/**
 * THE PERF ATTRIBUTION KEY — one derivation, so every site moves together
 * [POD-736].
 *
 * ---------------------------------------------------------------------------
 * WHY A DIGEST AND NOT THE PRINCIPAL ID
 * ---------------------------------------------------------------------------
 *
 * `principalIdOf` spells an agent principal as `agent:<sessionId>`. A session id
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
 * WHAT `DEVICE_GRADE_PRINCIPAL` MEANS FOR THE DIMENSION TODAY
 * ---------------------------------------------------------------------------
 *
 * `gateway/client-principal.ts` maps EVERY client connection to the one
 * device-grade feed principal, because one shared password cannot tell two people
 * apart. So today the partition table has exactly one entry and the principal
 * dimension is, in effect, constant.
 *
 * That is not a reason to leave the dimension out, and it is the trap this run
 * has paid for repeatedly: a dimension added later cannot be applied to samples
 * already recorded, so the FIRST post-login measurement would have nothing valid
 * to compare against. The dimension is derived from the real feed principal at
 * every site — never hard-coded to the device-grade constant — so the day
 * `feedPrincipalOf` stops being a constant, every recorded sample partitions
 * correctly with no edit here.
 */

import { createHash } from 'node:crypto'
import type { PerfPrincipalRef } from '@podium/protocol'
import { type FeedPrincipal, principalIdOf } from '@podium/sync'

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
export const perfPrincipal = (principal: FeedPrincipal): PerfPrincipalRef => {
  const id = principalIdOf(principal)
  let digest = digestCache.get(id)
  if (digest === undefined) {
    digest = createHash('sha256').update(id).digest('hex').slice(0, DIGEST_CHARS)
    digestCache.set(id, digest)
  }
  return { digest, kind: principal.kind }
}
