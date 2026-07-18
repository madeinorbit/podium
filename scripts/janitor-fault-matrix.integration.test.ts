import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAINTENANCE_PROTOCOL_VERSION,
  MAINTENANCE_SCHEMA_VERSION,
  type MaintenanceCommand,
  type MaintenanceCommandReply,
  type MaintenanceHandshakeReply,
} from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { JanitorService } from '../apps/janitor/src/janitor'
import { MaintenanceService } from '../apps/server/src/modules/maintenance/service'
import { type MessageRow, SessionStore } from '../apps/server/src/store'

const NOW = Date.parse('2026-07-18T00:00:00.000Z')

function dueMessage(id: string): MessageRow {
  return {
    id,
    threadId: `thread_${id}`,
    inReplyTo: null,
    fromKind: 'system',
    fromSession: null,
    fromName: 'acceptance',
    fromIssue: null,
    toKind: 'operator',
    toId: null,
    kind: 'notification',
    urgency: 'fyi',
    lifecycle: 'wait',
    body: 'due',
    expiresAt: '2026-07-01T00:00:00.000Z',
    createdAt: '2026-06-30T00:00:00.000Z',
    status: 'queued',
    deliveredAt: null,
    deliveredTo: null,
    ackedBy: null,
    hop: 0,
    clampedFrom: null,
    remindedAt: null,
    factKey: null,
    factTarget: null,
    expectsResponse: false,
  }
}

function observed(message: MessageRow) {
  return {
    messageId: message.id,
    status: 'queued' as const,
    lifecycle: message.lifecycle,
    createdAt: message.createdAt,
    expiresAt: message.expiresAt,
  }
}

function maintenance(store: SessionStore, now: () => number = () => NOW): MaintenanceService {
  return new MaintenanceService(
    store,
    {
      run<T>({ write }: { write: () => T }): T {
        return write()
      },
    },
    { now, leaseTtlMs: 90_000 },
  )
}

function expiredEvents(store: SessionStore, id: string): number {
  return store.events
    .listEventsSince(0)
    .filter((event) => event.kind === 'message.expired' && event.subject === id).length
}

describe.each([
  'before-apply',
  'after-apply-before-ack',
] as const)('janitor crash boundary: %s [spec:SP-c29e]', (boundary) => {
  it('retries the deterministic command and commits the transition exactly once', async () => {
    const store = new SessionStore(':memory:')
    const message = dueMessage(`msg_${boundary}`)
    store.messages.addMessage(message)
    const server = maintenance(store)
    let crash = true
    const service = new JanitorService({
      generationId: `gen_${boundary}`,
      now: () => NOW,
      handshake: async (request) => server.handshake(request),
      readExpiryCandidates: () => [observed(message)],
      apply: async (command): Promise<MaintenanceCommandReply> => {
        if (crash) {
          crash = false
          if (boundary === 'after-apply-before-ack') server.apply(command)
          throw new Error(`injected crash ${boundary}`)
        }
        return server.apply(command)
      },
    })

    await expect(service.tick()).rejects.toThrow(/injected crash/)
    await expect(service.tick()).resolves.toBeUndefined()

    expect(store.messages.getMessage(message.id)?.status).toBe('expired')
    expect(expiredEvents(store, message.id)).toBe(1)
    expect(service.metrics()).toMatchObject({
      queueDepth: 0,
      completedJobs: 1,
      failures: 1,
      supersededJobs: 0,
    })
    store.close()
  })
})

describe('janitor lease and server-restart faults [spec:SP-c29e]', () => {
  it('allows only one lease holder, then fences takeover after expiry', async () => {
    let now = NOW
    const store = new SessionStore(':memory:')
    const server = maintenance(store, () => now)
    const firstRead = vi.fn(() => [])
    const secondRead = vi.fn(() => [])
    const janitor = (generationId: string, readExpiryCandidates: () => []): JanitorService =>
      new JanitorService({
        generationId,
        now: () => now,
        handshake: async (request) => server.handshake(request),
        readExpiryCandidates,
        apply: async (command) => server.apply(command),
      })
    const first = janitor('gen_first', firstRead)
    const duplicate = janitor('gen_duplicate', secondRead)

    await first.tick()
    await duplicate.tick()
    expect(firstRead).toHaveBeenCalledTimes(1)
    expect(secondRead).not.toHaveBeenCalled()

    now += 91_000
    await duplicate.tick()
    expect(secondRead).toHaveBeenCalledTimes(1)

    const stale: MaintenanceCommand = {
      protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
      schemaVersion: MAINTENANCE_SCHEMA_VERSION,
      jobKind: 'message-expiry',
      runKey: 'message-expiry/stale',
      fencingToken: 1,
      observed: {
        messageId: 'stale',
        status: 'queued',
        lifecycle: 'wait',
        createdAt: '2026-07-01T00:00:00.000Z',
        expiresAt: null,
      },
    }
    expect(server.apply(stale)).toMatchObject({ status: 'stale', reason: 'fenced' })
    store.close()
  })

  it('accepts the fenced command after the server restarts between decision and apply', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-janitor-mid-migration-'))
    const dbPath = join(dir, 'podium.db')
    let store = new SessionStore(dbPath)
    const message = dueMessage('msg_restart')
    store.messages.addMessage(message)
    let server = maintenance(store)
    let restarted = false
    const service = new JanitorService({
      generationId: 'gen_restart',
      now: () => NOW,
      handshake: async (request): Promise<MaintenanceHandshakeReply> => server.handshake(request),
      readExpiryCandidates: () => {
        if (!restarted) {
          restarted = true
          store.close()
          store = new SessionStore(dbPath)
          server = maintenance(store)
        }
        return [observed(message)]
      },
      apply: async (command) => server.apply(command),
    })

    try {
      await service.tick()
      expect(restarted).toBe(true)
      expect(store.messages.getMessage(message.id)?.status).toBe('expired')
      expect(expiredEvents(store, message.id)).toBe(1)
      expect(service.metrics()).toMatchObject({
        queueDepth: 0,
        completedJobs: 1,
        failures: 0,
      })
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
