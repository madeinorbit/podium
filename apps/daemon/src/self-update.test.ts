import { describe, expect, it } from 'vitest'
import { decideOnProtocolMismatch } from './self-update'

describe('decideOnProtocolMismatch', () => {
  it('installed → update+exit', () => {
    expect(decideOnProtocolMismatch({ installed: true, consecutive: 1 })).toEqual({
      action: 'self-update',
    })
  })
  it('source/dev → just backoff', () => {
    expect(decideOnProtocolMismatch({ installed: false, consecutive: 1 })).toEqual({
      action: 'backoff',
    })
  })
  it('installed but repeated with no update available → give up loudly', () => {
    expect(
      decideOnProtocolMismatch({ installed: true, consecutive: 3, updatedAvailable: false }),
    ).toEqual({
      action: 'give-up',
    })
  })
})
