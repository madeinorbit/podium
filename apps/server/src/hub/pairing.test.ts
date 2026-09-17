import { describe, expect, it } from 'vitest'
import { asUserId } from '@podium/model'
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
  it('expires default codes after ten minutes', () => {
    const p = new PairingManager({ randomCode: () => 'CODE-0001' })
    const code = p.mint({}, 0)
    expect(p.redeem(code, 9 * 60_000)).toEqual({})

    const expired = p.mint({}, 0)
    expect(p.redeem(expired, 10 * 60_000)).toBeUndefined()
  })
  it('rejects an unknown code', () => {
    const p = new PairingManager({ randomCode: () => 'CODE-0001', ttlMs: 1000 })
    expect(p.redeem('NOPE-NOPE', 0)).toBeUndefined()
  })
})

describe('pairing boundaries', () => {
  it('stamps the authoritative installation and bounds mints per member', () => {
    let n = 0
    const p = new PairingManager({ installationId: 'installation-a', randomCode: () => `code-${n++}` })
    const grant = { ownerUserId: asUserId('member-a'), installationId: 'forged' }
    const code = p.mint(grant, 0)
    expect(p.redeem(code, 1)?.installationId).toBe('installation-a')
    for (let i = 0; i < 4; i++) p.mint(grant, 1)
    expect(() => p.mint(grant, 1)).toThrow('rate limit')
    expect(() => p.mint(grant, 60_000)).not.toThrow()
  })
  it('bounds all redemption attempts, including unknown codes and new connections', () => {
    const p = new PairingManager()
    const code = p.mint({}, 0)
    for (let i = 0; i < 120; i++) expect(p.redeem(`wrong-${i}`, 1)).toBeUndefined()
    expect(p.redeem(code, 1)).toBeUndefined()
    expect(p.redeem(code, 60_001)).toEqual({})
  })
})
