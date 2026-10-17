/**
 * The Telegram session attachments (POD-6212) against the migrated schema: the
 * conversation is the key (main chat and each topic apart), attaching again
 * replaces, and the relay watermark only lands on the attachment it was read for.
 */

import { asSessionId, asUserId } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { expectConstantStatements } from '../test-support/statement-count'
import { syncQueriesOver } from './executor/sync-drizzle'
import {
  type MessagingSessionAttachmentRow,
  MessagingSessionAttachmentsRepository,
} from './messaging-session-attachments'

let attachments: MessagingSessionAttachmentsRepository

const SESSION_A = asSessionId('11111111-1111-4111-8111-111111111111')
const SESSION_B = asSessionId('22222222-2222-4222-8222-222222222222')

const row = (over: Partial<MessagingSessionAttachmentRow> = {}): MessagingSessionAttachmentRow => ({
  chatId: 'chat-a',
  threadRef: '',
  userId: asUserId('usr-ada'),
  sessionId: SESSION_A,
  attachedAt: '2026-10-17T00:00:00.000Z',
  relayedItemId: null,
  ...over,
})

beforeEach(() => {
  attachments = new MessagingSessionAttachmentsRepository(syncQueriesOver(openMigratedTestDatabase()))
})

describe('MessagingSessionAttachmentsRepository', () => {
  it('round-trips every column of an attachment', async () => {
    const stored = row({ relayedItemId: 'item-7' })
    await attachments.upsert(stored)
    expect(await attachments.get('chat-a', '')).toEqual(stored)
  })

  it('keys on the conversation: the main chat and each topic are separate', async () => {
    const main = row()
    const topic = row({ threadRef: '77', sessionId: SESSION_B })
    await attachments.upsert(main)
    await attachments.upsert(topic)

    expect(await attachments.get('chat-a', '')).toEqual(main)
    expect(await attachments.get('chat-a', '77')).toEqual(topic)
    expect(await attachments.get('chat-b', '')).toBeUndefined()
    expect(await attachments.listForSession(SESSION_B)).toEqual([topic])
  })

  it('replaces the attachment when the same conversation attaches again', async () => {
    await attachments.upsert(row({ relayedItemId: 'old' }))
    const again = row({ sessionId: SESSION_B, attachedAt: '2026-10-17T01:00:00.000Z' })
    await attachments.upsert(again)

    expect(await attachments.get('chat-a', '')).toEqual(again)
    expect(await attachments.listForSession(SESSION_A)).toEqual([])
  })

  it('removes one conversation without touching another', async () => {
    await attachments.upsert(row())
    await attachments.upsert(row({ threadRef: '77' }))
    await attachments.remove('chat-a', '')

    expect(await attachments.get('chat-a', '')).toBeUndefined()
    expect(await attachments.listForSession(SESSION_A)).toEqual([row({ threadRef: '77' })])
  })

  it('stamps the relay watermark only on the attachment it was read for', async () => {
    await attachments.upsert(row())
    await attachments.markRelayed('chat-a', '', SESSION_A, 'item-1')
    expect((await attachments.get('chat-a', ''))?.relayedItemId).toBe('item-1')

    // The conversation moved to another session while a relay was in flight.
    await attachments.upsert(row({ sessionId: SESSION_B }))
    await attachments.markRelayed('chat-a', '', SESSION_A, 'item-2')
    expect((await attachments.get('chat-a', ''))?.relayedItemId).toBeNull()
  })

  it('reads a conversation’s and a session’s attachments in constant statements', async () => {
    await expectConstantStatements(
      {
        name: 'messaging session attachment reads',
        setup: async (size) => {
          const db = openMigratedTestDatabase()
          const repo = new MessagingSessionAttachmentsRepository(syncQueriesOver(db))
          for (let i = 0; i < size; i += 1) {
            await repo.upsert(row({ chatId: `chat-${i}`, sessionId: asSessionId(`other-${i}`) }))
          }
          await repo.upsert(row({ chatId: 'mine' }))
          return { db, repo }
        },
        target: (f) => ({ db: f.db }),
        run: async (f) => [await f.repo.get('mine', ''), await f.repo.listForSession(SESSION_A)],
        check: (result) => {
          expect(result).toEqual([row({ chatId: 'mine' }), [row({ chatId: 'mine' })]])
        },
      },
      2,
    )
  })
})
