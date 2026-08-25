/**
 * Webview shell-plugin bundle: emits the same closure-factory format as the
 * client preset (packages/client/tsdown.client.ts) — banner opens the
 * __ModuleLoader__.load factory, intro seeds module/exports, cjs output
 * assigns the plugin's name/inject/apply onto exports, footer returns them.
 */
import { defineConfig } from 'vite'

const ID = '@deepseek-ai/dsh-vscode-shell'

export default defineConfig({
  build: {
    outDir: '../webview-dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/shell-plugin.ts',
      formats: ['cjs'],
      fileName: () => 'shell-client.js',
    },
    rollupOptions: {
      output: {
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
        footer: 'return module.exports; } });',
        intro: 'var module = { exports: {} }; var exports = module.exports;',
      },
    },
  },
})
