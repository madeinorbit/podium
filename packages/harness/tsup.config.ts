import { defineConfig } from 'tsup'

export default defineConfig({
  // Two entries: the barrel, and the narrow open entrypoint the architecture
  // manifest lets non-host consumers reach (`@podium/harness/metadata`, POD-335).
  entry: ['src/index.ts', 'src/metadata.ts'],
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
