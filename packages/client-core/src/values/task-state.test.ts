import { describe, expect, it } from 'vitest'
import { rankedTaskStateSlots, taskStateWord } from './task-state'

const issue = (over: Record<string, unknown> = {}) => ({
  needsHuman: false,
  blocked: false,
  dependents: [],
  childCount: 0,
  childDoneCount: 0,
  ...over,
})

describe('rankedTaskStateSlots', () => {
  it('keeps the shared desktop/mobile rank under competing state', () => {
    const value = issue({
      needsHuman: true,
      blocked: true,
      dependents: [{ type: 'blocks' }],
      gitState: { shared: false, ahead: 3 },
      childCount: 5,
      childDoneCount: 2,
    })
    expect(rankedTaskStateSlots(value, { workingAgents: 2 }).map((slot) => slot.kind)).toEqual([
      'needs-human',
      'blocked',
      'blocking',
      'live',
      'merge',
      'subtree',
    ])
    expect(taskStateWord(value, 2)).toEqual({ text: 'needs you', tone: 'attention' })
  })

  it('suppresses the merge axis on shared workspaces', () => {
    expect(
      rankedTaskStateSlots(issue({ gitState: { shared: true, ahead: 9 } }), {
        workingAgents: 0,
      }),
    ).toEqual([])
  })
})
