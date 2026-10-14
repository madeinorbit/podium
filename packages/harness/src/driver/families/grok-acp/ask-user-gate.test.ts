/**
 * GROK'S INTERVIEW IS REFUSED WITH WHERE TO ASK (POD-6108, ANALYSIS.md D5).
 *
 * Grok 1.0.52 asks the client `_x.ai/ask_user_question` (RUN with a fake model
 * server, 2026-10-14), and a JSON-RPC error's message reaches the model as the
 * tool's failure. This client has no way to show Grok's interview to a person, so
 * the request is always refused; a session below a coordinator is told the
 * coordinator's issue instead of the generic "not implemented".
 */

import type { SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { SessionSpec } from '../../host.js'
import { createMemoryDriverSlots } from '../../testing/index.js'
import type { AskUserGate } from '../ask-user-gate.js'
import {
  createGrokAcpRuntime,
  type GrokAcpJournalEntry,
  type GrokAcpRuntimeHost,
} from './runtime.js'
import { type FakeGrokAcpServer, startFakeGrokAcpServer } from './test-support/fake-acp-server.js'

const spec = (): SessionSpec => ({
  harness: 'grok',
  selection: {
    auth: 'subscription',
    platform: 'linux',
    available: ['grok-acp'],
    preference: 'grok-acp',
  },
  workdir: '/tmp/grok-ask-user',
  model: {},
  instructions: { supported: false, reason: 'fixture' },
  mcpServers: { supported: false, reason: 'fixture' },
})

function world(askUserGate?: AskUserGate) {
  let seq = 0
  const servers = new Map<SessionId, FakeGrokAcpServer>()
  const entries = new Map<SessionId, GrokAcpJournalEntry>()
  const host: GrokAcpRuntimeHost = {
    ...(askUserGate ? { askUserGate } : {}),
    bindings: {
      recorded: (id) => entries.get(id),
      bound: (entry) => entries.set(entry.sessionId, entry),
      released: (id) => {
        entries.delete(id)
      },
    },
    now: () => Date.UTC(2026, 9, 14) + ++seq * 1000,
    mintSessionId: () => `gk-ask-${++seq}` as SessionId,
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
  return { host, serverFor: (sessionId: SessionId) => servers.get(sessionId) }
}

async function refusalFor(
  askUserGate?: AskUserGate,
): Promise<{ code: number; message: string } | undefined> {
  const w = world(askUserGate)
  const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
  try {
    const handle = await runtime.driver.create(spec())
    const server = w.serverFor(handle.binding.sessionId)!
    const id = server.askUserQuestion()
    await expect.poll(() => server.errors.has(id), { timeout: 2000 }).toBe(true)
    return server.errors.get(id)
  } finally {
    runtime.dispose()
  }
}

describe('Grok ask_user_question under the seat rule', () => {
  it('a session below a coordinator is refused with the coordinator to ask', async () => {
    const seen: SessionId[] = []
    const error = await refusalFor(async (sessionId) => {
      seen.push(sessionId)
      return 'Asking the user is not available: ask POD-7 with podium issue mail send POD-7'
    })
    expect(seen).toHaveLength(1)
    expect(error).toEqual({
      code: -32000,
      message: 'Asking the user is not available: ask POD-7 with podium issue mail send POD-7',
    })
  })

  it('a session that may talk to the user still gets the generic refusal', async () => {
    const error = await refusalFor(async () => null)
    expect(error?.message).toBe("Podium does not implement '_x.ai/ask_user_question'")
  })
})
