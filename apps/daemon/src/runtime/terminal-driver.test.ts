/**
 * THE RECEIPTS, PINNED (POD-1761 W3).
 *
 * The conformance corpus next door proves the driver satisfies the CONTRACT.
 * What it cannot prove is the part of W3 that is about this family in
 * particular: that a Claude accept is anchored to the causal hook rather than to
 * an echo that happened to arrive, that the degradation from `steer` is reported
 * rather than silent, that an adopt produces exactly one bootstrap and nothing
 * retroactive, and that the observation→event translation never invents a value
 * it was not given. Those are the assertions here.
 *
 * Each one is written against the DRIVER's own surface, not against its
 * internals: if a later change reorganizes the state machine but keeps the
 * receipts honest, these stay green — which is the only way a test earns its
 * place next to a mechanism this old.
 */

import type { PendingInteraction, RuntimeEvent } from '@podium/agent-runtime'
import type { AgentRuntimeState, SessionId, TranscriptItem } from '@podium/model'
import type { AgentObservation, DaemonMessage } from '@podium/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  RUNTIME_CONTRACT_ENV,
  runtimeContractEnabledByEnv,
  runtimeContractEnabledFor,
} from './flag'
import {
  createTerminalRuntime,
  stateEventForObservation,
  type TerminalHarnessProfile,
  type TerminalRuntime,
  type TerminalRuntimeHost,
  turnEventForObservation,
} from './terminal-driver'

// ---------------------------------------------------------------------------
// A fixture world, sized for one assertion at a time
// ---------------------------------------------------------------------------

const CLAUDE: TerminalHarnessProfile = {
  driverId: 'claude-pty',
  // The manifest's own order for Claude: the causal hook first, the transcript
  // echo as the fallback, `unverified` when neither lands.
  sendProof: ['hook', 'transcript-echo'],
  hookAnchoredAccept: true,
  needsSubmitVerification: false,
  usesRawFirstTurn: false,
  archivable: true,
  reportsContextPercent: true,
}

const GROK: TerminalHarnessProfile = {
  driverId: 'generic-pty',
  sendProof: ['transcript-echo'],
  hookAnchoredAccept: false,
  needsSubmitVerification: true,
  usesRawFirstTurn: false,
  archivable: false,
  reportsContextPercent: false,
}

/** The bracketed-paste envelope, parsed without a regex: the escape bytes are
 *  literal control characters, which a `RegExp` literal cannot carry legibly. */
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'
const pastedText = (text: string): string | undefined =>
  text.startsWith(PASTE_START) && text.endsWith(PASTE_END)
    ? text.slice(PASTE_START.length, text.length - PASTE_END.length)
    : undefined

interface VirtualTimer {
  at: number
  fn: () => void
  cancelled: boolean
}

interface World {
  runtime: TerminalRuntime
  host: TerminalRuntimeHost
  /** What the PTY was actually given, in order, decoded. */
  written: string[]
  frames: DaemonMessage[]
  /**
   * Make the fake CLI fire `UserPromptSubmit` when it receives the submitting CR,
   * the way Claude does.
   *
   * POSTED BY THE WORLD, NOT BY THE TEST, and that ordering is the point: a hook
   * posted before the driver has begun watching would prove nothing about the
   * driver and everything about the test's timing. `prompt` overrides what the
   * hook claims to be about, which is how a hook for somebody ELSE's send is
   * modelled.
   */
  hookOnSubmit(sessionId: SessionId, options?: { prompt?: string }): void
  /** Post a transcript record, as the harness's own store would. `reset` is the
   *  harness saying its store was REPLACED — a re-tail, a file rewrite, a resume
   *  rolling onto a new file — which is the case that used to mint a false
   *  `accepted`. */
  echo(sessionId: SessionId, text: string, options?: { reset?: boolean }): void
  observe(sessionId: SessionId, observation: Partial<AgentObservation>): void
  /** The `bind` frame — the daemon saying this session's CLI is up. It is what
   *  the server flips `status` on, and what the drain waits for. */
  bind(sessionId: SessionId): void
  setPhase(sessionId: SessionId, phase: AgentRuntimeState['phase']): void
  killHost(label: string): void
  now(): number
}

function makeWorld(): World {
  let clock = Date.UTC(2026, 7, 14)
  let timers: VirtualTimer[] = []
  let draining = false
  let nextId = 0
  const alive = new Map<string, boolean>()
  const phases = new Map<SessionId, AgentRuntimeState>()
  const written: string[] = []
  const frames: DaemonMessage[] = []
  const autoHook = new Map<SessionId, { prompt?: string }>()
  const pendingPaste = new Map<SessionId, string>()
  let runtime!: TerminalRuntime

  const pump = (): void => {
    if (draining) return
    draining = true
    queueMicrotask(() => {
      draining = false
      timers = timers.filter((timer) => !timer.cancelled)
      if (timers.length === 0) return
      timers.sort((a, b) => a.at - b.at)
      const next = timers.shift()
      if (next) {
        clock = Math.max(clock, next.at)
        next.fn()
      }
      if (timers.length > 0) pump()
    })
  }

  const host: TerminalRuntimeHost = {
    send: (msg) => frames.push(msg),
    bridge: (sessionId) =>
      alive.get(`podium-${sessionId}`)
        ? {
            pid: 99,
            write: (dataBase64) => {
              const text = Buffer.from(dataBase64, 'base64').toString('utf8')
              written.push(text)
              const paste = pastedText(text)
              if (paste !== undefined) {
                pendingPaste.set(sessionId, paste)
                return
              }
              if (text !== '\r') return
              const pasted = pendingPaste.get(sessionId)
              pendingPaste.delete(sessionId)
              const hook = autoHook.get(sessionId)
              if (!hook || pasted === undefined) return
              runtime.onHookPayload(sessionId, {
                hook_event_name: 'UserPromptSubmit',
                prompt: hook.prompt ?? pasted,
              })
            },
          }
        : undefined,
    trackedState: (sessionId) => phases.get(sessionId),
    draftSyncing: () => false,
    durableLabel: (sessionId) => `podium-${sessionId}`,
    scopeUnit: () => undefined,
    durableHostAlive: async (label) => alive.get(label) === true,
    stopSession: ({ durableLabel }) => {
      alive.set(durableLabel, false)
    },
    launch: async (msg) => {
      alive.set(`podium-${msg.sessionId}`, true)
      phases.set(msg.sessionId, {
        phase: 'idle',
        since: new Date(clock).toISOString(),
        nativeSubagentCount: 0,
      })
    },
    readTranscript: async () => [],
    archiveTranscript: async () => ({ path: '/tmp/session.jsonl' }),
    readFileBytes: async () => new TextEncoder().encode('{"role":"user"}'),
    memoryBytes: () => 1024,
    now: () => clock,
    setTimer: (fn, delayMs) => {
      const timer: VirtualTimer = { at: clock + delayMs, fn, cancelled: false }
      timers.push(timer)
      pump()
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as VirtualTimer).cancelled = true
    },
  }

  runtime = createTerminalRuntime(host)

  return {
    runtime,
    host,
    written,
    frames,
    hookOnSubmit: (sessionId, options) => {
      autoHook.set(sessionId, options ?? {})
    },
    echo: (sessionId, text, options) => {
      const item: TranscriptItem = {
        id: `item-${++nextId}`,
        role: 'user',
        ts: new Date(clock).toISOString(),
        text,
      }
      runtime.observe({
        type: 'transcriptDelta',
        sessionId,
        items: [item],
        ...(options?.reset ? { reset: true } : {}),
      })
    },
    bind: (sessionId) => {
      runtime.observe({
        type: 'bind',
        sessionId,
        cmd: 'fixture',
        cwd: '/tmp/w3',
        agentKind: 'claude-code',
        geometry: { cols: 80, rows: 24 },
      })
    },
    observe: (sessionId, partial) => {
      const observation: AgentObservation = {
        podiumSessionId: sessionId,
        provider: 'claude-code',
        providerSessionId: `native-${sessionId}`,
        bindingVersion: 1,
        providerTurnId: null,
        providerPromptId: null,
        observerGeneration: 1,
        providerCursor: { segmentId: 'seg', components: { transcript: ++nextId } },
        providerAt: new Date(clock).toISOString(),
        receivedAt: new Date(clock).toISOString(),
        sourceEventKind: 'test',
        transitionKind: 'activity',
        provenance: 'live',
        inputOrigin: 'human',
        turnEpoch: 1,
        priorPhase: 'idle',
        nextPhase: 'working',
        transitionId: `t-${++nextId}`,
        state: { phase: 'working', since: new Date(clock).toISOString(), nativeSubagentCount: 0 },
        ...partial,
      }
      runtime.observe({ type: 'agentObservation', observation } as DaemonMessage)
    },
    setPhase: (sessionId, phase) => {
      phases.set(sessionId, {
        phase,
        since: new Date(clock).toISOString(),
        nativeSubagentCount: 0,
      })
    },
    killHost: (label) => {
      alive.set(label, false)
    },
    now: () => clock,
  }
}

const SPEC = {
  harness: 'claude-code',
  selection: { auth: 'subscription' as const, platform: 'linux' as NodeJS.Platform, available: [] },
  workdir: '/tmp/w3',
  model: {},
  instructions: { supported: false as const, reason: 'test' },
  mcpServers: { supported: false as const, reason: 'test' },
}

// ---------------------------------------------------------------------------

describe('the flag', () => {
  it('is on only for an explicit 1 or true', () => {
    expect(runtimeContractEnabledByEnv({ [RUNTIME_CONTRACT_ENV]: '1' })).toBe(true)
    expect(runtimeContractEnabledByEnv({ [RUNTIME_CONTRACT_ENV]: 'true' })).toBe(true)
    // The failure mode this exists to prevent: an env-var flag that reads any
    // non-empty string as on, so `=0` turns it on.
    expect(runtimeContractEnabledByEnv({ [RUNTIME_CONTRACT_ENV]: '0' })).toBe(false)
    expect(runtimeContractEnabledByEnv({ [RUNTIME_CONTRACT_ENV]: 'false' })).toBe(false)
    expect(runtimeContractEnabledByEnv({})).toBe(false)
  })

  it('ORs the machine-wide switch with the per-session field, neither winning', () => {
    expect(runtimeContractEnabledFor(false, undefined)).toBe(false)
    expect(runtimeContractEnabledFor(true, undefined)).toBe(true)
    expect(runtimeContractEnabledFor(false, true)).toBe(true)
    // A per-session `false` does NOT veto the machine switch: both mean the same
    // thing, so an operator who flipped the machine gets what they asked for.
    expect(runtimeContractEnabledFor(true, false)).toBe(true)
  })
})

describe('send receipts', () => {
  let world: World

  beforeEach(() => {
    world = makeWorld()
  })

  it('anchors an accept to the causal hook on Claude, ahead of any echo', async () => {
    const driver = world.runtime.driverFor('claude-code', CLAUDE)
    const session = await driver.create(SPEC)
    const sessionId = session.binding.sessionId

    // The hook fires the way Claude's does — on submission, before the
    // transcript record for the turn is written. Nothing has echoed at all.
    world.hookOnSubmit(sessionId)
    const resolved = await session.send(
      { text: 'ship it' },
      { origin: 'human', delivery: 'when-ready' },
    )
    expect(resolved.outcome).toBe('accepted')
    if (resolved.outcome !== 'accepted') return
    // THE MECHANISM IS DECLARED, and this is the one that makes a terminal
    // receipt as good as a protocol ack.
    expect(resolved.provenBy).toBe('hook')
    expect(resolved.deliveredAs).toBe('when-ready')
    expect(resolved.turnEpoch).toBeGreaterThan(0)
  })

  it('does not credit a hook that belongs to a different prompt', async () => {
    const driver = world.runtime.driverFor('claude-code', CLAUDE)
    const session = await driver.create(SPEC)
    const sessionId = session.binding.sessionId

    // A hook for somebody ELSE's send — a queue drain overlapping a chat send is
    // the real case. Crediting it would report an accept for a turn that never
    // landed, so the waiter stays open and the window decides.
    world.hookOnSubmit(sessionId, { prompt: 'something else' })
    const resolved = await session.send(
      { text: 'first' },
      { origin: 'human', delivery: 'when-ready' },
    )
    expect(resolved.outcome).toBe('unverified')
  })

  it('answers `unverified` when the window closes with no proof, and says how long it waited', async () => {
    const driver = world.runtime.driverFor('grok', GROK)
    const session = await driver.create(SPEC)

    const resolved = await session.send(
      { text: 'did this land?' },
      { origin: 'human', delivery: 'when-ready' },
    )
    expect(resolved.outcome).toBe('unverified')
    if (resolved.outcome !== 'unverified') return
    // The two-generals gap made explicit: the caller decides what to do WITH THE
    // TRUTH IN HAND, which needs the number.
    expect(resolved.verificationWindowMs).toBe(4800)
    expect(resolved.deliveredAs).toBe('when-ready')
  })

  it('types a bracketed paste and a separate CR, never one chunk', async () => {
    const driver = world.runtime.driverFor('grok', GROK)
    const session = await driver.create(SPEC)
    await session.send({ text: 'hello' }, { origin: 'human', delivery: 'when-ready' })
    // The CLI's key parser folds a multi-character chunk into ONE key event, so
    // a payload with its CR appended submits nothing at all.
    expect(world.written[0]).toBe('\x1b[200~hello\x1b[201~')
    expect(world.written[1]).toBe('\r')
  })

  it('reports a steer downgrade through deliveredAs', async () => {
    const driver = world.runtime.driverFor('claude-code', CLAUDE)
    const session = await driver.create(SPEC)
    const receipt = await session.send({ text: 'and this' }, { origin: 'mail', delivery: 'steer' })
    expect(receipt.outcome).toBe('queued')
    if (receipt.outcome !== 'queued') return
    // A TUI cannot append into an open turn. The caller learns it did not steer.
    expect(receipt.deliveredAs).toBe('queue')
    expect(receipt.position).toBe(1)
  })

  it('refuses a send while a native prompt is open, and typing nothing is the point', async () => {
    const driver = world.runtime.driverFor('claude-code', CLAUDE)
    const session = await driver.create(SPEC)
    world.setPhase(session.binding.sessionId, 'needs_user')
    const receipt = await session.send(
      { text: 'go on' },
      { origin: 'steward', delivery: 'when-ready' },
    )
    expect(receipt).toEqual({
      outcome: 'refused',
      refusal: { reason: 'needs_user', detail: 'a native prompt is open' },
    })
    expect(world.written).toEqual([])
  })

  it('sends ESC before the replacement prompt on an interrupt delivery', async () => {
    const driver = world.runtime.driverFor('claude-code', CLAUDE)
    const session = await driver.create(SPEC)
    world.setPhase(session.binding.sessionId, 'needs_user')
    world.hookOnSubmit(session.binding.sessionId)
    const resolved = await session.send(
      { text: 'stop and do this' },
      { origin: 'human', delivery: 'interrupt' },
    )
    // The ESC is what dismisses the open prompt, which is why `needs_user` does
    // not refuse this path — and why the paste follows it rather than racing it.
    expect(world.written[0]).toBe('\x1b')
    expect(world.written[1]).toBe('\x1b[200~stop and do this\x1b[201~')
    expect(resolved.outcome).toBe('accepted')
    if (resolved.outcome === 'accepted') expect(resolved.deliveredAs).toBe('interrupt')
  })
})

describe('the echo baseline', () => {
  it('does NOT credit a send because a reset re-delivered the conversation', async () => {
    const world = makeWorld()
    const driver = world.runtime.driverFor('grok', GROK)
    const session = await driver.create(SPEC)
    const sessionId = session.binding.sessionId
    // A conversation that already happened.
    world.echo(sessionId, 'turn one')
    world.echo(sessionId, 'turn two')

    // A send with no proof of its own, whose window overlaps a RESET — the
    // harness's store being replaced and re-read from the top. The old count
    // read an append-only event log, so the reset looked like the whole history
    // echoing at once and credited whatever send happened to be in flight.
    const receipt = session.send(
      { text: 'did this land?' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await Promise.resolve()
    world.echo(sessionId, 'turn one', { reset: true })
    world.echo(sessionId, 'turn two')

    // A FALSE ACCEPT IS STRICTLY WORSE THAN THE `unverified` IT DISPLACES: the
    // caller stops looking, and the turn never happened.
    expect((await receipt).outcome).toBe('unverified')
  })

  it('still credits a genuine new user turn after a reset', async () => {
    const world = makeWorld()
    const driver = world.runtime.driverFor('grok', GROK)
    const session = await driver.create(SPEC)
    const sessionId = session.binding.sessionId
    world.echo(sessionId, 'turn one')

    const receipt = session.send(
      { text: 'a real turn' },
      { origin: 'human', delivery: 'when-ready' },
    )
    await Promise.resolve()
    // The reset re-delivers the history, and THEN the harness records this turn.
    // The count follows the server buffer's semantics exactly, so the baseline
    // moves with the reset and the new turn is still an increase.
    world.echo(sessionId, 'turn one', { reset: true })
    world.echo(sessionId, 'a real turn')

    const resolved = await receipt
    expect(resolved.outcome).toBe('accepted')
    if (resolved.outcome === 'accepted') expect(resolved.provenBy).toBe('transcript-echo')
  })

  it('does not type a raw first turn into a grok that is past its first turn', async () => {
    const world = makeWorld()
    const driver = world.runtime.driverFor('grok', {
      ...GROK,
      // POD-549/POD-901: grok's fresh TUI ignores bracketed paste until a native
      // first turn, so the FIRST prompt goes as raw keystrokes and later ones do
      // not. Reading that from a driver-local event log meant an adopted session
      // — whose log starts empty — typed raw into a long-running conversation.
      usesRawFirstTurn: true,
    })
    const session = await driver.create(SPEC)
    const sessionId = session.binding.sessionId

    void session.send({ text: 'first' }, { origin: 'human', delivery: 'when-ready' })
    await Promise.resolve()
    // No user turn yet: raw keystrokes, no paste envelope.
    expect(world.written[0]).toBe('first')

    world.echo(sessionId, 'first')
    world.written.length = 0
    void session.send({ text: 'second' }, { origin: 'human', delivery: 'when-ready' })
    await Promise.resolve()
    expect(world.written[0]).toBe('\u001b[200~second\u001b[201~')
  })
})

describe('the queue drain', () => {
  it('does not type into a session that is still starting', async () => {
    const world = makeWorld()
    const driver = world.runtime.driverFor('grok', GROK)
    const session = await driver.create(SPEC)

    // Queued while the CLI is still painting. `SessionInbox.drain` only ever
    // delivers into a `live` session; a `starting` one it polls and, at the
    // deadline, abandons WITHOUT typing — because a grok TUI that has bound but
    // not finished painting swallows everything typed at it (POD-549). That is
    // the silent loss the durable row exists to prevent, and flattening the
    // distinction into "running" would deliver into exactly that state.
    const receipt = session.send({ text: 'queued early' }, { origin: 'mail', delivery: 'queue' })
    expect((await receipt).outcome).toBe('queued')

    // Let the whole drain ladder run — floor, quiet, ceiling and deadline.
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let i = 0; i < 400; i++) await Promise.resolve()
    expect(world.written).toEqual([])
  })

  it('delivers once the CLI is up', async () => {
    const world = makeWorld()
    const driver = world.runtime.driverFor('grok', GROK)
    const session = await driver.create(SPEC)
    const sessionId = session.binding.sessionId

    expect(
      (await session.send({ text: 'queued' }, { origin: 'mail', delivery: 'queue' })).outcome,
    ).toBe('queued')
    world.bind(sessionId)
    // The bind is the same fact the server flips `status` on, so the drain and
    // the session row agree on "started" by construction rather than by having
    // two opinions.
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let i = 0; i < 400; i++) await Promise.resolve()
    expect(world.written[0]).toBe('\u001b[200~queued\u001b[201~')
  })
})

describe('interrupt', () => {
  it('REQUESTS a fence: one ESC, no turn event, no epoch movement', async () => {
    const world = makeWorld()
    const driver = world.runtime.driverFor('claude-code', CLAUDE)
    const session = await driver.create(SPEC)
    const before = await session.snapshot()

    await session.interrupt()

    expect(world.written).toEqual(['\x1b'])
    const after = await session.snapshot()
    // A driver that emitted its own fence would let a consumer believe a turn
    // ended that the agent is still running. Fences are absorbing; they are also
    // not ours to mint.
    expect(after.turnEpoch).toBe(before.turnEpoch)
    expect(world.frames.filter((frame) => frame.type === 'runtimeEvent')).toHaveLength(0)
  })
})

describe('adopt', () => {
  it('reproduces exactly one bootstrap snapshot and zero retroactive live events', async () => {
    const world = makeWorld()
    const driver = world.runtime.driverFor('claude-code', CLAUDE)
    const session = await driver.create(SPEC)
    const sessionId = session.binding.sessionId
    world.echo(sessionId, 'a turn that already happened')
    world.observe(sessionId, { transitionKind: 'turn_terminal', nextPhase: 'idle' })
    const checkpoint = await session.snapshot()

    world.runtime.control.restartSupervisor()
    const adopted = await driver.adopt(checkpoint.binding)

    // Everything after the checkpoint, and nothing at or before it.
    const live: RuntimeEvent[] = []
    const stream = adopted.events(checkpoint.cursor)[Symbol.asyncIterator]()
    const first = await stream.next()
    if (!first.done) live.push(first.value)
    expect(live).toHaveLength(1)
    expect(live[0]?.t).toBe('process')
    expect(live[0]?.provenance).toBe('live')
    expect(Number(live[0]?.cursor.components.seq)).toBeGreaterThan(
      Number(checkpoint.cursor.components.seq),
    )

    // Exactly ONE snapshot opens the stream, and it replays the pre-checkpoint
    // history as bootstrap — never as work that just happened.
    const bootstrap: RuntimeEvent[] = []
    const fromScratch = adopted.events('bootstrap')[Symbol.asyncIterator]()
    const opened = await fromScratch.next()
    if (!opened.done) bootstrap.push(opened.value)
    expect(bootstrap[0]?.provenance).toBe('bootstrap')

    const after = await adopted.snapshot()
    // MONOTONIC across the rebind: resetting either number is how a replayed
    // stream reads as new work.
    expect(after.turnEpoch).toBeGreaterThanOrEqual(checkpoint.turnEpoch)
    expect(after.observerGeneration).toBeGreaterThan(checkpoint.observerGeneration)
    expect(after.binding.bindingVersion).toBeGreaterThan(checkpoint.binding.bindingVersion)
  })

  it('refuses a binding whose durable host did not survive', async () => {
    const world = makeWorld()
    const driver = world.runtime.driverFor('claude-code', CLAUDE)
    const session = await driver.create(SPEC)
    const binding = session.binding
    world.killHost(binding.process.key)
    world.runtime.control.restartSupervisor()
    // EXACT identity, checked against the world. Adopting the wrong process is
    // worse than not adopting: it produces a session reporting someone else's work.
    await expect(driver.adopt(binding)).rejects.toThrow(/no surviving durable host/)
  })
})

describe('observation translation', () => {
  const base: AgentObservation = {
    podiumSessionId: 'session-1' as SessionId,
    provider: 'claude-code',
    providerSessionId: 'native-1',
    bindingVersion: 1,
    providerTurnId: null,
    providerPromptId: null,
    observerGeneration: 1,
    providerCursor: { segmentId: 'seg', components: { transcript: 1 } },
    providerAt: '2026-08-14T00:00:00.000Z',
    receivedAt: '2026-08-14T00:00:01.000Z',
    sourceEventKind: 'test',
    transitionKind: 'activity',
    provenance: 'live',
    inputOrigin: 'human',
    turnEpoch: 3,
    priorPhase: 'working',
    nextPhase: 'working',
    transitionId: 't-1',
    state: { phase: 'working', since: '2026-08-14T00:00:00.000Z', nativeSubagentCount: 0 },
  }

  it('takes the completion verdict from the provider, never from a guess', () => {
    const withVerdict = turnEventForObservation({
      ...base,
      transitionKind: 'turn_terminal',
      nextPhase: 'idle',
      state: { ...base.state, phase: 'idle', idle: { kind: 'open_todos' } },
    })
    expect(withVerdict).toEqual({
      t: 'turn',
      ev: { ev: 'completed', turnEpoch: 3, verdict: 'open_todos' },
    })
  })

  it('reads the compaction direction rather than assuming it', () => {
    // Getting this backwards would re-prime the instruction channel at the wrong
    // boundary — a silent failure, which is why it is read from the phase.
    expect(
      stateEventForObservation({
        ...base,
        transitionKind: 'compaction',
        nextPhase: 'compacting',
      }),
    ).toMatchObject({ kind: 'compaction', phase: 'start' })
    expect(
      stateEventForObservation({
        ...base,
        transitionKind: 'compaction',
        nextPhase: 'idle',
      }),
    ).toMatchObject({ kind: 'compaction', phase: 'end' })
  })

  it('emits NOTHING for a transition it cannot name honestly', () => {
    // The observation does not carry a subagent delta's direction, so there is no
    // event that would be true. Silence beats plausible.
    expect(stateEventForObservation({ ...base, transitionKind: 'subagent_bookkeeping' })).toBeNull()
    expect(turnEventForObservation({ ...base, transitionKind: 'activity' })).toBeNull()
  })

  it('stamps EVENT time, never observation time', async () => {
    const world = makeWorld()
    const driver = world.runtime.driverFor('claude-code', CLAUDE)
    const session = await driver.create(SPEC)
    world.observe(session.binding.sessionId, {
      transitionKind: 'turn_opened',
      nextPhase: 'working',
      providerAt: '2026-01-01T00:00:00.000Z',
      receivedAt: '2026-08-14T09:00:00.000Z',
    })
    const emitted = world.frames.filter(
      (frame): frame is Extract<DaemonMessage, { type: 'runtimeEvent' }> =>
        frame.type === 'runtimeEvent',
    )
    expect(emitted.length).toBeGreaterThan(0)
    // Observe-time stamping is what makes a reattach re-date every session to
    // "now"; the codebase is strict about this and so is the envelope.
    expect(emitted[0]?.event.at).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('interactions', () => {
  it('carries the ask through from the phase transition that reported it', async () => {
    const world = makeWorld()
    const driver = world.runtime.driverFor('claude-code', CLAUDE)
    const session = await driver.create(SPEC)
    world.observe(session.binding.sessionId, {
      transitionKind: 'needs_user',
      nextPhase: 'needs_user',
      state: {
        phase: 'needs_user',
        since: '2026-08-14T00:00:00.000Z',
        nativeSubagentCount: 0,
        need: { kind: 'permission', summary: 'Bash wants to run tests' },
      },
    })
    const open = await session.interactions()
    expect(open).toHaveLength(1)
    const ask = open[0] as PendingInteraction
    expect(ask.kind).toBe('permission')
    expect(ask.payload).toEqual({ summary: 'Bash wants to run tests' })
    // A hook-sourced ask still has a keystroke-emulated ANSWER: that asymmetry is
    // what keeps the whole family behind the at-least-once exemption.
    expect(ask.source).toBe('hook')
    expect(ask.answerable).toBe('keystroke-emulated')
  })

  it('closes an ask that a person answered at the terminal', async () => {
    const world = makeWorld()
    const driver = world.runtime.driverFor('claude-code', CLAUDE)
    const session = await driver.create(SPEC)
    const sessionId = session.binding.sessionId
    world.observe(sessionId, {
      transitionKind: 'needs_user',
      nextPhase: 'needs_user',
      state: {
        phase: 'needs_user',
        since: 'x',
        nativeSubagentCount: 0,
        need: { kind: 'question' },
      },
    })
    expect(await session.interactions()).toHaveLength(1)
    world.observe(sessionId, {
      transitionKind: 'activity',
      priorPhase: 'needs_user',
      nextPhase: 'working',
    })
    // Reporting it as `expired` would tell a consumer the ask went unanswered
    // when a person at the attached terminal answered it — which is the one
    // thing a TUI session always allows.
    expect(await session.interactions()).toHaveLength(0)
  })
})

describe('capabilities', () => {
  it('declares the terminal weaknesses and claims no others', async () => {
    const world = makeWorld()
    const driver = world.runtime.driverFor('claude-code', CLAUDE)
    const caps = driver.capabilities()
    expect(caps.send.mayReturnUnverified).toBe(true)
    expect(caps.send.native).not.toContain('steer')
    expect(caps.interrupt.fenceOnProviderConfirmation).toBe(true)
    expect(caps.placement).toBe('dedicated')
    // `no-attach` is the EMBEDDED family's exemption. A terminal session's engine
    // terminal is exactly the thing it has.
    expect(caps.attach.supported).toBe(true)
    expect(caps.observation.watchLevels).toEqual(['coarse'])
    expect(caps.draft.supported && caps.draft.value.write).toBe(false)
  })
})
