# Agent Note：VSCode 权限模式与 Automode 徽标

Status: implemented

[English](2026-08-25-vscode-permission-modes.md) | 中文

## 问题

VSCode 面板需要 Claude Code 风格的权限控制：可见的 Automode 开关、选择模式的方式以及中断。harness 已经拥有这些语义——base bundle 的 patch 钉住三个权限预设（`read-only` + ask、`workspace-write` + ask、`danger-full-access` + never）以及记录 `permission/preset` 与 `sandbox/mode` 会话事件的每会话 `/permission` 写路径——但扩展里没有任何东西把它们暴露出来。

## 决策

harness 零改动：扩展消费既有接缝。新的 host 模块 `permission-mode.ts` 拥有读侧——它把 mux 流 `session/event` 帧的宽 `data` 逐字段窄化（`permission/preset` 的 `preset`、`sandbox/mode` 的 `mode`）为三个预设名之一，折叠到最新值，并映射 Claude Code 标签（Manual / Auto / Full Access）。徽标显示所有会话中最近的模式事件，起步值来自 `dsh.initialPermissionMode`（`manual`/`auto`/`fullAccess` → `read-only`/`workspace-write`/`danger-full-access`；mux 不含历史，因此该设置是初始事实）。

写路径是 `applyPreset`：先设新会话默认——经 `settings.mutate` 写 `permission` 命名空间的 `defaultPreset`——再经 `/permission` 命令（harness 的唯一写路径）应用到每个打开面板的会话，执行方式是新加的 `NodeApiClient.rpcCall`，向 `/api/<endpoint>` gateway 通道 POST `client-request` 信封（与浏览器 connection rpc 同形，endpoint 即某个 `@Remote` 方法的 wire 名）。徽标点击在 Auto ↔ Manual 间切换；其余状态（Full Access、未知）经 Manual 离开循环。`dsh.setPermissionMode` 快速选择任一预设，`dsh.stopSession` 经 `sessions.cancel` 取消最近打开会话的运行中回合。

## 备选方案

**经 `DSH_PERMISSION_MODE` + 重启子进程驱动模式。** 拒绝（对原 PR 计划的偏离）：环境覆盖只在启动时设置部署默认，而 harness 已支持每会话切换且持久化在会话日志里——重启一无所获，而 `/permission` 路径样样做得更好。

**加专用模式 RPC。** 拒绝：`commands/execute` 是 web 表面已在使用的、会话作用域的既有写路径；第二个 RPC 会复制它的生命周期记录（`command/run`/`command/done` 事件）。

**每会话徽标。** 拒绝：Claude Code 的开关是全局的，mux 流不携带每会话历史，扩展也无法可靠地确定活动面板的会话；「最近事件徽标 + 应用到所有会话的写」是诚实的全局近似。

## 后果

每次模式切换都是持久的（会话事件在压缩与子进程重启后仍存），新会话默认跟随最近一次切换，扩展保持零权限策略逻辑——沙箱与审批旋钮留在 harness。徽标是投影，不是控制面：从面板的 `/permission` 输入切换后，徽标可能滞后到 mux 帧到达（流是状态的唯一发布者）。后续工作：会话运行在 `workspace-write` 下时隐藏 Accept/Reject 待定登记（diff 已落盘）；在投影 feed 可用后提供每会话徽标读数。
