import { Lightbulb } from 'lucide-react'
import type { JSX } from 'react'
import type { SessionOffer } from '@podium/protocol'

/**
 * Agent action offer bar [spec:SP-c7f1]: the agent's suggested next actions —
 * a freeform message above compact buttons. Shared between ChatView (above the
 * composer) and the native terminal panel (beneath the PTY), so an offer is
 * visible whichever view the session is in. A click hands the button's
 * predefined prompt to the host via `onAction`; sending it as a user turn
 * (sessions.sendText) makes the server clear the offer.
 */
export function OfferBar({
  offer,
  disabled,
  onAction,
}: {
  offer: SessionOffer
  disabled: boolean
  onAction: (prompt: string, offerCreatedAt: string) => void
}): JSX.Element {
  return (
    <div
      data-testid="offer-bar"
      className="rounded-xl border border-primary/40 bg-primary/[0.06] px-3 py-2"
    >
      <div className="flex items-start gap-1.5 text-xs text-foreground">
        <Lightbulb size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-primary" />
        <span className="whitespace-pre-wrap">{offer.message}</span>
      </div>
      {offer.actions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {offer.actions.map((action, ai) => (
            <button
              key={`${action.label}-${ai}`}
              type="button"
              disabled={disabled}
              onClick={() => onAction(action.prompt, offer.createdAt)}
              title={action.prompt}
              className="rounded-md border border-primary/50 bg-primary/[0.12] px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-primary/20 disabled:cursor-default disabled:opacity-50"
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
