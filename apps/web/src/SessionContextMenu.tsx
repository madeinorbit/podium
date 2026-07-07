import type { SessionMeta } from '@podium/protocol'
import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  Mail,
  MailOpen,
  MessageSquareText,
  Moon,
  Pencil,
  Pin,
  PinOff,
  Play,
  X,
} from 'lucide-react'
import { type JSX, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isSnoozed, snoozeUntil1h, snoozeUntilTomorrow5am } from './derive'
import { useSessionGuard } from './hooks/use-session-guard'
import { useStore } from './store'
import { useNow } from './useNow'

export interface ContextMenuAnchor {
  x: number
  y: number
}

/**
 * Which lifecycle actions apply to a session right now. Pure so the eligibility
 * rules (which gate the menu items) can be unit-tested without rendering.
 *  - hibernate: only a live, recoverable agent that isn't mid-turn (parking a
 *    working agent would lose its in-flight turn — the server enforces this too).
 *  - resume: a parked session (hibernated, or exited-but-recoverable).
 *  - close: a session with a process to kill.
 */
export function sessionMenuEligibility(session: SessionMeta): {
  canHibernate: boolean
  canResume: boolean
  canClose: boolean
  canMarkRead: boolean
  canMarkUnread: boolean
} {
  const phase = session.agentState?.phase
  const working = phase === 'working' || phase === 'compacting'
  const status = session.status
  return {
    canHibernate: status === 'live' && session.resumable === true && !working,
    canResume: status === 'hibernated' || (status === 'exited' && session.resumable === true),
    canClose: status === 'live' || status === 'starting' || status === 'reconnecting',
    // Email-style read toggle (#138): a currently-read session offers "mark unread";
    // an unread one offers "mark read". (`unread` is always a boolean on the wire.)
    canMarkRead: session.unread === true,
    canMarkUnread: !session.unread,
  }
}

/**
 * Right-click context menu for a session — the same actions the tab/panel/agent
 * toolbars expose (rename, pin, snooze, hibernate, resume, BTW, archive, close),
 * gathered in one place so they're reachable without hunting hover targets. Used
 * by the sidebar panel rows and the workspace tab strip. Cursor-anchored portal
 * (matches SnoozeControl's pattern), clamped into the viewport, dismissed on
 * outside-click / Escape / scroll.
 */
export function SessionContextMenu({
  session,
  pinned,
  anchor,
  onClose,
  onRename,
}: {
  session: SessionMeta
  pinned: boolean
  anchor: ContextMenuAnchor
  onClose: () => void
  /** Enter inline rename mode in the host (sidebar row / tab). */
  onRename: () => void
}): JSX.Element {
  const {
    setPinned,
    setSnooze,
    clearSnooze,
    hibernateSession,
    resurrectSession,
    startBtw,
    markSessionRead,
    markSessionUnread,
  } = useStore()
  const { guardedKill, guardedArchive } = useSessionGuard()
  const now = useNow(60_000)
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<ContextMenuAnchor>(anchor)

  // Clamp into the viewport once the menu has measured its real size, so a
  // right-click near the bottom/right edge doesn't open a clipped menu.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(anchor.x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(anchor.y, window.innerHeight - r.height - 8)),
    })
  }, [anchor])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const id = session.sessionId
  const snoozed = isSnoozed(session, now)
  const { canHibernate, canResume, canClose, canMarkRead, canMarkUnread } =
    sessionMenuEligibility(session)

  const run = (fn: () => void | Promise<void>): void => {
    void fn()
    onClose()
  }

  const itemCls =
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent hover:text-accent-foreground'

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Session actions"
      className="fixed z-[60] min-w-[190px] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
      style={{ left: pos.x, top: pos.y }}
      // The host opens this on contextmenu; suppress a nested browser menu.
      onContextMenu={(e) => e.preventDefault()}
    >
      <button type="button" role="menuitem" className={itemCls} onClick={() => run(onRename)}>
        <Pencil size={14} aria-hidden="true" /> Rename
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemCls}
        onClick={() => run(() => setPinned('panel', id, !pinned))}
      >
        {pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
        {pinned ? 'Unpin' : 'Pin'}
      </button>
      {/* Email-style read toggle (#138): mark a read session unread (or an unread
          one read) — mutually exclusive. Store actions are optimistic. */}
      {canMarkUnread && (
        <button
          type="button"
          role="menuitem"
          className={itemCls}
          onClick={() => run(() => markSessionUnread(id))}
        >
          <Mail size={14} aria-hidden="true" /> Mark as unread
        </button>
      )}
      {canMarkRead && (
        <button
          type="button"
          role="menuitem"
          className={itemCls}
          onClick={() => run(() => markSessionRead(id))}
        >
          <MailOpen size={14} aria-hidden="true" /> Mark as read
        </button>
      )}

      <div className="my-1 h-px bg-border" role="separator" />
      {snoozed ? (
        <button
          type="button"
          role="menuitem"
          className={itemCls}
          onClick={() => run(() => clearSnooze(id))}
        >
          <AlarmClockOff size={14} aria-hidden="true" /> Un-snooze
        </button>
      ) : (
        <>
          <div className="px-2 py-1 text-[11px] font-medium tracking-wide text-muted-foreground">
            Snooze
          </div>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => run(() => setSnooze(id, snoozeUntil1h(Date.now())))}
          >
            <AlarmClock size={14} aria-hidden="true" /> For 1 hour
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => run(() => setSnooze(id, snoozeUntilTomorrow5am(Date.now())))}
          >
            <AlarmClock size={14} aria-hidden="true" /> Until tomorrow
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => run(() => setSnooze(id, null))}
          >
            <AlarmClock size={14} aria-hidden="true" /> Until next message
          </button>
        </>
      )}

      <div className="my-1 h-px bg-border" role="separator" />
      {canHibernate && (
        <button
          type="button"
          role="menuitem"
          className={itemCls}
          onClick={() => run(() => hibernateSession(id))}
        >
          <Moon size={14} aria-hidden="true" /> Hibernate
        </button>
      )}
      {canResume && (
        <button
          type="button"
          role="menuitem"
          className={itemCls}
          onClick={() => run(() => resurrectSession(id))}
        >
          <Play size={14} aria-hidden="true" /> Resume
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className={itemCls}
        onClick={() => run(() => startBtw(id))}
      >
        <MessageSquareText size={14} aria-hidden="true" /> Ask superagent (BTW)
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemCls}
        onClick={() => run(() => guardedArchive(id, !session.archived))}
      >
        {session.archived ? (
          <ArchiveRestore size={14} aria-hidden="true" />
        ) : (
          <Archive size={14} aria-hidden="true" />
        )}
        {session.archived ? 'Unarchive' : 'Archive'}
      </button>
      {canClose && (
        <button
          type="button"
          role="menuitem"
          className={`${itemCls} text-destructive hover:bg-destructive/10 hover:text-destructive`}
          onClick={() => run(() => guardedKill(id))}
        >
          <X size={14} aria-hidden="true" /> Close
        </button>
      )}
    </div>,
    document.body,
  )
}
