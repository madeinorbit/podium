import { loadConfig, needsSetup } from '@podium/core/config'
import type { Hono } from 'hono'

/**
 * Read-only setup status. The web SetupGate + desktop shell probe this to decide whether to
 * show onboarding. WRITES go through the `setup.*` tRPC procedures (complete / join / connect)
 * — one authenticated surface for every setup mutation — so there is no POST here.
 */
export function registerSetupRoute(app: Hono): void {
  app.get('/setup/config', (c) => {
    const config = loadConfig()
    return c.json({ config, needsSetup: needsSetup(config) })
  })
}
