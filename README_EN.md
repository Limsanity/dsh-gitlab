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

## GitLab skill sync

`dsh-gitlab` can treat the repositories under a GitLab group as skill sources: **one repository = one skill** (`SKILL.md` at the repository root). On boot it clones the group's repositories locally and registers them with the skill seam; skill `list()` then reads the local checkout directly, with no network round-trips and offline capability.

### Configuration

`skillSources` is a list, each entry being one group on one instance:

| Field | Default | Meaning |
|---|---|---|
| `id` | — | unique source id, also the provider name (`gitlab:<id>`) and the checkout directory name |
| `group` | — | GitLab group path, e.g. `my-org/skills` |
| `baseUrl` | plugin `baseUrl` | this instance's API base; omit to inherit the plugin's global `baseUrl` |
| `tokenEnv` | plugin `tokenEnv` | this instance's token credential; omit to inherit the global `GITLAB_TOKEN` |
| `ref` | `main` | branch to check out |
| `rank` | `250` | discovery rank, lower wins |
| `includeSubgroups` | `true` | whether to include nested subgroups |

```yaml
skillSources:
  # several groups on the same instance (baseUrl / tokenEnv left empty = inherit the global config)
  - { id: core, group: my-org/core-skills, rank: 200 }
  - { id: team, group: my-org/team-skills, rank: 250 }
  # another instance with its own token
  - { id: internal, group: eng/skills, baseUrl: https://gitlab.internal.example/api/v4, tokenEnv: GITLAB_INTERNAL_TOKEN }
skillCloneRoot: ~/.dsh/skills-gitlab   # optional, defaults to ~/.dsh/skills-gitlab
```

### Local layout and discovery

```
~/.dsh/skills-gitlab/
  core/
    skill-a/SKILL.md    # the skill-a repository under the group
    skill-b/SKILL.md
  team/
    skill-c/SKILL.md
```

- each repository is cloned to `<skillCloneRoot>/<id>/<repo name>/`;
- catalog fields come from the `SKILL.md` frontmatter: `name` / `description` / `whenToUse` / `disable-model-invocation` / `user-invocable`;
- the skill name is the frontmatter `name` (it may differ from the repository name); cross-source duplicates resolve by `rank` (then provider order).

### Sync behavior

- on boot it clones missing repositories and `git pull`s existing ones (shallow clone, `--depth 1`), then invalidates the catalog once so a first query never observes an empty directory;
- failures are best-effort: an unreachable repository or source never blocks boot, and the provider serves whatever is on disk;
- the token rides in the checkout's origin URL (the same exposure class as the token already stored in `settings.yaml`; the local directory is never shared), so `pull`/`push` authenticate directly;
- requires the `git` binary; the token needs `read_repository` (`write_repository` for write-back).

### Host routes

| Route | Meaning |
|---|---|
| `GET /gitlab/skills/status` | lists each source's repositories and whether each is pulled locally |
| `POST /gitlab/skills/pull` | manual re-sync. body `{ "sourceId": "<id>" }` pulls one source, an empty body pulls all |
| `POST /gitlab/skills/save` | write back one checked-out skill's `SKILL.md`. body `{ "sourceId", "repo", "content", "message?" }`, then commit + push |
| `POST /gitlab/skills/remove` | deletes only the local checkout, never the remote repository. body `{ "sourceId", "repo" }` |

Routes sit behind the loopback trust fence and the web login session cookie (same as `/gitlab/status` and `/gitlab/actions`); the matching UI lives on the **Settings → GitLab Skills** page.

## Tokens

Resolution order (highest first):

1. the settings **per-host token** (exact match on the remote host, e.g. `gitlab.com`)
2. the settings **default token**
3. the plugin's `config.token`
4. the credentials file (`GITLAB_TOKEN` in `~/.dsh/.credentials.yaml`)
5. the `GITLAB_TOKEN` environment variable

Enter tokens on the **Settings → GitLab** page. The browser only ever sees whether a token is saved, never its value. Storage: the `gitlab` section of `~/.dsh/settings.yaml` (file mode 600, plaintext). Suggested PAT scope: `api` (`read_api` for read-only use).

## How the GitLab instance is discovered

1. `git remote get-url origin` is run in the workspace directory; the host and project path are parsed from it (`https://…`, `git@host:path`, and `ssh://git@host:port/path` all work; the ssh port is stripped and never reaches the API base)
2. an anonymous probe of `https://<host>/api/v4/version` decides the verdict: a 200 with a `version` field, or a 401 (the endpoint exists but demands authentication), marks the host as a GitLab instance — **the host name itself is not consulted**
3. the API base is `https://<host>/api/v4`; unusual deployments override it with `config.baseUrl` (which also skips the probe), and remote-less setups pin the project with `config.project`

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
