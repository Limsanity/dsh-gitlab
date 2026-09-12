/**
 * The user-editable settings section of the GitLab surface: the token the
 * host uses for GitLab API access. Registered under the `gitlab` settings
 * namespace, so the Web settings panel can edit it without a restart and the
 * host half re-tokenizes its live API clients on the update. The token
 * carries the secret role, so settings wires redact it and the browser never
 * reads a stored token back.
 * @module @lim324/dsh-gitlab/src/settings
 */
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
/**
 * The settings namespace owning the GitLab surface's user section.
 *
 * The `settingsNamespace()` runtime helper was removed upstream in DSH 0.1.2-alpha
 * (`refactor(services): move shared values behind service APIs`); the namespace
 * string is now validated by `SettingsProvider.register` through the type-level
 * `SettingsNamespaceInput`. The literal stays the same, so stored sections are
 * unaffected.
 */
export declare const GITLAB_SETTINGS_NAMESPACE: SettingsNamespace;
/** One GitLab skill source: a group whose repositories are individual skills. */
export interface GitlabSkillSource {
    /** Unique source id, also the provider name and the checkout directory name. */
    id: string;
    /** GitLab group path, e.g. `my-org/skills`. */
    group: string;
    /** Instance API base URL; defaults to the plugin `baseUrl`. */
    baseUrl?: string;
    /** Credential reference for this instance's token; defaults to the plugin `tokenEnv`. */
    tokenEnv?: string;
    /** Branch or tag to check out. */
    ref?: string;
    /** Discovery rank; lower ranks win duplicate skill names. */
    rank?: number;
    /** Whether to include repositories from nested subgroups. */
    includeSubgroups?: boolean;
}
/** Wire-safe skill-source schema, shared by the plugin config and the settings section. */
export declare const GitlabSkillSourceSchema: z<Schemastery.ObjectS<{
    id: z<string, string>;
    group: z<string, string>;
    baseUrl: z<string, string>;
    tokenEnv: z<string, string>;
    ref: z<string, string>;
    rank: z<number, number>;
    includeSubgroups: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    id: z<string, string>;
    group: z<string, string>;
    baseUrl: z<string, string>;
    tokenEnv: z<string, string>;
    ref: z<string, string>;
    rank: z<number, number>;
    includeSubgroups: z<boolean, boolean>;
}>>;
/** The user-editable GitLab settings section. */
export interface GitlabSettings {
    /**
     * Default GitLab personal access token, used for every GitLab host a
     * workspace points at unless a `hostTokens` entry overrides it; unset
     * falls back to the plugin config, then the credentials service, then the
     * `GITLAB_TOKEN` environment.
     */
    token?: string;
    /**
     * Per-host token overrides, keyed by the workspace remote's host
     * (e.g. `gitlab.com` or `git.internal.example`). A matching entry wins
     * over {@link GitlabSettings.token} for that host only.
     */
    hostTokens?: Record<string, string>;
    /**
     * Skill sources edited through the Web panel; when set, they override the
     * plugin config's `skillSources` so sources can change without a restart.
     */
    skillSources?: GitlabSkillSource[];
}
/** Wire-safe schema: every token carries the secret role, so settings wires redact them. */
export declare const GitlabSettingsSchema: z<GitlabSettings>;
