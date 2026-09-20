/**
 * POD-4442 smoke test: the shared slice surface exists with the shapes the
 * plan names, and a hand-built snapshot is internally consistent (every
 * ordered id resolves to a row).
 */
import { describe, expect, it } from 'vitest'
import type {
  Arm,
  ArmStats,
  RowRecord,
  RowSourceEvent,
  SliceGroup,
  SliceLocals,
  SliceOrder,
  SliceRow,
  SliceSnapshot,
} from './index'

describe('slice snapshot shape', () => {
  it('links order ids to rows and keeps bands in range', () => {
    const rowsById: Record<string, SliceRow> = {
      a: {
        id: 'a',
        displayRef: 'POD-1',
        title: 'First',
        phase: 'working',
        progressDone: 1,
        progressTotal: 2,
        working: true,
        asking: false,
        band: 1,
        repoKey: 'repo',
        closed: false,
      },
    }
    const groups: SliceGroup[] = [{ key: 'repo', label: 'repo', rowIds: ['a'], closedIds: [] }]
    const order: SliceOrder = { pinnedIds: [], groups }
    const snapshot: SliceSnapshot = { order, rowsById }
    for (const group of snapshot.order.groups) {
      for (const id of [...group.rowIds, ...group.closedIds]) {
        expect(snapshot.rowsById[id], `ordered id ${id} has no row`).toBeDefined()
      }
    }
    for (const row of Object.values(snapshot.rowsById)) {
      expect([0, 1, 2]).toContain(row.band)
    }
  })

  it('accepts both source event kinds', () => {
    const replace: RowSourceEvent = { type: 'replace', rows: [] }
    const update: RowSourceEvent = {
      type: 'update',
      rows: [{ kind: 'issue', id: 'a', value: undefined } satisfies RowRecord],
    }
    expect(replace.type).toBe('replace')
    expect(update.rows).toHaveLength(1)
  })

  it('types locals with a data clock, never Date.now()', () => {
    const locals: SliceLocals = { selectedIssueId: null, coarseNow: 1_758_000_000_000 }
    expect(locals.selectedIssueId).toBeNull()
    expect(typeof locals.coarseNow).toBe('number')
  })

  it('keeps stats counters numeric with a reset', () => {
    const stats: ArmStats = {
      rowsDerived: 0,
      rollupsDerived: 0,
      indexUpdates: 0,
      notifications: 0,
      reset() {},
    }
    stats.reset()
    expect(stats.rowsDerived).toBe(0)
    const _arm: Arm | null = null
    expect(_arm).toBeNull()
  })
})
