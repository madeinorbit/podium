import { describe, expect, it } from 'vitest'
import {
  type CostModelTotalWire,
  descendantsOf,
  floorOf,
  foldModelTotals,
  messagesOf,
  taskCostState,
} from './cost'

const total = (model: string, over: Partial<CostModelTotalWire> = {}): CostModelTotalWire => ({
  model,
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 1_000,
  cacheCreationTokens: 50,
  cacheCreation1hTokens: 0,
  messages: 1,
  ...over,
})

describe('foldModelTotals', () => {
  it('sums every class across sources and keeps one row per model', () => {
    const folded = foldModelTotals([
      [total('claude-opus-5'), total('gpt-5.6-sol', { messages: 3 })],
      [total('claude-opus-5', { outputTokens: 90, cacheCreation1hTokens: 7 })],
    ])
    expect(folded.map((m) => m.model)).toEqual(['claude-opus-5', 'gpt-5.6-sol'])
    expect(folded[0]).toMatchObject({
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 2_000,
      cacheCreationTokens: 100,
      cacheCreation1hTokens: 7,
      messages: 2,
    })
    expect(messagesOf(folded)).toBe(5)
  })

  it('folds nothing into nothing rather than into a zero row', () => {
    expect(foldModelTotals([])).toEqual([])
    expect(messagesOf([])).toBe(0)
  })
})

describe('the floor rule', () => {
  // Keyed off HARNESS and nothing else: Claude-side attribution is complete
  // (every usage-bearing Claude transcript has a segment row, subagent files
  // included), so only a task touched by another harness is a lower bound.
  it('marks a wholly-Codex task and a mixed task, not an all-Claude one', () => {
    expect(floorOf(['claude-code'])).toBe('none')
    expect(floorOf(['claude-code', 'claude-code'])).toBe('none')
    expect(floorOf(['codex'])).toBe('partial')
    expect(floorOf(['claude-code', 'codex'])).toBe('partial')
    expect(floorOf(['grok'])).toBe('partial')
  })

  it('does not mark a task with nothing counted — that is a cold state', () => {
    expect(floorOf([])).toBe('none')
  })

  // The correction POD-1869 measured: harness alone asserted a completeness it
  // could not see. POD-1574 was wholly Claude, fully attributed, and read 'none'
  // while 8 of its 10 sessions had never been harvested — a figure a third of
  // real spend, presented as complete.
  it('marks a wholly-Claude task whose sessions were never harvested', () => {
    expect(floorOf(['claude-code'], 1)).toBe('partial')
    expect(floorOf(['claude-code'], 8)).toBe('partial')
  })

  it('leaves a fully harvested all-Claude task unmarked', () => {
    expect(floorOf(['claude-code'], 0)).toBe('none')
  })

  it('marks on either reason, and the reasons stay separable', () => {
    // Harness only, everything harvested.
    expect(floorOf(['codex'], 0)).toBe('partial')
    // Completeness only, all Claude.
    expect(floorOf(['claude-code'], 3)).toBe('partial')
  })
})

describe('the four states', () => {
  it('costs a task with any counted reply, whatever else is missing', () => {
    expect(taskCostState({ sessionCount: 10, costedSessionCount: 1, pendingSessionCount: 9 })).toBe(
      'costed',
    )
  })

  // POD-1608 is the live case: 126 files changed and a truthful zero, because
  // the agent that did the work was bound to another issue. NEVER a $0.00.
  it('reads a task nobody ever ran a session on as no-sessions', () => {
    expect(taskCostState({ sessionCount: 0, costedSessionCount: 0, pendingSessionCount: 0 })).toBe(
      'no-sessions',
    )
  })

  it('reads sessions whose transcripts are gone as not-recorded', () => {
    expect(taskCostState({ sessionCount: 4, costedSessionCount: 0, pendingSessionCount: 0 })).toBe(
      'not-recorded',
    )
  })

  it('prefers pending over not-recorded — an unread file is not a lost one', () => {
    expect(taskCostState({ sessionCount: 4, costedSessionCount: 0, pendingSessionCount: 1 })).toBe(
      'pending',
    )
  })
})

describe('the rollup walk', () => {
  const tree = (edges: [string, string][]): Map<string, string[]> => {
    const out = new Map<string, string[]>()
    for (const [parent, child] of edges) {
      const list = out.get(parent)
      if (list) list.push(child)
      else out.set(parent, [child])
    }
    return out
  }

  it('reaches every descendant, not just the children', () => {
    const children = tree([
      ['epic', 'a'],
      ['epic', 'b'],
      ['a', 'a1'],
      ['a1', 'a2'],
    ])
    expect(descendantsOf('epic', children).sort()).toEqual(['a', 'a1', 'a2', 'b'])
  })

  it('returns nothing for a leaf', () => {
    expect(descendantsOf('leaf', tree([['other', 'x']]))).toEqual([])
  })

  it('counts each descendant once when the graph reaches it twice', () => {
    const children = tree([
      ['epic', 'a'],
      ['epic', 'b'],
      ['a', 'shared'],
      ['b', 'shared'],
    ])
    expect(descendantsOf('epic', children).sort()).toEqual(['a', 'b', 'shared'])
  })

  // `parent_id` is a plain self-reference with no cycle constraint, so a
  // reparent that closes a loop must cost one task's figure, not the read path.
  it('terminates on a cycle instead of hanging the read', () => {
    const children = tree([
      ['epic', 'a'],
      ['a', 'b'],
      ['b', 'epic'],
    ])
    expect(descendantsOf('epic', children).sort()).toEqual(['a', 'b'])
  })
})
