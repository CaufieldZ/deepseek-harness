# @deepseek-ai/dsh-vscode

English | [中文](README.zh.md)

VSCode extension for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): it spawns the harness as a child process and serves its sessions as editor tabs, like the Claude Code extension does for Claude Code.

## What this milestone ships

- **Session tabs.** Each session is one `WebviewPanel` editor tab (multi-open, draggable, restored on window reload). The activity-bar session tree opens sessions; `Cmd+N` starts a new one and `Cmd+Shift+T` reopens the most recently closed one.
- **The assembled web client.** Every panel boots the harness client UI — streaming chat, tool cards, plan, user questions, permissions — from a curated set of client bundles composed into a boot graph at panel render. The webview never talks HTTP to the child: all requests relay over the postMessage MessagePort carrier to the extension host.
- **IDE context.** The extension host keeps a debounced snapshot of the workspace, active editor, and selection in `$DSH_HOME/vscode/context.json`; the child's `vscode` profile injects it into the first request of each turn.
- **Claude Code hook compatibility.** The `vscode` profile mounts `hooks-claude-code` against the workspace root, so a workspace's `.claude/settings.json` hooks apply — the same file Claude Code reads. The child launches with the workspace root as its cwd for this.
- **Keyless development fixture.** Tests and snapshots boot the panel against the in-browser fixture host; the real child path runs with `dsh.setApiKey`.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `dsh.command` | `dsh` | Child command: the `dsh` bin on PATH, or an absolute path to a built bin |
| `dsh.profile` | `vscode` | Profile the child boots (`vscode` adds IDE context and CC hooks; `web` is the plain browser surface) |
| `dsh.node` | (empty) | When set, the child command is launched through this Node executable |
| `dsh.home` | (empty) | `DSH_HOME` for the child; empty inherits the default |
| `dsh.spawnTimeoutMs` | `30000` | Milliseconds to wait for the child's ready line |
| `dsh.extraEnv` | `{}` | Extra child environment entries, e.g. `DEEPSEEK_BASE_URL` |
| `dsh.enableNewConversationShortcut` | `false` | Use Cmd/Ctrl+N for a new session when the dsh views are focused |
| `dsh.enableReopenClosedSessionShortcut` | `true` | Use Cmd/Ctrl+Shift+T to reopen the most recently closed session |
| `dsh.preferredLocation` | `tab` | Where dsh sessions open |

## Commands

- `dsh.setApiKey` — prompt for the DeepSeek API key and store it in secret storage
- `dsh.importApiKeyFromSettings` — one-shot import of a plaintext key from an `acp.agents` configuration
- `dsh.restartChild` — rebuild the child from the current settings
- `dsh.newSession` — start a session in a new editor tab
- `dsh.reopenClosedSession` — reopen the most recently closed session tab

## Development

```sh
pnpm run build          # repo build (tsc + tsdown, plus the webview vite bundles)
code apps/vscode        # open the app folder, then F5: Run Extension
```

When developing against a repo-built bin instead of a globally installed `dsh`, set `dsh.command` to the absolute `apps/cli/lib/bin.js` path and `dsh.node` to `node`.

## Known Limitations and Deferred Work

- `Cmd+Escape` input focus is not wired yet.
- Automode and diff apply/accept land in follow-up changes.
- The profile is fixed to `web`; the dedicated `vscode` profile arrives with the IDE-context plugin.
