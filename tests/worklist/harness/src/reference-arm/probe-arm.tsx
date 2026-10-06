import { watchReference } from '../../../diagnostics/reference-state'
import { referenceState } from '../../../diagnostics/reference-state'
/**
 * POD-4564 (L6b) — the PROBE reference arm: the arm every planted-mistake
 * probe (`shared/src/probes/`) is proven ARMED on.
 *
 * WHY NOT THE L6a REFERENCE ARM. That arm (`arm.tsx`) holds no pool: no fed
 * table, no relation, no memo of its own. Four of the five mistakes need a
 * site to be planted in: an index to leave uncleaned, a declared relation to
 * maintain one way, a table for a row to walk, plain state for a derivation to
 * read. This arm adds exactly those sites and nothing else, and its snapshot
 * is its OWN state (the views it holds), so a planted mistake that stales a
 * view shows in `snapshot()`, where the L6a arm's snapshot reads the engine.
 *
 * WHAT IT IS.
 * - VIEWS: the oracle's row views (`projectRowViews` over the engine store),
 *   recomputed on every engine publication and every locals notification,
 *   keeping the previous view object when the new one is deep-equal (the L6a
 *   mechanism), so it redraws exactly the rows whose view changed.
 * - TABLE: the fed issue rows, stored borrowed and read through
 *   `reads.wrapTables` (so a walk over it is counted).
 * - RELATIONS: every declared `belongsTo` from `issue` to `issue`
 *   (`SCHEMA.issue.relations`; today `parent`, inverse `children`, with its
 *   `where`), maintained incrementally from the feed by the schema doc §4
 *   rules (detach then attach; delete removes from the inverse; buckets keyed
 *   by the reference, so a re-added parent finds its children), and handed to
 *   `reads.wrapRelations` as the arm contract requires. Its views never read
 *   them: a relation mistake here is FAIL-SOFT (screen correct, graph wrong),
 *   the variant only a graph-level check can see (K MobX E).
 * - `snapshot()`: the held views projected to `SliceRow`, in the unselected
 *   parity order; `rebuildFromScratch()`: the oracle over the engine with the
 *   arm's current locals, nothing held read.
 *
 * NOT A CANDIDATE. It reads the engine store for its views (whole-world work
 * per change) and is never in the roster (`roster.ts`).
 *
 * THE PLANTS (`ProbePlant`), one per probe, each the mistake as a hand-rolled
 * author would write it here (the per-substrate recipes are in the probes):
 * - `omittedInput` (P1): the row's declared inputs omit its own `title`: a
 *   change that moves only the title is judged "no input changed" and the
 *   prior view is kept. Any other input moving with it heals the row.
 * - `evictKeepsIndex` (P2): a deleted or evicted issue leaves its forward
 *   entry but stays in its parent's `children` bucket.
 * - `rowScan` (P3): the row component reaches the fenced issue table through
 *   a React context and walks it (counting the row's children) on every draw.
 * - `guardSet` (P4): a plain `Set` read inside the view derivation, meant as
 *   a once-per-pass guard ("already refreshed"): filled on row events,
 *   cleared only when a locals notification starts a pass. A row's SECOND
 *   change before the next tick or click keeps its stale view.
 * - `oneWayRelation` (P5): an update that moves an issue's parent rewrites the
 *   forward reference only; the old and new parents' `children` are not
 *   touched (insert and delete still maintain both directions).
 */

import { isDeepStrictEqual } from 'node:util'
import {
  createContext,
  createElement,
  memo,
  type ReactElement,
  useContext,
  useSyncExternalStore,
} from 'react'
import { createRoot } from 'react-dom/client'
import type {
  CheckableArm,
  CheckableArmHandle,
  LocalsSource,
  RowSource,
} from '../../../shared/src/arm'
import {
  DISABLED_READ_FENCE,
  type ReadFence,
  type RelationReader,
} from '../../../shared/src/instrument/reads'
import {
  CommitLogContext,
  currentCommitLog,
  type RowProps,
  RowShell,
} from '../../../shared/src/row-shell'
import { type RowView, sliceRowOf } from '@podium/client-graph/shared/row-view'
import { type BelongsToSpec, type EntityName, SCHEMA } from '@podium/client-graph/shared/schema'
import type {
  SliceIssue,
  SliceLocals,
  SliceOrder,
  SliceSnapshot,
} from '@podium/client-graph/shared/slice-types'
import type { ArmStats, RowRecord, RowSourceEvent } from '../../../shared/src/stats'
import type { ClientRuntime } from '@podium/client-core/engine'
import {
  legacyDerivationFromStore,
  projectRowViews,
  projectSnapshot,
  type RowViews,
  snapshotFromStore,
} from '../oracle/index'

export type ProbePlant =
  | 'omittedInput'
  | 'evictKeepsIndex'
  | 'rowScan'
  | 'guardSet'
  | 'oneWayRelation'

// ------------------------------------------------------------------ relations

/** One declared self-relation of `issue`, with the state that maintains it. */
interface Link {
  readonly name: string
  readonly spec: BelongsToSpec
  /** Member id → the target key it references (members only: `where` passes, key set). */
  readonly forward: Map<string, string>
  /** Target key → its members (the inverse collection), keyed by the reference. */
  readonly buckets: Map<string, Set<string>>
}

function declaredSelfLinks(): Link[] {
  const links: Link[] = []
  for (const [name, spec] of Object.entries(SCHEMA.issue.relations)) {
    if (spec.kind !== 'belongsTo' || spec.to !== 'issue') continue
    links.push({ name, spec, forward: new Map(), buckets: new Map() })
  }
  return links
}

/** The key this row references through `spec`, or null when it is not a member. */
function memberTarget(row: SliceIssue, spec: BelongsToSpec): string | null {
  const record = row as unknown as Readonly<Record<string, unknown>>
  if (spec.where !== undefined && !spec.where.test(record)) return null
  const key = record[spec.foreignKey]
  return typeof key === 'string' && key !== '' ? key : null
}

class IssueGraph {
  readonly table = new Map<string, SliceIssue>()
  readonly links = declaredSelfLinks()

  constructor(
    private readonly plant: ProbePlant | null,
    private readonly stats: ArmStats,
  ) {}

  replace(rows: readonly RowRecord[]): void {
    this.table.clear()
    for (const link of this.links) {
      link.forward.clear()
      link.buckets.clear()
    }
    for (const row of rows) this.apply(row)
  }

  apply(record: RowRecord): void {
    if (record.kind !== 'issue') return
    const known = this.table.has(record.id)
    const next = record.value as SliceIssue | undefined
    if (next === undefined) this.table.delete(record.id)
    else this.table.set(record.id, next)
    for (const link of this.links) {
      const before = link.forward.get(record.id) ?? null
      const after = next === undefined ? null : memberTarget(next, link.spec)
      if (before === after) continue
      // PLANTED (P2): the evicted row stays in its target's bucket.
      const keepBucket = next === undefined && this.plant === 'evictKeepsIndex'
      // PLANTED (P5): an update rewrites the reference, never the inverse.
      const oneWay = known && next !== undefined && this.plant === 'oneWayRelation'
      if (before !== null && !keepBucket && !oneWay) this.detach(link, before, record.id)
      if (after === null) link.forward.delete(record.id)
      else link.forward.set(record.id, after)
      if (after !== null && !oneWay) this.attach(link, after, record.id)
    }
  }

  private detach(link: Link, target: string, id: string): void {
    const bucket = link.buckets.get(target)
    bucket?.delete(id)
    if (bucket?.size === 0) link.buckets.delete(target)
    this.stats.indexUpdates += 1
  }

  private attach(link: Link, target: string, id: string): void {
    let bucket = link.buckets.get(target)
    if (bucket === undefined) {
      bucket = new Set()
      link.buckets.set(target, bucket)
    }
    bucket.add(id)
    this.stats.indexUpdates += 1
  }

  /** The shared accessor over the maintained relations (L5a `RelationReader`). */
  reader(): RelationReader {
    const link = (from: EntityName, relation: string, side: 'one' | 'many'): Link => {
      const found =
        from !== 'issue'
          ? undefined
          : this.links.find((l) => (side === 'one' ? l.name : l.spec.inverse) === relation)
      if (found === undefined) {
        throw new Error(
          `[probe-arm] ${from}.${relation} is not maintained by the probe reference arm`,
        )
      }
      return found
    }
    const members = (from: EntityName, id: string, relation: string): string[] =>
      [...(link(from, relation, 'many').buckets.get(id) ?? [])].sort()
    return {
      one: (from, id, relation) => {
        const target = link(from, relation, 'one').forward.get(id)
        return target !== undefined && this.table.has(target) ? target : null
      },
      many: members,
      size: (from, id, relation) => link(from, relation, 'many').buckets.get(id)?.size ?? 0,
      subset: () => [],
    }
  }
}

// ---------------------------------------------------------------------- views

interface ProbeState {
  /** The rendered order (with the selection). */
  order: SliceOrder
  /** The parity snapshot's order and row set (unselected baseline, spec §7). */
  parity: SliceSnapshot
  views: RowViews
}

type Trigger = 'boot' | 'rows' | 'locals'

function nextState(
  engine: ClientRuntime,
  locals: SliceLocals,
  previous: ProbeState | null,
  trigger: Trigger,
  plant: ProbePlant | null,
  guard: Set<string>,
): ProbeState {
  const derivation = legacyDerivationFromStore(referenceState(engine))
  const fresh = projectRowViews(derivation, locals)
  // PLANTED (P4): a locals notification is where the author thought a pass starts.
  if (plant === 'guardSet' && trigger === 'locals') guard.clear()
  const views: RowViews = {}
  for (const [id, view] of Object.entries(fresh)) {
    const prior = previous?.views[id]
    views[id] = prior !== undefined && keepPrior(prior, view, trigger, plant, guard) ? prior : view
  }
  return {
    order: projectSnapshot(derivation, locals).order,
    parity: projectSnapshot(derivation, { ...locals, selectedIssueId: null }),
    views,
  }
}

function keepPrior(
  prior: RowView,
  fresh: RowView,
  trigger: Trigger,
  plant: ProbePlant | null,
  guard: Set<string>,
): boolean {
  if (isDeepStrictEqual(prior, fresh)) return true
  // PLANTED (P1): `title` is not among the row's declared inputs.
  if (plant === 'omittedInput' && isDeepStrictEqual({ ...fresh, title: prior.title }, prior))
    return true
  if (plant === 'guardSet' && trigger === 'rows') {
    // PLANTED (P4): plain state read inside the derivation, tracked by nothing.
    if (guard.has(fresh.id)) return true
    guard.add(fresh.id)
  }
  return false
}

// ---------------------------------------------------------------------- rows

/** P3's way in: the fenced table, where no row should reach it. */
const TableContext = createContext<ReadonlyMap<string, SliceIssue> | null>(null)

const ProbeRow = memo(function ProbeRow({ row }: RowProps): ReactElement {
  return (
    <div data-issue-row={row.id} data-selected={row.selected ? 'true' : 'false'}>
      {row.displayRef} {row.title} [{row.phase}
      {row.working ? '*' : ''}
      {row.asking ? '?' : ''}] {row.progressDone}/{row.progressTotal}
    </div>
  )
})

/** PLANTED (P3): the row walks the whole issue table on every draw. */
const ScanningRow = memo(function ScanningRow({ row }: RowProps): ReactElement {
  const table = useContext(TableContext)
  let children = 0
  for (const issue of table?.values() ?? []) if (issue.parentId === row.id) children += 1
  return (
    <div data-issue-row={row.id} data-children={children}>
      {row.displayRef} {row.title}
    </div>
  )
})

function Slot({ view }: { view: RowView }): ReactElement {
  return <RowShell row={view} component={ProbeRow} />
}

function ScanningSlot({ view }: { view: RowView }): ReactElement {
  return <RowShell row={view} component={ScanningRow} />
}

const ProbeSlot = memo(Slot)
const ProbeScanningSlot = memo(ScanningSlot)

function ProbeList({
  subscribe,
  read,
  scanning,
}: {
  subscribe: (listener: () => void) => () => void
  read: () => ProbeState
  scanning: boolean
}): ReactElement {
  const state = useSyncExternalStore(subscribe, read)
  const SlotType = scanning ? ProbeScanningSlot : ProbeSlot
  return (
    <div data-probe-list>
      {[
        ...state.order.pinnedIds,
        ...state.order.groups.flatMap((group) => [...group.rowIds, ...group.closedIds]),
      ].map((id) => {
        const view = state.views[id]
        return view === undefined ? null : <SlotType key={id} view={view} />
      })}
    </div>
  )
}

function zeroStats(): ArmStats {
  const stats: ArmStats = {
    rowsDerived: 0,
    rollupsDerived: 0,
    indexUpdates: 0,
    notifications: 0,
    reset(): void {
      stats.rowsDerived = 0
      stats.rollupsDerived = 0
      stats.indexUpdates = 0
      stats.notifications = 0
    },
  }
  return stats
}

export interface ProbeArmHandle extends CheckableArmHandle {
  /** The raw relation accessor (tests); the arm hands the fence the same one. */
  readonly relations: RelationReader
}

export function probeReferenceArmFor(
  engine: ClientRuntime,
  plant: ProbePlant | null = null,
): CheckableArm {
  return {
    create(
      source: RowSource,
      channel: LocalsSource,
      reads: ReadFence = DISABLED_READ_FENCE,
    ): ProbeArmHandle {
      const stats = zeroStats()
      const graph = new IssueGraph(plant, stats)
      graph.replace(source.snapshot('issue'))
      const fenced = reads.wrapTables({ issue: graph.table }).issue
      const relations = graph.reader()
      reads.wrapRelations(relations)
      const guard = new Set<string>()
      let state = nextState(engine, channel.get(), null, 'boot', plant, guard)
      const listeners = new Set<() => void>()
      const refresh = (trigger: Trigger): void => {
        stats.notifications += 1
        state = nextState(engine, channel.get(), state, trigger, plant, guard)
        for (const listener of [...listeners]) listener()
      }
      const offFeed = source.subscribe((event: RowSourceEvent) => {
        if (event.type === 'replace') graph.replace(event.rows)
        else for (const row of event.rows) graph.apply(row)
      })
      const offRows = watchReference(engine, () => refresh('rows'))
      const offLocals = channel.subscribe(() => refresh('locals'))
      const subscribe = (listener: () => void): (() => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
      const read = (): ProbeState => state
      const roots = new Set<{ unmount(): void }>()
      return {
        relations,
        stats,
        snapshot(): SliceSnapshot {
          const rowsById: SliceSnapshot['rowsById'] = {}
          for (const [id, row] of Object.entries(state.parity.rowsById)) {
            const view = state.views[id]
            rowsById[id] = view === undefined ? row : sliceRowOf(view)
          }
          return { order: state.parity.order, rowsById }
        },
        rebuildFromScratch(): SliceSnapshot {
          return snapshotFromStore(referenceState(engine), {
            selectedIssueId: null,
            coarseNow: channel.get().coarseNow,
          })
        },
        dispose(): void {
          offFeed()
          offRows()
          offLocals()
          for (const root of roots) root.unmount()
          roots.clear()
        },
        mountWeb(el: Element): () => void {
          const root = createRoot(el)
          roots.add(root)
          root.render(
            <CommitLogContext.Provider value={currentCommitLog()}>
              <TableContext.Provider value={fenced}>
                {createElement(ProbeList, { subscribe, read, scanning: plant === 'rowScan' })}
              </TableContext.Provider>
            </CommitLogContext.Provider>,
          )
          return () => {
            if (!roots.delete(root)) return
            root.unmount()
          }
        },
        mountNative(): ReactElement {
          throw new Error('[probe-arm] web lane only; the probe reference arm has no native list')
        },
      }
    },
  }
}
