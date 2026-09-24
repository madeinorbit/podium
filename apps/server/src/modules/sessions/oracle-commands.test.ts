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
import { asMachineId, asSessionId, asUserId, firstAdminMemberId } from '@podium/model'
import { CLIENT_WIRE_VERSION, type ServerMessage } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { confirmingRetirement } from '../../test-support/host-daemon'
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

/** The live phases a send must not resurrect over. */
const LIVE_PHASES = ['errored', 'idle'] as const

const inputs = (daemon: ControlMessage[]) =>
  daemon.filter((m): m is Extract<ControlMessage, { type: 'input' }> => m.type === 'input')

/**
 * Every frame that ends a session's process: the contract lifecycle request a
 * park or stop sends since 722704624 (POD-4302), and the legacy `kill` frame
 * that remains only as the orphan-reaping escalation.
 */
const retirements = (daemon: ControlMessage[], sessionId: SessionId) =>
  daemon.filter(
    (m) => (m.type === 'runtimeLifecycleRequest' || m.type === 'kill') && m.sessionId === sessionId,
  )

/**
 * THE AGENT'S CONTRACT FRAMES, AS THE DAEMON SEES THEM (358ad0ffb / 81460a99b,
 * POD-4427 / POD-4279; the helpers mirror relay.test.ts, ceb56a21f).
 *
 * A queued send leaves as ONE `runtimeDurableSendRequest` keyed by the queue
 * row (`rowId` = `turnId`, 99ef2c33b); a when-ready send (continue) as a
 * `runtimeSendRequest`; a stop as a `runtimeInterruptRequest`; an answer as a
 * `runtimeAnswerRequest`. Custody is the `runtimeSendResult`; only the
 * driver's `delivery` runtime event settles a durable row (4bd403fed).
 */
type DurableSendRequest = Extract<ControlMessage, { type: 'runtimeDurableSendRequest' }>
const durableSends = (daemon: ControlMessage[], sessionId: SessionId): DurableSendRequest[] =>
  daemon.filter(
    (m): m is DurableSendRequest =>
      m.type === 'runtimeDurableSendRequest' && m.sessionId === sessionId,
  )
const runtimeSends = (daemon: ControlMessage[], sessionId: SessionId) =>
  daemon.filter(
    (m): m is Extract<ControlMessage, { type: 'runtimeSendRequest' }> =>
      m.type === 'runtimeSendRequest' && m.sessionId === sessionId,
  )
const interruptRequests = (daemon: ControlMessage[], sessionId: SessionId) =>
  daemon.filter(
    (m): m is Extract<ControlMessage, { type: 'runtimeInterruptRequest' }> =>
      m.type === 'runtimeInterruptRequest' && m.sessionId === sessionId,
  )
type AnswerRequest = Extract<ControlMessage, { type: 'runtimeAnswerRequest' }>
const answerRequests = (daemon: ControlMessage[]): AnswerRequest[] =>
  daemon.filter((m): m is AnswerRequest => m.type === 'runtimeAnswerRequest')

type Oracle = Awaited<ReturnType<typeof makeOracle>>

/** The durable sends once `count` of them have been handed on (a predicate wait). */
async function durableSendsOnceHandedOn(
  o: Oracle,
  sessionId: SessionId,
  count: number,
): Promise<DurableSendRequest[]> {
  await waitFor(
    () => durableSends(o.daemon, sessionId).length >= count,
    `${count} durable send(s) to be handed on`,
  )
  return durableSends(o.daemon, sessionId)
}

async function nextInterruptRequest(o: Oracle, sessionId: SessionId) {
  await waitFor(() => interruptRequests(o.daemon, sessionId).length > 0, 'the interrupt request')
  // biome-ignore lint/style/noNonNullAssertion: waited for above.
  return interruptRequests(o.daemon, sessionId).at(-1)!
}

/** The daemon takes custody of a durable row, as a real one does. Not delivery. */
const grantCustody = (o: Oracle, send: DurableSendRequest): Promise<void> =>
  o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'runtimeSendResult',
    requestId: send.requestId,
    sessionId: send.sessionId,
    receipt: {
      outcome: 'queued',
      position: 1,
      deliveredAs: 'queue',
      at: '2026-01-01T00:00:00.000Z',
    },
  })

/** The driver's `delivered` outcome for one durable row, on the runtime stream. */
const deliveryEvent = (daemon: ControlMessage[], sessionId: SessionId, rowId: string, seq = 1) => {
  const spawn = daemon.find(
    (m): m is Extract<ControlMessage, { type: 'spawn' }> =>
      m.type === 'spawn' && m.sessionId === sessionId,
  )
  if (spawn?.observationGeneration === undefined) throw new Error('spawn was not fenced')
  return {
    type: 'runtimeEvent',
    deliveryId: `delivery-${rowId}`,
    sessionId,
    event: {
      t: 'delivery',
      rowId,
      outcome: 'delivered',
      at: '2026-01-01T00:00:01.000Z',
      provenance: 'live',
      cursor: { segmentId: `delivery-${sessionId}`, components: { seq } },
      observerGeneration: spawn.observationGeneration,
      turnEpoch: 0,
    },
  } as const
}

/**
 * The first event of a REPLACEMENT observer generation (a woken process): a
 * bootstrap state snapshot. The runtime event gate admits nothing live on a
 * generation after the first until one arrives ('replacement-requires-bootstrap').
 */
const bootstrapSnapshot = (daemon: ControlMessage[], sessionId: SessionId) => {
  const spawn = daemon.find(
    (m): m is Extract<ControlMessage, { type: 'spawn' }> =>
      m.type === 'spawn' && m.sessionId === sessionId,
  )
  if (spawn?.observationGeneration === undefined) throw new Error('spawn was not fenced')
  return {
    type: 'runtimeEvent',
    deliveryId: `bootstrap-${sessionId}`,
    sessionId,
    event: {
      t: 'state',
      change: {
        kind: 'state_snapshot',
        state: { phase: 'idle', since: '2026-01-01T00:00:00.000Z', nativeSubagentCount: 0 },
      },
      at: '2026-01-01T00:00:00.500Z',
      provenance: 'bootstrap',
      cursor: { segmentId: `delivery-${sessionId}`, components: { seq: 1 } },
      observerGeneration: spawn.observationGeneration,
      turnEpoch: 0,
    },
  } as const
}

/**
 * Open a question ask on the session the way its driver reports one: an
 * `asked` interaction event carrying the driver's own id (terminal asks are
 * `keystroke-emulated`). Returns that id — the identity an answer is keyed by.
 */
async function openAsk(
  o: Oracle,
  sessionId: SessionId,
  questions: {
    question: string
    multiSelect: boolean
    previewLayout: boolean
    options: { label: string }[]
  }[],
): Promise<string> {
  const id = `ask:${sessionId}:${questions.length}`
  await o.reg.modules.interactions.onInteractionResolved({
    sessionId,
    ev: {
      ev: 'asked',
      interaction: {
        id,
        sessionId,
        kind: 'question',
        payload: { v: 1, questions },
        askedAt: new Date().toISOString(),
        source: 'screen-classifier',
        answerable: 'keystroke-emulated',
      },
    },
  })
  expect((await o.reg.modules.interactions.listOpen(sessionId)).map((row) => row.id)).toEqual([id])
  return id
}

/**
 * Answer through the public command, and answer the resulting
 * `runtimeAnswerRequest` the way the driver does (`outcome`, default ok).
 */
async function answerThroughDriver(
  o: Oracle,
  input: Parameters<Oracle['call']['sessions']['answerAskUserQuestion']>[0],
  outcome: AnswerResultOutcome = { ok: true },
): Promise<{
  result: Awaited<ReturnType<Oracle['call']['sessions']['answerAskUserQuestion']>>
  request: AnswerRequest
}> {
  const pending = o.call.sessions.answerAskUserQuestion(input)
  await waitFor(() => answerRequests(o.daemon).length > 0, 'the answer to reach the driver')
  // biome-ignore lint/style/noNonNullAssertion: waited for above.
  const request = answerRequests(o.daemon).at(-1)!
  await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'runtimeAnswerResult',
    requestId: request.requestId,
    sessionId: request.sessionId,
    outcome,
  })
  return { result: await pending, request }
}
type AnswerResultOutcome =
  | { ok: true }
  | { ok: false; reason: 'not-yet-supported'; detail?: string }

/** Bind a created session as a live plain shell (POD-4278): the raw PTY path. */
async function goLiveShell(o: Oracle, sessionId: SessionId): Promise<void> {
  await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: 'bash',
    cwd: '/p',
    agentKind: 'shell',
    geometry: { cols: 80, rows: 24 },
  })
}

/** A plain shell's abort key: Ctrl-C, its SIGINT (harness registry `harnessInterrupt`). */
const SHELL_ABORT = '\x03'

const confirmUserTurn = (
  o: Awaited<ReturnType<typeof makeOracle>>,
  sessionId: SessionId,
  text: string,
): Promise<void> =>
  o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'transcriptDelta',
    sessionId,
    items: [{ id: `turn-${text}`, role: 'user' as const, text, cursor: `c-${text}` }],
    tail: `c-${text}`,
  })

const hasSessionDelete = (client: ServerMessage[], sessionId: SessionId) =>
  client.some(
    (message) =>
      message.type === 'feedDelta' &&
      message.changes.some(
        (change) =>
          change.entity === 'session' && change.entityId === sessionId && change.op === 'remove',
      ),
  )

/** Bind a created session as a live agent with a known resume ref and phase. */
async function goLive(
  o: Awaited<ReturnType<typeof makeOracle>>,
  sessionId: SessionId,
  phase: 'idle' | 'working' | 'errored' = 'idle',
): Promise<void> {
  await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/p',
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  })
  await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'sessionResumeRef',
    sessionId,
    resume: RESUME,
    confidence: 'exact',
  })
  await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'agentState',
    sessionId,
    state: { phase, since: new Date().toISOString(), nativeSubagentCount: 0 },
  })
}

describe('oracle: create', () => {
  it(`${MUST_NOT_CHANGE}: create spawns on the daemon, persists the row, and returns the id the client may have chosen`, async () => {
    const o = await makeOracle()
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
    expect((await o.store.sessions.loadSessions()).map((r) => r.id)).toEqual([clientId])
  })

  it(`${MUST_NOT_CHANGE}: a non-uuid client sessionId is refused before it can reach the durable-label / scope path`, async () => {
    const o = await makeOracle()

    await expect(
      o.call.sessions.create({
        agentKind: 'claude-code',
        cwd: '/p',
        sessionId: asSessionId('../../evil'),
      }),
    ).rejects.toThrow()
    expect(await o.store.sessions.loadSessions()).toEqual([])
  })

  it(`${MUST_NOT_CHANGE}: an operator may explicitly spawn on a paired machine owned by another user`, async () => {
    const o = await makeOracle()
    // The oracle caller is an operator; machine ownership is explicit (POD-1079).
    await o.store.machines.upsertMachine({
      id: 'other',
      name: 'other',
      hostname: 'o',
      tokenHash: 'x',
      ownerUserId: firstAdminMemberId(),
      assignment: { server: false, agentExecution: true },
    })
    const other: ControlMessage[] = []
    // Finish attachment (including machine-cache invalidation) before authorizing a command.
    await o.reg.gateway.attachDaemon(
      'other',
      confirmingRetirement(o.reg, 'other', (m) => other.push(m)),
    )

    const { sessionId } = await o.call.sessions.create({
      agentKind: 'shell',
      cwd: '/p',
      machineId: 'other',
    })

    expect(other).toContainEqual(expect.objectContaining({ type: 'spawn', sessionId }))
    expect(o.daemon.filter((m) => m.type === 'spawn')).toHaveLength(0)
    expect((await o.meta(sessionId)).machineId).toBe('other')
  })
})

describe('oracle: resume', () => {
  it(`${MUST_NOT_CHANGE}: a resume with no matching row spawns a fresh session carrying the resume ref`, async () => {
    const o = await makeOracle()

    const { sessionId } = await o.call.sessions.resume({
      agentKind: 'claude-code',
      cwd: '/p',
      resume: RESUME,
      conversationId: 'native-1',
    })

    expect(o.daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, resume: RESUME }),
    )
    expect((await o.meta(sessionId)).resume).toEqual(RESUME)
  })

  it(`${MUST_NOT_CHANGE}: resuming an EXISTING row reuses it instead of minting a second session`, async () => {
    const o = await makeOracle()
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
    expect(await o.reg.modules.sessions.listSessions(undefined, 'rpc')).toHaveLength(1)
  })
})

describe('oracle: hibernate', () => {
  /**
   * THE KILL IS NOW A CONFIRMED RETIREMENT (722704624, POD-4302).
   *
   * This used to pin a fire-and-forget `kill` frame. Since 722704624 a park
   * asks the daemon to retire the process through the contract lifecycle
   * (`runtimeLifecycleRequest`, verb 'stop') and reports `ok` only on the
   * daemon's `retirement: 'confirmed'` answer; the legacy `kill` frame survives
   * only as the orphan-reaping escalation when that confirmation does not come.
   * The oracle's daemon confirms like a real one (`confirmingRetirement`), so a
   * clean park sends the lifecycle request and NO legacy kill. What stays
   * pinned is the intent: the status flips, it is durable, and the daemon is
   * told to end the process.
   */
  it(`${MUST_NOT_CHANGE}: hibernate parks a live session — status flips and the daemon is asked to retire the process`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId)
    o.daemon.length = 0

    expect(await o.call.sessions.hibernate({ sessionId })).toEqual({ ok: true })

    expect((await o.meta(sessionId)).status).toBe('hibernated')
    expect(retirements(o.daemon, sessionId)).toEqual([
      expect.objectContaining({ type: 'runtimeLifecycleRequest', sessionId, verb: 'stop' }),
    ])
    expect((await o.store.sessions.loadSessions()).find((r) => r.id === sessionId)?.status).toBe(
      'hibernated',
    )
  })

  it(`${MUST_NOT_CHANGE}: hibernate REFUSES with a reason (never a throw) when the session is not running`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
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

    const refused = await o.call.sessions.hibernate({ sessionId })

    expect(refused.ok).toBe(false)
    expect(refused.reason).toBe('no resume ref yet — the agent has not reported one')
    expect((await o.meta(sessionId)).status).toBe('live')
  })

  it(`${MUST_NOT_CHANGE}: hibernate refuses a WORKING agent so an in-flight turn is never killed`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId, 'working')

    expect(await o.call.sessions.hibernate({ sessionId })).toEqual({
      ok: false,
      reason: 'agent is working — let it reach idle first',
    })
    expect((await o.meta(sessionId)).status).toBe('live')
  })
})

describe('oracle: resurrect', () => {
  it(`${MUST_NOT_CHANGE}: resurrect respawns a parked session with its resume ref and moves it to 'starting'`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId)
    await o.call.sessions.hibernate({ sessionId })
    o.daemon.length = 0

    expect(await o.call.sessions.resurrect({ sessionId })).toEqual({ ok: true })

    expect((await o.meta(sessionId)).status).toBe('starting')
    expect(o.daemon).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, resume: RESUME }),
    )
  })

  it(`${MUST_NOT_CHANGE}: resurrect is idempotent for a still-running session, so a stale banner cannot turn a successful wake into an error`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId)
    const daemonFrames = o.daemon.length

    expect(await o.call.sessions.resurrect({ sessionId })).toEqual({ ok: true })
    expect(o.daemon).toHaveLength(daemonFrames)
  })

  it(`${MUST_NOT_CHANGE}: Grok resurrection stays non-live until a ready bind and persists failure, retry, and pointer truth [POD-2942]`, async () => {
    const o = await makeOracle()
    const machineId = o.reg.sessionStore.hostMachineId
    const resume = { kind: 'grok-session', value: 'native-grok-pod-2942' } as const
    const { sessionId } = await o.call.sessions.create({
      agentKind: 'grok',
      cwd: '/p',
      sessionId: '29420000-0000-4000-8000-000000000001',
    })
    await o.reg.gateway.routeDaemonFrame(machineId, {
      type: 'bind',
      sessionId,
      cmd: 'grok agent stdio (grok-acp)',
      cwd: '/p',
      agentKind: 'grok',
      geometry: { cols: 80, rows: 24 },
      driverId: 'grok-acp',
    })
    await o.reg.gateway.routeDaemonFrame(machineId, {
      type: 'sessionResumeRef',
      sessionId,
      resume,
      confidence: 'exact',
    })
    await o.reg.gateway.routeDaemonFrame(machineId, {
      type: 'agentState',
      sessionId,
      state: { phase: 'idle', since: new Date().toISOString(), nativeSubagentCount: 0 },
    })

    await expect(o.call.sessions.hibernate({ sessionId })).resolves.toEqual({ ok: true })
    expect(await o.meta(sessionId)).toMatchObject({ status: 'hibernated', resume })
    expect(
      (await o.store.sessions.loadSessions()).find((row) => row.id === sessionId)?.status,
    ).toBe('hibernated')

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
    expect((await o.meta(sessionId)).status).toBe('starting')
    expect(
      (await o.store.sessions.loadSessions()).find((row) => row.id === sessionId)?.status,
    ).toBe('starting')

    await o.reg.gateway.routeDaemonFrame(machineId, {
      type: 'spawnError',
      sessionId,
      message: 'session/load timed out',
    })
    expect((await o.meta(sessionId)).status).toBe('exited')
    expect(
      (await o.store.sessions.loadSessions()).find((row) => row.id === sessionId)?.status,
    ).toBe('exited')

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
    expect((await o.store.observationCheckpoints.get(sessionId))?.observationGeneration).toBe(
      secondSpawn?.observationGeneration,
    )
    expect((await o.store.sessions.loadSessions()).map((row) => row.id)).toEqual([sessionId])
    expect(await o.meta(sessionId)).toMatchObject({ status: 'starting', resume })

    await o.reg.gateway.routeDaemonFrame(machineId, {
      type: 'bind',
      sessionId,
      cmd: 'grok agent stdio (grok-acp)',
      cwd: '/p',
      agentKind: 'grok',
      geometry: { cols: 80, rows: 24 },
      driverId: 'grok-acp',
    })
    expect(await o.meta(sessionId)).toMatchObject({
      status: 'live',
      resume,
      driverId: 'grok-acp',
    })
    expect(
      (await o.store.sessions.loadSessions()).find((row) => row.id === sessionId),
    ).toMatchObject({
      status: 'live',
      selectedDriverId: 'grok-acp',
    })
  })

  /**
   * THE REFUSAL IS KEYED TO PROOF, NOT TO THE ABSENCE OF A REF (POD-2392,
   * re-pinned here by POD-3351).
   *
   * This case used to read "an exited AGENT with no resume ref cannot be
   * resurrected". POD-2392 narrowed that rule — "no ref" was two opposite
   * situations wearing one answer — and the case went red the day that commit
   * landed instead of being decided here. The pin is not dropped: the shape it
   * exists for is a session that comes back EMPTY while still presenting as
   * itself, and that shape is the first arm below. What the narrower rule adds
   * is that an agent which provably never opened a conversation has nothing to
   * come back empty from, so refusing it left deletion as the panel's only
   * remaining action.
   *
   * All three arms are stated together because the distinction IS the claim:
   *
   *   had a conversation, no way back  → refuses ('no resume ref')
   *   proven never bound               → starts over, with no ref on the wire
   *   shell                            → starts over (a fresh spawn IS recovery)
   */
  it(`${MUST_NOT_CHANGE}: resurrect refuses an exited agent whose conversation has no way back, and starts over one that never had a conversation — as it does a shell`, async () => {
    const o = await makeOracle()
    // A transcript item is a conversation, whether or not any `sessionResumeRef`
    // frame ever told us its native id — so this row is bound and ref-less, the
    // case where a relaunch would silently discard the conversation.
    const bound = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId: bound.sessionId,
      cmd: 'claude',
      cwd: '/p',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    await confirmUserTurn(o, bound.sessionId, 'a real turn')
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId: bound.sessionId,
      code: 1,
    })
    // Created and dead without ever binding a thread: the server minted the
    // 'never' claim itself, so a fresh start discards nothing.
    const neverBound = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId: neverBound.sessionId,
      code: 1,
    })
    const shell = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId: shell.sessionId,
      code: 1,
    })
    expect(await o.meta(bound.sessionId)).toMatchObject({ status: 'exited' })
    expect((await o.meta(bound.sessionId)).neverBound).toBeUndefined()
    expect(await o.meta(neverBound.sessionId)).toMatchObject({ neverBound: true })
    o.daemon.length = 0

    expect(await o.call.sessions.resurrect({ sessionId: bound.sessionId })).toEqual({
      ok: false,
      reason: 'no resume ref',
    })
    expect(o.daemon.filter((m) => m.type === 'spawn')).toEqual([])
    expect(await o.meta(bound.sessionId)).toMatchObject({ status: 'exited' })

    expect(await o.call.sessions.resurrect({ sessionId: neverBound.sessionId })).toEqual({
      ok: true,
    })
    expect(await o.call.sessions.resurrect({ sessionId: shell.sessionId })).toEqual({ ok: true })
    // The relaunch goes out WITHOUT a ref — this is a start over, not a resume
    // over a conversation the row never had.
    const relaunch = o.daemon.find(
      (m): m is Extract<ControlMessage, { type: 'spawn' }> =>
        m.type === 'spawn' && m.sessionId === neverBound.sessionId,
    )
    expect(relaunch).toMatchObject({ agentKind: 'claude-code', cwd: '/p' })
    expect(relaunch && 'resume' in relaunch ? relaunch.resume : undefined).toBeUndefined()
  })
})

describe('oracle: kill', () => {
  it(`${MUST_NOT_CHANGE}: kill tombstones the row with deletion_source 'standalone' and removes it from the live list`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    await goLive(o, sessionId)

    await o.call.sessions.kill({ sessionId })

    expect(await o.reg.modules.sessions.listSessions(undefined, 'rpc')).toEqual([])
    expect(await o.store.sessions.loadSessions()).toEqual([])
    const tombstone = (await o.store.sessions.loadDeletedSessions()).find((r) => r.id === sessionId)
    expect(tombstone?.deletionSource).toBe('standalone')
    expect(typeof tombstone?.deletedAt).toBe('string')
    expect(tombstone?.deletedByIssueId).toBeNull()
  })

  it(`${MUST_NOT_CHANGE}: kill signals the OWNING daemon — and only that one — and publishes the removal to clients`, async () => {
    // "Owning" is only assertable when a NON-owning machine exists to stay
    // silent. On a one-machine fixture the same assertion passes for a kill
    // broadcast to everyone, which is a different behaviour.
    const o = await makeOracle({ offlineMachines: [{ id: asMachineId('other'), name: 'other' }] })
    const otherSeen: ControlMessage[] = []
    o.reg.gateway.attachDaemon(
      'other',
      confirmingRetirement(o.reg, 'other', (m) => otherSeen.push(m)),
    )
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
it(`${MUST_NOT_CHANGE}: coalesces resurrection while asynchronous worktree preparation is pending`, async () => {
  const o = await makeOracle()
  const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
  await goLive(o, sessionId)
  await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'agentExit',
    sessionId,
    code: 137,
  })
  o.daemon.length = 0

  let release!: (result: { ok: true; cwd: string }) => void
  const preparation = new Promise<{ ok: true; cwd: string }>((resolve) => {
    release = resolve
  })
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  vi.spyOn(o.reg.modules.sessions.workspace, 'ensureSessionWorktree').mockImplementation(() => {
    enter()
    return preparation
  })

  const first = o.reg.modules.issueSessionLifecycle.resurrectSession({ sessionId })
  const second = o.reg.modules.issueSessionLifecycle.resurrectSession({ sessionId })
  expect(o.daemon.filter((message) => message.type === 'spawn')).toEqual([])

  await entered
  release({ ok: true, cwd: '/p' })
  expect(await first).toEqual({ ok: true })
  expect(await second).toEqual({ ok: true })
  expect(o.daemon.filter((message) => message.type === 'spawn')).toHaveLength(1)
})

describe('oracle: sendText / resumeAndSend', () => {
  /**
   * THE SERVER NO LONGER TYPES FOR AN AGENT (358ad0ffb / 81460a99b, POD-4427 /
   * POD-4279; POD-4661 cfb9924a7; POD-4666 fdc7bad1e).
   *
   * These oracles used to pin PTY bytes for a claude-code session: one bare Esc
   * for interrupt, one bracketed-paste frame stamped 'controller' for a send,
   * typed once a readiness window had run. That design was deleted. An agent's
   * send rides the durable queue and leaves as ONE `runtimeDurableSendRequest`
   * keyed by the queue row (`rowId` = `turnId`, 99ef2c33b), handed on at once
   * (the server never holds a message on its view of the agent, cfb9924a7) and
   * settled only by the driver's `delivery` runtime event (4bd403fed). An
   * agent's interrupt is a `runtimeInterruptRequest` to its driver, which owns
   * the abort key and the idle guard (fdc7bad1e: no server phase gate).
   *
   * WHAT IS STILL PINNED, AND WHERE. The origin stamp ('controller', operator
   * via the substrate, never 'human') rides the durable send's `origin`. A
   * plain SHELL (POD-4278) still gets raw PTY bytes, so each PTY claim is kept
   * on a shell session byte-for-byte, beside the agent's contract claim.
   */
  it(`${MUST_NOT_CHANGE}: interrupt of an agent hands the stop to its driver — one interrupt request, no PTY bytes, 'protocol' once accepted`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId, 'working')
    o.daemon.length = 0

    const answer = o.call.sessions.interrupt({ sessionId })
    const request = await nextInterruptRequest(o, sessionId)
    // A bare stop: no queued row to cancel rides along.
    expect(request.cancelRowId).toBeUndefined()
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'runtimeLifecycleResult',
      requestId: request.requestId,
      sessionId,
      result: { ok: true },
    })

    // `requested`, not `stopped` (POD-2792): the driver took the request.
    expect(await answer).toEqual({ ok: true, requested: 'protocol' })
    expect(interruptRequests(o.daemon, sessionId)).toHaveLength(1)
    // No replacement text, and nothing typed: the abort key is the driver's.
    expect(durableSends(o.daemon, sessionId)).toEqual([])
    expect(ptyFrames(o.daemon)).toEqual([])
  })

  it(`${MUST_NOT_CHANGE}: interrupt of a plain shell sends one bare abort key to the PTY and no replacement text`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    await goLiveShell(o, sessionId)
    o.daemon.length = 0

    expect(await o.call.sessions.interrupt({ sessionId })).toEqual({
      ok: true,
      requested: 'keystroke',
    })
    expect(ptyFrames(o.daemon)).toEqual([{ inputOrigin: 'controller', data: SHELL_ABORT }])
    expect(interruptRequests(o.daemon, sessionId)).toEqual([])
  })

  it(`${MUST_NOT_CHANGE}: sendText to a live agent reports a disposition and is handed on as ONE durable send stamped 'controller' (operator via substrate), not 'human' — never typed`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId)
    o.daemon.length = 0

    const result = await o.call.sessions.sendText({ sessionId, text: 'hello there' })

    expect(result.ok).toBe(true)
    expect(typeof result.disposition).toBe('string')
    // Operator chat rides the messaging substrate (#237 / POD-729) but stamps
    // origin 'controller' — person-origin, so standing offers clear and causal
    // turns attribute as user input (POD-552). Agent mail stays 'mail'
    // (POD-118). EXACT: one request carrying the text and nothing else.
    const [send] = await durableSendsOnceHandedOn(o, sessionId, 1)
    expect(send).toMatchObject({
      text: 'hello there',
      origin: 'controller',
      deliveryRecovery: false,
      initialPrompt: false,
    })
    expect(send!.turnId).toBe(send!.rowId)
    expect(ptyFrames(o.daemon)).toEqual([])
  })

  it(`${MUST_NOT_CHANGE}: sendText to a live shell reaches the PTY stamped 'controller' — one bracketed paste, then the submitting CR`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    await goLiveShell(o, sessionId)
    o.daemon.length = 0

    const result = await o.call.sessions.sendText({ sessionId, text: 'hello there' })

    expect(result.ok).toBe(true)
    expect(typeof result.disposition).toBe('string')
    // EXACT frame sequence, not a substring (POD-743).
    expect(ptyFrames(o.daemon)).toEqual([
      { inputOrigin: 'controller', data: `${PASTE_START}hello there${PASTE_END}` },
      { inputOrigin: 'controller', data: '\r' },
    ])
    expect(durableSends(o.daemon, sessionId)).toEqual([])
  })

  it(`${MUST_NOT_CHANGE}: sendText bypasses controller gating — a chat send is an explicit user act, not a competing keyboard`, async () => {
    const o = await makeOracle()
    const agent = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, agent.sessionId)
    const shell = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    await goLiveShell(o, shell.sessionId)
    // The claim is "bypasses CONTROLLER gating", so there has to BE a controller
    // that is not this caller — otherwise the test passes on a session nobody
    // controls and proves nothing about gating.
    const controllerId = attachTestClient(o.reg.clientGateway, () => {})
    await o.reg.clientGateway.routeClientFrame(controllerId, {
      type: 'hello',
      caps: ['sync.http.v1'],
      wireVersion: CLIENT_WIRE_VERSION,
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
    })
    for (const sessionId of [agent.sessionId, shell.sessionId]) {
      await o.reg.clientGateway.routeClientFrame(controllerId, { type: 'attach', sessionId })
      expect((await o.meta(sessionId)).controllerId).toBe(controllerId)
    }
    o.daemon.length = 0

    // The agent: accepted and handed to its driver, not refused.
    expect(
      (await o.call.sessions.sendText({ sessionId: agent.sessionId, text: 'still lands' })).ok,
    ).toBe(true)
    const [send] = await durableSendsOnceHandedOn(o, agent.sessionId, 1)
    expect(send).toMatchObject({ text: 'still lands', origin: 'controller' })
    // The shell: typed, not refused.
    expect(
      (await o.call.sessions.sendText({ sessionId: shell.sessionId, text: 'still lands' })).ok,
    ).toBe(true)
    expect(ptyFrames(o.daemon)).toEqual([
      { inputOrigin: 'controller', data: `${PASTE_START}still lands${PASTE_END}` },
      { inputOrigin: 'controller', data: '\r' },
    ])
  })

  it(`${MUST_NOT_CHANGE}: resumeAndSend wakes a PARKED session (the send is not dropped)`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId)
    await o.call.sessions.hibernate({ sessionId })
    o.daemon.length = 0

    const result = await o.call.sessions.resumeAndSend({ sessionId, text: 'wake up' })

    expect(result.ok).toBe(true)
    await waitFor(
      () => o.daemon.some((m) => m.type === 'spawn' && m.sessionId === sessionId),
      'the wake spawn to be dispatched',
    )
    expect((await o.meta(sessionId)).status).toBe('starting')
  })

  /**
   * RE-PINNED ON THE CONTRACT (358ad0ffb POD-4427, cfb9924a7 POD-4661,
   * 4bd403fed, POD-4360). The wake half is unchanged: two concurrent sends to an
   * exited agent and a replay of one of them request exactly ONE resurrection
   * and leave exactly two durable rows. What used to follow was the server
   * typing 'one' after the bind, holding 'two' until the transcript confirmed
   * 'one', then typing 'two'. The server no longer types or holds: each row is
   * handed on from admission, while the woken session is still starting, as
   * ONE fresh durable send, in FIFO order behind the daemon's custody receipt
   * for the row before it. The bind is a new owner, so it receives the
   * remaining rows again — as RECOVERIES (`deliveryRecovery: true`), which a
   * daemon confirms or fails and never retypes. A row leaves the queue only on
   * the driver's delivery event. "Exactly once" is now asserted on the fresh
   * sends, and on every recovery naming a row that was already handed on.
   */
  it(`${MUST_NOT_CHANGE}: sendText after process-gone resurrects once and hands concurrent/replayed sends on as ONE fresh write each`, async () => {
    const o = await makeOracle()
    const machineId = o.reg.sessionStore.hostMachineId
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId)
    await o.reg.gateway.routeDaemonFrame(machineId, { type: 'agentExit', sessionId, code: 137 })
    expect((await o.meta(sessionId)).status).toBe('exited')
    o.daemon.length = 0

    const [first, second] = await Promise.all([
      o.call.sessions.sendText({ sessionId, text: 'one', mutationId: 'm-dead-1' }),
      o.call.sessions.sendText({ sessionId, text: 'two', mutationId: 'm-dead-2' }),
    ])
    expect(first).toMatchObject({ ok: true, queued: true })
    expect(second).toMatchObject({ ok: true, queued: true })
    // Acceptance requests a wake; the asynchronous reaction dispatches it.
    await waitFor(
      () => o.daemon.filter((message) => message.type === 'spawn').length === 1,
      'the one wake spawn',
    )

    await o.call.sessions.sendText({ sessionId, text: 'one', mutationId: 'm-dead-1' })
    expect(o.daemon.filter((message) => message.type === 'spawn')).toHaveLength(1)
    expect(await o.store.sync.listQueuedMessages(sessionId)).toHaveLength(2)

    // FIFO custody: 'two' goes only once the daemon has taken 'one'.
    const [one] = await durableSendsOnceHandedOn(o, sessionId, 1)
    expect(one).toMatchObject({ text: 'one', origin: 'controller', deliveryRecovery: false })
    await grantCustody(o, one!)
    const [, two] = await durableSendsOnceHandedOn(o, sessionId, 2)
    expect(two).toMatchObject({ text: 'two', origin: 'controller', deliveryRecovery: false })
    expect(two!.rowId).not.toBe(one!.rowId)
    await grantCustody(o, two!)

    // The bind: the new owner receives both rows again, as recoveries.
    await o.reg.gateway.routeDaemonFrame(machineId, {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/p',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    const [, , recoverOne] = await durableSendsOnceHandedOn(o, sessionId, 3)
    await grantCustody(o, recoverOne!)
    const [, , , recoverTwo] = await durableSendsOnceHandedOn(o, sessionId, 4)
    await grantCustody(o, recoverTwo!)
    expect([recoverOne, recoverTwo]).toEqual([
      expect.objectContaining({ rowId: one!.rowId, text: 'one', deliveryRecovery: true }),
      expect.objectContaining({ rowId: two!.rowId, text: 'two', deliveryRecovery: true }),
    ])

    // Custody is not delivery: both rows stay queued until the driver says so.
    expect(await o.store.sync.listQueuedMessages(sessionId)).toHaveLength(2)
    // The woken process is a REPLACEMENT observer generation, whose stream
    // opens with a bootstrap snapshot before any live event is admitted.
    await o.reg.gateway.routeDaemonFrame(machineId, bootstrapSnapshot(o.daemon, sessionId))
    for (const [at, send] of [one!, two!].entries()) {
      await o.reg.gateway.routeDaemonFrame(
        machineId,
        deliveryEvent(o.daemon, sessionId, send.rowId, at + 2),
      )
    }
    await waitFor(
      async () => (await o.store.sync.listQueuedMessages(sessionId)).length === 0,
      'both rows to settle on their delivery events',
    )
    // One FRESH write per row, in order; the replay added none; never PTY bytes.
    const sends = durableSends(o.daemon, sessionId)
    expect(sends.filter((send) => !send.deliveryRecovery).map((send) => send.text)).toEqual([
      'one',
      'two',
    ])
    expect(sends).toHaveLength(4)
    expect(ptyFrames(o.daemon)).toEqual([])
  })

  it(`${MUST_NOT_CHANGE}: refuses archived and unresumable dead targets before durable acceptance`, async () => {
    const archived = await makeOracle()
    const { sessionId: archivedId } = await archived.call.sessions.create({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    await goLive(archived, archivedId)
    await archived.reg.gateway.routeDaemonFrame(archived.reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId: archivedId,
      code: 137,
    })
    await archived.call.sessions.setArchived({ sessionId: archivedId, archived: true })
    archived.daemon.length = 0

    expect(
      await archived.call.sessions.sendText({ sessionId: archivedId, text: 'do not wake' }),
    ).toEqual({
      ok: false,
      reason: 'session archived',
      disposition: 'dead_letter',
    })
    expect(await archived.store.sync.listQueuedMessages(archivedId)).toEqual([])
    expect(archived.daemon.filter((message) => message.type === 'spawn')).toEqual([])

    const unsupported = await makeOracle()
    const { sessionId: unsupportedId } = await unsupported.call.sessions.create({
      agentKind: 'claude-code',
      cwd: '/p',
    })
    await unsupported.reg.gateway.routeDaemonFrame(unsupported.reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId: unsupportedId,
      cmd: 'claude',
      cwd: '/p',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    await unsupported.reg.gateway.routeDaemonFrame(unsupported.reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId: unsupportedId,
      code: 1,
    })

    expect(
      await unsupported.call.sessions.sendText({ sessionId: unsupportedId, text: 'cannot resume' }),
    ).toEqual({ ok: false, reason: 'no resume ref', disposition: 'dead_letter' })
    expect(await unsupported.store.sync.listQueuedMessages(unsupportedId)).toEqual([])
  })

  // biome-ignore format: oracle-tags.test.ts reads the tag off the declaration line
  it.each(LIVE_PHASES)(`${MUST_NOT_CHANGE}: does not resurrect an already-live %s target`, async (phase) => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId, phase)
    o.daemon.length = 0

    const result = await o.call.sessions.sendText({ sessionId, text: 'still live' })

    expect(result.ok).toBe(true)
    expect(o.daemon.filter((message) => message.type === 'spawn')).toEqual([])
  })
})
describe('oracle: answerAskUserQuestion', () => {
  /**
   * THE MENU SCRIPT IS THE DRIVER'S NOW (358ad0ffb POD-4427, POD-4279).
   *
   * These oracles used to pin the keystrokes the server typed at a native menu
   * (digits one per write, Tab off a multi-select, a closing CR, 'n' for a
   * preview's Notes field, Esc for skip) and the 'human' stamp on them. The
   * server no longer types menu keys: an answer goes to the driver that owns
   * the menu (`deps.contractAnswer` → the interactions aggregate →
   * `runtimeAnswerRequest`), addressed by the ask's interaction id, as the
   * contract's question answer. The script moved to the terminal driver
   * (`menuScriptFor` / `questionScriptFor`, apps/daemon/src/runtime/
   * terminal-driver.ts); the multi-select Tab+CR, preview digit+CR, preview
   * Notes, skip Esc and stale-id refusal are exercised end to end in
   * apps/server/src/store/terminal-answer-contract.test.ts.
   *
   * WHAT THE SERVER STILL OWNS, pinned here: the translation of each client
   * choice shape into the contract's selections, the interaction id, who
   * answered, the refusals it makes itself, and that it TYPES NOTHING. The
   * question's shape (multi-select, preview) is not forwarded — the driver reads
   * it from the ask it holds, not from the client.
   */
  const PICK = {
    question: 'Pick',
    multiSelect: false,
    previewLayout: false,
    options: [{ label: 'One' }, { label: 'Two' }, { label: 'Three' }],
  }
  /** Each client choice shape, and the contract selections it must become. */
  const ANSWER_SHAPES = [
    {
      shape: 'a multi-select answer',
      questions: [{ ...PICK, multiSelect: true }],
      choices: [{ optionIndices: [1, 3], multiSelect: true }],
      selections: [{ optionIndices: [1, 3] }],
    },
    {
      shape: 'several picks with no multi-select flag',
      questions: [{ ...PICK, multiSelect: true }],
      choices: [{ optionIndices: [1, 3] }],
      selections: [{ optionIndices: [1, 3] }],
    },
    {
      shape: 'a lone multi-select with one pick',
      questions: [{ ...PICK, multiSelect: true }],
      choices: [{ optionIndices: [2], multiSelect: true }],
      selections: [{ optionIndices: [2] }],
    },
    {
      shape: 'two single-select questions',
      questions: [PICK, PICK],
      choices: [{ optionIndices: [1] }, { optionIndices: [2] }],
      selections: [{ optionIndices: [1] }, { optionIndices: [2] }],
    },
    {
      shape: 'a multi-question payload, in order',
      questions: [PICK, { ...PICK, multiSelect: true }],
      choices: [{ optionIndices: [1] }, { optionIndices: [2, 3], multiSelect: true }],
      selections: [{ optionIndices: [1] }, { optionIndices: [2, 3] }],
    },
    {
      shape: 'free text via Other',
      questions: [PICK],
      choices: [{ freeText: 'ship the long path', otherIndex: 4 }],
      selections: [{ optionIndices: [4], text: 'ship the long path' }],
    },
    {
      shape: 'an option on a PREVIEW question',
      questions: [{ ...PICK, previewLayout: true }],
      choices: [{ optionIndices: [2], previewLayout: true }],
      selections: [{ optionIndices: [2] }],
    },
    {
      shape: 'free text on a PREVIEW question',
      questions: [{ ...PICK, previewLayout: true }],
      choices: [{ freeText: 'ship the long path', otherIndex: 4, previewLayout: true }],
      selections: [{ optionIndices: [4], text: 'ship the long path' }],
    },
  ]

  it(`${MUST_NOT_CHANGE}: a single-select answer goes to the driver by its interaction id as the contract's question answer — nothing is typed`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId)
    const interactionId = await openAsk(o, sessionId, [PICK])
    o.daemon.length = 0

    const { result, request } = await answerThroughDriver(o, {
      sessionId,
      interactionId,
      choices: [{ optionIndices: [2] }],
    })

    expect(result).toEqual({ ok: true })
    expect(request).toMatchObject({
      sessionId,
      interactionId,
      principal: { kind: 'user' },
      answer: { kind: 'question', selections: [{ optionIndices: [2] }] },
    })
    expect(answerRequests(o.daemon)).toHaveLength(1)
    expect(inputs(o.daemon)).toEqual([])
    // Settled on the aggregate as a HUMAN's answer (the typed script's 'human'
    // stamp, carried by the row now).
    const row = (await o.reg.modules.interactions.listForSession(sessionId)).find(
      (candidate) => candidate.id === interactionId,
    )
    expect(row).toMatchObject({ status: 'answered', answeredBy: 'human' })
  })

  // biome-ignore format: oracle-tags.test.ts reads the tag off the declaration line
  it.each(ANSWER_SHAPES)(`${MUST_NOT_CHANGE}: $shape reaches the driver as its contract selections, in order, and nothing is typed`, async ({
    questions,
    choices,
    selections,
  }) => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId)
    const interactionId = await openAsk(o, sessionId, questions)
    o.daemon.length = 0

    const { result, request } = await answerThroughDriver(o, { sessionId, interactionId, choices })

    expect(result).toEqual({ ok: true })
    // EXACT: the whole answer, not a subset — an added or reordered selection
    // is a different answer.
    expect(request.answer).toEqual({ kind: 'question', selections })
    expect(inputs(o.daemon)).toEqual([])
  })

  it(`${MUST_NOT_CHANGE}: skip reaches the driver as a skip — nothing is typed`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId)
    const interactionId = await openAsk(o, sessionId, [PICK])
    o.daemon.length = 0

    const { result, request } = await answerThroughDriver(o, {
      sessionId,
      interactionId,
      skip: true,
    })

    expect(result).toEqual({ ok: true })
    expect(request.answer).toEqual({ kind: 'question', skip: true, selections: [] })
    expect(inputs(o.daemon)).toEqual([])
  })

  it(`${MUST_NOT_CHANGE}: an answer with no interaction id, or one the session does not hold, is refused 'unknown-interaction' — nothing reaches the driver and nothing is typed`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId)
    await openAsk(o, sessionId, [PICK])
    o.daemon.length = 0

    // Transcript-derived choices with no authoritative id fail CLOSED rather
    // than typing blind (POD-4292).
    expect(
      await o.call.sessions.answerAskUserQuestion({ sessionId, choices: [{ optionIndices: [1] }] }),
    ).toEqual({ ok: false, reason: 'unknown-interaction' })
    expect(
      await o.call.sessions.answerAskUserQuestion({
        sessionId,
        interactionId: 'ask:not-this-sessions',
        choices: [{ optionIndices: [1] }],
      }),
    ).toEqual({ ok: false, reason: 'unknown-interaction' })
    expect(answerRequests(o.daemon)).toEqual([])
    expect(inputs(o.daemon)).toEqual([])
    expect(await o.reg.modules.interactions.listOpen(sessionId)).toHaveLength(1)
  })

  it(`${MUST_NOT_CHANGE}: answering a session that is not live is refused with ok:false and types nothing`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId)
    await o.call.sessions.hibernate({ sessionId })
    o.daemon.length = 0

    expect(
      await o.call.sessions.answerAskUserQuestion({ sessionId, choices: [{ optionIndices: [1] }] }),
    ).toEqual({ ok: false })
    expect(inputs(o.daemon)).toEqual([])
  })

  /**
   * The server no longer decides deliverability itself: whether a choice can be
   * expressed at this menu is the driver's question, answered from the ask it
   * holds (`questionScriptFor` refuses with a reason and types nothing). What
   * the server pins is that the refusal comes back AS ITSELF, nothing is typed
   * on this side, and the ask stays open for a human rather than being marked
   * answered.
   */
  it(`${MUST_NOT_CHANGE}: a driver's refusal of an undeliverable answer comes back as itself, the ask stays open, and nothing is typed`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId)
    const interactionId = await openAsk(o, sessionId, [PICK, { ...PICK, previewLayout: true }])
    o.daemon.length = 0

    const { result } = await answerThroughDriver(
      o,
      {
        sessionId,
        interactionId,
        choices: [
          { optionIndices: [1] },
          { freeText: 'a custom answer', otherIndex: 4, previewLayout: true, multiSelect: true },
        ],
      },
      {
        ok: false,
        reason: 'not-yet-supported',
        detail: 'question 2: a preview question cannot be multi-select',
      },
    )

    expect(result).toEqual({
      ok: false,
      reason: 'not-yet-supported',
      detail: 'question 2: a preview question cannot be multi-select',
    })
    expect(inputs(o.daemon)).toEqual([])
    expect((await o.reg.modules.interactions.listOpen(sessionId)).map((row) => row.id)).toEqual([
      interactionId,
    ])
  })
})

describe('oracle: continue (the errored-agent retry)', () => {
  /**
   * RE-PINNED ON THE CONTRACT (358ad0ffb POD-4427, POD-4279). This used to pin
   * 'continue\r' typed at the PTY stamped 'auto_continue'. An agent's continue
   * now rides the receipt seam (`sendContinueViaContract`, session-wiring.ts):
   * one when-ready `runtimeSendRequest` carrying 'continue' with origin
   * 'auto_continue', crossing the errored gate it exists for (`allowErrored`).
   * A plain shell keeps the raw keystroke, pinned byte-for-byte below. The gate
   * — ONLY when the phase is errored — is unchanged on both.
   */
  it(`${MUST_NOT_CHANGE}: continue of an agent hands 'continue' to its driver stamped 'auto_continue', ONLY when the agent phase is errored, and types nothing`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId, 'idle')
    o.daemon.length = 0

    // Idle is not a retryable state: refused, and nothing is sent.
    expect(await o.call.sessions.continue({ sessionId })).toEqual({ ok: false })
    expect(runtimeSends(o.daemon, sessionId)).toEqual([])
    expect(durableSends(o.daemon, sessionId)).toEqual([])

    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId,
      state: { phase: 'errored', since: new Date().toISOString(), nativeSubagentCount: 0 },
    })

    expect(await o.call.sessions.continue({ sessionId })).toEqual({ ok: true })
    expect(runtimeSends(o.daemon, sessionId)).toEqual([
      expect.objectContaining({
        text: 'continue',
        origin: 'auto_continue',
        delivery: 'when-ready',
      }),
    ])
    expect(durableSends(o.daemon, sessionId)).toEqual([])
    expect(ptyFrames(o.daemon)).toEqual([])
  })

  it(`${MUST_NOT_CHANGE}: continue of a plain shell types 'continue' + CR stamped 'auto_continue', and ONLY when the phase is errored`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    await goLiveShell(o, sessionId)
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId,
      state: { phase: 'idle', since: new Date().toISOString(), nativeSubagentCount: 0 },
    })
    o.daemon.length = 0

    expect(await o.call.sessions.continue({ sessionId })).toEqual({ ok: false })
    expect(ptyFrames(o.daemon)).toEqual([])

    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId,
      state: { phase: 'errored', since: new Date().toISOString(), nativeSubagentCount: 0 },
    })

    expect(await o.call.sessions.continue({ sessionId })).toEqual({ ok: true })
    expect(ptyFrames(o.daemon)).toEqual([{ inputOrigin: 'auto_continue', data: 'continue\r' }])
    expect(runtimeSends(o.daemon, sessionId)).toEqual([])
  })

  it(`${MUST_NOT_CHANGE}: continue refuses a PARKED session even while its last known phase is errored — a dead PTY would swallow it`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId, 'errored')
    await o.call.sessions.hibernate({ sessionId })
    o.daemon.length = 0

    expect(await o.call.sessions.continue({ sessionId })).toEqual({ ok: false })
    expect(ptyFrames(o.daemon)).toEqual([])
  })
})

describe('oracle: stop (clean end, keep the branch)', () => {
  it(`${MUST_NOT_CHANGE}: stop parks the process, stamps stopReason 'parent', and CLEARS readAt (unlike archive, which keeps it)`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId)
    await o.call.sessions.markRead({ sessionId })
    o.daemon.length = 0
    expect((await o.meta(sessionId)).readAt).not.toBeNull()

    expect(await o.call.sessions.stop({ sessionId })).toEqual({
      ok: true,
      worktreeFreed: false,
      deferredKill: false,
    })

    const row = (await o.store.sessions.loadSessions()).find((r) => r.id === sessionId)
    expect(row).toMatchObject({ status: 'hibernated', stopReason: 'parent' })
    // A terminal transition is new unread information [spec:SP-6144]: stop
    // resurfaces the session, where archive deliberately does not.
    // Per-user (POD-1076): the terminal transition clears EVERY reader's marker,
    // which is what nulling the one column used to mean.
    expect((await o.store.sessions.listReadAt(firstAdminMemberId()))[sessionId]).toBeUndefined()
    // A confirmed retirement, not a fire-and-forget kill frame (722704624): see
    // the hibernate oracle above.
    expect(retirements(o.daemon, sessionId)).toEqual([
      expect.objectContaining({ type: 'runtimeLifecycleRequest', sessionId, verb: 'stop' }),
    ])
  })

  it(`${MUST_NOT_CHANGE}: --force re-labels the park 'forced' (work may have been discarded)`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId)

    expect((await o.call.sessions.stop({ sessionId, force: true })).ok).toBe(true)

    expect(
      (await o.store.sessions.loadSessions()).find((r) => r.id === sessionId)?.stopReason,
    ).toBe('forced')
  })

  it(`${MUST_NOT_CHANGE}: stopping an already-parked session is accepted and does not re-kill it`, async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await goLive(o, sessionId)
    await o.call.sessions.stop({ sessionId })
    // Counted over BOTH retirement frames: since 722704624 the first stop sends
    // a `runtimeLifecycleRequest`, not a `kill`, so a kill-only count would stay
    // at zero whether or not the second stop re-kills.
    const retirementsAfterFirst = retirements(o.daemon, sessionId).length
    expect(retirementsAfterFirst).toBe(1)

    expect((await o.call.sessions.stop({ sessionId })).ok).toBe(true)

    expect(retirements(o.daemon, sessionId)).toHaveLength(retirementsAfterFirst)
    // The row survives — stop keeps the branch, the transcript and the session.
    expect(
      (await o.reg.modules.sessions.listSessions(undefined, 'rpc')).map((s) => s.sessionId),
    ).toEqual([sessionId])
  })
})
