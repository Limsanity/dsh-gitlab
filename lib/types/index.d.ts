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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type GitlabRemote, type MrRow, type PipelineRow } from './gitlab.ts';
import { type GitlabSkillSource } from './settings.ts';
export { GITLAB_SETTINGS_NAMESPACE, GitlabSettingsSchema, GitlabSkillSourceSchema, type GitlabSettings, type GitlabSkillSource } from './settings.ts';
/** Backward-compatible alias: a GitLab skill source (see {@link GitlabSkillSource}). */
export type SkillSource = GitlabSkillSource;
/** Stable Cordis plugin name. */
export declare const name = "dsh-gitlab";
/** Services required before the GitLab surface can mount. */
export declare const inject: string[];
/** Plugin config: GitLab access and polling cadence. */
export interface Config {
    /** GitLab personal access token; omit for read-only (pipeline and MR lists still work on public projects). The settings-section token overrides this. */
    token?: string;
    /** Explicit project path "group/project"; when set, workspace enumeration is skipped. */
    project?: string;
    /** API base URL override for self-managed instances; defaults to https://<remote-host>/api/v4. */
    baseUrl?: string;
    /** Snapshot poll interval in milliseconds. */
    pollMs?: number;
    /**
     * Environment variable naming the credential holding the GitLab token;
     * resolved through the credentials service with a process-environment
     * fallback. `token` overrides both.
     */
    tokenEnv?: string;
    /** GitLab skill sources, each a group whose repositories are individual skills. */
    skillSources?: SkillSource[];
    /** Local checkout root; each source clones its repositories under `<skillCloneRoot>/<id>/`. */
    skillCloneRoot?: string;
}
export declare const Config: z<Config>;
/** One workspace row in the wire snapshot. */
export interface WorkspaceStatus {
    workspaceId: string;
    title: string;
    /** Whether this workspace is a GitLab repository (or has an explicit project). */
    gitlab: boolean;
    /** The parsed remote when detection succeeded. */
    remote: GitlabRemote | null;
    /** The GitLab project path polled, when gitlab is true. */
    project: string | null;
    /** Whether a token is configured (write actions need one). */
    authed: boolean;
    /** The workspace checkout's current branch, when resolvable. */
    currentBranch: string | null;
    /** The GitLab project's default branch, when the API reports one. */
    defaultBranch: string | null;
    /** The project's branch names for the create-MR selectors. */
    branches: string[];
    /** Latest pipelines, newest first. */
    pipelines: PipelineRow[];
    /** Open merge requests, newest first. */
    mrs: MrRow[];
    /** Last poll failure message, when any. */
    error: string | null;
}
/** Test hook: tests substitute a fake fetch and git runners; production never touches this. */
export declare const internals: {
    fetchImpl?: typeof fetch;
    runGit?: (dir: string) => Promise<string>;
    runGitBranch?: (dir: string) => Promise<string>;
};
/**
 * Resolve the git origin remote of a directory; undefined when the directory
 * is not a git checkout or has no origin.
 * @param cwd - the directory to inspect.
 * @param run - the git runner (injected for tests).
 * @returns the parsed remote, or undefined.
 */
export declare function detectRemote(cwd: string, run?: (dir: string) => Promise<string>): Promise<GitlabRemote | undefined>;
/**
 * Resolve the currently checked-out branch of a directory; undefined when
 * the directory is not a git checkout (e.g. a detached HEAD).
 * @param dir - the workspace directory.
 * @param run - the git runner (injected for tests).
 * @returns the branch name, or undefined.
 */
export declare function detectCurrentBranch(dir: string, run?: (dir: string) => Promise<string>): Promise<string | undefined>;
/**
 * Mount the GitLab surface: workspace enumeration, remote detection, the
 * per-project polled rows, and the two fenced routes. Workspaces without a
 * GitLab remote still appear with `gitlab: false` so the client half can
 * render the not-a-GitLab state.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export declare function apply(ctx: Context, config: Config): void;
