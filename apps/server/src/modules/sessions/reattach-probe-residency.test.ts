/**
 * A REATTACH PROBE RESTORES ITS PARKED SESSIONS ONCE (POD-7036).
 *
 * On every daemon attach the server probes each exited session on that machine
 * (a row can be wrongly 'exited' while its master survives). With eviction on,
 * each probe restored its session alone (a row read and five single-id
 * satellite reads: offers, drafts, checkpoints, turn states, transcripts), let
 * go of it, and the daemon's `reattachFailed` answer restored it again: on the
 * live server 672 sessions were materialized about 684 times each (the
 * POD-7027 audit's findings 6 and 11). Now the probes of one attach are
 * restored together, and a refusal for a row still exited with nothing queued
 * restores nothing.
 */
import type { SessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../relay'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { openTestStore } from '../../test-support/open-test-store'

const registries: SessionRegistry[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const reg of registries.splice(0)) await reg.dispose()
})

async function exitedSessions(count: number) {
  const store = await openTestStore(':memory:')
  await store.repos.addRepo('/r', store.hostMachineId)
  const reg = await SessionRegistry.create(store, undefined, {
    instanceId: 'default',
    sessionResidency: { evictParked: true, sweepIntervalMs: 0 },
  })
  registries.push(reg)
  await attachHostDaemon(reg)
  const sessions = reg.modules.sessions
  const machine = store.hostMachineId
  const ids: SessionId[] = []
  for (let i = 0; i < count; i++) {
    const cwd = `/r/w${i}`
    const { sessionId } = await sessions.createSession({ agentKind: 'claude-code', cwd })
    await reg.gateway.routeDaemonFrame(machine, {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd,
      agentKind: 'claude-code',
      geometry: { cols: 100, rows: 30 },
    } as never)
    await reg.gateway.routeDaemonFrame(machine, { type: 'agentExit', sessionId, code: 0 })
    ids.push(sessionId)
  }
  await sessions.flushActivity()
  sessions.residency.sweep()
  for (const id of ids) expect(sessions.sessions.has(id)).toBe(false)
  const repository = (
    sessions as unknown as {
      repository: { materializeStoredSessions(rows: readonly unknown[]): Promise<unknown> }
    }
  ).repository
  const restored: number[] = []
  const original = repository.materializeStoredSessions.bind(repository)
  vi.spyOn(repository, 'materializeStoredSessions').mockImplementation(async (rows) => {
    restored.push(rows.length)
    return await original(rows)
  })
  return { reg, sessions, machine, ids, restored }
}

describe('reattach probe residency (POD-7036)', () => {
  it('restores the probed parked sessions together, and their refusals restore nothing', async () => {
    const { reg, sessions, machine, ids, restored } = await exitedSessions(4)
    const sent: ControlMessage[] = []

    // The daemon reconnects: every exited session on it is probed.
    await attachHostDaemon(reg, (message) => sent.push(message))
    const probed = sent
      .filter((message) => message.type === 'reattach')
      .map((message) => (message as { sessionId: string }).sessionId)
    expect(probed.sort()).toEqual([...ids].sort())
    // One restore of all four, not four of one, and let go after the probe.
    expect(restored).toEqual([4])
    for (const id of ids) expect(sessions.sessions.has(id)).toBe(false)

    // The daemon answers: nothing is there to reattach. Each row is still
    // exited with nothing queued, so its refusal restores nothing.
    for (const sessionId of ids)
      await reg.gateway.routeDaemonFrame(machine, {
        type: 'reattachFailed',
        sessionId,
        reason: 'gone',
      })
    expect(restored).toEqual([4])
    for (const id of ids) expect(sessions.sessions.has(id)).toBe(false)
  })

  it('a refusal for an exited session with queued input still goes through its handler', async () => {
    const { reg, machine, ids, restored } = await exitedSessions(2)
    const [queued] = ids as [SessionId, ...SessionId[]]
    const counts = vi.spyOn(reg.sessionStore.sync, 'queuedMessageCounts')
    counts.mockImplementation(async () => new Map([[queued, 1]]))
    await reg.gateway.routeDaemonFrame(machine, {
      type: 'reattachFailed',
      sessionId: queued,
      reason: 'gone',
    })
    counts.mockRestore()
    // Restored, alone, for the handler that re-arms the queued wake.
    expect(restored).toEqual([1])
  })
})
