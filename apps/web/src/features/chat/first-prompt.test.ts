import { DraftStore } from '@podium/client-core/conversation'
import type { ClientRuntime } from '@podium/client-core/engine'
import { MobxPool } from '@podium/client-graph'
import { here } from '@podium/client-graph/lookup'
import { ingestMessageRecords } from '@podium/client-graph/message-models'
import { asSessionId, type MessageRecordWire, type TranscriptItem } from '@podium/model'
import { observable, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { createWebConversation } from './use-conversation'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose()
})

function fixture({ headless = false, initialRecords = [] as MessageRecordWire[] } = {}) {
  const id = asSessionId('new-session')
  const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null })
  pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'session',
        id,
        value: {
          sessionId: id,
          agentKind: 'claude-code',
          status: 'starting',
          headless,
          cwd: '/repo',
          archived: false,
          lastActiveAt: '2026-10-29T20:13:00Z',
        } as never,
      },
    ],
  })
  const ids = observable.array<string>([], { deep: false })
  const reader = {
    records: () => ({
      records: ids.flatMap((id) => here(pool.model('messageRecord', id)) ?? []),
      pending: 0,
    }),
  }
  pool.sources.register(['chatHeld', 'chatContextReader'], {
    read: (kind: string) => (kind === 'chatHeld' ? { sends: [] } : reader),
    dispose() {},
  } as never)
  const update = (records: MessageRecordWire[]) =>
    runInAction(() => {
      ingestMessageRecords(pool, records)
      ids.replace(records.map((record) => record.id))
    })
  update(initialRecords)
  const drafts = new DraftStore({
    storage: { get: () => null, set: () => {} },
    hub: {
      on: () => () => {},
      sendDraftEdit: () => {},
      connectionHealth: () => ({ status: 'ok' }),
    } as never,
  })
  const cancel = vi.fn(async () => ({ deliveryStatus: 'cancelled' }))
  const lookup = vi.fn(async () => ({ records: [] }))
  const runtime = {
    drafts,
    access: {
      hub: { subscribeTranscript: () => () => {} },
      trpc: {
        sessions: { transcriptRead: { query: async () => ({ items: [], hasMore: false }) } },
        messages: { cancel: { mutate: cancel }, records: { query: lookup } },
      },
    },
  } as unknown as ClientRuntime<Trpc>
  const conversation = createWebConversation(runtime, pool, id, {
    initialPendingText: 'Review the image',
  })
  const dispose = () => {
    conversation.dispose()
    drafts.dispose()
    pool.dispose()
  }
  cleanups.push(dispose)
  return { conversation, update, cancel, lookup }
}

const prompt = (over: Partial<MessageRecordWire> = {}): MessageRecordWire => ({
  id: 'msg-first-prompt',
  sessionId: asSessionId('new-session'),
  senderUserId: 'owner',
  body: 'Review the image',
  createdAt: '2026-10-29T20:13:00Z',
  status: 'stored',
  initialPrompt: true,
  attachments: [{ id: 'upload-shot', filename: 'shot.png', mediaType: 'image/png', kind: 'image' }],
  ...over,
})

it('hands the first bubble to an existing queued record with its image and real cancel ID', async () => {
  const f = fixture({ initialRecords: [prompt()] })
  await f.conversation.start()
  expect(f.conversation.sends.bubbles).toHaveLength(1)
  const bubble = f.conversation.sends.bubbles[0]
  if (!bubble) throw new Error('Expected the first prompt bubble')
  expect({
    deliveryId: bubble.deliveryId,
    state: bubble.state,
    retractable: bubble.retractable,
    files: bubble.files,
  }).toEqual({
    deliveryId: 'msg-first-prompt',
    state: 'queued',
    retractable: true,
    files: [{ path: 'shot.png', kind: 'image', attachmentId: 'upload-shot' }],
  })
  await f.conversation.sends.retract(bubble.id)
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith({ id: 'msg-first-prompt' })
  expect(f.conversation.sends.bubbles).toMatchObject([{ state: 'retracted', retractable: false }])
  expect(f.conversation.sends.bubbles[0]?.files).toEqual(bubble.files)
})

it('waits for the first record before offering cancel or looking up a synthetic ID', async () => {
  const f = fixture()
  await f.conversation.start()
  expect(f.conversation.sends.bubbles[0]?.retractable).toBe(false)
  expect(f.conversation.sends.interruptMessageId).toBeNull()
  const bubble = f.conversation.sends.bubbles[0]
  if (!bubble) throw new Error('Expected the first prompt placeholder')
  await f.conversation.sends.retract(bubble.id)
  expect(f.cancel).not.toHaveBeenCalled()
  expect(f.lookup).not.toHaveBeenCalled()

  f.update([prompt()])
  expect(f.conversation.sends.bubbles).toHaveLength(1)
  expect(f.conversation.sends.interruptMessageId).toBe('msg-first-prompt')
  expect(f.conversation.sends.bubbles).toMatchObject([
    {
      deliveryId: 'msg-first-prompt',
      retractable: true,
      files: [{ attachmentId: 'upload-shot' }],
    },
  ])
})

it('joins by the first-prompt marker even when another record has the same text', async () => {
  const f = fixture()
  await f.conversation.start()
  f.update([prompt({ id: 'msg-other', initialPrompt: undefined, attachments: [] })])
  expect(f.conversation.sends.bubbles).toHaveLength(2)
  f.update([
    prompt({ id: 'msg-other', initialPrompt: undefined, attachments: [] }),
    prompt({ body: 'Server-normalized prompt' }),
  ])
  expect(f.conversation.sends.bubbles).toHaveLength(2)
  expect(
    f.conversation.sends.bubbles.filter((bubble) => bubble.deliveryId === 'msg-first-prompt'),
  ).toHaveLength(1)
})

it('keeps a bound prompt until its own transcript entry arrives', async () => {
  const f = fixture({ initialRecords: [prompt()] })
  await f.conversation.start()
  const user = (id: string): TranscriptItem => ({
    id,
    cursor: id,
    role: 'user',
    text: 'Different words',
  })
  f.conversation.transcript.merge([user('unrelated')])
  expect(f.conversation.sends.bubbles).toHaveLength(1)
  f.update([
    prompt({ status: 'confirmed', transcriptItem: { id: 'first-entry', cursor: 'first-entry' } }),
  ])
  expect(f.conversation.sends.bubbles).toHaveLength(1)
  f.conversation.transcript.merge([user('first-entry')])
  expect(f.conversation.sends.bubbles).toEqual([])
})

it('keeps an already-confirmed first prompt until the initial transcript read catches up', async () => {
  const f = fixture({
    initialRecords: [
      prompt({ status: 'confirmed', transcriptItem: { id: 'first-entry', cursor: 'c1' } }),
    ],
  })
  await f.conversation.start()
  expect(f.conversation.sends.bubbles).toHaveLength(1)
  f.conversation.transcript.merge([
    { id: 'first-entry', cursor: 'c1', role: 'user', text: 'Recorded prompt' },
  ])
  expect(f.conversation.sends.bubbles).toEqual([])
})

it('retires the optimistic prompt when its cancelled record leaves the feed', async () => {
  const f = fixture({ initialRecords: [prompt()] })
  await f.conversation.start()
  f.update([])
  expect(f.conversation.sends.bubbles).toEqual([])
  expect(f.conversation.sends.pending).toEqual([])
})

it.each([
  false,
  true,
])('settles a recordless argv or headless first prompt on its user echo, headless=%s', async (headless) => {
  const f = fixture({ headless })
  await f.conversation.start()
  f.conversation.transcript.merge([
    { id: 'argv-entry', cursor: 'argv-entry', role: 'user', text: 'Recorded prompt' },
  ])
  expect(f.conversation.sends.bubbles).toEqual([])
})
