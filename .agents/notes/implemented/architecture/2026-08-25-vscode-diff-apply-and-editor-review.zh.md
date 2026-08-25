# Agent Note：VSCode diff 应用与编辑器 Accept/Reject 审查

Status: implemented

[English](2026-08-25-vscode-diff-apply-and-editor-review.md) | 中文

## 问题

面板把每个 `edit`/`write` 变更渲染成 diff 卡，但卡片是只读的：用户可以复制它、打开文件，仅此而已。没有从卡片对变更采取动作的途径，编辑器里也没有像 Claude Code 插件那样的逐文件接受/拒绝入口，客户端 UI 也缺少在不替换既有行的情况下挂载这些动作的缝。

## 决策

新增子槽位 `tool.call.diff-actions`（`kind: 'single'`、`scope: 'session'`），由 ui-tool 的 tool-call 聊天节点声明，`ToolCallTree` 在每个派生出 diff hunk 的调用旁渲染。owner 携带调用身份与已窄化的 hunks（`DiffActionOwnerProps.diffs`），绝不携带原始 wire 视图；没有注册就什么都不渲染，因此既有的 web 表面不变。选子槽位而非 `tool.call.toolview` 接管：keyed toolview 槽位会替换整行（且 `FileMutationRow` 并未导出），而动作槽位是叠加的，并让唯一的 diff 派生点（`diffCardModel`）保持权威。

VSCode webview 壳挂载该表面：一个 `dsh-vscode-diff-actions` 子插件经 `slots.inject`（与声明顺序无关）把 Apply/Reveal 按钮注册进该洞，带自己的 `vscode` locale 命名空间。按钮经 `main.ts` 安装的 transport 全局发送三条宿主本地消息——`diff-present`（把变更登记为待定）、`diff-apply`、`diff-reveal`——在 host 桥接的 wire 边界逐字段校验，并路由到 `diffActions` 处理器而不是子进程中继。

扩展宿主执行这些动作（`apps/vscode/src/diff-actions.ts`）。Apply 是编辑器同步：内容为编辑前文本的干净已打开文档经 `workspace.applyEdit` 替换；没有打开编辑器的文件做一次幂等的 `workspace.fs` 写入（子进程在工具执行时已经应用了变更——dsh 的 `edit`/`write` 工具经沙箱写入，不同于 Claude Code 的接受后写入流程）。脏缓冲或内容分叉的文档跳过该文件并警告，绝不覆盖未保存的用户工作。Reject 回退：磁盘内容必须仍等于编辑结果，然后写回编辑前内容（新建的文件则删除）。Reveal 为第一个 hunk 打开旧内容虚拟文档与真实文件之间的 `vscode.diff`；其余文件以普通文档打开。一个按解析后路径为键的 `PendingDiffs` 注册表驱动 editor/title 的 `dsh.acceptDiff`/`dsh.rejectDiff` 命令，由每次编辑器切换时重算的 `dsh.pendingDiff` 上下文键控制显示；被跳过的文件保留待定条目以便菜单重试。

## 备选方案

**在壳里为 `edit`/`write` 注册 `tool.call.toolview` 接管。** 拒绝：接管会整体替换既有行，迫使壳重新派生 diff 卡并重实现行骨架（展开状态、错误摘要）——这些 ui-tool 已经拥有——在包边界两侧复制逻辑，正是 keyed-slot 回退设计所要避免的漂移。

**从宿主渲染 Apply/Reveal。** 拒绝：宿主无法注入 webview DOM；按钮必须位于 webview 的 React 树中，子槽位提供的正是这一点。

**apply 前自动保存脏缓冲。** 拒绝（对原 PR 计划的偏离）：harness 在工具执行时应用编辑，脏缓冲已经与编辑所依据的磁盘内容分叉——保存它会覆盖 agent 的变更，而不是与之调和。跳过并警告能保全两边。

## 后果

VSCode 面板里每个带 diff 的调用现在显示 Apply/Reveal，每个呈现的变更都保持待定，直到在编辑器标题菜单接受或拒绝。该槽位随 web 表面发布但保持为空；ui-tool 的测试钉住 owner 载荷、挂载条件与注销。webview 壳 bundle 经模块加载器的平台模块表外部化 `react`、`react/jsx-runtime` 与 `dsh-client-ui-primitives`，按钮因此与应用共享同一 React 实例（再打包一份会破坏 hooks）。后续工作：Automode 自动应用 diff 而非等待 Apply；待定注册表可改为按会话而非按路径划定作用域。
