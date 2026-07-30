import type { SessionMeta, SessionOffer } from '@podium/model'
import { Lightbulb } from 'lucide-react'
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
        <span className="spb" aria-hidden="true" />
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
 */
export function OfferBar({
  offer,
  disabled,
  onAction,
  session,
}: {
  offer: SessionOffer
  disabled: boolean
  onAction: (prompt: string, offerCreatedAt: string) => Promise<void> | void
  /** When given, the offer's issue-artifact evidence renders as a thumbnail
   *  strip [POD-120] (needs the session to find its issue + input recency). */
  session?: SessionMeta
}): JSX.Element {
  // The input-action awaiting feedback (index into offer.actions), if any.
  const [pending, setPending] = useState<number | null>(null)
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState<number | null>(null)
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

  return (
    <div
      data-testid="offer-bar"
      aria-busy={submitting !== null || undefined}
      className="rounded-[10px] border border-primary/40 bg-primary/[0.05] px-3.5 py-2.5"
    >
      {/* The offer is the turn's single "needs you" surface — it owns the
          signal color while it is live (Flat Field, POD-159). */}
      <div className="mb-1 flex items-baseline gap-2 font-mono text-[8.5px] font-medium tracking-[0.12em] text-primary uppercase">
        <Lightbulb size={11} aria-hidden="true" className="self-center" />
        Offer · needs you
      </div>
      {/* First line = the five-second headline; the rest is supporting detail. */}
      <div className="text-[13px] font-semibold text-foreground">
        {offer.message.split('\n', 1)[0]}
      </div>
      {offer.message.includes('\n') && (
        <div className="mt-0.5 max-w-[132ch] text-xs whitespace-pre-wrap text-muted-foreground">
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
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
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
                  'inline-flex h-[26px] items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-50',
                  // The recommended action renders first and primary; the rest
                  // are quiet outlines so one button reads as the default.
                  ai === 0
                    ? 'bg-primary text-primary-foreground hover:opacity-85'
                    : 'border border-input bg-secondary text-foreground hover:bg-muted',
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
