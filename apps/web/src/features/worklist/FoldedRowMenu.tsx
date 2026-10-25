import type { IssueNavigationModel } from '@podium/client-core/values'
import { issueDisplayRef } from '@podium/protocol'
import { AlarmClockOff, ArrowUpFromLine } from 'lucide-react'
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
 * THE FOLDED ROW'S RETURN GESTURE (POD-1188).
 *
 * A live row carries the "Tuck" chip in its meta column, and pressing it drops
 * the finished row into Closed. A snooze moves a row into Snoozed. Right-click
 * offers the inverse for each lane: Bring back clears a tucked row's tuck;
 * Unsnooze clears a snoozed row's deferral so it returns to Open.
 *
 * ONE ITEM, NOT THE ISSUE MENU. The full `IssueContextMenu` is what a LIVE row
 * offers: stage, priority, colour, labels, handoff, delete. A row in the fold is
 * out of triage. `FoldedWorkRow` keeps the task's identity and folded status,
 * without its live vocabulary, and putting sixteen items behind this
 * right-click would be re-triaging from inside the fold. Bring it back or
 * unsnooze it and the live row's own menu is right there.
 *
 * DISABLED WITH ITS REASON, NEVER HIDDEN (POD-821's rule, POD-1077's reading of
 * it): a closed row past the finished-grace window is held down by the backstop
 * rather than by the tuck, so clearing the tuck would move nothing. An item that
 * quietly did nothing, or a right-click that opened nothing at all, are both
 * indistinguishable from a broken gate, so Bring back says why it is disabled.
 * Unsnooze clears the deferral without that closed-row grace-window restriction.
 */
export function FoldedRowMenu({
  issue,
  canBringBack,
  anchor,
  onClose,
  onBringBack,
  onUnsnooze,
}: {
  issue: IssueNavigationModel
  /** Would clearing the tuck actually return the row to the live list?
   *  `rowCanBringBack` — the grace window is the gate. */
  canBringBack: boolean
  anchor: ContextMenuAnchor
  onClose: () => void
  onBringBack: () => void
  onUnsnooze?: () => void
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
      {}
      <div className={`${MENU_HEADER} px-[5px]`}>
        <span>TASK</span>
        <span className={`${MENU_HEADER_REF} tabular-nums`}>{issueDisplayRef(issue)}</span>
      </div>
      {onUnsnooze ? (
        <button
          data-pressable
          type="button"
          role="menuitem"
          className={MENU_ITEM}
          onClick={() => {
            onUnsnooze()
            onClose()
          }}
        >
          <AlarmClockOff size={14} aria-hidden="true" /> Unsnooze
        </button>
      ) : canBringBack ? (
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
