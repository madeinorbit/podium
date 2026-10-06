import { DraftStore } from '@podium/client-core/conversation'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { autorun, observable, runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { insideReader, measureWork } from '../../../../tests/worklist/harness/src/work-meter'
import { MobileConversation } from './mobile-conversation'

const draftsForProbe = () => new DraftStore({ storage: { get: () => null, set: () => {} },
  hub: { on: () => () => {}, sendDraftEdit: () => true, connectionHealth: () => ({ status: 'ok', rttMs: null, since: 0 }) } })

it('bounds the canonical phone producer, observed rows and open Find at 1x/4x history', async () => {
  const item = (at: number): TranscriptItem => ({ id: `item-${at}`, role: at % 4 === 0 ? 'user' : 'assistant',
    cursor: Buffer.from(JSON.stringify(['file', at, `item-${at}`, 0])).toString('base64url'), text: `Message ${at}` })
  const samples = []
  for (const scale of [1, 4]) {
    const items = Array.from({ length: 512 * scale }, (_, at) => item(at))
    items[items.length - 1] = { ...items.at(-1)!, text: 'unique needle' }
    let page = { items, head: items[0]!.cursor, hasMore: true }
    const drafts = draftsForProbe()
    const conversation = new MobileConversation({ sessionId: asSessionId('phone-probe'), drafts,
      transcript: { source: { read: async () => page, subscribe: () => () => {} }, retainHistory: () => true,
        cache: { maxItems: 200, read: () => undefined, write: () => {} } },
      sends: { createDeliveryId: () => 'delivery', deliver: async () => ({ state: 'sent' as const }) },
    })
    await conversation.start()
    const phone = conversation.presentation, log = conversation.transcript
    const query = observable.box('needle'), cursor = observable.box(0)
    const stop = autorun(() => {
      phone.keys.slice(-80).forEach(key => { phone.row(key)?.item.text })
      phone.search(query.get(), cursor.get()); phone.latestAssistantKey
    })
    const count = async (name: string, change: () => unknown) =>
      (await measureWork(async () => insideReader(name, change), { trace: true })).work
    try {
      const stream = await count('retainedPhone.stream', () => log.merge([{ ...items.at(-1)!, text: 'unique needle streamed' }]))
      const incoming = await count('retainedPhone.incoming', () => log.merge([item(items.length)]))
      page = { items: [item(-2), item(-1), items[0]!], head: item(-2).cursor, hasMore: false }
      const older = await count('retainedPhone.older', () => log.loadOlder())
      const search = await count('retainedPhone.search', () => runInAction(() => query.set('needle streamed')))
      const move = await count('retainedPhone.cursor', () => runInAction(() => cursor.set(1)))
      expect(phone.search(query.get(), cursor.get()).total).toBe(1)
      expect(phone.row(items.at(-1)!.id)?.item.text).toBe('unique needle streamed')
      samples.push({ scale, history: items.length, stream, incoming, older, search, cursor: move })
    } finally { stop(); conversation.dispose(); drafts.dispose() }
  }
  console.log('[transcript-retained-phone-work]', JSON.stringify(samples))
  for (const name of ['stream', 'incoming', 'older', 'search', 'cursor'] as const) {
    expect(samples[1]![name].elements).toBeLessThanOrEqual(samples[0]![name].elements + 20)
    expect(samples[1]![name].visits).toBeLessThanOrEqual(samples[0]![name].visits + 40)
  }
})

it('bounds collapsed phone tool rows through result streams and prefix rekeys at 1x/4x children', async () => {
  const call = (at: number): TranscriptItem => ({ id: `call-${at}`, role: 'tool', text: '', toolName: 'Read',
    toolUseId: `use-${at}`, toolInput: `/file-${at}`, durationMs: 10,
    cursor: Buffer.from(JSON.stringify(['file', at, `call-${at}`, 0])).toString('base64url') })
  const samples = []
  for (const scale of [1, 4]) {
    const items = Array.from({ length: 128 * scale }, (_, at) => call(at))
    let page = { items, head: items[0]!.cursor, hasMore: true }
    const drafts = draftsForProbe()
    const conversation = new MobileConversation({ sessionId: asSessionId('phone-tool-probe'), drafts,
      transcript: { source: { read: async () => page, subscribe: () => () => {} }, retainHistory: () => true },
      sends: { createDeliveryId: () => 'delivery', deliver: async () => ({ state: 'sent' as const }) },
    })
    await conversation.start()
    const phone = conversation.presentation, log = conversation.transcript
    const stop = autorun(() => {
      const row = phone.row(phone.keys[0]!)
      row?.run?.title; row?.run?.durationMs; row?.run?.failures
    })
    try {
      const result: TranscriptItem = { id: 'result', role: 'tool', text: '', toolUseId: items.at(-1)!.toolUseId, toolResult: 'progress' }
      log.merge([result])
      const count = async (name: string, change: () => unknown) =>
        (await measureWork(async () => insideReader(name, change), { trace: true })).work
      const stream = await count('phoneTool.stream', () => log.merge([{ ...result, toolResult: 'complete' }]))
      const incoming = await count('phoneTool.incoming', () => log.merge([call(items.length)]))
      page = { items: [call(-1)], head: call(-1).cursor, hasMore: false }
      const older = await count('phoneTool.older', () => log.loadOlder())
      expect(phone.row('call--1')?.run?.durationMs).toBe((items.length + 2) * 10)
      expect(phone.positionOfKey(items.at(-1)!.id)).toBe(0)
      samples.push({ scale, children: items.length, stream, incoming, older })
    } finally { stop(); conversation.dispose(); drafts.dispose() }
  }
  console.log('[transcript-retained-phone-tool-work]', JSON.stringify(samples))
  for (const name of ['stream', 'incoming', 'older'] as const) {
    expect(samples[1]![name].elements).toBeLessThanOrEqual(samples[0]![name].elements + 20)
    expect(samples[1]![name].visits).toBeLessThanOrEqual(samples[0]![name].visits + 40)
  }
})
