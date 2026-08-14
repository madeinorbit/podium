import type { SessionMeta, SessionOffer } from '@podium/model/browser'
import { ChevronDown, Lightbulb, X } from 'lucide-react'
import { type JSX, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { OfferArtifactStrip } from './OfferArtifactStrip'
import { useOfferOverlayHost } from './offer-overlay'

/** The user's feedback rides the action's prompt as one turn. */
export const composeOfferPrompt = (prompt: string, feedback: string): string =>
  `${prompt}\n\n${feedback.trim()}`

const OFFER_EXIT_MS = 180
const OFFER_UNDO_MS = 10_000
const OFFER_UNDO_FADE_MS = 500

type DismissPhase = 'visible' | 'leaving' | 'undo' | 'undo-leaving'

/** Where the detail's clip window sits inside the overlay layer: flush with the
 *  offer row's own edges, and ending exactly at its top so the panel rises out
 *  of the row. All four numbers are layer-relative pixels. */
type OverlayBox = { left: number; right: number; bottom: number }

/**
 * Track the offer row's box inside the overlay layer.
 *
 * The clip window is placed rather than sized: it runs from just below the
 * panel header down to the row's top edge, so the panel can only ever grow
 * into space that already belongs to the layer. Nothing above the row is
 * measured, resized, or re-laid-out when the fold opens.
 */
function useOverlayBox(
  host: HTMLElement | null,
  row: HTMLElement | null,
  expanded: boolean,
): OverlayBox | null {
  const [box, setBox] = useState<OverlayBox | null>(null)
  // Layout effect: the box must be known in the same frame the panel is
  // revealed, or the first open slides up from a stale anchor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `expanded` is a re-measure trigger, not a read — the row moves when the dock slides open, and a ResizeObserver never fires for a box that only changed position
  useLayoutEffect(() => {
    if (!host || !row) return
    const measure = (): void => {
      const layer = host.getBoundingClientRect()
      const seat = row.getBoundingClientRect()
      // A hidden pane (PanelDeck parks warm panels at display:none) measures
      // zero. Keep the last good box instead of collapsing the clip window.
      if (layer.height === 0 || seat.height === 0) return
      const next = {
        left: Math.max(0, seat.left - layer.left),
        right: Math.max(0, layer.right - seat.right),
        bottom: Math.max(0, layer.bottom - seat.top),
      }
      setBox((prev) =>
        prev && prev.left === next.left && prev.right === next.right && prev.bottom === next.bottom
          ? prev
          : next,
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    observer.observe(row)
    return () => observer.disconnect()
  }, [host, row, expanded])
  return box
}

function OfferActionLabel({ label, pending }: { label: string; pending: boolean }): JSX.Element {
  return (
    <span className="inline-grid items-center justify-items-center">
      <span
        aria-hidden={pending || undefined}
        className={cn('col-start-1 row-start-1', pending && 'invisible')}
      >
        {label}
      </span>
      <span
        aria-hidden={!pending || undefined}
        className={cn(
          'col-start-1 row-start-1 inline-flex items-center gap-1',
          !pending && 'invisible',
        )}
      >
        Sending…
      </span>
    </span>
  )
}

/**
 * Agent action offer [spec:SP-c7f1]. Its resting state is one quiet decision
 * row: signal + five-second headline, the recommended action, dismiss, and a
 * disclosure. Supporting copy, evidence, alternative actions, and feedback
 * stay folded until requested. The row is its own inline-size container so a
 * narrow native dock gets the same two-row fallback as a narrow viewport.
 *
 * Dismissal is deliberately recoverable. The offer leaves immediately, an
 * Undo row remains for ten seconds, and only after that window does onDismiss
 * clear it on the server. That delay is the only way to offer a real undo: the
 * server operation is intentionally global and has no restore counterpart.
 */
export function OfferBar({
  offer,
  disabled,
  onAction,
  onDismiss,
  session,
}: {
  offer: SessionOffer
  disabled: boolean
  onAction: (prompt: string, offerCreatedAt: string) => Promise<void> | void
  /** Take the offer off every surface without answering it. Absent on a host
   *  that cannot write (the offer then keeps its two original exits). */
  onDismiss?: (offerCreatedAt: string) => Promise<void> | void
  /** When given, the offer's issue-artifact evidence renders as a thumbnail
   *  strip [POD-120] (needs the session to find its issue + input recency). */
  session?: SessionMeta
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  // Callback ref, not useRef: the overlay measurement has to re-run the moment
  // the row lands in the DOM, and a plain ref never re-renders to say so.
  const [rowEl, setRowEl] = useState<HTMLDivElement | null>(null)
  const overlayHost = useOfferOverlayHost()
  const overlayBox = useOverlayBox(overlayHost, rowEl, expanded)
  // The input-action awaiting feedback (index into offer.actions), if any.
  const [pending, setPending] = useState<number | null>(null)
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState<number | null>(null)
  const [dismissPhase, setDismissPhase] = useState<DismissPhase>('visible')
  const [error, setError] = useState<string | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const mounted = useRef(true)
  const currentOfferAt = useRef(offer.createdAt)
  const previousOfferAt = useRef(offer.createdAt)
  currentOfferAt.current = offer.createdAt
  const pendingAction = pending === null ? undefined : offer.actions[pending]
  const headline = offer.message.split('\n', 1)[0]
  const detail = offer.message.includes('\n')
    ? offer.message.slice(offer.message.indexOf('\n') + 1)
    : null
  const primaryAction = offer.actions[0]
  const secondaryActions = offer.actions.slice(1)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // This component is intentionally not keyed by the offer: the surrounding
  // composer and native dock stay mounted. A newer timestamp is a new decision
  // and must never inherit the old one's fold, feedback, or undo state.
  useEffect(() => {
    if (previousOfferAt.current === offer.createdAt) return
    previousOfferAt.current = offer.createdAt
    setExpanded(false)
    setPending(null)
    setFeedback('')
    setSubmitting(null)
    setDismissPhase('visible')
    setError(null)
  }, [offer.createdAt])

  const clearDismissTimers = (): void => {
    for (const timer of timers.current) clearTimeout(timer)
    timers.current = []
  }

  const invoke = async (index: number, prompt: string): Promise<void> => {
    if (submitting !== null) return
    const invokedAt = offer.createdAt
    setSubmitting(index)
    setError(null)
    try {
      await onAction(prompt, invokedAt)
      if (currentOfferAt.current === invokedAt) {
        setPending(null)
        setFeedback('')
      }
    } catch {
      if (currentOfferAt.current === invokedAt) {
        setExpanded(true)
        setError('Could not send this action. Try again.')
      }
    } finally {
      if (currentOfferAt.current === invokedAt) setSubmitting(null)
    }
  }

  const chooseAction = (index: number): void => {
    const action = offer.actions[index]
    if (!action) return
    if (action.input === true) {
      setPending(index)
      setExpanded(true)
      setError(null)
      return
    }
    void invoke(index, action.prompt)
  }

  const send = (): void => {
    if (pending === null || !pendingAction || !feedback.trim()) return
    void invoke(pending, composeOfferPrompt(pendingAction.prompt, feedback))
  }

  const commitDismiss = async (): Promise<void> => {
    if (!onDismiss) return
    try {
      await onDismiss(offer.createdAt)
    } catch {
      // A host that optimistically hides the server-backed offer may remount
      // this component itself. Hosts that keep it mounted recover here.
      if (mounted.current) {
        setDismissPhase('visible')
        setExpanded(true)
        setError('Could not dismiss this offer. Try again.')
      }
    }
  }

  const dismiss = (): void => {
    if (!onDismiss || dismissPhase !== 'visible' || submitting !== null) return
    const dismissedAt = offer.createdAt
    clearDismissTimers()
    setExpanded(false)
    setPending(null)
    setFeedback('')
    setError(null)
    setDismissPhase('leaving')
    timers.current = [
      setTimeout(() => {
        if (mounted.current && currentOfferAt.current === dismissedAt) setDismissPhase('undo')
      }, OFFER_EXIT_MS),
      setTimeout(
        () => {
          if (mounted.current && currentOfferAt.current === dismissedAt) {
            setDismissPhase('undo-leaving')
          }
        },
        OFFER_EXIT_MS + OFFER_UNDO_MS - OFFER_UNDO_FADE_MS,
      ),
      setTimeout(() => void commitDismiss(), OFFER_EXIT_MS + OFFER_UNDO_MS),
    ]
  }

  const undoDismiss = (): void => {
    clearDismissTimers()
    setDismissPhase('visible')
  }

  if (dismissPhase === 'undo' || dismissPhase === 'undo-leaving') {
    return (
      <div
        data-testid="offer-undo"
        aria-live="polite"
        className={cn(
          'offer-fold-root offer-fold-undo font-sans',
          dismissPhase === 'undo-leaving' && 'offer-fold-undo--leaving',
        )}
      >
        <span>Offer dismissed</span>
        <button
          data-pressable
          type="button"
          onClick={undoDismiss}
          className="font-medium text-muted-foreground transition-colors hover:text-text-strong"
        >
          Undo
        </button>
      </div>
    )
  }

  const detailId = `offer-detail-${offer.createdAt}`
  // The row is the anchor AND the seat: the overlay panel is placed flush with
  // its edges and rises out of its top edge.
  const overlaid = overlayHost !== null && overlayBox !== null

  const detailBody = (
    <div className="offer-fold-detail-body">
      {detail && (
        <p className="max-w-[132ch] text-[13px] leading-[1.6] whitespace-pre-wrap text-muted-foreground">
          {detail}
        </p>
      )}
      {session && (
        <OfferArtifactStrip
          offer={offer}
          session={session}
          className={detail ? 'mt-2' : undefined}
        />
      )}

      {pendingAction ? (
        <div className="offer-feedback mt-2 flex flex-col gap-1.5" data-testid="offer-feedback">
          <textarea
            // biome-ignore lint/a11y/noAutofocus: the field appears on the user's own click; focus is the expected next step
            autoFocus
            rows={4}
            value={feedback}
            disabled={disabled || submitting !== null}
            placeholder={`${pendingAction.label} — add your feedback…`}
            onChange={(event) => setFeedback(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send()
              if (event.key === 'Escape') setPending(null)
            }}
            className="min-h-24 w-full resize-none rounded-md border border-primary/40 bg-transparent px-2.5 py-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/70"
          />
          <div className="flex gap-1.5">
            <button
              data-pressable
              type="button"
              disabled={disabled || submitting !== null || !feedback.trim()}
              aria-busy={submitting === pending || undefined}
              onClick={send}
              className="rounded-md border border-primary/50 bg-primary/[0.12] px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-primary/20 disabled:cursor-default disabled:opacity-50"
            >
              <OfferActionLabel label={pendingAction.label} pending={submitting === pending} />
            </button>
            <button
              data-pressable
              type="button"
              disabled={submitting !== null}
              onClick={() => {
                setPending(null)
                setFeedback('')
              }}
              className="rounded-md border border-transparent px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        secondaryActions.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-x-[18px] gap-y-2">
            {secondaryActions.map((action, offset) => {
              const index = offset + 1
              return (
                <button
                  data-pressable
                  key={`${action.label}:${action.prompt}`}
                  type="button"
                  disabled={disabled || submitting !== null}
                  aria-busy={submitting === index || undefined}
                  onClick={() => chooseAction(index)}
                  title={action.prompt}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-text-strong disabled:cursor-default disabled:opacity-50"
                >
                  <OfferActionLabel label={action.label} pending={submitting === index} />
                  {action.input === true && <span className="text-[10px] opacity-70">✎</span>}
                </button>
              )
            })}
          </div>
        )
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )

  return (
    <div
      ref={setRowEl}
      data-testid="offer-bar"
      aria-busy={submitting !== null || undefined}
      className={cn(
        'offer-fold-root font-sans',
        overlaid && 'offer-fold-root--overlaid',
        expanded && 'offer-fold-root--expanded',
        dismissPhase === 'leaving' && 'offer-fold-root--leaving',
      )}
    >
      <div className="offer-fold-summary">
        <button
          data-pressable
          data-testid="offer-disclosure"
          type="button"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={() => setExpanded((open) => !open)}
          className="offer-fold-disclosure"
        >
          <span className="offer-fold-signal" aria-hidden="true">
            <Lightbulb size={12} />
          </span>
          <span className="min-w-0 text-left">
            <span className="offer-fold-eyebrow">Offer · needs you</span>
            <span className="offer-fold-title">{headline}</span>
          </span>
        </button>

        {primaryAction && (
          <button
            data-pressable
            data-testid="offer-primary-action"
            type="button"
            disabled={disabled || submitting !== null}
            aria-busy={submitting === 0 || undefined}
            onClick={() => chooseAction(0)}
            title={primaryAction.prompt}
            className="offer-fold-primary btn-primary-rim"
          >
            <OfferActionLabel label={primaryAction.label} pending={submitting === 0} />
            {primaryAction.input === true && <span className="text-[10px] opacity-70">✎</span>}
          </button>
        )}

        <div className="offer-fold-controls">
          {onDismiss && (
            <button
              data-pressable
              data-testid="offer-dismiss"
              type="button"
              disabled={submitting !== null}
              onClick={dismiss}
              aria-label="Dismiss offer"
              title="Dismiss — removes this offer without answering"
              className="offer-fold-icon"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
          <button
            data-pressable
            type="button"
            aria-label={expanded ? 'Hide offer details' : 'Show offer details'}
            title={expanded ? 'Hide details' : 'Show details'}
            aria-expanded={expanded}
            aria-controls={detailId}
            onClick={() => setExpanded((open) => !open)}
            className="offer-fold-icon offer-fold-chevron"
          >
            <ChevronDown size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      {overlaid ? (
        createPortal(
          <div
            data-testid="offer-overlay"
            className={cn('offer-overlay-clip', expanded && 'offer-overlay-clip--open')}
            style={{ left: overlayBox.left, right: overlayBox.right, bottom: overlayBox.bottom }}
          >
            <div
              id={detailId}
              data-testid="offer-detail"
              aria-hidden={!expanded}
              inert={!expanded}
              className="offer-overlay-panel"
            >
              {detailBody}
            </div>
          </div>,
          overlayHost,
        )
      ) : (
        <div
          id={detailId}
          data-testid="offer-detail"
          aria-hidden={!expanded}
          inert={!expanded}
          className="offer-fold-detail"
        >
          <div className="offer-fold-detail-clip">{detailBody}</div>
        </div>
      )}
    </div>
  )
}
