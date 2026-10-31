import type { ParsedEnvelope } from '@podium/client-core/values'
import { MobxPool } from '@podium/client-graph'
import { here } from '@podium/client-graph/lookup'
import { ingestLedgerMessages } from '@podium/client-graph/message-models'
import { asSessionId, asThreadId, type MessageLedgerWire } from '@podium/model/browser'
import { observable } from 'mobx'
import { expect, it, vi } from 'vitest'
import { ChatViewModel } from './chat-view-model'
import { MailReply } from './mail-reply'

const envelope = (id = 'ask'): ParsedEnvelope => ({
  id,
  from: 'issue:POD-2242',
  to: 'the operator',
  question: true,
  expectsReply: false,
  body: 'Which treatment?',
})
const mailWire = (id = 'ask'): MessageLedgerWire => ({
  id,
  threadId: asThreadId('thread'),
  inReplyTo: null,
  from: 'issue:POD-2242',
  to: 'the operator',
  kind: 'question',
  urgency: 'next-turn',
  lifecycle: 'wait',
  body: 'Which treatment?',
  createdAt: '2026-10-31T12:00:00Z',
  deliveryStatus: 'confirmed',
  ackedBy: null,
  deliveredAt: null,
  deliveredTo: null,
  expiresAt: null,
  clampedFrom: null,
  hop: 0,
})
const receipt = { id: 'reply', ok: true, acked: true }
function fixture() {
  const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null })
  const api = {
    show: vi.fn(async (id: string): Promise<unknown> => mailWire(id)),
    reply: vi.fn(async (_id: string, _body: string): Promise<unknown> => receipt),
  }
  const reply = new MailReply(pool, api)
  reply.start(envelope())
  reply.setDraft('Keep inbox reads separate.')
  return { pool, api, reply }
}

it('uses the existing messages.reply endpoint and keeps the session draft through cancel and send', async () => {
  const { pool } = fixture()
  const drafts = observable.map([[asSessionId('seat'), 'An ordinary prompt with a quote token']])
  pool.bindSessionDrafts({
    get: (id) => drafts.get(id) ?? '',
    set: (id, text) => {
      drafts.set(id, text)
    },
  })
  const show = vi.fn(async ({ id }: { id: string }) => mailWire(id))
  const mutate = vi.fn(async () => receipt)
  const view = new ChatViewModel(
    {
      pool,
      sessionId: asSessionId('seat'),
      runtime: {
        access: {
          trpc: { messages: { show: { query: show }, reply: { mutate } } },
          replica: { row: () => undefined },
        },
      },
    } as never,
    false,
    undefined,
    () => {},
  )
  expect(view.draft).toBe('An ordinary prompt with a quote token')
  view.reply.start(envelope())
  view.setDraft('The answer')
  expect(view.draft).toBe('The answer')
  expect(drafts.get(asSessionId('seat'))).toBe('An ordinary prompt with a quote token')
  view.reply.cancel()
  expect(view.draft).toBe('An ordinary prompt with a quote token')
  view.reply.start(envelope())
  expect(view.draft).toBe('The answer')
  expect(await view.reply.send(view.draft)).toBe(true)
  expect(mutate).toHaveBeenCalledExactlyOnceWith({ id: 'ask', body: 'The answer' })
  expect(view.reply.active).toBe(false)
  expect(view.draft).toBe('An ordinary prompt with a quote token')
  expect(here(pool.model('messageRecord', 'ask'))?.answered).toBe(true)
})

it('preserves the canonical answered fact across a stale ledger read', async () => {
  const { pool, reply } = fixture()
  await reply.load('ask')
  const original = here(pool.model('messageRecord', 'ask'))
  expect(original?.answered).toBe(false)
  await reply.send(reply.draft)
  ingestLedgerMessages(pool, [mailWire()])
  expect(here(pool.model('messageRecord', 'ask'))).toBe(original)
  expect(original?.ackedBy).toBe('reply')
  expect(original?.answered).toBe(true)
})

it('keeps the chosen target and does not consume a newer form after an older send completes', async () => {
  const { reply, api, pool } = fixture()
  let resolve!: (value: unknown) => void
  api.reply.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const first = reply.send(reply.draft)
  for (let turn = 0; turn < 20 && !resolve; turn++) await Promise.resolve()
  expect(resolve, reply.error ?? 'reply endpoint was not called').toBeTypeOf('function')
  expect(await reply.send('duplicate')).toBe(false)
  reply.cancel()
  reply.start(envelope('another'))
  expect(reply.target?.id).toBe('another')
  resolve(receipt)
  expect(await first).toBe(false)
  expect(api.reply).toHaveBeenCalledExactlyOnceWith('ask', 'Keep inbox reads separate.')
  expect(reply.active).toBe(true)
  expect(reply.target?.id).toBe('another')
  expect(reply.error).toBeNull()
  expect(here(pool.model('messageRecord', 'ask'))?.answered).toBe(true)
})

it.each([
  'network',
  'refused',
  'unconfirmed',
])('keeps text and target after a %s send failure', async (failure) => {
  const { reply, api, pool } = fixture()
  if (failure === 'network') api.reply.mockRejectedValueOnce(new Error('connection lost'))
  else
    api.reply.mockResolvedValueOnce({
      ...receipt,
      ...(failure === 'refused'
        ? { ok: false, reason: 'recipient unavailable' }
        : { acked: false }),
    })
  expect(await reply.send(reply.draft)).toBe(false)
  expect(reply.active).toBe(true)
  expect(reply.sending).toBe(false)
  expect(reply.draft).toBe('Keep inbox reads separate.')
  expect(reply.target?.id).toBe('ask')
  expect(reply.error).toBeTruthy()
  expect(here(pool.model('messageRecord', 'ask'))?.answered).toBe(false)
})

it('does not post blank, oversized, denied or mismatched notes', async () => {
  const { reply, api } = fixture()
  expect(await reply.send('  ')).toBe(false)
  expect(await reply.send('x'.repeat(32769))).toBe(false)
  api.show.mockRejectedValueOnce(new Error('not visible'))
  expect(await reply.send('answer')).toBe(false)
  api.show.mockResolvedValueOnce(mailWire('wrong'))
  expect(await reply.send('answer')).toBe(false)
  expect(api.reply).not.toHaveBeenCalled()
  expect(reply.draft).toBe('Keep inbox reads separate.')
})
