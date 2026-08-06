import { describe, expect, it } from 'vitest'
import {
  isOverlayView,
  nextBaseView,
  readBooleanState,
  readRightPanel,
  readSuperagentMode,
  rightPanelAllowed,
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

  it('accepts only a known right-dock panel', () => {
    expect(readRightPanel('git')).toBe('git')
    expect(readRightPanel('merge-queue')).toBe('merge-queue')
    expect(readRightPanel('unknown')).toBeNull()
  })

  it('gates experimental dock panels independently', () => {
    const features = { git: true, messages: true, mergeQueue: false }
    expect(rightPanelAllowed('files', features)).toBe(true)
    expect(rightPanelAllowed('git', features)).toBe(true)
    expect(rightPanelAllowed('merge-queue', features)).toBe(false)
    expect(rightPanelAllowed('merge-queue', { ...features, mergeQueue: true })).toBe(true)
  })
})

describe('utility overlays layer over a mode (POD-365)', () => {
  it('treats only the utilities as overlays', () => {
    expect(isOverlayView('settings')).toBe(true)
    expect(isOverlayView('usage')).toBe(true)
    expect(isOverlayView('workspace')).toBe(false)
    expect(isOverlayView('issues')).toBe(false)
  })

  it('keeps the mode underneath an overlay so closing returns you where you were', () => {
    // Opening Settings from Tasks must not silently rewrite "where you were" to
    // the workspace, which is what the old hard-coded close did.
    expect(nextBaseView('issues', 'settings')).toBe('issues')
    expect(nextBaseView('issues', 'usage')).toBe('issues')
    expect(nextBaseView('workspace', 'settings')).toBe('workspace')
  })

  it('adopts any non-overlay view as the new base', () => {
    expect(nextBaseView('workspace', 'issues')).toBe('issues')
    expect(nextBaseView('issues', 'workspace')).toBe('workspace')
    expect(nextBaseView('issues', 'workflows')).toBe('workflows')
  })
})
