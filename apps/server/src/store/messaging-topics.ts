/**
 * Telegram forum-topic bindings [spec:SP-5d81] — persists issueId ↔ threadRef
 * ↔ superagent thread for the messaging bridge across restarts.
 */

import type { IssueId, ThreadId } from '@podium/model'
import { and, eq, sql } from 'drizzle-orm'
import { messagingIssueTopics } from '../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { param, prepared } from './executor/sync-drizzle'

export interface MessagingIssueTopicRow {
  issueId: IssueId
  chatId: string
  threadRef: string
  superagentThreadId: ThreadId
  updatedAt: string
}

// Every query this repository runs, prepared once per store [POD-6147].

const topicsOfChat = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(messagingIssueTopics)
    .where(eq(messagingIssueTopics.chatId, param(messagingIssueTopics.chatId, 'chatId')))
    .prepare(),
)

const topicOfIssue = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(messagingIssueTopics)
    .where(
      and(
        eq(messagingIssueTopics.chatId, param(messagingIssueTopics.chatId, 'chatId')),
        eq(messagingIssueTopics.issueId, param(messagingIssueTopics.issueId, 'issueId')),
      ),
    )
    .prepare(),
)

const topicOfThreadRef = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(messagingIssueTopics)
    .where(
      and(
        eq(messagingIssueTopics.chatId, param(messagingIssueTopics.chatId, 'chatId')),
        eq(messagingIssueTopics.threadRef, param(messagingIssueTopics.threadRef, 'threadRef')),
      ),
    )
    .prepare(),
)

const upsertTopic = prepared((db: StoreDrizzle) =>
  db
    .insert(messagingIssueTopics)
    .values({
      issueId: sql.placeholder('issueId'),
      chatId: sql.placeholder('chatId'),
      threadRef: sql.placeholder('threadRef'),
      superagentThreadId: sql.placeholder('superagentThreadId'),
      updatedAt: sql.placeholder('updatedAt'),
    })
    .onConflictDoUpdate({
      target: [messagingIssueTopics.issueId, messagingIssueTopics.chatId],
      set: {
        threadRef: sql.placeholder('threadRef'),
        superagentThreadId: sql.placeholder('superagentThreadId'),
        updatedAt: sql.placeholder('updatedAt'),
      },
    })
    .prepare(),
)

export class MessagingTopicsRepository {
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * The query capability, INJECTED rather than reached for [spec rule 27b], and
   * read through a getter rather than frozen into a field [rule 34a]. Ambient
   * transaction routing (rule 35) has to resolve the ENCLOSING transaction on
   * every access, which a field assigned once in a constructor can never do — so
   * B1 changes the one line inside this getter and no call site below it.
   */
  private get db(): StoreDrizzle {
    return this.rootDb
  }

  async listForChat(chatId: string): Promise<MessagingIssueTopicRow[]> {
    return await topicsOfChat(this.db).all({ chatId })
  }

  async getByIssue(chatId: string, issueId: IssueId): Promise<MessagingIssueTopicRow | undefined> {
    return await topicOfIssue(this.db).get({ chatId, issueId })
  }

  async getByThreadRef(chatId: string, threadRef: string): Promise<MessagingIssueTopicRow | undefined> {
    return await topicOfThreadRef(this.db).get({ chatId, threadRef })
  }

  async upsert(row: MessagingIssueTopicRow): Promise<void> {
    // A WRITE: `.run()` on an insert. The conflict target is the composite
    // primary key, not `issue_id` alone — one issue has one binding PER CHAT.
    await upsertTopic(this.db).run({
      issueId: row.issueId,
      chatId: row.chatId,
      threadRef: row.threadRef,
      superagentThreadId: row.superagentThreadId,
      updatedAt: row.updatedAt,
    })
  }
}
