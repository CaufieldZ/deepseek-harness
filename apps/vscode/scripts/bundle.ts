/**
 * Extension package build: bundles the extension entry (tsc's lib/types
 * output) into one self-contained CJS file and stages the curated client
 * bundles beside it. A packaged vsix has no node_modules, so the runtime
 * falls back from require.resolve to the staged `curated/` copies (see
 * manifest.ts); `vscode` stays external — the extension host provides it.
 * Run from the package root after `tsc -b` (the repo build orders this).
 */
import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { CURATED_CLIENT_IDS } from '../src/manifest.ts'

const SHELL_ID = '@deepseek-ai/dsh-vscode-shell'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)

/** Staged metadata shape the runtime reads beside the curated copies. */
interface StagedMeta {
  version: string
  inject: string[]
  immediately: boolean
}

async function main(): Promise<void> {
  const entry = join(root, 'lib/types/src/extension.js')
  if (!existsSync(entry)) {
    throw new Error('lib/types/src/extension.js is missing — run `tsc -b` first')
  }
  const outfile = join(root, 'lib/extension.cjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2024',
    // The only runtime-provided module: the extension host injects it.
    external: ['vscode'],
    // CJS output replaces import.meta with an empty object; the manifest's
    // createRequire(import.meta.url) needs the real bundle location instead.
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(outfile).href) },
    sourcemap: false,
    logLevel: 'info',
  })

  // The packaged smoke test runs inside the VS Code test host (no tsx), so it
  // bundles the same way; `vscode` stays external there too.
  const smokeEntry = join(root, 'tests/e2e/smoke.ts')
  const smokeOut = join(root, 'lib/e2e/smoke.cjs')
  mkdirSync(dirname(smokeOut), { recursive: true })
  await build({
    entryPoints: [smokeEntry],
    outfile: smokeOut,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2024',
    external: ['vscode'],
    sourcemap: false,
    logLevel: 'warning',
  })

  const curatedDir = join(root, 'curated')
  rmSync(curatedDir, { recursive: true, force: true })
  mkdirSync(curatedDir, { recursive: true })
  const staged: Record<string, StagedMeta> = {}
  for (const id of CURATED_CLIENT_IDS) {
    if (id === SHELL_ID) continue
    const manifest = require(`${id}/package.json`) as { version: string; dsh?: { client?: { inject?: string[]; immediately?: boolean } } }
    const source = require.resolve(`${id}/client`)
    const dest = join(curatedDir, id, 'client.js')
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(source, dest)
    staged[id] = {
      version: manifest.version,
      inject: manifest.dsh?.client?.inject ?? [],
      immediately: manifest.dsh?.client?.immediately ?? false,
    }
  }
  writeFileSync(join(curatedDir, 'manifest.json'), JSON.stringify(staged, null, 2))
  console.log(`staged ${Object.keys(staged).length} curated bundles under ${curatedDir}`)
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
