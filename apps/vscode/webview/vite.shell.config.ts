/**
 * Webview shell-plugin bundle: emits the same closure-factory format as the
 * client preset (packages/client/tsdown.client.ts) — banner opens the
 * __ModuleLoader__.load factory, intro seeds module/exports, cjs output
 * assigns the plugin's name/inject/apply onto exports, footer returns them.
 */
import { defineConfig } from 'vite'

const ID = '@deepseek-ai/dsh-vscode-shell'

export default defineConfig({
  // JSX must compile to the automatic runtime: the classic transform emits
  // `React.createElement` against a global the webview never defines, while
  // the automatic runtime imports react/jsx-runtime — an external the module
  // loader's platform table resolves to the shared React instance.
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: '../webview-dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/shell-plugin.ts',
      formats: ['cjs'],
      fileName: () => 'shell-client.js',
    },
    rollupOptions: {
      // React and the client primitives resolve through the module loader's
      // platform-module table (the same table the client bundles externalize
      // to), so the shell shares their single instance instead of shipping a
      // second copy that would break hooks across two React runtimes.
      external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
      output: {
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
        footer: 'return module.exports; } });',
        intro: 'var module = { exports: {} }; var exports = module.exports;',
      },
    },
  },
})
