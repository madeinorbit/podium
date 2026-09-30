/** Fixed geometry has no row measurement cache, including after same-count moves. */
import { describe, expect, it } from 'vitest'
import { HEADER_HEIGHT, ROW_HEIGHT, WindowPlan } from '../react/list'
import type { WorklistGroups } from './groups'

// Declared lane summaries only: the plan never needs a row or a known-row index.
function lanes(pinnedIds: readonly string[], groups: { key: string; rowIds: readonly string[]; closedIds: readonly string[] }[]): WorklistGroups {
  return { pinnedIds, keys: groups.map((group) => group.key), group: (key: string) => groups.find((group) => group.key === key)! } as unknown as WorklistGroups
}
const folded = new Set<string>()

describe('the stable window plan', () => {
  it('retains the table and unchanged lane payloads; only the touched lane and following offsets change', () => {
    const a = { key: 'a', rowIds: ['a1', 'a2'], closedIds: ['a3'] }
    const b = { key: 'b', rowIds: ['b1'], closedIds: [] }
    const c = { key: 'c', rowIds: ['c1'], closedIds: [] }
    const groups = lanes(['p1'], [a, b, c])
    const plan = new WindowPlan()
    plan.update(groups, groups.keys, folded)
    const table = plan.segments
    const before = table.slice()
    const key = plan.getItemKey
    const estimate = plan.estimateSize
    plan.update(groups, groups.keys, folded)
    expect(plan.segments).toBe(table)
    before.forEach((segment, i) => expect(plan.segments[i]).toBe(segment))
    b.rowIds = ['b-new', 'b1']
    plan.update(groups, groups.keys, folded)
    expect(plan.segments).toBe(table)
    expect(plan.getItemKey).toBe(key)
    expect(plan.estimateSize).toBe(estimate)
    before.slice(0, 3).forEach((segment, i) => expect(plan.segments[i]).toBe(segment))
    expect(plan.segments[3]!.lane).not.toBe(before[3]!.lane)
    expect(plan.segments[4]!.lane).toBe(before[4]!.lane)
    expect(plan.segments[4]!.start).toBe(before[4]!.start + 1)
    expect(plan.segments[4]!.top).toBe(before[4]!.top + ROW_HEIGHT)
  })

  it('resolves keys, heights and pixels after same-count moves, insertion, removal, fold and group reorder', () => {
    const a = { key: 'a', rowIds: ['a1', 'a2'], closedIds: ['a3'] }
    const b = { key: 'b', rowIds: ['b1'], closedIds: [] as string[] }
    const groups = lanes(['p1'], [a, b])
    const plan = new WindowPlan()
    const check = (keys: string[], sizes: number[], keysOfGroups = groups.keys, folds: ReadonlySet<string> = folded) => {
      plan.update(groups, keysOfGroups, folds)
      expect(plan.count).toBe(keys.length)
      expect(plan.height).toBe(sizes.reduce((sum, size) => sum + size, 0))
      let top = 0
      keys.forEach((key, index) => {
        expect(plan.getItemKey(index)).toBe(key)
        expect(plan.estimateSize(index)).toBe(sizes[index])
        expect(plan.topOf(index)).toBe(top)
        expect(plan.indexAt(top)).toBe(index)
        expect(plan.indexAt(top + sizes[index]! - 1)).toBe(index)
        top += sizes[index]!
      })
    }
    const h = HEADER_HEIGHT, r = ROW_HEIGHT
    check(['pinned', 'p1', 'group:a', 'a1', 'a2', 'a3', 'group:b', 'b1'], [h,r,h,r,r,r,h,r])
    a.rowIds = ['a2']; b.rowIds = ['a1', 'b1']
    check(['pinned', 'p1', 'group:a', 'a2', 'a3', 'group:b', 'a1', 'b1'], [h,r,h,r,r,h,r,r])
    b.rowIds = ['new', 'a1', 'b1']
    check(['pinned', 'p1', 'group:a', 'a2', 'a3', 'group:b', 'new', 'a1', 'b1'], [h,r,h,r,r,h,r,r,r])
    b.rowIds = ['a1', 'b1']
    check(['pinned', 'p1', 'group:a', 'a2', 'group:b', 'a1', 'b1'], [h,r,h,r,h,r,r], groups.keys, new Set(['a']))
    check(['pinned', 'p1', 'group:b', 'a1', 'b1', 'group:a', 'a2', 'a3'], [h,r,h,r,r,h,r,r], ['b', 'a'])
    const entries = plan.window(plan.height - r, r)
    expect(entries.at(-1)?.key).toBe('a3')
    expect(entries.at(-1)?.start).toBe(plan.height - r)
    const empty = lanes([], [])
    plan.update(empty, empty.keys, folded)
    expect(plan.window(0, r)).toEqual([])
    expect(plan.count).toBe(0)
    expect(plan.height).toBe(0)
  })

  it('draws only the viewport and overscan at any position in a 4x-sized lane', () => {
    const groups = lanes([], [{ key: 'a', rowIds: Array.from({ length: 2928 }, (_, i) => `i${i}`), closedIds: [] }])
    const plan = new WindowPlan()
    plan.update(groups, groups.keys, folded)
    for (const offset of [0, 56_000, plan.height]) {
      const entries = plan.window(offset, 560)
      expect(entries.length).toBeGreaterThan(0)
      expect(entries.length).toBeLessThanOrEqual(22)
      for (const entry of entries) expect(entry.key).toBe(plan.getItemKey(entry.index))
    }
    expect(plan.window(0, 0)).toEqual([])
  })
})
