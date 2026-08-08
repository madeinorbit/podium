import { describe, expect, it } from 'vitest'
import { PULL_REFRESH_THRESHOLD, pullWillRefresh, resistedPullDistance } from './pull-to-refresh'

describe('PWA pull-to-refresh motion', () => {
  it('ignores upward travel and resists a downward pull', () => {
    expect(resistedPullDistance(-20)).toBe(0)
    expect(resistedPullDistance(40)).toBe(20)
    expect(resistedPullDistance(1_000)).toBe(78)
  })

  it('arms only after the visible release threshold', () => {
    expect(pullWillRefresh(PULL_REFRESH_THRESHOLD - 1)).toBe(false)
    expect(pullWillRefresh(PULL_REFRESH_THRESHOLD)).toBe(true)
  })
})
