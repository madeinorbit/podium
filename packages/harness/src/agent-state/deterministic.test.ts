import { describe, expect, it } from 'vitest'
import { deterministicStateToEvents, resolvedState } from './deterministic'

describe('deterministicStateToEvents', () => {
  it('preserves the explicit open-todo idle verdict', () => {
    expect(
      deterministicStateToEvents(
        resolvedState('idle.needs_input.open_todo_list', 'provider task list remains open'),
      ),
    ).toEqual([
      { kind: 'turn_completed', verdict: { kind: 'open_todos', summary: 'open todo list' } },
    ])
  })
})
