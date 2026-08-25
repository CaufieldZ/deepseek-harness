/**
 * Webview application build: bundles main.ts over the assembled client
 * application into webview-dist. The host injects the module-loader facade,
 * __DSH_BOOT__, and the plugin bundle scripts at panel-render time, so the
 * built index.html stays injection-free (the same split apps/web has).
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { clientBuildEnvironmentDefines } from '../../../scripts/client-build-environment.ts'

export default defineConfig({
  base: './',
  define: {
    ...clientBuildEnvironmentDefines(process.env),
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    'process.env.CORDIS_SHARED': 'undefined',
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      'node:module': fileURLToPath(new URL('../../../apps/web/src/node-module-stub.ts', import.meta.url)),
    },
  },
  build: {
    outDir: '../webview-dist',
    emptyOutDir: true,
  },
})
