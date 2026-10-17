import { CommittedRows } from './committed-rows'
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
  isValidMachinePath,
  IssueStage,
  IssueUserState,
  isIssueClosed,
  isIssueColorSlot,
  machinePathAncestors,
  machinePathSeparator,
  type MachineId,
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
  labels,
  machines,
  meta,
  sessions,
} from '../migrations/schema'
import { applyAfterCommit, spanOpen } from './executor/executor'
import {
  commentCountsOfIssues,
  deferralsOf,
  depsFromIssues,
  depsToIssues,
  issueCountGroups,
  issueListing,
  type IssueListingInput,
  type IssueListingShape,
  issueStatTotals,
  labelsOfIssues,
  listingKey,
  listingValues,
  liveChildrenOf,
  perChunk,
  readableAmong,
  sortScopeOf,
} from './issue-listings'
import { operationLoader } from './executor/operation-loader'
import { currentReadScope, readScopeSlot } from './executor/read-scope'
import type { StoreDrizzle, StoreQueries, TransactionRunner } from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  param,
  placeholdersFor,
  prepared,
  preparedFamily,
  shapeOf,
} from './executor/sync-drizzle'
import { parseStringArray, requireUserId } from './helpers'
import { StaleIssueRevisionError } from './issue-revision'
import { prefixUpperBound } from './prefix-range'
import type { IssueCommentRow, IssueMessageRow, IssueRow, StoredIssueUserState } from './types'

export const LEGACY_WORKTREE_MIGRATION = 'legacy_worktree_machine_ids_v1'

const log = createLogger('server:store')

// Every query this repository runs, prepared once per store [POD-6147]. The
// statements that WRITE the `issues` table are the exception in placement, not
// in kind: they are prepared inside their own method (see `issueWrites`).

const issueRevision = prepared((db: StoreDrizzle) =>
  db
    .select({ revision: issues.revision })
    .from(issues)
    .where(eq(issues.id, param(issues.id, 'id')))
    .prepare(),
)

const issueById = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(issues)
    .where(eq(issues.id, param(issues.id, 'id')))
    .prepare(),
)



/** Closed or deleted, by the same rule as `isIssueClosed`; a NULL id is skipped. */
function closedOf(rows: readonly { id: unknown; stage: unknown; closedReason: string | null; deletedAt: string | null }[]): Set<string> {
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
const issueClosureRowsOf = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({
      id: issues.id,
      stage: issues.stage,
      closedReason: issues.closedReason,
      deletedAt: issues.deletedAt,
    })
    .from(issues)
    .where(inListOf(issues.id, size, 'ids'))
    .prepare(),
)

/** One shape per IN-list size bucket; `getIssues` chunks at 500. */
const issuesByIds = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select()
    .from(issues)
    .where(inListOf(issues.id, size, 'ids'))
    .prepare(),
)

const liveIssueParentEdges = prepared((db: StoreDrizzle) =>
  db
    .select({ id: issues.id, parentId: issues.parentId })
    .from(issues)
    .where(isNull(issues.deletedAt))
    .prepare(),
)

const issueRowsOfRepo = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(issues)
    .where(
      or(
        eq(issues.repoId, param(issues.repoId, 'repoId')),
        and(isNull(issues.repoId), eq(issues.repoPath, param(issues.repoPath, 'repoPath'))),
      ),
    )
    .orderBy(asc(issues.seq))
    .prepare(),
)

const allIssueRows = prepared((db: StoreDrizzle) =>
  db.select().from(issues).orderBy(asc(issues.repoPath), asc(issues.seq)).prepare(),
)

/**
 * One page of every issue row, in id order: from the first id (`start`, which
 * includes an empty id) or after the last one read (`after`). The full-truth
 * reconcile walks the whole table this way through the primary key instead of
 * reading the issue map (POD-6158).
 */
const issueRowsPage = preparedFamily((db: StoreDrizzle, from: 'start' | 'after') =>
  db
    .select()
    .from(issues)
    .where(from === 'start' ? gte(issues.id, param(issues.id, 'id')) : gt(issues.id, param(issues.id, 'id')))
    .orderBy(asc(issues.id))
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

const foldedWorktreePath = sql`lower(replace(${issues.worktreePath}, '/', '\\'))`

/** Live issues at any of the candidate keys: one index search per arm, no
 *  sort (the caller orders the few rows). Both arms share one IN-list size, so
 *  the family has one shape per size bucket. */
const worktreeOwnersOf = preparedFamily((db: StoreDrizzle, size: number) => {
  const columns = {
    id: issues.id,
    repoPath: issues.repoPath,
    seq: issues.seq,
    worktreePath: issues.worktreePath,
    archived: issues.archived,
  }
  const literal = db
    .select(columns)
    .from(issues)
    .where(and(inListOf(issues.worktreePath, size, 'lit'), isNull(issues.deletedAt)))
  const folded = db
    .select(columns)
    .from(issues)
    .where(and(
      inArray(foldedWorktreePath, Array.from({ length: size }, (_, index) => sql.placeholder(`fold${index}`))),
      isNotNull(issues.worktreePath),
      isNull(issues.deletedAt),
    ))
  return literal.unionAll(folded).prepare()
})

/** Candidate keys per statement and arm; two arms stay far below SQLite's
 *  bound-parameter limit. */
const WORKTREE_OWNER_CHUNK = 2048


const deleteRefLettersOf = prepared((db: StoreDrizzle) =>
  db
    .delete(issueRefLetters)
    .where(eq(issueRefLetters.issueId, param(issueRefLetters.issueId, 'issueId')))
    .prepare(),
)

const deleteOrphanRefLetters = prepared((db: StoreDrizzle) =>
  db
    .delete(issueRefLetters)
    .where(notInArray(issueRefLetters.issueId, db.select({ id: issues.id }).from(issues)))
    .prepare(),
)

const highestSeqOfRepo = prepared((db: StoreDrizzle) =>
  db
    .select({ m: max(issues.seq) })
    .from(issues)
    .where(eq(issues.repoId, param(issues.repoId, 'repoId')))
    .prepare(),
)

const issueSeqRows = prepared((db: StoreDrizzle) =>
  db
    .select({
      id: issues.id,
      repoId: issues.repoId,
      repoPath: issues.repoPath,
      machineId: issues.machineId,
      seq: issues.seq,
      createdAt: issues.createdAt,
    })
    .from(issues)
    .prepare(),
)

/**
 * The path itself, or a path under it: the second arm is the range of paths
 * that start with `<path>/` (`under` .. `below`, see {@link prefixUpperBound}),
 * which idx_issues_repo seeks. The `/` is the PATH BOUNDARY: `/rootless` merely
 * shares a text prefix with `/root` and must not be swept in. The `rowid`
 * tie-break is load-bearing on equal `created_at`, and `rowid` is not a schema
 * column, so it stays a fragment.
 */
const issuesUnderPathOutsideRepo = prepared((db: StoreDrizzle) =>
  db
    .select({ id: issues.id, seq: issues.seq })
    .from(issues)
    .where(
      and(
        or(
          eq(issues.repoPath, param(issues.repoPath, 'repoPath')),
          and(
            gte(issues.repoPath, param(issues.repoPath, 'under')),
            lt(issues.repoPath, param(issues.repoPath, 'below')),
          ),
        ),
        or(isNull(issues.repoId), ne(issues.repoId, param(issues.repoId, 'repoId'))),
      ),
    )
    .orderBy(asc(issues.createdAt), sql`rowid asc`)
    .prepare(),
)

const issueIdAtSeq = prepared((db: StoreDrizzle) =>
  db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.repoId, param(issues.repoId, 'repoId')), eq(issues.seq, param(issues.seq, 'seq'))))
    .prepare(),
)

/**
 * The reference columns of the issues at one sequence number (POD-6158).
 * Deleted rows are included: a reference names a row, whatever its state, as
 * the boot map's reference index always did. Ordered by repository path, then
 * id, which is the boot map's order for rows it loaded.
 */
const issueRefColumns = {
  id: issues.id,
  repoId: issues.repoId,
  repoPath: issues.repoPath,
  machineId: issues.machineId,
  seq: issues.seq,
  // Read only for the structural quarantine.
  stage: issues.stage,
  title: issues.title,
}

const issueRefsAtSeq = prepared((db: StoreDrizzle) =>
  db
    .select(issueRefColumns)
    .from(issues)
    .where(eq(issues.seq, param(issues.seq, 'seq')))
    .orderBy(asc(issues.repoPath), asc(issues.id))
    .prepare(),
)

/** {@link issueRefsAtSeq} for several numbers; one shape per IN-list size. */
const issueRefsAtSeqsOf = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select(issueRefColumns)
    .from(issues)
    .where(inListOf(issues.seq, size, 'seqs'))
    .orderBy(asc(issues.seq), asc(issues.repoPath), asc(issues.id))
    .prepare(),
)

/** At most one row: `(repo_id, seq)` is unique. */
const issueRefAtRepoSeq = prepared((db: StoreDrizzle) =>
  db
    .select(issueRefColumns)
    .from(issues)
    .where(and(eq(issues.repoId, param(issues.repoId, 'repoId')), eq(issues.seq, param(issues.seq, 'seq'))))
    .prepare(),
)

/** Rows the repo-id heal has not stamped yet; their repo is resolved by path.
 *  Unordered: the caller orders the union with the stamped row. */
const legacyIssueRefsAtSeq = prepared((db: StoreDrizzle) =>
  db
    .select(issueRefColumns)
    .from(issues)
    .where(and(eq(issues.seq, param(issues.seq, 'seq')), isNull(issues.repoId)))
    .prepare(),
)

/** One user's markers for a set of issues; one shape per IN-list size. */
const issueUserStatesOf = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({
      issueId: issueUserState.issueId,
      readAt: issueUserState.readAt,
      tuckedAt: issueUserState.tuckedAt,
      pinnedAt: issueUserState.pinnedAt,
    })
    .from(issueUserState)
    .where(
      and(
        eq(issueUserState.userId, param(issueUserState.userId, 'userId')),
        inListOf(issueUserState.issueId, size, 'ids'),
      ),
    )
    .prepare(),
)

const refLetterNextIndex = prepared((db: StoreDrizzle) =>
  db
    .select({ nextIndex: issueRefLetters.nextIndex })
    .from(issueRefLetters)
    .where(eq(issueRefLetters.issueId, param(issueRefLetters.issueId, 'issueId')))
    .prepare(),
)

const upsertRefLetterNextIndex = prepared((db: StoreDrizzle) =>
  db
    .insert(issueRefLetters)
    .values({ issueId: sql.placeholder('issueId'), nextIndex: sql.placeholder('nextIndex') })
    .onConflictDoUpdate({
      target: issueRefLetters.issueId,
      set: { nextIndex: sql.placeholder('nextIndex') },
    })
    .prepare(),
)

const issuesMissingRepoIdCount = prepared((db: StoreDrizzle) =>
  db.select({ c: count() }).from(issues).where(isNull(issues.repoId)).prepare(),
)

const legacyWorktreeReceipt = prepared((db: StoreDrizzle) =>
  db
    .select({ value: meta.value })
    .from(meta)
    .where(eq(meta.key, LEGACY_WORKTREE_MIGRATION))
    .prepare(),
)

const liveMachineById = prepared((db: StoreDrizzle) =>
  db
    .select({ id: machines.id })
    .from(machines)
    .where(and(eq(machines.id, param(machines.id, 'id')), isNull(machines.revokedAt)))
    .prepare(),
)

const insertLegacyWorktreeReceipt = prepared((db: StoreDrizzle) =>
  db
    .insert(meta)
    .values({ key: LEGACY_WORKTREE_MIGRATION, value: sql.placeholder('value') })
    .prepare(),
)

/**
 * The two terms `backfillLegacyWorktreeMachineIds` is built from, in one place
 * so the count and the UPDATE can never drift into disagreeing about which
 * rows are candidates and which are contradicted. The host machine is the
 * `hostMachineId` placeholder of whichever statement embeds them.
 */
const legacyWorktreeTerms = prepared((db: StoreDrizzle) => ({
  /** Owns a worktree, names no machine — the residue a v0.1.0 build leaves. */
  legacyWorktreeRow: and(isNotNull(issues.worktreePath), isNull(issues.machineId)),
  /**
   * Correlated on `issues.id` in the WHERE, so drizzle qualifies it back to
   * the OUTER row rather than self-joining; the select list is the literal
   * `1`, so there is no unqualified column here to silently rebind onto
   * `sessions`. `legacyWorktreeBackfillSql` pins both properties.
   */
  contradictorySession: exists(
    db
      .select({ one: sql`1` })
      .from(sessions)
      .where(
        and(
          or(eq(sessions.issueId, issues.id), eq(sessions.refIssueId, issues.id)),
          ne(sessions.machineId, param(sessions.machineId, 'hostMachineId')),
        ),
      ),
  ),
}))

/** Counts the candidates the contradiction evidence tells the backfill to leave alone. */
const legacyWorktreeSkippedBuilder = prepared((db: StoreDrizzle) => {
  const { legacyWorktreeRow, contradictorySession } = legacyWorktreeTerms(db)
  return db
    .select({ c: count() })
    .from(issues)
    .where(and(legacyWorktreeRow, contradictorySession))
})

const legacyWorktreeSkipped = prepared((db: StoreDrizzle) =>
  legacyWorktreeSkippedBuilder(db).prepare(),
)

/** Labels by lower-cased name, one shape per IN-list size (see {@link inListSize}). */
const labelsNamed = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select()
    .from(labels)
    .where(
      inArray(
        sql`lower(${labels.name})`,
        Array.from({ length: size }, (_, index) => sql.placeholder(`name${index}`)),
      ),
    )
    .prepare(),
)

/** A label's colour and/or description; one shape per set of patched columns. */
const patchLabel = preparedFamily((db: StoreDrizzle, shape: string) =>
  db
    .update(labels)
    .set(placeholdersFor(shape) as Partial<typeof labels.$inferInsert>)
    .where(eq(labels.id, param(labels.id, 'id')))
    .prepare(),
)

const insertLabelRow = prepared((db: StoreDrizzle) =>
  db
    .insert(labels)
    .values({
      name: sql.placeholder('name'),
      color: sql.placeholder('color'),
      description: sql.placeholder('description'),
      createdAt: sql.placeholder('createdAt'),
    })
    .returning()
    .prepare(),
)

const labelVocabulary = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(labels)
    .orderBy(asc(sql`lower(${labels.name})`))
    .prepare(),
)

const deleteLabelsOf = prepared((db: StoreDrizzle) =>
  db
    .delete(issueLabels)
    .where(eq(issueLabels.issueId, param(issueLabels.issueId, 'issueId')))
    .prepare(),
)

const insertLabel = prepared((db: StoreDrizzle) =>
  db
    .insert(issueLabels)
    .values({ issueId: sql.placeholder('issueId'), labelId: sql.placeholder('labelId') })
    .onConflictDoNothing()
    .prepare(),
)

const labelsOf = prepared((db: StoreDrizzle) =>
  db
    .select({ label: labels.name })
    .from(issueLabels)
    .innerJoin(labels, eq(labels.id, issueLabels.labelId))
    .where(eq(issueLabels.issueId, param(issueLabels.issueId, 'issueId')))
    .orderBy(asc(labels.name))
    .prepare(),
)

const insertDep = prepared((db: StoreDrizzle) =>
  db
    .insert(issueDeps)
    .values({
      fromId: sql.placeholder('fromId'),
      toId: sql.placeholder('toId'),
      type: sql.placeholder('type'),
    })
    .onConflictDoNothing()
    .prepare(),
)

const deleteDepOfType = prepared((db: StoreDrizzle) =>
  db
    .delete(issueDeps)
    .where(
      and(
        eq(issueDeps.fromId, param(issueDeps.fromId, 'fromId')),
        eq(issueDeps.toId, param(issueDeps.toId, 'toId')),
        eq(issueDeps.type, param(issueDeps.type, 'type')),
      ),
    )
    .prepare(),
)

const deleteDepsBetween = prepared((db: StoreDrizzle) =>
  db
    .delete(issueDeps)
    .where(
      and(
        eq(issueDeps.fromId, param(issueDeps.fromId, 'fromId')),
        eq(issueDeps.toId, param(issueDeps.toId, 'toId')),
      ),
    )
    .prepare(),
)

const depsFrom = prepared((db: StoreDrizzle) =>
  db
    .select({ toId: issueDeps.toId, type: issueDeps.type })
    .from(issueDeps)
    .where(eq(issueDeps.fromId, param(issueDeps.fromId, 'fromId')))
    .orderBy(asc(issueDeps.toId), asc(issueDeps.type))
    .prepare(),
)

const allDeps = prepared((db: StoreDrizzle) =>
  db
    .select({ fromId: issueDeps.fromId, toId: issueDeps.toId, type: issueDeps.type })
    .from(issueDeps)
    .orderBy(asc(issueDeps.fromId), asc(issueDeps.toId), asc(issueDeps.type))
    .prepare(),
)

const depsTo = prepared((db: StoreDrizzle) =>
  db
    .select({ fromId: issueDeps.fromId, type: issueDeps.type })
    .from(issueDeps)
    .where(eq(issueDeps.toId, param(issueDeps.toId, 'toId')))
    .orderBy(asc(issueDeps.fromId), asc(issueDeps.type))
    .prepare(),
)

const insertComment = prepared((db: StoreDrizzle) =>
  db
    .insert(issueComments)
    .values({
      id: sql.placeholder('id'),
      issueId: sql.placeholder('issueId'),
      author: sql.placeholder('author'),
      body: sql.placeholder('body'),
      createdAt: sql.placeholder('createdAt'),
      actor: sql.placeholder('actor'),
      onBehalfOf: sql.placeholder('onBehalfOf'),
    })
    .prepare(),
)

const commentsOf = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(issueComments)
    .where(eq(issueComments.issueId, param(issueComments.issueId, 'issueId')))
    .orderBy(asc(issueComments.createdAt), asc(issueComments.id))
    .prepare(),
)

const commentCountOf = prepared((db: StoreDrizzle) =>
  db
    .select({ n: count() })
    .from(issueComments)
    .where(eq(issueComments.issueId, param(issueComments.issueId, 'issueId')))
    .prepare(),
)

const commentCountsByIssue = prepared((db: StoreDrizzle) =>
  db
    .select({ issueId: issueComments.issueId, n: count() })
    .from(issueComments)
    .groupBy(issueComments.issueId)
    .prepare(),
)

/**
 * The ESCAPE clause is what makes `%` and `_` in a user's query LITERAL.
 * drizzle's `like()` emits no ESCAPE, so this stays a fragment; dropping it
 * would make a query of `100%` match every comment.
 */
const commentSearch = preparedFamily((db: StoreDrizzle, limited: 'all' | 'limited') => {
  const base = db
    .select({
      issueId: issueComments.issueId,
      body: issueComments.body,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(sql`${issueComments.body} LIKE ${sql.placeholder('pattern')} ESCAPE '\\'`)
    .orderBy(desc(issueComments.createdAt))
  return limited === 'all' ? base.prepare() : base.limit(sql.placeholder('limit')).prepare()
})

const insertMessage = prepared((db: StoreDrizzle) =>
  db
    .insert(issueMessages)
    .values({
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

const messageById = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(issueMessages)
    .where(eq(issueMessages.id, param(issueMessages.id, 'id')))
    .prepare(),
)

const messagesOf = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(issueMessages)
    .where(eq(issueMessages.issueId, param(issueMessages.issueId, 'issueId')))
    .orderBy(asc(issueMessages.createdAt), asc(issueMessages.id))
    .prepare(),
)

const messagesOfWithStatus = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(issueMessages)
    .where(
      and(
        eq(issueMessages.issueId, param(issueMessages.issueId, 'issueId')),
        eq(issueMessages.status, param(issueMessages.status, 'status')),
      ),
    )
    .orderBy(asc(issueMessages.createdAt), asc(issueMessages.id))
    .prepare(),
)

const unreadMessageCountOf = prepared((db: StoreDrizzle) =>
  db
    .select({ n: count() })
    .from(issueMessages)
    .where(
      and(
        eq(issueMessages.issueId, param(issueMessages.issueId, 'issueId')),
        eq(issueMessages.status, 'unread'),
      ),
    )
    .prepare(),
)

/** Only `unread` flips, so a `claimed` message never regresses to `read`. */
const markMessageRead = prepared((db: StoreDrizzle) =>
  db
    .update(issueMessages)
    .set({ status: 'read' })
    .where(
      and(
        eq(issueMessages.issueId, param(issueMessages.issueId, 'issueId')),
        eq(issueMessages.id, param(issueMessages.id, 'id')),
        eq(issueMessages.status, 'unread'),
      ),
    )
    .prepare(),
)

const upsertMessageReadAt = prepared((db: StoreDrizzle) =>
  db
    .insert(issueMessageUserState)
    .values({
      userId: sql.placeholder('userId'),
      issueMessageId: sql.placeholder('issueMessageId'),
      readAt: sql.placeholder('readAt'),
    })
    .onConflictDoUpdate({
      target: [issueMessageUserState.userId, issueMessageUserState.issueMessageId],
      set: { readAt: sql.placeholder('readAt') },
    })
    .prepare(),
)

const messageReadAtOf = prepared((db: StoreDrizzle) =>
  db
    .select({
      issueMessageId: issueMessageUserState.issueMessageId,
      readAt: issueMessageUserState.readAt,
    })
    .from(issueMessageUserState)
    .where(eq(issueMessageUserState.userId, param(issueMessageUserState.userId, 'userId')))
    .prepare(),
)

const issueUserStateFeedColumns = {
  userId: issueUserState.userId,
  entityId: issueUserState.issueId,
  readAt: issueUserState.readAt,
  tuckedAt: issueUserState.tuckedAt,
  pinnedAt: issueUserState.pinnedAt,
}

const allIssueUserStateRows = prepared((db: StoreDrizzle) =>
  db.select(issueUserStateFeedColumns).from(issueUserState).prepare(),
)

const issueUserStateRowsOf = prepared((db: StoreDrizzle) =>
  db
    .select(issueUserStateFeedColumns)
    .from(issueUserState)
    .where(eq(issueUserState.issueId, param(issueUserState.issueId, 'issueId')))
    .prepare(),
)

const issueUserStateOne = prepared((db: StoreDrizzle) =>
  db
    .select({
      readAt: issueUserState.readAt,
      tuckedAt: issueUserState.tuckedAt,
      pinnedAt: issueUserState.pinnedAt,
    })
    .from(issueUserState)
    .where(
      and(
        eq(issueUserState.userId, param(issueUserState.userId, 'userId')),
        eq(issueUserState.issueId, param(issueUserState.issueId, 'issueId')),
      ),
    )
    .prepare(),
)

const deleteIssueUserStateOne = prepared((db: StoreDrizzle) =>
  db
    .delete(issueUserState)
    .where(
      and(
        eq(issueUserState.userId, param(issueUserState.userId, 'userId')),
        eq(issueUserState.issueId, param(issueUserState.issueId, 'issueId')),
      ),
    )
    .prepare(),
)

const upsertIssueUserState = prepared((db: StoreDrizzle) =>
  db
    .insert(issueUserState)
    .values({
      userId: sql.placeholder('userId'),
      issueId: sql.placeholder('issueId'),
      readAt: sql.placeholder('readAt'),
      tuckedAt: sql.placeholder('tuckedAt'),
      pinnedAt: sql.placeholder('pinnedAt'),
    })
    .onConflictDoUpdate({
      target: [issueUserState.userId, issueUserState.issueId],
      set: {
        readAt: sql.placeholder('readAt'),
        tuckedAt: sql.placeholder('tuckedAt'),
        pinnedAt: sql.placeholder('pinnedAt'),
      },
    })
    .prepare(),
)

const deleteIssueUserStateOf = prepared((db: StoreDrizzle) =>
  db
    .delete(issueUserState)
    .where(eq(issueUserState.issueId, param(issueUserState.issueId, 'issueId')))
    .prepare(),
)

/** Single UPDATE guarded on status, so there is no read-then-write race. */
const claimMessage = prepared((db: StoreDrizzle) =>
  db
    .update(issueMessages)
    .set({
      status: 'claimed',
      claimedBy: sql.placeholder('claimedBy'),
      claimedAt: sql.placeholder('claimedAt'),
    })
    .where(and(eq(issueMessages.id, param(issueMessages.id, 'id')), ne(issueMessages.status, 'claimed')))
    .prepare(),
)

const deleteMessagesOf = prepared((db: StoreDrizzle) =>
  db
    .delete(issueMessages)
    .where(eq(issueMessages.issueId, param(issueMessages.issueId, 'issueId')))
    .prepare(),
)

const deleteDepsTouching = prepared((db: StoreDrizzle) =>
  db
    .delete(issueDeps)
    .where(
      or(
        eq(issueDeps.fromId, param(issueDeps.fromId, 'issueId')),
        eq(issueDeps.toId, param(issueDeps.toId, 'issueId')),
      ),
    )
    .prepare(),
)

const deleteCommentsOf = prepared((db: StoreDrizzle) =>
  db
    .delete(issueComments)
    .where(eq(issueComments.issueId, param(issueComments.issueId, 'issueId')))
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
  'activityNotes',
  'notesUpdatedAt',
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
  'landedAt',
  'landedSha',
  'supersededBy',
  'duplicateOf',
  'sortKey',
  'color',
  'estimateMin',
  'needsHuman',
  'humanQuestion',
  'humanQuestionOptions',
  'humanQuestionAskedBy',
  'humanQuestionAskedAt',
  'humanQuestionAttribution',
  'panel',
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
    if (order === 'path-seq') return text(a.repoPath, b.repoPath) || a.seq - b.seq || text(a.id, b.id)
    if (order === 'updated') return Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || text(a.repoPath, b.repoPath) || a.seq - b.seq
    if (order === 'priority-seq') {
      return a.priority - b.priority || a.seq - b.seq || text(a.repoPath, b.repoPath) || text(a.id, b.id)
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
function structurallySound(r: { id: unknown; repoPath: unknown; stage: unknown; title: unknown }): boolean {
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
    id: unknown; repoId: string | null; repoPath: unknown; machineId: string | null; seq: number
    stage: unknown; title: unknown
  }[],
): IssueRefRow[] {
  return rows.flatMap((row) =>
    structurallySound(row)
      ? [{ id: asIssueId(row.id as string), repoId: (row.repoId ?? null) as RepoId | null,
          repoPath: row.repoPath as string, machineId: (row.machineId ?? null) as MachineId | null, seq: row.seq }]
      : [],
  )
}

export interface WorktreeOwnerRow {
  id: IssueId
  repoPath: string
  seq: number
  worktreePath: string | null
  archived: boolean
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
  readonly committed: CommittedRows<typeof issues.$inferSelect>
  private sessionRefPublisher: ((ids: readonly IssueId[]) => Promise<void>) | undefined

  /** Composition hook for the two repairs that change permanent session refs.
   * Runs inside their write span; it declares authority rows, never broadcasts. */
  setSessionRefPublisher(publish: (ids: readonly IssueId[]) => Promise<void>): void {
    this.sessionRefPublisher = publish
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
  private readonly userStateLoader = operationLoader<string, StoredIssueUserState>(async (keys) => {
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
        found.set(`${user}\u0000${r.issueId}`, { readAt: r.readAt, tuckedAt: r.tuckedAt, pinnedAt: r.pinnedAt })
      }
    }
    return found
  }, { copy: (state) => ({ ...state }), perOperation: true })
  /**
   * Issue rows by id, batched per operation (POD-6158): the per-row reads of a
   * listing's authorization pass, asked together, are one `IN (...)` query.
   * Shares {@link getIssues}' mapping and quarantine; every caller gets its
   * own copy.
   */
  private readonly rowLoader = operationLoader<string, IssueRow>(
    async (ids) => await this.readIssuesByIds(ids),
    { copy: (row) => ({ ...row, blockedBy: [...row.blockedBy],
      humanQuestionOptions: row.humanQuestionOptions ? [...row.humanQuestionOptions] : row.humanQuestionOptions }),
      perOperation: true },
  )
  private readonly rootDb: StoreDrizzle
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
    upsert?: (db: StoreDrizzle, shape: string) => IssueRowsWrite
    shippingStage?: (db: StoreDrizzle) => IssueRowsWrite
    remove?: (db: StoreDrizzle) => IssueRowsWrite
    seq?: (db: StoreDrizzle) => IssueRowsWrite
    repoIdAndSeq?: (db: StoreDrizzle) => IssueRowsWrite
    legacyMachine?: (db: StoreDrizzle) => IssueRowsWrite
  } = {}

  constructor(
    queries: StoreQueries,
    /** Repos-aggregate lookup: stable repo_id for an issue's repoPath. */
    private readonly resolveRepoIdForPath: (
      repoPath: string,
      machineId?: MachineId | null,
    ) => string | Promise<string>,
  ) {
    this.committed = new CommittedRows(queries.createOrJoinTransaction, 'issues')
    // The per-operation loaders are invalidated after each write (rowsWritten)
    // AND after each commit of one, which makes their memos exact inside write
    // spans (POD-6189, operation-loader.ts). Deleting an issue cascades to its
    // markers, so the marker loader follows the issue feed too.
    this.committed.subscribe(() => this.rowsWritten())
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * The query layer. `StoreQueries` is wiring and is named here and nowhere else
   * (spec rule 34), so a call site reads as a query.
   *
   * A GETTER, not a field (rule 34a): once transaction routing is ambient
   * (rule 35) this resolves the ENCLOSING transaction on every access, and a
   * field frozen at construction could never do that. B1 changes this one line.
   */
  protected get db(): StoreDrizzle {
    return this.rootDb
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
  ): Promise<{ changes: number }> {
    const result = await this.committed.write(query, operation)
    this.rowsWritten()
    return result
  }

  private rowsWritten(): void {
    this.rowLoader.invalidate()
    this.userStateLoader.invalidate()
  }

  /** A marker write: invalidated after it and, inside a span, after its commit. */
  private userStateWritten(): void {
    this.userStateLoader.invalidate()
    if (spanOpen()) applyAfterCommit(() => this.userStateLoader.invalidate(), 'issue-user-state:loader')
  }

  /** The current scope's cache, opened on first use and discarded when the
   *  scope ends. Undefined once a write in this scope has disabled caching. */
  private async frameRows(): Promise<Map<string, IssueRow | null> | undefined> {
    const held = currentReadScope().slot(this.rowCacheSlot)
    return held.disabled ? undefined : held.rows
  }

  async upsertIssue(
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
      acceptance: row.acceptance,
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
      humanQuestionAttribution: row.humanQuestionAttribution
        ? JSON.stringify(row.humanQuestionAttribution)
        : null,
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
    // The SHAPE is the set of keys this row actually sets: drizzle renders an
    // undefined `values` key as NULL and drops an undefined `set` key, so a
    // row with an undefined column is a different statement, as it always was.
    const upsert = (this.issueWrites.upsert ??= preparedFamily((db: StoreDrizzle, shape: string) => {
      const placeholders = placeholdersFor(shape)
      const set: Record<string, Placeholder> = {}
      for (const column of UPSERT_ISSUE_SET_COLUMNS) {
        const placeholder = placeholders[column]
        if (placeholder !== undefined) set[column] = placeholder
      }
      return db
        .insert(issues)
        .values(placeholders as unknown as typeof issues.$inferInsert)
        .onConflictDoUpdate({
          target: issues.id,
          set: set as unknown as Partial<typeof issues.$inferInsert>,
        })
        .returning()
        .prepare()
    }))
    await this.writeRows(
      async () => await upsert(this.db, shapeOf(values)).all(values),
      'upsert',
    )
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
    const transition = (this.issueWrites.shippingStage ??= prepared((db: StoreDrizzle) =>
      db
        .update(issues)
        .set({
          stage: sql.placeholder('nextStage'),
          updatedAt: sql.placeholder('updatedAt'),
          revision: sql`COALESCE(${issues.revision}, 0) + 1`,
        })
        .where(
          and(
            eq(issues.id, param(issues.id, 'id')),
            eq(issues.stage, param(issues.stage, 'expectedStage')),
            isNull(issues.deletedAt),
          ),
        )
        .returning()
        .prepare(),
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
      for (const r of await issuesByIds(this.db, size).all(inListValues(chunk.map(asIssueId), size, 'ids'))) {
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
      for (const row of issueRefRows(await issueRefsAtSeqsOf(this.db, size).all(inListValues(chunk, size, 'seqs')))) {
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
    const key = shape.parents !== undefined ? 'parents' : shape.ids !== undefined ? 'ids' : undefined
    const chunks = key && list ? chunked([...new Set(list)], 500) : [undefined]
    const raw: (typeof issues.$inferSelect)[] = []
    for (const chunk of chunks) {
      if (chunk !== undefined && chunk.length === 0) continue
      const sized: IssueListingShape = chunk === undefined ? shape
        : { ...shape, [key!]: inListSize(chunk.length) }
      raw.push(...(await issueListing(this.db, listingKey(sized)).all(
        listingValues(sized, { ...input, ...(chunk ? { [key!]: chunk } : {}) }),
      )))
    }
    const rows = await this.mapQuarantined(raw)
    return chunks.length > 1 ? sortListing(rows, shape.order) : rows
  }

  /** Per (stage, priority, type, assignee): how many issues of a listing shape,
   *  in the order the groups first appear in (repository path, sequence). */
  async countIssueGroups(
    shape: IssueListingShape,
    input: IssueListingInput = {},
  ): Promise<{ stage: string; priority: number; type: string; assignee: string | null; n: number }[]> {
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
    return { total: row?.total ?? 0, closed: Number(row?.closed ?? 0), ready: Number(row?.ready ?? 0),
      blocked: Number(row?.blocked ?? 0) }
  }

  /** The rows of a listing shape that carry a deferral, and whether each would
   *  otherwise be ready. */
  async deferralsIn(
    shape: IssueListingShape,
    input: IssueListingInput = {},
  ): Promise<{ id: IssueId; deferUntil: string; ready: boolean }[]> {
    const rows = await deferralsOf(this.db, listingKey(shape)).all(listingValues(shape, input))
    return rows.flatMap((r) => typeof r.deferUntil === 'string'
      ? [{ id: r.id as IssueId, deferUntil: r.deferUntil, ready: Number(r.ready) === 1 }] : [])
  }

  /** The narrow rows of one manual-order key space (`issue-listings.ts`
   *  sortScopeOf): a parent's live children, or a repository's live top-level
   *  issues, without the viewer's pinned ones when a viewer is given. */
  async sortScope(
    scope: { parentId: IssueId } | { repoId: RepoId; unpinnedFor?: UserId },
  ): Promise<{ id: IssueId; sortKey: string | null; createdAt: string; seq: number }[]> {
    const rows = 'parentId' in scope
      ? await sortScopeOf(this.db, 'parent').all({ parentId: scope.parentId })
      : scope.unpinnedFor
        ? await sortScopeOf(this.db, 'top-unpinned').all({ repoId: scope.repoId, viewer: scope.unpinnedFor })
        : await sortScopeOf(this.db, 'top').all({ repoId: scope.repoId })
    return rows.flatMap((r) => typeof r.id === 'string'
      ? [{ id: r.id as IssueId, sortKey: r.sortKey ?? null, createdAt: r.createdAt, seq: r.seq }] : [])
  }

  /** Labels of these issues, each issue's in name order. */
  async labelsOfIssues(ids: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>()
    for (const r of await perChunk(ids, async (size, values) => await labelsOfIssues(this.db, size).all(values))) {
      const names = out.get(r.issueId)
      if (names) names.push(r.label)
      else out.set(r.issueId, [r.label])
    }
    return out
  }

  /** The dependency edges FROM these issues, in (from, to, type) order. */
  async depsFromIssues(ids: readonly string[]): Promise<{ fromId: IssueId; toId: IssueId; type: string }[]> {
    return await perChunk(ids, async (size, values) => await depsFromIssues(this.db, size).all(values))
  }

  /** The dependency edges TO these issues, in (to, from, type) order. */
  async depsToIssues(ids: readonly string[]): Promise<{ fromId: IssueId; toId: IssueId; type: string }[]> {
    return await perChunk(ids, async (size, values) => await depsToIssues(this.db, size).all(values))
  }

  async commentCountsOfIssues(ids: readonly string[]): Promise<Map<string, number>> {
    const rows = await perChunk(ids, async (size, values) => await commentCountsOfIssues(this.db, size).all(values))
    return new Map(rows.map((r) => [r.issueId, r.n]))
  }

  /** Live children of these parents with their closure columns, in the boot
   *  map's order. */
  async liveChildrenOf(parentIds: readonly string[]): Promise<
    { id: IssueId; parentId: IssueId; stage: string; closedReason: string | null; deletedAt: string | null }[]
  > {
    // A parent's children all come back in its own chunk, in their order.
    const rows = await perChunk(parentIds, async (size, values) => await liveChildrenOf(this.db, size).all(values))
    return rows.flatMap((r) => typeof r.id === 'string' && r.parentId
      ? [{ id: r.id as IssueId, parentId: r.parentId as IssueId, stage: r.stage, closedReason: r.closedReason, deletedAt: r.deletedAt }]
      : [])
  }

  /** Which of these issues `reader` may see (owner or read-covering grant). */
  async readableAmong(ids: readonly string[], reader: UserId): Promise<Set<string>> {
    const rows = await perChunk(ids, async (size, values) =>
      await readableAmong(this.db, size).all({ ...values, reader }))
    return new Set(rows.map((r) => r.id))
  }

  /** The closure columns of these issues (stage, close reason, deletion). */
  async closureOf(ids: readonly string[]): Promise<Map<string, { stage: string; closedReason: string | null; deletedAt: string | null }>> {
    const out = new Map<string, { stage: string; closedReason: string | null; deletedAt: string | null }>()
    for (const r of await perChunk(ids, async (size, values) => await issueClosureRowsOf(this.db, size).all(values))) {
      if (typeof r.id !== 'string') continue
      out.set(r.id, { stage: typeof r.stage === 'string' ? r.stage : '', closedReason: r.closedReason, deletedAt: r.deletedAt })
    }
    return out
  }

  /** Map raw rows, skipping (and logging) the structurally corrupt ones. */
  private async mapQuarantined(rows: readonly (typeof issues.$inferSelect)[]): Promise<IssueRow[]> {
    const out: IssueRow[] = []
    for (const r of rows) {
      try {
        if (!structurallySound(r)) throw new Error('structurally corrupt row (non-string id/repo_path/stage/title)')
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
      for (const id of closedOf(await issueClosureRowsOf(this.db, size).all(inListValues(chunk.map(asIssueId), size, 'ids')))) out.add(id)
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
      const rows: (typeof issues.$inferSelect)[] = after === null
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
    for (let at = 0; at < Math.max(literalKeys.length, foldedKeys.length); at += WORKTREE_OWNER_CHUNK) {
      const literalChunk = literalKeys.slice(at, at + WORKTREE_OWNER_CHUNK)
      const foldedChunk = foldedKeys.slice(at, at + WORKTREE_OWNER_CHUNK)
      const size = inListSize(Math.max(literalChunk.length, foldedChunk.length, 1))
      // An empty arm is padded with '': no live worktree is the empty path.
      const values = inListValues(literalChunk.length ? literalChunk : [''], size, 'lit')
      inListValues(foldedChunk.length ? foldedChunk : [''], size, 'fold', values)
      for (const row of await worktreeOwnersOf(this.db, size).all(values)) {
        // The structural quarantine every cwd reader applies.
        if (typeof row.id !== 'string' || typeof row.repoPath !== 'string') continue
        byId.set(row.id, { id: asIssueId(row.id), repoPath: row.repoPath, seq: row.seq,
          worktreePath: row.worktreePath, archived: row.archived })
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
    const remove = (this.issueWrites.remove ??= prepared((db: StoreDrizzle) =>
      db
        .delete(issues)
        .where(eq(issues.id, param(issues.id, 'id')))
        .returning()
        .prepare(),
    ))
    await this.writeRows(
      async () => await remove(this.db).all({ id: asIssueId(id) }),
      'delete',
    )
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
    const setSeq = (this.issueWrites.seq ??= prepared((db: StoreDrizzle) =>
      db
        .update(issues)
        .set({ seq: sql.placeholder('seq') })
        .where(eq(issues.id, param(issues.id, 'id')))
        .returning()
        .prepare(),
    ))
    await this.createOrJoinTransaction(async () => {
      for (const u of updates) {
        await this.writeRows(
          async () => await setSeq(this.db).all({ id: u.id, seq: u.seq }),
          'upsert',
        )
      }
      await this.sessionRefPublisher?.(updates.map((update) => update.id))
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
    const setRepoIdAndSeq = (this.issueWrites.repoIdAndSeq ??= prepared((db: StoreDrizzle) =>
      db
        .update(issues)
        .set({ repoId: sql.placeholder('repoId'), seq: sql.placeholder('seq') })
        .where(eq(issues.id, param(issues.id, 'id')))
        .returning()
        .prepare(),
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
        )
      }
      await this.sessionRefPublisher?.(rows.map((row) => row.id))
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
  async backfillLegacyWorktreeMachineIds(
    candidateHostId: MachineId,
  ): Promise<{ hostMachineId: MachineId; backfilled: number; skipped: number } | undefined> {
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
      const backfill = (this.issueWrites.legacyMachine ??= prepared((db: StoreDrizzle) => {
        const { legacyWorktreeRow, contradictorySession } = legacyWorktreeTerms(db)
        return db
          .update(issues)
          .set({ machineId: sql.placeholder('hostMachineId') })
          .where(and(legacyWorktreeRow, not(contradictorySession)))
          .returning()
          .prepare()
      }))
      const backfilled = Number(
        (
          await this.writeRows(
            async () => await backfill(this.db).all({ hostMachineId }),
            'upsert',
          )
        ).changes,
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
    return legacyWorktreeSkippedBuilder(this.db).toSQL().sql
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
    })
  }

  async listIssueComments(issueId: IssueId): Promise<IssueCommentRow[]> {
    return await commentsOf(this.db).all({ issueId })
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
    userId: UserId,
    issueId: IssueId,
    ids: string[],
    readAt: string,
  ): Promise<void> {
    requireUserId(userId)
    for (const id of ids) {
      // Only `unread` flips, so a `claimed` message never regresses to `read`.
      await markMessageRead(this.db).run({ issueId, id })
      // Written for EVERY named message, not only the unread ones.
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
  async loadIssueUserState(userId: UserId, issueId: IssueId): Promise<StoredIssueUserState | undefined> {
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

  async getIssueUserState(
    userId: UserId,
    issueId: IssueId,
  ): Promise<StoredIssueUserState | undefined> {
    requireUserId(userId)
    const r = await issueUserStateOne(this.db).get({ userId, issueId })
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
  async setIssueUserState(
    userId: UserId,
    issueId: IssueId,
    patch: Partial<StoredIssueUserState>,
  ): Promise<void> {
    requireUserId(userId)
    if (!issueId) throw new Error('issue user-state issue id is empty')
    const current = (await this.getIssueUserState(userId, issueId)) ?? {
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
      await deleteIssueUserStateOne(this.db).run({ userId, issueId })
      this.userStateWritten()
      return
    }
    await upsertIssueUserState(this.db).run({
      userId,
      issueId,
      readAt: next.readAt,
      tuckedAt: next.tuckedAt,
      pinnedAt: next.pinnedAt,
    })
    this.userStateWritten()
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
    await this.deleteIssueMessagesForIssue(issueId)
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
    activityNotes: r.activityNotes,
    notesUpdatedAt: r.notesUpdatedAt,
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
    humanQuestionAskedBy: r.humanQuestionAskedBy ?? null,
    humanQuestionAskedAt: r.humanQuestionAskedAt,
    humanQuestionAttribution: questionAttribution(r.humanQuestionAttribution),
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
