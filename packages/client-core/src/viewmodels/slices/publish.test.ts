import { describe, expect, it } from 'vitest'
import { createSlicePublisher, defineSlice } from './publish'

// ---------------------------------------------------------------------------
// POD-330 — the slice publication mechanism.
//
// Three properties, and the second is the one the provider's own comment
// demanded of whatever POD-330 landed:
//
//   1. N readers of a slice within one snapshot cause ONE derivation;
//   2. it invalidates on a SHRINK that moves no revision — an eviction — not
//      merely on an update;
//   3. it never carries a value across a principal switch, without being told
//      that a switch happened.
// ---------------------------------------------------------------------------

interface World {
  readonly rows: readonly { id: string; rev: number }[]
}

const idsSlice = defineSlice<World, string[]>({
  name: 'ids',
  derive: (w) => w.rows.map((r) => r.id),
})

describe('createSlicePublisher', () => {
  it('derives ONCE for many readers of the same snapshot', () => {
    let snapshot: World = { rows: [{ id: 'a', rev: 1 }] }
    const pub = createSlicePublisher(() => snapshot)

    const first = pub.read(idsSlice)
    const second = pub.read(idsSlice)
    const third = pub.read(idsSlice)

    expect(pub.derivations().ids).toBe(1)
    // Every reader gets the SAME object, so identity comparisons downstream see
    // one value rather than three equal ones.
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(first).toEqual(['a'])
  })

  it('re-derives once per new snapshot, not once per read', () => {
    let snapshot: World = { rows: [{ id: 'a', rev: 1 }] }
    const pub = createSlicePublisher(() => snapshot)
    pub.read(idsSlice)
    pub.read(idsSlice)
    snapshot = {
      rows: [
        { id: 'a', rev: 1 },
        { id: 'b', rev: 1 },
      ],
    }
    pub.read(idsSlice)
    pub.read(idsSlice)
    pub.read(idsSlice)

    expect(pub.derivations().ids).toBe(2)
    expect(pub.read(idsSlice)).toEqual(['a', 'b'])
  })

  it('INVALIDATES ON A SHRINK THAT MOVES NO REVISION — an evict is not an update', () => {
    // The row is not deleted and its revision does not move. It simply left this
    // principal's view. A cache keyed on ids, on a dependency set or on a
    // revision high-water mark would all miss this and paint the evicted row
    // forever; keying on snapshot identity cannot.
    const kept = { id: 'a', rev: 7 }
    const shared = { id: 'shared-away', rev: 7 }
    let snapshot: World = { rows: [kept, shared] }
    const pub = createSlicePublisher(() => snapshot)
    expect(pub.read(idsSlice)).toEqual(['a', 'shared-away'])

    // Eviction: the row is gone from the replica, with the SAME revision on
    // every surviving row.
    snapshot = { rows: [kept] }
    expect(pub.read(idsSlice)).toEqual(['a'])
    expect(pub.derivations().ids).toBe(2)
    // No tombstone, no placeholder, nothing standing in for the evicted row.
    expect(pub.read(idsSlice)).toHaveLength(1)
  })

  it('re-derives after a RESCOPE that rebuilds the world wholesale', () => {
    let snapshot: World = { rows: [{ id: 'a', rev: 1 }] }
    const pub = createSlicePublisher(() => snapshot)
    pub.read(idsSlice)
    snapshot = {
      rows: [
        { id: 'x', rev: 1 },
        { id: 'y', rev: 1 },
      ],
    }
    expect(pub.read(idsSlice)).toEqual(['x', 'y'])
  })

  it('carries nothing across a principal switch, and is never told one happened', () => {
    const worldA: World = { rows: [{ id: 'mine', rev: 1 }] }
    const worldB: World = { rows: [{ id: 'theirs', rev: 1 }] }
    // A new principal is a new runtime, so a new publisher over a new snapshot.
    const pubA = createSlicePublisher(() => worldA)
    expect(pubA.read(idsSlice)).toEqual(['mine'])
    const pubB = createSlicePublisher(() => worldB)
    expect(pubB.read(idsSlice)).toEqual(['theirs'])
    expect(pubB.derivations().ids).toBe(1)
  })

  it('keeps the previous value identity when isEqual says the answer did not change', () => {
    let snapshot: World = { rows: [{ id: 'a', rev: 1 }] }
    const stable = defineSlice<World, string[]>({
      name: 'stable',
      derive: (w) => w.rows.map((r) => r.id),
      isEqual: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
    })
    const pub = createSlicePublisher(() => snapshot)
    const first = pub.read(stable)
    // A new snapshot whose derived answer is the same: re-derived (the count
    // moves) but the identity is preserved so consumers do not re-render.
    snapshot = { rows: [{ id: 'a', rev: 2 }] }
    const second = pub.read(stable)
    expect(pub.derivations().stable).toBe(2)
    expect(second).toBe(first)
  })

  it('can skip a derivation when unrelated source fields change', () => {
    interface NoisyWorld extends World {
      readonly noise: number
    }
    const relevant = defineSlice<NoisyWorld, string[]>({
      name: 'relevant',
      sourceEqual: (previous, next) => previous.rows === next.rows,
      derive: (world) => world.rows.map((row) => row.id),
    })
    let snapshot: NoisyWorld = { rows: [{ id: 'a', rev: 1 }], noise: 0 }
    const pub = createSlicePublisher(() => snapshot)
    const first = pub.read(relevant)

    snapshot = { rows: snapshot.rows, noise: 1 }
    expect(pub.read(relevant)).toBe(first)
    expect(pub.derivations().relevant).toBe(1)

    snapshot = { rows: [{ id: 'a', rev: 2 }], noise: 1 }
    expect(pub.read(relevant)).not.toBe(first)
    expect(pub.derivations().relevant).toBe(2)
  })

  it('defaults to Object.is, so a fresh object is a fresh value', () => {
    let snapshot: World = { rows: [{ id: 'a', rev: 1 }] }
    const pub = createSlicePublisher(() => snapshot)
    const first = pub.read(idsSlice)
    snapshot = { rows: [{ id: 'a', rev: 2 }] }
    expect(pub.read(idsSlice)).not.toBe(first)
  })

  it('counts each slice separately', () => {
    let snapshot: World = { rows: [{ id: 'a', rev: 1 }] }
    const count = defineSlice<World, number>({ name: 'count', derive: (w) => w.rows.length })
    const pub = createSlicePublisher(() => snapshot)
    pub.read(idsSlice)
    pub.read(count)
    snapshot = { rows: [] }
    pub.read(count)
    expect(pub.derivations()).toEqual({ ids: 1, count: 2 })
  })
})
