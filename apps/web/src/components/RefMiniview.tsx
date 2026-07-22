import { shallowEqual } from '@podium/client-core/store'
import { formatLong, truncateTitle } from '@podium/protocol'
import { Copy, ExternalLink, GripVertical, PanelRight, Play, User, X } from 'lucide-react'
import {
  type JSX,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import { useStoreSelector } from '@/app/store'
import { StageChip } from '@/features/issues/IssuePanelView'
import { copyToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/home'
import { isIssueStartable } from '@/features/issues/issue-startable'
import { setKnownRefPrefixes } from '@/lib/markdown'
import {
  closeMiniview,
  getMiniviewState,
  openMiniview,
  REF_PREFIXES_CHANGED_EVENT,
  setRefActivator,
  subscribeMiniview,
} from '@/lib/ref-activation'
import {
  collectRefPrefixes,
  type RefIssueLike,
  type RefSessionLike,
  type ResolvedRef,
  resolveRef,
  sessionWorkingIssueRef,
} from '@/lib/ref-miniview'

/**
 * Root-mounted host for the single floating ref miniview (#474, area 7). Owns:
 *  - the activator registration (plain click → miniview, Cmd/Ctrl → full view);
 *  - reading the external miniview store and resolving the open ref;
 *  - rendering the draggable <RefCard> when a ref is open and resolvable.
 */
export function RefMiniviewHost(): JSX.Element | null {
  const { trpc, issues, sessions, setOpenIssueId, setView, setPeekIssueId, navigateToSession } =
    useStoreSelector(
      (s) => ({
        trpc: s.trpc,
        issues: s.issues,
        sessions: s.sessions,
        setOpenIssueId: s.setOpenIssueId,
        setView: s.setView,
        setPeekIssueId: s.setPeekIssueId,
        navigateToSession: s.navigateToSession,
      }),
      shallowEqual,
    )

  const openIssueFull = (issueId: string): void => {
    setOpenIssueId(issueId)
    setView('issues')
  }
  // Register the activator: plain click opens the miniview; Cmd/Ctrl-click jumps
  // straight to the full view. Kept fresh so it always sees the latest store data.
  useEffect(() => {
    setRefActivator((ref, mods, anchor) => {
      if (!mods.direct) {
        openMiniview(ref, anchor)
        return
      }
      const target = resolveRef(ref, issues, sessions)
      if (!target) {
        openMiniview(ref, anchor) // nothing to navigate to — fall back to the card (shows "not found")
        return
      }
      if (target.kind === 'issue') openIssueFull(target.issue.id)
      else navigateToSession(ref)
    })
    return () => setRefActivator(null)
  })

  const state = useSyncExternalStore(subscribeMiniview, getMiniviewState, getMiniviewState)
  if (!state) return null

  const target = resolveRef(state.ref, issues, sessions)

  return createPortal(
    <RefCard
      key={state.seq} // re-seed the position on every activation, even same-ref
      refToken={state.ref}
      anchor={state.anchor}
      target={target}
      issues={issues}
      onClose={closeMiniview}
      onOpenFull={() => {
        if (!target) return
        closeMiniview()
        // One rung up the ladder (POD-95): an issue escalates to the PEEK
        // DRAWER over the right edge — the chat stays put; the full /issues/:id
        // page remains one more step away (drawer header's "Open full page", or
        // Cmd/Ctrl-click on the chip). Sessions have no peek surface and still
        // navigate.
        if (target.kind === 'issue') setPeekIssueId(target.issue.id)
        else navigateToSession(state.ref)
      }}
      onStart={(issueId) => trpc.issues.start.mutate({ id: issueId })}
    />,
    document.body,
  )
}

const CARD_WIDTH = 400
const VIEWPORT_MARGIN = 12

/** Seed the card near the activating click: slightly below-left, clamped into
 *  the viewport. Without an anchor (keyboard/synthetic activation) fall back to
 *  the old top-right seed. Exported for tests. */
export function seedCardPosition(
  anchor: { x: number; y: number } | undefined,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  if (!anchor) return { x: Math.max(16, viewport.width - CARD_WIDTH - 20), y: 88 }
  return {
    x: Math.min(
      Math.max(VIEWPORT_MARGIN, anchor.x - 24),
      viewport.width - CARD_WIDTH - VIEWPORT_MARGIN,
    ),
    y: Math.min(Math.max(VIEWPORT_MARGIN, anchor.y + 14), viewport.height - 120),
  }
}

/** The draggable, fixed-position miniview card. Drag by its header. Exported for tests. */
export function RefCard({
  refToken,
  anchor,
  target,
  issues,
  onClose,
  onOpenFull,
  onStart,
}: {
  refToken: string
  anchor?: { x: number; y: number }
  target: ResolvedRef | null
  issues: readonly RefIssueLike[]
  onClose: () => void
  onOpenFull: () => void
  /** Start an agent on the issue (POD-110) — `trpc.issues.start` in the host. */
  onStart?: (issueId: string) => Promise<unknown>
}): JSX.Element {
  // Fixed position, dragged by the header. Seeded next to the activating click
  // (falling back to top-right when there is none); the user drags it wherever.
  // Kept in state so a re-resolve (issues update) doesn't reset it.
  const [pos, setPos] = useState<{ x: number; y: number }>(() =>
    seedCardPosition(anchor, { width: window.innerWidth, height: window.innerHeight }),
  )
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  const cardEl = useRef<HTMLDivElement | null>(null)

  // The seed only estimates the card's height; once real, nudge it fully into
  // view — and if that would cover an anchored link, flip above the click instead.
  // Mount-only by design (the card is keyed per activation): later height changes
  // (issue updates) shouldn't yank a card the user may have dragged.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only reposition; see above.
  useLayoutEffect(() => {
    const el = cardEl.current
    if (!el) return
    const h = el.offsetHeight
    setPos((p) => {
      const maxY = window.innerHeight - h - VIEWPORT_MARGIN
      if (p.y <= maxY) return p
      const flipY = anchor ? anchor.y - h - 10 : maxY
      return { ...p, y: Math.max(VIEWPORT_MARGIN, Math.min(maxY, anchor ? flipY : maxY)) }
    })
  }, [])
  const targetTitle =
    target?.kind === 'issue'
      ? target.issue.title
      : target?.kind === 'session'
        ? target.session.name || target.session.title || ''
        : ''

  // Escape closes — but never at the expense of surfaces with their own Escape
  // semantics: keys headed into a terminal or another open dialog pass through
  // untouched, and we never stopPropagation/preventDefault (the card is a
  // side-panel, not a modal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const t = e.target instanceof Element ? e.target : null
      if (t?.closest('.xterm')) return // terminal owns its Escape
      const dialog = t?.closest('[role=dialog],[role=alertdialog]')
      if (dialog && dialog !== cardEl.current) return // an open dialog is on top
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // Light-dismiss: a pointerdown anywhere outside the card closes it. Safe from
  // the activating click because activation happens on `click` — that click's
  // pointerdown fired before this card mounted. Clicking another ref link still
  // works: the pointerdown closes this card, then the click opens the next one.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      const el = cardEl.current
      if (!el) return
      if (e.target instanceof Node && el.contains(e.target)) return
      onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [onClose])

  // Drag handlers, shared by whichever region acts as the handle (the compact
  // session header bar, or the issue card's head). Pointer events + capture:
  // one code path for mouse and touch, and move/up keep arriving even when the
  // pointer leaves the handle mid-drag.
  const dragHandlers = {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.target instanceof Element && e.target.closest('button')) return
      drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!drag.current) return
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.current.dx)),
        y: Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.current.dy)),
      })
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
      drag.current = null
      e.currentTarget.releasePointerCapture(e.pointerId)
    },
    onPointerCancel: () => {
      drag.current = null
    },
  }

  const closeButton = (
    <button
      type="button"
      className="flex size-6 flex-none items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      title="Close"
      aria-label="Close"
      onClick={onClose}
    >
      <X size={13} aria-hidden="true" />
    </button>
  )

  return (
    <div
      ref={cardEl}
      className="fixed z-40 w-[min(400px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={`Reference ${refToken}`}
    >
      {target?.kind === 'issue' ? (
        <>
          {/* The head IS the drag handle: identity + stage, then title + the
              one primary action, then the quiet meta line. */}
          <div
            className="cursor-grab touch-none px-4 pt-3.5 pb-3.5 active:cursor-grabbing"
            {...dragHandlers}
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <button
                type="button"
                className="cursor-pointer font-mono text-[11px] font-semibold tracking-[0.04em] text-muted-foreground hover:text-foreground"
                title={`Copy "${refToken}"`}
                onClick={() => copyToClipboard(refToken, `Copied ${refToken}`)}
              >
                {refToken}
              </button>
              <span className="flex flex-none items-center gap-1.5">
                {target.issue.stage && <StageChip stage={target.issue.stage} />}
                {closeButton}
              </span>
            </div>
            <IssueSummary issue={target.issue} issues={issues} onStart={onStart} />
            {target.issue.description?.trim() && (
              <div
                className="mt-2 overflow-hidden text-[12px] leading-[1.5] text-muted-foreground"
                style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}
                title={target.issue.description}
              >
                {target.issue.description}
              </div>
            )}
          </div>
          {target.issue.activityNotes && (
            <div className="mx-3 mb-3 rounded-[10px] border border-border/60 bg-muted/40 px-3.5 py-3">
              <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[10px]">
                <span className="font-semibold tracking-[0.09em] text-muted-foreground/70 uppercase">
                  Latest update
                </span>
                {target.issue.notesUpdatedAt && (
                  <span className="flex-none text-muted-foreground/60">
                    {relativeTime(target.issue.notesUpdatedAt, Date.now())}
                  </span>
                )}
              </div>
              <div
                className="overflow-hidden text-[12.5px] leading-[1.5] text-foreground/90"
                style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}
                title={target.issue.activityNotes}
              >
                {target.issue.activityNotes}
              </div>
            </div>
          )}
          <IssueDetailsStrip issue={target.issue} />
          {/* Footer: the two ways out. Escalation stays one rung (POD-95) —
              "Open full page" raises the peek drawer, not the /issues route. */}
          <div className="flex items-center gap-2 p-3">
            <button
              type="button"
              className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-muted/40 text-[12px] font-medium text-foreground/85 hover:bg-accent hover:text-foreground"
              onClick={onOpenFull}
            >
              Open full page
              <PanelRight size={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 text-[12px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => copyToClipboard(refToken, `Copied ${refToken}`)}
            >
              <Copy size={11} aria-hidden="true" />
              Copy ref
            </button>
          </div>
        </>
      ) : (
        <>
          {/* Session / unresolved: compact drag bar with the canonical long form
              (#474 spec §display) — `POD-13-A · title` truncated, full on hover. */}
          <div
            className="flex cursor-grab touch-none items-center gap-1.5 border-b border-border/60 bg-muted/40 px-2 py-1.5 active:cursor-grabbing"
            {...dragHandlers}
          >
            <GripVertical
              size={13}
              className="flex-none text-muted-foreground/60"
              aria-hidden="true"
            />
            <span
              className="flex-1 truncate font-mono text-[12px] font-medium"
              title={targetTitle ? `${refToken} · ${targetTitle}` : refToken}
            >
              {targetTitle ? formatLong(refToken, targetTitle) : refToken}
            </span>
            {target && (
              <button
                type="button"
                className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Open full view"
                aria-label="Open full view"
                onClick={onOpenFull}
              >
                <ExternalLink size={13} aria-hidden="true" />
              </button>
            )}
            {closeButton}
          </div>
          <div className="px-3 py-2.5 text-[13px]">
            {!target ? (
              <p className="text-muted-foreground">Reference not found.</p>
            ) : (
              <SessionSummary session={target.session} issues={issues} />
            )}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Keep the markdown + terminal ref linkifiers' known-prefix set in sync (#474,
 * task 1). The canonical source is `repos.listDetailed` — a registered repo with
 * zero issues must still linkify — unioned with the prefixes visible on the live
 * issues list (cheap, and covers the window before the fetch lands). Refetches
 * when the store's repo list changes and on REF_PREFIXES_CHANGED_EVENT (the
 * settings prefix editor). Mounted once at app root; renders nothing.
 * Linkification is inert until this runs (an empty prefix set disables it).
 */
export function RefPrefixSync(): null {
  const { trpc, issuePrefixKey, repoKey } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      issuePrefixKey: [...collectRefPrefixes(s.issues)].sort().join(','),
      // Registered repos changing (add/remove) means the prefix set may have too.
      repoKey: s.repos
        .map((r) => r.path)
        .sort()
        .join('\n'),
    }),
    shallowEqual,
  )
  const [repoPrefixes, setRepoPrefixes] = useState<string[]>([])

  // biome-ignore lint/correctness/useExhaustiveDependencies: repoKey is a deliberate refetch trigger — repos changing means the prefix set may have too.
  useEffect(() => {
    let cancelled = false
    const fetchPrefixes = (): void => {
      trpc.repos.listDetailed
        .query()
        .then((rows) => {
          if (!cancelled) setRepoPrefixes([...collectRefPrefixes(rows)].sort())
        })
        .catch(() => {}) // best-effort; issue-derived prefixes still apply
    }
    fetchPrefixes()
    window.addEventListener(REF_PREFIXES_CHANGED_EVENT, fetchPrefixes)
    return () => {
      cancelled = true
      window.removeEventListener(REF_PREFIXES_CHANGED_EVENT, fetchPrefixes)
    }
  }, [trpc, repoKey])

  useEffect(() => {
    const issuePrefixes = issuePrefixKey ? issuePrefixKey.split(',') : []
    setKnownRefPrefixes(new Set([...repoPrefixes, ...issuePrefixes]))
  }, [issuePrefixKey, repoPrefixes])
  return null
}

/**
 * One-click agent start from the preview card (POD-110). Rendered only while
 * the issue is startable; once the start lands the store's worktreePath update
 * unmounts it, so local state only has to cover the in-flight window. Errors
 * render inline — the card has no toast surface.
 */
function RunNowAction({
  issueId,
  onStart,
}: {
  issueId: string
  onStart: (issueId: string) => Promise<unknown>
}): JSX.Element {
  const [state, setState] = useState<
    { kind: 'idle' | 'busy' | 'started' } | { kind: 'error'; message: string }
  >({ kind: 'idle' })
  const busy = state.kind === 'busy' || state.kind === 'started'
  return (
    <div className="flex flex-none flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-60"
        onClick={() => {
          setState({ kind: 'busy' })
          onStart(issueId).then(
            () => setState({ kind: 'started' }),
            (e: unknown) =>
              setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) }),
          )
        }}
      >
        <Play size={12} aria-hidden="true" />
        {state.kind === 'busy' ? 'Starting…' : state.kind === 'started' ? 'Started' : 'Run now'}
      </button>
      {state.kind === 'error' && (
        <span className="max-w-44 text-right text-[10.5px] leading-snug text-red-400">
          {state.message}
        </span>
      )}
    </div>
  )
}

/** Title row + one primary action + the quiet meta line — the head's lower half
 *  (identity + stage render above it, in the card head). "Ready" is intentionally
 *  absent: normal availability is silent, blockers appear only when actionable
 *  (plain dot, no icon). Every enrichment degrades to nothing when absent. */
function IssueSummary({
  issue,
  issues,
  onStart,
}: {
  issue: RefIssueLike
  issues: readonly RefIssueLike[]
  onStart?: (issueId: string) => Promise<unknown>
}): JSX.Element {
  // Parent chip only when the parent is resolvable to a displayRef.
  const parentRef = issue.parentId
    ? issues.find((i) => i.id === issue.parentId)?.displayRef
    : undefined
  const meta: JSX.Element[] = []
  if (issue.priority !== undefined)
    meta.push(
      <span key="p" className="font-mono font-semibold text-foreground/85">
        P{issue.priority}
      </span>,
    )
  if (issue.assignee)
    meta.push(
      <span key="a" className="inline-flex min-w-0 items-center gap-1">
        <User size={11} className="flex-none" aria-hidden="true" />
        <span className="truncate">{issue.assignee}</span>
      </span>,
    )
  if (parentRef)
    meta.push(
      <span key="in" className="font-mono">
        in {parentRef}
      </span>,
    )
  if (issue.blocked)
    meta.push(
      <span key="b" className="inline-flex items-center gap-1.5 text-red-400">
        <span className="size-1.5 flex-none rounded-full bg-red-400" aria-hidden="true" />
        blocked{issue.blockedBy?.length ? ` (${issue.blockedBy.length})` : null}
      </span>,
    )
  return (
    <>
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1 text-[15px] leading-[1.32] font-semibold tracking-[-0.01em] text-foreground">
          {truncateTitle(issue.title, 120)}
        </div>
        {onStart && isIssueStartable(issue) && <RunNowAction issueId={issue.id} onStart={onStart} />}
      </div>
      {meta.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center text-[11px] text-muted-foreground">
          {meta.map((el, i) => (
            <span key={el.key} className="inline-flex min-w-0 items-center">
              {i > 0 && (
                <span
                  className="mx-2 size-0.5 flex-none rounded-full bg-muted-foreground/50"
                  aria-hidden="true"
                />
              )}
              {el}
            </span>
          ))}
        </div>
      )}
    </>
  )
}

/** The mock's three-cell evidence strip: labeled cells between hairlines, each
 *  degrading away when it has no data (the strip vanishes entirely when empty).
 *  Evidence stays a quiet table, not a dashboard. */
function IssueDetailsStrip({ issue }: { issue: RefIssueLike }): JSX.Element | null {
  const todos = issue.panel?.todos ?? []
  const todosDone = todos.filter((t) => t.done).length
  const artifacts = issue.panel?.artifacts?.length ?? 0
  const comments = issue.commentCount ?? 0
  const cells: { label: string; value: string }[] = []
  if (todos.length > 0) cells.push({ label: 'Tasks', value: `${todosDone} of ${todos.length} done` })
  if ((issue.childCount ?? 0) > 0)
    cells.push({
      label: 'Subissues',
      value: `${issue.childDoneCount ?? 0}/${issue.childCount} done`,
    })
  if (artifacts > 0) cells.push({ label: 'Artifacts', value: `${artifacts}` })
  if (comments > 0)
    cells.push({ label: 'Activity', value: `${comments} comment${comments === 1 ? '' : 's'}` })
  if (cells.length === 0) return null
  return (
    <div
      className="grid border-y border-border/60"
      style={{ gridTemplateColumns: `repeat(${Math.min(cells.length, 3)}, 1fr)` }}
    >
      {cells.slice(0, 3).map((c, i) => (
        <div
          key={c.label}
          className={cn('min-w-0 px-3 py-2.5', i > 0 && 'border-l border-border/60')}
        >
          <div className="text-[10px] text-muted-foreground/70">{c.label}</div>
          <div className="mt-1 truncate text-[11px] tabular-nums text-foreground/85">{c.value}</div>
        </div>
      ))}
    </div>
  )
}

function repoName(cwd: string): string {
  return cwd.split('/').pop() ?? cwd
}

function SessionSummary({
  session,
  issues,
}: {
  session: RefSessionLike
  issues: readonly RefIssueLike[]
}): JSX.Element {
  const label = session.name || session.title || 'Session'
  // When the session has since re-homed onto a different issue than its birth
  // ref names, say so — the birth displayRef stays primary (#474, finding 9).
  const workingRef = sessionWorkingIssueRef(session, issues)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
        <span>{session.displayRef}</span>
        {workingRef && (
          <span className="rounded border border-border/60 bg-muted/60 px-1 py-px text-[10px]">
            working {workingRef}
          </span>
        )}
      </div>
      <div className="text-[13px] font-medium leading-snug">{label}</div>
      <div className="truncate text-[11px] text-muted-foreground/80">{repoName(session.cwd)}</div>
    </div>
  )
}
