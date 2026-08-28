import { defineConfig } from 'tsup'

export default defineConfig({
  /**
   * `src/update/refusal.ts` is its own entry so a BROWSER bundle can reach the
   * refusal table without the barrel (POD-2241). apps/web loads the update
   * engine behind a lazy boundary that POD-2190 split out to keep 99 KB off the
   * first paint; importing the barrel there took that chunk's cold import from
   * ~250 ms to ~3 s, which `updates-context.test.tsx` caught by timing out. The
   * table imports nothing, so as its own entry it costs the chunk one module.
   *
   * `src/update/dev-version.ts` is an entry for the same reason (POD-2502): the
   * update chunk asks `isDevChannelVersion` whether a target names a dev build,
   * and that is a VALUE. Its only import is `./version-order`, which imports
   * nothing — two modules through the leaf, the whole wire schema through the
   * barrel.
   */
  entry: ['src/index.ts', 'src/daemon.ts', 'src/update/dev-version.ts', 'src/update/refusal.ts'],
  format: ['esm'],
  // POD-781: the shared tsconfig enables `incremental` for tsgo typechecking,
  // but tsup's dts worker re-passes compilerOptions programmatically, where
  // `incremental` without `tsBuildInfoFile` is TS5074. dts builds gain nothing
  // from incremental — turn it off here, leaving typecheck caching untouched.
  dts: { compilerOptions: { incremental: false } },
  clean: true,
  sourcemap: true,
  treeshake: true,
})
