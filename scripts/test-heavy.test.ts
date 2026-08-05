import { describe, expect, it } from 'vitest'
import { shouldAcquireHeavyTestLease } from './test-heavy'

describe('shouldAcquireHeavyTestLease', () => {
  it('requires a live session identity', () => {
    expect(shouldAcquireHeavyTestLease({})).toBe(false)
    expect(shouldAcquireHeavyTestLease({ PODIUM_SESSION_ID: 'session-1' })).toBe(true)
  })

  it('does not treat unrelated Podium variables as a session', () => {
    expect(shouldAcquireHeavyTestLease({ PODIUM_INSTANCE: 'default' })).toBe(false)
  })
})
