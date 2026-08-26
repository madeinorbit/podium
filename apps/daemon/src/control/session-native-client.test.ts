import { type AgentPhase, type AgentRuntimeState, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './context'
import {
  nativeClientInteractionAnswered,
  nativeClientStateObserved,
  sessionHandlers,
} from './session'

const SESSION = asSessionId('11111111-1111-4111-8111-111111111111')
/** Every transient refusal these tests drive is one only codex can issue. */
const CODEX = 'codex-app-server' as const

/**
 * The driver matters because only codex can issue the `busy`/`needs_user`
 * refusals the retry tests drive. It no longer changes the release arm: that arm
 * used to ask which driver this was, and POD-2823 established the teardown is
 * owed to every one of them.
 */
function world(driver: 'opencode-server' | 'codex-app-server' = 'opencode-server') {
  const attach = vi.fn(async () => ({
    kind: 'client' as const,
    placement: 'on-machine' as const,
    stream: { id: SESSION },
    warm: { ttlMs: 1_000 },
  }))
  const release = vi.fn(async () => {})
  const clientTerminals = {
    attach: vi.fn(),
    adopt: vi.fn(),
    close: vi.fn(async () => {}),
    viewers: vi.fn(),
    input: vi.fn(() => false),
    resize: vi.fn(() => false),
    redraw: vi.fn(() => false),
    reclaimable: vi.fn(() => 0),
    reclaimUnwatched: vi.fn(async () => 0),
  }
  const handle = {
    binding: { family: 'server', driver },
    attach,
    lease: { release },
  }
  const ctx = {
    outputScheduler: { setPriority: vi.fn() },
    clientTerminals,
    nativeClientRequests: new Set([SESSION]),
    nativeClientTransitions: new Map(),
    pendingResizes: new Map(),
    agentRuntime: {
      handleFor: (id: string) => (id === SESSION ? handle : undefined),
      has: (id: string) => id === SESSION,
    },
    bridges: new Map(),
    observers: { recordInputOrigin: vi.fn() },
    composerEngine: { onInputByte: vi.fn(), onResize: vi.fn() },
  } as unknown as DaemonContext
  return { ctx, attach, release, clientTerminals }
}

/** The frame the daemon already emits on every phase change, as this session. */
const stateOf = (phase: AgentPhase): AgentRuntimeState => ({
  phase,
  since: '2026-08-20T00:00:00.000Z',
  nativeSubagentCount: 0,
})

/** Let the in-flight attach/release transition finish before asserting on what
 *  it recorded — the reconcile calls `attach()` before it takes its own slot. */
const settled = (ctx: DaemonContext) =>
  vi.waitFor(() => expect(ctx.nativeClientTransitions?.size).toBe(0))

/** Open Native on this session, exactly as the browser's view switch does. */
function openNative(ctx: DaemonContext, nativeView = true): void {
  sessionHandlers.sessionPriority(ctx, {
    type: 'sessionPriority',
    sessionId: SESSION,
    priority: 0,
    nativeView,
  })
}

describe('server-family native client control', () => {
  it('attaches on a native view and releases the lease on a chat view', async () => {
    const { ctx, attach, release, clientTerminals } = world()
    sessionHandlers.sessionPriority(ctx, {
      type: 'sessionPriority',
      sessionId: SESSION,
      priority: 0,
      nativeView: true,
    })
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1))
    expect(clientTerminals.viewers).toHaveBeenLastCalledWith(SESSION, true)
    expect(attach).toHaveBeenCalledWith({
      mode: 'takeover',
      holder: `podium-native:${SESSION}`,
    })

    sessionHandlers.sessionPriority(ctx, {
      type: 'sessionPriority',
      sessionId: SESSION,
      priority: 0,
      nativeView: false,
    })
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(`podium-native:${SESSION}`))
    expect(clientTerminals.close).toHaveBeenCalledWith(SESSION)
    expect(clientTerminals.viewers).toHaveBeenLastCalledWith(SESSION, false)
  })

  it('routes terminal input, geometry, and redraw without a PTY bridge', () => {
    const { ctx, clientTerminals } = world()
    clientTerminals.input.mockReturnValue(true)
    clientTerminals.resize.mockReturnValue(true)
    clientTerminals.redraw.mockReturnValue(true)

    sessionHandlers.input(ctx, {
      type: 'input',
      sessionId: SESSION,
      data: 'aGVsbG8=',
      inputOrigin: 'human',
    })
    sessionHandlers.resize(ctx, { type: 'resize', sessionId: SESSION, cols: 91, rows: 33 })
    sessionHandlers.redraw(ctx, { type: 'redraw', sessionId: SESSION })

    expect(clientTerminals.input).toHaveBeenCalledWith(SESSION, 'aGVsbG8=')
    expect(clientTerminals.resize).toHaveBeenCalledWith(SESSION, 91, 33)
    expect(clientTerminals.redraw).toHaveBeenCalledWith(SESSION)
    expect(ctx.pendingResizes.has(SESSION)).toBe(false)
  })

  it('drops stale client-terminal input after Chat releases Native', () => {
    const { ctx, clientTerminals } = world()
    ctx.nativeClientRequests?.delete(SESSION)
    sessionHandlers.input(ctx, {
      type: 'input',
      sessionId: SESSION,
      data: 'c3RhbGU=',
      inputOrigin: 'human',
    })
    expect(clientTerminals.input).not.toHaveBeenCalled()
  })
})

/**
 * THE DROPPED REQUEST (POD-2489). Codex hands its single writer to the native
 * TUI only while idle, so opening Native mid-turn is refused with `busy` — and
 * every refusal used to end the reconcile with nothing scheduled to come back.
 * The user got a dark view until they toggled to Chat and back.
 */
describe('a native attach the session refused', () => {
  it('re-attaches on its own once the turn ends', async () => {
    const { ctx, attach, clientTerminals } = world(CODEX)
    attach.mockResolvedValueOnce({ reason: 'busy', detail: 'a turn is open' } as never)

    openNative(ctx)
    await settled(ctx)
    expect(attach).toHaveBeenCalledTimes(1)
    expect(clientTerminals.viewers).toHaveBeenLastCalledWith(SESSION, true)
    // Refused, but owed: the request is still live and recorded as such.
    expect(ctx.nativeClientRetries?.get(SESSION)).toBe(1)

    // Mid-turn states are the refusal restated — spending the small budget on
    // them would exhaust it before the session ever became attachable. `errored`
    // and `unknown` are not retried either: only a codex session can be in this
    // map, and the codex driver assigns neither phase, so an arm for them would
    // be a claim no reachable session can take.
    for (const phase of ['working', 'compacting', 'needs_user', 'errored', 'unknown'] as const) {
      nativeClientStateObserved(ctx, SESSION, stateOf(phase))
    }
    expect(attach).toHaveBeenCalledTimes(1)
    expect(ctx.nativeClientRetries?.get(SESSION)).toBe(1)

    // The turn ends. NO USER ACTION: the same frame the badge already rides.
    nativeClientStateObserved(ctx, SESSION, stateOf('idle'))
    await settled(ctx)
    expect(attach).toHaveBeenCalledTimes(2)
    expect(attach).toHaveBeenLastCalledWith({
      mode: 'takeover',
      holder: `podium-native:${SESSION}`,
    })
    // Attached: nothing is owed, so a later idle does not re-attach.
    expect(ctx.nativeClientRetries?.has(SESSION)).toBe(false)
    nativeClientStateObserved(ctx, SESSION, stateOf('idle'))
    expect(attach).toHaveBeenCalledTimes(2)
  })

  it('does not retry a refusal that will not clear on its own', async () => {
    const { ctx, attach } = world(CODEX)
    attach.mockResolvedValue({ reason: 'lease_held', detail: 'held by someone else' } as never)

    openNative(ctx)
    await settled(ctx)
    expect(attach).toHaveBeenCalledTimes(1)
    // `lease_held` names another human-controller: retrying against it is the
    // interleaving the lease exists to prevent. Same for a machine that cannot
    // host a client terminal at all.
    expect(ctx.nativeClientRetries?.has(SESSION)).toBe(false)

    nativeClientStateObserved(ctx, SESSION, stateOf('idle'))
    nativeClientStateObserved(ctx, SESSION, stateOf('idle'))
    expect(attach).toHaveBeenCalledTimes(1)
  })

  it('gives up after a bounded number of transient refusals', async () => {
    const { ctx, attach } = world(CODEX)
    attach.mockResolvedValue({ reason: 'busy' } as never)

    openNative(ctx)
    await settled(ctx)
    // A session flapping between idle and working must not re-attempt the
    // handoff forever — the retry is armed by state changes, not a timer.
    for (let i = 0; i < 10; i += 1) {
      nativeClientStateObserved(ctx, SESSION, stateOf('idle'))
      await settled(ctx)
    }
    expect(attach).toHaveBeenCalledTimes(4)
    expect(ctx.nativeClientRetries?.has(SESSION)).toBe(false)
  })

  it('drops the pending retry when the user goes back to Chat', async () => {
    const { ctx, attach, release } = world(CODEX)
    attach.mockResolvedValueOnce({ reason: 'needs_user' } as never)

    openNative(ctx)
    await settled(ctx)
    expect(ctx.nativeClientRetries?.get(SESSION)).toBe(1)

    openNative(ctx, false)
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(`podium-native:${SESSION}`))
    // Firing the retry now would take the lease behind the user's back.
    expect(ctx.nativeClientRetries?.has(SESSION)).toBe(false)
    nativeClientStateObserved(ctx, SESSION, stateOf('idle'))
    expect(attach).toHaveBeenCalledTimes(1)
  })

  it('re-arms a needs_user refusal off the answer, not off a state frame', async () => {
    const { ctx, attach } = world(CODEX)
    attach.mockResolvedValueOnce({ reason: 'needs_user' } as never)

    openNative(ctx)
    await settled(ctx)
    expect(ctx.nativeClientRetries?.get(SESSION)).toBe(1)

    // THE PHASE CANNOT CARRY THIS ONE. A session with an open ask reports
    // `needs_user`, which is the refusal restated, and codex emits no state event
    // when the ask closes (POD-2494) — so the arm would be inert if it waited for
    // a frame. The answer itself is the trigger.
    nativeClientStateObserved(ctx, SESSION, stateOf('needs_user'))
    expect(attach).toHaveBeenCalledTimes(1)

    nativeClientInteractionAnswered(ctx, SESSION)
    await settled(ctx)
    expect(attach).toHaveBeenCalledTimes(2)
  })

  it('ignores an answer for a session that never asked for Native', async () => {
    const { ctx, attach, release, clientTerminals } = world(CODEX)
    ctx.nativeClientRequests?.delete(SESSION)

    // No refused request, nothing owed: an answer is just an answer. WITHOUT the
    // guard the reconcile would take its RELEASE arm instead of returning —
    // closing a client terminal and dropping a lease for every answered ask on
    // every server session, which is why `attach` alone does not pin this.
    nativeClientInteractionAnswered(ctx, SESSION)
    await settled(ctx)
    expect(attach).not.toHaveBeenCalled()
    expect(clientTerminals.close).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  /**
   * THE REGRESSION ROUND TWO SHIPPED AND ROUND THREE TOOK BACK.
   *
   * Answering an approval RESUMES the turn — codex's own driver says so — so the
   * attach fired off an answer is refused `busy`. Charged against the same three
   * attempts as a flapping state frame, an ordinary three-approval turn emptied
   * the budget before the idle frame that would have succeeded, leaving the user
   * exactly where this issue started.
   */
  it('does not spend the budget on answers, so the idle frame still lands', async () => {
    const { ctx, attach } = world(CODEX)
    attach.mockResolvedValue({ reason: 'needs_user' } as never)

    openNative(ctx)
    await settled(ctx)
    expect(ctx.nativeClientRetries?.get(SESSION)).toBe(1)

    // Three approvals answered, three attaches refused `busy` because each answer
    // restarted the turn. None of them may cost an attempt.
    attach.mockResolvedValue({ reason: 'busy' } as never)
    for (let i = 0; i < 3; i += 1) {
      nativeClientInteractionAnswered(ctx, SESSION)
      await settled(ctx)
    }
    expect(attach).toHaveBeenCalledTimes(4)
    expect(ctx.nativeClientRetries?.get(SESSION)).toBe(1)

    // The turn ends. This is the frame the whole issue is about.
    attach.mockResolvedValue({ kind: 'client', stream: { id: SESSION } } as never)
    nativeClientStateObserved(ctx, SESSION, stateOf('idle'))
    await settled(ctx)
    expect(attach).toHaveBeenCalledTimes(5)
    expect(ctx.nativeClientRetries?.has(SESSION)).toBe(false)
  })

  it('still caps the state frames an answer did not pay for', async () => {
    const { ctx, attach } = world(CODEX)
    attach.mockResolvedValue({ reason: 'busy' } as never)

    openNative(ctx)
    await settled(ctx)
    // A free attempt leaves the count where it was rather than resetting it, so
    // the flapping cap the answers bypassed is still exactly three deep.
    nativeClientInteractionAnswered(ctx, SESSION)
    await settled(ctx)
    expect(ctx.nativeClientRetries?.get(SESSION)).toBe(1)

    for (let i = 0; i < 5; i += 1) {
      nativeClientStateObserved(ctx, SESSION, stateOf('idle'))
      await settled(ctx)
    }
    // 1 open + 1 free answer + 3 charged state frames, then the entry is gone.
    expect(attach).toHaveBeenCalledTimes(5)
    expect(ctx.nativeClientRetries?.has(SESSION)).toBe(false)
  })

  /**
   * THE OBLIGATION, NOT THE NAME (POD-2823).
   *
   * This used to assert `close(SESSION, 'codex')` and explain that "the kind is
   * what revokes the stock TUI's direct WebSocket writer". The kind never
   * revoked anything — `close()` reclaims the record's own label whatever kind
   * it is given, and on a release straight after an attach there is always a
   * record. So the assertion pinned an IDENTIFIER while believing it pinned a
   * teardown, which is this epic's signature defect wearing a test's clothes.
   *
   * What actually protects the lease gate is ORDER: the client that holds a
   * direct writer to the codex listener must be gone BEFORE the lease is handed
   * to anyone else. That is what is asserted now, and it is asserted for every
   * server driver rather than for the one whose name someone remembered.
   */
  it.each([
    'codex-app-server',
    'opencode-server',
  ] as const)('takes the client down before releasing the lease (%s)', async (driver) => {
    const order: string[] = []
    const { ctx, clientTerminals, release } = world(driver)
    clientTerminals.close.mockImplementation(async () => {
      order.push('close')
    })
    release.mockImplementation(async () => {
      order.push('release')
    })

    openNative(ctx)
    await settled(ctx)
    openNative(ctx, false)
    await settled(ctx)

    expect(clientTerminals.close).toHaveBeenCalledWith(SESSION)
    // A lease released while the stock TUI still holds its own writer lets
    // queued keystrokes bypass the gate entirely.
    expect(order).toEqual(['close', 'release'])
  })

  it('forgets a request whose session ended before it could be honoured', async () => {
    const { ctx, attach } = world(CODEX)
    attach.mockResolvedValue({ reason: 'busy' } as never)

    openNative(ctx)
    await settled(ctx)
    expect(ctx.nativeClientRetries?.get(SESSION)).toBe(1)

    nativeClientStateObserved(ctx, SESSION, stateOf('ended'))
    expect(ctx.nativeClientRetries?.has(SESSION)).toBe(false)
    expect(attach).toHaveBeenCalledTimes(1)
  })
})
