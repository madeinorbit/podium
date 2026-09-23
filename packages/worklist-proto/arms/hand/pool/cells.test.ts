/**
 * POD-4578 (Ha1) — the derivation cell: it records what it read, re-runs
 * only when one of those inputs moved, stops at an equal value, and a
 * disposed cell leaves nothing in any index.
 */

import { describe, expect, it } from 'vitest'
import { CellGraph, DepIndex, sameData } from './cells'

function rig() {
  const graph = new CellGraph()
  const rows = new DepIndex<string>('rows')
  const data = new Map<string, number>([
    ['a', 1],
    ['b', 2],
    ['flag', 0],
  ])
  const get = (key: string) => {
    graph.track(rows, key)
    return data.get(key) ?? 0
  }
  const set = (key: string, value: number) => {
    data.set(key, value)
    graph.invalidateKey(rows, key)
    graph.flush()
  }
  return { graph, rows, get, set }
}

describe('cells', () => {
  it('re-runs only on an input it read on its LAST run (a branch not taken is not an input)', () => {
    const r = rig()
    let runs = 0
    const cell = r.graph.cell(
      'pick',
      () => {
        runs += 1
        return r.get('flag') === 0 ? r.get('a') : r.get('b')
      },
      sameData,
    )
    expect(r.graph.read(cell)).toBe(1)
    r.set('b', 20)
    expect(runs).toBe(1) // b was not read
    r.set('flag', 1)
    expect(r.graph.read(cell)).toBe(20)
    r.set('a', 10)
    expect(runs).toBe(2) // a is no longer read
    expect(r.rows.has('a')).toBe(false)
  })

  it('an equal result keeps the old object and does not wake readers', () => {
    const r = rig()
    let outer = 0
    const inner = r.graph.cell('inner', () => ({ positive: r.get('a') > 0 }), sameData)
    const first = r.graph.read(inner)
    const reader = r.graph.cell(
      'outer',
      () => {
        outer += 1
        return r.graph.read(inner).positive
      },
      sameData,
    )
    r.graph.read(reader)
    r.set('a', 5)
    expect(r.graph.read(inner)).toBe(first)
    expect(outer).toBe(1)
    r.set('a', -1)
    expect(outer).toBe(2)
    expect(r.graph.read(reader)).toBe(false)
  })

  it('drains lower levels first, so a diamond runs its sink once', () => {
    const r = rig()
    let sink = 0
    const left = r.graph.cell('left', () => r.get('a') + 1, sameData)
    const right = r.graph.cell('right', () => r.get('a') * 2, sameData)
    const bottom = r.graph.cell(
      'bottom',
      () => {
        sink += 1
        return r.graph.read(left) + r.graph.read(right)
      },
      sameData,
    )
    expect(r.graph.read(bottom)).toBe(4)
    r.set('a', 3)
    expect(sink).toBe(2)
    expect(r.graph.read(bottom)).toBe(10)
  })

  it('a disposed cell leaves no entry in any index and wakes its readers', () => {
    const r = rig()
    const inner = r.graph.cell('inner', () => r.get('a'), sameData)
    let woke = 0
    const reader = r.graph.cell(
      'reader',
      () => {
        woke += 1
        return r.graph.read(inner)
      },
      sameData,
    )
    r.graph.read(reader)
    r.graph.dispose(inner)
    expect(r.rows.size).toBe(0)
    expect(r.graph.pending).toBe(1)
    expect(() => r.graph.flush()).toThrow(/disposed cell inner/)
    expect(woke).toBe(2)
  })
})
