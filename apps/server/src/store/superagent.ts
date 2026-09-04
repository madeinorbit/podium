/**
 * Superagent aggregate — owns `superagent_threads` and `superagent_messages`
 * (the 'global' orchestrator thread, per-session 'btw' threads and per-repo
 * 'concierge' intake threads).
 */

import {
  asSessionId,
  asThreadId,
  FIRST_ADMIN_USER_ID,
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
import type { StoreQueries, SyncDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { parseJsonColumn } from './helpers'
import type {
  PendingSuperagentTurnRow,
  QueuedSuperagentInputRow,
  SuperagentMessageRow,
  SuperagentThreadRow,
  ToolCallRow,
} from './types'

export class SuperagentRepository {
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

  /** Per-boot heal: idempotent seed of the always-there 'global' thread. */
  seedGlobalThread(ownerUserId: UserId = FIRST_ADMIN_USER_ID): void {
    const saNow = new Date().toISOString()
    // CONVERTED, and the enumeration is why [POD-3403 rule 31]. `INSERT OR IGNORE`
    // suppresses UNIQUE, PRIMARY KEY, NOT NULL and CHECK; `onConflictDoNothing()`
    // suppresses the uniqueness conflict alone. So the two agree exactly when no
    // NOT NULL and no CHECK violation is reachable at this site, and here neither
    // is. Enumerated against the live DDL rather than assumed:
    //   NOT NULL columns: id, kind, created_at, updated_at (all supplied
    //     non-null above), owner_user_id (supplied; its parameter defaults to
    //     FIRST_ADMIN_USER_ID) and archived (not supplied, so its DEFAULT 0
    //     applies). Nothing reaching this statement can be null.
    //   CHECK constraints: none on this table anywhere in the migration chain.
    //   Foreign keys: none — and they would not count anyway, because OR IGNORE
    //     throws on a foreign key exactly as the plain form does (measured).
    // What is left reachable is the `id` primary-key conflict, which is the whole
    // point of the statement and which both forms swallow identically.
    this.db
      .insert(superagentThreads)
      .values({
        id: asThreadId('global'),
        ownerUserId,
        kind: 'global',
        createdAt: saNow,
        updatedAt: saNow,
      })
      .onConflictDoNothing()
      .run()
  }

  loadSuperagentMessages(threadId = 'global', limit = 200): SuperagentMessageRow[] {
    const rows = this.db
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
      .where(eq(superagentMessages.threadId, asThreadId(threadId)))
      .orderBy(desc(superagentMessages.id))
      .limit(limit)
      .all()
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

  appendSuperagentMessage(
    threadId: ThreadId,
    m: Omit<SuperagentMessageRow, 'id' | 'createdAt' | 'ownerUserId'> & { ownerUserId?: UserId },
  ): SuperagentMessageRow {
    const createdAt = new Date().toISOString()
    const ownerUserId = m.ownerUserId ?? this.getSuperagentThread(threadId)?.ownerUserId
    if (!ownerUserId) throw new Error(`unknown superagent thread: ${threadId}`)
    const result = this.db
      .insert(superagentMessages)
      .values({
        threadId,
        ownerUserId,
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : null,
        toolCallId: m.toolCallId ?? null,
        toolName: m.toolName ?? null,
        createdAt,
      })
      .run()
    this.db
      .update(superagentThreads)
      .set({ updatedAt: createdAt })
      .where(eq(superagentThreads.id, threadId))
      .run()
    return { ...m, ownerUserId, id: Number(result.lastInsertRowid), createdAt }
  }

  clearSuperagentMessages(threadId = 'global'): void {
    this.db
      .delete(superagentMessages)
      .where(eq(superagentMessages.threadId, asThreadId(threadId)))
      .run()
  }

  listSuperagentThreads(ownerUserId: UserId): SuperagentThreadRow[] {
    return this.db
      .select()
      .from(superagentThreads)
      .where(
        and(eq(superagentThreads.ownerUserId, ownerUserId), eq(superagentThreads.archived, false)),
      )
      .orderBy(desc(superagentThreads.updatedAt))
      .all()
      .map((r) => this.mapSuperagentThread(r))
  }

  getSuperagentThread(id: string, ownerUserId?: UserId): SuperagentThreadRow | undefined {
    const r = this.db
      .select()
      .from(superagentThreads)
      .where(
        ownerUserId
          ? and(
              eq(superagentThreads.id, asThreadId(id)),
              eq(superagentThreads.ownerUserId, ownerUserId),
            )
          : eq(superagentThreads.id, asThreadId(id)),
      )
      .get()
    return r ? this.mapSuperagentThread(r) : undefined
  }

  upsertSuperagentThread(t: {
    id: string
    ownerUserId: UserId
    kind: 'global' | 'btw' | 'concierge'
    originSessionId?: SessionId
    repoPath?: string
    title?: string
  }): void {
    const now = new Date().toISOString()
    this.db
      .insert(superagentThreads)
      .values({
        id: asThreadId(t.id),
        ownerUserId: t.ownerUserId,
        kind: t.kind,
        originSessionId: t.originSessionId ?? null,
        repoPath: t.repoPath ?? null,
        title: t.title ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: superagentThreads.id,
        set: {
          title: sql`COALESCE(excluded.title, ${superagentThreads.title})`,
          // RE-OPENING IS A SIDE EFFECT OF WRITING. `archiveSuperagentThread`
          // hides a thread; this line is the only thing that brings it back.
          archived: false,
          updatedAt: now,
        },
      })
      .run()
  }

  setThreadWatermark(id: string, itemId: string, ts: string | undefined): void {
    this.db
      .update(superagentThreads)
      .set({ watermarkItemId: itemId, watermarkTs: ts ?? null })
      .where(eq(superagentThreads.id, asThreadId(id)))
      .run()
  }

  /** Patch the headless-session binding columns on a thread. Only the fields
   *  present in `patch` are written; `terminalSessionId: null` clears the
   *  terminal one-writer lock. */
  updateSuperagentThreadBinding(
    id: string,
    patch: {
      agentKind?: string
      // null clears the binding — used on a harness switch to force a fresh
      // session on the next turn (#199).
      podiumSessionId?: SessionId | null
      /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
      harnessSessionId?: string | null
      /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
      terminalSessionId?: string | null
      /** null clears the per-thread override and returns the thread to the
       *  `superagent` settings role (POD-782). */
      model?: string | null
      effort?: string | null
    },
  ): void {
    // ONLY THE FIELDS PRESENT IN `patch` ARE WRITTEN, which is what the
    // hand-built SET list did: an absent key leaves the column alone, and an
    // explicit `null` CLEARS it. Building the object the same way keeps that
    // distinction, which a spread of the whole patch would lose.
    const set: Partial<typeof superagentThreads.$inferInsert> = {}
    if (patch.agentKind !== undefined) set.agentKind = patch.agentKind
    if (patch.podiumSessionId !== undefined) set.podiumSessionId = patch.podiumSessionId
    if (patch.harnessSessionId !== undefined) set.harnessSessionId = patch.harnessSessionId
    if (patch.terminalSessionId !== undefined) {
      set.terminalSessionId = patch.terminalSessionId as SessionId | null
    }
    if (patch.model !== undefined) set.model = patch.model
    if (patch.effort !== undefined) set.effort = patch.effort
    if (Object.keys(set).length === 0) return
    set.updatedAt = new Date().toISOString()
    this.db
      .update(superagentThreads)
      .set(set)
      .where(eq(superagentThreads.id, asThreadId(id)))
      .run()
  }

  archiveSuperagentThread(id: string): void {
    this.db
      .update(superagentThreads)
      .set({ archived: true })
      .where(eq(superagentThreads.id, asThreadId(id)))
      .run()
  }

  putQueuedInput(row: Omit<QueuedSuperagentInputRow, 'createdAt'>): QueuedSuperagentInputRow {
    const createdAt = new Date().toISOString()
    this.db
      .insert(superagentQueuedInputs)
      .values({
        inputId: row.inputId,
        ownerUserId: row.ownerUserId,
        threadId: row.threadId,
        text: row.text,
        focusJson: row.focus ? JSON.stringify(row.focus) : null,
        agentKind: row.agentKind ?? null,
        attachSessionId: row.attachSessionId ?? null,
        createdAt,
      })
      .run()
    return { ...row, createdAt }
  }

  /** Queued inputs oldest-first — every thread's, or one thread's. The order is
   *  the delivery order: the pump takes the head and only ever runs one turn per
   *  thread, so a burst of sends reaches the harness in the order it was typed. */
  listQueuedInputs(threadId?: ThreadId): QueuedSuperagentInputRow[] {
    const rows = this.db
      .select()
      .from(superagentQueuedInputs)
      .where(threadId ? eq(superagentQueuedInputs.threadId, threadId) : undefined)
      .orderBy(asc(superagentQueuedInputs.createdAt))
      .all()
    return rows.map((row) => ({
      inputId: row.inputId,
      ownerUserId: row.ownerUserId,
      threadId: row.threadId,
      text: row.text,
      ...(row.agentKind ? { agentKind: row.agentKind } : {}),
      // TRUE SERIALIZATION EDGE: a TEXT column this system minted and wrote,
      // and one the schema leaves unbranded, so the re-entry stays named.
      ...(row.attachSessionId ? { attachSessionId: asSessionId(row.attachSessionId) } : {}),
      focus: parseJsonColumn<QueuedSuperagentInputRow['focus']>(
        row.focusJson,
        `queued superagent input ${String(row.inputId)}`,
      ),
      createdAt: row.createdAt,
    }))
  }

  deleteQueuedInput(inputId: string): void {
    this.db.delete(superagentQueuedInputs).where(eq(superagentQueuedInputs.inputId, inputId)).run()
  }

  putPendingTurn(row: Omit<PendingSuperagentTurnRow, 'createdAt'>): PendingSuperagentTurnRow {
    const createdAt = new Date().toISOString()
    this.db
      .insert(superagentPendingTurns)
      .values({
        turnId: row.turnId,
        ownerUserId: row.ownerUserId,
        threadId: row.threadId,
        podiumSessionId: row.podiumSessionId,
        payloadJson: JSON.stringify(row.payload),
        firstTurn: row.firstTurn,
        createdAt,
      })
      .run()
    return { ...row, createdAt }
  }

  promoteQueuedInput(
    inputId: string,
    row: Omit<PendingSuperagentTurnRow, 'createdAt'>,
  ): PendingSuperagentTurnRow {
    return this.createOrJoinTransaction(() => {
      const pending = this.putPendingTurn(row)
      this.deleteQueuedInput(inputId)
      return pending
    })
  }

  listPendingTurns(): PendingSuperagentTurnRow[] {
    const rows = this.db
      .select()
      .from(superagentPendingTurns)
      .orderBy(asc(superagentPendingTurns.createdAt))
      .all()
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

  deletePendingTurn(turnId: string): void {
    this.db.delete(superagentPendingTurns).where(eq(superagentPendingTurns.turnId, turnId)).run()
  }

  /**
   * The thread row as its readers want it: `null` becomes `undefined`, and
   * nothing else. Every cast this used to carry is gone — the names and the
   * brands come off the schema now.
   */
  private mapSuperagentThread(r: typeof superagentThreads.$inferSelect): SuperagentThreadRow {
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
