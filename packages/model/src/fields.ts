import { z } from 'zod'

/**
 * Cross-entity primitive field schemas. Entity vocabularies (issue, session, …)
 * build their field groups out of these so a primitive's meaning is defined once.
 */

/**
 * THE clock representation [ADR 4 D3, rejected alternative "ISO and epoch dual
 * semantics in model"; POD-299 "collapse twin predicate families to one clock
 * representation; adapters at edges"].
 *
 * An instant, encoded as an ISO-8601 string. ISO (not epoch-ms) is the canonical
 * form because every timestamp in the issue vocabulary is already an ISO string
 * in both `IssueRow` and `IssueWire` today, so the Issues cutover needs no clock
 * adapter at all. Representations that speak epoch-ms (e.g. `SessionRow`'s
 * `lastOutputAt` / `lastInputAt` / `lastResumedAt`) convert at their own edge
 * when the session vocabulary lands — that is what "adapters at edges" means.
 *
 * Because this is ONE named schema rather than 20 inline `z.string()`s, changing
 * the canonical clock later is a single edit here, not a scavenger hunt. That is
 * the whole point of the vocabulary.
 *
 * NOT validated as a strict datetime: existing rows are written by many call
 * sites and a stricter schema here would reject durable data this slice does not
 * own. Tightening is a deliberate later decision, made in one place.
 */
export const Timestamp = z.string()
export type Timestamp = z.infer<typeof Timestamp>

/**
 * The entity revision token [ADR 2 D3]. A monotonic integer, assigned by the
 * authority on every accepted write, carried on the durable row and on the wire
 * projection. It answers "is my write based on current truth?" — commands echo
 * it back as `expectedRevision`.
 *
 * Authority-assigned and OPAQUE to replicas: a replica never computes it,
 * compares it for truth, or arbitrates on it. Distinct from the feed cursor
 * `(feedId, epoch, seq)`, which answers "where am I in the stream?" and is the
 * transport's concern, not the entity's.
 */
export const Revision = z.number().int().positive()
export type Revision = z.infer<typeof Revision>
