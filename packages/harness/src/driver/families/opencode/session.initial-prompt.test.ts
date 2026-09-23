/**
 * THE INITIAL PROMPT'S TURN IS REPORTED LIVE (POD-4647).
 *
 * Its own file because `session.test.ts` replaces the runtime module for every
 * test in it; this one needs the real runtime over the fake opencode server, so
 * the turn start is the one `send()` really emits.
 *
 * The event pump reads from `'bootstrap'`, and everything already in the
 * driver's log when it subscribes goes out relabelled as bootstrap. A prompt
 * sent before the pump subscribes puts its `turn/started` in that log. The
 * server's event gate refuses a bootstrap turn start once any earlier event has
 * set a checkpoint, and then refuses the rest of that turn as an epoch jump —
 * so the first turn's fate hung on nothing reaching the log ahead of it.
 */
import type { SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { manifestFor } from '../../../registry.js'
import { createMemoryDriverSlots } from '../../testing/index.js'
import { opencodeFlavor } from './engine-facts.js'
import { createOpencodeSessionRuntime, type DaemonOpencodeRuntime } from './session.js'
import { makeOpencodeTestHost } from './test-support/host.js'

const SESSION_ID = 'opencode-initial-prompt' as SessionId

const runtimes: DaemonOpencodeRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    for (const binding of runtime.bindings()) await runtime.handleFor(binding.sessionId)?.kill?.()
  }
})

describe('opencode launch with an initial prompt', () => {
  it('sends the prompt once and reports its turn start live, not as bootstrap', async () => {
    const sent: DaemonMessage[] = []
    const engine = makeOpencodeTestHost()
    const runtime = createOpencodeSessionRuntime({
      driverSlots: createMemoryDriverSlots(),
      flavor: opencodeFlavor(manifestFor('opencode')!),
      engine,
      send: (message) => sent.push(message),
      emitBind: (bind) => sent.push({ type: 'bind', ...bind }),
      sessionReady: () => {},
      traceRuntimeEvent: () => {},
      startMailContinuation: () => () => {},
    })
    runtimes.push(runtime)

    await runtime.launch({ sessionId: SESSION_ID, cwd: '/work', initialPrompt: 'What is 7 times 8?' })

    const server = engine.serverFor(SESSION_ID)!
    const opencodeSessionId = runtime.handleFor(SESSION_ID)!.binding.resume!.value
    await vi.waitFor(() => expect(server.promptCount(opencodeSessionId)).toBe(1))
    expect(JSON.stringify(server.lastPrompt(opencodeSessionId))).toContain('What is 7 times 8?')

    const turnStarted = await vi.waitFor(() => {
      const event = sent
        .flatMap((message) => (message.type === 'runtimeEvent' ? [message.event] : []))
        .find((candidate) => candidate.t === 'turn' && candidate.ev.ev === 'started')
      expect(event).toBeDefined()
      return event
    })
    expect(turnStarted).toMatchObject({ provenance: 'live', turnEpoch: 1 })
  })
})
