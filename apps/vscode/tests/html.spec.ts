/**
 * Panel HTML assembly unit tests: the CSP meta, the nonce coverage of every
 * inline script, the boot-global and deep-link injections, the bundle script
 * order, and the attribute/script-text escaping are all pure functions of the
 * inputs, so they are pinned here without a webview.
 */
import { describe, expect, it } from 'vitest'
import { buildPanelHtml, type PanelHtmlInputs } from '../src/panels/html.ts'

const APP_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>dsh</title>
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-def.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`

function build(overrides: Partial<PanelHtmlInputs> = {}): string {
  return buildPanelHtml({
    appHtml: APP_HTML,
    cspSource: 'https://file+.vscode-resource.test',
    nonce: 'n-1',
    facadeScript: 'window.__ModuleLoader__={load(){}}',
    bootJson: '{"rev":"vscode-1","entries":[]}',
    sessionId: 's-1',
    bundleSrcs: ['https://file+.vscode-resource.test/b/a.js', 'https://file+.vscode-resource.test/b/b.js'],
    assetsBase: 'https://file+.vscode-resource.test/webview-dist/',
    ...overrides,
  })
}

describe('buildPanelHtml', () => {
  it('locks the CSP to the panel nonce and cspSource and keeps the network closed', () => {
    const html = build()
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("script-src 'nonce-n-1' https://file+.vscode-resource.test")
    expect(html).toContain("style-src https://file+.vscode-resource.test 'unsafe-inline'")
    expect(html).toContain("connect-src 'none'")
  })

  it('covers every inline script with the nonce and loads every bundle by src', () => {
    const html = build()
    expect(html.match(/<script nonce="n-1">/g)).toHaveLength(3)
    // The app's own module script is external (vite) and carries no nonce:
    // the cspSource grants it instead.
    expect(html).toContain('<script type="module" crossorigin src="https://file+.vscode-resource.test/webview-dist/assets/index-abc.js"></script>')
    expect(html).toContain('<script src="https://file+.vscode-resource.test/b/a.js"></script>')
    expect(html).toContain('<script src="https://file+.vscode-resource.test/b/b.js"></script>')
    // No inline script escapes the nonce.
    expect(html.match(/<script(?![^>]*\bnonce=)(?![^>]*\bsrc=)/g)).toBeNull()
  })

  it('injects the facade, the boot graph, and the session deep link before the bundles', () => {
    const html = build()
    const facade = html.indexOf('window.__ModuleLoader__={load(){}}')
    const boot = html.indexOf('globalThis["__DSH_BOOT__"] = {"rev":"vscode-1","entries":[]};')
    const session = html.indexOf('globalThis["__DSH_SESSION_ID__"] = "s-1";')
    const firstBundle = html.indexOf('https://file+.vscode-resource.test/b/a.js')
    expect(facade).toBeGreaterThan(-1)
    expect(boot).toBeGreaterThan(facade)
    expect(session).toBeGreaterThan(boot)
    expect(firstBundle).toBeGreaterThan(session)
  })

  it('escapes CSP and bundle attributes', () => {
    const html = build({
      cspSource: 'https://x.test/"&<',
      bundleSrcs: ['https://x.test/a.js?x=<&"'],
    })
    expect(html).toContain('https://x.test/&quot;&amp;&lt;')
    expect(html).toContain('https://x.test/a.js?x=&lt;&amp;&quot;')
  })

  it('escapes the session id and boot json against script termination', () => {
    const html = build({
      sessionId: 's</script><script>alert(1)',
      bootJson: '{"rev":"a</script>b","entries":[]}',
    })
    expect(html).not.toContain('</script><script>alert(1)')
    expect(html).toContain('"a<\\/script>b"')
    expect(html).toContain('"s<\\/script><script>alert(1)"')
  })
})
