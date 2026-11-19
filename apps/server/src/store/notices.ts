// workspace-scoped (POD-6959)
/**
 * THE NOTICE INBOX STORE (POD-6881, credential management spec §13).
 *
 * One row per notice, for one person. `open` keeps ONE open notice per
 * (recipient, dedupe key): a second emit of a condition that is still open
 * changes nothing. `resolveByKey` closes every open notice of a key, whoever it
 * is for, and the next emit opens a new row. Every read and mark names the
 * recipient, so one person can never read or mark another's notice through
 * this repository.
 *
 * `notices` is a synced table (record `inboxNotice`): every write runs as one
 * change-log commit (`ChangeLogCommit`, POD-6920), which drains the database's
 * change capture and appends the records the write reached, so the change log
 * and the table commit or roll back together (the superagent thread pattern,
 * POD-6675).
 */

import type { UserId } from '@podium/model'
import { desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { notices } from '../migrations/schema'
import { captureWrite } from '../sync/capture-pg'
import { type ChangeLogCommit, inChangeLogTransaction } from './change-log-commit'
import type {
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  inWorkspace,
  param,
  prepared,
  preparedFamily,
  WORKSPACE,
} from './executor/sync-drizzle'

/** A notice row, without the workspace it belongs to (the repository's own). */
export type NoticeRow = Omit<typeof notices.$inferSelect, 'workspaceId'>

/** A notice to open: everything but the read and resolve marks. */
export type NewNotice = Omit<NoticeRow, 'readAt' | 'resolvedAt' | 'subjectAnchor' | 'body'> & {
  readonly subjectAnchor?: string | null
  readonly body?: string | null
}

/** Runs every write as one change-log commit (POD-6920). */
export type NoticeFeedCapture = ChangeLogCommit

/** Kinds with no condition that could clear them (`isEventNoticeKind`). */
const EVENT_KINDS = ['mention', 'credential-shared']

/** At most this many read event notices are resolved by one cap pass. */
const CAP_BATCH = 500

// Every query this repository runs, prepared once per store [POD-6147].

/** Every column of a notice but its workspace, which a row never carries out. */
const NOTICE_COLUMNS = (t: StoreTables) => ({
  id: t.notices.id,
  recipientUserId: t.notices.recipientUserId,
  kind: t.notices.kind,
  subjectKind: t.notices.subjectKind,
  subjectId: t.notices.subjectId,
  subjectAnchor: t.notices.subjectAnchor,
  title: t.notices.title,
  body: t.notices.body,
  dedupeKey: t.notices.dedupeKey,
  createdAt: t.notices.createdAt,
  readAt: t.notices.readAt,
  resolvedAt: t.notices.resolvedAt,
})

const recipientIs = (t: StoreTables) =>
  eq(t.notices.recipientUserId, param(t.notices.recipientUserId, 'recipient'))

/** Open notices by id: what the `inboxNotice` record builder reads. */
const openOfIds = preparedFamily((db, t, size: number) =>
  db
    .select(NOTICE_COLUMNS(t))
    .from(t.notices)
    .where(inWorkspace(t.notices, inListOf(t.notices.id, size, 'ids'), isNull(t.notices.resolvedAt)))
    .prepare(),
)

/** Every open notice, in id order: the record builder's full stream. A seek on
 *  `idx_notices_open` (resolved_at, id) reads only the open rows, already in id
 *  order, however long the resolved history. */
const allOpen = prepared((db, t) =>
  db
    .select(NOTICE_COLUMNS(t))
    .from(t.notices)
    .where(inWorkspace(t.notices, isNull(t.notices.resolvedAt)))
    .orderBy(t.notices.id)
    .prepare(),
)

const insertNotice = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.notices)
      .values({
        workspaceId: WORKSPACE,
        id: sql.placeholder('id'),
        recipientUserId: sql.placeholder('recipient'),
        kind: sql.placeholder('kind'),
        subjectKind: sql.placeholder('subjectKind'),
        subjectId: sql.placeholder('subjectId'),
        subjectAnchor: sql.placeholder('subjectAnchor'),
        title: sql.placeholder('title'),
        body: sql.placeholder('body'),
        dedupeKey: sql.placeholder('dedupeKey'),
        createdAt: sql.placeholder('createdAt'),
      })
      // The one unique constraint that can fire is the open-dedupe index.
      .onConflictDoNothing()
      .returning(NOTICE_COLUMNS(t)),
  ).prepare(),
)

const openNoticeOfKey = prepared((db, t) =>
  db
    .select(NOTICE_COLUMNS(t))
    .from(t.notices)
    .where(
      inWorkspace(
        t.notices,
        eq(t.notices.dedupeKey, param(t.notices.dedupeKey, 'dedupeKey')),
        recipientIs(t),
        isNull(t.notices.resolvedAt),
      ),
    )
    .limit(1)
    .prepare(),
)

const resolveKey = prepared((db, t) =>
  captureWrite(
    db
      .update(t.notices)
      .set({ resolvedAt: sql.placeholder('at') })
      .where(
        inWorkspace(
          t.notices,eq(t.notices.dedupeKey, param(t.notices.dedupeKey, 'dedupeKey')), isNull(t.notices.resolvedAt)),
      )
      .returning(NOTICE_COLUMNS(t)),
  ).prepare(),
)

const openOfRecipient = prepared((db, t) =>
  db
    .select(NOTICE_COLUMNS(t))
    .from(t.notices)
    .where(inWorkspace(t.notices, recipientIs(t), isNull(t.notices.resolvedAt)))
    .orderBy(desc(t.notices.createdAt), desc(t.notices.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

const openOfRecipientBefore = prepared((db, t) =>
  db
    .select(NOTICE_COLUMNS(t))
    .from(t.notices)
    .where(
      inWorkspace(
        t.notices,
        recipientIs(t),
        isNull(t.notices.resolvedAt),
        sql`(${t.notices.createdAt}, ${t.notices.id}) < (${sql.placeholder('beforeAt')}, ${sql.placeholder('beforeId')})`,
      ),
    )
    .orderBy(desc(t.notices.createdAt), desc(t.notices.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

const unreadCount = prepared((db, t) =>
  db
    .select({ n: sql<number>`count(*)` })
    .from(t.notices)
    .where(
      inWorkspace(
        t.notices,
        recipientIs(t),
        isNull(t.notices.resolvedAt),
        isNull(t.notices.readAt),
      ),
    )
    .prepare(),
)

const markOneRead = prepared((db, t) =>
  captureWrite(
    db
      .update(t.notices)
      .set({ readAt: sql.placeholder('at') })
      .where(
        inWorkspace(
          t.notices,
          eq(t.notices.id, param(t.notices.id, 'id')),
          recipientIs(t),
          isNull(t.notices.readAt),
          isNull(t.notices.resolvedAt),
        ),
      )
      .returning(NOTICE_COLUMNS(t)),
  ).prepare(),
)

const markEveryRead = prepared((db, t) =>
  captureWrite(
    db
      .update(t.notices)
      .set({ readAt: sql.placeholder('at') })
      .where(inWorkspace(t.notices, recipientIs(t), isNull(t.notices.resolvedAt), isNull(t.notices.readAt)))
      .returning(NOTICE_COLUMNS(t)),
  ).prepare(),
)

const resolveReadEventsPastCap = prepared((db, t) =>
  captureWrite(
    db
      .update(t.notices)
      .set({ resolvedAt: sql.placeholder('at') })
      .where(
        inWorkspace(
          t.notices,
          inArray(
            t.notices.id,
            db
              .select({ id: t.notices.id })
              .from(t.notices)
              .where(
                inWorkspace(
                  t.notices,
                recipientIs(t),
                isNull(t.notices.resolvedAt),
                isNotNull(t.notices.readAt),
                  inArray(t.notices.kind, EVENT_KINDS),
                ),
              )
              .orderBy(desc(t.notices.createdAt), desc(t.notices.id))
              .limit(CAP_BATCH)
              .offset(sql.placeholder('keep')),
          ),
        ),
      )
      .returning(NOTICE_COLUMNS(t)),
  ).prepare(),
)

export class NoticesRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner
  private feedCapture: NoticeFeedCapture | undefined

  /** One workspace's queries: its notices are that workspace's (POD-6959). */
  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** Resolved on every access so ambient transaction routing applies [POD-3221 rule 34a]. */
  private get db(): WorkspaceDb {
    return this.scope
  }

  /** Install the change-log commit every write runs as (`inboxNotice`). */
  setFeedCapture(capture: NoticeFeedCapture): () => void {
    this.feedCapture = capture
    return () => {
      if (this.feedCapture === capture) this.feedCapture = undefined
    }
  }

  /**
   * THE ONE WRITE FUNNEL: each write is one change-log commit, so the records
   * it reached are appended in its transaction (a savepoint inside an
   * enclosing one). Without a hook (a store-level test) it is a transaction.
   */
  private async write(query: () => Promise<NoticeRow[]>): Promise<NoticeRow[]> {
    return await inChangeLogTransaction(this.feedCapture, this.createOrJoinTransaction, query)
  }

  /** The OPEN notices among `ids` (any recipient): a resolved one is no record. */
  async openByIds(ids: readonly string[]): Promise<NoticeRow[]> {
    const unique = [...new Set(ids)]
    const out: NoticeRow[] = []
    for (let at = 0; at < unique.length; at += 500) {
      const chunk = unique.slice(at, at + 500)
      const size = inListSize(chunk.length)
      out.push(...(await openOfIds(this.db, size).all(inListValues(chunk, size, 'ids'))))
    }
    return out
  }

  /** Every open notice, for the record builder's full stream. */
  async allOpen(): Promise<NoticeRow[]> {
    return await allOpen(this.db).all()
  }

  /**
   * Open a notice, or return the open one with the same recipient and key
   * unchanged (`created: false`).
   */
  async open(n: NewNotice): Promise<{ notice: NoticeRow; created: boolean }> {
    return await this.createOrJoinTransaction(async () => {
      const [inserted] = await this.write(
        async () =>
          await insertNotice(this.db).all({
            id: n.id,
            recipient: n.recipientUserId,
            kind: n.kind,
            subjectKind: n.subjectKind,
            subjectId: n.subjectId,
            subjectAnchor: n.subjectAnchor ?? null,
            title: n.title,
            body: n.body ?? null,
            dedupeKey: n.dedupeKey,
            createdAt: n.createdAt,
          }),
      )
      if (inserted !== undefined) return { notice: inserted, created: true }
      const existing = await openNoticeOfKey(this.db).get({
        dedupeKey: n.dedupeKey,
        recipient: n.recipientUserId,
      })
      if (existing === undefined) {
        throw new Error(`notice ${n.dedupeKey} conflicted but no open notice holds the key`)
      }
      return { notice: existing, created: false }
    })
  }

  /** Resolve every open notice of a key, for every recipient. */
  async resolveByKey(dedupeKey: string, at: string): Promise<NoticeRow[]> {
    return await this.write(async () => await resolveKey(this.db).all({ dedupeKey, at }))
  }

  /** A person's open notices, newest first; `before` is the last row of the previous page. */
  async listOpen(
    recipient: UserId,
    page: { limit: number; before?: { createdAt: string; id: string } },
  ): Promise<NoticeRow[]> {
    if (page.before === undefined) {
      return await openOfRecipient(this.db).all({ recipient, limit: page.limit })
    }
    return await openOfRecipientBefore(this.db).all({
      recipient,
      limit: page.limit,
      beforeAt: page.before.createdAt,
      beforeId: page.before.id,
    })
  }

  /** Open and unread: the number on the tray. */
  async countUnread(recipient: UserId): Promise<number> {
    return (await unreadCount(this.db).get({ recipient }))?.n ?? 0
  }

  /** Mark one of the recipient's open notices read; null when it is not theirs,
   *  not open, or already read. */
  async markRead(recipient: UserId, id: string, at: string): Promise<NoticeRow | null> {
    const [row] = await this.write(
      async () => await markOneRead(this.db).all({ id, recipient, at }),
    )
    return row ?? null
  }

  /** Mark every open unread notice of one person read. */
  async markAllRead(recipient: UserId, at: string): Promise<NoticeRow[]> {
    return await this.write(async () => await markEveryRead(this.db).all({ recipient, at }))
  }

  /** Resolve a person's read event notices beyond the newest `keep`. */
  async resolveReadEventsBeyond(recipient: UserId, keep: number, at: string): Promise<NoticeRow[]> {
    return await this.write(
      async () => await resolveReadEventsPastCap(this.db).all({ recipient, keep, at }),
    )
  }
}
