import { describe, expect, it } from 'vitest'
import { agentLaunchProcedure } from './agent-launch'

describe('agent launch routing', () => {
  it('adds a session when the issue has a live worktree', () => {
    expect(
      agentLaunchProcedure({ branch: 'issue/12-live', worktreePath: '/repo/.worktrees/12' }),
    ).toBe('addSession')
  })

  it('restarts a branch whose worktree was freed', () => {
    expect(agentLaunchProcedure({ branch: 'issue/12-preserved', worktreePath: null })).toBe('start')
  })

  it('starts an issue with no existing checkout', () => {
    expect(agentLaunchProcedure({ branch: null, worktreePath: null })).toBe('start')
  })
})
