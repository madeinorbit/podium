/**
 * POD-4800: send during a daemon restart must not vanish.
 *
 * A message sent while the agent's machine daemon is briefly offline (e.g. a
 * 3-second daemon restart) must be kept and delivered when the daemon comes
 * back — not answered `dead_letter "machine unreachable"` with no durable row.
 *
 * Lowest-layer reproduction: sessions.sendText to a session whose machine's
 * daemon is detached must NOT come back dead_letter; it must leave a durable
 * row that is forwarded when the daemon re-attaches.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { disposeOracles, makeOracle } from './oracle-support'

afterEach(() => disposeOracles())

describe('pod-4800: send queued across daemon restart', () => {
  it('sendText to a reconnecting session queues durably instead of dead-lettering', async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/p',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    o.reg.gateway.detachDaemon(o.reg.sessionStore.hostMachineId)
    expect((await o.meta(sessionId)).status).toBe('reconnecting')
    o.daemon.length = 0

    const sent = await o.call.sessions.sendText({ sessionId, text: 'are you there' })

    // The bug: { ok:false, reason:'machine unreachable', disposition:'dead_letter' }
    // with no durable row and nothing forwarded on reattach.
    expect(sent.disposition).not.toBe('dead_letter')
    expect(sent.ok).toBe(true)

    // Durable custody: the inbox FIFO holds the row while the daemon is away.
    const queued = await o.store.sync.listQueuedMessages(sessionId)
    expect(queued).toHaveLength(1)
    expect(queued[0]?.text).toBe('are you there')

    // The ledger row stays queued (not dead-lettered) for the same send.
    const messageId = (sent as { message?: { id?: string } }).message?.id ?? (sent as { id?: string }).id
    if (typeof messageId === 'string') {
      expect((await o.store.messages.getMessage(messageId))?.status).toBe('queued')
    }
  })

  it('resumeAndSend to a reconnecting session also queues instead of dead-lettering', async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/p',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    o.reg.gateway.detachDaemon(o.reg.sessionStore.hostMachineId)
    expect((await o.meta(sessionId)).status).toBe('reconnecting')

    const woken = await o.call.sessions.resumeAndSend({ sessionId, text: 'wake up' })
    expect(woken.disposition).not.toBe('dead_letter')
    expect(woken.ok).toBe(true)
    expect(await o.store.sync.listQueuedMessages(sessionId)).toHaveLength(1)
  })
})
