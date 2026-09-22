// @vitest-environment happy-dom
/**
 * POD-4609 (L5g) — the #6–#10 reads budgets, proven in both directions.
 *
 * WHY A SHAPE ARM, NOT THE REFERENCE ARM. The L6a reference arm
 * (`reference-arm/arm.tsx`) reads the engine store, never the feed or a fenced
 * table, so its reads cell is 0 on every step (`fences.test.tsx` pins that).
 * It meets every budget by being blind to the fence, which proves nothing: it
 * is the wrong arm for this fence, by design (it is exempt and not a
 * candidate). The YES here is a probe arm in the style of
 * `reads-probe.test.tsx`: it stores the borrowed rows, reads them only through
 * `reads.wrapTables` and `reads.wrapRelations`, and on each event performs
 * exactly the reads the budget derivations name
 * (`docs/plans/pod-4441-harness.md`, "Reads per change"):
 *
 * - a session: the session, the lane of a NEW session, then its issue's chain
 *   (each level's issue, climbing `issue.parent`);
 * - an issue: the row; a new issue's sessions; the old and the new chain when
 *   the parent moved, else the row's own chain when a roll-up input moved;
 *   then placement — leaving a position reads its two neighbours, entering
 *   one binary-searches its group READING every probed row (no cached rank
 *   keys: the worst honest arm) and then reads its two neighbours;
 * - an evicted issue: the stored row, its old chain, its position, and its
 *   parent's listing when the parent was listed only through its children
 *   (a rescue parent: sessionless backlog, `size` checks are free);
 * - a tick (the locals channel, POD-4608): only the rows whose fold deadline
 *   (`issueFinishedAt` + the 24 h grace, kept as a derived key) it passes,
 *   each read and moved from the open lane to the fold.
 *
 * It renders nothing and projects no slice, so parity is not asserted; its
 * "listed" set approximates visibility (not archived, not a childless
 * sessionless backlog row) after mount. What it proves: the fence counts these shapes
 * (every step's reads are bounded BELOW by the rows the change names — the
 * cell is not vacuous), and the budgets hold on the real corpus targets at
 * 1x, 2x and 4x (chain depths and group sizes as the corpus has them).
 *
 * The NO: the same arm plus ONE walk over the issue table per notification
 * (a row event or a locals change) fails every #6–#10 budget; the legacy
 * control, which reads the whole world, fails every one, the ticks included
 * (`control.test.tsx`).
 *
 * STEP ISOLATION (wall clock held still). The #3 click's eager mark-read is
 * acknowledged by the scenario server but never echoed as truth, so the
 * runtime's ledger keeps it awaiting truth until its 60 s WALL-CLOCK sweep
 * (`AWAITING_TRUTH_TTL_MS`, `client-core/src/engine/overlay.ts`). The sweep
 * retires the overlay and the feed emits that row in whichever step is
 * running 60 s later: never at 1x (the run is shorter), at 4x in #6b on one
 * run and in #8 on another. That row belongs to #3, not to the step it lands
 * in, and it would turn #8's budget of 0 red by timing alone. So these runs
 * fake `Date` (frozen): the sweep never comes due, and no step is charged for
 * another step's write. The row views do not read the wall clock
 * (`fences.test.tsx`, "wall-clock independence").
 *
 * #3 (L5a's, NOT changed here): the click's feed event names the clicked row
 * (the eager mark-read), so an arm that reads the rows its events name reads
 * 1 on #3, over L5a's budget of 0 — the same shape #9a has, budgeted 3 here.
 * Reported to the coordinator, not re-read: L5a's budgets are L5a's.
 */

import { isDeepStrictEqual } from 'node:util'
import { createElement, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Arm, ArmHandle } from '../../shared/src/arm'
import { DISABLED_READ_FENCE, type RelationReader } from '../../shared/src/instrument/reads'
import { type FixtureScale, startScenarioEngine } from '../../shared/src/scenarios'
import type { EntityName } from '../../shared/src/schema'
import type { SliceIssue, SliceSession } from '../../shared/src/slice-types'
import type { ArmStats, RowRecord } from '../../shared/src/stats'
import {
  assertReads,
  type CountResult,
  clockTickReadBudget,
  mountArmForCounts,
} from './count-harness'
import { engineLocals, FENCE_SCENARIOS, openFenceFeeds, runFenceStep } from './fence-scenarios'
import { rowViewsFromStore } from './oracle/index'

type ProbeMode = 'shape' | 'scan'

/** The scenarios whose budgets POD-4609 fixed. #1–#5 are L5a's (see the note on #3 above). */
const BUDGETED_HERE = new Set([
  '#6a',
  '#6b',
  '#6c',
  '#6d',
  '#7',
  '#8',
  '#8b',
  '#9a',
  '#9b',
  '#9c',
  '#10',
])

/**
 * The rows each change NAMES, which any arm must read: the fence's cell must
 * be at least this, or it is blind. The ticks name the rows they cross,
 * counted from the oracle in the run.
 */
const NAMED_ROWS: Readonly<Record<string, number>> = {
  '#6a': 2, // the issue and its session
  '#6b': 1,
  '#6c': 1,
  '#6d': 2, // the leaf and the rescue parent that leaves with it
  '#7': 3, // the moved row, its old parent, its new parent
  '#9a': 1,
  '#9b': 1,
  '#9c': 1,
  '#10': 100, // fifty sessions and their fifty issues
}

function zeroStats(): ArmStats {
  const stats: ArmStats = {
    rowsDerived: 0,
    rollupsDerived: 0,
    indexUpdates: 0,
    notifications: 0,
    reset() {
      stats.rowsDerived = 0
      stats.rollupsDerived = 0
      stats.indexUpdates = 0
      stats.notifications = 0
    },
  }
  return stats
}

type RankKey = readonly [number, number, string, number, number, string]

function rankKey(row: SliceIssue): RankKey {
  return [
    row.pinned === true ? 0 : 1,
    row.sortKey ? 0 : 1,
    row.sortKey ?? '',
    -(Date.parse(row.createdAt) || 0),
    -row.seq,
    row.id,
  ]
}

function compareKeys(a: RankKey, b: RankKey): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return (a[i] as number | string) < (b[i] as number | string) ? -1 : 1
  }
  return 0
}

/** The finished grace (`SIDEBAR_FINISHED_GRACE_MS`): a settled closure folds after it. */
const FINISHED_GRACE_MS = 24 * 60 * 60 * 1000

/** A closed top-level row's fold deadline (`issueFinishedAt` + grace), or null when time cannot fold it. */
function foldDeadline(row: SliceIssue): number | null {
  if (!row.closedAt || row.parentId || row.tuckedAt || row.closedReason === 'abandoned') return null
  return (Date.parse(row.closedAt ?? row.updatedAt) || 0) + FINISHED_GRACE_MS
}

/** Group plus lane at clock `now`: tucked or abandoned closures fold at once, others after the grace. */
function groupOf(row: SliceIssue, now: number): string {
  const deadline = foldDeadline(row)
  const folded = !!row.closedAt && (deadline === null || now > deadline)
  return `${row.repoId ?? row.repoPath}:${folded ? 'closed' : 'open'}`
}

/** Fields a roll-up up the chain reads from a row. `readAt`/`unread` are not among them. */
const ROLLUP_FIELDS = [
  'stage',
  'closedAt',
  'closedReason',
  'archived',
  'deletedAt',
  'needsHuman',
  'draft',
] as const

/**
 * `visibleAtMount`: the oracle's visible rows when the arm mounts, so its
 * groups hold what a real arm's list holds (mount-time, never charged). After
 * that the arm decides listing itself, from the changed rows only.
 */
function shapeArm(mode: ProbeMode, visibleAtMount: ReadonlySet<string>): Arm {
  return {
    create(source, localsSource, reads = DISABLED_READ_FENCE): ArmHandle {
      let now = localsSource.get().coarseNow
      const raw = {
        issue: new Map<string, SliceIssue>(),
        session: new Map<string, SliceSession>(),
        worktree: new Map<string, unknown>(),
      }
      /** Lane paths: strings the arm keeps for the longest-prefix resolver. */
      const lanePaths = new Set<string>()
      const parentOf = new Map<string, string>()
      const childrenOf = new Map<string, Set<string>>()
      const sessionsOf = new Map<string, Set<string>>()
      const issueOfSession = new Map<string, string>()
      const groups = new Map<string, string[]>()
      const placedIn = new Map<string, string>()
      /** Fold deadlines of placed open-lane rows: derived keys, never entity reads. */
      const deadlines = new Map<string, number>()
      const track = (id: string, row: SliceIssue): void => {
        const deadline = foldDeadline(row)
        if (deadline !== null && deadline >= now && placedIn.get(id)?.endsWith(':open'))
          deadlines.set(id, deadline)
        else deadlines.delete(id)
      }

      const link = (
        index: Map<string, Set<string>>,
        key: string | null | undefined,
        id: string,
      ): void => {
        if (!key) return
        const bucket = index.get(key) ?? new Set<string>()
        bucket.add(id)
        index.set(key, bucket)
      }
      const unlink = (
        index: Map<string, Set<string>>,
        key: string | null | undefined,
        id: string,
      ): void => {
        if (key) index.get(key)?.delete(id)
      }
      /** The schema's `where`: an archived or deleted issue contributes no parent edge. */
      const parentEdge = (row: SliceIssue): string | null =>
        row.archived === true || row.deletedAt ? null : (row.parentId ?? null)

      const reader: RelationReader = {
        one(from: EntityName, id: string, relation: string): string | null {
          if (from === 'issue' && relation === 'parent') return parentOf.get(id) ?? null
          if (from === 'session' && relation === 'issue') return issueOfSession.get(id) ?? null
          return null
        },
        many(from: EntityName, id: string, relation: string): Iterable<string> {
          if (from === 'issue' && relation === 'children') return [...(childrenOf.get(id) ?? [])]
          if (from === 'issue' && relation === 'sessions') return [...(sessionsOf.get(id) ?? [])]
          return []
        },
        size(from: EntityName, id: string, relation: string): number {
          if (from === 'issue' && relation === 'children') return childrenOf.get(id)?.size ?? 0
          if (from === 'issue' && relation === 'sessions') return sessionsOf.get(id)?.size ?? 0
          return 0
        },
      }
      const tables = reads.wrapTables(raw)
      const rel = reads.wrapRelations(reader)

      // ---------------------------------------------------------------- seed
      // Built before the harness resets the fence: mount reads are not charged.
      for (const record of source.snapshot('worktree')) {
        raw.worktree.set(record.id, record.value)
        lanePaths.add(record.id)
      }
      for (const record of source.snapshot('session')) {
        const session = record.value as SliceSession
        raw.session.set(record.id, session)
        if (session.issueId) {
          issueOfSession.set(record.id, session.issueId)
          link(sessionsOf, session.issueId, record.id)
        }
      }
      for (const record of source.snapshot('issue'))
        raw.issue.set(record.id, record.value as SliceIssue)
      for (const row of raw.issue.values()) {
        const parent = parentEdge(row)
        if (parent !== null) {
          parentOf.set(row.id, parent)
          link(childrenOf, parent, row.id)
        }
      }
      const listed = (id: string): boolean => {
        const row = tables.issue.get(id)
        if (row === undefined || row.archived === true || row.deletedAt) return false
        // A rescue parent: visible only through a member.
        return !(
          row.stage === 'backlog' &&
          rel.size('issue', id, 'children') === 0 &&
          rel.size('issue', id, 'sessions') === 0
        )
      }
      for (const row of raw.issue.values()) {
        if (!visibleAtMount.has(row.id)) continue
        const group = groupOf(row, now)
        groups.set(group, [...(groups.get(group) ?? []), row.id])
        placedIn.set(row.id, group)
        track(row.id, row)
      }
      for (const ids of groups.values()) {
        ids.sort((a, b) => compareKeys(rankKey(raw.issue.get(a)!), rankKey(raw.issue.get(b)!)))
      }

      // --------------------------------------------------------------- reads
      const readIssue = (id: string): SliceIssue | undefined => {
        const row = tables.issue.get(id)
        void row?.stage
        return row
      }
      const climb = (id: string | null | undefined): void => {
        const seen = new Set<string>()
        let current = id ?? null
        while (current !== null && !seen.has(current)) {
          seen.add(current)
          readIssue(current)
          current = rel.one('issue', current, 'parent')
        }
      }
      const neighbours = (ids: string[], index: number): void => {
        if (index > 0) readIssue(ids[index - 1]!)
        if (index + 1 < ids.length) readIssue(ids[index + 1]!)
      }
      const leave = (id: string): void => {
        const group = placedIn.get(id)
        if (group === undefined) return
        const ids = groups.get(group)!
        const index = ids.indexOf(id)
        neighbours(ids, index)
        ids.splice(index, 1)
        placedIn.delete(id)
        deadlines.delete(id)
      }
      const enter = (id: string, row: SliceIssue): void => {
        const group = groupOf(row, now)
        const ids = groups.get(group) ?? []
        groups.set(group, ids)
        const key = rankKey(row)
        let lo = 0
        let hi = ids.length
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (compareKeys(rankKey(readIssue(ids[mid]!)!), key) < 0) lo = mid + 1
          else hi = mid
        }
        ids.splice(lo, 0, id)
        neighbours(ids, lo)
        placedIn.set(id, group)
        track(id, row)
      }
      /** Re-evaluate one row's listing and position after its inputs moved. */
      const place = (id: string, before: { group: string; key: RankKey } | null): void => {
        const row = tables.issue.get(id)
        const wasPlaced = placedIn.has(id)
        const isListed = row !== undefined && listed(id)
        if (wasPlaced && !isListed) leave(id)
        else if (!wasPlaced && isListed) enter(id, row)
        else if (wasPlaced && isListed && before !== null) {
          if (before.group !== groupOf(row, now) || compareKeys(before.key, rankKey(row)) !== 0) {
            leave(id)
            enter(id, row)
          } else track(id, row)
        }
      }

      const onSession = (record: RowRecord): void => {
        const previousIssue = issueOfSession.get(record.id) ?? null
        const known = raw.session.has(record.id)
        if (record.value === undefined) {
          raw.session.delete(record.id)
          issueOfSession.delete(record.id)
          unlink(sessionsOf, previousIssue, record.id)
          climb(previousIssue)
          return
        }
        raw.session.set(record.id, record.value as SliceSession)
        const session = tables.session.get(record.id)!
        const issueId = session.issueId ?? null
        if (!known) {
          // The lane: longest-prefix over the lane paths (strings the arm holds), then one read.
          let lane: string | null = null
          for (const path of lanePaths) {
            if (
              (session.cwd === path || session.cwd.startsWith(`${path}/`)) &&
              path.length > (lane?.length ?? -1)
            )
              lane = path
          }
          if (lane !== null) tables.worktree.get(lane)
        }
        if (issueId !== previousIssue) {
          unlink(sessionsOf, previousIssue, record.id)
          if (issueId !== null) {
            issueOfSession.set(record.id, issueId)
            link(sessionsOf, issueId, record.id)
          } else issueOfSession.delete(record.id)
          climb(previousIssue)
        }
        climb(rel.one('session', record.id, 'issue'))
      }

      const onIssue = (record: RowRecord): void => {
        const id = record.id
        const previous = raw.issue.get(id)
        const oldParent = parentOf.get(id) ?? null
        if (record.value === undefined) {
          void previous?.stage
          raw.issue.delete(id)
          parentOf.delete(id)
          unlink(childrenOf, oldParent, id)
          leave(id)
          climb(oldParent)
          if (oldParent !== null) place(oldParent, null)
          return
        }
        const before =
          previous === undefined ? null : { group: groupOf(previous, now), key: rankKey(previous) }
        raw.issue.set(id, record.value as SliceIssue)
        const row = tables.issue.get(id)!
        const newParent = parentEdge(row)
        if (newParent !== oldParent) {
          unlink(childrenOf, oldParent, id)
          if (newParent === null) parentOf.delete(id)
          else {
            parentOf.set(id, newParent)
            link(childrenOf, newParent, id)
          }
          climb(oldParent)
          climb(id)
        } else if (previous === undefined) {
          for (const sessionId of rel.many('issue', id, 'sessions')) tables.session.get(sessionId)
          climb(id)
        } else if (ROLLUP_FIELDS.some((field) => previous[field] !== row[field])) {
          climb(id)
        }
        place(id, before)
      }

      /** The planted mistake (`scan`): one walk over the issue table per notification. */
      const walk = (): void => {
        for (const row of tables.issue.values()) void row.stage
      }
      /** A tick: only the rows whose fold deadline it passes are read and moved. */
      const offLocals = localsSource.subscribe((changed) => {
        if (mode === 'scan') walk()
        if (!changed.has('coarseNow')) return
        const next = localsSource.get().coarseNow
        const due = [...deadlines].filter(([, deadline]) => deadline < next).map(([id]) => id)
        now = next
        for (const id of due) {
          const row = readIssue(id)
          if (row === undefined) continue
          leave(id)
          enter(id, row)
        }
      })

      const stats = zeroStats()
      const off = source.subscribe((event) => {
        stats.notifications += 1
        for (const record of event.rows) {
          if (record.kind === 'session') onSession(record)
          else if (record.kind === 'issue') onIssue(record)
          else if (record.value === undefined) {
            raw.worktree.delete(record.id)
            lanePaths.delete(record.id)
          } else {
            raw.worktree.set(record.id, record.value)
            lanePaths.add(record.id)
          }
        }
        if (mode === 'scan') walk()
      })
      return {
        snapshot: () => ({ order: { pinnedIds: [], groups: [] }, rowsById: {} }),
        stats,
        dispose: () => {
          off()
          offLocals()
        },
        mountWeb: () => () => undefined,
        mountNative: (): ReactElement => createElement('div'),
      }
    },
  }
}

interface Cell {
  methodology: string
  reads: number
  budget: number
  result: CountResult
}

const TICKS = ['#8', '#8b'] as const

/**
 * Every fence scenario, in order, against the shape arm. For the two ticks it
 * also records the rows the tick actually crossed (view changed, entered or
 * left), to hold the budget's projection to what happened.
 */
async function runShape(
  scale: FixtureScale,
  mode: ProbeMode,
): Promise<{ cells: Cell[]; crossed: Record<string, string[]> }> {
  // Wall clock held still: see STEP ISOLATION in the header.
  vi.useFakeTimers({ toFake: ['Date'] })
  const ctx = await startScenarioEngine(scale)
  const feeds = openFenceFeeds(ctx, 'overlaid')
  const visible = new Set(
    Object.keys(rowViewsFromStore(ctx.engine.getSnapshot(), engineLocals(ctx))),
  )
  const mounted = mountArmForCounts(shapeArm(mode, visible), feeds.rows.source, feeds.locals)
  const cells: Cell[] = []
  const crossed: Record<string, string[]> = {}
  try {
    for (const entry of FENCE_SCENARIOS) {
      const tick = (TICKS as readonly string[]).includes(entry.methodology)
      const before = tick ? rowViewsFromStore(ctx.engine.getSnapshot(), engineLocals(ctx)) : null
      const { result, readsBudget } = await runFenceStep(mounted, ctx, feeds.flush, entry)
      if (before !== null) {
        const after = rowViewsFromStore(ctx.engine.getSnapshot(), engineLocals(ctx))
        const ids = new Set([...Object.keys(before), ...Object.keys(after)])
        crossed[entry.methodology] = [...ids]
          .filter((id) => !isDeepStrictEqual(before[id], after[id]))
          .sort()
      }
      cells.push({
        methodology: entry.methodology,
        reads: result.readsPerChange ?? -1,
        budget: readsBudget,
        result,
      })
    }
  } finally {
    mounted.unmount()
    feeds.dispose()
    ctx.engine.destroy()
    vi.useRealTimers()
  }
  return { cells, crossed }
}

const line = (cells: Cell[]): string =>
  cells.map((c) => `${c.methodology}:${c.reads}/${c.budget}`).join(' ')

describe('reads budgets #6–#10 (POD-4609)', () => {
  for (const scale of [1, 2, 4] as const) {
    it(`YES at ${scale}x: an arm doing the derived reads meets every budget, and the fence sees them`, async () => {
      const { cells, crossed } = await runShape(scale, 'shape')
      console.info(
        `[reads-budgets] shape ${scale}x reads/budget: ${line(cells)} ` +
          `crossed=${JSON.stringify(Object.fromEntries(TICKS.map((t) => [t, crossed[t]?.length])))}`,
      )
      const mine = cells.filter((cell) => BUDGETED_HERE.has(cell.methodology))
      expect(mine.map((cell) => cell.methodology)).toEqual([...BUDGETED_HERE])
      for (const cell of mine) {
        const tick = crossed[cell.methodology]
        // A tick's budget is its projected crossings; it must be what the tick did.
        if (tick !== undefined)
          expect(cell.budget, cell.methodology).toBe(clockTickReadBudget(tick.length))
        const named = tick?.length ?? NAMED_ROWS[cell.methodology]!
        expect(
          cell.reads,
          `${cell.methodology} reads fewer rows than the change names: the cell is blind`,
        ).toBeGreaterThanOrEqual(named)
        assertReads(cell.result, { readsPerChange: cell.budget })
      }
      // #8 crosses nothing at any scale (its budget is 0); #8b crosses the grace rows.
      expect(crossed['#8']).toEqual([])
      expect(crossed['#8b']?.length).toBeGreaterThan(0)
    }, 300_000)
  }

  it('NO: the same arm plus one walk over the issue table per notification fails every budget', async () => {
    const { cells } = await runShape(1, 'scan')
    console.info(`[reads-budgets] scan 1x reads/budget: ${line(cells)}`)
    const mine = cells.filter((c) => BUDGETED_HERE.has(c.methodology))
    expect(mine).toHaveLength(BUDGETED_HERE.size)
    for (const cell of mine) {
      expect(
        () => assertReads(cell.result, { readsPerChange: cell.budget }),
        cell.methodology,
      ).toThrow(/read \d+ rows, budget/)
    }
  }, 300_000)
})
