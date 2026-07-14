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
  setRefActivator,
  subscribeMiniview,
} from '@/lib/ref-activation'
import {
  knownPrefixesFromIssues,
  type RefIssueLike,
  type RefSessionLike,
  type ResolvedRef,
  resolveRef,
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
  onClose,
  onOpenFull,
}: {
  refToken: string
  target: ResolvedRef | null
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

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!drag.current) return
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.current.dx)),
        y: Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.current.dy)),
      })
    }
    const onUp = (): void => {
      drag.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className="fixed z-[90] w-[340px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={`Reference ${refToken}`}
    >
      {/* Drag handle header. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: header is a drag surface; actions have their own buttons */}
      <div
        className="flex cursor-grab items-center gap-1.5 border-b border-border/60 bg-muted/40 px-2 py-1.5 active:cursor-grabbing"
        onMouseDown={(e) => {
          drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
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
          <SessionSummary session={target.session} />
        )}
      </div>
    </div>
  )
}

/**
 * Keep the markdown + terminal ref linkifiers' known-prefix set in sync with the
 * live issues list (#474, task 1). Mounted once at app root; renders nothing.
 * Linkification is inert until this runs (an empty prefix set disables it).
 */
export function RefPrefixSync(): null {
  const prefixKey = useStoreSelector((s) => [...knownPrefixesFromIssues(s.issues)].sort().join(','))
  useEffect(() => {
    setKnownRefPrefixes(prefixKey ? prefixKey.split(',') : [])
  }, [prefixKey])
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

function SessionSummary({ session }: { session: RefSessionLike }): JSX.Element {
  const label = session.name || session.title || 'Session'
  return (
    <div className="flex flex-col gap-1.5">
      <div className="font-mono text-[11px] text-muted-foreground">{session.displayRef}</div>
      <div className="text-[13px] font-medium leading-snug">{label}</div>
      <div className="truncate text-[11px] text-muted-foreground/80">{repoName(session.cwd)}</div>
    </div>
  )
}
