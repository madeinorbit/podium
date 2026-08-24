/**
 * PUBLISHER-OWNED DEVELOPMENT VERSIONS.
 *
 * A minted development release is `X.Y.Z-dev.<N>+<sha>`. The base is the
 * release cycle being worked toward, not the edge cut that happened to produce
 * the checkout. The publisher-owned monotonic state — not the checkout's
 * package.json alone — supplies `<N>`. Build metadata carries the commit;
 * semver §10 discards it for precedence.
 *
 * Spec: updater-convergence §1, disposition 23, decision 13 (POD-2502).
 *
 * EVERY checkout is minted on the NEXT PATCH cycle (`X.Y.(Z+1)-dev.N+sha`),
 * bare `X.Y.Z` and prerelease alike: a development build is working PAST the cut
 * it was taken from, so it is a prerelease of the version that cut leads to, not
 * of the one already made. The shared version ordering additionally places a
 * cycle's `-dev.N` labels above its `-edge.N` labels, which is what keeps a mint
 * above the edge cut its own base anticipates (POD-2737).
 *
 * Source checkouts still report `dev+<sha>` for log / process identity
 * ({@link ../product-version.ts}); published targets (bundle or identity) carry
 * this orderable form.
 */

import { compareVersions, isProvablyNewer } from './version-order'

/** Monotonic minting state owned by one publisher instance. */
export interface DevPublisherVersionState {
  /**
   * Mint cycle base — the next-patch lineage the checkout points at (`0.1.2`
   * from either a `0.1.1` or a `0.1.1-edge.2` checkout). Already bumped:
   * never the checkout's own core, and never carries a prerelease.
   *
   * State persisted before POD-2737 may still hold an un-bumped core, or a
   * legacy `0.1.0-edge.20`. Both are read as-is and left to the mint gate in
   * {@link mintDevVersion}, which moves off them on the first mint that
   * provably clears the last one. A stored base is NEVER re-run through
   * {@link effectiveMintBase} — that would walk the lineage forward on every
   * read (see `dev-publisher-state.ts`).
   */
  base: string
  /** Counter on {@link base}; increments on every mint at that base. */
  counter: number
}

const SOURCE_IDENTITY = /^dev\+[0-9a-f]{7,40}$/i
const VERSION_WITH_OPTIONAL_PRERELEASE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
/**
 * Legacy prerelease lineage form: `0.1.0-edge.20.dev.5+656f49b`.
 * It remains parseable so retained artifacts and persisted state can be
 * recognized while all new mints use the flat form below.
 */
const PUBLISHER_DEV = /^(.*?)\.dev\.(\d+)\+([0-9a-f]{7,40})$/i
/** Flat publisher form: `0.1.2-dev.5+656f49b`. */
const PUBLISHER_DEV_FLAT = /^(\d+\.\d+\.\d+)-dev\.(\d+)\+([0-9a-f]{7,40})$/i

export function shortCommitSha(sha: string): string {
  return sha.trim().toLowerCase().slice(0, 7)
}

/**
 * Map a checkout release version onto the mint cycle base: ALWAYS `X.Y.(Z+1)`.
 *
 * The prerelease, if any, is dropped rather than consulted. `0.1.1` and
 * `0.1.1-edge.2` are both the 0.1.1 cycle, and a development build taken from
 * either is working toward what comes NEXT, so both mint `0.1.2-dev.N`.
 *
 * This used to collapse a prerelease onto its own core — `0.1.1-edge.2` minted
 * `0.1.1-dev.N`, a prerelease of the very cut the build was already past. That
 * still sorted above `0.1.1-edge.2`, but only through the `dev` > `edge` tier
 * deviation in `version-order.ts`; now the core carries it, and the tier
 * deviation is left holding the case it exists for — a mint against the edge cut
 * of its OWN base, `0.1.2-dev.N` vs the `0.1.2-edge.1` that lands later.
 */
export function effectiveMintBase(checkoutBase: string): string {
  const trimmed = checkoutBase.trim()
  if (!trimmed) throw new Error('checkout release base is required')
  const parsed = VERSION_WITH_OPTIONAL_PRERELEASE.exec(trimmed)
  if (!parsed) return trimmed
  const major = parsed[1] as string
  const minor = parsed[2] as string
  const patch = Number(parsed[3])
  return `${major}.${minor}.${patch + 1}`
}

function coreVersion(raw: string): string | null {
  const parsed = VERSION_WITH_OPTIONAL_PRERELEASE.exec(raw)
  if (!parsed) return null
  return `${parsed[1]}.${parsed[2]}.${parsed[3]}`
}

/**
 * Format a publisher mint from an already-resolved cycle base.
 *
 * A legacy stored edge base is normalized as a safety net; all newly persisted
 * state is the flat `X.Y.Z` cycle base.
 */
export function formatDevVersion(base: string, counter: number, sha: string): string {
  if (!Number.isInteger(counter) || counter < 1) {
    throw new Error(`development version counter must be a positive integer, got ${counter}`)
  }
  const trimmed = base.trim()
  if (!trimmed) throw new Error('development version base is required')
  const cycle = coreVersion(trimmed) ?? trimmed
  return `${cycle}-dev.${counter}+${shortCommitSha(sha)}`
}

/**
 * Advance publisher state and mint the next orderable development version.
 *
 * - The mint the checkout's cycle would produce clears the previous mint →
 *   adopt that cycle, reset counter to 1.
 * - Otherwise keep the publisher cycle (branch-vintage / same cycle / a cycle
 *   whose first mint would not clear) and bump N.
 * - `state === null` seeds from the effective checkout cycle at counter 1.
 *
 * ONE GATE, ON THE THING THE INVARIANT IS ABOUT. The rule this module owes the
 * fleet is "every mint is provably newer than the previous mint" — so the gate
 * asks exactly that question of the version it is about to hand out, and
 * nothing else. An earlier revision also required `compareVersions(lineage,
 * state.base) > 0`. That conjunct is implied by this one for every lineage the
 * release process produces, and having both cost more than it bought: each was
 * individually sufficient, so removing EITHER left the suite green, and the
 * guards could not be shown to be doing anything (POD-2502 round-2 review, M2
 * and M3 both survived). It was also wrong on its own terms — a base-only
 * comparison can reset the counter when the checkout moves to a later cycle
 * without proving that the first mint clears the previous mint. The single mint
 * gate keeps this publisher's one flat identity monotonic.
 *
 * Both remaining checks are separately observable, which is the point: mutate
 * this gate in either direction, or delete the fail-closed throw below, and a
 * test goes red (see `dev-version.test.ts`, "arming").
 */
export function mintDevVersion(
  state: DevPublisherVersionState | null,
  checkoutBase: string,
  sha: string,
): { version: string; state: DevPublisherVersionState } {
  const lineage = effectiveMintBase(checkoutBase)

  if (state === null) {
    const next: DevPublisherVersionState = { base: lineage, counter: 1 }
    return { version: formatDevVersion(lineage, 1, sha), state: next }
  }

  const storedBase = coreVersion(state.base) ?? state.base
  const previousMint = formatDevVersion(storedBase, state.counter, '0000000')
  const adoptVersion = formatDevVersion(lineage, 1, sha)

  if (isProvablyNewer(adoptVersion, previousMint)) {
    const next: DevPublisherVersionState = { base: lineage, counter: 1 }
    return { version: adoptVersion, state: next }
  }

  // FAIL CLOSED on the fallback too. Bumping N on a base this system can order
  // always clears the previous mint; a base it CANNOT order (a corrupt state
  // file, a hand-edited base) makes `isProvablyNewer` return false, and minting
  // a version whose relation to the last one is unknown is how a machine gets
  // offered an update it already ran. The publisher's callers treat a throw
  // here as "no release available" (`dev-bundle.ts` `target()`).
  const counter = state.counter + 1
  const version = formatDevVersion(storedBase, counter, sha)
  if (!isProvablyNewer(version, previousMint)) {
    throw new Error(
      `development mint ${version} is not provably newer than previous mint ${previousMint}`,
    )
  }
  return { version, state: { base: storedBase, counter } }
}

export interface ParsedPublisherDevVersion {
  base: string
  counter: number
  sha: string
  version: string
}

function parsedMint(
  base: string,
  counterRaw: string,
  shaRaw: string,
  version: string,
): ParsedPublisherDevVersion | null {
  // The base must itself be a version this system can order — otherwise a random
  // `foo.dev.1+abc1234` string would count as a publisher mint.
  if (compareVersions(base, base) !== 0) return null
  const counter = Number(counterRaw)
  if (!Number.isInteger(counter) || counter < 1) return null
  return { base, counter, sha: shaRaw.toLowerCase(), version }
}

/** Parse a flat publisher mint, or a legacy nested mint retained on disk. */
export function parsePublisherDevVersion(raw: string): ParsedPublisherDevVersion | null {
  const value = raw.trim()
  const flat = PUBLISHER_DEV_FLAT.exec(value)
  if (flat) {
    return parsedMint(flat[1] as string, flat[2] as string, flat[3] as string, value)
  }
  const legacy = PUBLISHER_DEV.exec(value)
  if (legacy) {
    return parsedMint(legacy[1] as string, legacy[2] as string, legacy[3] as string, value)
  }
  return null
}

/** True for a flat or legacy publisher mint (not a bare `dev+<sha>`). */
export function isPublisherDevVersion(version: string): boolean {
  return parsePublisherDevVersion(version) !== null
}

/** True only for the current flat publisher form; legacy mints remain parseable. */
export function isFlatPublisherDevVersion(version: string): boolean {
  const value = version.trim()
  return PUBLISHER_DEV_FLAT.test(value) && parsePublisherDevVersion(value) !== null
}

/** True for `dev+<sha>` source identity OR a publisher-minted development version. */
export function isDevChannelVersion(version: string): boolean {
  const value = version.trim()
  return SOURCE_IDENTITY.test(value) || isPublisherDevVersion(value)
}

/**
 * Commit SHA a development version names — build metadata on a mint, or the
 * suffix of a `dev+<sha>` source identity.
 */
export function commitShaFromDevVersion(version: string): string | null {
  const minted = parsePublisherDevVersion(version)
  if (minted) return minted.sha
  const source = SOURCE_IDENTITY.exec(version.trim())
  if (source) return version.trim().slice(4).toLowerCase().slice(0, 7)
  const plus = version.lastIndexOf('+')
  if (plus >= 0) {
    const meta = version.slice(plus + 1).toLowerCase()
    if (/^[0-9a-f]{7,40}$/.test(meta)) return meta.slice(0, 7)
  }
  return null
}

/**
 * Operator-facing short form: `dev.5 (656f49b)`. Non-publisher versions pass through.
 *
 * Display helper for settings / update surfaces; shell version single-sourcing
 * remains POD-2451's job.
 */
export function formatDevVersionShort(version: string): string {
  const minted = parsePublisherDevVersion(version)
  if (!minted) return version
  return `dev.${minted.counter} (${minted.sha})`
}
