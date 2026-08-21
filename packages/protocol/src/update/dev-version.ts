/**
 * PUBLISHER-OWNED DEVELOPMENT VERSIONS.
 *
 * A minted development release is `<lineage>.dev.<N>+<sha>` (or
 * `<lineage>-dev.<N>+<sha>` when the lineage has no prerelease). The lineage is
 * publisher-owned monotonic state — not the checkout's package.json alone —
 * and `<N>` increments on that lineage. Build metadata carries the commit;
 * semver §10 discards it for precedence.
 *
 * Spec: updater-convergence §1, disposition 23, decision 13 (POD-2502).
 *
 * Stable cuts: a bare `X.Y.Z` checkout is minted on the NEXT PATCH lineage
 * (`X.Y.(Z+1)-dev.N+sha`) so the mint sorts above the release it builds on and
 * above every prior `X.Y.Z-edge.*.dev.*` mint. Minting on `X.Y.Z-dev.N` would
 * sort *below* both — the trap this module exists to close.
 *
 * Source checkouts still report `dev+<sha>` for log / process identity
 * ({@link ../product-version.ts}); published targets (bundle or identity) carry
 * this orderable form.
 */

import { compareVersions, isProvablyNewer } from './version-order'

/** Monotonic minting state owned by one publisher instance. */
export interface DevPublisherVersionState {
  /**
   * Mint lineage base (e.g. `0.1.0-edge.20`, or `0.1.2` after a stable `0.1.1`
   * cut bumped to the next patch). Never a bare stable that still needs bumping.
   */
  base: string
  /** Counter on {@link base}; increments on every mint at that base. */
  counter: number
}

const SOURCE_IDENTITY = /^dev\+[0-9a-f]{7,40}$/i
const STABLE_CORE = /^(\d+)\.(\d+)\.(\d+)$/
/**
 * Prerelease lineage form: `0.1.0-edge.20.dev.5+656f49b`.
 * Base is everything before the final `.dev.<N>+<sha>`.
 */
const PUBLISHER_DEV = /^(.*?)\.dev\.(\d+)\+([0-9a-f]{7,40})$/i
/** Next-patch lineage form: `0.1.2-dev.5+656f49b`. */
const PUBLISHER_DEV_STABLE_LINEAGE = /^(\d+\.\d+\.\d+)-dev\.(\d+)\+([0-9a-f]{7,40})$/i

export function shortCommitSha(sha: string): string {
  return sha.trim().toLowerCase().slice(0, 7)
}

/**
 * Map a checkout release version onto the mint lineage base.
 *
 * Edge/prerelease checkouts pass through. A bare `X.Y.Z` becomes `X.Y.(Z+1)` so
 * `-dev.N` mints sort above that release and above its edge lineage.
 */
export function effectiveMintBase(checkoutBase: string): string {
  const trimmed = checkoutBase.trim()
  if (!trimmed) throw new Error('checkout release base is required')
  const stable = STABLE_CORE.exec(trimmed)
  if (!stable) return trimmed
  const major = stable[1] as string
  const minor = stable[2] as string
  const patch = Number(stable[3])
  return `${major}.${minor}.${patch + 1}`
}

/**
 * Format a publisher mint from an already-resolved lineage base.
 *
 * Pass {@link effectiveMintBase} output (or a stored state.base), not a raw
 * stable cut — a bare `X.Y.Z` here still produces `X.Y.Z-dev.N`, which sorts
 * below that release. Minting goes through {@link mintDevVersion}.
 */
export function formatDevVersion(base: string, counter: number, sha: string): string {
  if (!Number.isInteger(counter) || counter < 1) {
    throw new Error(`development version counter must be a positive integer, got ${counter}`)
  }
  const trimmed = base.trim()
  if (!trimmed) throw new Error('development version base is required')
  const withDev = trimmed.includes('-') ? `${trimmed}.dev.${counter}` : `${trimmed}-dev.${counter}`
  return `${withDev}+${shortCommitSha(sha)}`
}

/**
 * Advance publisher state and mint the next orderable development version.
 *
 * - The mint the checkout's lineage would produce clears the previous mint →
 *   adopt that lineage, reset counter to 1.
 * - Otherwise keep the publisher base (branch-vintage / same base / a lineage
 *   whose first mint would not clear) and bump N.
 * - `state === null` seeds from the effective checkout lineage at counter 1.
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
 * comparison keeps the publisher on the bumped stable lineage after the first
 * stable cut (`0.1.2-dev.N` forever), because `0.1.2-edge.1` sorts BELOW
 * `0.1.2` even though `0.1.2-edge.1.dev.1` sorts above `0.1.2-dev.1`. The
 * single gate rejoins the edge train and keeps disposition 23's stated form
 * (`<last release>.dev.<N>+<sha>`).
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

  const previousMint = formatDevVersion(state.base, state.counter, '0000000')
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
  const version = formatDevVersion(state.base, counter, sha)
  if (!isProvablyNewer(version, previousMint)) {
    throw new Error(
      `development mint ${version} is not provably newer than previous mint ${previousMint}`,
    )
  }
  return { version, state: { base: state.base, counter } }
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

/** Parse a publisher-minted development version, or `null` when it is not one. */
export function parsePublisherDevVersion(raw: string): ParsedPublisherDevVersion | null {
  const value = raw.trim()
  // Next-patch lineage form first: more specific (`X.Y.Z-dev.N+sha`).
  const stable = PUBLISHER_DEV_STABLE_LINEAGE.exec(value)
  if (stable) {
    return parsedMint(stable[1] as string, stable[2] as string, stable[3] as string, value)
  }
  const edge = PUBLISHER_DEV.exec(value)
  if (edge) {
    return parsedMint(edge[1] as string, edge[2] as string, edge[3] as string, value)
  }
  return null
}

/** True for a publisher-minted `<base>.dev.<N>+<sha>` (not a bare `dev+<sha>`). */
export function isPublisherDevVersion(version: string): boolean {
  return parsePublisherDevVersion(version) !== null
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
