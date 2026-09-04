import { shallowEqual } from '@podium/client-core/store'
import { pendingInteractionCards } from '@podium/client-core/viewmodels'
import type { SessionId } from '@podium/model/browser'
import type { PendingInteractionWire } from '@podium/protocol'
import { OctagonAlert } from 'lucide-react'
import { type JSX, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { cn } from '@/lib/utils'

/**
 * THE BLOCKED-SESSION BAR (POD-2414; spec §4).
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * The PendingInteraction aggregate has been durable, deduped, feed-synced and
 * CLI-answerable since POD-2020, and no shell rendered it. §4's claim is that a
 * blocking ask "renders in the web UI, the Tray, mobile, and any attached CLI
 * simultaneously" — and until something drew it, the aggregate's whole promise
 * ("nothing blocks invisibly") held only for a person who happened to be at a
 * terminal running `podium interactions list`.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT SITS, AND WHY IT IS NOT IN THE FEED
 * ---------------------------------------------------------------------------
 * Above the composer, below the transcript, permanently — not as a transcript
 * row. A row scrolls away, and an ask that scrolled away is the exact failure
 * this is here to fix. It occupies space only while a session is blocked, which
 * is the one moment its space is worth more than the transcript's.
 *
 * ---------------------------------------------------------------------------
 * IT RENDERS WHAT THE VIEWMODEL DECIDED
 * ---------------------------------------------------------------------------
 * Which buttons an ask offers, what the muted line says when it offers none,
 * and which asks the transcript's own AskUserQuestion card renders better are
 * all `pendingInteractionCards`' decisions, shared with mobile. This file is
 * layout, a mutation and an error line.
 */
const NO_ASKS: PendingInteractionWire[] = []

export function PendingInteractionBar({
  sessionId,
  compact,
}: {
  sessionId: SessionId
  compact?: boolean
}): JSX.Element | null {
  const { trpc, rows } = useStoreSelector(
    // `?? NO_ASKS` rather than a bare read, and the constant is module-level so
    // the fallback keeps one identity: a replica whose `pendingInteraction`
    // collection has not arrived yet is a PARTIAL WORLD, not an error, and a
    // bar for blocking asks must never be the reason the transcript beside it
    // fails to render.
    (s) => ({ trpc: s.trpc, rows: s.pendingInteractions ?? NO_ASKS }),
    shallowEqual,
  )
  // Keyed by `${interactionId}:${actionId}` so two bars for one session (chat
  // mode keeps the native dock mounted) cannot disable each other's buttons.
  const [sending, setSending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cards = pendingInteractionCards(rows, sessionId).filter(
    (card) => card.surface === 'aggregate',
  )
  if (cards.length === 0) return null

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 px-3 py-2.5">
      {cards.map((card) => (
        <div
          key={card.id}
          data-testid="pending-interaction"
          data-kind={card.kind}
          className="rounded-md border border-primary/40 bg-primary/[0.06] px-3 py-2.5"
        >
          <div className="flex items-start gap-2">
            <OctagonAlert size={14} aria-hidden="true" className="mt-[3px] shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {card.title}
              </div>
              <p
                className={cn(
                  'mt-0.5 whitespace-pre-wrap text-[13px] leading-[1.5] text-foreground',
                  // A plan or an overflow prompt can be long; the bar must not
                  // grow without bound or it eats the transcript it sits under.
                  'max-h-[9lh] overflow-y-auto',
                )}
              >
                {card.detail}
              </p>
              {card.note !== undefined && (
                <p className="mt-1 text-xs text-muted-foreground">{card.note}</p>
              )}
              {card.actions.length > 0 && (
                <div className={cn('mt-2 flex flex-wrap gap-1.5', compact && 'gap-1')}>
                  {card.actions.map((action) => {
                    const key = `${card.id}:${action.id}`
                    return (
                      <button
                        data-pressable
                        key={action.id}
                        type="button"
                        data-testid={`pending-interaction-action-${action.id}`}
                        disabled={sending !== null}
                        className={cn(
                          'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-50',
                          action.tone === 'primary' &&
                            'border-primary/50 bg-primary/[0.12] text-foreground hover:bg-primary/20',
                          action.tone === 'danger' &&
                            'border-destructive/40 text-destructive hover:bg-destructive/10',
                          action.tone === 'neutral' &&
                            'border-input text-muted-foreground hover:text-foreground',
                        )}
                        onClick={async () => {
                          if (sending !== null) return
                          setSending(key)
                          setError(null)
                          try {
                            // The ROW DISAPPEARS on success: the feed carries the
                            // open set only, so a resolved ask is removed and this
                            // bar unmounts. There is nothing optimistic to draw.
                            await trpc.interactions.answer.mutate({
                              id: card.id,
                              answer: action.answer,
                            })
                          } catch (cause) {
                            setError(
                              cause instanceof Error
                                ? cause.message
                                : 'Could not send that answer. Try again.',
                            )
                          } finally {
                            setSending(null)
                          }
                        }}
                      >
                        {action.label}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
