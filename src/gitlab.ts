/**
 * Minimal GitLab REST API client plus git-remote parsing for the host half.
 * Purpose-built for the pipeline/MR surface: list pipelines, list open MRs,
 * approve, merge. The token travels only in the private-token header.
 * @module @lim324/dsh-gitlab/src/gitlab
 */

/** One parsed GitLab repository remote. */
export interface GitlabRemote {
  /** Remote host, e.g. gitlab.com. */
  host: string
  /** Project path without the .git suffix, e.g. group/sub/project. */
  project: string
}

/**
 * Parse a git origin URL into host and project, for the two shapes git
 * produces: `https://host/group/project.git` and `git@host:group/project.git`.
 * @param url - the raw `git remote get-url origin` output.
 * @returns the parsed remote, or undefined for non-origin shapes.
 */
export function parseGitRemote(url: string): GitlabRemote | undefined {
  const https = /^https?:\/\/([^/]+)\/(.+)$/.exec(url.trim())
  let host: string
  let rest: string
  if (https !== null) {
    host = https[1]!
    rest = https[2]!
  } else {
    const ssh = /^git@([^:]+):(.+)$/.exec(url.trim())
    if (ssh === null) return undefined
    host = ssh[1]!
    rest = ssh[2]!
  }
  const project = rest.replace(/\.git$/, '')
  // A path that tries to escape the project namespace is not a valid remote.
  if (project === '' || project.split('/').some(segment => segment === '' || segment === '..')) return undefined
  return { host, project }
}

/** One job row inside a pipeline. */
export interface JobRow {
  id: number
  name: string
  stage: string
  status: string
  durationSeconds: number | null
  webUrl: string | null
}

/** The commit a pipeline ran for (carried by the jobs response). */
export interface CommitInfo {
  title: string
  authorName: string | null
}

/** One pipeline row for the status snapshot, with its jobs and commit attached. */
export interface PipelineRow {
  id: number
  status: string
  ref: string
  sha: string
  webUrl: string | null
  commit: CommitInfo | null
  jobs: JobRow[]
}

/** One merge request row for the status snapshot. */
export interface MrRow {
  iid: number
  title: string
  sourceBranch: string
  targetBranch: string
  author: string | null
  webUrl: string | null
}

/** Client options; fetchImpl injection keeps the client testable. */
export interface GitlabApiOptions {
  baseUrl: string
  token?: string
  /**
   * Lazily resolved per request and per `hasToken()` probe, winning over
   * `token` when present. The host passes one so a settings-section edit
   * re-tokenizes live clients without reconstructing them.
   */
  tokenProvider?: () => string | undefined
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * Thin GitLab REST v4 client over injectable fetch: bearer-style private
 * token header, a per-request timeout, and typed projections for the four
 * calls the UI surface needs.
 */
export class GitlabApi {
  private readonly baseUrl: string
  private readonly token: string | undefined
  private readonly tokenProvider: (() => string | undefined) | undefined
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: GitlabApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.token = options.token
    this.tokenProvider = options.tokenProvider
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  /** The token the next request will send: the live provider first, then the static option. */
  private currentToken(): string | undefined {
    return this.tokenProvider?.() ?? this.token
  }

  /** Whether a token is configured (write operations need one). */
  hasToken(): boolean {
    const token = this.currentToken()
    return token !== undefined && token !== ''
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', ...init.headers as Record<string, string> }
    const token = this.currentToken()
    if (token !== undefined) headers['private-token'] = token
    // JSON bodies are the client's only body kind; stringify callers rely
    // on this default because fetch would otherwise send text/plain.
    if (init.body !== undefined && headers['content-type'] === undefined) headers['content-type'] = 'application/json'
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) throw new Error(`GitLab API ${String(res.status)} for ${path}`)
    if (res.status === 204) return undefined as T
    const text = await res.text()
    // Some GitLab write endpoints answer an empty 200; an empty body is a
    // success with nothing to project.
    if (text === '') return undefined as T
    return JSON.parse(text) as T
  }

  /** Latest pipelines, newest first, capped server-side. */
  async listPipelines(project: string, perPage = 5): Promise<PipelineRow[]> {
    const data = await this.request<Array<{ id: number; status: string; ref: string; sha: string; web_url: string | null }>>(
      `/projects/${encodeURIComponent(project)}/pipelines?${new URLSearchParams({ per_page: String(perPage) })}`,
    )
    return data.map(item => ({ id: item.id, status: item.status, ref: item.ref, sha: item.sha, webUrl: item.web_url, commit: null, jobs: [] }))
  }

  /** The jobs of one pipeline (stage order) plus the commit it ran for, which the jobs response carries. */
  async listPipelineJobs(project: string, pipelineId: number): Promise<{ jobs: JobRow[]; commit: CommitInfo | null }> {
    const data = await this.request<Array<{
      id: number
      name: string
      stage: string
      status: string
      duration: number | null
      web_url: string | null
      commit: { title: string; author_name: string | null } | null
    }>>(
      `/projects/${encodeURIComponent(project)}/pipelines/${String(pipelineId)}/jobs`,
    )
    // The API answers newest-first and exposes no stage-position field;
    // ascending id restores the execution order (later stages run later,
    // so their ids are higher) for a freshly run pipeline.
    const sorted = [...data].sort((left, right) => left.id - right.id)
    const first = sorted[0]
    return {
      jobs: sorted.map(item => ({
        id: item.id,
        name: item.name,
        stage: item.stage,
        status: item.status,
        durationSeconds: item.duration,
        webUrl: item.web_url,
      })),
      commit: first?.commit == null
        ? null
        : { title: first.commit.title, authorName: first.commit.author_name },
    }
  }

  /** Open merge requests, newest first, capped server-side. */
  async listMrs(project: string, perPage = 10): Promise<MrRow[]> {
    const data = await this.request<Array<{ iid: number; title: string; source_branch: string; target_branch: string; author: { name: string } | null; web_url: string | null }>>(
      `/projects/${encodeURIComponent(project)}/merge_requests?${new URLSearchParams({ state: 'opened', per_page: String(perPage) })}`,
    )
    return data.map(item => ({
      iid: item.iid,
      title: item.title,
      sourceBranch: item.source_branch,
      targetBranch: item.target_branch,
      author: item.author?.name ?? null,
      webUrl: item.web_url,
    }))
  }

  /** The project's default branch, when the API reports one. */
  async getDefaultBranch(project: string): Promise<string | null> {
    const data = await this.request<{ default_branch: string | null }>(`/projects/${encodeURIComponent(project)}`)
    return data.default_branch
  }

  /** The project's branch names, most recently active first, capped server-side. */
  async listBranches(project: string, perPage = 50): Promise<string[]> {
    const data = await this.request<Array<{ name: string }>>(
      `/projects/${encodeURIComponent(project)}/repository/branches?${new URLSearchParams({ per_page: String(perPage) })}`,
    )
    return data.map(item => item.name)
  }

  /** Create one merge request; returns its iid and web link. */
  async createMr(project: string, input: { sourceBranch: string; targetBranch: string; title: string }): Promise<{ iid: number; webUrl: string | null }> {
    const data = await this.request<{ iid: number; web_url: string | null }>(
      `/projects/${encodeURIComponent(project)}/merge_requests`,
      {
        method: 'POST',
        body: JSON.stringify({ source_branch: input.sourceBranch, target_branch: input.targetBranch, title: input.title }),
      },
    )
    return { iid: data.iid, webUrl: data.web_url }
  }

  /** Approve one MR. */
  async approveMr(project: string, iid: number): Promise<void> {
    await this.request<unknown>(`/projects/${encodeURIComponent(project)}/merge_requests/${String(iid)}/approve`, { method: 'POST' })
  }

  /** Close one open MR without merging. */
  async closeMr(project: string, iid: number): Promise<void> {
    await this.request<unknown>(`/projects/${encodeURIComponent(project)}/merge_requests/${String(iid)}`, {
      method: 'PUT',
      body: JSON.stringify({ state_event: 'close' }),
    })
  }

  /** Merge one MR. */
  async mergeMr(project: string, iid: number): Promise<void> {
    await this.request<unknown>(`/projects/${encodeURIComponent(project)}/merge_requests/${String(iid)}/merge`, { method: 'PUT' })
  }
}
