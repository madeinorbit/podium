import {
  MAINTENANCE_PROTOCOL_VERSION,
  MAINTENANCE_SCHEMA_VERSION,
  type MaintenanceCommand,
  type MaintenanceCommandReply,
  type MaintenanceHandshake,
  type MaintenanceHandshakeReply,
} from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it, vi } from 'vitest'
import { JanitorService, MessageExpiryReader } from './janitor'

describe('JanitorService [spec:SP-c29e]', () => {
  it('handshakes before reading durable candidates and sends the fenced deterministic command', async () => {
    const calls: string[] = []
    let command: MaintenanceCommand | undefined
    const service = new JanitorService({
      generationId: 'gen_a',
      now: () => Date.parse('2026-07-18T00:00:00.000Z'),
      handshake: async (request: MaintenanceHandshake): Promise<MaintenanceHandshakeReply> => {
        calls.push(`handshake:${request.protocolVersion}:${request.schemaVersion}`)
        return {
          status: 'ready',
          fencingToken: 9,
          expiresAt: '2026-07-18T00:01:30.000Z',
          messageWaitTtlMs: 7 * 24 * 60 * 60_000,
        }
      },
      readExpiryCandidates: (input) => {
        calls.push(`read:${input.limit}`)
        return [
          {
            messageId: 'msg_1',
            status: 'queued',
            lifecycle: 'wait',
            createdAt: '2026-07-01T00:00:00.000Z',
            expiresAt: null,
          },
        ]
      },
      apply: async (request: MaintenanceCommand): Promise<MaintenanceCommandReply> => {
        command = request
        calls.push('apply')
        return { status: 'applied', jobKind: request.jobKind, runKey: request.runKey }
      },
    })

    await service.tick()

    expect(calls).toEqual([
      `handshake:${MAINTENANCE_PROTOCOL_VERSION}:${MAINTENANCE_SCHEMA_VERSION}`,
      'read:100',
      'apply',
    ])
    expect(command).toMatchObject({
      jobKind: 'message-expiry',
      fencingToken: 9,
      observed: { messageId: 'msg_1' },
    })
  })

  it('never reads or applies while another generation owns the lease', async () => {
    const readExpiryCandidates = vi.fn(() => [])
    const apply = vi.fn()
    const service = new JanitorService({
      generationId: 'gen_b',
      now: () => Date.parse('2026-07-18T00:00:00.000Z'),
      handshake: async () => ({ status: 'busy', retryAt: '2026-07-18T00:01:30.000Z' }),
      readExpiryCandidates,
      apply,
    })

    await service.tick()

    expect(readExpiryCandidates).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it('drops its lease immediately when the server fences a command', async () => {
    let handshakes = 0
    const service = new JanitorService({
      generationId: 'gen_a',
      now: () => Date.parse('2026-07-18T00:00:00.000Z'),
      handshake: async () => {
        handshakes += 1
        return {
          status: 'ready',
          fencingToken: handshakes,
          expiresAt: '2026-07-18T00:01:30.000Z',
          messageWaitTtlMs: 7 * 24 * 60 * 60_000,
        }
      },
      readExpiryCandidates: () => [
        {
          messageId: 'msg_1',
          status: 'queued',
          lifecycle: 'wait',
          createdAt: '2026-07-01T00:00:00.000Z',
          expiresAt: null,
        },
      ],
      apply: async (request) => ({
        status: 'stale',
        jobKind: request.jobKind,
        runKey: request.runKey,
        reason: 'fenced',
      }),
    })

    await service.tick()
    await service.tick()

    expect(handshakes).toBe(2)
  })

  it('reads only durable due facts in bounded pages without consulting runtime state', async () => {
    const db = openDatabase(':memory:')
    try {
      db.exec(`CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT
      )`)
      const insert = db.prepare(
        'INSERT INTO messages (id, status, lifecycle, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      insert.run(
        'msg_explicit',
        'queued',
        'wake',
        '2026-07-17T00:00:00.000Z',
        '2026-07-18T00:00:00.000Z',
      )
      insert.run('msg_wait', 'queued', 'wait', '2026-07-01T00:00:00.000Z', null)
      insert.run('msg_wake', 'queued', 'wake', '2026-07-01T00:00:00.000Z', null)
      insert.run(
        'msg_future',
        'queued',
        'wait',
        '2026-07-17T00:00:00.000Z',
        '2026-07-19T00:00:00.000Z',
      )

      const reader = new MessageExpiryReader(db)
      const rows = await reader.read({
        now: '2026-07-18T00:00:00.000Z',
        waitImplicitCutoff: '2026-07-11T00:00:00.000Z',
        limit: 100,
      })
      expect(rows.map((row) => row.messageId)).toEqual(['msg_wait', 'msg_explicit'])

      const bounded = await reader.read({
        now: '2026-07-18T00:00:00.000Z',
        waitImplicitCutoff: '2026-07-11T00:00:00.000Z',
        limit: 1,
      })
      expect(bounded).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})
