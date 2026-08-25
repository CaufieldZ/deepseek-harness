# Agent Note: VSCode diff apply and the editor Accept/Reject review

Status: implemented

English | [中文](2026-08-25-vscode-diff-apply-and-editor-review.zh.md)

## Problem

The panel renders every `edit`/`write` change as a diff card, but the card is read-only: the user can copy it and open the file, nothing more. There is no way to act on a change from the card, no per-file accept/reject affordance in the editor like the Claude Code extension's, and no seam in the client UI for mounting such actions without replacing the shipped rows.

## Decision

A new child slot, `tool.call.diff-actions` (`kind: 'single'`, `scope: 'session'`), declared by ui-tool's tool-call chat node and rendered by `ToolCallTree` beside every call whose view derives diff hunks. The owner carries the call identity plus the already-narrowed hunks (`DiffActionOwnerProps.diffs`), never a raw wire view; no registration renders nothing, so the shipped web surface is unchanged. A child slot rather than a `tool.call.toolview` takeover: the keyed toolview slot replaces an entire row (and `FileMutationRow` is not exported), while the action slot is additive and keeps the one diff-derivation site (`diffCardModel`) authoritative.

The VSCode webview shell mounts the surface: a `dsh-vscode-diff-actions` sub-plugin registers Apply/Reveal buttons into the hole through `slots.inject` (declaration-order independent) with its own `vscode` locale namespace. The buttons post three host-local messages over the transport global `main.ts` installs — `diff-present` (registers the change as pending), `diff-apply`, `diff-reveal` — validated field-by-field at the wire in the host bridge and routed to a `diffActions` handler instead of the child relay.

The extension host executes the actions (`apps/vscode/src/diff-actions.ts`). Apply is an editor sync: a clean open document holding the pre-edit text is replaced through `workspace.applyEdit`; a file without an open editor gets an idempotent `workspace.fs` write (the child already applied the change at tool time — dsh's `edit`/`write` tools write through the sandbox, unlike Claude Code's accept-then-write flow). A dirty buffer or a diverged document skips that file with a warning instead of overwriting unsaved user work. Reject reverts: the disk content must still equal the edit's result, then the pre-edit content is written back (a created file is deleted). Reveal opens `vscode.diff` between a virtual old-content document and the real file for the first hunk; the remaining files open as plain documents. A `PendingDiffs` registry keyed by resolved path feeds the editor/title `dsh.acceptDiff`/`dsh.rejectDiff` commands, gated by the `dsh.pendingDiff` context key recomputed on every editor switch; skipped files keep their pending entry so the menu can retry.

## Alternatives considered

**Register a `tool.call.toolview` takeover for `edit`/`write` in the shell.** Rejected: takeover replaces the shipped row wholesale, forcing the shell to re-derive the diff card and re-implement row chrome (expand state, error summaries) that ui-tool already owns — duplicated logic on both sides of a package boundary, exactly the drift the keyed-slot fallback is designed against.

**Render Apply/Reveal from the host.** Rejected: the host cannot inject into webview DOM; the button must live in the webview React tree, which is what the child slot provides.

**Autosave dirty buffers before apply.** Rejected (deviation from the original PR plan): the harness applies edits at tool time, so a dirty buffer already diverges from the disk the edit was computed against — saving it would clobber the agent's change, not reconcile with it. Skipping with a warning preserves both sides.

## Consequences

Every diff-bearing call in the VSCode panel now shows Apply/Reveal, and every presented change is pending until accepted or rejected in the editor title menu. The slot ships as part of the web surface but stays empty there; its ui-tool tests pin the owner payload, the mount condition, and disposal. The webview shell bundle externalizes `react`, `react/jsx-runtime`, and `dsh-client-ui-primitives` through the module loader's platform-module table, so the buttons share the single React instance with the app (a second bundled copy would break hooks). Follow-up work: Automode auto-applies diffs instead of gating on Apply, and the pending registry could scope per session instead of per path.
