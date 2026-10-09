/**
 * THE INITIAL PROMPT'S TURN IS REPORTED LIVE (POD-4649).
 *
 * Its own file because `session.test.ts` drives adoption through a stub
 * transport; this one needs the real runtime over the fake ACP server, so the
 * turn start is the one `send()` really emits.
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
import { createMemoryDriverSlots, serverFamilyLaunch } from '../../testing/index.js'
import { grokEngineFacts } from './engine-facts.js'
import { createGrokSessionRuntime, type DaemonGrokRuntime } from './session.js'
import type { GrokAcpRuntimeHost } from './runtime.js'
import { startFakeGrokAcpServer, type FakeGrokAcpServer } from './test-support/fake-acp-server.js'

const SESSION_ID = 'grok-initial-prompt' as SessionId
const PROMPT = 'What is 7 times 8?'

const runtimes: DaemonGrokRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
})

describe('grok-acp launch with an initial prompt', () => {
  it('sends the prompt once and reports its turn start live, not as bootstrap', async () => {
    const sent: DaemonMessage[] = []
    const servers = new Map<SessionId, FakeGrokAcpServer>()
    const entries = new Map<SessionId, never>()
    let seq = 0
    const host: GrokAcpRuntimeHost = {
      bindings: {
        recorded: (id) => entries.get(id),
        bound: (entry) => void entries.set(entry.sessionId, entry as never),
        released: (id) => void entries.delete(id),
      },
      now: () => Date.UTC(2026, 7, 20) + ++seq * 1000,
      mintSessionId: () => `gk-minted-${++seq}` as SessionId,
      readHistory: async () => ({ items: [], hasMore: false }),
      async launch(input) {
        const server = startFakeGrokAcpServer(`grok-native-${input.sessionId}`)
        servers.set(input.sessionId, server)
        return {
          transport: server.transport,
          process: { key: `podium-gk-${input.sessionId}`, pid: 4000 + seq },
          alive: () => server.alive,
          stop: async () => server.crash(),
          kill: async () => server.crash(),
          resources: () => undefined,
        }
      },
    }
    const runtime = createGrokSessionRuntime({
      driverSlots: createMemoryDriverSlots(),
      facts: grokEngineFacts(manifestFor('grok')!),
      engine: host,
      send: (message) => sent.push(message),
      emitBind: (bind) => {
        sent.push({ type: 'bind', ...bind })
      },
      sessionReady: () => {},
      traceRuntimeEvent: () => {},
      startMailContinuation: () => () => {},
    })
    runtimes.push(runtime)

    await runtime.launch(
      serverFamilyLaunch({
        sessionId: SESSION_ID,
        cwd: '/work',
        initialPrompt: PROMPT,
        instructions: [{ source: 'podium:issues', content: 'Run `podium issue prime`.' }],
      }),
    )

    const server = servers.get(SESSION_ID)!
    expect(server).toBeDefined()
    // The spec's instructions reach Grok as session rules (POD-5814).
    expect(server.sessionNews[0]).toMatchObject({ _meta: { rules: 'Run `podium issue prime`.' } })
    await vi.waitFor(() => expect(server.promptCount).toBe(1))

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
