# Agent Note: VSCode IDE context and the vscode profile

Status: implemented

English | [中文](2026-08-25-vscode-ide-context-profile.zh.md)

## Problem

The panel gives the agent the interactive surface, but the agent cannot see what the user is looking at — the active file, the selection, the workspace — and a workspace built on the Claude Code ecosystem (CLAUDE.md, `.claude/settings.json` hooks) stays inert. Both must work without touching the API wire: the child is a separate process, and the extension host owns the editor state.

## Decision

The extension host maintains a state file, `$DSH_HOME/vscode/context.json` (`apps/vscode/src/context-feed.ts`): a debounced snapshot of the workspace root, the active editor (path, cursor, selection text capped at 4000 chars), and up to 20 open files, written atomically (temp + rename) so the reader never sees a torn document. The feed home resolves through `resolveDshHome(settings.home, {})` — the same resolver the child uses, with a blank environment so the extension host's own env cannot skew it. A new context plugin, `@deepseek-ai/dsh-vscode-context`, reads the feed during request preparation: a prepended `agent/pre-step` listener on `step === 1`, validating the document at the wire boundary (version, narrowed fields — malformed means warn and skip, never a turn failure), re-injecting only when the rendered state changed since the last durable injection (the same backscan scheduling as tmux-context, so compaction and resume survive), with an optional `refreshIntervalMs` floor. The injected message uses the `snapshot` form (`source: { kind: 'plugin', plugin: 'vscode-context', form: 'snapshot', sections }`).

The extension spawns the child with the workspace root as its cwd and defaults `dsh.profile` to `vscode`, a new shipped profile template (`PROFILE_TEMPLATES.vscode`) composing a third bundle, `@deepseek-ai/dsh-vscode-profile`, over `dsh-base` + `dsh-web-app`. That bundle's patch appends two rows: `vscode-context` and `hooks-claude-code` with `configPath: ./.claude/settings.json` — resolved from the launch cwd, so a workspace's CC hooks file applies verbatim, and a workspace without one registers no hooks. The new bundle packages enter the `apps/cli` dependency closure so profile bundle resolution and the profiles module fallback both see them from the dsh installation.

## Alternatives considered

**Carry editor state over the API wire.** Rejected: a new channel (events, endpoints, or a second stream) would need apiproxy schema, client services, and the trust fence's blessing for state that changes every keystroke; a state file is read once per turn by the plugin that owns the pre-step extension point, with zero wire surface.

**Reuse the `web` profile and mount the plugins in the extension.** Rejected: the child is launched through the profile launcher; plugin composition belongs to the profile, not to the host process that spawns it. The profile is also the one place where CC hook compatibility can be a shipped default without touching the web app's composition.

**Feed the whole open-file set and full selection.** Rejected: caps (4000-char selection, 20 files) keep a keystroke from turning the model-visible prefix into a megabyte; the caps live in the extension-side builder so the file format stays generous.

## Consequences

Model-visible content grows by one reading per changed turn (token and KV-cache effects documented in the package README). The vscode-context plugin is opt-in outside the `vscode` profile, matching the tmux-context posture; its real-Loader e2e (a two-turn headless run with a mock adapter and a seeded feed) pins the assembled injection and the unchanged-state suppression. The hook bridge keeps its process-level config limitation: switching workspaces needs a child restart. Follow-up work: per-session hook config discovery (`TODO(per-session-hook-config)` in hooks-claude-code) and multi-root workspace feeds.
