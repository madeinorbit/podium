import { afterEach, describe, expect, it, vi } from 'vitest'
import { JoinMemo } from './join-memo'

afterEach(() => vi.unstubAllGlobals())

describe('immutable companion joins', () => {
  it('preserves tuple identity through updates, rollback and independent rows', () => {
    const memo = new JoinMemo<object>()
    const row = {}, otherRow = {}, repo = {}, firstHome = {}, nextHome = {}, missing = {}
    const first = memo.cell(row, [firstHome, repo, missing])
    first.value = { label: 'first' }
    expect(memo.cell(row, [firstHome, repo, missing])).toBe(first)
    const changed = memo.cell(row, [nextHome, repo, missing])
    changed.value = { label: 'changed' }
    expect(changed).not.toBe(first)
    expect(memo.cell(row, [firstHome, repo, missing]).value).toBe(first.value)
    expect(memo.cell(row, [nextHome, repo, missing]).value).toBe(changed.value)
    expect(memo.cell(otherRow, [firstHome, repo, missing]).value).toBeUndefined()
    expect(memo.cell(row, [firstHome, {}, missing]).value).toBeUndefined()
  })

  it('owns its input signature instead of retaining a mutable caller array', () => {
    const memo = new JoinMemo<string>()
    const row = {}, first = {}, second = {}, keys = [first]
    memo.cell(row, keys).value = 'original'
    keys[0] = second
    expect(memo.cell(row, [first]).value).toBe('original')
    expect(memo.cell(row, keys).value).toBeUndefined()
    expect(memo.cell(row, [first]).value).toBe('original')
  })

  it('allocates no per-row weak tries for a bootstrap with one tuple per row', () => {
    const NativeWeakMap = globalThis.WeakMap
    let maps = 0
    vi.stubGlobal('WeakMap', class extends NativeWeakMap {
      constructor() { super(); maps++ }
    })
    const memo = new JoinMemo<number>()
    const rows = Array.from({ length: 1_000 }, () => ({}))
    const homes = Array.from({ length: 6 }, () => ({}))
    rows.forEach((row, at) => { memo.cell(row, homes).value = at })
    rows.forEach((row, at) => expect(memo.cell(row, homes).value).toBe(at))
    expect(maps).toBe(1)
    memo.cell(rows[0]!, [{}, ...homes.slice(1)]).value = -1
    expect(memo.cell(rows[0]!, homes).value).toBe(0)
    expect(memo.cell(rows[1]!, homes).value).toBe(1)
    expect(maps).toBeLessThan(20)
  })
})
