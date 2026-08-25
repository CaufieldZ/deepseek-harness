# Agent Note：VSCode IDE 上下文与 vscode profile

Status: implemented

[English](2026-08-25-vscode-ide-context-profile.md) | 中文

## 问题

面板给了 agent 交互表面，但 agent 看不见用户正在看什么——活动文件、选区、工作区——而建立在 Claude Code 生态上的工作区（CLAUDE.md、`.claude/settings.json` 钩子）仍然不起作用。两者都必须在不动 API wire 的前提下工作：子进程是独立进程，编辑器状态归扩展宿主所有。

## 决策

扩展宿主维护一个状态文件 `$DSH_HOME/vscode/context.json`（`apps/vscode/src/context-feed.ts`）：工作区根、活动编辑器（路径、光标、选区文本截断到 4000 字符）以及最多 20 个打开文件的防抖快照，原子写入（临时文件 + rename），读取方永远看不到撕裂的文档。feed home 经 `resolveDshHome(settings.home, {})` 解析——与子进程相同的解析器，环境留空以免扩展宿主自身的环境变量造成偏差。新上下文插件 `@deepseek-ai/dsh-vscode-context` 在请求准备阶段读取 feed：前置 `agent/pre-step` 监听器、仅 `step === 1`、在 wire 边界校验文档（版本、逐字段窄化——畸形则警告并跳过，绝不使回合失败），仅在渲染状态相对上次持久注入发生变化时重新注入（与 tmux-context 相同的回扫调度，压缩与恢复均成立），可选 `refreshIntervalMs` 下限。注入消息使用 `snapshot` 形式（`source: { kind: 'plugin', plugin: 'vscode-context', form: 'snapshot', sections }`）。

扩展以工作区根作为子进程启动 cwd，并把 `dsh.profile` 默认改为 `vscode`——一个新的内置 profile 模板（`PROFILE_TEMPLATES.vscode`），在 `dsh-base` + `dsh-web-app` 之上组合第三个 bundle `@deepseek-ai/dsh-vscode-profile`。该 bundle 的 patch 追加两行：`vscode-context` 与 `hooks-claude-code`（`configPath: ./.claude/settings.json`）——相对启动 cwd 解析，因此工作区的 CC 钩子文件原样生效，没有该文件的工作区不注册任何钩子。新 bundle 包进入 `apps/cli` 依赖闭包，使 profile bundle 解析与 profiles 模块回退都能从 dsh 安装目录看到它们。

## 备选方案

**经 API wire 携带编辑器状态。** 拒绝：新通道（事件、端点或第二条流）需要 apiproxy schema、客户端服务与信任栅栏的许可，去承载每次按键都在变化的状态；状态文件由拥有 pre-step 扩展点的插件每回合读取一次，零 wire 表面。

**沿用 `web` profile 并在扩展里挂载插件。** 拒绝：子进程经 profile 启动器启动；插件组合属于 profile，不属于启动它的宿主进程。profile 也是唯一能让 CC 钩子兼容成为默认发布行为、而不动 web 应用组合的地方。

**feed 整个打开文件集与完整选区。** 拒绝：上限（4000 字符选区、20 个文件）防止一次按键把模型可见前缀变成兆字节级；上限放在扩展侧构建器里，文件格式保持宽松。

## 影响

模型可见内容每个变化回合增加一条读取（token 与 KV-cache 影响记录在包 README）。vscode-context 插件在 `vscode` profile 之外为可选启用，与 tmux-context 姿态一致；其真实 Loader e2e（两回合 headless 运行 + mock 适配器 + 预置 feed）钉住装配后的注入与状态未变时的抑制。钩子桥保留其进程级配置限制：切换工作区需要重启子进程。后续工作：按会话的钩子配置发现（hooks-claude-code 的 `TODO(per-session-hook-config)`）与多根工作区 feed。
