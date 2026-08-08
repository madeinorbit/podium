import { describe, expect, it } from 'vitest'
import { DELEGATION_RULE, LOCK_RULE, MERGE_LANDING_RULE } from './delegation'

describe('MERGE_LANDING_RULE', () => {
  it('names the hard path, the bans, and the sidebar post-condition', () => {
    // The procedure itself — agents already had a one-liner and still cherry-picked.
    expect(MERGE_LANDING_RULE).toContain('merge-lock acquire')
    expect(MERGE_LANDING_RULE).toContain('local')
    expect(MERGE_LANDING_RULE).toMatch(/merge --ff-only/i)
    expect(MERGE_LANDING_RULE).toContain('merge-lock release')

    // Explicit never-dos — without these, "smarter" paths reappear under load.
    expect(MERGE_LANDING_RULE).toMatch(/NEVER cherry-pick/i)
    expect(MERGE_LANDING_RULE).toMatch(/NEVER push a temp branch tip/i)

    // Why ancestry matters: the done criterion is the git fact, not the ahead proxy.
    expect(MERGE_LANDING_RULE).toContain('merge-base --is-ancestor')
    expect(MERGE_LANDING_RULE).toContain('gitState.merged')
    expect(MERGE_LANDING_RULE).toContain('parentBranch')
    expect(MERGE_LANDING_RULE).toMatch(/ready to merge|sidebar/i)

    // Diverged history is stop-and-ask, not invent-a-route.
    expect(MERGE_LANDING_RULE).toMatch(/STOP and ask/i)
  })

  it('sits next to the lock and delegation rules without drifting into them', () => {
    // Smoke that the three prime co-tenants still export as strings.
    expect(typeof LOCK_RULE).toBe('string')
    expect(typeof DELEGATION_RULE).toBe('string')
    expect(MERGE_LANDING_RULE.length).toBeGreaterThan(200)
  })
})
