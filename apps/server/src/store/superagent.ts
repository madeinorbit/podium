/**
 * Superagent aggregate — owns `superagent_threads` and `superagent_messages`
 * (the 'global' orchestrator thread, per-session 'btw' threads and per-repo
 * 'concierge' intake threads).
 */

import {
  asThreadId,
  firstAdminMemberId,
  type SessionId,
  type ThreadId,
  type UserId,
} from '@podium/model'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import {
  superagentMessages,
  superagentPendingTurns,
  superagentQueuedInputs,
  superagentThreads,
} from '../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { param, placeholdersFor, prepared, preparedFamily, shapeOf } from './executor/sync-drizzle'
import { UsersRepository } from './users'
import { parseJsonColumn } from './helpers'
import type {
  PendingSuperagentTurnRow,
  QueuedSuperagentInputRow,
  SuperagentMessageRow,
  SuperagentThreadRow,
  ToolCallRow,
} from './types'

/** RETAINED EXTERNAL-INPUT/ID-MINT CASTS: legacy thread methods accept string
 * ids and the global thread is minted from a literal. Selected thread/session
 * ids flow from the schema without re-entry casts. */
// Every query this repository runs, prepared once per store [POD-6147].

const P = (name: string) => sql.placeholder(name)
const threadIdIs = () => eq(superagentThreads.id, param(superagentThreads.id, 'id'))

// CONVERTED, and the enumeration is why [POD-3403 rule 31]. `INSERT OR IGNORE`
// suppresses UNIQUE, PRIMARY KEY, NOT NULL and CHECK; `onConflictDoNothing()`
// suppresses the uniqueness conflict alone. So the two agree exactly when no
// NOT NULL and no CHECK violation is reachable at this site, and here neither
// is. Enumerated against the live DDL rather than assumed:
//   NOT NULL columns: id, kind, created_at, updated_at (all supplied
//     non-null above), owner_user_id (supplied; its parameter defaults to
//     firstAdminMemberId()) and archived (not supplied, so its DEFAULT 0
//     applies). Nothing reaching this statement can be null.
//   CHECK constraints: none on this table anywhere in the migration chain.
//   Foreign keys: none — and they would not count anyway, because OR IGNORE
//     throws on a foreign key exactly as the plain form does (measured).
// What is left reachable is the `id` primary-key conflict, which is the whole
// point of the statement and which both forms swallow identically.
const seedGlobal = prepared((db: StoreDrizzle) =>
  db
    .insert(superagentThreads)
    .values({
      id: asThreadId('global'),
      ownerUserId: P('ownerUserId'),
      kind: 'global',
      createdAt: P('now'),
      updatedAt: P('now'),
    })
    .onConflictDoNothing()
    .prepare(),
)

const threadMessages = prepared((db: StoreDrizzle) =>
  db
    .select({
      id: superagentMessages.id,
      ownerUserId: superagentMessages.ownerUserId,
      role: superagentMessages.role,
      content: superagentMessages.content,
      toolCalls: superagentMessages.toolCalls,
      toolCallId: superagentMessages.toolCallId,
      toolName: superagentMessages.toolName,
      createdAt: superagentMessages.createdAt,
    })
    .from(superagentMessages)
    .where(eq(superagentMessages.threadId, param(superagentMessages.threadId, 'threadId')))
    .orderBy(desc(superagentMessages.id))
    .limit(P('limit'))
    .prepare(),
)

const insertMessage = prepared((db: StoreDrizzle) =>
  db
    .insert(superagentMessages)
    .values({
      threadId: P('threadId'),
      ownerUserId: P('ownerUserId'),
      role: P('role'),
      content: P('content'),
      toolCalls: P('toolCalls'),
      toolCallId: P('toolCallId'),
      toolName: P('toolName'),
      createdAt: P('createdAt'),
    })
    .prepare(),
)

const touchThread = prepared((db: StoreDrizzle) =>
  db.update(superagentThreads).set({ updatedAt: P('updatedAt') }).where(threadIdIs()).prepare(),
)

const deleteThreadMessages = prepared((db: StoreDrizzle) =>
  db
    .delete(superagentMessages)
    .where(eq(superagentMessages.threadId, param(superagentMessages.threadId, 'threadId')))
    .prepare(),
)

const openThreadsOf = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(superagentThreads)
    .where(
      and(
        eq(superagentThreads.ownerUserId, param(superagentThreads.ownerUserId, 'ownerUserId')),
        eq(superagentThreads.archived, false),
      ),
    )
    .orderBy(desc(superagentThreads.updatedAt))
    .prepare(),
)

const threadById = prepared((db: StoreDrizzle) =>
  db.select().from(superagentThreads).where(threadIdIs()).prepare(),
)

const ownedThreadById = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(superagentThreads)
    .where(
      and(
        threadIdIs(),
        eq(superagentThreads.ownerUserId, param(superagentThreads.ownerUserId, 'ownerUserId')),
      ),
    )
    .prepare(),
)

const upsertThread = prepared((db: StoreDrizzle) =>
  db
    .insert(superagentThreads)
    .values({
      id: P('id'),
      ownerUserId: P('ownerUserId'),
      kind: P('kind'),
      originSessionId: P('originSessionId'),
      repoPath: P('repoPath'),
      title: P('title'),
      createdAt: P('now'),
      updatedAt: P('now'),
    })
    .onConflictDoUpdate({
      target: superagentThreads.id,
      set: {
        title: sql`COALESCE(excluded.title, ${superagentThreads.title})`,
        // RE-OPENING IS A SIDE EFFECT OF WRITING. `archiveSuperagentThread`
        // hides a thread; this line is the only thing that brings it back.
        archived: false,
        updatedAt: P('now'),
      },
    })
    .prepare(),
)

const setWatermark = prepared((db: StoreDrizzle) =>
  db
    .update(superagentThreads)
    .set({ watermarkItemId: P('itemId'), watermarkTs: P('ts') })
    .where(threadIdIs())
    .prepare(),
)

/** The binding patch writes only the keys it carries, so its key set is the shape. */
const setThreadBinding = preparedFamily((db: StoreDrizzle, shape: string) =>
  db
    .update(superagentThreads)
    .set(placeholdersFor(shape) as unknown as Partial<typeof superagentThreads.$inferInsert>)
    .where(threadIdIs())
    .prepare(),
)

const archiveThread = prepared((db: StoreDrizzle) =>
  db.update(superagentThreads).set({ archived: true }).where(threadIdIs()).prepare(),
)

const insertQueuedInput = prepared((db: StoreDrizzle) =>
  db
    .insert(superagentQueuedInputs)
    .values({
      inputId: P('inputId'),
      ownerUserId: P('ownerUserId'),
      threadId: P('threadId'),
      text: P('text'),
      focusJson: P('focusJson'),
      agentKind: P('agentKind'),
      attachSessionId: P('attachSessionId'),
      createdAt: P('createdAt'),
    })
    .prepare(),
)

const allQueuedInputs = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(superagentQueuedInputs)
    .where(undefined)
    .orderBy(asc(superagentQueuedInputs.createdAt))
    .prepare(),
)

const queuedInputsOfThread = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(superagentQueuedInputs)
    .where(eq(superagentQueuedInputs.threadId, param(superagentQueuedInputs.threadId, 'threadId')))
    .orderBy(asc(superagentQueuedInputs.createdAt))
    .prepare(),
)

const deleteQueuedInputRow = prepared((db: StoreDrizzle) =>
  db
    .delete(superagentQueuedInputs)
    .where(eq(superagentQueuedInputs.inputId, param(superagentQueuedInputs.inputId, 'inputId')))
    .prepare(),
)

const insertPendingTurn = prepared((db: StoreDrizzle) =>
  db
    .insert(superagentPendingTurns)
    .values({
      turnId: P('turnId'),
      ownerUserId: P('ownerUserId'),
      threadId: P('threadId'),
      podiumSessionId: P('podiumSessionId'),
      payloadJson: P('payloadJson'),
      firstTurn: P('firstTurn'),
      createdAt: P('createdAt'),
    })
    .prepare(),
)

const allPendingTurns = prepared((db: StoreDrizzle) =>
  db.select().from(superagentPendingTurns).orderBy(asc(superagentPendingTurns.createdAt)).prepare(),
)

const deletePendingTurnRow = prepared((db: StoreDrizzle) =>
  db
    .delete(superagentPendingTurns)
    .where(eq(superagentPendingTurns.turnId, param(superagentPendingTurns.turnId, 'turnId')))
    .prepare(),
)

export class SuperagentRepository {
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  private readonly users: UsersRepository

  constructor(queries: StoreQueries) {
    this.users = new UsersRepository(queries)
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

  /** Per-boot heal: idempotent seed of the always-there 'global' thread. */
  async seedGlobalThread(ownerUserId?: UserId): Promise<void> {
    ownerUserId ??= await firstAdminMemberId({ users: this.users })
    const saNow = new Date().toISOString()
    // `DO NOTHING` matches `OR IGNORE` here: see `seedGlobal`.
    await seedGlobal(this.db).run({ ownerUserId, now: saNow })
  }

  async loadSuperagentMessages(threadId = 'global', limit = 200): Promise<SuperagentMessageRow[]> {
    const rows = await threadMessages(this.db).all({ threadId: asThreadId(threadId), limit })
    return rows.reverse().map((r) => ({
      id: r.id,
      ownerUserId: r.ownerUserId,
      role: r.role as SuperagentMessageRow['role'],
      content: r.content,
      // A DECISION, not a driver artefact: a corrupt blob quarantines to
      // undefined rather than taking the whole thread down (spec rule 4).
      toolCalls: parseJsonColumn<ToolCallRow[]>(
        r.toolCalls,
        `superagent msg ${String(r.id)} tool_calls`,
      ),
      toolCallId: r.toolCallId ?? undefined,
      toolName: r.toolName ?? undefined,
      createdAt: r.createdAt,
    }))
  }

  async appendSuperagentMessage(
    threadId: ThreadId,
    m: Omit<SuperagentMessageRow, 'id' | 'createdAt' | 'ownerUserId'> & { ownerUserId?: UserId },
  ): Promise<SuperagentMessageRow> {
    const createdAt = new Date().toISOString()
    const ownerUserId = m.ownerUserId ?? (await this.getSuperagentThread(threadId))?.ownerUserId
    if (!ownerUserId) throw new Error(`unknown superagent thread: ${threadId}`)
    const result = await insertMessage(this.db).run({
      threadId,
      ownerUserId,
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : null,
      toolCallId: m.toolCallId ?? null,
      toolName: m.toolName ?? null,
      createdAt,
    })
    await touchThread(this.db).run({ id: threadId, updatedAt: createdAt })
    return { ...m, ownerUserId, id: Number(result.lastInsertRowid), createdAt }
  }

  async clearSuperagentMessages(threadId = 'global'): Promise<void> {
    await deleteThreadMessages(this.db).run({ threadId: asThreadId(threadId) })
  }

  async listSuperagentThreads(ownerUserId: UserId): Promise<SuperagentThreadRow[]> {
    const rows = await openThreadsOf(this.db).all({ ownerUserId })
    return await Promise.all(rows.map(async (r) => await this.mapSuperagentThread(r)))
  }

  async getSuperagentThread(
    id: string,
    ownerUserId?: UserId,
  ): Promise<SuperagentThreadRow | undefined> {
    const r = ownerUserId
      ? await ownedThreadById(this.db).get({ id: asThreadId(id), ownerUserId })
      : await threadById(this.db).get({ id: asThreadId(id) })
    return r ? await this.mapSuperagentThread(r) : undefined
  }

  async upsertSuperagentThread(t: {
    id: string
    ownerUserId: UserId
    kind: 'global' | 'btw' | 'concierge'
    originSessionId?: SessionId
    repoPath?: string
    title?: string
  }): Promise<void> {
    const now = new Date().toISOString()
    await upsertThread(this.db).run({
      // EXTERNAL INPUT BRAND DECODE: this legacy writer accepts the
      // service-facing string id and brands it at the persistence boundary.
      id: asThreadId(t.id),
      ownerUserId: t.ownerUserId,
      kind: t.kind,
      originSessionId: t.originSessionId ?? null,
      repoPath: t.repoPath ?? null,
      title: t.title ?? null,
      now,
    })
  }

  async setThreadWatermark(id: string, itemId: string, ts: string | undefined): Promise<void> {
    await setWatermark(this.db).run({ id: asThreadId(id), itemId, ts: ts ?? null })
  }

  /** Patch the headless-session binding columns on a thread. Only the fields
   *  present in `patch` are written; `terminalSessionId: null` clears the
   *  terminal one-writer lock. */
  async updateSuperagentThreadBinding(
    id: string,
    patch: {
      agentKind?: string
      // null clears the binding — used on a harness switch to force a fresh
      // session on the next turn (#199).
      podiumSessionId?: SessionId | null
      /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
      harnessSessionId?: string | null
      /** A Podium session holding the one-writer terminal lock. */
      terminalSessionId?: SessionId | null
      /** null clears the per-thread override and returns the thread to the
       *  `superagent` settings role (POD-782). */
      model?: string | null
      effort?: string | null
    },
  ): Promise<void> {
    // ONLY THE FIELDS PRESENT IN `patch` ARE WRITTEN, which is what the
    // hand-built SET list did: an absent key leaves the column alone, and an
    // explicit `null` CLEARS it. Building the object the same way keeps that
    // distinction, which a spread of the whole patch would lose.
    const set: Partial<typeof superagentThreads.$inferInsert> = {}
    if (patch.agentKind !== undefined) set.agentKind = patch.agentKind
    if (patch.podiumSessionId !== undefined) set.podiumSessionId = patch.podiumSessionId
    if (patch.harnessSessionId !== undefined) set.harnessSessionId = patch.harnessSessionId
    if (patch.terminalSessionId !== undefined) set.terminalSessionId = patch.terminalSessionId
    if (patch.model !== undefined) set.model = patch.model
    if (patch.effort !== undefined) set.effort = patch.effort
    if (Object.keys(set).length === 0) return
    set.updatedAt = new Date().toISOString()
    await setThreadBinding(this.db, shapeOf(set)).run({ ...set, id: asThreadId(id) })
  }

  async archiveSuperagentThread(id: string): Promise<void> {
    await archiveThread(this.db).run({ id: asThreadId(id) })
  }

  async putQueuedInput(
    row: Omit<QueuedSuperagentInputRow, 'createdAt'>,
  ): Promise<QueuedSuperagentInputRow> {
    const createdAt = new Date().toISOString()
    await insertQueuedInput(this.db).run({
      inputId: row.inputId,
      ownerUserId: row.ownerUserId,
      threadId: row.threadId,
      text: row.text,
      focusJson: row.focus ? JSON.stringify(row.focus) : null,
      agentKind: row.agentKind ?? null,
      attachSessionId: row.attachSessionId ?? null,
      createdAt,
    })
    return { ...row, createdAt }
  }

  /** Queued inputs oldest-first — every thread's, or one thread's. The order is
   *  the delivery order: the pump takes the head and only ever runs one turn per
   *  thread, so a burst of sends reaches the harness in the order it was typed. */
  async listQueuedInputs(threadId?: ThreadId): Promise<QueuedSuperagentInputRow[]> {
    const rows = threadId
      ? await queuedInputsOfThread(this.db).all({ threadId })
      : await allQueuedInputs(this.db).all()
    return rows.map((row) => ({
      inputId: row.inputId,
      ownerUserId: row.ownerUserId,
      threadId: row.threadId,
      text: row.text,
      ...(row.agentKind ? { agentKind: row.agentKind } : {}),
      ...(row.attachSessionId ? { attachSessionId: row.attachSessionId } : {}),
      focus: parseJsonColumn<QueuedSuperagentInputRow['focus']>(
        row.focusJson,
        `queued superagent input ${String(row.inputId)}`,
      ),
      createdAt: row.createdAt,
    }))
  }

  async deleteQueuedInput(inputId: string): Promise<void> {
    await deleteQueuedInputRow(this.db).run({ inputId })
  }

  async putPendingTurn(
    row: Omit<PendingSuperagentTurnRow, 'createdAt'>,
  ): Promise<PendingSuperagentTurnRow> {
    const createdAt = new Date().toISOString()
    await insertPendingTurn(this.db).run({
      turnId: row.turnId,
      ownerUserId: row.ownerUserId,
      threadId: row.threadId,
      podiumSessionId: row.podiumSessionId,
      payloadJson: JSON.stringify(row.payload),
      firstTurn: row.firstTurn,
      createdAt,
    })
    return { ...row, createdAt }
  }

  async promoteQueuedInput(
    inputId: string,
    row: Omit<PendingSuperagentTurnRow, 'createdAt'>,
  ): Promise<PendingSuperagentTurnRow> {
    return await this.createOrJoinTransaction(async () => {
      const pending = await this.putPendingTurn(row)
      await this.deleteQueuedInput(inputId)
      return pending
    })
  }

  async listPendingTurns(): Promise<PendingSuperagentTurnRow[]> {
    const rows = await allPendingTurns(this.db).all()
    return rows.map((row) => {
      const payload = parseJsonColumn<PendingSuperagentTurnRow['payload']>(
        row.payloadJson,
        `pending superagent turn ${row.turnId}`,
      )
      // A DECISION and not a quarantine: a turn with no readable payload cannot
      // be replayed, so it refuses rather than resuming as an empty one.
      if (!payload) throw new Error(`invalid persisted superagent turn payload: ${row.turnId}`)
      return {
        turnId: row.turnId,
        ownerUserId: row.ownerUserId,
        threadId: row.threadId,
        podiumSessionId: row.podiumSessionId,
        payload,
        firstTurn: row.firstTurn,
        createdAt: row.createdAt,
      }
    })
  }

  async deletePendingTurn(turnId: string): Promise<void> {
    await deletePendingTurnRow(this.db).run({ turnId })
  }

  /**
   * The thread row as its readers want it: `null` becomes `undefined`, and
   * nothing else. Every cast this used to carry is gone — the names and the
   * brands come off the schema now.
   */
  private async mapSuperagentThread(
    r: typeof superagentThreads.$inferSelect,
  ): Promise<SuperagentThreadRow> {
    return {
      id: r.id,
      ownerUserId: r.ownerUserId,
      kind: r.kind as 'global' | 'btw' | 'concierge',
      originSessionId: r.originSessionId ?? undefined,
      repoPath: r.repoPath ?? undefined,
      title: r.title ?? undefined,
      watermarkItemId: r.watermarkItemId ?? undefined,
      watermarkTs: r.watermarkTs ?? undefined,
      agentKind: r.agentKind ?? undefined,
      podiumSessionId: r.podiumSessionId ?? undefined,
      harnessSessionId: r.harnessSessionId ?? undefined,
      terminalSessionId: r.terminalSessionId ?? undefined,
      model: r.model ?? undefined,
      effort: r.effort ?? undefined,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      archived: r.archived,
    }
  }
}
