import { asSessionId, type TranscriptItem } from '@podium/model'
import { expect, it } from 'vitest'
import type { ConversationMessage } from './contracts'
import { createSendsFixture } from './model-test-support'
import { conversationBubblePosition, projectConversation } from './projection'

const record = (
  id: string,
  createdAt: string,
  extra: Partial<ConversationMessage> = {},
): ConversationMessage => ({
  id,
  body: id,
  createdAt,
  status: 'unknown',
  ...extra,
})

it('places a restored /compact before the exact newer echo using only server record times', () => {
  const bubbles = projectConversation({
    turns: [],
    records: [
      record('new', '2026-11-13T10:01:00Z', {
        status: 'confirmed',
        transcriptItem: { id: 'echo' },
      }),
      record('old', '2026-11-13T10:00:00Z'),
    ],
    transcriptIds: new Set(['echo']),
    seenOpen: new Set(),
    hidden: new Set(),
  })
  expect(bubbles).toHaveLength(1)
  expect(bubbles[0]).toMatchObject({
    deliveryId: 'old',
    beforeTranscriptId: 'echo',
    state: 'unknown',
  })
  const [bubble] = bubbles
  if (!bubble) throw new Error('Missing unresolved send')
  expect(conversationBubblePosition(bubble, (id) => (id === 'echo' ? 3 : undefined))).toBe(3)
})

it('captures the local transcript anchor and retains it when a skewed phone clock meets the server record', async () => {
  const items: TranscriptItem[] = [
    { id: 'tail', role: 'assistant', text: 'Older answer', ts: '2026-11-14T10:00:00Z' },
  ]
  let notify = () => {}
  let records: ConversationMessage[] = []
  const sends = createSendsFixture({
    sessionId: asSessionId('order'),
    transcript: { getSnapshot: () => ({ items }), subscribe: () => () => {} },
    records: {
      getSnapshot: () => records,
      subscribe: (listener) => {
        notify = listener
        return () => {}
      },
    },
    createDeliveryId: () => 'compact',
    deliver: async () => ({ state: 'sent' }),
    clock: { now: () => 1, setTimeout: () => 0, clearTimeout() {} },
  })
  sends.start()
  try {
    await sends.submit({ text: '/compact' })
    expect(sends.model.bubbles[0]?.afterTranscriptId).toBe('tail')
    records = [record('compact', '2026-11-13T10:00:00Z')]
    notify()
    expect(sends.model.bubbles[0]).toMatchObject({
      afterTranscriptId: 'tail',
      at: 1,
      state: 'unknown',
    })
    const [bubble] = sends.model.bubbles
    if (!bubble) throw new Error('Missing unresolved send')
    expect(conversationBubblePosition(bubble, (id) => (id === 'tail' ? 4 : undefined))).toBe(5)
  } finally {
    sends.dispose()
  }
})

it('keeps an empty-transcript send at the start, and leaves an unresolved anchor at the tail', () => {
  expect(conversationBubblePosition({ afterTranscriptId: null }, () => undefined)).toBe(0)
  expect(
    conversationBubblePosition({ afterTranscriptId: 'not-loaded' }, () => undefined),
  ).toBeUndefined()
})

it('keeps restored placement work flat at 1x/4x transcript history with the twenty-record confirmation window', () => {
  const probes: number[] = []
  for (const scale of [1, 4]) {
    const retained = new Set(Array.from({ length: 128 * scale }, (_, index) => `history-${index}`))
    const records = [record('old', '2026-11-13T10:00:00Z')]
    for (let index = 1; index <= 20; index++) {
      retained.add(`echo-${index}`)
      records.push(
        record(`new-${index}`, new Date(Date.UTC(2026, 10, 13, 10, index)).toISOString(), {
          status: 'confirmed',
          transcriptItem: { id: `echo-${index}` },
        }),
      )
    }
    let count = 0
    const [bubble] = projectConversation({
      turns: [],
      records,
      transcriptIds: {
        has(id) {
          count++
          return retained.has(id)
        },
      },
      seenOpen: new Set(),
      hidden: new Set(),
    })
    expect(bubble?.beforeTranscriptId).toBe('echo-1')
    probes.push(count)
  }
  expect(probes).toEqual([40, 40])
})
