/**
 * The user-editable settings section of the GitLab surface: the token the
 * host uses for GitLab API access. Registered under the `gitlab` settings
 * namespace, so the Web settings panel can edit it without a restart and the
 * host half re-tokenizes its live API clients on the update. The token
 * carries the secret role, so settings wires redact it and the browser never
 * reads a stored token back.
 * @module @lim324/dsh-gitlab/src/settings
 */

import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** The settings namespace owning the GitLab surface's user section. */
export const GITLAB_SETTINGS_NAMESPACE = settingsNamespace('gitlab')

/** The user-editable GitLab settings section. */
export interface GitlabSettings {
  /**
   * Default GitLab personal access token, used for every GitLab host a
   * workspace points at unless a `hostTokens` entry overrides it; unset
   * falls back to the plugin config, then the credentials service, then the
   * `GITLAB_TOKEN` environment.
   */
  token?: string
  /**
   * Per-host token overrides, keyed by the workspace remote's host
   * (e.g. `gitlab.com` or `git.internal.example`). A matching entry wins
   * over {@link GitlabSettings.token} for that host only.
   */
  hostTokens?: Record<string, string>
}

/** Wire-safe schema: every token carries the secret role, so settings wires redact them. */
export const GitlabSettingsSchema: z<GitlabSettings> = z.object({
  token: z.string().role('secret'),
  hostTokens: z.dict(z.string().role('secret')),
})
