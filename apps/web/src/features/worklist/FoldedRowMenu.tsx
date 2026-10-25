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

/** One return action per folded lane: clear snooze, or bring a tucked task
 * back while it is still inside the finished-grace window. */
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
