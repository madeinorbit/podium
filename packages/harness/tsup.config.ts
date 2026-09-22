import { defineConfig } from 'tsup'

export default defineConfig({
  // Eight entries (POD-4469): the barrel; the narrow open entrypoint the
  // architecture manifest lets non-host consumers reach
  // (`@podium/harness/metadata`, POD-335); the browser half
  // (`@podium/harness/browser`, POD-2206) — the static facts a BUNDLE may have,
  // which `./metadata` cannot give it because its closure reaches the manifests
  // and their sqlite modules; the driver contract (`./driver`, server may
  // import) and its host half (`./driver/host`, daemon only — including the
  // terminal family's host-only machinery, POD-4498); the conformance
  // corpus (`./driver/testing`); the transcript store (`./store`, both sides);
  // and machine inventory (`./inventory`, daemon only). The composer rules
  // themselves live in `adapters/<h>/composer.ts` (POD-4477) and reach the
  // browser through the `./browser` entry above, never through a deep path.
  entry: [
    'src/index.ts',
    'src/metadata.ts',
    'src/browser.ts',
    'src/driver.ts',
    'src/driver/host.ts',
    'src/driver/testing/index.ts',
    'src/store.ts',
    'src/inventory.ts',
  ],
  format: ['esm'],
  clean: true,
  sourcemap: true,
  treeshake: true,
})
