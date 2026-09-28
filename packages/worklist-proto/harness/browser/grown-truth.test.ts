/**
 * POD-4715 — the rescope grown-truth gate is what the lifecycle run fails on
 * when a page does not reach the grown state: 732 rows at 1x, 1,464 at 2x
 * (the full visible set the healed control and the pools hold).
 */
import { describe, expect, it } from 'vitest'
import { truthRows } from './grown-truth'

describe('rescope grown truth (POD-4715)', () => {
  it('is the full visible set at 1x and 2x', () => {
    expect(truthRows(1)).toBe(732)
    expect(truthRows(2)).toBe(1464)
  }, 300_000)
})
