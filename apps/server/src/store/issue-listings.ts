/**
 * ISSUE LISTINGS IN SQL (POD-6191, part of the issue map removal POD-6158).
 *
 * The listings (`issues.list`, ready, blocked, graph, tree, children, search,
 * counts...) used to scan IssueStore's in-memory map of every issue and filter,
 * sort and join in JavaScript, with table-wide reads of every label, dep and
 * comment count for each report (server-data rules 4 and 5). Here the filter,
 * the visibility check and the order are SQL, and the joins a report needs are
 * read for the listed rows only.
 *
 * VISIBILITY is the rule `IssueCommandCtx.mayReadIssue` applies per row: the
 * reader owns the issue, or holds a `read`, `write` or `manage` grant on it.
 *
 * WHAT STAYS IN JAVASCRIPT, and why: deferral (`isIssueDeferred` parses
 * `deferUntil` with `Date.parse`, whose zone rules SQLite does not share) is
 * decided on the few rows that carry a `defer_until` at all; Jaccard similarity
 * and the git-log match are not SQL questions.
 */

import type { IssueId, RepoId, UserId } from '@podium/model'
import { and, asc, type Column, count, eq, inArray, isNotNull, isNull, not, type SQL, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { grants, issueComments, issueDeps, issueLabels, issues, issueUserState, labels } from '../migrations/schema'
import { inListOf, inListSize, inListValues, param, preparedFamily, type StoreDrizzle } from './executor/sync-drizzle'

/** Board stages a ready queue may hold (`isReadyIssueStage` over the enum). */
const READY_STAGES = ['backlog', 'planning', 'in_progress', 'review', 'done'] as const
/** Grant verbs that cover reading (`IssueReportsModule.ownedTarget`). */
const READ_VERBS = ['read', 'write', 'manage'] as const

/** The columns these fragments read: the table or an alias of it. */
type IssueColumns = Record<'id' | 'stage' | 'closedReason' | 'ownerUserId' | 'parentId' | 'deletedAt', Column>

/** Finished by board stage or a recorded close reason (`isIssueClosed`). */
function closedOf(table: IssueColumns): SQL {
  return sql`(${table.stage} = 'done' OR ${table.closedReason} IS NOT NULL)`
}

// The fragments below are SQL text, not query builders: each prepared
// definition in this file builds its statement once and embeds them
// (`prepared-guard.test.ts` admits no builder outside a definition).

/** The reader owns the issue or holds a read-covering grant on it, by the
 *  grant's primary key (kind, resource, grantee, verb). */
function readableBy(table: IssueColumns): SQL {
  const verbs = sql.join(READ_VERBS.map((verb) => sql`${verb}`), sql`, `)
  return sql`(${table.ownerUserId} = ${sql.placeholder('reader')} OR EXISTS (SELECT 1 FROM ${grants} WHERE ${grants.resourceKind} = 'issue' AND ${grants.resourceId} = ${table.id} AND ${grants.grantee} = ${sql.placeholder('reader')} AND ${grants.verb} IN (${verbs})))`
}

const blocker = alias(issues, 'blocker')

/** An open `blocked-by` target: the row is blocked unless it is itself closed
 *  (`isIssueBlocked`). A deleted target still blocks while open; a target
 *  whose row is gone does not. */
function blockedOf(table: IssueColumns): SQL {
  return sql`EXISTS (SELECT 1 FROM ${issueDeps} INNER JOIN ${sql.raw('"issues" "blocker"')} ON ${blocker.id} = ${issueDeps.toId} WHERE ${issueDeps.fromId} = ${table.id} AND ${issueDeps.type} = 'blocked-by' AND NOT ${closedOf(blocker)})`
}

const child = alias(issues, 'child')

/**
 * One listing's shape. Every option changes the statement's text, so each
 * combination the code uses is its own prepared statement (a finite set).
 */
export interface IssueListingShape {
  /** `repo_id = :repoId`, the repository scope (every stored issue has one:
   *  the store refuses to boot otherwise, `store.ts` refuseLegacyIdentities). */
  repo: boolean
  /** `deleted_at IS NULL`. */
  live: boolean
  /** Owned by or granted to `:reader`. */
  readable: boolean
  /** `open`: not finished; `closed`: finished; `ready`: open, in a ready
   *  stage and not blocked (deferral is the caller's); `blocked`: open and
   *  blocked. */
  state?: 'open' | 'closed' | 'ready' | 'blocked'
  /** Not archived. */
  unarchived?: boolean
  /** `parent_id IN (...)` at this IN-list size bucket. */
  parents?: number
  /** `id IN (...)` at this IN-list size bucket. */
  ids?: number
  /** `updated_at` before `:before`. */
  updatedBefore?: boolean
  /** Has a live child the reader sees, and every such child is finished. */
  completeParent?: boolean
  /** Carries a deferral (decided by the caller). */
  deferred?: boolean
  /** Has a worktree recorded. */
  hasWorktree?: boolean
  /** Has no parent. */
  topLevel?: boolean
  /** Search equalities, each against its own parameter. */
  stage?: boolean
  priority?: boolean
  type?: boolean
  assignee?: boolean
  parent?: boolean
  label?: boolean
  /** Lowercased ASCII text inside `title description brief`. */
  text?: boolean
  /** `path-seq`: the boot map's order (repository path, sequence);
   *  `updated`: oldest update first. */
  order: 'repo-seq' | 'path-seq' | 'priority-seq' | 'seq' | 'updated'
}

const FLAGS = [
  'unarchived', 'updatedBefore', 'completeParent', 'deferred', 'hasWorktree', 'topLevel', 'stage', 'priority', 'type',
  'assignee', 'parent', 'label', 'text',
] as const

export function listingKey(shape: IssueListingShape): string {
  return [
    shape.repo ? 'repo' : 'all',
    shape.live ? 'live' : 'any',
    shape.readable ? 'readable' : 'unrestricted',
    shape.state ?? 'any-state',
    shape.parents === undefined ? 'any-parent' : `parents${shape.parents}`,
    shape.ids === undefined ? 'any-id' : `ids${shape.ids}`,
    shape.order,
    FLAGS.filter((flag) => shape[flag]).join('+') || 'plain',
  ].join(',')
}

function parseListingKey(key: string): IssueListingShape {
  const [repo, live, readable, state, parents, ids, order, flags] = key.split(',')
  const set = new Set(flags === 'plain' ? [] : flags!.split('+'))
  const shape: IssueListingShape = {
    repo: repo === 'repo',
    live: live === 'live',
    readable: readable === 'readable',
    ...(state !== 'any-state' ? { state: state as IssueListingShape['state'] } : {}),
    ...(parents !== 'any-parent' ? { parents: Number(parents!.slice('parents'.length)) } : {}),
    ...(ids !== 'any-id' ? { ids: Number(ids!.slice('ids'.length)) } : {}),
    order: order as IssueListingShape['order'],
  }
  for (const flag of FLAGS) if (set.has(flag)) shape[flag] = true
  return shape
}

function listingWhere(shape: IssueListingShape): SQL | undefined {
  // The boot load's structural quarantine (`structurallySound` in issues.ts):
  // a corrupt row counts in no listing, as it was in no map.
  const where: SQL[] = [
    sql`${issues.id} IS NOT NULL AND ${issues.repoPath} IS NOT NULL AND ${issues.stage} IS NOT NULL AND ${issues.title} IS NOT NULL`,
  ]
  if (shape.repo) where.push(eq(issues.repoId, param(issues.repoId, 'repoId')))
  if (shape.live) where.push(isNull(issues.deletedAt))
  if (shape.readable) where.push(readableBy(issues))
  if (shape.state === 'closed') where.push(closedOf(issues))
  else if (shape.state) where.push(not(closedOf(issues)))
  if (shape.state === 'ready') {
    where.push(inArray(issues.stage, [...READY_STAGES]), sql`NOT ${blockedOf(issues)}`)
  }
  if (shape.state === 'blocked') where.push(blockedOf(issues))
  if (shape.unarchived) where.push(eq(issues.archived, false))
  if (shape.parents !== undefined) where.push(inListOf(issues.parentId, shape.parents, 'parent'))
  if (shape.ids !== undefined) where.push(inListOf(issues.id, shape.ids, 'id'))
  if (shape.updatedBefore) where.push(sql`julianday(${issues.updatedAt}) < julianday(${sql.placeholder('before')})`)
  if (shape.completeParent) {
    const visible = shape.readable ? sql` AND ${readableBy(child)}` : sql``
    const liveVisibleChild = (extra: SQL) =>
      sql`EXISTS (SELECT 1 FROM ${sql.raw('"issues" "child"')} WHERE ${child.parentId} = ${issues.id} AND ${child.deletedAt} IS NULL${visible} AND ${extra})`
    where.push(liveVisibleChild(sql`1`), sql`NOT ${liveVisibleChild(sql`NOT ${closedOf(child)}`)}`)
  }
  if (shape.deferred) where.push(isNotNull(issues.deferUntil))
  if (shape.hasWorktree) where.push(isNotNull(issues.worktreePath))
  if (shape.topLevel) where.push(isNull(issues.parentId))
  if (shape.stage) where.push(eq(issues.stage, param(issues.stage, 'stage')))
  if (shape.priority) where.push(eq(issues.priority, param(issues.priority, 'priority')))
  if (shape.type) where.push(eq(issues.type, param(issues.type, 'type')))
  if (shape.assignee) where.push(eq(issues.assignee, param(issues.assignee, 'assignee')))
  if (shape.parent) where.push(eq(issues.parentId, param(issues.parentId, 'parent')))
  if (shape.label) {
    where.push(
      sql`EXISTS (SELECT 1 FROM ${issueLabels} INNER JOIN ${labels} ON ${labels.id} = ${issueLabels.labelId} WHERE ${issueLabels.issueId} = ${issues.id} AND ${labels.name} = ${sql.placeholder('label')})`,
    )
  }
  if (shape.text) {
    where.push(
      sql`instr(lower(${issues.title} || ' ' || ${issues.description} || ' ' || coalesce(${issues.brief}, '')), ${sql.placeholder('text')}) > 0`,
    )
  }
  return and(...where)
}

function listingOrder(shape: IssueListingShape) {
  switch (shape.order) {
    // `list`: by repository, then sequence — the unique (repo_id, seq) index.
    case 'repo-seq':
      return [asc(issues.repoId), asc(issues.seq)]
    // Work queues: priority, then sequence; the repository path and id only
    // break ties between repositories, in the order the boot load read them.
    case 'priority-seq':
      return [asc(issues.priority), asc(issues.seq), asc(issues.repoPath), asc(issues.id)]
    case 'path-seq':
      return [asc(issues.repoPath), asc(issues.seq), asc(issues.id)]
    case 'seq':
      return [asc(issues.seq), asc(issues.repoPath), asc(issues.id)]
    case 'updated':
      return [sql`julianday(${issues.updatedAt})`, asc(issues.repoPath), asc(issues.seq)]
  }
}

/** Full issue rows for one listing shape. */
export const issueListing = preparedFamily((db: StoreDrizzle, key: string) => {
  const shape = parseListingKey(key)
  return db
    .select()
    .from(issues)
    .where(listingWhere(shape))
    .orderBy(...listingOrder(shape))
    .prepare()
})

/** The values a listing of this shape binds. */
export interface IssueListingInput {
  repoId?: RepoId
  reader?: UserId
  parents?: readonly string[]
  ids?: readonly string[]
  /** ISO instant for `updatedBefore`. */
  before?: string
  stage?: string
  priority?: number
  type?: string
  assignee?: string
  parent?: string
  label?: string
  /** Already lowercased ASCII. */
  text?: string
}

export function listingValues(shape: IssueListingShape, input: IssueListingInput): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  if (shape.repo) values.repoId = input.repoId
  if (shape.readable) values.reader = input.reader
  if (shape.parents !== undefined) inListValues(input.parents ?? [], shape.parents, 'parent', values)
  if (shape.ids !== undefined) inListValues(input.ids ?? [], shape.ids, 'id', values)
  if (shape.updatedBefore) values.before = input.before
  for (const key of ['stage', 'priority', 'type', 'assignee', 'parent', 'label', 'text'] as const) {
    if (shape[key]) values[key] = input[key]
  }
  return values
}

/** Counted per (stage, priority, type, assignee) for `issues.count`; the
 *  minimum (repo path, sequence) of each group keeps the boot map's order of
 *  first appearance. */
export const issueCountGroups = preparedFamily((db: StoreDrizzle, key: string) => {
  const shape = parseListingKey(key)
  return db
    .select({
      stage: issues.stage,
      priority: issues.priority,
      type: issues.type,
      assignee: issues.assignee,
      n: count(),
      first: sql<string>`min(${issues.repoPath} || char(0) || printf('%020d', ${issues.seq}))`,
    })
    .from(issues)
    .where(listingWhere(shape))
    .groupBy(issues.stage, issues.priority, issues.type, issues.assignee)
    .prepare()
})

/** `issues.stats`: totals over one listing shape; deferral is counted by the
 *  caller over the rows that carry a `defer_until`. */
export const issueStatTotals = preparedFamily((db: StoreDrizzle, key: string) => {
  const shape = parseListingKey(key)
  return db
    .select({
      total: count(),
      closed: sql<number>`coalesce(sum(case when ${closedOf(issues)} then 1 else 0 end), 0)`,
      ready: sql<number>`coalesce(sum(case when not ${closedOf(issues)} and ${inArray(issues.stage, [...READY_STAGES])} and not ${blockedOf(issues)} then 1 else 0 end), 0)`,
      blocked: sql<number>`coalesce(sum(case when not ${closedOf(issues)} and ${blockedOf(issues)} then 1 else 0 end), 0)`,
    })
    .from(issues)
    .where(listingWhere(shape))
    .prepare()
})

/** The rows of one listing shape that carry a deferral, with what deciding it
 *  for `ready` needs. */
export const deferralsOf = preparedFamily((db: StoreDrizzle, key: string) => {
  const shape = parseListingKey(key)
  return db
    .select({
      id: issues.id,
      deferUntil: issues.deferUntil,
      ready: sql<number>`case when not ${closedOf(issues)} and ${inArray(issues.stage, [...READY_STAGES])} and not ${blockedOf(issues)} then 1 else 0 end`,
    })
    .from(issues)
    .where(and(listingWhere(shape), isNotNull(issues.deferUntil)))
    .prepare()
})

// ---- the manual-order key space (POD-6192) ---------------------------------

/**
 * One sort-key scope, narrow: a parent's live children (`parent`), or a
 * repository's live top-level issues (`top`), optionally without the ones the
 * broadcast viewer pinned (`top-unpinned`), which have their own section.
 */
export const sortScopeOf = preparedFamily((db: StoreDrizzle, key: 'parent' | 'top' | 'top-unpinned') =>
  db
    .select({
      id: issues.id,
      sortKey: issues.sortKey,
      createdAt: issues.createdAt,
      seq: issues.seq,
    })
    .from(issues)
    .where(
      and(
        isNull(issues.deletedAt),
        ...(key === 'parent'
          ? [eq(issues.parentId, param(issues.parentId, 'parentId'))]
          : [isNull(issues.parentId), eq(issues.repoId, param(issues.repoId, 'repoId'))]),
        ...(key === 'top-unpinned'
          ? [sql`NOT EXISTS (SELECT 1 FROM ${issueUserState} WHERE ${issueUserState.userId} = ${sql.placeholder('viewer')} AND ${issueUserState.issueId} = ${issues.id} AND ${issueUserState.pinnedAt} IS NOT NULL)`]
          : []),
      ),
    )
    .prepare(),
)

// ---- the joins a report needs, for the listed rows only -------------------

export const labelsOfIssues = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ issueId: issueLabels.issueId, label: labels.name })
    .from(issueLabels)
    .innerJoin(labels, eq(labels.id, issueLabels.labelId))
    .where(inListOf(issueLabels.issueId, size, 'ids'))
    .orderBy(asc(issueLabels.issueId), asc(labels.name))
    .prepare(),
)

export const depsFromIssues = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ fromId: issueDeps.fromId, toId: issueDeps.toId, type: issueDeps.type })
    .from(issueDeps)
    .where(inListOf(issueDeps.fromId, size, 'ids'))
    .orderBy(asc(issueDeps.fromId), asc(issueDeps.toId), asc(issueDeps.type))
    .prepare(),
)

export const depsToIssues = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ fromId: issueDeps.fromId, toId: issueDeps.toId, type: issueDeps.type })
    .from(issueDeps)
    .where(inListOf(issueDeps.toId, size, 'ids'))
    .orderBy(asc(issueDeps.toId), asc(issueDeps.fromId), asc(issueDeps.type))
    .prepare(),
)

export const commentCountsOfIssues = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ issueId: issueComments.issueId, n: count() })
    .from(issueComments)
    .where(inListOf(issueComments.issueId, size, 'ids'))
    .groupBy(issueComments.issueId)
    .prepare(),
)

/** Live children of a set of parents, with the columns a report counts them by;
 *  in the boot map's order (repository path, then sequence). */
export const liveChildrenOf = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({
      id: issues.id,
      parentId: issues.parentId,
      stage: issues.stage,
      closedReason: issues.closedReason,
      deletedAt: issues.deletedAt,
    })
    .from(issues)
    .where(and(inListOf(issues.parentId, size, 'ids'), isNull(issues.deletedAt)))
    .orderBy(asc(issues.repoPath), asc(issues.seq), asc(issues.id))
    .prepare(),
)

/** Which of these issues the reader may see. */
export const readableAmong = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ id: issues.id })
    .from(issues)
    .where(and(inListOf(issues.id, size, 'ids'), readableBy(issues)))
    .prepare(),
)

/** IN-list chunking shared by the join reads: one statement per 500 ids. */
export async function perChunk<T>(
  ids: readonly string[],
  run: (size: number, values: Record<string, unknown>) => Promise<T[]>,
): Promise<T[]> {
  const unique = [...new Set(ids)]
  const out: T[] = []
  for (let at = 0; at < unique.length; at += 500) {
    const chunk = unique.slice(at, at + 500)
    const size = inListSize(chunk.length)
    out.push(...(await run(size, inListValues(chunk, size, 'ids'))))
  }
  return out
}

/** The listed ids an IN-list shape is built for: the size bucket of `ids`. */
export function inListBucket(ids: readonly unknown[]): number {
  return inListSize(ids.length)
}

export type { IssueId }
