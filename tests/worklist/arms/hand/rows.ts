/**
 * POD-4446 — committed row assembly (spec §7 oracle projection). SliceRows
 * from summary + rollup + placement; a row commits only when its value (or
 * origin tick) differs. The tick rides the commit without entering the
 * snapshot.
 */

import type { SliceRow } from '@podium/client-graph/shared/slice-types'
import { assertNever, nullStats, type Delta, type DerivationStats } from './deltas'
import type { GroupsModule } from './groups'
import type { RollupModule } from './rollup'
import type { SummaryModule } from './summary'
import type { VisibleModule } from './visible'

export class RowsModule {
  /** Committed rows by id (identity-stable unless the value moved). */
  readonly rows = new Map<string, SliceRow>()

  constructor(
    private readonly summary: SummaryModule,
    private readonly rollup: RollupModule,
    private readonly groups: GroupsModule,
    private readonly visible: VisibleModule,
    private readonly stats: DerivationStats = nullStats,
  ) {}

  assemble(id: string): SliceRow | null {
    if (!this.visible.isVisible(id)) return null
    const summary = this.summary.summaries.get(id)
    const aggregate = this.rollup.aggregates.get(id)
    if (summary === undefined || aggregate === undefined) return null
    // `closed` is the fold predicate, not the lane: pinned settled rows read
    // closed while rendering in PINNED (the oracle projects rowInClosedFold
    // directly, independent of lanes).
    return {
      id,
      displayRef: summary.displayRef,
      title: summary.title,
      phase: aggregate.phase,
      progressDone: aggregate.progressDone,
      progressTotal: aggregate.progressTotal,
      working: aggregate.working,
      asking: aggregate.asking,
      band: summary.band,
      repoKey: summary.repoKey,
      closed: this.groups.closedOf(id),
    }
  }

  refresh(id: string, out: Delta[]): void {
    const next = this.assemble(id)
    const prev = this.rows.get(id)
    const tick = this.rollup.ticks.get(id) ?? null
    if (next === null) {
      if (prev !== undefined) {
        this.rows.delete(id)
        this.lastTick.delete(id)
        this.stats.rows(1)
        out.push({ kind: 'RowChanged', id })
      }
      return
    }
    const snap = JSON.stringify([next, tick])
    const prevSnap = prev === undefined ? null : JSON.stringify([prev, this.lastTick.get(id) ?? null])
    if (prevSnap !== snap) {
      this.rows.set(id, next)
      this.lastTick.set(id, tick)
      this.stats.rows(1)
      out.push({ kind: 'RowChanged', id })
    }
  }

  private readonly lastTick = new Map<string, unknown>()

  apply(batch: Delta[]): Delta[] {
    const out: Delta[] = []
    const dirty = new Set<string>()
    for (const delta of batch) {
      switch (delta.kind) {
        case 'SummaryChanged':
        case 'RollupChanged':
        case 'VisibilityChanged':
        case 'GroupChanged':
          if (delta.kind === 'GroupChanged') {
            if (delta.key === '') {
              for (const id of this.groups.pinnedIds) dirty.add(id)
              this.stats.scan('rows-group', this.groups.pinnedIds.length)
            } else {
              const group = this.groups.groups.find((g) => g.key === delta.key)
              if (group !== undefined) {
                for (const id of group.rowIds) dirty.add(id)
                for (const id of group.closedIds) dirty.add(id)
                this.stats.scan('rows-group', group.rowIds.length + group.closedIds.length)
              }
            }
          } else {
            dirty.add(delta.id)
          }
          break
        case 'IssueChanged':
        case 'IssueRemoved':
        case 'MembershipChanged':
        case 'SessionChanged':
        case 'SessionRemoved':
        case 'WorktreeChanged':
        case 'WorktreeRemoved':
        case 'ChildrenChanged':
        case 'OriginChanged':
        case 'OrderChanged':
        case 'RowChanged':
        case 'SelectionChanged':
        case 'ClockChanged':
          break
        default:
          assertNever(delta)
      }
    }
    for (const id of dirty) this.refresh(id, out)
    return out
  }

  /** Full derive for replace/bootstrap (no deltas; store derives after). */
  rebuildAll(): void {
    this.rows.clear()
    this.lastTick.clear()
    for (const id of this.visible.orderedIds()) {
      const next = this.assemble(id)
      if (next !== null) {
        this.rows.set(id, next)
        this.lastTick.set(id, this.rollup.ticks.get(id) ?? null)
      }
    }
  }
}
