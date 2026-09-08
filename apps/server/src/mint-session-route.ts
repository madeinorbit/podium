/**
 * Host-local mint-session for a Turso-backed instance [POD-3272].
 *
 * Self-hosted mint writes podium.db from a second process. A remote database
 * has no file, so the CLI goes through the running server with the same
 * daemon secret the janitor already presents.
 */

import { createHash, randomBytes } from 'node:crypto'
import { FIRST_ADMIN_USER_ID } from '@podium/model'
import { BREAK_GLASS_LABEL } from '@podium/runtime/session-mint'
import type { Hono } from 'hono'
import type { SessionStore } from './store'

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function registerMintSessionRoute(
  app: Hono,
  deps: {
    authenticateSecret(secret: string): boolean
    store: SessionStore
  },
): void {
  app.post('/internal/mint-session', async (c) => {
    const header = c.req.header('authorization')
    const secret = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    if (!secret || !deps.authenticateSecret(secret)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    let ttlMs = DEFAULT_TTL_MS
    try {
      const body = (await c.req.json()) as { ttlMs?: unknown }
      if (typeof body.ttlMs === 'number' && Number.isFinite(body.ttlMs) && body.ttlMs > 0) {
        ttlMs = body.ttlMs
      }
    } catch {
      /* empty body is the default TTL */
    }
    const accounts = await deps.store.users.list()
    if (accounts.length > 1) {
      return c.json(
        {
          error:
            'refusing to mint: this instance holds more than one user account, and a break-glass session carries the first admin authority',
        },
        403,
      )
    }
    const token = randomBytes(32).toString('base64url')
    const nowMs = Date.now()
    const expiresAt = new Date(nowMs + ttlMs).toISOString()
    await deps.store.auth.createClientSession(
      createHash('sha256').update(token).digest('hex'),
      FIRST_ADMIN_USER_ID,
      expiresAt,
      BREAK_GLASS_LABEL,
    )
    return c.json({ token, expiresAt })
  })
}
