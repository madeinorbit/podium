import { describe, expect, it, vi } from 'vitest'
import { closeActiveWorkspaceTab } from './workspace-close'

describe('closeActiveWorkspaceTab', () => {
  // POD-710: the lock is gone — a session tab is a view like any other, so Cmd+W
  // closes it. The session itself is untouched (the caller only rewrites the
  // workspace layout), which is why this returns true rather than declining.
  it('closes an active session tab and consumes the keystroke', () => {
    const closeTab = vi.fn()

    expect(closeActiveWorkspaceTab('session-1', closeTab)).toBe(true)
    expect(closeTab).toHaveBeenCalledWith('session-1')
  })

  it('closes an active file tab', () => {
    const closeTab = vi.fn()

    expect(closeActiveWorkspaceTab('file:/repo/readme.md', closeTab)).toBe(true)
    expect(closeTab).toHaveBeenCalledWith('file:/repo/readme.md')
  })

  it('allows the desktop shell fallback when there is no active tab', () => {
    const closeTab = vi.fn()

    expect(closeActiveWorkspaceTab(null, closeTab)).toBe(false)
    expect(closeTab).not.toHaveBeenCalled()
  })
})
