# @lim324/dsh-gitlab

DeepSeek Harness 的 Web UI 插件:在会话面板展示当前工作区对应 GitLab 仓库的 CI/CD pipeline 与 MR,支持 MR 操作,以及按 host 的访问 token 管理。

## 功能

- **GitLab tab**(conversation 面板,与 Chat / Trajectory 并列):自动定位当前 session 所属 workspace 的 GitLab 仓库
- **Pipelines**:最近 5 条,展开显示 stage 横向布局、job 状态/耗时/链接、commit 标题与作者
- **Open MRs**:approve / merge / close 按钮,create MR(源/目标分支下拉可选,标题可填)
- **Settings 面板 → GitLab 页**:默认 token + 按 host 的 token 管理,保存后热生效,无需重启
- 轮询刷新(默认 30s);API 失败时**清空列表并显示错误横幅**——不保留旧数据

## 安装

```sh
# 从 npm
dsh plugin --profile web add @lim324/dsh-gitlab

# 或从本地 tarball
pnpm pack
dsh plugin --profile web add file:/path/to/lim324-dsh-gitlab-0.1.0.tgz
```

依赖平台能力:guard seat、settings seam、Web 设置面板(`dsh-host-webserver >= 0.1.0-rc.6`、`dsh-settings`、`dsh-client-ui-settings` 等,见 `peerDependencies`)。

## 配置(可选,均有默认值)

`~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-gitlab
      name: '@lim324/dsh-gitlab'
      config:
        pollMs: 30000   # 轮询间隔 ms(>= 5000)
        # project: group/proj        # 显式固定项目,跳过 workspace 枚举
        # baseUrl: https://git.internal.example/gitlab/api/v4  # 非标准 API 路径
        # tokenEnv: GITLAB_TOKEN     # credential-ref / 环境变量名(默认 GITLAB_TOKEN)
```

## GitLab Skill 同步

`dsh-gitlab` 可以把一个 GitLab group 下的仓库当作 skill 来源:**每个仓库 = 一个 skill**(`SKILL.md` 在仓库根)。启动时把 group 下的仓库 clone 到本地,并注册进 skill seam;之后 skill 的 `list()` 直接读本地,无需网络、离线可用。

### 配置

`skillSources` 是一个列表,每项是「一个实例上的一个 group」:

| 字段 | 默认 | 说明 |
|---|---|---|
| `id` | — | 源唯一 id,也是 provider 名(`gitlab:<id>`)与本地目录名 |
| `group` | — | GitLab group 路径,如 `my-org/skills` |
| `baseUrl` | 全局 `baseUrl` | 该实例 API 地址;不写则用插件全局 baseUrl |
| `tokenEnv` | 全局 `tokenEnv` | 该实例 token 凭证;不写则用全局 `GITLAB_TOKEN` |
| `ref` | `main` | 检出分支 |
| `rank` | `250` | 发现优先级,越小越优先 |
| `includeSubgroups` | `true` | 是否包含嵌套子 group |

```yaml
skillSources:
  # 同一个实例上的多个 group（baseUrl / tokenEnv 留空 = 继承全局配置）
  - { id: core, group: my-org/core-skills, rank: 200 }
  - { id: team, group: my-org/team-skills, rank: 250 }
  # 另一个实例，独立 token
  - { id: internal, group: eng/skills, baseUrl: https://gitlab.internal.example/api/v4, tokenEnv: GITLAB_INTERNAL_TOKEN }
skillCloneRoot: ~/.dsh/skills-gitlab   # 可选，默认 <DSH_HOME>/skills-gitlab（DSH_HOME 未设置时为 ~/.dsh/skills-gitlab）
```

### 本地结构与发现

```
<DSH_HOME>/skills-gitlab/          # DSH_HOME 未设置时即 ~/.dsh/skills-gitlab
  core/
    skill-a/SKILL.md    # group 里的仓库 skill-a
    skill-b/SKILL.md
  team/
    skill-c/SKILL.md
```

- 每个仓库 clone 到 `<skillCloneRoot>/<id>/<仓库名>/`；
- skill 目录字段来自 `SKILL.md` 的 frontmatter：`name` / `description` / `whenToUse` / `disable-model-invocation` / `user-invocable`；
- skill 名来自 frontmatter `name`，可与仓库名不同；跨源同名按 `rank` 去重（同 rank 按 provider 顺序）。

### 同步行为

- 启动时自动 clone 缺失的仓库、`git pull` 已存在的（浅 clone，`--depth 1`）；同步完成后失效一次目录，避免首次查询看到空目录；
- 失败 best-effort：某个仓库/源拉不到不阻塞启动，provider 读到什么算什么；
- token 内嵌在 checkout 的 origin URL 里（与 `settings.yaml` 里的 token 同级暴露，本地目录不外发），`pull`/`push` 直接可用；
- 依赖 `git` 二进制；token 需要 `read_repository`（写回需 `write_repository`）权限。

### Host 路由

| 路由 | 说明 |
|---|---|
| `GET /gitlab/skills/status` | 列出每个源的仓库及是否已拉取到本地 |
| `POST /gitlab/skills/pull` | 手动重拉。body `{ "sourceId": "<id>" }` 拉单个源，空 body 拉全部 |
| `POST /gitlab/skills/save` | 写回某个已检出 skill 的 `SKILL.md`。body `{ "sourceId", "repo", "content", "message?" }`，commit + push |
| `POST /gitlab/skills/remove` | 只删除本地 checkout，不碰远程仓库。body `{ "sourceId", "repo" }` |

路由均在 loopback trust fence 内、受 web 登录会话 cookie 保护（与 `/gitlab/status`、`/gitlab/actions` 相同）。对应的 UI 在 **Settings → GitLab Skills** 页。

### 模型工具

agent 可以直接调用以下工具（与 UI 等价）：

| 工具 | 说明 |
|---|---|
| `gitlab_skill_pull` | 同步一个源（`sourceId` 可选，缺省全部） |
| `gitlab_skill_save` | 写回某个 skill 的 `SKILL.md` 并 commit + push（**需审批**） |
| `gitlab_skill_remove` | 只删除本地 checkout，不碰远程仓库 |

## Token

来源优先级(从高到低):

1. settings 里的 **per-host token**(按 remote host 精确匹配,如 `gitlab.com`)
2. settings 里的**默认 token**
3. 插件 `config.token`
4. credentials 文件(`~/.dsh/.credentials.yaml` 里的 `GITLAB_TOKEN`)
5. 环境变量 `GITLAB_TOKEN`

在 **Settings → GitLab** 页面填写保存;浏览器只能看到"是否已保存",读不回 token 的值。存储位置:`~/.dsh/settings.yaml` 的 `gitlab` 段(文件权限 600,明文)。PAT 建议 scope:`api`(只读场景 `read_api` 即可)。

## GitLab 实例如何发现

1. 对 workspace 目录执行 `git remote get-url origin`,解析出 `host` 与 `project`(支持 `https://…`、`git@host:path`、`ssh://git@host:port/path` 三种形态;ssh 端口会被剥离,不会带进 API base)
2. 向 `https://<host>/api/v4/version` 发一次匿名探测:返回 200(带 `version` 字段)或 401(端点存在但要求认证)即判定为 GitLab 实例,**不依赖 host 名**
3. API base 为 `https://<host>/api/v4`;非常规实例用 `config.baseUrl` 覆盖(设置了 baseUrl 则跳过探测);无 git remote 的场景用 `config.project` 固定项目

## 使用

1. 打开属于某个 workspace 的 session → conversation 面板选择 **GitLab** tab
2. 展开 pipeline 查看 job;在 Open merge requests 区直接 approve / merge / close,或用分支下拉创建 MR
3. 按钮有 in-flight 状态,操作结果以 Toast 提示;列表随轮询自动更新

## 安全

- 数据路由(`/gitlab/status`、`/gitlab/actions`、`/gitlab/settings`)均在 loopback trust fence 内,并受 web 登录会话 cookie 保护
- token 只在 host 侧使用;浏览器只拿到快照和"是否已设置"

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm run test      # REAL-composition 测试,含 fake GitLab API 与 settings 服务
pnpm run build     # tsc + tsdown(host/client 两个 bundle)
```

dev 期类型与运行时通过 tsconfig `paths` / vitest alias 指向一份 dsh checkout 的构建产物——保证 Context / SlotMap 的声明合并共享同一份类型。这些映射只作用于本仓库编译与测试,不进发布产物;发布包自包含(host 运行时零外部依赖,client 只依赖平台 seed 模块)。

## License

MIT
