# Agent Note: VSCode webview panel boot

Status: implemented

English | [中文](2026-08-25-vscode-webview-panel-boot.zh.md)

## Problem

The extension host relays the harness API over a MessagePort carrier, but the webview needs the whole interactive client application — the assembled plugin graph, the bundle transport, the boot protocol, and a per-panel session deep link — and it must work without HTTP: the webview's origin can never pass the /api trust fence, and the CSP must keep `connect-src 'none'`.

## Decision

Each session panel renders one HTML document that replays the served web app's boot protocol: the inline queue facade (`bootInjections`), the `__DSH_BOOT__` graph, a deep-link global, then one blocking classic `<script>` per curated bundle in graph order. Because every bundle is pre-registered, the module system never fetches on demand — `loadBundle` stays absent and the on-demand path (a script element against a webview URI) is unreachable; this is the invariant the assembled snapshot pins. The bundle set is curated to 22 entries (`CURATED_CLIENT_IDS` plus the extension's own shell bundle, built by `webview/build.ts` into the closure-factory format): the full client UI minus the web-only surfaces — the sidebar is replaced by the activity-bar session tree, and `ui-trajectory` stays because it owns the `conversation.view` slot. The webview transport sets `__DSH_TRANSPORT__` to the MessagePort client; the `?fixture` URL mode of the connection plugin still wins, which gives the snapshot lane a keyless in-browser host. The per-panel session deep link rides a host-injected `__DSH_SESSION_ID__` global (a webview URL has no query string), and the shell plugin unsubscribes from the session list before calling `open` — `open` mutates the list store synchronously, and a still-subscribed listener would re-enter forever. Panel restoration after window reload re-applies the webview options and re-reads the session id from the webview-persisted state (`acquireVsCodeApi().setState`).

## Alternatives considered

**Ship the full web bundle set (37 packages).** Rejected for this milestone: the sidebar and the web-only settings surfaces double the panel payload and duplicate the activity-bar tree; the curated set is one file (`CURATED_CLIENT_IDS`) and the assembled snapshot fails loudly when an entry is missing or a service goes unsatisfied.

**Give the webview an on-demand `loadBundle` seam over postMessage.** Rejected: script-tag preloading is what the served app's module system already guarantees, the CSP then needs no bundle-fetch channel, and the all-preloaded invariant is snapshot-testable.

**Deep-link sessions through `location.search`.** Rejected: a webview document URL carries no query string, so the session id must arrive as an injected global.

## Consequences

The panel HTML is a pure function (`buildPanelHtml`) with a strict CSP (`default-src 'none'`, script nonce, `connect-src 'none'`, inline styles kept for runtime-injected `<style>` tags) — unit-tested for nonce coverage, escaping, and injection order. `ui-trajectory`'s virtualization keeps the DOM window small, so snapshot assertions target row presence rather than early turns. The root `pnpm run build` now produces `webview-dist/` (wired as `build:vscode-webview`), which the snapshot lane and the F5 flow both depend on. Follow-up changes add diff apply/accept, Automode, and the `vscode` IDE-context profile.
