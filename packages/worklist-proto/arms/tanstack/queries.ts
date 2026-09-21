/**
 * POD-4448 — every relational derivation as a chained live query
 * (methodology §5.4). Entity collections in, derived collections out; each
 * later query reads earlier ones, so the graph IS the dependency structure —
 * no hand-declared input lists anywhere.
 *
 * - memberQ: sessions × locals → owner (explicit issueId, else the R3 prefix
 *   index) + raw verdict inputs. The prefix match itself is the maintained
 *   PrefixIndex (joins are cross-source eq only); the wtVersion join makes
 *   every seat move re-resolve here, so nothing goes stale silently.
 * - verdictQ: memberQ × issues × locals → per-session verdicts (retaining,
 *   live, needsYou/offerOnly/endedDone/workingNow, activity stamps).
 * - aggQ: groupBy owner → per-issue scalars (retained count, explicit max
 *   activity for the unread rollup, retained max for activityAt, first pick).
 * - issuesN: narrowed issues + join marker.
 * - childQ: R1 live-child edges (pure where + select).
 * - summaryQ: issuesN × aggQ(left) × locals → own-summary + flat predicate
 *   + unread + band + display fields.
 * - visibleQ: where over summaryQ (flat, unexcluded) — the visible set.
 * - orderQ / laneQ / groupsQ / rowsQ read the rollup collection: orderBy on
 *   rank keys; per-row baseline lane; groupBy repo scalars; SliceRow fold.
 * The recursive subtree rollup is the ONE custom collection (rollup.ts).
 * Every query carries an explicit gcTime; every fn body bumps GraphRuns.
 */

import {
  and,
  BasicIndex,
  count,
  createLiveQueryCollection,
  eq,
  max,
  min,
  not,
  sum,
  caseWhen,
  type Collection,
} from '@tanstack/db'
import { GC_TIME_MS, type EntityCollections, type LocalsRow, type PrefixIndex } from './collections'
import {
  bandOf,
  derivedUnreadFromMax,
  displayRefOf,
  displayTitleOf,
  firstPickOf,
  groupKeyOf,
  groupLabelOf,
  inClosedFold,
  isSessionWorking,
  attentionGroup,
  isOfferOnlyAttention,
  closedFoldAt,
  issueFinished,
  parseFirstPick,
  parseMs,
  sessionlessKept,
  sessionLive,
  sessionRetains,
  structurallyExcluded,
  openSession,
} from './rules'
import type { RollupRow } from './rollup'

/** Per-scenario query-graph run counts. fn bodies bump these; pure-DSL
 *  maintenance (groupBy/orderBy/where/select) is IVM-internal and reported
 *  as change events on the collections, never invented here. */
export interface GraphRuns {
  memberNarrow: number
  memberOwner: number
  verdict: number
  issuesNarrow: number
  child: number
  summary: number
  lane: number
  rows: number
  changes: Record<string, number>
  reset(): void
}

export function createGraphRuns(): GraphRuns {
  const runs: GraphRuns = {
    memberNarrow: 0,
    memberOwner: 0,
    verdict: 0,
    issuesNarrow: 0,
    child: 0,
    summary: 0,
    lane: 0,
    rows: 0,
    changes: {},
    reset() {
      runs.memberNarrow = 0
      runs.memberOwner = 0
      runs.verdict = 0
      runs.issuesNarrow = 0
      runs.child = 0
      runs.summary = 0
      runs.lane = 0
      runs.rows = 0
      runs.changes = {}
    },
  }
  return runs
}

export interface MemberRow {
  sid: string
  /** Explicit issueId, or the R3-resolved owner, or null (orphan). */
  owner: string | null
  marker: 1
  explicit: boolean
  phase: string | null | undefined
  idleKind: string | undefined
  hasOffer: boolean
  status: string | null | undefined
  agentKind: string | null | undefined
  busy: boolean
  archived: boolean
  activeAt: string
  stoppedAt: string | null | undefined
  readAt: string | null | undefined
  unread: boolean
  endedSince: string | null | undefined
  agentName: string | null | undefined
  cwd: string
}

/** narrowQ output: MemberRow with the explicit issueId still attached and
 *  the owner unresolved (null). */
export interface NarrowRow extends Omit<MemberRow, 'owner'> {
  owner: null
  explicitId: string | null
}

export interface VerdictRow {
  sid: string
  owner: string
  marker: 1
  explicit: boolean
  retaining: boolean
  live: boolean
  needsYou: boolean
  offerOnly: boolean
  endedDone: boolean
  workingNow: boolean
  activeAt: string
  retainedActive: string | null
  pick: string
  archived: boolean
  status: string | null | undefined
}

export interface AggRow {
  owner: string
  retained: number
  /** Max activity over explicit non-shell members (unread rollup). */
  explicitMax: string | null
  /** Max activity over retained members (activityAt anchor). */
  retainedLatest: string | null
  firstPick: string | null
}

export interface IssuesNRow {
  id: string
  parentId: string | null | undefined
  seq: number
  createdAt: string
  updatedAt: string
  closedAt: string | null | undefined
  deletedAt: string | null | undefined
  archived: boolean | undefined
  stage: string
  closedReason: string | null | undefined
  audience: 'human' | 'agent' | undefined
  draft: boolean | undefined
  pinned: boolean | undefined
  sortKey: string | null | undefined
  deferUntil: string | null | undefined
  tuckedAt: string | null | undefined
  repoId: string | null | undefined
  repoPath: string
  needsHuman: boolean | undefined
  blocked: boolean | undefined
  readAt: string | null | undefined
  title: string
  marker: 1
}

export interface ChildRow {
  id: string
  parentId: string
}

export interface SummaryRow {
  id: string
  excluded: boolean
  flat: boolean
  activityAt: number
  displayRef: string
  title: string
  band: 0 | 1 | 2
  repoKey: string
  unread: boolean
}

export interface LaneRow {
  id: string
  groupKey: string
  label: string
  lane: 'pinned' | 'open' | 'closed'
  foldAt: number
}

export interface RowsRow {
  id: string
  displayRef: string
  title: string
  phase: 'queued' | 'working' | 'waiting' | 'done'
  progressDone: number
  progressTotal: number
  working: boolean
  asking: boolean
  band: 0 | 1 | 2
  repoKey: string
  tickId: string | null
  tickSeq: number | null
  tickTitle: string | null
  tickRef: string | null
}

function idleKindOfState(agentState: unknown): string | undefined {
  return (agentState as { idle?: { kind?: string } } | undefined)?.idle?.kind
}

/** Structural holder for every live query collection in the graph. The
 *  concrete `createLiveQueryCollection` return types carry SingleResult /
 *  NonSingleResult markers that differ per query; the store, the rollup
 *  sync and the tests program against this surface only. */
export interface QueryChange {
  key: string | number
  type: string
  value?: unknown
}

export interface LiveQuery {
  readonly size: number
  readonly toArray: unknown[]
  get(key: string | number): unknown
  subscribeChanges(cb: (changes: QueryChange[]) => void): { unsubscribe(): void }
  cleanup(): Promise<unknown>
}

/**
 * Re-type a created live query collection for a from()/join() source
 * position. `createLiveQueryCollection` returns a SingleResult |
 * NonSingleResult union that degrades ref inference to RefBrand; the
 * runtime object is the real collection, so this cast restores precise
 * refs. Used ONLY at source positions, never to bypass value typing.
 */
function asSource<T extends object>(query: LiveQuery): Collection<T, string, Record<string, never>> {
  return query as unknown as Collection<T, string, Record<string, never>>
}

function maxMs(value: string | null | number | undefined): number {
  if (typeof value !== 'string') return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

export interface BaseQueries {
  narrowQ: LiveQuery
  memberQ: LiveQuery
  verdictQ: LiveQuery
  aggQ: LiveQuery
  issuesN: LiveQuery
  childQ: LiveQuery
  summaryQ: LiveQuery
  visibleQ: LiveQuery
}

/** Membership → verdicts → per-issue scalars → own-summary → visible set. */
export function createBaseQueries(
  entities: EntityCollections,
  prefix: PrefixIndex,
  runs: GraphRuns,
): BaseQueries {
  const { issues, sessions, locals } = entities

  // Narrowing hop: shells/headless filtered, marker attached. Joins see
  // pre-fn rows (verified: a join after fn.select matches on the FROM
  // shape), so the marker MUST be materialized in its own collection
  // before any join can use it.
  const narrowQ = createLiveQueryCollection({
    id: 'tanstack-arm.narrow',
    gcTime: GC_TIME_MS,
    getKey: (item) => (item as unknown as MemberRow).sid,
    query: (q) =>
      q
        .from({ s: sessions.collection })
        .fn.where((row) => row.s.headless !== true && row.s.agentKind !== 'shell')
        .fn.select((row) => {
          runs.memberNarrow += 1
          const s = row.s
          const out: NarrowRow = {
            sid: s.sessionId,
            owner: null,
            marker: 1,
            explicit: s.issueId != null,
            explicitId: s.issueId ?? null,
            phase: s.agentState?.phase,
            idleKind: idleKindOfState(s.agentState),
            hasOffer: s.offer !== undefined,
            status: s.status,
            agentKind: s.agentKind,
            busy: (s as { busy?: boolean }).busy === true,
            archived: s.archived === true,
            activeAt: s.lastActiveAt,
            stoppedAt: s.stoppedAt,
            readAt: s.readAt,
            unread: s.unread === true,
            endedSince: s.agentState?.since ?? null,
            agentName: (s as { name?: string }).name ?? null,
            cwd: s.cwd,
          }
          return out
        }),
  })

  const memberQ = createLiveQueryCollection({
    id: 'tanstack-arm.member',
    gcTime: GC_TIME_MS,
    getKey: (item) => (item as unknown as MemberRow).sid,
    query: (q) =>
      q
        .from({ s: asSource<NarrowRow>(narrowQ) })
        .join(
          { l: locals.collection },
          ({ s, l }) => eq((s as unknown as { marker: 1 }).marker, l.marker),
          'inner',
        )
        .fn.select((row) => {
          runs.memberOwner += 1
          const m = row.s as unknown as NarrowRow
          const owner = m.explicitId ?? prefix.resolveCwd(m.cwd) ?? null
          const out: MemberRow = {
            sid: m.sid,
            owner,
            marker: 1,
            explicit: m.explicit,
            phase: m.phase,
            idleKind: m.idleKind,
            hasOffer: m.hasOffer,
            status: m.status,
            agentKind: m.agentKind,
            busy: m.busy,
            archived: m.archived,
            activeAt: m.activeAt,
            stoppedAt: m.stoppedAt,
            readAt: m.readAt,
            unread: m.unread,
            endedSince: m.endedSince,
            agentName: m.agentName,
            cwd: m.cwd,
          }
          return out
        }),
  })

  const verdictQ = createLiveQueryCollection({
    id: 'tanstack-arm.verdict',
    gcTime: GC_TIME_MS,
    getKey: (item) => (item as unknown as VerdictRow).sid,
    query: (q) =>
      q
        .from({ m: asSource<MemberRow>(memberQ) })
        .join({ i: issues.collection }, ({ m, i }) => eq(m.owner, i.id), 'inner')
        .join({ l: locals.collection }, ({ m, l }) => eq((m as unknown as { marker: 1 }).marker, l.marker), 'inner')
        .fn.select((row) => {
          runs.verdict += 1
          const m = row.m as unknown as MemberRow
          const owner = row.i
          const now = (row.l as unknown as LocalsRow).now
          const phase = m.phase
          const idleNeeds =
            m.idleKind === 'question' || m.idleKind === 'approval' || m.idleKind === 'interrupted'
          const idleDone = m.idleKind === 'done' || m.idleKind === 'open_todos'
          const needsYouNoOffer =
            phase === 'needs_user' ||
            phase === 'errored' ||
            (phase === 'idle' && idleNeeds)
          const needsYou = m.hasOffer || needsYouNoOffer
          const offerOnly = m.hasOffer && !needsYouNoOffer
          const endedDone = phase === 'ended' || (phase === 'idle' && idleDone)
          const workingNow =
            (phase === 'working' || phase === 'compacting') &&
            m.status !== 'exited' &&
            m.status !== 'starting' &&
            m.status !== 'reconnecting' &&
            m.status !== 'hibernated'
          // sessionRetains / sessionLive vs the owner issue (spec R-VIS).
          const finished = issueFinished(owner)
          let retaining: boolean
          let live: boolean
          if (m.archived) {
            retaining = false
            live = false
          } else {
            const finishedAt =
              m.stoppedAt ??
              (phase === 'ended'
                ? m.endedSince
                : idleDone && finished
                  ? (owner.closedAt ?? owner.updatedAt ?? m.endedSince)
                  : undefined)
            if (finishedAt == null) {
              retaining = true
            } else {
              const ms = parseMs(finishedAt) ?? 0
              if (m.unread || m.readAt == null) {
                retaining = now - ms <= 7 * 24 * 60 * 60 * 1000
              } else {
                retaining = now - Math.max(ms, parseMs(m.readAt) ?? 0) <= 24 * 60 * 60 * 1000
              }
            }
            live = m.status !== 'exited' && retaining
          }
          const out: VerdictRow = {
            sid: m.sid,
            owner: m.owner as string,
            marker: 1,
            explicit: m.explicit,
            retaining,
            live,
            needsYou,
            offerOnly,
            endedDone,
            workingNow,
            activeAt: m.activeAt,
            retainedActive: retaining ? m.activeAt : null,
            pick: firstPickOf(m.sid, m.agentKind ?? null, m.agentName ?? null),
            archived: m.archived,
            status: m.status,
          }
          return out
        }),
  })

  const aggQ = createLiveQueryCollection({
    id: 'tanstack-arm.agg',
    gcTime: GC_TIME_MS,
    getKey: (item) => (item as unknown as AggRow).owner,
    query: (q) =>
      q
        .from({ v: asSource<VerdictRow>(verdictQ) })
        .groupBy(({ v }) => v.owner)
        .select(({ v }) => ({
          owner: v.owner,
          retained: sum(caseWhen(eq(v.retaining, true), 1, 0)),
          explicitMax: max(caseWhen(eq(v.explicit, true), v.activeAt, null)),
          retainedLatest: max(caseWhen(eq(v.retaining, true), v.activeAt, null)),
          firstPick: min(v.pick),
        })),
  })

  const issuesN = createLiveQueryCollection({
    id: 'tanstack-arm.issuesN',
    gcTime: GC_TIME_MS,
    getKey: (item) => (item as unknown as IssuesNRow).id,
    query: (q) =>
      q.from({ i: issues.collection }).fn.select((row) => {
        runs.issuesNarrow += 1
        const i = row.i
        const out: IssuesNRow = {
          id: i.id,
          parentId: i.parentId,
          seq: i.seq,
          createdAt: i.createdAt,
          updatedAt: i.updatedAt,
          closedAt: i.closedAt,
          deletedAt: i.deletedAt,
          archived: i.archived,
          stage: i.stage,
          closedReason: i.closedReason,
          audience: i.audience,
          draft: i.draft,
          pinned: i.pinned,
          sortKey: i.sortKey,
          deferUntil: i.deferUntil,
          tuckedAt: i.tuckedAt,
          repoId: i.repoId,
          repoPath: i.repoPath,
          needsHuman: i.needsHuman,
          blocked: i.blocked,
          readAt: i.readAt,
          title: i.title,
          marker: 1,
        }
        return out
      }),
  })

  const childQ = createLiveQueryCollection({
    id: 'tanstack-arm.child',
    gcTime: GC_TIME_MS,
    getKey: (item) => (item as unknown as ChildRow).id,
    query: (q) =>
      q
        .from({ i: issues.collection })
        .fn.where((row) => {
          runs.child += 1
          const i = row.i
          return i.archived !== true && i.deletedAt == null && i.parentId != null
        })
        .select(({ i }) => ({ id: i.id, parentId: i.parentId as string })),
  })

  const summaryQ = createLiveQueryCollection({
    id: 'tanstack-arm.summary',
    gcTime: GC_TIME_MS,
    getKey: (item) => (item as unknown as SummaryRow).id,
    query: (q) =>
      q
        .from({ n: asSource<IssuesNRow>(issuesN) })
        .join({ a: asSource<AggRow>(aggQ) }, ({ n, a }) => eq(n.id, a.owner), 'left')
        .join({ l: locals.collection }, ({ n, l }) => eq((n as unknown as { marker: 1 }).marker, l.marker), 'inner')
        .fn.select((row) => {
          const n = row.n as unknown as IssuesNRow
          const agg = row.a as unknown as AggRow | undefined
          const now = (row.l as unknown as LocalsRow).now
          const sentinel = (): SummaryRow => ({
            id: n.id,
            excluded: true,
            flat: false,
            activityAt: 0,
            displayRef: '',
            title: '',
            band: 1,
            repoKey: '',
            unread: false,
          })
          // Structurally excluded issues hold no summary: sessions on them
          // recompute nothing downstream (the heartbeat short-circuit).
          if (structurallyExcluded(n as unknown as Parameters<typeof structurallyExcluded>[0])) {
            return sentinel()
          }
          runs.summary += 1
          const issue = n as unknown as Parameters<typeof sessionlessKept>[0] &
            Parameters<typeof derivedUnreadFromMax>[0] &
            Parameters<typeof displayRefOf>[0] &
            Parameters<typeof displayTitleOf>[0] &
            Parameters<typeof bandOf>[0] &
            Parameters<typeof groupKeyOf>[0]
          const retained = agg?.retained ?? 0
          const unread = derivedUnreadFromMax(issue, maxMs(agg?.explicitMax))
          const flat = retained > 0 || sessionlessKept(issue, now, unread)
          const peak = maxMs(agg?.retainedLatest)
          const first = parseFirstPick(agg?.firstPick ?? null)
          const out: SummaryRow = {
            id: n.id,
            excluded: false,
            flat,
            activityAt: peak !== 0 ? peak : (parseMs(n.updatedAt) ?? 0),
            displayRef: displayRefOf(issue, prefix.prefixForRepo(n.repoId)),
            title: displayTitleOf(issue, first.name, first.kind),
            band: bandOf(issue, now),
            repoKey: groupKeyOf(issue),
            unread,
          }
          return out
        }),
  })

  const visibleQ = createLiveQueryCollection({
    id: 'tanstack-arm.visible',
    gcTime: GC_TIME_MS,
    getKey: (item) => (item as unknown as SummaryRow).id,
    query: (q) =>
      q
        .from({ s: asSource<SummaryRow>(summaryQ) })
        .where(({ s }) => and(eq(s.excluded, false), eq(s.flat, true))),
  })

  // Explicit join indexes for the query compiler (methodology §5.4): the
  // entity collections build theirs eagerly; derived collections declare
  // the keys later queries join or group on. Without these the compiler
  // falls back to scanning local data (a startup warning, then O(N²)).
  aggQ.createIndex((row) => (row as unknown as AggRow).owner, { indexType: BasicIndex })
  summaryQ.createIndex((row) => (row as unknown as SummaryRow).id, { indexType: BasicIndex })

  return { narrowQ, memberQ, verdictQ, aggQ, issuesN, childQ, summaryQ, visibleQ }
}

export interface TopQueries {
  orderQ: LiveQuery
  laneQ: LiveQuery
  groupsQ: LiveQuery
  rowsQ: LiveQuery
}

/**
 * Order, lanes, groups and rows over the rollup collection. orderQ is pure
 * DSL (where + chained orderBy, the R-ORDER rank); laneQ evaluates the
 * baseline (unlatched) fold predicate per row; groupsQ is the groupBy;
 * rowsQ folds the SliceRow. The selection latch is NOT a query input —
 * clicks must not re-run 3,200 lane fns (R-SEL: selection never re-derives
 * rows); the commit layer applies the latch to the two affected rows.
 */
export function createTopQueries(
  entities: EntityCollections,
  base: BaseQueries,
  rollupC: { collection: Collection<RollupRow, string, Record<string, never>> },
  runs: GraphRuns,
): TopQueries {
  const { locals } = entities
  const rollup = rollupC.collection

  const orderQ = createLiveQueryCollection({
    id: 'tanstack-arm.order',
    gcTime: GC_TIME_MS,
    getKey: (item) => (item as unknown as { id: string }).id,
    query: (q) =>
      q
        .from({ r: rollup })
        .where(({ r }) => eq(r.final, true))
        .orderBy(({ r }) => r.band, 'asc')
        .orderBy(({ r }) => r.sortKeyEnc, 'asc')
        .orderBy(({ r }) => r.createdAt, 'desc')
        .orderBy(({ r }) => r.seq, 'desc')
        .orderBy(({ r }) => r.id, 'asc')
        .select(({ r }) => ({ id: r.id })),
  })

  const laneQ = createLiveQueryCollection({
    id: 'tanstack-arm.lane',
    gcTime: GC_TIME_MS,
    getKey: (item) => (item as unknown as LaneRow).id,
    query: (q) =>
      q
        .from({ r: rollup })
        .join({ l: locals.collection }, ({ r, l }) => eq(r.marker, l.marker), 'inner')
        .fn.select((row) => {
          runs.lane += 1
          const r = row.r as unknown as RollupRow
          const now = (row.l as unknown as LocalsRow).now
          const issue = r as unknown as Parameters<typeof inClosedFold>[0]['issue']
          let lane: LaneRow['lane']
          if (r.pinned) {
            lane = 'pinned'
          } else if (
            inClosedFold({
              issue,
              waiting: r.asking,
              selectedIssueId: null,
              selectedIssueWasFolded: false,
              now,
            })
          ) {
            lane = 'closed'
          } else {
            lane = 'open'
          }
          const out: LaneRow = {
            id: r.id,
            groupKey: r.repoKey,
            label: groupLabelOf({ repoPath: r.repoPath }),
            lane,
            foldAt: closedFoldAt(issue),
          }
          return out
        }),
  })

  const groupsQ = createLiveQueryCollection({
    id: 'tanstack-arm.groups',
    gcTime: GC_TIME_MS,
    getKey: (item) => (item as unknown as { key: string }).key,
    query: (q) =>
      q
        .from({ r: asSource<LaneRow>(laneQ) })
        .where(({ r }) => not(eq(r.lane, 'pinned')))
        .groupBy(({ r }) => r.groupKey)
        .select(({ r }) => ({
          key: r.groupKey,
          label: max(r.label),
          openN: sum(caseWhen(eq(r.lane, 'open'), 1, 0)),
          closedN: sum(caseWhen(eq(r.lane, 'closed'), 1, 0)),
        })),
  })

  const rowsQ = createLiveQueryCollection({
    id: 'tanstack-arm.rows',
    gcTime: GC_TIME_MS,
    getKey: (item) => (item as unknown as RowsRow).id,
    query: (q) =>
      q
        .from({ s: asSource<SummaryRow>(base.summaryQ) })
        .join({ r: rollup }, ({ s, r }) => eq(s.id, r.id), 'inner')
        .where(({ r }) => eq(r.final, true))
        .fn.select((row) => {
          runs.rows += 1
          const s = row.s as unknown as SummaryRow
          const r = row.r as unknown as RollupRow
          const out: RowsRow = {
            id: s.id,
            displayRef: s.displayRef,
            title: s.title,
            phase: r.phase,
            progressDone: r.progressDone,
            progressTotal: r.progressTotal,
            working: r.working,
            asking: r.asking,
            band: s.band,
            repoKey: s.repoKey,
            tickId: r.tickId,
            tickSeq: r.tickSeq,
            tickTitle: r.tickTitle,
            tickRef: r.tickRef,
          }
          return out
        }),
  })

  return { orderQ, laneQ, groupsQ, rowsQ }
}
