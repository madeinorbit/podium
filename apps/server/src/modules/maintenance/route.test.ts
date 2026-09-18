import { machineHelloTranscript, type MachineChallenge } from '@podium/protocol'
import { mintSigningKeyPair } from '@podium/runtime/signing'
import { machinePublicKeyWire, signWithMachine, verifyWithMachineKey } from '@podium/runtime/machine-credential'
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
    autoArchiveReadWindowMs: 24 * 60 * 60 * 1000,
    eventRetentionMaxAgeDays: 14,
    eventRetentionMaxRows: 50_000,
    changeKeepRows: 20_000,
    changeMaxAgeMs: 3 * 24 * 60 * 60 * 1000,
    maintenanceCommandMaxAgeMs: 14 * 24 * 60 * 60 * 1000,
    worktreeGcMode: 'propose' as const,
    worktreeGcAfterDays: 14,
  }))
  const apply = vi.fn((command) => ({
    status: 'applied' as const,
    jobKind: command.jobKind,
    runKey: command.runKey,
  }))

  function app() {
    const value = new Hono()
    registerMaintenanceRoute(value, {
      machineId: 'host', installationId: 'installation', authenticateSignature: () => false,
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

describe('maintenance key proofs', () => {
  const body = JSON.stringify({ protocolVersion: MAINTENANCE_PROTOCOL_VERSION, schemaVersion: MAINTENANCE_SCHEMA_VERSION, generationId: 'key-test' })
  const path = '/maintenance/handshake'
  const key = mintSigningKeyPair()
  function setup() {
    const app = new Hono()
    const verify = vi.fn((transcript: string, signature: string) => verifyWithMachineKey(machinePublicKeyWire(key), transcript, signature))
    registerMaintenanceRoute(app, { machineId: 'host', installationId: 'installation', authenticateToken: () => false,
      authenticateSignature: verify,
      service: { handshake: () => ({ status: 'busy', retryAt: '2099-01-01T00:00:00Z' }), apply: (command) => ({ status: 'applied', jobKind: command.jobKind, runKey: command.runKey }) },
    })
    const challenge = async () => (await app.request('/maintenance/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, body }) })).json() as Promise<MachineChallenge>
    const proof = (c: MachineChallenge, transcript = machineHelloTranscript(c)) => `MachineKey ${JSON.stringify({ nonce: c.nonce, signature: signWithMachine(key, transcript) })}`
    const send = (authorization: string, target = path, payload = body) => app.request(target, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: payload })
    return { app, challenge, proof, send, verify }
  }
  it('consumes each nonce once even with concurrent requests', async () => {
    const t = setup()
    const auth = t.proof(await t.challenge())
    const responses = await Promise.all([t.send(auth), t.send(auth)])
    expect(responses.map((r) => r.status).sort()).toEqual([200, 401])
    expect(t.verify).toHaveBeenCalledOnce()
  })
  it.each(['machine', 'installation', 'connection', 'body', 'path', 'expired', 'unknown', 'signature'])('refuses a mismatched %s and consumes a failed proof', async (kind) => {
    const t = setup()
    const c = await t.challenge()
    const changed = { ...c }
    if (kind === 'machine') changed.machineId = 'other'
    if (kind === 'installation') changed.installationId = 'other'
    if (kind === 'connection') changed.connectionId = 'other'
    if (kind === 'unknown') changed.nonce = 'other'
    let auth = t.proof(changed)
    if (kind === 'signature') auth = `MachineKey ${JSON.stringify({ nonce: c.nonce, signature: 'invalid' })}`
    const now = kind === 'expired' ? vi.spyOn(Date, 'now').mockReturnValue(c.expiresAtMs) : undefined
    try {
      expect((await t.send(auth, kind === 'path' ? '/maintenance/command' : path, kind === 'body' ? '{}' : body)).status).toBe(401)
      if (kind !== 'unknown') expect((await t.send(t.proof(c))).status).toBe(401)
    } finally { now?.mockRestore() }
  })
  it('does not accept a nonce from another server instance', async () => {
    const first = setup(), second = setup()
    expect((await second.send(first.proof(await first.challenge()))).status).toBe(401)
  })
  it('bounds pending challenge memory', async () => {
    const t = setup()
    for (let n = 0; n < 256; n++) await t.challenge()
    expect((await t.app.request('/maintenance/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, body }) })).status).toBe(429)
  })
})
