// workspace-scoped (POD-6959)
/**
 * Superagent aggregate — owns `superagent_threads` and `superagent_messages`
 * (the 'global' orchestrator thread, per-session 'btw' threads and per-repo
 * 'concierge' intake threads).
 */

import {
  asThreadId,
  firstAdminMemberId,
  type SessionId,
  type SuperagentTurnFailureWire,
  type ThreadId,
  type UserId,
} from '@podium/model'
import { asc, desc, eq, inArray, isNull, notExists, sql } from 'drizzle-orm'
import type { superagentThreads } from '../migrations/schema'
import { type ChangeLogCommit, inChangeLogTransaction } from './change-log-commit'
import type {
  LegacyWorkspaceQueries,
  StoreDrizzle,
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
} from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  inWorkspace,
  param,
  placeholdersFor,
  prepared,
  preparedFamily,
  shapeOf,
  WORKSPACE,
} from './executor/sync-drizzle'
import { parseJsonColumn } from './helpers'
import type {
  PendingSuperagentTurnRow,
  QueuedSuperagentInputRow,
  SuperagentMessageRow,
  SuperagentThreadRow,
  ToolCallRow,
} from './types'
import { UsersRepository } from './users'

/** RETAINED EXTERNAL-INPUT/ID-MINT CASTS: legacy thread methods accept string
 * ids and the global thread is minted from a literal. Selected thread/session
 * ids flow from the schema without re-entry casts. */
// Every query this repository runs, prepared once per store [POD-6147].

const P = (name: string) => sql.placeholder(name)
const threadIdIs = (t: StoreTables) =>
  eq(t.superagentThreads.id, param(t.superagentThreads.id, 'id'))

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
const seedGlobal = prepared((db, t) =>
  db
    .insert(t.superagentThreads)
    .values({
      workspaceId: WORKSPACE,
      id: asThreadId('global'),
      ownerUserId: P('ownerUserId'),
      kind: 'global',
      createdAt: P('now'),
      updatedAt: P('now'),
    })
    .onConflictDoNothing()
    .returning()
    .prepare(),
)

const threadMessages = prepared((db, t) =>
  db
    .select({
      id: t.superagentMessages.id,
      ownerUserId: t.superagentMessages.ownerUserId,
      role: t.superagentMessages.role,
      content: t.superagentMessages.content,
      toolCalls: t.superagentMessages.toolCalls,
      toolCallId: t.superagentMessages.toolCallId,
      toolName: t.superagentMessages.toolName,
      createdAt: t.superagentMessages.createdAt,
    })
    .from(t.superagentMessages)
    .where(
      inWorkspace(
        t.superagentMessages,
        eq(t.superagentMessages.threadId, param(t.superagentMessages.threadId, 'threadId')),
      ),
    )
    .orderBy(desc(t.superagentMessages.id))
    .limit(P('limit'))
    .prepare(),
)

const insertMessage = prepared((db, t) =>
  db
    .insert(t.superagentMessages)
    .values({
      workspaceId: WORKSPACE,
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

const touchThread = prepared((db, t) =>
  db
    .update(t.superagentThreads)
    .set({ updatedAt: P('updatedAt') })
    .where(inWorkspace(t.superagentThreads, threadIdIs(t)))
    .returning()
    .prepare(),
)

const deleteThreadMessages = prepared((db, t) =>
  db
    .delete(t.superagentMessages)
    .where(
      inWorkspace(
        t.superagentMessages,
        eq(t.superagentMessages.threadId, param(t.superagentMessages.threadId, 'threadId')),
      ),
    )
    .prepare(),
)

const openThreadsOf = prepared((db, t) =>
  db
    .select()
    .from(t.superagentThreads)
    .where(
      inWorkspace(
        t.superagentThreads,
        eq(t.superagentThreads.ownerUserId, param(t.superagentThreads.ownerUserId, 'ownerUserId')),
        eq(t.superagentThreads.archived, false),
      ),
    )
    .orderBy(desc(t.superagentThreads.updatedAt))
    .prepare(),
)

const threadById = prepared((db, t) =>
  db
    .select()
    .from(t.superagentThreads)
    .where(inWorkspace(t.superagentThreads, threadIdIs(t)))
    .prepare(),
)

/** Threads by id, for building `superagentThread` records by id (POD-6763). */
const threadsOfIds = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.superagentThreads)
    .where(inWorkspace(t.superagentThreads, inListOf(t.superagentThreads.id, size, 'ids')))
    .prepare(),
)

const ownedThreadById = prepared((db, t) =>
  db
    .select()
    .from(t.superagentThreads)
    .where(
      inWorkspace(
        t.superagentThreads,
        threadIdIs(t),
        eq(t.superagentThreads.ownerUserId, param(t.superagentThreads.ownerUserId, 'ownerUserId')),
      ),
    )
    .prepare(),
)

const upsertThread = prepared((db, t) =>
  db
    .insert(t.superagentThreads)
    .values({
      workspaceId: WORKSPACE,
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
      target: t.superagentThreads.id,
      set: {
        title: sql`COALESCE(excluded.title, ${t.superagentThreads.title})`,
        // RE-OPENING IS A SIDE EFFECT OF WRITING. `archiveSuperagentThread`
        // hides a thread; this line is the only thing that brings it back.
        archived: false,
        updatedAt: P('now'),
      },
    })
    .returning()
    .prepare(),
)

const setWatermark = prepared((db, t) =>
  db
    .update(t.superagentThreads)
    .set({ watermarkItemId: P('itemId'), watermarkTs: P('ts') })
    .where(inWorkspace(t.superagentThreads, threadIdIs(t)))
    .prepare(),
)

/** The binding patch writes only the keys it carries, so its key set is the shape. */
const setThreadBinding = preparedFamily((db, t, shape: string) =>
  db
    .update(t.superagentThreads)
    .set(placeholdersFor(shape) as unknown as Partial<typeof superagentThreads.$inferInsert>)
    .where(inWorkspace(t.superagentThreads, threadIdIs(t)))
    .returning()
    .prepare(),
)

const archiveThread = prepared((db, t) =>
  db
    .update(t.superagentThreads)
    .set({ archived: true })
    .where(inWorkspace(t.superagentThreads, threadIdIs(t)))
    .returning()
    .prepare(),
)

/** Every thread, archived ones included: the `superagentThread` boot reconcile. */
const allThreads = prepared((db, t) =>
  db
    .select()
    .from(t.superagentThreads)
    .where(inWorkspace(t.superagentThreads))
    .orderBy(asc(t.superagentThreads.id))
    .prepare(),
)

/** A pending-turn row of the outer thread (its unique `thread_id` index). */
const pendingTurnOfThread = (db: StoreDrizzle, t: StoreTables) =>
  db
    .select({ one: sql`1` })
    .from(t.superagentPendingTurns)
    .where(
      inWorkspace(
        t.superagentPendingTurns,
        eq(t.superagentPendingTurns.threadId, t.superagentThreads.id),
      ),
    )

/**
 * BOOT TRUTH OF `turn_running` (POD-6675): a thread runs a turn exactly when it
 * has a pending-turn row, the durable record of a dispatched turn. A restart in
 * the middle of a turn's preparation (no pending row yet) leaves the flag set
 * with nothing to clear it; this clears it, and a thread whose pending row
 * survived keeps it until that turn ends. Only rows that change are written.
 */
const syncTurnRunning = prepared((db, t) =>
  db
    .update(t.superagentThreads)
    .set({ turnRunning: false })
    .where(
      inWorkspace(
        t.superagentThreads,
        inArray(
          t.superagentThreads.id,
          db
            .select({ id: sql<ThreadId>`${t.superagentThreads.id}` })
            // A sparse running set remains bounded even under statistics from a
            // tiny database. Recover no archived history just to rediscover false.
            .from(sql`${t.superagentThreads} INDEXED BY idx_superagent_threads_running`)
            .where(
              inWorkspace(
                t.superagentThreads,
                eq(t.superagentThreads.turnRunning, true),
                notExists(pendingTurnOfThread(db, t)),
              ),
            ),
        ),
      ),
    )
    .returning()
    .prepare(),
)

/** A newly created member's global, in the account write's transaction. */
const seedMemberGlobal = prepared((db, t) =>
  db
    .insert(t.superagentThreads)
    .select(
      db
        .select({
          // The member's own workspace: the users read below is held to it.
          workspaceId: t.users.workspaceId,
          id: sql<ThreadId>`'global:' || ${t.users.id}`.as('id'),
          ownerUserId: t.users.id,
          kind: sql<string>`'global'`.as('kind'),
          createdAt: sql<string>`${P('now')}`.as('created_at'),
          updatedAt: sql<string>`${P('now')}`.as('updated_at'),
        })
        .from(t.users)
        .where(
          inWorkspace(
            t.users,
            eq(t.users.id, param(t.users.id, 'ownerUserId')),
            isNull(t.users.disabledAt),
            notExists(
              db
                .select({ one: sql`1` })
                .from(t.superagentThreads)
                .where(
                  inWorkspace(
                    t.superagentThreads,
                    eq(t.superagentThreads.ownerUserId, t.users.id),
                    eq(t.superagentThreads.kind, 'global'),
                  ),
                ),
            ),
          ),
        ),
    )
    .onConflictDoNothing()
    .returning()
    .prepare(),
)

const insertQueuedInput = prepared((db, t) =>
  db
    .insert(t.superagentQueuedInputs)
    .values({
      workspaceId: WORKSPACE,
      inputId: P('inputId'),
      ownerUserId: P('ownerUserId'),
      threadId: P('threadId'),
      text: P('text'),
      focusJson: P('focusJson'),
      agentKind: P('agentKind'),
      attachSessionId: P('attachSessionId'),
      model: P('model'),
      effort: P('effort'),
      createdAt: P('createdAt'),
    })
    .prepare(),
)

const allQueuedInputs = prepared((db, t) =>
  db
    .select()
    .from(t.superagentQueuedInputs)
    .where(inWorkspace(t.superagentQueuedInputs))
    .orderBy(asc(t.superagentQueuedInputs.createdAt))
    .prepare(),
)

const queuedInputsOfThread = prepared((db, t) =>
  db
    .select()
    .from(t.superagentQueuedInputs)
    .where(
      inWorkspace(
        t.superagentQueuedInputs,
        eq(t.superagentQueuedInputs.threadId, param(t.superagentQueuedInputs.threadId, 'threadId')),
      ),
    )
    .orderBy(asc(t.superagentQueuedInputs.createdAt))
    .prepare(),
)

const deleteQueuedInputRow = prepared((db, t) =>
  db
    .delete(t.superagentQueuedInputs)
    .where(
      inWorkspace(
        t.superagentQueuedInputs,
        eq(t.superagentQueuedInputs.inputId, param(t.superagentQueuedInputs.inputId, 'inputId')),
      ),
    )
    .prepare(),
)

const insertPendingTurn = prepared((db, t) =>
  db
    .insert(t.superagentPendingTurns)
    .values({
      workspaceId: WORKSPACE,
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

const allPendingTurns = prepared((db, t) =>
  db
    .select()
    .from(t.superagentPendingTurns)
    .where(inWorkspace(t.superagentPendingTurns))
    .orderBy(asc(t.superagentPendingTurns.createdAt))
    .prepare(),
)

const deletePendingTurnRow = prepared((db, t) =>
  db
    .delete(t.superagentPendingTurns)
    .where(
      inWorkspace(
        t.superagentPendingTurns,
        eq(t.superagentPendingTurns.turnId, param(t.superagentPendingTurns.turnId, 'turnId')),
      ),
    )
    .prepare(),
)

/**
 * Called with the rows of every write to `superagent_threads`, inside that
 * write's transaction (POD-6675): the `superagentThread` feed capture.
 */
export type SuperagentThreadFeedCapture = ChangeLogCommit

type ThreadSelect = typeof superagentThreads.$inferSelect

/** The columns a thread update may set: never its workspace, which the handle fills
 *  (POD-6959). */
type ThreadPatch = Omit<Partial<typeof superagentThreads.$inferInsert>, 'workspaceId'>

export class SuperagentRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner
  private threadFeedCapture: SuperagentThreadFeedCapture | undefined

  private readonly users: UsersRepository

  /** The queries are one workspace's; `rootDb` rides along only for the users
   *  repository, whose own scoping task narrows it (POD-6959). */
  constructor(queries: LegacyWorkspaceQueries) {
    this.users = new UsersRepository(queries)
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

  /** Install the thread feed capture, run inside every thread write's transaction. */
  setThreadFeedCapture(capture: SuperagentThreadFeedCapture): () => void {
    this.threadFeedCapture = capture
    return () => {
      if (this.threadFeedCapture === capture) this.threadFeedCapture = undefined
    }
  }

  /**
   * THE ONE THREAD WRITE FUNNEL (POD-6675). `superagent_threads` is a synced
   * table: every write returns the rows it wrote and hands them to the feed
   * capture in the same transaction, so a thread's record reaches its owner's
   * devices from the write path, whichever module moved it, and the table and
   * the change log commit or roll back together.
   */
  private async writeThreads(query: () => Promise<ThreadSelect[]>): Promise<SuperagentThreadRow[]> {
    const rows = await inChangeLogTransaction(
      this.threadFeedCapture,
      this.createOrJoinTransaction,
      query,
    )
    return rows.map((row) => this.mapSuperagentThread(row))
  }

  /** Per-boot heal: idempotent seed of the always-there 'global' thread.
   *  BOOTSTRAP (POD-6285): with no owner given, the bare id is seeded for the
   *  first admin, the install's original person; other members get their own
   *  `global:<member>` thread on first use. */
  async seedGlobalThread(ownerUserId?: UserId): Promise<void> {
    ownerUserId ??= await firstAdminMemberId({ users: this.users })
    const saNow = new Date().toISOString()
    // `DO NOTHING` matches `OR IGNORE` here: see `seedGlobal`.
    await this.writeThreads(async () => await seedGlobal(this.db).all({ ownerUserId, now: saNow }))
  }

  async seedMemberGlobalThread(ownerUserId: UserId): Promise<void> {
    await this.seedGlobalThread()
    const now = new Date().toISOString()
    await this.writeThreads(async () => await seedMemberGlobal(this.db).all({ ownerUserId, now }))
  }

  /** Every thread, archived ones included, as the boot reconcile publishes them. */
  async allThreadsForBootReconcile(): Promise<SuperagentThreadRow[]> {
    return (await allThreads(this.db).all()).map((row) => this.mapSuperagentThread(row))
  }

  /** Boot truth of `turnRunning`: set exactly on threads with a pending turn. */
  async syncTurnRunningWithPendingTurns(): Promise<void> {
    await this.writeThreads(async () => await syncTurnRunning(this.db).all())
  }

  /**
   * A turn started or ended on the thread (POD-6675). A NEW turn also clears the
   * last failure (`clearFailure`); a turn re-driven after a restart is the same
   * turn and leaves it. The status leaves `updatedAt` alone (it orders the
   * threads by conversation), and the feed appends only a record that changed.
   */
  async setTurnRunning(
    id: ThreadId,
    running: boolean,
    opts: { clearFailure?: boolean } = {},
  ): Promise<void> {
    const set: ThreadPatch = { turnRunning: running }
    if (opts.clearFailure === true) {
      set.lastTurnFailureAt = null
      set.lastTurnFailureMessage = null
      set.lastTurnFailureUserText = null
    }
    await this.writeTurnStatus(id, set)
  }

  /** The thread's last turn failed, or (null) its failure is cleared. */
  async setTurnFailure(id: ThreadId, failure: SuperagentTurnFailureWire | null): Promise<void> {
    await this.writeTurnStatus(id, {
      lastTurnFailureAt: failure?.at ?? null,
      lastTurnFailureMessage: failure?.message ?? null,
      lastTurnFailureUserText: failure?.userText ?? null,
    })
  }

  private async writeTurnStatus(id: ThreadId, set: ThreadPatch): Promise<void> {
    await this.writeThreads(
      async () => await setThreadBinding(this.db, shapeOf(set)).all({ ...set, id }),
    )
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
    await this.writeThreads(
      async () => await touchThread(this.db).all({ id: threadId, updatedAt: createdAt }),
    )
    return { ...m, ownerUserId, id: Number(result.lastInsertRowid), createdAt }
  }

  async clearSuperagentMessages(threadId = 'global'): Promise<void> {
    await deleteThreadMessages(this.db).run({ threadId: asThreadId(threadId) })
  }

  async listSuperagentThreads(ownerUserId: UserId): Promise<SuperagentThreadRow[]> {
    const rows = await openThreadsOf(this.db).all({ ownerUserId })
    return rows.map((r) => this.mapSuperagentThread(r))
  }

  /** {@link getSuperagentThread} for many ids, one read per 500; absent ids have no row. */
  async superagentThreadsByIds(ids: readonly string[]): Promise<SuperagentThreadRow[]> {
    const unique = [...new Set(ids)]
    const out: SuperagentThreadRow[] = []
    for (let at = 0; at < unique.length; at += 500) {
      const chunk = unique.slice(at, at + 500).map(asThreadId)
      const size = inListSize(chunk.length)
      for (const row of await threadsOfIds(this.db, size).all(inListValues(chunk, size, 'ids')))
        out.push(this.mapSuperagentThread(row))
    }
    return out
  }

  async getSuperagentThread(
    id: string,
    ownerUserId?: UserId,
  ): Promise<SuperagentThreadRow | undefined> {
    const r = ownerUserId
      ? await ownedThreadById(this.db).get({ id: asThreadId(id), ownerUserId })
      : await threadById(this.db).get({ id: asThreadId(id) })
    return r ? this.mapSuperagentThread(r) : undefined
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
    await this.writeThreads(
      async () =>
        await upsertThread(this.db).all({
          // EXTERNAL INPUT BRAND DECODE: this legacy writer accepts the
          // service-facing string id and brands it at the persistence boundary.
          id: asThreadId(t.id),
          ownerUserId: t.ownerUserId,
          kind: t.kind,
          originSessionId: t.originSessionId ?? null,
          repoPath: t.repoPath ?? null,
          title: t.title ?? null,
          now,
        }),
    )
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
      /** The owner's edits (POD-6675, `records.superagentThread.edit`). */
      title?: string | null
      archived?: boolean
    },
  ): Promise<void> {
    // ONLY THE FIELDS PRESENT IN `patch` ARE WRITTEN, which is what the
    // hand-built SET list did: an absent key leaves the column alone, and an
    // explicit `null` CLEARS it. Building the object the same way keeps that
    // distinction, which a spread of the whole patch would lose.
    const set: ThreadPatch = {}
    if (patch.agentKind !== undefined) set.agentKind = patch.agentKind
    if (patch.podiumSessionId !== undefined) set.podiumSessionId = patch.podiumSessionId
    if (patch.harnessSessionId !== undefined) set.harnessSessionId = patch.harnessSessionId
    if (patch.terminalSessionId !== undefined) set.terminalSessionId = patch.terminalSessionId
    if (patch.model !== undefined) set.model = patch.model
    if (patch.effort !== undefined) set.effort = patch.effort
    if (patch.title !== undefined) set.title = patch.title
    if (patch.archived !== undefined) set.archived = patch.archived
    if (Object.keys(set).length === 0) return
    set.updatedAt = new Date().toISOString()
    await this.writeThreads(
      async () => await setThreadBinding(this.db, shapeOf(set)).all({ ...set, id: asThreadId(id) }),
    )
  }

  async archiveSuperagentThread(id: string): Promise<void> {
    await this.writeThreads(async () => await archiveThread(this.db).all({ id: asThreadId(id) }))
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
      model: row.model ?? null,
      effort: row.effort ?? null,
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
      ...(row.model ? { model: row.model } : {}),
      ...(row.effort ? { effort: row.effort } : {}),
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
  private mapSuperagentThread(r: ThreadSelect): SuperagentThreadRow {
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
      turnRunning: r.turnRunning,
      lastTurnFailure:
        r.lastTurnFailureAt !== null && r.lastTurnFailureMessage !== null
          ? {
              at: r.lastTurnFailureAt,
              message: r.lastTurnFailureMessage,
              userText: r.lastTurnFailureUserText,
            }
          : null,
    }
  }
}
