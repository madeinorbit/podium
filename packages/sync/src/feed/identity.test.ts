/**
 * Feed identity (ADR 2 D1) — every case paired, so a stuck answer fails one half.
 *
 * The pairing is POD-305's arbitration pattern and it is the reason this file is
 * shaped the way it is: a guard tested only with the input it refuses is
 * indistinguishable from a guard that refuses everything, and a guard tested only
 * with the input it accepts is indistinguishable from one that accepts
 * everything. Both mistakes are invisible in a green run. So `assertOpaqueEpoch`
 * gets a ULID it must ACCEPT beside the counter it must REFUSE, and the registry
 * gets a working mint beside a frozen one.
 */

import { describe, expect, it } from 'vitest'
import {
  assertOpaqueEpoch,
  FeedIdentityError,
  FeedIdentityRegistry,
  type FeedIdentity,
  type FeedIdentityStore,
} from './identity'

/** A durable store, as a plain object. One row, exactly as the port describes. */
function memoryStore(seed: FeedIdentity | null = null): FeedIdentityStore & {
  writes: number
  peek(): FeedIdentity | null
} {
  let held = seed
  let writes = 0
  return {
    readIdentity: () => held,
    writeIdentity: (identity) => {
      held = identity
      writes += 1
    },
    get writes() {
      return writes
    },
    peek: () => held,
  }
}

/** Distinct opaque values, in order. Stands in for a ULID/UUID source. */
function mintSequence(...values: readonly string[]): () => string {
  let index = 0
  return () => {
    const value = values[index]
    if (value === undefined) throw new Error('mint exhausted — the test asked for more ids than it supplied')
    index += 1
    return value
  }
}

const ULID_A = '01JQ0P8Z3M4N5R6T7V8W9XAYBZ'
const ULID_B = '01JQ0P9Q1C2D3E4F5G6H7J8K9M'
const ULID_C = '01JQ0PB5X7Y8Z9A0B1C2D3E4F5'

describe('assertOpaqueEpoch — D1 refuses a counter, and only a counter', () => {
  it('ACCEPTS an opaque id', () => {
    expect(() => assertOpaqueEpoch(ULID_A)).not.toThrow()
    expect(() => assertOpaqueEpoch('3f9a1c2e-7b8d-4e5f-9a0b-1c2d3e4f5a6b')).not.toThrow()
  })

  it('REFUSES a decimal counter — the exact shape D1 spends its longest passage on', () => {
    // The failure this prevents is silent: restore backup(epoch=3) → bump → 4;
    // restore the SAME backup again → bump → 4 again. A replica holding the first
    // `4` finds no mismatch with the second and applies a foreign timeline.
    expect(() => assertOpaqueEpoch('4')).toThrow(FeedIdentityError)
    expect(() => assertOpaqueEpoch('4')).toThrow(/COUNTER/)
    expect(() => assertOpaqueEpoch('0')).toThrow(FeedIdentityError)
  })

  it('REFUSES an empty epoch', () => {
    expect(() => assertOpaqueEpoch('')).toThrow(FeedIdentityError)
  })

  it('accepts an id that merely CONTAINS digits, so the guard is not a digit ban', () => {
    // Without this case, `/\d/` would pass every test above while rejecting most
    // real ULIDs — a guard that refuses the legitimate input is the same class of
    // bug as one that admits the illegitimate one, and only a pair catches both.
    expect(() => assertOpaqueEpoch('01JQ0P8Z3M4N5R6T7V8W9XAYBZ')).not.toThrow()
    expect(() => assertOpaqueEpoch('epoch-2')).not.toThrow()
  })
})

describe('FeedIdentityRegistry — minting, persistence, and surviving a restart', () => {
  it('mints on first use and PERSISTS, so a second registry over the same store agrees', () => {
    const store = memoryStore()
    const first = new FeedIdentityRegistry(store, mintSequence(ULID_A, ULID_B))

    const minted = first.current()
    expect(minted.feedId).toBe(ULID_A)
    expect(minted.epoch).toBe(ULID_B)
    expect(store.writes).toBe(1)

    // THE RESTART. A fresh registry, a mint that would produce DIFFERENT values if
    // it were consulted, and the same store. If persistence were absent — or if
    // `current()` trusted only its own cache — this would mint again and the
    // assertion would catch it. That is the point of using a distinct mint here
    // rather than the same one.
    const afterRestart = new FeedIdentityRegistry(store, mintSequence(ULID_C, ULID_C))
    expect(afterRestart.current()).toEqual(minted)
    expect(store.writes).toBe(1)
  })

  it('does NOT write on construction — a read-only consumer does not create a feed', () => {
    const store = memoryStore()
    new FeedIdentityRegistry(store, mintSequence(ULID_A, ULID_B))
    expect(store.peek()).toBeNull()
    expect(store.writes).toBe(0)
  })

  it('bump() keeps feedId, changes epoch, and persists — the same feed, a new generation', () => {
    const store = memoryStore()
    const registry = new FeedIdentityRegistry(store, mintSequence(ULID_A, ULID_B, ULID_C))

    const before = registry.current()
    const after = registry.bump('restore')

    expect(after.feedId).toBe(before.feedId)
    expect(after.epoch).not.toBe(before.epoch)
    expect(store.peek()).toEqual(after)

    // And it survives the restart too, or a bump would be forgotten on reboot —
    // which is the same silent failure as never bumping.
    expect(new FeedIdentityRegistry(store, mintSequence(ULID_A)).current()).toEqual(after)
  })

  it('REFUSES a bump that mints the epoch it is replacing — a frozen mint is a silent no-op', () => {
    // The counterfactual the accepting case above cannot supply: a mint that has
    // been stubbed or memoised upstream. Without this guard `bump()` returns
    // successfully, persists an unchanged epoch, and every replica keeps applying
    // across a discontinuity with nothing to compare that differs.
    const store = memoryStore()
    const registry = new FeedIdentityRegistry(store, mintSequence(ULID_A, ULID_B, ULID_B))
    registry.current()
    expect(() => registry.bump('seq-discontinuity')).toThrow(/not producing fresh values/)
  })

  it('REFUSES a counter mint at the moment it is wired, not at the restore that breaks', () => {
    const store = memoryStore()
    const counter = (() => {
      let n = 0
      return () => String(++n)
    })()
    expect(() => new FeedIdentityRegistry(store, counter).current()).toThrow(/COUNTER/)
    // Nothing was persisted: a refused mint must not leave a half-created feed.
    expect(store.peek()).toBeNull()
  })

  it('REFUSES a persisted counter epoch on read, so a bad old row cannot be trusted forward', () => {
    const store = memoryStore({ feedId: ULID_A, epoch: '7' })
    expect(() => new FeedIdentityRegistry(store, mintSequence(ULID_B)).current()).toThrow(/COUNTER/)
  })
})
