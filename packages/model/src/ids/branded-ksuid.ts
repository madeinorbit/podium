/**
 * Branded ids — a Stripe-style prefix, an underscore, and the 27 characters of a
 * {@link ksuid} [spec, hosted sign-in §9.1]. `mem_0ujtsYcgvSTl8PAuAdqWYSMnLOv`.
 *
 * The prefix is part of the STORED value, not a display convention, and that is
 * the whole point: an id in a log line, a URL or a support ticket says which
 * table it came from, and a value from the wrong table fails at the boundary
 * instead of selecting nothing three layers down. Two 27-character bodies are
 * indistinguishable; `mem_` and `inv_` are not.
 *
 * WHAT IS HERE AND WHAT IS IN `brands.ts`. This module is the mechanism: the
 * prefix rule, the mint, the parser, and the zod schema factory. A BRAND — the
 * compile-time name, its schema and its `as…` cast — belongs in `brands.ts` and
 * nowhere else, as that file's header says; `MemberId` and `InviteId` are built
 * there out of {@link brandedIdSchema} and {@link mintBrandedId}.
 *
 * THE PREFIX RULE, from §9.1: two or three lowercase letters, four only for the
 * rare ones, then an underscore. {@link mintBrandedId} enforces it, so a prefix
 * that arrives as data cannot put a malformed id in a column. §9.1's table is
 * authoritative and spans both stores; {@link ID_PREFIXES} holds only the two
 * this repo owns, because the rest name Postgres rows in podium-cloud's platform
 * package — which builds them from the same two functions rather than a second
 * id scheme.
 *
 * NOT FOR MACHINES. §9.1 keeps machine ids as the UUIDs they are: the id lives
 * in every daemon's own local file, so a rename would have to touch every
 * machine. {@link MachineId} is unchanged and stays unbranded by prefix.
 */

import { z } from 'zod'
import type { Instant } from '../clock'
import { isKsuid, KSUID_LENGTH, ksuid, ksuidInstant } from './ksuid'

/**
 * A prefix, as a type: the trailing underscore is part of it, so the prefix and
 * the separator can never be spelled apart at a call site. The rest of §9.1's
 * rule is a runtime check — see {@link mintBrandedId}.
 */
export type IdPrefix = `${string}_`

/** §9.1: two or three letters, four for the rare ones, then the underscore. */
const PREFIX_SHAPE = /^[a-z]{2,4}_$/

/**
 * The prefixes this repo mints, by model. The workspace member and the workspace
 * invite are the SQLite-side rows of §9.1's table; everything else in it is a
 * Postgres row owned by podium-cloud's platform package.
 */
export const ID_PREFIXES = {
  member: 'mem_',
  invite: 'inv_',
} as const satisfies Record<string, IdPrefix>

/** A model this repo mints branded ids for. */
export type IdModel = keyof typeof ID_PREFIXES

const requirePrefix = (prefix: IdPrefix): IdPrefix => {
  if (!PREFIX_SHAPE.test(prefix)) {
    throw new Error(
      `${JSON.stringify(prefix)} is not a valid id prefix: two to four lowercase letters and an underscore (§9.1)`,
    )
  }
  return prefix
}

/**
 * Mint a branded id. `at` defaults to now and exists so a caller can be
 * deterministic — see `ksuid.ts`'s header on why the nondeterminism is a
 * parameter in a package that otherwise takes its clock as an argument.
 */
export function mintBrandedId(prefix: IdPrefix, at?: Instant): string {
  return `${requirePrefix(prefix)}${ksuid(at)}`
}

/**
 * Take an id of UNKNOWN kind apart — the reader's half of "the id says what it
 * is", for a log line or a support ticket whose prefix this build may not mint.
 * Null when the value is not a branded id at all, so an unrecognised prefix is
 * never returned as if it had been understood (`keys.ts`'s fails-closed rule).
 */
export function splitBrandedId(value: string): { prefix: IdPrefix; ksuid: string } | null {
  if (value.length <= KSUID_LENGTH) return null
  const body = value.slice(-KSUID_LENGTH)
  const prefix = value.slice(0, value.length - KSUID_LENGTH)
  if (!PREFIX_SHAPE.test(prefix) || !isKsuid(body)) return null
  return { prefix: prefix as IdPrefix, ksuid: body }
}

/** Is this an id of this kind? The non-throwing half of {@link parseBrandedId}. */
export function isBrandedId(prefix: IdPrefix, value: string): boolean {
  return splitBrandedId(value)?.prefix === requirePrefix(prefix)
}

/**
 * Take apart an id that must be of this kind, and say when it is not. An id from
 * another table is refused by its prefix, which is the only thing that can tell
 * two 27-character bodies apart — the check invite-and-claim (A4) rests on.
 *
 * Throws rather than returning null, for the reason `keys.ts` gives: a parser
 * that hands back a partly-understood value lets the caller act on a lie about
 * which id space it is in.
 */
export function parseBrandedId(
  prefix: IdPrefix,
  value: string,
): { prefix: IdPrefix; ksuid: string; at: Instant } {
  const expected = requirePrefix(prefix)
  const split = splitBrandedId(value)
  if (!split || split.prefix !== expected) {
    const got = split ? `${split.prefix} id` : JSON.stringify(value)
    throw new Error(`parseBrandedId: expected ${expected} id, got ${got}`)
  }
  return { ...split, at: ksuidInstant(split.ksuid) }
}

/**
 * The validating boundary schema for one prefix, for `brands.ts` to brand. It
 * checks the whole value — prefix, alphabet, width and that the body is twenty
 * bytes a mint could have produced — because a branded id is the one id family
 * in this package whose SHAPE is ours to know (contrast {@link MachineId}, whose
 * shape each machine decides).
 */
export const brandedIdSchema = (prefix: IdPrefix) =>
  z.string().refine((value) => isBrandedId(prefix, value), {
    message: `not a ${requirePrefix(prefix)} id: expected the prefix and ${KSUID_LENGTH} base62 characters`,
  })
