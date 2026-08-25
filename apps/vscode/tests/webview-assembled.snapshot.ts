// @vitest-environment jsdom
// Keyless assembled-webview snapshot: the real built client bundles booted the
// way a panel boots them — the queue facade, __DSH_BOOT__, the deep-link
// global, then every curated bundle as one blocking classic script (the panel
// HTML renders one <script src> per bundle; there is no loadBundle seam, so a
// missing bundle cannot hide behind an on-demand fetch). The fixture URL mode
// selects the keyless FixtureApiClient, so nothing reaches a host process or a
// model; the transport persistence call and the deep-link focus prove the
// vscode-specific wiring, and the rendered conversation proves the curated
// graph assembles and activates.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { composeGraph, loadCuratedBundles, queueFacadeText } from '../src/manifest.ts'

/** The shell bundle ships with the extension (built by webview/build.ts). */
const SHELL_BUNDLE = resolve(import.meta.dirname, '../webview-dist/shell-client.js')

/** The panel's render inputs, reproduced here so the snapshot owns them. */
function panelBootInputs(): { codes: readonly string[]; graphText: string } {
  const bundles = loadCuratedBundles(SHELL_BUNDLE)
  const graph = composeGraph(bundles, bundle => bundle.bundlePath)
  const facade = queueFacadeText(graph)
  return {
    codes: [facade, ...bundles.map(bundle => readFileSync(bundle.bundlePath, 'utf8'))],
    graphText: JSON.stringify(graph),
  }
}

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

class EventSourceStub {
  addEventListener(): void {}
  close(): void {}
}

interface PostMessageStub {
  postMessage(message: unknown): void
  setState(state: unknown): void
}

let stateCalls: unknown[]
let main: typeof import('../webview/src/main.ts') | undefined

beforeEach(() => {
  stateCalls = []
  localStorage.clear()
  Object.defineProperty(navigator, 'languages', { value: ['en-US'], configurable: true })
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('EventSource', EventSourceStub)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => { callback(0) }, 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { clearTimeout(id) })
  vi.stubGlobal('acquireVsCodeApi', () => {
    const stub: PostMessageStub = {
      postMessage: () => {},
      setState: (state) => { stateCalls.push(state) },
    }
    return stub
  })
})

afterEach(async () => {
  await act(async () => { await main?.appEntry.dispose() })
  main = undefined
  cleanup()
  document.body.innerHTML = ''
  document.head.querySelectorAll('style[data-plugin]').forEach((style) => { style.remove() })
  history.replaceState(null, '', '/')
  const ownNavigator = navigator as unknown as Record<string, unknown>
  delete ownNavigator.languages
  delete ownNavigator.language
  vi.unstubAllGlobals()
})

it('boots the panel graph from script registrations and focuses the injected session', async () => {
  const { codes, graphText } = panelBootInputs()
  // The fixture URL selects the keyless in-browser host (the connection bundle
  // reads it at materialization time).
  history.replaceState(null, '', '/?fixture')
  // Panel HTML execution order: facade, boot graph, deep-link global, bundles.
  const [facadeCode, ...bundleCodes] = codes
  if (facadeCode === undefined) throw new Error('panel boot inputs: missing queue facade script')
  ;(0, eval)(facadeCode)
  ;(globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ = JSON.parse(graphText) as unknown
  ;(globalThis as { __DSH_SESSION_ID__?: unknown }).__DSH_SESSION_ID__ = 'fx-alpha'
  for (const code of bundleCodes) (0, eval)(code)

  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
  main = await import('../webview/src/main.ts')

  // The header of fx-alpha renders only when the shell plugin opened it: the
  // deep link is the sole open() caller in a fresh boot.
  await screen.findByText('Fixture 历史会话', {}, { timeout: 20_000 })
  // The trajectory flow renders history rows for the open session (the
  // virtualizer keeps only a window in the DOM; assert on row presence, not a
  // specific early turn).
  await waitFor(() => {
    expect(document.querySelectorAll('[data-chat-flow-kind]').length).toBeGreaterThan(0)
  }, { timeout: 20_000 })

  // The transport persisted the panel state the reload serializer restores.
  expect(stateCalls).toEqual([{ sessionId: 'fx-alpha' }])

  // Every plugin injected its stylesheet through the loader's CSS path.
  const styleOwners = [...new Set([...document.head.querySelectorAll('style[data-plugin]')]
    .map(style => style.getAttribute('data-plugin'))
    .filter((owner): owner is string => owner !== null))]
    .sort()
  for (const plugin of ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-tool']) {
    expect(styleOwners).toContain(plugin)
  }

  expect({
    graph: (JSON.parse(graphText) as { entries: { id: string; rev: string }[] }).entries
      .map(entry => `${entry.id} @ ${entry.rev}`),
    stateCalls,
    sessionHeader: 'Fixture 历史会话',
    chatFlowRows: document.querySelectorAll('[data-chat-flow-kind]').length > 0,
    styleOwners,
  }).toMatchInlineSnapshot(`
    {
      "chatFlowRows": true,
      "graph": [
        "@deepseek-ai/dsh-client-modules @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-client-runtime @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-client-connection @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-typert-registry @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-api-gateway @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-api-remotes @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-cordis-client-runner @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-client-locale @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-client-ui-theme @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-client-ui-layout @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-client-ui-renderer @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-client-ui-conversation @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-client-ui-trajectory @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-client-ui-attachment @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-client-ui-tool @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-client-ui-plan @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-client-ui-user-questions @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-client-ui-model-selection @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-client-ui-commands @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-client-ui-input-trigger @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-client-ui-settings @ 0.1.1-rc.2",
        "@deepseek-ai/dsh-vscode-shell @ shell-1",
      ],
      "sessionHeader": "Fixture 历史会话",
      "stateCalls": [
        {
          "sessionId": "fx-alpha",
        },
      ],
      "styleOwners": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-attachment",
        "@deepseek-ai/dsh-client-ui-commands",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-input-trigger",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-model-selection",
        "@deepseek-ai/dsh-client-ui-plan",
        "@deepseek-ai/dsh-client-ui-theme",
        "@deepseek-ai/dsh-client-ui-tool",
        "@deepseek-ai/dsh-client-ui-trajectory",
        "@deepseek-ai/dsh-client-ui-user-questions",
      ],
    }
  `)
})
