/**
 * THE INITIAL PROMPT'S TURN IS REPORTED LIVE (POD-4649).
 *
 * Its own file because `session.test.ts` replaces nothing here — this one needs
 * the real runtime over the fake app-server, so the turn start is the one
 * `send()` really emits.
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
import { codexEngineFacts } from './engine-facts.js'
import { createCodexSessionRuntime, type DaemonCodexRuntime } from './session.js'
import type { CodexRuntimeHost } from './runtime.js'
import { startFakeAppServer, type FakeAppServer } from './test-support/fake-app-server.js'

const SESSION_ID = 'codex-initial-prompt' as SessionId
const PROMPT = 'What is 7 times 8?'

const runtimes: DaemonCodexRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    for (const binding of runtime.bindings()) await runtime.handleFor(binding.sessionId)?.kill?.()
    runtime.dispose()
  }
})

describe('codex launch with an initial prompt', () => {
  it('sends the prompt once and reports its turn start live, not as bootstrap', async () => {
    const sent: DaemonMessage[] = []
    const servers = new Map<SessionId, FakeAppServer>()
    const entries = new Map<string, unknown>()
    let seq = 0
    const host: CodexRuntimeHost = {
      stageAttachment: async ({ source }) => ({
        id: 'test-attachment',
        path: '/tmp/test-' + source.filename,
        filename: source.filename,
        mediaType: source.mediaType,
        kind: source.mediaType.startsWith('image/') ? 'image' : 'file',
      }),
      bindings: {
        recorded: (id) => entries.get(id) as never,
        bound: (entry) => void entries.set(entry.sessionId, entry),
        released: (id) => void entries.delete(id),
      },
      now: () => Date.UTC(2026, 7, 14) + ++seq * 1000,
      mintSessionId: () => 'minted' as SessionId,
      async launch(input) {
        const server = startFakeAppServer()
        servers.set(input.sessionId, server)
        return {
          transport: server.transport,
          clientAddress: `unix:///tmp/${input.sessionId}.sock`,
          process: { key: `podium-cx-${input.sessionId}` },
          stop: async () => {
            server.close()
          },
          kill: async () => {
            server.close()
          },
          resources: () => undefined,
        }
      },
    }
    const runtime = createCodexSessionRuntime({
      driverSlots: createMemoryDriverSlots(),
      facts: codexEngineFacts(manifestFor('codex')!),
      engine: host,
      send: (message) => sent.push(message),
      emitBind: (bind) => sent.push({ type: 'bind', ...bind }),
      sessionReady: () => {},
      traceRuntimeEvent: () => {},
      startMailContinuation: () => () => {},
    })
    runtimes.push(runtime)

    await runtime.launch({ sessionId: SESSION_ID, cwd: '/work', initialPrompt: PROMPT })

    const server = servers.get(SESSION_ID)!
    expect(server).toBeDefined()
    await vi.waitFor(() => expect(server.turnStarts).toBe(1))
    expect(JSON.stringify(server.lastTurnInput)).toContain(PROMPT)

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
