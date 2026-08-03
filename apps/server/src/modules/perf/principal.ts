/**
 * THE PERF ATTRIBUTION KEY — one derivation, so every site moves together
 * [POD-736].
 *
 * ---------------------------------------------------------------------------
 * WHY A DIGEST AND NOT THE PRINCIPAL ID
 * ---------------------------------------------------------------------------
 *
 * `principalRoutingId` spells an agent principal as `agent:<agentIdentity>:<delegation>`.
 * An agent identity and a delegation ref are both content from somebody's slice
 * is content from somebody's slice, and `perf.snapshot` is a deployment-wide
 * read — so keying the partitions by the raw id would put one principal's
 * identifiers into another principal's read, which is exactly the leak
 * `docs/multi-user-readiness.md` §3.1 forbids and exactly the thing this harness
 * must not become while measuring the harm away.
 *
 * The digest is a plain SHA-256 prefix rather than a salted one, and the reason
 * is a measurement property rather than laziness: the A/B this harness exists to
 * support compares the SAME principal across two runs of the server, and a
 * per-process salt would give that principal a different key in each arm — the
 * comparison would silently become cross-principal, which the issue's own
 * acceptance criterion treats as invalid. Principal ids are unguessable
 * (session uuids, and the device-grade constant), so the digest is not an
 * enumeration surface; if per-user login ever makes an id guessable, THAT is the
 * moment to salt it, and this paragraph is the note saying so.
 *
 * `kind` stays in the clear: it is a property of the transport that produced the
 * principal, not of a person, and an operator reading a partition table needs to
 * know whether they are looking at a human's connection or an agent's.
 *
 * ---------------------------------------------------------------------------
 * THE DIMENSION IS DERIVED, NEVER HARD-CODED
 * ---------------------------------------------------------------------------
 *
 * Every site hands this function the live feed principal for the connection or
 * call (from `feedPrincipalOf` on the WS plane, or from `FamilyState.feedPrincipal`
 * on /trpc). The digest therefore tracks whoever the transport authenticated —
 * one shared-password account today, many accounts the day per-user login has
 * more than one row — with no edit at the record sites. Hard-coding a constant
 * here would be the trap this harness paid for once already: a dimension added
 * later cannot be applied to samples already recorded.
 */

import { type Principal, principalRoutingId } from '@podium/protocol'
import { createHash } from 'node:crypto'
import type { PerfPrincipalRef } from '@podium/protocol'

/** Digest length in hex chars. 16 (64 bits) — collision-free at any plausible
 *  principal count, and short enough to read in a report. */
const DIGEST_CHARS = 16

const digestCache = new Map<string, string>()

/**
 * The perf partition key for one feed principal.
 *
 * DERIVED from the principal it is handed, never from a constant: passing
 * `DEVICE_GRADE_PRINCIPAL` here produces the device-grade digest because that IS
 * the principal, not because this function knows about it.
 */
export const perfPrincipal = (principal: Principal): PerfPrincipalRef => {
  // A machine or system principal is not perf-sampled and PerfPrincipalRef has
  // never carried one. REFUSED rather than folded into 'user': widening the wire
  // type would put a kind on a report that no consumer expects, and collapsing
  // it would file a job's samples under a person's partition.
  if (principal.kind !== 'user' && principal.kind !== 'agent') {
    throw new Error(`perfPrincipal: a ${principal.kind} principal is not perf-sampled`)
  }
  const id = principalRoutingId(principal)
  let digest = digestCache.get(id)
  if (digest === undefined) {
    digest = createHash('sha256').update(id).digest('hex').slice(0, DIGEST_CHARS)
    digestCache.set(id, digest)
  }
  return { digest, kind: principal.kind }
}
