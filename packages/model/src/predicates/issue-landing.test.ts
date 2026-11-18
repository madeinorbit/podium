import { describe, expect, it } from 'vitest'
import { issueLanding } from './issue-landing'

describe('issueLanding (POD-2151)', () => {
  const landed = {
    stage: 'done' as const,
    closedReason: 'done',
    parentBranch: 'tf.dev',
    landedAt: '2026-10-26T19:59:00Z',
    landedSha: 'fcd1385aa9e0',
    branch: 'issue/1-x',
    // What the merge action writes: the axis it just settled.
    gitState: { shared: false, merged: true, ahead: 0 },
  }

  it('reads where and what a done row landed', () => {
    expect(issueLanding(landed)).toEqual({ at: landed.landedAt, branch: 'tf.dev', sha: 'fcd1385' })
    expect(issueLanding({ ...landed, landedSha: null, parentBranch: null })).toEqual({
      at: landed.landedAt,
      branch: null,
      sha: null,
    })
  })

  it('is null without a stamp, for any ending but done, and while new work awaits merge', () => {
    expect(issueLanding({ ...landed, landedAt: null })).toBeNull()
    expect(issueLanding({ ...landed, closedReason: 'cancelled' })).toBeNull()
    expect(issueLanding({ ...landed, stage: 'in_progress', closedReason: null })).toBeNull()
    // The stamp outlives a reopen; unlanded work outranks it.
    expect(issueLanding({ ...landed, gitState: { shared: false, ahead: 1 } })).toBeNull()
  })
})
