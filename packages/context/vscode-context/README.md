# @deepseek-ai/dsh-vscode-context

English | [中文](README.zh.md)

Opt-in durable context naming the workspace, active editor, and selection the VS Code extension host maintains in a state file. It is sampled once per turn during model-request preparation and ships only through the `vscode` profile bundle. Decision record: [the webview panel boot Agent Note](../../../.agents/notes/implemented/architecture/2026-08-25-vscode-webview-panel-boot.md).

## Config

```yaml
- id: vscode-context
  name: '@deepseek-ai/dsh-vscode-context'
  config:
    feedPath: /absolute/path/context.json # optional; defaults to $DSH_HOME/vscode/context.json
    refreshIntervalMs: 60000              # optional; omit or set to 0 to inject on every changed turn
```

`refreshIntervalMs` must be a non-negative safe integer. Omission or `0` injects whenever the rendered editor state changed since the last injection. A positive value additionally suppresses injections that fall within that many milliseconds of the latest one.

## How it reads the editor state

The plugin prepends an `agent/pre-step` listener that runs only on the first step of each turn. When due, it reads one JSON document — the feed — written atomically by the extension host:

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

The feed is a wire boundary: the plugin narrows every field and rejects a document with a wrong version or a malformed field. An absent file (the extension is not running, or no editor is open), an unreadable file, or a malformed feed is a no-op, never an error; a parse failure is contained and logged as a warning so the turn continues. The feed path defaults to `$DSH_HOME/vscode/context.json`, the same home the child resolves through `DSH_HOME`.

State is pulled on every eligible turn — a file switch or a selection move is picked up without any wire change or background process. The plugin re-injects only when the rendered editor state differs from its last injection, so an unchanged editor adds nothing.

## Timing semantics

The plugin prepends an `agent/pre-step` listener. When an injection is due and the downstream decision enters the proposed step, it prepends one sourced `UserMessage` to the returned batch. AgentLoop records that context after `step/start` with source `{ kind: 'plugin', plugin: 'vscode-context' }`. Change suppression and interval scheduling scan the raw durable session events for the latest injection of this source, so the schedule survives compaction and resumed processes without process-local cache state; sessions schedule independently. A downstream pre-step listener that rejects or fails prevents the reading from being recorded.

## Model Experience

### Preparation-time editor state

#### What the model sees

On each turn whose editor state changed, one source-tagged context message with the lines below. The selection text is capped by the extension host (4000 characters) and trimmed of its trailing newline; at most 20 open files are named.

##### Changed-turn reading

```markdown
vscode context (turn <turn>):
workspace <workspace-path>
active file <path>, cursor <line>:<character>, selection lines <start>-<end>:
<selection-text>
open files (<count>): <paths>
```

#### Token effect

Each reading accumulates until compaction shadows it. Unchanged editor state and interval suppression add nothing.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **First step only** — a file switch or selection move mid-turn is reflected on the next turn, not between steps.
- **Feed freshness** — the feed is the extension host's last debounced snapshot; very recent editor churn may lag one turn.
- **One workspace** — the feed names the first workspace folder only; multi-root workspaces report their first root.
