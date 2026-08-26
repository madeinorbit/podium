import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  actorAgent,
  asAgentIdentityId,
  asMachineId,
  asMutationId,
  asSessionId,
  asUserId,
  FIRST_ADMIN_USER_ID,
  type SessionId,
  type SessionMeta,
  SOLE_USER_ID,
} from '@podium/model'
import { asDelegationRef, type MetadataChange, type ServerMessage } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'

/** One host across the simulated restart: storeA writes rows under this id and storeB
 *  re-opens the same file as the same machine, which is what a real reboot is. Without
 *  pinning it each store would mint its own (POD-318) and the restart would look like
 *  a different computer. */
const TEST_MACHINE = asMachineId('machine-under-test')

import { userCommandPrincipal } from './command-principal'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'
import { attachTestClient } from './test-support/client-transport'
import { advanceToComposerReady, advanceUntil } from './test-support/readiness-queue'

// Outbox write path at the registry seam (docs/spec/outbox-write-path.md §2.1-2.2):
// queueText wake + durable delivery, restart survival, FIFO + spacing, the
// withMutation idempotency wrapper, failed-drain row retention, and the
// queuedMessageCount surfacing on the wire (snapshot meta + P2 delta stream).
// The settle-heuristic behaviors themselves (floor/quiet/max) are covered by
// relay.test.ts's 'queueText drain' describe — not duplicated here.

const G = { cols: 80, rows: 24 }
const bind = (sessionId: SessionId) =>
  ({
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/',
    agentKind: 'claude-code',
    geometry: G,
  }) as const

const decodedInputs = (daemon: ControlMessage[]): string[] =>
  daemon
    .filter((m) => m.type === 'input')
    .map((m) => Buffer.from((m as { data: string }).data, 'base64').toString())

const pastesContaining = (daemon: ControlMessage[], text: string): string[] =>
  decodedInputs(daemon).filter((t) => t.includes(text))

/** live claude session with a resume ref, parked via hibernate. */
function hibernatedSession(reg: SessionRegistry): string {
  const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
  reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(sessionId))
  reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
    type: 'sessionResumeRef',
    sessionId,
    resume: { kind: 'claude-session', value: 'abc-123' },
  })
  expect(reg.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
  return sessionId
}

/** Drive the readiness engine to 'settled' after a bind: a short burst of output,
 *  then quiet long enough to clear the floor(800)+quiet(600) window (fake timers). */
function settle(reg: SessionRegistry, sessionId: string): void {
  let seq = 0
  for (let i = 0; i < 5; i += 1) {
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentFrame',
      sessionId: asSessionId(sessionId),
      seq: seq++,
      data: 'eA==',
    })
    vi.advanceTimersByTime(200)
  }
  // A resumed CLI is ready when its harness reports state for THIS process,
  // not merely when its boot paint goes quiet (POD-1100). This is the proof the
  // real harness emits after bind and the old fixture omitted.
  reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
    type: 'agentState',
    sessionId: asSessionId(sessionId),
    state: { phase: 'idle', since: new Date(Date.now()).toISOString(), nativeSubagentCount: 0 },
  })
  vi.advanceTimersByTime(1400)
}

/**
 * THE TWO LANES AGREE FROM HERE, AND THIS IS THE SENTENCE THAT SAYS SO (POD-2842).
 *
 * THE OPPOSING TEST IS `apps/server/src/modules/sessions/inbox.test.ts` — the
 * SERVICES-lane unit over the same call, which asserts `{ok: true, queued:
 * true}` for a chat send to a bound claude-code session and nothing on the PTY
 * until the readiness window has run. THAT ONE IS THE CONTRACT. This file is
 * the BOUNDARY lane, and until POD-2842 it asserted the opposite about that one
 * call: a bare `{ok: true}` at :541, and a queue row that was gone the moment
 * the paste was on the wire. `relay.test.ts` held the same contradiction and
 * POD-2837 resolved it the same way.
 *
 * THE QUEUE IS THE CONTRACT for a bound, idle claude-code session (ruled
 * 2026-08-26, `docs/plans/pod-1761-release-ledger.md`). A bind makes a session
 * live BEFORE its composer is mounted, and bytes typed into an unmounted
 * composer are accepted by the pty and dropped by the app (POD-2116) — a SILENT
 * loss, where the queue's cost is a visible wait. Claude's composer readiness
 * cannot be observed at all (`composerReadiness: 'confirmed-turn'`, POD-2823),
 * so the only proof it will take typing is a user turn in the transcript.
 *
 * SO IF YOU CHANGE ONE LANE, CHANGE THE OTHER. A repo that asserts both answers
 * drifts back to whichever one nobody runs — which is exactly how this file sat
 * red for days while `inbox.test.ts` stayed green.
 *
 * WHAT DID NOT CHANGE IS A SINGLE BYTE. The bracketed-paste envelopes, the
 * exactly-once delivery, the FIFO order and the durable rows are asserted below
 * exactly as they were. What moved is that a typed row is now HELD until the
 * transcript witnesses it, so "delivered" is asserted after that proof rather
 * than at the moment of typing.
 */
/**
 * THE PROOF A CLAUDE COMPOSER TOOK THE ROW, and the only one there is: a user
 * turn in the transcript. `composerReadiness: 'confirmed-turn'` means the CLI
 * publishes nothing an observer can read, so the drain types the row and then
 * HOLDS it — durable, still counted, still the operator's — until this frame
 * arrives. Every "delivered" assertion below is asserted after it, and the
 * "still queued" assertions before it are what say the hold is real.
 */
function confirmUserTurn(reg: SessionRegistry, sessionId: string, text: string): void {
  reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
    type: 'transcriptDelta',
    sessionId: asSessionId(sessionId),
    items: [{ id: `turn-${text}`, role: 'user' as const, text, cursor: `c-${text}` }],
    tail: `c-${text}`,
  })
}

/** The durable rows this session still holds. */
const queuedRows = (reg: SessionRegistry, sessionId: string) =>
  reg.sessionStore.sync.listQueuedMessages(asSessionId(sessionId))

/** Step the clock until the head row settles out of the queue. */
const advanceUntilSettled = (reg: SessionRegistry, sessionId: string, text: string): void =>
  advanceUntil(
    () => !queuedRows(reg, sessionId).some((row) => row.text === text),
    `the transcript-confirmed row "${text}" settled`,
  )

describe('queueText (durable outbox sends)', () => {
  it('rejects an offline queued agent write when its human is revoked before drain', async () => {
    vi.useFakeTimers()
    try {
      const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
      const daemon: ControlMessage[] = []
      reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (message) => daemon.push(message))

      const source = reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/source',
      }).sessionId
      const target = reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/target',
        spawnedBy: `session:${source}`,
      }).sessionId
      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(target))
      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
        type: 'sessionResumeRef',
        sessionId: target,
        resume: { kind: 'claude-session', value: 'revocation-proof' },
      })
      expect(reg.modules.sessions.hibernateSession({ sessionId: target })).toEqual({ ok: true })
      daemon.length = 0

      const principal = {
        kind: 'agent' as const,
        principalRef: source,
        delegation: asDelegationRef(source),
        attribution: {
          actor: actorAgent(asAgentIdentityId(source)),
          onBehalfOf: FIRST_ADMIN_USER_ID,
        },
      }
      expect(
        reg.modules.sessions.queueText({
          sessionId: target,
          text: 'must not cross revocation',
          mutationId: asMutationId('revoke-before-drain'),
          principal,
        }),
      ).toEqual({ ok: true, queued: true })

      // User lifecycle writes intentionally have no repository API yet.
      // @ts-expect-error test-only revocation through SessionStore's private connection
      reg.sessionStore.db
        .prepare('UPDATE users SET disabled_at = ? WHERE id = ?')
        .run('2026-08-01T00:00:00.000Z', FIRST_ADMIN_USER_ID)

      await vi.waitFor(() =>
        expect(daemon).toContainEqual(
          expect.objectContaining({ type: 'spawn', sessionId: target }),
        ),
      )
      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(target))
      settle(reg, target)

      expect(pastesContaining(daemon, 'must not cross revocation')).toEqual([])
      expect(reg.sessionStore.sync.listQueuedMessages(target)).toEqual([])
      expect(
        reg.modules.sessions.listSessions().find((session) => session.sessionId === target)
          ?.queuedMessageCount,
      ).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
  it('wakes a hibernated resumable session, shows the count, and delivers exactly once after bind + settle', async () => {
    vi.useFakeTimers()
    try {
      const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
      const daemon: ControlMessage[] = []
      reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (m) => daemon.push(m))
      const sessionId = hibernatedSession(reg)
      daemon.length = 0

      expect(
        reg.modules.sessions.queueText({ sessionId: asSessionId(sessionId), text: 'wake-up-msg' }),
      ).toEqual({
        ok: true,
        queued: true,
      })

      // The wake follows async worktree/instruction preparation.
      await vi.waitFor(() =>
        expect(daemon).toContainEqual(
          expect.objectContaining({
            type: 'spawn',
            sessionId,
            resume: { kind: 'claude-session', value: 'abc-123' },
          }),
        ),
      )
      // The queued count rides the session meta while the message waits...
      expect(reg.modules.sessions.listSessions()[0]?.queuedMessageCount).toBe(1)
      // ...and nothing is typed while the respawn is still starting.
      expect(pastesContaining(daemon, 'wake-up-msg')).toHaveLength(0)

      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(asSessionId(sessionId)))
      settle(reg, sessionId)
      // `settle` above already ran the clock past the readiness window, so this
      // steps zero times — it is here to state the dependency, not to wait.
      advanceUntil(
        () => pastesContaining(daemon, 'wake-up-msg').length === 1,
        'the queued row reached the PTY',
      )

      // Exactly ONE bracketed-paste input containing the text (no double-type).
      expect(pastesContaining(daemon, 'wake-up-msg')).toEqual(['\x1b[200~wake-up-msg\x1b[201~'])
      // TYPED IS NOT DELIVERED. The bytes are in the CLI and the row is still
      // the operator's: counted, durable, and visible in the meta. Claiming
      // delivery here is the silent loss the queue exists to refuse.
      expect(reg.modules.sessions.listSessions()[0]?.queuedMessageCount).toBe(1)
      expect(queuedRows(reg, sessionId)).toHaveLength(1)

      confirmUserTurn(reg, sessionId, 'wake-up-msg')
      advanceUntilSettled(reg, sessionId, 'wake-up-msg')

      // Delivered: the count leaves the meta and the durable row is gone.
      expect(reg.modules.sessions.listSessions()[0]?.queuedMessageCount).toBeUndefined()
      expect(reg.sessionStore.sync.listQueuedMessages(asSessionId(sessionId))).toEqual([])
      // And still exactly one paste — the confirmation settles the row, it
      // never retypes it.
      expect(pastesContaining(daemon, 'wake-up-msg')).toEqual(['\x1b[200~wake-up-msg\x1b[201~'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a due one-off wakes a hibernated target and delivers its message exactly once', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T22:00:00.000Z'))
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    try {
      const daemon: ControlMessage[] = []
      reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (message) => daemon.push(message))
      const sessionId = hibernatedSession(reg)
      daemon.length = 0
      const runAt = '2026-07-16T22:02:00.000Z'
      const automation = reg.modules.automations.create(
        {
          name: 'Night quota wake',
          scheduleKind: 'once',
          runAt,
          targetSessionId: asSessionId(sessionId),
          repoPath: '/w',
          agentKind: 'claude-code',
          prompt: 'continue-night-work',
          enabled: true,
          sessionMode: 'resume',
        },
        userCommandPrincipal(asUserId(SOLE_USER_ID), 'admin'),
      )

      vi.setSystemTime(new Date('2026-07-16T22:02:01.000Z'))

      reg.modules.automations.tick()
      await vi.waitFor(() =>
        expect(daemon).toContainEqual(
          expect.objectContaining({
            type: 'spawn',
            sessionId,
            resume: { kind: 'claude-session', value: 'abc-123' },
          }),
        ),
      )
      expect(pastesContaining(daemon, 'continue-night-work')).toHaveLength(0)

      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(asSessionId(sessionId)))
      settle(reg, sessionId)

      expect(pastesContaining(daemon, 'continue-night-work')).toEqual([
        '\x1b[200~continue-night-work\x1b[201~',
      ])
      expect(reg.modules.automations.runs(automation.id)).toEqual([
        expect.objectContaining({ outcome: 'spawned', sessionId }),
      ])
      expect(reg.modules.automations.list()[0]).toMatchObject({
        enabled: false,
        nextRunAt: null,
        lastRunAt: runAt,
      })

      reg.modules.automations.tick()
      expect(reg.modules.automations.runs(automation.id)).toHaveLength(1)
      expect(pastesContaining(daemon, 'continue-night-work')).toHaveLength(1)
    } finally {
      reg.dispose()
      vi.useRealTimers()
    }
  })

  it('refuses a parked agent with no resume ref and queues NOTHING', () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    const daemon: ControlMessage[] = []
    reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (m) => daemon.push(m))
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(sessionId))
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId,
      code: 1,
    })
    daemon.length = 0

    expect(reg.modules.sessions.queueText({ sessionId, text: 'into-the-void' })).toEqual({
      ok: false,
      reason: 'no resume ref',
    })
    // No durable row, no count on the meta, no wake attempt.
    expect(reg.sessionStore.sync.listQueuedMessages(sessionId)).toEqual([])
    expect(reg.modules.sessions.listSessions()[0]?.queuedMessageCount).toBeUndefined()
    expect(daemon.filter((m) => m.type === 'spawn')).toEqual([])
  })

  it('survives a server restart: count re-seeds from the table and delivery happens after the wake', async () => {
    vi.useFakeTimers()
    try {
      const file = join(mkdtempSync(join(tmpdir(), 'podium-outbox-relay-')), 'podium.db')
      const storeA = new SessionStore(file, TEST_MACHINE)
      const regA = new SessionRegistry(storeA, undefined, { instanceId: 'default' })
      const daemonA: ControlMessage[] = []
      regA.gateway.attachDaemon(regA.sessionStore.hostMachineId, (m) => daemonA.push(m))
      const sessionId = hibernatedSession(regA)
      expect(
        regA.modules.sessions.queueText({
          sessionId: asSessionId(sessionId),
          text: 'survive-restart',
        }),
      ).toEqual({
        ok: true,
        queued: true,
      })

      await vi.waitFor(() => expect(daemonA.some((message) => message.type === 'spawn')).toBe(true))
      expect(pastesContaining(daemonA, 'survive-restart')).toHaveLength(0)
      regA.dispose()
      storeA.close()

      // Restart: fresh store + registry over the same DB file.
      const storeB = new SessionStore(file, TEST_MACHINE)
      const regB = new SessionRegistry(storeB, undefined, { instanceId: 'default' })
      expect(
        regB.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
          ?.queuedMessageCount,
      ).toBe(1)

      const daemonB: ControlMessage[] = []
      regB.gateway.attachDaemon(regB.sessionStore.hostMachineId, (m) => daemonB.push(m))
      regB.gateway.routeDaemonFrame(regB.sessionStore.hostMachineId, bind(asSessionId(sessionId)))
      // Silent respawn: no harness state at all, so the readiness window has
      // nothing to settle against and falls back to its ceiling. Stepped rather
      // than jumped — see `advanceToComposerReady`.
      advanceToComposerReady(() => pastesContaining(daemonB, 'survive-restart').length)
      expect(pastesContaining(daemonB, 'survive-restart')).toHaveLength(1)
      // Typed by the NEW process, and still held by it: a row that crossed a
      // restart is confirmed from the transcript like any other.
      expect(queuedRows(regB, sessionId)).toHaveLength(1)

      confirmUserTurn(regB, sessionId, 'survive-restart')
      advanceUntilSettled(regB, sessionId, 'survive-restart')
      expect(regB.sessionStore.sync.listQueuedMessages(asSessionId(sessionId))).toEqual([])
      expect(
        regB.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
          ?.queuedMessageCount,
      ).toBeUndefined()
      // Exactly once across the restart — the row the old process queued was
      // typed by the new one, not by both.
      expect(pastesContaining(daemonB, 'survive-restart')).toHaveLength(1)
      regB.dispose()
      storeB.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers two queued messages FIFO, spaced, each as its own input', () => {
    vi.useFakeTimers()
    try {
      const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
      const daemon: ControlMessage[] = []
      reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (m) => daemon.push(m))
      const { sessionId } = reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/w',
      })
      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(sessionId))

      reg.modules.sessions.queueText({ sessionId, text: 'first-msg' })
      reg.modules.sessions.queueText({ sessionId, text: 'second-msg' })
      expect(reg.modules.sessions.listSessions()[0]?.queuedMessageCount).toBe(2)

      // Silent TUI → the readiness window falls back to its ceiling and the head
      // is typed. Stepped, not jumped: the old `advanceTimersByTime(6_400)` wrote
      // down a constant POD-2836 is about to move.
      advanceToComposerReady(() => pastesContaining(daemon, 'first-msg').length)
      expect(pastesContaining(daemon, 'first-msg')).toHaveLength(1)
      // ...and the second is not fused onto the same tick. It cannot even be
      // ATTEMPTED yet: the head is typed but unconfirmed, so both rows are still
      // durable and still counted.
      expect(pastesContaining(daemon, 'second-msg')).toHaveLength(0)
      expect(reg.modules.sessions.listSessions()[0]?.queuedMessageCount).toBe(2)

      confirmUserTurn(reg, sessionId, 'first-msg')
      // Settle the head, and stop on the step that settles it — inside the
      // spacing gap, which is the only place the gap can be observed.
      advanceUntilSettled(reg, sessionId, 'first-msg')
      // THE SPACING IS PINNED HERE, and it takes the one-millisecond step to pin
      // it: this fake clock does not run a timer scheduled DURING a tick until
      // the next advance, so "the second has not gone out yet" is equally true
      // of a zero spacing. A zero-spacing `deliverNext` has already landed by
      // the +1ms mark; a spaced one has not.
      expect(pastesContaining(daemon, 'second-msg')).toHaveLength(0)
      vi.advanceTimersByTime(1)
      expect(pastesContaining(daemon, 'second-msg')).toHaveLength(0)
      advanceUntil(
        () => pastesContaining(daemon, 'second-msg').length === 1,
        'the second row reached the PTY',
      )

      // Both delivered, in enqueue order, as SEPARATE bracketed-paste inputs.
      const pastes = decodedInputs(daemon).filter((t) => t.startsWith('\x1b[200~'))
      expect(pastes).toEqual(['\x1b[200~first-msg\x1b[201~', '\x1b[200~second-msg\x1b[201~'])
      expect(reg.modules.sessions.listSessions()[0]?.queuedMessageCount).toBeUndefined()
      expect(reg.sessionStore.sync.listQueuedMessages(sessionId)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failed drain (never live before the deadline) keeps the rows; the next bind delivers', () => {
    vi.useFakeTimers()
    try {
      const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
      const daemon: ControlMessage[] = []
      reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (m) => daemon.push(m))
      // No bind: the session sits in 'starting' past the 25s drain deadline.
      const { sessionId } = reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/w',
      })
      reg.modules.sessions.queueText({ sessionId, text: 'patient-msg' })

      vi.advanceTimersByTime(26_000)
      expect(pastesContaining(daemon, 'patient-msg')).toHaveLength(0)
      // The attempt gave up but the ROWS REMAIN — nothing was dropped.
      expect(reg.sessionStore.sync.listQueuedMessages(sessionId)).toHaveLength(1)
      expect(reg.modules.sessions.listSessions()[0]?.queuedMessageCount).toBe(1)

      // The PTY finally binds → a fresh attempt re-arms and types after settle.
      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(sessionId))
      settle(reg, sessionId)
      // `settle` above already ran the clock past the readiness window, so this
      // steps zero times — it is here to state the dependency, not to wait.
      advanceUntil(
        () => pastesContaining(daemon, 'patient-msg').length === 1,
        'the queued row reached the PTY',
      )
      expect(pastesContaining(daemon, 'patient-msg')).toHaveLength(1)
      // Typed once, and still held: the abandoned pass did not spend the row's
      // one at-most-once attempt, and the new pass does not claim delivery
      // until the transcript witnesses it.
      expect(queuedRows(reg, sessionId)).toHaveLength(1)

      confirmUserTurn(reg, sessionId, 'patient-msg')
      advanceUntilSettled(reg, sessionId, 'patient-msg')
      expect(pastesContaining(daemon, 'patient-msg')).toHaveLength(1)
      expect(reg.sessionStore.sync.listQueuedMessages(sessionId)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces the queued count on the P2 delta stream (session upsert with queuedMessageCount 1)', () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, () => {})
    const sessionId = hibernatedSession(reg)

    const inbox: ServerMessage[] = []
    const clientId = attachTestClient(reg.clientGateway, (m) => inbox.push(m))
    reg.clientGateway.routeClientFrame(clientId, {
      type: 'hello',
      wireVersion: 2,
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps: ['metadataDelta'],
    })
    const before = inbox.length

    reg.modules.sessions.queueText({
      sessionId: asSessionId(sessionId),
      text: 'queued-while-parked',
    })
    reg.modules.sessions.flushBroadcasts() // earlier setup broadcasts armed the coalescer — run the pending pipeline

    const changes = inbox.slice(before).flatMap((message) => {
      if (message.type === 'metadataDelta') return message.changes
      if (message.type !== 'feedDelta') return []
      return message.changes
        .filter((change) => change.op !== 'evict')
        .map((change) => ({ ...change, id: change.entityId }) as MetadataChange)
    })
    const upserts = changes.filter(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    )
    expect(upserts.length).toBeGreaterThanOrEqual(1)
    expect(upserts.some((c) => (c.value as SessionMeta).queuedMessageCount === 1)).toBe(true)
  })

  it('clears an existing snooze when a message is queued (fresh user intent)', () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, () => {})
    const sessionId = hibernatedSession(reg)
    reg.modules.sessions.setSnooze({
      userId: SOLE_USER_ID,
      sessionId: asSessionId(sessionId),
      until: null,
    })
    expect(reg.modules.sessions.listSessions()[0]?.snoozedUntil).toBeNull()

    reg.modules.sessions.queueText({ sessionId: asSessionId(sessionId), text: 'un-snooze' })
    expect('snoozedUntil' in (reg.modules.sessions.listSessions()[0] ?? {})).toBe(false)
    expect(reg.sessionStore.sessions.listSnoozes(asUserId(SOLE_USER_ID))).toEqual({})
  })
})

/**
 * FRAMEWORK IDEMPOTENCY as the REGISTRY exposes it (POD-382).
 *
 * These cases were written against `SessionLifecycle.withMutation` and now run
 * against `modules.mutations` — `@podium/sync`'s `MutationLedger`, the one
 * implementation — over the SAME durable table. Renamed rather than duplicated:
 * a case left wearing the old name would claim a wrapper that no longer exists.
 *
 * The ledger's own semantics are unit-tested in
 * packages/sync/src/mutation-ledger.test.ts; what these add is that the wiring in
 * the composition root reaches it, and that a replay through it does not
 * double-type into a real PTY.
 */
describe('framework idempotency (modules.mutations)', () => {
  it('runs once per id; a replay returns the recorded result without re-running', () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    let runs = 0
    const first = reg.modules.mutations.once(asMutationId('m-1'), 'test.proc', () => {
      runs += 1
      return { ok: true, ids: ['a', 'b'] }
    })
    const replay = reg.modules.mutations.once(asMutationId('m-1'), 'test.proc', () => {
      runs += 1
      return { ok: true, ids: ['DIFFERENT'] }
    })
    expect(runs).toBe(1)
    expect(first).toEqual({ ok: true, ids: ['a', 'b'] })
    expect(replay).toEqual(first) // deep-equal via the JSON round-trip

    // A different id runs again.
    const other = reg.modules.mutations.once(asMutationId('m-2'), 'test.proc', () => {
      runs += 1
      return { ok: true, ids: ['c'] }
    })
    expect(runs).toBe(2)
    expect(other).toEqual({ ok: true, ids: ['c'] })

    // No id at all = today's behavior: always runs.
    reg.modules.mutations.once(undefined, 'test.proc', () => {
      runs += 1
      return 1
    })
    reg.modules.mutations.once(undefined, 'test.proc', () => {
      runs += 1
      return 1
    })
    expect(runs).toBe(4)
  })

  it('records the RESOLVED value of an async proc, not the pending Promise (issues.create shape)', async () => {
    // Regression guard: JSON.stringify(promise) === '{}', which would poison every
    // replay of an async proc with an empty object.
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    let runs = 0
    const fn = async () => {
      runs += 1
      return { id: 'issue-1', title: 'once' }
    }
    const first = await reg.modules.mutations.once(asMutationId('m-async'), 'issues.create', fn)
    const replay = await reg.modules.mutations.once(asMutationId('m-async'), 'issues.create', fn)
    expect(runs).toBe(1)
    expect(first).toEqual({ id: 'issue-1', title: 'once' })
    expect(replay).toEqual(first)
  })

  it('a replayed sendText types exactly one input frame (no double-type into the PTY)', () => {
    vi.useFakeTimers()
    try {
      const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
      const daemon: ControlMessage[] = []
      reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (m) => daemon.push(m))
      const { sessionId } = reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/w',
      })
      reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(sessionId))

      const send = () =>
        reg.modules.mutations.once(asMutationId('send-1'), 'sessions.sendText', () =>
          reg.modules.sessions.sendText({ sessionId, text: 'only-once' }),
        )
      // ONE ANSWER, THE SAME ONE `inbox.test.ts` GIVES (POD-2842): the send is
      // accepted and HELD, not typed. `queued: true` is the caller's warning
      // that the bytes are not on the wire yet — see the note above
      // `describe('queueText (durable outbox sends)')` for why that is the
      // contract, and why this file used to say the opposite on this very line.
      expect(send()).toEqual({ ok: true, queued: true })
      expect(send()).toEqual({ ok: true, queued: true }) // recorded result, fn not re-run
      // Nothing is typed into a composer that has not proven it is mounted.
      vi.advanceTimersByTime(100)
      expect(decodedInputs(daemon)).toEqual([])

      advanceToComposerReady(() => pastesContaining(daemon, 'only-once').length)
      // Flush the deferred submit CR. This file does not PIN that delay — with
      // `SUBMIT_CR_DELAY_MS = 0` all 12 checks here stay green (measured,
      // POD-2842). `expectSubmitStillDeferred` in `relay.test.ts` is what pins
      // it; the assertion below is about how MANY frames, not about when.
      vi.advanceTimersByTime(200)

      expect(pastesContaining(daemon, 'only-once')).toHaveLength(1)
      // One paste + one CR — nothing else went to the PTY. THIS is the assertion
      // the test is named for: a replay must not put a second copy in the
      // composer, and the readiness queue moved WHEN it is typed, never how many
      // times.
      expect(decodedInputs(daemon)).toEqual(['\x1b[200~only-once\x1b[201~', '\r'])
    } finally {
      vi.useRealTimers()
    }
  })
})
