import { describe, expect, it } from 'vitest'
import { dropTargetStage } from './kanban-dnd'

describe('dropTargetStage', () => {
  it('accepts valid stages, rejects junk', () => {
    expect(dropTargetStage('in_progress')).toBe('in_progress')
    expect(dropTargetStage('done')).toBe('done')
    expect(dropTargetStage('nonsense')).toBeNull()
    expect(dropTargetStage('')).toBeNull()
  })
})
