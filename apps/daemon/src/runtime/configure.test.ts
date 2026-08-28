/**
 * THE DAEMON'S HALF OF A STICKY CONFIGURE (POD-3081).
 *
 * This handler is deliberately the thinnest one in `runtime/handlers.ts`: it
 * forwards the patch to the driver and reports what came back. So what is worth
 * pinning is not logic — there is none to speak of — but the three ways a
 * forwarder can lie about a machine it is standing in front of:
 *
 *   1. answering for a session it does not drive,
 *   2. flattening a driver's typed refusal into something the caller cannot act
 *      on,
 *   3. reporting WHEN the change bites from an assumption rather than from the
 *      driver that knows.
 *
 * Hermetic: a stub handle and a stub capability, no process and no provider.
 */

import type { ConfigureRequest, DriverCapabilities, Refusal } from '@podium/agent-runtime'
import type { SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from '../control/context'
import { runtimeHandlers } from './handlers'

const SESSION = 'session-configure' as SessionId

type ConfigureResult = Extract<DaemonMessage, { type: 'runtimeConfigureResult' }>

function makeContext(input: {
  configure?: (request: ConfigureRequest) => Promise<Refusal | { ok: true }>
  effective?: 'immediate' | 'next-turn'
  /** Omit the handle entirely — a session this daemon does not drive. */
  absent?: boolean
}): { ctx: DaemonContext; sent: DaemonMessage[]; seen: ConfigureRequest[] } {
  const sent: DaemonMessage[] = []
  const seen: ConfigureRequest[] = []
  const handle = {
    binding: { sessionId: SESSION },
    async configure(request: ConfigureRequest) {
      seen.push(request)
      return (await input.configure?.(request)) ?? { ok: true as const }
    },
  }
  const ctx = {
    send: (msg: DaemonMessage) => {
      sent.push(msg)
    },
    agentRuntime: {
      handleFor: () => (input.absent ? undefined : handle),
      capabilitiesFor: () =>
        input.effective === undefined
          ? undefined
          : ({
              configure: {
                supported: true,
                value: { fields: ['model', 'effort'], effective: input.effective },
              },
            } as unknown as DriverCapabilities),
    },
  } as unknown as DaemonContext
  return { ctx, sent, seen }
}

const resultOf = (sent: DaemonMessage[]): ConfigureResult['result'] | undefined =>
  sent.find((msg): msg is ConfigureResult => msg.type === 'runtimeConfigureResult')?.result

describe('runtimeConfigureRequest', () => {
  it('forwards only the named fields, and reports when the driver says it bites', async () => {
    const { ctx, sent, seen } = makeContext({ effective: 'next-turn' })

    runtimeHandlers.runtimeConfigureRequest(ctx, {
      type: 'runtimeConfigureRequest',
      requestId: 'req-1',
      sessionId: SESSION,
      effort: 'high',
    } as never)
    await vi.waitFor(() => expect(resultOf(sent)).toBeDefined())

    // A PATCH ARRIVES AS A PATCH. Forwarding `{ model: undefined, effort: 'high' }`
    // would be a different request — `decideConfigure` treats a present key as an
    // asked-for field, so a hand-built object with undefined members is fine and
    // an explicit `model: ''` is not. What must never appear is a model this
    // handler invented from what the server last believed.
    expect(seen).toEqual([{ effort: 'high' }])
    expect(resultOf(sent)).toEqual({ ok: true, effective: 'next-turn' })
  })

  it('reports `immediate` when THAT is what the driver declared', async () => {
    const { ctx, sent } = makeContext({ effective: 'immediate' })

    runtimeHandlers.runtimeConfigureRequest(ctx, {
      type: 'runtimeConfigureRequest',
      requestId: 'req-2',
      sessionId: SESSION,
      model: 'gpt-5-codex',
    } as never)
    await vi.waitFor(() => expect(resultOf(sent)).toBeDefined())

    /**
     * READ, NOT ASSUMED. Hard-coding `next-turn` here would pass on every driver
     * that has it and quietly mis-report the one that does not — and the field
     * exists precisely so a person is told "switched" rather than "from your
     * next message" when the harness really did switch.
     */
    expect(resultOf(sent)).toEqual({ ok: true, effective: 'immediate' })
  })

  it('carries a driver refusal back with its reason AND its detail', async () => {
    const { ctx, sent } = makeContext({
      effective: 'next-turn',
      configure: async () => ({ reason: 'invalid_value', detail: '"gpt 5" contains whitespace' }),
    })

    runtimeHandlers.runtimeConfigureRequest(ctx, {
      type: 'runtimeConfigureRequest',
      requestId: 'req-3',
      sessionId: SESSION,
      model: 'gpt 5',
    } as never)
    await vi.waitFor(() => expect(resultOf(sent)).toBeDefined())

    /**
     * BOTH HALVES SURVIVE THE WIRE. `invalid_value` tells the caller to offer
     * another value where `unsupported` tells it to stop offering the control at
     * all, and the detail is the sentence a person reads to know WHICH other
     * value. A handler that returned a bare boolean would erase both.
     */
    expect(resultOf(sent)).toEqual({
      reason: 'invalid_value',
      detail: '"gpt 5" contains whitespace',
    })
  })

  it('REFUSES `not_running` for a session it does not drive, and asks nobody', async () => {
    const { ctx, sent, seen } = makeContext({ absent: true })

    runtimeHandlers.runtimeConfigureRequest(ctx, {
      type: 'runtimeConfigureRequest',
      requestId: 'req-4',
      sessionId: SESSION,
      model: 'gpt-5-codex',
    } as never)
    await vi.waitFor(() => expect(resultOf(sent)).toBeDefined())

    expect(resultOf(sent)).toEqual({
      reason: 'not_running',
      detail: 'session is not behind the runtime contract',
    })
    expect(seen).toEqual([])
  })

  it('answers `not_running` when the driver THROWS rather than refusing', async () => {
    const { ctx, sent } = makeContext({
      effective: 'next-turn',
      configure: async () => {
        throw new Error('transport closed')
      },
    })

    runtimeHandlers.runtimeConfigureRequest(ctx, {
      type: 'runtimeConfigureRequest',
      requestId: 'req-5',
      sessionId: SESSION,
      model: 'gpt-5-codex',
    } as never)
    await vi.waitFor(() => expect(resultOf(sent)).toBeDefined())

    /**
     * A THROW MUST STILL ANSWER. The caller is a correlated RPC with a timeout;
     * an unanswered frame turns a transport hiccup into a stalled control that
     * only resolves when the window closes. The reason is `not_running` because
     * from the caller's side a dead transport and a gone session are the same
     * fact.
     */
    expect(resultOf(sent)).toMatchObject({ reason: 'not_running' })
  })
})
