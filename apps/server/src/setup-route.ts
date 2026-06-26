import {
  loadConfig,
  needsSetup,
  PodiumConfig,
  type PodiumConfig as PodiumConfigType,
  saveConfig,
} from '@podium/core/config'
import type { Hono } from 'hono'

/**
 * Shared setup API. The setup web UI (apps/web SetupView) reads the current config and
 * writes the chosen deployment mode here. The CLI / Tauri shell read the same config file.
 */
export function registerSetupRoute(app: Hono): void {
  // TODO(phase3/6): gate /setup/config POST (loopback-only or daemon.secret) before off-box server modes ship
  app.get('/setup/config', (c) => {
    const config = loadConfig()
    return c.json({ config, needsSetup: needsSetup(config) })
  })

  app.post('/setup/config', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid json' }, 400)
    }
    const parsed = PodiumConfig.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'invalid config', issues: parsed.error.issues }, 400)
    }
    const config: PodiumConfigType = parsed.data
    saveConfig(config)
    return c.json({ ok: true, config })
  })
}
