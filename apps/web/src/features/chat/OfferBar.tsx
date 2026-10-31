import { relativeTime } from '@podium/client-core/focus'
import type { SessionView } from '@podium/client-core/session-values'
import type { SessionOffer } from '@podium/model/browser'
import { ChevronDown, Pencil, X } from 'lucide-react'
import { type JSX, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTipAnchorVisible, useTipMoment, useTipUnseen } from '@/features/tips'
import { useClock } from '@/lib/clock-hooks'
import { cn } from '@/lib/utils'
import { OfferArtifactStrip } from './OfferArtifactStrip'
import { OfferText } from './OfferText'
import { useOfferDismissal } from './offer-dismissal'
import { chargeSeat, useOfferLift } from './offer-lift'

/** The user's feedback rides the action's prompt as one turn. */
export const composeOfferPrompt = (prompt: string, feedback: string): string =>
  `${prompt}\n\n${feedback.trim()}`

/**
 * Publish the open fold's height to the lifting host (POD-1068).
 *
 * The number IS the animation: the seat's negative top margin, the lifted
 * region's transform, and the fold's own height all read `--offer-lift` and
 * transition to it together, so the pane above rides up by exactly the pixels
 * the detail took. It is capped at the room the host will give, and the detail
 * scrolls inside whatever is left over.
 *
 * Returns whether this host lifts at all, and whether the detail was capped —
 * the only two things here worth a render.
 */
function useOfferFoldLift(
  body: HTMLElement | null,
  expanded: boolean,
): { lifted: boolean; capped: boolean } {
  const lift = useOfferLift()
  const [capped, setCapped] = useState(false)
  // This bar's identity with the host, so a second bar for the same offer (chat
  // mode keeps the native dock mounted) cannot overwrite this one's claim.
  const claim = useRef({})
  // Layout effect: the height must be published in the same frame the fold is
  // marked open, or the first open animates from a stale (zero) lift.
  useLayoutEffect(() => {
    if (!lift) return
    const publishLift = (px: number): void => {
      lift.setLift(claim.current, px)
      chargeSeat(body, px)
    }
    const close = (): void => {
      publishLift(0)
      setCapped(false)
    }
    if (!expanded || !body) {
      close()
      return
    }
    const publish = (): void => {
      // The body keeps its natural height however small the clip around it is,
      // so this measures what the fold WANTS, not what it currently shows.
      const wanted = body.offsetHeight
      const room = lift.room()
      // A hidden pane measures zero; a lift of zero there would leave a stale
      // open fold showing nothing when the pane comes back.
      if (wanted === 0) return
      setCapped(wanted > room)
      publishLift(Math.min(wanted, room))
    }
    publish()
    const stopWatchingRoom = lift.watchRoom(publish)
    if (typeof ResizeObserver === 'undefined') {
      return () => {
        stopWatchingRoom()
        close()
      }
    }
    // The detail grows on its own while open — the feedback field appears, an
    // error lands under it — and the lift has to follow it.
    const observer = new ResizeObserver(publish)
    observer.observe(body)
    return () => {
      observer.disconnect()
      stopWatchingRoom()
      close()
    }
  }, [body, expanded, lift])
  return { lifted: lift !== null, capped }
}

/**
 * First Flights moment 6 (first-offer): the first offer card this person sees.
 *
 * A bar can be mounted where nobody sees it (the native dock stays mounted,
 * clipped shut, in chat mode), so each bar has its own anchor name and only a
 * bar that is fully on screen is eligible. "Fully" also waits out the dock's
 * opening fold: the tip lands on the settled card, never mid-animation.
 * Card 2 anchors the task's sidebar row (`task-row:<id>`, WorkRowShell).
 */
function useFirstOfferTip(card: HTMLElement | null, issueId: string | null | undefined): string {
  const anchor = `first-offer-${useId()}`
  // Watch only while the moment can still show; the registration stays for replay.
  const onScreen = useTipAnchorVisible(useTipUnseen('first-offer') ? card : null)
  useTipMoment('first-offer', {
    active: onScreen,
    cards: [
      {
        anchor,
        title: 'Your next move.',
        body: 'When an agent is done, it suggests what comes next. One tap sends it.',
      },
      ...(issueId
        ? [
            {
              anchor: `task-row:${issueId}`,
              title: 'It waits for you.',
              body: 'Offers stay in your list and on your phone. Answer from anywhere.',
            },
          ]
        : []),
    ],
  })
  return anchor
}

/** The mark on an action that opens the feedback field instead of sending. */
function InputMark(): JSX.Element {
  return <Pencil size={10} aria-hidden="true" className="offer-fold-action-pencil" />
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

/** How long the decision has waited ("8h"). Its own leaf on a minute clock, so
 *  the tick re-renders three characters rather than the card. */
function OfferAge({ since }: { since: string }): JSX.Element | null {
  const now = useClock(60_000)
  const age = relativeTime(since, now).replace(/ ago$/, '')
  if (!age) return null
  return <span className="offer-card-age"> · {age === 'just now' ? 'now' : age}</span>
}

/**
 * Agent action offer [spec:SP-c7f1]. THE ONE PLACE "NEEDS YOU" IS SAID
 * (POD-2076): a card whose header reads "Needs your decision · 8h", then the
 * headline, the body, the evidence, and every action in one row — the
 * recommendation filled, the alternatives outlined. The chevron collapses the
 * card to its header and headline.
 *
 * The evidence ({@link OfferArtifactStrip}) sits in the card's own flow, between
 * the text and the actions, because it is what the decision is judged on: the
 * user reads the claim, looks at the proof, then answers, top to bottom. Only
 * what the user asked for opens in the fold below (the lifted reveal): an input
 * action's feedback field, and an error that needs a retry.
 *
 * Dismissal is deliberately recoverable. The offer leaves immediately, an
 * Undo row remains for ten seconds, and only after that window does onDismiss
 * clear it on the server. That delay is the only way to offer a real undo: the
 * server operation is intentionally global and has no restore counterpart.
 * The window is held by {@link useOfferDismissal} rather than by this component,
 * so the panel's OTHER bar for the same offer leaves on the same click instead
 * of ten seconds later (POD-1103).
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
  /** When given, the offer's issue-artifact evidence renders as a row of tiles
   *  [POD-120] (needs the session to find its issue + input recency). */
  session?: Pick<SessionView, 'sessionId' | 'issueId' | 'lastInputAt'>
}): JSX.Element {
  // `collapsed` is the card itself folded down to its header and headline.
  const [collapsed, setCollapsed] = useState(false)
  // Callback ref, not useRef: the fold has to be measured the moment its body
  // lands in the DOM, and a plain ref never re-renders to say so.
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null)
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null)
  const tipAnchor = useFirstOfferTip(cardEl, session?.issueId)
  // The input-action awaiting feedback (index into offer.actions), if any.
  const [pending, setPending] = useState<number | null>(null)
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState<number | null>(null)
  const dismissal = useOfferDismissal(offer.createdAt)
  const dismissPhase = dismissal.phase
  const [error, setError] = useState<string | null>(null)
  // The FOLD is open exactly while it has something to show, a feedback field
  // or an error, so clearing the last of them (Escape, Cancel, a send) closes
  // it and an empty fold can never hold a lift.
  const expanded = pending !== null || error !== null
  const { lifted, capped } = useOfferFoldLift(bodyEl, expanded)
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
  // and must never inherit the old one's fold, feedback, or undo state. (The
  // dismissal phase needs no reset here — it is keyed by stamp in its host.)
  useEffect(() => {
    if (previousOfferAt.current === offer.createdAt) return
    previousOfferAt.current = offer.createdAt
    setCollapsed(false)
    setPending(null)
    setFeedback('')
    setSubmitting(null)
    setError(null)
  }, [offer.createdAt])

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
      setError(null)
      return
    }
    void invoke(index, action.prompt)
  }

  const send = (): void => {
    if (pending === null || !pendingAction || !feedback.trim()) return
    void invoke(pending, composeOfferPrompt(pendingAction.prompt, feedback))
  }

  /** Runs when the undo window closes. Rethrows so the host restores the offer
   *  on every bar; the message is this bar's own, since this is the one the
   *  operator clicked. */
  const commitDismiss = async (): Promise<void> => {
    if (!onDismiss) return
    try {
      await onDismiss(offer.createdAt)
    } catch (cause) {
      // A host that optimistically hides the server-backed offer may remount
      // this component itself. Hosts that keep it mounted recover here.
      if (mounted.current) {
        setError('Could not dismiss this offer. Try again.')
      }
      throw cause
    }
  }

  const dismiss = (): void => {
    if (!onDismiss || dismissPhase !== 'visible' || submitting !== null) return
    setPending(null)
    setFeedback('')
    setError(null)
    dismissal.begin(commitDismiss)
  }

  const undoDismiss = (): void => {
    dismissal.undo()
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
  const toggleCollapsed = (): void => {
    if (!collapsed) {
      setPending(null)
      setFeedback('')
      setError(null)
    }
    setCollapsed(!collapsed)
  }

  const actionRow = (
    <div className="offer-card-actions">
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
          {primaryAction.input === true && <InputMark />}
        </button>
      )}
      {secondaryActions.map((action, offset) => {
        const index = offset + 1
        return (
          <button
            data-pressable
            data-testid="offer-secondary-action"
            key={`${action.label}:${action.prompt}`}
            type="button"
            disabled={disabled || submitting !== null}
            aria-busy={submitting === index || undefined}
            onClick={() => chooseAction(index)}
            title={action.prompt}
            className="offer-fold-action"
          >
            <OfferActionLabel label={action.label} pending={submitting === index} />
            {action.input === true && <InputMark />}
          </button>
        )
      })}
    </div>
  )

  const detailBody = (
    <div ref={setBodyEl} className="offer-fold-detail-body">
      {pendingAction && (
        <div className="offer-feedback flex flex-col gap-1.5" data-testid="offer-feedback">
          <textarea
            autoFocus
            rows={4}
            value={feedback}
            disabled={disabled || submitting !== null}
            placeholder={`${pendingAction.label}: add your feedback…`}
            onChange={(event) => setFeedback(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send()
              if (event.key === 'Escape') setPending(null)
            }}
            className="min-h-24 w-full resize-none rounded-[7px] border border-border bg-transparent px-2.5 py-2 text-[12.5px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-foreground/30"
          />
          <div className="flex gap-1.5">
            <button
              data-pressable
              type="button"
              disabled={disabled || submitting !== null || !feedback.trim()}
              aria-busy={submitting === pending || undefined}
              onClick={send}
              className="offer-fold-action offer-fold-action--commit"
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
              className="offer-fold-action offer-fold-action--ghost"
            >
              Cancel
            </button>
          </div>
        </div>
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
      ref={setCardEl}
      data-testid="offer-bar"
      data-tip-anchor={tipAnchor}
      aria-busy={submitting !== null || undefined}
      data-collapsed={collapsed ? 'true' : undefined}
      className={cn(
        'offer-fold-root offer-card font-sans',
        lifted && 'offer-fold-root--lifted',
        expanded && 'offer-fold-root--expanded',
        dismissPhase === 'leaving' && 'offer-fold-root--leaving',
      )}
    >
      <div className="offer-card-head">
        <button
          data-pressable
          data-testid="offer-disclosure"
          type="button"
          aria-expanded={!collapsed}
          onClick={toggleCollapsed}
          className="offer-card-heading"
        >
          <span className="offer-card-eyebrow">
            <span className="offer-card-dot" aria-hidden="true" />
            Needs your decision
            <OfferAge since={offer.createdAt} />
          </span>
          <span className="offer-fold-title">{headline}</span>
        </button>
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
              className="offer-fold-icon offer-card-dismiss"
            >
              <X size={13} aria-hidden="true" />
            </button>
          )}
          <button
            data-pressable
            type="button"
            aria-label={collapsed ? 'Show offer' : 'Collapse offer'}
            title={collapsed ? 'Show offer' : 'Collapse'}
            aria-expanded={!collapsed}
            onClick={toggleCollapsed}
            className="offer-fold-icon offer-fold-chevron"
          >
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {detail && <OfferText text={detail} className="offer-card-body" />}
          {session && <OfferArtifactStrip offer={offer} session={session} />}
          {!pendingAction && actionRow}
        </>
      )}

      <div
        id={detailId}
        data-testid="offer-detail"
        aria-hidden={!expanded}
        inert={!expanded}
        className="offer-fold-detail"
      >
        <div className={cn('offer-fold-detail-clip', capped && 'offer-fold-detail-clip--capped')}>
          {detailBody}
        </div>
      </div>
    </div>
  )
}
