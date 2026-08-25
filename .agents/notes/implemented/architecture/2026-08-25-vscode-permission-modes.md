# Agent Note: VSCode permission modes and the Automode badge

Status: implemented

English | [中文](2026-08-25-vscode-permission-modes.zh.md)

## Problem

The VSCode panel needs the Claude-Code-style permission controls: a visible Automode switch, a way to pick a mode, and an interrupt. The harness already owns the semantics — the base bundle's patch pins three permission presets (`read-only` + ask, `workspace-write` + ask, `danger-full-access` + never) and a per-session `/permission` write path that records `permission/preset` and `sandbox/mode` session events — but nothing in the extension exposes them.

## Decision

Zero harness changes: the extension consumes the existing seams. A new host module, `permission-mode.ts`, owns the read side — it narrows the wide `data` of the mux stream's `session/event` frames field by field (`permission/preset`'s `preset`, `sandbox/mode`'s `mode`) into one of the three preset names, folds to the latest, and maps the Claude-Code labels (Manual / Auto / Full Access). The badge shows the newest mode event across sessions and starts from `dsh.initialPermissionMode` (`manual`/`auto`/`fullAccess` → `read-only`/`workspace-write`/`danger-full-access`; the mux carries no history, so the setting is the initial truth).

The write path is `applyPreset`: the new-session default first, through `settings.mutate` on the `permission` namespace's `defaultPreset`, then every open panel's session through the `/permission` command — the harness's one write path — executed via a new `NodeApiClient.rpcCall` that posts a `client-request` envelope to the `/api/<endpoint>` gateway channel (the same shape the browser connection rpc uses, so the endpoint is the wire name of one `@Remote` method). The badge click toggles Auto ↔ Manual; every other state (Full Access, unknown) leaves the loop through Manual. `dsh.setPermissionMode` quick-picks any preset, and `dsh.stopSession` cancels the most recently opened session's running turn through `sessions.cancel`.

## Alternatives considered

**Drive the mode through `DSH_PERMISSION_MODE` + child restart.** Rejected (deviation from the original PR plan): the env override sets the deployment default only at boot, while the harness already supports per-session switches that persist in the session log — a restart loses nothing but adds nothing the `/permission` path cannot do better.

**Add a dedicated mode RPC.** Rejected: `commands/execute` is the existing, session-scoped write path the web surface already uses; a second RPC would duplicate its lifecycle recording (`command/run`/`command/done` events).

**Per-session badge.** Rejected: Claude Code's switch is global, the mux stream carries no per-session history, and the extension cannot name the active panel's session reliably; a last-event badge with an apply-to-all-sessions write is the honest global approximation.

## Consequences

Every mode switch is durable (the session events survive compaction and child restarts), the new-session default follows the last switch, and the extension stays free of any permission-policy logic — the sandbox and approval knobs stay in the harness. The badge is a projection, not a control plane: it can lag a switch made from a panel's `/permission` input until the mux frame arrives (the stream is the state's only publisher). Follow-up work: hide the Accept/Reject pending registration when the session runs under `workspace-write` (the diff already landed), and per-session badge readouts once a projection feed is available.
