/**
 * vsix assembly: the workspace name (@deepseek-ai/dsh-vscode) violates the
 * extension-name grammar (no scope, no slash), so vsce packages a staged
 * copy whose package.json carries the legal `dsh-vscode` name. Everything
 * the vsix ships — the bundled entry, the webview build, the staged curated
 * bundles, the icon, and the README — is copied from the package root; the
 * staged manifest keeps only the fields vsce validates. The result lands at
 * `apps/vscode/dsh-vscode-<version>.vsix`. Run after scripts/bundle.ts.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const stage = join(root, '.package-tmp')

/** The extension manifest fields vsce validates; `name` is rewritten to the legal form. */
interface VsceManifest {
  name: string
  version: string
  publisher: string
  engines: Record<string, string>
  main: string
  activationEvents: string[]
  contributes: unknown
  files: string[]
  icon?: string
  repository?: unknown
  description: string
  license: string
}

function main(): void {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown> & VsceManifest
  const staged: VsceManifest = {
    name: 'dsh-vscode',
    version: manifest.version,
    publisher: manifest.publisher,
    engines: manifest.engines,
    main: manifest.main,
    activationEvents: manifest.activationEvents,
    contributes: manifest.contributes,
    files: manifest.files,
    description: manifest.description,
    license: manifest.license,
    ...(manifest.icon === undefined ? {} : { icon: manifest.icon }),
    ...(manifest.repository === undefined ? {} : { repository: manifest.repository }),
  }
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  for (const source of ['lib/extension.cjs', 'webview-dist', 'curated', 'media', 'README.md', 'README.zh.md']) {
    if (!existsSync(join(root, source))) throw new Error(`missing package input: ${source} (run scripts/bundle.ts and the webview build first)`)
    cpSync(join(root, source), join(stage, source), { recursive: true })
  }
  writeFileSync(join(stage, 'package.json'), JSON.stringify(staged, null, 2))
  // The staged copy has no node_modules, so pin the vsce binary from the
  // package root's install.
  const vsce = join(root, 'node_modules/.bin/vsce')
  const result = spawnSync(vsce, ['package', '--no-dependencies', '--out', join(root, `dsh-vscode-${manifest.version}.vsix`)], {
    cwd: stage,
    stdio: 'inherit',
    env: process.env,
  })
  rmSync(stage, { recursive: true, force: true })
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
    return
  }
  console.log(`packaged ${join(root, `dsh-vscode-${manifest.version}.vsix`)}`)
}

main()
