/**
 * Telegram forum-topic bindings [spec:SP-5d81] — persists issueId ↔ threadRef
 * ↔ superagent thread for the messaging bridge across restarts.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export interface MessagingIssueTopicRow {
  issueId: string
  chatId: string
  threadRef: string
  superagentThreadId: string
  updatedAt: string
}

export class MessagingTopicsRepository {
  constructor(private readonly db: SqlDatabase) {}

  listForChat(chatId: string): MessagingIssueTopicRow[] {
    const rows = this.db
      .prepare(
        `SELECT issue_id, chat_id, thread_ref, superagent_thread_id, updated_at
         FROM messaging_issue_topics WHERE chat_id = ?`,
      )
      .all(chatId) as Record<string, unknown>[]
    return rows.map((r) => this.map(r))
  }

  getByIssue(chatId: string, issueId: string): MessagingIssueTopicRow | undefined {
    const r = this.db
      .prepare(
        `SELECT issue_id, chat_id, thread_ref, superagent_thread_id, updated_at
         FROM messaging_issue_topics WHERE chat_id = ? AND issue_id = ?`,
      )
      .get(chatId, issueId) as Record<string, unknown> | undefined
    return r ? this.map(r) : undefined
  }

  getByThreadRef(chatId: string, threadRef: string): MessagingIssueTopicRow | undefined {
    const r = this.db
      .prepare(
        `SELECT issue_id, chat_id, thread_ref, superagent_thread_id, updated_at
         FROM messaging_issue_topics WHERE chat_id = ? AND thread_ref = ?`,
      )
      .get(chatId, threadRef) as Record<string, unknown> | undefined
    return r ? this.map(r) : undefined
  }

  upsert(row: MessagingIssueTopicRow): void {
    this.db
      .prepare(
        `INSERT INTO messaging_issue_topics
           (issue_id, chat_id, thread_ref, superagent_thread_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (issue_id, chat_id) DO UPDATE SET
           thread_ref = excluded.thread_ref,
           superagent_thread_id = excluded.superagent_thread_id,
           updated_at = excluded.updated_at`,
      )
      .run(row.issueId, row.chatId, row.threadRef, row.superagentThreadId, row.updatedAt)
  }

  private map(r: Record<string, unknown>): MessagingIssueTopicRow {
    return {
      issueId: r.issue_id as string,
      chatId: r.chat_id as string,
      threadRef: r.thread_ref as string,
      superagentThreadId: r.superagent_thread_id as string,
      updatedAt: r.updated_at as string,
    }
  }
}