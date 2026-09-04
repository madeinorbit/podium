/**
 * Issues aggregate — owns the `issues` table and its child tables:
 * `issue_labels`, `issue_deps`, `issue_comments` and `issue_messages`
 * (agent mail, issue #103).
 *
 * Cross-aggregate note: an issue's stable repo identity (repo_id, #74) is
 * resolved by the repos aggregate; the resolver is injected.
 */

import { createLogger } from '@podium/logger'
import {
  asIssueId,
  type IssueId,
  IssueStage,
  isIssueClosed,
  isIssueColorSlot,
  type RepoId,
  type SessionId,
  type UserId,
} from '@podium/model'
import { letterForIndex } from '@podium/protocol'
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  max,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import {
  issueComments,
  issueDeps,
  issueLabels,
  issueMessages,
  issueMessageUserState,
  issueRefLetters,
  issues,
  issueUserState,
} from '../migrations/schema'
import { currentReadScope, readScopeSlot } from './executor/read-scope'
import type { SyncDrizzle, SyncQueries } from './executor/sync-drizzle'
import { parseStringArray, requireUserId } from './helpers'
import { StaleIssueRevisionError } from './issue-revision'
import type { IssueCommentRow, IssueMessageRow, IssueRow, StoredIssueUserState } from './types'

const log = createLogger('server:store')

export class IssuesRepository {
  /** Rows skipped by the last {@link listIssueRows} because they were
   *  structurally corrupt (row-level quarantine). Diagnostic counter. */
  quarantinedRowCount = 0

  /**
   * THE ROW READ CACHE [POD-1931], HELD BY THE READ SCOPE [POD-3261].
   *
   * The publish fan-out is O(events x sessions), and every pass resolves the
   * owning issue of every session it admits. Measured on the live server: ONE
   * event-loop frame ran 242 `getIssues` calls returning 94,138 rows plus 5,163
   * `getIssue` calls — 13 seconds of CPU, most of it `mapIssueRow` parsing the
   * same JSON columns over and over, with RSS climbing to 4.6GB and the GC that
   * followed costing another 12-14 seconds of stall.
   *
   * A row cannot change inside a read scope, so the second read of an id inside
   * one is the first read's answer. The cache holds MAPPED rows and hands out a
   * shallow COPY per call, so callers keep the fresh-object-per-read contract
   * they had before for their own fields; only the parse is shared, not the
   * object.
   *
   * WHAT CHANGED, AND WHY IT HAD TO. The cache used to be a field on this
   * repository invalidated by `queueMicrotask` — sound only because a microtask
   * cannot run inside a synchronous turn, which is to say sound only while the
   * store is synchronous. The first `await` anywhere in the fan-out drops it,
   * and this epic's whole business is putting awaits in that fan-out. The
   * lifetime is now a {@link ReadScope}, which a pass opens around itself and
   * which becomes a real read lease at the flip; the microtask turn survives
   * only as the scope's fallback owner, in `read-scope.ts`, and dies with it.
   *
   * `disabled` is the frame-that-writes rule, unchanged: a scope that WRITES
   * issues does not cache at all, because populating a cache from inside an
   * open transaction would survive a rollback for the rest of the scope, and no
   * read path is worth that. Write scopes are rare; the passes this exists for
   * are pure fan-out reads.
   */
  private readonly rowCacheSlot = readScopeSlot<{
    readonly rows: Map<string, IssueRow | null>
    disabled: boolean
  }>(() => ({ rows: new Map(), disabled: false }))

  /** The query capability: the drizzle instance and the transaction port. Both
   *  halves come from one object so the flip swaps what fills it and leaves this
   *  construction site alone. */
  private readonly db: SyncDrizzle

  constructor(
    private readonly queries: SyncQueries,
    /** Repos-aggregate lookup: stable repo_id for an issue's repoPath. */
    private readonly resolveRepoIdForPath: (repoPath: string) => string,
  ) {
    this.db = queries.db
  }

  /** Every issue-row WRITE calls this BEFORE the write: the frame stops caching,
   *  and whatever it had already cached is dropped.
   *
   *  Enforced, not remembered (POD-1939): `store-issues-row-cache-writers.test.ts`
   *  reads this file, finds every statement writing the `issues` table, and fails
   *  unless the enclosing method invalidates first — so a NEW write path is
   *  caught the day it is added. It also explains why the handle is not wrapped
   *  to do this automatically. */
  private invalidateRowCache(): void {
    const held = currentReadScope().slot(this.rowCacheSlot)
    held.rows.clear()
    held.disabled = true
  }

  /** The current scope's cache, opened on first use and discarded when the
   *  scope ends. Undefined once a write in this scope has disabled caching. */
  private frameRows(): Map<string, IssueRow | null> | undefined {
    const held = currentReadScope().slot(this.rowCacheSlot)
    return held.disabled ? undefined : held.rows
  }

  upsertIssue(
    row: IssueRow,
    /**
     * THE DURABLE HALF OF THE DRAFT MODEL [POD-3259, spec §3.6 model (b)].
     *
     * `expectedRevision` is the revision the caller's draft was cut from —
     * `null` for a row that has never been written. When it is supplied and the
     * stored revision has moved, this refuses INSIDE the transaction, so the
     * loser's write rolls back rather than overwriting the winner's columns
     * with a field set read before the winner existed.
     *
     * OPT-IN, and it has to be: most callers hand over a row they built from a
     * literal or read outside any revision discipline, and turning their write
     * into a precondition would be a behaviour change this epic does not make.
     * `IssueRegistry.persistWith` passes it for every draft it cuts, which is
     * every mutation path in the tracker.
     *
     * It cannot fire while the store is synchronous — nothing can run between
     * cutting a draft and committing it — and that is the point: it is armed
     * before the awaits arrive, not after.
     */
    opts?: { expectedRevision: number | null },
  ): void {
    this.invalidateRowCache()
    if (
      !row.ownerUserId ||
      !row.visibility ||
      !row.createdByActor ||
      row.createdByOnBehalfOf === undefined
    ) {
      throw new Error(`upsertIssue: complete ownership attribution is required for ${row.id}`)
    }
    // Strict on write: stage is a load-bearing enum (the board column + zod-validated
    // on the wire). defaultAgent is intentionally NOT validated here — 'auto' is a
    // legal stored sentinel resolved to a concrete kind only at spawn time.
    if (!IssueStage.safeParse(row.stage).success) {
      throw new Error(
        `upsertIssue: refusing to persist invalid stage ${JSON.stringify(row.stage)} for ${row.id}`,
      )
    }
    // Normalize blockedBy so the column is always a clean string[] JSON value.
    const blockedBy = Array.isArray(row.blockedBy)
      ? row.blockedBy.filter((x): x is string => typeof x === 'string')
      : []
    // THE revision assignment (ADR 2 D3). This is the issues table's only SQL
    // writer, so putting the bump here makes it STRUCTURAL: every accepted write
    // gets a fresh revision with no call-site cooperation, and a new write path
    // cannot forget to bump one.
    //
    // Read the CURRENT value out of the DB rather than off `row`: the caller's
    // copy may be stale (or a hand-built literal), and the value that matters is
    // the one on the row actually being replaced. `?? 0` covers the first write
    // of a new issue → revision 1, matching the migration's backfill of 1 for
    // rows that predate the column.
    //
    // The assignment MUTATES the caller's row on purpose, mirroring how
    // persistWith already stamps `row.updatedAt` in place before this call. That
    // is what lets a post-write toWire(row) carry the committed token for free —
    // and it is why a wire projected BEFORE the write is a bug (see
    // IssueLifecyclePlan.wire, which enforces the ordering).
    //
    // Interaction with the ledger's byte-equality dedup, which this must NOT
    // break: a bumped revision changes the wire JSON, so a write is never
    // deduped away. That is correct and costs nothing, because the dedup's real
    // job for issues is the WRITE-LESS reconcile path (derived ripples: closing
    // X flips ready/blocked on its dependents without any write touching them).
    // reconcile never reaches this method, so no revision burns on a no-op and
    // the ripple republishes under an unchanged revision — leaving in-flight
    // expectedRevision preconditions valid, which is the whole point of D3.
    const current = this.db
      .select({ revision: issues.revision })
      .from(issues)
      .where(eq(issues.id, row.id))
      .get()
    if (opts) {
      const found = current?.revision ?? null
      if (found !== opts.expectedRevision) {
        throw new StaleIssueRevisionError(row.id, opts.expectedRevision, found)
      }
    }
    row.revision = (current?.revision ?? 0) + 1
    // The column set is the schema's, and the two halves are deliberately
    // different: `values` carries every column, `set` carries only the columns a
    // SECOND write may change. The eight the update omits — id, owner_user_id,
    // visibility, created_by_actor, created_by_on_behalf_of, repo_path, seq and
    // created_at — are the row's identity and its provenance, and the upsert has
    // never rewritten them.
    const values = {
      id: row.id,
      ownerUserId: row.ownerUserId,
      visibility: row.visibility,
      createdByActor: row.createdByActor ?? row.ownerUserId,
      createdByOnBehalfOf: row.createdByOnBehalfOf,
      repoPath: row.repoPath,
      repoId: row.repoId ?? (this.resolveRepoIdForPath(row.repoPath) as RepoId),
      seq: row.seq,
      title: row.title,
      description: row.description,
      brief: row.brief ?? null,
      stage: row.stage,
      worktreePath: row.worktreePath,
      branch: row.branch,
      parentBranch: row.parentBranch,
      defaultAgent: row.defaultAgent,
      defaultModel: row.defaultModel,
      defaultEffort: row.defaultEffort,
      machineId: row.machineId ?? null,
      linearId: row.linearId,
      linearIdentifier: row.linearIdentifier,
      linearUrl: row.linearUrl,
      activityNotes: row.activityNotes,
      notesUpdatedAt: row.notesUpdatedAt,
      suggestedStage: row.suggestedStage,
      suggestedReason: row.suggestedReason,
      blockedBy: JSON.stringify(blockedBy),
      dependencyNote: row.dependencyNote,
      prUrl: row.prUrl,
      priority: row.priority,
      type: row.type,
      assignee: row.assignee,
      parentId: row.parentId,
      design: row.design,
      acceptance: row.acceptance,
      notes: row.notes,
      dueAt: row.dueAt,
      deferUntil: row.deferUntil,
      closedReason: row.closedReason,
      closedAt: row.closedAt ?? null,
      landedAt: row.landedAt ?? null,
      landedSha: row.landedSha ?? null,
      supersededBy: row.supersededBy,
      duplicateOf: row.duplicateOf,
      sortKey: row.sortKey ?? null,
      color: row.color ?? null,
      estimateMin: row.estimateMin,
      needsHuman: row.needsHuman,
      humanQuestion: row.humanQuestion,
      humanQuestionOptions: row.humanQuestionOptions?.length
        ? JSON.stringify(row.humanQuestionOptions)
        : null,
      humanQuestionAskedBy: row.humanQuestionAskedBy ?? null,
      humanQuestionAskedAt: row.humanQuestionAskedAt ?? null,
      panel: row.panel ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archived: row.archived,
      origin: row.origin ?? 'human',
      audience: row.audience ?? 'human',
      draft: row.draft ?? false,
      deletedAt: row.deletedAt ?? null,
      revision: row.revision,
      coordinatorSessionId: row.coordinatorSessionId ?? null,
      startedBySession: row.startedBySession ?? null,
    }
    this.db
      .insert(issues)
      .values(values)
      .onConflictDoUpdate({
        target: issues.id,
        set: {
          repoId: values.repoId,
          title: values.title,
          description: values.description,
          brief: values.brief,
          stage: values.stage,
          worktreePath: values.worktreePath,
          branch: values.branch,
          parentBranch: values.parentBranch,
          defaultAgent: values.defaultAgent,
          defaultModel: values.defaultModel,
          defaultEffort: values.defaultEffort,
          machineId: values.machineId,
          linearId: values.linearId,
          linearIdentifier: values.linearIdentifier,
          linearUrl: values.linearUrl,
          activityNotes: values.activityNotes,
          notesUpdatedAt: values.notesUpdatedAt,
          suggestedStage: values.suggestedStage,
          suggestedReason: values.suggestedReason,
          blockedBy: values.blockedBy,
          dependencyNote: values.dependencyNote,
          prUrl: values.prUrl,
          priority: values.priority,
          type: values.type,
          assignee: values.assignee,
          parentId: values.parentId,
          design: values.design,
          acceptance: values.acceptance,
          notes: values.notes,
          dueAt: values.dueAt,
          deferUntil: values.deferUntil,
          closedReason: values.closedReason,
          closedAt: values.closedAt,
          landedAt: values.landedAt,
          landedSha: values.landedSha,
          supersededBy: values.supersededBy,
          duplicateOf: values.duplicateOf,
          sortKey: values.sortKey,
          color: values.color,
          estimateMin: values.estimateMin,
          needsHuman: values.needsHuman,
          humanQuestion: values.humanQuestion,
          humanQuestionOptions: values.humanQuestionOptions,
          humanQuestionAskedBy: values.humanQuestionAskedBy,
          humanQuestionAskedAt: values.humanQuestionAskedAt,
          panel: values.panel,
          updatedAt: values.updatedAt,
          archived: values.archived,
          origin: values.origin,
          audience: values.audience,
          draft: values.draft,
          deletedAt: values.deletedAt,
          revision: values.revision,
          coordinatorSessionId: values.coordinatorSessionId,
          startedBySession: values.startedBySession,
        },
      })
      .run()
  }

  /** Internal Shipping custody seam. Ordinary issue CRUD never calls this.
   * Callers bind it to ship-order create/settlement with SessionStore.transact;
   * the expected-stage predicate is the admission/settlement CAS. */
  transitionShippingStage(
    id: IssueId,
    expectedStage: Extract<IssueStage, 'review' | 'shipping'>,
    nextStage: Extract<IssueStage, 'shipping' | 'review' | 'done'>,
    updatedAt: string,
  ): IssueRow {
    const legal =
      (expectedStage === 'review' && nextStage === 'shipping') ||
      (expectedStage === 'shipping' && (nextStage === 'review' || nextStage === 'done'))
    if (!legal) {
      throw new Error(`illegal shipping issue-stage transition ${expectedStage} → ${nextStage}`)
    }
    this.invalidateRowCache()
    // ONE statement, and it stays one: the fence (`stage = expectedStage` plus
    // `deleted_at IS NULL`) and the write are the compare-and-swap. Splitting the
    // read out would turn the CAS into a race. `revision` is bumped from its own
    // stored value, so the expression references the column rather than a bound
    // parameter.
    const result = this.db
      .update(issues)
      .set({
        stage: nextStage,
        updatedAt,
        revision: sql`COALESCE(${issues.revision}, 0) + 1`,
      })
      .where(and(eq(issues.id, id), eq(issues.stage, expectedStage), isNull(issues.deletedAt)))
      .run()
    if (result.changes !== 1) {
      throw new Error(`issue ${id} shipping stage fence failed: expected ${expectedStage}`)
    }
    const row = this.getIssue(id)
    if (!row) throw new Error(`issue ${id} disappeared after shipping transition`)
    return row
  }

  /**
   * SERIALIZATION EDGE — the one place a sqlite `Record<string, unknown>` becomes
   * an `IssueRow`. Every cast below is a decode of an untyped column, brands
   * included: sqlite has no type to carry a brand, so this is where a stored
   * string re-enters the branded id space. Casts here are NOT POD-361 adapter
   * casts; above this function every issue id is branded.
   */
  private mapIssueRow(r: typeof issues.$inferSelect): IssueRow {
    return {
      id: r.id,
      ownerUserId: r.ownerUserId,
      visibility:
        r.visibility === 'deployment-substrate' ||
        r.visibility === 'owned-compute' ||
        r.visibility === 'per-user-state' ||
        r.visibility === 'secret'
          ? r.visibility
          : 'personal',
      createdByActor: r.createdByActor,
      // SERIALIZATION EDGE: `created_by_on_behalf_of` carries no `$type` in the
      // schema, so the brand cannot flow from the column and re-enters here.
      createdByOnBehalfOf: (r.createdByOnBehalfOf as UserId | null) ?? null,
      repoPath: r.repoPath,
      repoId: r.repoId,
      seq: r.seq,
      title: r.title,
      description: r.description,
      brief: r.brief,
      stage: r.stage,
      worktreePath: r.worktreePath,
      branch: r.branch,
      parentBranch: r.parentBranch,
      defaultAgent: r.defaultAgent,
      defaultModel: r.defaultModel,
      defaultEffort: r.defaultEffort,
      machineId: r.machineId,
      linearId: r.linearId,
      linearIdentifier: r.linearIdentifier,
      linearUrl: r.linearUrl,
      activityNotes: r.activityNotes,
      notesUpdatedAt: r.notesUpdatedAt,
      suggestedStage: r.suggestedStage,
      suggestedReason: r.suggestedReason,
      blockedBy: parseStringArray(r.blockedBy, `issue ${String(r.id)} blocked_by`),
      dependencyNote: r.dependencyNote,
      prUrl: r.prUrl,
      priority: r.priority,
      type: r.type,
      // SERIALIZATION EDGE, as above: `assignee` carries no `$type`.
      assignee: (r.assignee as UserId | null) ?? null,
      parentId: r.parentId,
      design: r.design,
      acceptance: r.acceptance,
      notes: r.notes,
      dueAt: r.dueAt,
      deferUntil: r.deferUntil,
      closedReason: r.closedReason,
      closedAt: r.closedAt,
      landedAt: r.landedAt,
      landedSha: r.landedSha,
      supersededBy: r.supersededBy,
      duplicateOf: r.duplicateOf,
      sortKey: r.sortKey,
      color: isIssueColorSlot(r.color) ? r.color : null,
      estimateMin: r.estimateMin,
      needsHuman: r.needsHuman,
      humanQuestion: r.humanQuestion,
      // Options self-quarantine like blocked_by, but to null (= no chips) so a
      // corrupt blob degrades to the free-form question rather than [] chips.
      humanQuestionOptions: r.humanQuestionOptions
        ? (() => {
            const v = parseStringArray(
              r.humanQuestionOptions,
              `issue ${String(r.id)} human_question_options`,
            )
            return v.length > 0 ? v : null
          })()
        : null,
      // SERIALIZATION EDGE, as above: `human_question_asked_by` carries no `$type`.
      humanQuestionAskedBy: (r.humanQuestionAskedBy as SessionId | null) ?? null,
      humanQuestionAskedAt: r.humanQuestionAskedAt,
      panel: r.panel,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      archived: r.archived,
      deletedAt: r.deletedAt,
      origin: r.origin,
      audience: r.audience,
      draft: r.draft,
      // ADR 2 D3. `?? 1` is defence in depth, not an expected path: the column
      // is `DEFAULT 1 NOT NULL` and the migration materialized 1 into every
      // pre-existing row, so a null here would mean a hand-mangled database.
      revision: r.revision ?? 1,
      coordinatorSessionId: r.coordinatorSessionId,
      // SERIALIZATION EDGE, as above: `started_by_session` carries no `$type`
      // either, so this is the fourth column whose brand cannot flow from the
      // schema.
      startedBySession: (r.startedBySession as SessionId | null) ?? null,
    }
  }

  getIssue(id: string): IssueRow | null {
    const cache = this.frameRows()
    const hit = cache?.get(id)
    if (hit !== undefined) return hit === null ? null : { ...hit }
    const r = this.db
      .select()
      .from(issues)
      .where(eq(issues.id, asIssueId(id)))
      .get()
    const mapped = r ? this.mapIssueRow(r) : null
    cache?.set(id, mapped)
    return mapped === null ? null : { ...mapped }
  }

  /**
   * The CWD-RESOLUTION PROJECTION [POD-1653] — five columns, no row mapping.
   *
   * `DurableIssueAccessIndex` answers three questions from the issue table
   * (which worktrees exist, which issue owns this cwd, who solely owns it) and
   * answered all three with `listIssueRows()`: `SELECT *` over every issue,
   * each row then run through `mapIssueRow`, which parses several JSON columns.
   * On the live host that is ~1600 rows fully materialized — and it sat on a
   * per-message path (`worktreePaths().includes(cwd)`), so a membership test
   * cost a full scan plus 1600 JSON parses.
   *
   * The questions only ever read `worktree_path`, `repo_path`, `deleted_at` and
   * `archived`. Reading those columns keeps the answer identical while dropping
   * both the row payload and the mapping entirely.
   *
   * Deliberately still a LIVE read, once per call. This index exists to reflect
   * durable state without a snapshot (see its header); making it cheaper is not
   * a licence to make it stale.
   */
  listIssueCwdRows(): {
    id: IssueId
    repoPath: string
    worktreePath: string | null
    deletedAt: string | null
    archived: boolean
  }[] {
    const rows = this.db
      .select({
        id: issues.id,
        repoPath: issues.repoPath,
        worktreePath: issues.worktreePath,
        deletedAt: issues.deletedAt,
        archived: issues.archived,
      })
      .from(issues)
      .orderBy(asc(issues.repoPath), asc(issues.seq))
      .all()
    const out: {
      id: IssueId
      repoPath: string
      worktreePath: string | null
      deletedAt: string | null
      archived: boolean
    }[] = []
    for (const r of rows) {
      // Same structural quarantine listIssueRows applies: a NULL id or repo_path
      // is a corrupt row, and it must not reach a cwd decision.
      if (typeof r.id !== 'string' || typeof r.repoPath !== 'string') continue
      out.push({
        id: r.id,
        repoPath: r.repoPath,
        worktreePath: r.worktreePath,
        deletedAt: r.deletedAt,
        archived: r.archived,
      })
    }
    return out
  }

  /**
   * The FINISHED-WORK PROJECTION — two columns, no row mapping.
   *
   * The auto-hibernate sweep orders its candidates by whether the work they sit
   * on is finished (POD-568), which it asks once per host sample. Answering that
   * with `getIssues()` would be `SELECT *` plus `mapIssueRow`'s JSON parses over
   * every issue a live session touches, on a five-second path — the exact cost
   * {@link listIssueCwdRows} exists to have removed.
   *
   * Only `stage` and `closed_reason` are read, and the predicate itself stays
   * {@link isIssueClosed}'s so there is one definition of finished. Deleted rows
   * count as closed: a session on a tombstoned issue is at least as reapable as
   * one on a done issue, and quarantining it would order it BELOW live work.
   */
  closedIssueIds(): Set<string> {
    const rows = this.db
      .select({
        id: issues.id,
        stage: issues.stage,
        closedReason: issues.closedReason,
        deletedAt: issues.deletedAt,
      })
      .from(issues)
      .all()
    const out = new Set<string>()
    for (const r of rows) {
      if (typeof r.id !== 'string') continue
      const closed =
        r.deletedAt != null ||
        isIssueClosed({
          stage: typeof r.stage === 'string' ? r.stage : '',
          closedReason: r.closedReason,
        })
      if (closed) out.add(r.id)
    }
    return out
  }

  /**
   * The same by-id read, asked about MANY ids at once [POD-1653].
   *
   * A reader-scoped session projection resolves the owning issue of every
   * session it admits. POD-1618's per-pass memo collapses the ~1200 sessions
   * onto their ~630 distinct issues, which is the right collapse and still
   * ~630 statements per pass. This asks for all of them in one.
   *
   * Rows that do not exist are simply ABSENT from the result — the caller must
   * treat a missing id as "no such issue", which is what `getIssue` returning
   * null already means. Mapping failures are quarantined the same way
   * `listIssueRows` quarantines them, so one corrupt row costs that row.
   */
  getIssues(ids: readonly string[]): Map<string, IssueRow> {
    const out = new Map<string, IssueRow>()
    const unique = [...new Set(ids)]
    if (unique.length === 0) return out
    // Serve what this frame has already parsed, and ask SQLite only for the
    // rest. A miss recorded as null is an ANSWER ("no such issue"), the same
    // one the query would give, so it must not be re-asked either.
    const cache = this.frameRows()
    const wanted = cache === undefined ? unique : []
    if (cache !== undefined) {
      for (const id of unique) {
        const hit = cache.get(id)
        if (hit === undefined) wanted.push(id)
        else if (hit !== null) out.set(id, { ...hit })
      }
    }
    if (wanted.length === 0) return out
    const CHUNK = 500
    for (let i = 0; i < wanted.length; i += CHUNK) {
      const chunk = wanted.slice(i, i + CHUNK)
      const rows = this.db
        .select()
        .from(issues)
        .where(inArray(issues.id, chunk.map(asIssueId)))
        .all()
      for (const r of rows) {
        try {
          if (typeof r.id !== 'string') continue
          const mapped = this.mapIssueRow(r)
          cache?.set(r.id, mapped)
          out.set(r.id, { ...mapped })
        } catch (err) {
          log.error('quarantined a corrupt issue row — skipped', { issueId: r.id ?? null, err })
        }
      }
    }
    // An id asked for and not returned is absent — record the answer so a later
    // pass in this frame does not re-ask. A QUARANTINED row is absent from `out`
    // too, and caching it as absent is the same verdict the caller already got.
    if (cache !== undefined) for (const id of wanted) if (!out.has(id)) cache.set(id, null)
    return out
  }

  /**
   * All issue rows (optionally one repo), with ROW-LEVEL QUARANTINE: a row
   * that is structurally corrupt (or whose mapping throws for any reason) is
   * skipped, logged and counted — never propagated. This is the boot-hydration
   * read (IssueService), where one corrupt row aborting the whole load would
   * crash-loop the server. Individual JSON columns additionally self-quarantine
   * to safe defaults (see parseStringArray), which keeps the row.
   */
  /**
   * THE PARENT EDGE FOR EVERY ISSUE — the cost rollup's whole input (POD-1858).
   *
   * Two columns rather than `listIssueRows()`, and that is the point: a rollup
   * walk needs the tree and nothing else, and mapping 1,800 full issue rows
   * (with their JSON columns and per-row quarantine guard) to read one field is
   * how a panel read turns into a visible pause.
   */
  listIssueParentEdges(): { id: IssueId; parentId: IssueId | null }[] {
    // TOMBSTONES ARE NOT ANCESTORS. Issues are soft-deleted, so an unfiltered
    // walk folds a costed task's spend into a parent the operator deleted and
    // can see nowhere else in the app (POD-1858 review).
    const rows = this.db
      .select({ id: issues.id, parentId: issues.parentId })
      .from(issues)
      .where(isNull(issues.deletedAt))
      .all()
    return rows.map((r) => ({ id: r.id, parentId: r.parentId }))
  }

  listIssueRows(repoPath?: string): IssueRow[] {
    // Repo-scoped reads key on the stable repo_id (issue #164): the given path
    // resolves to its logical repo, so two registered clones of one repository
    // (or an issue filed under a sub-path of the root) list together. The
    // NULL-repo_id fallback keeps legacy rows the boot heal hasn't stamped yet
    // visible under their exact path.
    const rows = repoPath
      ? this.db
          .select()
          .from(issues)
          .where(
            or(
              eq(issues.repoId, this.resolveRepoIdForPath(repoPath) as RepoId),
              and(isNull(issues.repoId), eq(issues.repoPath, repoPath)),
            ),
          )
          .orderBy(asc(issues.seq))
          .all()
      : this.db.select().from(issues).orderBy(asc(issues.repoPath), asc(issues.seq)).all()
    const out: IssueRow[] = []
    this.quarantinedRowCount = 0
    for (const r of rows) {
      try {
        // Load-bearing TEXT columns must actually be strings: a NULL id (SQLite
        // allows NULL in a TEXT PRIMARY KEY) or NULL stage/title row would poison
        // every downstream consumer — quarantine it instead of mapping it.
        if (
          typeof r.id !== 'string' ||
          typeof r.repoPath !== 'string' ||
          typeof r.stage !== 'string' ||
          typeof r.title !== 'string'
        ) {
          throw new Error('structurally corrupt row (non-string id/repo_path/stage/title)')
        }
        out.push(this.mapIssueRow(r))
      } catch (err) {
        this.quarantinedRowCount += 1
        log.error('quarantined a corrupt issue row — skipped', { issueId: r.id ?? null, err })
      }
    }
    return out
  }

  deleteIssue(id: string): void {
    // Referential integrity is the ENGINE's job since migration 006 (#164):
    // child rows (labels/deps/comments/messages) go via ON DELETE CASCADE and
    // scalar back-references on OTHER rows (parent_id / superseded_by /
    // duplicate_of) clear via ON DELETE SET NULL — no manual scrub needed
    // (PRAGMA foreign_keys is enabled per-connection by the store facade).
    //
    // TWO TABLES ARE OUTSIDE THAT GUARANTEE (POD-1926), because neither declares
    // a foreign key: `issue_ref_letters` below, and `sessions.issue_id` /
    // `sessions.ref_issue_id` — which explicit draft-rehome cleanup
    // clears for the sessions it can see and `SessionsRepository`
    // .detachTombstonesFromIssue clears for the ones it cannot. Anything added
    // here that points at an issue without a constraint must be scrubbed by hand
    // or it outlives the row, and the comment above will read as if it were
    // covered.
    this.db
      .delete(issueRefLetters)
      .where(eq(issueRefLetters.issueId, asIssueId(id)))
      .run()
    this.invalidateRowCache()
    this.db
      .delete(issues)
      .where(eq(issues.id, asIssueId(id)))
      .run()
  }

  /** Per-boot heal (POD-1926): drop letter counters whose issue is already gone —
   *  rows a hard purge before {@link deleteIssue} scrubbed them left behind. The
   *  counter exists so a letter is never reused WITHIN an issue, so once the issue
   *  is deleted it protects nothing. Returns the number of rows dropped. */
  pruneOrphanRefLetters(): number {
    const result = this.db
      .delete(issueRefLetters)
      .where(notInArray(issueRefLetters.issueId, this.db.select({ id: issues.id }).from(issues)))
      .run()
    return Number(result.changes)
  }

  /** Next human-facing issue number, allocated per LOGICAL repo — scoped by the
   *  stable `repo_id` (issue #164, #140) so every checkout of one origin shares a
   *  single seq sequence and two machines with different paths can no longer mint
   *  colliding numbers. Callers resolve the path to a repo_id (resolveRepoIdForPath)
   *  before allocating. UNIQUE(repo_id, seq) enforces the invariant at the SQL layer. */
  nextIssueSeq(repoId: RepoId): number {
    const r = this.db
      .select({ m: max(issues.seq) })
      .from(issues)
      .where(eq(issues.repoId, repoId))
      .get()
    return (r?.m ?? 0) + 1
  }

  /**
   * #140 heal, ported from main's boot-time migrate(): make `seq` unique per
   * `repo_id` by renumbering the loser of each `(repo_id, seq)` collision. For each
   * repo_id the canonical path is the one with the most issues (tie-break: path
   * ascending); within a colliding seq the kept row is the one on the canonical path
   * (then earliest created_at, then id), and every other row is bumped to append
   * after that repo_id's current MAX(seq). Idempotent: a DB with no collisions is
   * untouched. Returns the number of issues renumbered.
   *
   * On this branch migration 005 already dedupes historic collisions and installs
   * UNIQUE(repo_id, seq), so post-migration writes cannot recreate them — this heal
   * is defense in depth for databases restored from a pre-index build.
   */
  renumberCollidingIssueSeqs(): number {
    const rows = this.db
      .select({
        id: issues.id,
        repoId: issues.repoId,
        repoPath: issues.repoPath,
        seq: issues.seq,
        createdAt: issues.createdAt,
      })
      .from(issues)
      .all()
    const byRepo = new Map<string, typeof rows>()
    for (const r of rows) {
      const rid = r.repoId ?? this.resolveRepoIdForPath(r.repoPath)
      const g = byRepo.get(rid)
      if (g) g.push(r)
      else byRepo.set(rid, [r])
    }
    const updates: { id: IssueId; seq: number }[] = []
    for (const group of byRepo.values()) {
      const counts = new Map<string, number>()
      for (const r of group) counts.set(r.repoPath, (counts.get(r.repoPath) ?? 0) + 1)
      const canonPath = [...counts.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0]![0]
      const bySeq = new Map<number, typeof group>()
      for (const r of group) {
        const g = bySeq.get(r.seq)
        if (g) g.push(r)
        else bySeq.set(r.seq, [r])
      }
      let maxSeq = group.reduce((m, r) => Math.max(m, r.seq), 0)
      for (const clash of bySeq.values()) {
        if (clash.length < 2) continue
        const ordered = [...clash].sort(
          (a, b) =>
            (a.repoPath === canonPath ? 0 : 1) - (b.repoPath === canonPath ? 0 : 1) ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        )
        for (const loser of ordered.slice(1)) updates.push({ id: loser.id, seq: ++maxSeq })
      }
    }
    if (updates.length === 0) return 0
    this.invalidateRowCache()
    // The span covers the UPDATE loop only. The read and the planning above are
    // deliberately outside it, which is what keeps the write window short; a
    // conversion must not widen the span to cover them.
    this.queries.transact(() => {
      for (const u of updates) {
        this.db.update(issues).set({ seq: u.seq }).where(eq(issues.id, u.id)).run()
      }
    })
    return updates.length
  }

  /** Repo-identity upgrade (#74): stamp repoId onto issues under repoPath.
   *  Called by the repos aggregate when a path-fallback id upgrades to the
   *  origin-derived one. Collision-safe under UNIQUE(repo_id, seq): when the
   *  upgrade merges two path-keyed buckets into one logical repo, any seq
   *  already taken in the target bucket is renumbered to the next free seq
   *  (oldest row first keeps its number), loudly logged. */
  assignRepoIdToIssuesUnder(repoId: RepoId, repoPath: string): void {
    // `LIKE ? || '/%'` matches at a PATH BOUNDARY: `/rootless` merely shares a
    // text prefix with `/root` and must not be swept in. The `rowid` tie-break is
    // load-bearing on equal `created_at`, and `rowid` is not a schema column, so
    // both stay as fragments.
    const rows = this.db
      .select({ id: issues.id, seq: issues.seq })
      .from(issues)
      .where(
        and(
          or(eq(issues.repoPath, repoPath), sql`${issues.repoPath} LIKE ${repoPath} || '/%'`),
          or(isNull(issues.repoId), ne(issues.repoId, repoId)),
        ),
      )
      .orderBy(asc(issues.createdAt), sql`rowid asc`)
      .all()
    if (rows.length === 0) return
    const highest = this.db
      .select({ m: max(issues.seq) })
      .from(issues)
      .where(eq(issues.repoId, repoId))
      .get()
    let next = (highest?.m ?? 0) + 1
    const taken = (seq: number) =>
      this.db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.repoId, repoId), eq(issues.seq, seq)))
        .get()
    this.invalidateRowCache()
    for (const r of rows) {
      let seq = r.seq
      const holder = taken(seq)
      if (holder && holder.id !== r.id) {
        while (taken(next)) next += 1
        seq = next
        next += 1
        log.warn(
          'repo-id upgrade merged buckets — reassigning a taken seq (issue ids are unchanged)',
          {
            repoId,
            issueId: r.id,
            takenSeq: r.seq,
            reassignedTo: seq,
          },
        )
      }
      this.db.update(issues).set({ repoId, seq }).where(eq(issues.id, r.id)).run()
    }
  }

  /**
   * Allocate the next session column letter for an issue (`A`, `B`, … `Z`, `AA`,
   * #474). Backed by the `issue_ref_letters` high-water counter so a letter is
   * NEVER reused within an issue — even after the session that held it is deleted.
   * Transactional: the read-increment-return is atomic, so two concurrent
   * allocations can never mint the same `POD-13-A`.
   */
  allocateSessionLetter(issueId: IssueId): string {
    return this.queries.transact(() => {
      const row = this.db
        .select({ nextIndex: issueRefLetters.nextIndex })
        .from(issueRefLetters)
        .where(eq(issueRefLetters.issueId, issueId))
        .get()
      const index = row?.nextIndex ?? 0
      this.db
        .insert(issueRefLetters)
        .values({ issueId, nextIndex: index + 1 })
        .onConflictDoUpdate({
          target: issueRefLetters.issueId,
          set: { nextIndex: index + 1 },
        })
        .run()
      return letterForIndex(index)
    })
  }

  /** Issues carrying no repo_id — read by the facade's boot refusal. A live
   *  writer cannot produce one (`upsertIssue` resolves a repo_id before it
   *  inserts), so a non-zero answer means a database from before POD-1360. */
  issuesMissingRepoId(): number {
    const r = this.db.select({ c: count() }).from(issues).where(isNull(issues.repoId)).get()
    return r?.c ?? 0
  }

  // ---- labels ----

  setIssueLabels(issueId: IssueId, labels: string[]): void {
    const clean = [...new Set(labels.filter((l) => typeof l === 'string' && l.trim()))].map((l) =>
      l.trim(),
    )
    this.db.delete(issueLabels).where(eq(issueLabels.issueId, issueId)).run()
    for (const l of clean) {
      // DECISION POD-3403 — `INSERT OR IGNORE` before the conversion. OR IGNORE
      // suppressed EVERY constraint violation including the foreign key onto
      // issues(id); ON CONFLICT DO NOTHING suppresses only the (issue_id, label)
      // conflict and lets the foreign key raise. The ruling is to leave such a
      // site unconverted, and that is not executable here: leaving it means
      // keeping `.prepare()`, which means keeping the raw handle, which keeps
      // this file on STAGE_A_UNCONVERTED. Converted literally and marked instead;
      // the difference is visible only for a label naming a missing issue.
      this.db.insert(issueLabels).values({ issueId, label: l }).onConflictDoNothing().run()
    }
  }

  getIssueLabels(issueId: IssueId): string[] {
    return this.db
      .select({ label: issueLabels.label })
      .from(issueLabels)
      .where(eq(issueLabels.issueId, issueId))
      .orderBy(asc(issueLabels.label))
      .all()
      .map((r) => r.label)
  }

  /** Labels for every issue in one ordered read — list serializers use this to
   * avoid preparing and running one query per issue at live board sizes. */
  listIssueLabelsByIssue(): Map<string, string[]> {
    const rows = this.db
      .select({ issueId: issueLabels.issueId, label: issueLabels.label })
      .from(issueLabels)
      .orderBy(asc(issueLabels.issueId), asc(issueLabels.label))
      .all()
    const byIssue = new Map<string, string[]>()
    for (const row of rows) {
      const labels = byIssue.get(row.issueId)
      if (labels) labels.push(row.label)
      else byIssue.set(row.issueId, [row.label])
    }
    return byIssue
  }

  listAllLabels(): string[] {
    return this.db
      .selectDistinct({ label: issueLabels.label })
      .from(issueLabels)
      .orderBy(asc(issueLabels.label))
      .all()
      .map((r) => r.label)
  }

  // ---- deps ----

  addIssueDep(fromId: IssueId, toId: IssueId, type = 'blocks'): void {
    // DECISION POD-3403 — see setIssueLabels: `INSERT OR IGNORE` also swallowed
    // the foreign key onto issues(id), and ON CONFLICT DO NOTHING does not.
    this.db.insert(issueDeps).values({ fromId, toId, type }).onConflictDoNothing().run()
  }

  removeIssueDep(fromId: IssueId, toId: IssueId, type?: string): void {
    if (type) {
      this.db
        .delete(issueDeps)
        .where(
          and(eq(issueDeps.fromId, fromId), eq(issueDeps.toId, toId), eq(issueDeps.type, type)),
        )
        .run()
    } else {
      this.db
        .delete(issueDeps)
        .where(and(eq(issueDeps.fromId, fromId), eq(issueDeps.toId, toId)))
        .run()
    }
  }

  /** SERIALIZATION EDGE: `to_id`/`from_id` come back untyped, so the row shape
   *  re-declares the id space they were stored under. `type` is a dep KIND, not
   *  an id, and stays a free string. */
  listIssueDeps(fromId: IssueId): { toId: IssueId; type: string }[] {
    return this.db
      .select({ toId: issueDeps.toId, type: issueDeps.type })
      .from(issueDeps)
      .where(eq(issueDeps.fromId, fromId))
      .orderBy(asc(issueDeps.toId), asc(issueDeps.type))
      .all()
  }

  /** EVERY dep edge, for the ledger's full-truth reconcile of the 'issueDep'
   *  kind [POD-822]. Ordered so the row set is stable across calls — reconcile
   *  diffs by id, but a stable order keeps the change log's appends readable and
   *  the tests' expectations deterministic. */
  listAllIssueDeps(): { fromId: IssueId; toId: IssueId; type: string }[] {
    return this.db
      .select({ fromId: issueDeps.fromId, toId: issueDeps.toId, type: issueDeps.type })
      .from(issueDeps)
      .orderBy(asc(issueDeps.fromId), asc(issueDeps.toId), asc(issueDeps.type))
      .all()
  }

  listDependents(toId: IssueId): { fromId: IssueId; type: string }[] {
    return this.db
      .select({ fromId: issueDeps.fromId, type: issueDeps.type })
      .from(issueDeps)
      .where(eq(issueDeps.toId, toId))
      .orderBy(asc(issueDeps.fromId), asc(issueDeps.type))
      .all()
  }

  // ---- comments ----

  addIssueComment(c: IssueCommentRow): void {
    this.db
      .insert(issueComments)
      .values({
        id: c.id,
        issueId: c.issueId,
        author: c.author,
        body: c.body,
        createdAt: c.createdAt,
        actor: c.actor ?? null,
        onBehalfOf: c.onBehalfOf ?? null,
      })
      .run()
  }

  listIssueComments(issueId: IssueId): IssueCommentRow[] {
    return this.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id))
      .all()
  }

  /** Comment count for ONE issue — the single-issue toWire path (#175). */
  countIssueComments(issueId: IssueId): number {
    const r = this.db
      .select({ n: count() })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .get()
    return r?.n ?? 0
  }

  /** Comment counts for ALL issues in one GROUP BY (#175) — list serializations
   *  share this map so N-issue toWire runs don't cost N comment queries (the
   *  same batching posture as the shared sessionList). Issues with no comments
   *  are simply absent (read as 0). */
  countIssueCommentsByIssue(): Map<string, number> {
    const rows = this.db
      .select({ issueId: issueComments.issueId, n: count() })
      .from(issueComments)
      .groupBy(issueComments.issueId)
      .all()
    return new Map(rows.map((r) => [r.issueId, r.n]))
  }

  /** Substring match over issue comment bodies — comments have no FTS (bounded
   *  volume), so LIKE is enough for the omni-search's comment source. */
  searchIssueComments(
    query: string,
    limit: number | null = 30,
  ): { issueId: IssueId; body: string; createdAt: string }[] {
    const q = query.trim()
    if (!q) return []
    const escaped = '%' + q.replace(/[%_]/g, (c) => '\\' + c) + '%'
    // The ESCAPE clause is what makes `%` and `_` in a user's query LITERAL.
    // drizzle's `like()` emits no ESCAPE, so this stays a fragment; dropping it
    // would make a query of `100%` match every comment.
    const base = this.db
      .select({
        issueId: issueComments.issueId,
        body: issueComments.body,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(sql`${issueComments.body} LIKE ${escaped} ESCAPE '\\'`)
      .orderBy(desc(issueComments.createdAt))
    return limit === null ? base.all() : base.limit(Math.min(200, Math.max(1, limit))).all()
  }

  // ---- issue mail (issue #103) ----

  /** SERIALIZATION EDGE: every field but one now arrives typed. `status` is a
   *  free TEXT column narrowed to the domain's union — a decision, not a driver
   *  artefact — and the projection drops `actor`/`on_behalf_of`, which the row
   *  type does not carry. */
  private mapIssueMessage(r: {
    id: string
    issueId: IssueId
    fromAuthor: string
    body: string
    createdAt: string
    status: string
    claimedBy: string | null
    claimedAt: string | null
  }): IssueMessageRow {
    return {
      id: r.id,
      issueId: r.issueId,
      fromAuthor: r.fromAuthor,
      body: r.body,
      createdAt: r.createdAt,
      status: r.status as IssueMessageRow['status'],
      claimedBy: r.claimedBy,
      claimedAt: r.claimedAt,
    }
  }

  addIssueMessage(m: IssueMessageRow): void {
    this.db
      .insert(issueMessages)
      .values({
        id: m.id,
        issueId: m.issueId,
        fromAuthor: m.fromAuthor,
        body: m.body,
        createdAt: m.createdAt,
        status: m.status,
        claimedBy: m.claimedBy,
        claimedAt: m.claimedAt,
      })
      .run()
  }

  getIssueMessage(id: string): IssueMessageRow | null {
    const r = this.db.select().from(issueMessages).where(eq(issueMessages.id, id)).get()
    return r ? this.mapIssueMessage(r) : null
  }

  listIssueMessages(
    issueId: IssueId,
    opts?: { status?: IssueMessageRow['status'] },
  ): IssueMessageRow[] {
    const rows = this.db
      .select()
      .from(issueMessages)
      .where(
        opts?.status
          ? and(eq(issueMessages.issueId, issueId), eq(issueMessages.status, opts.status))
          : eq(issueMessages.issueId, issueId),
      )
      .orderBy(asc(issueMessages.createdAt), asc(issueMessages.id))
      .all()
    return rows.map((r) => this.mapIssueMessage(r))
  }

  countUnreadIssueMessages(issueId: IssueId): number {
    const r = this.db
      .select({ n: count() })
      .from(issueMessages)
      .where(and(eq(issueMessages.issueId, issueId), eq(issueMessages.status, 'unread')))
      .get()
    return r?.n ?? 0
  }

  /**
   * Mark the given messages read FOR ONE USER.
   *
   * TWO WRITES, TWO CLASSES, and keeping them apart is the point (POD-1076).
   * `status` is the mail's DELIVERY state — a shared fact about the message, so
   * it stays on the message row and still only flips `unread` (idempotent; never
   * regresses a `claimed` message back to `read`). `read_at` is a fact about a
   * READER, so it lands in `issue_message_user_state` keyed `(user_id, id)`, and
   * it is written for EVERY named message rather than only the unread ones: my
   * having read a message somebody else already claimed is still true.
   */
  markIssueMessagesRead(userId: UserId, issueId: IssueId, ids: string[], readAt: string): void {
    requireUserId(userId)
    for (const id of ids) {
      // Only `unread` flips, so a `claimed` message never regresses to `read`.
      this.db
        .update(issueMessages)
        .set({ status: 'read' })
        .where(
          and(
            eq(issueMessages.issueId, issueId),
            eq(issueMessages.id, id),
            eq(issueMessages.status, 'unread'),
          ),
        )
        .run()
      // Written for EVERY named message, not only the unread ones.
      this.db
        .insert(issueMessageUserState)
        .values({ userId, issueMessageId: id, readAt })
        .onConflictDoUpdate({
          target: [issueMessageUserState.userId, issueMessageUserState.issueMessageId],
          set: { readAt },
        })
        .run()
    }
  }

  /** One user's tracker-mail read markers, `issueMessageId → readAt`. */
  listIssueMessageReadAt(userId: UserId): Record<string, string | null> {
    requireUserId(userId)
    const rows = this.db
      .select({
        issueMessageId: issueMessageUserState.issueMessageId,
        readAt: issueMessageUserState.readAt,
      })
      .from(issueMessageUserState)
      .where(eq(issueMessageUserState.userId, userId))
      .all()
    const out: Record<string, string | null> = {}
    for (const r of rows) out[r.issueMessageId] = r.readAt
    return out
  }

  // ---- per-user issue state (POD-1076): read, tuck-away, pin ----
  /**
   * One user's markers for every issue they have touched, `issueId → row`.
   * ADR 9 D3 rule 4's class: `issues.read_at` / `tucked_at` / `pinned` were
   * singleton columns until POD-1076 and are now keyed `(user_id, issue_id)`.
   *
   * An absent key means this person has done nothing to that issue. Rows with
   * all three markers null are deleted rather than kept (see {@link setIssueUserState}),
   * so absence is the only spelling.
   */
  listIssueUserState(userId: UserId): Map<string, StoredIssueUserState> {
    requireUserId(userId)
    const rows = this.db
      .select({
        issueId: issueUserState.issueId,
        readAt: issueUserState.readAt,
        tuckedAt: issueUserState.tuckedAt,
        pinnedAt: issueUserState.pinnedAt,
      })
      .from(issueUserState)
      .where(eq(issueUserState.userId, userId))
      .all()
    const out = new Map<string, StoredIssueUserState>()
    for (const r of rows) {
      out.set(r.issueId, { readAt: r.readAt, tuckedAt: r.tuckedAt, pinnedAt: r.pinnedAt })
    }
    return out
  }

  getIssueUserState(userId: UserId, issueId: IssueId): StoredIssueUserState | undefined {
    requireUserId(userId)
    const r = this.db
      .select({
        readAt: issueUserState.readAt,
        tuckedAt: issueUserState.tuckedAt,
        pinnedAt: issueUserState.pinnedAt,
      })
      .from(issueUserState)
      .where(and(eq(issueUserState.userId, userId), eq(issueUserState.issueId, issueId)))
      .get()
    return r ? { readAt: r.readAt, tuckedAt: r.tuckedAt, pinnedAt: r.pinnedAt } : undefined
  }

  /**
   * Write one user's markers for one issue. A PARTIAL patch: an absent key leaves
   * the stored value alone, so `setIssueUserState(u, i, { readAt: t })` cannot
   * silently un-pin an issue — the failure a whole-row upsert would make easy.
   *
   * A row whose three markers all end up null is DELETED, so the table holds only
   * issues a person has actually touched and "absent" keeps its single meaning.
   */
  setIssueUserState(userId: UserId, issueId: IssueId, patch: Partial<StoredIssueUserState>): void {
    requireUserId(userId)
    if (!issueId) throw new Error('issue user-state issue id is empty')
    const current = this.getIssueUserState(userId, issueId) ?? {
      readAt: null,
      tuckedAt: null,
      pinnedAt: null,
    }
    const next: StoredIssueUserState = {
      readAt: patch.readAt !== undefined ? patch.readAt : current.readAt,
      tuckedAt: patch.tuckedAt !== undefined ? patch.tuckedAt : current.tuckedAt,
      pinnedAt: patch.pinnedAt !== undefined ? patch.pinnedAt : current.pinnedAt,
    }
    if (next.readAt === null && next.tuckedAt === null && next.pinnedAt === null) {
      this.db
        .delete(issueUserState)
        .where(and(eq(issueUserState.userId, userId), eq(issueUserState.issueId, issueId)))
        .run()
      return
    }
    this.db
      .insert(issueUserState)
      .values({
        userId,
        issueId,
        readAt: next.readAt,
        tuckedAt: next.tuckedAt,
        pinnedAt: next.pinnedAt,
      })
      .onConflictDoUpdate({
        target: [issueUserState.userId, issueUserState.issueId],
        set: { readAt: next.readAt, tuckedAt: next.tuckedAt, pinnedAt: next.pinnedAt },
      })
      .run()
  }

  /** Drop every user's per-user rows for an issue. Called from the issue's own
   *  purge path: the rows are not the issue's (they follow the USER), but a
   *  hard-deleted issue leaves them addressing nothing. */
  purgeIssueUserState(issueId: IssueId): void {
    this.db.delete(issueUserState).where(eq(issueUserState.issueId, issueId)).run()
  }

  /** Atomic claim: exactly one caller wins; a second claim on the same message
   *  returns false. Single UPDATE guarded on status, so there is no read-then-write race. */
  claimIssueMessage(id: string, claimedBy: string, claimedAt: string): boolean {
    const r = this.db
      .update(issueMessages)
      .set({ status: 'claimed', claimedBy, claimedAt })
      .where(and(eq(issueMessages.id, id), ne(issueMessages.status, 'claimed')))
      .run()
    return r.changes === 1
  }

  deleteIssueMessagesForIssue(issueId: IssueId): void {
    this.db.delete(issueMessages).where(eq(issueMessages.issueId, issueId)).run()
  }

  deleteIssueChildRows(issueId: IssueId): void {
    this.db.delete(issueLabels).where(eq(issueLabels.issueId, issueId)).run()
    this.db
      .delete(issueDeps)
      .where(or(eq(issueDeps.fromId, issueId), eq(issueDeps.toId, issueId)))
      .run()
    this.db.delete(issueComments).where(eq(issueComments.issueId, issueId)).run()
    this.deleteIssueMessagesForIssue(issueId)
  }
}
