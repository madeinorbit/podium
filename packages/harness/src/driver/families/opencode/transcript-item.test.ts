/**
 * THE CONFIRMATION NAMES THE HISTORY ENTRY (POD-4774).
 *
 * `prompt_async` answers 204 with no body, and opencode publishes the prompt's
 * user message and text part on its event stream. The driver pairs that part
 * with the send by the transcript-echo correlation (whitespace-tolerant, never
 * a substring) and names the part's item — opencode's own part id, which is
 * what history re-reads — as a second `delivered` outcome.
 */

import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { AgentSessionHandle, RuntimeEvent, SessionSpec } from '../../host.js'
import { createMemoryDriverSlots } from '../../testing/index.js'
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

/** Publish the prompt's user message the way opencode does, with the text the
 *  recorder wrote (`text`), which may differ from what was sent by whitespace. */
function recordPrompt(host: OpencodeTestHost, handle: AgentSessionHandle, text?: string): void {
  const server = host.serverFor(handle.binding.sessionId)!
  const opencodeSessionId = handle.binding.resume!.value
  const message = server.session(opencodeSessionId)!.messages.at(-1)! as {
    info: Record<string, unknown>
    parts: Record<string, unknown>[]
  }
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

describe('the history entry a delivered opencode send became', () => {
  it("names a durable row's entry by the part opencode recorded, rewrapped", async () => {
    const host = makeOpencodeTestHost()
    const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const events = collect(handle)
      await handle.send(
        { text: 'look  at\nthis', rowId: 'msg_row' },
        { origin: 'human', delivery: 'when-ready' },
      )
      await expect.poll(() => deliveries(events).length).toBe(1)
      recordPrompt(host, handle, 'look at this')
      await expect.poll(() => deliveries(events).length).toBe(2)
      const [shown] = shownUser(events)
      expect(shown).toBeDefined()
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
          transcriptItem: { id: shownUser(events)[0]!.id, cursor: shownUser(events)[0]!.cursor },
        }),
      ])
    } finally {
      runtime.dispose()
    }
  })

  it('does not name a user part whose text is not the prompt', async () => {
    const host = makeOpencodeTestHost()
    const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec())
      const events = collect(handle)
      await handle.send(
        { id: 'msg_other', text: 'the prompt' },
        { origin: 'human', delivery: 'when-ready' },
      )
      recordPrompt(host, handle, 'the prompt, and something else')
      await expect.poll(() => shownUser(events).length).toBe(1)
      // Give a wrong credit the chance to surface before asserting there is none.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(deliveries(events)).toEqual([])
    } finally {
      runtime.dispose()
    }
  })
})
