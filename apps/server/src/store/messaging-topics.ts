// workspace-scoped (POD-6959)
/**
 * Telegram forum-topic bindings [spec:SP-5d81] — persists issueId ↔ threadRef
 * ↔ superagent thread for the messaging bridge across restarts.
 */

import type { IssueId, ThreadId } from '@podium/model'
import { eq, sql } from 'drizzle-orm'
import type {
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from './executor/sync-drizzle'
import { inWorkspace, param, prepared, WORKSPACE } from './executor/sync-drizzle'

export interface MessagingIssueTopicRow {
  issueId: IssueId
  chatId: string
  threadRef: string
  superagentThreadId: ThreadId
  updatedAt: string
}

// Every query this repository runs, prepared once per store [POD-6147].

/** The row's own columns: a read hands back no `workspace_id` (POD-6959). */
const topicColumns = (t: StoreTables) => ({
  issueId: t.messagingIssueTopics.issueId,
  chatId: t.messagingIssueTopics.chatId,
  threadRef: t.messagingIssueTopics.threadRef,
  superagentThreadId: t.messagingIssueTopics.superagentThreadId,
  updatedAt: t.messagingIssueTopics.updatedAt,
})

const topicsOfChat = prepared((db, t) =>
  db
    .select(topicColumns(t))
    .from(t.messagingIssueTopics)
    .where(
      inWorkspace(
        t.messagingIssueTopics,
        eq(t.messagingIssueTopics.chatId, param(t.messagingIssueTopics.chatId, 'chatId')),
      ),
    )
    .prepare(),
)

const topicOfIssue = prepared((db, t) =>
  db
    .select(topicColumns(t))
    .from(t.messagingIssueTopics)
    .where(
      inWorkspace(
        t.messagingIssueTopics,
        eq(t.messagingIssueTopics.chatId, param(t.messagingIssueTopics.chatId, 'chatId')),
        eq(t.messagingIssueTopics.issueId, param(t.messagingIssueTopics.issueId, 'issueId')),
      ),
    )
    .prepare(),
)

const topicOfThreadRef = prepared((db, t) =>
  db
    .select(topicColumns(t))
    .from(t.messagingIssueTopics)
    .where(
      inWorkspace(
        t.messagingIssueTopics,
        eq(t.messagingIssueTopics.chatId, param(t.messagingIssueTopics.chatId, 'chatId')),
        eq(t.messagingIssueTopics.threadRef, param(t.messagingIssueTopics.threadRef, 'threadRef')),
      ),
    )
    .prepare(),
)

const upsertTopic = prepared((db, t) =>
  db
    .insert(t.messagingIssueTopics)
    .values({
      workspaceId: WORKSPACE,
      issueId: sql.placeholder('issueId'),
      chatId: sql.placeholder('chatId'),
      threadRef: sql.placeholder('threadRef'),
      superagentThreadId: sql.placeholder('superagentThreadId'),
      updatedAt: sql.placeholder('updatedAt'),
    })
    .onConflictDoUpdate({
      target: [t.messagingIssueTopics.issueId, t.messagingIssueTopics.chatId],
      set: {
        threadRef: sql.placeholder('threadRef'),
        superagentThreadId: sql.placeholder('superagentThreadId'),
        updatedAt: sql.placeholder('updatedAt'),
      },
    })
    .prepare(),
)

export class MessagingTopicsRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * The query capability, INJECTED rather than reached for [spec rule 27b], and
   * read through a getter rather than frozen into a field [rule 34a]. Ambient
   * transaction routing (rule 35) has to resolve the ENCLOSING transaction on
   * every access, which a field assigned once in a constructor can never do — so
   * B1 changes the one line inside this getter and no call site below it.
   */
  private get db(): WorkspaceDb {
    return this.scope
  }

  async listForChat(chatId: string): Promise<MessagingIssueTopicRow[]> {
    return await topicsOfChat(this.db).all({ chatId })
  }

  async getByIssue(chatId: string, issueId: IssueId): Promise<MessagingIssueTopicRow | undefined> {
    return await topicOfIssue(this.db).get({ chatId, issueId })
  }

  async getByThreadRef(
    chatId: string,
    threadRef: string,
  ): Promise<MessagingIssueTopicRow | undefined> {
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
