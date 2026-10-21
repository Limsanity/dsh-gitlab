// @vitest-environment jsdom
/**
 * Component-level coverage for the three MR surfaces: the turn-tail card, the
 * composer dock and the review pane. `fetch` is stubbed with the host's wire
 * shapes; the assertions pin what a reviewer sees (authorship badges, merge
 * warnings, file rows, diff lines) and that opening the pane carries the
 * workspace/project identity.
 */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MrDock, MrReviewPane, MrTurnTail, statusLabel, type MrSurfacesHost } from '../src/client/mr.tsx'

// The real primitives bundle pulls CSS/tooling that the plugin's test tree does
// not install; the confirmation buttons only need native button semantics here.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const React = await import('react')
  return {
    Button: (props: Record<string, unknown>) => React.createElement(
      'button',
      {
        type: 'button',
        className: `mock-button mock-button-${String(props.variant ?? 'default')}`,
        disabled: props.disabled === true,
        onClick: props.onClick as (() => void) | undefined,
      },
      props.children as React.ReactNode,
    ),
  }
})

const PROJECT = 'group/proj'

const detail = {
  workspaceId: '__configured__',
  project: PROJECT,
  mr: {
    iid: 3,
    title: 'Fix thing',
    state: 'opened',
    webUrl: 'https://gitlab.com/group/proj/-/merge_requests/3',
    sourceBranch: 'fix',
    targetBranch: 'main',
    author: { name: 'dev', username: 'dev' },
    hasConflicts: false,
    detailedMergeStatus: 'mergeable',
    mergeStatus: 'can_be_merged',
    changesCount: '2',
    sha: 'abc1234',
    createdAt: '2026-10-19T09:00:00Z',
    updatedAt: '2026-10-19T12:00:00Z',
  },
  commits: [
    {
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortId: 'aaaaaaa',
      title: 'feat: mine',
      authorName: 'dev',
      authorEmail: 'dev@example.com',
      authoredDate: '2026-10-19T10:00:00Z',
      parentCount: 1,
      mergeSuspect: false,
      webUrl: null,
      mine: 'me',
    },
    {
      id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      shortId: 'bbbbbbb',
      title: 'fix: someone else',
      authorName: '张三',
      authorEmail: 'zhang@example.com',
      authoredDate: '2026-10-19T11:00:00Z',
      parentCount: 2,
      mergeSuspect: true,
      webUrl: null,
      mine: 'other',
    },
    {
      id: 'cccccccccccccccccccccccccccccccccccccccc',
      shortId: 'ccccccc',
      title: "Merge branch 'feature/x' into fix",
      authorName: 'dev',
      authorEmail: 'dev@example.com',
      authoredDate: '2026-10-19T12:00:00Z',
      parentCount: 0,
      mergeSuspect: true,
      webUrl: null,
      mine: 'me',
    },
  ],
  files: [
    { path: 'src/a.ts', oldPath: null, status: 'modified', additions: 2, deletions: 1, binary: false, patchAvailable: true },
    { path: 'src/b.ts', oldPath: null, status: 'added', additions: 1, deletions: 0, binary: false, patchAvailable: true },
  ],
  hasMoreCommits: false,
  hasMoreFiles: false,
  overflow: false,
  identity: { email: 'dev@example.com', name: 'dev' },
  fetchedAt: '2026-10-19T12:01:00Z',
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

const host = (overrides: Partial<MrSurfacesHost> = {}): MrSurfacesHost => ({
  canOpenReview: true,
  openReview: vi.fn(),
  canMergeViaAgent: false,
  mergeViaAgent: vi.fn(async () => {}),
  ...overrides,
})

let root: Root | undefined
let container: HTMLDivElement | undefined

async function mount(node: ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root?.render(node) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
  return container
}

afterEach(async () => {
  await act(async () => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

const useSessions = (selector: (state: unknown) => unknown): unknown =>
  selector({ byId: { s1: { cwd: '/repo' } } })

beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/gitlab/session-mrs')) {
      return json({ turns: { 2: [{ url: 'https://gitlab.com/group/proj/-/merge_requests/3', host: 'gitlab.com', project: PROJECT, iid: 3 }] }, available: true })
    }
    if (url.includes('/gitlab/branch-mrs')) {
      return json({ project: PROJECT, branch: 'fix', mrs: [{ iid: 3, title: 'Fix thing', sourceBranch: 'fix', targetBranch: 'main', webUrl: detail.mr.webUrl }] })
    }
    if (url.includes('/gitlab/mr/commit')) {
      return json({ sha: 'abc', files: [{ path: 'src/a.ts', status: 'modified' }] })
    }
    if (url.includes('/gitlab/mr/file')) {
      return json({
        path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, binary: false,
        patch: '@@ -1,2 +1,3 @@\n-old line\n+new line\n+added line\n context', truncated: false, unavailable: false,
      })
    }
    if (url.includes('/gitlab/mr?')) return json(detail)
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
})

describe('statusLabel', () => {
  it('shows the GitLab vocabulary and prefers durable state over not_open', () => {
    expect(statusLabel({ ...detail.mr, state: 'merged', detailedMergeStatus: 'not_open' })).toEqual({ text: 'merged', tone: 'ok' })
    expect(statusLabel({ ...detail.mr, state: 'closed', detailedMergeStatus: 'not_open' })).toEqual({ text: 'closed', tone: 'muted' })
    expect(statusLabel(detail.mr)).toEqual({ text: 'mergeable', tone: 'ok' })
    expect(statusLabel({ ...detail.mr, detailedMergeStatus: 'ci_must_pass' })).toEqual({ text: 'ci_must_pass', tone: 'warn' })
    expect(statusLabel({ ...detail.mr, detailedMergeStatus: 'checking' })).toEqual({ text: 'checking', tone: 'muted' })
  })
})

describe('MrTurnTail', () => {
  it('renders the gate evidence and drills into commits and files', async () => {
    const openReview = vi.fn()
    const view = await mount(
      <MrTurnTail sessionId="s1" turn={{ turn: 2 }} useSessions={useSessions} host={host({ openReview })} />,
    )

    expect(view.textContent).toContain('!3')
    expect(view.textContent).toContain('→ main')
    expect(view.textContent).toContain('mergeable')
    expect(view.textContent).toContain('3 提交')
    expect(view.textContent).toContain('2 文件')
    expect(view.textContent).toContain('1 条他人的提交')
    expect(view.textContent).toContain('2 个 merge 提交')

    const head = view.querySelector('.gli-head-main') as HTMLButtonElement
    await act(async () => { head.click() })
    expect(view.textContent).toContain('提交 3')
    expect(view.textContent).toContain('feat: mine')
    expect(view.textContent).toContain('张三')
    expect(view.textContent).toContain('你')
    expect(view.textContent).toContain('他人')

    // One commit's files load on demand and can scope the file list.
    const commitRow = [...view.querySelectorAll('.gli-row')].find(row => row.textContent?.includes('feat: mine')) as HTMLButtonElement
    await act(async () => { commitRow.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    expect(view.textContent).toContain('这条提交改了 1 个文件')

    // The files tab lists changed paths and opens the pane for one path.
    const filesTab = [...view.querySelectorAll('.gli-tab')].find(tab => tab.textContent?.includes('文件')) as HTMLButtonElement
    await act(async () => { filesTab.click() })
    const fileRow = [...view.querySelectorAll('.gli-row')].find(row => row.textContent?.includes('src/a.ts')) as HTMLButtonElement
    await act(async () => { fileRow.click() })
    expect(openReview).toHaveBeenCalledWith({ cwd: '/repo', project: PROJECT, iid: 3, path: 'src/a.ts' })
  })

  it('asks the agent to merge only after an explicit confirmation', async () => {
    const mergeViaAgent = vi.fn(async () => {})
    const view = await mount(
      <MrTurnTail
        sessionId="s1"
        turn={{ turn: 2 }}
        useSessions={useSessions}
        host={host({ canMergeViaAgent: true, mergeViaAgent })}
      />,
    )
    const head = view.querySelector('.gli-head-main') as HTMLButtonElement
    await act(async () => { head.click() })

    const ask = [...view.querySelectorAll('button')].find(button => button.textContent === '让 Agent 合入') as HTMLButtonElement
    expect(ask).toBeTruthy()
    // The first click only raises the confirmation, never a submit.
    await act(async () => { ask.click() })
    expect(mergeViaAgent).not.toHaveBeenCalled()
    expect(view.textContent).toContain('确认让 Agent 合入')

    const confirm = [...view.querySelectorAll('button')].find(button => button.textContent === '确认发送') as HTMLButtonElement
    await act(async () => { confirm.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    expect(mergeViaAgent).toHaveBeenCalledWith({
      sessionId: 's1',
      project: PROJECT,
      iid: 3,
      sourceBranch: 'fix',
      targetBranch: 'main',
      webUrl: detail.mr.webUrl,
    })
    expect(view.textContent).toContain('已发送给 Agent')
  })

  it('renders nothing when the turn has no MR link', async () => {
    globalThis.fetch = vi.fn(async () => json({ turns: {}, available: true })) as unknown as typeof fetch
    // A different turn avoids the module's per-turn link cache and proves the
    // surface itself renders nothing for an MR-less answer.
    const view = await mount(<MrTurnTail sessionId="s2" turn={{ turn: 9 }} useSessions={useSessions} host={host()} />)
    expect(view.querySelector('.gli-card')).toBeNull()
  })
})

describe('MrDock', () => {
  it('opens the pane with the workspace and project identity', async () => {
    const openReview = vi.fn()
    const view = await mount(<MrDock sessionId="s1" useSessions={useSessions} host={host({ openReview })} />)
    const item = view.querySelector('.gli-dock-item') as HTMLButtonElement
    expect(item.textContent).toContain('!3')
    expect(item.textContent).toContain('main')
    await act(async () => { item.click() })
    expect(openReview).toHaveBeenCalledWith({ cwd: '/repo', project: PROJECT, iid: 3 })
  })
})

describe('MrReviewPane', () => {
  it('lists files, opens one diff, and offers prev/next navigation', async () => {
    const useTabInfo = () => ({
      tab: { navigation: { params: { cwd: '/repo', project: PROJECT, iid: 3 } }, actions: { close: vi.fn() } },
    })
    const view = await mount(<MrReviewPane useTabInfo={useTabInfo} host={host()} />)
    expect(view.textContent).toContain('Fix thing')
    expect(view.textContent).toContain('src/a.ts')

    const fileRow = [...view.querySelectorAll('.gli-row')].find(row => row.textContent?.includes('src/a.ts')) as HTMLButtonElement
    await act(async () => { fileRow.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    expect(view.querySelector('.gli-diff')).not.toBeNull()
    expect(view.textContent).toContain('+new line')
    expect(view.textContent).toContain('−1')
    expect(view.querySelectorAll('.gli-diff-add').length).toBe(2)

    // "Next file" moves to the second path and loads its patch from the same stub.
    const next = view.querySelector('button[aria-label="下一个文件"]') as HTMLButtonElement
    expect(next.disabled).toBe(false)
    await act(async () => { next.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    expect(view.textContent).toContain('src/b.ts')
  })
})
