/**
 * Telegram forum-topic bindings [spec:SP-5d81] — persists issueId ↔ threadRef
 * ↔ superagent thread for the messaging bridge across restarts.
 */

import type { IssueId, ThreadId } from '@podium/model'
import { and, eq } from 'drizzle-orm'
import { messagingIssueTopics } from '../migrations/schema'
import type { QueryClient, StoreExecutor } from './executor'
import type { SyncDrizzle } from './executor/sync-drizzle'

export interface MessagingIssueTopicRow {
  issueId: IssueId
  chatId: string
  threadRef: string
  superagentThreadId: ThreadId
  updatedAt: string
}

export class MessagingTopicsRepository {
  private readonly db: SyncDrizzle

  constructor(executor: StoreExecutor<QueryClient>) {
    // Stage A's synchronous seam, asserted HERE so a store built over a non-bun
    // handle names the repository that needed it rather than failing at the
    // first statement [spec rule 27a].
    if (!executor.stageA) {
      throw new Error("MessagingTopicsRepository needs the executor's Stage A drizzle instance")
    }
    this.db = executor.stageA.db
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
