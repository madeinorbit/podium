import { defineConfig } from 'tsup'

export default defineConfig({
  /**
   * `src/update/refusal.ts` is its own entry so a BROWSER bundle can reach the
   * refusal table without the barrel (POD-2241). apps/web loads the update
   * engine behind a lazy boundary that POD-2190 split out to keep 99 KB off the
   * first paint; importing the barrel there took that chunk's cold import from
   * ~250 ms to ~3 s, which `updates-context.test.tsx` caught by timing out. The
   * table imports nothing, so as its own entry it costs the chunk one module.
   */
  entry: ['src/index.ts', 'src/daemon.ts', 'src/update/refusal.ts'],
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
