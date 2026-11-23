// The shared MailReply flow is tested in packages/client-graph; this file keeps
// the web chat view model's draft routing through it.
import type { ParsedEnvelope } from '@podium/client-core/values'
import { MobxPool } from '@podium/client-graph'
import { here } from '@podium/client-graph/lookup'
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
        api: { messages: { show: { query: show }, reply: { mutate } } },
        replica: { row: () => undefined },
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

