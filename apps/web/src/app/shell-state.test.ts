import { describe, expect, it } from 'vitest'
import {
  isOverlayView,
  nextBaseView,
  readBooleanState,
  readFlightDeckCollapsed,
  readRightPanel,
  rightPanelAllowed,
} from './shell-state'

describe('desktop shell persistence readers', () => {
  it('restores independent sidebar collapse state without treating corrupt values as true', () => {
    expect(readBooleanState('true')).toBe(true)
    expect(readBooleanState('0', true)).toBe(false)
    expect(readBooleanState('wat', false)).toBe(false)
  })

  it('accepts only a known right-dock panel', () => {
    expect(readRightPanel('superagent')).toBe('superagent')
    expect(readRightPanel('git')).toBe('git')
    expect(readRightPanel('merge-queue')).toBe('merge-queue')
    expect(readRightPanel('unknown')).toBeNull()
  })

  // The Flight Deck inherited the Superagent column's slot AND its persisted
  // mode key, so a user's saved 'folded' still folds and the pre-#65 'closed'
  // spelling still resolves to folded rather than removing the column.
  it('folds the Flight Deck on folded/closed and opens on anything else', () => {
    expect(readFlightDeckCollapsed('folded')).toBe(true)
    expect(readFlightDeckCollapsed('closed')).toBe(true)
    expect(readFlightDeckCollapsed('open')).toBe(false)
    expect(readFlightDeckCollapsed(null)).toBe(false)
    expect(readFlightDeckCollapsed('invalid')).toBe(false)
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
