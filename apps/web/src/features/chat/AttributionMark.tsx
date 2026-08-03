import type { TranscriptAttribution } from '@podium/client-core/viewmodels'
import type { JSX } from 'react'

/**
 * THE ATTRIBUTION PAIR ON A TRANSCRIPT ROW (POD-405).
 *
 * Doc §3.1.3 A3: every act records ACTOR (which agent) and ON-BEHALF-OF (which
 * human), both stamped by the authority from the authenticated transport. The UI
 * READS the pair. It never infers a half, never defaults one to the signed-in
 * user, and never sends either back.
 *
 * THE THREE-VALUED ON-BEHALF-OF IS RENDERED AS THREE THINGS, NOT TWO:
 *
 *  - a name        → "on behalf of <name>";
 *  - `null`        → no human behind it (a system act) — stated, not blank;
 *  - `undefined`   → this deployment does not carry the half yet (POD-1075 adds
 *                    it to `SessionMeta`). Rendered as nothing at all, because
 *                    "unknown" and "nobody" are different claims and printing
 *                    the second for the first would be a lie the UI invented.
 *
 * Both halves also ride as data attributes, which is what lets a test assert the
 * PAIR rather than a rendered sentence, and what makes the half light up the day
 * the wire carries it without this component changing.
 */
export function AttributionMark({
  attribution,
  className,
}: {
  attribution: TranscriptAttribution
  className?: string
}): JSX.Element {
  const { actorKind, actorId, onBehalfOf } = attribution
  const behalf =
    onBehalfOf === undefined
      ? null
      : onBehalfOf === null
        ? 'no delegating human'
        : `on behalf of ${onBehalfOf}`
  return (
    <span
      className={className}
      data-attribution
      data-actor-kind={actorKind}
      data-actor={actorId ?? ''}
      // Empty vs absent is deliberate: '' is "carried, and there is no human";
      // the attribute is absent entirely when the wire does not carry the half.
      {...(onBehalfOf !== undefined ? { 'data-on-behalf-of': onBehalfOf ?? '' } : {})}
      title={[actorId, behalf].filter(Boolean).join(' — ') || undefined}
    >
      {behalf && <span className="chat-ctx">· {behalf}</span>}
    </span>
  )
}
