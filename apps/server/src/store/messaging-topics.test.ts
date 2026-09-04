/**
 * GOLDEN TESTS FOR THE TELEGRAM TOPIC BINDINGS [POD-3395].
 *
 * The coverage census (POD-3244) measured all four public methods of
 * `MessagingTopicsRepository` as NEVER EXECUTED by any lane — the only
 * repository in this wave with nothing at all behind it. So this file is
 * written FIRST, against the synchronous raw-handle code, and it is the oracle
 * the drizzle conversion has to keep green.
 *
 * It pins BEHAVIOUR, not statements: what the chat scope excludes, which
 * columns the upsert's conflict target keys on, and which columns that conflict
 * overwrites. Those are the three things a conversion can get wrong while every
 * row still looks plausible — an `ON CONFLICT` target moved from
 * `(issue_id, chat_id)` to `(issue_id)` would pass any single-chat test.
 */

import { asIssueId, asThreadId } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { createBunStoreExecutor } from './executor'
import { type MessagingIssueTopicRow, MessagingTopicsRepository } from './messaging-topics'

let topics: MessagingTopicsRepository

const row = (over: Partial<MessagingIssueTopicRow> = {}): MessagingIssueTopicRow => ({
  issueId: asIssueId('iss_11111111-1111-4111-8111-111111111111'),
  chatId: 'chat-a',
  threadRef: 'thread-1',
  superagentThreadId: asThreadId('sa-1'),
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

beforeEach(() => {
  topics = new MessagingTopicsRepository(
    createBunStoreExecutor({ database: openMigratedTestDatabase() }),
  )
})

describe('MessagingTopicsRepository', () => {
  it('round-trips every column of a stored binding', () => {
    const stored = row()
    topics.upsert(stored)

    expect(topics.getByIssue(stored.chatId, stored.issueId)).toEqual(stored)
  })

  it('scopes every read to one chat', () => {
    const inChat = row({ chatId: 'chat-a', threadRef: 'thread-a' })
    const otherChat = row({ chatId: 'chat-b', threadRef: 'thread-b' })
    topics.upsert(inChat)
    topics.upsert(otherChat)

    // Three separate scopings, because a conversion can drop the chat predicate
    // from one read and keep it on the others.
    expect(topics.listForChat('chat-a')).toEqual([inChat])
    expect(topics.getByIssue('chat-b', inChat.issueId)).toEqual(otherChat)
    expect(topics.getByThreadRef('chat-a', 'thread-b')).toBeUndefined()
  })

  it('answers a binding that is not there with undefined rather than throwing', () => {
    expect(topics.getByIssue('chat-a', row().issueId)).toBeUndefined()
    expect(topics.getByThreadRef('chat-a', 'thread-1')).toBeUndefined()
    expect(topics.listForChat('chat-a')).toEqual([])
  })

  it('keys the upsert conflict on the issue AND the chat, not on the issue alone', () => {
    const first = row({ chatId: 'chat-a', threadRef: 'thread-a' })
    const second = row({ chatId: 'chat-b', threadRef: 'thread-b' })
    topics.upsert(first)
    topics.upsert(second)

    // One issue, two chats, TWO rows. A conflict target narrowed to `issue_id`
    // would leave one row here and this is the only assertion that sees it.
    expect(topics.listForChat('chat-a')).toEqual([first])
    expect(topics.listForChat('chat-b')).toEqual([second])
  })

  it('overwrites the thread ref, the superagent thread and the timestamp on conflict', () => {
    const original = row()
    topics.upsert(original)
    const rebound = row({
      threadRef: 'thread-moved',
      superagentThreadId: asThreadId('sa-2'),
      updatedAt: '2026-02-02T00:00:00.000Z',
    })
    topics.upsert(rebound)

    expect(topics.listForChat('chat-a')).toEqual([rebound])
    // The old thread ref is gone, not merely shadowed.
    expect(topics.getByThreadRef('chat-a', 'thread-1')).toBeUndefined()
    expect(topics.getByThreadRef('chat-a', 'thread-moved')).toEqual(rebound)
  })

  it('lists every binding in one chat', () => {
    const one = row({ issueId: asIssueId('iss_11111111-1111-4111-8111-111111111111') })
    const two = row({
      issueId: asIssueId('iss_22222222-2222-4222-8222-222222222222'),
      threadRef: 'thread-2',
    })
    topics.upsert(one)
    topics.upsert(two)

    expect(new Set(topics.listForChat('chat-a').map((r) => r.threadRef))).toEqual(
      new Set(['thread-1', 'thread-2']),
    )
  })
})
