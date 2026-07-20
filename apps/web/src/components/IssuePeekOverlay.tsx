import { shallowEqual } from '@podium/client-core/store'
import { issueDisplayRef } from '@podium/protocol'
import { ExternalLink, X } from 'lucide-react'
import { type JSX, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStoreSelector } from '@/app/store'
import { IssuePanelView } from '@/features/issues/IssuePanelView'
import { resolveActiveWorktree } from '@/lib/dock-panel'
import { cn } from '@/lib/utils'
import { finishPeekClose, nextPeekPhase, PEEK_CLOSED, type PeekPhase } from './issue-peek-phase'

/** Entry: unhurried, settles softly. Exit: quicker, symmetric ease. */
const ENTER = 'duration-[380ms] ease-[cubic-bezier(0.32,0.72,0,1)]'
const EXIT = 'duration-[240ms] ease-[cubic-bezier(0.65,0,0.35,1)]'
/** Fallback for the exit's transitionend under prefers-reduced-motion. */
const EXIT_FALLBACK_MS = 400

/**
 * The issue peek drawer (POD-95): a chat ref's "open" without leaving the
 * conversation. Unlike the docked panels it is an OVERLAY — it slides in over
 * the right edge (covering the dock and rail), floats above the shell on a
 * scrim, and leaves the URL untouched. Escape / scrim / ✕ close it; the full
 * /issues/:id page stays one action away ("Open full page", Cmd/Ctrl-click).
 * Root-mounted next to RefMiniviewHost; renders nothing while closed.
 */
export function IssuePeekOverlay(): JSX.Element | null {
  const {
    peekIssueId,
    setPeekIssueId,
    issues,
    sessions,
    paneA,
    fileTabs,
    setOpenIssueId,
    setView,
  } = useStoreSelector(
    (s) => ({
      peekIssueId: s.peekIssueId,
      setPeekIssueId: s.setPeekIssueId,
      issues: s.issues,
      sessions: s.sessions,
      paneA: s.paneA,
      fileTabs: s.fileTabs,
      setOpenIssueId: s.setOpenIssueId,
      setView: s.setView,
    }),
    shallowEqual,
  )

  const [phase, setPhase] = useState<PeekPhase>(PEEK_CLOSED)
  useEffect(() => {
    setPhase((p) => nextPeekPhase(p, peekIssueId))
  }, [peekIssueId])

  // `slid` drives the transform: mounted off-screen, then two frames later
  // slid=true so the entry actually transitions (no first-paint teleport).
  const [slid, setSlid] = useState(false)
  const open = phase.kind === 'open'
  useLayoutEffect(() => {
    if (!open) {
      setSlid(false)
      return
    }
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setSlid(true))
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [open])

  // Reduced motion (or a missed transitionend) must not strand the closing
  // phase — finish it on a timer as well.
  useEffect(() => {
    if (phase.kind !== 'closing') return
    const t = setTimeout(() => setPhase(finishPeekClose), EXIT_FALLBACK_MS)
    return () => clearTimeout(t)
  }, [phase.kind])

  // Escape closes — with the miniview card's pass-throughs: a terminal or an
  // open dialog (other than this drawer) owns its own Escape.
  const panelEl = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const t = e.target instanceof Element ? e.target : null
      if (t?.closest('.xterm')) return
      const dialog = t?.closest('[role=dialog],[role=alertdialog]')
      if (dialog && dialog !== panelEl.current) return
      setPeekIssueId(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, setPeekIssueId])

  // Land keyboard focus on the drawer so Escape/tab start inside it.
  useEffect(() => {
    if (open) panelEl.current?.focus()
  }, [open])

  if (phase.kind === 'closed') return null

  const issue = issues.find((i) => i.id === phase.issueId && !i.deletedAt) ?? null
  // IssuePanelView's explicit-id path skips archived issues — say "archived"
  // rather than mounting a panel that contradicts the header.
  const renderable = issue != null && !issue.archived
  const displayRef = issue ? issueDisplayRef(issue) : null
  const active = resolveActiveWorktree({ paneA, fileTabs, sessions })
  const visible = open && slid
  const close = (): void => setPeekIssueId(null)

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-40" data-testid="peek-overlay-root">
      {/* Scrim: the drawer is ABOVE the app, and everything behind it — the
          right dock and rail included — steps back. Click closes. */}
      <div
        className={cn(
          'absolute inset-0 bg-black/40 transition-opacity motion-reduce:transition-none',
          visible ? `pointer-events-auto opacity-100 ${ENTER}` : `opacity-0 ${EXIT}`,
        )}
        onClick={close}
        aria-hidden="true"
      />
      <div
        ref={panelEl}
        role="dialog"
        aria-modal="true"
        aria-label={displayRef ? `Peek ${displayRef}` : 'Issue peek'}
        tabIndex={-1}
        data-testid="peek-overlay"
        onTransitionEnd={(e) => {
          if (e.target === panelEl.current && e.propertyName === 'transform') {
            setPhase(finishPeekClose)
          }
        }}
        className={cn(
          'pointer-events-auto absolute inset-y-2 right-2 flex w-[min(480px,calc(100vw-16px))] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground outline-none',
          // Elevation reads from the edge: a long soft throw to the left plus a
          // hairline ring, so the drawer is unmistakably a layer, not a column.
          'shadow-[-40px_0_80px_-24px_rgba(0,0,0,0.65),0_0_0_1px_rgba(0,0,0,0.35)]',
          'transition-transform will-change-transform motion-reduce:transition-none motion-reduce:translate-x-0',
          visible ? `translate-x-0 ${ENTER}` : `translate-x-[calc(100%+24px)] ${EXIT}`,
        )}
      >
        <div className="flex h-12 flex-none items-center gap-1.5 border-b border-border px-3">
          {/* Keyed by issue: replacing one peek with another replays the amber
              flash (motion.css morph-row-flash → resting bg-primary/10). */}
          <span
            key={phase.issueId}
            className="morph-row-flash flex min-w-0 flex-1 items-center gap-2 rounded-md bg-primary/10 px-2.5 py-1.5"
            data-testid="peek-overlay-tab"
          >
            <span className="flex-none font-mono text-[12px] font-medium text-primary">
              {displayRef ?? '#?'}
            </span>
            <span className="truncate text-[13px] font-medium text-secondary-foreground">
              {issue?.title ?? 'Issue not found'}
            </span>
          </span>
          {issue && (
            <button
              type="button"
              className="flex size-7 flex-none items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Open full page"
              aria-label="Open full page"
              onClick={() => {
                close()
                setOpenIssueId(issue.id)
                setView('issues')
              }}
            >
              <ExternalLink size={13} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="flex size-7 flex-none items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Close (esc)"
            aria-label="Close peek"
            onClick={close}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        {/* Keyed body: swapping peeks gets a small secondary slide while the
            drawer itself stays put. */}
        <div
          key={phase.issueId}
          className="flex min-h-0 flex-1 flex-col animate-in fade-in slide-in-from-right-4 duration-200"
        >
          {renderable ? (
            <IssuePanelView
              cwd={active?.cwd ?? ''}
              machineId={active?.machineId}
              issueId={issue.id}
            />
          ) : (
            <div className="p-3 text-xs text-muted-foreground/70">
              {issue ? 'This issue is archived.' : 'This issue is no longer available.'}
            </div>
          )}
        </div>
        <div className="flex h-8 flex-none items-center justify-between border-t border-border/60 px-3 text-[10px] text-muted-foreground/60">
          <span>
            <kbd className="rounded border border-border/60 bg-muted/60 px-1 font-mono">esc</kbd>{' '}
            close
          </span>
          <span>a new ref replaces this peek</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
