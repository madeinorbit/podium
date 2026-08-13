import type { SessionMeta, SessionOffer } from '@podium/model/browser'
import { Lightbulb, X } from 'lucide-react'
import { type JSX, useState } from 'react'
import { cn } from '@/lib/utils'
import { OfferArtifactStrip } from './OfferArtifactStrip'

/** The user's feedback rides the action's prompt as one turn. */
export const composeOfferPrompt = (prompt: string, feedback: string): string =>
  `${prompt}\n\n${feedback.trim()}`

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
 * Agent action offer bar [spec:SP-c7f1]: the agent's suggested next actions —
 * a freeform message above compact buttons. Shared between ChatView (above the
 * composer) and the native terminal panel (beneath the PTY), so an offer is
 * visible whichever view the session is in. A click hands the button's
 * predefined prompt to the host via `onAction`; sending it as a user turn
 * (sessions.sendText) makes the server clear the offer. An `input` action
 * (agent-declared, e.g. "Send back") first swaps the buttons for a feedback
 * field and sends prompt + feedback together.
 *
 * `onDismiss` is the THIRD answer, and the one the block used to lack: none of
 * these. Until it existed an offer could only leave by being answered or by the
 * conversation moving past it, so a question the operator had already decided
 * against sat in the composer until they typed something else to be rid of it.
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
  // The input-action awaiting feedback (index into offer.actions), if any.
  const [pending, setPending] = useState<number | null>(null)
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState<number | null>(null)
  const [dismissing, setDismissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pendingAction = pending === null ? undefined : offer.actions[pending]

  const invoke = async (index: number, prompt: string): Promise<void> => {
    if (submitting !== null) return
    setSubmitting(index)
    setError(null)
    try {
      await onAction(prompt, offer.createdAt)
      setPending(null)
      setFeedback('')
    } catch {
      setError('Could not send this action. Try again.')
    } finally {
      setSubmitting(null)
    }
  }

  const send = (): void => {
    if (pending === null || !pendingAction || !feedback.trim()) return
    void invoke(pending, composeOfferPrompt(pendingAction.prompt, feedback))
  }

  const dismiss = async (): Promise<void> => {
    if (!onDismiss || dismissing || submitting !== null) return
    setDismissing(true)
    setError(null)
    try {
      await onDismiss(offer.createdAt)
    } catch {
      setError('Could not dismiss this offer. Try again.')
      setDismissing(false)
    }
    // No `finally`: a dismissal that WORKED unmounts this bar, and clearing the
    // flag on the way out would flash the control live again first.
  }

  return (
    <div
      data-testid="offer-bar"
      aria-busy={submitting !== null || undefined}
      // A BLOCK IN THE DOCUMENT, NOT A CARD (POD-725). The offer used to be a
      // yellow-rimmed, yellow-washed panel — three separate yellow signals for
      // one request. The design spends the yellow once, on the button the
      // operator is meant to press, and asks the rest of the block to earn its
      // weight typographically: an ochre eyebrow, a headline set larger than any
      // prose above it, and a rule marking where the answer ended and the
      // question began. That is also what lets the offer sit unchanged in the
      // chat document, in the native dock and in the issue panel — it brings no
      // surface of its own to argue with theirs.
      // font-sans explicitly: the composer region it usually renders inside is
      // mono end to end (the CLI prompt idiom, POD-159), and an offer is prose —
      // a question in monospace reads as machine output rather than as someone
      // asking you something.
      className="border-t border-hairline-soft pt-4 font-sans"
    >
      <div className="flex items-baseline gap-2 font-mono shell-type-micro tracking-[0.16em] text-attention uppercase">
        <Lightbulb size={11} aria-hidden="true" className="self-center" />
        Offer · needs you
        {/* THE DECLINE, AT THE EYEBROW'S FAR END. It belongs on the label row
            and not among the actions: the buttons are answers to the question,
            and this is the one control that says the question does not need
            one. Faint, and it takes no accent — an offer's single yellow is
            spent on the action the operator is meant to press, so a dismissal
            that also wore attention ink would be arguing with it.
            NOT gated on `disabled`, unlike every button below it: `disabled`
            means this session cannot take a turn — exited and unresumable —
            and that is exactly the case where an offer would otherwise stand
            forever, unanswerable and with no way out. */}
        {onDismiss && (
          <button
            data-pressable
            data-testid="offer-dismiss"
            type="button"
            disabled={dismissing || submitting !== null}
            onClick={() => void dismiss()}
            aria-label="Dismiss offer"
            title="Dismiss — takes it off every surface without answering"
            className="-my-1 ml-auto self-center rounded p-1 text-text-faint transition-colors hover:text-text-strong disabled:cursor-default disabled:opacity-50"
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      {/* First line = the five-second headline; the rest is supporting detail. */}
      <div className="mt-2.5 text-[15px] leading-[1.5] font-semibold text-text-strong">
        {offer.message.split('\n', 1)[0]}
      </div>
      {offer.message.includes('\n') && (
        <div className="mt-1.5 max-w-[132ch] text-[13px] leading-[1.6] whitespace-pre-wrap text-muted-foreground">
          {offer.message.slice(offer.message.indexOf('\n') + 1)}
        </div>
      )}
      {session && <OfferArtifactStrip offer={offer} session={session} className="mt-2" />}
      {pendingAction ? (
        <div className="offer-feedback mt-2 flex flex-col gap-1.5" data-testid="offer-feedback">
          <textarea
            // biome-ignore lint/a11y/noAutofocus: the field appears on the user's own click; focus is the expected next step
            autoFocus
            rows={4}
            value={feedback}
            disabled={disabled || submitting !== null}
            placeholder={`${pendingAction.label} — add your feedback…`}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
              if (e.key === 'Escape') setPending(null)
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
        offer.actions.length > 0 && (
          <div className="mt-3.5 flex flex-wrap items-center gap-x-[18px] gap-y-2">
            {offer.actions.map((action, ai) => (
              <button
                data-pressable
                key={`${action.label}:${action.prompt}`}
                type="button"
                disabled={disabled || submitting !== null}
                aria-busy={submitting === ai || undefined}
                onClick={() =>
                  action.input === true ? setPending(ai) : void invoke(ai, action.prompt)
                }
                title={action.prompt}
                className={cn(
                  'inline-flex items-center gap-1.5 text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-50',
                  // ONE BUTTON, THEN ALTERNATIVES. The recommended action is the
                  // only filled object; every other action is plain text at the
                  // same size. Outlined runners-up made a row of near-equal
                  // buttons, which is precisely the "which of these do I press"
                  // the recommendation exists to answer — and on a white sheet
                  // three outlines read louder than the one fill they flank.
                  ai === 0
                    ? 'btn-primary-rim rounded-lg border bg-primary px-4 py-2 leading-none font-semibold text-primary-foreground hover:opacity-85'
                    : 'text-muted-foreground hover:text-text-strong',
                )}
              >
                <OfferActionLabel label={action.label} pending={submitting === ai} />
                {action.input === true && <span className="text-[10px] opacity-70">✎</span>}
              </button>
            ))}
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
}
