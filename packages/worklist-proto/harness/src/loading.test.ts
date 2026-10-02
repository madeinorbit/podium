import { LOADING as rootLoading, MobxPool } from '@podium/client-graph'
import { LOADING } from '@podium/client-graph/loading'
import { LOADING as rollupLoading } from '@podium/client-graph/worklist/rollup'
import { expect, it } from 'vitest'

it('shares one cold-row marker across compatibility exports and live pool reads', () => {
  expect(rootLoading).toBe(LOADING)
  expect(rollupLoading).toBe(LOADING)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  try {
    expect(pool.row('preference', 'podium.chat.stickyPrompts')).toBe(LOADING)
  } finally {
    pool.dispose()
  }
})
