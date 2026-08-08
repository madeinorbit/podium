/**
 * vitest `globalSetup` for POD-523's pre-migrated store fixture: make sure this
 * checkout holds a current-schema database image, and tell the forks where it is.
 *
 * It runs ONCE per lane, in vitest's main process, before any worker starts — which
 * is the point. Building the image means running the real 54-migration chain, and
 * doing that in the forks would drag the drizzle migrator's module graph into the
 * setup path of every apps/server test file, including the ~200 that never
 * construct a store (measured: 0.4 s → 43 s of setup for a pure policy file).
 *
 * A warm checkout does not even load the migrator here: `ensureSchemaImage` hashes
 * the migration manifest, finds that digest already cached, and returns. That digest
 * IS the invalidation — a changed migration is a changed filename, so a schema
 * change rebuilds without anyone remembering to clear anything.
 *
 * `process.env` rather than vitest's `provide`: the forks read this from
 * `SessionStore`'s synchronous constructor path, and `inject()` is async. Forks
 * inherit the parent environment, so setting it here is enough.
 */

import {
  FIXTURE_DISABLED_ENV,
  SCHEMA_IMAGE_ENV,
} from './apps/server/src/test-support/pre-migrated-store'
import { ensureSchemaImage } from './apps/server/src/test-support/pre-migrated-store.build'

export default async function setup(): Promise<void> {
  // The A/B switch. Setting it puts every store back on the real 54-step chain, which
  // is how "the suite reports the same results with and without the fixture" is
  // demonstrated — and the first thing to try when a store test looks wrong.
  if (process.env[FIXTURE_DISABLED_ENV]) return
  const imagePath = await ensureSchemaImage()
  // Undefined means the image could not be built or cached. Nothing is installed and
  // every store runs the real chain — slower, never wrong.
  if (imagePath !== undefined) process.env[SCHEMA_IMAGE_ENV] = imagePath
}
