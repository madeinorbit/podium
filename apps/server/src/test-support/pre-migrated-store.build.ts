/**
 * Builds and caches the pre-migrated schema image [POD-523] — the half of the
 * fixture that knows about migrations. See `pre-migrated-store.ts` for the design;
 * this file exists as a SEPARATE module for one reason, and it is a measured one.
 *
 * The per-fork half is loaded by a vitest setupFile, i.e. by all ~291 apps/server
 * test files including the ~200 that never construct a store. Pulling the migration
 * chain's module graph (drizzle-orm, its bun-sqlite migrator, the 57 KB manifest)
 * into that path cost a pure policy file 43 s of setup where it had cost 0.4 s —
 * import time is already 53.5% of the server lane's work (POD-515), so paying it
 * everywhere to save migrations somewhere would have been a net loss.
 *
 * So the split is: this module runs ONCE per run, in vitest's main process
 * (`globalSetup`), and even there the migrator is behind the cache-miss branch —
 * a warm run only hashes the manifest. The forks read the finished file.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DRIZZLE_MIGRATIONS } from '../migrations/drizzle-manifest.generated'

/** Bump when the shape of what is cached changes, independently of the manifest. */
const FIXTURE_FORMAT = 1

/**
 * The cache key: the identity of the schema an image was built from.
 *
 * THIS IS THE INVALIDATION GUARANTEE the whole change rests on. Schema DDL lives
 * only in `src/migrations/` ([spec:SP-4428], and `store.ts` says so), so every
 * schema change is a change to some migration's name or sql — and every such change
 * is a different digest, a different filename, and therefore a rebuild. There is no
 * step anyone can forget. A stale image cannot be reached, only orphaned.
 */
export function schemaFingerprint(migrations = DRIZZLE_MIGRATIONS): string {
  const hash = createHash('sha256')
  hash.update(`podium-test-schema/v${FIXTURE_FORMAT}\n`)
  // Name AND sql, and the length before the sql so no two migrations can be
  // concatenated into the same bytes as one.
  for (const { name, sql } of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(`${name}\n${sql.length}\n${sql}\n`)
  }
  return hash.digest('hex').slice(0, 32)
}

/**
 * Where the image for `fingerprint` lives.
 *
 * NOT under tmp, deliberately [spec:SP-0be7]: the hermetic setup repoints TMPDIR at
 * a per-file container that is deleted when the fork exits, so a tmp cache would be
 * rebuilt ~291 times per run. `node_modules/.cache` is the conventional home for a
 * derived artifact — already ignored, and wiped by a clean install.
 */
export function schemaCachePath(fingerprint = schemaFingerprint()): string {
  const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  return join(repositoryRoot, 'node_modules', '.cache', 'podium-test-schema', `${fingerprint}.db`)
}

/**
 * The path to a verified current-schema image, building it if this checkout has
 * none. Returns undefined when the image could neither be built nor cached, which
 * leaves every store on the real chain — slower, never wrong.
 */
export async function ensureSchemaImage(): Promise<string | undefined> {
  const cachePath = schemaCachePath()
  if (existsSync(cachePath)) return cachePath
  try {
    // Behind the miss: this is the import the split exists to keep out of the forks.
    const { buildSchemaImage, assertImageMatchesManifest } = await import(
      './pre-migrated-store.image'
    )
    const image = buildSchemaImage()
    assertImageMatchesManifest(image)
    mkdirSync(dirname(cachePath), { recursive: true })
    // Rename, not a direct write: concurrent lanes race here and a reader must
    // never see a half-written image. Same directory, so the rename is atomic.
    const staging = `${cachePath}.${process.pid}.tmp`
    writeFileSync(staging, image)
    renameSync(staging, cachePath)
    return cachePath
  } catch (error) {
    // A read-only checkout, a full disk, a runtime without sqlite3_serialize, a
    // migration that no longer applies — all of them mean "no fixture", and the real
    // chain is always a correct answer. But SAY SO: the only other symptom is a suite
    // that quietly went back to costing 400 ms a store, which reads as nothing at all.
    console.warn(
      `[podium:test] no pre-migrated schema image; every store will run the full ` +
        `migration chain — ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
}
