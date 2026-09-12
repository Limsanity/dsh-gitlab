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
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name (client half). */
export declare const name = "dsh-gitlab";
/** Client services required before the tab can mount. */
export declare const inject: string[];
/** The host status row wire shape (mirrors the host half). */
export interface WorkspaceStatus {
    workspaceId: string;
    title: string;
    gitlab: boolean;
    remote: {
        host: string;
        project: string;
    } | null;
    project: string | null;
    authed: boolean;
    currentBranch: string | null;
    defaultBranch: string | null;
    branches: string[];
    pipelines: Array<{
        id: number;
        status: string;
        ref: string;
        sha: string;
        webUrl: string | null;
        commit: {
            title: string;
            authorName: string | null;
        } | null;
        jobs: Array<{
            id: number;
            name: string;
            stage: string;
            status: string;
            durationSeconds: number | null;
            webUrl: string | null;
        }>;
    }>;
    mrs: Array<{
        iid: number;
        title: string;
        sourceBranch: string;
        targetBranch: string;
        author: string | null;
        webUrl: string | null;
    }>;
    error: string | null;
}
/** One workspace projection from the workspaces feed. */
export interface WorkspaceProjection {
    workspaceId: string;
    title: string;
    sessionIds: readonly string[];
}
/**
 * Resolve the workspace a session belongs to: the first workspace whose
 * sessionIds contain the session. Undefined when the session belongs to no
 * workspace.
 * @param sessionId - the open session.
 * @param workspaces - the workspaces feed rows.
 * @returns the owning workspace id, or undefined.
 */
export declare function findWorkspaceId(sessionId: string | undefined, workspaces: readonly WorkspaceProjection[]): string | undefined;
/**
 * Mount the GitLab tab into the conversation view ring, beside Chat and
 * Trajectory. The tab appears whenever a session is open.
 * @param ctx - client context carrying the slot registry.
 */
export declare function apply(ctx: Context): void;
