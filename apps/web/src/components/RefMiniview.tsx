import { relativeTime } from '@podium/client-core/focus'
import { shallowEqual } from '@podium/client-core/store'
import { type IssueReferenceModel, issueReferenceModel } from '@podium/client-core/viewmodels'
import type { IssueId } from '@podium/model'
import { formatLong, truncateTitle } from '@podium/protocol'
import {
  ArchiveRestore,
  Check,
  ExternalLink,
  GripVertical,
  LoaderCircle,
  PanelRight,
  Play,
  User,
  X,
} from 'lucide-react'
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
import { useReplicaIssues, useStoreSelector } from '@/app/store'
import { isIssueStartable } from '@/features/issues/issue-startable'
import {
  ISSUE_AGENT_KINDS,
  issueAgentIcon,
  issueAgentKind,
  issueAgentLabel,
} from '@/lib/issue-agents'
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
import { cn } from '@/lib/utils'
import { IssueReference } from './IssueReference'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

/**
 * Root-mounted host for the single floating ref miniview (#474, area 7). Owns:
 *  - the activator registration (plain click → miniview, Cmd/Ctrl → full view);
 *  - reading the external miniview store and resolving the open ref;
 *  - rendering the draggable <RefCard> when a ref is open and resolvable.
 */
export function RefMiniviewHost(): JSX.Element | null {
  const issues = useReplicaIssues()
  const { trpc, sessions, setOpenIssueId, setView, setPeekIssueId, navigateToSession } =
    useStoreSelector(
      (s) => ({
        trpc: s.trpc,
        sessions: s.sessions,
        setOpenIssueId: s.setOpenIssueId,
        setView: s.setView,
        setPeekIssueId: s.setPeekIssueId,
        navigateToSession: s.navigateToSession,
      }),
      shallowEqual,
    )

  const openIssueFull = (issueId: IssueId): void => {
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
        // page remains one more step away (drawer header's "Open issue peek", or
        // Cmd/Ctrl-click on the chip). Sessions have no peek surface and still
        // navigate.
        if (target.kind === 'issue') setPeekIssueId(target.issue.id)
        else navigateToSession(state.ref)
      }}
      onStart={(issueId) => trpc.issues.start.mutate({ id: issueId })}
      onPromote={(issueId) => trpc.issues.promote.mutate({ id: issueId })}
      onAgentChange={(issueId, defaultAgent) =>
        trpc.issues.update.mutate({ id: issueId, patch: { defaultAgent } })
      }
    />,
    document.body,
  )
}

const CARD_WIDTH = 416
const VIEWPORT_MARGIN = 12

/** Seed the card near the activating click: slightly below-left, clamped into
 *  the viewport. Without an anchor (keyboard/synthetic activation) fall back to
 *  the old top-right seed. Exported for tests. */
export function seedCardPosition(
  anchor: { x: number; y: number } | undefined,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const width = Math.max(0, Math.min(CARD_WIDTH, viewport.width - VIEWPORT_MARGIN * 2))
  if (!anchor) return { x: Math.max(VIEWPORT_MARGIN, viewport.width - width - 20), y: 88 }
  return {
    x: Math.min(
      Math.max(VIEWPORT_MARGIN, anchor.x - 24),
      Math.max(VIEWPORT_MARGIN, viewport.width - width - VIEWPORT_MARGIN),
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
  onPromote,
  onAgentChange,
}: {
  refToken: string
  anchor?: { x: number; y: number }
  target: ResolvedRef | null
  issues: readonly RefIssueLike[]
  onClose: () => void
  onOpenFull: () => void
  /** Start an agent on the issue (POD-110) — `trpc.issues.start` in the host. */
  onStart?: (issueId: string) => Promise<unknown>
  /** Approve an agent proposal into backlog without starting it. */
  onPromote?: (issueId: string) => Promise<unknown>
  /** Persist the harness planned for the next session on this issue. */
  onAgentChange?: (issueId: string, defaultAgent: string) => Promise<unknown>
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
  const issueRefModel: IssueReferenceModel | null =
    target?.kind === 'issue'
      ? target.issue.stage
        ? issueReferenceModel({
            id: target.issue.id,
            seq: target.issue.seq,
            title: target.issue.title,
            stage: target.issue.stage,
            ...(target.issue.prefix ? { prefix: target.issue.prefix } : {}),
            ...(target.issue.displayRef ? { displayRef: target.issue.displayRef } : {}),
            ...(target.issue.archived !== undefined ? { archived: target.issue.archived } : {}),
            ...(target.issue.deletedAt ? { deletedAt: target.issue.deletedAt } : {}),
          })
        : {
            ref: refToken,
            issueId: target.issue.id,
            title: target.issue.title,
            stage: null,
            availability: 'unavailable',
            accessibleLabel: `Task ${refToken} has no available status`,
          }
      : null

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
      // Base UI portals SelectContent to document.body. It is still owned by
      // this popup, so choosing a harness must not trip light-dismiss.
      if (
        e.target instanceof Element &&
        e.target.closest('[data-ref-miniview-owned="true"]')
      )
        return
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
      data-pressable
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
      className="fixed z-40 w-[min(416px,calc(100vw-1.5rem))] origin-top-left overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-[0_24px_64px_-20px_rgb(0_0_0/0.55),0_0_0_1px_var(--border)] animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-150 ease-out motion-reduce:animate-none"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={`Reference ${refToken}`}
    >
      {target?.kind === 'issue' ? (
        <>
          {/* The head is the drag handle. Identity stays readable rather than
              doubling as an undiscoverable copy action. */}
          <div
            className="cursor-grab touch-none px-4 pt-4 pb-3 active:cursor-grabbing"
            {...dragHandlers}
          >
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <div className="min-w-0 text-[11px] font-semibold tracking-[0.04em] text-muted-foreground">
                {issueRefModel && <IssueReference model={issueRefModel} showTitle={false} />}
              </div>
              <span className="flex flex-none items-center gap-1.5">{closeButton}</span>
            </div>
            <IssueSummary issue={target.issue} issues={issues} />
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
          {onAgentChange && (
            <IssueHarnessPicker issue={target.issue} onAgentChange={onAgentChange} />
          )}
          <IssueDetailsStrip issue={target.issue} />
          {onStart && isIssueStartable(target.issue) && (
            <IssueActions issue={target.issue} onStart={onStart} onPromote={onPromote} />
          )}
          {/* Escalation stays one rung (POD-95): open the peek drawer without
              replacing the chat. */}
          <div className="border-t border-border/60 p-2.5">
            <button
              data-pressable
              type="button"
              className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={onOpenFull}
            >
              Open issue peek
              <PanelRight size={12} aria-hidden="true" />
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
                data-pressable
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
  const { trpc, repoKey } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      // Registered repos changing (add/remove) means the prefix set may have too.
      repoKey: s.repos
        .map((r) => r.path)
        .sort()
        .join('\n'),
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const issuePrefixKey = [...collectRefPrefixes(issues)].sort().join(',')
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

/** The issue's persisted defaultAgent is the plan for its next session. Keep
 *  that choice close to the proposal decision and make persistence visible. */
function IssueHarnessPicker({
  issue,
  onAgentChange,
}: {
  issue: RefIssueLike
  onAgentChange: (issueId: string, defaultAgent: string) => Promise<unknown>
}): JSX.Element {
  const persisted = issueAgentKind(issue.defaultAgent) ?? 'claude-code'
  const [selected, setSelected] = useState(persisted)
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState('')

  useEffect(() => {
    setSelected(persisted)
  }, [persisted])
  useEffect(() => {
    if (state !== 'saved') return
    const timeout = window.setTimeout(() => setState('idle'), 1200)
    return () => window.clearTimeout(timeout)
  }, [state])

  const change = (next: string | null): void => {
    const agent = issueAgentKind(next)
    if (!agent || agent === selected || state === 'saving') return
    const previous = selected
    setSelected(agent)
    setState('saving')
    setError('')
    onAgentChange(issue.id, agent).then(
      () => {
        setState('saved')
      },
      (cause: unknown) => {
        setSelected(previous)
        setState('idle')
        setError(cause instanceof Error ? cause.message : String(cause))
      },
    )
  }

  return (
    <div className="mx-3 mb-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground/70 uppercase">
            Planned agent
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            Used when this issue starts
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          <span className="flex size-5 items-center justify-center" aria-hidden="true">
            {state === 'saving' ? (
              <LoaderCircle size={14} className="animate-spin text-muted-foreground" />
            ) : state === 'saved' ? (
              <Check size={14} className="animate-in zoom-in-50 text-success duration-150" />
            ) : (
              issueAgentIcon(selected, 14)
            )}
          </span>
          <Select value={selected} onValueChange={change} disabled={state === 'saving'}>
            <SelectTrigger
              size="sm"
              className="w-[148px] border-border/70 bg-background/40 text-[11.5px]"
              aria-label="Planned agent harness"
            >
              <SelectValue>{issueAgentLabel(selected)}</SelectValue>
            </SelectTrigger>
            <SelectContent align="end" data-ref-miniview-owned="true">
              {ISSUE_AGENT_KINDS.map((agent) => (
                <SelectItem key={agent} value={agent}>
                  {issueAgentIcon(agent, 13)}
                  {issueAgentLabel(agent)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[10.5px] leading-snug text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/** Start immediately or, for a human-curated proposal, approve it into backlog.
 *  Each async path owns visible progress and inline failure feedback. */
function IssueActions({
  issue,
  onStart,
  onPromote,
}: {
  issue: RefIssueLike
  onStart: (issueId: string) => Promise<unknown>
  onPromote?: (issueId: string) => Promise<unknown>
}): JSX.Element {
  const [starting, setStarting] = useState<'idle' | 'busy' | 'done'>('idle')
  const [promoting, setPromoting] = useState<'idle' | 'busy' | 'done'>('idle')
  const [error, setError] = useState('')
  const proposed = issue.stage === 'proposed'

  const start = (): void => {
    setStarting('busy')
    setError('')
    onStart(issue.id).then(
      () => setStarting('done'),
      (cause: unknown) => {
        setStarting('idle')
        setError(cause instanceof Error ? cause.message : String(cause))
      },
    )
  }
  const promote = (): void => {
    if (!onPromote) return
    setPromoting('busy')
    setError('')
    onPromote(issue.id).then(
      () => setPromoting('done'),
      (cause: unknown) => {
        setPromoting('idle')
        setError(cause instanceof Error ? cause.message : String(cause))
      },
    )
  }

  return (
    <div className="border-t border-border/60 bg-muted/15 p-3">
      {proposed && (
        <div className="mb-2.5">
          <div className="text-[11px] font-semibold text-foreground/90">Approve this proposal</div>
          <div className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">
            Add it to the backlog for an agent to pick up later, or start it now.
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        {proposed && onPromote && (
          <button
            data-pressable
            type="button"
            disabled={promoting !== 'idle' || starting !== 'idle'}
            className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-background/40 px-3 text-[11.5px] font-semibold text-foreground/85 transition-all hover:-translate-y-px hover:bg-accent hover:text-foreground active:translate-y-0 disabled:pointer-events-none disabled:opacity-60 motion-reduce:transform-none"
            onClick={promote}
          >
            {promoting === 'busy' ? (
              <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
            ) : promoting === 'done' ? (
              <Check size={13} className="animate-in zoom-in-50 text-success" aria-hidden="true" />
            ) : (
              <ArchiveRestore size={13} aria-hidden="true" />
            )}
            {promoting === 'busy'
              ? 'Adding…'
              : promoting === 'done'
                ? 'In backlog'
                : 'Add to backlog'}
          </button>
        )}
        <button
          data-pressable
          type="button"
          disabled={starting !== 'idle' || promoting === 'busy'}
          className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[11.5px] font-semibold text-primary-foreground shadow-sm transition-all hover:-translate-y-px hover:bg-primary/90 active:translate-y-0 disabled:pointer-events-none disabled:opacity-60 motion-reduce:transform-none"
          onClick={start}
        >
          {starting === 'busy' ? (
            <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
          ) : starting === 'done' ? (
            <Check size={13} className="animate-in zoom-in-50" aria-hidden="true" />
          ) : (
            <Play size={13} aria-hidden="true" />
          )}
          {starting === 'busy' ? 'Starting…' : starting === 'done' ? 'Started' : 'Run now'}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[10.5px] leading-snug text-destructive">
          {error}
        </p>
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
}: {
  issue: RefIssueLike
  issues: readonly RefIssueLike[]
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
        blocked{issue.blockedByNotes?.length ? ` (${issue.blockedByNotes.length})` : null}
      </span>,
    )
  return (
    <>
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1 text-[16px] leading-[1.3] font-semibold tracking-[-0.015em] text-foreground">
          {truncateTitle(issue.title, 120)}
        </div>
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
  if (todos.length > 0)
    cells.push({ label: 'Tasks', value: `${todosDone} of ${todos.length} done` })
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
