/**
 * Packaged-extension smoke: downloads a pinned VS Code build and runs
 * tests/e2e/smoke.ts (bundled to lib/e2e/smoke.cjs by scripts/bundle.ts)
 * inside the test host with the package root on the development path — the
 * extension host then loads exactly the packaged entry (package.json `main`,
 * lib/extension.cjs, with the staged curated-bundle fallback). Before that,
 * the vsix content is asserted: the archive must carry the bundled entry,
 * the staged curated manifest, and the webview build. Usage:
 * `tsx scripts/smoke.ts <path-to-vsix>`; HTTP(S)_PROXY env entries are
 * honored by the VS Code download.
 *
 * The Electron binary rejects the CLI-shim install flags
 * (`--install-extension`, `--extensions-dir`), so installation is verified
 * by content assertion instead of host-side install.
 */
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

async function main(): Promise<void> {
  const vsix = process.argv[2]
  if (vsix === undefined) throw new Error('usage: tsx scripts/smoke.ts <path-to-vsix>')
  const vsixPath = resolve(vsix)
  if (!existsSync(vsixPath)) throw new Error(`vsix not found: ${vsixPath}`)
  const smokePath = join(root, 'lib/e2e/smoke.cjs')
  if (!existsSync(smokePath)) throw new Error('lib/e2e/smoke.cjs is missing — run scripts/bundle.ts first')

  const members = execFileSync('unzip', ['-Z1', vsixPath], { encoding: 'utf8' })
  const required = [
    'extension/lib/extension.cjs',
    'extension/curated/manifest.json',
    'extension/webview-dist/index.html',
    'extension/webview-dist/shell-client.js',
  ]
  const missing = required.filter(member => !members.includes(member))
  if (missing.length > 0) throw new Error(`vsix is missing members: ${missing.join(', ')}`)

  // The downloaded macOS build's Electron binary rejects every VS Code CLI
  // flag; the app's own CLI shim (Resources/app/bin/code) parses them and
  // launches the real binary, so the test host runs through it.
  const electronPath = await downloadAndUnzipVSCode('1.100.0')
  const vscodeExecutablePath = join(dirname(electronPath), '..', 'Resources', 'app', 'bin', 'code')
  const exitCode = await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: smokePath,
    launchArgs: ['--skip-welcome'],
  })
  if (exitCode !== 0) {
    process.exitCode = exitCode
    console.error(`smoke failed with exit code ${exitCode}`)
    return
  }
  console.log(`smoke OK for ${vsixPath}`)
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
