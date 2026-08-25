# Agent Note: VSCode extension child process and Node carrier

Status: implemented

English | [中文](2026-08-25-vscode-extension-child-process-and-carrier.zh.md)

## Problem

A VSCode extension must present the full interactive harness surface — streaming chat, session list/history, approvals, questions, plans — inside an editor whose own runtime is an Electron extension host. The existing surfaces each fall short for that job: ACP is deliberately automation-only (no streaming, no session list, no interactive rendering), the SDK JSON-RPC wire lacks session list/history/cancel, and the web client stack assumes a browser over HTTP, which the extension host is not.

## Decision

The extension (`@deepseek-ai/dsh-vscode`) spawns the harness as a child process: `dsh --profile web --no-open --port 0`, bound to `127.0.0.1` with an OS-assigned port announced on the child stdout. The extension host drives it with `NodeApiClient`, a subclass of `AbstractApiClient` whose `resolveBase` re-reads the child base URL per request (restarts change the port), whose `doFetch` is plain Node fetch, and whose mux/host streams ride one `ws` WebSocket downlink each — the network SSE path answers only Upgrade Required, so WebSocket is the only network downlink. Cordis is never booted inside the extension host: `installFailLoud` exits the process, `node-pty` needs a Node ABI the Electron host lacks, stdout purity belongs to child processes, and a crash can only kill a child the extension owns. The DeepSeek credential travels as `scrubbedParentEnv()` plus an explicit `DEEPSEEK_API_KEY`, stored in VS Code secret storage. A ready announcement naming a non-loopback host fails loud and stops the child — the loopback binding is a security invariant, not a convenience.

## Alternatives considered

**Boot cordis in-process in the extension host.** Rejected: process-lifetime assumptions (`process.exit`, stdin EOF ownership, fail-loud), Electron-native-ABI rebuilds, stdio-purity conflicts, and crash containment all favor a child. Everything the in-process shape would buy (key injection, editor-context services) has a child-compatible equivalent.

**Drive the ACP server instead.** Rejected: the ACP surface is scoped to automation (committed text only, no session list, no interactive rendering), so a chat panel over ACP would rebuild the interactive layer the web client already owns.

**Use the SDK JSON-RPC runtime.** Rejected: its wire lacks session list/history/cancel and per-prompt results, all of which the extension needs for session tabs and interrupt.

**Let the webview talk HTTP to the child directly.** Rejected: the /api trust fence requires `Origin.host === Host`, and a webview origin (`vscode-webview://<id>`) can never match the loopback authority. The extension host relays; the webview-side MessagePort carrier lands in a follow-up change over the existing `__DSH_TRANSPORT__` seam.

## Consequences

The child surface needs zero harness-side changes today (the shipped `web` profile already supports `--no-open --port 0`). The loopback port is a per-child secret that the extension alone knows; the API client re-resolves it after every restart. Version skew between the extension and an installed `dsh` surfaces through `host.describe.version` in the status bar. Follow-up changes add the webview MessagePort carrier, session panels, and the dedicated `vscode` profile.
