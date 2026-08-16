# @lim324/dsh-gitlab

A DeepSeek Harness Web UI plugin: shows the GitLab CI/CD pipelines and merge requests of the repository behind the open session's workspace, with MR actions and per-host access-token management.

[中文](README.md)

## Features

- **GitLab tab** (in the conversation pane, beside Chat and Trajectory): automatically resolves the GitLab repository of the workspace the open session belongs to
- **Pipelines**: the latest five, expandable to a horizontal stage layout with job status/duration/links plus the commit title and author
- **Open MRs**: approve / merge / close buttons, and create-MR with source/target branch selectors and an optional title
- **Settings panel → GitLab page**: a default token plus per-host tokens; edits take effect live, no restart
- Poll-based refresh (default 30 s); on API failure the list is **cleared and an error banner is shown** — no stale data is kept

## Installation

```sh
# from npm
dsh plugin --profile web add @lim324/dsh-gitlab

# or from a local tarball
pnpm pack
dsh plugin --profile web add file:/path/to/lim324-dsh-gitlab-0.1.0.tgz
```

Requires platform capabilities: guard seats, the settings seam, and the Web settings panel (`dsh-host-webserver >= 0.1.0-rc.6`, `dsh-settings`, `dsh-client-ui-settings`, …; see `peerDependencies`).

## Configuration (optional; every field has a default)

`~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-gitlab
      name: '@lim324/dsh-gitlab'
      config:
        pollMs: 30000   # poll interval in ms (>= 5000)
        # project: group/proj        # pin one project, skipping workspace enumeration
        # baseUrl: https://git.internal.example/gitlab/api/v4  # non-standard API path
        # tokenEnv: GITLAB_TOKEN     # credential-ref / environment variable name (default GITLAB_TOKEN)
```

## Tokens

Resolution order (highest first):

1. the settings **per-host token** (exact match on the remote host, e.g. `gitlab.com`)
2. the settings **default token**
3. the plugin's `config.token`
4. the credentials file (`GITLAB_TOKEN` in `~/.dsh/.credentials.yaml`)
5. the `GITLAB_TOKEN` environment variable

Enter tokens on the **Settings → GitLab** page. The browser only ever sees whether a token is saved, never its value. Storage: the `gitlab` section of `~/.dsh/settings.yaml` (file mode 600, plaintext). Suggested PAT scope: `api` (`read_api` for read-only use).

## How the GitLab instance is discovered

1. `git remote get-url origin` is run in the workspace directory; the host and project path are parsed from it (https and ssh forms both work)
2. the host name must contain `gitlab` for the workspace to count as a GitLab repository (v1 heuristic)
3. the API base is `https://<host>/api/v4`; unusual deployments override it with `config.baseUrl`, and remote-less setups pin the project with `config.project`

## Usage

1. Open a session that belongs to a workspace, then pick the **GitLab** tab in the conversation pane
2. Expand pipelines to inspect jobs; approve / merge / close in the Open merge requests section, or create an MR with the branch selectors
3. Buttons carry in-flight states and results appear as toasts; lists refresh with the poller

## Security

- The data routes (`/gitlab/status`, `/gitlab/actions`, `/gitlab/settings`) sit behind the loopback trust fence and the web login session cookie
- Tokens are used host-side only; the browser only receives snapshots and the saved/unsaved flag

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run test      # REAL-composition tests with a fake GitLab API and settings service
pnpm run build     # tsc + tsdown (host and client bundles)
```

During development, types and runtime resolve through tsconfig `paths` / vitest aliases to a dsh checkout's build artifacts, so the Context / SlotMap declaration merging shares one physical copy of the platform types. These mappings only apply to this repository's own compilation and tests — nothing leaks into the published package, which is self-contained (the host bundle has no runtime dependencies beyond Node builtins; the client bundle depends only on platform seed modules).

## License

MIT
