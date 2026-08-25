/**
 * Static webview bundle manifest: the curated client plugin set composed
 * into a WebBootGraph at panel creation (no build step) — the extension's
 * own dependency closure supplies the bootInjections facade and every
 * lib/client.js bundle. The curated set plus the fix list for unsatisfied
 * services (typert/remote/settingsScope) was derived from each package's
 * dsh.client metadata and cordis inject lists.
 */
import { createRequire } from 'node:module'
import { bootInjections, orderByModuleGraph } from '@deepseek-ai/dsh-client-modules'
import type { WebBootEntry, WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'

/** The webview plugin roster; the shell bundle is built by webview/build.ts. */
const CURATED_CLIENT_IDS = [
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-cordis-client-runner',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-theme',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-trajectory',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-user-questions',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-commands',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-vscode-shell',
] as const

/** One curated bundle: metadata from the package manifest plus its on-disk path. */
export interface CuratedBundle {
  id: string
  /** Absolute path to the built closure-factory bundle (lib/client.js or webview-dist/shell-client.js). */
  bundlePath: string
  /** The package's declared inject list (informational graph metadata). */
  inject: string[]
  /** Stage-one prefetch flag from the package's dsh.client block. */
  immediately: boolean
  /** Content revision; the package version stands in for the bundle hash. */
  rev: string
}

/** dsh.client block shape read from each curated package's manifest. */
interface DshClientMeta {
  inject?: string[]
  immediately?: boolean
}

const require = createRequire(import.meta.url)

/**
 * Resolve every curated bundle's metadata and path. Fails loud on a missing
 * package or bundle: a broken webview manifest must not render a half-booted
 * panel.
 */
export function loadCuratedBundles(shellBundlePath: string): CuratedBundle[] {
  const bundles: CuratedBundle[] = []
  for (const id of CURATED_CLIENT_IDS) {
    if (id === '@deepseek-ai/dsh-vscode-shell') {
      bundles.push({ id, bundlePath: shellBundlePath, inject: ['sessions'], immediately: false, rev: 'shell-1' })
      continue
    }
    const manifest = require(`${id}/package.json`) as { version: string; dsh?: { client?: DshClientMeta } }
    const bundlePath = require.resolve(`${id}/client`)
    bundles.push({
      id,
      bundlePath,
      inject: manifest.dsh?.client?.inject ?? [],
      immediately: manifest.dsh?.client?.immediately ?? false,
      rev: manifest.version,
    })
  }
  return bundles
}

/**
 * Compose the WebBootGraph for one panel: bundle URLs are per-panel webview
 * URIs (each panel has its own vscode-webview origin).
 */
export function composeGraph(bundles: readonly CuratedBundle[], urlOf: (bundle: CuratedBundle) => string): WebBootGraph {
  const entries: WebBootEntry[] = orderByModuleGraph(bundles.map(bundle => ({
    id: bundle.id,
    url: urlOf(bundle),
    rev: bundle.rev,
    inject: bundle.inject,
    immediately: bundle.immediately,
  })))
  return { rev: 'vscode-1', entries }
}

/** The inline queue-facade script text (first bootInjections row). */
export function queueFacadeText(graph: WebBootGraph): string {
  const [facade] = bootInjections(graph)
  if (facade === undefined || facade.kind !== 'script' || 'src' in facade) {
    throw new Error('bootInjections did not produce the queue facade script row')
  }
  return facade.text
}
