import { createHash, randomUUID } from 'node:crypto'
import { machineHelloTranscript, type MachineChallenge } from '@podium/protocol'
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
  machineId: string
  installationId: string
  authenticateSignature(transcript: string, signature: string): Promise<boolean> | boolean
  authenticateToken(token: string): Promise<boolean> | boolean
  service: {
    handshake(request: Handshake): Promise<MaintenanceHandshakeReply> | MaintenanceHandshakeReply
    apply(request: Command): MaintenanceCommandReply | Promise<MaintenanceCommandReply>
  }
}

/** Same host identity and credential verifiers as daemon hello. */
export function registerMaintenanceRoute(app: Hono, deps: MaintenanceRouteDeps): void {
  const pending = new Map<string, { challenge: MachineChallenge; digest: string }>()
  const digest = (path: string, body: string) => createHash('sha256').update(JSON.stringify([path, body])).digest('hex')
  app.post('/maintenance/challenge', async (c) => {
    let request: unknown
    try { request = await c.req.json() } catch { return c.json({ error: 'invalid-json' }, 400) }
    const value = request as { path?: unknown; body?: unknown } | null
    if (!value || (value.path !== '/maintenance/handshake' && value.path !== '/maintenance/command')
      || typeof value.body !== 'string') return c.json({ error: 'invalid-challenge' }, 400)
    const now = Date.now()
    for (const [nonce, entry] of pending) if (entry.challenge.expiresAtMs <= now) pending.delete(nonce)
    if (pending.size >= 256) return c.json({ error: 'too-many-challenges' }, 429)
    const binding = digest(value.path, value.body)
    const challenge: MachineChallenge = { type: 'machineChallenge', machineId: deps.machineId,
      installationId: deps.installationId, connectionId: `maintenance:${randomUUID()}:${binding}`,
      nonce: randomUUID(), expiresAtMs: now + 30_000 }
    pending.set(challenge.nonce, { challenge, digest: binding })
    return c.json(challenge)
  })
  const authorize = async (header: string | undefined, path: string, body: string): Promise<boolean> => {
    if (header?.startsWith('Bearer ')) {
      const token = header.slice('Bearer '.length)
      return token.length > 0 && (await deps.authenticateToken(token))
    }
    if (!header?.startsWith('MachineKey ')) return false
    let proof: { nonce?: unknown; signature?: unknown }
    try { proof = JSON.parse(header.slice('MachineKey '.length)) } catch { return false }
    if (!proof || typeof proof.nonce !== 'string' || typeof proof.signature !== 'string' || proof.signature.length > 256) return false
    const entry = pending.get(proof.nonce)
    pending.delete(proof.nonce) // Consume before awaiting verification, including failed attempts.
    if (!entry || entry.challenge.expiresAtMs <= Date.now() || entry.digest !== digest(path, body)) return false
    return await deps.authenticateSignature(machineHelloTranscript(entry.challenge), proof.signature)
  }

  app.post('/maintenance/handshake', async (c) => {
    const raw = await c.req.text()
    if (!(await authorize(c.req.header('authorization'), c.req.path, raw))) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return c.json({ error: 'invalid-json' }, 400)
    }
    const parsed = MaintenanceHandshake.safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid-handshake' }, 400)
    return c.json(await deps.service.handshake(parsed.data))
  })

  app.post('/maintenance/command', async (c) => {
    const raw = await c.req.text()
    if (!(await authorize(c.req.header('authorization'), c.req.path, raw))) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return c.json({ error: 'invalid-json' }, 400)
    }
    const parsed = MaintenanceCommand.safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid-command' }, 400)
    return c.json(await deps.service.apply(parsed.data))
  })
}
