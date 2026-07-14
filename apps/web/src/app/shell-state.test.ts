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

  it('restores the engraved tri-state and migrates the legacy open boolean', () => {
    expect(readSuperagentMode('folded', false)).toBe('folded')
    expect(readSuperagentMode('closed', true)).toBe('closed')
    expect(readSuperagentMode(null, true)).toBe('open')
    expect(readSuperagentMode('invalid', false)).toBe('closed')
  })

  it('accepts only one of the four right-dock panels and defaults last-used to Issue', () => {
    expect(readRightPanel('git')).toBe('git')
    expect(readRightPanel('unknown')).toBeNull()
    expect(readLastRightPanel('shell')).toBe('shell')
    expect(readLastRightPanel(null)).toBe('issue')
  })
})
