import type { ServerReadiness } from '@podium/model'
import { loadConfig } from '@podium/runtime/config'
import type { Hono } from 'hono'

/**
 * Read-only setup status. The web SetupGate + desktop shell probe this to decide whether to
 * show onboarding. WRITES go through the `setup.*` tRPC procedures (complete / join / connect)
 * — one authenticated surface for every setup mutation — so there is no POST here.
 *
 * SECURITY: this route is unauthenticated by design (it must answer before login exists), so
 * it must never echo the config back. The config can hold credentials — `upstream.token` (a
 * hub-minted long-lived client-session token) and `pairCode` — which would otherwise be
 * readable by anyone who can reach the URL. Only setup-gating fields leave this route;
 * authenticated readers use the `setup.info` tRPC procedure. The local launcher capability
 * is transport metadata, deliberately separate from the shared readiness state.
 */
export function registerSetupRoute(
  app: Hono,
  opts: { readiness: () => ServerReadiness; localSetupDefault?: boolean },
): void {
  app.get('/setup/config', (c) => {
    const config = loadConfig()
    const readiness = opts.readiness()
    const required = readiness.state === 'unconfigured' || readiness.state === 'activation_pending'
    if (readiness.state === 'unconfigured' && opts.localSetupDefault === true) {
      c.header('X-Podium-Local-Setup', 'all-in-one')
    }
    return c.json({
      needsSetup: required,
      mode: config.mode ?? null,
      state: readiness.state,
      reason: readiness.reason,
      dataPlane: readiness.dataPlane,
    })
  })
}
