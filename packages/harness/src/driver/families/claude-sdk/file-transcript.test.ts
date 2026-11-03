// The Claude SDK conversation comes from the session file (POD-6280).
//
// The driver used to build its own copies of a turn's items from the stream:
// tool calls, tool results and the final reply, each under an id of its own.
// Reads served the file's copies, so where the two disagreed the chat kept
// both, and every Claude SDK reply showed twice. These tests pin the one-reader
// contract: the driver publishes the file's items, through one identity gate,
// and a turn closes once the file holds the record it ended with.

import type { SessionId, TranscriptItem } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEvent } from '../../host.js'
import { createMemoryAttachmentStager, createMemoryDriverSlots } from '../../testing/index.js'
import {
  type ClaudeSdkRuntimeHost,
  type ClaudeSdkTurnHandle,
  createClaudeSdkRuntime,
} from './runtime.js'

const SESSION = 'claude-sdk-file' as SessionId
const RESUME = '00000000-0000-4000-8000-0000000000bb'

function spec() {
  return {
    harness: 'claude-code' as const,
    selection: {
      auth: 'subscription' as const,
      platform: 'linux' as const,
      available: ['claude-sdk' as const],
      preference: 'claude-sdk' as const,
    },
    workdir: '/tmp/claude-sdk-file',
    model: {},
    instructions: { supported: false as const, reason: 'fixture' },
    mcpServers: { supported: false as const, reason: 'fixture' },
  }
}

const record = (
  id: string,
  role: TranscriptItem['role'],
  offset: number,
  extra: Partial<TranscriptItem> = {},
): TranscriptItem => ({
  id,
  role,
  text: extra.text ?? '',
  ts: '2026-11-03T12:00:00.000Z',
  cursor: `cursor:${offset}`,
  ...extra,
})

/** A world whose session file is a feed the test appends to. */
function world() {
  const feeds = new Set<(items: readonly TranscriptItem[]) => void>()
  const turns: Array<{ finish(itemId?: string): void; output: string }> = []
  const host: ClaudeSdkRuntimeHost = {
    stageAttachment: createMemoryAttachmentStager(),
    mintSessionId: () => SESSION,
    mintResumeValue: () => RESUME,
    now: () => '2026-11-03T12:00:00.000Z',
    startTurn(): ClaudeSdkTurnHandle {
      let finish!: (itemId?: string) => void
      const done = new Promise<{ resumeValue: string; output: string; itemId?: string }>(
        (resolve) => {
          finish = (itemId) =>
            resolve({ resumeValue: RESUME, output: 'the reply', ...(itemId ? { itemId } : {}) })
        },
      )
      turns.push({ finish: (itemId) => finish(itemId), output: 'the reply' })
      return {
        done,
        accepted: Promise.resolve(),
        interrupt() {},
        answerPermission() {},
        dispose() {},
      }
    },
    async readTranscript() {
      return { items: [], hasMore: false }
    },
    async readArchive() {
      return undefined
    },
    watchTranscript(_input, onItems) {
      feeds.add(onItems)
      return () => feeds.delete(onItems)
    },
  }
  const runtime = createClaudeSdkRuntime(host, createMemoryDriverSlots())
  const append = (...items: TranscriptItem[]) => {
    for (const feed of [...feeds]) feed(items)
  }
  return { runtime, turns, append, feeds }
}

async function collect(
  handle: { events(from: 'bootstrap'): AsyncIterable<RuntimeEvent> },
  sink: RuntimeEvent[],
) {
  for await (const event of handle.events('bootstrap')) sink.push(event)
}

const completes = (events: RuntimeEvent[]) =>
  events.flatMap((event) =>
    event.t === 'item' && event.item.kind === 'complete' ? [event.item.item] : [],
  )

describe('the Claude SDK conversation is the session file', () => {
  it('publishes the file items once each, and a re-marked record replaces its row', async () => {
    const w = world()
    const handle = await w.runtime.createWithId(SESSION, spec())
    const events: RuntimeEvent[] = []
    void collect(handle, events)
    await handle.send({ id: 't1', text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    await vi.waitFor(() => expect(w.feeds.size).toBe(1))
    const call = record('toolu_1', 'tool', 10, { toolName: 'Bash', toolUseId: 'toolu_1' })
    const result = record('rec-2-result-toolu_1', 'tool', 20, {
      toolUseId: 'toolu_1',
      toolResult: 'ok',
    })
    const reply = record('rec-3', 'assistant', 30, { text: 'the reply' })
    w.append(call, result, reply)
    w.append(call, result) // the tail re-delivers: no new rows
    w.append({ ...reply, answer: true }) // the turn-end stamper re-marks the reply
    w.turns[0]!.finish('rec-3')
    await vi.waitFor(() =>
      expect(events.some((e) => e.t === 'turn' && e.ev.ev === 'completed')).toBe(true),
    )
    const items = completes(events)
    expect(items.map((item) => item.id)).toEqual([
      'toolu_1',
      'rec-2-result-toolu_1',
      'rec-3',
      'rec-3',
    ])
    expect(items.at(-1)).toMatchObject({ id: 'rec-3', answer: true })
    // Nothing the driver built: no item for the stream's own output.
    expect(
      items.filter((item) => item.role === 'assistant').every((item) => item.id === 'rec-3'),
    ).toBe(true)
    w.runtime.dispose()
  })

  it('closes a turn only once the file holds the record it ended with', async () => {
    const w = world()
    const handle = await w.runtime.createWithId(SESSION, spec())
    const events: RuntimeEvent[] = []
    void collect(handle, events)
    await handle.send({ id: 't1', text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    await vi.waitFor(() => expect(w.feeds.size).toBe(1))
    w.turns[0]!.finish('rec-final')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(events.some((e) => e.t === 'turn' && e.ev.ev === 'completed')).toBe(false)
    w.append(record('rec-final', 'assistant', 40, { text: 'the reply', answer: true }))
    await vi.waitFor(() =>
      expect(events.some((e) => e.t === 'turn' && e.ev.ev === 'completed')).toBe(true),
    )
    const order = events.flatMap((e) =>
      e.t === 'item' && e.item.kind === 'complete' && e.item.item.id === 'rec-final'
        ? ['record']
        : e.t === 'turn' && e.ev.ev === 'completed'
          ? ['completed']
          : [],
    )
    expect(order).toEqual(['record', 'completed'])
    w.runtime.dispose()
  })

  it('closes a turn whose record never reaches the file after the bound', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const w = world()
      const handle = await w.runtime.createWithId(SESSION, spec())
      const events: RuntimeEvent[] = []
      void collect(handle, events)
      await handle.send({ id: 't1', text: 'go' }, { origin: 'human', delivery: 'when-ready' })
      await vi.waitFor(() => expect(w.feeds.size).toBe(1))
      w.turns[0]!.finish('rec-never')
      await vi.advanceTimersByTimeAsync(3_100)
      await vi.waitFor(() =>
        expect(events.some((e) => e.t === 'turn' && e.ev.ev === 'completed')).toBe(true),
      )
      expect(completes(events).filter((item) => item.role === 'assistant')).toEqual([])
      w.runtime.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops following the file when the session ends', async () => {
    const w = world()
    const handle = await w.runtime.createWithId(SESSION, spec())
    await handle.send({ id: 't1', text: 'go' }, { origin: 'human', delivery: 'when-ready' })
    await vi.waitFor(() => expect(w.feeds.size).toBe(1))
    await handle.stop()
    expect(w.feeds.size).toBe(0)
    w.runtime.dispose()
  })
})
