// workspace-scoped (POD-6959)
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
 * VISIBILITY is not a filter here: every member reads every task (design
 * §2.2, POD-6288), so a listing holds every row its shape selects. What a
 * reader may not receive of a task is taken out of the report afterwards
 * (`modules/issues/execution-visibility.ts`).
 *
 * WHAT STAYS IN JAVASCRIPT, and why: deferral (`isIssueDeferred` parses
 * `deferUntil` with `Date.parse`, whose zone rules SQLite does not share) is
 * decided on the few rows that carry a `defer_until` at all; Jaccard similarity
 * and the git-log match are not SQL questions.
 */

import type { IssueId, RepoId } from '@podium/model'
import {
  and,
  asc,
  type Column,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  not,
  type SQL,
  sql,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { StoreDialect } from './executor/binding'
import { dialectOf } from './executor/dialect-prepared'
import type { StoreTables } from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  inWorkspace,
  param,
  preparedFamily,
  sameWorkspace,
} from './executor/sync-drizzle'
import { throughIndex } from './index-hints'

/** Board stages a ready queue may hold (`isReadyIssueStage` over the enum). */
const READY_STAGES = ['backlog', 'planning', 'in_progress', 'review', 'done'] as const

/** The columns these fragments read: the table or an alias of it. */
type IssueColumns = Record<
  'id' | 'stage' | 'closedReason' | 'ownerUserId' | 'parentId' | 'deletedAt' | 'workspaceId',
  Column
>

/** Finished by board stage or a recorded close reason (`isIssueClosed`). */
function closedOf(table: IssueColumns): SQL {
  return sql`(${table.stage} = 'done' OR ${table.closedReason} IS NOT NULL)`
}

// The fragments below are SQL text, not query builders: each prepared
// definition in this file builds its statement once and embeds them
// (`prepared-guard.test.ts` admits no builder outside a definition).

const blocker = (t: StoreTables) => alias(t.issues, 'blocker')

/** An open `blocked-by` target: the row is blocked unless it is itself closed
 *  (`isIssueBlocked`). A deleted target still blocks while open; a target
 *  whose row is gone does not. */
function blockedOf(t: StoreTables, table: IssueColumns): SQL {
  // Each table in its own scope: the edge in the outer row's workspace, the
  // blocker in the edge's.
  return sql`EXISTS (SELECT 1 FROM ${t.issueDeps} INNER JOIN ${sql.raw('"issues" "blocker"')} ON ${blocker(t).workspaceId} = ${t.issueDeps.workspaceId} AND ${blocker(t).id} = ${t.issueDeps.toId} WHERE ${t.issueDeps.workspaceId} = ${table.workspaceId} AND ${t.issueDeps.fromId} = ${table.id} AND ${t.issueDeps.type} = 'blocked-by' AND NOT ${closedOf(blocker(t))})`
}

const child = (t: StoreTables) => alias(t.issues, 'child')

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
  'unarchived',
  'updatedBefore',
  'completeParent',
  'deferred',
  'hasWorktree',
  'topLevel',
  'stage',
  'priority',
  'type',
  'assignee',
  'parent',
  'label',
  'text',
] as const

export function listingKey(shape: IssueListingShape): string {
  return [
    shape.repo ? 'repo' : 'all',
    shape.live ? 'live' : 'any',
    shape.state ?? 'any-state',
    shape.parents === undefined ? 'any-parent' : `parents${shape.parents}`,
    shape.ids === undefined ? 'any-id' : `ids${shape.ids}`,
    shape.order,
    FLAGS.filter((flag) => shape[flag]).join('+') || 'plain',
  ].join(',')
}

function parseListingKey(key: string): IssueListingShape {
  const [repo, live, state, parents, ids, order, flags] = key.split(',')
  const set = new Set(flags === 'plain' ? [] : flags!.split('+'))
  const shape: IssueListingShape = {
    repo: repo === 'repo',
    live: live === 'live',
    ...(state !== 'any-state' ? { state: state as IssueListingShape['state'] } : {}),
    ...(parents !== 'any-parent' ? { parents: Number(parents!.slice('parents'.length)) } : {}),
    ...(ids !== 'any-id' ? { ids: Number(ids!.slice('ids'.length)) } : {}),
    order: order as IssueListingShape['order'],
  }
  for (const flag of FLAGS) if (set.has(flag)) shape[flag] = true
  return shape
}

/**
 * The two engines' forms of what differs (POD-6984, POD-6958 design 2.3): SQLite
 * compares the text `updated_at` as an instant through `julianday`, Postgres compares
 * and orders its `timestamptz` column directly; SQLite's `instr` is Postgres's
 * `strpos`, over a lowered text kept in byte order (`COLLATE "C"`, rule 13), which
 * also keeps Postgres's `lower()` to ASCII as SQLite's is.
 */
function listingWhere(
  t: StoreTables,
  shape: IssueListingShape,
  dialect: StoreDialect,
): SQL | undefined {
  // The boot load's structural quarantine (`structurallySound` in issues.ts):
  // a corrupt row counts in no listing, as it was in no map.
  const where: (SQL | undefined)[] = [
    sql`${t.issues.id} IS NOT NULL AND ${t.issues.repoPath} IS NOT NULL AND ${t.issues.stage} IS NOT NULL AND ${t.issues.title} IS NOT NULL`,
  ]
  if (shape.repo) where.push(eq(t.issues.repoId, param(t.issues.repoId, 'repoId')))
  if (shape.live) where.push(isNull(t.issues.deletedAt))
  if (shape.state === 'closed') where.push(closedOf(t.issues))
  else if (shape.state) where.push(not(closedOf(t.issues)))
  if (shape.state === 'ready') {
    where.push(inArray(t.issues.stage, [...READY_STAGES]), sql`NOT ${blockedOf(t, t.issues)}`)
  }
  if (shape.state === 'blocked') where.push(blockedOf(t, t.issues))
  if (shape.unarchived) where.push(eq(t.issues.archived, false))
  if (shape.parents !== undefined) where.push(inListOf(t.issues.parentId, shape.parents, 'parent'))
  if (shape.ids !== undefined) where.push(inListOf(t.issues.id, shape.ids, 'id'))
  if (shape.updatedBefore)
    where.push(
      dialect === 'pg'
        ? sql`${t.issues.updatedAt} < ${sql.placeholder('before')}`
        : sql`julianday(${t.issues.updatedAt}) < julianday(${sql.placeholder('before')})`,
    )
  if (shape.completeParent) {
    const liveVisibleChild = (extra: SQL) =>
      sql`EXISTS (SELECT 1 FROM ${sql.raw('"issues" "child"')} WHERE ${child(t).workspaceId} = ${t.issues.workspaceId} AND ${child(t).parentId} = ${t.issues.id} AND ${child(t).deletedAt} IS NULL AND ${extra})`
    where.push(
      // Postgres refuses an integer as an AND operand; SQLite keeps its text (POD-6992).
      liveVisibleChild(dialect === 'pg' ? sql`TRUE` : sql`1`),
      sql`NOT ${liveVisibleChild(sql`NOT ${closedOf(child(t))}`)}`,
    )
  }
  if (shape.deferred) where.push(isNotNull(t.issues.deferUntil))
  if (shape.hasWorktree) where.push(isNotNull(t.issues.worktreePath))
  if (shape.topLevel) where.push(isNull(t.issues.parentId))
  if (shape.stage) where.push(eq(t.issues.stage, param(t.issues.stage, 'stage')))
  if (shape.priority) where.push(eq(t.issues.priority, param(t.issues.priority, 'priority')))
  if (shape.type) where.push(eq(t.issues.type, param(t.issues.type, 'type')))
  // THE ASSIGNEE IS THE OWNER (POD-6287, design §4.3): `issues.assignee` is
  // only a legacy display label now, so the filter matches the accountable human.
  if (shape.assignee) where.push(eq(t.issues.ownerUserId, param(t.issues.ownerUserId, 'assignee')))
  if (shape.parent) where.push(eq(t.issues.parentId, param(t.issues.parentId, 'parent')))
  if (shape.label) {
    where.push(
      sql`EXISTS (SELECT 1 FROM ${t.issueLabels} INNER JOIN ${t.labels} ON ${t.labels.workspaceId} = ${t.issueLabels.workspaceId} AND ${t.labels.id} = ${t.issueLabels.labelId} WHERE ${t.issueLabels.workspaceId} = ${t.issues.workspaceId} AND ${t.issueLabels.issueId} = ${t.issues.id} AND ${t.labels.name} = ${sql.placeholder('label')})`,
    )
  }
  if (shape.text) {
    const haystack = sql`${t.issues.title} || ' ' || ${t.issues.description} || ' ' || coalesce(${t.issues.brief}, '')`
    where.push(
      dialect === 'pg'
        ? sql`strpos(lower((${haystack}) COLLATE "C"), ${sql.placeholder('text')}) > 0`
        : sql`instr(lower(${haystack}), ${sql.placeholder('text')}) > 0`,
    )
  }
  return inWorkspace(t.issues, ...where)
}

function listingOrder(t: StoreTables, shape: IssueListingShape, dialect: StoreDialect) {
  switch (shape.order) {
    // `list`: by repository, then sequence — the unique (repo_id, seq) index. A
    // row without a repository id comes first, where SQLite sorts NULL.
    case 'repo-seq':
      return dialect === 'pg'
        ? [sql`${t.issues.repoId} asc nulls first`, asc(t.issues.seq)]
        : [asc(t.issues.repoId), asc(t.issues.seq)]
    // Work queues: priority, then sequence; the repository path and id only
    // break ties between repositories, in the order the boot load read them.
    case 'priority-seq':
      return [asc(t.issues.priority), asc(t.issues.seq), asc(t.issues.repoPath), asc(t.issues.id)]
    case 'path-seq':
      return [asc(t.issues.repoPath), asc(t.issues.seq), asc(t.issues.id)]
    case 'seq':
      return [asc(t.issues.seq), asc(t.issues.repoPath), asc(t.issues.id)]
    case 'updated':
      return [
        dialect === 'pg' ? asc(t.issues.updatedAt) : sql`julianday(${t.issues.updatedAt})`,
        asc(t.issues.repoPath),
        asc(t.issues.seq),
      ]
  }
}

/** Full issue rows for one listing shape. */
export const issueListing = preparedFamily((db, t, key: string) => {
  const shape = parseListingKey(key)
  const dialect = dialectOf(db)
  return db
    .select()
    .from(t.issues)
    .where(listingWhere(t, shape, dialect))
    .orderBy(...listingOrder(t, shape, dialect))
    .prepare()
})

/** The values a listing of this shape binds. */
export interface IssueListingInput {
  repoId?: RepoId
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

export function listingValues(
  shape: IssueListingShape,
  input: IssueListingInput,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  if (shape.repo) values.repoId = input.repoId
  if (shape.parents !== undefined)
    inListValues(input.parents ?? [], shape.parents, 'parent', values)
  if (shape.ids !== undefined) inListValues(input.ids ?? [], shape.ids, 'id', values)
  if (shape.updatedBefore) values.before = input.before
  for (const key of ['stage', 'priority', 'type', 'assignee', 'parent', 'label', 'text'] as const) {
    if (shape[key]) values[key] = input[key]
  }
  return values
}

/** Counted per (stage, priority, type, assignee) for `issues.count`, the
 *  assignee being the owner (POD-6287); the
 *  minimum (repo path, sequence) of each group keeps the boot map's order of
 *  first appearance. `first` is only that order's key: the path, a separator
 *  below every path character (SQLite's NUL; Postgres text cannot hold one, so
 *  U+0001) and the zero-padded sequence, compared in byte order on both engines. */
export const issueCountGroups = preparedFamily((db, t, key: string) => {
  const shape = parseListingKey(key)
  const dialect = dialectOf(db)
  return db
    .select({
      stage: t.issues.stage,
      priority: t.issues.priority,
      type: t.issues.type,
      assignee: t.issues.ownerUserId,
      n: count().as('n'),
      first: (dialect === 'pg'
        ? sql<string>`min((${t.issues.repoPath} || chr(1) || lpad(${t.issues.seq}::text, 20, '0')) COLLATE "C")`
        : sql<string>`min(${t.issues.repoPath} || char(0) || printf('%020d', ${t.issues.seq}))`
      ).as('first'),
    })
    .from(t.issues)
    .where(listingWhere(t, shape, dialect))
    .groupBy(t.issues.stage, t.issues.priority, t.issues.type, t.issues.ownerUserId)
    .prepare()
})

/** `issues.stats`: totals over one listing shape; deferral is counted by the
 *  caller over the rows that carry a `defer_until`. Each total has its own alias:
 *  unaliased, Postgres names all three `coalesce` and the row keeps one of them
 *  (POD-7103; `dialect-census.test.ts` refuses such a select list). */
export const issueStatTotals = preparedFamily((db, t, key: string) => {
  const shape = parseListingKey(key)
  return db
    .select({
      total: count().as('total'),
      closed: sql<number>`coalesce(sum(case when ${closedOf(t.issues)} then 1 else 0 end), 0)`.as(
        'closed',
      ),
      ready:
        sql<number>`coalesce(sum(case when not ${closedOf(t.issues)} and ${inArray(t.issues.stage, [...READY_STAGES])} and not ${blockedOf(t, t.issues)} then 1 else 0 end), 0)`.as(
          'ready',
        ),
      blocked:
        sql<number>`coalesce(sum(case when not ${closedOf(t.issues)} and ${blockedOf(t, t.issues)} then 1 else 0 end), 0)`.as(
          'blocked',
        ),
    })
    .from(t.issues)
    .where(listingWhere(t, shape, dialectOf(db)))
    .prepare()
})

/** The rows of one listing shape that carry a deferral, with what deciding it
 *  for `ready` needs. */
export const deferralsOf = preparedFamily((db, t, key: string) => {
  const shape = parseListingKey(key)
  return db
    .select({
      id: t.issues.id,
      deferUntil: t.issues.deferUntil,
      ready: sql<number>`case when not ${closedOf(t.issues)} and ${inArray(t.issues.stage, [...READY_STAGES])} and not ${blockedOf(t, t.issues)} then 1 else 0 end`,
    })
    .from(t.issues)
    .where(and(listingWhere(t, shape, dialectOf(db)), isNotNull(t.issues.deferUntil)))
    .prepare()
})

// ---- the manual-order key space (POD-6192) ---------------------------------

/**
 * One sort-key scope, narrow: a parent's live children (`parent`), or a
 * repository's live top-level issues (`top`), optionally without the ones the
 * named member pinned (`top-unpinned`), which have their own section. A pin is
 * the member's `pins` row of kind 'issue' (POD-6692), read by its primary key.
 */
export const sortScopeOf = preparedFamily((db, t, key: 'parent' | 'top' | 'top-unpinned') =>
  db
    .select({
      id: t.issues.id,
      sortKey: t.issues.sortKey,
      createdAt: t.issues.createdAt,
      seq: t.issues.seq,
    })
    .from(t.issues)
    .where(
      inWorkspace(
        t.issues,
        isNull(t.issues.deletedAt),
        ...(key === 'parent'
          ? [eq(t.issues.parentId, param(t.issues.parentId, 'parentId'))]
          : [isNull(t.issues.parentId), eq(t.issues.repoId, param(t.issues.repoId, 'repoId'))]),
        ...(key === 'top-unpinned'
          ? [
              sql`NOT EXISTS (SELECT 1 FROM ${t.pins} WHERE ${t.pins.workspaceId} = ${t.issues.workspaceId} AND ${t.pins.userId} = ${sql.placeholder('viewer')} AND ${t.pins.kind} = 'issue' AND ${t.pins.id} = ${t.issues.id})`,
            ]
          : []),
      ),
    )
    .prepare(),
)

// ---- the joins a report needs, for the listed rows only -------------------

export const labelsOfIssues = preparedFamily((db, t, size: number) =>
  db
    .select({ issueId: t.issueLabels.issueId, label: t.labels.name })
    .from(t.issueLabels)
    .innerJoin(
      t.labels,
      and(sameWorkspace(t.labels, t.issueLabels), eq(t.labels.id, t.issueLabels.labelId)),
    )
    .where(inWorkspace(t.issueLabels, inListOf(t.issueLabels.issueId, size, 'ids')))
    .orderBy(asc(t.issueLabels.issueId), asc(t.labels.name))
    .prepare(),
)

export const depsFromIssues = preparedFamily((db, t, size: number) =>
  db
    .select({ fromId: t.issueDeps.fromId, toId: t.issueDeps.toId, type: t.issueDeps.type })
    .from(t.issueDeps)
    .where(inWorkspace(t.issueDeps, inListOf(t.issueDeps.fromId, size, 'ids')))
    .orderBy(asc(t.issueDeps.fromId), asc(t.issueDeps.toId), asc(t.issueDeps.type))
    .prepare(),
)

export const depsToIssues = preparedFamily((db, t, size: number) =>
  db
    .select({ fromId: t.issueDeps.fromId, toId: t.issueDeps.toId, type: t.issueDeps.type })
    .from(t.issueDeps)
    .where(inWorkspace(t.issueDeps, inListOf(t.issueDeps.toId, size, 'ids')))
    .orderBy(asc(t.issueDeps.toId), asc(t.issueDeps.fromId), asc(t.issueDeps.type))
    .prepare(),
)

export const commentCountsOfIssues = preparedFamily((db, t, size: number) =>
  db
    .select({ issueId: t.issueComments.issueId, n: count() })
    .from(t.issueComments)
    .where(inWorkspace(t.issueComments, inListOf(t.issueComments.issueId, size, 'ids')))
    .groupBy(t.issueComments.issueId)
    .prepare(),
)

/** A column by its bare name, mapped as the table maps it: for a FROM that is
 *  an INDEXED BY clause, over which drizzle refuses a table column. */
const bare = <T extends Column>(column: T) => sql`${sql.identifier(column.name)}`.mapWith(column)

/** Live children of a set of parents, with the columns a report counts them by;
 *  in the boot map's order (repository path, then sequence). Through
 *  `idx_issues_children` by name on SQLite (POD-7034): the statistics average the
 *  children over the parents that have any, so at a few hundred parents the
 *  planner prices the seeks above a scan of every issue, while most parents a
 *  report asks about have none. */
export const liveChildrenOf = preparedFamily((db, t, size: number) =>
  db
    .select({
      id: bare(t.issues.id),
      parentId: bare(t.issues.parentId),
      stage: bare(t.issues.stage),
      closedReason: bare(t.issues.closedReason),
      deletedAt: bare(t.issues.deletedAt),
    })
    .from(throughIndex(db, t.issues, 'idx_issues_children'))
    .where(
      inWorkspace(t.issues, inListOf(t.issues.parentId, size, 'ids'), isNull(t.issues.deletedAt)),
    )
    .orderBy(asc(t.issues.repoPath), asc(t.issues.seq), asc(t.issues.id))
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
