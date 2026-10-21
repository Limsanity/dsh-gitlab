/**
 * Read-only merge-request review surface for the Web client: turn-local MR
 * links, one MR's commits and changed files, a single commit's files, and one
 * file's patch. Every route is workspace-scoped: the caller names a session
 * directory (or a workspace the host already tracks) and a project equal to
 * that workspace's detected GitLab project, so the token never becomes a
 * general GitLab proxy.
 *
 * The release-mr skill gates a release on commit authorship and the changed
 * file set; these routes expose exactly that evidence, fetched live instead of
 * transcribed into a chat message.
 * @module @lim324/dsh-gitlab/src/mr
 */

import { execFile } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { GitlabApi, MrCommitRow, MrDetailRow, MrDiffRow } from './gitlab.ts'
import { GitlabHttpError } from './gitlab.ts'
import { isTrustedLocalRequest } from './fence.ts'

const execFileAsync = promisify(execFile)

/** How long one MR's file list and cached patches serve without a refetch. */
const FILE_TTL_MS = 60_000
/** How many MR file sets stay cached in one process. */
const FILE_CACHE_LIMIT = 24
/** Upper bound for one cached MR's patches; larger patches fall back to GitLab. */
const PATCH_CACHE_BYTES = 4 * 1024 * 1024
/** Upper bound for one file patch sent to the browser. */
const PATCH_RESPONSE_CHARS = 200_000
/** How many turn-local MR links one answer may carry. */
const MAX_TURN_REFS = 5
/** Session text is immutable after the turn closes; cache the parse per turn. */
const TURN_CACHE_LIMIT = 500
/** Identity is read from the checkout's git config; it changes rarely. */
const IDENTITY_TTL_MS = 300_000

/** One MR link found in an assistant answer. */
export interface MrRef {
  url: string
  host: string
  project: string
  iid: number
}

/** The local git identity used to tell the reviewer's commits from others'. */
export interface GitIdentity {
  email: string | null
  name: string | null
}

/** One cached changed file: raw diff row plus computed stats and patch. */
interface FileEntry extends MrDiffRow {
  additions: number
  deletions: number
  binary: boolean
}

/** One MR's cached file page. */
interface FileSet {
  at: number
  files: Map<string, FileEntry>
  order: string[]
  hasMore: boolean
  overflow: boolean
}

/** The workspace summary slice these routes read from the plugin's poller. */
export interface MrWorkspaceStatus {
  gitlab: boolean
  project: string | null
  currentBranch: string | null
  mrs: ReadonlyArray<{
    iid: number
    title: string
    sourceBranch: string
    targetBranch: string
    author: string | null
    webUrl: string | null
  }>
}

/** Small structural workspace row; the registry service stays optional. */
export interface MrWorkspace {
  id: string
  path: string
  title: string
}

/** Host wiring the routes need from the plugin entry. */
export interface MrRouteOptions {
  ctx: Context
  config: { project?: string }
  ensureWorkspace: (workspaceId: string) => Promise<MrWorkspaceStatus | undefined>
  projectForWorkspace: (workspaceId: string) => string | null
  workspaceFor: (workspaceId: string) => MrWorkspace | undefined
  apiForProject: (project: string) => GitlabApi | undefined
}

/** Test seams for git identity and the clock. */
export const mrInternals: {
  runGitIdentity?: (dir: string) => Promise<GitIdentity>
  now?: () => number
} = {}

const now = (): number => mrInternals.now?.() ?? Date.now()

interface SessionEventLike {
  type?: string
  data?: {
    turn?: number
    message?: { content?: ReadonlyArray<{ type?: string; text?: string }> }
  }
}

interface SessionsLike {
  get?: (id: string) => { snapshotEvents?: () => readonly SessionEventLike[] } | undefined
}

interface SessionPersistenceLike {
  stat?: (id: string) => Promise<unknown>
  open?: (
    id: string,
    mode: 'read',
  ) => Promise<{ read: () => Promise<{ events?: readonly SessionEventLike[] }>; close: () => Promise<void> }>
}

export interface MrFileSummary {
  path: string
  oldPath: string | null
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  binary: boolean
  patchAvailable: boolean
}

export interface MrReviewPayload {
  workspaceId: string
  project: string
  mr: MrDetailRow
  commits: Array<MrCommitRow & { mine: 'me' | 'other' | 'unknown' }>
  files: MrFileSummary[]
  hasMoreCommits: boolean
  hasMoreFiles: boolean
  overflow: boolean
  identity: GitIdentity
  fetchedAt: string
}

/** Count added and removed lines in a unified patch. */
export function patchStats(patch: string | null | undefined): { additions: number; deletions: number; binary: boolean } {
  if (patch === null || patch === undefined || patch === '') {
    return { additions: 0, deletions: 0, binary: false }
  }
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { additions, deletions, binary: /^Binary files .* differ$/m.test(patch) }
}

/** Map a raw diff to the file-row status the client badge renders. */
export function fileStatus(diff: Pick<MrDiffRow, 'newFile' | 'deletedFile' | 'renamedFile'>): MrFileSummary['status'] {
  if (diff.newFile) return 'added'
  if (diff.deletedFile) return 'deleted'
  if (diff.renamedFile) return 'renamed'
  return 'modified'
}

/**
 * Classify one commit's author against the local checkout identity.
 * Unknown is a first-class answer: guessing "someone else" from a missing
 * email would turn a gate warning into a false accusation.
 */
export function classifyCommit(
  commit: { authorName: string | null; authorEmail: string | null },
  identity: GitIdentity,
): 'me' | 'other' | 'unknown' {
  const email = commit.authorEmail?.trim().toLowerCase() ?? ''
  const name = commit.authorName?.trim() ?? ''
  const meEmail = identity.email?.trim().toLowerCase() ?? ''
  const meName = identity.name?.trim() ?? ''
  if (email !== '' && meEmail !== '' && email === meEmail) return 'me'
  if (name !== '' && meName !== '' && name === meName) return 'me'
  if (email !== '' && meEmail !== '') return 'other'
  return 'unknown'
}

/**
 * Find merge-request links in one assistant answer.
 *
 * Only canonical `https://<host>/<project>/-/merge_requests/<iid>` URLs count;
 * a bare `!123` is too ambiguous to fetch against. The host/project pair is
 * matched against the workspace remote before any API call, so a link to a
 * different project renders no card rather than borrowing this workspace's
 * token.
 */
export function parseMrRefs(text: string): MrRef[] {
  const refs = new Map<string, MrRef>()
  const pattern = /https?:\/\/[^\s<>"'`\])]+\/-\/merge_requests\/(\d+)/g
  for (const match of text.matchAll(pattern)) {
    const url = match[0]
    const iid = Number(match[1])
    if (!Number.isSafeInteger(iid) || iid <= 0 || iid > 2_147_483_647) continue
    const cut = url.indexOf('/-/merge_requests/')
    if (cut <= 0) continue
    let parsed: URL
    try {
      parsed = new URL(url.slice(0, cut))
    } catch {
      continue
    }
    const project = decodeURIComponent(parsed.pathname.replace(/^\/+|\/+$/g, ''))
    if (project === '' || project.split('/').some(segment => segment === '' || segment === '..')) continue
    refs.set(`${parsed.host}/${project}!${String(iid)}`, { url, host: parsed.host, project, iid })
    if (refs.size >= MAX_TURN_REFS) break
  }
  return [...refs.values()]
}

/** Read the checkout's configured author identity; empty when git has none. */
async function readIdentity(dir: string): Promise<GitIdentity> {
  if (mrInternals.runGitIdentity !== undefined) return mrInternals.runGitIdentity(dir)
  const read = async (key: string): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('git', ['-C', dir, 'config', '--get', key])
      const value = stdout.trim()
      return value === '' ? null : value
    } catch {
      return null
    }
  }
  return { email: await read('user.email'), name: await read('user.name') }
}

/**
 * The Session's durable events, live when attached and from persistence
 * otherwise. Undefined means the services are unavailable or the Session is
 * unknown.
 */
async function readSessionEvents(ctx: Context, sessionId: string): Promise<readonly SessionEventLike[] | undefined> {
  const sessions = ctx.get('sessions') as SessionsLike | undefined
  const live = sessions?.get?.(sessionId)
  if (live?.snapshotEvents !== undefined) {
    try {
      return live.snapshotEvents()
    } catch {
      /* fall through to persistence */
    }
  }
  const persistence = ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
  if (persistence?.stat === undefined || persistence.open === undefined) return undefined
  try {
    if (!(await persistence.stat(sessionId))) return undefined
    const handle = await persistence.open(sessionId, 'read')
    try {
      return (await handle.read()).events
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/**
 * Merge-request links per turn. One scan answers every turn card in a long
 * Session, instead of one request per rendered turn.
 */
async function scanSessionRefs(ctx: Context, sessionId: string): Promise<{ turns: Record<string, MrRef[]>; count: number } | undefined> {
  const events = await readSessionEvents(ctx, sessionId)
  if (events === undefined) return undefined
  const texts = new Map<number, string[]>()
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const turn = event.data?.turn
    if (typeof turn !== 'number' || !Number.isSafeInteger(turn)) continue
    for (const block of event.data?.message?.content ?? []) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue
      const parts = texts.get(turn)
      if (parts === undefined) texts.set(turn, [block.text])
      else parts.push(block.text)
    }
  }
  const turns: Record<string, MrRef[]> = {}
  for (const [turn, parts] of texts) {
    const refs = parseMrRefs(parts.join('\n'))
    if (refs.length > 0) turns[String(turn)] = refs
  }
  return { turns, count: events.length }
}

/** Cheap live generation signal for the session-ref cache. */
function liveEventCount(ctx: Context, sessionId: string): number | undefined {
  const sessions = ctx.get('sessions') as SessionsLike | undefined
  const live = sessions?.get?.(sessionId)
  if (live?.snapshotEvents === undefined) return undefined
  try {
    return live.snapshotEvents().length
  } catch {
    return undefined
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof GitlabHttpError) {
    if (error.status === 401 || error.status === 403) {
      sendJson(res, 401, { error: 'GitLab token cannot read this merge request' })
      return
    }
    if (error.status === 404) {
      sendJson(res, 404, { error: 'Merge request not found' })
      return
    }
  }
  sendJson(res, 502, { error: 'GitLab API request failed' })
}

function positiveInt(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function boundedText(raw: string | null, max: number): string | undefined {
  if (raw === null || raw === '') return undefined
  return raw.length <= max && !raw.includes('\u0000') ? raw : undefined
}

/** Keep a Map at its limit by evicting the oldest insertion. */
function trimMap(map: Map<string, unknown>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest === undefined) return
    map.delete(oldest)
  }
}

/**
 * Mount the four read-only review routes.
 * @param options - host wiring: workspace resolution, poller, and API clients.
 */
export function registerMrRoutes(options: MrRouteOptions): void {
  const { ctx, config } = options
  const fileCache = new Map<string, FileSet>()
  const identityCache = new Map<string, { at: number; value: GitIdentity }>()
  const turnRefCache = new Map<string, MrRef[]>()
  const sessionRefCache = new Map<string, { at: number; count: number; turns: Record<string, MrRef[]> }>()
  const SESSION_REF_TTL_MS = 10_000

  const workspaceIdForCwd = (cwd: string): string | undefined => {
    if (config.project !== undefined) return '__configured__'
    const target = resolvePath(cwd)
    if (target === resolvePath(process.cwd())) return '__cwd__'
    const registry = ctx.get('workspaceRegistry') as { list: () => MrWorkspace[] } | undefined
    // Session summaries and registry rows may differ only by a trailing slash
    // or a redundant segment; compare canonical paths.
    return registry?.list().find(entry => resolvePath(entry.path) === target)?.id
  }

  const workspaceForRequest = (url: URL): string | undefined => {
    const explicit = url.searchParams.get('workspaceId')
    if (explicit !== null && explicit !== '') return explicit
    const cwd = url.searchParams.get('cwd')
    return cwd === null || cwd === '' ? undefined : workspaceIdForCwd(cwd)
  }

  const loadIdentity = async (workspaceId: string): Promise<GitIdentity> => {
    const dir = options.workspaceFor(workspaceId)?.path ?? ''
    if (dir === '') return { email: null, name: null }
    const cached = identityCache.get(dir)
    if (cached !== undefined && now() - cached.at < IDENTITY_TTL_MS) return cached.value
    const value = await readIdentity(dir).catch(() => ({ email: null, name: null }))
    identityCache.set(dir, { at: now(), value })
    trimMap(identityCache, 32)
    return value
  }

  const loadFiles = async (api: GitlabApi, project: string, iid: number, force = false): Promise<FileSet> => {
    const key = `${project}!${String(iid)}`
    const cached = fileCache.get(key)
    if (!force && cached !== undefined && now() - cached.at < FILE_TTL_MS) return cached
    const page = await api.listMrDiffs(project, iid, 1, 100)
    const files = new Map<string, FileEntry>()
    const order: string[] = []
    let bytes = 0
    for (const diff of page.diffs) {
      if (diff.path === '') continue
      const stats = patchStats(diff.patch)
      // Patches beyond the per-MR budget stay `null`; the file route then
      // points at GitLab instead of shipping a multi-megabyte answer.
      const keepPatch = diff.patch !== null && bytes + diff.patch.length <= PATCH_CACHE_BYTES
      if (keepPatch) bytes += diff.patch?.length ?? 0
      files.set(diff.path, {
        ...diff,
        patch: keepPatch ? diff.patch : null,
        additions: stats.additions,
        deletions: stats.deletions,
        binary: stats.binary,
      })
      order.push(diff.path)
    }
    const value: FileSet = { at: now(), files, order, hasMore: page.hasMore, overflow: page.overflow }
    fileCache.set(key, value)
    trimMap(fileCache, FILE_CACHE_LIMIT)
    return value
  }

  /** Extend a cached first page with later pages until the path appears. */
  const findFile = async (
    api: GitlabApi,
    project: string,
    iid: number,
    path: string,
  ): Promise<FileEntry | undefined> => {
    const set = await loadFiles(api, project, iid)
    const direct = set.files.get(path)
    if (direct !== undefined) return direct
    let page = 2
    while (set.hasMore && page <= 3) {
      const next = await api.listMrDiffs(project, iid, page, 100)
      for (const diff of next.diffs) {
        if (diff.path === '' || set.files.has(diff.path)) continue
        const stats = patchStats(diff.patch)
        set.files.set(diff.path, {
          ...diff,
          patch: diff.patch,
          additions: stats.additions,
          deletions: stats.deletions,
          binary: stats.binary,
        })
        set.order.push(diff.path)
      }
      set.hasMore = next.hasMore
      if (set.files.has(path)) return set.files.get(path)
      page += 1
    }
    return undefined
  }

  const resolveTarget = async (
    workspaceId: string,
    requestedProject: string | null,
  ): Promise<{ status: MrWorkspaceStatus; api: GitlabApi; project: string } | undefined> => {
    const status = await options.ensureWorkspace(workspaceId)
    if (status === undefined || !status.gitlab || status.project === null || status.project === '') return undefined
    const project = options.projectForWorkspace(workspaceId) ?? status.project
    if (requestedProject !== null && requestedProject !== '' && requestedProject !== project) return undefined
    const api = options.apiForProject(project)
    if (api === undefined) return undefined
    return { status, api, project }
  }

  // ── turn-local MR links ──────────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/gitlab/turn-mrs',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!isTrustedLocalRequest(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        const sessionId = boundedText(url.searchParams.get('sessionId'), 160)
        const turn = positiveInt(url.searchParams.get('turn'))
        if (sessionId === undefined || turn === undefined || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
          sendJson(res, 400, { error: 'missing sessionId or turn' })
          return
        }
        const key = `${sessionId}:${String(turn)}`
        const cached = turnRefCache.get(key)
        if (cached !== undefined) {
          sendJson(res, 200, { refs: cached, available: true })
          return
        }
        const events = await readSessionEvents(ctx, sessionId)
        if (events === undefined) {
          sendJson(res, 200, { refs: [], available: false })
          return
        }
        const parts: string[] = []
        for (const event of events) {
          if (event.type !== 'assistant/message' || event.data?.turn !== turn) continue
          for (const block of event.data.message?.content ?? []) {
            if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
          }
        }
        const refs = parseMrRefs(parts.join('\n'))
        turnRefCache.set(key, refs)
        trimMap(turnRefCache, TURN_CACHE_LIMIT)
        sendJson(res, 200, { refs, available: true })
      } catch {
        sendJson(res, 500, { error: 'turn scan failed' })
      }
    },
  }), 'dsh-gitlab: turn MR refs')

  // ── every turn's MR links in one scan ────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/gitlab/session-mrs',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!isTrustedLocalRequest(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        const sessionId = boundedText(url.searchParams.get('sessionId'), 160)
        if (sessionId === undefined || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
          sendJson(res, 400, { error: 'missing sessionId' })
          return
        }
        const cached = sessionRefCache.get(sessionId)
        // A live Session reports its event count cheaply; a new turn changes
        // it and invalidates the cache, so a card for the new turn cannot
        // appear one turn late.
        const liveCount = liveEventCount(ctx, sessionId)
        if (cached !== undefined && now() - cached.at < SESSION_REF_TTL_MS
          && (liveCount === undefined || cached.count === liveCount)) {
          sendJson(res, 200, { turns: cached.turns, available: true })
          return
        }
        const scanned = await scanSessionRefs(ctx, sessionId)
        if (scanned === undefined) {
          sendJson(res, 200, { turns: {}, available: false })
          return
        }
        sessionRefCache.set(sessionId, { at: now(), count: scanned.count, turns: scanned.turns })
        trimMap(sessionRefCache, 50)
        sendJson(res, 200, { turns: scanned.turns, available: true })
      } catch {
        sendJson(res, 500, { error: 'session scan failed' })
      }
    },
  }), 'dsh-gitlab: session MR refs')

  // ── one MR: metadata, commits, files ─────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/gitlab/mr',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!isTrustedLocalRequest(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        const workspaceId = workspaceForRequest(url)
        const iid = positiveInt(url.searchParams.get('iid'))
        if (workspaceId === undefined) {
          sendJson(res, 400, { error: 'missing workspace' })
          return
        }
        if (iid === undefined) {
          sendJson(res, 400, { error: 'missing iid' })
          return
        }
        const target = await resolveTarget(workspaceId, url.searchParams.get('project'))
        if (target === undefined) {
          sendJson(res, 404, { error: 'unknown workspace or project' })
          return
        }
        const force = url.searchParams.get('refresh') === '1'
        const [mr, commitPage, fileSet, identity] = await Promise.all([
          target.api.getMr(target.project, iid),
          target.api.listMrCommits(target.project, iid),
          loadFiles(target.api, target.project, iid, force),
          loadIdentity(workspaceId),
        ])
        const files: MrFileSummary[] = []
        for (const path of fileSet.order) {
          const file = fileSet.files.get(path)
          if (file === undefined) continue
          files.push({
            path: file.path,
            oldPath: file.oldPath,
            status: fileStatus(file),
            additions: file.additions,
            deletions: file.deletions,
            binary: file.binary,
            patchAvailable: file.patch !== null,
          })
        }
        const payload: MrReviewPayload = {
          workspaceId,
          project: target.project,
          mr,
          commits: commitPage.commits.map(commit => ({ ...commit, mine: classifyCommit(commit, identity) })),
          files,
          hasMoreCommits: commitPage.hasMore,
          hasMoreFiles: fileSet.hasMore,
          overflow: fileSet.overflow,
          identity,
          fetchedAt: new Date(now()).toISOString(),
        }
        sendJson(res, 200, payload)
      } catch (error) {
        fail(res, error)
      }
    },
  }), 'dsh-gitlab: MR detail route')

  // ── one commit's files ──────────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/gitlab/mr/commit',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!isTrustedLocalRequest(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        const workspaceId = workspaceForRequest(url)
        const iid = positiveInt(url.searchParams.get('iid'))
        const sha = boundedText(url.searchParams.get('sha'), 64)
        if (workspaceId === undefined || iid === undefined || sha === undefined || !/^[0-9a-f]{7,64}$/i.test(sha)) {
          sendJson(res, 400, { error: 'missing or invalid parameters' })
          return
        }
        const target = await resolveTarget(workspaceId, url.searchParams.get('project'))
        if (target === undefined) {
          sendJson(res, 404, { error: 'unknown workspace or project' })
          return
        }
        const diffs = await target.api.listCommitDiffs(target.project, sha)
        sendJson(res, 200, {
          sha,
          files: diffs.filter(diff => diff.path !== '').map(diff => ({
            path: diff.path,
            oldPath: diff.oldPath,
            status: fileStatus(diff),
          })),
        })
      } catch (error) {
        fail(res, error)
      }
    },
  }), 'dsh-gitlab: MR commit route')

  // ── one file's patch ────────────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/gitlab/mr/file',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!isTrustedLocalRequest(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        const workspaceId = workspaceForRequest(url)
        const iid = positiveInt(url.searchParams.get('iid'))
        const path = boundedText(url.searchParams.get('path'), 1024)
        if (workspaceId === undefined || iid === undefined || path === undefined) {
          sendJson(res, 400, { error: 'missing or invalid parameters' })
          return
        }
        const target = await resolveTarget(workspaceId, url.searchParams.get('project'))
        if (target === undefined) {
          sendJson(res, 404, { error: 'unknown workspace or project' })
          return
        }
        const file = await findFile(target.api, target.project, iid, path)
        if (file === undefined) {
          sendJson(res, 404, { error: 'file is not part of this merge request' })
          return
        }
        const patch = file.patch ?? ''
        const truncated = patch.length > PATCH_RESPONSE_CHARS
        sendJson(res, 200, {
          path: file.path,
          status: fileStatus(file),
          additions: file.additions,
          deletions: file.deletions,
          binary: file.binary,
          patch: truncated ? patch.slice(0, PATCH_RESPONSE_CHARS) : patch,
          truncated,
          unavailable: file.patch === null,
        })
      } catch (error) {
        fail(res, error)
      }
    },
  }), 'dsh-gitlab: MR file route')

  // ── current branch's open MRs (composer dock) ───────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/gitlab/branch-mrs',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!isTrustedLocalRequest(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        const workspaceId = workspaceForRequest(url)
        if (workspaceId === undefined) {
          sendJson(res, 400, { error: 'missing workspace' })
          return
        }
        const status = await options.ensureWorkspace(workspaceId)
        if (status === undefined || !status.gitlab || status.project === null) {
          sendJson(res, 404, { error: 'unknown workspace or project' })
          return
        }
        const branch = status.currentBranch
        const mrs = branch === null ? [] : status.mrs.filter(mr => mr.sourceBranch === branch)
        sendJson(res, 200, {
          workspaceId,
          project: status.project,
          branch,
          mrs: mrs.map(mr => ({
            iid: mr.iid,
            title: mr.title,
            sourceBranch: mr.sourceBranch,
            targetBranch: mr.targetBranch,
            webUrl: mr.webUrl,
          })),
        })
      } catch (error) {
        fail(res, error)
      }
    },
  }), 'dsh-gitlab: branch MRs route')
}
