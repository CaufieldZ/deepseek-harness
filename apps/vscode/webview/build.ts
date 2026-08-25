/** Webview build: the application bundle plus the shell-plugin client bundle. */
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

// Programmatic build() defaults root to the process cwd; pin it to this
// directory so both configs resolve their entries relative to the webview.
const root = fileURLToPath(new URL('.', import.meta.url))

await build({ configFile: new URL('./vite.config.ts', import.meta.url).pathname, root })
await build({ configFile: new URL('./vite.shell.config.ts', import.meta.url).pathname, root })
