import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
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
