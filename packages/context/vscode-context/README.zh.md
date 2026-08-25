# @deepseek-ai/dsh-vscode-context

[English](README.md) | 中文

可选启用的持久上下文，描述 VS Code 扩展宿主维护在状态文件里的工作区、活动编辑器与选区。它在模型请求准备阶段每回合采样一次，只随 `vscode` profile bundle 发布。决策记录：[webview panel boot Agent Note](../../../.agents/notes/implemented/architecture/2026-08-25-vscode-webview-panel-boot.zh.md)。

## 配置

```yaml
- id: vscode-context
  name: '@deepseek-ai/dsh-vscode-context'
  config:
    feedPath: /absolute/path/context.json # optional; defaults to $DSH_HOME/vscode/context.json
    refreshIntervalMs: 60000              # optional; omit or set to 0 to inject on every changed turn
```

`refreshIntervalMs` 必须是非负安全整数。省略或为 `0` 时，渲染后的编辑器状态相对上次注入发生变化即注入。正值还会抑制距最近一次注入不足该毫秒数的注入。

## 如何读取编辑器状态

插件前置一个 `agent/pre-step` 监听器，只在每回合第一步运行。到期时读取一份 JSON 文档——扩展宿主原子写入的 feed：

```json
{
  "version": 1,
  "updatedAt": 1760000000000,
  "workspace": "/work",
  "activeFile": {
    "path": "src/index.ts",
    "languageId": "typescript",
    "cursor": { "line": 42, "character": 7 },
    "selection": { "startLine": 40, "endLine": 50, "text": "const answer = 42\n" }
  },
  "openFiles": ["src/index.ts", "src/util.ts"]
}
```

feed 是 wire 边界：插件逐字段窄化校验，版本不符或字段畸形即拒绝。文件缺失（扩展未运行或没有打开的编辑器）、不可读或内容畸形都是 no-op，绝不报错；解析失败被包含并记入警告，回合继续。feed 路径默认为 `$DSH_HOME/vscode/context.json`，即子进程经 `DSH_HOME` 解析出的同一 home。

状态在每个符合条件的回合重新拉取——切换文件或移动选区无需任何 wire 变更或后台进程即可生效。插件只在渲染后的编辑器状态相对上次注入变化时重新注入，编辑器未变则不加任何内容。

## 时序语义

插件前置一个 `agent/pre-step` 监听器。注入到期且下游决策进入提议步骤时，它向返回批次前置一条带来源的 `UserMessage`。AgentLoop 在 `step/start` 之后以 `{ kind: 'plugin', plugin: 'vscode-context' }` 来源记录该上下文。变化抑制与间隔调度扫描原始持久会话事件中该来源的最近注入，因此调度在压缩与进程恢复后依然成立，无需进程本地缓存；各会话独立调度。下游 pre-step 监听器拒绝或失败会阻止该读取被记录。

## 模型体验

### 准备阶段的编辑器状态

#### 模型所见

在编辑器状态发生变化的每个回合，一条带来源标签的上下文消息，包含以下行。选区文本由扩展宿主截断（4000 字符）并去掉尾部换行；最多列出 20 个打开文件。

##### 变化回合的读取

```markdown
vscode context (turn <turn>):
workspace <workspace-path>
active file <path>, cursor <line>:<character>, selection lines <start>-<end>:
<selection-text>
open files (<count>): <paths>
```

#### Token 影响

每条读取持续累积，直到压缩将其遮蔽。编辑器状态未变与间隔抑制不添加任何内容。

#### KV Cache 影响

只追加；新可见内容位于可复用请求前缀之后，不会使已有 KV-cache 条目失效。

## Known Limitations and Deferred Work

- **仅第一步**——回合中途切换文件或移动选区会在下一回合才反映，不在步骤之间。
- **feed 新鲜度**——feed 是扩展宿主最近一次防抖快照；刚刚发生的编辑器变动可能滞后一个回合。
- **单一工作区**——feed 只列出第一个工作区文件夹；多根工作区仅报告其第一个根。
