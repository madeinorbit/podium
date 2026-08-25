/**
 * THE FOLDED LEFT COLUMN — the 58px identity rail under its ⟩ header band.
 *
 * One component because the fold draws this markup TWICE (POD-1658): once as
 * the settled column, and once as the ghost that dissolves in over the last
 * beat of the collapse so the subtree swap at the end lands on identical
 * pixels. A second hand-kept copy is exactly how that swap becomes visible
 * again — which is the bug the ghost exists to hide.
 */
import { ChevronRight } from 'lucide-react'
import type { JSX } from 'react'
import { SidebarRail } from './SidebarRail'

export function CollapsedSidebar({ onExpand }: { onExpand?: () => void }): JSX.Element {
  return (
    <aside className="collapsed-sidebar" aria-label="Collapsed work sidebar">
      <button
        data-pressable
        type="button"
        className="collapsed-sidebar-expand"
        aria-label="Expand sidebar"
        title="Expand sidebar"
        onClick={onExpand}
      >
        {/* 15px, not 13: the control is the column's whole header band
            (POD-1178), and a 13px glyph read as a speck parked in the middle. */}
        <ChevronRight size={15} aria-hidden="true" />
      </button>
      <SidebarRail />
    </aside>
  )
}
