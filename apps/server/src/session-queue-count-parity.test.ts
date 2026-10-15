/**
 * A session's queued-input count comes from its `queued_messages` rows
 * (POD-6155 step 4).
 *
 * Before `Session.queuedMessageCount` (the registry's mirror of the durable
 * queue, bumped on insert, re-read after a drain and re-seeded at boot) was
 * deleted, this test compared it with the indexed count after every step of
 * these outbox flows, at the commit that adds this file. What stays is a
 * regression test: the count, and the count clients see, follow queueing while
 * live, an exit, a server restart, the wake, custody and delivery of each row.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, asSessionId, type SessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'

const TEST_MACHINE = asMachineId('machine-under-test')
const G = { cols: 80, rows: 24 }
const bind = (sessionId: SessionId) =>
  ({ type: 'bind', sessionId, cmd: 'claude', cwd: '/', agentKind: 'claude-code', geometry: G }) as const

type DurableSendRequest = Extract<ControlMessage, { type: 'runtimeDurableSendRequest' }>
/** The row ids handed on to the daemon for this session, fresh or recovered. */
const handedOn = (daemon: ControlMessage[], sessionId: string): string[] => [
  ...new Set(
    daemon
      .filter((m): m is DurableSendRequest => m.type === 'runtimeDurableSendRequest' && m.sessionId === sessionId)
      .map((m) => m.rowId),
  ),
]

const custodyGranting = (reg: SessionRegistry, daemon: ControlMessage[]) => (message: ControlMessage): void => {
  daemon.push(message)
  if (message.type !== 'runtimeDurableSendRequest') return
  void reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
    type: 'runtimeSendResult',
    requestId: message.requestId,
    sessionId: message.sessionId,
    receipt: { outcome: 'queued', position: 1, deliveredAs: 'queue', at: '2026-01-01T00:00:00.000Z' },
  })
}

async function deliverRows(reg: SessionRegistry, daemon: ControlMessage[], sessionId: SessionId, rowIds: readonly string[]) {
  const spawn = daemon.filter((m): m is Extract<ControlMessage, { type: 'spawn' }> => m.type === 'spawn' && m.sessionId === sessionId).at(-1)
  const observerGeneration = spawn!.observationGeneration!
  const cursor = (seq: number) => ({ segmentId: `delivery-${sessionId}`, components: { seq } })
  await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
    type: 'runtimeEvent',
    deliveryId: `bootstrap-${sessionId}-${observerGeneration}`,
    sessionId,
    event: {
      t: 'state',
      change: { kind: 'state_snapshot', state: { phase: 'idle', since: '2026-01-01T00:00:00.000Z', nativeSubagentCount: 0 } },
      at: '2026-01-01T00:00:00.500Z', provenance: 'bootstrap', cursor: cursor(1), observerGeneration, turnEpoch: 0,
    },
  })
  for (const [index, rowId] of rowIds.entries()) {
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'runtimeEvent',
      deliveryId: `delivery-${rowId}`,
      sessionId,
      event: {
        t: 'delivery', rowId, outcome: 'delivered', at: '2026-01-01T00:00:01.000Z', provenance: 'live',
        cursor: cursor(index + 2), observerGeneration, turnEpoch: 0,
      },
    })
  }
}

/** The indexed count, the rows themselves and the count the wire meta carries agree. */
async function expectParity(reg: SessionRegistry, sessionId: SessionId) {
  const rows = (await reg.sessionStore.sync.listQueuedMessages(sessionId)).length
  expect((await reg.sessionStore.sync.queuedMessageCounts(sessionId)).get(sessionId) ?? 0).toBe(rows)
  const meta = (await reg.modules.sessions.listSessions(undefined, 'rpc')).find((s) => s.sessionId === sessionId)
  expect(meta?.queuedMessageCount ?? 0).toBe(rows)
}

describe('session queue counts come from the durable rows', () => {
  it('through queueing, an exit, a server restart, the wake, custody and delivery', async () => {
    vi.useFakeTimers()
    try {
      const file = join(mkdtempSync(join(tmpdir(), 'podium-queue-parity-')), 'podium.db')
      const storeA = await openTestStore(file, TEST_MACHINE)
      const regA = await SessionRegistry.create(storeA, undefined, { instanceId: 'default' })
      await attachHostDaemon(regA, () => {})
      const idle = await regA.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/idle' })
      const { sessionId } = await regA.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
      await regA.gateway.routeDaemonFrame(regA.sessionStore.hostMachineId, bind(sessionId))
      await regA.gateway.routeDaemonFrame(regA.sessionStore.hostMachineId, {
        type: 'sessionResumeRef', sessionId, resume: { kind: 'claude-session', value: 'abc-123' },
      })
      await expectParity(regA, sessionId)
      // Rows admitted while live; the daemon never takes them, so they stay queued.
      for (const text of ['first', 'second']) {
        expect(await regA.modules.sessions.queueText({ sessionId, text })).toMatchObject({ ok: true, queued: true })
        await vi.advanceTimersByTimeAsync(0)
        await expectParity(regA, sessionId)
      }
      await regA.gateway.routeDaemonFrame(regA.sessionStore.hostMachineId, { type: 'agentExit', sessionId, code: 137 })
      await vi.advanceTimersByTimeAsync(0)
      await expectParity(regA, sessionId)
      expect((await regA.sessionStore.sync.listQueuedMessages(sessionId)).length).toBeGreaterThan(0)
      await regA.dispose()
      await storeA.close()

      // The boot re-seed, then the wake, custody and one delivery at a time.
      const storeB = await openTestStore(file, TEST_MACHINE)
      const regB = await SessionRegistry.create(storeB, undefined, { instanceId: 'default' })
      const daemon: ControlMessage[] = []
      await attachHostDaemon(regB, custodyGranting(regB, daemon))
      await expectParity(regB, sessionId)
      await expectParity(regB, idle.sessionId)
      await regB.gateway.routeDaemonFrame(regB.sessionStore.hostMachineId, {
        type: 'reattachFailed', sessionId, reason: 'process gone',
      })
      await vi.waitFor(() => expect(daemon.some((m) => m.type === 'spawn' && m.sessionId === sessionId)).toBe(true))
      await regB.gateway.routeDaemonFrame(regB.sessionStore.hostMachineId, bind(sessionId))
      await vi.waitFor(() => expect(handedOn(daemon, sessionId).length).toBeGreaterThan(0))
      await vi.advanceTimersByTimeAsync(0)
      await expectParity(regB, sessionId)
      for (;;) {
        const rows = await regB.sessionStore.sync.listQueuedMessages(sessionId)
        if (rows.length === 0) break
        await vi.waitFor(() => expect(handedOn(daemon, sessionId)).toContain(rows[0]!.id))
        await deliverRows(regB, daemon, sessionId, [rows[0]!.id])
        await vi.waitFor(async () =>
          expect((await regB.sessionStore.sync.listQueuedMessages(sessionId)).length).toBe(rows.length - 1))
        await vi.advanceTimersByTimeAsync(0)
        await expectParity(regB, sessionId)
      }
      await regB.dispose()
      await storeB.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
