/**
 * Client half: a conversation-pane tab (the `conversation.view` seat, beside
 * Chat and Trajectory) showing the pipelines and open MRs of the workspace
 * the open session belongs to. The tab is session-scoped: its sessionId
 * selects the workspace through the workspaces feed, and only that
 * workspace's status is fetched from the host (`/gitlab/status?workspaceId=`)
 * on a 10-second cadence. All requests are same-origin, so the Web session
 * cookie authenticates them. The surface is built from the platform's
 * UI primitives and `--dsw-*` design tokens.
 * @module @lim324/dsh-gitlab/client
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { Button, DisclosureRow, Input, Pill, StateDot, Toast, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the 'settings.section' SlotMap declaration owned by the
// settings surface (the section itself edits the token through this
// plugin's own /gitlab/settings route, not the settings RPC).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/** Stable Cordis plugin name (client half). */
export const name = 'dsh-gitlab'

/** Client services required before the tab can mount. */
export const inject = ['slots', 'sessions', 'workspaces']

/** Poll cadence for the host status route. */
const POLL_MS = 10_000

/** The host status row wire shape (mirrors the host half). */
export interface WorkspaceStatus {
  workspaceId: string
  title: string
  gitlab: boolean
  remote: { host: string; project: string } | null
  project: string | null
  authed: boolean
  currentBranch: string | null
  defaultBranch: string | null
  branches: string[]
  pipelines: Array<{
    id: number
    status: string
    ref: string
    sha: string
    webUrl: string | null
    commit: { title: string; authorName: string | null } | null
    jobs: Array<{ id: number; name: string; stage: string; status: string; durationSeconds: number | null; webUrl: string | null }>
  }>
  mrs: Array<{ iid: number; title: string; sourceBranch: string; targetBranch: string; author: string | null; webUrl: string | null }>
  error: string | null
}

/** One workspace projection from the workspaces feed. */
export interface WorkspaceProjection {
  workspaceId: string
  title: string
  sessionIds: readonly string[]
}

/**
 * Resolve the workspace a session belongs to: the first workspace whose
 * sessionIds contain the session. Undefined when the session belongs to no
 * workspace.
 * @param sessionId - the open session.
 * @param workspaces - the workspaces feed rows.
 * @returns the owning workspace id, or undefined.
 */
export function findWorkspaceId(
  sessionId: string | undefined,
  workspaces: readonly WorkspaceProjection[],
): string | undefined {
  if (sessionId === undefined) return undefined
  return workspaces.find(candidate => candidate.sessionIds.includes(sessionId))?.workspaceId
}

/** One fetch outcome: either the status row or a message why it failed. */
interface FetchOutcome {
  status?: WorkspaceStatus
  error: string
}

/** Read the status row of one workspace. */
async function fetchStatus(workspaceId: string): Promise<FetchOutcome> {
  try {
    const res = await fetch(`/gitlab/status?workspaceId=${encodeURIComponent(workspaceId)}`)
    if (res.ok) return { status: (await res.json()) as WorkspaceStatus, error: '' }
    return { error: `host answered ${String(res.status)}` }
  } catch {
    return { error: 'cannot reach the GitLab surface' }
  }
}

/** Submit one MR action and report the outcome. */
async function submitAction(op: 'approve' | 'merge' | 'close' | 'create-mr', iid: number, project: string, extras?: { title?: string; sourceBranch?: string; targetBranch?: string }): Promise<{ ok: boolean; note: string }> {
  const payload: Record<string, unknown> = { op, iid, project }
  if (extras?.title !== undefined) payload.title = extras.title
  if (extras?.sourceBranch !== undefined) payload.sourceBranch = extras.sourceBranch
  if (extras?.targetBranch !== undefined) payload.targetBranch = extras.targetBranch
  const res = await fetch('/gitlab/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (res.ok) {
    const data = await res.json() as { iid?: number }
    return { ok: true, note: data.iid !== undefined ? `MR !${data.iid} created` : 'done' }
  }
  return { ok: false, note: res.status === 401 ? 'token required' : await res.text() }
}

/** Map one GitLab status string to the platform's four-state semantic. */
function dotState(status: string): StateDotState {
  if (status === 'success') return 'done'
  if (status === 'failed' || status === 'canceled') return 'error'
  if (status === 'skipped' || status === 'manual') return 'warning'
  return 'ongoing'
}

const style: Record<string, CSSProperties> = {
  root: {
    padding: '16px 20px', boxSizing: 'border-box', height: '100%', overflowY: 'auto',
    color: 'var(--dsw-alias-label-primary)', fontSize: 13,
  },
  header: { fontWeight: 600, fontSize: 15, margin: '0 0 4px' },
  sub: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, margin: '0 0 12px' },
  section: {
    fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em',
    color: 'var(--dsw-alias-label-tertiary)', margin: '14px 0 4px',
  },
  error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, margin: '0 0 8px' },
  note: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginTop: 8 },
  meta: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 },
  stages: { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start', padding: '6px 0 10px' },
  stage: {
    minWidth: 140, border: '1px solid var(--dsw-alias-border-low)', borderRadius: 8,
    padding: '6px 8px', boxSizing: 'border-box',
  },
  stageName: { fontWeight: 600, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 },
  job: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 12 },
  mrRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid var(--dsw-alias-border-low)' },
  createBar: { display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' },
  select: {
    padding: '5px 8px', border: '1px solid var(--dsw-alias-border-low)', borderRadius: 6,
    background: 'var(--dsw-alias-bg-layer-low)', color: 'var(--dsw-alias-label-primary)', fontSize: 12,
  },
  link: { color: 'var(--dsw-alias-label-primary)', textDecoration: 'none' },
}

/** The framework kit subset the tab component reads; the composed props supply the rest. */
interface GitlabViewProps {
  sessionId: string
  useWorkspaces: SnapshotSelectorHook<WorkspaceListState>
}

/** The GitLab tab body: pipelines and open MRs of the open session's workspace. */
function GitlabView({ sessionId, useWorkspaces }: GitlabViewProps): JSX.Element {
  const workspaces = useWorkspaces(state => state.items)
  const workspaceId = findWorkspaceId(sessionId, workspaces)
  const [status, setStatus] = useState<WorkspaceStatus | undefined>()
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [expandedPipeline, setExpandedPipeline] = useState<number | null>(null)
  // Action feedback rides the platform Toast: transient (auto-fades) by
  // design, so it never lingers as stale state across remounts. The seq
  // key restarts the cycle when the same text is shown again.
  const [actionToast, setActionToast] = useState<{ text: string; seq: number } | null>(null)
  const [busyOp, setBusyOp] = useState<string | null>(null)
  const [mrTitle, setMrTitle] = useState('')
  const [sourceBranch, setSourceBranch] = useState<string | null>(null)
  const [targetBranch, setTargetBranch] = useState<string | null>(null)
  const busy = useRef(false)

  // Seed the branch selectors from the first loaded status row; the user's
  // selection wins afterwards.
  useEffect(() => {
    if (status === undefined) return
    setSourceBranch(current => current ?? status.currentBranch ?? status.branches[0] ?? null)
    setTargetBranch(current => current ?? status.defaultBranch ?? status.branches[0] ?? null)
  }, [status])

  useEffect(() => {
    let alive = true
    if (workspaceId === undefined) {
      setStatus(undefined)
      setFetchError(null)
      return
    }
    const poll = async (): Promise<void> => {
      const outcome = await fetchStatus(workspaceId)
      if (!alive) return
      if (outcome.status !== undefined) {
        setStatus(outcome.status)
        setFetchError(null)
      } else {
        setFetchError(outcome.error)
      }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [workspaceId])

  const refreshAfterAction = useCallback(async () => {
    if (workspaceId === undefined) return
    const refreshed = await fetchStatus(workspaceId)
    if (refreshed.status !== undefined) {
      setStatus(refreshed.status)
      setFetchError(null)
    } else {
      setFetchError(refreshed.error)
    }
  }, [workspaceId])

  // Stable identity so Toast's timer is not reset by unrelated re-renders.
  const dismissToast = useCallback(() => { setActionToast(null) }, [])
  const showToast = useCallback((text: string) => {
    setActionToast(previous => ({ text, seq: (previous?.seq ?? 0) + 1 }))
  }, [])

  const runAction = useCallback(async (op: 'approve' | 'merge' | 'close', iid: number, project: string) => {
    if (busy.current || workspaceId === undefined) return
    busy.current = true
    setBusyOp(`${op} MR !${iid}`)
    try {
      const outcome = await submitAction(op, iid, project)
      showToast(`${op} MR !${iid}: ${outcome.note}`)
      await refreshAfterAction()
    } catch {
      showToast('action failed')
    } finally {
      busy.current = false
      setBusyOp(null)
    }
  }, [workspaceId, refreshAfterAction, showToast])

  const runCreateMr = useCallback(async (project: string) => {
    if (busy.current || workspaceId === undefined) return
    busy.current = true
    setBusyOp('create MR')
    try {
      const outcome = await submitAction('create-mr', 0, project, { title: mrTitle, sourceBranch: sourceBranch ?? undefined, targetBranch: targetBranch ?? undefined })
      showToast(outcome.note)
      await refreshAfterAction()
    } catch {
      showToast('action failed')
    } finally {
      busy.current = false
      setBusyOp(null)
    }
  }, [workspaceId, mrTitle, sourceBranch, targetBranch, refreshAfterAction, showToast])

  if (workspaceId === undefined) {
    return <div style={style.root}>This session has no workspace, or the workspace is not a GitLab repository.</div>
  }
  if (status === undefined && fetchError !== null) {
    return <div style={style.root}><p style={style.error}>GitLab status unavailable: {fetchError}</p></div>
  }
  if (status === undefined) {
    return <div style={style.root}>Loading…</div>
  }
  if (!status.gitlab) {
    return <div style={style.root}>This workspace is not a GitLab repository.</div>
  }
  return (
    <div style={style.root}>
      <p style={style.header}>GitLab CI/CD</p>
      <p style={style.sub}>
        {status.title}
        {!status.authed ? ' · read-only (no token)' : ''}
      </p>
      {status.error !== null ? <p style={style.error}>GitLab API error: {status.error}</p> : null}
      {fetchError !== null ? <p style={style.error}>Showing stale data — refresh failed: {fetchError}</p> : null}
      <div style={style.section}>Pipelines</div>
      {status.pipelines.length === 0 ? <p style={style.meta}>none</p> : status.pipelines.map(pipeline => {
        const expanded = expandedPipeline === pipeline.id
        const stages: Array<{ name: string; jobs: WorkspaceStatus['pipelines'][number]['jobs'] }> = []
        for (const job of pipeline.jobs) {
          const last = stages[stages.length - 1]
          if (last !== undefined && last.name === job.stage) last.jobs.push(job)
          else stages.push({ name: job.stage, jobs: [job] })
        }
        return (
          <DisclosureRow
            key={pipeline.id}
            icon={<StateDot state={dotState(pipeline.status)} />}
            title={`${pipeline.status.replace(/_/g, ' ')} · ${pipeline.ref}`}
            collapsedContent={
              pipeline.commit !== null
                ? <span style={{ ...style.meta, marginLeft: 10 }}>{pipeline.commit.title}{pipeline.commit.authorName !== null ? ` · ${pipeline.commit.authorName}` : ''}</span>
                : <span style={{ ...style.meta, marginLeft: 10 }}>{pipeline.sha.slice(0, 8)}</span>
            }
            keepContentWhenOpen
            open={expanded}
            expandable
            onToggle={() => setExpandedPipeline(expanded ? null : pipeline.id)}
            expandOnRowClick
          >
            {pipeline.jobs.length === 0
              ? <p style={style.meta}>no jobs</p>
              : (
                <div style={style.stages}>
                  {stages.map(stage => (
                    <div key={stage.name} style={style.stage}>
                      <div style={style.stageName}>{stage.name}</div>
                      {stage.jobs.map(job => (
                        <div key={job.id} style={style.job}>
                          <StateDot state={dotState(job.status)} size={10} />
                          {job.webUrl !== null
                            ? <a style={style.link} href={job.webUrl} target="_blank" rel="noreferrer" title={`${job.name} · ${job.status}`}>{job.name}</a>
                            : <span>{job.name}</span>}
                          {job.durationSeconds !== null ? <span style={{ ...style.meta, marginLeft: 'auto' }}>{Math.round(job.durationSeconds)}s</span> : null}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
          </DisclosureRow>
        )
      })}
      <div style={style.section}>Open merge requests</div>
      <div style={style.createBar}>
        <select style={style.select} value={sourceBranch ?? ''} onChange={event => setSourceBranch(event.target.value)} disabled={!status.authed} title="source branch">
          {status.branches.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <span style={style.meta}>→</span>
        <select style={style.select} value={targetBranch ?? ''} onChange={event => setTargetBranch(event.target.value)} disabled={!status.authed} title="target branch">
          {status.branches.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <Input
          style={{ flex: 1, minWidth: 140 }}
          placeholder="MR title (optional)"
          value={mrTitle}
          onChange={event => setMrTitle(event.target.value)}
          disabled={!status.authed}
        />
        <Button variant="primary" size="sm" disabled={!status.authed || busyOp !== null} onClick={() => void runCreateMr(status.project!)}>{busyOp === 'create MR' ? 'Creating…' : 'Create MR'}</Button>
      </div>
      {status.mrs.length === 0 ? <p style={style.meta}>none</p> : status.mrs.map(mr => (
        <div key={mr.iid} style={style.mrRow}>
          <Pill>!{mr.iid}</Pill>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mr.title}</span>
          <span style={style.meta}>{mr.sourceBranch} → {mr.targetBranch}</span>
          <Button variant="outline" size="sm" disabled={!status.authed || busyOp !== null} onClick={() => void runAction('approve', mr.iid, status.project!)}>{busyOp === `approve MR !${mr.iid}` ? 'Approving…' : 'Approve'}</Button>
          <Button variant="primary" size="sm" disabled={!status.authed || busyOp !== null} onClick={() => void runAction('merge', mr.iid, status.project!)}>{busyOp === `merge MR !${mr.iid}` ? 'Merging…' : 'Merge'}</Button>
          <Button variant="ghost" size="sm" disabled={!status.authed || busyOp !== null} onClick={() => void runAction('close', mr.iid, status.project!)}>{busyOp === `close MR !${mr.iid}` ? 'Closing…' : 'Close'}</Button>
        </div>
      ))}
      {busyOp !== null ? <p style={style.note}>{busyOp} …</p> : null}
      {actionToast !== null ? <Toast key={actionToast.seq} text={actionToast.text} onDone={dismissToast} /> : null}
    </div>
  )
}

/** Wire view of the host's `gitlab` settings section; the tokens themselves never cross the wire. */
interface GitlabSettingsView {
  available: boolean
  writable: boolean
  tokenSet: boolean
  /** Host names with a saved per-host token. */
  hostTokens: string[]
  revision: number | undefined
}

/** Read the saved-token state through the plugin's own fenced route. */
async function fetchGitlabSettings(): Promise<GitlabSettingsView | null> {
  try {
    const res = await fetch('/gitlab/settings')
    if (res.ok) return await res.json() as GitlabSettingsView
    return null
  } catch {
    return null
  }
}

/** Write or clear a token (optionally per host); returns the fresh view and flags a revision conflict. */
async function writeGitlabSettings(body: { host?: string; token?: string; clear?: boolean; expectedRevision?: number }): Promise<{ ok: boolean; conflict: boolean; view: GitlabSettingsView | null }> {
  try {
    const res = await fetch('/gitlab/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) return { ok: true, conflict: false, view: await res.json() as GitlabSettingsView }
    return { ok: false, conflict: res.status === 409, view: null }
  } catch {
    return { ok: false, conflict: false, view: null }
  }
}

/** The Settings panel's GitLab page: edit the tokens the host half uses. */
function GitlabTokenForm(): JSX.Element {
  const [view, setView] = useState<GitlabSettingsView | null>(null)
  const [draft, setDraft] = useState('')
  const [hostDraft, setHostDraft] = useState('')
  const [hostTokenDraft, setHostTokenDraft] = useState('')
  const [busyOp, setBusyOp] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void fetchGitlabSettings().then(fresh => { if (alive) setView(fresh) })
    return () => { alive = false }
  }, [])

  const unavailable = view?.available === false
  const readOnly = view !== null && view.available && !view.writable
  const disabled = view === null || unavailable || readOnly || busyOp !== null

  // Shared write outcome handling: commit the fresh view or surface the
  // failure, re-reading on a revision conflict.
  const settle = async (outcome: Awaited<ReturnType<typeof writeGitlabSettings>>, successNote: string): Promise<boolean> => {
    if (outcome.ok && outcome.view !== null) {
      setView(outcome.view)
      setNote(successNote)
    } else {
      setNote(outcome.conflict ? 'settings changed elsewhere — reloaded, try again' : 'save failed')
      if (outcome.conflict) setView(await fetchGitlabSettings())
    }
    setBusyOp(null)
    return outcome.ok && outcome.view !== null
  }

  const save = async (): Promise<void> => {
    if (draft === '' || view === null) return
    setBusyOp('save')
    setNote(null)
    const saved = await settle(await writeGitlabSettings({ token: draft, expectedRevision: view.revision }), 'saved — the GitLab tab now uses this token')
    if (saved) setDraft('')
  }

  const clear = async (): Promise<void> => {
    if (view === null) return
    setBusyOp('clear')
    setNote(null)
    await settle(await writeGitlabSettings({ clear: true, expectedRevision: view.revision }), 'cleared — back to plugin config / environment')
  }

  const saveHost = async (): Promise<void> => {
    if (hostDraft === '' || hostTokenDraft === '' || view === null) return
    setBusyOp('saveHost')
    setNote(null)
    const saved = await settle(await writeGitlabSettings({ host: hostDraft, token: hostTokenDraft, expectedRevision: view.revision }), `saved — ${hostDraft} now uses this token`)
    if (saved) setHostTokenDraft('')
  }

  const clearHost = async (host: string): Promise<void> => {
    if (view === null) return
    setBusyOp(`clearHost:${host}`)
    setNote(null)
    await settle(await writeGitlabSettings({ host, clear: true, expectedRevision: view.revision }), `cleared — ${host} falls back to the default token`)
  }

  return (
    <div style={style.root}>
      <p style={style.header}>GitLab</p>
      <p style={style.sub}>Access tokens the host uses for pipeline and merge-request access. Empty falls back to the plugin config or the GITLAB_TOKEN environment. The browser never reads a saved token back.</p>
      <div style={style.createBar}>
        <Input
          style={{ flex: 1, minWidth: 200 }}
          type="password"
          placeholder="personal access token"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          disabled={disabled}
        />
        <Button variant="primary" size="sm" disabled={disabled || draft === ''} onClick={() => void save()}>{busyOp === 'save' ? 'Saving…' : 'Save'}</Button>
        <Button variant="ghost" size="sm" disabled={disabled || !view?.tokenSet} onClick={() => void clear()}>{busyOp === 'clear' ? 'Clearing…' : 'Clear'}</Button>
      </div>
      <p style={style.meta}>{view?.tokenSet === true ? 'A default token is saved.' : 'No default token saved.'}</p>
      <div style={style.section}>Per-host tokens</div>
      <p style={style.sub}>Keyed by the workspace remote's host (e.g. gitlab.com); a matching host overrides the default token for that host.</p>
      {view?.hostTokens.length === 0 ? <p style={style.meta}>none</p> : view?.hostTokens.map(host => (
        <div key={host} style={style.mrRow}>
          <Pill>saved</Pill>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{host}</span>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void clearHost(host)}>{busyOp === `clearHost:${host}` ? 'Clearing…' : 'Clear'}</Button>
        </div>
      ))}
      <div style={style.createBar}>
        <Input
          style={{ flex: 1, minWidth: 140 }}
          placeholder="host (gitlab.com)"
          value={hostDraft}
          onChange={event => setHostDraft(event.target.value)}
          disabled={disabled}
        />
        <Input
          style={{ flex: 1, minWidth: 200 }}
          type="password"
          placeholder="token for this host"
          value={hostTokenDraft}
          onChange={event => setHostTokenDraft(event.target.value)}
          disabled={disabled}
        />
        <Button variant="primary" size="sm" disabled={disabled || hostDraft === '' || hostTokenDraft === ''} onClick={() => void saveHost()}>{busyOp === 'saveHost' ? 'Adding…' : 'Add'}</Button>
      </div>
      {unavailable ? <p style={style.error}>The settings service is not mounted in this deployment.</p> : null}
      {!unavailable && readOnly ? <p style={style.error}>The settings document is read-only here.</p> : null}
      {note !== null ? <p style={style.note}>{note}</p> : null}
    </div>
  )
}

/** Wire view of one skill source: the config spread plus its repositories. */
interface SkillSourceView {
  id: string
  group: string
  baseUrl?: string
  tokenEnv?: string
  ref?: string
  rank?: number
  includeSubgroups?: boolean
  repos: Array<{ name: string; pulled: boolean }>
}

/** Wire view of the skills status route. */
interface SkillStatusView {
  sources: SkillSourceView[]
  revision?: number
}

/** Read the skills status through the plugin's own fenced route. */
async function fetchSkillStatus(): Promise<SkillStatusView | null> {
  try {
    const res = await fetch('/gitlab/skills/status')
    if (res.ok) return await res.json() as SkillStatusView
    return null
  } catch {
    return null
  }
}

/** POST one skills-management operation; returns whether the host accepted it. */
async function postSkills(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.ok
  } catch {
    return false
  }
}

/** The Settings panel's GitLab Skills page: configure skill sources, sync a group's repositories locally, and drop local checkouts. */
function GitlabSkillsPanel(): JSX.Element {
  const [status, setStatus] = useState<SkillStatusView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [newId, setNewId] = useState('')
  const [newGroup, setNewGroup] = useState('')

  const load = useCallback(async (): Promise<void> => {
    const fresh = await fetchSkillStatus()
    if (fresh === null) setLoadError('cannot reach the skills status route')
    else { setStatus(fresh); setLoadError(null) }
  }, [])
  useEffect(() => { void load() }, [load])

  const sync = async (sourceId: string): Promise<void> => {
    setBusy(`sync:${sourceId}`)
    setNote(null)
    if (await postSkills('/gitlab/skills/pull', { sourceId })) {
      setNote(`synced ${sourceId}`)
      await load()
    } else {
      setNote('sync failed')
    }
    setBusy(null)
  }

  const remove = async (sourceId: string, repo: string): Promise<void> => {
    setBusy(`remove:${sourceId}:${repo}`)
    setNote(null)
    if (await postSkills('/gitlab/skills/remove', { sourceId, repo })) {
      setNote(`removed local checkout of ${repo}`)
      await load()
    } else {
      setNote('remove failed')
    }
    setBusy(null)
  }

  // Replace the whole source list through the fenced CRUD route; the host
  // re-registers providers and syncs the added/kept sources on commit. The
  // `repos` field rides along but the host ignores it when parsing.
  const saveSources = async (next: SkillSourceView[]): Promise<boolean> => {
    const res = await fetch('/gitlab/skills/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources: next, expectedRevision: status?.revision }),
    })
    if (res.ok) { await load(); return true }
    return false
  }

  const addSource = async (): Promise<void> => {
    const id = newId.trim()
    const group = newGroup.trim()
    if (id === '' || group === '' || status === null) return
    setBusy('add')
    setNote(null)
    if (await saveSources([...status.sources, { id, group, repos: [] }])) {
      setNote(`added source ${id}`)
      setNewId('')
      setNewGroup('')
    } else {
      setNote('add source failed')
    }
    setBusy(null)
  }

  const removeSource = async (id: string): Promise<void> => {
    if (status === null) return
    setBusy(`removeSource:${id}`)
    setNote(null)
    if (await saveSources(status.sources.filter(source => source.id !== id))) {
      setNote(`removed source ${id}`)
    } else {
      setNote('remove source failed')
    }
    setBusy(null)
  }

  if (status === null && loadError !== null) {
    return <div style={style.root}><p style={style.header}>GitLab skills</p><p style={style.error}>{loadError}</p><p style={style.sub}>Skill sync needs the host route; check that the plugin is running and reachable.</p></div>
  }
  if (status === null) {
    return <div style={style.root}><p style={style.header}>GitLab skills</p><p style={style.sub}>loading…</p></div>
  }

  return (
    <div style={style.root}>
      <p style={style.header}>GitLab skills</p>
      <p style={style.sub}>Each repository under a configured group is one skill (a root SKILL.md). Add a source — a GitLab group whose repositories carry that file — then sync to check it out locally for the model.</p>
      <div style={style.section}>Add source</div>
      <div style={style.createBar}>
        <Input
          style={{ flex: 1, minWidth: 120 }}
          placeholder="source id"
          value={newId}
          onChange={event => setNewId(event.target.value)}
          disabled={busy !== null}
        />
        <Input
          style={{ flex: 1, minWidth: 180 }}
          placeholder="group (org/skills)"
          value={newGroup}
          onChange={event => setNewGroup(event.target.value)}
          disabled={busy !== null}
        />
        <Button variant="primary" size="sm" disabled={busy !== null || newId.trim() === '' || newGroup.trim() === ''} onClick={() => void addSource()}>{busy === 'add' ? 'Adding…' : 'Add'}</Button>
      </div>
      <div style={style.section}>Sources</div>
      {status.sources.length === 0
        ? <p style={style.meta}>No skill sources configured.</p>
        : status.sources.map(source => (
            <div key={source.id} style={{ marginBottom: 16 }}>
              <div style={{ ...style.mrRow, borderTop: 'none' }}>
                <span style={{ flex: 1, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source.id}</span>
                <span style={style.meta}>{source.group}</span>
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void sync(source.id)}>{busy === `sync:${source.id}` ? 'Syncing…' : 'Sync'}</Button>
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void removeSource(source.id)}>{busy === `removeSource:${source.id}` ? 'Removing…' : 'Remove'}</Button>
              </div>
              {source.repos.length === 0
                ? <p style={style.meta}>no repositories</p>
                : source.repos.map(repo => (
                    <div key={repo.name} style={style.mrRow}>
                      <Pill>{repo.pulled ? 'pulled' : 'remote'}</Pill>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{repo.name}</span>
                      {repo.pulled
                        ? <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void remove(source.id, repo.name)}>{busy === `remove:${source.id}:${repo.name}` ? 'Removing…' : 'Remove local'}</Button>
                        : null}
                    </div>
                  ))}
            </div>
          ))}
      {note !== null ? <p style={style.note}>{note}</p> : null}
    </div>
  )
}

/**
 * Mount the GitLab tab into the conversation view ring, beside Chat and
 * Trajectory. The tab appears whenever a session is open.
 * @param ctx - client context carrying the slot registry.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'gitlab',
    order: 20,
    label: () => 'GitLab',
  }, GitlabView))

  // The GitLab page inside the Settings panel: the token lives in the
  // `gitlab` settings namespace on the host and is edited through this
  // plugin's own /gitlab/settings route (the settings RPC only serves
  // allowlisted namespaces).
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'gitlab',
    order: 30,
    label: () => 'GitLab',
  }, GitlabTokenForm))

  // The skill-sync page: list each source's repositories, sync a group, and
  // drop local checkouts.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'gitlab-skills',
    order: 31,
    label: () => 'GitLab Skills',
  }, GitlabSkillsPanel))
}
