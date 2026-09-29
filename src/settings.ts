/**
 * The user-editable settings section of the GitLab surface: the token the
 * host uses for GitLab API access. The token carries the secret role, so
 * settings wires redact it and the browser never reads a stored token back.
 *
 * DSH 0.2.0 derives settings namespaces from profile entries and removed
 * `SettingsForms.register`, so this module no longer registers a namespace:
 * the section **is** the plugin's own `Config`, edited through the Web
 * settings panel and read from `apply(ctx, config)`.
 *
 * 🔴 The Cordis entry id must stay `gitlab` (see `GITLAB_ENTRY_ID` in
 * `index.ts`): 0.2.0's `settings.yaml` importer maps a legacy section name to
 * the owning entry id, so a `gitlab:` section in the old document lands in
 * this entry instead of being skipped with a warning.
 *
 * @module @lim324/dsh-gitlab/src/settings
 */

import z from '@deepseek-ai/schemastery'

/** One GitLab skill source: a group whose repositories are individual skills. */
export interface GitlabSkillSource {
  /** Unique source id, also the provider name and the checkout directory name. */
  id: string
  /** GitLab group path, e.g. `my-org/skills`. */
  group: string
  /** Instance API base URL; defaults to the plugin `baseUrl`. */
  baseUrl?: string
  /** Credential reference for this instance's token; defaults to the plugin `tokenEnv`. */
  tokenEnv?: string
  /** Branch or tag to check out. */
  ref?: string
  /** Discovery rank; lower ranks win duplicate skill names. */
  rank?: number
  /** Whether to include repositories from nested subgroups. */
  includeSubgroups?: boolean
}

/** Wire-safe skill-source schema, shared by the plugin config and the settings section. */
export const GitlabSkillSourceSchema = z.object({
  id: z.string(),
  group: z.string(),
  baseUrl: z.string(),
  tokenEnv: z.string().role('credential-ref'),
  ref: z.string().default('main'),
  rank: z.natural().default(250),
  includeSubgroups: z.boolean().default(true),
})

/**
 * The settings fields the Web panel owns — a projection of the plugin's
 * `Config`, kept as its own shape because the panel reads and writes them
 * independently of the boot-time config values.
 */
export interface GitlabSettings {
  /**
   * Default GitLab personal access token, used for every GitLab host a
   * workspace points at unless a `hostTokens` entry overrides it; unset
   * falls back to the credentials service, then the `GITLAB_TOKEN`
   * environment.
   */
  token?: string
  /**
   * Per-host token overrides, keyed by the workspace remote's host
   * (e.g. `gitlab.com` or `git.internal.example`). A matching entry wins
   * over {@link GitlabSettings.token} for that host only.
   */
  hostTokens?: Record<string, string>
  /**
   * Skill sources edited through the Web panel; when set, they override the
   * plugin config's `skillSources` so sources can change without a restart.
   */
  skillSources?: GitlabSkillSource[]
}

/** Wire-safe schema for the per-host token overrides; every value carries the secret role. */
export const GitlabHostTokensSchema = z.dict(z.string().role('secret'))
