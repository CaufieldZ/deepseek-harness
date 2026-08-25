#!/usr/bin/env node
/** Test driver that sends two turns through one Headless Loader composition with a static IDE feed. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('vscode-context driver requires a config path')

const ctx = await boot('vscode-context-e2e', resolveConfigPath(configPath, undefined))
try {
  await runFixtureTurn(ctx, { task: 'first' })
  await runFixtureTurn(ctx, { task: 'second' })
} finally {
  await ctx.fiber.dispose()
}
