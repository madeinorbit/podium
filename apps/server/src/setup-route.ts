import { loadConfig, needsSetup } from '@podium/runtime/config'
import type { Hono } from 'hono'

/**
 * Read-only setup status. The web SetupGate + desktop shell probe this to decide whether to
 * show onboarding. WRITES go through the `setup.*` tRPC procedures (complete / join / connect)
 * — one authenticated surface for every setup mutation — so there is no POST here.
 *
 * SECURITY: this route is unauthenticated by design (it must answer before login exists), so
 * it must never echo the config back. The config can hold credentials — `upstream.token` (a
 * hub-minted long-lived client-session token) and `pairCode` — which would otherwise be
 * readable by anyone who can reach the URL. Only the setup-gating fields leave this route;
 * authenticated readers use the `setup.info` tRPC procedure.
 */
export function registerSetupRoute(app: Hono): void {
  app.get('/setup/config', (c) => {
    const config = loadConfig()
    return c.json({ needsSetup: needsSetup(config), mode: config.mode ?? null })
  })
}
