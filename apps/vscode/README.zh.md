# @deepseek-ai/dsh-vscode

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 VSCode 插件：把 harness 作为子进程启动，并把会话呈现为编辑器标签页——就像 Claude Code 插件之于 Claude Code。

## 本里程碑交付

- **会话标签页。** 每个会话是一个 `WebviewPanel` 编辑器标签页（可多开、可拖拽、窗口重载后恢复）。活动栏会话树可打开会话；`Cmd+N` 新建会话，`Cmd+Shift+T` 重开最近关闭的会话。
- **装配后的 web 客户端。** 每个面板启动 harness 客户端 UI——流式聊天、工具卡片、plan、用户提问、权限——由精选的客户端 bundle 集在面板渲染时组装为启动图。webview 从不直接对子进程发起 HTTP：所有请求经 postMessage MessagePort 载体中继到扩展宿主。
- **diff 应用与审查。** 每个 `edit`/`write` 调用的 diff 卡带 Apply 与 Reveal 按钮。Apply 经工作区 API 把变更同步进你的编辑器；Reveal 打开旧→新预览。每个呈现的变更同时登记为待定：编辑器标题菜单为该文件显示 Accept Change / Reject Change，其中 Reject 把它恢复为编辑前内容。动作在扩展宿主执行——绝不经过 harness 子进程。
- **权限模式（Automode）。** 状态栏显示当前权限模式——Manual（`read-only`）、Auto（`workspace-write`）或 Full Access（`danger-full-access`）——并作为可点击徽标：点击在 Auto/Manual 间切换，`dsh.setPermissionMode` 任选其一，每次切换都设置新会话默认并经 harness 的 `/permission` 命令应用到所有打开的会话。`dsh.stopSession` 中断当前会话。初始模式来自 `dsh.initialPermissionMode`。
- **IDE 上下文。** 扩展宿主把工作区、活动编辑器与选区的防抖快照写入 `$DSH_HOME/vscode/context.json`；子进程的 `vscode` profile 把它注入每回合的第一个请求。
- **Claude Code 钩子兼容。** `vscode` profile 以工作区根挂载 `hooks-claude-code`，因此工作区的 `.claude/settings.json` 钩子生效——与 Claude Code 读取的是同一个文件。子进程以工作区根为启动 cwd。
- **免 key 开发夹具。** 测试与快照在浏览器内 fixture 宿主上启动面板；真实子进程路径经 `dsh.setApiKey` 运行。

## 配置

| 设置 | 默认值 | 含义 |
|---|---|---|
| `dsh.command` | `dsh` | 子进程命令：PATH 上的 `dsh` bin，或已构建 bin 的绝对路径 |
| `dsh.profile` | `vscode` | 子进程启动的 profile（`vscode` 增加 IDE 上下文与 CC 钩子；`web` 为纯浏览器表面） |
| `dsh.node` | （空） | 设置后，子进程命令经此 Node 可执行文件启动 |
| `dsh.home` | （空） | 子进程的 `DSH_HOME`；为空则继承默认值 |
| `dsh.spawnTimeoutMs` | `30000` | 等待子进程 ready 行的毫秒数 |
| `dsh.extraEnv` | `{}` | 额外的子进程环境变量，如 `DEEPSEEK_BASE_URL` |
| `dsh.enableNewConversationShortcut` | `false` | dsh 视图聚焦时用 Cmd/Ctrl+N 新建会话 |
| `dsh.enableReopenClosedSessionShortcut` | `true` | 用 Cmd/Ctrl+Shift+T 重开最近关闭的会话 |
| `dsh.preferredLocation` | `tab` | dsh 会话的打开位置 |
| `dsh.initialPermissionMode` | `manual` | 子进程启动的权限模式：`manual`（每次文件变更都审批）、`auto`（工作区内编辑放行、更宽的写入询问）、`fullAccess`（从不提示） |

## 命令

- `dsh.setApiKey` — 输入 DeepSeek API key 并存进 secret storage
- `dsh.importApiKeyFromSettings` — 从 `acp.agents` 配置一次性导入明文 key
- `dsh.restartChild` — 按当前设置重建子进程
- `dsh.newSession` — 在新编辑器标签页中开始一个会话
- `dsh.reopenClosedSession` — 重开最近关闭的会话标签页
- `dsh.acceptDiff` / `dsh.rejectDiff` — 应用或回退活动编辑器的待定变更（编辑器标题菜单）
- `dsh.toggleAutomode` — 在 Auto 与 Manual 间切换权限模式（状态栏徽标点击）
- `dsh.setPermissionMode` — 选择 Manual、Auto 或 Full Access
- `dsh.stopSession` — 中断最近打开的会话的运行中回合

## 开发

```sh
pnpm run build          # repo build (tsc + tsdown, plus the webview vite bundles)
code apps/vscode        # open the app folder, then F5: Run Extension
```

针对仓库内构建的 bin（而非全局安装的 `dsh`）开发时，把 `dsh.command` 设为 `apps/cli/lib/bin.js` 的绝对路径、`dsh.node` 设为 `node`。

## 打包

```sh
pnpm --filter @deepseek-ai/dsh-vscode run build:webview   # the panel HTML + shell bundle
pnpm --filter @deepseek-ai/dsh-vscode run build:bundle    # extension.cjs + staged curated bundles + smoke.cjs
pnpm --dir apps/vscode exec tsx scripts/package.ts        # dsh-vscode-<version>.vsix
pnpm --dir apps/vscode exec tsx scripts/smoke.ts apps/vscode/dsh-vscode-<version>.vsix  # packaged smoke (downloads VS Code)
```

vsix 把扩展入口打成单个 CJS 文件，并把精选客户端 bundle 暂存在其旁（打包后的扩展没有 node_modules）。用 `code --install-extension apps/vscode/dsh-vscode-<version>.vsix` 安装。

## Known Limitations and Deferred Work

- `Cmd+Escape` 输入框聚焦尚未接线。
- **先应用后审查。** harness 的 `edit`/`write` 工具在工具执行时经沙箱写入，因此 diff 卡审查的是一个已经落到工作区的变更——Apply 同步编辑器、Reject 回退，而非 Claude Code 的接受后再写入流程。带未保存更改的文件会被两个动作跳过而非覆盖。
- **每文件一个待定变更。** 待定注册表按解析后的路径为键；第二个会话对同一文件的 diff 会替换第一个的 Accept/Reject 条目。
- **Reveal 只预览第一个文件。** 多文件变更只为第一个 hunk 打开旧→新 diff 预览，其余以普通文档打开。
- **徽标取最近事件。** 徽标反映所有会话中最近的模式事件；mux 流不含历史，因此徽标从 `dsh.initialPermissionMode` 起步，直到某个会话切换。
