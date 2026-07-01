import { describe, expect, it } from 'vitest'
import { decideOnProtocolMismatch, decidePostUpdate } from './self-update'

describe('decideOnProtocolMismatch', () => {
  it('installed → self-update', () => {
    expect(decideOnProtocolMismatch({ installed: true })).toEqual({ action: 'self-update' })
  })
  it('source/dev → just backoff', () => {
    expect(decideOnProtocolMismatch({ installed: false })).toEqual({ action: 'backoff' })
  })
})

describe('decidePostUpdate', () => {
  it('exit 10 (updated) → restart into the new binary', () => {
    expect(decidePostUpdate(10)).toBe('restart')
  })
  it('exit 0 (already current) → give up', () => {
    expect(decidePostUpdate(0)).toBe('give-up')
  })
  it('exit 1 (update failed) → give up', () => {
    expect(decidePostUpdate(1)).toBe('give-up')
  })
  it('null status (spawn killed by signal) → give up', () => {
    expect(decidePostUpdate(null)).toBe('give-up')
  })
})
