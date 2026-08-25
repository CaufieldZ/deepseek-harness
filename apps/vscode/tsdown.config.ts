import { defineConfig } from 'tsdown'

/**
 * The extension ships one entry: the `main` referenced by package.json.
 * The root tsdown workspace build defaults to `lib/types/index.js`, so this
 * override points at `lib/types/extension.js` instead; its reachable modules
 * bundle with it. Declarations come from `tsc -b` (dts: false), matching
 * apps/cli.
 */
export default defineConfig({
  entry: ['lib/types/extension.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
