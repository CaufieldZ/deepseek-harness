# @deepseek-ai/dsh-vscode

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 VSCode 插件：把 harness 作为子进程启动，并将把会话呈现为编辑器标签页——就像 Claude Code 插件之于 Claude Code。

## 本里程碑交付

扩展宿主生命周期：启动 harness 子进程（`dsh --profile web --no-open --port 0`，回环绑定）、把 DeepSeek API key 存进 VSCode secret storage、崩溃后指数退避重启、在状态栏显示子进程状态与 harness 版本。

会话标签页聊天 UI 与 webview MessagePort 载体在后续变更中落地；在此之前，状态栏与输出通道就是全部表面。

## 配置

| 设置 | 默认值 | 含义 |
|---|---|---|
| `dsh.command` | `dsh` | 子进程命令：PATH 上的 `dsh` bin，或已构建 bin 的绝对路径 |
| `dsh.profile` | `web` | 子进程启动的 profile |
| `dsh.node` | （空） | 设置后，子进程命令经此 Node 可执行文件启动 |
| `dsh.home` | （空） | 子进程的 `DSH_HOME`；为空则继承默认值 |
| `dsh.spawnTimeoutMs` | `30000` | 等待子进程 ready 行的毫秒数 |
| `dsh.extraEnv` | `{}` | 额外的子进程环境变量，如 `DEEPSEEK_BASE_URL` |

## 命令

- `dsh.setApiKey` — 输入 DeepSeek API key 并存进 secret storage
- `dsh.importApiKeyFromSettings` — 从 `acp.agents` 配置一次性导入明文 key
- `dsh.restartChild` — 按当前设置重建子进程

## 开发

```sh
pnpm run build          # repo build (tsc + tsdown emit lib/)
code apps/vscode        # open the app folder, then F5: Run Extension
```

针对仓库内构建的 bin（而非全局安装的 `dsh`）开发时，把 `dsh.command` 设为 `apps/cli/lib/bin.js` 的绝对路径、`dsh.node` 设为 `node`。

## Known Limitations and Deferred Work

- 还没有聊天 UI——本里程碑只有子进程生命周期与 API 载体。
- 设置变更经 `dsh.restartChild` 生效，非实时。
- profile 固定为 `web`；专用 `vscode` profile 随 IDE 上下文插件一起落地。
