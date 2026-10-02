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
