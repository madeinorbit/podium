// workspace-scoped (POD-6959)
import type { WriteScope } from '@podium/sync'
import { CommittedRows } from './committed-rows'
import { bareColumns, throughIndex } from './index-hints'
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
  Attribution,
  asIssueId,
  type IssueId,
  IssueStage,
  IssueUserState,
  isIssueClosed,
  isValidMachinePath,
  type MachineId,
  machinePathAncestors,
  machinePathSeparator,
  type RepoId,
  type UserId,
} from '@podium/model'
import { letterForIndex } from '@podium/protocol'
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  ne,
  not,
  notInArray,
  or,
  type Placeholder,
  type SQL,
  sql,
} from 'drizzle-orm'
import { textColumnClass } from '../migrations/pg/schema-classes'
import type { issues, issueTextRevisions, labels } from '../migrations/schema'
import { captureWrite } from '../sync/capture-pg'
import { dialectOf } from './executor/dialect-prepared'
import { applyAfterCommit, spanOpen } from './executor/executor'
import { operationLoader } from './executor/operation-loader'
import { currentReadScope, readScopeSlot } from './executor/read-scope'
import type {
  StoreDrizzle,
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
  placeholdersFor,
  prepared,
  preparedFamily,
  preparedGlobal,
  sameWorkspace,
  shapeOf,
  WORKSPACE,
} from './executor/sync-drizzle'
import { parseStringArray, requireUserId } from './helpers'
import { IssueGitStatesRepository } from './issue-git-states'
import {
  commentCountsOfIssues,
  deferralsOf,
  depsFromIssues,
  depsToIssues,
  type IssueListingInput,
  type IssueListingShape,
  issueCountGroups,
  issueListing,
  issueStatTotals,
  labelsOfIssues,
  listingKey,
  listingValues,
  liveChildrenOf,
  perChunk,
  sortScopeOf,
} from './issue-listings'
import { IssuePanelRepository } from './issue-panel'
import { StaleIssueRevisionError } from './issue-revision'
import { prefixUpperBound } from './prefix-range'
import type {
  IssueAccessRow,
  IssueCommentRow,
  IssueMessageRow,
  IssueRow,
  IssueTextField,
  IssueTextRevisionRow,
  StoredIssueUserState,
} from './types'

export const LEGACY_WORKTREE_MIGRATION = 'legacy_worktree_machine_ids_v1'

const log = createLogger('server:store')

// Every query this repository runs, prepared once per store [POD-6147]. The
// statements that WRITE the `issues` table are the exception in placement, not
// in kind: they are prepared inside their own method (see `issueWrites`).

const issueRevision = prepared((db, t) =>
  db
    .select({ revision: t.issues.revision })
    .from(t.issues)
    .where(inWorkspace(t.issues, eq(t.issues.id, param(t.issues.id, 'id'))))
    .prepare(),
)

const issueById = prepared((db, t) =>
  db
    .select()
    .from(t.issues)
    .where(inWorkspace(t.issues, eq(t.issues.id, param(t.issues.id, 'id'))))
    .prepare(),
)

/** Closed or deleted, by the same rule as `isIssueClosed`; a NULL id is skipped. */
function closedOf(
  rows: readonly {
    id: unknown
    stage: unknown
    closedReason: string | null
    deletedAt: string | null
  }[],
): Set<string> {
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

/** The closure columns for a set of ids; one shape per IN-list size. */
const issueClosureRowsOf = preparedFamily((db, t, size: number) =>
  db
    .select({
      id: t.issues.id,
      stage: t.issues.stage,
      closedReason: t.issues.closedReason,
      deletedAt: t.issues.deletedAt,
    })
    .from(t.issues)
    .where(inWorkspace(t.issues, inListOf(t.issues.id, size, 'ids')))
    .prepare(),
)

/** One shape per IN-list size bucket; `getIssues` chunks at 500. */
const issuesByIds = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.issues)
    .where(inWorkspace(t.issues, inListOf(t.issues.id, size, 'ids')))
    .prepare(),
)

/**
 * The live, unarchived children of these parents, whole rows (POD-7431): one
 * level of a flight deck's subtree. Through `idx_issues_children` by name, as
 * `liveChildrenOf`: without it SQLite walks every issue in the listing order
 * and keeps the few children, so the read grew with the workspace.
 */
const liveUnarchivedChildRows = preparedFamily((db, t, size: number) =>
  db
    .select(bareColumns(t.issues))
    .from(throughIndex(db, t.issues, 'idx_issues_children'))
    .where(
      inWorkspace(
        t.issues,
        inListOf(t.issues.parentId, size, 'ids'),
        isNull(t.issues.deletedAt),
        eq(t.issues.archived, false),
      ),
    )
    .prepare(),
)

/**
 * The live, unarchived issues these sessions started (POD-7431): the
 * provenance a flight deck grafts under its author's issue. Through the
 * partial index, which SQLite would otherwise cost as a walk of every issue.
 */
const liveIssuesStartedBy = preparedFamily((db, t, size: number) =>
  db
    .select(bareColumns(t.issues))
    .from(throughIndex(db, t.issues, 'idx_issues_started_by'))
    .where(
      inWorkspace(
        t.issues,
        inListOf(t.issues.startedBySession, size, 'ids'),
        isNull(t.issues.deletedAt),
        eq(t.issues.archived, false),
      ),
    )
    .prepare(),
)

/**
 * What the sharing rules read of an issue (POD-7153): the execution pointers
 * and the checkout path, plus the four columns the quarantine checks. Never
 * the bodies, which a decision does not read.
 */
const issueAccessByIds = preparedFamily((db, t, size: number) =>
  db
    .select({
      id: t.issues.id,
      repoPath: t.issues.repoPath,
      stage: t.issues.stage,
      title: t.issues.title,
      ownerUserId: t.issues.ownerUserId,
      machineId: t.issues.machineId,
      worktreePath: t.issues.worktreePath,
      coordinatorSessionId: t.issues.coordinatorSessionId,
      startedBySession: t.issues.startedBySession,
      humanQuestionAskedBy: t.issues.humanQuestionAskedBy,
    })
    .from(t.issues)
    .where(inWorkspace(t.issues, inListOf(t.issues.id, size, 'ids')))
    .prepare(),
)

const liveIssueParentEdges = prepared((db, t) =>
  db
    .select({ id: t.issues.id, parentId: t.issues.parentId })
    .from(t.issues)
    .where(inWorkspace(t.issues, isNull(t.issues.deletedAt)))
    .prepare(),
)

const issueRowsOfRepo = prepared((db, t) =>
  db
    .select()
    .from(t.issues)
    .where(
      inWorkspace(
        t.issues,
        or(
          eq(t.issues.repoId, param(t.issues.repoId, 'repoId')),
          and(isNull(t.issues.repoId), eq(t.issues.repoPath, param(t.issues.repoPath, 'repoPath'))),
        ),
      ),
    )
    .orderBy(asc(t.issues.seq))
    .prepare(),
)

const allIssueRows = prepared((db, t) =>
  db
    .select()
    .from(t.issues)
    .where(inWorkspace(t.issues))
    .orderBy(asc(t.issues.repoPath), asc(t.issues.seq))
    .prepare(),
)

/**
 * One page of every issue row, in id order: from the first id (`start`, which
 * includes an empty id) or after the last one read (`after`). The full-truth
 * reconcile walks the whole table this way through the primary key instead of
 * reading the issue map (POD-6158).
 */
const issueRowsPage = preparedFamily((db, t, from: 'start' | 'after') =>
  db
    .select()
    .from(t.issues)
    .where(
      inWorkspace(
        t.issues,
        from === 'start'
          ? gte(t.issues.id, param(t.issues.id, 'id'))
          : gt(t.issues.id, param(t.issues.id, 'id')),
      ),
    )
    .orderBy(asc(t.issues.id))
    .limit(sql.placeholder('limit'))
    .prepare(),
)

/**
 * The worktree paths that could contain a folder, as stored keys (POD-6155).
 *
 * `literal` answers POSIX-style roots, whose membership is literal
 * (`isMachinePathWithinRoot`): the folder itself and every prefix that ends
 * just before or just after a `/`. `folded` answers Windows-style roots, whose
 * membership ignores ASCII case and separator spelling: the folder's
 * normalized ancestors, ASCII-lowercased, each with and without a trailing
 * backslash, matched against `lower(replace(worktree_path, '/', '\'))`.
 * Both are candidates only; the caller decides membership with `isMemberCwd`.
 */
export function folderOwnerKeys(cwd: string): { literal: string[]; folded: string[] } {
  const literal = new Set<string>([cwd])
  for (let at = cwd.indexOf('/'); at >= 0; at = cwd.indexOf('/', at + 1)) {
    if (at > 0) literal.add(cwd.slice(0, at))
    literal.add(cwd.slice(0, at + 1))
  }
  const folded = new Set<string>()
  if (machinePathSeparator(cwd) === '\\' && isValidMachinePath(cwd)) {
    for (const ancestor of machinePathAncestors(cwd)) {
      const key = ancestor.replace(/[A-Z]/g, (char) => char.toLowerCase())
      folded.add(key)
      if (!key.endsWith('\\')) folded.add(`${key}\\`)
    }
  }
  return { literal: [...literal], folded: [...folded] }
}

/**
 * `lower(<text>)` in byte order on both engines. SQLite compares bytes; Postgres gives
 * a computed text the database's collation unless it says `COLLATE "C"` (POD-6958
 * design 2.3, rule 13). The collation goes outside `lower()`, so the expression stays
 * the one the `lower(…)` indexes are built on, and `lower()` itself folds ASCII only,
 * as SQLite's does, because its argument is a `COLLATE "C"` column.
 */
const loweredText = (db: StoreDrizzle, text: SQL): SQL =>
  dialectOf(db) === 'pg' ? sql`lower(${text}) COLLATE "C"` : sql`lower(${text})`

const foldedWorktreePath = (db: StoreDrizzle, t: StoreTables) =>
  loweredText(db, sql`replace(${t.issues.worktreePath}, '/', '\\')`)

/** Live issues at any of the candidate keys: one index search per arm, no
 *  sort (the caller orders the few rows). Both arms share one IN-list size, so
 *  the family has one shape per size bucket. */
const worktreeOwnersOf = preparedFamily((db, t, size: number) => {
  const columns = {
    id: t.issues.id,
    repoPath: t.issues.repoPath,
    seq: t.issues.seq,
    worktreePath: t.issues.worktreePath,
    archived: t.issues.archived,
    machineId: t.issues.machineId,
  }
  const literal = db
    .select(columns)
    .from(t.issues)
    .where(
      inWorkspace(
        t.issues,
        inListOf(t.issues.worktreePath, size, 'lit'),
        isNull(t.issues.deletedAt),
      ),
    )
  const folded = db
    .select(columns)
    .from(t.issues)
    .where(
      inWorkspace(
        t.issues,
        inArray(
          foldedWorktreePath(db, t),
          Array.from({ length: size }, (_, index) => sql.placeholder(`fold${index}`)),
        ),
        isNotNull(t.issues.worktreePath),
        isNull(t.issues.deletedAt),
      ),
    )
  return literal.unionAll(folded).prepare()
})

/**
 * The live tasks with a worktree on these machines, with their assignees
 * (POD-6291): the rows whose machine path changes hands with the machine's
 * custody. Walks `idx_issues_worktree`, the live worktrees only, named with
 * INDEXED BY for the reason `openChat` in `store/messages.ts` gives; read on a
 * custody change, never per request. Postgres has no index hints: its planner picks
 * the partial index from the same predicate.
 */
const liveWorktreesOnMachines = preparedFamily((db, t, size: number) =>
  db
    // Selected by name: drizzle refuses a table column over a raw FROM.
    .select({
      id: sql<string>`${sql.identifier('id')}`,
      machineId: sql<string | null>`${sql.identifier('machine_id')}`,
      ownerUserId: sql<string>`${sql.identifier('owner_user_id')}`,
    })
    .from(
      dialectOf(db) === 'pg' ? sql`${t.issues}` : sql`${t.issues} INDEXED BY idx_issues_worktree`,
    )
    .where(
      inWorkspace(
        t.issues,
        sql`${t.issues.worktreePath} IS NOT NULL AND ${t.issues.deletedAt} IS NULL`,
        inListOf(t.issues.machineId, size, 'machineIds'),
      ),
    )
    .prepare(),
)

/** Candidate keys per statement and arm; two arms stay far below SQLite's
 *  bound-parameter limit. */
const WORKTREE_OWNER_CHUNK = 2048

const deleteRefLettersOf = prepared((db, t) =>
  db
    .delete(t.issueRefLetters)
    .where(
      inWorkspace(
        t.issueRefLetters,
        eq(t.issueRefLetters.issueId, param(t.issueRefLetters.issueId, 'issueId')),
      ),
    )
    .prepare(),
)

const deleteOrphanRefLetters = prepared((db, t) =>
  db
    .delete(t.issueRefLetters)
    .where(
      inWorkspace(
        t.issueRefLetters,
        notInArray(
          t.issueRefLetters.issueId,
          // This workspace's issues only, in the subquery's own scope.
          db.select({ id: t.issues.id }).from(t.issues).where(inWorkspace(t.issues)),
        ),
      ),
    )
    .prepare(),
)

const highestSeqOfRepo = prepared((db, t) =>
  db
    .select({ m: max(t.issues.seq) })
    .from(t.issues)
    .where(inWorkspace(t.issues, eq(t.issues.repoId, param(t.issues.repoId, 'repoId'))))
    .prepare(),
)

const issueSeqRows = prepared((db, t) =>
  db
    .select({
      id: t.issues.id,
      repoId: t.issues.repoId,
      repoPath: t.issues.repoPath,
      machineId: t.issues.machineId,
      seq: t.issues.seq,
      createdAt: t.issues.createdAt,
    })
    .from(t.issues)
    .where(inWorkspace(t.issues))
    .prepare(),
)

/**
 * The path itself, or a path under it: the second arm is the range of paths
 * that start with `<path>/` (`under` .. `below`, see {@link prefixUpperBound}),
 * which idx_issues_repo seeks. The `/` is the PATH BOUNDARY: `/rootless` merely
 * shares a text prefix with `/root` and must not be swept in. The tie-break on
 * equal `created_at` is load-bearing (the first row keeps a colliding seq), so it
 * is the primary key, on both engines: Postgres has no `rowid` (POD-6958 design
 * 2.3; the order this replaced was SQLite's insertion order).
 */
const issuesUnderPathOutsideRepo = prepared((db, t) =>
  db
    .select({ id: t.issues.id, seq: t.issues.seq })
    .from(t.issues)
    .where(
      inWorkspace(
        t.issues,
        or(
          eq(t.issues.repoPath, param(t.issues.repoPath, 'repoPath')),
          and(
            gte(t.issues.repoPath, param(t.issues.repoPath, 'under')),
            lt(t.issues.repoPath, param(t.issues.repoPath, 'below')),
          ),
        ),
        or(isNull(t.issues.repoId), ne(t.issues.repoId, param(t.issues.repoId, 'repoId'))),
      ),
    )
    .orderBy(asc(t.issues.createdAt), asc(t.issues.id))
    .prepare(),
)

const issueIdAtSeq = prepared((db, t) =>
  db
    .select({ id: t.issues.id })
    .from(t.issues)
    .where(
      inWorkspace(
        t.issues,
        eq(t.issues.repoId, param(t.issues.repoId, 'repoId')),
        eq(t.issues.seq, param(t.issues.seq, 'seq')),
      ),
    )
    .prepare(),
)

/**
 * The reference columns of the issues at one sequence number (POD-6158).
 * Deleted rows are included: a reference names a row, whatever its state, as
 * the boot map's reference index always did. Ordered by repository path, then
 * id, which is the boot map's order for rows it loaded.
 */
const issueRefColumns = (t: StoreTables) => ({
  id: t.issues.id,
  repoId: t.issues.repoId,
  repoPath: t.issues.repoPath,
  machineId: t.issues.machineId,
  seq: t.issues.seq,
  // Read only for the structural quarantine.
  stage: t.issues.stage,
  title: t.issues.title,
})

const issueRefsAtSeq = prepared((db, t) =>
  db
    .select(issueRefColumns(t))
    .from(t.issues)
    .where(inWorkspace(t.issues, eq(t.issues.seq, param(t.issues.seq, 'seq'))))
    .orderBy(asc(t.issues.repoPath), asc(t.issues.id))
    .prepare(),
)

/** {@link issueRefsAtSeq} for several numbers; one shape per IN-list size. */
const issueRefsAtSeqsOf = preparedFamily((db, t, size: number) =>
  db
    .select(issueRefColumns(t))
    .from(t.issues)
    .where(inWorkspace(t.issues, inListOf(t.issues.seq, size, 'seqs')))
    .orderBy(asc(t.issues.seq), asc(t.issues.repoPath), asc(t.issues.id))
    .prepare(),
)

/** At most one row: `(repo_id, seq)` is unique. */
const issueRefAtRepoSeq = prepared((db, t) =>
  db
    .select(issueRefColumns(t))
    .from(t.issues)
    .where(
      inWorkspace(
        t.issues,
        eq(t.issues.repoId, param(t.issues.repoId, 'repoId')),
        eq(t.issues.seq, param(t.issues.seq, 'seq')),
      ),
    )
    .prepare(),
)

/** Rows the repo-id heal has not stamped yet; their repo is resolved by path.
 *  Unordered: the caller orders the union with the stamped row. */
const legacyIssueRefsAtSeq = prepared((db, t) =>
  db
    .select(issueRefColumns(t))
    .from(t.issues)
    .where(
      inWorkspace(t.issues, eq(t.issues.seq, param(t.issues.seq, 'seq')), isNull(t.issues.repoId)),
    )
    .prepare(),
)

/** A user-state row with every marker and record null: what an absent row means. */
const NO_STORED_USER_STATE: Required<StoredIssueUserState> = {
  readAt: null,
  tuckedAt: null,
  joinedAt: null,
  joinedVia: null,
  assignedAt: null,
  assignedBy: null,
}

/** A stored row's markers and personal records (POD-6290), as the store hands them out. */
const storedUserStateOf = (r: {
  readAt: string | null
  tuckedAt: string | null
  joinedAt: string | null
  joinedVia: 'start' | 'agent' | 'join' | null
  assignedAt: string | null
  assignedBy: UserId | null
}): Required<StoredIssueUserState> => ({
  readAt: r.readAt,
  tuckedAt: r.tuckedAt,
  joinedAt: r.joinedAt,
  joinedVia: r.joinedVia,
  assignedAt: r.assignedAt,
  assignedBy: r.assignedBy,
})

/** One user's markers for a set of issues; one shape per IN-list size. */
const issueUserStatesOf = preparedFamily((db, t, size: number) =>
  db
    .select({
      issueId: t.issueUserState.issueId,
      readAt: t.issueUserState.readAt,
      tuckedAt: t.issueUserState.tuckedAt,
      joinedAt: t.issueUserState.joinedAt,
      joinedVia: t.issueUserState.joinedVia,
      assignedAt: t.issueUserState.assignedAt,
      assignedBy: t.issueUserState.assignedBy,
    })
    .from(t.issueUserState)
    .where(
      inWorkspace(
        t.issueUserState,
        eq(t.issueUserState.userId, param(t.issueUserState.userId, 'userId')),
        inListOf(t.issueUserState.issueId, size, 'ids'),
      ),
    )
    .prepare(),
)

const refLetterNextIndex = prepared((db, t) =>
  db
    .select({ nextIndex: t.issueRefLetters.nextIndex })
    .from(t.issueRefLetters)
    .where(
      inWorkspace(
        t.issueRefLetters,
        eq(t.issueRefLetters.issueId, param(t.issueRefLetters.issueId, 'issueId')),
      ),
    )
    .prepare(),
)

const upsertRefLetterNextIndex = prepared((db, t) =>
  db
    .insert(t.issueRefLetters)
    .values({
      workspaceId: WORKSPACE,
      issueId: sql.placeholder('issueId'),
      nextIndex: sql.placeholder('nextIndex'),
    })
    .onConflictDoUpdate({
      target: [t.issueRefLetters.workspaceId, t.issueRefLetters.issueId],
      set: { nextIndex: sql.placeholder('nextIndex') },
    })
    .prepare(),
)

const issuesMissingRepoIdCount = prepared((db, t) =>
  db
    .select({ c: count() })
    .from(t.issues)
    .where(inWorkspace(t.issues, isNull(t.issues.repoId)))
    .prepare(),
)

/** The install's upgrade mark (`meta`, an install key): the backfill runs once per database. */
const legacyWorktreeReceipt = preparedGlobal((db, t) =>
  db
    .select({ value: t.meta.value })
    .from(t.meta)
    .where(eq(t.meta.key, LEGACY_WORKTREE_MIGRATION))
    .prepare(),
)

const liveMachineById = prepared((db, t) =>
  db
    .select({ id: t.machines.id })
    .from(t.machines)
    .where(
      inWorkspace(
        t.machines,
        eq(t.machines.id, param(t.machines.id, 'id')),
        isNull(t.machines.revokedAt),
      ),
    )
    .prepare(),
)

const insertLegacyWorktreeReceipt = preparedGlobal((db, t) =>
  captureWrite(
    db.insert(t.meta).values({ key: LEGACY_WORKTREE_MIGRATION, value: sql.placeholder('value') }),
  ).prepare(),
)

/**
 * The two terms `backfillLegacyWorktreeMachineIds` is built from, in one place
 * so the count and the UPDATE can never drift into disagreeing about which
 * rows are candidates and which are contradicted. The host machine is the
 * `hostMachineId` placeholder of whichever statement embeds them.
 */
const legacyWorktreeTerms = prepared((db, t) => ({
  /** Owns a worktree, names no machine — the residue a v0.1.0 build leaves. */
  legacyWorktreeRow: and(isNotNull(t.issues.worktreePath), isNull(t.issues.machineId)),
  /**
   * Correlated on `issues.id` in the WHERE, so drizzle qualifies it back to
   * the OUTER row rather than self-joining; the select list is the literal
   * `1`, so there is no unqualified column here to silently rebind onto
   * `sessions`. `legacyWorktreeBackfillSql` pins both properties.
   */
  contradictorySession: exists(
    db
      .select({ one: sql`1` })
      .from(t.sessions)
      .where(
        inWorkspace(
          t.sessions,
          or(eq(t.sessions.issueId, t.issues.id), eq(t.sessions.refIssueId, t.issues.id)),
          ne(t.sessions.machineId, param(t.sessions.machineId, 'hostMachineId')),
        ),
      ),
  ),
}))

/** Counts the candidates the contradiction evidence tells the backfill to leave alone. */
const legacyWorktreeSkippedBuilder = prepared((db, t) => {
  const { legacyWorktreeRow, contradictorySession } = legacyWorktreeTerms(db)
  return db
    .select({ c: count() })
    .from(t.issues)
    .where(inWorkspace(t.issues, legacyWorktreeRow, contradictorySession))
})

const legacyWorktreeSkipped = prepared((db) => legacyWorktreeSkippedBuilder(db).prepare())

/** Labels by lower-cased name, one shape per IN-list size (see {@link inListSize}). */
const labelsNamed = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.labels)
    .where(
      inWorkspace(
        t.labels,
        inArray(
          loweredText(db, sql`${t.labels.name}`),
          Array.from({ length: size }, (_, index) => sql.placeholder(`name${index}`)),
        ),
      ),
    )
    .prepare(),
)

/** A label's colour and/or description; one shape per set of patched columns. */
const patchLabel = preparedFamily((db, t, shape: string) =>
  db
    .update(t.labels)
    .set(placeholdersFor(shape) as Partial<typeof labels.$inferInsert>)
    .where(inWorkspace(t.labels, eq(t.labels.id, param(t.labels.id, 'id'))))
    .prepare(),
)

const insertLabelRow = prepared((db, t) =>
  db
    .insert(t.labels)
    .values({
      workspaceId: WORKSPACE,
      name: sql.placeholder('name'),
      color: sql.placeholder('color'),
      description: sql.placeholder('description'),
      createdAt: sql.placeholder('createdAt'),
    })
    .returning()
    .prepare(),
)

const labelVocabulary = prepared((db, t) =>
  db
    .select()
    .from(t.labels)
    .where(inWorkspace(t.labels))
    .orderBy(asc(loweredText(db, sql`${t.labels.name}`)))
    .prepare(),
)

const deleteLabelsOf = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.issueLabels)
      .where(
        inWorkspace(
          t.issueLabels,
          eq(t.issueLabels.issueId, param(t.issueLabels.issueId, 'issueId')),
        ),
      ),
  ).prepare(),
)

const insertLabel = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.issueLabels)
      .values({
        workspaceId: WORKSPACE,
        issueId: sql.placeholder('issueId'),
        labelId: sql.placeholder('labelId'),
      })
      .onConflictDoNothing(),
  ).prepare(),
)

const labelsOf = prepared((db, t) =>
  db
    .select({ label: t.labels.name })
    .from(t.issueLabels)
    .innerJoin(
      t.labels,
      and(sameWorkspace(t.labels, t.issueLabels), eq(t.labels.id, t.issueLabels.labelId)),
    )
    .where(
      inWorkspace(
        t.issueLabels,
        eq(t.issueLabels.issueId, param(t.issueLabels.issueId, 'issueId')),
      ),
    )
    .orderBy(asc(t.labels.name))
    .prepare(),
)

/** The issues carrying these labels (POD-6920: a label's rename reaches them). */
// Through `idx_issue_labels_label_id` by name on SQLite (POD-7034): from 16
// labels the statistics (a label's issues averaged over the labels in use) price
// the seeks above a walk of every issue's labels.
const issuesOfLabels = preparedFamily((db, t, size: number) =>
  db
    // Selected by name: drizzle refuses a table column over a raw FROM.
    .selectDistinct({ issueId: sql<string>`${sql.identifier('issue_id')}` })
    .from(throughIndex(db, t.issueLabels, 'idx_issue_labels_label_id'))
    .where(inWorkspace(t.issueLabels, inListOf(t.issueLabels.labelId, size, 'ids')))
    .prepare(),
)

const insertDep = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.issueDeps)
      .values({
        workspaceId: WORKSPACE,
        fromId: sql.placeholder('fromId'),
        toId: sql.placeholder('toId'),
        type: sql.placeholder('type'),
      })
      .onConflictDoNothing(),
  ).prepare(),
)

const deleteDepOfType = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.issueDeps)
      .where(
        inWorkspace(
          t.issueDeps,
          eq(t.issueDeps.fromId, param(t.issueDeps.fromId, 'fromId')),
          eq(t.issueDeps.toId, param(t.issueDeps.toId, 'toId')),
          eq(t.issueDeps.type, param(t.issueDeps.type, 'type')),
        ),
      ),
  ).prepare(),
)

const deleteDepsBetween = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.issueDeps)
      .where(
        inWorkspace(
          t.issueDeps,
          eq(t.issueDeps.fromId, param(t.issueDeps.fromId, 'fromId')),
          eq(t.issueDeps.toId, param(t.issueDeps.toId, 'toId')),
        ),
      ),
  ).prepare(),
)

const depsFrom = prepared((db, t) =>
  db
    .select({ toId: t.issueDeps.toId, type: t.issueDeps.type })
    .from(t.issueDeps)
    .where(inWorkspace(t.issueDeps, eq(t.issueDeps.fromId, param(t.issueDeps.fromId, 'fromId'))))
    .orderBy(asc(t.issueDeps.toId), asc(t.issueDeps.type))
    .prepare(),
)

const allDeps = prepared((db, t) =>
  db
    .select({ fromId: t.issueDeps.fromId, toId: t.issueDeps.toId, type: t.issueDeps.type })
    .from(t.issueDeps)
    .where(inWorkspace(t.issueDeps))
    .orderBy(asc(t.issueDeps.fromId), asc(t.issueDeps.toId), asc(t.issueDeps.type))
    .prepare(),
)

const depsTo = prepared((db, t) =>
  db
    .select({ fromId: t.issueDeps.fromId, type: t.issueDeps.type })
    .from(t.issueDeps)
    .where(inWorkspace(t.issueDeps, eq(t.issueDeps.toId, param(t.issueDeps.toId, 'toId'))))
    .orderBy(asc(t.issueDeps.fromId), asc(t.issueDeps.type))
    .prepare(),
)

const insertComment = prepared((db, t) =>
  db
    .insert(t.issueComments)
    .values({
      workspaceId: WORKSPACE,
      id: sql.placeholder('id'),
      issueId: sql.placeholder('issueId'),
      author: sql.placeholder('author'),
      body: sql.placeholder('body'),
      createdAt: sql.placeholder('createdAt'),
      actor: sql.placeholder('actor'),
      onBehalfOf: sql.placeholder('onBehalfOf'),
      mentions: sql.placeholder('mentions'),
    })
    .prepare(),
)

const commentsOf = prepared((db, t) =>
  db
    .select()
    .from(t.issueComments)
    .where(
      inWorkspace(
        t.issueComments,
        eq(t.issueComments.issueId, param(t.issueComments.issueId, 'issueId')),
      ),
    )
    .orderBy(asc(t.issueComments.createdAt), asc(t.issueComments.id))
    .prepare(),
)

const commentById = prepared((db, t) =>
  db
    .select()
    .from(t.issueComments)
    .where(inWorkspace(t.issueComments, eq(t.issueComments.id, param(t.issueComments.id, 'id'))))
    .prepare(),
)

/** Rewrites the body and the edit stamp only: the author columns never move. */
const editComment = prepared((db, t) =>
  db
    .update(t.issueComments)
    .set({
      body: sql.placeholder('body') as unknown as string,
      editedAt: sql.placeholder('editedAt') as unknown as string,
      editedBy: sql.placeholder('editedBy') as unknown as string,
      editedOnBehalfOf: sql.placeholder('editedOnBehalfOf') as unknown as string,
      mentions: sql.placeholder('mentions') as unknown as string,
    })
    .where(inWorkspace(t.issueComments, eq(t.issueComments.id, param(t.issueComments.id, 'id'))))
    .prepare(),
)

const deleteComment = prepared((db, t) =>
  db
    .delete(t.issueComments)
    .where(inWorkspace(t.issueComments, eq(t.issueComments.id, param(t.issueComments.id, 'id'))))
    .prepare(),
)

const insertTextRevision = prepared((db, t) =>
  db
    .insert(t.issueTextRevisions)
    .values({
      workspaceId: WORKSPACE,
      issueId: sql.placeholder('issueId'),
      field: sql.placeholder('field'),
      body: sql.placeholder('body'),
      source: sql.placeholder('source'),
      restoredFrom: sql.placeholder('restoredFrom'),
      issueRevision: sql.placeholder('issueRevision'),
      actor: sql.placeholder('actor'),
      onBehalfOf: sql.placeholder('onBehalfOf'),
      createdAt: sql.placeholder('createdAt'),
    })
    .prepare(),
)

/** One field's history, oldest first: the index order, so no sort. */
const textRevisionsOf = prepared((db, t) =>
  db
    .select()
    .from(t.issueTextRevisions)
    .where(
      inWorkspace(
        t.issueTextRevisions,
        eq(t.issueTextRevisions.issueId, param(t.issueTextRevisions.issueId, 'issueId')),
        eq(t.issueTextRevisions.field, sql.placeholder('field')),
      ),
    )
    .orderBy(asc(t.issueTextRevisions.id))
    .prepare(),
)

/** Does this field have any history yet? Index-only probe. */
const anyTextRevisionOf = prepared((db, t) =>
  db
    .select({ id: t.issueTextRevisions.id })
    .from(t.issueTextRevisions)
    .where(
      inWorkspace(
        t.issueTextRevisions,
        eq(t.issueTextRevisions.issueId, param(t.issueTextRevisions.issueId, 'issueId')),
        eq(t.issueTextRevisions.field, sql.placeholder('field')),
      ),
    )
    .limit(1)
    .prepare(),
)

const textRevisionById = prepared((db, t) =>
  db
    .select()
    .from(t.issueTextRevisions)
    .where(inWorkspace(t.issueTextRevisions, eq(t.issueTextRevisions.id, sql.placeholder('id'))))
    .prepare(),
)

const deleteTextRevisionsOf = prepared((db, t) =>
  db
    .delete(t.issueTextRevisions)
    .where(
      inWorkspace(
        t.issueTextRevisions,
        eq(t.issueTextRevisions.issueId, param(t.issueTextRevisions.issueId, 'issueId')),
      ),
    )
    .prepare(),
)

const commentCountOf = prepared((db, t) =>
  db
    .select({ n: count() })
    .from(t.issueComments)
    .where(
      inWorkspace(
        t.issueComments,
        eq(t.issueComments.issueId, param(t.issueComments.issueId, 'issueId')),
      ),
    )
    .prepare(),
)

const commentCountsByIssue = prepared((db, t) =>
  db
    .select({ issueId: t.issueComments.issueId, n: count() })
    .from(t.issueComments)
    .where(inWorkspace(t.issueComments))
    .groupBy(t.issueComments.issueId)
    .prepare(),
)

/**
 * The ESCAPE clause is what makes `%` and `_` in a user's query LITERAL.
 * drizzle's `like()` emits no ESCAPE, so this stays a fragment; dropping it
 * would make a query of `100%` match every comment.
 */
const commentSearch = preparedFamily((db, t, limited: 'all' | 'limited') => {
  const base = db
    .select({
      issueId: t.issueComments.issueId,
      body: t.issueComments.body,
      createdAt: t.issueComments.createdAt,
    })
    .from(t.issueComments)
    .where(
      inWorkspace(
        t.issueComments,
        // SQLite's LIKE folds ASCII case; Postgres's ILIKE over a `COLLATE "C"`
        // column folds ASCII only, which is the same match.
        dialectOf(db) === 'pg'
          ? sql`${t.issueComments.body} ILIKE ${sql.placeholder('pattern')} ESCAPE '\\'`
          : sql`${t.issueComments.body} LIKE ${sql.placeholder('pattern')} ESCAPE '\\'`,
      ),
    )
    .orderBy(desc(t.issueComments.createdAt))
  return limited === 'all' ? base.prepare() : base.limit(sql.placeholder('limit')).prepare()
})

const insertMessage = prepared((db, t) =>
  db
    .insert(t.issueMessages)
    .values({
      workspaceId: WORKSPACE,
      id: sql.placeholder('id'),
      issueId: sql.placeholder('issueId'),
      fromAuthor: sql.placeholder('fromAuthor'),
      body: sql.placeholder('body'),
      createdAt: sql.placeholder('createdAt'),
      status: sql.placeholder('status'),
      claimedBy: sql.placeholder('claimedBy'),
      claimedAt: sql.placeholder('claimedAt'),
    })
    .prepare(),
)

const messageById = prepared((db, t) =>
  db
    .select()
    .from(t.issueMessages)
    .where(inWorkspace(t.issueMessages, eq(t.issueMessages.id, param(t.issueMessages.id, 'id'))))
    .prepare(),
)

const messagesOf = prepared((db, t) =>
  db
    .select()
    .from(t.issueMessages)
    .where(
      inWorkspace(
        t.issueMessages,
        eq(t.issueMessages.issueId, param(t.issueMessages.issueId, 'issueId')),
      ),
    )
    .orderBy(asc(t.issueMessages.createdAt), asc(t.issueMessages.id))
    .prepare(),
)

const messagesOfWithStatus = prepared((db, t) =>
  db
    .select()
    .from(t.issueMessages)
    .where(
      inWorkspace(
        t.issueMessages,
        eq(t.issueMessages.issueId, param(t.issueMessages.issueId, 'issueId')),
        eq(t.issueMessages.status, param(t.issueMessages.status, 'status')),
      ),
    )
    .orderBy(asc(t.issueMessages.createdAt), asc(t.issueMessages.id))
    .prepare(),
)

const unreadMessageCountOf = prepared((db, t) =>
  db
    .select({ n: count() })
    .from(t.issueMessages)
    .where(
      inWorkspace(
        t.issueMessages,
        eq(t.issueMessages.issueId, param(t.issueMessages.issueId, 'issueId')),
        eq(t.issueMessages.status, 'unread'),
      ),
    )
    .prepare(),
)

/** Only `unread` flips, so a `claimed` message never regresses to `read`. */
const markMessageRead = prepared((db, t) =>
  db
    .update(t.issueMessages)
    .set({ status: 'read' })
    .where(
      inWorkspace(
        t.issueMessages,
        eq(t.issueMessages.issueId, param(t.issueMessages.issueId, 'issueId')),
        eq(t.issueMessages.id, param(t.issueMessages.id, 'id')),
        eq(t.issueMessages.status, 'unread'),
      ),
    )
    .prepare(),
)

const upsertMessageReadAt = prepared((db, t) =>
  db
    .insert(t.issueMessageUserState)
    .values({
      workspaceId: WORKSPACE,
      userId: sql.placeholder('userId'),
      issueMessageId: sql.placeholder('issueMessageId'),
      readAt: sql.placeholder('readAt'),
    })
    .onConflictDoUpdate({
      target: [
        t.issueMessageUserState.workspaceId,
        t.issueMessageUserState.userId,
        t.issueMessageUserState.issueMessageId,
      ],
      set: { readAt: sql.placeholder('readAt') },
    })
    .prepare(),
)

const messageReadAtOf = prepared((db, t) =>
  db
    .select({
      issueMessageId: t.issueMessageUserState.issueMessageId,
      readAt: t.issueMessageUserState.readAt,
    })
    .from(t.issueMessageUserState)
    .where(
      inWorkspace(
        t.issueMessageUserState,
        eq(t.issueMessageUserState.userId, param(t.issueMessageUserState.userId, 'userId')),
      ),
    )
    .prepare(),
)

const issueUserStateFeedColumns = (t: StoreTables) => ({
  userId: t.issueUserState.userId,
  entityId: t.issueUserState.issueId,
  readAt: t.issueUserState.readAt,
  tuckedAt: t.issueUserState.tuckedAt,
  joinedAt: t.issueUserState.joinedAt,
  joinedVia: t.issueUserState.joinedVia,
  assignedAt: t.issueUserState.assignedAt,
  assignedBy: t.issueUserState.assignedBy,
})

const allIssueUserStateRows = prepared((db, t) =>
  db
    .select(issueUserStateFeedColumns(t))
    .from(t.issueUserState)
    .where(inWorkspace(t.issueUserState))
    .prepare(),
)

const issueUserStateRowsOf = prepared((db, t) =>
  db
    .select(issueUserStateFeedColumns(t))
    .from(t.issueUserState)
    .where(
      inWorkspace(
        t.issueUserState,
        eq(t.issueUserState.issueId, param(t.issueUserState.issueId, 'issueId')),
      ),
    )
    .prepare(),
)

const issueUserStateOne = prepared((db, t) =>
  db
    .select({
      readAt: t.issueUserState.readAt,
      tuckedAt: t.issueUserState.tuckedAt,
      joinedAt: t.issueUserState.joinedAt,
      joinedVia: t.issueUserState.joinedVia,
      assignedAt: t.issueUserState.assignedAt,
      assignedBy: t.issueUserState.assignedBy,
    })
    .from(t.issueUserState)
    .where(
      inWorkspace(
        t.issueUserState,
        eq(t.issueUserState.userId, param(t.issueUserState.userId, 'userId')),
        eq(t.issueUserState.issueId, param(t.issueUserState.issueId, 'issueId')),
      ),
    )
    .prepare(),
)

const deleteIssueUserStateOne = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.issueUserState)
      .where(
        inWorkspace(
          t.issueUserState,
          eq(t.issueUserState.userId, param(t.issueUserState.userId, 'userId')),
          eq(t.issueUserState.issueId, param(t.issueUserState.issueId, 'issueId')),
        ),
      ),
  ).prepare(),
)

const upsertIssueUserState = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.issueUserState)
      .values({
        workspaceId: WORKSPACE,
        userId: sql.placeholder('userId'),
        issueId: sql.placeholder('issueId'),
        readAt: sql.placeholder('readAt'),
        tuckedAt: sql.placeholder('tuckedAt'),
        joinedAt: sql.placeholder('joinedAt'),
        joinedVia: sql.placeholder('joinedVia'),
        assignedAt: sql.placeholder('assignedAt'),
        assignedBy: sql.placeholder('assignedBy'),
      })
      .onConflictDoUpdate({
        target: [t.issueUserState.workspaceId, t.issueUserState.userId, t.issueUserState.issueId],
        set: {
          readAt: sql.placeholder('readAt'),
          tuckedAt: sql.placeholder('tuckedAt'),
          joinedAt: sql.placeholder('joinedAt'),
          joinedVia: sql.placeholder('joinedVia'),
          assignedAt: sql.placeholder('assignedAt'),
          assignedBy: sql.placeholder('assignedBy'),
        },
      }),
  ).prepare(),
)

const deleteIssueUserStateOf = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.issueUserState)
      .where(
        inWorkspace(
          t.issueUserState,
          eq(t.issueUserState.issueId, param(t.issueUserState.issueId, 'issueId')),
        ),
      ),
  ).prepare(),
)

/** Single UPDATE guarded on status, so there is no read-then-write race. */
const claimMessage = prepared((db, t) =>
  db
    .update(t.issueMessages)
    .set({
      status: 'claimed',
      claimedBy: sql.placeholder('claimedBy'),
      claimedAt: sql.placeholder('claimedAt'),
    })
    .where(
      inWorkspace(
        t.issueMessages,
        eq(t.issueMessages.id, param(t.issueMessages.id, 'id')),
        ne(t.issueMessages.status, 'claimed'),
      ),
    )
    .prepare(),
)

const deleteMessagesOf = prepared((db, t) =>
  db
    .delete(t.issueMessages)
    .where(
      inWorkspace(
        t.issueMessages,
        eq(t.issueMessages.issueId, param(t.issueMessages.issueId, 'issueId')),
      ),
    )
    .prepare(),
)

const deleteDepsTouching = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.issueDeps)
      .where(
        inWorkspace(
          t.issueDeps,
          or(
            eq(t.issueDeps.fromId, param(t.issueDeps.fromId, 'issueId')),
            eq(t.issueDeps.toId, param(t.issueDeps.toId, 'issueId')),
          ),
        ),
      ),
  ).prepare(),
)

const deleteCommentsOf = prepared((db, t) =>
  db
    .delete(t.issueComments)
    .where(
      inWorkspace(
        t.issueComments,
        eq(t.issueComments.issueId, param(t.issueComments.issueId, 'issueId')),
      ),
    )
    .prepare(),
)

/**
 * The columns `upsertIssue`'s conflict branch rewrites. The seven it omits — id,
 * owner_user_id, visibility, created_by_actor, created_by_on_behalf_of, seq and
 * created_at — are the row's identity and its provenance.
 *
 * `repo_path` is rewritten (POD-6158). A start or resume that moves an issue
 * onto another machine moves its repository path with its worktree (POD-1461),
 * and that move used to reach only the in-memory issue map: the stored row kept
 * the old path and a restart put it back.
 */
/** The statement-family key prefix of an upsert that also rewrites the owner. */
const REASSIGN_SHAPE_PREFIX = 'reassign|'

const UPSERT_ISSUE_SET_COLUMNS = [
  'repoPath',
  'repoId',
  'title',
  'description',
  'brief',
  'stage',
  'worktreePath',
  'branch',
  'parentBranch',
  'defaultAgent',
  'defaultModel',
  'defaultEffort',
  'agentProfileId',
  'machineId',
  'linearId',
  'linearIdentifier',
  'linearUrl',
  'suggestedStage',
  'suggestedReason',
  'blockedBy',
  'dependencyNote',
  'prUrl',
  'priority',
  'type',
  'assignee',
  'parentId',
  'acceptance',
  'dueAt',
  'deferUntil',
  'closedReason',
  'closedAt',
  'closedByUserId',
  'landedAt',
  'landedSha',
  'supersededBy',
  'duplicateOf',
  'sortKey',
  'estimateMin',
  'needsHuman',
  'humanQuestion',
  'humanQuestionOptions',
  'humanQuestionAskedBy',
  'humanQuestionAskedAt',
  'humanQuestionAttribution',
  'updatedAt',
  'archived',
  'origin',
  'audience',
  'draft',
  'deletedAt',
  'revision',
  'coordinatorSessionId',
  'startedBySession',
] as const

/** A prepared write on the `issues` table that RETURNS the rows it wrote. */
interface IssueRowsWrite {
  all(values: Record<string, unknown>): Promise<(typeof issues.$inferSelect)[]>
}

/** RETAINED EXTERNAL-INPUT BRAND CASTS: compatibility methods accept raw issue
 * ids and repo-path resolution still returns a string. Query/write casts decode
 * those inputs; selected issue fields are schema-branded. */
/** A live issue that may own a folder: what membership and its tie-break read. */
function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size))
  return out
}

/** A listing's order, for merging the chunks of a long IN-list. */
function sortListing(rows: IssueRow[], order: IssueListingShape['order']): IssueRow[] {
  const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  return rows.sort((a, b) => {
    if (order === 'repo-seq') return text(a.repoId ?? '', b.repoId ?? '') || a.seq - b.seq
    if (order === 'path-seq')
      return text(a.repoPath, b.repoPath) || a.seq - b.seq || text(a.id, b.id)
    if (order === 'updated')
      return (
        Date.parse(a.updatedAt) - Date.parse(b.updatedAt) ||
        text(a.repoPath, b.repoPath) ||
        a.seq - b.seq
      )
    if (order === 'priority-seq') {
      return (
        a.priority - b.priority || a.seq - b.seq || text(a.repoPath, b.repoPath) || text(a.id, b.id)
      )
    }
    return a.seq - b.seq || text(a.repoPath, b.repoPath) || text(a.id, b.id)
  })
}

/**
 * The structural quarantine every issue read applies (see
 * {@link IssuesRepository.listIssueRows}): a row whose id, repository path,
 * stage or title is not a string poisons every consumer, so it is skipped and
 * logged, and stays absent (POD-6158).
 */
function structurallySound(r: {
  id: unknown
  repoPath: unknown
  stage: unknown
  title: unknown
}): boolean {
  return (
    typeof r.id === 'string' &&
    typeof r.repoPath === 'string' &&
    typeof r.stage === 'string' &&
    typeof r.title === 'string'
  )
}

/** The columns a reference is resolved over (POD-6158). */
export interface IssueRefRow {
  id: IssueId
  repoId: RepoId | null
  repoPath: string
  machineId: MachineId | null
  seq: number
}

/** Structurally corrupt rows are skipped, as every issue read quarantines them. */
function issueRefRows(
  rows: readonly {
    id: unknown
    repoId: string | null
    repoPath: unknown
    machineId: string | null
    seq: number
    stage: unknown
    title: unknown
  }[],
): IssueRefRow[] {
  return rows.flatMap((row) =>
    structurallySound(row)
      ? [
          {
            id: asIssueId(row.id as string),
            repoId: (row.repoId ?? null) as RepoId | null,
            repoPath: row.repoPath as string,
            machineId: (row.machineId ?? null) as MachineId | null,
            seq: row.seq,
          },
        ]
      : [],
  )
}

export interface WorktreeOwnerRow {
  id: IssueId
  repoPath: string
  seq: number
  worktreePath: string | null
  archived: boolean
  /** The machine the issue is homed on, or null when it has none. */
  machineId: MachineId | null
}

/** `ORDER BY repo_path, seq` in SQLite's BINARY collation: UTF-8 bytes, then
 *  sequence. Each repo path is encoded once per row, not per comparison. */
function byRepoPathThenSeq<T extends { repoPath: string; seq: number }>(rows: Iterable<T>): T[] {
  const keyed = Array.from(rows, (row) => ({ row, key: Buffer.from(row.repoPath) }))
  keyed.sort((a, b) => Buffer.compare(a.key, b.key) || a.row.seq - b.row.seq)
  return keyed.map(({ row }) => row)
}

/** One row of the label vocabulary (POD-6106). `id` is server-local. */
export type LabelRow = typeof labels.$inferSelect

export class IssuesRepository {
  readonly panel: IssuePanelRepository
  readonly gitStates: IssueGitStatesRepository
  readonly committed: CommittedRows<typeof issues.$inferSelect>
  private sessionRefWrite: (<T>(write: () => Promise<T>) => Promise<T>) | undefined

  /** Run an issue write that sessions reference as a change-log commit, so
   *  their records are appended in the source transaction (POD-6920). */
  setSessionRefWrite(write: NonNullable<IssuesRepository['sessionRefWrite']>): void {
    this.sessionRefWrite = write
  }

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
   * lifetime is now a {@link ReadScope}, which a pass opens around itself.
   * Unscoped reads get a fresh cache per read; no microtask owns its lifetime.
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
  /**
   * The broadcast viewer's markers, one row per issue, batched per operation
   * (POD-6158). Keyed `userId NUL issueId`; a report pass over many issues asks
   * for each in the same tick and this sends one `IN (...)` query per user.
   */
  private readonly userStateLoader = operationLoader<string, StoredIssueUserState>(
    async (keys) => {
      const byUser = new Map<string, IssueId[]>()
      for (const key of keys) {
        const at = key.indexOf('\u0000')
        const user = key.slice(0, at)
        const ids = byUser.get(user) ?? []
        ids.push(asIssueId(key.slice(at + 1)))
        byUser.set(user, ids)
      }
      const found = new Map<string, StoredIssueUserState>()
      for (const [user, ids] of byUser) {
        const size = inListSize(ids.length)
        const values = inListValues(ids, size, 'ids')
        values.userId = user
        for (const r of await issueUserStatesOf(this.db, size).all(values)) {
          found.set(`${user}\u0000${r.issueId}`, storedUserStateOf(r))
        }
      }
      return found
    },
    { copy: (state) => ({ ...state }), perOperation: true },
  )
  /**
   * Issue rows by id, batched per operation (POD-6158): the per-row reads of a
   * listing's authorization pass, asked together, are one `IN (...)` query.
   * Shares {@link getIssues}' mapping and quarantine; every caller gets its
   * own copy.
   */
  /** {@link loadIssueAccess}'s loader: the same scope and invalidation as {@link rowLoader}. */
  private readonly accessLoader = operationLoader<string, IssueAccessRow>(
    async (ids) => {
      const out = new Map<string, IssueAccessRow>()
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500)
        const size = inListSize(chunk.length)
        for (const r of await issueAccessByIds(this.db, size).all(
          inListValues(chunk.map(asIssueId), size, 'ids'),
        )) {
          if (!structurallySound(r)) continue
          out.set(r.id, {
            id: r.id,
            ownerUserId: r.ownerUserId,
            machineId: r.machineId,
            worktreePath: r.worktreePath,
            coordinatorSessionId: r.coordinatorSessionId,
            startedBySession: r.startedBySession ?? null,
            humanQuestionAskedBy: r.humanQuestionAskedBy ?? null,
          })
        }
      }
      return out
    },
    { copy: (row) => ({ ...row }), perOperation: true },
  )

  private readonly rowLoader = operationLoader<string, IssueRow>(
    async (ids) => await this.readIssuesByIds(ids),
    {
      copy: (row) => ({
        ...row,
        blockedBy: [...row.blockedBy],
        humanQuestionOptions: row.humanQuestionOptions
          ? [...row.humanQuestionOptions]
          : row.humanQuestionOptions,
      }),
      perOperation: true,
    },
  )
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  /**
   * THE `issues`-TABLE WRITES, PREPARED INSIDE THEIR OWN METHOD [POD-6147].
   *
   * Prepared once like every other statement here, but defined at the write
   * site rather than at module level: `store-issues-row-cache-writers.test.ts`
   * requires every builder that writes `issues` to sit inside a method that
   * calls `invalidateRowCache()` before it (POD-1939), and a module-level
   * definition has no method. Each is built on its method's first run, after
   * that method's invalidation, and held for the repository's life — one
   * repository per store, so this is once per store, as module-level
   * `prepared` would be.
   */
  private readonly issueWrites: {
    upsert?: (db: WorkspaceDb, shape: string) => IssueRowsWrite
    shippingStage?: (db: WorkspaceDb) => IssueRowsWrite
    remove?: (db: WorkspaceDb) => IssueRowsWrite
    seq?: (db: WorkspaceDb) => IssueRowsWrite
    repoIdAndSeq?: (db: WorkspaceDb) => IssueRowsWrite
    legacyMachine?: (db: WorkspaceDb) => IssueRowsWrite
  } = {}

  constructor(
    queries: WorkspaceQueries,
    /** Repos-aggregate lookup: stable repo_id for an issue's repoPath. */
    private readonly resolveRepoIdForPath: (
      repoPath: string,
      machineId?: MachineId | null,
    ) => string | Promise<string>,
  ) {
    this.panel = new IssuePanelRepository(queries)
    this.gitStates = new IssueGitStatesRepository(queries)
    this.committed = new CommittedRows(queries.createOrJoinTransaction, 'issues')
    // The per-operation loaders are invalidated after each write (rowsWritten)
    // AND after each commit of one, which makes their memos exact inside write
    // spans (POD-6189, operation-loader.ts). Deleting an issue cascades to its
    // markers, so the marker loader follows the issue feed too.
    this.committed.subscribe(() => this.rowsWritten())
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * The query layer. `WorkspaceQueries` is wiring and is named here and nowhere else
   * (spec rule 34), so a call site reads as a query.
   *
   * A GETTER, not a field (rule 34a): once transaction routing is ambient
   * (rule 35) this resolves the ENCLOSING transaction on every access, and a
   * field frozen at construction could never do that. B1 changes this one line.
   */
  protected get db(): WorkspaceDb {
    return this.scope
  }

  /** Every issue-row WRITE calls this BEFORE the write: the frame stops caching,
   *  and whatever it had already cached is dropped.
   *
   *  Enforced, not remembered (POD-1939): `store-issues-row-cache-writers.test.ts`
   *  reads this file, finds every statement writing the `issues` table, and fails
   *  unless the enclosing method invalidates first — so a NEW write path is
   *  caught the day it is added. It also explains why the handle is not wrapped
   *  to do this automatically. */
  private async invalidateRowCache(): Promise<void> {
    const held = currentReadScope().slot(this.rowCacheSlot)
    held.rows.clear()
    held.disabled = true
    this.rowsWritten()
  }

  /** Every `issues` write goes through here: the commit feed, then the
   *  per-operation loaders invalidated after the write (POD-6158). */
  private async writeRows(
    query: () => Promise<(typeof issues.$inferSelect)[]>,
    operation: 'upsert' | 'delete',
    refIssueIds: readonly IssueId[] = [],
  ): Promise<{ changes: number }> {
    const write = async () => {
      const result = await this.committed.write(query, operation)
      // A frame cache may hold the old issue. Invalidate inside the source
      // write, before its dependent session is built.
      this.rowsWritten()
      return result
    }
    return refIssueIds.length > 0 && this.sessionRefWrite
      ? await this.sessionRefWrite(write)
      : await write()
  }

  private rowsWritten(): void {
    this.rowLoader.invalidate()
    this.accessLoader.invalidate()
    this.userStateLoader.invalidate()
  }

  /** A marker write: invalidated after it and, inside a span, after its commit. */
  private userStateWritten(): void {
    this.userStateLoader.invalidate()
    if (spanOpen())
      applyAfterCommit(() => this.userStateLoader.invalidate(), 'issue-user-state:loader')
  }

  /** The current scope's cache, opened on first use and discarded when the
   *  scope ends. Undefined once a write in this scope has disabled caching. */
  private async frameRows(): Promise<Map<string, IssueRow | null> | undefined> {
    const held = currentReadScope().slot(this.rowCacheSlot)
    return held.disabled ? undefined : held.rows
  }

  async upsertIssue(
    _scope: WriteScope,
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
    opts?: {
      expectedRevision: number | null
      /**
       * REASSIGNMENT (POD-6287, design §2.2/§4.3): rewrite `owner_user_id`, the
       * task's one accountable human, which every other write leaves alone. Only
       * the reassign path passes it, and only with a pinned revision, so of two
       * reassignments cut from one revision the second is refused rather than
       * silently overwriting the first.
       */
      reassign?: true
    },
  ): Promise<void> {
    await this.invalidateRowCache()
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
    // The upsert owns its revision assignment (ADR 2 D3). Each upsert that
    // changes the row gets a fresh revision. The guard below skips an upsert
    // that changes no stored column and keeps the existing revision (POD-6768).
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
    // The issue record carries the stored revision. A skipped upsert changes
    // no column, so nothing is captured. A changed column advances the
    // revision so replicas receive the new precondition token.
    const current = await issueRevision(this.db).get({ id: row.id })
    if (opts) {
      const found = current?.revision ?? null
      if (found !== opts.expectedRevision) {
        throw new StaleIssueRevisionError(row.id, opts.expectedRevision, found)
      }
    }
    row.revision = (current?.revision ?? 0) + 1
    // The column set is the schema's, and the two halves are deliberately
    // different: `values` carries every column, `set` carries only the columns a
    // SECOND write may change. The seven the update omits — id, owner_user_id,
    // visibility, created_by_actor, created_by_on_behalf_of, seq and created_at —
    // are the row's identity and its provenance, and the upsert has never
    // rewritten them (see UPSERT_ISSUE_SET_COLUMNS on repo_path).
    const values = {
      id: row.id,
      ownerUserId: row.ownerUserId,
      visibility: row.visibility,
      createdByActor: row.createdByActor ?? row.ownerUserId,
      createdByOnBehalfOf: row.createdByOnBehalfOf,
      repoPath: row.repoPath,
      repoId:
        row.repoId ?? ((await this.resolveRepoIdForPath(row.repoPath, row.machineId)) as RepoId),
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
      agentProfileId: row.agentProfileId ?? null,
      machineId: row.machineId ?? null,
      linearId: row.linearId,
      linearIdentifier: row.linearIdentifier,
      linearUrl: row.linearUrl,
      suggestedStage: row.suggestedStage,
      suggestedReason: row.suggestedReason,
      blockedBy: JSON.stringify(blockedBy),
      dependencyNote: row.dependencyNote,
      prUrl: row.prUrl,
      priority: row.priority,
      type: row.type,
      assignee: row.assignee,
      parentId: row.parentId,
      acceptance: row.acceptance,
      dueAt: row.dueAt,
      deferUntil: row.deferUntil,
      closedReason: row.closedReason,
      closedAt: row.closedAt ?? null,
      closedByUserId: row.closedByUserId ?? null,
      landedAt: row.landedAt ?? null,
      landedSha: row.landedSha ?? null,
      supersededBy: row.supersededBy,
      duplicateOf: row.duplicateOf,
      sortKey: row.sortKey ?? null,
      estimateMin: row.estimateMin,
      needsHuman: row.needsHuman,
      humanQuestion: row.humanQuestion,
      humanQuestionOptions: row.humanQuestionOptions?.length
        ? JSON.stringify(row.humanQuestionOptions)
        : null,
      humanQuestionAskedBy: row.humanQuestionAskedBy ?? null,
      humanQuestionAskedAt: row.humanQuestionAskedAt ?? null,
      humanQuestionAttribution: row.humanQuestionAttribution
        ? JSON.stringify(row.humanQuestionAttribution)
        : null,
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
    // The SHAPE is the set of keys this row actually sets: drizzle renders an
    // undefined `values` key as NULL and drops an undefined `set` key, so a
    // row with an undefined column is a different statement, as it always was.
    const upsert = (this.issueWrites.upsert ??= preparedFamily((db, t, key: string) => {
      const reassign = key.startsWith(REASSIGN_SHAPE_PREFIX)
      const placeholders = placeholdersFor(reassign ? key.slice(REASSIGN_SHAPE_PREFIX.length) : key)
      const set: Record<string, Placeholder> = {}
      for (const column of reassign
        ? [...UPSERT_ISSUE_SET_COLUMNS, 'ownerUserId' as const]
        : UPSERT_ISSUE_SET_COLUMNS) {
        const placeholder = placeholders[column]
        if (placeholder !== undefined) set[column] = placeholder
      }
      // Compare the columns this statement sets, including optional ownership
      // reassignment and updatedAt (activity for recency and unread). Separate
      // issue panel records are compared by their own builders. SQLite's
      // `IS NOT` between two values is Postgres's `IS DISTINCT FROM`, and a
      // `json` column compares as its text there, as SQLite compares it
      // (POD-6958 design 2.3, rule 7).
      const pg = dialectOf(db) === 'pg'
      const changed = Object.keys(set)
        .filter((column) => column !== 'revision')
        .map((column) => {
          const stored = t.issues[column as keyof typeof issues.$inferInsert]
          const proposed = sql`excluded.${sql.identifier(stored.name)}`
          if (!pg) return sql`${stored} IS NOT ${proposed}`
          return textColumnClass('issues', stored.name) === 'json'
            ? sql`CAST(${stored} AS TEXT) IS DISTINCT FROM CAST(${proposed} AS TEXT)`
            : sql`${stored} IS DISTINCT FROM ${proposed}`
        })
      return captureWrite(
        db
          .insert(t.issues)
          .values({
            ...placeholders,
            workspaceId: WORKSPACE,
          } as unknown as typeof issues.$inferInsert)
          .onConflictDoUpdate({
            target: [t.issues.workspaceId, t.issues.id],
            set: set as unknown as Partial<typeof issues.$inferInsert>,
            setWhere: sql.join(changed, sql` OR `),
          })
          .returning(),
      ).prepare()
    }))
    const written = await this.writeRows(
      async () =>
        await upsert(
          this.db,
          opts?.reassign ? `${REASSIGN_SHAPE_PREFIX}${shapeOf(values)}` : shapeOf(values),
        ).all(values),
      'upsert',
      // An existing issue's full-row write carries the birth-ref inputs too.
      // Name its dependents conservatively; unchanged records append nothing.
      current ? [row.id] : [],
    )
    // On a skipped upsert, the draft returned to the caller carries the same
    // revision as the stored row.
    if (written.changes === 0 && current) row.revision = current.revision ?? undefined
  }

  /** Internal Shipping custody seam. Ordinary issue CRUD never calls this.
   * Callers bind it to ship-order create/settlement with SessionStore.transact;
   * the expected-stage predicate is the admission/settlement CAS. */
  async transitionShippingStage(
    id: IssueId,
    expectedStage: Extract<IssueStage, 'review' | 'shipping'>,
    nextStage: Extract<IssueStage, 'shipping' | 'review' | 'done'>,
    updatedAt: string,
  ): Promise<IssueRow> {
    const legal =
      (expectedStage === 'review' && nextStage === 'shipping') ||
      (expectedStage === 'shipping' && (nextStage === 'review' || nextStage === 'done'))
    if (!legal) {
      throw new Error(`illegal shipping issue-stage transition ${expectedStage} → ${nextStage}`)
    }
    await this.invalidateRowCache()
    // ONE statement, and it stays one: the fence (`stage = expectedStage` plus
    // `deleted_at IS NULL`) and the write are the compare-and-swap. Splitting the
    // read out would turn the CAS into a race. `revision` is bumped from its own
    // stored value, so the expression references the column rather than a bound
    // parameter.
    const transition = (this.issueWrites.shippingStage ??= prepared((db, t) =>
      captureWrite(
        db
          .update(t.issues)
          .set({
            stage: sql.placeholder('nextStage'),
            updatedAt: sql.placeholder('updatedAt'),
            revision: sql`COALESCE(${t.issues.revision}, 0) + 1`,
          })
          .where(
            inWorkspace(
              t.issues,
              eq(t.issues.id, param(t.issues.id, 'id')),
              eq(t.issues.stage, param(t.issues.stage, 'expectedStage')),
              isNull(t.issues.deletedAt),
            ),
          )
          .returning(),
      ).prepare(),
    ))
    const result = await this.writeRows(
      async () => await transition(this.db).all({ id, expectedStage, nextStage, updatedAt }),
      'upsert',
    )
    if (result.changes !== 1) {
      throw new Error(`issue ${id} shipping stage fence failed: expected ${expectedStage}`)
    }
    const row = await this.getIssue(id)
    if (!row) throw new Error(`issue ${id} disappeared after shipping transition`)
    return row
  }

  async getIssue(id: string): Promise<IssueRow | null> {
    const cache = await this.frameRows()
    const hit = cache?.get(id)
    if (hit !== undefined) return hit === null ? null : { ...hit }
    const r = await issueById(this.db).get({ id: asIssueId(id) })
    const mapped = r ? await issueFromRow(r) : null
    cache?.set(id, mapped)
    return mapped === null ? null : { ...mapped }
  }

  /** One issue row, batched with the other loads of this tick and memoized for
   *  the operation (POD-6158). Deleted rows included. */
  async loadIssue(id: string): Promise<IssueRow | undefined> {
    return await this.rowLoader.load(id)
  }

  /**
   * What the sharing rules read of these issues (POD-7153), by the same
   * quarantine as {@link loadIssues}: an issue {@link loadIssues} would skip is
   * absent here too. One `IN (…)` read per 500, without the bodies.
   */
  async loadIssueAccess(ids: Iterable<string>): Promise<Map<string, IssueAccessRow>> {
    const out = new Map<string, IssueAccessRow>()
    for (const [id, row] of await this.accessLoader.loadMany(ids)) if (row) out.set(id, row)
    return out
  }

  /** {@link loadIssue} for many ids; absent ids are absent from the map. */
  async loadIssues(ids: Iterable<string>): Promise<Map<string, IssueRow>> {
    const out = new Map<string, IssueRow>()
    for (const [id, row] of await this.rowLoader.loadMany(ids)) if (row) out.set(id, row)
    return out
  }

  /** The loader's batch: rows by id in one statement per 500, quarantined. */
  private async readIssuesByIds(ids: readonly string[]): Promise<Map<string, IssueRow>> {
    const out = new Map<string, IssueRow>()
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      const size = inListSize(chunk.length)
      for (const r of await issuesByIds(this.db, size).all(
        inListValues(chunk.map(asIssueId), size, 'ids'),
      )) {
        try {
          if (!structurallySound(r)) {
            log.error('quarantined a corrupt issue row — skipped', { issueId: r.id ?? null })
            continue
          }
          out.set(r.id, await issueFromRow(r))
        } catch (err) {
          log.error('quarantined a corrupt issue row — skipped', { issueId: r.id ?? null, err })
        }
      }
    }
    return out
  }

  /**
   * One issue row, read now, never from the read scope's memo (POD-6158).
   *
   * For the rows a write is drafted from. A memo inside an operation could hand
   * back a row read before another operation's commit, and the draft's
   * revision pin would then refuse a write against the latest commit; this
   * read always sees the latest commit.
   */
  async getIssueLive(id: string): Promise<IssueRow | null> {
    const r = await issueById(this.db).get({ id: asIssueId(id) })
    if (!r) return null
    if (!structurallySound(r)) {
      log.error('quarantined a corrupt issue row — skipped', { issueId: r.id ?? null })
      return null
    }
    return await issueFromRow(r)
  }

  /** Does a row with this id exist, deleted or not (POD-6158)? */
  async hasIssue(id: string): Promise<boolean> {
    return (await issueRevision(this.db).get({ id: asIssueId(id) })) !== undefined
  }

  /** {@link issueRefsAt} for several sequence numbers in one statement per 500,
   *  keyed by number (POD-6158). */
  async issueRefsAtSeqs(seqs: Iterable<number>): Promise<Map<number, IssueRefRow[]>> {
    const unique = [...new Set(seqs)]
    const out = new Map<number, IssueRefRow[]>()
    for (let at = 0; at < unique.length; at += 500) {
      const chunk = unique.slice(at, at + 500)
      const size = inListSize(chunk.length)
      for (const row of issueRefRows(
        await issueRefsAtSeqsOf(this.db, size).all(inListValues(chunk, size, 'seqs')),
      )) {
        const rows = out.get(row.seq) ?? []
        rows.push(row)
        out.set(row.seq, rows)
      }
    }
    return out
  }

  /**
   * The issues a reference with this sequence number can name (POD-6158): every
   * repository's row at `seq`, or, given a repository, its row plus the legacy
   * rows the repo-id heal has not stamped (their repository is decided by the
   * caller's path resolver). Rows whose id or repository path is not a string
   * are skipped, as every issue read quarantines them.
   */
  async issueRefsAt(seq: number, repoId?: RepoId): Promise<IssueRefRow[]> {
    return issueRefRows(
      repoId === undefined
        ? await issueRefsAtSeq(this.db).all({ seq })
        : [
            ...(await issueRefAtRepoSeq(this.db).all({ repoId, seq })),
            ...(await legacyIssueRefsAtSeq(this.db).all({ seq })),
          ],
    )
  }

  // ---- listings in SQL (POD-6191) -------------------------------------------

  /**
   * The issue rows of one listing shape (`issue-listings.ts`): filtered, made
   * visible to `reader` and ordered in SQL. `parents`/`ids` lists longer than
   * one statement's 500 are read in chunks and merged in the shape's order.
   * Structurally corrupt rows are skipped, as every issue read skips them.
   */
  async listIssueRowsWhere(
    shape: IssueListingShape,
    input: IssueListingInput = {},
  ): Promise<IssueRow[]> {
    const list = input.parents ?? input.ids
    const key =
      shape.parents !== undefined ? 'parents' : shape.ids !== undefined ? 'ids' : undefined
    const chunks = key && list ? chunked([...new Set(list)], 500) : [undefined]
    // A limit bounds one statement; merged chunks would each take their own.
    if (shape.limit && chunks.length > 1) throw new Error('A limited listing reads one statement')
    const raw: (typeof issues.$inferSelect)[] = []
    for (const chunk of chunks) {
      if (chunk !== undefined && chunk.length === 0) continue
      const sized: IssueListingShape =
        chunk === undefined ? shape : { ...shape, [key!]: inListSize(chunk.length) }
      raw.push(
        ...(await issueListing(this.db, listingKey(sized)).all(
          listingValues(sized, { ...input, ...(chunk ? { [key!]: chunk } : {}) }),
        )),
      )
    }
    const rows = await this.mapQuarantined(raw)
    return chunks.length > 1 ? sortListing(rows, shape.order) : rows
  }

  /** Per (stage, priority, type, assignee): how many issues of a listing shape,
   *  in the order the groups first appear in (repository path, sequence). */
  async countIssueGroups(
    shape: IssueListingShape,
    input: IssueListingInput = {},
  ): Promise<
    { stage: string; priority: number; type: string; assignee: string | null; n: number }[]
  > {
    const rows = await issueCountGroups(this.db, listingKey(shape)).all(listingValues(shape, input))
    return rows
      .sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0))
      .map(({ stage, priority, type, assignee, n }) => ({ stage, priority, type, assignee, n }))
  }

  /** Totals over a listing shape for `issues.stats` (deferral: {@link deferralsIn}). */
  async issueStatTotals(
    shape: IssueListingShape,
    input: IssueListingInput = {},
  ): Promise<{ total: number; closed: number; ready: number; blocked: number }> {
    const row = await issueStatTotals(this.db, listingKey(shape)).get(listingValues(shape, input))
    return {
      total: row?.total ?? 0,
      closed: Number(row?.closed ?? 0),
      ready: Number(row?.ready ?? 0),
      blocked: Number(row?.blocked ?? 0),
    }
  }

  /** The rows of a listing shape that carry a deferral, and whether each would
   *  otherwise be ready. */
  async deferralsIn(
    shape: IssueListingShape,
    input: IssueListingInput = {},
  ): Promise<{ id: IssueId; deferUntil: string; ready: boolean }[]> {
    const rows = await deferralsOf(this.db, listingKey(shape)).all(listingValues(shape, input))
    return rows.flatMap((r) =>
      typeof r.deferUntil === 'string'
        ? [{ id: r.id as IssueId, deferUntil: r.deferUntil, ready: Number(r.ready) === 1 }]
        : [],
    )
  }

  /** The narrow rows of one manual-order key space (`issue-listings.ts`
   *  sortScopeOf): a parent's live children, or a repository's live top-level
   *  issues, without the viewer's pinned ones when a viewer is given. */
  async sortScope(
    scope: { parentId: IssueId } | { repoId: RepoId; unpinnedFor?: UserId },
  ): Promise<{ id: IssueId; sortKey: string | null; createdAt: string; seq: number }[]> {
    const rows =
      'parentId' in scope
        ? await sortScopeOf(this.db, 'parent').all({ parentId: scope.parentId })
        : scope.unpinnedFor
          ? await sortScopeOf(this.db, 'top-unpinned').all({
              repoId: scope.repoId,
              viewer: scope.unpinnedFor,
            })
          : await sortScopeOf(this.db, 'top').all({ repoId: scope.repoId })
    return rows.flatMap((r) =>
      typeof r.id === 'string'
        ? [{ id: r.id as IssueId, sortKey: r.sortKey ?? null, createdAt: r.createdAt, seq: r.seq }]
        : [],
    )
  }

  /** Labels of these issues, each issue's in name order. */
  async labelsOfIssues(ids: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>()
    for (const r of await perChunk(
      ids,
      async (size, values) => await labelsOfIssues(this.db, size).all(values),
    )) {
      const names = out.get(r.issueId)
      if (names) names.push(r.label)
      else out.set(r.issueId, [r.label])
    }
    return out
  }

  /** The ids of the issues carrying these labels (POD-6920). */
  async issueIdsOfLabels(labelIds: readonly number[]): Promise<string[]> {
    const ids = [...new Set(labelIds)]
    const out = new Set<string>()
    for (let at = 0; at < ids.length; at += 500) {
      const chunk = ids.slice(at, at + 500)
      const size = inListSize(chunk.length)
      for (const row of await issuesOfLabels(this.db, size).all(inListValues(chunk, size, 'ids')))
        out.add(row.issueId)
    }
    return [...out]
  }

  /** The live, unarchived children of these parents, in the boot map's order
   *  (repository path, sequence), POD-7431: one read per 500 parents through
   *  `idx_issues_children`, the few rows ordered here. */
  async liveUnarchivedChildren(parentIds: readonly string[]): Promise<IssueRow[]> {
    const raw = await perChunk(
      [...new Set(parentIds)],
      async (size, values) => await liveUnarchivedChildRows(this.db, size).all(values),
    )
    return sortListing(await this.mapQuarantined(raw), 'path-seq')
  }

  /** The live, unarchived issues started by these sessions, in the boot map's
   *  order (repository path, sequence), POD-7431: one read per 500 sessions
   *  through `idx_issues_started_by`, the few rows ordered here. */
  async liveIssuesStartedBy(sessionIds: readonly string[]): Promise<IssueRow[]> {
    const raw = await perChunk(
      [...new Set(sessionIds)],
      async (size, values) => await liveIssuesStartedBy(this.db, size).all(values),
    )
    return sortListing(await this.mapQuarantined(raw), 'path-seq')
  }

  /** The dependency edges FROM these issues, in (from, to, type) order. */
  async depsFromIssues(
    ids: readonly string[],
  ): Promise<{ fromId: IssueId; toId: IssueId; type: string }[]> {
    return await perChunk(
      ids,
      async (size, values) => await depsFromIssues(this.db, size).all(values),
    )
  }

  /** The dependency edges TO these issues, in (to, from, type) order. */
  async depsToIssues(
    ids: readonly string[],
  ): Promise<{ fromId: IssueId; toId: IssueId; type: string }[]> {
    return await perChunk(
      ids,
      async (size, values) => await depsToIssues(this.db, size).all(values),
    )
  }

  async commentCountsOfIssues(ids: readonly string[]): Promise<Map<string, number>> {
    const rows = await perChunk(
      ids,
      async (size, values) => await commentCountsOfIssues(this.db, size).all(values),
    )
    return new Map(rows.map((r) => [r.issueId, r.n]))
  }

  /** Live children of these parents with their closure columns, in the boot
   *  map's order. */
  async liveChildrenOf(parentIds: readonly string[]): Promise<
    {
      id: IssueId
      parentId: IssueId
      stage: string
      closedReason: string | null
      deletedAt: string | null
    }[]
  > {
    // A parent's children all come back in its own chunk, in their order.
    const rows = await perChunk(
      parentIds,
      async (size, values) => await liveChildrenOf(this.db, size).all(values),
    )
    return rows.flatMap((r) =>
      typeof r.id === 'string' && r.parentId
        ? [
            {
              id: r.id as IssueId,
              parentId: r.parentId as IssueId,
              stage: r.stage,
              closedReason: r.closedReason,
              deletedAt: r.deletedAt,
            },
          ]
        : [],
    )
  }

  /** The closure columns of these issues (stage, close reason, deletion). */
  async closureOf(
    ids: readonly string[],
  ): Promise<
    Map<string, { stage: string; closedReason: string | null; deletedAt: string | null }>
  > {
    const out = new Map<
      string,
      { stage: string; closedReason: string | null; deletedAt: string | null }
    >()
    for (const r of await perChunk(
      ids,
      async (size, values) => await issueClosureRowsOf(this.db, size).all(values),
    )) {
      if (typeof r.id !== 'string') continue
      out.set(r.id, {
        stage: typeof r.stage === 'string' ? r.stage : '',
        closedReason: r.closedReason,
        deletedAt: r.deletedAt,
      })
    }
    return out
  }

  /** Map raw rows, skipping (and logging) the structurally corrupt ones. */
  private async mapQuarantined(rows: readonly (typeof issues.$inferSelect)[]): Promise<IssueRow[]> {
    const out: IssueRow[] = []
    for (const r of rows) {
      try {
        if (!structurallySound(r))
          throw new Error('structurally corrupt row (non-string id/repo_path/stage/title)')
        out.push(await issueFromRow(r))
      } catch (err) {
        log.error('quarantined a corrupt issue row — skipped', { issueId: r.id ?? null, err })
      }
    }
    return out
  }

  /**
   * The FINISHED-WORK PROJECTION for a set of issues — four columns, no row
   * mapping, read by primary key (POD-6155).
   *
   * The auto-hibernate sweep orders its candidates by whether the work they sit
   * on is finished (POD-568), which it asks once per host sample. Answering that
   * with `getIssues()` would be `SELECT *` plus `mapIssueRow`'s JSON parses on a
   * five-second path. The predicate stays {@link isIssueClosed}'s so there is
   * one definition of finished. Deleted rows count as closed: a session on a
   * tombstoned issue is at least as reapable as one on a done issue.
   */
  async closedIssueIdsAmong(ids: Iterable<string>): Promise<Set<string>> {
    const unique = [...new Set(ids)]
    const out = new Set<string>()
    for (let at = 0; at < unique.length; at += 500) {
      const chunk = unique.slice(at, at + 500)
      const size = inListSize(chunk.length)
      for (const id of closedOf(
        await issueClosureRowsOf(this.db, size).all(
          inListValues(chunk.map(asIssueId), size, 'ids'),
        ),
      ))
        out.add(id)
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
  async getIssues(ids: readonly string[]): Promise<Map<string, IssueRow>> {
    const out = new Map<string, IssueRow>()
    const unique = [...new Set(ids)]
    if (unique.length === 0) return out
    // Serve what this frame has already parsed, and ask SQLite only for the
    // rest. A miss recorded as null is an ANSWER ("no such issue"), the same
    // one the query would give, so it must not be re-asked either.
    const cache = await this.frameRows()
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
      const size = inListSize(chunk.length)
      const rows = await issuesByIds(this.db, size).all(
        inListValues(chunk.map(asIssueId), size, 'ids'),
      )
      for (const r of rows) {
        try {
          if (typeof r.id !== 'string') continue
          const mapped = await issueFromRow(r)
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
   * skipped and logged — never propagated, so one corrupt row costs that row.
   * No server path reads every issue this way since POD-6158 (tests and the
   * statement census do). Individual JSON columns additionally self-quarantine
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
  async listIssueParentEdges(): Promise<{ id: IssueId; parentId: IssueId | null }[]> {
    // TOMBSTONES ARE NOT ANCESTORS. Issues are soft-deleted, so an unfiltered
    // walk folds a costed task's spend into a parent the operator deleted and
    // can see nowhere else in the app (POD-1858 review).
    const rows = await liveIssueParentEdges(this.db).all()
    return rows.map((r) => ({ id: r.id, parentId: r.parentId }))
  }

  async listIssueRows(repoPath?: string): Promise<IssueRow[]> {
    // Repo-scoped reads key on the stable repo_id (issue #164): the given path
    // resolves to its logical repo, so two registered clones of one repository
    // (or an issue filed under a sub-path of the root) list together. The
    // NULL-repo_id fallback keeps legacy rows the boot heal hasn't stamped yet
    // visible under their exact path.
    const repoId = repoPath ? await this.resolveRepoIdForPath(repoPath) : undefined
    const rows = repoPath
      ? await issueRowsOfRepo(this.db).all({ repoId: repoId as RepoId, repoPath })
      : await allIssueRows(this.db).all()
    const out: IssueRow[] = []
    for (const r of rows) {
      try {
        // Load-bearing TEXT columns must actually be strings: a NULL id (SQLite
        // allows NULL in a TEXT PRIMARY KEY) or NULL stage/title row would poison
        // every downstream consumer — quarantine it instead of mapping it.
        if (!structurallySound(r)) {
          throw new Error('structurally corrupt row (non-string id/repo_path/stage/title)')
        }
        out.push(await issueFromRow(r))
      } catch (err) {
        log.error('quarantined a corrupt issue row — skipped', { issueId: r.id ?? null, err })
      }
    }
    return out
  }

  /**
   * Every issue row, a page at a time in id order, with the quarantine of
   * {@link listIssueRows} (POD-6158). Each page is one statement through the
   * primary key; the walk as a whole reads the table, which is what a
   * full-truth reconcile needs. A caller that needs one consistent view walks
   * inside a span.
   */
  async *issueRowPages(pageSize = 500): AsyncGenerator<IssueRow[]> {
    let after: string | null = null
    for (;;) {
      const rows: (typeof issues.$inferSelect)[] =
        after === null
          ? await issueRowsPage(this.db, 'start').all({ id: asIssueId(''), limit: pageSize })
          : await issueRowsPage(this.db, 'after').all({ id: asIssueId(after), limit: pageSize })
      const page: IssueRow[] = []
      for (const r of rows) {
        try {
          if (!structurallySound(r)) {
            throw new Error('structurally corrupt row (non-string id/repo_path/stage/title)')
          }
          page.push(await issueFromRow(r))
        } catch (err) {
          log.error('quarantined a corrupt issue row — skipped', { issueId: r.id ?? null, err })
        }
      }
      if (page.length > 0) yield page
      // `id >= ''` leaves out NULL and numeric ids (quarantined either way), so
      // the cursor is never NULL.
      if (rows.length < pageSize) return
      after = rows[rows.length - 1]!.id
    }
  }

  /**
   * The live issues whose worktree could contain any of these folders, in
   * repository order (`repo_path`, then `seq`; BINARY collation) — the
   * candidates `isMemberCwd` then decides on (POD-6155). One statement for up to
   * 2048 candidate keys per arm, served by `idx_issues_worktree` and
   * `idx_issues_worktree_folded`; never a whole-table read.
   */
  /** {@link liveWorktreesOnMachines}: the live worktree tasks on these
   *  machines, `machineId → [{ id, ownerUserId }]`, one read per 500 machines. */
  async liveWorktreeIssuesOnMachines(
    machineIds: readonly string[],
  ): Promise<Map<string, { id: IssueId; ownerUserId: UserId }[]>> {
    const out = new Map<string, { id: IssueId; ownerUserId: UserId }[]>()
    const unique = [...new Set(machineIds)]
    for (const id of unique) out.set(id, [])
    for (const chunk of chunked(unique, 500)) {
      const size = inListSize(chunk.length)
      for (const row of await liveWorktreesOnMachines(this.db, size).all(
        inListValues(chunk, size, 'machineIds'),
      )) {
        if (typeof row.machineId !== 'string') continue
        out
          .get(row.machineId)
          ?.push({ id: row.id as IssueId, ownerUserId: row.ownerUserId as UserId })
      }
    }
    return out
  }

  async worktreeOwnerCandidates(cwds: Iterable<string>): Promise<WorktreeOwnerRow[]> {
    const literal = new Set<string>()
    const folded = new Set<string>()
    for (const cwd of cwds) {
      const keys = folderOwnerKeys(cwd)
      for (const key of keys.literal) literal.add(key)
      for (const key of keys.folded) folded.add(key)
    }
    const literalKeys = [...literal]
    const foldedKeys = [...folded]
    const byId = new Map<string, WorktreeOwnerRow>()
    for (
      let at = 0;
      at < Math.max(literalKeys.length, foldedKeys.length);
      at += WORKTREE_OWNER_CHUNK
    ) {
      const literalChunk = literalKeys.slice(at, at + WORKTREE_OWNER_CHUNK)
      const foldedChunk = foldedKeys.slice(at, at + WORKTREE_OWNER_CHUNK)
      const size = inListSize(Math.max(literalChunk.length, foldedChunk.length, 1))
      // An empty arm is padded with '': no live worktree is the empty path.
      const values = inListValues(literalChunk.length ? literalChunk : [''], size, 'lit')
      inListValues(foldedChunk.length ? foldedChunk : [''], size, 'fold', values)
      for (const row of await worktreeOwnersOf(this.db, size).all(values)) {
        // The structural quarantine every cwd reader applies.
        if (typeof row.id !== 'string' || typeof row.repoPath !== 'string') continue
        byId.set(row.id, {
          id: asIssueId(row.id),
          repoPath: row.repoPath,
          seq: row.seq,
          worktreePath: row.worktreePath,
          archived: row.archived,
          machineId: (row.machineId ?? null) as MachineId | null,
        })
      }
    }
    return byRepoPathThenSeq(byId.values())
  }

  async deleteIssue(id: string): Promise<void> {
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
    await deleteRefLettersOf(this.db).run({ issueId: asIssueId(id) })
    await this.invalidateRowCache()
    const remove = (this.issueWrites.remove ??= prepared((db, t) =>
      captureWrite(
        db
          .delete(t.issues)
          .where(inWorkspace(t.issues, eq(t.issues.id, param(t.issues.id, 'id'))))
          .returning(),
      ).prepare(),
    ))
    await this.writeRows(async () => await remove(this.db).all({ id: asIssueId(id) }), 'delete', [
      asIssueId(id),
    ])
  }

  /** Per-boot heal (POD-1926): drop letter counters whose issue is already gone —
   *  rows a hard purge before {@link deleteIssue} scrubbed them left behind. The
   *  counter exists so a letter is never reused WITHIN an issue, so once the issue
   *  is deleted it protects nothing. Returns the number of rows dropped. */
  async pruneOrphanRefLetters(): Promise<number> {
    const result = await deleteOrphanRefLetters(this.db).run()
    return Number(result.changes)
  }

  /** Next human-facing issue number, allocated per LOGICAL repo — scoped by the
   *  stable `repo_id` (issue #164, #140) so every checkout of one origin shares a
   *  single seq sequence and two machines with different paths can no longer mint
   *  colliding numbers. Callers resolve the path to a repo_id (resolveRepoIdForPath)
   *  before allocating. UNIQUE(repo_id, seq) enforces the invariant at the SQL layer. */
  async nextIssueSeq(repoId: RepoId): Promise<number> {
    const r = await highestSeqOfRepo(this.db).get({ repoId })
    return Number(r?.m ?? 0) + 1
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
  async renumberCollidingIssueSeqs(): Promise<number> {
    const rows = await issueSeqRows(this.db).all()
    const byRepo = new Map<string, typeof rows>()
    for (const r of rows) {
      const rid = r.repoId ?? (await this.resolveRepoIdForPath(r.repoPath, r.machineId))
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
    await this.invalidateRowCache()
    // The span covers the UPDATE loop only. The read and the planning above are
    // deliberately outside it, which is what keeps the write window short; a
    // conversion must not widen the span to cover them.
    const setSeq = (this.issueWrites.seq ??= prepared((db, t) =>
      captureWrite(
        db
          .update(t.issues)
          .set({ seq: sql.placeholder('seq') })
          .where(inWorkspace(t.issues, eq(t.issues.id, param(t.issues.id, 'id'))))
          .returning(),
      ).prepare(),
    ))
    await this.createOrJoinTransaction(async () => {
      for (const u of updates) {
        await this.writeRows(
          async () => await setSeq(this.db).all({ id: u.id, seq: u.seq }),
          'upsert',
          [u.id],
        )
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
  async assignRepoIdToIssuesUnder(repoId: RepoId, repoPath: string): Promise<void> {
    // Matches at a PATH BOUNDARY (see issuesUnderPathOutsideRepo).
    const under = `${repoPath}/`
    const rows = await issuesUnderPathOutsideRepo(this.db).all({
      repoPath,
      under,
      below: prefixUpperBound(under),
      repoId,
    })
    if (rows.length === 0) return
    const highest = await highestSeqOfRepo(this.db).get({ repoId })
    let next = (highest?.m ?? 0) + 1
    const taken = async (seq: number) => await issueIdAtSeq(this.db).get({ repoId, seq })
    await this.invalidateRowCache()
    const setRepoIdAndSeq = (this.issueWrites.repoIdAndSeq ??= prepared((db, t) =>
      captureWrite(
        db
          .update(t.issues)
          .set({ repoId: sql.placeholder('repoId'), seq: sql.placeholder('seq') })
          .where(inWorkspace(t.issues, eq(t.issues.id, param(t.issues.id, 'id'))))
          .returning(),
      ).prepare(),
    ))
    await this.createOrJoinTransaction(async () => {
      for (const r of rows) {
        let seq = r.seq
        const holder = await taken(seq)
        if (holder && holder.id !== r.id) {
          while (await taken(next)) next += 1
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
        await this.writeRows(
          async () => await setRepoIdAndSeq(this.db).all({ id: r.id, repoId, seq }),
          'upsert',
          [r.id],
        )
      }
    })
  }

  /**
   * Allocate the next session column letter for an issue (`A`, `B`, … `Z`, `AA`,
   * #474). Backed by the `issue_ref_letters` high-water counter so a letter is
   * NEVER reused within an issue — even after the session that held it is deleted.
   * Transactional: the read-increment-return is atomic, so two concurrent
   * allocations can never mint the same `POD-13-A`.
   */
  async allocateSessionLetter(issueId: IssueId): Promise<string> {
    return await this.createOrJoinTransaction(async () => {
      const row = await refLetterNextIndex(this.db).get({ issueId })
      const index = row?.nextIndex ?? 0
      await upsertRefLetterNextIndex(this.db).run({ issueId, nextIndex: index + 1 })
      return letterForIndex(index)
    })
  }

  /** Issues carrying no repo_id — read by the facade's boot refusal. A live
   *  writer cannot produce one (`upsertIssue` resolves a repo_id before it
   *  inserts), so a non-zero answer means a database from before POD-1360. */
  async issuesMissingRepoId(): Promise<number> {
    const r = await issuesMissingRepoIdCount(this.db).get()
    return r?.c ?? 0
  }

  /** One-time historical migration, after the facade's identity refusals.
   * The enrolled host row supplies the placement; an absent or revoked host
   * defers the migration. The receipt commits with the updates, even when
   * contradictory rows remain for manual recovery. */
  // LEGACY(remove-after: 2027-05): Pin v0.1.0 worktrees to an enrolled host; removing this drops that repair.
  async backfillLegacyWorktreeMachineIds(
    candidateHostId?: MachineId,
  ): Promise<{ hostMachineId: MachineId; backfilled: number; skipped: number } | undefined> {
    if (candidateHostId === undefined) return undefined
    return await this.createOrJoinTransaction(async () => {
      if (await legacyWorktreeReceipt(this.db).get()) return undefined
      const host = await liveMachineById(this.db).get({ id: candidateHostId })
      if (!host) return undefined
      const hostMachineId = host.id
      const skipped = (await legacyWorktreeSkipped(this.db).get({ hostMachineId }))?.c ?? 0
      // BEFORE the write, per the POD-1939 invariant `store-issues-row-cache-writers`
      // enforces: invalidating afterwards would still empty the map, but a read
      // taken in between would cache rows read inside this open transaction.
      await this.invalidateRowCache()
      const backfill = (this.issueWrites.legacyMachine ??= prepared((db, t) => {
        const { legacyWorktreeRow, contradictorySession } = legacyWorktreeTerms(db)
        return captureWrite(
          db
            .update(t.issues)
            .set({ machineId: sql.placeholder('hostMachineId') })
            .where(inWorkspace(t.issues, legacyWorktreeRow, not(contradictorySession)))
            .returning(),
        ).prepare()
      }))
      const backfilled = Number(
        (await this.writeRows(async () => await backfill(this.db).all({ hostMachineId }), 'upsert'))
          .changes,
      )
      await insertLegacyWorktreeReceipt(this.db).run({
        value: JSON.stringify({ hostMachineId, backfilled, skipped }),
      })
      return { hostMachineId, backfilled, skipped }
    })
  }

  /**
   * The SQL the contradiction test emits, so a test can pin the subquery's
   * CORRELATION directly rather than only through its consequence. Read off the
   * count query rather than the UPDATE because both are built from the same
   * `legacyWorktreeTerms`, and a write builder in a method that exists only to
   * print SQL would owe the POD-1939 cache invalidation it has no reason to do.
   * The host machine is a placeholder in both, so the text does not depend on it.
   */
  legacyWorktreeContradictionSql(_hostMachineId: MachineId): string {
    // Rendered on the handle's drizzle instance, never run: a workspace view
    // binds statements only, and this reads the builder's text.
    return legacyWorktreeSkippedBuilder(this.db.drizzle).toSQL().sql
  }

  // ---- labels ----
  //
  // Labels are a vocabulary of their own (POD-6106): one `labels` row per name,
  // unique ignoring case, and `issue_labels` links issues to label ids. The wire
  // still names a label by its NAME, so every read below joins back to it. This
  // layer is policy-free: whether a caller may CREATE a label is the issue
  // service's decision, made before it calls `setIssueLabels`.

  /** Trim, drop empties, and collapse case variants onto their first spelling. */
  private cleanLabelNames(names: readonly string[]): string[] {
    const seen = new Map<string, string>()
    for (const raw of names) {
      if (typeof raw !== 'string') continue
      const name = raw.trim()
      if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name)
    }
    return [...seen.values()]
  }

  /** The labels these names refer to, keyed by lower-cased name. Absent = no such label. */
  async findLabels(names: readonly string[]): Promise<Map<string, LabelRow>> {
    const wanted = this.cleanLabelNames(names).map((n) => n.toLowerCase())
    if (wanted.length === 0) return new Map()
    const size = inListSize(wanted.length)
    const rows = await labelsNamed(this.db, size).all(inListValues(wanted, size, 'name'))
    return new Map(rows.map((r) => [r.name.toLowerCase(), r]))
  }

  /** Create a label, or edit the colour/description of the one with this name
   *  (case-insensitive). The stored spelling of an existing name never changes. */
  async defineLabel(input: {
    name: string
    color?: string | null
    description?: string | null
  }): Promise<LabelRow> {
    const [name] = this.cleanLabelNames([input.name])
    if (!name) throw new Error('label name is empty')
    const existing = (await this.findLabels([name])).get(name.toLowerCase())
    if (existing) {
      const patch: { color?: string | null; description?: string | null } = {}
      if (input.color !== undefined) patch.color = input.color
      if (input.description !== undefined) patch.description = input.description
      if (Object.keys(patch).length === 0) return existing
      await patchLabel(this.db, shapeOf(patch)).run({ ...patch, id: existing.id })
      return { ...existing, ...patch }
    }
    const created = await insertLabelRow(this.db).get({
      name,
      color: input.color ?? null,
      description: input.description ?? null,
      createdAt: new Date().toISOString(),
    })
    if (!created) throw new Error(`label ${name} was not persisted`)
    return created
  }

  /** The whole vocabulary, by name ignoring case. */
  async listLabels(): Promise<LabelRow[]> {
    return await labelVocabulary(this.db).all()
  }

  /** Replace an issue's labels. A name with no label yet CREATES one — the
   *  service has already decided the caller may. Returns the stored spellings. */
  async setIssueLabels(issueId: IssueId, names: string[]): Promise<string[]> {
    const clean = this.cleanLabelNames(names)
    const found = await this.findLabels(clean)
    const ids: number[] = []
    const stored: string[] = []
    for (const name of clean) {
      const row = found.get(name.toLowerCase()) ?? (await this.defineLabel({ name }))
      ids.push(row.id)
      stored.push(row.name)
    }
    await deleteLabelsOf(this.db).run({ issueId })
    for (const labelId of ids) {
      // `INSERT OR IGNORE` before the conversion, and EQUIVALENT here (spec
      // rule 31). The two forms differ only where OR IGNORE suppresses
      // something DO NOTHING does not, which is NOT NULL and CHECK — a foreign
      // key is suppressed by neither, measured on the shipped table. This one
      // has no CHECK, and both NOT NULL columns come from non-nullable sources.
      await insertLabel(this.db).run({ issueId, labelId })
    }
    return stored
  }

  async getIssueLabels(issueId: IssueId): Promise<string[]> {
    return (await labelsOf(this.db).all({ issueId })).map((r) => r.label)
  }

  // ---- deps ----

  async addIssueDep(fromId: IssueId, toId: IssueId, type = 'blocked-by'): Promise<void> {
    // `INSERT OR IGNORE` before the conversion, and EQUIVALENT here for the
    // reason setIssueLabels states (spec rule 31). All three NOT NULL columns are
    // non-nullable at every caller: `fromId` and `toId` are required, and `type`
    // has both a parameter default and a column default of 'blocked-by', so an
    // omitted value takes the same value either way. The CHECK on `type`
    // (POD-6100) is NOT swallowed by `onConflictDoNothing` — that is ON CONFLICT
    // DO NOTHING on the primary key only — so an unknown type still throws.
    await insertDep(this.db).run({ fromId, toId, type })
  }

  async removeIssueDep(fromId: IssueId, toId: IssueId, type?: string): Promise<void> {
    if (type) {
      await deleteDepOfType(this.db).run({ fromId, toId, type })
    } else {
      await deleteDepsBetween(this.db).run({ fromId, toId })
    }
  }

  /** SERIALIZATION EDGE: `to_id`/`from_id` come back untyped, so the row shape
   *  re-declares the id space they were stored under. `type` is a dep KIND, not
   *  an id, and stays a free string. */
  async listIssueDeps(fromId: IssueId): Promise<{ toId: IssueId; type: string }[]> {
    return await depsFrom(this.db).all({ fromId })
  }

  /** EVERY dep edge, for the ledger's full-truth reconcile of the 'issueDep'
   *  kind [POD-822]. Ordered so the row set is stable across calls — reconcile
   *  diffs by id, but a stable order keeps the change log's appends readable and
   *  the tests' expectations deterministic. */
  async listAllIssueDeps(): Promise<{ fromId: IssueId; toId: IssueId; type: string }[]> {
    return await allDeps(this.db).all()
  }

  async listDependents(toId: IssueId): Promise<{ fromId: IssueId; type: string }[]> {
    return await depsTo(this.db).all({ toId })
  }

  // ---- comments ----

  async addIssueComment(c: IssueCommentRow): Promise<void> {
    await insertComment(this.db).run({
      id: c.id,
      issueId: c.issueId,
      author: c.author,
      body: c.body,
      createdAt: c.createdAt,
      actor: c.actor ?? null,
      onBehalfOf: c.onBehalfOf ?? null,
      mentions: c.mentions ?? null,
    })
  }

  async listIssueComments(issueId: IssueId): Promise<IssueCommentRow[]> {
    return await commentsOf(this.db).all({ issueId })
  }

  async getIssueComment(id: string): Promise<IssueCommentRow | undefined> {
    return (await commentById(this.db).get({ id })) ?? undefined
  }

  /** Replace a comment's body and stamp who edited it (POD-6289). The author
   *  columns are not part of the write. */
  async editIssueComment(edit: {
    id: string
    body: string
    editedAt: string
    editedBy: string
    editedOnBehalfOf: string | null
    /** The members the new body mentions, as stored JSON (POD-6881). */
    mentions?: string | null
  }): Promise<void> {
    await editComment(this.db).run({ ...edit, mentions: edit.mentions ?? null })
  }

  async deleteIssueComment(id: string): Promise<void> {
    await deleteComment(this.db).run({ id })
  }

  // ---- description and brief history (POD-6289) ----

  async appendIssueTextRevision(r: Omit<IssueTextRevisionRow, 'id'>): Promise<void> {
    await insertTextRevision(this.db).run({
      issueId: r.issueId,
      field: r.field,
      body: r.body,
      source: r.source,
      restoredFrom: r.restoredFrom ?? null,
      issueRevision: r.issueRevision ?? null,
      actor: r.actor ?? null,
      onBehalfOf: r.onBehalfOf ?? null,
      createdAt: r.createdAt,
    })
  }

  async listIssueTextRevisions(
    issueId: IssueId,
    field: IssueTextField,
  ): Promise<IssueTextRevisionRow[]> {
    return (await textRevisionsOf(this.db).all({ issueId, field })).map(textRevisionFromRow)
  }

  async hasIssueTextRevisions(issueId: IssueId, field: IssueTextField): Promise<boolean> {
    return (await anyTextRevisionOf(this.db).get({ issueId, field })) !== undefined
  }

  async getIssueTextRevision(id: number): Promise<IssueTextRevisionRow | undefined> {
    const row = await textRevisionById(this.db).get({ id })
    return row ? textRevisionFromRow(row) : undefined
  }

  /** Comment count for ONE issue — the single-issue toWire path (#175). */
  async countIssueComments(issueId: IssueId): Promise<number> {
    const r = await commentCountOf(this.db).get({ issueId })
    return r?.n ?? 0
  }

  /** Comment counts for ALL issues in one GROUP BY (#175) — list serializations
   *  share this map so N-issue toWire runs don't cost N comment queries (the
   *  same batching posture as the shared sessionList). Issues with no comments
   *  are simply absent (read as 0). */
  async countIssueCommentsByIssue(): Promise<Map<string, number>> {
    const rows = await commentCountsByIssue(this.db).all()
    return new Map(rows.map((r) => [r.issueId, r.n]))
  }

  /** Substring match over issue comment bodies — comments have no FTS (bounded
   *  volume), so LIKE is enough for the omni-search's comment source. */
  async searchIssueComments(
    query: string,
    limit: number | null = 30,
  ): Promise<{ issueId: IssueId; body: string; createdAt: string }[]> {
    const q = query.trim()
    if (!q) return []
    const escaped = '%' + q.replace(/[%_]/g, (c) => '\\' + c) + '%'
    // The ESCAPE clause is what makes `%` and `_` in a user's query LITERAL
    // (see commentSearch).
    return limit === null
      ? await commentSearch(this.db, 'all').all({ pattern: escaped })
      : await commentSearch(this.db, 'limited').all({
          pattern: escaped,
          limit: Math.min(200, Math.max(1, limit)),
        })
  }

  // ---- issue mail (issue #103) ----

  /** SERIALIZATION EDGE: every field but one now arrives typed. `status` is a
   *  free TEXT column narrowed to the domain's union — a decision, not a driver
   *  artefact — and the projection drops `actor`/`on_behalf_of`, which the row
   *  type does not carry. */
  private async mapIssueMessage(r: {
    id: string
    issueId: IssueId
    fromAuthor: string
    body: string
    createdAt: string
    status: string
    claimedBy: string | null
    claimedAt: string | null
  }): Promise<IssueMessageRow> {
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

  async addIssueMessage(m: IssueMessageRow): Promise<void> {
    await insertMessage(this.db).run({
      id: m.id,
      issueId: m.issueId,
      fromAuthor: m.fromAuthor,
      body: m.body,
      createdAt: m.createdAt,
      status: m.status,
      claimedBy: m.claimedBy,
      claimedAt: m.claimedAt,
    })
  }

  async getIssueMessage(id: string): Promise<IssueMessageRow | null> {
    const r = await messageById(this.db).get({ id })
    return r ? await this.mapIssueMessage(r) : null
  }

  async listIssueMessages(
    issueId: IssueId,
    opts?: { status?: IssueMessageRow['status'] },
  ): Promise<IssueMessageRow[]> {
    const rows = opts?.status
      ? await messagesOfWithStatus(this.db).all({ issueId, status: opts.status })
      : await messagesOf(this.db).all({ issueId })
    return await Promise.all(rows.map(async (r) => await this.mapIssueMessage(r)))
  }

  async countUnreadIssueMessages(issueId: IssueId): Promise<number> {
    const r = await unreadMessageCountOf(this.db).get({ issueId })
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
  async markIssueMessagesRead(
    /** The reading member, or `null` when nobody read it (a delivery to no
     *  session): only the shared delivery state moves then (POD-6291). */
    userId: UserId | null,
    issueId: IssueId,
    ids: string[],
    readAt: string,
  ): Promise<void> {
    if (userId !== null) requireUserId(userId)
    for (const id of ids) {
      // Only `unread` flips, so a `claimed` message never regresses to `read`.
      await markMessageRead(this.db).run({ issueId, id })
      // Written for EVERY named message, not only the unread ones.
      if (userId !== null)
        await upsertMessageReadAt(this.db).run({ userId, issueMessageId: id, readAt })
    }
  }

  /** One user's tracker-mail read markers, `issueMessageId → readAt`. */
  async listIssueMessageReadAt(userId: UserId): Promise<Record<string, string | null>> {
    requireUserId(userId)
    const rows = await messageReadAtOf(this.db).all({ userId })
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
  /** Authority-only feed truth. A targeted publish reads one issue's users;
   * boot/purge reconciles the full set. Delivery is filtered by the keyed user. */
  async listIssueUserStateRows(issueId?: IssueId): Promise<IssueUserState[]> {
    const rows =
      issueId === undefined
        ? await allIssueUserStateRows(this.db).all()
        : await issueUserStateRowsOf(this.db).all({ issueId })
    return rows.map((row) => IssueUserState.parse(row))
  }

  /** {@link getIssueUserState}, batched with the other loads of this tick and
   *  memoized for the operation (POD-6158). */
  async loadIssueUserState(
    userId: UserId,
    issueId: IssueId,
  ): Promise<StoredIssueUserState | undefined> {
    requireUserId(userId)
    return await this.userStateLoader.load(`${userId}\u0000${issueId}`)
  }

  /** {@link loadIssueUserState} for many issues, in one batch per 500. */
  async loadIssueUserStates(
    userId: UserId,
    issueIds: readonly string[],
  ): Promise<Map<string, StoredIssueUserState | undefined>> {
    requireUserId(userId)
    const loaded = await this.userStateLoader.loadMany(issueIds.map((id) => `${userId}\u0000${id}`))
    return new Map(issueIds.map((id) => [id, loaded.get(`${userId}\u0000${id}`)] as const))
  }

  /** Markers for mixed (person, issue) pairs in one batch, keyed by issue id:
   *  each issue's markers are the named person's (POD-6291). */
  async loadIssueUserStatesOfPairs(
    pairs: readonly { userId: UserId; issueId: string }[],
  ): Promise<Map<string, StoredIssueUserState | undefined>> {
    for (const pair of pairs) requireUserId(pair.userId)
    const loaded = await this.userStateLoader.loadMany(
      pairs.map((p) => `${p.userId}\u0000${p.issueId}`),
    )
    return new Map(
      pairs.map((p) => [p.issueId, loaded.get(`${p.userId}\u0000${p.issueId}`)] as const),
    )
  }

  async getIssueUserState(
    userId: UserId,
    issueId: IssueId,
  ): Promise<StoredIssueUserState | undefined> {
    requireUserId(userId)
    const r = await issueUserStateOne(this.db).get({ userId, issueId })
    return r ? storedUserStateOf(r) : undefined
  }

  /**
   * Write one user's markers for one issue. A PARTIAL patch: an absent key leaves
   * the stored value alone, so `setIssueUserState(u, i, { readAt: t })` cannot
   * silently un-pin an issue — the failure a whole-row upsert would make easy.
   *
   * A row whose three markers all end up null is DELETED, so the table holds only
   * issues a person has actually touched and "absent" keeps its single meaning.
   */
  async setIssueUserState(
    _scope: WriteScope,
    userId: UserId,
    issueId: IssueId,
    patch: Partial<StoredIssueUserState>,
    /** The stored row the caller just read in this transaction, so the patch
     *  is applied without reading it again; `null` = no row. */
    known?: StoredIssueUserState | null,
  ): Promise<Required<StoredIssueUserState> | undefined> {
    requireUserId(userId)
    if (!issueId) throw new Error('issue user-state issue id is empty')
    const current =
      (known !== undefined ? known : await this.getIssueUserState(userId, issueId)) ??
      NO_STORED_USER_STATE
    const pick = <K extends keyof StoredIssueUserState>(key: K) =>
      (patch[key] !== undefined ? patch[key] : current[key]) ?? null
    const next = {
      readAt: pick('readAt'),
      tuckedAt: pick('tuckedAt'),
      joinedAt: pick('joinedAt'),
      joinedVia: pick('joinedVia'),
      assignedAt: pick('assignedAt'),
      assignedBy: pick('assignedBy'),
    }
    if (Object.values(next).every((value) => value === null)) {
      await deleteIssueUserStateOne(this.db).run({ userId, issueId })
      this.userStateWritten()
      return undefined
    }
    await upsertIssueUserState(this.db).run({ userId, issueId, ...next })
    this.userStateWritten()
    return next
  }

  /** Drop every user's per-user rows for an issue. Called from the issue's own
   *  purge path: the rows are not the issue's (they follow the USER), but a
   *  hard-deleted issue leaves them addressing nothing. */
  async purgeIssueUserState(issueId: IssueId): Promise<void> {
    await deleteIssueUserStateOf(this.db).run({ issueId })
    this.userStateWritten()
  }

  /** Atomic claim: exactly one caller wins; a second claim on the same message
   *  returns false. Single UPDATE guarded on status, so there is no read-then-write race. */
  async claimIssueMessage(id: string, claimedBy: string, claimedAt: string): Promise<boolean> {
    const r = await claimMessage(this.db).run({ id, claimedBy, claimedAt })
    return r.changes === 1
  }

  async deleteIssueMessagesForIssue(issueId: IssueId): Promise<void> {
    await deleteMessagesOf(this.db).run({ issueId })
  }

  async deleteIssueChildRows(issueId: IssueId): Promise<void> {
    await deleteLabelsOf(this.db).run({ issueId })
    await deleteDepsTouching(this.db).run({ issueId })
    await deleteCommentsOf(this.db).run({ issueId })
    await deleteTextRevisionsOf(this.db).run({ issueId })
    await this.deleteIssueMessagesForIssue(issueId)
  }
}

function textRevisionFromRow(r: typeof issueTextRevisions.$inferSelect): IssueTextRevisionRow {
  return {
    id: r.id,
    issueId: r.issueId,
    field: r.field as IssueTextField,
    body: r.body,
    source: r.source as IssueTextRevisionRow['source'],
    restoredFrom: r.restoredFrom,
    issueRevision: r.issueRevision,
    actor: r.actor,
    onBehalfOf: r.onBehalfOf,
    createdAt: r.createdAt,
  }
}

/** Map the schema-inferred row into the domain row. Branded ids arrive from
 * the schema; the remaining mapping is semantic validation and quarantine. */
export function issueFromRow(r: typeof issues.$inferSelect): IssueRow {
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
    createdByOnBehalfOf: r.createdByOnBehalfOf ?? null,
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
    agentProfileId: r.agentProfileId,
    machineId: r.machineId,
    linearId: r.linearId,
    linearIdentifier: r.linearIdentifier,
    linearUrl: r.linearUrl,
    activityNotes: null,
    notesUpdatedAt: null,
    suggestedStage: r.suggestedStage,
    suggestedReason: r.suggestedReason,
    blockedBy: parseStringArray(r.blockedBy, `issue ${String(r.id)} blocked_by`),
    dependencyNote: r.dependencyNote,
    prUrl: r.prUrl,
    priority: r.priority,
    type: r.type,
    assignee: r.assignee ?? null,
    parentId: r.parentId,
    acceptance: r.acceptance,
    dueAt: r.dueAt,
    deferUntil: r.deferUntil,
    closedReason: r.closedReason,
    closedAt: r.closedAt,
    closedByUserId: r.closedByUserId ?? null,
    landedAt: r.landedAt,
    landedSha: r.landedSha,
    supersededBy: r.supersededBy,
    duplicateOf: r.duplicateOf,
    sortKey: r.sortKey,
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
    humanQuestionAskedBy: r.humanQuestionAskedBy ?? null,
    humanQuestionAskedAt: r.humanQuestionAskedAt,
    humanQuestionAttribution: questionAttribution(r.humanQuestionAttribution),
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
    startedBySession: r.startedBySession ?? null,
  }
}

/** Corrupt optional provenance does not hide the question or invent an actor. */
function questionAttribution(raw: string | null): Attribution | null {
  if (!raw) return null
  try {
    const parsed = Attribution.safeParse(JSON.parse(raw))
    if (parsed.success) return parsed.data
  } catch {
    /* Unattributed historical or corrupt row. */
  }
  return null
}
