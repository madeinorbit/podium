import { defineConfig } from 'tsup'

export default defineConfig({
  // Three entries: the barrel; the narrow open entrypoint the architecture
  // manifest lets non-host consumers reach (`@podium/harness/metadata`,
  // POD-335); and the browser half (`@podium/harness/browser`, POD-2206) — the
  // static facts a BUNDLE may have, which `./metadata` cannot give it because
  // its closure reaches the manifests and their sqlite modules.
  entry: ['src/index.ts', 'src/metadata.ts', 'src/browser.ts'],
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
