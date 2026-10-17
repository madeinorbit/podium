/**
 * Telegram conversation ↔ directly attached session (POD-6212) — which of the
 * bound user's own sessions a chat (or one forum topic of it) talks to, across
 * restarts. One row per conversation; `threadRef` is `''` for the main chat.
 */

import type { SessionId, UserId } from '@podium/model'
import { and, eq, sql } from 'drizzle-orm'
import { messagingSessionAttachments } from '../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { param, prepared } from './executor/sync-drizzle'

export interface MessagingSessionAttachmentRow {
  chatId: string
  /** Forum topic id; `''` is the main chat. */
  threadRef: string
  /** The bound user who attached it — the only user it may speak for. */
  userId: UserId
  sessionId: SessionId
  attachedAt: string
  /** Last transcript item relayed into the chat; `null` before the first. */
  relayedItemId: string | null
}

// Every query this repository runs, prepared once per store [POD-6147].

const attachmentOfConversation = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(messagingSessionAttachments)
    .where(
      and(
        eq(messagingSessionAttachments.chatId, param(messagingSessionAttachments.chatId, 'chatId')),
        eq(
          messagingSessionAttachments.threadRef,
          param(messagingSessionAttachments.threadRef, 'threadRef'),
        ),
      ),
    )
    .prepare(),
)

const attachmentsOfSession = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(messagingSessionAttachments)
    .where(
      eq(
        messagingSessionAttachments.sessionId,
        param(messagingSessionAttachments.sessionId, 'sessionId'),
      ),
    )
    .prepare(),
)

const upsertAttachment = prepared((db: StoreDrizzle) =>
  db
    .insert(messagingSessionAttachments)
    .values({
      chatId: sql.placeholder('chatId'),
      threadRef: sql.placeholder('threadRef'),
      userId: sql.placeholder('userId'),
      sessionId: sql.placeholder('sessionId'),
      attachedAt: sql.placeholder('attachedAt'),
      relayedItemId: sql.placeholder('relayedItemId'),
    })
    .onConflictDoUpdate({
      target: [messagingSessionAttachments.chatId, messagingSessionAttachments.threadRef],
      set: {
        userId: sql.placeholder('userId'),
        sessionId: sql.placeholder('sessionId'),
        attachedAt: sql.placeholder('attachedAt'),
        relayedItemId: sql.placeholder('relayedItemId'),
      },
    })
    .prepare(),
)

const deleteAttachment = prepared((db: StoreDrizzle) =>
  db
    .delete(messagingSessionAttachments)
    .where(
      and(
        eq(messagingSessionAttachments.chatId, param(messagingSessionAttachments.chatId, 'chatId')),
        eq(
          messagingSessionAttachments.threadRef,
          param(messagingSessionAttachments.threadRef, 'threadRef'),
        ),
      ),
    )
    .prepare(),
)

/** Guarded by the session id: a relay that finishes after the conversation was
 *  re-attached elsewhere must not stamp its watermark on the new attachment. */
const markRelayed = prepared((db: StoreDrizzle) =>
  db
    .update(messagingSessionAttachments)
    .set({ relayedItemId: sql.placeholder('relayedItemId') })
    .where(
      and(
        eq(messagingSessionAttachments.chatId, param(messagingSessionAttachments.chatId, 'chatId')),
        eq(
          messagingSessionAttachments.threadRef,
          param(messagingSessionAttachments.threadRef, 'threadRef'),
        ),
        eq(
          messagingSessionAttachments.sessionId,
          param(messagingSessionAttachments.sessionId, 'sessionId'),
        ),
      ),
    )
    .prepare(),
)

export class MessagingSessionAttachmentsRepository {
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** The query builder, resolved on every access [POD-3221 spec rule 34a]. */
  private get db(): StoreDrizzle {
    return this.rootDb
  }

  async get(chatId: string, threadRef: string): Promise<MessagingSessionAttachmentRow | undefined> {
    return await attachmentOfConversation(this.db).get({ chatId, threadRef })
  }

  /** Every conversation attached to one session — the relay's fan-out. */
  async listForSession(sessionId: SessionId): Promise<MessagingSessionAttachmentRow[]> {
    return await attachmentsOfSession(this.db).all({ sessionId })
  }

  /** Attach (or re-attach) one conversation. The primary key is the conversation,
   *  so attaching again replaces whatever it was attached to before. */
  async upsert(row: MessagingSessionAttachmentRow): Promise<void> {
    await upsertAttachment(this.db).run({ ...row })
  }

  async remove(chatId: string, threadRef: string): Promise<void> {
    await deleteAttachment(this.db).run({ chatId, threadRef })
  }

  async markRelayed(
    chatId: string,
    threadRef: string,
    sessionId: SessionId,
    relayedItemId: string,
  ): Promise<void> {
    await markRelayed(this.db).run({ chatId, threadRef, sessionId, relayedItemId })
  }
}
