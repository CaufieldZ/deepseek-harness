# @deepseek-ai/dsh-vscode

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 VSCode 插件：把 harness 作为子进程启动，并把会话呈现为编辑器标签页——就像 Claude Code 插件之于 Claude Code。

## 本里程碑交付

- **会话标签页。** 每个会话是一个 `WebviewPanel` 编辑器标签页（可多开、可拖拽、窗口重载后恢复）。活动栏会话树可打开会话；`Cmd+N` 新建会话，`Cmd+Shift+T` 重开最近关闭的会话。
- **装配后的 web 客户端。** 每个面板启动 harness 客户端 UI——流式聊天、工具卡片、plan、用户提问、权限——由精选的客户端 bundle 集在面板渲染时组装为启动图。webview 从不直接对子进程发起 HTTP：所有请求经 postMessage MessagePort 载体中继到扩展宿主。
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

## 命令

- `dsh.setApiKey` — 输入 DeepSeek API key 并存进 secret storage
- `dsh.importApiKeyFromSettings` — 从 `acp.agents` 配置一次性导入明文 key
- `dsh.restartChild` — 按当前设置重建子进程
- `dsh.newSession` — 在新编辑器标签页中开始一个会话
- `dsh.reopenClosedSession` — 重开最近关闭的会话标签页

## 开发

```sh
pnpm run build          # repo build (tsc + tsdown, plus the webview vite bundles)
code apps/vscode        # open the app folder, then F5: Run Extension
```

针对仓库内构建的 bin（而非全局安装的 `dsh`）开发时，把 `dsh.command` 设为 `apps/cli/lib/bin.js` 的绝对路径、`dsh.node` 设为 `node`。

## Known Limitations and Deferred Work

- `Cmd+Escape` 输入框聚焦尚未接线。
- Automode 与 diff 应用/接受在后续变更中落地。
- profile 固定为 `web`；专用 `vscode` profile 随 IDE 上下文插件一起落地。
