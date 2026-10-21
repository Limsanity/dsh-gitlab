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
 * Parse a git origin URL into host and project, for the three shapes git
 * produces: `https://host/group/project.git`, `git@host:group/project.git`,
 * and `ssh://git@host:port/group/project.git`. The host never carries the
 * port: an ssh port is meaningless to the HTTPS API, and https remotes with
 * explicit ports are rare enough to leave to `config.baseUrl`.
 * @param url - the raw `git remote get-url origin` output.
 * @returns the parsed remote, or undefined for non-origin shapes.
 */
export function parseGitRemote(url: string): GitlabRemote | undefined {
  let host: string
  let rest: string
  const https = /^https?:\/\/([^/]+)\/(.+)$/.exec(url.trim())
  if (https !== null) {
    host = https[1]!
    rest = https[2]!
  } else {
    const sshUrl = /^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(url.trim())
    const scp = /^git@([^:]+):(.+)$/.exec(url.trim())
    const ssh = sshUrl ?? scp
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

/** One merge request's reviewable detail row. */
export interface MrDetailRow {
  iid: number
  title: string
  state: string
  webUrl: string | null
  sourceBranch: string
  targetBranch: string
  author: { name: string | null; username: string | null }
  hasConflicts: boolean
  /** GitLab 15.6+ mergeability verdict; null on older instances. */
  detailedMergeStatus: string | null
  /** Legacy verdict kept for instances without `detailed_merge_status`. */
  mergeStatus: string | null
  /** `changes_count` is a string: the API may answer `"1000+"` when truncated. */
  changesCount: string | null
  sha: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** One commit of a merge request. */
export interface MrCommitRow {
  id: string
  shortId: string
  title: string
  authorName: string | null
  authorEmail: string | null
  authoredDate: string | null
  /** More than one parent marks a merge commit, which the release gate rejects. */
  parentCount: number
  /**
   * Whether this looks like a merge commit. GitLab 16.11 returns an empty
   * `parent_ids` for MR commits, so the conventional merge title is the
   * remaining signal; a real multi-parent commit always sets it too.
   */
  mergeSuspect: boolean
  webUrl: string | null
}

/** One changed file of a merge request or one commit. */
export interface MrDiffRow {
  path: string
  oldPath: string | null
  newFile: boolean
  deletedFile: boolean
  renamedFile: boolean
  /** Unified patch; null when the API omitted it (binary, generated or oversized). */
  patch: string | null
}

/** A GitLab REST failure carrying the HTTP status the routes translate. */
export class GitlabHttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'GitlabHttpError'
    this.status = status
  }
}

/** One project row in a group listing, reduced to what skill discovery needs. */
export interface GroupProjectRow {
  /** Project basename, e.g. `skill-foo`. */
  name: string
  /** Project path within its namespace, e.g. `group/subgroup/skill-foo`. */
  pathWithNamespace: string
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
    if (!res.ok) throw new GitlabHttpError(res.status, `GitLab API ${String(res.status)} for ${path}`)
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

  /** List the projects of one group, optionally including nested subgroups. */
  async listGroupProjects(group: string, includeSubgroups = true, perPage = 100): Promise<GroupProjectRow[]> {
    const params = new URLSearchParams({ per_page: String(perPage), include_subgroups: String(includeSubgroups), simple: 'true' })
    const data = await this.request<Array<{ name: string; path_with_namespace: string }>>(
      `/groups/${encodeURIComponent(group)}/projects?${params.toString()}`,
    )
    return data.map(item => ({ name: item.name, pathWithNamespace: item.path_with_namespace }))
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

  /** One merge request's review metadata. */
  async getMr(project: string, iid: number): Promise<MrDetailRow> {
    const data = await this.request<{
      iid: number
      title: string
      state: string
      web_url: string | null
      source_branch: string
      target_branch: string
      author: { name?: string | null; username?: string | null } | null
      has_conflicts?: boolean | null
      detailed_merge_status?: string | null
      merge_status?: string | null
      changes_count?: string | number | null
      sha?: string | null
      created_at?: string | null
      updated_at?: string | null
    }>(`/projects/${encodeURIComponent(project)}/merge_requests/${String(iid)}`)
    return {
      iid: data.iid,
      title: data.title,
      state: data.state,
      webUrl: data.web_url,
      sourceBranch: data.source_branch,
      targetBranch: data.target_branch,
      author: { name: data.author?.name ?? null, username: data.author?.username ?? null },
      hasConflicts: data.has_conflicts === true,
      detailedMergeStatus: data.detailed_merge_status ?? null,
      mergeStatus: data.merge_status ?? null,
      changesCount: data.changes_count === undefined || data.changes_count === null ? null : String(data.changes_count),
      sha: data.sha ?? null,
      createdAt: data.created_at ?? null,
      updatedAt: data.updated_at ?? null,
    }
  }

  /** A merge request's commits, oldest first as GitLab returns them. */
  async listMrCommits(project: string, iid: number, perPage = 100): Promise<{ commits: MrCommitRow[]; hasMore: boolean }> {
    const data = await this.request<Array<{
      id: string
      short_id?: string | null
      title: string
      author_name?: string | null
      author_email?: string | null
      authored_date?: string | null
      parent_ids?: string[] | null
      web_url?: string | null
    }>>(`/projects/${encodeURIComponent(project)}/merge_requests/${String(iid)}/commits?${new URLSearchParams({ per_page: String(perPage) })}`)
    return {
      commits: data.map(item => {
        const parentCount = Array.isArray(item.parent_ids) ? item.parent_ids.length : 0
        return {
          id: item.id,
          shortId: item.short_id ?? item.id.slice(0, 8),
          title: item.title,
          authorName: item.author_name ?? null,
          authorEmail: item.author_email ?? null,
          authoredDate: item.authored_date ?? null,
          parentCount,
          mergeSuspect: parentCount > 1 || /^Merge (?:branch|remote-tracking branch|pull request|tag|commit)\b/i.test(item.title),
          webUrl: item.web_url ?? null,
        }
      }),
      hasMore: data.length >= perPage,
    }
  }

  /**
   * A merge request's changed files, one page at a time.
   *
   * GitLab 15.7+ serves `/diffs` with pagination; older instances answer 404
   * and only expose the single-response `/changes` endpoint. Both carry the
   * unified patch, so callers get the same shape either way.
   */
  async listMrDiffs(project: string, iid: number, page = 1, perPage = 100): Promise<{ diffs: MrDiffRow[]; hasMore: boolean; overflow: boolean }> {
    const base = `/projects/${encodeURIComponent(project)}/merge_requests/${String(iid)}`
    try {
      const data = await this.request<RawDiff[]>(`${base}/diffs?${new URLSearchParams({ page: String(page), per_page: String(perPage) })}`)
      return { diffs: data.map(mapDiff), hasMore: data.length >= perPage, overflow: false }
    } catch (error) {
      if (!isDiffsDowngrade(error)) throw error
      try {
        // GitLab (notably the 16.11 JH line) answers 500 when one page's diff
        // payload is too large; the single-response endpoint still works and
        // is the reliable fallback there.
        const data = await this.request<{ changes?: RawDiff[]; overflow?: boolean }>(`${base}/changes`)
        const rows = (data.changes ?? []).map(mapDiff)
        return { diffs: rows.slice(0, 300), hasMore: rows.length > 300, overflow: data.overflow === true }
      } catch (fallbackError) {
        if (!isDiffsDowngrade(fallbackError)) throw fallbackError
        // Last resort: a page small enough for the instance's byte budget.
        const data = await this.request<RawDiff[]>(`${base}/diffs?${new URLSearchParams({ page: '1', per_page: '30' })}`)
        return { diffs: data.map(mapDiff), hasMore: data.length >= 30, overflow: false }
      }
    }
  }

  /** The files one commit touched, without their patches. */
  async listCommitDiffs(project: string, sha: string): Promise<MrDiffRow[]> {
    const data = await this.request<RawDiff[]>(
      `/projects/${encodeURIComponent(project)}/repository/commits/${encodeURIComponent(sha)}/diff`,
    )
    return data.map(mapDiff)
  }
}

/** One raw GitLab diff entry shared by the MR and commit endpoints. */
interface RawDiff {
  old_path?: string
  new_path?: string
  new_file?: boolean
  deleted_file?: boolean
  renamed_file?: boolean
  diff?: string
}

/** Statuses that mean "this page size/endpoint is unusable here", not "auth failed". */
function isDiffsDowngrade(error: unknown): boolean {
  return error instanceof GitlabHttpError && [404, 405, 500, 501, 502, 503].includes(error.status)
}

/** Project one raw diff entry without inventing a path the API did not report. */
function mapDiff(raw: RawDiff): MrDiffRow {
  const path = raw.new_path ?? raw.old_path ?? ''
  const oldPath = raw.old_path === undefined || raw.old_path === path ? null : raw.old_path
  return {
    path,
    oldPath,
    newFile: raw.new_file === true,
    deletedFile: raw.deleted_file === true,
    renamedFile: raw.renamed_file === true,
    patch: typeof raw.diff === 'string' ? raw.diff : null,
  }
}
