import {
  MaintenanceCommand,
  MaintenanceHandshake,
  type MaintenanceCommand as Command,
  type MaintenanceCommandReply,
  type MaintenanceHandshake as Handshake,
  type MaintenanceHandshakeReply,
} from '@podium/protocol'
import type { Hono } from 'hono'

export interface MaintenanceRouteDeps {
  authenticateToken(token: string): boolean
  service: {
    handshake(request: Handshake): MaintenanceHandshakeReply
    apply(request: Command): MaintenanceCommandReply
  }
}

/** Narrow, local-secret-authenticated janitor transport [spec:SP-c29e]. */
export function registerMaintenanceRoute(app: Hono, deps: MaintenanceRouteDeps): void {
  const authorize = (header: string | undefined): boolean => {
    if (!header?.startsWith('Bearer ')) return false
    const token = header.slice('Bearer '.length)
    return token.length > 0 && deps.authenticateToken(token)
  }

  app.post('/maintenance/handshake', async (c) => {
    if (!authorize(c.req.header('authorization'))) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid-json' }, 400)
    }
    const parsed = MaintenanceHandshake.safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid-handshake' }, 400)
    return c.json(deps.service.handshake(parsed.data))
  })

  app.post('/maintenance/command', async (c) => {
    if (!authorize(c.req.header('authorization'))) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid-json' }, 400)
    }
    const parsed = MaintenanceCommand.safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid-command' }, 400)
    return c.json(deps.service.apply(parsed.data))
  })
}
