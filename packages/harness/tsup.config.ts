import { defineConfig } from 'tsup'

export default defineConfig({
  // Three entries: the barrel; the narrow open entrypoint the architecture
  // manifest lets non-host consumers reach (`@podium/harness/metadata`,
  // POD-335); and the browser half (`@podium/harness/browser`, POD-2206) — the
  // static facts a BUNDLE may have, which `./metadata` cannot give it because
  // its closure reaches the manifests and their sqlite modules.
  entry: ['src/index.ts', 'src/metadata.ts', 'src/browser.ts'],
  format: ['esm'],
  clean: true,
  sourcemap: true,
  treeshake: true,
})
