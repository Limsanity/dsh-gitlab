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
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-skill'
import { gitClone, gitPull } from './git.ts'
import { GitlabApi, parseGitRemote, type GitlabRemote, type MrRow, type PipelineRow } from './gitlab.ts'
import { isTrustedLocalRequest } from './fence.ts'
import { createLocalSkillProvider } from './skill.ts'
import { GITLAB_SETTINGS_NAMESPACE, GitlabSettingsSchema, type GitlabSettings } from './settings.ts'

export { GITLAB_SETTINGS_NAMESPACE, GitlabSettingsSchema, type GitlabSettings } from './settings.ts'

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

/**
 * One GitLab skill source: a group on one GitLab instance. Every repository
 * under the group is one skill (its `SKILL.md` lives at the repository root).
 */
export interface SkillSource {
  /** Unique source id, also the provider name and the checkout directory name. */
  id: string
  /** GitLab group path, e.g. `my-org/skills`. */
  group: string
  /** Instance API base URL; defaults to the plugin `baseUrl`. */
  baseUrl?: string
  /** Credential reference for this instance's token; defaults to the plugin `tokenEnv`. */
  tokenEnv?: string
  /** Branch or tag to check out. */
  ref?: string
  /** Discovery rank for this source; lower ranks win duplicate skill names. */
  rank?: number
  /** Whether to include repositories from nested subgroups. */
  includeSubgroups?: boolean
}

export const Config: z<Config> = z.object({
  // Schemastery members are optional unless marked required().
  token: z.string().role('secret'),
  project: z.string(),
  baseUrl: z.string(),
  pollMs: z.natural().min(5000).default(30_000),
  tokenEnv: z.string().role('credential-ref').default('GITLAB_TOKEN'),
  skillSources: z.array(z.object({
    id: z.string(),
    group: z.string(),
    baseUrl: z.string(),
    tokenEnv: z.string().role('credential-ref'),
    ref: z.string().default('main'),
    rank: z.natural().default(250),
    includeSubgroups: z.boolean().default(true),
  })).default([]),
  skillCloneRoot: z.string(),
})

/** Upper bound for one action request body. */
const MAX_ACTION_BYTES = 8192

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
  }
  let settingsFace: GitlabSettingsFace | undefined
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(GITLAB_SETTINGS_NAMESPACE, GitlabSettingsSchema)
    // Seed the section: watchers only fire on commits, so the value that
    // was already persisted before this boot must be read once at
    // registration.
    settingsSection = scope.get()
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
    }
    // Re-poll every live project when the section changes: a token edit
    // flips `authed` and read/write behavior on the next snapshot without a
    // restart. The registration is an effect on the inject fiber, so it
    // dies with this plugin.
    scope.watch((next) => {
      settingsSection = next
      for (const project of rowsByProject.keys()) void refresh(project)
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

  // Register one local-checkout skill provider per configured source, cloning
  // (or pulling) each source under the shared checkout root first. `ctx.inject`
  // waits for the optional skill seam, so a deployment without skills leaves
  // the web surface untouched.
  const skillSources = config.skillSources ?? []
  if (skillSources.length > 0) {
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

    ctx.inject(['skills'], (skillsCtx) => {
      for (const source of skillSources) {
        const checkoutRoot = join(cloneRoot, source.id)
        const provider = createLocalSkillProvider({
          localRoot: checkoutRoot,
          rank: source.rank ?? 250,
          source: 'gitlab',
          providerName: `gitlab:${source.id}`,
        }, ctx)
        skillsCtx.effect(() => skillsCtx.skills.registerProvider(() => provider), `dsh-gitlab: skill ${source.id}`)
        // Sync on boot, best-effort: list the group's repositories, clone each
        // (one skill per repository), and fast-forward existing checkouts. A
        // source that cannot be reached leaves the provider with whatever is
        // already on disk (or nothing), never blocks boot.
        void (async () => {
          try {
            await mkdir(checkoutRoot, { recursive: true })
            const api = new GitlabApi({
              baseUrl: source.baseUrl ?? config.baseUrl ?? 'https://gitlab.com/api/v4',
              tokenProvider: () => sourceToken(source),
            })
            const repos = await api.listGroupProjects(source.group, source.includeSubgroups ?? true)
            for (const repo of repos) {
              const dest = join(checkoutRoot, repo.name)
              try {
                if (existsSync(dest)) await gitPull(dest)
                else await gitClone(`${sourceGitHost(source)}/${repo.pathWithNamespace}.git`, sourceToken(source), dest)
              } catch (error) {
                ctx.logger.warn(`dsh-gitlab: skill repo ${repo.pathWithNamespace} sync failed: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
          } catch (error) {
            ctx.logger.warn(`dsh-gitlab: skill source ${source.id} sync failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        })()
      }
    })
  }
}
