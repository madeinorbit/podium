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
 * (`<base>.dev.<N>+<sha>`, POD-2502) are ordinary semver and order here.
 */

/**
 * A version this comparison can actually reason about: three numeric core
 * components plus semver's dotted prerelease identifiers. Build metadata
 * (`+<sha>`) is accepted and DISCARDED — semver §10 says it takes no part in
 * precedence, and two builds of one version are the same version here.
 */
interface ParsedVersion {
  core: readonly [number, number, number]
  prerelease: readonly (string | number)[]
}

const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const numericOrText = (id: string): string | number => (/^\d+$/.test(id) ? Number(id) : id)

/** `null` for anything that is not a semver — including the forensic
 *  `dev+<sha>` / plain `dev` labels a source checkout carries. Publisher mints
 *  with appended `.dev.<N>` identifiers parse and order normally. */
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
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: prerelease.map(numericOrText),
  }
}

/**
 * Semver §11 precedence over the prerelease identifiers. The two rules that a
 * naive dot-splitting comparison cannot express, and that decide real Podium
 * versions:
 *
 * - **A release outranks its own prereleases.** `0.1.4` > `0.1.4-edge.4`, so an
 *   edge install stops offering itself the prerelease once the release lands.
 * - **Numeric identifiers compare NUMERICALLY.** `edge.10` > `edge.4`; compared
 *   as text it is the other way round, and edge would stall at `.9` forever.
 *
 * Mixed identifiers: numeric always ranks below alphanumeric, and a shorter set
 * of otherwise-equal identifiers ranks below a longer one.
 */
function comparePrerelease(
  a: readonly (string | number)[],
  b: readonly (string | number)[],
): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const left = a[i] as string | number
    const right = b[i] as string | number
    if (left === right) continue
    const leftIsNumber = typeof left === 'number'
    const rightIsNumber = typeof right === 'number'
    if (leftIsNumber !== rightIsNumber) return leftIsNumber ? -1 : 1
    if (leftIsNumber && rightIsNumber) return left < right ? -1 : 1
    return (left as string) < (right as string) ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
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
    const l = left.core[i] as number
    const r = right.core[i] as number
    if (l !== r) return l < r ? -1 : 1
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
