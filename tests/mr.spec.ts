/**
 * MR review routes: pure parsing/classification units plus the real Loader
 * composition with a fake GitLab API and fake Session services. The routes are
 * read-only; the tests pin the workspace/project fence and the evidence shape
 * the Web card consumes.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as GitlabUi from '../src/index.ts'
import { classifyCommit, fileStatus, parseMrRefs, patchStats, type MrReviewPayload } from '../src/mr.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  GitlabUi.internals.fetchImpl = undefined
  GitlabUi.internals.runGit = undefined
  GitlabUi.internals.runGitBranch = undefined
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(rows: string[], extraModules: Record<string, unknown> = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-gitlab-mr-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, rows.join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@lim324/dsh-gitlab', GitlabUi],
    ...Object.entries(extraModules),
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

const WEBSERVER_ROW = [
  "- name: '@deepseek-ai/dsh-host-webserver'",
  '  config:',
  "    host: '127.0.0.1'",
  '    port: 0',
]

const MR_URL = 'https://gitlab.com/group/proj/-/merge_requests/3'

/** A fake GitLab API serving the configured project and one merge request. */
function fakeGitlab(): { fetchImpl: typeof fetch; seen: string[] } {
  const seen: string[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    seen.push(`${method} ${url}`)
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/projects/group%2Fproj')) return json({ default_branch: 'main' })
    if (url.includes('/repository/branches?')) return json([{ name: 'main' }, { name: 'fix' }])
    if (url.endsWith('/pipelines?per_page=5')) return json([])
    if (url.includes('/merge_requests?state=opened')) {
      return json([{ iid: 3, title: 'Fix thing', source_branch: 'fix', target_branch: 'main', author: { name: 'dev' }, web_url: MR_URL }])
    }
    if (url.endsWith('/merge_requests/3/commits?per_page=100')) {
      return json([
        {
          id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          short_id: 'aaaaaaa',
          title: 'feat: mine',
          author_name: 'dev',
          author_email: 'dev@example.com',
          authored_date: '2026-10-19T10:00:00Z',
          parent_ids: ['p1'],
          web_url: 'https://gitlab.com/group/proj/-/commit/aaaa',
        },
        {
          id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          short_id: 'bbbbbbb',
          title: 'fix: someone else',
          author_name: '张三',
          author_email: 'zhang@example.com',
          authored_date: '2026-10-19T11:00:00Z',
          parent_ids: ['p1', 'p2'],
          web_url: null,
        },
        {
          id: 'cccccccccccccccccccccccccccccccccccccccc',
          short_id: 'ccccccc',
          title: "Merge branch 'feature/x' into fix",
          author_name: 'dev',
          author_email: 'dev@example.com',
          authored_date: '2026-10-19T12:00:00Z',
          parent_ids: [],
          web_url: null,
        },
      ])
    }
    if (url.includes('/merge_requests/3/diffs?')) {
      return json([
        { old_path: 'src/a.ts', new_path: 'src/a.ts', diff: '@@ -1,2 +1,3 @@\n-old line\n+new line\n+added line\n context' },
        { old_path: 'src/b.ts', new_path: 'src/b.ts', new_file: true, diff: '+export const b = 1\n' },
      ])
    }
    if (url.endsWith('/repository/commits/abc1234/diff')) {
      return json([{ old_path: 'src/a.ts', new_path: 'src/a.ts', diff: '@@ -1 +1 @@' }])
    }
    if (url.endsWith('/merge_requests/3') && method === 'GET') {
      return json({
        iid: 3,
        title: 'Fix thing',
        state: 'opened',
        web_url: MR_URL,
        source_branch: 'fix',
        target_branch: 'main',
        author: { name: 'dev', username: 'dev' },
        has_conflicts: false,
        detailed_merge_status: 'mergeable',
        merge_status: 'can_be_merged',
        changes_count: '2',
        sha: 'abc1234',
        created_at: '2026-10-19T09:00:00Z',
        updated_at: '2026-10-19T12:00:00Z',
      })
    }
    return new Response('{"message":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, seen }
}

const MR_EVENTS = [
  {
    type: 'assistant/message',
    data: {
      turn: 2,
      message: {
        content: [
          { type: 'text', text: '已创建 production MR：' },
          { type: 'text', text: `${MR_URL}\n请人工 review。` },
        ],
      },
    },
  },
  {
    type: 'assistant/message',
    data: { turn: 3, message: { content: [{ type: 'text', text: '这一步没有链接。' }] } },
  },
]

/** Session services the turn scan reads when a Session is attached. */
function fakeSessionsPlugin(): { name: string; apply: (ctx: Context) => void } {
  return {
    name: 'fake-sessions',
    apply: (ctx: Context) => {
      const provide = (name: string, value: unknown): void => {
        ;(ctx as unknown as { provide: (key: string, service: unknown) => void }).provide(name, value)
      }
      provide('sessions', {
        get: (id: string) => (id === 's1'
          ? { snapshotEvents: () => MR_EVENTS }
          : undefined),
      })
      provide('sessionPersistence', {
        stat: async (id: string) => id === 's1',
        open: async () => ({ read: async () => ({ events: MR_EVENTS }), close: async () => {} }),
      })
    },
  }
}

describe('parseMrRefs', () => {
  it('finds canonical merge request URLs and normalizes the project path', () => {
    expect(parseMrRefs(`见 ${MR_URL} 。`)).toEqual([
      { url: MR_URL, host: 'gitlab.com', project: 'group/proj', iid: 3 },
    ])
    expect(parseMrRefs('https://gitlab.example.com:8443/group/sub/proj/-/merge_requests/7#note_1')).toEqual([
      { url: 'https://gitlab.example.com:8443/group/sub/proj/-/merge_requests/7', host: 'gitlab.example.com:8443', project: 'group/sub/proj', iid: 7 },
    ])
  })

  it('dedupes, caps, and ignores everything that is not a merge request URL', () => {
    expect(parseMrRefs(`${MR_URL} ${MR_URL}`)).toHaveLength(1)
    const six = Array.from({ length: 6 }, (_, index) => `https://gitlab.com/g/p/-/merge_requests/${String(index + 1)}`).join('\n')
    expect(parseMrRefs(six)).toHaveLength(5)
    expect(parseMrRefs('MR !3 已创建')).toEqual([])
    expect(parseMrRefs('https://gitlab.com/g/p/-/merge_requests/')).toEqual([])
  })
})

describe('classifyCommit', () => {
  const identity = { email: 'Me@Example.com', name: 'Me' }

  it('prefers the local identity and reports unknown instead of guessing', () => {
    expect(classifyCommit({ authorName: 'Anyone', authorEmail: 'me@example.com' }, identity)).toBe('me')
    expect(classifyCommit({ authorName: 'Me', authorEmail: null }, identity)).toBe('me')
    expect(classifyCommit({ authorName: 'Other', authorEmail: 'other@example.com' }, identity)).toBe('other')
    expect(classifyCommit({ authorName: 'Other', authorEmail: null }, identity)).toBe('unknown')
    expect(classifyCommit({ authorName: 'Other', authorEmail: 'other@example.com' }, { email: null, name: null })).toBe('unknown')
  })
})

describe('patchStats and fileStatus', () => {
  it('counts changed lines without the file headers', () => {
    expect(patchStats('+++ b/a\n--- a/a\n@@ -1 +1,2 @@\n-old\n+new\n+another')).toEqual({ additions: 2, deletions: 1, binary: false })
    expect(patchStats(null)).toEqual({ additions: 0, deletions: 0, binary: false })
    expect(patchStats('Binary files a/x.png and b/x.png differ')).toMatchObject({ binary: true })
  })

  it('maps diff flags to one status badge', () => {
    expect(fileStatus({ newFile: true, deletedFile: false, renamedFile: false })).toBe('added')
    expect(fileStatus({ newFile: false, deletedFile: true, renamedFile: false })).toBe('deleted')
    expect(fileStatus({ newFile: false, deletedFile: false, renamedFile: true })).toBe('renamed')
    expect(fileStatus({ newFile: false, deletedFile: false, renamedFile: false })).toBe('modified')
  })
})

describe('MR review routes', () => {
  it('serves turn refs, MR evidence, commit files and one file patch', { timeout: 60_000 }, async () => {
    const { fetchImpl, seen } = fakeGitlab()
    GitlabUi.internals.fetchImpl = fetchImpl
    const loaded = await loadComposition([
      ...WEBSERVER_ROW,
      "- name: 'fake-sessions'",
      '',
      "- name: '@lim324/dsh-gitlab'",
      '  config:',
      "    project: 'group/proj'",
      '    pollMs: 5000',
      '',
    ], { 'fake-sessions': fakeSessionsPlugin() })
    const port = loaded.webServer.port
    const base = `http://127.0.0.1:${String(port)}`

    // Turn links come from the assistant text of exactly that turn.
    const refs = await (await fetch(`${base}/gitlab/turn-mrs?sessionId=s1&turn=2`)).json() as { refs: unknown[]; available: boolean }
    expect(refs.available).toBe(true)
    expect(refs.refs).toEqual([{ url: MR_URL, host: 'gitlab.com', project: 'group/proj', iid: 3 }])
    expect(await (await fetch(`${base}/gitlab/turn-mrs?sessionId=s1&turn=3`)).json()).toEqual({ refs: [], available: true })
    expect((await fetch(`${base}/gitlab/turn-mrs?sessionId=s1`)).status).toBe(400)

    // One scan answers every turn card in a long Session.
    const session = await (await fetch(`${base}/gitlab/session-mrs?sessionId=s1`)).json() as { turns: Record<string, unknown[]>; available: boolean }
    expect(session.available).toBe(true)
    expect(Object.keys(session.turns)).toEqual(['2'])
    expect(session.turns['2']).toHaveLength(1)
    expect((await fetch(`${base}/gitlab/session-mrs`)).status).toBe(400)

    // One MR: metadata, authored commits, changed files with computed stats.
    const response = await fetch(`${base}/gitlab/mr?workspaceId=__configured__&project=group/proj&iid=3`)
    expect(response.status).toBe(200)
    const payload = await response.json() as MrReviewPayload
    expect(payload.mr).toMatchObject({ iid: 3, detailedMergeStatus: 'mergeable', hasConflicts: false, changesCount: '2', targetBranch: 'main' })
    expect(payload.commits).toHaveLength(3)
    expect(payload.commits[0]).toMatchObject({ shortId: 'aaaaaaa', mine: 'unknown', parentCount: 1, mergeSuspect: false })
    expect(payload.commits[1]).toMatchObject({ authorName: '张三', mine: 'unknown', parentCount: 2, mergeSuspect: true })
    // GitLab 16.11 returns empty parent_ids for MR commits; the merge title is
    // the remaining signal for the release gate.
    expect(payload.commits[2]).toMatchObject({ parentCount: 0, mergeSuspect: true })
    expect(payload.files).toEqual([
      { path: 'src/a.ts', oldPath: null, status: 'modified', additions: 2, deletions: 1, binary: false, patchAvailable: true },
      { path: 'src/b.ts', oldPath: null, status: 'added', additions: 1, deletions: 0, binary: false, patchAvailable: true },
    ])
    expect(payload.hasMoreFiles).toBe(false)

    // The project fence: a mismatched project never borrows this workspace's client.
    expect((await fetch(`${base}/gitlab/mr?workspaceId=__configured__&project=evil/proj&iid=3`)).status).toBe(404)
    // A missing workspace answers 400 rather than guessing.
    expect((await fetch(`${base}/gitlab/mr?iid=3`)).status).toBe(400)

    // One commit's files.
    const commit = await (await fetch(`${base}/gitlab/mr/commit?workspaceId=__configured__&project=group/proj&iid=3&sha=abc1234`)).json() as { files: unknown[] }
    expect(commit.files).toEqual([{ path: 'src/a.ts', oldPath: null, status: 'modified' }])
    expect((await fetch(`${base}/gitlab/mr/commit?workspaceId=__configured__&project=group/proj&iid=3&sha=bad`)).status).toBe(400)

    // One file's patch, including a path the MR does not contain.
    const file = await (await fetch(`${base}/gitlab/mr/file?workspaceId=__configured__&project=group/proj&iid=3&path=src%2Fa.ts`)).json() as { patch: string; additions: number }
    expect(file.patch).toContain('@@ -1,2 +1,3 @@')
    expect(file.additions).toBe(2)
    expect((await fetch(`${base}/gitlab/mr/file?workspaceId=__configured__&project=group/proj&iid=3&path=src%2Fmissing.ts`)).status).toBe(404)

    // The dock route filters open MRs by the checkout's current branch; the
    // configured project has no checkout, so it reports the branch as null.
    const branch = await (await fetch(`${base}/gitlab/branch-mrs?workspaceId=__configured__`)).json() as { branch: string | null; mrs: unknown[] }
    expect(branch).toEqual({ workspaceId: '__configured__', project: 'group/proj', branch: null, mrs: [] })

    expect(seen.some(entry => entry.includes('/merge_requests/3/commits'))).toBe(true)
  })

  it('falls back to the single-response changes endpoint on older GitLab', { timeout: 60_000 }, async () => {
    const baseFetch = fakeGitlab().fetchImpl
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('/merge_requests/3/diffs?')) {
        return new Response('{"message":"404 Not Found"}', { status: 404, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/merge_requests/3/changes')) {
        return new Response(JSON.stringify({
          changes: [{ old_path: 'src/c.ts', new_path: 'src/c.ts', diff: '+c' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return baseFetch(input, init)
    }
    GitlabUi.internals.fetchImpl = fetchImpl
    const loaded = await loadComposition([
      ...WEBSERVER_ROW,
      "- name: '@lim324/dsh-gitlab'",
      '  config:',
      "    project: 'group/proj'",
      '    pollMs: 5000',
      '',
    ])
    const base = `http://127.0.0.1:${String(loaded.webServer.port)}`
    const payload = await (await fetch(`${base}/gitlab/mr?workspaceId=__configured__&project=group/proj&iid=3`)).json() as MrReviewPayload
    expect(payload.files).toHaveLength(1)
    expect(payload.files[0]).toMatchObject({ path: 'src/c.ts', status: 'modified', additions: 1 })
  })
})
