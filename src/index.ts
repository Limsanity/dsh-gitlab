/**
 * @lim324/dsh-gitlab — host half of the GitLab Web surface: enumerates
 * the workspaces the harness knows (the workspace registry, with the launch
 * cwd as fallback), detects which ones are GitLab repositories by their git
 * remote, polls pipeline and open-MR snapshots per project into memory, and
 * serves them to the client half over two loopback-fenced routes
 * (`GET /gitlab/status`, `POST /gitlab/actions`, plus the `GET|POST
 * /gitlab/settings` token route below). The client half picks the entry
 * matching the current session's workspace. GitLab tokens stay on the host;
 * the browser only ever sees snapshots and action results, and never reads a
 * saved token back. The `gitlab` settings namespace holds the token durably
 * (persisted by the settings provider); edits re-tokenize every live client
 * without a restart.
 * @module @lim324/dsh-gitlab
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { gitClone, gitCommitPush, gitPull } from './git.ts'
import { GitlabApi, parseGitRemote, type GitlabRemote, type MrRow, type PipelineRow } from './gitlab.ts'
import { isTrustedLocalRequest } from './fence.ts'
import { createLocalSkillProvider } from './skill.ts'
import { GITLAB_SETTINGS_NAMESPACE, GitlabSettingsSchema, GitlabSkillSourceSchema, type GitlabSettings, type GitlabSkillSource } from './settings.ts'

export { GITLAB_SETTINGS_NAMESPACE, GitlabSettingsSchema, GitlabSkillSourceSchema, type GitlabSettings, type GitlabSkillSource } from './settings.ts'

/** Backward-compatible alias: a GitLab skill source (see {@link GitlabSkillSource}). */
export type SkillSource = GitlabSkillSource

const execFileAsync = promisify(execFile)

/** Stable Cordis plugin name. */
export const name = 'dsh-gitlab'

/** Services required before the GitLab surface can mount. */
export const inject = ['webServer']

/** Plugin config: GitLab access and polling cadence. */
export interface Config {
  /** GitLab personal access token; omit for read-only (pipeline and MR lists still work on public projects). The settings-section token overrides this. */
  token?: string
  /** Explicit project path "group/project"; when set, workspace enumeration is skipped. */
  project?: string
  /** API base URL override for self-managed instances; defaults to https://<remote-host>/api/v4. */
  baseUrl?: string
  /** Snapshot poll interval in milliseconds. */
  pollMs?: number
  /**
   * Environment variable naming the credential holding the GitLab token;
   * resolved through the credentials service with a process-environment
   * fallback. `token` overrides both.
   */
  tokenEnv?: string
  /** GitLab skill sources, each a group whose repositories are individual skills. */
  skillSources?: SkillSource[]
  /** Local checkout root; each source clones its repositories under `<skillCloneRoot>/<id>/`. */
  skillCloneRoot?: string
}

export const Config: z<Config> = z.object({
  // Schemastery members are optional unless marked required().
  token: z.string().role('secret'),
  project: z.string(),
  baseUrl: z.string(),
  pollMs: z.natural().min(5000).default(30_000),
  tokenEnv: z.string().role('credential-ref').default('GITLAB_TOKEN'),
  skillSources: z.array(GitlabSkillSourceSchema).default([]),
  skillCloneRoot: z.string(),
})

/** Upper bound for one action request body. */
const MAX_ACTION_BYTES = 8192

/**
 * Resource-safety bound, not a tunable: a skill source may hold dozens of
 * repositories, and cloning or pulling them all at once would spawn a
 * corresponding number of git processes and TLS connections. Run at most this
 * many git operations concurrently per sync.
 */
const SKILL_SYNC_CONCURRENCY = 6

/**
 * Run `fn` over `items` with at most `limit` in-flight invocations, preserving
 * order-independent completion. Failures are the caller's to handle.
 * @param items - the work items.
 * @param limit - the concurrency ceiling.
 * @param fn - the per-item async work.
 */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      // `cursor++` runs before any await, so each worker claims a distinct item.
      const item = items[cursor++]!
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/**
 * Validate an untrusted array into skill sources. Every entry needs a
 * non-empty string `id` and `group`; the optional fields are kept only when
 * their declared type matches (anything else is dropped and re-defaulted by
 * the settings schema). Returns undefined when the input is not an array or
 * any entry lacks id/group.
 * @param value - the request body's `sources` field.
 * @returns the parsed sources, or undefined when malformed.
 */
function parseSkillSources(value: unknown): SkillSource[] | undefined {
  if (!Array.isArray(value)) return undefined
  const sources: SkillSource[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined
    const row = item as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id : ''
    const group = typeof row.group === 'string' ? row.group : ''
    if (id === '' || group === '') return undefined
    const stringField = (key: string): string | undefined =>
      typeof row[key] === 'string' ? row[key] as string : undefined
    sources.push({
      id,
      group,
      baseUrl: stringField('baseUrl'),
      tokenEnv: stringField('tokenEnv'),
      ref: stringField('ref'),
      rank: typeof row.rank === 'number' ? row.rank : undefined,
      includeSubgroups: typeof row.includeSubgroups === 'boolean' ? row.includeSubgroups : undefined,
    })
  }
  return sources
}

/** The minimal workspace facts this plugin reads; structural so the registry stays an optional service. */
interface WorkspaceLike {
  id: string
  path: string
  title: string
}

/** One workspace row in the wire snapshot. */
export interface WorkspaceStatus {
  workspaceId: string
  title: string
  /** Whether this workspace is a GitLab repository (or has an explicit project). */
  gitlab: boolean
  /** The parsed remote when detection succeeded. */
  remote: GitlabRemote | null
  /** The GitLab project path polled, when gitlab is true. */
  project: string | null
  /** Whether a token is configured (write actions need one). */
  authed: boolean
  /** The workspace checkout's current branch, when resolvable. */
  currentBranch: string | null
  /** The GitLab project's default branch, when the API reports one. */
  defaultBranch: string | null
  /** The project's branch names for the create-MR selectors. */
  branches: string[]
  /** Latest pipelines, newest first. */
  pipelines: PipelineRow[]
  /** Open merge requests, newest first. */
  mrs: MrRow[]
  /** Last poll failure message, when any. */
  error: string | null
}

/** Action requests the client half may submit. */
interface ActionRequest {
  op: 'approve' | 'merge' | 'close' | 'create-mr'
  iid?: number
  /** The project the action targets; must be one of the polled GitLab projects. */
  project: string
  /** Optional MR title; the host composes a default from the branch names. */
  title?: string
  /** create-mr source branch; omitted falls back to the workspace's current branch. */
  sourceBranch?: string
  /** create-mr target branch; omitted falls back to the project's default branch. */
  targetBranch?: string
}

/** Test hook: tests substitute a fake fetch and git runners; production never touches this. */
export const internals: { fetchImpl?: typeof fetch; runGit?: (dir: string) => Promise<string>; runGitBranch?: (dir: string) => Promise<string> } = {}

/**
 * Resolve the git origin remote of a directory; undefined when the directory
 * is not a git checkout or has no origin.
 * @param cwd - the directory to inspect.
 * @param run - the git runner (injected for tests).
 * @returns the parsed remote, or undefined.
 */
export async function detectRemote(cwd: string, run = internals.runGit ?? ((dir: string): Promise<string> => execFileAsync('git', ['-C', dir, 'remote', 'get-url', 'origin']).then(result => result.stdout))): Promise<GitlabRemote | undefined> {
  try {
    return parseGitRemote(await run(cwd))
  } catch {
    return undefined
  }
}

/**
 * Resolve the currently checked-out branch of a directory; undefined when
 * the directory is not a git checkout (e.g. a detached HEAD).
 * @param dir - the workspace directory.
 * @param run - the git runner (injected for tests).
 * @returns the branch name, or undefined.
 */
export async function detectCurrentBranch(dir: string, run = internals.runGitBranch ?? ((directory: string): Promise<string> => execFileAsync('git', ['-C', directory, 'branch', '--show-current']).then(result => result.stdout))): Promise<string | undefined> {
  try {
    const branch = (await run(dir)).trim()
    return branch === '' ? undefined : branch
  } catch {
    return undefined
  }
}

/** Read a JSON body up to the size bound; undefined means over the bound or unparsable. */
async function readJsonBody(req: IncomingMessage): Promise<unknown | undefined> {
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > MAX_ACTION_BYTES) return undefined
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_ACTION_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

/** One polled GitLab project's live rows. */
interface ProjectRows {
  pipelines: PipelineRow[]
  mrs: MrRow[]
  error: string | null
}

/**
 * Mount the GitLab surface: workspace enumeration, remote detection, the
 * per-project polled rows, and the two fenced routes. Workspaces without a
 * GitLab remote still appear with `gitlab: false` so the client half can
 * render the not-a-GitLab state.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // The credentials face is structural: the CredentialProvider contract's
  // resolve matches this subset, so the service stays optional.
  const credentials = ctx.get('credentials') as { resolve(ref: string): { value: string } | undefined } | undefined
  // The user-editable settings section (the Web settings panel) wins, then
  // explicit config, then the credentials service for the named
  // credential-ref, then the process environment. Within the section, a
  // per-host override beats the default token for that host.
  let settingsSection: GitlabSettings | undefined
  const resolveToken = (host: string | undefined): string | undefined => {
    const hostToken = host !== undefined && host !== '' ? settingsSection?.hostTokens?.[host] : undefined
    return hostToken ?? settingsSection?.token ?? config.token ?? credentials?.resolve(config.tokenEnv ?? 'GITLAB_TOKEN')?.value ?? process.env[config.tokenEnv ?? 'GITLAB_TOKEN']
  }

  // Skill sources are mutable: the settings section (edited through the Web
  // panel) overrides the plugin config, and a change re-registers the live
  // skill providers. Declared up front so the settings watcher, registered
  // before the skill section below, can reach them without a TDZ hit.
  let skillSources: SkillSource[] = config.skillSources ?? []
  let resyncProviders: (() => void) | undefined
  const sourcesKey = (sources: SkillSource[]): string => JSON.stringify(
    [...sources].sort((a, b) => a.id.localeCompare(b.id)).map(source => [
      source.id, source.group, source.baseUrl ?? null, source.tokenEnv ?? null,
      source.ref ?? null, source.rank ?? null, source.includeSubgroups ?? null,
    ]),
  )
  // Schemastery coerces an absent array field to [], so an empty settings
  // list cannot be told apart from "never configured". Treat an empty list as
  // "not configured": the plugin config's sources win until the settings
  // section actually lists one.
  const effectiveSkillSources = (settingsSources: SkillSource[] | undefined): SkillSource[] =>
    settingsSources !== undefined && settingsSources.length > 0 ? settingsSources : (config.skillSources ?? [])

  const rowsByProject = new Map<string, ProjectRows>()
  const apisByProject = new Map<string, GitlabApi>()
  const remoteByWorkspace = new Map<string, GitlabRemote | null>()
  const projectByWorkspace = new Map<string, string | null>()
  const defaultBranchByProject = new Map<string, string | null>()
  const branchesByProject = new Map<string, string[]>()
  const currentBranchByWorkspace = new Map<string, string | null>()
  const pollers = new Map<string, ReturnType<typeof setInterval>>()
  const ensuring = new Map<string, Promise<WorkspaceStatus | undefined>>()
  /** One detection result per host, so workspaces sharing a host probe once. */
  const probeByHost = new Map<string, boolean>()

  /**
   * Detect a GitLab instance by its API rather than its host name: a GET of
   * `/api/v4/version` answering 200 with a version document, or 401 (the
   * endpoint exists but demands authentication), proves the host serves the
   * GitLab API; anything else does not. Network and TLS failures leave the
   * host undetected — explicit `config.baseUrl` remains the escape hatch.
   * @param host - the remote host to probe.
   * @returns whether the host serves the GitLab API.
   */
  const probeGitlab = async (host: string): Promise<boolean> => {
    const cached = probeByHost.get(host)
    if (cached !== undefined) return cached
    let result = false
    try {
      const impl = internals.fetchImpl ?? fetch
      const res = await impl(`https://${host}/api/v4/version`, { signal: AbortSignal.timeout(5000) })
      if (res.status === 401) result = true
      else if (res.ok) result = (await res.text()).includes('"version"')
    } catch {
      // Failure proves nothing; the host stays undetected.
    }
    probeByHost.set(host, result)
    return result
  }
  // Registered synchronously so the pollers die with the fiber.
  ctx.effect(() => () => {
    for (const timer of pollers.values()) clearInterval(timer)
    pollers.clear()
  }, 'dsh-gitlab: pollers')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/gitlab/status',
    handler: async (req, res) => {
      if (!isTrustedLocalRequest(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server requests. */
      const workspaceId = new URL(req.url ?? '/', 'http://x').searchParams.get('workspaceId')
      if (workspaceId === null) {
        res.writeHead(400)
        res.end('missing workspaceId')
        return
      }
      const status = await ensure(workspaceId)
      if (status === undefined) {
        res.writeHead(404)
        res.end('unknown workspace')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(status))
    },
  }), 'dsh-gitlab: status route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/gitlab/actions',
    handler: async (req, res) => {
      if (!isTrustedLocalRequest(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      const body = await readJsonBody(req)
      const action = body as Partial<ActionRequest> | undefined
      if (action === undefined || typeof action.project !== 'string') {
        res.writeHead(400)
        res.end('bad request')
        return
      }
      if (action.op !== 'approve' && action.op !== 'merge' && action.op !== 'close' && action.op !== 'create-mr') {
        res.writeHead(400)
        res.end('bad request')
        return
      }
      if (action.op !== 'create-mr' && typeof action.iid !== 'number') {
        res.writeHead(400)
        res.end('bad request')
        return
      }
      const api = apisByProject.get(action.project)
      if (api === undefined) {
        res.writeHead(409)
        res.end('unknown GitLab project')
        return
      }
      if (!api.hasToken()) {
        res.writeHead(401)
        res.end('token required')
        return
      }
      try {
        if (action.op === 'approve') {
          await api.approveMr(action.project, action.iid!)
          await refresh(action.project)
        } else if (action.op === 'merge') {
          await api.mergeMr(action.project, action.iid!)
          await refresh(action.project)
        } else if (action.op === 'close') {
          await api.closeMr(action.project, action.iid!)
          await refresh(action.project)
        } else {
          const workspaceId = [...projectByWorkspace.entries()].find(([, project]) => project === action.project)?.[0]
          const source = workspaceId === undefined ? undefined : resolveWorkspace(workspaceId)
          const currentBranch = source === undefined || source.path === '' ? null : await detectCurrentBranch(source.path).catch(() => null)
          const sourceBranch = action.sourceBranch !== undefined && action.sourceBranch !== '' ? action.sourceBranch : (currentBranch ?? undefined)
          if (sourceBranch === undefined) {
            res.writeHead(409)
            res.end('cannot resolve the source branch')
            return
          }
          const targetBranch = action.targetBranch !== undefined && action.targetBranch !== '' ? action.targetBranch : (defaultBranchByProject.get(action.project) ?? 'main')
          const title = action.title !== undefined && action.title !== '' ? action.title : `Merge ${sourceBranch} into ${targetBranch}`
          const created = await api.createMr(action.project, { sourceBranch, targetBranch, title })
          // Refresh before answering so the client's follow-up status fetch
          // already carries the new MR row — no poll-cycle lag on the list.
          await refresh(action.project)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, iid: created.iid, webUrl: created.webUrl }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true }))
      } catch (error) {
        res.writeHead(502)
        res.end(error instanceof Error ? error.message : 'GitLab API error')
      }
    },
  }), 'dsh-gitlab: actions route')

  /** Look one workspace up by id: the registry, the cwd sentinel, or the configured project. */
  const resolveWorkspace = (workspaceId: string): WorkspaceLike | undefined => {
    if (config.project !== undefined) {
      return workspaceId === '__configured__' ? { id: '__configured__', path: '', title: config.project } : undefined
    }
    if (workspaceId === '__cwd__') return { id: '__cwd__', path: process.cwd(), title: basename(process.cwd()) }
    const registry = ctx.get('workspaceRegistry') as { list(): WorkspaceLike[] } | undefined
    return registry?.list().find(entry => entry.id === workspaceId)
  }

  const refresh = async (project: string): Promise<void> => {
    const api = apisByProject.get(project)
    const rows = rowsByProject.get(project)
    if (api === undefined || rows === undefined) return
    try {
      const [pipelines, mrs, branches] = await Promise.all([
        api.listPipelines(project),
        api.listMrs(project),
        // Branches change rarely but the create-MR selectors read this
        // snapshot; refreshing it here keeps newly pushed branches visible
        // without a restart.
        api.listBranches(project).catch(() => undefined),
      ])
      // Jobs are one extra API call per pipeline; the pipeline list is
      // capped at five, so this stays well within GitLab's rate budget.
      await Promise.all(pipelines.map(async pipeline => {
        const { jobs, commit } = await api.listPipelineJobs(project, pipeline.id)
        pipeline.jobs = jobs
        pipeline.commit = commit
      }))
      rows.pipelines = pipelines
      rows.mrs = mrs
      rows.error = null
      if (branches !== undefined) branchesByProject.set(project, branches)
      // The workspace's checked-out branch can move under the poller's feet;
      // re-read it so the source selector's default follows the checkout.
      for (const [workspaceId, workspaceProject] of projectByWorkspace) {
        if (workspaceProject !== project) continue
        const source = resolveWorkspace(workspaceId)
        if (source === undefined || source.path === '') continue
        currentBranchByWorkspace.set(workspaceId, (await detectCurrentBranch(source.path).catch(() => null)) ?? null)
      }
    } catch (error) {
      // Failures clear the snapshot instead of keeping the last good
      // values: the surface shows only what the API answers right now, so
      // stale rows can never linger past a page refresh.
      rows.pipelines = []
      rows.mrs = []
      branchesByProject.set(project, [])
      rows.error = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * Resolve one workspace's status row, detecting its remote and starting a
   * poller on first request. Only workspaces the client has actually asked
   * for are ever detected or polled; unknown ids answer 404. Deduplicated per
   * workspace id, so concurrent polls of the same workspace share one
   * detection pass.
   * @param workspaceId - the workspace the client is viewing.
   * @returns the status row, or undefined for an unknown workspace.
   */
  const ensure = (workspaceId: string): Promise<WorkspaceStatus | undefined> => {
    const pending = ensuring.get(workspaceId)
    if (pending !== undefined) return pending
    const promise = (async (): Promise<WorkspaceStatus | undefined> => {
      const source = resolveWorkspace(workspaceId)
      if (source === undefined) return undefined
      if (!projectByWorkspace.has(source.id)) {
        let remote: GitlabRemote | undefined
        if (source.path !== '') remote = await detectRemote(source.path)
        if (config.project !== undefined) {
          // An explicitly pinned project needs no detection.
          remoteByWorkspace.set(source.id, null)
          projectByWorkspace.set(source.id, config.project)
        } else if (remote !== undefined && (config.baseUrl !== undefined || await probeGitlab(remote.host))) {
          // An explicit API base is proof enough; otherwise the host must
          // actually serve the GitLab API.
          remoteByWorkspace.set(source.id, remote)
          projectByWorkspace.set(source.id, remote.project)
        } else {
          remoteByWorkspace.set(source.id, remote ?? null)
          projectByWorkspace.set(source.id, null)
        }
      }
      const project = projectByWorkspace.get(source.id) ?? null
      if (project !== null && project !== undefined && !apisByProject.has(project)) {
        const remote = remoteByWorkspace.get(source.id)
        const api = new GitlabApi({
          baseUrl: config.baseUrl ?? (remote === null || remote === undefined ? 'https://gitlab.com/api/v4' : `https://${remote.host}/api/v4`),
          // The provider pins this project's remote host, so the per-host
          // settings override (and the generic fallback) resolve live.
          tokenProvider: () => resolveToken(remote?.host),
          fetchImpl: internals.fetchImpl,
        })
        apisByProject.set(project, api)
        rowsByProject.set(project, { pipelines: [], mrs: [], error: null })
        // A missing project lookup must not break the whole status row;
        // the 'main' fallback covers renamed or private projects.
        defaultBranchByProject.set(project, await api.getDefaultBranch(project).catch(() => null))
        branchesByProject.set(project, await api.listBranches(project).catch(() => []))
        currentBranchByWorkspace.set(
          source.id,
          source.path === '' ? null : (await detectCurrentBranch(source.path).catch(() => null)) ?? null,
        )
        await refresh(project)
        pollers.set(project, setInterval(() => { void refresh(project) }, config.pollMs ?? 30_000))
      }
      const rows = project === null || project === undefined ? undefined : rowsByProject.get(project)
      return {
        workspaceId: source.id,
        title: source.title,
        gitlab: project !== null && project !== undefined,
        remote: remoteByWorkspace.get(source.id) ?? null,
        project,
        authed: project === null || project === undefined ? false : (apisByProject.get(project)?.hasToken() ?? false),
        currentBranch: currentBranchByWorkspace.get(source.id) ?? null,
        defaultBranch: project === null || project === undefined ? null : (defaultBranchByProject.get(project) ?? null),
        branches: project === null || project === undefined ? [] : (branchesByProject.get(project) ?? []),
        pipelines: rows?.pipelines ?? [],
        mrs: rows?.mrs ?? [],
        error: rows?.error ?? null,
      }
    })()
    ensuring.set(workspaceId, promise)
    void promise.then(() => { ensuring.delete(workspaceId) }, () => { ensuring.delete(workspaceId) })
    return promise
  }

  // ── settings namespace ────────────────────────────────────────────────────
  // The `gitlab` namespace holds the user-editable token. The Web settings
  // RPC only serves allowlisted namespaces (the api-proxy configuration
  // boundary), so the browser edits the token through this plugin's own
  // fenced route below, which calls the seam in-process — never returning
  // the token itself, only whether one is set.
  interface GitlabSettingsFace {
    get(): { available: true; writable: boolean; tokenSet: boolean; hostTokens: string[]; revision: number | undefined }
    update(host: string | undefined, token: string | undefined, expectedRevision?: number): Promise<void>
    updateSources(sources: SkillSource[], expectedRevision?: number): Promise<void>
  }
  let settingsFace: GitlabSettingsFace | undefined
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(GITLAB_SETTINGS_NAMESPACE, GitlabSettingsSchema)
    // Seed the section: watchers only fire on commits, so the value that
    // was already persisted before this boot must be read once at
    // registration.
    settingsSection = scope.get()
    // Apply persisted skill sources on first read. The skill providers may
    // register before or after this seed, so reconcile through the shared
    // `resyncProviders` hook either way.
    const seededSources = effectiveSkillSources(settingsSection.skillSources)
    if (sourcesKey(skillSources) !== sourcesKey(seededSources)) {
      skillSources = seededSources
      if (resyncProviders !== undefined) void resyncProviders()
    }
    const revisionOf = (): number | undefined =>
      settingsCtx.settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === GITLAB_SETTINGS_NAMESPACE)?.revision
    settingsFace = {
      get: () => {
        const section = scope.get()
        return {
          available: true,
          writable: settingsCtx.settings.writable,
          tokenSet: section.token !== undefined,
          // Only the host names cross the wire: a listed host always has a
          // stored value (the schema rejects undefined dict entries).
          hostTokens: Object.keys(section.hostTokens ?? {}),
          revision: revisionOf(),
        }
      },
      update: async (host, token, expectedRevision) => {
        if (token === undefined) {
          const path = host === undefined || host === '' ? ['token'] : ['hostTokens', host]
          await settingsCtx.settings.mutate(GITLAB_SETTINGS_NAMESPACE, [{ op: 'unset', path }], expectedRevision)
        } else if (host === undefined || host === '') {
          await settingsCtx.settings.update(GITLAB_SETTINGS_NAMESPACE, { token }, expectedRevision)
        } else {
          await settingsCtx.settings.update(GITLAB_SETTINGS_NAMESPACE, { hostTokens: { [host]: token } }, expectedRevision)
        }
      },
      updateSources: async (sources, expectedRevision) => {
        await settingsCtx.settings.update(GITLAB_SETTINGS_NAMESPACE, { skillSources: sources }, expectedRevision)
      },
    }
    // Re-poll every live project when the section changes: a token edit
    // flips `authed` and read/write behavior on the next snapshot without a
    // restart. A skill-source change re-registers providers live.
    scope.watch((next) => {
      settingsSection = next
      for (const project of rowsByProject.keys()) void refresh(project)
      const nextSources = effectiveSkillSources(next.skillSources)
      if (sourcesKey(skillSources) !== sourcesKey(nextSources)) {
        skillSources = nextSources
        if (resyncProviders !== undefined) void resyncProviders()
      }
    })
  })

  // The settings route: read the saved-token state and write/clear the
  // token, revision-guarded so a stale browser tab cannot overwrite a newer
  // write. The token itself never crosses this route.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/gitlab/settings',
    handler: async (req, res) => {
      if (!isTrustedLocalRequest(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(settingsFace?.get() ?? { available: false }))
        return
      }
      if (req.method === 'POST') {
        if (settingsFace === undefined) {
          res.writeHead(503)
          res.end('settings service is not mounted')
          return
        }
        const body = await readJsonBody(req)
        const action = body as Partial<{ host: unknown; token: unknown; clear: unknown; expectedRevision: unknown }> | undefined
        const clear = action?.clear === true
        const token = typeof action?.token === 'string' && action.token !== '' ? action.token : undefined
        const host = typeof action?.host === 'string' && action.host !== '' ? action.host : undefined
        if (action === undefined || (!clear && token === undefined)) {
          res.writeHead(400)
          res.end('token or clear required')
          return
        }
        const expectedRevision = typeof action.expectedRevision === 'number' ? action.expectedRevision : undefined
        try {
          await settingsFace.update(host, clear ? undefined : token, expectedRevision)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(settingsFace.get()))
        } catch (error) {
          if (error instanceof SettingsConflictError) {
            res.writeHead(409)
            res.end('settings-conflict')
          } else {
            res.writeHead(400)
            res.end(error instanceof Error ? error.message : 'settings rejected')
          }
        }
        return
      }
      res.writeHead(405)
      res.end()
    },
  }), 'dsh-gitlab: settings route')

  // The local-checkout skill seam: one provider per configured source, cloned
  // (or pulled) under the shared checkout root. `ctx.inject` waits for the
  // optional skill seam, so a deployment without skills leaves the surface
  // untouched; sources are dynamic and re-registered on settings changes.
  const cloneRoot = config.skillCloneRoot ?? join(homedir(), '.dsh', 'skills-gitlab')

  // Per-source instance facts: each source may live on a different GitLab
  // host with its own token credential.
  const sourceGitHost = (source: SkillSource): string =>
    (source.baseUrl ?? config.baseUrl ?? 'https://gitlab.com/api/v4').replace(/\/api\/v4\/?$/, '')
  const sourceHostName = (source: SkillSource): string =>
    sourceGitHost(source).replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const sourceToken = (source: SkillSource): string | undefined => {
    const host = sourceHostName(source)
    const tokenEnv = source.tokenEnv ?? config.tokenEnv ?? 'GITLAB_TOKEN'
    return settingsSection?.hostTokens?.[host]
      ?? settingsSection?.token
      ?? config.token
      ?? credentials?.resolve(tokenEnv)?.value
      ?? process.env[tokenEnv]
  }
  const sourceById = (id: string): SkillSource | undefined => skillSources.find(source => source.id === id)

  // List every source's repositories with their local pulled status. The
  // available list comes from the GitLab API; the pulled flag from whether
  // the checkout directory exists locally. Each entry spreads the full source
  // config so the Web panel can round-trip edits without dropping fields.
  const skillStatus = async (): Promise<{ sources: Array<SkillSource & { repos: Array<{ name: string; pulled: boolean }> }> }> => {
    const sources = []
    for (const source of skillSources) {
      const checkoutRoot = join(cloneRoot, source.id)
      const local: string[] = await readdir(checkoutRoot, { withFileTypes: true })
        .then(entries => entries.filter(entry => entry.isDirectory()).map(entry => entry.name))
        .catch(() => [])
      const localSet = new Set(local)
      const api = new GitlabApi({
        baseUrl: source.baseUrl ?? config.baseUrl ?? 'https://gitlab.com/api/v4',
        tokenProvider: () => sourceToken(source),
      })
      let repos: { name: string; pulled: boolean }[] = []
      try {
        repos = (await api.listGroupProjects(source.group, source.includeSubgroups ?? true))
          .map(repo => ({ name: repo.name, pulled: localSet.has(repo.name) }))
      } catch {
        // API unreachable: still report the locally checked-out skills.
        repos = local.map(name => ({ name, pulled: true }))
      }
      sources.push({ ...source, repos })
    }
    return { sources }
  }

  // Registered even without configured sources so the settings panel can
  // render the "no sources" state instead of receiving a 404 and spinning.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/gitlab/skills/status',
    handler: async (req, res) => {
      if (!isTrustedLocalRequest(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (req.method !== 'GET') {
        res.writeHead(405)
        res.end()
        return
      }
      try {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ...(await skillStatus()), revision: settingsFace?.get().revision }))
      } catch (error) {
        res.writeHead(500)
        res.end(error instanceof Error ? error.message : 'status failed')
      }
    },
  }), 'dsh-gitlab: skills status route')

  // Clone or fast-forward pull one repository row into its checkout dir.
  const syncRepoRow = async (checkoutRoot: string, source: SkillSource, repo: { name: string; pathWithNamespace: string }): Promise<void> => {
    const dest = join(checkoutRoot, repo.name)
    if (existsSync(dest)) await gitPull(dest)
    else await gitClone(`${sourceGitHost(source)}/${repo.pathWithNamespace}.git`, sourceToken(source), dest)
  }

  // Clone (or pull) every repository of one source. Best-effort per repo so
  // one unreachable repository never blocks the rest of the group.
  const syncSource = async (source: SkillSource): Promise<void> => {
    const checkoutRoot = join(cloneRoot, source.id)
    await mkdir(checkoutRoot, { recursive: true })
    const api = new GitlabApi({
      baseUrl: source.baseUrl ?? config.baseUrl ?? 'https://gitlab.com/api/v4',
      tokenProvider: () => sourceToken(source),
    })
    const repos = await api.listGroupProjects(source.group, source.includeSubgroups ?? true)
    await mapWithConcurrency(repos, SKILL_SYNC_CONCURRENCY, async (repo) => {
      try {
        await syncRepoRow(checkoutRoot, source, repo)
      } catch (error) {
        ctx.logger.warn(`dsh-gitlab: skill repo ${repo.pathWithNamespace} sync failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  // Clone or pull exactly one repository of a source, looked up by name so the
  // Web panel can pull a single repository without a whole-group sync.
  const syncRepo = async (source: SkillSource, repoName: string): Promise<void> => {
    const checkoutRoot = join(cloneRoot, source.id)
    await mkdir(checkoutRoot, { recursive: true })
    const api = new GitlabApi({
      baseUrl: source.baseUrl ?? config.baseUrl ?? 'https://gitlab.com/api/v4',
      tokenProvider: () => sourceToken(source),
    })
    const repos = await api.listGroupProjects(source.group, source.includeSubgroups ?? true)
    const repo = repos.find(candidate => candidate.name === repoName)
    if (repo === undefined) throw new Error(`repository "${repoName}" is not in group ${source.group}`)
    await syncRepoRow(checkoutRoot, source, repo)
  }

  // Catalog invalidation callbacks keyed by source id, shared between the
  // provider registrations and the model-facing tools.
  const invalidators = new Map<string, () => void>()
  const invalidateAll = (): void => { for (const invalidate of invalidators.values()) invalidate() }

  // (Re)register one local-checkout provider per current source. Runs at boot
  // and again whenever the settings section's skillSources change, so
  // Web-panel edits take effect without a restart. Syncing is manual: the
  // panel lists remote repositories and pulls them individually or as a group.
  ctx.inject(['skills'], (skillsCtx) => {
    const cleanups: Array<() => void> = []
    resyncProviders = (): void => {
      for (const cleanup of cleanups) cleanup()
      cleanups.length = 0
      invalidators.clear()
      for (const source of skillSources) {
        const checkoutRoot = join(cloneRoot, source.id)
        const provider = createLocalSkillProvider({
          localRoot: checkoutRoot,
          rank: source.rank ?? 250,
          source: 'gitlab',
          providerName: `gitlab:${source.id}`,
        }, ctx)
        cleanups.push(skillsCtx.skills.registerProvider((control) => {
          invalidators.set(source.id, control.invalidate)
          return provider
        }))
      }
      invalidateAll()
    }
    resyncProviders()
    // Dispose every provider registration when the skills context dies.
    skillsCtx.effect(() => () => {
      for (const cleanup of cleanups) cleanup()
      cleanups.length = 0
    })
  })

  // Model-facing tools: the agent can pull, save, and remove skills directly.
  // `save` writes back to the remote repository, so it requests approval.
  type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  interface ApprovalLike {
    request(req: { agent: unknown; toolName: string; reason?: string; signal?: AbortSignal }): Promise<ApprovalOutcome>
  }
  const requireApproval = async (exec: { agent?: unknown; signal: AbortSignal }, toolName: string, reason: string): Promise<void> => {
    const approval = ctx.get('approval') as ApprovalLike | undefined
    if (approval === undefined || exec.agent === undefined) throw new Error(`${toolName} cannot be approved in this context`)
    const outcome = await approval.request({ agent: exec.agent, toolName, reason, signal: exec.signal })
    if (outcome !== 'allowed-once') throw new Error(`${toolName} not approved: ${outcome}`)
  }

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register(defineTool({
      name: 'gitlab_skill_pull',
      description: 'Sync GitLab-backed skills into the local checkout so the skill catalog reflects the latest remote state. Omit sourceId to sync every configured source.',
      parameters: {
        sourceId: { type: 'string', description: 'Optional source id; omit to sync every configured source.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { synced: { type: 'array', items: { type: 'string' }, required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: `Synced skill sources: ${(value.synced as string[]).join(', ')}` }],
      },
      async execute(args) {
        const target = typeof args.sourceId === 'string' ? sourceById(args.sourceId) : undefined
        const targets = target !== undefined ? [target] : skillSources
        await Promise.all(targets.map(source => syncSource(source)))
        invalidateAll()
        return { synced: targets.map(source => source.id) }
      },
      presentCall(args) {
        return { card: 'generic', title: 'Pull GitLab skills', kind: 'fetch', rawInput: args.sourceId ?? 'all' }
      },
    }))

    toolCtx.tools.register(defineTool({
      name: 'gitlab_skill_save',
      description: 'Write one checked-out skill\'s SKILL.md back to its GitLab repository (commit + push). Requires approval.',
      parameters: {
        sourceId: { type: 'string', required: true, description: 'The source id.' },
        repo: { type: 'string', required: true, description: 'The repository (skill) name.' },
        content: { type: 'string', required: true, description: 'The full SKILL.md content to write.' },
        message: { type: 'string', description: 'Optional commit message.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { repo: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: `Saved skill ${String(value.repo)}` }],
      },
      async execute(args, exec) {
        const source = sourceById(args.sourceId)
        if (source === undefined) throw new Error(`unknown sourceId "${args.sourceId}"`)
        const dest = join(cloneRoot, source.id, args.repo)
        if (!existsSync(dest)) throw new Error(`skill repository "${args.repo}" is not checked out; pull it first`)
        await requireApproval(exec, 'gitlab_skill_save', `commit SKILL.md of "${args.repo}" to ${source.group}`)
        await writeFile(join(dest, 'SKILL.md'), args.content)
        await gitCommitPush(dest, typeof args.message === 'string' && args.message !== '' ? args.message : `update skill ${args.repo}`)
        invalidateAll()
        return { repo: args.repo }
      },
      presentCall(args) {
        return { card: 'generic', title: `Save skill ${args.repo}`, kind: 'edit', rawInput: args.repo }
      },
    }))

    toolCtx.tools.register(defineTool({
      name: 'gitlab_skill_remove',
      description: 'Delete only the local checkout of one skill; the remote GitLab repository is left untouched.',
      parameters: {
        sourceId: { type: 'string', required: true, description: 'The source id.' },
        repo: { type: 'string', required: true, description: 'The repository (skill) name.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { repo: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: `Removed local checkout of ${String(value.repo)}` }],
      },
      async execute(args) {
        const source = sourceById(args.sourceId)
        if (source === undefined) throw new Error(`unknown sourceId "${args.sourceId}"`)
        await rm(join(cloneRoot, source.id, args.repo), { recursive: true, force: true })
        invalidateAll()
        return { repo: args.repo }
      },
      presentCall(args) {
        return { card: 'generic', title: `Remove local skill ${args.repo}`, kind: 'delete', rawInput: args.repo }
      },
    }))
  })

  // Manual re-sync of one source (or every source) — the pull endpoint the
  // settings panel will call.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/gitlab/skills/pull',
    handler: async (req, res) => {
      if (!isTrustedLocalRequest(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      const body = await readJsonBody(req) as Partial<{ sourceId: unknown; repo: unknown }> | undefined
      const target = typeof body?.sourceId === 'string' ? sourceById(body.sourceId) : undefined
      if (body?.sourceId !== undefined && target === undefined) {
        res.writeHead(404)
        res.end('unknown sourceId')
        return
      }
      const repo = typeof body?.repo === 'string' && body.repo !== '' ? body.repo : undefined
      try {
        if (repo !== undefined) {
          // Single-repository sync: the panel's per-repo pull.
          if (target === undefined) throw new Error('repo requires a sourceId')
          await syncRepo(target, repo)
        } else {
          // Whole-source (or all-source) sync.
          const targets = target !== undefined ? [target] : skillSources
          await Promise.all(targets.map(source => syncSource(source)))
        }
        invalidateAll()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true }))
      } catch (error) {
        res.writeHead(500)
        res.end(error instanceof Error ? error.message : 'sync failed')
      }
    },
  }), 'dsh-gitlab: skills pull route')

  // Write one checked-out skill's SKILL.md back to GitLab (commit + push).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/gitlab/skills/save',
    handler: async (req, res) => {
      if (!isTrustedLocalRequest(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      const body = await readJsonBody(req) as Partial<{ sourceId: unknown; repo: unknown; content: unknown; message: unknown }> | undefined
      const source = typeof body?.sourceId === 'string' ? sourceById(body.sourceId) : undefined
      const repo = typeof body?.repo === 'string' && body.repo !== '' ? body.repo : undefined
      const content = typeof body?.content === 'string' ? body.content : undefined
      if (source === undefined || repo === undefined || content === undefined) {
        res.writeHead(400)
        res.end('sourceId, repo, and content are required')
        return
      }
      const dest = join(cloneRoot, source.id, repo)
      if (!existsSync(dest)) {
        res.writeHead(404)
        res.end('skill repository is not checked out; pull it first')
        return
      }
      try {
        await writeFile(join(dest, 'SKILL.md'), content)
        await gitCommitPush(dest, typeof body?.message === 'string' && body.message !== '' ? body.message : `update skill ${repo}`)
        invalidateAll()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true }))
      } catch (error) {
        res.writeHead(500)
        res.end(error instanceof Error ? error.message : 'save failed')
      }
    },
  }), 'dsh-gitlab: skills save route')

  // Remove only the local checkout of one skill; the remote repository is
  // left untouched.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/gitlab/skills/remove',
    handler: async (req, res) => {
      if (!isTrustedLocalRequest(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      const body = await readJsonBody(req) as Partial<{ sourceId: unknown; repo: unknown }> | undefined
      const source = typeof body?.sourceId === 'string' ? sourceById(body.sourceId) : undefined
      const repo = typeof body?.repo === 'string' && body.repo !== '' ? body.repo : undefined
      if (source === undefined || repo === undefined) {
        res.writeHead(400)
        res.end('sourceId and repo are required')
        return
      }
      try {
        await rm(join(cloneRoot, source.id, repo), { recursive: true, force: true })
        invalidateAll()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true }))
      } catch (error) {
        res.writeHead(500)
        res.end(error instanceof Error ? error.message : 'remove failed')
      }
    },
  }), 'dsh-gitlab: skills remove route')

  // Read and replace the configured skill sources (the Web panel's CRUD).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/gitlab/skills/sources',
    handler: async (req, res) => {
      if (!isTrustedLocalRequest(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ sources: skillSources, revision: settingsFace?.get().revision }))
        return
      }
      if (req.method === 'POST') {
        if (settingsFace === undefined) {
          res.writeHead(503)
          res.end('settings service is not mounted')
          return
        }
        const body = await readJsonBody(req) as Partial<{ sources: unknown; expectedRevision: unknown }> | undefined
        const sources = parseSkillSources(body?.sources)
        if (sources === undefined) {
          res.writeHead(400)
          res.end('sources must be an array of { id, group } objects')
          return
        }
        const expectedRevision = typeof body?.expectedRevision === 'number' ? body.expectedRevision : undefined
        try {
          await settingsFace.updateSources(sources, expectedRevision)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true }))
        } catch (error) {
          if (error instanceof SettingsConflictError) {
            res.writeHead(409)
            res.end('settings-conflict')
          } else {
            res.writeHead(400)
            res.end(error instanceof Error ? error.message : 'sources rejected')
          }
        }
        return
      }
      res.writeHead(405)
      res.end()
    },
  }), 'dsh-gitlab: skills sources route')
}
