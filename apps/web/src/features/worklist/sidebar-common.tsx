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

/** The one aside shell the sidebar renders into. The aside itself never scrolls —
 *  only the work list inside it — so the footer stays pinned. */
export const SIDEBAR_ASIDE_CLASS =
  'flex w-full min-h-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground'

const SIDEBAR_WIDTH_KEY = 'podium:sidebar:width'
const SIDEBAR_WIDTH_MIN = 238
const SIDEBAR_WIDTH_MAX = 340
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
      <div className="flex items-center justify-between px-2 pt-2.5 pb-[5px]">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[10.5px] font-semibold tracking-[0.09em] uppercase text-[#7a7a86] hover:text-[#9a9aa8]"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label}`}
        >
          {collapsed ? (
            <ChevronRight size={11} aria-hidden="true" className="flex-none text-[#6c6c78]" />
          ) : (
            <ChevronDown size={11} aria-hidden="true" className="flex-none text-[#6c6c78]" />
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
  const hibernated = session.status === 'hibernated'
  // Amber status word right of the name (mock's "needs review"/"paused" meta):
  // attention states show their badge label; a parked session reads "paused".
  const meta = hibernated ? 'paused' : badge?.tone === 'attention' ? badge.label : null
  return (
    // One rounded row: [agent chip][name][meta][dot]. Pin/close reveal as an
    // overlay cluster on hover so the row's layout never shifts.
    <div
      className={cn(
        'group relative flex min-w-0 items-center rounded-md transition-colors',
        dotRight ? 'min-h-7' : 'min-h-8',
        active ? 'bg-[#232330]' : 'hover:bg-[#20202a]',
      )}
    >
      {editing ? (
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 py-[3px] pr-2',
            dotRight ? 'pl-[30px]' : 'pl-2',
          )}
        >
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
            'flex min-w-0 flex-1 cursor-pointer items-center text-left',
            dotRight
              ? 'gap-2 py-[5px] pr-2 pl-[30px] text-[12.5px]'
              : 'gap-2 py-1.5 pr-2 pl-2 text-[13.5px]',
            // Selection is the accent background ALONE — never a heavier font
            // (#170), so it can't be confused with UNREAD's weight signal.
            active ? 'text-[#f3f3f8]' : 'text-muted-foreground hover:text-foreground',
            !dotRight && !active && 'text-[#dcdce4]',
            // Email-style unread emphasis (#126): an unread session reads at
            // medium weight, lifting it out of the muted baseline — INDEPENDENT of
            // selection, so a selected+unread row is still bold (on accent).
            // Suppressed (#138) for WORKING-section rows AND for any currently-
            // working session anywhere; also for a snoozed session.
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
          <span className={cn('flex min-w-0 flex-1', hibernated && 'italic opacity-60')}>
            <WorkerLabel session={session} chip />
          </span>
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
          {meta && (
            <span className="rowmeta flex-none text-[10px] text-[#d4a017] opacity-80 transition-opacity group-hover:opacity-100">
              {meta}
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
          <span className="flex w-2 flex-none justify-center">
            <span className={cn(sessionDotClass(session), 'size-[7px] min-w-[7px]')} />
          </span>
        </button>
      )}
      {badge?.showContinue && (
        <Button
          variant="destructive"
          size="sm"
          className="mr-1 h-auto flex-none border border-destructive/50 bg-transparent px-1.5 py-px text-[10px] font-normal hover:bg-destructive/10"
          title="Send 'continue' to the errored agent"
          onClick={() => void continueSession(session.sessionId)}
        >
          Continue
        </Button>
      )}
      {/* Hover overlay: pin + close, floated over the row's right edge (before the
          dot) so revealing them never reflows the row. Pinned stays lit inline. */}
      <div
        className={cn(
          'absolute top-1/2 right-5 hidden -translate-y-1/2 items-center gap-0 rounded-md group-hover:flex',
          active ? 'bg-[#232330]' : 'bg-[#20202a]',
        )}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            'size-6 flex-none',
            pinned ? 'text-primary' : 'text-muted-foreground/70 hover:text-foreground',
          )}
          aria-pressed={pinned}
          title={pinned ? 'Unpin panel' : 'Pin panel'}
          onClick={() => onPinned(!pinned)}
        >
          <Pin size={12} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 flex-none text-muted-foreground/70 hover:text-destructive"
          title="Close session"
          onClick={() => void guardedKill(session.sessionId)}
        >
          <X size={12} aria-hidden="true" />
        </Button>
      </div>
      {/* Pinned indicator stays visible without hover. */}
      {pinned && (
        <Pin
          size={11}
          aria-hidden="true"
          className="absolute top-1/2 right-5 -translate-y-1/2 text-primary group-hover:hidden"
        />
      )}
      {/* Rightmost + always visible. On attention rows: the snooze control.
          Elsewhere only when snoozed (an un-snooze affordance). */}
      {(attention || snoozed) && <SnoozeControl session={session} className="flex-none" />}
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
