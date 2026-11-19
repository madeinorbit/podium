// workspace-scoped (POD-6959)
/**
 * Telegram conversation ↔ directly attached session (POD-6212) — which of the
 * bound user's own sessions a chat (or one forum topic of it) talks to, across
 * restarts. One row per conversation; `threadRef` is `''` for the main chat.
 */

import type { SessionId, UserId } from '@podium/model'
import { eq, sql } from 'drizzle-orm'
import type {
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from './executor/sync-drizzle'
import { inWorkspace, param, prepared, WORKSPACE } from './executor/sync-drizzle'

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

/** The row's own columns: a read hands back no `workspace_id` (POD-6959). */
const attachmentColumns = (t: StoreTables) => ({
  chatId: t.messagingSessionAttachments.chatId,
  threadRef: t.messagingSessionAttachments.threadRef,
  userId: t.messagingSessionAttachments.userId,
  sessionId: t.messagingSessionAttachments.sessionId,
  attachedAt: t.messagingSessionAttachments.attachedAt,
  relayedItemId: t.messagingSessionAttachments.relayedItemId,
})

const attachmentOfConversation = prepared((db, t) =>
  db
    .select(attachmentColumns(t))
    .from(t.messagingSessionAttachments)
    .where(
      inWorkspace(
        t.messagingSessionAttachments,
        eq(
          t.messagingSessionAttachments.chatId,
          param(t.messagingSessionAttachments.chatId, 'chatId'),
        ),
        eq(
          t.messagingSessionAttachments.threadRef,
          param(t.messagingSessionAttachments.threadRef, 'threadRef'),
        ),
      ),
    )
    .prepare(),
)

const attachmentsOfSession = prepared((db, t) =>
  db
    .select(attachmentColumns(t))
    .from(t.messagingSessionAttachments)
    .where(
      inWorkspace(
        t.messagingSessionAttachments,
        eq(
          t.messagingSessionAttachments.sessionId,
          param(t.messagingSessionAttachments.sessionId, 'sessionId'),
        ),
      ),
    )
    .prepare(),
)

const upsertAttachment = prepared((db, t) =>
  db
    .insert(t.messagingSessionAttachments)
    .values({
      workspaceId: WORKSPACE,
      chatId: sql.placeholder('chatId'),
      threadRef: sql.placeholder('threadRef'),
      userId: sql.placeholder('userId'),
      sessionId: sql.placeholder('sessionId'),
      attachedAt: sql.placeholder('attachedAt'),
      relayedItemId: sql.placeholder('relayedItemId'),
    })
    .onConflictDoUpdate({
      target: [
        t.messagingSessionAttachments.workspaceId,
        t.messagingSessionAttachments.chatId,
        t.messagingSessionAttachments.threadRef,
      ],
      set: {
        userId: sql.placeholder('userId'),
        sessionId: sql.placeholder('sessionId'),
        attachedAt: sql.placeholder('attachedAt'),
        relayedItemId: sql.placeholder('relayedItemId'),
      },
    })
    .prepare(),
)

const deleteAttachment = prepared((db, t) =>
  db
    .delete(t.messagingSessionAttachments)
    .where(
      inWorkspace(
        t.messagingSessionAttachments,
        eq(
          t.messagingSessionAttachments.chatId,
          param(t.messagingSessionAttachments.chatId, 'chatId'),
        ),
        eq(
          t.messagingSessionAttachments.threadRef,
          param(t.messagingSessionAttachments.threadRef, 'threadRef'),
        ),
      ),
    )
    .prepare(),
)

/** Guarded by the session id: a relay that finishes after the conversation was
 *  re-attached elsewhere must not stamp its watermark on the new attachment. */
const markRelayed = prepared((db, t) =>
  db
    .update(t.messagingSessionAttachments)
    .set({ relayedItemId: sql.placeholder('relayedItemId') })
    .where(
      inWorkspace(
        t.messagingSessionAttachments,
        eq(
          t.messagingSessionAttachments.chatId,
          param(t.messagingSessionAttachments.chatId, 'chatId'),
        ),
        eq(
          t.messagingSessionAttachments.threadRef,
          param(t.messagingSessionAttachments.threadRef, 'threadRef'),
        ),
        eq(
          t.messagingSessionAttachments.sessionId,
          param(t.messagingSessionAttachments.sessionId, 'sessionId'),
        ),
      ),
    )
    .prepare(),
)

export class MessagingSessionAttachmentsRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** The query builder, resolved on every access [POD-3221 spec rule 34a]. */
  private get db(): WorkspaceDb {
    return this.scope
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
