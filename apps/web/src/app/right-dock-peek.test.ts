import { describe, expect, it } from 'vitest'
import { DOCK_WIDTH_KEY, dockSurface, PEEK_WIDTH_KEY } from './right-dock-peek'

describe('dockSurface', () => {
  it('is hidden with no panel and no peek', () => {
    expect(dockSurface({ tab: null, peekIssueId: null })).toBeNull()
  })

  it('shows the selected panel at the regular width', () => {
    expect(dockSurface({ tab: 'issue', peekIssueId: null })).toEqual({
      surface: 'panel',
      panelBehindPeek: false,
      widthKey: DOCK_WIDTH_KEY,
      defaultWidth: 340,
    })
  })

  it('a peek wins over the selected panel and keeps its tab reachable', () => {
    expect(dockSurface({ tab: 'issue', peekIssueId: 'iss_1' })).toEqual({
      surface: 'peek',
      panelBehindPeek: true,
      widthKey: PEEK_WIDTH_KEY,
      defaultWidth: 420,
    })
  })

  it('a peek opens the dock even when it was closed', () => {
    expect(dockSurface({ tab: null, peekIssueId: 'iss_1' })).toMatchObject({
      surface: 'peek',
      panelBehindPeek: false,
    })
  })

  it('peek width persists under its own key (width bump, not a resize)', () => {
    expect(PEEK_WIDTH_KEY).not.toBe(DOCK_WIDTH_KEY)
  })
})
