import { relativeTime } from '@podium/client-core/focus'
import { shallowEqual } from '@podium/client-core/store'
import { issueReferenceModel } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { machinePathBasename } from '@podium/model'
import type { IssueComment, IssueId, SessionId } from '@podium/model/browser'
import { formatLong, parseAnyRef, truncateTitle } from '@podium/protocol'
import {
  ArchiveRestore,
  Check,
  ExternalLink,
  ListTree,
  LoaderCircle,
  MessagesSquare,
  Play,
  User,
  X,
} from 'lucide-react'
import {
  type JSX,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import { OPEN_RIGHT_PANEL_EVENT } from '@/app/shell-state'
import { useRuntimeSelector } from '@/app/store'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { IssueChipLiveness } from '@/features/chat/IssueChipLiveness'
import { useChatReferenceMachines } from '@/features/chat/use-chat-context'
import { useIssueExplorer } from '@/features/issues/explorer/explorer-context'
import { IssueAgentSettings } from '@/features/issues/IssueAgentSettings'
import { PriorityGlyph } from '@/features/issues/issue-glyphs'
import { isIssueStartable } from '@/features/issues/issue-startable'
import type { LaunchMachine } from '@/features/issues/LaunchBox'
import { setKnownRefPrefixes } from '@/lib/markdown-references'
import {
  closeMiniview,
  getMiniviewState,
  openMiniview,
  setRefActivator,
  subscribeMiniview,
} from '@/lib/ref-activation'
import {
  type IssueSessionTarget,
  type RefIssueLike,
  type RefSessionLike,
  type ResolvedRef,
  resolveRef,
  sessionForIssue,
  sessionWorkingIssueRef,
} from '@/lib/ref-miniview'
import { cn } from '@/lib/utils'
import { IssueReference } from './IssueReference'
import { readReferenceSession, readRefMiniview } from './ref-miniview-readers'

/**
 * Root-mounted host for the single floating ref miniview (#474, area 7). Owns:
 *  - the activator registration (plain click → miniview, Cmd/Ctrl → full view);
 *  - reading the external miniview store and resolving the open ref;
 *  - rendering the <RefCard> when a ref is open and resolvable.
 */
export function RefMiniviewHost(): JSX.Element | null {
  return <PoolRefMiniviewHost />
}

function PoolRefMiniviewHost(): JSX.Element {
  const state = useSyncExternalStore(subscribeMiniview, getMiniviewState, getMiniviewState)
  const pool = useWorklistPool()
  const { setOpenIssueId, setView, navigateToSession } = useRuntimeSelector(
    (s) => ({
      setOpenIssueId: s.setOpenIssueId,
      setView: s.setView,
      navigateToSession: s.navigateToSession,
    }),
    shallowEqual,
  )
  // The activator stays registered while the card is closed. Session browsing
  // is needed only for a card or an explicit direct session activation.
  useEffect(() => {
    setRefActivator((ref, mods, anchor) => {
      if (!mods.direct) {
        openMiniview(ref, anchor)
        return
      }
      const parsed = parseAnyRef(ref)
      if (parsed?.kind === 'issue') {
        const target = resolvePoolIssue(pool, ref)
        if (target?.kind === 'issue') {
          setOpenIssueId(target.issue.id)
          setView('issues')
          return
        }
      } else if (parsed?.kind === 'session' && pool) {
        const session = readReferenceSession(pool, ref)
        if (session && typeof session !== 'symbol') {
          navigateToSession(ref)
          return
        }
      }
      openMiniview(ref, anchor)
    })
    return () => setRefActivator(null)
  }, [pool, setOpenIssueId, setView, navigateToSession])
  return (
    <>
      <IssueChipLiveness root={document.body} />
      {state && <OpenPoolRefMiniview state={state} pool={pool} />}
    </>
  )
}

function resolvePoolIssue(pool: MobxPool | null, token: string): ResolvedRef | null {
  const parsed = parseAnyRef(token)
  if (!pool || parsed?.kind !== 'issue') return null
  const id = pool.queries.issueReferenceId(token)
  if (!id || typeof id === 'symbol') return null
  const row = pool.row('issue', id)
  return row && typeof row !== 'symbol'
    ? { kind: 'issue', ref: parsed, issue: row as RefIssueLike }
    : null
}

function OpenPoolRefMiniview({
  state,
  pool,
}: {
  state: NonNullable<ReturnType<typeof getMiniviewState>>
  pool: MobxPool | null
}): JSX.Element {
  const read = useCallback((pool: MobxPool) => readRefMiniview(pool, state.ref), [state.ref])
  const data = useWorklistPoolProjection(read, {
    issues: [] as RefIssueLike[],
    sessions: [] as RefSessionLike[],
    loading: true,
  })
  return (
    <RefMiniviewContents
      issues={data.issues}
      sessions={data.sessions}
      resolveIssue={(token) => {
        const parsed = parseAnyRef(token)
        const issue = data.issues[0]
        return token === state?.ref && issue && parsed?.kind === 'issue'
          ? { kind: 'issue', ref: parsed, issue }
          : resolvePoolIssue(pool, token)
      }}
      loading={data.loading}
    />
  )
}

function RefMiniviewContents({
  issues,
  sessions,
  resolveIssue,
  loading = false,
}: {
  issues: readonly RefIssueLike[]
  sessions: readonly RefSessionLike[]
  resolveIssue: (ref: string) => ResolvedRef | null
  loading?: boolean
}): JSX.Element | null {
  const machines = useChatReferenceMachines()
  const { trpc, navigateToSession } = useRuntimeSelector(
    (s) => ({
      trpc: s.trpc,
      navigateToSession: s.navigateToSession,
    }),
    shallowEqual,
  )
  const { retarget } = useIssueExplorer()
  const loadComments = useCallback((id: IssueId) => trpc.issues.comments.query({ id }), [trpc])

  /**
   * The card's escalation (POD-786): point the ISSUE EXPLORER at this task and
   * reveal the dock. It replaces the peek drawer, which was a second, parallel
   * detail surface over the same `IssuePanelView` — the explorer already renders
   * that panel, with a trail the drawer never had.
   *
   * IN THE EXPLORER, AND NOWHERE ELSE (POD-1265). This used to get there by
   * moving the shell — select the mission root, focus the task — because that
   * was the only lever the explorer followed. But the shell selection is also
   * what the sidebar highlights and what keys the tab area's workspace, so
   * reading a ref in chat swapped the operator's whole workspace over to
   * whatever task the message happened to mention. The explorer now takes a
   * target directly, and the deck is left exactly where the work is.
   */
  const openInExplorer = (issueId: IssueId): void => {
    retarget(issueId)
    window.dispatchEvent(new CustomEvent(OPEN_RIGHT_PANEL_EVENT, { detail: 'issue' }))
  }
  const state = useSyncExternalStore(subscribeMiniview, getMiniviewState, getMiniviewState)
  if (!state) return null

  const target =
    parseAnyRef(state.ref)?.kind === 'issue'
      ? resolveIssue(state.ref)
      : resolveRef(state.ref, [], sessions)

  return createPortal(
    <RefCard
      key={state.seq} // re-seed the position on every activation, even same-ref
      refToken={state.ref}
      anchor={state.anchor}
      target={target}
      loading={loading}
      issues={issues}
      sessions={sessions}
      machines={machines}
      onClose={closeMiniview}
      onOpenFull={() => {
        if (!target) return
        closeMiniview()
        // One rung up the ladder: an issue escalates INTO THE EXPLORER, which
        // keeps the chat where it is; the full /issues/:id page stays one more
        // step away (Cmd/Ctrl-click on the chip). Sessions have no explorer
        // surface and still navigate.
        if (target.kind === 'issue') openInExplorer(target.issue.id)
        else navigateToSession(state.ref)
      }}
      onGoToSession={(sessionId) => {
        closeMiniview()
        navigateToSession(sessionId)
      }}
      onStart={(issueId) => trpc.issues.start.mutate({ id: issueId })}
      onPromote={(issueId) => trpc.issues.promote.mutate({ id: issueId })}
      loadComments={loadComments}
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

/** The fixed-position miniview card, anchored to the ref that opened it. Exported for tests. */
export function RefCard({
  refToken,
  anchor,
  target,
  issues,
  sessions = [],
  machines = [],
  onClose,
  onOpenFull,
  onGoToSession,
  onStart,
  onPromote,
  loadComments,
  loading = false,
}: {
  refToken: string
  anchor?: { x: number; y: number }
  target: ResolvedRef | null
  loading?: boolean
  issues: readonly RefIssueLike[]
  /** Live sessions, for the "Go to session" action. Absent = no such action. */
  sessions?: readonly RefSessionLike[]
  machines?: LaunchMachine[]
  onClose: () => void
  onOpenFull: () => void
  /** Jump to the session running this task (or the ancestor's that covers it). */
  onGoToSession?: (sessionId: SessionId) => void
  /** Start an agent on the issue (POD-110) — `trpc.issues.start` in the host. */
  onStart?: (issueId: IssueId) => Promise<unknown>
  /** Approve an agent proposal into backlog without starting it. */
  onPromote?: (issueId: IssueId) => Promise<unknown>
  /** Loaded only while the issue card is open; the feed carries no count here. */
  loadComments?: (issueId: IssueId) => Promise<readonly IssueComment[]>
}): JSX.Element {
  // Fixed position, placed once next to the activating click (falling back to
  // top-right when there is none) and left there. The card is not draggable: it
  // is a transient reading surface tied to the link you clicked, and a movable
  // one asked the reader to manage a window for a card that closes on the next
  // click anywhere. Kept in state so a re-resolve (issues update) doesn't reset it.
  const [pos, setPos] = useState<{ x: number; y: number }>(() =>
    seedCardPosition(anchor, { width: window.innerWidth, height: window.innerHeight }),
  )
  const [savingSettings, setSavingSettings] = useState(false)
  const cardEl = useRef<HTMLDivElement | null>(null)
  const anchorY = anchor?.y

  // The seed only estimates the card's height; once real, nudge it fully into
  // view — and if that would cover an anchored link, flip above the click instead.
  // Re-runs whenever the card's height changes (an issue update adding an
  // activity note, say): with no drag there is no user-chosen position to
  // protect, and staying inside the viewport is the only thing that matters.
  useLayoutEffect(() => {
    const el = cardEl.current
    if (!el) return
    const clampIntoView = (): void => {
      const h = el.offsetHeight
      setPos((p) => {
        const maxY = window.innerHeight - h - VIEWPORT_MARGIN
        if (p.y <= maxY) return p
        const flipY = anchorY === undefined ? maxY : anchorY - h - 10
        return { ...p, y: Math.max(VIEWPORT_MARGIN, Math.min(maxY, flipY)) }
      })
    }
    clampIntoView()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(clampIntoView)
    observer.observe(el)
    return () => observer.disconnect()
  }, [anchorY])
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
      if (t?.closest('[data-overlay-owner="ref-miniview"]')) return
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
      // Portaled settings menus belong to this card for light-dismiss.
      if (e.target instanceof Element && e.target.closest('[data-overlay-owner="ref-miniview"]'))
        return
      onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [onClose])

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
          <div className="px-4 pt-4 pb-3">
            {/* IDENTITY ROW — what this task IS, in one line: stage glyph, ref,
                priority. Priority is identity, not enrichment: it outranks
                everything on the meta line below and was being read last, at the
                end of a dot-separated run. Here it sits where the ref is, in the
                same mono voice, and reads first. */}
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold tracking-[0.04em] text-muted-foreground">
                <IssueReference
                  model={
                    target.issue.stage
                      ? issueReferenceModel({
                          ...target.issue,
                          stage: target.issue.stage,
                          displayRef: refToken,
                        })
                      : {
                          ref: refToken,
                          issueId: target.issue.id,
                          title: target.issue.title,
                          stage: null,
                          availability: 'present',
                          accessibleLabel: `Task ${refToken}: ${target.issue.title}`,
                        }
                  }
                  showTitle={false}
                />
                {target.issue.priority !== undefined && (
                  <span
                    className="flex flex-none items-center gap-1"
                    title={`Priority P${target.issue.priority}`}
                  >
                    <PriorityGlyph priority={target.issue.priority} size={12} />
                    <span className="font-mono text-foreground/85">P{target.issue.priority}</span>
                  </span>
                )}
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
          {isIssueStartable(target.issue) && (
            <div className="mx-3 mb-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
              <IssueAgentSettings
                key={target.issue.id}
                issue={target.issue}
                machines={machines}
                compact
                menuOwner="ref-miniview"
                onSavingChange={setSavingSettings}
              />
            </div>
          )}
          <IssueDetailsStrip
            key={target.issue.id}
            issue={target.issue}
            loadComments={loadComments}
          />
          {onStart && isIssueStartable(target.issue) && (
            <IssueActions
              issue={target.issue}
              onStart={onStart}
              onPromote={onPromote}
              disabled={savingSettings}
            />
          )}
          <IssueEscalations
            issue={target.issue}
            issues={issues}
            sessions={sessions}
            onOpenFull={onOpenFull}
            onGoToSession={onGoToSession}
          />
        </>
      ) : (
        <>
          {/* Session / unresolved: compact title bar with the canonical long form
              (#474 spec §display) — `POD-13-A · title` truncated, full on hover. */}
          <div className="flex items-center gap-1.5 border-b border-border/60 bg-muted/40 px-2.5 py-1.5">
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
              <p className="text-muted-foreground">
                {loading ? 'Loading reference…' : 'Reference not found.'}
              </p>
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
 * task 1). The replicated repository feed includes registered repos with zero
 * issues and applies prefix changes by address. Its maintained prefix scalar
 * updates the linkifiers without fetching or walking a repository catalog.
 * Mounted once at app root; renders nothing.
 * Linkification is inert until this runs (an empty prefix set disables it).
 */
export function RefPrefixSync(): JSX.Element {
  return <PoolRefPrefixSync />
}

function PoolRefPrefixSync(): null {
  const read = useCallback((pool: MobxPool) => {
    return pool.queries.repositoryPrefixKey()
  }, [])
  const prefixKey = useWorklistPoolProjection(read, '')
  useEffect(() => {
    setKnownRefPrefixes(new Set(prefixKey ? prefixKey.split(',') : []))
  }, [prefixKey])
  return null
}

/** Start immediately or, for a human-curated proposal, approve it into backlog.
 *  Each async path owns visible progress and inline failure feedback. */
function IssueActions({
  disabled = false,
  issue,
  onStart,
  onPromote,
}: {
  issue: RefIssueLike
  onStart: (issueId: IssueId) => Promise<unknown>
  onPromote?: (issueId: IssueId) => Promise<unknown>
  disabled?: boolean
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
            disabled={disabled || promoting !== 'idle' || starting !== 'idle'}
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
          disabled={disabled || starting !== 'idle' || promoting === 'busy'}
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

/**
 * THE CARD'S TWO WAYS OUT (POD-786).
 *
 * The card is a glance. Both exits leave the chat exactly where it is, and each
 * answers a different question the glance provokes:
 *
 *  - "tell me more about this task" → the ISSUE EXPLORER, which owns task detail
 *    now. It replaced a peek drawer that rendered the same `IssuePanelView` on a
 *    scrim, so what used to be a parallel surface is now the one surface.
 *  - "take me to the agent doing it" → the session. For a subtask that is usually
 *    the PARENT's session, and when it is, the button says so rather than
 *    pretending the child has one — otherwise a landing on POD-500-A from a card
 *    titled POD-517 reads as the wrong session opening.
 *
 * Neither is primary: reading and joining are different intents, not steps.
 */
function IssueEscalations({
  issue,
  issues,
  sessions,
  onOpenFull,
  onGoToSession,
}: {
  issue: RefIssueLike
  issues: readonly RefIssueLike[]
  sessions: readonly RefSessionLike[]
  onOpenFull: () => void
  onGoToSession?: (sessionId: SessionId) => void
}): JSX.Element {
  const target: IssueSessionTarget | null = onGoToSession
    ? sessionForIssue(issue, issues, sessions)
    : null
  // Only worth naming when it is NOT this task's own session; on its own task
  // the ref is noise the header already carries.
  const inherited = target && target.via.id !== issue.id ? target : null
  const sessionRef = target?.session.displayRef ?? ''
  return (
    <div className="flex items-center gap-1.5 border-t border-border/60 p-2.5">
      {target && onGoToSession && (
        <button
          data-pressable
          type="button"
          className="inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={
            inherited
              ? `Open ${sessionRef} — the session on ${inherited.via.displayRef ?? 'the parent task'}, which covers this subtask`
              : `Open ${sessionRef}`
          }
          onClick={() => onGoToSession(target.session.sessionId)}
        >
          <MessagesSquare size={12} className="flex-none" aria-hidden="true" />
          <span className="truncate">{inherited ? 'Parent session' : 'Go to session'}</span>
          {inherited && sessionRef && (
            <span className="flex-none font-mono text-[10.5px] text-muted-foreground/60">
              {sessionRef}
            </span>
          )}
        </button>
      )}
      <button
        data-pressable
        type="button"
        className="inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="Show this task in the issue explorer"
        onClick={onOpenFull}
      >
        <ListTree size={12} className="flex-none" aria-hidden="true" />
        <span className="truncate">Open in explorer</span>
      </button>
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
  // Priority is deliberately absent — it rides the identity row above.
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
function IssueDetailsStrip({
  issue,
  loadComments,
}: {
  issue: RefIssueLike
  loadComments?: (issueId: IssueId) => Promise<readonly IssueComment[]>
}): JSX.Element | null {
  const [comments, setComments] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: issue updates invalidate the on-demand comment count.
  useEffect(() => {
    let cancelled = false
    if (loadComments) {
      void Promise.resolve()
        .then(() => loadComments(issue.id))
        .then((rows) => {
          if (!cancelled) setComments(rows.length)
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [issue.id, issue.updatedAt, loadComments])
  const todos = issue.panel?.todos ?? []
  const todosDone = todos.filter((t) => t.done).length
  const artifacts = issue.panel?.artifacts?.length ?? 0
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
      <div className="truncate text-[11px] text-muted-foreground/80">
        {machinePathBasename(session.cwd)}
      </div>
    </div>
  )
}
