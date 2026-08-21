/**
 * ONE PACKAGE, TWO INSTALLATIONS — the detection, and the valve beside it.
 *
 * This is the half of `web-bundle-budget.ts` that decides whether a package
 * reached the bundle from more than one place on disk. It lives in its own file
 * for one reason: the budget script reads `apps/web/dist` at module scope, so
 * nothing in it can be imported without a built website standing by, and a check
 * whose ability to REFUSE is never exercised is the defect this whole line of
 * work kept finding. Everything here is a pure function over source paths, and
 * `web-bundle-duplicates.test.ts` drives it with synthetic ones.
 *
 * WHY A SECOND COPY MATTERS AT ALL. Two answers, and they are not the same
 * answer — which is the whole of POD-2527. SINGLETON_PACKAGES below is the list
 * of packages a second copy BREAKS. What the byte ceilings needed was the list
 * of packages a second copy COSTS, and that list is "every package", because the
 * eager source budget counts `sourcesContent`: a split prices one vendor file
 * twice and arrives at the ceiling as growth with nobody's name on it.
 *
 * WHY THERE IS AN ACCEPT LIST. Detection without a valve gives the wrong advice
 * under the one condition it is most confident about. See
 * ACCEPTED_DUPLICATE_PACKAGES.
 */

/** One package, resolved from more than one directory, in the bundle. */
export interface DuplicatedPackage {
  readonly package: string
  /** Distinct on-disk installation directories, sorted. */
  readonly installations: readonly string[]
  /** True when a split does not cost bytes but breaks the feature outright. */
  readonly breaksTheFeature: boolean
  /** Set only when an acceptance exists and did NOT cover what was found: the
   *  number of installations that were signed off. More than that is a new
   *  split hiding behind an old decision, so it is still an error. */
  readonly acceptedInstallations?: number
}

export interface AcceptedDuplicatePackage extends DuplicatedPackage {
  readonly reason: string
}

/** An entry on the accept list: a package, how many installations were signed
 *  off, and why. */
export interface DuplicateAcceptance {
  readonly package: string
  /** The number of installations this decision covers. A split that grows past
   *  it is not the split that was accepted. */
  readonly installations: number
  readonly reason: string
}

export interface DuplicateReport {
  /** Splits nothing has signed off. These fail the build. */
  readonly duplicated: readonly DuplicatedPackage[]
  /** Splits an entry below covers exactly. Reported, not fatal. */
  readonly accepted: readonly AcceptedDuplicatePackage[]
  /** Entries that no longer describe anything in the bundle. An acceptance that
   *  outlives its reason is an open door nobody remembers holding, so these fail
   *  the build too — the fix is to delete the entry. */
  readonly unusedAcceptances: readonly string[]
  /** Entries naming a SINGLETON_PACKAGES member. There is no legitimate second
   *  copy of those, so such an entry can never be honoured; it is a mistake in
   *  the list itself rather than a fact about the bundle. */
  readonly illegalAcceptances: readonly string[]
}

/**
 * PACKAGES THAT MUST BE BUNDLED EXACTLY ONCE (POD-2469).
 *
 * This is a correctness check wearing a size check's clothes. Every package here
 * hands out objects that its own code then recognises with `instanceof` or by
 * reference, so a second copy in the bundle does not cost bytes — it breaks the
 * feature. `@codemirror/state` is the one that taught us: `EditorState.create`
 * walks the extension set, meets a `Facet` minted by the other copy, fails the
 * check and throws "Unrecognized extension value in extension set". The file
 * panel died on mount in edit and side-by-side mode; view mode renders a
 * preview, so it looked fine.
 *
 * `@lezer/highlight` is the quiet one. Its `tags` are the objects a grammar
 * marks its tree with AND the objects `HighlightStyle` matches against, so a
 * split there throws nothing at all — the code just stops being coloured.
 *
 * WHAT MAKES A COPY. One entry in the lockfile is not one module: what counts is
 * the resolved path on disk, and a mixed node_modules yields two of them for the
 * same version. `apps/web/node_modules/@codemirror/` carries symlinks into
 * `node_modules/.bun/` for some of these and not others, so some imports landed
 * on the `.bun` copy and the rest on the hoisted root one. That is why the fix
 * is `resolve.dedupe` in apps/web/vite.config.ts rather than an install step,
 * and why this check counts DISTINCT RESOLVED PATHS rather than chunks.
 *
 * If this fires, something reached one of these packages by a path `dedupe` does
 * not cover — a new dependency of its own, or a specifier not on that list.
 *
 * Nothing here may ever go on the accept list: for these packages there is no
 * such thing as a legitimate second copy.
 */
export const SINGLETON_PACKAGES = [
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/language',
  '@codemirror/autocomplete',
  '@codemirror/commands',
  '@codemirror/search',
  '@codemirror/lint',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
  'react',
  'react-dom',
] as const

/**
 * DELIBERATE SPLITS, SIGNED OFF ONE AT A TIME. Empty, and meant to stay that
 * way.
 *
 * The check above scans every package, which is right — but it means the only
 * thing it can say about a split is "dedupe it", and that is the wrong advice
 * for a two-version install somebody chose. This repository's store already
 * carries several: `@trpc/client`, `@tanstack/db` and `@testing-library/react`
 * are each installed at two versions today. None of them reaches the browser
 * bundle from two places, which is why this list is empty rather than
 * pre-populated — an accept list seeded with things that are not actually
 * duplicated is an accept list nobody has read.
 *
 * The day one of them does, a release should not be held hostage to a gate that
 * can only say no. Add the entry, and make it carry the decision:
 *
 *   - `package` — the name as the check reports it.
 *   - `installations` — how many were measured. The check accepts THAT many and
 *     no more, so a third copy arriving later is still a failure rather than
 *     something the old decision quietly absorbs.
 *   - `reason` — which two versions, who needs each, what the second copy costs
 *     in eager source bytes, and what would let the entry be deleted.
 *
 * An entry that stops matching the bundle fails the build as `unusedAcceptances`
 * rather than lingering: the escape hatch has to be as easy to close as it is to
 * open.
 */
export const ACCEPTED_DUPLICATE_PACKAGES: readonly DuplicateAcceptance[] = []

/**
 * EVERY package in the bundle, so the duplicate check does not need a list
 * (POD-2527).
 *
 * A package name is the segment after the LAST `node_modules/` in a resolved
 * path — `@scope/name` counts as one, and the `.bun` store's nested spelling
 * collapses onto the same name as the hoisted one, which is the point: those two
 * are exactly the pair that splits.
 */
export function bundledPackageNames(sourcePaths: readonly string[]): string[] {
  const marker = '/node_modules/'
  const names = new Set<string>()
  for (const path of sourcePaths) {
    const at = path.lastIndexOf(marker)
    if (at < 0) continue
    const [first, second] = path.slice(at + marker.length).split('/')
    if (!first) continue
    if (first.startsWith('@')) {
      if (second) names.add(`${first}/${second}`)
    } else names.add(first)
  }
  return [...names].sort()
}

/**
 * Distinct on-disk installations of `pkg` that reached the bundle. Keyed by the
 * directory the sources sit in rather than by version or lockfile entry: one
 * entry can still be two modules, and it is the module identity that decides
 * whether `instanceof` holds. See SINGLETON_PACKAGES.
 */
export function packageInstallations(sourcePaths: readonly string[], pkg: string): string[] {
  const needle = `node_modules/${pkg}/`
  return [
    ...new Set(
      sourcePaths.flatMap((path) => {
        const at = path.lastIndexOf(needle)
        return at < 0 ? [] : [path.slice(0, at + needle.length - 1)]
      }),
    ),
  ].sort()
}

/**
 * The whole judgement, over ABSOLUTE source paths: what is split, what has been
 * signed off, and which sign-offs no longer describe anything.
 *
 * Paths must be absolute. `sources` in a chunk map are relative to the map that
 * names them, so the same installation gets a different spelling depending on
 * how deep the build ran — and two spellings of one directory read as two
 * installations.
 */
export function duplicateReport(
  sourcePaths: readonly string[],
  acceptances: readonly DuplicateAcceptance[] = ACCEPTED_DUPLICATE_PACKAGES,
): DuplicateReport {
  const singletons = new Set<string>(SINGLETON_PACKAGES)
  const accepts = new Map(acceptances.map((entry) => [entry.package, entry]))
  const duplicated: DuplicatedPackage[] = []
  const accepted: AcceptedDuplicatePackage[] = []
  const covered = new Set<string>()

  for (const pkg of bundledPackageNames(sourcePaths)) {
    const installations = packageInstallations(sourcePaths, pkg)
    if (installations.length < 2) continue
    const acceptance = accepts.get(pkg)
    const breaksTheFeature = singletons.has(pkg)
    if (acceptance && !breaksTheFeature && acceptance.installations === installations.length) {
      covered.add(pkg)
      accepted.push({ package: pkg, installations, breaksTheFeature, reason: acceptance.reason })
      continue
    }
    if (acceptance && !breaksTheFeature) covered.add(pkg)
    duplicated.push({
      package: pkg,
      installations,
      breaksTheFeature,
      ...(acceptance && !breaksTheFeature
        ? { acceptedInstallations: acceptance.installations }
        : {}),
    })
  }

  const illegalAcceptances = acceptances
    .map((entry) => entry.package)
    .filter((pkg) => singletons.has(pkg))
    .sort()

  return {
    duplicated,
    accepted,
    unusedAcceptances: acceptances
      .map((entry) => entry.package)
      .filter((pkg) => !covered.has(pkg) && !singletons.has(pkg))
      .sort(),
    illegalAcceptances,
  }
}
