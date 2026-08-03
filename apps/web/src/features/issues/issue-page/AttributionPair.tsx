/**
 * ATTRIBUTION IS A PAIR, AND THE CLIENT ONLY EVER READS IT (POD-646).
 *
 * Per docs/multi-user-readiness.md §3.1.3 A3 every write records ACTOR (which
 * agent, person, machine or job) and ON-BEHALF-OF (which human), and both are
 * stamped by the authority from the authenticated transport — ADR 3 D7 —
 * precisely so "did a person or an agent do this?" stays answerable. This
 * component renders that pair from those server fields and NOTHING else. It
 * never infers the actor from a session id it happens to have, never fills
 * `onBehalfOf` in from the row's owner, and never synthesises either half when
 * one is missing.
 *
 * The asymmetry between the two halves is deliberate upstream and is preserved
 * here: `onBehalfOf` is NULLABLE, not optional. `null` means "there is no human
 * behind this" — true for a machine observation and for a system job (§ADR 9 D8
 * S5 forbids defaulting it to an operator or to the owner) — and is rendered as
 * a named absence rather than dropped, because "no human" and "nobody threaded
 * the value" are different facts and only the first is representable.
 *
 * Work an agent did is OWNED by its delegating human (A4), so the on-behalf-of
 * half is also the answer to "whose work is this?" — which is why it is shown
 * next to the actor rather than behind a hover.
 */
import { type Attribution, actorDisplayId } from '@podium/model'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'

/** The human-facing noun for each actor arm. Kept next to the rendering rather
 *  than in a shared map: `actorDisplayId` deliberately discards `kind`, so the
 *  only correct way to say what an actor IS is to branch on the union here. */
function actorKindLabel(actor: Attribution['actor']): string {
  switch (actor.kind) {
    case 'user':
      return 'person'
    case 'agent':
      return 'agent'
    case 'machine':
      return 'machine'
    case 'system':
      return 'system job'
  }
}

/**
 * `<actor> · for <human>` — both halves, always, from `attribution` alone.
 *
 * Renders nothing when the pair itself is absent: an entity whose projection
 * does not carry attribution has not told us who acted, and inventing "unknown ·
 * for you" would be exactly the synthesis A3 forbids.
 */
export function AttributionPair({
  attribution,
  className,
}: {
  attribution?: Attribution
  className?: string
}): JSX.Element | null {
  if (!attribution) return null
  const { actor, onBehalfOf } = attribution
  return (
    <span
      className={cn(
        'inline-flex items-baseline gap-1 text-[11px] text-muted-foreground',
        className,
      )}
      data-testid="attribution-pair"
    >
      <span data-testid="attribution-actor" title={`${actorKindLabel(actor)} — the actor`}>
        {actorDisplayId(actor)}
      </span>
      <span aria-hidden="true">·</span>
      {onBehalfOf === null ? (
        <span
          data-testid="attribution-on-behalf-of"
          className="italic"
          title="A machine or system job acts for no human (ADR 9 D8 S5)"
        >
          no human
        </span>
      ) : (
        <span data-testid="attribution-on-behalf-of" title="On behalf of — whose work this is">
          for {onBehalfOf}
        </span>
      )}
    </span>
  )
}
