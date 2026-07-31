import { z } from 'zod'

/**
 * Cross-entity primitive field schemas. Entity vocabularies (issue, session, …)
 * build their field groups out of these so a primitive's meaning is defined once.
 *
 * PORTED FROM MAIN at the POD-1246 catch-up (main's `packages/model/src/fields.ts`,
 * POD-791). Both branches invented `packages/model` independently; integration's
 * is the structural destination (ADR 8 D4's domain→model rename+absorb, which
 * main's own model README declared and integration completed), but these two
 * symbols existed ONLY on main and are load-bearing — `Revision` is the
 * expected-revision token the issues concurrency contract is written against.
 */

/**
 * THE clock representation [ADR 4 D3, rejected alternative "ISO and epoch dual
 * semantics in model"; POD-299 "collapse twin predicate families to one clock
 * representation; adapters at edges"].
 *
 * An instant, encoded as an ISO-8601 string. ISO (not epoch-ms) is the canonical
 * form because every timestamp in the issue vocabulary is already an ISO string
 * in both `IssueRow` and `IssueWire` today, so the Issues cutover needs no clock
 * adapter at all. Representations that speak epoch-ms convert at their own edge.
 *
 * NOT the same thing as `clock.ts`'s `Instant`, and the two are not rivals:
 * `Instant` is the RUNTIME representation (epoch-ms) with `toInstant`/`toIso`
 * adapters at the edges; `Timestamp` is the FIELD SCHEMA a vocabulary composes
 * from. Integration's field groups currently inline `z.string()` at each `*At`
 * field — precisely the restatement this symbol exists to collapse. Migrating
 * those call sites onto it is deliberate follow-up work, not a merge edit.
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
 *
 * Distinct also from `fields/change.ts`'s `ChangeRevisionField`, which is
 * NONNEGATIVE because it counts a position in the change stream. This one is
 * POSITIVE: an entity that exists has been written at least once. Do not merge
 * the two — they answer different questions and disagree about `0`.
 */
export const Revision = z.number().int().positive()
export type Revision = z.infer<typeof Revision>
