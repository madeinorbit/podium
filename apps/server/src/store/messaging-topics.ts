/**
 * Telegram forum-topic bindings [spec:SP-5d81] — persists issueId ↔ threadRef
 * ↔ superagent thread for the messaging bridge across restarts.
 */

import type { IssueId, ThreadId } from '@podium/model'
import { and, eq } from 'drizzle-orm'
import { messagingIssueTopics } from '../migrations/schema'
import type { StoreQueries, SyncDrizzle, TransactionRunner } from './executor/sync-drizzle'

export interface MessagingIssueTopicRow {
  issueId: IssueId
  chatId: string
  threadRef: string
  superagentThreadId: ThreadId
  updatedAt: string
}

export class MessagingTopicsRepository {
  private readonly rootDb: SyncDrizzle
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
  private get db(): SyncDrizzle {
    return this.rootDb
  }

  listForChat(chatId: string): MessagingIssueTopicRow[] {
    return this.db
      .select()
      .from(messagingIssueTopics)
      .where(eq(messagingIssueTopics.chatId, chatId))
      .all()
  }

  getByIssue(chatId: string, issueId: IssueId): MessagingIssueTopicRow | undefined {
    return this.db
      .select()
      .from(messagingIssueTopics)
      .where(
        and(eq(messagingIssueTopics.chatId, chatId), eq(messagingIssueTopics.issueId, issueId)),
      )
      .get()
  }

  getByThreadRef(chatId: string, threadRef: string): MessagingIssueTopicRow | undefined {
    return this.db
      .select()
      .from(messagingIssueTopics)
      .where(
        and(eq(messagingIssueTopics.chatId, chatId), eq(messagingIssueTopics.threadRef, threadRef)),
      )
      .get()
  }

  upsert(row: MessagingIssueTopicRow): void {
    // A WRITE: `.run()` on an insert. The conflict target is the composite
    // primary key, not `issue_id` alone — one issue has one binding PER CHAT.
    this.db
      .insert(messagingIssueTopics)
      .values(row)
      .onConflictDoUpdate({
        target: [messagingIssueTopics.issueId, messagingIssueTopics.chatId],
        set: {
          threadRef: row.threadRef,
          superagentThreadId: row.superagentThreadId,
          updatedAt: row.updatedAt,
        },
      })
      .run()
  }
}
