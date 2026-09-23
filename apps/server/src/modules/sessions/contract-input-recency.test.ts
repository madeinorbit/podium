/**
 * POD-3995 THING TWO: a human turn on a contract session must move input recency.
 *
 * `lastInputAtMs`/`lastUserInputAtMs` advance on the PTY type path and on
 * auto-continue, but nothing on the contract path touches them — so for a
 * contract session they never move, and the boot-time offer-staleness rule
 * (repository.ts) plus the `userOpenedTurn` fallback (daemon-lifecycle.ts)
 * can never fire. The `turn/started` event already carries the send's origin;
 * the server has to honour it for recency.
 */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@podium/model'
import { SessionRegistry } from '../../relay'
import { attachHostDaemon } from '../../test-support/host-daemon'

const G = { cols: 80, rows: 24 }
const HUMAN_TURN_AT = '2026-09-01T00:00:10.000Z'
const SYSTEM_TURN_AT = '2026-09-01T00:00:20.000Z'

async function seedContractSession() {
  const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  attachHostDaemon(reg, () => {})
  const { sessionId } = await reg.modules.sessions.createSession({
    agentKind: 'claude-code',
    cwd: '/p',
  })
  await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/p',
    agentKind: 'claude-code',
    geometry: G,
    driverId: 'claude-sdk',
  })
  return { reg, sessionId }
}

function turnStarted(
  sessionId: SessionId,
  deliveryId: string,
  at: string,
  origin: 'human' | 'system',
  turnEpoch: number,
  seq: number,
) {
  return {
    type: 'runtimeEvent' as const,
    deliveryId,
    sessionId,
    event: {
      t: 'turn' as const,
      ev: { ev: 'started' as const, turnEpoch, origin },
      at,
      provenance: 'live' as const,
      cursor: { segmentId: 'recency-segment', components: { seq } },
      observerGeneration: 1,
      turnEpoch,
    },
  }
}

function terminalOf(reg: SessionRegistry, sessionId: SessionId) {
  const session = reg.modules.sessions.sessions.get(sessionId)
  if (!session) throw new Error('session disappeared from the registry')
  return session.terminal
}

describe('contract input recency (POD-3995)', () => {
  it('a human-origin turn/started advances last-input AND last-user-input recency', async () => {
    const { reg, sessionId } = await seedContractSession()
    try {
      expect(terminalOf(reg, sessionId).lastInputAtMs).toBe(0)
      expect(terminalOf(reg, sessionId).lastUserInputAtMs).toBe(0)

      await reg.gateway.routeDaemonFrame(
        reg.sessionStore.hostMachineId,
        turnStarted(sessionId, 'recency-human', HUMAN_TURN_AT, 'human', 1, 1),
      )
      await reg.modules.sessions.runtimeEventGate.replayBoardProjection()

      expect(terminalOf(reg, sessionId).lastInputAtMs).toBe(Date.parse(HUMAN_TURN_AT))
      expect(terminalOf(reg, sessionId).lastUserInputAtMs).toBe(Date.parse(HUMAN_TURN_AT))
    } finally {
      await reg.dispose()
    }
  })

  it('a system-origin turn/started advances last-input but NOT last-user-input', async () => {
    const { reg, sessionId } = await seedContractSession()
    try {
      await reg.gateway.routeDaemonFrame(
        reg.sessionStore.hostMachineId,
        turnStarted(sessionId, 'recency-human', HUMAN_TURN_AT, 'human', 1, 1),
      )
      await reg.modules.sessions.runtimeEventGate.replayBoardProjection()
      await reg.gateway.routeDaemonFrame(
        reg.sessionStore.hostMachineId,
        turnStarted(sessionId, 'recency-system', SYSTEM_TURN_AT, 'system', 2, 2),
      )
      await reg.modules.sessions.runtimeEventGate.replayBoardProjection()

      // A non-human turn is still input (boot staleness sees it); it is not a
      // person touching the session (the user-input fallback must not see it).
      expect(terminalOf(reg, sessionId).lastInputAtMs).toBe(Date.parse(SYSTEM_TURN_AT))
      expect(terminalOf(reg, sessionId).lastUserInputAtMs).toBe(Date.parse(HUMAN_TURN_AT))
    } finally {
      await reg.dispose()
    }
  })
})
