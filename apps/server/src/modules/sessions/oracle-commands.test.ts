import { attachTestClient } from '../../test-support/client-transport'

/**
 * ORACLE — command-class session writes (POD-379 for POD-312 / POD-381).
 *
 * create · resume · kill · hibernate · resurrect · interrupt · sendText · resumeAndSend ·
 * answerAskUserQuestion · continue.
 *
 * These are the writes that command a PROCESS, so what is pinned here is the
 * control message that reaches the daemon, its ORDER, the refusal REASONS
 * (returned, not thrown, for the lifecycle primitives), and what survives in
 * the durable row. See oracle-support.ts for the tag contract.
 */

import type { SessionId } from '@podium/model'
import { asMachineId, asUserId, asSessionId, SOLE_USER_ID } from '@podium/model'
import { type ServerMessage, WIRE_VERSION } from '@podium/protocol'
import { type ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  disposeOracles,
  MUST_NOT_CHANGE,
  makeOracle,
  PASTE_END,
  PASTE_START,
  ptyFrames,
  waitFor,
  willChange,
} from './oracle-support'

afterEach(() => disposeOracles())

const RESUME = { kind: 'claude-session', value: 'native-1' } as const

const inputs = (daemon: ControlMessage[]) =>
  daemon.filter((m): m is Extract<ControlMessage, { type: 'input' }> => m.type === 'input')

const confirmUserTurn = (
  o: ReturnType<typeof makeOracle>,
  sessionId: SessionId,
  text: string,
): void =>
  o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'transcriptDelta',
    sessionId,
    items: [{ id: `turn-${text}`, role: 'user' as const, text, cursor: `c-${text}` }],
    tail: `c-${text}`,
  })

const hasSessionDelete = (client: ServerMessage[], sessionId: SessionId) =>
  client.some(
    (message) =>
      (message.type === 'feedDelta' || message.type === 'feedBootstrap') &&
      message.changes.some(
        (change) =>
          change.entity === 'session' && change.entityId === sessionId && change.op === 'remove',
      ),
  )

/** Bind a created session as a live agent with a known resume ref and phase. */
function goLive(
  o: ReturnType<typeof makeOracle>,
  sessionId: SessionId,
  phase: 'idle' | 'working' | 'errored' = 'idle',
): void {
  o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/p',
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  })
  o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'sessionResumeRef',
    sessionId,
    resume: RESUME,
    confidence: 'exact',
  })
  o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'agentState',
    sessionId,
    state: { phase, since: new Date().toISOString(), nativeSubagentCount: 0 },
  })
}

describe('oracle: create', () => {
  it(`${MUST_NOT_CHANGE}: create spawns on the daemon, persists the row, and returns the id the client may have chosen`, async () => {
    const o = makeOracle()
    const clientId = '11111111-1111-4111-8111-111111111111'

    const { sessionId } = await o.call.sessions.create({
      agentKind: 'claude-code',
      cwd: '/p',
      sessionId: clientId,
    })

    expect(sessionId).toBe(clientId)
    expect(o.daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd: '/p' }),
    )
    expect(o.store.sessions.loadSessions().map((r) => r.id)).toEqual([clientId])
  })

  it(`${MUST_NOT_CHANGE}: a non-uuid client sessionId is refused before it can reach the durable-label / scope path`, async () => {
    const o = makeOracle()

    await expect(
      o.call.sessions.create({
        agentKind: 'claude-code',
        cwd: '/p',
        sessionId: asSessionId('../../evil'),
      }),
    ).rejects.toThrow()
    expect(o.store.sessions.loadSessions()).toEqual([])
  })

  it(`${willChange('POD-1079', "machines become owned compute; 'use' defaults to the owner only")}: placement is ambient — any authenticated caller may spawn on any paired machine`, async () => {
    const o = makeOracle()
    // A second paired machine nobody "owns": there is no owner column today.
    o.store.machines.upsertMachine({
      id: 'other',
      name: 'other',
      hostname: 'o',
      tokenHash: 'x',
      ownerUserId: asUserId('user:sole'),
    })
    const other: ControlMessage[] = []
    o.reg.gateway.attachDaemon('other', (m) => other.push(m))

    const { sessionId } = await o.call.sessions.create({
      agentKind: 'shell',
      cwd: '/p',
      machineId: 'other',
    })

    expect(other).toContainEqual(expect.objectContaining({ type: 'spawn', sessionId }))
    expect(o.daemon.filter((m) => m.type === 'spawn')).toHaveLength(0)
    expect(o.meta(sessionId).machineId).toBe('other')
  })
})

describe('oracle: resume', () => {
  it(`${MUST_NOT_CHANGE}: a resume with no matching row spawns a fresh session carrying the resume ref`, async () => {
    const o = makeOracle()

    const { sessionId } = await o.call.sessions.resume({
      agentKind: 'claude-code',
      cwd: '/p',
      resume: RESUME,
      conversationId: 'native-1',
    })

    expect(o.daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, resume: RESUME }),
    )
    expect(o.meta(sessionId).resume).toEqual(RESUME)
  })

  it(`${MUST_NOT_CHANGE}: resuming an EXISTING row reuses it instead of minting a second session`, async () => {
    const o = makeOracle()
    const first = await o.call.sessions.resume({
      agentKind: 'claude-code',
      cwd: '/p',
      resume: RESUME,
      conversationId: 'native-1',
    })

    const second = await o.call.sessions.resume({
      agentKind: 'claude-code',
      cwd: '/p',
      resume: RESUME,
      conversationId: 'native-1',
    })

    expect(second.sessionId).toBe(first.sessionId)
    expect(o.reg.modules.sessions.listSessions()).toHaveLength(1)
  })
})

describe('oracle: hibernate', () => {
  it(`${MUST_NOT_CHANGE}: hibernate parks a live session — status flips and the daemon is told to kill the process`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)

    expect(await o.call.sessions.hibernate({ sessionId })).toEqual({ ok: true })

    expect(o.meta(sessionId).status).toBe('hibernated')
    expect(o.daemon).toContainEqual(expect.objectContaining({ type: 'kill', sessionId }))
    expect(o.store.sessions.loadSessions().find((r) => r.id === sessionId)?.status).toBe(
      'hibernated',
    )
  })

  it(`${MUST_NOT_CHANGE}: hibernate REFUSES with a reason (never a throw) when the session is not running`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId,
      code: 0,
    })

    expect(await o.call.sessions.hibernate({ sessionId })).toEqual({
      ok: false,
      reason: 'not running',
    })
  })

  it(`${MUST_NOT_CHANGE}: hibernate refuses a live session with no resume ref — parking it would lose the conversation`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/p',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })

    const refused = await o.call.sessions.hibernate({ sessionId })

    expect(refused.ok).toBe(false)
    expect(refused.reason).toBe('no resume ref yet — the agent has not reported one')
    expect(o.meta(sessionId).status).toBe('live')
  })

  it(`${MUST_NOT_CHANGE}: hibernate refuses a WORKING agent so an in-flight turn is never killed`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId, 'working')

    expect(await o.call.sessions.hibernate({ sessionId })).toEqual({
      ok: false,
      reason: 'agent is working — let it reach idle first',
    })
    expect(o.meta(sessionId).status).toBe('live')
  })
})

describe('oracle: resurrect', () => {
  it(`${MUST_NOT_CHANGE}: resurrect respawns a parked session with its resume ref and moves it to 'starting'`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    await o.call.sessions.hibernate({ sessionId })
    o.daemon.length = 0

    expect(await o.call.sessions.resurrect({ sessionId })).toEqual({ ok: true })

    expect(o.meta(sessionId).status).toBe('starting')
    expect(o.daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, resume: RESUME }),
    )
  })

  it(`${MUST_NOT_CHANGE}: resurrect is idempotent for a still-running session, so a stale banner cannot turn a successful wake into an error`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    const daemonFrames = o.daemon.length

    expect(await o.call.sessions.resurrect({ sessionId })).toEqual({ ok: true })
    expect(o.daemon).toHaveLength(daemonFrames)
  })

  it(`${MUST_NOT_CHANGE}: Grok resurrection stays non-live until a ready bind and persists failure, retry, and pointer truth [POD-2942]`, async () => {
    const o = makeOracle()
    const machineId = o.reg.sessionStore.hostMachineId
    const resume = { kind: 'grok-session', value: 'native-grok-pod-2942' } as const
    const { sessionId } = await o.call.sessions.create({
      agentKind: 'grok',
      cwd: '/p',
      sessionId: '29420000-0000-4000-8000-000000000001',
    })
    o.reg.gateway.routeDaemonFrame(machineId, {
      type: 'bind',
      sessionId,
      cmd: 'grok agent stdio (grok-acp)',
      cwd: '/p',
      agentKind: 'grok',
      geometry: { cols: 80, rows: 24 },
      runtimeContract: true,
      driverId: 'grok-acp',
    })
    o.reg.gateway.routeDaemonFrame(machineId, {
      type: 'sessionResumeRef',
      sessionId,
      resume,
      confidence: 'exact',
    })
    o.reg.gateway.routeDaemonFrame(machineId, {
      type: 'agentState',
      sessionId,
      state: { phase: 'idle', since: new Date().toISOString(), nativeSubagentCount: 0 },
    })

    await expect(o.call.sessions.hibernate({ sessionId })).resolves.toEqual({ ok: true })
    expect(o.meta(sessionId)).toMatchObject({ status: 'hibernated', resume })
    expect(o.store.sessions.loadSessions().find((row) => row.id === sessionId)?.status).toBe(
      'hibernated',
    )

    o.daemon.length = 0
    await expect(o.call.sessions.resurrect({ sessionId })).resolves.toEqual({ ok: true })
    const firstSpawn = o.daemon.find(
      (frame): frame is Extract<ControlMessage, { type: 'spawn' }> =>
        frame.type === 'spawn' && frame.sessionId === sessionId,
    )
    expect(firstSpawn).toMatchObject({ sessionId, resume })
    expect(firstSpawn?.observationGeneration).toEqual(expect.any(Number))

    // No provider/session readiness confirmation means no bind. Across the
    // observation window from A7b, both the public projection and SQLite stay
    // `starting`; neither is painted live because resurrect accepted the wake.
    await Promise.resolve()
    expect(o.meta(sessionId).status).toBe('starting')
    expect(o.store.sessions.loadSessions().find((row) => row.id === sessionId)?.status).toBe(
      'starting',
    )

    o.reg.gateway.routeDaemonFrame(machineId, {
      type: 'spawnError',
      sessionId,
      message: 'session/load timed out',
    })
    expect(o.meta(sessionId).status).toBe('exited')
    expect(o.store.sessions.loadSessions().find((row) => row.id === sessionId)?.status).toBe(
      'exited',
    )

    // A retry preserves the same Podium row and provider pointer, while its
    // observation fence advances so a previous attempt cannot become current.
    o.daemon.length = 0
    await expect(o.call.sessions.resurrect({ sessionId })).resolves.toEqual({ ok: true })
    const secondSpawn = o.daemon.find(
      (frame): frame is Extract<ControlMessage, { type: 'spawn' }> =>
        frame.type === 'spawn' && frame.sessionId === sessionId,
    )
    expect(secondSpawn).toMatchObject({ sessionId, resume })
    expect(secondSpawn?.observationGeneration).toBeGreaterThan(
      firstSpawn?.observationGeneration as number,
    )
    expect(o.store.observationCheckpoints.get(sessionId)?.observationGeneration).toBe(
      secondSpawn?.observationGeneration,
    )
    expect(o.store.sessions.loadSessions().map((row) => row.id)).toEqual([sessionId])
    expect(o.meta(sessionId)).toMatchObject({ status: 'starting', resume })

    o.reg.gateway.routeDaemonFrame(machineId, {
      type: 'bind',
      sessionId,
      cmd: 'grok agent stdio (grok-acp)',
      cwd: '/p',
      agentKind: 'grok',
      geometry: { cols: 80, rows: 24 },
      runtimeContract: true,
      driverId: 'grok-acp',
    })
    expect(o.meta(sessionId)).toMatchObject({
      status: 'live',
      resume,
      driverId: 'grok-acp',
    })
    expect(o.store.sessions.loadSessions().find((row) => row.id === sessionId)).toMatchObject({
      status: 'live',
      selectedDriverId: 'grok-acp',
    })
  })

  it(`${MUST_NOT_CHANGE}: an exited AGENT with no resume ref cannot be resurrected; a shell can (a fresh spawn IS its recovery)`, async () => {
    const o = makeOracle()
    const agent = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId: agent.sessionId,
      code: 1,
    })
    const shell = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId: shell.sessionId,
      code: 1,
    })

    expect(await o.call.sessions.resurrect({ sessionId: agent.sessionId })).toEqual({
      ok: false,
      reason: 'no resume ref',
    })
    expect(await o.call.sessions.resurrect({ sessionId: shell.sessionId })).toEqual({ ok: true })
  })
})

describe('oracle: kill', () => {
  it(`${MUST_NOT_CHANGE}: kill tombstones the row with deletion_source 'standalone' and removes it from the live list`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    goLive(o, sessionId)

    await o.call.sessions.kill({ sessionId })

    expect(o.reg.modules.sessions.listSessions()).toEqual([])
    expect(o.store.sessions.loadSessions()).toEqual([])
    const tombstone = o.store.sessions.loadDeletedSessions().find((r) => r.id === sessionId)
    expect(tombstone?.deletionSource).toBe('standalone')
    expect(typeof tombstone?.deletedAt).toBe('string')
    expect(tombstone?.deletedByIssueId).toBeNull()
  })

  it(`${MUST_NOT_CHANGE}: kill signals the OWNING daemon — and only that one — and publishes the removal to clients`, async () => {
    // "Owning" is only assertable when a NON-owning machine exists to stay
    // silent. On a one-machine fixture the same assertion passes for a kill
    // broadcast to everyone, which is a different behaviour.
    const o = makeOracle({ offlineMachines: [{ id: asMachineId('other'), name: 'other' }] })
    const otherSeen: ControlMessage[] = []
    o.reg.gateway.attachDaemon('other', (m) => otherSeen.push(m))
    const { sessionId } = await o.call.sessions.create({
      agentKind: 'shell',
      cwd: '/p',
      machineId: 'other',
    })
    otherSeen.length = 0
    o.daemon.length = 0

    await o.call.sessions.kill({ sessionId })

    expect(otherSeen).toContainEqual(
      expect.objectContaining({ type: 'sessionBindingRetire', sessionId }),
    )
    expect(o.daemon.filter((m) => m.type === 'sessionBindingRetire')).toEqual([])
    await waitFor(
      () => hasSessionDelete(o.client, sessionId),
      'the removal to reach the attached client',
    )
  })
})
  it('coalesces resurrection while asynchronous worktree preparation is pending', async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId,
      code: 137,
    })
    o.daemon.length = 0

    let release!: (result: { ok: true; cwd: string }) => void
    vi.spyOn(o.reg.modules.sessions.workspace, 'ensureSessionWorktree').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )

    const first = o.reg.modules.issueSessionLifecycle.resurrectSession({ sessionId })
    const second = o.reg.modules.issueSessionLifecycle.resurrectSession({ sessionId })
    expect(o.daemon.filter((message) => message.type === 'spawn')).toEqual([])

    release({ ok: true, cwd: '/p' })
    expect(await first).toEqual({ ok: true })
    expect(await second).toEqual({ ok: true })
    expect(o.daemon.filter((message) => message.type === 'spawn')).toHaveLength(1)
  })

describe('oracle: sendText / resumeAndSend', () => {
  /**
   * RE-PINNED, NOT RELAXED (POD-2792). The behaviour this characterizes — one
   * bare Esc, no replacement text, `ok` — is unchanged for a terminal session
   * and is still asserted here byte-for-byte. What the reply gained is
   * `requested: 'keystroke'`, which names WHICH delivery carried the stop.
   *
   * It was added because the other delivery had been missing entirely: a
   * server-family session has no PTY, the daemon discarded these bytes, and the
   * call answered a bare `{ ok: true }` that a caller could not tell from this
   * one. `ok` means the interrupt was REQUESTED, never that the turn stopped,
   * and `requested` is what makes the two proofs distinguishable at the wire.
   * Pinning the field here is the point: an edit that collapses them again is a
   * red test rather than a silent return to a stop that could not be checked.
   */
  it(`${MUST_NOT_CHANGE}: interrupt sends one bare Esc to the PTY and no replacement text`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId, 'working')
    o.daemon.length = 0

    expect(await o.call.sessions.interrupt({ sessionId })).toEqual({
      ok: true,
      requested: 'keystroke',
    })
    expect(ptyFrames(o.daemon)).toEqual([{ inputOrigin: 'controller', data: '\x1b' }])
  })

  /**
   * Paint the TUI for half a second, then go quiet — what a real CLI does after
   * a bind, and what lets `inbox.ts` call the composer ready from the SETTLE
   * heuristic (`READY_QUIET_MS` of silence past a `READY_FLOOR_MS` floor) in
   * about a second, rather than waiting out the ceiling a terminal that never
   * paints falls back to.
   *
   * SPREAD OVER TIME, NOT DUMPED IN ONE GO, and the difference is load-bearing:
   * the drain captures a BASELINE output timestamp on its first poll and asks
   * whether output has arrived SINCE. A burst that all lands before that poll
   * moves the baseline with it, so the session reads as one that never painted
   * and the check sits out the full ceiling — which is what a synchronous
   * five-frame loop here did.
   *
   * Purely an accelerator. If the host is loaded enough that the frames miss
   * their window, readiness falls back to the ceiling and the predicate wait
   * below simply returns later; nothing about what is asserted depends on it.
   */
  const paintTui = (o: ReturnType<typeof makeOracle>, sessionId: SessionId): void => {
    let seq = 0
    const painter = setInterval(() => {
      o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
        type: 'agentFrame',
        sessionId,
        seq: seq++,
        data: 'eA==',
      })
      if (seq >= 5) clearInterval(painter)
    }, 100)
    painter.unref?.()
  }

  /** Generous because it is a PREDICATE wait: it returns as soon as the row is typed. */
  const READINESS_TIMEOUT_MS = 20_000

  /**
   * The frames as they stood AT THE MOMENT OF DELIVERY, snapshotted inside the
   * predicate rather than re-read after the wait returns.
   *
   * The submitting CR is a SEPARATE, LATER write (`SUBMIT_CR_DELAY_MS`, POD-152),
   * so "one paste frame and nothing else" is a claim about an instant, not about
   * the session's whole life. Re-reading after the wait would make these two
   * checks a race against that delay under real timers — they would still pass
   * on a quiet host and fail on a loaded one, which is the flake this lane
   * refuses (`retry: 0`).
   *
   * THIS DOES NOT PIN THE DELAY, AND SAYING SO IS THE POINT (POD-2842). Under
   * real timers a zero-delay CR still lands on a later macrotask than the paste,
   * and `waitFor`'s own poll is a macrotask too — so the snapshot sees the paste
   * alone either way. MEASURED, not reasoned: `SUBMIT_CR_DELAY_MS = 0` leaves
   * all 35 checks in this file green. What pins it is
   * `expectSubmitStillDeferred` in `relay.test.ts` (BOUNDARY lane), on a fake
   * clock where one millisecond tells the two apart — the same mutation kills 4
   * there. An assertion that only LOOKS like a timing pin is worse than no
   * assertion, because it is trusted.
   */
  const framesWhenTyped = async (
    o: ReturnType<typeof makeOracle>,
    what: string,
  ): Promise<ReturnType<typeof ptyFrames>> => {
    let snapshot: ReturnType<typeof ptyFrames> = []
    await waitFor(
      () => {
        const frames = ptyFrames(o.daemon)
        if (frames.length === 0) return false
        snapshot = frames
        return true
      },
      what,
      READINESS_TIMEOUT_MS,
    )
    return snapshot
  }

  /**
   * THE TWO CHECKS BELOW DRIVE THE READINESS QUEUE, AND THIS SAYS WHY (POD-2842).
   *
   * THE OPPOSING TEST IS `apps/server/src/modules/sessions/inbox.test.ts` — the
   * unit over the same call, in THIS lane, which asserts `{ok: true, queued:
   * true}` and nothing on the PTY until the readiness window has run. THAT ONE
   * IS THE CONTRACT. `relay.test.ts` (BOUNDARY lane) says the same thing about
   * the same call since POD-2837, and `relay.outbox.test.ts` since POD-2842.
   * These two used to describe the third answer: bytes on the wire by the time
   * the call returned, which is why they timed out at `waitFor`'s 2s default
   * rather than failing an assertion.
   *
   * A bind makes a session live BEFORE its composer is mounted, and bytes typed
   * into an unmounted composer are accepted by the pty and DROPPED by the app
   * (POD-2116). Claude's composer readiness cannot be observed
   * (`composerReadiness: 'confirmed-turn'`, POD-2823), so the send is held and
   * typed once the window has run. SO IF YOU CHANGE ONE LANE, CHANGE THE OTHER.
   *
   * WHAT IS PINNED IS UNCHANGED: the exact frame sequence, one bracketed-paste
   * frame stamped `controller` and nothing else. Only the moment it is asserted
   * at moved, and `waitFor` is a predicate wait (POD-757) — never a sleep — so
   * nothing here writes down a window POD-2836 is about to move.
   */
  it(`${MUST_NOT_CHANGE}: sendText to a live session reports a disposition and reaches the PTY stamped 'controller' (operator via substrate), not 'human'`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    o.daemon.length = 0

    const result = await o.call.sessions.sendText({ sessionId, text: 'hello there' })

    expect(result.ok).toBe(true)
    expect(typeof result.disposition).toBe('string')
    // Accepted and HELD — the queue is the contract for this session, so the
    // call returning is not the bytes being on the wire.
    expect(inputs(o.daemon)).toEqual([])
    paintTui(o, sessionId)
    // Operator chat rides the messaging substrate (#237 / POD-729) but stamps
    // inputOrigin 'controller' — person-origin, so standing offers clear and
    // causal turns attribute as user input (POD-552). Agent mail stays 'mail'
    // (POD-118). Direct keystroke paths (answerAskUserQuestion) stamp 'human'.
    // EXACT frame sequence, not a substring: one bracketed-paste frame carrying
    // the text and nothing else. A wrapper change (an added CR, a split write, a
    // second frame) is a behaviour change the migration must not make silently.
    expect(await framesWhenTyped(o, 'the text to reach the PTY')).toEqual([
      { inputOrigin: 'controller', data: `${PASTE_START}hello there${PASTE_END}` },
    ])
  })

  it(`${MUST_NOT_CHANGE}: sendText bypasses controller gating — a chat send is an explicit user act, not a competing keyboard`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    // The claim is "bypasses CONTROLLER gating", so there has to BE a controller
    // that is not this caller — otherwise the test passes on a session nobody
    // controls and proves nothing about gating.
    const controllerId = attachTestClient(o.reg.clientGateway, () => {})
    o.reg.clientGateway.routeClientFrame(controllerId, {
      type: 'hello',
      wireVersion: WIRE_VERSION,
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
    })
    o.reg.clientGateway.routeClientFrame(controllerId, { type: 'attach', sessionId })
    expect(o.meta(sessionId).controllerId).toBe(controllerId)
    o.daemon.length = 0

    expect((await o.call.sessions.sendText({ sessionId, text: 'still lands' })).ok).toBe(true)
    // Held, not refused: the gating question is answered at ACCEPT time, and
    // the queue is only where the accepted send waits for the composer.
    expect(inputs(o.daemon)).toEqual([])
    paintTui(o, sessionId)
    expect(await framesWhenTyped(o, 'the gated-around send to reach the PTY')).toEqual([
      { inputOrigin: 'controller', data: `${PASTE_START}still lands${PASTE_END}` },
    ])
  })

  it(`${MUST_NOT_CHANGE}: resumeAndSend wakes a PARKED session (the send is not dropped)`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    await o.call.sessions.hibernate({ sessionId })
    o.daemon.length = 0

    const result = await o.call.sessions.resumeAndSend({ sessionId, text: 'wake up' })

    expect(result.ok).toBe(true)
    await waitFor(
      () => o.daemon.some((m) => m.type === 'spawn' && m.sessionId === sessionId),
      'the wake spawn to be dispatched',
    )
    expect(o.meta(sessionId).status).toBe('starting')
  })

  it('sendText after process-gone resurrects once and drains concurrent/replayed sends exactly once', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-31T00:00:00.000Z'))
      const o = makeOracle()
      const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
      goLive(o, sessionId)
      o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
        type: 'agentExit',
        sessionId,
        code: 137,
      })
      expect(o.meta(sessionId).status).toBe('exited')
      o.daemon.length = 0

      const [first, second] = await Promise.all([
        o.call.sessions.sendText({ sessionId, text: 'one', mutationId: 'm-dead-1' }),
        o.call.sessions.sendText({ sessionId, text: 'two', mutationId: 'm-dead-2' }),
      ])
      expect(first).toMatchObject({ ok: true, queued: true })
      expect(second).toMatchObject({ ok: true, queued: true })
      expect(o.daemon.filter((message) => message.type === 'spawn')).toHaveLength(1)

      await o.call.sessions.sendText({
        sessionId,
        text: 'one',
        mutationId: 'm-dead-1',
      })
      expect(o.daemon.filter((message) => message.type === 'spawn')).toHaveLength(1)
      expect(o.store.sync.listQueuedMessages(sessionId)).toHaveLength(2)

      o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
        type: 'bind',
        sessionId,
        cmd: 'claude',
        cwd: '/p',
        agentKind: 'claude-code',
        geometry: { cols: 80, rows: 24 },
      })
      o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
        type: 'agentState',
        sessionId,
        state: {
          phase: 'idle',
          since: '2026-08-31T00:00:01.000Z',
          nativeSubagentCount: 0,
        },
      })
      for (let i = 0; i < 5; i += 1) {
        o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
          type: 'agentFrame',
          sessionId,
          seq: i,
          data: 'eA==',
        })
        await vi.advanceTimersByTimeAsync(200)
      }
      await vi.advanceTimersByTimeAsync(3_000)

      const delivered = ptyFrames(o.daemon).map((frame) => frame.data)
      expect(delivered.filter((data) => data.includes('one'))).toHaveLength(1)
      expect(delivered.filter((data) => data.includes('two'))).toHaveLength(0)

      confirmUserTurn(o, sessionId, 'one')
      for (let i = 0; i < 50 && !ptyFrames(o.daemon).some((frame) => frame.data.includes('two')); i += 1) {
        await vi.advanceTimersByTimeAsync(200)
      }
      expect(ptyFrames(o.daemon).filter((frame) => frame.data.includes('two'))).toHaveLength(1)

      confirmUserTurn(o, sessionId, 'two')
      for (let i = 0; i < 50 && o.store.sync.listQueuedMessages(sessionId).length > 0; i += 1) {
        await vi.advanceTimersByTimeAsync(200)
      }
      expect(o.store.sync.listQueuedMessages(sessionId)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses archived and unresumable dead targets before durable acceptance', async () => {
    const archived = makeOracle()
    const { sessionId: archivedId } = await archived.call.sessions.create({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    goLive(archived, archivedId)
    archived.reg.gateway.routeDaemonFrame(archived.reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId: archivedId,
      code: 137,
    })
    await archived.call.sessions.setArchived({ sessionId: archivedId, archived: true })
    archived.daemon.length = 0

    expect(await archived.call.sessions.sendText({ sessionId: archivedId, text: 'do not wake' })).toEqual({
      ok: false,
      reason: 'session archived',
      disposition: 'dead_letter',
    })
    expect(archived.store.sync.listQueuedMessages(archivedId)).toEqual([])
    expect(archived.daemon.filter((message) => message.type === 'spawn')).toEqual([])

    const unsupported = makeOracle()
    const { sessionId: unsupportedId } = await unsupported.call.sessions.create({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    unsupported.reg.gateway.routeDaemonFrame(unsupported.reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId: unsupportedId,
      cmd: 'claude',
      cwd: '/p',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    unsupported.reg.gateway.routeDaemonFrame(unsupported.reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId: unsupportedId,
      code: 1,
    })

    expect(
      await unsupported.call.sessions.sendText({ sessionId: unsupportedId, text: 'cannot resume' }),
    ).toEqual({ ok: false, reason: 'no resume ref', disposition: 'dead_letter' })
    expect(unsupported.store.sync.listQueuedMessages(unsupportedId)).toEqual([])
  })

  it.each(['errored', 'idle'] as const)(
    'does not resurrect an already-live %s target',
    async (phase) => {
      const o = makeOracle()
      const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
      goLive(o, sessionId, phase)
      o.daemon.length = 0

      const result = await o.call.sessions.sendText({ sessionId, text: 'still live' })

      expect(result.ok).toBe(true)
      expect(o.daemon.filter((message) => message.type === 'spawn')).toEqual([])
    },
  )
})
describe('oracle: answerAskUserQuestion', () => {
  // The missing Enter is the load-bearing half: a LONE single-select question is
  // the one shape the native menu submits on the digit itself, so a closing CR
  // here would arrive after the dialog closed and land in the composer.
  it(`${MUST_NOT_CHANGE}: a single-select answer types the bare option digit (no Enter)`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    o.daemon.length = 0

    expect(
      await o.call.sessions.answerAskUserQuestion({ sessionId, choices: [{ optionIndices: [2] }] }),
    ).toEqual({ ok: true })

    expect(inputs(o.daemon).map((m) => Buffer.from(m.data, 'base64').toString())).toEqual(['2'])
    expect(inputs(o.daemon).map((m) => m.inputOrigin)).toEqual(['human'])
  })

  it(`${MUST_NOT_CHANGE}: two single-select questions each advance on their digit, and the pair ends on the confirm CR`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    o.daemon.length = 0

    await o.call.sessions.answerAskUserQuestion({
      sessionId,
      choices: [{ optionIndices: [1] }, { optionIndices: [2] }],
    })
    await waitFor(() => inputs(o.daemon).length === 3, 'both digits and the confirm CR')

    expect(inputs(o.daemon).map((m) => Buffer.from(m.data, 'base64').toString())).toEqual([
      '1',
      '2',
      '\r',
    ])
  })

  // POD-609 SUPERSEDES the two characterizations below. They pinned the payload
  // that the real menu silently ignores: a comma-joined `1,3\r` reaches the CLI
  // as ONE key event named "1,3" (its parser folds a multi-character chunk into
  // a single key), so no box was ever ticked, and the trailing CR then toggled
  // whatever row happened to be focused. What is pinned now is the sequence
  // verified against a live Claude Code 2.1.226 TUI — one keystroke per write,
  // Tab off a multi-select, one closing CR on the confirm step.
  it(`${MUST_NOT_CHANGE}: a multi-select answer types one digit per keystroke, then Tab off the question and CR to confirm`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    o.daemon.length = 0

    await o.call.sessions.answerAskUserQuestion({
      sessionId,
      choices: [{ optionIndices: [1, 3], multiSelect: true }],
    })
    await waitFor(() => inputs(o.daemon).length === 4, 'the whole multi-select keystroke script')

    expect(inputs(o.daemon).map((m) => Buffer.from(m.data, 'base64').toString())).toEqual([
      '1',
      '3',
      '\t',
      '\r',
    ])
    expect(inputs(o.daemon).map((m) => m.inputOrigin)).toEqual(['human', 'human', 'human', 'human'])
  })

  it(`${MUST_NOT_CHANGE}: a multi-question payload is typed in order, one keystroke per write, and ends with the confirm CR`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    o.daemon.length = 0

    await o.call.sessions.answerAskUserQuestion({
      sessionId,
      choices: [{ optionIndices: [1] }, { optionIndices: [2, 3], multiSelect: true }],
    })
    await waitFor(() => inputs(o.daemon).length === 5, 'the whole multi-question keystroke script')

    expect(inputs(o.daemon).map((m) => Buffer.from(m.data, 'base64').toString())).toEqual([
      '1',
      '2',
      '3',
      '\t',
      '\r',
    ])
  })

  it(`${MUST_NOT_CHANGE}: several picks alone mark a multi-select, so a client that cannot say so still lands`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    o.daemon.length = 0

    await o.call.sessions.answerAskUserQuestion({ sessionId, choices: [{ optionIndices: [1, 3] }] })
    await waitFor(() => inputs(o.daemon).length === 4, 'the inferred multi-select script')

    expect(inputs(o.daemon).map((m) => Buffer.from(m.data, 'base64').toString())).toEqual([
      '1',
      '3',
      '\t',
      '\r',
    ])
  })

  it(`${MUST_NOT_CHANGE}: a lone multi-select still gets its Tab and CR when only one option is picked`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    o.daemon.length = 0

    await o.call.sessions.answerAskUserQuestion({
      sessionId,
      choices: [{ optionIndices: [2], multiSelect: true }],
    })
    await waitFor(() => inputs(o.daemon).length === 3, 'the one-pick multi-select script')

    expect(inputs(o.daemon).map((m) => Buffer.from(m.data, 'base64').toString())).toEqual([
      '2',
      '\t',
      '\r',
    ])
  })

  it(`${MUST_NOT_CHANGE}: answering a session that is not live is refused with ok:false and types nothing`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    await o.call.sessions.hibernate({ sessionId })
    o.daemon.length = 0

    expect(
      await o.call.sessions.answerAskUserQuestion({ sessionId, choices: [{ optionIndices: [1] }] }),
    ).toEqual({ ok: false })
    expect(inputs(o.daemon)).toEqual([])
  })

  it(`${MUST_NOT_CHANGE}: free-text via Other types otherIndex, then text, then CR (after settle)`, async () => {
    vi.useFakeTimers()
    try {
      const o = makeOracle()
      const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
      goLive(o, sessionId)
      o.daemon.length = 0

      expect(
        await o.call.sessions.answerAskUserQuestion({
          sessionId,
          choices: [{ freeText: 'ship the long path', otherIndex: 3 }],
        }),
      ).toEqual({ ok: true })

      // Digit lands immediately so Other focuses before any free-text bytes.
      expect(inputs(o.daemon).map((m) => Buffer.from(m.data, 'base64').toString())).toEqual(['3'])
      expect(inputs(o.daemon).map((m) => m.inputOrigin)).toEqual(['human'])

      await vi.advanceTimersByTimeAsync(120)
      expect(inputs(o.daemon).map((m) => Buffer.from(m.data, 'base64').toString())).toEqual([
        '3',
        'ship the long path',
      ])

      // A LONE single-select question auto-submits on that CR, so the script
      // stops here — no closing confirm (POD-609).
      await vi.advanceTimersByTimeAsync(120)
      expect(inputs(o.daemon).map((m) => Buffer.from(m.data, 'base64').toString())).toEqual([
        '3',
        'ship the long path',
        '\r',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  // POD-770. A single-select question whose options carry `preview` text draws a
  // DIFFERENT native dialog: options in a left column, the preview on the right,
  // a Notes field, and NO Other row. There a digit only MOVES the highlight, a
  // digit past the last option is dropped, Enter selects the highlighted row and
  // `n` opens Notes. Reproduced against claude 2.1.228 in a PTY — the classic
  // script (`3`, text, CR) committed option 1 and threw the text away, and a bare
  // digit left the dialog open forever. These two pin the scripts that work.
  it(`${MUST_NOT_CHANGE}: an option on a PREVIEW question types the digit then a CR — the digit alone only moves the cursor`, async () => {
    vi.useFakeTimers()
    try {
      const o = makeOracle()
      const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
      goLive(o, sessionId)
      o.daemon.length = 0

      expect(
        await o.call.sessions.answerAskUserQuestion({
          sessionId,
          choices: [{ optionIndices: [2], previewLayout: true }],
        }),
      ).toEqual({ ok: true })

      const typed = () => inputs(o.daemon).map((m) => Buffer.from(m.data, 'base64').toString())
      expect(typed()).toEqual(['2'])
      // The CR is the SELECT here, not a closing confirm — a lone question
      // auto-submits on it, so the script stops.
      await vi.advanceTimersByTimeAsync(120)
      expect(typed()).toEqual(['2', '\r'])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(typed()).toEqual(['2', '\r'])
    } finally {
      vi.useRealTimers()
    }
  })

  it(`${MUST_NOT_CHANGE}: free text on a PREVIEW question types 'n', then the text, then CR — never the Other digit`, async () => {
    vi.useFakeTimers()
    try {
      const o = makeOracle()
      const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
      goLive(o, sessionId)
      o.daemon.length = 0

      expect(
        await o.call.sessions.answerAskUserQuestion({
          sessionId,
          // otherIndex still rides along from the card; the preview layout has no
          // Other row, so it must NOT be typed — 3 would fall off the end of a
          // two-option list and the text would be swallowed as menu keys.
          choices: [{ freeText: 'ship the long path', otherIndex: 3, previewLayout: true }],
        }),
      ).toEqual({ ok: true })

      const typed = () => inputs(o.daemon).map((m) => Buffer.from(m.data, 'base64').toString())
      expect(typed()).toEqual(['n'])
      await vi.advanceTimersByTimeAsync(120)
      expect(typed()).toEqual(['n', 'ship the long path'])
      await vi.advanceTimersByTimeAsync(120)
      expect(typed()).toEqual(['n', 'ship the long path', '\r'])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(typed()).toEqual(['n', 'ship the long path', '\r'])
    } finally {
      vi.useRealTimers()
    }
  })

  it(`${MUST_NOT_CHANGE}: an undeliverable choice refuses with a reason and types NOTHING — not even the choices it could have typed`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    o.daemon.length = 0

    // Q1 is answerable, Q2 is not. Typing Q1's digit and stopping would leave Q2
    // on its first row for the closing CR to commit — the POD-770 substitution.
    expect(
      await o.call.sessions.answerAskUserQuestion({
        sessionId,
        choices: [
          { optionIndices: [1] },
          { freeText: 'a custom answer', otherIndex: 3, previewLayout: true, multiSelect: true },
        ],
      }),
    ).toEqual({ ok: false, reason: 'question 2: a preview question cannot be multi-select' })
    expect(inputs(o.daemon)).toEqual([])
  })

  it(`${MUST_NOT_CHANGE}: skip types a bare Esc and nothing else`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    o.daemon.length = 0

    expect(await o.call.sessions.answerAskUserQuestion({ sessionId, skip: true })).toEqual({
      ok: true,
    })
    expect(inputs(o.daemon).map((m) => Buffer.from(m.data, 'base64').toString())).toEqual(['\x1b'])
    expect(inputs(o.daemon).map((m) => m.inputOrigin)).toEqual(['human'])
  })
})

describe('oracle: continue (the errored-agent retry)', () => {
  it(`${MUST_NOT_CHANGE}: continue types 'continue' + CR stamped 'auto_continue', and ONLY when the agent phase is errored`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId, 'idle')
    o.daemon.length = 0

    // Idle is not a retryable state: refused, and nothing is typed.
    expect(await o.call.sessions.continue({ sessionId })).toEqual({ ok: false })
    expect(ptyFrames(o.daemon)).toEqual([])

    o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId,
      state: { phase: 'errored', since: new Date().toISOString(), nativeSubagentCount: 0 },
    })

    expect(await o.call.sessions.continue({ sessionId })).toEqual({ ok: true })
    expect(ptyFrames(o.daemon)).toEqual([{ inputOrigin: 'auto_continue', data: 'continue\r' }])
  })

  it(`${MUST_NOT_CHANGE}: continue refuses a PARKED session even while its last known phase is errored — a dead PTY would swallow it`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId, 'errored')
    await o.call.sessions.hibernate({ sessionId })
    o.daemon.length = 0

    expect(await o.call.sessions.continue({ sessionId })).toEqual({ ok: false })
    expect(ptyFrames(o.daemon)).toEqual([])
  })
})

describe('oracle: stop (clean end, keep the branch)', () => {
  it(`${MUST_NOT_CHANGE}: stop parks the process, stamps stopReason 'parent', and CLEARS readAt (unlike archive, which keeps it)`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    await o.call.sessions.markRead({ sessionId })
    expect(o.meta(sessionId).readAt).not.toBeNull()

    expect(await o.call.sessions.stop({ sessionId })).toEqual({
      ok: true,
      worktreeFreed: false,
      deferredKill: false,
    })

    const row = o.store.sessions.loadSessions().find((r) => r.id === sessionId)
    expect(row).toMatchObject({ status: 'hibernated', stopReason: 'parent' })
    // A terminal transition is new unread information [spec:SP-6144]: stop
    // resurfaces the session, where archive deliberately does not.
    // Per-user (POD-1076): the terminal transition clears EVERY reader's marker,
    // which is what nulling the one column used to mean.
    expect(o.store.sessions.listReadAt(asUserId(SOLE_USER_ID))[sessionId]).toBeUndefined()
    expect(o.daemon).toContainEqual(expect.objectContaining({ type: 'kill', sessionId }))
  })

  it(`${MUST_NOT_CHANGE}: --force re-labels the park 'forced' (work may have been discarded)`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)

    expect((await o.call.sessions.stop({ sessionId, force: true })).ok).toBe(true)

    expect(o.store.sessions.loadSessions().find((r) => r.id === sessionId)?.stopReason).toBe(
      'forced',
    )
  })

  it(`${MUST_NOT_CHANGE}: stopping an already-parked session is accepted and does not re-kill it`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goLive(o, sessionId)
    await o.call.sessions.stop({ sessionId })
    const killsAfterFirst = o.daemon.filter((m) => m.type === 'kill').length

    expect((await o.call.sessions.stop({ sessionId })).ok).toBe(true)

    expect(o.daemon.filter((m) => m.type === 'kill')).toHaveLength(killsAfterFirst)
    // The row survives — stop keeps the branch, the transcript and the session.
    expect(o.reg.modules.sessions.listSessions().map((s) => s.sessionId)).toEqual([sessionId])
  })
})
