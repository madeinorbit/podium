/**
 * PRECEDENCE BETWEEN TWO VERSION LABELS — the one ordering in the update system,
 * kept in one place because two of them drift.
 *
 * READ `./convergence.ts` FIRST. A daemon converges to target EQUALITY, never to
 * "whatever is newest", and that is what makes a deliberate downgrade possible.
 * Nothing here may be used to decide WHETHER to converge.
 *
 * What it is for is the two questions that genuinely need an order, and both are
 * safety questions asked at the edges:
 *
 * - `podium update` on an UNATTACHED install, which has no server to be
 *   authority and only the feed to compare against (`apps/cli`).
 * - Whether an update whose safety cannot be PROVEN is at least a step FORWARD,
 *   which is the difference between a target that might brick this machine and
 *   one that structurally cannot (`refuseSchemaRegression` in `apps/daemon`).
 *
 * FAILS CLOSED, and every caller must treat it that way: `null` means "these two
 * labels have no order", not "equal". A source checkout's forensic `dev+<sha>`
 * identity has nothing to compare; publisher-minted development versions
 * (`X.Y.Z-dev.<N>+<sha>`) are orderable here.
 */

/**
 * A version this comparison can actually reason about: three numeric core
 * components plus semver's dotted prerelease identifiers. Build metadata
 * (`+<sha>`) is accepted and DISCARDED — semver §10 says it takes no part in
 * precedence, and two builds of one version are the same version here.
 */
interface ParsedVersion {
  core: readonly [string, string, string]
  prerelease: readonly string[]
}

const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const isNumericIdentifier = (id: string): boolean => /^\d+$/.test(id)

/**
 * Semver numeric identifiers are arbitrary-precision non-negative integers.
 * They stay as canonical decimal strings so digit length followed by
 * lexicographic comparison remains exact beyond JavaScript's safe-integer
 * range. Leading zeroes are rejected by `parseVersion` before this runs.
 */
function compareNumericIdentifiers(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return a === b ? 0 : a < b ? -1 : 1
}

/** `null` for anything that is not a semver — including the forensic
 *  `dev+<sha>` / plain `dev` labels a source checkout carries. Publisher mints
 *  with flat `X.Y.Z-dev.<N>` identifiers parse and order normally. */
function parseVersion(raw: string): ParsedVersion | null {
  const m = SEMVER.exec(raw.trim())
  if (!m) return null
  if (
    [m[1], m[2], m[3]].some((identifier) =>
      identifier === undefined ? false : /^0\d+$/.test(identifier),
    )
  )
    return null
  const prerelease = (m[4] ?? '').length === 0 ? [] : (m[4] as string).split('.')
  if (prerelease.some((identifier) => /^0\d+$/.test(identifier))) return null

  return {
    core: [m[1] as string, m[2] as string, m[3] as string],
    prerelease,
  }
}

/**
 * Semver §11 precedence over the prerelease identifiers, with Podium's one
 * deliberate deviation: for the same core, known channel identifiers have
 * explicit tiers — `dev` above `edge` above every other alphanumeric
 * identifier. The tier is compared before text, and text is compared
 * alphabetically only within the same tier. This makes the deviation a total
 * order instead of a pairwise exception.
 *
 * The three rules that a naive dot-splitting comparison cannot express, and
 * that decide real Podium versions:
 *
 * - **A release outranks its own prereleases.** `0.1.4` > `0.1.4-edge.4`, so an
 *   edge install stops offering itself the prerelease once the release lands.
 * - **Numeric identifiers compare NUMERICALLY.** `edge.10` > `edge.4`; compared
 *   as text it is the other way round, and edge would stall at `.9` forever.
 * - **A development cycle outranks the edge cycle of the same core.**
 *   `0.1.2-dev.1` > `0.1.2-edge.1`. Since POD-2737 a mint is minted on the NEXT
 *   patch, so the cut it was BUILT from is already below it on the core alone —
 *   what this tier carries is the cut its own base anticipates, the `0.1.2-edge.1`
 *   that lands later. Without it, cutting that edge would make every development
 *   build on the 0.1.2 lineage look older than the release it is ahead of.
 *
 * Mixed identifiers: numeric always ranks below alphanumeric, and a shorter set
 * of otherwise-equal identifiers ranks below a longer one.
 */
function comparePrerelease(
  a: readonly string[],
  b: readonly string[],
): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const left = a[i] as string
    const right = b[i] as string
    if (left === right) continue
    const leftIsNumber = isNumericIdentifier(left)
    const rightIsNumber = isNumericIdentifier(right)
    if (leftIsNumber !== rightIsNumber) return leftIsNumber ? -1 : 1
    if (leftIsNumber && rightIsNumber) return compareNumericIdentifiers(left, right)
    const leftText = left
    const rightText = right
    const leftRank = prereleaseTextRank(leftText)
    const rightRank = prereleaseTextRank(rightText)
    if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1
    return leftText < rightText ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

/**
 * Known publisher channels get explicit precedence. Unknown alphanumeric
 * prerelease identifiers share the fallback tier and remain text-ordered
 * within it; putting `edge` above that tier prevents a label such as `dzz`
 * from closing a cycle between `dev` and `edge`.
 */
function prereleaseTextRank(identifier: string): number {
  if (identifier === 'dev') return 2
  if (identifier === 'edge') return 1
  return 0
}

/**
 * Precedence between two versions, or `null` when either side is not a version
 * this can order.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i++) {
    const order = compareNumericIdentifiers(left.core[i] as string, right.core[i] as string)
    if (order !== 0) return order
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/**
 * Is `candidate` PROVABLY ahead of `current`?
 *
 * Named for what it can be relied on to mean, because the false answer covers
 * two different situations — behind, and unorderable — and every caller here
 * has to treat them alike. `false` is never evidence that `candidate` is older.
 */
export function isProvablyNewer(candidate: string, current: string): boolean {
  const order = compareVersions(candidate, current)
  return order !== null && order > 0
}
