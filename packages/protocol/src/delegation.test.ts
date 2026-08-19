import { describe, expect, it } from 'vitest'
import { DELEGATION_RULE, LOCK_RULE } from './delegation'

describe('LOCK_RULE', () => {
  it('reserves the merge namespace to the canonical name', () => {
    // The mutex having two spellings is what let two sessions hold it at once.
    expect(LOCK_RULE).toContain('merge:<branch>')
    expect(LOCK_RULE).toMatch(/RESERVED/)
    expect(LOCK_RULE).toMatch(/REFUSED/)
  })

  it('sits next to the lock and delegation rules without drifting into them', () => {
    // Smoke that the two prime co-tenants still export as strings.
    expect(typeof LOCK_RULE).toBe('string')
    expect(typeof DELEGATION_RULE).toBe('string')
  })
})

describe('prime-bound procedure length (POD-789)', () => {
  it('keeps the two always-loaded procedures under 4 KB combined', () => {
    const combined = LOCK_RULE.length + DELEGATION_RULE.length
    expect(combined).toBeLessThan(4000)
  })
})
