/**
 * THE CONFIRMATION NAMES THE HISTORY ENTRY (POD-4774), BY ID (POD-4813).
 *
 * The send's id is opencode's message id and the text part's id is derived
 * from it, so the driver finds the record by id and never by its text. v1's
 * `prompt_async` answers 204 with no body and publishes the part on its event
 * stream; v2 answers with the admitted input, which names the part at once.
 */

import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { AgentSessionHandle, RuntimeEvent, SessionSpec } from '../../host.js'
import { createMemoryDriverSlots } from '../../testing/index.js'
import { deltaItemIdForPart } from './map.js'
import { createOpencodeRuntime } from './runtime.js'
import { makeOpencodeTestHost, type OpencodeTestHost } from './test-support/host.js'

const spec = (): SessionSpec => ({
  harness: 'opencode',
  selection: { auth: 'api-key', platform: 'linux', available: ['opencode-server'] },
  workdir: '/tmp/transcript-item-test',
  model: {},
  instructions: { supported: false, reason: 'fixture' },
  mcpServers: { supported: false, reason: 'fixture' },
})

type Row = { info: Record<string, unknown>; parts: Record<string, unknown>[] }

function rows(host: OpencodeTestHost, handle: AgentSessionHandle): Row[] {
  const server = host.serverFor(handle.binding.sessionId)!
  return server.session(handle.binding.resume!.value)!.messages as Row[]
}

/** Publish the prompt's user message the way opencode does, from what the
 *  server recorded; `text` is what the recorder wrote, if it differs. */
function recordPrompt(host: OpencodeTestHost, handle: AgentSessionHandle, text?: string): void {
  const server = host.serverFor(handle.binding.sessionId)!
  const opencodeSessionId = handle.binding.resume!.value
  const message = rows(host, handle).at(-1)!
  server.emit('message.updated', { sessionID: opencodeSessionId, info: message.info })
  const part = message.parts[0]!
  server.emit('message.part.updated', {
    sessionID: opencodeSessionId,
    part: text === undefined ? part : { ...part, text },
  })
}

/** Every event the handle publishes, collected as it happens. */
function collect(handle: AgentSessionHandle): RuntimeEvent[] {
  const events: RuntimeEvent[] = []
  void (async () => {
    for await (const event of handle.events('bootstrap')) events.push(event)
  })()
  return events
}

const deliveries = (events: RuntimeEvent[]) =>
  events.flatMap((event) => (event.t === 'delivery' ? [event] : []))
const shownUser = (events: RuntimeEvent[]): TranscriptItem[] =>
  events.flatMap((event) =>
    event.t === 'item' && event.item.kind === 'complete' && event.item.item.role === 'user'
      ? [event.item.item]
      : [],
  )

/** The entry opencode's history holds for a part id, as the driver names it. */
const entryFor = (handle: AgentSessionHandle, partId: string): string =>
  deltaItemIdForPart(handle.binding.resume!.value, partId)

describe('the history entry a delivered opencode send became', () => {
  it("records a durable row under the row's own id and names that entry", async () => {
    const host = makeOpencodeTestHost()
    const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const events = collect(handle)
      await handle.send(
        { id: 'msg_row', rowId: 'msg_row', text: 'look  at\nthis' },
        { origin: 'human', delivery: 'when-ready' },
      )
      await expect.poll(() => deliveries(events).length).toBe(1)
      expect(rows(host, handle).at(-1)).toMatchObject({
        info: { id: 'msg_row' },
        parts: [{ id: 'prt_000000000000row', text: 'look  at\nthis' }],
      })
      // The recorder may rewrite the text; the id still pairs.
      recordPrompt(host, handle, 'look at this')
      await expect.poll(() => deliveries(events).length).toBe(2)
      const [shown] = shownUser(events)
      expect(shown?.id).toBe(entryFor(handle, 'prt_000000000000row'))
      expect(deliveries(events)[1]).toMatchObject({
        rowId: 'msg_row',
        outcome: 'delivered',
        transcriptItem: { id: shown!.id, cursor: shown!.cursor },
      })
    } finally {
      runtime.dispose()
    }
  })

  it("names a direct send's entry under its turn id", async () => {
    const host = makeOpencodeTestHost()
    const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const events = collect(handle)
      const receipt = await handle.send(
        { id: 'msg_direct', text: 'direct' },
        { origin: 'human', delivery: 'when-ready' },
      )
      expect(receipt).toMatchObject({ outcome: 'accepted', provenBy: 'protocol-ack' })
      recordPrompt(host, handle)
      await expect.poll(() => deliveries(events).length).toBe(1)
      expect(deliveries(events)).toEqual([
        expect.objectContaining({
          rowId: 'msg_direct',
          outcome: 'delivered',
          transcriptItem: {
            id: entryFor(handle, 'prt_000000000000direct'),
            cursor: shownUser(events)[0]!.cursor,
          },
        }),
      ])
    } finally {
      runtime.dispose()
    }
  })

  it('does not name a user part of another id, even with the same text', async () => {
    const host = makeOpencodeTestHost()
    const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const events = collect(handle)
      await handle.send(
        { id: 'msg_mine', text: 'the prompt' },
        { origin: 'human', delivery: 'when-ready' },
      )
      const server = host.serverFor(handle.binding.sessionId)!
      const sessionID = handle.binding.resume!.value
      const info = { id: 'msg_theirs', sessionID, role: 'user', time: { created: 1 } }
      server.emit('message.updated', { sessionID, info })
      server.emit('message.part.updated', {
        sessionID,
        part: {
          id: 'prt_theirs',
          sessionID,
          messageID: 'msg_theirs',
          type: 'text',
          text: 'the prompt',
        },
      })
      await expect.poll(() => shownUser(events).length).toBe(1)
      // Give a wrong credit the chance to surface before asserting there is none.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(deliveries(events)).toEqual([])
    } finally {
      runtime.dispose()
    }
  })

  it('records a repeat of the same id once, names the same entry, and stays idle', async () => {
    const host = makeOpencodeTestHost()
    const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const events = collect(handle)
      const server = host.serverFor(handle.binding.sessionId)!
      const sessionID = handle.binding.resume!.value
      const send = (id: string, delivery: 'when-ready' | 'queue' = 'when-ready') =>
        handle.send({ id, text: 'once' }, { origin: 'human', delivery })
      await send('msg_twice')
      recordPrompt(host, handle)
      await expect.poll(() => deliveries(events).length).toBe(1)
      server.goIdle(sessionID)

      // The repeat: opencode re-publishes the record and runs an empty turn.
      const repeat = await send('msg_twice')

      expect(server.promptCount(sessionID)).toBe(2)
      expect(rows(host, handle)).toEqual([
        expect.objectContaining({
          info: expect.objectContaining({ id: 'msg_twice' }),
          parts: [expect.objectContaining({ id: 'prt_000000000000twice', text: 'once' })],
        }),
      ])
      expect(deliveries(events)[0]).toMatchObject({
        transcriptItem: { id: entryFor(handle, 'prt_000000000000twice') },
      })
      expect(repeat).toMatchObject({
        outcome: 'accepted',
        transcriptItem: { id: entryFor(handle, 'prt_000000000000twice') },
      })
      // The empty turn closed before its 204 arrived; nothing may reopen it.
      expect(await send('msg_after', 'queue')).toMatchObject({ outcome: 'accepted' })
    } finally {
      runtime.dispose()
    }
  })

  it('gives a turn id of another shape one stable opencode id', async () => {
    const host = makeOpencodeTestHost()
    const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const server = host.serverFor(handle.binding.sessionId)!
      const sessionID = handle.binding.resume!.value
      const send = () =>
        handle.send({ id: 'turn:7', text: 'again' }, { origin: 'human', delivery: 'when-ready' })
      await send()
      const first = server.lastPrompt(sessionID)?.messageID
      server.goIdle(sessionID)
      expect(await send()).toMatchObject({ outcome: 'accepted' })
      expect(first).toMatch(/^msg_[0-9a-f]{32}$/)
      expect(server.lastPrompt(sessionID)?.messageID).toBe(first)
      expect(rows(host, handle)).toHaveLength(1)
    } finally {
      runtime.dispose()
    }
  })

  it('names the entry an admission reports at once, with no event', async () => {
    const host = makeOpencodeTestHost({
      // What the v2 client answers: the admitted input names its text part.
      wrapClient: (client) => ({
        ...client,
        async prompt(sessionId, body) {
          await client.prompt(sessionId, body)
          return { textPartId: `${body.messageID}:0` }
        },
      }),
    })
    const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const receipt = await handle.send(
        { id: 'msg_admitted', text: 'v2' },
        { origin: 'human', delivery: 'when-ready' },
      )
      expect(receipt).toMatchObject({
        outcome: 'accepted',
        transcriptItem: { id: entryFor(handle, 'msg_admitted:0') },
      })
    } finally {
      runtime.dispose()
    }
  })
})
