/**
 * THE DRIVER AND THE STORE NAME A GROK ITEM THE SAME WAY (POD-7003).
 *
 * A chat-view Grok session's latest page is the Store's read of Grok's
 * `updates.jsonl` with the driver's complete items laid over it, merged by item
 * id (apps/server `mergeLatestTranscriptPage`). An item the two sides name
 * differently is shown twice: the user's prompt and Grok's reply each appeared
 * twice in the chat view (POD-6867 acceptance run, reproduced on dev/mw).
 *
 * Grok's file is not its wire. Measured on grok 1.0.70 (POD-7003 probe) and in
 * the 1.0.44 `session/load` replay (`__fixtures__/live-frames.jsonl`): a reply
 * streams as many `agent_message_chunk` updates, each under its own
 * `_meta.eventId`, and the file keeps ONE record of the whole text under the
 * LAST chunk's eventId and time. The prompt's `user_message_chunk` never comes
 * over the wire; the driver reads it from the file. This test builds the file
 * that way from what the fake server sent, and asks that every item the driver
 * shows, and the entry its receipt names, is one the Store reads.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId, TranscriptItem, TranscriptItemRef } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { grokRecordToItems } from '../../../adapters/grok/transcript.js'
import { readFileItems } from '../../../store/slice.js'
import { streamItemIdOf } from '../../../store/stream-identity.js'
import type { RuntimeEvent, SessionSpec } from '../../host.js'
import {
  testEngineTerms,
  testHarnessContext,
  testSessionTerms,
} from '../../testing/harness-context.js'
import { createMemoryAttachmentStager, createMemoryDriverSlots } from '../../testing/index.js'
import {
  createGrokAcpRuntime,
  type GrokAcpJournalEntry,
  type GrokAcpRuntimeHost,
} from './runtime.js'
import {
  type FakeGrokAcpServer,
  type FakeGrokStoredUpdate,
  startFakeGrokAcpServer,
} from './test-support/fake-acp-server.js'

const spec = (): SessionSpec => ({
  harness: 'grok',
  ...testSessionTerms(),
  harnessContext: testHarnessContext({ kind: 'grok' }),
  selection: {
    auth: 'subscription',
    platform: 'linux',
    available: ['grok-acp'],
    preference: 'grok-acp',
  },
  workdir: '/tmp/grok-store-identity',
  model: {},
  instructions: { supported: false, reason: 'fixture' },
  mcpServers: { supported: false, reason: 'fixture' },
})

type Frame = Record<string, unknown>

function world(): {
  host: GrokAcpRuntimeHost
  serverFor(sessionId: SessionId): FakeGrokAcpServer
  sent(grokSessionId: string): Frame[]
} {
  let seq = 0
  const servers = new Map<SessionId, FakeGrokAcpServer>()
  const entries = new Map<SessionId, GrokAcpJournalEntry>()
  const store = new Map<string, FakeGrokStoredUpdate[]>()
  const frameStore = new Map<string, Frame[]>()
  return {
    serverFor: (sessionId) => {
      const server = servers.get(sessionId)
      if (!server) throw new Error(`no fake Grok server for ${sessionId}`)
      return server
    },
    sent: (grokSessionId) => frameStore.get(grokSessionId) ?? [],
    host: {
      ...testEngineTerms(),
      harnessContextFor: async () => testHarnessContext({ kind: 'grok' }),
      stageAttachment: createMemoryAttachmentStager(),
      bindings: {
        recorded: (id) => entries.get(id),
        bound: (entry) => entries.set(entry.sessionId, entry),
        released: (id) => {
          entries.delete(id)
        },
      },
      now: () => Date.UTC(2026, 10, 17) + ++seq * 1000,
      nativeArchivePollMs: 1,
      mintSessionId: () => `gk-identity-${++seq}` as SessionId,
      readHistory: async () => ({ items: [], hasMore: false }),
      async readNativeUpdates({ grokSessionId, offset }) {
        const bytes = new TextEncoder().encode(
          (frameStore.get(grokSessionId) ?? [])
            .map((frame) => `${JSON.stringify(frame)}\n`)
            .join(''),
        )
        const start = bytes.length < offset ? 0 : offset
        return { offset: start, bytes: bytes.subarray(start) }
      },
      async launch(input) {
        const server = startFakeGrokAcpServer(`grok-native-${input.sessionId}`, {
          store,
          frameStore,
        })
        servers.set(input.sessionId, server)
        return {
          transport: server.transport,
          process: { key: `podium-gk-${input.sessionId}`, pid: 4100 + seq },
          alive: () => server.alive,
          stop: async () => server.crash(),
          kill: async () => server.crash(),
          resources: () => undefined,
        }
      },
    },
  }
}

const updateOf = (frame: Frame): Record<string, unknown> | undefined =>
  ((frame.params as Record<string, unknown> | undefined)?.update as
    | Record<string, unknown>
    | undefined) ?? undefined

/**
 * Grok's `updates.jsonl` for what the server sent: a run of reply chunks is one
 * record of the whole text, under the run's last eventId and time (measured).
 */
function grokFile(frames: readonly Frame[]): string {
  const lines: Frame[] = []
  let run: Frame[] = []
  const flush = (): void => {
    const last = run.at(-1)
    if (!last) return
    const text = run
      .map((frame) => (updateOf(frame)?.content as { text?: string } | undefined)?.text ?? '')
      .join('')
    const params = last.params as Record<string, unknown>
    lines.push({
      ...last,
      params: {
        ...params,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      },
    })
    run = []
  }
  for (const frame of frames) {
    if (updateOf(frame)?.sessionUpdate === 'agent_message_chunk') {
      run.push(frame)
      continue
    }
    flush()
    lines.push(frame)
  }
  flush()
  return lines.map((frame) => `${JSON.stringify(frame)}\n`).join('')
}

async function completeItems(
  handle: { events(after: never): AsyncIterable<RuntimeEvent> },
  cursor: unknown,
  enough: (items: readonly TranscriptItem[]) => boolean,
  ms = 3_000,
): Promise<{ items: TranscriptItem[]; deltaIds: string[] }> {
  const items: TranscriptItem[] = []
  const deltaIds: string[] = []
  const iterator = handle.events(cursor as never)[Symbol.asyncIterator]()
  const deadline = Date.now() + ms
  try {
    while (!enough(items) && Date.now() < deadline) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now())),
      ])
      if (next === null || next.done) break
      const event = next.value
      if (event.t !== 'item') continue
      if (event.item.kind === 'complete') items.push(event.item.item)
      else if (event.item.kind === 'delta') deltaIds.push(event.item.itemId)
    }
  } finally {
    void iterator.return?.()
  }
  return { items, deltaIds }
}

describe('a Grok item has one name, live and on disk (POD-7003)', () => {
  it('names every item the driver shows, and the entry its receipt names, as the Store reads them', async () => {
    const w = world()
    const runtime = createGrokAcpRuntime(w.host, createMemoryDriverSlots())
    const dir = await mkdtemp(join(tmpdir(), 'grok-store-identity-'))
    try {
      const handle = await runtime.driver.create(spec())
      // A chat viewer: the reply also streams as preview fragments.
      const release = await handle.watch('fine')
      const before = await handle.snapshot()
      const named: TranscriptItemRef[] = []
      await handle.send(
        { id: 'msg_same', text: 'run pwd' },
        { origin: 'human', delivery: 'when-ready', onTranscriptItem: (item) => named.push(item) },
      )
      const server = w.serverFor(handle.binding.sessionId)
      server.streamAgentText(['let ', 'me ', 'look'])
      server.toolCall({
        toolCallId: 'call-pwd',
        title: 'run_terminal_command',
        kind: 'execute',
        rawInput: { command: 'pwd' },
      })
      server.toolCallUpdate({
        toolCallId: 'call-pwd',
        status: 'completed',
        rawOutput: { output_for_prompt: '/tmp/grok-store-identity' },
      })
      server.streamAgentText(['it ', 'is ', 'the ', 'fixture '])
      server.completeTurn()

      const shown = await completeItems(
        handle,
        before.cursor,
        (items) => items.filter((item) => item.role === 'assistant').length >= 2,
      )
      await expect.poll(() => named.length).toBe(1)

      const file = join(dir, 'updates.jsonl')
      await writeFile(file, grokFile(w.sent(server.sessionId)))
      const stored = await readFileItems(file, 'grok-store-identity', grokRecordToItems)

      // Both sides hold the same conversation under the same names, so the
      // overlay merge joins each pair. The driver emits the prompt's entry only
      // once it has read it back from the file, so emission order is not file
      // order; the merge orders by time, and identity is what this pins.
      const byId = (items: readonly TranscriptItem[]) =>
        items
          .map((item) => [item.id, item.role, item.text || item.toolResult || item.toolUseId])
          .sort(([a], [b]) => String(a).localeCompare(String(b)))
      expect(stored).toHaveLength(5)
      expect(byId(shown.items)).toEqual(byId(stored))
      // The receipt links the message to the entry the chat shows.
      expect(named.map((item) => item.id)).toEqual([
        stored.find((item) => item.role === 'user')?.id,
      ])
      // The live preview still joins its complete reply.
      const replies = shown.items.filter((item) => item.role === 'assistant')
      expect(shown.deltaIds.length).toBeGreaterThan(0)
      expect([...new Set(shown.deltaIds)]).toEqual(replies.map(streamItemIdOf))
      release()
    } finally {
      runtime.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
