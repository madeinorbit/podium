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
/**
 * A uuid actor id shortened to its leading segment, for DENSE rows only.
 *
 * Safe precisely because `actorDisplayId` is already display-only and
 * deliberately non-round-trippable — nothing may compare or gate on it, so
 * showing less of it cannot break a consumer that was never allowed to read it
 * that way. The full value stays in `title`.
 *
 * Only a uuid is shortened. A `user:sole` or a system job NAME is already short
 * and already meaningful, and clipping those would destroy information rather
 * than compress it.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const shortenId = (id: string): string => (UUID_RE.test(id) ? id.slice(0, 8) : id)

export function AttributionPair({
  attribution,
  className,
  compact = false,
}: {
  attribution?: Attribution
  className?: string
  /** Dense single-line rows (the sidebar's session roster): shorten a uuid
   *  actor id so the ON-BEHALF-OF half still fits beside it. Rendered whole, a
   *  uuid consumed the line and evicted the human half — a pair that is present
   *  in the DOM and collapsed to the eye, on exactly the delegated rows the
   *  pair exists to distinguish. */
  compact?: boolean
}): JSX.Element | null {
  if (!attribution) return null
  const { actor, onBehalfOf } = attribution
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-baseline gap-1 text-[11px] text-muted-foreground',
        className,
      )}
      data-testid="attribution-pair"
    >
      {/* BOTH HALVES SHRINK, NEITHER IS PUSHED OFF (POD-1526). An agent actor's
          id is a full uuid, so in a narrow container the actor half alone
          consumed the line and the on-behalf-of half was clipped out of sight —
          rendering, in effect, a collapsed pair on exactly the delegated rows
          the pair exists to distinguish. `min-w-0` + `truncate` on each half
          makes them ellipsize instead of evict: a shortened id still says WHO,
          whereas an absent half says nothing. Both keep their full value in
          `title`. */}
      <span
        className="min-w-0 truncate"
        data-testid="attribution-actor"
        title={`${actorKindLabel(actor)} — the actor: ${actorDisplayId(actor)}`}
      >
        {compact ? shortenId(actorDisplayId(actor)) : actorDisplayId(actor)}
      </span>
      <span aria-hidden="true" className="flex-none">
        ·
      </span>
      {onBehalfOf === null ? (
        <span
          data-testid="attribution-on-behalf-of"
          className="flex-none italic"
          title="A machine or system job acts for no human (ADR 9 D8 S5)"
        >
          no human
        </span>
      ) : (
        <span
          className="min-w-0 truncate"
          data-testid="attribution-on-behalf-of"
          title={`On behalf of — whose work this is: ${onBehalfOf}`}
        >
          for {onBehalfOf}
        </span>
      )}
    </span>
  )
}
