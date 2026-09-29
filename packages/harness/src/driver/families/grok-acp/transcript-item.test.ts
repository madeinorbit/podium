/**
 * THE CONFIRMATION NAMES THE HISTORY ENTRY (POD-4774).
 *
 * Grok records a live prompt by echoing it as a `user_message_chunk` under
 * its provider event id. The driver builds the prompt's transcript item from
 * that echo and reports its id on the accepted receipt — and on a durable
 * row's delivered outcome — so the chat matches the message to the entry by
 * id. Where Grok answers without echoing, the driver records the text it sent
 * under its own id and names that: one user item either way, never a guess.
 */

import type { SessionId, TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { RuntimeEvent, SessionSpec } from '../../host.js'
import { createMemoryDriverSlots } from '../../testing/index.js'
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
  workdir: '/tmp/grok-transcript-item',
  model: {},
  instructions: { supported: false, reason: 'fixture' },
  mcpServers: { supported: false, reason: 'fixture' },
})

function world(options: { echoPrompt?: boolean } = {}): {
  host: GrokAcpRuntimeHost
  serverFor(sessionId: SessionId): FakeGrokAcpServer | undefined
} {
  let seq = 0
  const servers = new Map<SessionId, FakeGrokAcpServer>()
  const entries = new Map<SessionId, GrokAcpJournalEntry>()
  return {
    serverFor: (sessionId) => servers.get(sessionId),
    host: {
      bindings: {
        recorded: (id) => entries.get(id),
        bound: (entry) => entries.set(entry.sessionId, entry),
        released: (id) => {
          entries.delete(id)
        },
      },
      now: () => Date.UTC(2026, 7, 20) + ++seq * 1000,
      mintSessionId: () => `gk-item-${++seq}` as SessionId,
      readHistory: async () => ({ items: [], hasMore: false }),
      async launch(input) {
        const server = startFakeGrokAcpServer(`grok-native-${input.sessionId}`, options)
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
    },
  }
}

const userItems = (items: readonly TranscriptItem[]): TranscriptItem[] =>
  items.filter((item) => item.role === 'user')

describe('the history entry a delivered Grok send became', () => {
  it("names the entry built from Grok's own echo of the prompt", async () => {
    const w = world()
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const receipt = await handle.send(
        { id: 't1', text: 'ship it' },
        { origin: 'human', delivery: 'when-ready' },
      )
      expect(receipt).toMatchObject({ outcome: 'accepted', provenBy: 'protocol-ack' })
      if (receipt.outcome !== 'accepted') return
      const server = w.serverFor(handle.binding.sessionId)!
      // The echo's provider event id, not a driver counter.
      expect(receipt.transcriptItem).toEqual({ id: `grok-user-${server.sessionId}-1` })
      server.completeTurn()
      const history = await handle.transcript.history({ limit: 100 })
      // The one user item the chat shows for this prompt is the one named.
      expect(userItems(history.items).map((item) => item.id)).toEqual([receipt.transcriptItem!.id])
    } finally {
      runtime.dispose()
    }
  })

  it('names the text it sent when Grok answers without echoing it', async () => {
    const w = world({ echoPrompt: false })
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const sent = handle.send(
        { id: 't1', text: 'ship it' },
        { origin: 'human', delivery: 'when-ready' },
      )
      // The answer starts: the harness has moved on without recording the prompt.
      await Promise.resolve()
      w.serverFor(handle.binding.sessionId)!.streamAgentText(['on it'])
      const receipt = await sent
      expect(receipt).toMatchObject({
        outcome: 'accepted',
        transcriptItem: { id: 'grok-user-turn-1' },
      })
      w.serverFor(handle.binding.sessionId)!.completeTurn()
      // Recorded once, ahead of the answer it prompted.
      await expect
        .poll(async () =>
          (await handle.transcript.history({ limit: 100 })).items.map((item) => [
            item.role,
            item.id,
          ]),
        )
        .toEqual([
          ['user', 'grok-user-turn-1'],
          ['assistant', expect.any(String)],
        ])
    } finally {
      runtime.dispose()
    }
  })

  it("carries the entry on a durable row's delivered outcome", async () => {
    const w = world()
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const before = await handle.snapshot()
      await handle.send(
        { text: 'durable', rowId: 'msg_row' },
        { origin: 'human', delivery: 'when-ready' },
      )
      const events: RuntimeEvent[] = []
      for await (const event of handle.events(before.cursor)) {
        events.push(event)
        if (event.t === 'delivery') break
      }
      const server = w.serverFor(handle.binding.sessionId)!
      expect(events.find((event) => event.t === 'delivery')).toMatchObject({
        t: 'delivery',
        rowId: 'msg_row',
        outcome: 'delivered',
        transcriptItem: { id: `grok-user-${server.sessionId}-1` },
      })
    } finally {
      runtime.dispose()
    }
  })
})
