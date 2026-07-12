/**
 * Shared sidebar building blocks (extracted from the retired classic
 * Sidebar.tsx): the resizable aside shell, persisted collapse state, the
 * collapsible section header, the stale-sessions tuck-away, and the session
 * PanelRow used by every session list in the unified sidebar.
 */
import type { SessionMeta } from '@podium/protocol'
import { ChevronDown, ChevronRight, Pin, X } from 'lucide-react'
import type { JSX, ReactNode, PointerEvent as ReactPointerEvent } from 'react'
import { useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import {
  agentBadge,
  agentColorHex,
  isSessionWorking,
  isSnoozed,
  repoBranchForCwd,
  returnedFromSnooze,
  sessionDotClass,
} from '@/lib/derive'
import { useSessionGuard } from '@/lib/hooks/use-session-guard'
import { type ContextMenuAnchor, SessionContextMenu } from '@/lib/SessionContextMenu'
import { SnoozeControl } from '@/lib/SnoozeControl'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'
import { SessionNameEditor, sessionDisplayName, WorkerLabel } from '@/lib/WorkerLabel'

/** The one aside shell the sidebar renders into. */
export const SIDEBAR_ASIDE_CLASS =
  'flex w-full flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar text-sidebar-foreground'

const SIDEBAR_WIDTH_KEY = 'podium:sidebar:width'
const SIDEBAR_WIDTH_MIN = 200
const SIDEBAR_WIDTH_MAX = 560
const SIDEBAR_WIDTH_DEFAULT = 280

/**
 * The aside shell with a drag-to-resize right edge. The handle lives on a
 * non-scrolling wrapper (the aside itself scrolls, so an absolute child of it
 * would only cover the first viewport-height of content). Width persists via
 * the ui-state collection.
 */
export function ResizableAside({ children }: { children: ReactNode }): JSX.Element {
  const ui = useStoreSelector((s) => s.uiState)
  const [width, setWidth] = useState<number>(() => {
    const v = Number(ui.get(SIDEBAR_WIDTH_KEY))
    return Number.isFinite(v) && v >= SIDEBAR_WIDTH_MIN && v <= SIDEBAR_WIDTH_MAX
      ? v
      : SIDEBAR_WIDTH_DEFAULT
  })
  const onHandlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const handle = e.currentTarget
    const left = handle.parentElement?.getBoundingClientRect().left ?? 0
    handle.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      setWidth(
        Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(ev.clientX - left))),
      )
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      setWidth((w) => {
        ui.set(SIDEBAR_WIDTH_KEY, String(w))
        return w
      })
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up, { once: true })
    handle.addEventListener('pointercancel', up, { once: true })
  }
  return (
    <div className="relative flex flex-none" style={{ width }}>
      <aside className={SIDEBAR_ASIDE_CLASS}>{children}</aside>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        className="absolute inset-y-0 -right-0.5 z-10 w-1.5 cursor-col-resize hover:bg-primary/40 active:bg-primary/60"
        onPointerDown={onHandlePointerDown}
      />
    </div>
  )
}

/** Per-section collapse state, persisted via the ui-state collection. Absent
 *  key = the section's own default (attention/pinned open, working closed). */
export function useCollapsed(key: string, defaultCollapsed: boolean): [boolean, () => void] {
  const ui = useStoreSelector((s) => s.uiState)
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const v = ui.get(key)
    return v === null ? defaultCollapsed : v === 'true'
  })
  const toggle = () => {
    setCollapsed((c) => {
      const next = !c
      ui.set(key, next ? 'true' : 'false')
      return next
    })
  }
  return [collapsed, toggle]
}

/** A collapsible sidebar section: a chevroned uppercase header over its rows.
 *  Collapsed state persists per `storageKey`; `right` renders inline controls
 *  (e.g. the repo-sort select) that stay clickable without toggling. */
export function CollapsibleSection({
  label,
  storageKey,
  defaultCollapsed = false,
  count,
  right,
  children,
}: {
  label: string
  storageKey: string
  defaultCollapsed?: boolean
  count?: number
  right?: ReactNode
  children: ReactNode
}): JSX.Element {
  const [collapsed, toggle] = useCollapsed(storageKey, defaultCollapsed)
  return (
    <div className="min-w-0 py-1">
      <div className="flex items-center justify-between px-3 pt-2 pb-[3px]">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[10px] font-bold tracking-[0.08em] uppercase text-primary hover:text-primary/80"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label}`}
        >
          {collapsed ? (
            <ChevronRight size={11} aria-hidden="true" className="flex-none" />
          ) : (
            <ChevronDown size={11} aria-hidden="true" className="flex-none" />
          )}
          <span className="truncate">
            {label}
            {collapsed && count !== undefined && count > 0 && (
              <span className="ml-1 font-normal text-muted-foreground">· {count}</span>
            )}
          </span>
        </button>
        {right}
      </div>
      {!collapsed && children}
    </div>
  )
}

/** Collapsed "Stale" subsection at the bottom of a session group — quiet,
 *  long-inactive sessions tucked away so the active ones stay scannable. */
export function StaleSection({
  sessions,
  render,
}: {
  sessions: SessionMeta[]
  render: (session: SessionMeta) => JSX.Element
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (sessions.length === 0) return null
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-1 py-[3px] pr-3 pl-7 text-left text-[10px] font-semibold tracking-[0.08em] uppercase text-muted-foreground/60 hover:text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={11} aria-hidden="true" className="flex-none" />
        ) : (
          <ChevronRight size={11} aria-hidden="true" className="flex-none" />
        )}
        <span>
          Stale
          {!open && <span className="ml-1 font-normal lowercase">· {sessions.length}</span>}
        </span>
      </button>
      {open && sessions.map(render)}
    </div>
  )
}

function StatusDot({ session }: { session: SessionMeta }): JSX.Element {
  // Shared single source of truth — colour semantics match tabs/home/chat, and
  // the `dot`/`parked` markers drive the hibernated grayed-italic row in CSS.
  return <span className={sessionDotClass(session)} />
}

export function PanelRow({
  session,
  pinned,
  active,
  onSelect,
  onPinned,
  attention = false,
  dotRight = false,
  suppressUnread = false,
}: {
  session: SessionMeta
  pinned: boolean
  active: boolean
  onSelect: () => void
  onPinned: (pinned: boolean) => void
  /** True only for the NEEDS YOUR ATTENTION rows: shows the snooze control
   *  (rightmost, always visible) and reveals pin/close on hover. */
  attention?: boolean
  /** Unified WORK-list child rows: the status dot moves to the RIGHT edge,
   *  slightly smaller, vertically aligned under the parent row's summary dot
   *  (same pr-3 + a w-2 slot centering the smaller dot). Rows are also more
   *  indented and tighter, so the group reads as belonging to its parent. */
  dotRight?: boolean
  /** WORKING-section rows (#138): a session that's actively in progress is not
   *  "new unseen work", so its unread emphasis is suppressed even when unread. */
  suppressUnread?: boolean
}): JSX.Element {
  const continueSession = useStoreSelector((s) => s.continueSession)
  const renameSession = useStoreSelector((s) => s.renameSession)
  const { guardedKill } = useSessionGuard()
  const badge = agentBadge(session)
  const [editing, setEditing] = useState(false)
  const [menuAnchor, setMenuAnchor] = useState<ContextMenuAnchor | null>(null)
  // Snooze control shows: on attention rows always (to snooze); elsewhere ONLY
  // when already snoozed — so worktree/pinned rows surface an un-snooze affordance
  // for a snoozed session, but never a plain "snooze" icon.
  const now = useNow(60_000)
  const snoozed = isSnoozed(session, now)
  // A timed snooze that has lapsed but isn't cleared yet → the session just came
  // back into the queue; mark it (compareRecency already lifts it by its deadline).
  const backFromSnooze = returnedFromSnooze(session, now)
  return (
    // Constant row height (matches the icon-sm controls) so revealing pin/close on
    // hover never grows the row — otherwise every row below jumps down.
    <div className={cn('group flex min-w-0 items-center gap-1', dotRight ? 'min-h-6' : 'min-h-7')}>
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 py-[3px] pr-3 pl-7">
          <StatusDot session={session} />
          <SessionNameEditor
            value={sessionDisplayName(session)}
            onCommit={(name) => {
              void renameSession(session.sessionId, name)
              setEditing(false)
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-[3px] pr-3 text-left text-xs',
            dotRight ? 'pl-10' : 'pl-7',
            // Selection is the accent background ALONE — never a heavier font
            // (#170), so it can't be confused with UNREAD's weight signal.
            active
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            // Email-style unread emphasis (#126): an unread session reads at
            // medium weight, lifting it out of the muted baseline — INDEPENDENT of
            // selection, so a selected+unread row is still bold (on accent). Marking
            // it read on open clears this optimistically. Suppressed (#138) for
            // WORKING-section rows AND for any currently-working session anywhere —
            // active work isn't "unseen", and a working session re-flips unread on
            // every output, so emphasis would flicker back constantly. Also suppressed
            // for a snoozed session — deliberately set aside, not "unseen work". On a
            // selected row the accent-foreground colour already wins; only add
            // text-foreground when unselected.
            session.unread &&
              !suppressUnread &&
              !isSessionWorking(session) &&
              !snoozed &&
              (active ? 'font-medium' : 'font-medium text-foreground'),
          )}
          onClick={onSelect}
          // Double-click the row to rename — matches the tab strip.
          onDoubleClick={() => setEditing(true)}
          // Right-click for the full action menu (rename + every toolbar action).
          onContextMenu={(e) => {
            e.preventDefault()
            setMenuAnchor({ x: e.clientX, y: e.clientY })
          }}
        >
          {!dotRight && <StatusDot session={session} />} <WorkerLabel session={session} />
          {/* Unsent composer draft → DRAFT tag (shown wherever a session is listed,
              not just NEEDS YOUR ATTENTION). The session is also lifted by its
              draft-edit time via compareRecency. */}
          {session.draftUpdatedAt && (
            <span
              className="flex-none rounded border border-input px-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground"
              title="Unsent draft"
            >
              Draft
            </span>
          )}
          {backFromSnooze && (
            <span
              className="flex-none rounded border border-amber-500/40 px-1 text-[9px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400"
              title="Snooze ended — back in your queue"
            >
              Unsnoozed
            </span>
          )}
          {/* The agent's /color identity accent — a short vertical line right of
              the name (distinct from the status dot, which is its state). */}
          {agentColorHex(session.agentColor) && (
            <span
              className="ml-0.5 h-3 w-[2px] flex-none rounded-full"
              style={{ background: agentColorHex(session.agentColor) }}
              aria-hidden="true"
            />
          )}
          {/* Pinned panels span repos/worktrees, so show which one — compact two
              lines (repo bold, branch below) where the kind label used to sit. */}
          {pinned && <RepoBranchTag cwd={session.cwd} />}
          {dotRight && (
            <span className="ml-auto flex w-2 flex-none justify-center">
              <span className={cn(sessionDotClass(session), 'size-1.5 min-w-1.5')} />
            </span>
          )}
        </button>
      )}
      {badge?.showContinue && (
        <Button
          variant="destructive"
          size="sm"
          className="h-auto border border-destructive/50 bg-transparent px-2 py-px text-[11px] font-normal hover:bg-destructive/10"
          title="Send 'continue' to the errored agent"
          onClick={() => void continueSession(session.sessionId)}
        >
          Continue
        </Button>
      )}
      {/* Pin: lit when pinned, otherwise hidden until row hover (so on attention
          rows it never competes with the always-on, rightmost snooze control). */}
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn(
          'w-7 min-w-7 flex-none rounded-none',
          // Unpinned: hidden (label keeps full width) until row hover; pinned: lit.
          pinned
            ? 'text-primary'
            : 'hidden text-muted-foreground/70 hover:text-foreground group-hover:inline-flex',
        )}
        aria-pressed={pinned}
        title={pinned ? 'Unpin panel' : 'Pin panel'}
        onClick={() => onPinned(!pinned)}
      >
        <Pin size={13} aria-hidden="true" />
      </Button>
      {/* Close (kill) — revealed on row hover, matching the tab strip's X. */}
      <Button
        variant="ghost"
        size="icon-sm"
        className="hidden w-7 min-w-7 flex-none rounded-none text-muted-foreground/70 hover:text-destructive group-hover:inline-flex"
        title="Close session"
        onClick={() => void guardedKill(session.sessionId)}
      >
        <X size={13} aria-hidden="true" />
      </Button>
      {/* Rightmost + always visible (never shifts when pin/close reveal on hover).
          On attention rows: the snooze control. Elsewhere (worktree/pinned/working):
          only when snoozed, so it reads as an un-snooze affordance — never a plain
          "snooze" icon outside NEEDS YOUR ATTENTION. */}
      {(attention || snoozed) && <SnoozeControl session={session} />}
      {menuAnchor && (
        <SessionContextMenu
          session={session}
          pinned={pinned}
          anchor={menuAnchor}
          onClose={() => setMenuAnchor(null)}
          onRename={() => {
            setMenuAnchor(null)
            setEditing(true)
          }}
        />
      )}
    </div>
  )
}

/** Compact repo/branch stamp for a pinned panel: repo bold on top, branch muted
 *  below. Full "repo · branch" on the hover title. */
function RepoBranchTag({ cwd }: { cwd: string }): JSX.Element | null {
  const repos = useStoreSelector((s) => s.repos)
  const rb = repoBranchForCwd(repos, cwd)
  if (!rb) return null
  return (
    <span
      className="ml-auto flex flex-none flex-col items-end pl-2 leading-tight"
      title={rb.branch ? `${rb.repo} · ${rb.branch}` : rb.repo}
    >
      <span className="max-w-[12ch] overflow-hidden text-ellipsis whitespace-nowrap text-[10px] font-bold text-foreground/80">
        {rb.repo}
      </span>
      {rb.branch && (
        <span className="max-w-[12ch] overflow-hidden text-ellipsis whitespace-nowrap text-[9px] text-muted-foreground/70">
          {rb.branch}
        </span>
      )}
    </span>
  )
}
