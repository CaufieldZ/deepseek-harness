/**
 * Panel HTML assembly: the vite-built webview page plus the runtime boot
 * injections (queue facade, __DSH_BOOT__, bundle script tags) under a
 * default-src 'none' CSP with nonce-only inline scripts. Pure function of
 * its inputs so the CSP and injection invariants are unit-testable.
 */

export interface PanelHtmlInputs {
  /** The built webview-dist/index.html content (vite base './'). */
  appHtml: string
  /** CSP source string for this panel (panel.webview.cspSource). */
  cspSource: string
  /** One-time nonce covering every inline script. */
  nonce: string
  /** The inline queue-facade script text. */
  facadeScript: string
  /** The __DSH_BOOT__ graph JSON. */
  bootJson: string
  /** The session the shell plugin focuses on boot. */
  sessionId: string
  /** Bundle script srcs (webview URIs) in graph order. */
  bundleSrcs: readonly string[]
  /** Webview URI prefix of the built webview-dist/ directory (trailing slash). */
  assetsBase: string
}

/** Escape one HTML attribute value for the CSP meta tag. */
function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/** JSON text safe inside a script element: `</script>` would end it early. */
function scriptText(json: string): string {
  return json.replaceAll('</script>', '<\\/script>')
}

/**
 * Build the final panel HTML: CSP meta, head injections (facade, boot graph,
 * every bundle script), then the app HTML with its ./assets/ references
 * rewritten to this panel's webview URIs.
 */
export function buildPanelHtml(inputs: PanelHtmlInputs): string {
  // style-src keeps 'unsafe-inline': client plugins inject their stylesheets
  // as runtime <style> elements (ui-theme) and the strict script-src nonce
  // policy is what carries the XSS defense.
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${inputs.nonce}' ${inputs.cspSource}`,
    `style-src ${inputs.cspSource} 'unsafe-inline'`,
    `font-src ${inputs.cspSource}`,
    `img-src ${inputs.cspSource} data:`,
    "connect-src 'none'",
  ].join('; ')
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`
  const bootScripts = [
    `<script nonce="${inputs.nonce}">${inputs.facadeScript}</script>`,
    `<script nonce="${inputs.nonce}">globalThis["__DSH_BOOT__"] = ${scriptText(inputs.bootJson)};</script>`,
    `<script nonce="${inputs.nonce}">globalThis["__DSH_SESSION_ID__"] = ${scriptText(JSON.stringify(inputs.sessionId))};</script>`,
    ...inputs.bundleSrcs.map(src => `<script src="${escapeAttribute(src)}"></script>`),
  ].join('\n    ')
  const headInjection = `${meta}\n    ${bootScripts}`
  const appHtml = inputs.appHtml.replaceAll('./assets/', `${inputs.assetsBase}assets/`)
  // Inject after <head> and after <body> per the webserver's injection convention.
  return appHtml
    .replace('<head>', `<head>\n    ${headInjection}`)
    .replace('<body>', '<body>\n    ')
}
