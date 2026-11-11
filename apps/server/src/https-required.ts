import { HTTPS_SIGN_IN_DOCS_URL, type HttpsRequiredRefusal, signInHttpsUrl } from '@podium/protocol'
import type { Hono } from 'hono'
import { html } from 'hono/html'
import { type MemberOfRequest, refusalAnswer } from './identity/member-of-request'

/** A document works even when an HTTP browser cannot start the app's secure APIs. */
export function httpsRequiredPage(guidance: HttpsRequiredRefusal) {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>HTTPS required · Podium</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#0a0a0e;color:#f3f3f8}
body{margin:0;min-height:100svh;display:grid;place-items:center;box-sizing:border-box;padding:28px}
main{width:100%;max-width:620px} .brand{letter-spacing:.18em;font-size:13px;color:#b7b7c5}
.label{color:#d97757;font:12px ui-monospace,monospace;letter-spacing:.1em;margin-top:48px}
h1{font-size:clamp(30px,5vw,44px);line-height:1.15;margin:14px 0 24px;letter-spacing:-.03em}
p{font-size:16px;line-height:1.7;color:#b7b7c5;overflow-wrap:anywhere}
a{color:#f0a88f;text-underline-offset:4px;overflow-wrap:anywhere}
.action{display:inline-block;background:#d97757;color:#27130c;padding:13px 18px;border-radius:9px;text-decoration:none;font-weight:650;margin:8px 0 18px}
aside{margin-top:26px;padding-top:18px;border-top:1px solid #30303b} h2{font-size:16px;font-weight:600}
code{color:#f3f3f8} a:focus-visible{outline:2px solid #f0a88f;outline-offset:5px}
</style></head><body><main>
<div class="brand">PODIUM</div><div class="label">SECURE CONNECTION REQUIRED</div>
<h1>Connect with HTTPS</h1><p>${guidance.message}</p>
${guidance.httpsUrl ? html`<a class="action" href="${guidance.httpsUrl}">Open HTTPS address →</a><p>${guidance.httpsUrl}</p>` : ''}
<aside><h2>Set up HTTPS</h2><p><a href="${guidance.docsUrl}">HTTPS setup instructions</a></p></aside>
</main></body></html>`
}

/** Register after API routes and before mobile redirects or the SPA catch-all. */
export function registerHttpsRequiredPage(app: Hono, memberOfRequest: MemberOfRequest): void {
  app.use('*', async (c, next) => {
    const path = c.req.path
    const document =
      ['/', '/desktop', '/mobile', '/index.html', '/mobile/index.html'].includes(path) ||
      c.req.header('sec-fetch-mode') === 'navigate' ||
      c.req.header('accept')?.includes('text/html')
    const facts = memberOfRequest.factsOf(c.req.raw)
    if (
      (c.req.method === 'GET' || c.req.method === 'HEAD') &&
      document &&
      facts.scheme === 'http' &&
      !facts.sameMachine
    ) {
      const resolution = await memberOfRequest(c.req.raw)
      if (resolution.kind === 'https_required') {
        const { body } = refusalAnswer(resolution)
        if ('message' in body) {
          c.header('cache-control', 'no-store')
          c.header(
            'content-security-policy',
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          )
          c.header('referrer-policy', 'no-referrer')
          return c.html(await httpsRequiredPage(body), 400)
        }
      }
    }
    await next()
  })
}

export function httpsSignInWarning(opts: {
  loopback: boolean
  tls: boolean
  trustedProxyHops: number
  publicUrl?: string
}): string | undefined {
  if (opts.loopback || opts.tls || (opts.trustedProxyHops > 0 && signInHttpsUrl(opts.publicUrl)))
    return undefined
  return (
    'People on other computers will not be able to sign in until HTTPS is set up. Run podium setup to configure HTTPS with Tailscale Serve or a reverse proxy. See ' +
    HTTPS_SIGN_IN_DOCS_URL
  )
}
