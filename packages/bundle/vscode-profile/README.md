# @deepseek-ai/dsh-vscode-profile

English | [中文](README.zh.md)

The `vscode` profile bundle: the IDE-context feed ([`dsh-vscode-context`](../../context/vscode-context/README.md)) and the Claude Code hook bridge ([`dsh-hooks-claude-code`](../../hooks/hooks-claude-code/README.md)) over the `dsh-web-app` surface. The `dsh --profile vscode` template composes it as the third layer after `dsh-base` and `dsh-web-app`:

```yaml
dsh:
  profile:
    bundles:
      - '@deepseek-ai/dsh-base'
      - '@deepseek-ai/dsh-web-app'
      - '@deepseek-ai/dsh-vscode-profile'
```

## What the patch mounts

| Row | Package | Config |
|---|---|---|
| `vscode-context` | `@deepseek-ai/dsh-vscode-context` | — (reads `$DSH_HOME/vscode/context.json`) |
| `hooks-claude-code` | `@deepseek-ai/dsh-hooks-claude-code` | `configPath: ./.claude/settings.json` |

Both rows append to the composed entry list after the web surface. The hook config path resolves from the child launch cwd: the VS Code extension spawns the child at the workspace root, so a workspace's `.claude/settings.json` (or its `hooks` key) applies — the same file Claude Code reads. A workspace without that file registers no hooks (the bridge logs a warning and registers nothing).

## Model Experience

Indirectly, through the inserted rows: this bundle adds the IDE-context reading (the vscode-context package documents its token and KV-cache effects) and the CC hook bridge, and contributes no model-visible text of its own.

#### KV Cache effect

None directly; each inserted row's package owns its effect.

## Known Limitations and Deferred Work

- **Process-level hook config** — `hooks-claude-code` reads one config at load; switching workspaces requires a child restart (`dsh: Restart Harness Child Process`).
- **First workspace root only** — the feed names the first workspace folder; see the vscode-context package for its own limits.
