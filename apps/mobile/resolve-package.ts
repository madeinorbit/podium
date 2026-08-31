import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Package paths for the mobile vite/vitest configs, resolved rather than guessed.
 *
 * These configs used to spell their alias targets as `../../node_modules/<pkg>`,
 * which is only where a package lands under a HOISTED install. The repo's
 * bunfig sets `linker = "isolated"` with a global store, so `node_modules`
 * holds only what the owning package.json declares and the real payload lives
 * behind a symlink into `~/.bun/install/cache/links`. A dependency of
 * `apps/mobile` (react-native-svg) simply is not at the root under that layout,
 * and its alias pointed at a path that does not exist — every test whose graph
 * reached it died with "Failed to resolve import react-native-svg" (POD-3174).
 *
 * Node's resolver already knows where the linker put things, so ask it. The two
 * entry points differ in WHICH package.json does the asking, and that choice is
 * load-bearing, not cosmetic — see `resolveRootPackage`.
 */

/** Resolves as `apps/mobile` does — its own dependencies, whatever the layout. */
const mobileRequire = createRequire(fileURLToPath(import.meta.url))

/**
 * Resolves as the WORKSPACE ROOT does. `@testing-library/react` lives at the
 * root and is externalized CJS, so it always loads the root's React; the react
 * and react-dom aliases exist to point the app's imports at that same copy
 * (apps/mobile pins 19.2.3, the root 19.2.7). Resolving these from the mobile
 * package would hand the app its own React back and reintroduce exactly the
 * two-copy "Invalid hook call" breakage `test/one-react.ts` reports.
 */
const rootRequire = createRequire(fileURLToPath(new URL('../../package.json', import.meta.url)))

/** Absolute path to a file inside one of `apps/mobile`'s own dependencies. */
export function resolveMobileFile(specifier: string): string {
  return mobileRequire.resolve(specifier)
}

/** Absolute path to one of `apps/mobile`'s own dependency directories. */
export function resolveMobilePackage(name: string): string {
  return dirname(mobileRequire.resolve(`${name}/package.json`))
}

/**
 * Absolute path to a file in a package resolved as `dependency` itself would
 * resolve it. The isolated linker gives every package only what it declares, so
 * a package that reaches for a transitive one it never declared (react-native-svg
 * imports `@react-native/assets-registry`, which comes with react-native) has no
 * path to it. Asking the declaring package is how that gets bridged.
 *
 * It also has to be asked EXPLICITLY: apps/mobile sits inside the repo, so a
 * plain resolve of an undeclared package walks up past the worktree and lands in
 * the main checkout's node_modules — resolving, wrongly and silently.
 */
export function resolveThroughMobileDep(dependency: string, specifier: string): string {
  const owner = createRequire(mobileRequire.resolve(`${dependency}/package.json`))
  return owner.resolve(specifier)
}

/** Absolute path to the root's copy of a package's directory. */
export function resolveRootPackage(name: string): string {
  return dirname(rootRequire.resolve(`${name}/package.json`))
}

/** Absolute path to a file inside the root's copy of a package. */
export function resolveRootFile(specifier: string): string {
  return rootRequire.resolve(specifier)
}
