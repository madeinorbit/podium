/**
 * KSUID — the 20-byte, 27-character sortable identifier the branded ids in
 * {@link file://./branded-ksuid.ts} are built from [spec, hosted sign-in §9.1].
 *
 * Four big-endian bytes of epoch seconds, sixteen random bytes, base62 with the
 * digits-uppercase-lowercase alphabet, left-padded to a FIXED 27 characters.
 * The three properties that buys, and that this module owes its callers:
 *
 *   1. **Lexicographic order is creation order.** The alphabet is in ASCII
 *      order and the width is fixed, so string comparison, `ORDER BY id` and a
 *      B-tree walk all agree with the clock. `keys.ts`'s sort-order argument
 *      for composite keys is the same one.
 *   2. **Index locality.** Rows minted in the same minute share a prefix, so an
 *      index on the id stays hot where a UUIDv4 scatters.
 *   3. **The id says what it is.** That half lives in `branded-ksuid.ts`: this
 *      module emits the 27 characters, the prefix is glued on there.
 *
 * WHY OURS AND NOT A LIBRARY. `packages/model` is the L0 root and zod is the
 * only dependency it may ever have (see this package's `package.json`), so a
 * KSUID dependency here is not available at any price. The cost of writing it
 * is one encoding to get right, and `ksuid.test.ts` pins that encoding against
 * the reference implementation's own published vector rather than against
 * itself — a hand-rolled base62 that is merely self-consistent is exactly the
 * failure this file could otherwise ship.
 *
 * NONDETERMINISM, AND WHY IT IS A PARAMETER. Nothing else in this package reads
 * the ambient clock — `clock.ts` is normative that every time-dependent
 * predicate TAKES an {@link Instant}. A mint cannot be pure, so both of its
 * inputs are parameters with defaults: callers get `ksuid()`, and tests, golden
 * vectors and any platform without `crypto` pass their own. The default
 * randomness source THROWS where there is none rather than falling back to
 * `Math.random` — `packages/client-core`'s `randomUUID` does fall back, and is
 * right to, because it names a mutation or a draft; a durable row identity
 * whose collision odds nobody can state is a different thing. (These ids are
 * identifiers, not secrets: an invite's secret is its hashed token, never its
 * id.)
 */

import type { Instant } from '../clock'

/** The base62 alphabet, in ASCII order so digit order IS character order. */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const RADIX = 62n

/** Seconds are counted from 2014-05-13, so four bytes reach past 2150. */
const KSUID_EPOCH_SECONDS = 1_400_000_000
const MAX_TIMESTAMP_SECONDS = 0xff_ff_ff_ff
const PAYLOAD_BYTES = 16
/** 2^160 — one past the largest value twenty bytes can hold. */
const MAX_VALUE = 1n << 160n

/**
 * Every KSUID is exactly this long. 62^26 is smaller than 2^160 and 62^27 is
 * larger, so 27 is both the width every value fits in and a width some 27-
 * character strings OVERFLOW — see {@link isKsuid}.
 */
export const KSUID_LENGTH = 27

/** The first instant a KSUID can carry: the KSUID epoch itself. */
export const MIN_KSUID_INSTANT: Instant = KSUID_EPOCH_SECONDS * 1000

/** The last instant four bytes of seconds can carry, in 2150. */
export const MAX_KSUID_INSTANT: Instant = (KSUID_EPOCH_SECONDS + MAX_TIMESTAMP_SECONDS) * 1000

/** A source of cryptographically random bytes — see this file's header. */
export type RandomBytes = (length: number) => Uint8Array

const platformRandomBytes: RandomBytes = (length) => {
  // Reached through `globalThis` and typed locally on purpose: this package
  // compiles under a lean `lib` with no DOM, and `packages/protocol` typechecks
  // this SOURCE to catch an ambient global creeping in (see tsconfig.json).
  const source = (
    globalThis as {
      crypto?: { getRandomValues?: (into: Uint8Array) => Uint8Array }
    }
  ).crypto
  if (!source || typeof source.getRandomValues !== 'function') {
    throw new Error(
      'ksuid: no source of randomness on this platform — pass one to ksuid() explicitly',
    )
  }
  return source.getRandomValues(new Uint8Array(length))
}

const encode = (value: bigint): string => {
  let out = ''
  for (let n = value; n > 0n; n /= RADIX) out = ALPHABET.charAt(Number(n % RADIX)) + out
  // The padding is not cosmetic: an id that prints its natural length sorts by
  // length before it sorts by time.
  return out.padStart(KSUID_LENGTH, '0')
}

/** The 160-bit value a KSUID spells, or null if the string is not one. */
const decode = (value: string): bigint | null => {
  if (value.length !== KSUID_LENGTH) return null
  let n = 0n
  for (const char of value) {
    const digit = ALPHABET.indexOf(char)
    if (digit < 0) return null
    n = n * RADIX + BigInt(digit)
  }
  return n < MAX_VALUE ? n : null
}

/**
 * Mint a KSUID. `at` defaults to now and `random` to the platform's CSPRNG;
 * both are parameters so a caller can be deterministic (see the header).
 *
 * Throws when `at` is outside the range four bytes of seconds can carry, rather
 * than wrapping — an id that silently reports 2014 because the clock was wrong
 * is worse than a failed write.
 */
export function ksuid(at: Instant = Date.now(), random: RandomBytes = platformRandomBytes): string {
  const seconds = Math.floor(at / 1000) - KSUID_EPOCH_SECONDS
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_TIMESTAMP_SECONDS) {
    throw new Error(
      `ksuid: ${at} is outside the KSUID range (${MIN_KSUID_INSTANT}..${MAX_KSUID_INSTANT})`,
    )
  }
  const payload = random(PAYLOAD_BYTES)
  if (payload.length !== PAYLOAD_BYTES) {
    throw new Error(`ksuid: the randomness source returned ${payload.length} bytes, need 16`)
  }
  let value = BigInt(seconds)
  for (const byte of payload) value = (value << 8n) | BigInt(byte)
  return encode(value)
}

/**
 * Is this string a KSUID — the right width, the right alphabet, AND a value
 * twenty bytes can hold? The last clause is why this is not a regex: 62^27
 * exceeds 2^160, so `'z'.repeat(27)` passes every shape check and decodes to
 * nothing that was ever minted.
 */
export function isKsuid(value: string): boolean {
  return decode(value) !== null
}

/**
 * The instant a KSUID was minted, from its first four bytes, truncated to the
 * second it stores. Throws rather than returning a fallback: a value that is
 * not a KSUID has no time, and reading one off it would be a well-typed lie.
 */
export function ksuidInstant(value: string): Instant {
  const decoded = decode(value)
  if (decoded === null) throw new Error(`ksuidInstant: not a KSUID: ${JSON.stringify(value)}`)
  return (Number(decoded >> BigInt(PAYLOAD_BYTES * 8)) + KSUID_EPOCH_SECONDS) * 1000
}
