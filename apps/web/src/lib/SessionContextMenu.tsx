import { shallowEqual } from '@podium/client-core/store'
import { reposToViews } from '@podium/client-core/viewmodels'
import {
  handoffAvailability,
  isSnoozed,
  type MachineId,
  type SessionMeta,
  snoozeUntil1h,
  snoozeUntilTomorrow5am,
} from '@podium/model/browser'
import {
  AlarmClock,
  AlarmClockOff,
  ArchiveRestore,
  ArrowRightLeft,
  ChevronRight,
  Mail,
  MailOpen,
  MessageSquareText,
  Moon,
  Pencil,
  Play,
  Square,
  Trash2,
} from 'lucide-react'
import { type JSX, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { useReplicaIssues, useStoreSelector } from '@/app/store'
import { useSessionGuard } from '@/lib/hooks/use-session-guard'
import { useFeature } from '@/lib/use-feature'
import {
  MENU_EMPTY,
  MENU_HEADER,
  MENU_HEADER_REF,
  MENU_HINT,
  MENU_ITEM,
  MENU_ITEM_DESTRUCTIVE,
  MENU_ITEM_DISABLED,
  MENU_PANEL,
  MENU_RULE,
  MENU_SECTION,
  MENU_SUBTEXT,
} from './menu-surface'
import { useNow } from './useNow'
import { sessionDisplayName } from './WorkerLabel'
import {
  type ContextMenuAnchor,
  handoffBlockerText,
  handoffRejectionText,
  sessionMenuEligibility,
} from './session-context-menu'

/**
 * Right-click context menu for a session — the same actions the panel/agent
 * toolbars expose (rename, pin, snooze, hibernate, resume, BTW, end, delete),
 * gathered in one place so they're reachable without hunting hover targets. Used
 * by the sidebar panel rows and the FLIGHT DECK, which is where sessions live;
 * POD-710 took it off the tab, because a tab is a view and a menu that can kill
 * an agent from one is exactly the tab/session conflation that work undoes. The
 * tab's own menu instead offers "Reveal in flight deck" (POD-1077), so the
 * boundary costs reach rather than access.
 * Cursor-anchored portal
 * (matches SnoozeControl's pattern), clamped into the viewport, dismissed on
 * outside-click / Escape / scroll.
 */
export function SessionContextMenu({
  session,
  anchor,
  onClose,
  onRename,
}: {
  session: SessionMeta
  anchor: ContextMenuAnchor
  onClose: () => void
  /** Enter inline rename mode in the host (sidebar row / tab). */
  onRename: () => void
}): JSX.Element {
  const {
    setSnooze,
    clearSnooze,
    hibernateSession,
    resurrectSession,
    startBtw,
    markSessionRead,
    markSessionUnread,
    trpc,
    repos,
    machines,
  } = useStoreSelector(
    (s) => ({
      setSnooze: s.setSnooze,
      clearSnooze: s.clearSnooze,
      hibernateSession: s.hibernateSession,
      resurrectSession: s.resurrectSession,
      startBtw: s.startBtw,
      markSessionRead: s.markSessionRead,
      markSessionUnread: s.markSessionUnread,
      trpc: s.trpc,
      repos: s.repos,
      machines: s.machines,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const { guardedDelete, guardedEnd, guardedArchive } = useSessionGuard()
  const handoffEnabled = useFeature('session-handoff')
  const now = useNow(60_000)
  // The attached issue is part of the handoff gate: a session whose cwd drifted
  // onto the main checkout is still eligible via the issue's worktree (SP-3f7a).
  const issue = issues.find((i) => i.id === session.issueId)
  const { blocker, candidates } = handoffAvailability(session, reposToViews(repos), machines, issue)
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<ContextMenuAnchor>(anchor)
  const [handoffTop, setHandoffTop] = useState<number | null>(null)

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
  const { canHibernate, canResume, canEnd, canDelete, canMarkRead, canMarkUnread } =
    sessionMenuEligibility(session)

  const run = (fn: () => void | Promise<void>): void => {
    void fn()
    onClose()
  }

  // The session's own pane narrates the move (HandoverPane), so this toast is for
  // the operator who is looking somewhere else: it names WHICH session landed
  // WHERE, and a failure names the target it never reached (the server rolls the
  // session back to where it was).
  const handoff = (machineId: MachineId, machineName: string): void => {
    onClose()
    void trpc.sessions.handoff.mutate({ sessionId: id, machineId }).then(
      () => toast.success(`${sessionDisplayName(session)} resumed on ${machineName}`),
      (error: unknown) =>
        toast.error(
          `Handover to ${machineName} failed — ${error instanceof Error ? error.message : String(error)}`,
        ),
    )
  }

  const itemCls = MENU_ITEM

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Session actions"
      className={`fixed z-[60] min-w-[196px] ${MENU_PANEL}`}
      style={{ left: pos.x, top: pos.y }}
      // The host opens this on contextmenu; suppress a nested browser menu.
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Same header the issue menu and the colour picker wear (POD-380): the
          two sidebar menus open one pixel apart and must read as one family. */}
      <div className={`${MENU_HEADER} px-[5px]`}>
        <span>AGENT</span>
        <span className={`${MENU_HEADER_REF} min-w-0 truncate normal-case`}>
          {sessionDisplayName(session)}
        </span>
      </div>
      <button
        data-pressable
        type="button"
        role="menuitem"
        className={itemCls}
        onClick={() => run(onRename)}
      >
        <Pencil size={14} aria-hidden="true" /> Rename
      </button>
      {/* Email-style read toggle (#138): mark a read session unread (or an unread
          one read) — mutually exclusive. Store actions are optimistic. */}
      {canMarkUnread && (
        <button
          data-pressable
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
          data-pressable
          type="button"
          role="menuitem"
          className={itemCls}
          onClick={() => run(() => markSessionRead(id))}
        >
          <MailOpen size={14} aria-hidden="true" /> Mark as read
        </button>
      )}

      <div className={MENU_SECTION}>SNOOZE</div>
      {snoozed ? (
        <button
          data-pressable
          type="button"
          role="menuitem"
          className={itemCls}
          onClick={() => run(() => clearSnooze(id))}
        >
          <AlarmClockOff size={14} aria-hidden="true" /> Un-snooze
        </button>
      ) : (
        <>
          <button
            data-pressable
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => run(() => setSnooze(id, snoozeUntil1h(Date.now())))}
          >
            <AlarmClock size={14} aria-hidden="true" /> For 1 hour
          </button>
          <button
            data-pressable
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => run(() => setSnooze(id, snoozeUntilTomorrow5am(Date.now())))}
          >
            <AlarmClock size={14} aria-hidden="true" /> Until tomorrow
          </button>
          <button
            data-pressable
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => run(() => setSnooze(id, null))}
          >
            <AlarmClock size={14} aria-hidden="true" /> Until next message
          </button>
        </>
      )}

      <div className={MENU_SECTION}>MANAGE</div>
      {canHibernate && (
        <button
          data-pressable
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
          data-pressable
          type="button"
          role="menuitem"
          className={itemCls}
          onClick={() =>
            run(async () => {
              await resurrectSession(id)
            })
          }
        >
          <Play size={14} aria-hidden="true" /> Resume
        </button>
      )}
      {/* When enabled, a blocker disables handoff and says why inline; otherwise
          the submenu names every other repo machine (POD-821). */}
      {handoffEnabled &&
        (blocker ? (
          <button
            data-pressable
            type="button"
            role="menuitem"
            disabled
            className={`${MENU_ITEM_DISABLED} flex-col items-stretch gap-0.5`}
          >
            <span className="flex items-center gap-2">
              <ArrowRightLeft size={14} aria-hidden="true" /> Handoff
            </span>
            <span className={MENU_SUBTEXT}>{handoffBlockerText(blocker, session.agentKind)}</span>
          </button>
        ) : (
          <button
            data-pressable
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={handoffTop !== null}
            className={itemCls}
            onMouseEnter={(event) => setHandoffTop(event.currentTarget.offsetTop)}
            onClick={(event) => setHandoffTop(event.currentTarget.offsetTop)}
          >
            <ArrowRightLeft size={14} aria-hidden="true" /> Handoff
            <ChevronRight size={12} aria-hidden="true" className="ml-auto text-text-dim" />
          </button>
        ))}
      <button
        data-pressable
        type="button"
        role="menuitem"
        className={itemCls}
        onClick={() => run(() => startBtw(id))}
      >
        <MessageSquareText size={14} aria-hidden="true" /> Ask superagent (BTW)
      </button>
      {/* ARCHIVE IS GONE FROM THIS MENU (POD-1077), and only its escape hatch
          remains. Archiving a session was never filing — POD-108 made it park
          the process — so it was a third spelling of "stop the agent" sitting
          between Hibernate and Close, and the one that said least about what it
          did. The gesture itself is not lost: archiving the ISSUE cascades to
          every member session (#133), and the SP-6144 sweep archives stopped,
          read sessions on its own. What a menu must never do is strand a state,
          so an already-archived session still offers the way back. */}
      {session.archived && (
        <button
          data-pressable
          type="button"
          role="menuitem"
          className={itemCls}
          onClick={() => run(() => guardedArchive(id, false))}
        >
          <ArchiveRestore size={14} aria-hidden="true" /> Unarchive
        </button>
      )}
      {/* The two ways out, under a rule and named by what survives. Everything
          above this line is reversible; nothing below it is fully. */}
      {(canEnd || canDelete) && <hr className={MENU_RULE} />}
      {canEnd && (
        <button
          data-pressable
          type="button"
          role="menuitem"
          className={itemCls}
          onClick={() => run(() => guardedEnd(id))}
        >
          <Square size={14} aria-hidden="true" /> End session
          <span className={MENU_HINT}>frees worktree</span>
        </button>
      )}
      {canDelete && (
        <button
          data-pressable
          type="button"
          role="menuitem"
          className={MENU_ITEM_DESTRUCTIVE}
          onClick={() => run(() => guardedDelete(id))}
        >
          <Trash2 size={14} aria-hidden="true" /> Delete session…
        </button>
      )}
      {handoffEnabled && handoffTop !== null && (
        <div
          role="menu"
          aria-label="Handoff targets"
          className={`absolute left-full z-[61] min-w-[180px] ${MENU_PANEL}`}
          style={{
            ...(pos.x + 380 > window.innerWidth ? { left: 'auto', right: '100%' } : {}),
            top: handoffTop - 4,
          }}
        >
          {candidates.length === 0 && (
            <div className={MENU_EMPTY}>No other machine has this repo</div>
          )}
          {candidates.map(({ machine, rejection }) =>
            rejection ? (
              <button
                data-pressable
                key={machine.id}
                type="button"
                role="menuitem"
                disabled
                className={MENU_ITEM_DISABLED}
              >
                <span className="size-2 rounded-full bg-muted-foreground" aria-hidden="true" />
                {machine.name}
                <span className={MENU_HINT}>
                  {handoffRejectionText(rejection, session.agentKind)}
                </span>
              </button>
            ) : (
              <button
                data-pressable
                key={machine.id}
                type="button"
                role="menuitem"
                className={itemCls}
                onClick={() => handoff(machine.id, machine.name)}
              >
                <span className="size-2 rounded-full bg-live" aria-hidden="true" />
                {machine.name}
              </button>
            ),
          )}
        </div>
      )}
    </div>,
    document.body,
  )
}
