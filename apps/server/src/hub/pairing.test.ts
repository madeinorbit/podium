import { describe, expect, it } from 'vitest'
import { PairingManager } from './pairing'

describe('PairingManager', () => {
  it('redeems a freshly minted code exactly once', () => {
    let n = 0
    const p = new PairingManager({ randomCode: () => `CODE-000${n++}`, ttlMs: 1000 })
    const code = p.mint({ copyAgentCredentials: true }, 0)
    expect(p.redeem(code, 100)).toEqual({ copyAgentCredentials: true })
    expect(p.redeem(code, 100)).toBeUndefined() // single-use
  })
  it('rejects an expired code', () => {
    const p = new PairingManager({ randomCode: () => 'CODE-0001', ttlMs: 1000 })
    const code = p.mint({}, 0)
    expect(p.redeem(code, 2000)).toBeUndefined()
  })
  it('keeps the default code alive for a long install and expires it after one hour', () => {
    const p = new PairingManager({ randomCode: () => 'CODE-0001' })
    const code = p.mint({}, 0)
    expect(p.redeem(code, 10 * 60_000)).toEqual({})

    const expired = p.mint({}, 0)
    expect(p.redeem(expired, 60 * 60_000 + 1)).toBeUndefined()
  })
  it('rejects an unknown code', () => {
    const p = new PairingManager({ randomCode: () => 'CODE-0001', ttlMs: 1000 })
    expect(p.redeem('NOPE-NOPE', 0)).toBeUndefined()
  })
})
