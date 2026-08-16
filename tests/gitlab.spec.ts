/**
 * REAL-composition coverage: a test-only cordis.yml boots the webserver and
 * the dsh-gitlab host half through the vendored Loader (aliased to the
 * checkout's built artifacts), with a fake fetch standing in for the GitLab
 * API. Unit sections pin remote parsing and the client's wire behavior.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SettingsConflictError, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { GitlabApi, parseGitRemote } from '../src/gitlab.ts'
import * as GitlabUi from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  GitlabUi.internals.fetchImpl = undefined
  GitlabUi.internals.runGit = undefined
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a cordis.yml with the given rows, then boot it through the real Loader. */
async function loadComposition(rows: string[], extraModules: Record<string, unknown> = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-gitlab-loader-'))
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

/** A fake GitLab API: one hand-rolled response per path pattern, recording each request's token header. */
function fakeGitlab(): { fetchImpl: typeof fetch; seen: string[]; tokens: string[]; createdMrBodies: unknown[] } {
  const seen: string[] = []
  const tokens: string[] = []
  const createdMrBodies: unknown[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    seen.push(`${init?.method ?? 'GET'} ${url}`)
    tokens.push(String((init?.headers as Record<string, string> | undefined)?.['private-token'] ?? ''))
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    // Detection probe: this host answers 401 (the endpoint exists but
    // demands authentication), proving the 401 signal counts as GitLab.
    if (url === 'https://gitlab.com/api/v4/version') {
      return json({ version: '17.0.0', revision: 'abc123' })
    }
    if (url === 'https://git-ops.internal.example/api/v4/version') {
      return new Response('{"message":"401 Unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } })
    }
    if (url.endsWith('/pipelines?per_page=5')) {
      return json([{ id: 7, status: 'running', ref: 'main', sha: 'abc12345', web_url: null }])
    }
    if (url.endsWith('/pipelines/7/jobs')) {
      // Newest-first, exactly like the real API: the client must restore
      // the execution order by ascending id. The commit rides along on the
      // jobs payload, like the real API.
      return json([
        { id: 12, name: 'test', stage: 'test', status: 'running', duration: null, web_url: null, commit: { title: 'ci: two jobs per stage', author_name: 'dev' } },
        { id: 11, name: 'build', stage: 'build', status: 'success', duration: 42, web_url: 'https://gitlab.com/-/jobs/11', commit: { title: 'ci: two jobs per stage', author_name: 'dev' } },
      ])
    }
    if (url.includes('/merge_requests?state=opened')) {
      return json([{ iid: 3, title: 'Fix thing', source_branch: 'fix', target_branch: 'main', author: { name: 'dev' }, web_url: null }])
    }
    if (url.endsWith('/approve') || url.endsWith('/merge')) {
      return new Response('', { status: 200 })
    }
    if (url.endsWith('/merge_requests/3') && init?.method === 'PUT') {
      return json({ iid: 3, state: 'closed' })
    }
    if (url.endsWith('/merge_requests') && init?.method === 'POST') {
      createdMrBodies.push(JSON.parse(String(init.body)))
      return json({ iid: 42, web_url: 'https://gitlab.com/x/-/merge_requests/42' })
    }
    if (url.endsWith('/projects/group%2Fproj') || url.endsWith('/projects/acme%2Ffrontend')) {
      return json({ default_branch: 'main' })
    }
    if (url.includes('/repository/branches?')) {
      return json([{ name: 'main' }, { name: 'feature/x' }])
    }
    return new Response('{"message":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, seen, tokens, createdMrBodies }
}

/**
 * A settings service faithful to the seam subset the settings route
 * touches: register/get/watch plus service-level update/mutate with deep
 * merge, revision guarding, and describe carrying the revision.
 */
function fakeSettingsPlugin(initial: Record<string, unknown> = {}): { name: string; apply: (ctx: Context) => void } {
  const watchers: Array<(next: unknown) => void> = []
  let section: Record<string, unknown> = { ...initial }
  let revision = 0
  const fire = (): void => { for (const callback of watchers) callback(section) }
  const guard = (expectedRevision: number | undefined): void => {
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      throw new SettingsConflictError(settingsNamespace('gitlab'), expectedRevision, revision)
    }
  }
  const deepMerge = (patch: Record<string, unknown>): Record<string, unknown> => {
    const next: Record<string, unknown> = { ...section, ...patch }
    if (typeof section.hostTokens === 'object' && section.hostTokens !== null && typeof patch.hostTokens === 'object' && patch.hostTokens !== null) {
      next.hostTokens = { ...(section.hostTokens as Record<string, unknown>), ...(patch.hostTokens as Record<string, unknown>) }
    }
    return next
  }
  return {
    name: 'fake-settings',
    apply: (ctx: Context) => {
      ctx.provide('settings', {
        writable: true,
        describe: () => [{ ns: settingsNamespace('gitlab'), revision }],
        register: (ns: string, _schema: unknown) => ({
          get: () => section,
          watch: (callback: (next: unknown) => void) => { watchers.push(callback); return () => {} },
        }),
        update: async (ns: string, patch: Record<string, unknown>, expectedRevision?: number) => {
          expect(ns).toBe('gitlab')
          guard(expectedRevision)
          section = deepMerge(patch)
          revision++
          fire()
        },
        mutate: async (ns: string, ops: Array<{ op: string; path: readonly string[] }>, expectedRevision?: number) => {
          expect(ns).toBe('gitlab')
          guard(expectedRevision)
          for (const op of ops) {
            if (op.op !== 'unset') continue
            const [head, nested] = op.path
            if (head === undefined) {
              section = {}
              continue
            }
            if (nested === undefined) {
              const { [head]: _removed, ...kept } = section
              section = kept
              continue
            }
            const parent = section[head]
            if (typeof parent === 'object' && parent !== null) {
              const { [nested]: _removedNested, ...keptNested } = parent as Record<string, unknown>
              section = { ...section, [head]: keptNested }
            }
          }
          revision++
          fire()
        },
      })
    },
  }
}

describe('parseGitRemote', () => {
  it('parses https, scp, and ssh:// origin shapes and rejects garbage', () => {
    expect(parseGitRemote('https://gitlab.com/group/sub/proj.git')).toEqual({ host: 'gitlab.com', project: 'group/sub/proj' })
    expect(parseGitRemote('git@gitlab.example.com:group/proj.git')).toEqual({ host: 'gitlab.example.com', project: 'group/proj' })
    // The ssh:// shape strips the ssh port: it is never the HTTPS API port.
    expect(parseGitRemote('ssh://git@git-corp.example.com:32200/fde/webapps/act/demo-project.git'))
      .toEqual({ host: 'git-corp.example.com', project: 'fde/webapps/act/demo-project' })
    expect(parseGitRemote('ssh://git@host.example/group/proj')).toEqual({ host: 'host.example', project: 'group/proj' })
    expect(parseGitRemote('https://github.com/a/b.git')).toEqual({ host: 'github.com', project: 'a/b' })
    expect(parseGitRemote('not a remote')).toBeUndefined()
    expect(parseGitRemote('https://gitlab.com/../evil.git')).toBeUndefined()
    expect(parseGitRemote('https://gitlab.com/group//proj.git')).toBeUndefined()
  })
})

describe('GitlabApi', () => {
  it('sends the private-token header, encodes the project path, and times out via the signal', async () => {
    const seen: RequestInit[] = []
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init ?? {})
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const api = new GitlabApi({ baseUrl: 'https://gitlab.example.com/api/v4/', token: 'tok', fetchImpl })
    expect(await api.listPipelines('group/sub proj')).toEqual([])
    expect(seen[0]?.headers).toMatchObject({ 'private-token': 'tok' })
    expect(String(seen[0]?.signal)).toBeTruthy()
  })

  it('approve and merge POST/PUT the expected paths', async () => {
    const { fetchImpl, seen } = fakeGitlab()
    const api = new GitlabApi({ baseUrl: 'https://gitlab.com/api/v4', token: 'tok', fetchImpl })
    await api.approveMr('group/proj', 3)
    await api.mergeMr('group/proj', 3)
    expect(seen).toContain('POST https://gitlab.com/api/v4/projects/group%2Fproj/merge_requests/3/approve')
    expect(seen).toContain('PUT https://gitlab.com/api/v4/projects/group%2Fproj/merge_requests/3/merge')
  })

  it('rejects non-ok responses', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as typeof fetch
    const api = new GitlabApi({ baseUrl: 'https://gitlab.com/api/v4', fetchImpl })
    await expect(api.listPipelines('g/p')).rejects.toThrow(/401/)
  })
})

describe('real Loader composition', () => {
  it('serves the not-a-GitLab cwd fallback state and fences the routes', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition([
      ...WEBSERVER_ROW,
      "- name: '@lim324/dsh-gitlab'",
      '  config:',
      '    pollMs: 5000',
      '',
    ])
    const port = loaded.webServer.port

    // A missing workspaceId answers 400; an unknown one answers 404.
    expect((await fetch(`http://127.0.0.1:${String(port)}/gitlab/status`)).status).toBe(400)
    expect((await fetch(`http://127.0.0.1:${String(port)}/gitlab/status?workspaceId=nope`)).status).toBe(404)

    const status = await fetch(`http://127.0.0.1:${String(port)}/gitlab/status?workspaceId=__cwd__`)
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ gitlab: false, authed: false, pipelines: [], mrs: [] })

    // Without a settings service the token route degrades to unavailable.
    const settings = await (await fetch(`http://127.0.0.1:${String(port)}/gitlab/settings`)).json()
    expect(settings).toEqual({ available: false })

    // Actions against an unknown project answer 409.
    const action = await fetch(`http://127.0.0.1:${String(port)}/gitlab/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'approve', iid: 1, project: 'nope' }),
    })
    expect(action.status).toBe(409)

    // The fence refuses a non-loopback Host authority.
    const hostile = connect(port, '127.0.0.1')
    await once(hostile, 'connect')
    const hostileData = once(hostile, 'data')
    hostile.write([
      'GET /gitlab/status?workspaceId=__cwd__ HTTP/1.1',
      'Host: evil.example.com',
      'Connection: close',
      '',
      '',
    ].join('\r\n'))
    const [chunk] = await hostileData as [Buffer]
    expect(String(chunk)).toContain('403')
    hostile.destroy()
  })

  it('detects and polls only the requested workspace, on demand', { timeout: 60_000 }, async () => {
    const { fetchImpl, seen, createdMrBodies } = fakeGitlab()
    GitlabUi.internals.fetchImpl = fetchImpl
    GitlabUi.internals.runGit = async (dir: string) => {
      if (dir === '/ws/frontend') return 'https://gitlab.com/acme/frontend.git'
      if (dir === '/ws/backend') return 'git@github.com:acme/backend.git'
      return 'not a remote'
    }
    GitlabUi.internals.runGitBranch = async () => 'master'
    const fakeRegistry = {
      name: 'fake-workspace-registry',
      apply: (ctx: Context) => {
        ctx.provide('workspaceRegistry', {
          list: () => [
            { id: 'ws-frontend', path: '/ws/frontend', title: 'frontend' },
            { id: 'ws-backend', path: '/ws/backend', title: 'backend' },
          ],
        })
      },
    }
    const loaded = await loadComposition([
      ...WEBSERVER_ROW,
      "- name: 'fake-workspace-registry'",
      '',
      "- name: '@lim324/dsh-gitlab'",
      '  config:',
      "    token: 'tok'",
      '    pollMs: 5000',
      '',
    ], { 'fake-workspace-registry': fakeRegistry })
    const port = loaded.webServer.port

    // Requesting the frontend workspace detects and polls only its project.
    const frontend = await (await fetch(`http://127.0.0.1:${String(port)}/gitlab/status?workspaceId=ws-frontend`)).json() as GitlabUi.WorkspaceStatus
    expect(frontend).toMatchObject({
      workspaceId: 'ws-frontend', gitlab: true, authed: true, project: 'acme/frontend',
      pipelines: [{
        status: 'running',
        commit: { title: 'ci: two jobs per stage', authorName: 'dev' },
        jobs: [{ name: 'build', stage: 'build' }, { name: 'test', status: 'running' }],
      }],
      mrs: [{ title: 'Fix thing' }],
    })
    expect(seen.some(url => url.includes('acme%2Ffrontend'))).toBe(true)
    expect(seen.some(url => url.endsWith('/pipelines/7/jobs'))).toBe(true)

    // The backend workspace was never requested: its non-GitLab remote is
    // only detected when asked for, and it answers the not-a-GitLab row.
    expect(seen.some(url => url.includes('acme%2Fbackend'))).toBe(false)
    const backend = await (await fetch(`http://127.0.0.1:${String(port)}/gitlab/status?workspaceId=ws-backend`)).json() as GitlabUi.WorkspaceStatus
    expect(backend).toMatchObject({ workspaceId: 'ws-backend', gitlab: false, authed: false, pipelines: [] })

    // create-mr: explicit branch choices from the client win.
    const created = await fetch(`http://127.0.0.1:${String(port)}/gitlab/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'create-mr', project: 'acme/frontend', title: 'Ship it', sourceBranch: 'feature/x', targetBranch: 'main' }),
    })
    expect(created.status).toBe(200)
    expect(await created.json()).toMatchObject({ ok: true, iid: 42 })
    expect(createdMrBodies).toEqual([{ source_branch: 'feature/x', target_branch: 'main', title: 'Ship it' }])

    // Without explicit branches, the workspace's current branch and the
    // project's default branch fill in.
    const fallback = await fetch(`http://127.0.0.1:${String(port)}/gitlab/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'create-mr', project: 'acme/frontend', title: 'Composed' }),
    })
    expect(fallback.status).toBe(200)
    expect(createdMrBodies[1]).toEqual({ source_branch: 'master', target_branch: 'main', title: 'Composed' })

    // The status row carries the selectors' data.
    const row = await (await fetch(`http://127.0.0.1:${String(port)}/gitlab/status?workspaceId=ws-frontend`)).json() as GitlabUi.WorkspaceStatus
    expect(row).toMatchObject({ currentBranch: 'master', defaultBranch: 'main', branches: ['main', 'feature/x'] })
  })

  it('resolves workspaces registered after boot on their first request', { timeout: 60_000 }, async () => {
    const { fetchImpl } = fakeGitlab()
    GitlabUi.internals.fetchImpl = fetchImpl
    GitlabUi.internals.runGit = async (dir: string) => {
      if (dir === '/ws/frontend') return 'https://gitlab.com/acme/frontend.git'
      return 'not a remote'
    }
    const registry = { current: [] as Array<{ id: string; path: string; title: string }> }
    const fakeRegistry = {
      name: 'fake-workspace-registry',
      apply: (ctx: Context) => {
        ctx.provide('workspaceRegistry', { list: () => registry.current })
      },
    }
    const loaded = await loadComposition([
      ...WEBSERVER_ROW,
      "- name: 'fake-workspace-registry'",
      '',
      "- name: '@lim324/dsh-gitlab'",
      '  config:',
      '    pollMs: 5000',
      '',
    ], { 'fake-workspace-registry': fakeRegistry })
    const port = loaded.webServer.port

    // Unknown before registration.
    expect((await fetch(`http://127.0.0.1:${String(port)}/gitlab/status?workspaceId=ws-frontend`)).status).toBe(404)

    // Registered after boot: the first request resolves it.
    registry.current = [{ id: 'ws-frontend', path: '/ws/frontend', title: 'frontend' }]
    const after = await (await fetch(`http://127.0.0.1:${String(port)}/gitlab/status?workspaceId=ws-frontend`)).json() as GitlabUi.WorkspaceStatus
    expect(after).toMatchObject({ workspaceId: 'ws-frontend', gitlab: true, project: 'acme/frontend', pipelines: [{ status: 'running' }] })
  })

  it('polls the configured project and serves token-gated actions', { timeout: 60_000 }, async () => {
    const { fetchImpl, seen } = fakeGitlab()
    GitlabUi.internals.fetchImpl = fetchImpl
    const loaded = await loadComposition([
      ...WEBSERVER_ROW,
      "- name: '@lim324/dsh-gitlab'",
      '  config:',
      "    project: 'group/proj'",
      '    token: tok',
      '    pollMs: 5000',
      '',
    ])
    const port = loaded.webServer.port

    const status = await fetch(`http://127.0.0.1:${String(port)}/gitlab/status?workspaceId=__configured__`)
    const body = await status.json() as GitlabUi.WorkspaceStatus
    expect(body).toMatchObject({ gitlab: true, authed: true, project: 'group/proj', pipelines: [{ status: 'running' }], mrs: [{ title: 'Fix thing' }] })

    const approve = await fetch(`http://127.0.0.1:${String(port)}/gitlab/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'approve', iid: 3, project: 'group/proj' }),
    })
    expect(approve.status).toBe(200)
    expect(seen).toContain('POST https://gitlab.com/api/v4/projects/group%2Fproj/merge_requests/3/approve')

    const close = await fetch(`http://127.0.0.1:${String(port)}/gitlab/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'close', iid: 3, project: 'group/proj' }),
    })
    expect(close.status).toBe(200)
    expect(seen).toContain('PUT https://gitlab.com/api/v4/projects/group%2Fproj/merge_requests/3')

    const bad = await fetch(`http://127.0.0.1:${String(port)}/gitlab/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'explode', iid: 3, project: 'group/proj' }),
    })
    expect(bad.status).toBe(400)
  })

  it('registers the gitlab settings namespace and re-tokenizes live clients on user edits', { timeout: 60_000 }, async () => {
    const { fetchImpl, seen } = fakeGitlab()
    GitlabUi.internals.fetchImpl = fetchImpl
    // A structural settings service: register/get/watch/update, with the
    // namespace and schema captured for the assertions.
    const registrations: Array<{ ns: string; schema: unknown }> = []
    let update: ((patch: object) => Promise<void>) | undefined
    const fakeSettings = {
      name: 'fake-settings',
      apply: (ctx: Context) => {
        const watchers: Array<(next: unknown) => void> = []
        let section: Record<string, unknown> = {}
        ctx.provide('settings', {
          register: (ns: string, schema: unknown) => {
            registrations.push({ ns, schema })
            return {
              get: () => section,
              watch: (callback: (next: unknown) => void) => { watchers.push(callback); return () => {} },
              update: async (patch: object) => {
                section = { ...section, ...patch }
                for (const callback of watchers) callback(section)
              },
            }
          },
        })
        update = async (patch: object) => {
          section = { ...section, ...patch }
          for (const callback of watchers) callback(section)
        }
      },
    }
    const loaded = await loadComposition([
      ...WEBSERVER_ROW,
      "- name: 'fake-settings'",
      '',
      "- name: '@lim324/dsh-gitlab'",
      '  config:',
      "    project: 'group/proj'",
      '    pollMs: 5000',
      '',
    ], { 'fake-settings': fakeSettings })
    const port = loaded.webServer.port

    // The namespace registers once, under its branded name.
    expect(registrations.map(entry => entry.ns)).toEqual(['gitlab'])

    // No config token: writes answer 401.
    await (await fetch(`http://127.0.0.1:${String(port)}/gitlab/status?workspaceId=__configured__`)).json()
    const before = await fetch(`http://127.0.0.1:${String(port)}/gitlab/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'approve', iid: 3, project: 'group/proj' }),
    })
    expect(before.status).toBe(401)

    // The Settings panel's save re-tokenizes the live client: the same
    // action now succeeds and the snapshot flips to authed.
    await update!({ token: 'settings-tok' })
    const after = await fetch(`http://127.0.0.1:${String(port)}/gitlab/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'approve', iid: 3, project: 'group/proj' }),
    })
    expect(after.status).toBe(200)
    expect(seen).toContain('POST https://gitlab.com/api/v4/projects/group%2Fproj/merge_requests/3/approve')
    const row = await (await fetch(`http://127.0.0.1:${String(port)}/gitlab/status?workspaceId=__configured__`)).json() as GitlabUi.WorkspaceStatus
    expect(row.authed).toBe(true)
  })

  it('serves the token state over the fenced /gitlab/settings route, revision-guarded', { timeout: 60_000 }, async () => {
    const { fetchImpl, seen } = fakeGitlab()
    GitlabUi.internals.fetchImpl = fetchImpl
    const loaded = await loadComposition([
      ...WEBSERVER_ROW,
      "- name: 'fake-settings'",
      '',
      "- name: '@lim324/dsh-gitlab'",
      '  config:',
      "    project: 'group/proj'",
      '    pollMs: 5000',
      '',
    ], { 'fake-settings': fakeSettingsPlugin() })
    const port = loaded.webServer.port

    // Initial state: no token saved.
    const initial = await (await fetch(`http://127.0.0.1:${String(port)}/gitlab/settings`)).json() as { available: boolean; writable: boolean; tokenSet: boolean; hostTokens: string[]; revision: number }
    expect(initial).toEqual({ available: true, writable: true, tokenSet: false, hostTokens: [], revision: 0 })

    // Saving a token re-tokenizes the live client: writes stop answering 401.
    const save = await fetch(`http://127.0.0.1:${String(port)}/gitlab/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'settings-tok', expectedRevision: 0 }),
    })
    expect(save.status).toBe(200)
    expect(await save.json()).toMatchObject({ tokenSet: true, revision: 1 })
    await (await fetch(`http://127.0.0.1:${String(port)}/gitlab/status?workspaceId=__configured__`)).json()
    const approve = await fetch(`http://127.0.0.1:${String(port)}/gitlab/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'approve', iid: 3, project: 'group/proj' }),
    })
    expect(approve.status).toBe(200)
    expect(seen).toContain('POST https://gitlab.com/api/v4/projects/group%2Fproj/merge_requests/3/approve')

    // A stale revision answers 409 and does not overwrite.
    const stale = await fetch(`http://127.0.0.1:${String(port)}/gitlab/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'other-tok', expectedRevision: 0 }),
    })
    expect(stale.status).toBe(409)

    // Clearing falls back to unauthenticated.
    const clear = await fetch(`http://127.0.0.1:${String(port)}/gitlab/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true, expectedRevision: 1 }),
    })
    expect(clear.status).toBe(200)
    expect(await clear.json()).toMatchObject({ tokenSet: false, revision: 2 })
    const after = await fetch(`http://127.0.0.1:${String(port)}/gitlab/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'approve', iid: 3, project: 'group/proj' }),
    })
    expect(after.status).toBe(401)

    // Per-host tokens: saved by host name, cleared individually, and the
    // default token stays untouched.
    const hostSave = await fetch(`http://127.0.0.1:${String(port)}/gitlab/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'gitlab.com', token: 'com-tok', expectedRevision: 2 }),
    })
    expect(hostSave.status).toBe(200)
    expect(await hostSave.json()).toMatchObject({ tokenSet: false, hostTokens: ['gitlab.com'], revision: 3 })
    const hostClear = await fetch(`http://127.0.0.1:${String(port)}/gitlab/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'gitlab.com', clear: true, expectedRevision: 3 }),
    })
    expect(hostClear.status).toBe(200)
    expect(await hostClear.json()).toMatchObject({ hostTokens: [], revision: 4 })

    // A malformed write answers 400.
    const bad = await fetch(`http://127.0.0.1:${String(port)}/gitlab/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(bad.status).toBe(400)
  })

  it('sends each project its host-matched token, falling back to the default', { timeout: 60_000 }, async () => {
    const { fetchImpl, seen, tokens } = fakeGitlab()
    GitlabUi.internals.fetchImpl = fetchImpl
    GitlabUi.internals.runGit = async (dir: string) => {
      if (dir === '/ws/frontend') return 'https://gitlab.com/acme/frontend.git'
      // A corporate-shaped remote: ssh:// with a port and a host name that
      // does not contain "gitlab" — detection must come from the API probe.
      if (dir === '/ws/other') return 'ssh://git@git-ops.internal.example:32200/acme/other.git'
      return 'not a remote'
    }
    const fakeRegistry = {
      name: 'fake-workspace-registry',
      apply: (ctx: Context) => {
        ctx.provide('workspaceRegistry', {
          list: () => [
            { id: 'ws-frontend', path: '/ws/frontend', title: 'frontend' },
            { id: 'ws-other', path: '/ws/other', title: 'other' },
          ],
        })
      },
    }
    const loaded = await loadComposition([
      ...WEBSERVER_ROW,
      "- name: 'fake-settings'",
      '',
      "- name: 'fake-workspace-registry'",
      '',
      "- name: '@lim324/dsh-gitlab'",
      '  config:',
      '    pollMs: 5000',
      '',
    ], { 'fake-settings': fakeSettingsPlugin(), 'fake-workspace-registry': fakeRegistry })
    const port = loaded.webServer.port

    // Detect both projects first (no token yet).
    await (await fetch(`http://127.0.0.1:${String(port)}/gitlab/status?workspaceId=ws-frontend`)).json()
    await (await fetch(`http://127.0.0.1:${String(port)}/gitlab/status?workspaceId=ws-other`)).json()

    // A default token plus a gitlab.com override.
    const saveDefault = await fetch(`http://127.0.0.1:${String(port)}/gitlab/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'default-tok', expectedRevision: 0 }),
    })
    expect(saveDefault.status).toBe(200)
    const saveHost = await fetch(`http://127.0.0.1:${String(port)}/gitlab/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'gitlab.com', token: 'com-tok', expectedRevision: 1 }),
    })
    expect(saveHost.status).toBe(200)

    const approve = async (project: string): Promise<void> => {
      const res = await fetch(`http://127.0.0.1:${String(port)}/gitlab/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'approve', iid: 3, project }),
      })
      expect(res.status).toBe(200)
    }
    await approve('acme/frontend')
    await approve('acme/other')

    // The gitlab.com project carried the per-host token; the internal host
    // fell back to the default token.
    expect(tokens[seen.indexOf('POST https://gitlab.com/api/v4/projects/acme%2Ffrontend/merge_requests/3/approve')]).toBe('com-tok')
    expect(tokens[seen.indexOf('POST https://git-ops.internal.example/api/v4/projects/acme%2Fother/merge_requests/3/approve')]).toBe('default-tok')
  })

  it('seeds the token persisted before this boot without a commit', { timeout: 60_000 }, async () => {
    const { fetchImpl, seen, tokens } = fakeGitlab()
    GitlabUi.internals.fetchImpl = fetchImpl
    const loaded = await loadComposition([
      ...WEBSERVER_ROW,
      "- name: 'fake-settings'",
      '',
      "- name: '@lim324/dsh-gitlab'",
      '  config:',
      "    project: 'group/proj'",
      '    pollMs: 5000',
      '',
    ], { 'fake-settings': fakeSettingsPlugin({ token: 'persisted-tok' }) })
    const port = loaded.webServer.port

    // No watch ever fired; the registration-time read alone must arm the token.
    await (await fetch(`http://127.0.0.1:${String(port)}/gitlab/status?workspaceId=__configured__`)).json()
    const approve = await fetch(`http://127.0.0.1:${String(port)}/gitlab/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'approve', iid: 3, project: 'group/proj' }),
    })
    expect(approve.status).toBe(200)
    expect(tokens[seen.indexOf('POST https://gitlab.com/api/v4/projects/group%2Fproj/merge_requests/3/approve')]).toBe('persisted-tok')
  })

  it('clears the snapshot when a poll fails — no stale rows survive', { timeout: 60_000 }, async () => {
    const { fetchImpl } = fakeGitlab()
    let broken = false
    GitlabUi.internals.fetchImpl = ((input, init) =>
      broken ? Promise.resolve(new Response('nope', { status: 500 })) : fetchImpl(input, init)) as typeof fetch
    const loaded = await loadComposition([
      ...WEBSERVER_ROW,
      "- name: '@lim324/dsh-gitlab'",
      '  config:',
      "    project: 'group/proj'",
      '    token: tok',
      '    pollMs: 5000',
      '',
    ])
    const port = loaded.webServer.port
    const status = async (): Promise<GitlabUi.WorkspaceStatus> =>
      (await fetch(`http://127.0.0.1:${String(port)}/gitlab/status?workspaceId=__configured__`)).json() as Promise<GitlabUi.WorkspaceStatus>

    // First poll succeeds and serves rows.
    const healthy = await status()
    expect(healthy.pipelines).toHaveLength(1)
    expect(healthy.error).toBeNull()

    // The API breaks; the next poll must empty the snapshot, not keep it.
    broken = true
    await new Promise(resolve => setTimeout(resolve, 5500))
    const failed = await status()
    expect(failed.pipelines).toEqual([])
    expect(failed.mrs).toEqual([])
    expect(failed.branches).toEqual([])
    expect(failed.error).toContain('500')

    // The API recovers; the next poll repopulates.
    broken = false
    await new Promise(resolve => setTimeout(resolve, 5500))
    const recovered = await status()
    expect(recovered.pipelines).toHaveLength(1)
    expect(recovered.error).toBeNull()
  })

  it('answers 401 on write actions when no token is configured', { timeout: 60_000 }, async () => {
    const { fetchImpl } = fakeGitlab()
    GitlabUi.internals.fetchImpl = fetchImpl
    const loaded = await loadComposition([
      ...WEBSERVER_ROW,
      "- name: '@lim324/dsh-gitlab'",
      '  config:',
      "    project: 'group/proj'",
      '    pollMs: 5000',
      '',
    ])
    const port = loaded.webServer.port
    // On-demand mode: the project's api exists only after its status was requested.
    expect((await fetch(`http://127.0.0.1:${String(port)}/gitlab/status?workspaceId=__configured__`)).status).toBe(200)
    const action = await fetch(`http://127.0.0.1:${String(port)}/gitlab/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'merge', iid: 3, project: 'group/proj' }),
    })
    expect(action.status).toBe(401)
  })
})

describe('findWorkspaceId', () => {
  it('matches the current session to its owning workspace', async () => {
    const { findWorkspaceId } = await import('../src/client/index.tsx')
    const workspaces = [
      { workspaceId: 'a', title: 'A', sessionIds: ['s1'] },
      { workspaceId: 'b', title: 'B', sessionIds: ['s2'] },
    ]
    expect(findWorkspaceId('s2', workspaces)).toBe('b')
    expect(findWorkspaceId(undefined, workspaces)).toBeUndefined()
    expect(findWorkspaceId('s3', workspaces)).toBeUndefined()
    expect(findWorkspaceId('s1', [{ workspaceId: 'z', title: 'Z', sessionIds: [] }])).toBeUndefined()
  })
})
