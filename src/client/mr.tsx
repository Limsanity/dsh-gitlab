/**
 * Message-page MR review surfaces.
 *
 * Three mounts, all first-party React over the host's read-only MR routes:
 * - `conversation.chat.turnTail`: a card at the end of the turn whose answer
 *   links a merge request, showing the release-gate evidence (commit
 *   authorship, merge commits, conflicts, changed files).
 * - `conversation.composer.dock`: a slim status bar for the current branch's
 *   open merge requests.
 * - `sidebar.right.pane.tab`: the full review pane (file list + unified diff).
 *
 * Nothing here calls the model. Card/pane actions only read; merge and approve
 * stay in the GitLab tab, so a review card can never merge by accident.
 * @module @lim324/dsh-gitlab/client/mr
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

/** The services the surfaces use; both sides are optional at mount time. */
export interface MrSurfacesHost {
  canOpenReview: boolean
  openReview: (input: { cwd: string; project: string; iid: number; path?: string }) => void
  /**
   * Whether a chat message can be submitted to the session (the card's
   * "let the agent merge" action). The card never calls the GitLab merge API.
   */
  canMergeViaAgent: boolean
  mergeViaAgent: (input: { sessionId: string; project: string; iid: number; sourceBranch: string; targetBranch: string; webUrl: string | null }) => Promise<void>
}

/** The user-turn text a merge request from the card submits. */
export function mergePrompt(input: { iid: number; sourceBranch: string; targetBranch: string; webUrl: string | null }): string {
  return [
    `请合入这个 MR（用户已在审查卡上明确确认）：!${String(input.iid)} → ${input.targetBranch}`,
    `源分支：${input.sourceBranch}`,
    ...(input.webUrl === null ? [] : [input.webUrl]),
    '',
    '执行前请重新 fetch，并按 release-mr 的闸门复核（G1–G4；staging 用 S1–S6）。',
    '任一闸不过就停手并列出证据，不要试合、不要强推。',
  ].join('\n')
}

/** Stable identities of the sidebar tab type and its body entry. */
export const MR_TAB_KIND = 'gitlab-mr-review'
export const MR_TAB_ID = '@lim324/dsh-gitlab/mr-review'

interface MrRef { url: string; host: string; project: string; iid: number }

interface MrCommit {
  id: string
  shortId: string
  title: string
  authorName: string | null
  authorEmail: string | null
  authoredDate: string | null
  parentCount: number
  mergeSuspect: boolean
  webUrl: string | null
  mine: 'me' | 'other' | 'unknown'
}

interface MrFile {
  path: string
  oldPath: string | null
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  binary: boolean
  patchAvailable: boolean
}

interface MrPayload {
  workspaceId: string
  project: string
  mr: {
    iid: number
    title: string
    state: string
    webUrl: string | null
    sourceBranch: string
    targetBranch: string
    author: { name: string | null; username: string | null }
    hasConflicts: boolean
    detailedMergeStatus: string | null
    mergeStatus: string | null
    changesCount: string | null
    sha: string | null
    createdAt: string | null
    updatedAt: string | null
  }
  commits: MrCommit[]
  files: MrFile[]
  hasMoreCommits: boolean
  hasMoreFiles: boolean
  overflow: boolean
  identity: { email: string | null; name: string | null }
  fetchedAt: string
}

interface MrFilePatch {
  path: string
  status: MrFile['status']
  additions: number
  deletions: number
  binary: boolean
  patch: string
  truncated: boolean
  unavailable: boolean
}

interface BranchMrs {
  project: string
  branch: string | null
  mrs: Array<{ iid: number; title: string; sourceBranch: string; targetBranch: string; webUrl: string | null }>
}

interface CardItem {
  ref: MrRef
  detail: MrPayload
  newCommits: string[]
}

const DETAIL_TTL_MS = 30_000
const PATCH_CACHE_LIMIT = 40
const SHOWN_DIFF_LINES = 1200
const BASELINE_PREFIX = 'dsh-gitlab.mr-baseline.v1:'

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    let note = `HTTP ${String(response.status)}`
    try {
      const body = await response.json() as { error?: unknown }
      if (typeof body.error === 'string') note = body.error
    } catch { /* keep the status note */ }
    throw new HttpError(response.status, note)
  }
  return await response.json() as T
}

const detailCache = new Map<string, { at: number; value: MrPayload }>()
const detailInflight = new Map<string, Promise<MrPayload>>()
const sessionRefsInflight = new Map<string, Promise<Record<string, MrRef[]>>>()
const patchCache = new Map<string, MrFilePatch>()

function detailKey(cwd: string, project: string, iid: number): string {
  return `${cwd}\u0000${project}!${String(iid)}`
}

/**
 * Every turn's MR links for one Session, in one request. A long Session
 * renders many turn tails; coalescing them keeps the first paint to one call
 * instead of one per turn.
 */
async function loadSessionRefs(sessionId: string): Promise<Record<string, MrRef[]>> {
  // Concurrent mounts (the turn tails of one session paint together) share a
  // request; there is no result cache, because a new turn must be visible on
  // its first mount instead of one turn late. The host cache carries the
  // generation check.
  const inflight = sessionRefsInflight.get(sessionId)
  if (inflight !== undefined) return inflight
  const promise = getJson<{ turns?: Record<string, MrRef[]> }>(
    `/gitlab/session-mrs?${new URLSearchParams({ sessionId }).toString()}`,
  ).then(body => (body.turns !== undefined && body.turns !== null && typeof body.turns === 'object' ? body.turns : {}))
    .finally(() => { sessionRefsInflight.delete(sessionId) })
  sessionRefsInflight.set(sessionId, promise)
  return promise
}

async function loadDetail(
  input: { cwd: string; project: string; iid: number },
  options: { signal?: AbortSignal; refresh?: boolean } = {},
): Promise<MrPayload> {
  const key = detailKey(input.cwd, input.project, input.iid)
  if (options.refresh !== true) {
    const cached = detailCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < DETAIL_TTL_MS) return cached.value
    const inflight = detailInflight.get(key)
    if (inflight !== undefined) return inflight
  }
  const params = new URLSearchParams({ cwd: input.cwd, project: input.project, iid: String(input.iid) })
  if (options.refresh === true) params.set('refresh', '1')
  const promise = getJson<MrPayload>(`/gitlab/mr?${params.toString()}`, options.signal)
    .then(value => {
      detailCache.set(key, { at: Date.now(), value })
      while (detailCache.size > 30) {
        const oldest = detailCache.keys().next().value
        if (oldest === undefined) break
        detailCache.delete(oldest)
      }
      return value
    })
    .finally(() => { detailInflight.delete(key) })
  if (options.refresh !== true) detailInflight.set(key, promise)
  return promise
}

async function loadPatch(
  input: { cwd: string; project: string; iid: number; path: string },
  options: { refresh?: boolean } = {},
): Promise<MrFilePatch> {
  const key = detailKey(input.cwd, input.project, input.iid) + `\u0000${input.path}`
  if (options.refresh !== true) {
    const cached = patchCache.get(key)
    if (cached !== undefined) return cached
  }
  const params = new URLSearchParams({ cwd: input.cwd, project: input.project, iid: String(input.iid), path: input.path })
  const value = await getJson<MrFilePatch>(`/gitlab/mr/file?${params.toString()}`)
  patchCache.set(key, value)
  while (patchCache.size > PATCH_CACHE_LIMIT) {
    const oldest = patchCache.keys().next().value
    if (oldest === undefined) break
    patchCache.delete(oldest)
  }
  return value
}

/** Read one MR's saved commit baseline, if this browser saved one. */
function readBaseline(sessionId: string, turn: number, iid: number): { commits: string[] } | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(`${BASELINE_PREFIX}${sessionId}:${String(turn)}:${String(iid)}`)
    if (typeof raw !== 'string') return null
    const parsed = JSON.parse(raw) as { commits?: unknown }
    return Array.isArray(parsed.commits) && parsed.commits.every(item => typeof item === 'string')
      ? { commits: parsed.commits as string[] }
      : null
  } catch {
    return null
  }
}

function writeBaseline(sessionId: string, turn: number, iid: number, commits: string[]): void {
  try {
    globalThis.sessionStorage?.setItem(
      `${BASELINE_PREFIX}${sessionId}:${String(turn)}:${String(iid)}`,
      JSON.stringify({ commits }),
    )
  } catch { /* private mode: new badges simply stay off */ }
}

/**
 * Show GitLab's own vocabulary instead of translating it: reviewers compare the
 * chip with the API, docs and CI output. State wins for a merged/closed MR
 * (it reports `detailed_merge_status: "not_open"` there); otherwise the
 * mergeability verdict is the useful value. Tone only color-codes it.
 */
export function statusLabel(mr: MrPayload['mr']): { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  const state = typeof mr.state === 'string' && mr.state !== '' ? mr.state : 'unknown'
  if (state !== 'opened') return { text: state, tone: state === 'merged' ? 'ok' : 'muted' }
  if (mr.hasConflicts) return { text: 'conflict', tone: 'bad' }
  if (mr.detailedMergeStatus !== null && mr.detailedMergeStatus !== '') {
    return { text: mr.detailedMergeStatus, tone: mergeTone(mr.detailedMergeStatus) }
  }
  if (mr.mergeStatus !== null && mr.mergeStatus !== '') {
    return {
      text: mr.mergeStatus,
      tone: mr.mergeStatus === 'can_be_merged' ? 'ok' : mr.mergeStatus === 'cannot_be_merged' ? 'bad' : 'muted',
    }
  }
  return { text: 'unknown', tone: 'muted' }
}

/** Tone for one GitLab mergeability verdict. */
function mergeTone(status: string): 'ok' | 'warn' | 'bad' | 'muted' {
  if (status === 'mergeable') return 'ok'
  if (status === 'checking' || status === 'unchecked' || status === 'not_open') return 'muted'
  if (status === 'conflict' || status === 'broken_status') return 'bad'
  return 'warn'
}

function fileLetter(status: MrFile['status']): string {
  if (status === 'added') return 'A'
  if (status === 'deleted') return 'D'
  if (status === 'renamed') return 'R'
  return 'M'
}

function formatDate(raw: string | null): string {
  if (raw === null) return ''
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return ''
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${month}-${day} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function diffLineClass(line: string): string {
  if (line.startsWith('@@')) return 'gli-diff-hunk'
  if (line.startsWith('+') && !line.startsWith('+++')) return 'gli-diff-add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'gli-diff-del'
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) return 'gli-diff-meta'
  return ''
}


/* ─────────────────────────────── icons ─────────────────────────────────── */

interface IconSize { size?: number }

function Svg({ size = 16, children }: IconSize & { children: ReactNode }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function IconMr({ size }: IconSize): ReactNode {
  return (
    <Svg size={size}>
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="12" cy="3.5" r="1.5" />
      <circle cx="8" cy="12.5" r="1.5" />
      <path d="M4 5v1a3 3 0 0 0 3 3M12 5v1a3 3 0 0 1-3 3M8 9v2" />
    </Svg>
  )
}

function IconChevron({ size }: IconSize): ReactNode {
  return <Svg size={size}><path d="M4 6.5 8 10.5l4-4" /></Svg>
}

function IconBack({ size }: IconSize): ReactNode {
  return <Svg size={size}><path d="M9.5 3.5 5 8l4.5 4.5" /></Svg>
}

function IconRefresh({ size }: IconSize): ReactNode {
  return (
    <Svg size={size}>
      <path d="M13 8a5 5 0 1 1-1.6-3.7M13 3v2.6h-2.6" />
    </Svg>
  )
}

function IconExternal({ size }: IconSize): ReactNode {
  return (
    <Svg size={size}>
      <path d="M9 3h4v4M13 3 7.5 8.5" />
      <path d="M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5" />
    </Svg>
  )
}

function IconCopy({ size }: IconSize): ReactNode {
  return (
    <Svg size={size}>
      <rect x="5.5" y="5.5" width="7" height="7" rx="1.2" />
      <path d="M10.5 5.5V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h1.5" />
    </Svg>
  )
}

function IconUp({ size }: IconSize): ReactNode {
  return <Svg size={size}><path d="M8 13V3M4 7l4-4 4 4" /></Svg>
}

function IconDown({ size }: IconSize): ReactNode {
  return <Svg size={size}><path d="M8 3v10M4 9l4 4 4-4" /></Svg>
}

function IconClose({ size }: IconSize): ReactNode {
  return <Svg size={size}><path d="M4 4l8 8M12 4l-8 8" /></Svg>
}

function IconPanel({ size }: IconSize): ReactNode {
  return (
    <Svg size={size}>
      <rect x="2.5" y="3" width="11" height="10" rx="1.2" />
      <path d="M9.5 3v10" />
    </Svg>
  )
}

function IconSpark({ size }: IconSize): ReactNode {
  return (
    <Svg size={size}>
      <path d="M8 2.5l1.1 2.9L12 6.5l-2.9 1.1L8 10.5 6.9 7.6 4 6.5l2.9-1.1L8 2.5Z" />
      <path d="M12.5 10.5l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5.5-1.3Z" />
    </Svg>
  )
}

/* ─────────────────────────────── turn-tail card ─────────────────────────── */

export function MrTurnTail(props: Record<string, unknown> & { host: MrSurfacesHost }): ReactNode {
  const { host, ...rest } = props
  const sessionId = typeof rest.sessionId === 'string' ? rest.sessionId : undefined
  const turnLocation = rest.turn
  const turn = typeof turnLocation === 'number'
    ? turnLocation
    : typeof turnLocation === 'object' && turnLocation !== null && typeof (turnLocation as { turn?: unknown }).turn === 'number'
      ? (turnLocation as { turn: number }).turn
      : undefined
  const useSessions = rest.useSessions as ((selector: (state: unknown) => unknown) => unknown) | undefined
  const readCwd = useSessions ?? (() => undefined)
  // The selector runs on every render; sessionId is fixed for this slot entry.
  const cwd = readCwd((state: unknown) => {
    const byId = (state as { byId?: Record<string, { cwd?: string }> } | undefined)?.byId
    return sessionId === undefined ? undefined : byId?.[sessionId]?.cwd
  }) as string | undefined

  const [items, setItems] = useState<CardItem[]>([])
  const [hasRefs, setHasRefs] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState<'commits' | 'files'>('commits')
  const [onlyOthers, setOnlyOthers] = useState(false)
  const [commitFiles, setCommitFiles] = useState<Record<string, { loading: boolean; files?: Array<{ path: string; status: MrFile['status'] }>; error?: string }>>({})
  const [fileFilter, setFileFilter] = useState<{ iid: number; sha: string; paths: string[] } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [confirmMerge, setConfirmMerge] = useState<number | null>(null)
  const [mergeState, setMergeState] = useState<Record<number, 'sending' | 'sent' | 'error'>>({})
  const mounted = useRef(true)
  const inflight = useRef<AbortController | null>(null)

  useEffect(() => () => {
    mounted.current = false
    inflight.current?.abort()
  }, [])

  const load = useCallback(async (refresh: boolean) => {
    if (sessionId === undefined || turn === undefined || cwd === undefined) return
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    if (refresh) setRefreshing(true)
    setError('')
    try {
      const byTurn = await loadSessionRefs(sessionId)
      const refs = byTurn[String(turn)] ?? []
      if (refs.length > 0 && mounted.current) setHasRefs(true)
      const next: CardItem[] = []
      for (const ref of refs) {
        try {
          const detail = await loadDetail({ cwd, project: ref.project, iid: ref.iid }, { signal: controller.signal, refresh })
          const baseline = readBaseline(sessionId, turn, ref.iid)
          const ids = detail.commits.map(commit => commit.id)
          if (baseline === null) writeBaseline(sessionId, turn, ref.iid, ids)
          const known = new Set(baseline?.commits ?? ids)
          next.push({ ref, detail, newCommits: detail.commits.filter(commit => !known.has(commit.id)).map(commit => commit.id) })
        } catch (failure) {
          // A 404 means the link names another project; that is not an error
          // worth surfacing on this workspace's answer.
          if (!(failure instanceof HttpError) || failure.status !== 404) throw failure
        }
      }
      if (!mounted.current) return
      setItems(next)
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted) return
      setError(failure instanceof Error ? failure.message : '加载失败')
    } finally {
      if (mounted.current) setRefreshing(false)
    }
  }, [cwd, sessionId, turn])

  useEffect(() => {
    void load(false)
  }, [load])

  const openReview = (detail: MrPayload, path?: string): void => {
    if (cwd === undefined || !host.canOpenReview) return
    host.openReview({ cwd, project: detail.project, iid: detail.mr.iid, path })
  }

  const loadCommitFiles = async (detail: MrPayload, commit: MrCommit): Promise<void> => {
    if (cwd === undefined) return
    const key = `${String(detail.mr.iid)}:${commit.id}`
    setCommitFiles(previous => ({ ...previous, [key]: { loading: true } }))
    try {
      const body = await getJson<{ files: Array<{ path: string; status: MrFile['status'] }> }>(
        `/gitlab/mr/commit?${new URLSearchParams({ cwd, project: detail.project, iid: String(detail.mr.iid), sha: commit.id }).toString()}`,
      )
      if (!mounted.current) return
      setCommitFiles(previous => ({ ...previous, [key]: { loading: false, files: body.files } }))
    } catch {
      if (!mounted.current) return
      setCommitFiles(previous => ({ ...previous, [key]: { loading: false, error: '无法读取提交文件' } }))
    }
  }

  const askAgentToMerge = async (detail: MrPayload): Promise<void> => {
    const iid = detail.mr.iid
    setConfirmMerge(null)
    setMergeState(previous => ({ ...previous, [iid]: 'sending' }))
    try {
      await host.mergeViaAgent({
        sessionId: sessionId ?? '',
        project: detail.project,
        iid,
        sourceBranch: detail.mr.sourceBranch,
        targetBranch: detail.mr.targetBranch,
        webUrl: detail.mr.webUrl,
      })
      if (mounted.current) setMergeState(previous => ({ ...previous, [iid]: 'sent' }))
    } catch {
      if (mounted.current) setMergeState(previous => ({ ...previous, [iid]: 'error' }))
    }
  }

  const markRead = (item: CardItem): void => {
    if (sessionId === undefined || turn === undefined) return
    writeBaseline(sessionId, turn, item.detail.mr.iid, item.detail.commits.map(commit => commit.id))
    setItems(previous => previous.map(entry => entry.detail.mr.iid === item.detail.mr.iid ? { ...entry, newCommits: [] } : entry))
  }

  if (sessionId === undefined || turn === undefined || cwd === undefined) return null
  // Most turns carry no MR link; render nothing rather than a skeleton, so a
  // long Session does not flash one placeholder per turn on first paint.
  if (items.length === 0 && error === '') return null

  return (
    <div className="gli-tail">
      {items.map(item => {
        const detail = item.detail
        const mr = detail.mr
        const status = statusLabel(mr)
        const others = detail.commits.filter(commit => commit.mine === 'other')
        const unknown = detail.commits.filter(commit => commit.mine === 'unknown')
        const merges = detail.commits.filter(commit => commit.mergeSuspect)
        const additions = detail.files.reduce((total, file) => total + file.additions, 0)
        const deletions = detail.files.reduce((total, file) => total + file.deletions, 0)
        const commitsShown = onlyOthers ? others : detail.commits
        const visibleFiles = fileFilter !== null && fileFilter.iid === mr.iid
          ? detail.files.filter(file => fileFilter.paths.includes(file.path))
          : detail.files
        const warnings: string[] = []
        if (others.length > 0) warnings.push(`${others.length} 条他人的提交`)
        if (merges.length > 0) warnings.push(`${merges.length} 个 merge 提交`)
        if (unknown.length > 0) warnings.push(`${unknown.length} 条作者未知`)
        return (
          <section className="gli-card" key={`${detail.project}!${String(mr.iid)}`} aria-label={`合并请求 !${String(mr.iid)} 审查`}>
            <div className="gli-card-head">
              <button
                type="button"
                className="gli-expand gli-head-main"
                onClick={() => setExpanded(value => !value)}
                aria-expanded={expanded}
              >
                <span className="gli-tile"><IconMr size={18} /></span>
                <span className="gli-head-copy">
                  <span className="gli-head-line">
                    <span className="gli-mr">!{mr.iid}</span>
                    <span className="gli-branch">→ {mr.targetBranch}</span>
                    <span className="gli-chevron" data-open={expanded ? 'true' : undefined}><IconChevron /></span>
                  </span>
                  <span className="gli-card-title">{mr.title}</span>
                  <span className="gli-card-meta">
                    <span className={`gli-status gli-status-${status.tone}`}>
                      <span className="gli-status-dot" aria-hidden="true" />
                      {status.text}
                    </span>
                    <span className="gli-sep">·</span>
                    <span><span className="gli-num">{detail.commits.length}{detail.hasMoreCommits ? '+' : ''}</span> 提交</span>
                    <span className="gli-sep">·</span>
                    <span><span className="gli-num">{detail.files.length}{detail.hasMoreFiles ? '+' : ''}</span> 文件</span>
                    <span className="gli-sep">·</span>
                    <span className="gli-counts">
                      <span className="gli-plus">+{additions}</span>
                      <span className="gli-minus">−{deletions}</span>
                    </span>
                  </span>
                  {warnings.length > 0
                    ? <span className="gli-warn-line">{warnings.join(' · ')}</span>
                    : detail.commits.length > 0 ? <span className="gli-ok-line">提交均为你</span> : null}
                </span>
              </button>
              <button
                type="button"
                className="gli-icon-btn"
                title="刷新"
                aria-label="刷新合并请求"
                disabled={refreshing}
                onClick={() => { void load(true) }}
              ><IconRefresh size={15} /></button>
            </div>

            {item.newCommits.length > 0 && (
              <div className="gli-note">
                自上次查看后 +{item.newCommits.length} 提交
                <button type="button" className="gli-link-btn" onClick={() => markRead(item)}>标记已读</button>
              </div>
            )}
            {detail.identity.email === null && detail.identity.name === null && (
              <div className="gli-note gli-note-muted">本仓库未配置 git 作者，提交归属显示为「未知」。</div>
            )}

            {expanded && (
              <div className="gli-body">
                <div className="gli-body-bar">
                  <div className="gli-seg" role="tablist" aria-label="审查视图">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === 'commits'}
                      className="gli-seg-item gli-tab"
                      onClick={() => setTab('commits')}
                    >提交 <span className="gli-num">{detail.commits.length}</span></button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === 'files'}
                      className="gli-seg-item gli-tab"
                      onClick={() => setTab('files')}
                    >文件 <span className="gli-num">{detail.files.length}</span></button>
                  </div>
                  {tab === 'commits' && others.length > 0 && (
                    <button
                      type="button"
                      className={onlyOthers ? 'gli-text-btn gli-text-btn-on' : 'gli-text-btn'}
                      aria-pressed={onlyOthers}
                      onClick={() => setOnlyOthers(value => !value)}
                    >只看他人</button>
                  )}
                </div>

                {tab === 'commits' ? (
                  <div className="gli-list">
                    {commitsShown.length === 0 && <div className="gli-empty">没有符合条件的提交</div>}
                    {commitsShown.map(commit => {
                      const key = `${String(mr.iid)}:${commit.id}`
                      const drill = commitFiles[key]
                      const isNew = item.newCommits.includes(commit.id)
                      return (
                        <div key={commit.id} className="gli-row-wrap">
                          <button
                            type="button"
                            className="gli-row gli-commit"
                            onClick={() => { void loadCommitFiles(detail, commit) }}
                            aria-expanded={drill?.files !== undefined}
                          >
                            <span className="gli-row-main">
                              <span className="gli-row-title">{commit.title}</span>
                              <span className="gli-row-sub">
                                <span className={`gli-author gli-author-${commit.mine === 'me' ? 'me' : commit.mine === 'other' ? 'other' : 'unknown'}`}>
                                  {commit.mine === 'me' ? '你' : commit.mine === 'other' ? '他人' : '未知'}
                                </span>
                                <span className="gli-sep">·</span>
                                <span className="gli-sha">{commit.shortId}</span>
                                <span className="gli-sep">·</span>
                                <span className="gli-sub-text">{commit.authorName ?? '未知作者'}</span>
                                <span className="gli-sep">·</span>
                                <span className="gli-sub-text">{formatDate(commit.authoredDate)}</span>
                                {commit.mergeSuspect && <span className="gli-tag">merge</span>}
                              </span>
                            </span>
                            {isNew && <span className="gli-new" title="新提交" aria-label="新提交" />}
                          </button>
                          {drill !== undefined && (
                            <div className="gli-drill">
                              {drill.loading && <span className="gli-muted-text">读取提交文件…</span>}
                              {drill.error !== undefined && <span className="gli-error-text">{drill.error}</span>}
                              {drill.files !== undefined && (
                                <>
                                  <div className="gli-drill-title">这条提交改了 {drill.files.length} 个文件</div>
                                  {drill.files.map(file => (
                                    <div className="gli-drill-row" key={file.path}>
                                      <span className={`gli-file-letter gli-file-${file.status}`}>{fileLetter(file.status)}</span>
                                      <span className="gli-path" title={file.path}>{file.path}</span>
                                    </div>
                                  ))}
                                  {drill.files.length > 0 && (
                                    <button
                                      type="button"
                                      className="gli-link-btn"
                                      onClick={() => {
                                        setFileFilter({ iid: mr.iid, sha: commit.shortId, paths: drill.files?.map(file => file.path) ?? [] })
                                        setTab('files')
                                      }}
                                    >在文件列表里只看这些</button>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="gli-list">
                    {fileFilter !== null && fileFilter.iid === mr.iid && (
                      <div className="gli-filter-chip">
                        只看提交 {fileFilter.sha} 的文件
                        <button type="button" className="gli-link-btn" onClick={() => setFileFilter(null)}>清除</button>
                      </div>
                    )}
                    {visibleFiles.length === 0 && <div className="gli-empty">没有文件</div>}
                    {visibleFiles.map(file => (
                      <button
                        type="button"
                        className="gli-row"
                        key={file.path}
                        onClick={() => { if (host.canOpenReview) openReview(detail, file.path) }}
                        disabled={!host.canOpenReview}
                        title={host.canOpenReview ? '打开 diff' : '请在 GitLab 中查看'}
                      >
                        <span className={`gli-file-letter gli-file-${file.status}`}>{fileLetter(file.status)}</span>
                        <span className="gli-path" title={file.path}>{file.path}</span>
                        <span className="gli-stats"><span className="gli-plus">+{file.additions}</span><span className="gli-minus">−{file.deletions}</span></span>
                        {file.binary && <span className="gli-tag">binary</span>}
                      </button>
                    ))}
                    {(detail.hasMoreFiles || detail.overflow) && (
                      <div className="gli-empty">仅显示前 {detail.files.length} 个文件{detail.overflow ? '（GitLab 已截断）' : ''}，其余请在 GitLab 查看。</div>
                    )}
                  </div>
                )}

                {confirmMerge === mr.iid && (
                  <div className="gli-callout" role="alertdialog" aria-label={`确认让 Agent 合入 !${String(mr.iid)}`}>
                    <span className="gli-callout-text">
                      确认让 Agent 合入 <strong>!{mr.iid} → {mr.targetBranch}</strong>？
                      它会先重新拉取并复核闸门，任一不过就停手。这一步只会发送一条对话消息，不会直接调用 GitLab 合并。
                    </span>
                    <span className="gli-callout-actions">
                      <Button type="button" variant="outline" size="sm" onClick={() => setConfirmMerge(null)}>取消</Button>
                      <Button type="button" variant="primary" size="sm" onClick={() => { void askAgentToMerge(detail) }}>确认发送</Button>
                    </span>
                  </div>
                )}

                <div className="gli-foot">
                  {host.canMergeViaAgent && sessionId !== undefined && mr.state === 'opened' && (
                    <button
                      type="button"
                      className="gli-text-btn"
                      disabled={mergeState[mr.iid] === 'sending' || mergeState[mr.iid] === 'sent'}
                      onClick={() => setConfirmMerge(mr.iid)}
                    >
                      <IconSpark size={14} />
                      {mergeState[mr.iid] === 'sent'
                        ? '已发送给 Agent'
                        : mergeState[mr.iid] === 'sending'
                          ? '发送中…'
                          : '让 Agent 合入'}
                    </button>
                  )}
                  {mergeState[mr.iid] === 'error' && <span className="gli-error-text">消息发送失败，请重试</span>}
                  {host.canOpenReview && (
                    <button type="button" className="gli-text-btn" onClick={() => openReview(detail)}>
                      <IconPanel size={14} />展开审查
                    </button>
                  )}
                  {mr.webUrl !== null && (
                    <a className="gli-text-btn gli-action-link" href={mr.webUrl} target="_blank" rel="noreferrer">
                      <IconExternal size={14} />GitLab
                    </a>
                  )}
                  <span className="gli-time">更新于 {formatDate(detail.fetchedAt)}</span>
                </div>
              </div>
            )}
          </section>
        )
      })}
      {error !== '' && hasRefs && (
        <div className="gli-card gli-error-card">
          审查数据加载失败：{error}
          <button type="button" className="gli-link-btn" onClick={() => { void load(true) }}>重试</button>
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────── composer dock ──────────────────────────── */

export function MrDock(props: Record<string, unknown> & { host: MrSurfacesHost }): ReactNode {
  const { host, ...rest } = props
  const sessionId = typeof rest.sessionId === 'string' ? rest.sessionId : undefined
  const useSessions = rest.useSessions as ((selector: (state: unknown) => unknown) => unknown) | undefined
  const readCwd = useSessions ?? (() => undefined)
  const cwd = readCwd((state: unknown) => {
    const byId = (state as { byId?: Record<string, { cwd?: string }> } | undefined)?.byId
    return sessionId === undefined ? undefined : byId?.[sessionId]?.cwd
  }) as string | undefined
  const [state, setState] = useState<BranchMrs | null>(null)

  useEffect(() => {
    if (cwd === undefined) return
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const body = await getJson<BranchMrs>(`/gitlab/branch-mrs?cwd=${encodeURIComponent(cwd)}`)
        if (alive) setState(body)
      } catch {
        if (alive) setState(null)
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, 30_000)
    return () => { alive = false; clearInterval(timer) }
  }, [cwd])

  if (state === null || state.mrs.length === 0) return null
  return (
    <div className="gli-dock" aria-label={`当前分支 ${state.branch ?? ''} 的合并请求`}>
      <span className="gli-dock-icon"><IconMr size={14} /></span>
      {state.branch !== null && <span className="gli-dock-branch" title={state.branch}>{state.branch}</span>}
      {state.mrs.map(mr => (
        <button
          type="button"
          key={mr.iid}
          className="gli-dock-item"
          disabled={!host.canOpenReview}
          onClick={() => { if (cwd !== undefined && host.canOpenReview) host.openReview({ cwd, project: state.project, iid: mr.iid }) }}
          title={mr.title}
        >
          <span className="gli-mr">!{mr.iid}</span>
          <span className="gli-dock-target">→ {mr.targetBranch}</span>
        </button>
      ))}
    </div>
  )
}

/* ─────────────────────────────── review pane ────────────────────────────── */

interface PaneParams { cwd?: string; project?: string; iid?: number; path?: string }

export function MrReviewPane(props: Record<string, unknown> & { host: MrSurfacesHost }): ReactNode {
  const { host, ...rest } = props
  type TabInfo = { tab?: { navigation?: { params?: unknown }; actions?: { close?: () => void } } }
  const useTabInfo = rest.useTabInfo as (() => TabInfo) | undefined
  const readTab: () => TabInfo = useTabInfo ?? (() => ({}))
  const info = readTab()
  const params = (info?.tab?.navigation?.params ?? {}) as PaneParams
  const cwd = typeof params.cwd === 'string' ? params.cwd : undefined
  const project = typeof params.project === 'string' && params.project !== '' ? params.project : undefined
  const iid = typeof params.iid === 'number' ? params.iid : undefined
  const initialPath = typeof params.path === 'string' ? params.path : undefined

  const [payload, setPayload] = useState<MrPayload | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(initialPath ?? null)
  const [patch, setPatch] = useState<MrFilePatch | null>(null)
  const [patchError, setPatchError] = useState('')
  const [patchLoading, setPatchLoading] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [filter, setFilter] = useState('')
  const [notice, setNotice] = useState('')
  const sessionId = typeof rest.sessionId === 'string' ? rest.sessionId : undefined
  const [confirmMerge, setConfirmMerge] = useState(false)
  const [mergeState, setMergeState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const mounted = useRef(true)

  useEffect(() => () => { mounted.current = false }, [])

  const load = useCallback(async (refresh: boolean) => {
    if (cwd === undefined || iid === undefined || project === undefined) return
    setLoading(true)
    setError('')
    try {
      const detail = await loadDetail({ cwd, project, iid }, { refresh })
      if (!mounted.current) return
      setPayload(detail)
    } catch (failure) {
      if (!mounted.current) return
      setError(failure instanceof Error ? failure.message : '加载失败')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [cwd, iid, project])

  useEffect(() => { void load(false) }, [load])

  useEffect(() => {
    if (payload === null || selected === null) { setPatch(null); return }
    let alive = true
    setPatchLoading(true)
    setPatchError('')
    if (cwd === undefined) { setPatchLoading(false); setPatchError('缺少工作区路径'); return }
    void loadPatch({ cwd, project: payload.project, iid: payload.mr.iid, path: selected })
      .then(value => { if (alive) setPatch(value) })
      .catch(failure => { if (alive) setPatchError(failure instanceof Error ? failure.message : '无法读取补丁') })
      .finally(() => { if (alive) setPatchLoading(false) })
    return () => { alive = false }
  }, [cwd, payload, selected])

  // Reset the transient viewer when the tab switches to another MR.
  useEffect(() => {
    setSelected(initialPath ?? null)
    setShowAll(false)
    setNotice('')
  }, [iid, initialPath])

  const files = payload?.files ?? []
  const visible = filter.trim() === ''
    ? files
    : files.filter(file => file.path.toLowerCase().includes(filter.trim().toLowerCase()))
  const index = selected === null ? -1 : visible.findIndex(file => file.path === selected)
  const previous = index > 0 ? visible[index - 1] : undefined
  const next = index >= 0 && index < visible.length - 1 ? visible[index + 1] : undefined
  const current = index >= 0 ? visible[index] : undefined

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      if (mounted.current) setNotice('已复制')
    } catch {
      if (mounted.current) setNotice('复制失败')
    }
  }

  const close = (): void => { info?.tab?.actions?.close?.() }

  const askAgentToMerge = async (): Promise<void> => {
    if (payload === null || sessionId === undefined) return
    setConfirmMerge(false)
    setMergeState('sending')
    try {
      await host.mergeViaAgent({
        sessionId,
        project: payload.project,
        iid: payload.mr.iid,
        sourceBranch: payload.mr.sourceBranch,
        targetBranch: payload.mr.targetBranch,
        webUrl: payload.mr.webUrl,
      })
      if (mounted.current) setMergeState('sent')
    } catch {
      if (mounted.current) setMergeState('error')
    }
  }

  if (cwd === undefined || iid === undefined || project === undefined) {
    return <div className="gli-pane gli-pane-empty">缺少作品参数，请从对话中的 MR 卡片打开。</div>
  }
  if (loading && payload === null) {
    return <div className="gli-pane gli-pane-empty">读取 MR 信息…</div>
  }
  if (error !== '' && payload === null) {
    return (
      <div className="gli-pane gli-pane-empty">
        无法读取 MR：{error}
        <button type="button" className="gli-link-btn" onClick={() => { void load(true) }}>重试</button>
      </div>
    )
  }
  if (payload === null) return null

  const mr = payload.mr
  const status = statusLabel(mr)
  return (
    <div className="gli-pane">
      <header className="gli-pane-head">
        <div className="gli-pane-top">
          <span className="gli-tile"><IconMr size={18} /></span>
          <div className="gli-pane-copy">
            <div className="gli-head-line">
              <span className="gli-mr">!{mr.iid}</span>
              <span className="gli-branch">→ {mr.targetBranch}</span>
              <span className={`gli-status gli-status-${status.tone}`}>
                <span className="gli-status-dot" aria-hidden="true" />
                {status.text}
              </span>
            </div>
            <div className="gli-pane-title">{mr.title}</div>
            <div className="gli-pane-meta">
              <span className="gli-num">{payload.commits.length}</span> 提交 ·
              <span className="gli-num">{payload.files.length}</span> 文件
              {payload.identity.email !== null && <span> · 你：{payload.identity.email}</span>}
            </div>
          </div>
          <div className="gli-pane-tools">
            <button type="button" className="gli-icon-btn" title="刷新" aria-label="刷新" disabled={loading} onClick={() => { void load(true) }}>
              <IconRefresh size={15} />
            </button>
            {mr.webUrl !== null && (
              <a className="gli-icon-btn" title="在 GitLab 打开" aria-label="在 GitLab 打开" href={mr.webUrl} target="_blank" rel="noreferrer">
                <IconExternal size={15} />
              </a>
            )}
            <button type="button" className="gli-icon-btn" title="关闭" aria-label="关闭" onClick={close}>
              <IconClose size={15} />
            </button>
          </div>
        </div>
        <div className="gli-pane-bar">
          {host.canMergeViaAgent && sessionId !== undefined && mr.state === 'opened' && (
            <button
              type="button"
              className="gli-text-btn"
              disabled={mergeState === 'sending' || mergeState === 'sent'}
              onClick={() => setConfirmMerge(true)}
            >
              <IconSpark size={14} />
              {mergeState === 'sent' ? '已发送给 Agent' : mergeState === 'sending' ? '发送中…' : '让 Agent 合入'}
            </button>
          )}
          {mergeState === 'error' && <span className="gli-error-text">消息发送失败，请重试</span>}
          {loading && <span className="gli-muted-text">刷新中…</span>}
        </div>
        {confirmMerge && (
          <div className="gli-callout" role="alertdialog" aria-label={`确认让 Agent 合入 !${String(mr.iid)}`}>
            <span className="gli-callout-text">
              确认让 Agent 合入 <strong>!{mr.iid} → {mr.targetBranch}</strong>？
              它会先重新拉取并复核闸门，任一不过就停手；这一步只会发送一条对话消息，不会直接调用 GitLab 合并。
            </span>
            <span className="gli-callout-actions">
              <Button type="button" variant="outline" size="sm" onClick={() => setConfirmMerge(false)}>取消</Button>
              <Button type="button" variant="primary" size="sm" onClick={() => { void askAgentToMerge() }}>确认发送</Button>
            </span>
          </div>
        )}
      </header>

      {selected === null ? (
        <div className="gli-pane-body">
          {files.length > 30 && (
            <input
              className="gli-search"
              value={filter}
              onChange={event => setFilter(event.target.value)}
              placeholder="筛选文件路径"
              aria-label="筛选文件路径"
            />
          )}
          {visible.length === 0 && <div className="gli-empty">没有匹配的文件</div>}
          {visible.map(file => (
            <button type="button" className="gli-row" key={file.path} onClick={() => { setSelected(file.path); setShowAll(false) }}>
              <span className={`gli-file-letter gli-file-${file.status}`}>{fileLetter(file.status)}</span>
              <span className="gli-path" title={file.path}>{file.path}</span>
              <span className="gli-stats"><span className="gli-plus">+{file.additions}</span><span className="gli-minus">−{file.deletions}</span></span>
              {file.binary && <span className="gli-tag">binary</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="gli-pane-body">
          <div className="gli-diff-head">
            <button type="button" className="gli-text-btn" onClick={() => { setSelected(null); setPatch(null); setShowAll(false) }}>
              <IconBack size={14} />文件列表
            </button>
            <span className="gli-diff-path" title={selected}>{selected}</span>
            <span className="gli-stats">
              <span className="gli-plus">+{current?.additions ?? patch?.additions ?? 0}</span>
              <span className="gli-minus">−{current?.deletions ?? patch?.deletions ?? 0}</span>
            </span>
            <span className="gli-spacer" />
            <button
              type="button"
              className={wrap ? 'gli-text-btn gli-text-btn-on' : 'gli-text-btn'}
              aria-pressed={wrap}
              title={wrap ? '不换行' : '自动换行'}
              onClick={() => setWrap(value => !value)}
            >换行</button>
            <button type="button" className="gli-icon-btn" title="复制路径" aria-label="复制路径" onClick={() => { void copy(selected) }}>
              <IconCopy size={15} />
            </button>
            <button type="button" className="gli-icon-btn" title="上一个文件" aria-label="上一个文件" disabled={previous === undefined} onClick={() => { if (previous !== undefined) { setSelected(previous.path); setShowAll(false) } }}>
              <IconUp size={15} />
            </button>
            <button type="button" className="gli-icon-btn" title="下一个文件" aria-label="下一个文件" disabled={next === undefined} onClick={() => { if (next !== undefined) { setSelected(next.path); setShowAll(false) } }}>
              <IconDown size={15} />
            </button>
          </div>
          {notice !== '' && <div className="gli-note">{notice}</div>}
          {patchLoading && <div className="gli-empty">读取补丁…</div>}
          {patchError !== '' && <div className="gli-error-text">{patchError}</div>}
          {patch !== null && !patchLoading && (
            patch.unavailable || patch.patch === '' ? (
              <div className="gli-empty">
                {patch.binary
                  ? '二进制文件，无文本 diff。'
                  : patch.status === 'renamed' && patch.additions === 0 && patch.deletions === 0
                    ? '纯重命名，文件内容没有改动。'
                    : '补丁过大或不可用，请在 GitLab 中查看。'}
                {mr.webUrl !== null && <a className="gli-link-btn" href={`${mr.webUrl}/diffs`} target="_blank" rel="noreferrer">在 GitLab 查看 diff</a>}
              </div>
            ) : (
              <>
                <pre className={wrap ? 'gli-diff gli-diff-wrap' : 'gli-diff'} tabIndex={0} aria-label={`${selected} 的差异`}>
                  {(showAll ? patch.patch.split('\n') : patch.patch.split('\n').slice(0, SHOWN_DIFF_LINES)).map((line, lineIndex) => (
                    <div key={lineIndex} className={`gli-diff-line ${diffLineClass(line)}`}>{line === '' ? ' ' : line}</div>
                  ))}
                </pre>
                {!showAll && patch.patch.split('\n').length > SHOWN_DIFF_LINES && (
                  <button type="button" className="gli-text-btn" onClick={() => setShowAll(true)}>
                    显示全部 {patch.patch.split('\n').length} 行
                  </button>
                )}
                {patch.truncated && <div className="gli-note gli-note-muted">补丁过大，仅显示前 200,000 字符。</div>}
              </>
            )
          )}
        </div>
      )}
      <footer className="gli-pane-foot">
        {mr.hasConflicts && (
          <span className="gli-status gli-status-bad"><span className="gli-status-dot" aria-hidden="true" />conflict</span>
        )}
        <span className="gli-time">数据 {formatDate(payload.fetchedAt)}</span>
      </footer>
    </div>
  )
}

/* ───────────────────────────────── mounting ─────────────────────────────── */

export interface MrPaneServices {
  sidebarRight?: { openTab?: (kind: string, options?: { params?: unknown }) => void }
  sidebarRightTabs?: { register?: (definition: Record<string, unknown>) => (() => void) | void }
}

/**
 * Mount the three surfaces. The pane is mounted only when the sidebar-right
 * services exist; the card and dock still work in a profile without them.
 */
export function installMrSurfaces(ctx: Record<string, unknown> & {
  slots: any
  effect?: (callback: () => () => void, label?: string) => void
  sessions?: {
    using?: (
      id: string,
      options: Record<string, unknown>,
      operation: (reference: any) => Promise<unknown>,
    ) => Promise<unknown>
  }
}, hostServices: MrPaneServices): MrSurfacesHost {
  const sidebarRight = hostServices.sidebarRight
  const sidebarRightTabs = hostServices.sidebarRightTabs
  const canOpenReview = typeof sidebarRight?.openTab === 'function' && typeof sidebarRightTabs?.register === 'function'
  const sessions = ctx.sessions
  const canMergeViaAgent = typeof sessions?.using === 'function'

  const host: MrSurfacesHost = {
    canOpenReview,
    canMergeViaAgent,
    openReview: input => {
      if (!canOpenReview) return
      try {
        sidebarRight?.openTab?.(MR_TAB_KIND, { params: input })
      } catch { /* a closed sidebar must not break the card */ }
    },
    mergeViaAgent: async input => {
      if (sessions?.using === undefined) throw new Error('会话服务不可用')
      if (input.sessionId === '') throw new Error('缺少会话身份')
      const text = mergePrompt(input)
      await sessions.using(input.sessionId, {
        source: 'dsh-gitlab-mr-review',
        signal: new AbortController().signal,
      }, async reference => {
        await reference.ready
        const session = reference.binding?.session
        if (session === undefined) throw new Error('会话尚未就绪')
        const submission = session.beginSubmission({ mode: 'queue', text, attachments: [] })
        try {
          const result = await session.prompt(
            [{ type: 'text', text }],
            'queue',
            new AbortController().signal,
            submission.requestId,
          )
          if (result !== undefined && result !== null && result.ok === false) {
            throw new Error(typeof result.error?.message === 'string' ? result.error.message : '提交失败')
          }
        } catch (error) {
          try { submission.abandon() } catch { /* already resolved */ }
          throw error
        }
      })
    },
  }

  const slots = ctx.slots as {
    inject: (name: string, register: () => () => void) => void
    register: (options: Record<string, unknown>, component: (props: Record<string, unknown>) => ReactNode) => () => void
  }

  slots.inject('conversation.chat.turnTail', () => slots.register(
    { name: 'conversation.chat.turnTail', id: MR_TAB_ID, order: 20 },
    (props: Record<string, unknown>) => <MrTurnTail {...props} host={host} />,
  ))

  slots.inject('conversation.composer.dock', () => slots.register(
    { name: 'conversation.composer.dock', id: MR_TAB_ID, order: 20 },
    (props: Record<string, unknown>) => <MrDock {...props} host={host} />,
  ))

  if (canOpenReview) {
    // Register the page type inside the effect so its disposer is owned by the
    // plugin fiber, mirroring the core deliverables surface.
    ctx.effect?.(() => {
      const remove = sidebarRightTabs?.register?.({
        id: MR_TAB_ID,
        kind: MR_TAB_KIND,
        priority: 'extension',
        title: () => 'MR 审查',
      })
      return () => { if (typeof remove === 'function') remove() }
    }, 'dsh-gitlab: MR review tab')
    // Tab bodies are a keyed slot; the key is the tab id so one tab keeps one body.
    slots.inject('sidebar.right.pane.tab', () => slots.register(
      { name: 'sidebar.right.pane.tab', key: MR_TAB_ID },
      (props: Record<string, unknown>) => <MrReviewPane {...props} host={host} />,
    ))
  }

  ctx.effect?.(() => {
    if (typeof document === 'undefined') return () => {}
    const style = document.createElement('style')
    style.dataset.plugin = '@lim324/dsh-gitlab/mr'
    style.textContent = MR_STYLES
    document.head.append(style)
    return () => style.remove()
  }, 'dsh-gitlab: MR surfaces styles')

  return host
}

/** Scoped styles; only `.gli-*` selectors, all values from DSH tokens. */
export const MR_STYLES = `
/* MR review surfaces — same visual language as the native changed-files card:
   hairline border, layer-1 surface, 13/20 title, 10/16 tertiary stats, 36/44px rows. */
.gli-tail{display:flex;flex-direction:column;gap:8px;margin-top:6px}
.gli-card{container-type:inline-size;position:relative;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;overflow:hidden;min-width:0}
.gli-card-head{display:flex;align-items:flex-start;gap:2px;padding:10px 10px 8px 12px;transition:background-color .12s ease}
.gli-card-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gli-expand{display:flex;align-items:flex-start;gap:10px;flex:1;min-width:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:8px}
.gli-expand:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.gli-tile{width:32px;height:32px;flex:none;display:grid;place-items:center;border:0.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);color:var(--dsw-alias-label-secondary)}
.gli-head-copy{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}
.gli-head-line{display:flex;align-items:center;gap:8px;min-width:0}
.gli-mr{font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace));font-size:13px;line-height:20px;font-weight:600;letter-spacing:.01em;flex:none}
.gli-branch{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.gli-status{display:inline-flex;align-items:center;gap:5px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}
.gli-status-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.gli-status-ok{color:var(--dsw-alias-state-success-primary)}
.gli-status-warn{color:var(--dsw-alias-state-warning-primary)}
.gli-status-bad{color:var(--dsw-alias-state-error-primary)}
.gli-status-muted{color:var(--dsw-alias-label-tertiary)}
.gli-chevron{display:inline-flex;align-items:center;justify-content:center;margin-left:auto;color:var(--dsw-alias-label-tertiary);transition:transform .12s ease}
.gli-chevron[data-open=true]{transform:rotate(180deg)}
.gli-card-title{font-size:13px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gli-card-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.gli-num{font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace));font-variant-numeric:tabular-nums}
.gli-sep{color:var(--dsw-alias-label-tertiary)}
.gli-counts{display:inline-flex;align-items:center;gap:5px;flex:none}
.gli-plus{color:var(--dsw-alias-state-success-primary);font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace));font-variant-numeric:tabular-nums}
.gli-minus{color:var(--dsw-alias-state-error-primary);font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace));font-variant-numeric:tabular-nums}
.gli-warn-line{font-size:11px;line-height:16px;color:var(--dsw-alias-state-warning-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gli-ok-line{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.gli-body{border-top:0.5px solid var(--dsw-alias-border-l2);padding:8px 0 0}
.gli-body-bar{display:flex;align-items:center;gap:8px;padding:0 12px 8px;flex-wrap:wrap}
.gli-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover)}
.gli-seg-item{appearance:none;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:3px 10px;min-height:26px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
.gli-seg-item[aria-selected=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 0 0 0.5px var(--dsw-alias-border-l1)}
.gli-seg-item:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.gli-text-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:6px 6px;min-height:30px;border-radius:6px;cursor:pointer;text-decoration:none}
.gli-text-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.gli-text-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.gli-text-btn:disabled{opacity:.45;cursor:default}
.gli-text-btn-on{color:var(--dsw-alias-state-warning-primary)}
.gli-link-btn{appearance:none;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:4px 2px;min-height:26px;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.gli-link-btn:hover{color:var(--dsw-alias-label-primary)}
.gli-icon-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;text-decoration:none}
.gli-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.gli-icon-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.gli-icon-btn:disabled{opacity:.35;cursor:default}
.gli-list{display:flex;flex-direction:column}
.gli-row-wrap{display:flex;flex-direction:column}
.gli-row-wrap + .gli-row-wrap{border-top:0.5px solid var(--dsw-alias-border-l1)}
.gli-row{display:flex;align-items:center;gap:10px;width:100%;min-height:36px;padding:6px 12px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;box-sizing:border-box;min-width:0}
.gli-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.gli-row:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.gli-row:disabled{opacity:.7;cursor:default}
.gli-author{display:inline-flex;align-items:center;gap:4px;flex:none;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.gli-author::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.gli-author-other{color:var(--dsw-alias-state-warning-primary)}
.gli-author-unknown{color:var(--dsw-alias-label-tertiary)}
.gli-sha{flex:none;font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace));font-size:10px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.gli-row-main{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}
.gli-row-title{font-size:12.5px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gli-row-sub{display:flex;align-items:center;gap:5px;min-width:0;font-size:10px;line-height:15px;color:var(--dsw-alias-label-tertiary);overflow:hidden;white-space:nowrap}
.gli-sub-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gli-tag{flex:none;font-size:10px;line-height:15px;padding:0 5px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:4px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace))}
.gli-new{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-warning-primary);flex:none}
.gli-drill{margin:0 12px 8px 60px;padding:6px 0 4px;border-top:0.5px dashed var(--dsw-alias-border-l1)}
.gli-drill-title{font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-bottom:2px}
.gli-drill-row{display:flex;align-items:center;gap:8px;min-height:28px;font-size:12px}
.gli-file-letter{width:16px;height:16px;flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace));font-size:10px;line-height:16px;font-weight:600}
.gli-file-added{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.gli-file-modified{color:var(--dsw-alias-state-warning-primary);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 12%,transparent)}
.gli-file-deleted{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.gli-file-renamed{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
.gli-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace));font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-primary)}
.gli-stats{flex:none;display:inline-flex;align-items:center;gap:5px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.gli-filter-chip{display:flex;align-items:center;gap:8px;padding:4px 12px 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.gli-empty{padding:10px 12px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.gli-note{display:flex;align-items:center;gap:8px;padding:2px 12px 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-warning-primary)}
.gli-note-muted{color:var(--dsw-alias-label-tertiary)}
.gli-muted-text{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.gli-error-text{font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary)}
.gli-error-card{padding:10px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.gli-callout{display:flex;flex-direction:column;gap:6px;margin:8px 12px;padding:8px 10px;border-left:3px solid var(--dsw-alias-state-warning-primary);border-radius:0 6px 6px 0;background:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 8%,transparent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.gli-callout-text{display:block}
.gli-callout-actions{display:flex;gap:8px;flex-wrap:wrap}
.gli-foot{display:flex;align-items:center;gap:2px;flex-wrap:wrap;border-top:0.5px solid var(--dsw-alias-border-l2);padding:4px 8px}
.gli-time{margin-left:auto;padding-right:4px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
/* composer dock: one ambient line, no bordered buttons */
.gli-dock{display:flex;align-items:center;gap:6px;padding:2px 0 4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}
.gli-dock::-webkit-scrollbar{display:none}
.gli-dock-icon{display:inline-flex;color:var(--dsw-alias-label-tertiary)}
.gli-dock-branch{flex:none;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace));font-size:10px;color:var(--dsw-alias-label-tertiary)}
.gli-dock-item{flex:none;appearance:none;display:inline-flex;align-items:center;gap:4px;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;padding:3px 6px;border-radius:6px;cursor:pointer;white-space:nowrap}
.gli-dock-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.gli-dock-item:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.gli-dock-item:disabled{opacity:.6;cursor:default}
.gli-dock-item .gli-mr{font-size:11px;line-height:16px;font-weight:500}
.gli-dock-target{color:var(--dsw-alias-label-tertiary)}
/* review pane */
.gli-pane{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.gli-pane-empty{padding:20px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.gli-pane-head{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1));border-bottom:0.5px solid var(--dsw-alias-border-l2);padding:12px 14px 8px}
.gli-pane-top{display:flex;align-items:flex-start;gap:10px}
.gli-pane-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.gli-pane-title{font-size:14px;line-height:20px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gli-pane-meta{font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.gli-pane-tools{display:flex;align-items:center;gap:2px;flex:none}
.gli-pane-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px}
.gli-pane-body{flex:1;min-height:0;overflow:auto;padding:0 0 12px}
.gli-search{width:calc(100% - 24px);min-height:32px;margin:8px 12px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;box-sizing:border-box}
.gli-search:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.gli-diff-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1));border-bottom:0.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.gli-diff-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace));font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.gli-diff{margin:0;padding:6px 0 24px;overflow:auto;background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-markdown-code-block,12px/1.6 var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace));white-space:pre;tab-size:2}
.gli-diff-line{box-sizing:border-box;min-height:1lh;padding:0 22px;white-space:pre}
.gli-diff-wrap,.gli-diff-wrap .gli-diff-line{white-space:pre-wrap;overflow-wrap:anywhere}
.gli-diff-add{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-code-diff-added,color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent));box-shadow:inset 3px 0 0 var(--dsw-alias-state-success-primary)}
.gli-diff-del{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-code-diff-deleted,color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent));box-shadow:inset 3px 0 0 var(--dsw-alias-state-error-primary)}
.gli-diff-hunk{color:var(--dsw-alias-label-tertiary);background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 7%,transparent)}
.gli-diff-meta{color:var(--dsw-alias-label-tertiary)}
.gli-spacer{flex:1}
.gli-pane-foot{display:flex;align-items:center;gap:8px;padding:8px 14px;border-top:0.5px solid var(--dsw-alias-border-l2);font-size:10px}
.gli-pane-foot .gli-time{margin-left:auto}
@container (max-width: 420px){
  .gli-card-head{padding:8px 8px 6px 10px}
  .gli-tile{width:26px;height:26px;border-radius:8px}
  .gli-head-copy{gap:0}
  .gli-card-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:normal;overflow:hidden;line-height:19px}
  .gli-card-meta{gap:5px}
  .gli-warn-line,.gli-ok-line{white-space:normal}
  .gli-body-bar{padding:0 10px 6px}
  .gli-seg{width:100%}
  .gli-seg-item{flex:1;justify-content:center}
  .gli-row{min-height:44px;padding:7px 10px}
  .gli-commit .gli-row-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:normal;overflow:hidden;line-height:17px}
  .gli-tag{align-self:flex-start;margin-top:1px}
  .gli-foot{padding:4px 6px}
  .gli-foot .gli-text-btn{flex:1;justify-content:center;min-height:36px;background:var(--dsw-alias-interactive-bg-hover);border-radius:8px}
  .gli-time{display:none}
  .gli-drill{margin:0 10px 8px}
}
@container (max-width: 360px){
  .gli-tile{display:none}
  .gli-card-head{padding-left:10px}
}
@media (max-width:640px){
  .gli-pane-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:normal;overflow:hidden}
  .gli-pane-tools .gli-icon-btn{width:32px;height:32px}
  .gli-pane-head{padding:10px 12px 6px}
  .gli-diff-head{padding:6px 10px;gap:6px}
  .gli-diff-head .gli-stats{display:none}
  .gli-diff{font-size:11.5px}
  .gli-dock-branch{max-width:100px}
}
@media (pointer:coarse){.gli-row,.gli-drill-row{min-height:44px}.gli-icon-btn{width:32px;height:32px}.gli-text-btn{min-height:36px}}
@media (max-width:640px){
  .gli-card-head{padding:9px 8px 7px 10px}
  .gli-tile{width:28px;height:28px;border-radius:9px}
  .gli-head-line{gap:6px}
  .gli-pane-head{padding:10px 12px 6px}
  .gli-pane-body{padding-bottom:8px}
  .gli-diff-line{padding:0 14px}
  .gli-drill{margin-left:12px}
}
@media (prefers-reduced-motion:reduce){.gli-card-head,.gli-chevron{transition:none}}
`
