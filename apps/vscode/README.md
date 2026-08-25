# @deepseek-ai/dsh-vscode

English | [中文](README.zh.md)

VSCode extension for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): it spawns the harness as a child process and will serve its sessions as editor tabs, like the Claude Code extension does for Claude Code.

## What this milestone ships

The extension host lifecycle: it launches the harness child (`dsh --profile web --no-open --port 0`, loopback-bound), stores the DeepSeek API key in VS Code secret storage, restarts the child on crash with exponential backoff, and shows child state plus the harness version in the status bar.

The session-tab chat UI and the webview MessagePort carrier land in follow-up changes; until then the status bar and output channel are the whole surface.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `dsh.command` | `dsh` | Child command: the `dsh` bin on PATH, or an absolute path to a built bin |
| `dsh.profile` | `web` | Profile the child boots |
| `dsh.node` | (empty) | When set, the child command is launched through this Node executable |
| `dsh.home` | (empty) | `DSH_HOME` for the child; empty inherits the default |
| `dsh.spawnTimeoutMs` | `30000` | Milliseconds to wait for the child's ready line |
| `dsh.extraEnv` | `{}` | Extra child environment entries, e.g. `DEEPSEEK_BASE_URL` |

## Commands

- `dsh.setApiKey` — prompt for the DeepSeek API key and store it in secret storage
- `dsh.importApiKeyFromSettings` — one-shot import of a plaintext key from an `acp.agents` configuration
- `dsh.restartChild` — rebuild the child from the current settings

## Development

```sh
pnpm run build          # repo build (tsc + tsdown emit lib/)
code apps/vscode        # open the app folder, then F5: Run Extension
```

When developing against a repo-built bin instead of a globally installed `dsh`, set `dsh.command` to the absolute `apps/cli/lib/bin.js` path and `dsh.node` to `node`.

## Known Limitations and Deferred Work

- No chat UI yet — this milestone is the child lifecycle and API carrier only.
- Settings changes apply on `dsh.restartChild`, not live.
- The profile is fixed to `web`; the dedicated `vscode` profile arrives with the IDE-context plugin.
