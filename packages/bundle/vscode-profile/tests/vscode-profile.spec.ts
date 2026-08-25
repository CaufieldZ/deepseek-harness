/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list carrying the IDE-context and
 * hook-bridge rows.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('dsh-vscode-profile bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patchPath = resolve(root, manifest.dsh!.bundle!.patch!)
    expect(existsSync(patchPath)).toBe(true)
    const parsed = yaml.load(
      readFileSync(patchPath, 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    const rows = (parsed as { insert?: { id?: string; name?: string; config?: Record<string, unknown> }[] }[]).flatMap(
      patch => patch.insert ?? [],
    )
    expect(rows).toEqual([
      { id: 'vscode-context', name: '@deepseek-ai/dsh-vscode-context' },
      {
        id: 'hooks-claude-code',
        name: '@deepseek-ai/dsh-hooks-claude-code',
        config: { configPath: './.claude/settings.json' },
      },
    ])
    // Every inserted row's package is a declared dependency, so the bundle's
    // patch is resolvable from the installation it ships with.
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-vscode-context')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-hooks-claude-code')
  })
})
