import type { RightPanelTab } from './shell-state'

/**
 * What the right dock renders (POD-95): the selected panel, or a transient
 * issue PEEK layered as a labeled tab beside it. The peek is how a chat ref
 * opens "in place" — the Task (or whichever) panel stays one click away, which
 * is what disambiguates the surface from the current task living in the same
 * dock. One peek at a time; opening another ref replaces it.
 *
 * Width bump: a peek remembers its own (wider) column width under a separate
 * storage key, so glancing at an issue gets more room without permanently
 * resizing the user's dock.
 */
export interface DockSurface {
  /** What the dock body shows right now. */
  surface: 'peek' | 'panel'
  /** True when a panel tab is selected underneath the peek — render its tab so
   *  it stays one click away. */
  panelBehindPeek: boolean
  /** ResizableColumn storage key — peek widths persist separately from the dock. */
  widthKey: string
  defaultWidth: number
}

export const DOCK_WIDTH_KEY = 'podium:rightdock:width'
export const PEEK_WIDTH_KEY = 'podium:rightdock:peekWidth'

/** Null = the dock is hidden (no panel selected, nothing peeked). */
export function dockSurface(args: {
  tab: RightPanelTab | null
  peekIssueId: string | null
}): DockSurface | null {
  if (args.peekIssueId) {
    return {
      surface: 'peek',
      panelBehindPeek: args.tab !== null,
      widthKey: PEEK_WIDTH_KEY,
      defaultWidth: 420,
    }
  }
  if (!args.tab) return null
  return {
    surface: 'panel',
    panelBehindPeek: false,
    widthKey: DOCK_WIDTH_KEY,
    defaultWidth: 340,
  }
}
