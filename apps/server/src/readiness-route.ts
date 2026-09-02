import type { ServerReadiness } from '@podium/model'
import type { Hono } from 'hono'

/** Public, non-secret lifecycle status. This route stays independent from the
 * setup compatibility route so setup composition can evolve in its owner lane. */
export function registerReadinessRoute(
  app: Hono,
  readiness: () => ServerReadiness,
  instanceId: string,
): void {
  /**
   * The instance id rides along so an instance probing its OWN public URL can
   * tell "my front door works" from "something else answers there" (PDM-26).
   * It is not a secret — /version already publishes it on the same
   * unauthenticated tier — and it names nothing about the work being done here.
   */
  app.get('/readiness', (c) => c.json({ ...readiness(), instanceId }))
  app.get('/setup/mobile', (c) => {
    const status = readiness()
    if (status.dataPlane === 'available') return c.redirect('/')
    const pending = status.state === 'activation_pending'
    const heading = pending
      ? 'Setup is saved; Podium needs to restart'
      : 'Finish setup on the server'
    const body = pending
      ? 'Restart Podium on the server, then retry. No setup changes are needed.'
      : 'This Podium server is online, but it is not ready for other devices yet. On the server, run podium setup, finish access and login choices, then retry here.'
    c.header('cache-control', 'no-store')
    c.header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    )
    return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#16171a;color:#f2f3f5;font:16px/1.55 system-ui,sans-serif}.card{width:min(520px,100%);padding:30px;border:1px solid #34363c;border-radius:16px;background:#1d1f23}.label{color:#d9b477;font:600 11px/1.2 ui-monospace,monospace;letter-spacing:.16em}h1{margin:12px 0;font-size:28px;line-height:1.12}p{margin:0;color:#a8adb6}code{color:#f2f3f5}a{display:inline-block;margin-top:24px;padding:10px 18px;border-radius:9px;background:#d9b477;color:#16171a;font-weight:650;text-decoration:none}</style></head>
<body><main class="card"><div class="label">SERVER NOT READY</div><h1>${heading}</h1><p>${body.replace('podium setup', '<code>podium setup</code>')}</p><a href="/">Retry</a></main></body></html>`)
  })
}
