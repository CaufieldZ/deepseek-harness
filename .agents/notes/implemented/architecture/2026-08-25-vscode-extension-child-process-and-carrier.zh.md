# Agent Note: VSCode 插件的子进程与 Node 载体

Status: implemented

[English](2026-08-25-vscode-extension-child-process-and-carrier.md) | 中文

## Problem

一个 VSCode 插件要在编辑器里呈现 harness 的完整交互面——流式聊天、会话列表/历史、审批、提问、plan——而编辑器的运行时是 Electron 扩展宿主。现有各接缝对这个任务都不够用：ACP 被刻意限定为 automation-only（无流式、无会话列表、无交互渲染），SDK 的 JSON-RPC wire 缺少会话列表/历史/取消，而 web 客户端栈假定浏览器走 HTTP，扩展宿主并不是浏览器。

## Decision

插件（`@deepseek-ai/dsh-vscode`）把 harness 作为子进程启动：`dsh --profile web --no-open --port 0`，绑定 `127.0.0.1`，OS 分配的端口经子进程 stdout 宣告。扩展宿主用 `NodeApiClient` 驱动它——这是 `AbstractApiClient` 的子类：`resolveBase` 每次请求重读子进程 base URL（重启会换端口），`doFetch` 就是 Node fetch，mux/host 两个事件流各走一条 `ws` WebSocket downlink（网络 SSE 路径只回 Upgrade Required，WebSocket 是唯一网络下行）。Cordis 绝不内嵌进扩展宿主：`installFailLoud` 会 `process.exit`、`node-pty` 需要的 Node ABI 与 Electron 宿主不匹配、stdout 纯净性属于子进程、崩溃最多带走插件自己拥有的子进程。DeepSeek 凭据以 `scrubbedParentEnv()` + 显式 `DEEPSEEK_API_KEY` 传递，密钥存于 VSCode secret storage。宣告非回环地址的 ready 行会大声失败并停掉子进程——回环绑定是安全不变量，不是便利配置。

## Alternatives considered

**在扩展宿主内嵌 cordis。** 否决：进程级假设（`process.exit`、stdin EOF 归属、fail-loud）、Electron 原生 ABI 重编译、stdio 纯净性冲突、崩溃隔离都不利。内嵌形态能买到的东西（密钥注入、编辑器上下文服务）都有子进程等价方案。

**改走 ACP server。** 否决：ACP 面只面向自动化（仅提交文本、无会话列表、无交互渲染），聊天面板走 ACP 等于重造 web 客户端已有的交互层。

**用 SDK 的 JSON-RPC runtime。** 否决：其 wire 缺少会话列表/历史/取消和逐 prompt 结果——会话标签页与打断都需要这些。

**让 webview 直连子进程 HTTP。** 否决：/api 信任栅栏要求 `Origin.host === Host`，而 webview origin（`vscode-webview://<id>`）永远匹配不上回环 authority。扩展宿主负责中继；webview 侧的 MessagePort 载体在后续变更中经既有的 `__DSH_TRANSPORT__` 接缝落地。

## Consequences

子进程面今天无需任何 harness 侧改动（已发布的 `web` profile 本身就支持 `--no-open --port 0`）。回环端口是插件独占的每子进程秘密；API 客户端在每次重启后重新解析。插件与已安装 `dsh` 之间的版本偏差经状态栏的 `host.describe.version` 呈现。后续变更将补齐 webview MessagePort 载体、会话面板与专用的 `vscode` profile。
