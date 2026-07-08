import { describe, expect, it } from 'vitest'
import { PairingManager } from './pairing'

describe('PairingManager', () => {
  it('redeems a freshly minted code exactly once', () => {
    let n = 0
    const p = new PairingManager({ randomCode: () => `CODE-000${n++}`, ttlMs: 1000 })
    const code = p.mint(0)
    expect(p.redeem(code, 100)).toBe(true)
    expect(p.redeem(code, 100)).toBe(false) // single-use
  })
  it('rejects an expired code', () => {
    const p = new PairingManager({ randomCode: () => 'CODE-0001', ttlMs: 1000 })
    const code = p.mint(0)
    expect(p.redeem(code, 2000)).toBe(false)
  })
  it('rejects an unknown code', () => {
    const p = new PairingManager({ randomCode: () => 'CODE-0001', ttlMs: 1000 })
    expect(p.redeem('NOPE-NOPE', 0)).toBe(false)
  })
})
