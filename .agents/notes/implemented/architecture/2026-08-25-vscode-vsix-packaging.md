# Agent Note: VSCode vsix packaging and the packaged smoke test

Status: implemented

English | [中文](2026-08-25-vscode-vsix-packaging.zh.md)

## Problem

The extension runs from source (F5), but the user installs a vsix. A packaged extension has no node_modules, so two runtime assumptions break: the tsdown ESM entry is not the CJS module the extension host loads, and `loadCuratedBundles` resolves the 22 client bundles through `require.resolve`. The workspace name (`@deepseek-ai/dsh-vscode`) also violates the extension-manifest name grammar, which vsce enforces.

## Decision

`scripts/bundle.ts` bundles the tsc output (`lib/types/src/extension.js`) into one self-contained CJS file with esbuild — `vscode` is the only external (the host injects it), `import.meta.url` is defined to the bundle location so the manifest's `createRequire` still gets a real path, and ws's optional native requires stay inside their try/catch (pure-JS fallback). The same script stages the 22 curated client bundles under `curated/<id>/client.js` plus a `curated/manifest.json` carrying each package's `dsh.client` metadata (inject/version/immediately), and bundles the packaged smoke test to `lib/e2e/smoke.cjs`. `loadCuratedBundles` keeps two tiers: `require.resolve` in development, and the staged copies + staged metadata when node_modules is absent — a failed resolve falls through to the staged tier, which fails loud if anything is missing.

`scripts/package.ts` assembles the vsix from a staged copy: vsce validates the manifest, and the workspace name is illegal there, so the script rewrites `name` to `dsh-vscode` in the staged `package.json` (the workspace manifest keeps `@deepseek-ai/dsh-vscode`, which the workspace constraints require). `package.json` ships with empty `dependencies` — everything the extension needs at runtime is inside `extension.cjs` or the staged assets — and `files` pins the payload (`lib/extension.cjs`, `webview-dist`, `curated`, `media`, `README.md`), which the workspace-constraints `appPackageFiles` table mirrors.

The packaged smoke (`scripts/smoke.ts` + `tests/e2e/smoke.ts`) runs inside a downloaded VS Code build through `@vscode/test-electron` with the package root on the development path — the host loads exactly the packaged entry (`lib/extension.cjs` with the staged-curated fallback) — and asserts activation plus the command surface; the vsix itself is verified by content assertion (`unzip -Z1` must list the bundled entry, the staged curated manifest, and the webview build). Two environment facts shaped it: the download is pinned to `1.100.0` (the engines floor; newer stable macOS builds replaced the Electron entry with a launcher), and the test host runs through the app's own CLI shim (`Resources/app/bin/code`) because the Electron binary rejects every VS Code CLI flag on macOS — including `--install-extension`, which is why installation is asserted rather than performed host-side. CI gets a dedicated `vscode-package` job — typecheck, webview build, bundle, package, smoke, vsix artifact — joined into the `all-checks-passed` verdict.

## Alternatives considered

**Ship `node_modules` inside the vsix.** Rejected: vsce resolves production dependencies through the package manager, and `workspace:^` protocol dependencies have no registry version to install; bundling removes the whole class.

**Rename the workspace package to a legal extension name.** Rejected: the workspace constraints require the `@deepseek-ai/` prefix for app packages, and the monorepo references the name in constraints and fixtures.

**Smoke against the latest stable VS Code.** Rejected: the current stable's macOS launcher rejects `--install-extension`/test-host flags; pinning to the engines floor is deterministic and matches the supported minimum.

## Consequences

`pnpm --filter @deepseek-ai/dsh-vscode run build:bundle && pnpm --dir apps/vscode exec tsx scripts/package.ts` produces `apps/vscode/dsh-vscode-<version>.vsix`, installable with `code --install-extension`. The bundle duplicates the client packages' code inside the extension (~770KB) instead of sharing the store; staged bundles refresh only on `build:bundle`, so a dev-mode panel reads node_modules and the packaged panel reads the staged copies — the two-tier resolution keeps both fresh in their own lifecycle. Follow-up work: version the staged manifest against the bundle build, and drive the smoke from `vsce ls` output instead of a re-listing.
