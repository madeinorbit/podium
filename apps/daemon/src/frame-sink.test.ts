/**
 * THE PRODUCTION WIRING OF BOTH OUTBOUND TAPS (POD-2489).
 *
 * WHY THIS FILE EXISTS. POD-2489's adversarial review deleted the native-attach
 * tap from the daemon's outbound sink and watched all eight tests of
 * `control/session-native-client.test.ts` stay green — those tests call
 * `nativeClientStateObserved` directly, and nothing else reached the call site.
 * The same held for passing a wrong phase through it. The fix could have been
 * dead in the shipped daemon and no gate would have said so.
 *
 * So these tests drive REAL `DaemonMessage` frames through the real sink, with no
 * daemon boot: the sink's ports are thunks, and a fake context is all the second
 * tap needs.
 */

import { asSessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './control/context'
import { createFrameSink } from './frame-sink'

const SESSION = asSessionId('22222222-2222-4222-8222-222222222222')

const agentState = (phase: 'idle' | 'working'): DaemonMessage =>
  ({
    type: 'agentState',
    sessionId: SESSION,
    state: { phase, since: '2026-08-20T00:00:00.000Z', nativeSubagentCount: 0 },
  }) as DaemonMessage

function world() {
  const attach = vi.fn(async () => ({ reason: 'busy' }) as never)
  const handle = {
    binding: { family: 'server', driver: 'codex-app-server' },
    attach,
    lease: { release: vi.fn(async () => {}) },
  }
  const ctx = {
    // A session that already asked for Native and was refused: exactly the state
    // an `agentState` frame is supposed to act on.
    nativeClientRequests: new Set([SESSION]),
    nativeClientTransitions: new Map(),
    nativeClientRetries: new Map([[SESSION, 1]]),
    pendingResizes: new Map(),
    clientTerminals: { close: vi.fn(async () => {}), resize: vi.fn(() => false) },
    agentRuntime: { handleFor: (id: string) => (id === SESSION ? handle : undefined) },
  } as unknown as DaemonContext
  const upstream = vi.fn()
  const observe = vi.fn()
  const sink = createFrameSink({
    upstream,
    runtime: () => ({ observe }),
    context: () => ctx,
  })
  return { sink, ctx, attach, upstream, observe }
}

/** The sink hands the reconcile off to a promise chain; let it drain. */
const settled = (ctx: DaemonContext) =>
  vi.waitFor(() => expect(ctx.nativeClientTransitions?.size).toBe(0))

describe('the daemon outbound frame sink', () => {
  it('re-arms a refused native attach from a real agentState frame', async () => {
    const { sink, ctx, attach, upstream } = world()

    sink(agentState('idle'))
    await settled(ctx)

    // THE CALL SITE ITSELF, not the observer it calls: deleting the tap from the
    // sink reddens this, which is exactly what nothing did before.
    expect(attach).toHaveBeenCalledTimes(1)
    expect(attach).toHaveBeenCalledWith({
      mode: 'takeover',
      holder: `podium-native:${SESSION}`,
    })
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('forwards the phase on the frame untranslated', async () => {
    const { sink, ctx, attach } = world()

    // `working` is the refusal restated, and the reconcile drops it. A sink that
    // invented a phase — or forwarded the wrong one — would attach here.
    sink(agentState('working'))
    await settled(ctx)

    expect(attach).not.toHaveBeenCalled()
    expect(ctx.nativeClientRetries?.get(SESSION)).toBe(1)
  })

  it('acts on agentState only', async () => {
    const { sink, ctx, attach, upstream } = world()

    sink({ type: 'transcriptDelta', sessionId: SESSION, items: [] } as unknown as DaemonMessage)
    await settled(ctx)

    expect(attach).not.toHaveBeenCalled()
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('stays fail-open before the context exists', () => {
    const upstream = vi.fn()
    const sink = createFrameSink({
      upstream,
      runtime: () => undefined,
      context: () => undefined,
    })

    // The bootstrap window: `send` is built before the context and the runtime.
    // A frame crossing it goes upstream untapped rather than throwing.
    expect(() => sink(agentState('idle'))).not.toThrow()
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('re-arms a needs_user refusal when the ask is answered', async () => {
    const { sink, ctx, attach } = world()

    // The natural move — open the TUI to answer the prompt — is the one codex
    // refuses, and no state frame ever announces the answer (POD-2494). The
    // causal stream carries it, so this is where that arm comes back to life.
    sink({
      type: 'runtimeEvent',
      sessionId: SESSION,
      event: { t: 'interaction', ev: { ev: 'answered', id: 'ask-1', answeredBy: 'human' } },
    } as unknown as DaemonMessage)
    await settled(ctx)

    expect(attach).toHaveBeenCalledTimes(1)
  })

  it('ignores an ask that only just opened', async () => {
    const { sink, ctx, attach } = world()

    // `asked` is the reason the attach was refused, not the reason to retry it.
    sink({
      type: 'runtimeEvent',
      sessionId: SESSION,
      event: { t: 'interaction', ev: { ev: 'asked', interaction: { id: 'ask-1' } } },
    } as unknown as DaemonMessage)
    await settled(ctx)

    expect(attach).not.toHaveBeenCalled()
  })

  it('never feeds the driver its own output', () => {
    const { sink, observe, upstream } = world()

    sink({ type: 'runtimeEvent', sessionId: SESSION, event: {} } as unknown as DaemonMessage)
    sink({ type: 'runtimeFineEvent', sessionId: SESSION, event: {} } as unknown as DaemonMessage)
    sink(agentState('working'))

    // The driver emits its own `runtimeEvent` frames THROUGH this sink, so
    // observing them here would be a loop. Everything else is fair game.
    expect(observe).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledWith(agentState('working'))
    expect(upstream).toHaveBeenCalledTimes(3)
  })
})
