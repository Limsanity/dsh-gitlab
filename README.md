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

## Token

来源优先级(从高到低):

1. settings 里的 **per-host token**(按 remote host 精确匹配,如 `gitlab.com`)
2. settings 里的**默认 token**
3. 插件 `config.token`
4. credentials 文件(`~/.dsh/.credentials.yaml` 里的 `GITLAB_TOKEN`)
5. 环境变量 `GITLAB_TOKEN`

在 **Settings → GitLab** 页面填写保存;浏览器只能看到"是否已保存",读不回 token 的值。存储位置:`~/.dsh/settings.yaml` 的 `gitlab` 段(文件权限 600,明文)。PAT 建议 scope:`api`(只读场景 `read_api` 即可)。

## GitLab 实例如何发现

1. 对 workspace 目录执行 `git remote get-url origin`,解析出 `host` 与 `project`(支持 https / ssh 两种形态)
2. host 名必须包含 `gitlab` 才视为 GitLab 仓库(v1 启发式)
3. API base 为 `https://<host>/api/v4`;非常规实例用 `config.baseUrl` 覆盖;无 git remote 的场景用 `config.project` 固定项目

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
