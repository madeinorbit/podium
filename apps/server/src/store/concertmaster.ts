// workspace-scoped (POD-6959)
/**
 * THE CONCERTMASTER CONVERSATION STORE (POD-7211).
 *
 * One row per entry of a Concertmaster session's curated conversation: a
 * message the agent sent (`say`), one its person sent (`user`) or an ask. An
 * id starts with the entry's time (`concertmasterEntryId`), so the rows of one
 * session read in id order are the conversation in order.
 *
 * `concertmaster_entries` is a synced table (record `concertmasterEntry`):
 * every write runs as one change-log commit (`ChangeLogCommit`, POD-6920),
 * which drains the database's change capture and appends the records the write
 * reached, so the change log and the table commit or roll back together (the
 * notice inbox's pattern, POD-6881).
 *
 * AN ASK'S NUMBER counts per session, from 1, and is allocated inside the
 * write's own transaction: writes of one workspace run one at a time, so the
 * highest number read and the insert that follows cannot interleave with
 * another ask of the same session. The unique index refuses the rest.
 */

import type { MessageRecordAttachment, SessionId, UserId } from '@podium/model'
import { asc, desc, eq, gt, isNotNull, sql } from 'drizzle-orm'
import type { concertmasterEntries } from '../migrations/schema'
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

type StoredEntry = Omit<typeof concertmasterEntries.$inferSelect, 'workspaceId'>

/** An entry as the domain reads it: its JSON lists decoded. */
export interface ConcertmasterEntryRow {
  readonly id: string
  readonly sessionId: SessionId
  readonly kind: string
  readonly body: string
  readonly createdAt: string
  readonly artifacts: readonly string[] | null
  readonly senderUserId: UserId | null
  readonly attachments: readonly MessageRecordAttachment[] | null
  readonly number: number | null
  readonly askKind: string | null
  readonly detail: string | null
  readonly options: readonly string[] | null
  readonly status: string | null
  readonly answer: string | null
  readonly settledAt: string | null
  readonly settledBy: string | null
}

/** Runs every write as one change-log commit (POD-6920). */
export type ConcertmasterFeedCapture = ChangeLogCommit

/** How many entries one listing for the agent reads at most. */
export const CONCERTMASTER_LIST_CEILING = 200

/** A JSON list column as stored; a value that no longer parses reads as none. */
function listOf<T>(raw: string | null): readonly T[] | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : null
  } catch {
    return null
  }
}

const jsonOrNull = (list: readonly unknown[] | null | undefined): string | null =>
  list === null || list === undefined || list.length === 0 ? null : JSON.stringify(list)

function rowOf(stored: StoredEntry): ConcertmasterEntryRow {
  return {
    id: stored.id,
    sessionId: stored.sessionId,
    kind: stored.kind,
    body: stored.body,
    createdAt: stored.createdAt,
    artifacts: listOf<string>(stored.artifactsJson),
    senderUserId: stored.senderUserId,
    attachments: listOf<MessageRecordAttachment>(stored.attachmentsJson),
    number: stored.number,
    askKind: stored.askKind,
    detail: stored.detail,
    options: listOf<string>(stored.optionsJson),
    status: stored.status,
    answer: stored.answer,
    settledAt: stored.settledAt,
    settledBy: stored.settledBy,
  }
}

// Every query this repository runs, prepared once per store [POD-6147].

/** Every column of an entry but its workspace, which a row never carries out. */
const ENTRY_COLUMNS = (t: StoreTables) => ({
  id: t.concertmasterEntries.id,
  sessionId: t.concertmasterEntries.sessionId,
  kind: t.concertmasterEntries.kind,
  body: t.concertmasterEntries.body,
  createdAt: t.concertmasterEntries.createdAt,
  artifactsJson: t.concertmasterEntries.artifactsJson,
  senderUserId: t.concertmasterEntries.senderUserId,
  attachmentsJson: t.concertmasterEntries.attachmentsJson,
  number: t.concertmasterEntries.number,
  askKind: t.concertmasterEntries.askKind,
  detail: t.concertmasterEntries.detail,
  optionsJson: t.concertmasterEntries.optionsJson,
  status: t.concertmasterEntries.status,
  answer: t.concertmasterEntries.answer,
  settledAt: t.concertmasterEntries.settledAt,
  settledBy: t.concertmasterEntries.settledBy,
})

const sessionIs = (t: StoreTables) =>
  eq(t.concertmasterEntries.sessionId, param(t.concertmasterEntries.sessionId, 'sessionId'))

/** Entries by id: what the `concertmasterEntry` record builder reads. */
const entriesOfIds = preparedFamily((db, t, size: number) =>
  db
    .select(ENTRY_COLUMNS(t))
    .from(t.concertmasterEntries)
    .where(inWorkspace(t.concertmasterEntries, inListOf(t.concertmasterEntries.id, size, 'ids')))
    .prepare(),
)

/**
 * One page of every entry in id order: the record builder's full stream walks
 * the primary key a page at a time and never reads the table in one statement.
 * An id is never empty, so the walk starts after `''`.
 */
const entriesAfter = prepared((db, t) =>
  db
    .select(ENTRY_COLUMNS(t))
    .from(t.concertmasterEntries)
    .where(
      inWorkspace(
        t.concertmasterEntries,
        gt(t.concertmasterEntries.id, param(t.concertmasterEntries.id, 'after')),
      ),
    )
    .orderBy(asc(t.concertmasterEntries.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

/** One session's newest entries, newest first: the agent's listing reads a bounded tail. */
const newestOfSession = prepared((db, t) =>
  db
    .select(ENTRY_COLUMNS(t))
    .from(t.concertmasterEntries)
    .where(inWorkspace(t.concertmasterEntries, sessionIs(t)))
    .orderBy(desc(t.concertmasterEntries.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

/** One session's asks by number, highest first: the listing's asks and the next number. */
const asksOfSession = prepared((db, t) =>
  db
    .select(ENTRY_COLUMNS(t))
    .from(t.concertmasterEntries)
    .where(
      inWorkspace(t.concertmasterEntries, sessionIs(t), isNotNull(t.concertmasterEntries.number)),
    )
    // Every row here has a number; the order says so for Postgres, whose
    // descending order would otherwise put a NULL first.
    .orderBy(sql`${t.concertmasterEntries.number} DESC NULLS LAST`)
    .limit(sql.placeholder('limit'))
    .prepare(),
)

const askOfNumber = prepared((db, t) =>
  db
    .select(ENTRY_COLUMNS(t))
    .from(t.concertmasterEntries)
    .where(
      inWorkspace(
        t.concertmasterEntries,
        sessionIs(t),
        eq(t.concertmasterEntries.number, param(t.concertmasterEntries.number, 'number')),
      ),
    )
    .limit(1)
    .prepare(),
)

const entryOfId = prepared((db, t) =>
  db
    .select(ENTRY_COLUMNS(t))
    .from(t.concertmasterEntries)
    .where(
      inWorkspace(
        t.concertmasterEntries,
        eq(t.concertmasterEntries.id, param(t.concertmasterEntries.id, 'id')),
      ),
    )
    .limit(1)
    .prepare(),
)

/** One insert for every kind: a column a kind does not use is NULL. */
const insertEntry = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.concertmasterEntries)
      .values({
        workspaceId: WORKSPACE,
        id: sql.placeholder('id'),
        sessionId: sql.placeholder('sessionId'),
        kind: sql.placeholder('kind'),
        body: sql.placeholder('body'),
        createdAt: sql.placeholder('createdAt'),
        artifactsJson: sql.placeholder('artifactsJson'),
        senderUserId: sql.placeholder('senderUserId'),
        attachmentsJson: sql.placeholder('attachmentsJson'),
        number: sql.placeholder('number'),
        askKind: sql.placeholder('askKind'),
        detail: sql.placeholder('detail'),
        optionsJson: sql.placeholder('optionsJson'),
        status: sql.placeholder('status'),
      })
      // The id is the entry's identity: a `user` entry's is derived from its
      // message, so recording that message again changes nothing.
      .onConflictDoNothing({
        target: [t.concertmasterEntries.workspaceId, t.concertmasterEntries.id],
      })
      .returning(ENTRY_COLUMNS(t)),
  ).prepare(),
)

/** Rewrite an OPEN ask's words. A settled ask keeps what its person answered to. */
const rewriteOpenAsk = prepared((db, t) =>
  captureWrite(
    db
      .update(t.concertmasterEntries)
      .set({
        body: sql.placeholder('body'),
        detail: sql.placeholder('detail'),
        optionsJson: sql.placeholder('optionsJson'),
      })
      .where(
        inWorkspace(
          t.concertmasterEntries,
          eq(t.concertmasterEntries.id, param(t.concertmasterEntries.id, 'id')),
          eq(t.concertmasterEntries.status, 'open'),
        ),
      )
      .returning(ENTRY_COLUMNS(t)),
  ).prepare(),
)

/** Settle an OPEN ask. Guarded on `open`, so of two settles the first wins. */
const settleOpenAsk = prepared((db, t) =>
  captureWrite(
    db
      .update(t.concertmasterEntries)
      .set({
        status: sql.placeholder('status'),
        answer: sql.placeholder('answer'),
        settledAt: sql.placeholder('settledAt'),
        settledBy: sql.placeholder('settledBy'),
      })
      .where(
        inWorkspace(
          t.concertmasterEntries,
          eq(t.concertmasterEntries.id, param(t.concertmasterEntries.id, 'id')),
          eq(t.concertmasterEntries.status, 'open'),
        ),
      )
      .returning(ENTRY_COLUMNS(t)),
  ).prepare(),
)

/** A message the agent sends its person. */
export interface NewConcertmasterSay {
  readonly id: string
  readonly sessionId: SessionId
  readonly body: string
  readonly artifacts?: readonly string[]
  readonly createdAt: string
}

/** A message the person sent, as the agent received it. */
export interface NewConcertmasterUserEntry {
  readonly id: string
  readonly sessionId: SessionId
  readonly body: string
  readonly senderUserId: UserId | null
  readonly attachments?: readonly MessageRecordAttachment[]
  readonly createdAt: string
}

export interface NewConcertmasterAsk {
  readonly id: string
  readonly sessionId: SessionId
  readonly askKind: string
  readonly title: string
  readonly detail?: string
  readonly options?: readonly string[]
  readonly createdAt: string
}

export class ConcertmasterRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner
  private feedCapture: ConcertmasterFeedCapture | undefined

  /** One workspace's queries: its conversations are that workspace's (POD-6959). */
  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** Resolved on every access so ambient transaction routing applies [POD-3221 rule 34a]. */
  private get db(): WorkspaceDb {
    return this.scope
  }

  /** Install the change-log commit every write runs as (`concertmasterEntry`). */
  setFeedCapture(capture: ConcertmasterFeedCapture): () => void {
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
  private async write<T>(query: () => Promise<T>): Promise<T> {
    return await inChangeLogTransaction(this.feedCapture, this.createOrJoinTransaction, query)
  }

  /** The entries among `ids`, for the record builder. */
  async entriesByIds(ids: readonly string[]): Promise<ConcertmasterEntryRow[]> {
    const unique = [...new Set(ids)]
    const out: ConcertmasterEntryRow[] = []
    for (let at = 0; at < unique.length; at += 500) {
      const chunk = unique.slice(at, at + 500)
      const size = inListSize(chunk.length)
      const rows = await entriesOfIds(this.db, size).all(inListValues(chunk, size, 'ids'))
      out.push(...rows.map(rowOf))
    }
    return out
  }

  /** Every entry, a page at a time in id order: the record builder's full stream. */
  async *entryPages(pageSize = 500): AsyncGenerator<ConcertmasterEntryRow[]> {
    let after = ''
    for (;;) {
      const stored = await entriesAfter(this.db).all({ after, limit: pageSize })
      if (stored.length > 0) yield stored.map(rowOf)
      if (stored.length < pageSize) return
      after = stored[stored.length - 1]!.id
    }
  }

  async entry(id: string): Promise<ConcertmasterEntryRow | undefined> {
    const stored = await entryOfId(this.db).get({ id })
    return stored === undefined ? undefined : rowOf(stored)
  }

  /** One session's ask by its number. */
  async ask(sessionId: SessionId, number: number): Promise<ConcertmasterEntryRow | undefined> {
    const stored = await askOfNumber(this.db).get({ sessionId, number })
    return stored === undefined ? undefined : rowOf(stored)
  }

  /** One session's asks, the highest number first, at most `limit`. */
  async asks(sessionId: SessionId, limit: number): Promise<ConcertmasterEntryRow[]> {
    return (await asksOfSession(this.db).all({ sessionId, limit: bounded(limit) })).map(rowOf)
  }

  /** One session's newest entries in conversation order, at most `limit`. */
  async tail(sessionId: SessionId, limit: number): Promise<ConcertmasterEntryRow[]> {
    const newestFirst = await newestOfSession(this.db).all({ sessionId, limit: bounded(limit) })
    return newestFirst.reverse().map(rowOf)
  }

  async addSay(say: NewConcertmasterSay): Promise<ConcertmasterEntryRow> {
    const [stored] = await this.write(
      async () =>
        await insertEntry(this.db).all({
          ...NO_ASK,
          id: say.id,
          sessionId: say.sessionId,
          kind: 'say',
          body: say.body,
          createdAt: say.createdAt,
          artifactsJson: jsonOrNull(say.artifacts),
          senderUserId: null,
          attachmentsJson: null,
        }),
    )
    if (stored === undefined) throw new Error(`concertmaster entry ${say.id} already exists`)
    return rowOf(stored)
  }

  /**
   * Record a message the person sent. `null` when its entry already exists:
   * the id is derived from the message, so a repeat is not a second entry.
   */
  async addUserEntry(entry: NewConcertmasterUserEntry): Promise<ConcertmasterEntryRow | null> {
    const [stored] = await this.write(
      async () =>
        await insertEntry(this.db).all({
          ...NO_ASK,
          id: entry.id,
          sessionId: entry.sessionId,
          kind: 'user',
          body: entry.body,
          createdAt: entry.createdAt,
          artifactsJson: null,
          senderUserId: entry.senderUserId,
          attachmentsJson: jsonOrNull(entry.attachments),
        }),
    )
    return stored === undefined ? null : rowOf(stored)
  }

  /** Open an ask under the session's next number. */
  async addAsk(ask: NewConcertmasterAsk): Promise<ConcertmasterEntryRow> {
    return await this.write(async () => {
      const [highest] = await asksOfSession(this.db).all({ sessionId: ask.sessionId, limit: 1 })
      const [stored] = await insertEntry(this.db).all({
        id: ask.id,
        sessionId: ask.sessionId,
        kind: 'ask',
        body: ask.title,
        createdAt: ask.createdAt,
        artifactsJson: null,
        senderUserId: null,
        attachmentsJson: null,
        number: (highest?.number ?? 0) + 1,
        askKind: ask.askKind,
        detail: ask.detail ?? null,
        optionsJson: jsonOrNull(ask.options),
        status: 'open',
      })
      if (stored === undefined) throw new Error(`concertmaster entry ${ask.id} already exists`)
      return rowOf(stored)
    })
  }

  /** Rewrite an open ask's title, detail and options; `null` when it is not open. */
  async rewriteAsk(
    id: string,
    words: { title: string; detail: string | null; options: readonly string[] | null },
  ): Promise<ConcertmasterEntryRow | null> {
    const [stored] = await this.write(
      async () =>
        await rewriteOpenAsk(this.db).all({
          id,
          body: words.title,
          detail: words.detail,
          optionsJson: jsonOrNull(words.options),
        }),
    )
    return stored === undefined ? null : rowOf(stored)
  }

  /** Settle an open ask; `null` when it is not open (settled already, or no ask). */
  async settleAsk(
    id: string,
    outcome: { status: string; answer: string | null; settledAt: string; settledBy: string },
  ): Promise<ConcertmasterEntryRow | null> {
    const [stored] = await this.write(
      async () => await settleOpenAsk(this.db).all({ id, ...outcome }),
    )
    return stored === undefined ? null : rowOf(stored)
  }
}

/** The ask columns of an entry that is no ask. */
const NO_ASK = {
  number: null,
  askKind: null,
  detail: null,
  optionsJson: null,
  status: null,
} as const

const bounded = (limit: number): number =>
  Math.min(CONCERTMASTER_LIST_CEILING, Math.max(1, Math.trunc(limit)))
