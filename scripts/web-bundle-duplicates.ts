/**
 * ONE SINGLETON PACKAGE, TWO INSTALLATIONS (POD-2469).
 *
 * The web build's correctness check (`web-bundle-correctness.ts`) asks whether
 * a package that must exist once reached the bundle from more than one place on
 * disk. It lives in its own file because that check reads `apps/web/dist` at
 * module scope; everything here is a pure function over source paths, and
 * `web-bundle-duplicates.test.ts` drives it with synthetic ones.
 *
 * A second copy of any OTHER package only costs bytes, and the build no longer
 * limits size (POD-6423), so those are not reported.
 */

/** A singleton package resolved from more than one directory in the bundle. */
export interface SplitPackage {
  readonly package: string
  /** Distinct on-disk installation directories, sorted. */
  readonly installations: readonly string[]
}

/**
 * PACKAGES THAT MUST BE BUNDLED EXACTLY ONCE (POD-2469).
 *
 * Every package here
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
 * Every SINGLETON_PACKAGES member that reached the bundle from more than one
 * installation, over ABSOLUTE source paths.
 *
 * Paths must be absolute. `sources` in a chunk map are relative to the map that
 * names them, so the same installation gets a different spelling depending on
 * how deep the build ran, and two spellings of one directory read as two
 * installations.
 */
export function splitSingletons(sourcePaths: readonly string[]): SplitPackage[] {
  return SINGLETON_PACKAGES.flatMap((pkg) => {
    const installations = packageInstallations(sourcePaths, pkg)
    return installations.length < 2 ? [] : [{ package: pkg, installations }]
  })
}
