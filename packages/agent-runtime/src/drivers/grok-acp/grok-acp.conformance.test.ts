import type { SessionId } from '@podium/model'
import { PERMITTED_FAILURES } from '../../permitted-failures.js'
import type { ConformanceControl, ConformanceTarget } from '../../testing/index.js'
import { runConformance } from '../../testing/index.js'
import { createGrokAcpClient } from './client.js'
import {
  createGrokAcpRuntime,
  type GrokAcpEndpoint,
  type GrokAcpJournal,
  type GrokAcpJournalEntry,
  type GrokAcpRuntime,
  type GrokAcpRuntimeHost,
} from './runtime.js'
import { type FakeGrokAcpServer, startFakeGrokAcpServer } from './test-support/fake-acp-server.js'

function makeWorld(): { target: ConformanceTarget } {
  let runtime: GrokAcpRuntime | undefined
  let replayPromptSettlement: (() => void) | undefined
  let seq = 0
  const servers = new Map<SessionId, FakeGrokAcpServer>()
  const entries = new Map<SessionId, GrokAcpJournalEntry>()
  const journal: GrokAcpJournal = {
    read: (id) => entries.get(id),
    write: (entry) => entries.set(entry.sessionId, entry),
    clear: (id) => {
      entries.delete(id)
    },
  }
  const processKey = (id: SessionId): string => `podium-gk-${id}`
  const host: GrokAcpRuntimeHost = {
    journal,
    now: () => Date.UTC(2026, 7, 16) + ++seq * 1000,
    mintSessionId: () => `gk-session-${++seq}` as SessionId,
    makeClient(config) {
      const client = createGrokAcpClient(config)
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property !== 'call') return Reflect.get(target, property, receiver)
          return (method: string, params?: unknown): Promise<unknown> => {
            const promise = client.call(method, params)
            if (method !== 'session/prompt') return promise
            // A native Promise settles once, while the driver fence must also
            // absorb a provider adapter that delivers the same settlement
            // twice. This replayable thenable exposes that exact boundary.
            return {
              then(
                onfulfilled: (value: unknown) => unknown,
                onrejected: (reason: unknown) => unknown,
              ): Promise<unknown> {
                return promise.then((value) => {
                  replayPromptSettlement = () => {
                    void onfulfilled(value)
                  }
                  return onfulfilled(value)
                }, onrejected)
              },
            } as Promise<unknown>
          }
        },
      })
    },
    async launch(input) {
      const nativeId =
        entries.get(input.sessionId)?.grokSessionId ?? `grok-native-${input.sessionId}`
      replayPromptSettlement = undefined
      const server = startFakeGrokAcpServer(nativeId, {
        onReplayedPromptResult: () => replayPromptSettlement?.(),
      })
      servers.get(input.sessionId)?.crash()
      servers.set(input.sessionId, server)
      const endpoint: GrokAcpEndpoint = {
        transport: server.transport,
        process: {
          key: processKey(input.sessionId),
          pid: 5000 + seq,
          scopeUnit: `${processKey(input.sessionId)}.scope`,
        },
        stop: async () => server.crash(),
        kill: async () => {
          server.crash()
          servers.delete(input.sessionId)
        },
        resources: () => ({ memoryBytes: 80 * 1024 * 1024, oomKills: 0 }),
        alive: () => server.alive,
      }
      return endpoint
    },
    readArchive: async () => [{ path: 'updates.jsonl', bytes: new TextEncoder().encode('{}\n') }],
    attachClient: async ({ sessionId }) => ({
      streamId: `grok-client-${sessionId}`,
      warmTtlMs: 300_000,
    }),
  }
  const serverFor = (id: SessionId): FakeGrokAcpServer => {
    const server = servers.get(id)
    if (!server) throw new Error(`no fake Grok ACP server for ${id}`)
    return server
  }
  const control: ConformanceControl = {
    askInteraction(sessionId) {
      return serverFor(sessionId).askPermission()
    },
    reaskInteraction(sessionId) {
      return serverFor(sessionId).askPermission()
    },
    async completeTurn(sessionId) {
      serverFor(sessionId).completeTurn()
      // The response settles a Promise; yielding here makes this control a
      // causal barrier before the corpus sends its later ordering witness.
      await Promise.resolve()
    },

    async failTurn(sessionId) {
      serverFor(sessionId).completeTurn('refusal')
      await Promise.resolve()
    },
    processEvent(sessionId, ev) {
      if (ev.ev === 'exited') serverFor(sessionId).crash()
    },
    failNextVerification(sessionId) {
      serverFor(sessionId).failNextPrompt()
    },
    textDeliveries(sessionId) {
      return serverFor(sessionId).promptCount
    },
    restartSupervisor() {
      for (const [sessionId, server] of servers) {
        runtime?.forget(sessionId)
        server.crash()
      }
    },
    connectWithoutSecret() {
      return { refused: true }
    },
  }
  return {
    target: {
      name: 'grok-acp',
      family: 'server',
      createDriver: () => {
        runtime = createGrokAcpRuntime(host)
        return { driver: runtime.driver, control }
      },
      reset: () => {
        runtime?.dispose()
        runtime = undefined
        for (const server of servers.values()) server.crash()
        servers.clear()
        entries.clear()
        replayPromptSettlement = undefined
        seq = 0
      },
      spec: () => ({
        harness: 'grok',
        selection: {
          auth: 'subscription',
          platform: 'linux',
          available: ['grok-acp'],
          preference: 'grok-acp',
        },
        workdir: '/tmp/conformance-grok',
        model: {},
        instructions: { supported: false, reason: 'fixture' },
        mcpServers: { supported: false, reason: 'fixture' },
      }),
    },
  }
}

const { target } = makeWorld()
runConformance(target.createDriver, {
  name: target.name,
  family: target.family,
  reset: target.reset,
  spec: target.spec,
  exemptions: PERMITTED_FAILURES.server,
})
