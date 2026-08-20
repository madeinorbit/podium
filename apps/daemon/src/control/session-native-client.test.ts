import { type AgentPhase, type AgentRuntimeState, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './context'
import { nativeClientStateObserved, sessionHandlers } from './session'

const SESSION = asSessionId('11111111-1111-4111-8111-111111111111')

function world() {
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
    binding: { family: 'server', driver: 'opencode-server' },
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
    expect(clientTerminals.close).toHaveBeenCalledWith(SESSION, undefined)
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
    const { ctx, attach, clientTerminals } = world()
    attach.mockResolvedValueOnce({ reason: 'busy', detail: 'a turn is open' } as never)

    openNative(ctx)
    await settled(ctx)
    expect(attach).toHaveBeenCalledTimes(1)
    expect(clientTerminals.viewers).toHaveBeenLastCalledWith(SESSION, true)
    // Refused, but owed: the request is still live and recorded as such.
    expect(ctx.nativeClientRetries?.get(SESSION)).toBe(1)

    // Mid-turn states are the refusal restated — spending the small budget on
    // them would exhaust it before the session ever became attachable.
    nativeClientStateObserved(ctx, SESSION, stateOf('working'))
    nativeClientStateObserved(ctx, SESSION, stateOf('needs_user'))
    expect(attach).toHaveBeenCalledTimes(1)

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
    const { ctx, attach } = world()
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
    const { ctx, attach } = world()
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
    const { ctx, attach, release } = world()
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

  it('forgets a request whose session ended before it could be honoured', async () => {
    const { ctx, attach } = world()
    attach.mockResolvedValue({ reason: 'busy' } as never)

    openNative(ctx)
    await settled(ctx)
    expect(ctx.nativeClientRetries?.get(SESSION)).toBe(1)

    nativeClientStateObserved(ctx, SESSION, stateOf('ended'))
    expect(ctx.nativeClientRetries?.has(SESSION)).toBe(false)
    expect(attach).toHaveBeenCalledTimes(1)
  })
})
