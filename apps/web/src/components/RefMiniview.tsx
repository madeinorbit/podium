import { shallowEqual } from '@podium/client-core/store'
import { issueDisplayRef, truncateTitle } from '@podium/protocol'
import { ExternalLink, GripVertical, X } from 'lucide-react'
import { type JSX, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useStoreSelector } from '@/app/store'
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
  const {
    issues,
    sessions,
    setOpenIssueId,
    setView,
    setSelectedIssueId,
    setSelectedWorktree,
    setPane,
  } = useStoreSelector(
    (s) => ({
      issues: s.issues,
      sessions: s.sessions,
      setOpenIssueId: s.setOpenIssueId,
      setView: s.setView,
      setSelectedIssueId: s.setSelectedIssueId,
      setSelectedWorktree: s.setSelectedWorktree,
      setPane: s.setPane,
    }),
    shallowEqual,
  )

  const openIssueFull = (issueId: string): void => {
    setOpenIssueId(issueId)
    setView('issues')
  }
  const openSessionFull = (session: { sessionId: string; cwd: string; issueId?: string }): void => {
    setSelectedIssueId(session.issueId ?? null)
    setSelectedWorktree(session.cwd)
    setPane('A', session.sessionId)
    setView('workspace')
  }

  // Register the activator: plain click opens the miniview; Cmd/Ctrl-click jumps
  // straight to the full view. Kept fresh so it always sees the latest store data.
  useEffect(() => {
    setRefActivator((ref, mods) => {
      if (!mods.direct) {
        openMiniview(ref)
        return
      }
      const target = resolveRef(ref, issues, sessions)
      if (!target) {
        openMiniview(ref) // nothing to navigate to — fall back to the card (shows "not found")
        return
      }
      if (target.kind === 'issue') openIssueFull(target.issue.id)
      else openSessionFull(target.session)
    })
    return () => setRefActivator(null)
  })

  const state = useSyncExternalStore(subscribeMiniview, getMiniviewState, getMiniviewState)
  if (!state) return null

  const target = resolveRef(state.ref, issues, sessions)

  return createPortal(
    <RefCard
      refToken={state.ref}
      target={target}
      issues={issues}
      onClose={closeMiniview}
      onOpenFull={() => {
        if (!target) return
        closeMiniview()
        if (target.kind === 'issue') openIssueFull(target.issue.id)
        else openSessionFull(target.session)
      }}
    />,
    document.body,
  )
}

/** The draggable, fixed-position miniview card. Drag by its header. */
function RefCard({
  refToken,
  target,
  issues,
  onClose,
  onOpenFull,
}: {
  refToken: string
  target: ResolvedRef | null
  issues: readonly RefIssueLike[]
  onClose: () => void
  onOpenFull: () => void
}): JSX.Element {
  // Fixed position, dragged by the header. Seeded near the top-right; the user
  // drags it wherever. Kept in state so a re-resolve (issues update) doesn't reset it.
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({
    x: Math.max(16, window.innerWidth - 360),
    y: 88,
  }))
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  const cardEl = useRef<HTMLDivElement | null>(null)

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

  return (
    <div
      ref={cardEl}
      className="fixed z-40 w-[340px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={`Reference ${refToken}`}
    >
      {/* Drag handle header. Pointer events + capture: one code path for mouse
          and touch, and move/up keep arriving even when the pointer leaves the
          header mid-drag. */}
      <div
        className="flex cursor-grab touch-none items-center gap-1.5 border-b border-border/60 bg-muted/40 px-2 py-1.5 active:cursor-grabbing"
        onPointerDown={(e) => {
          if (e.target instanceof Element && e.target.closest('button')) return
          drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          setPos({
            x: Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.current.dx)),
            y: Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.current.dy)),
          })
        }}
        onPointerUp={(e) => {
          drag.current = null
          e.currentTarget.releasePointerCapture(e.pointerId)
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        <GripVertical size={13} className="flex-none text-muted-foreground/60" aria-hidden="true" />
        <span className="flex-1 truncate font-mono text-[12px] font-medium">{refToken}</span>
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
        <button
          type="button"
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Close"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="px-3 py-2.5 text-[13px]">
        {!target ? (
          <p className="text-muted-foreground">Reference not found.</p>
        ) : target.kind === 'issue' ? (
          <IssueSummary issue={target.issue} />
        ) : (
          <SessionSummary session={target.session} issues={issues} />
        )}
      </div>
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

function IssueSummary({ issue }: { issue: RefIssueLike }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="font-mono text-[11px] text-muted-foreground">{issueDisplayRef(issue)}</div>
      <div className="text-[13px] font-medium leading-snug">{truncateTitle(issue.title, 120)}</div>
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
