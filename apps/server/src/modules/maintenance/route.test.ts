import {
  MAINTENANCE_PROTOCOL_VERSION,
  MAINTENANCE_SCHEMA_VERSION,
  messageExpiryRunKey,
} from '@podium/protocol'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { registerMaintenanceRoute } from './route'

describe('maintenance route [spec:SP-c29e]', () => {
  const handshake = vi.fn(() => ({
    status: 'ready' as const,
    fencingToken: 4,
    expiresAt: '2026-07-18T00:01:30.000Z',
    messageWaitTtlMs: 7 * 24 * 60 * 60_000,
  }))
  const apply = vi.fn((command) => ({
    status: 'applied' as const,
    jobKind: command.jobKind,
    runKey: command.runKey,
  }))

  function app() {
    const value = new Hono()
    registerMaintenanceRoute(value, {
      authenticateToken: (token) => token === 'secret',
      service: { handshake, apply },
    })
    return value
  }

  it('authenticates every request with the local maintenance bearer', async () => {
    const response = await app().request('/maintenance/handshake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        generationId: 'gen_a',
      }),
    })
    expect(response.status).toBe(401)
    expect(handshake).not.toHaveBeenCalled()
  })

  it('validates and dispatches the exact handshake contract', async () => {
    const response = await app().request('/maintenance/handshake', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        generationId: 'gen_a',
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ready', fencingToken: 4 })
    expect(handshake).toHaveBeenCalledOnce()
  })

  it('rejects malformed commands before the authority and dispatches valid fenced commands', async () => {
    const malformed = await app().request('/maintenance/command', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(malformed.status).toBe(400)

    const observed = {
      messageId: 'msg_1',
      status: 'queued' as const,
      lifecycle: 'wait' as const,
      createdAt: '2026-07-01T00:00:00.000Z',
      expiresAt: null,
    }
    const valid = await app().request('/maintenance/command', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        jobKind: 'message-expiry',
        runKey: messageExpiryRunKey(observed),
        fencingToken: 4,
        observed,
      }),
    })
    expect(valid.status).toBe(200)
    expect(await valid.json()).toMatchObject({ status: 'applied' })
    expect(apply).toHaveBeenCalledOnce()
  })
})
