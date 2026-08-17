import type { IssueNavigationModel } from '@podium/client-core/viewmodels'
import { issueDisplayRef } from '@podium/protocol'
import { ArrowUpFromLine } from 'lucide-react'
import type { JSX } from 'react'
import { createPortal } from 'react-dom'
import {
  MENU_HEADER,
  MENU_HEADER_REF,
  MENU_ITEM,
  MENU_ITEM_DISABLED,
  MENU_PANEL,
  MENU_SUBTEXT,
} from '@/lib/menu-surface'
import type { ContextMenuAnchor } from '@/lib/session-context-menu'
import { useCursorMenu } from '@/lib/use-cursor-menu'

/**
 * THE FOLDED ROW'S ONE GESTURE (POD-1188): Bring back.
 *
 * A live row carries the "Tuck" chip in its meta column, and pressing it drops
 * the finished row into Closed. Nothing carried the inverse: a row tucked away
 * by mistake could be clicked back into the panel, archived, or reopened — but
 * not simply put back where it was. So the folded row answers a right-click, and
 * what it answers with is the one move that is missing.
 *
 * ONE ITEM, NOT THE ISSUE MENU. The full `IssueContextMenu` is what a LIVE row
 * offers: stage, priority, colour, labels, handoff, delete. A row in the fold is
 * out of triage — the whole point of `FoldedWorkRow` dropping to one dim line is
 * that the vocabulary of an open row does not apply to it — and putting sixteen
 * items behind this right-click would be re-triaging from inside the archive.
 * Bring it back and the live row's own menu is right there.
 *
 * DISABLED WITH ITS REASON, NEVER HIDDEN (POD-821's rule, POD-1077's reading of
 * it): a folded row past the finished-grace window is held down by the backstop
 * rather than by the tuck, so clearing the tuck would move nothing. An item that
 * quietly did nothing, or a right-click that opened nothing at all, are both
 * indistinguishable from a broken gate — so the row says which one it is.
 */
export function FoldedRowMenu({
  issue,
  canBringBack,
  anchor,
  onClose,
  onBringBack,
}: {
  issue: IssueNavigationModel
  /** Would clearing the tuck actually return the row to the live list?
   *  `rowCanBringBack` — the grace window is the gate. */
  canBringBack: boolean
  anchor: ContextMenuAnchor
  onClose: () => void
  onBringBack: () => void
}): JSX.Element {
  const { ref, pos } = useCursorMenu(anchor, onClose)
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Folded task actions"
      className={`fixed z-[60] min-w-[196px] ${MENU_PANEL}`}
      style={{ left: pos.x, top: pos.y }}
      // The host opens this on contextmenu; suppress a nested browser menu.
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* The same header the issue menu, the session menu and the colour picker
          wear (POD-380) — these panels open one pixel apart in this column and
          have to read as one object. */}
      <div className={`${MENU_HEADER} px-[5px]`}>
        <span>TASK</span>
        <span className={`${MENU_HEADER_REF} tabular-nums`}>{issueDisplayRef(issue)}</span>
      </div>
      {canBringBack ? (
        <button
          data-pressable
          type="button"
          role="menuitem"
          className={MENU_ITEM}
          data-testid="bring-back"
          onClick={() => {
            onBringBack()
            onClose()
          }}
        >
          {/* The tuck chip's glyph, turned around: that control points DOWN into
              Closed, so its inverse points back up out of it. */}
          <ArrowUpFromLine size={14} aria-hidden="true" /> Bring back
        </button>
      ) : (
        <button
          data-pressable
          type="button"
          role="menuitem"
          disabled
          className={`${MENU_ITEM_DISABLED} flex-col items-stretch gap-0.5`}
          data-testid="bring-back-blocked"
        >
          <span className="flex items-center gap-2">
            <ArrowUpFromLine size={14} aria-hidden="true" /> Bring back
          </span>
          <span className={MENU_SUBTEXT}>The fold keeps closures older than a day</span>
        </button>
      )}
    </div>,
    document.body,
  )
}
