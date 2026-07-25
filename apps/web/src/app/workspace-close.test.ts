import { describe, expect, it, vi } from 'vitest'
import type { DeckTab } from './panel-deck'
import { closeWorkspaceTab } from './workspace-close'

describe('closeWorkspaceTab', () => {
  it('consumes Cmd+W without closing a session tab', () => {
    const closeFileTab = vi.fn()
    const active = {
      id: 'session-1',
      kind: 'session',
      session: { sessionId: 'session-1' },
    } as DeckTab

    expect(closeWorkspaceTab(active, closeFileTab)).toBe(true)
    expect(closeFileTab).not.toHaveBeenCalled()
  })

  it('closes an active file tab', () => {
    const closeFileTab = vi.fn()
    const active = {
      id: 'file:/repo/readme.md',
      kind: 'file',
      file: { id: 'file:/repo/readme.md' },
    } as DeckTab

    expect(closeWorkspaceTab(active, closeFileTab)).toBe(true)
    expect(closeFileTab).toHaveBeenCalledWith('file:/repo/readme.md')
  })

  it('allows the desktop shell fallback when there is no active tab', () => {
    expect(closeWorkspaceTab(undefined, vi.fn())).toBe(false)
  })
})
