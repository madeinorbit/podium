import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The Node driver stays gone [PDM-25].
 *
 * `node:sqlite` was removed because everything above the shim is already
 * Bun-only — the drizzle migrator, the serialize/deserialize helpers, the
 * compiled binary, every test lane. A re-added import would not fail anywhere
 * (the lanes all run under Bun, where it may even resolve); it would just
 * quietly re-open the question of which runtime this package supports.
 */
const SQLITE_SRC = fileURLToPath(new URL('../src/sqlite/', import.meta.url))

describe('sqlite shim runtime', () => {
  it('names no Node SQLite driver anywhere under src/sqlite', () => {
    const offenders = readdirSync(SQLITE_SRC).filter((name) =>
      readFileSync(join(SQLITE_SRC, name), 'utf8').includes('node:sqlite'),
    )
    expect(offenders).toEqual([])
  })
})
