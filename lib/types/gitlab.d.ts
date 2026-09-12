/**
 * Minimal GitLab REST API client plus git-remote parsing for the host half.
 * Purpose-built for the pipeline/MR surface: list pipelines, list open MRs,
 * approve, merge. The token travels only in the private-token header.
 * @module @lim324/dsh-gitlab/src/gitlab
 */
/** One parsed GitLab repository remote. */
export interface GitlabRemote {
    /** Remote host, e.g. gitlab.com. */
    host: string;
    /** Project path without the .git suffix, e.g. group/sub/project. */
    project: string;
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
export declare function parseGitRemote(url: string): GitlabRemote | undefined;
/** One job row inside a pipeline. */
export interface JobRow {
    id: number;
    name: string;
    stage: string;
    status: string;
    durationSeconds: number | null;
    webUrl: string | null;
}
/** The commit a pipeline ran for (carried by the jobs response). */
export interface CommitInfo {
    title: string;
    authorName: string | null;
}
/** One pipeline row for the status snapshot, with its jobs and commit attached. */
export interface PipelineRow {
    id: number;
    status: string;
    ref: string;
    sha: string;
    webUrl: string | null;
    commit: CommitInfo | null;
    jobs: JobRow[];
}
/** One merge request row for the status snapshot. */
export interface MrRow {
    iid: number;
    title: string;
    sourceBranch: string;
    targetBranch: string;
    author: string | null;
    webUrl: string | null;
}
/** One project row in a group listing, reduced to what skill discovery needs. */
export interface GroupProjectRow {
    /** Project basename, e.g. `skill-foo`. */
    name: string;
    /** Project path within its namespace, e.g. `group/subgroup/skill-foo`. */
    pathWithNamespace: string;
}
/** Client options; fetchImpl injection keeps the client testable. */
export interface GitlabApiOptions {
    baseUrl: string;
    token?: string;
    /**
     * Lazily resolved per request and per `hasToken()` probe, winning over
     * `token` when present. The host passes one so a settings-section edit
     * re-tokenizes live clients without reconstructing them.
     */
    tokenProvider?: () => string | undefined;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}
/**
 * Thin GitLab REST v4 client over injectable fetch: bearer-style private
 * token header, a per-request timeout, and typed projections for the four
 * calls the UI surface needs.
 */
export declare class GitlabApi {
    private readonly baseUrl;
    private readonly token;
    private readonly tokenProvider;
    private readonly fetchImpl;
    private readonly timeoutMs;
    constructor(options: GitlabApiOptions);
    /** The token the next request will send: the live provider first, then the static option. */
    private currentToken;
    /** Whether a token is configured (write operations need one). */
    hasToken(): boolean;
    private request;
    /** Latest pipelines, newest first, capped server-side. */
    listPipelines(project: string, perPage?: number): Promise<PipelineRow[]>;
    /** The jobs of one pipeline (stage order) plus the commit it ran for, which the jobs response carries. */
    listPipelineJobs(project: string, pipelineId: number): Promise<{
        jobs: JobRow[];
        commit: CommitInfo | null;
    }>;
    /** Open merge requests, newest first, capped server-side. */
    listMrs(project: string, perPage?: number): Promise<MrRow[]>;
    /** The project's default branch, when the API reports one. */
    getDefaultBranch(project: string): Promise<string | null>;
    /** The project's branch names, most recently active first, capped server-side. */
    listBranches(project: string, perPage?: number): Promise<string[]>;
    /** List the projects of one group, optionally including nested subgroups. */
    listGroupProjects(group: string, includeSubgroups?: boolean, perPage?: number): Promise<GroupProjectRow[]>;
    /** Create one merge request; returns its iid and web link. */
    createMr(project: string, input: {
        sourceBranch: string;
        targetBranch: string;
        title: string;
    }): Promise<{
        iid: number;
        webUrl: string | null;
    }>;
    /** Approve one MR. */
    approveMr(project: string, iid: number): Promise<void>;
    /** Close one open MR without merging. */
    closeMr(project: string, iid: number): Promise<void>;
    /** Merge one MR. */
    mergeMr(project: string, iid: number): Promise<void>;
}
