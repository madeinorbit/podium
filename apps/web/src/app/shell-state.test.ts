import { describe, expect, it } from 'vitest'
import {
  readBooleanState,
  readLastRightPanel,
  readRightPanel,
  readSuperagentMode,
} from './shell-state'

describe('desktop shell persistence readers', () => {
  it('restores independent sidebar collapse state without treating corrupt values as true', () => {
    expect(readBooleanState('true')).toBe(true)
    expect(readBooleanState('0', true)).toBe(false)
    expect(readBooleanState('wat', false)).toBe(false)
  })

  it('restores open/folded and normalizes every legacy closed shape to folded (#65)', () => {
    expect(readSuperagentMode('open', false)).toBe('open')
    expect(readSuperagentMode('folded', false)).toBe('folded')
    // Pre-#65 persisted 'closed' folds — the column never disappears.
    expect(readSuperagentMode('closed', true)).toBe('folded')
    expect(readSuperagentMode(null, true)).toBe('open')
    expect(readSuperagentMode(null, false)).toBe('folded')
    expect(readSuperagentMode('invalid', false)).toBe('folded')
  })

  it('accepts only one of the four right-dock panels and defaults last-used to Issue', () => {
    expect(readRightPanel('git')).toBe('git')
    expect(readRightPanel('unknown')).toBeNull()
    expect(readLastRightPanel('shell')).toBe('shell')
    expect(readLastRightPanel(null)).toBe('issue')
  })
})
