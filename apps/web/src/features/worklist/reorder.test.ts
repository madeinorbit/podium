// POD-168 — drop persistence planning: one midpoint write on the fast path,
// whole-scope backfill when legacy unkeyed rows surround the drop point.
import { describe, expect, it } from 'vitest'
import { planReorderKeys } from './reorder'

const keyOf = (keys: Record<string, string | undefined>) => (id: string) => keys[id]

describe('planReorderKeys', () => {
  it('writes exactly one midpoint key between keyed neighbors', () => {
    const patches = planReorderKeys(['a', 'm', 'b'], 'm', keyOf({ a: 'c', b: 'r' }))
    expect(patches).toHaveLength(1)
    expect(patches[0]!.id).toBe('m')
    expect(patches[0]!.sortKey > 'c' && patches[0]!.sortKey < 'r').toBe(true)
  })

  it('drop at the top mints above the first key', () => {
    const patches = planReorderKeys(['m', 'a', 'b'], 'm', keyOf({ a: 'c', b: 'r' }))
    expect(patches).toHaveLength(1)
    expect(patches[0]!.sortKey < 'c').toBe(true)
  })

  it('drop at the bottom mints below the last key', () => {
    const patches = planReorderKeys(['a', 'b', 'm'], 'm', keyOf({ a: 'c', b: 'r' }))
    expect(patches).toHaveLength(1)
    expect(patches[0]!.sortKey > 'r').toBe(true)
  })

  it('backfills the whole scope when a neighbor is unkeyed', () => {
    const patches = planReorderKeys(['a', 'm', 'legacy'], 'm', keyOf({ a: 'c' }))
    expect(patches.map((p) => p.id)).toEqual(['a', 'm', 'legacy'])
    // Ascending keys in the new visual order.
    expect(patches[0]!.sortKey < patches[1]!.sortKey).toBe(true)
    expect(patches[1]!.sortKey < patches[2]!.sortKey).toBe(true)
  })

  it('backfills when neighbor keys are out of order (corrupt scope)', () => {
    const patches = planReorderKeys(['a', 'm', 'b'], 'm', keyOf({ a: 'r', b: 'c' }))
    expect(patches).toHaveLength(3)
  })

  it('single-row scope still yields a key (keys the row for future drags)', () => {
    const patches = planReorderKeys(['m'], 'm', keyOf({}))
    expect(patches).toHaveLength(1)
    expect(patches[0]!.id).toBe('m')
  })

  it('unknown moved id is a no-op', () => {
    expect(planReorderKeys(['a', 'b'], 'zz', keyOf({}))).toEqual([])
  })
})
