import { defineConfig } from 'tsup'

export default defineConfig({
  // Eight entries (POD-4469): the barrel; the narrow open entrypoint the
  // architecture manifest lets non-host consumers reach
  // (`@podium/harness/metadata`, POD-335); the browser half
  // (`@podium/harness/browser`, POD-2206) — the static facts a BUNDLE may have,
  // which `./metadata` cannot give it because its closure reaches the manifests
  // and their sqlite modules; the driver contract (`./driver`, server may
  // import) and its host half (`./driver/host`, daemon only); the conformance
  // corpus (`./driver/testing`); the transcript store (`./store`, both sides);
  // and machine inventory (`./inventory`, daemon only). Two narrow deep
  // entries expose the pure composer interface the web fallback and
  // terminal-client share without taking the host barrel; the composer rules
  // move to `adapters/<h>/composer.ts` with their browser exports in 4.3.
  entry: [
    'src/index.ts',
    'src/metadata.ts',
    'src/browser.ts',
    'src/driver.ts',
    'src/driver/host.ts',
    'src/driver/testing/index.ts',
    'src/store.ts',
    'src/inventory.ts',
    'src/driver/families/terminal/composer-sync.ts',
    'src/driver/families/terminal/prompt-extract.ts',
  ],
  format: ['esm'],
  clean: true,
  sourcemap: true,
  treeshake: true,
})
