/**
 * POD-4795 — INTERRUPT AND FILE SENDS ARE DURABLE ROWS, END TO END.
 *
 * Over a real registry and an on-disk store, the two sends that used to go
 * straight to the agent's machine without a row now leave the server the way
 * every other send does: one `runtimeDurableSendRequest` keyed by the message
 * id (`rowId` = `turnId` = message id), carrying the delivery mode and the
 * staged files. Because the row is stored, it outlives the server process that
 * accepted it; because the machine recognises the id, a re-forward after a
 * restart arrives as a recovery the daemon answers without typing again
 * (packages/harness/src/driver/delivery-queue.test.ts pins that half).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, type SessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'

const TEST_MACHINE = asMachineId('machine-under-test')

const tmpDirs: string[] = []
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})
function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-durable-sends-'))
  tmpDirs.push(dir)
  return join(dir, 'podium.db')
}

const bind = (sessionId: SessionId) =>
  ({
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/',
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  }) as const

type DurableSendRequest = Extract<ControlMessage, { type: 'runtimeDurableSendRequest' }>
const durableSends = (daemon: ControlMessage[], sessionId: SessionId): DurableSendRequest[] =>
  daemon.filter(
    (message): message is DurableSendRequest =>
      message.type === 'runtimeDurableSendRequest' && message.sessionId === sessionId,
  )
const directSends = (daemon: ControlMessage[], sessionId: SessionId) =>
  daemon.filter((message) => message.type === 'runtimeSendRequest' && message.sessionId === sessionId)

/** A staged ref, shaped the way the daemon's staging directory mints one. */
const staged = (sessionId: SessionId) => ({
  id: 'att-1',
  path: `/state/uploads/${sessionId}/att-1.png`,
  filename: 'shot.png',
  mediaType: 'image/png',
  kind: 'image' as const,
})

async function boot(file: string, daemon: ControlMessage[]) {
  const registry = await SessionRegistry.create(await openTestStore(file, TEST_MACHINE), undefined, {
    instanceId: 'default',
  })
  await attachHostDaemon(registry, (message) => daemon.push(message))
  return registry
}

describe('interrupt and file sends ride the durable queue (POD-4795)', () => {
  it('keeps a send with files stored across a server restart, and forwards it with its files', async () => {
    const file = dbFile()
    const first: ControlMessage[] = []
    const reg1 = await boot(file, first)
    const { sessionId } = await reg1.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/repo',
    })
    await reg1.gateway.routeDaemonFrame(reg1.sessionStore.hostMachineId, bind(sessionId))
    const attachment = staged(sessionId)

    const sent = await reg1.modules.messages.send(
      { kind: 'operator' },
      {
        to: { kind: 'session', id: sessionId },
        body: 'here is the screenshot',
        attachments: [attachment],
      },
    )
    // Handed on as a row, never answered `delivered` ahead of the agent.
    expect(sent.message.deliveryStatus).toBe('dispatched')
    await vi.waitFor(() => expect(durableSends(first, sessionId)).toHaveLength(1))
    expect(durableSends(first, sessionId)[0]).toMatchObject({
      rowId: sent.message.id,
      turnId: sent.message.id,
      delivery: 'when-ready',
      attachments: [attachment],
      deliveryRecovery: false,
    })
    expect(directSends(first, sessionId)).toEqual([])

    // The server goes away while the row waits for the agent.
    await reg1.dispose()
    await reg1.sessionStore.close()

    const second: ControlMessage[] = []
    const reg2 = await boot(file, second)
    try {
      expect(await reg2.modules.sessions.hasQueuedMessage(sessionId, sent.message.id)).toBe(true)
      await reg2.gateway.routeDaemonFrame(reg2.sessionStore.hostMachineId, bind(sessionId))
      await vi.waitFor(() => expect(durableSends(second, sessionId)).toHaveLength(1))
      // Same row, same id, files and all — as a recovery, because the first
      // server reserved it before the forward.
      expect(durableSends(second, sessionId)[0]).toMatchObject({
        rowId: sent.message.id,
        delivery: 'when-ready',
        attachments: [attachment],
        deliveryRecovery: true,
      })
      expect(directSends(second, sessionId)).toEqual([])
    } finally {
      await reg2.dispose()
      await reg2.sessionStore.close()
    }
  })

  it('sends an interrupt as one row under the message id, and re-forwards it as a recovery after a restart', async () => {
    const file = dbFile()
    const first: ControlMessage[] = []
    const reg1 = await boot(file, first)
    const { sessionId } = await reg1.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/repo',
    })
    await reg1.gateway.routeDaemonFrame(reg1.sessionStore.hostMachineId, bind(sessionId))

    const sent = await reg1.modules.messages.send(
      { kind: 'operator' },
      { to: { kind: 'session', id: sessionId }, body: 'stop and read this', urgency: 'interrupt' },
    )
    expect(sent.message.deliveryStatus).toBe('dispatched')
    await vi.waitFor(() => expect(durableSends(first, sessionId)).toHaveLength(1))
    expect(durableSends(first, sessionId)[0]).toMatchObject({
      rowId: sent.message.id,
      turnId: sent.message.id,
      delivery: 'interrupt',
      deliveryRecovery: false,
    })
    // No second pipeline: no direct send, and no stop request of the server's own.
    expect(directSends(first, sessionId)).toEqual([])
    expect(first.filter((message) => message.type === 'runtimeInterruptRequest')).toEqual([])

    await reg1.dispose()
    await reg1.sessionStore.close()

    const second: ControlMessage[] = []
    const reg2 = await boot(file, second)
    try {
      await reg2.gateway.routeDaemonFrame(reg2.sessionStore.hostMachineId, bind(sessionId))
      await vi.waitFor(() => expect(durableSends(second, sessionId)).toHaveLength(1))
      // The daemon recognises the id; a recovery is confirm-or-fail, never a
      // second cut or a second typing.
      expect(durableSends(second, sessionId)[0]).toMatchObject({
        rowId: sent.message.id,
        delivery: 'interrupt',
        deliveryRecovery: true,
      })
    } finally {
      await reg2.dispose()
      await reg2.sessionStore.close()
    }
  })
})
