/**
 * PUBLISHER-OWNED DEVELOPMENT VERSIONS.
 *
 * A minted development release is `<base>.dev.<N>+<sha>` (or `<base>-dev.<N>+<sha>`
 * when `<base>` has no prerelease yet). `<base>` is the highest release version
 * this publisher has ever minted on — persisted publisher state, not the
 * checkout's package.json alone — and `<N>` is a monotonic counter on that base.
 * Build metadata carries the commit; semver §10 discards it for precedence.
 *
 * Spec: updater-convergence §1, disposition 23, decision 13 (POD-2502).
 *
 * Source checkouts still report `dev+<sha>` for log / process identity
 * ({@link ../product-version.ts}); only publisher-minted *bundles* carry this
 * orderable form.
 */

import { compareVersions } from './version-order'

/** Monotonic minting state owned by one publisher instance. */
export interface DevPublisherVersionState {
  /** Highest release base this publisher has minted on (e.g. `0.1.0-edge.20`). */
  base: string
  /** Counter on {@link base}; increments on every mint at that base. */
  counter: number
}

const SOURCE_IDENTITY = /^dev\+[0-9a-f]{7,40}$/i
/**
 * Prerelease base form: `0.1.0-edge.20.dev.5+656f49b`.
 * Base is everything before the final `.dev.<N>+<sha>` (non-greedy from the left).
 */
const PUBLISHER_DEV = /^(.*?)\.dev\.(\d+)\+([0-9a-f]{7,40})$/i
/** Stable base form: `0.1.0-dev.5+656f49b` (hyphen starts the prerelease). */
const PUBLISHER_DEV_STABLE_BASE = /^(\d+\.\d+\.\d+)-dev\.(\d+)\+([0-9a-f]{7,40})$/i

export function shortCommitSha(sha: string): string {
  return sha.trim().toLowerCase().slice(0, 7)
}

/**
 * Format a publisher mint. Appends `.dev.<N>` onto an existing prerelease base,
 * or starts `-dev.<N>` when the base is a bare `X.Y.Z`.
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
 * - Checkout base newer than remembered base → adopt it, reset counter to 1.
 * - Otherwise keep the publisher base (branch-vintage / same base) and bump N.
 * - `state === null` seeds from the checkout base at counter 1.
 */
export function mintDevVersion(
  state: DevPublisherVersionState | null,
  checkoutBase: string,
  sha: string,
): { version: string; state: DevPublisherVersionState } {
  const checkout = checkoutBase.trim()
  if (!checkout) {
    throw new Error('checkout release base is required to mint a development version')
  }

  let base: string
  let counter: number
  if (state === null) {
    base = checkout
    counter = 1
  } else {
    const order = compareVersions(checkout, state.base)
    if (order !== null && order > 0) {
      base = checkout
      counter = 1
    } else {
      base = state.base
      counter = state.counter + 1
    }
  }

  const next: DevPublisherVersionState = { base, counter }
  return { version: formatDevVersion(base, counter, sha), state: next }
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
  // Stable-base form first: more specific (`X.Y.Z-dev.N+sha`).
  const stable = PUBLISHER_DEV_STABLE_BASE.exec(value)
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
