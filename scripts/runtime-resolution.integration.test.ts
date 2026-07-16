/**
 * @podium/runtime must load ONCE per worker — proven from scripts/, the seam that broke.
 *
 * scripts/ is not a workspace package, so it owns no node_modules/@podium symlink and
 * resolves '@podium/runtime/sqlite' by walking UP the filesystem. That walk can leave the
 * checkout entirely and land in a sibling one, while apps/server — which does own a symlink
 * once a worktree-local `bun install` has run — resolves the same specifier to the copy
 * under test. Two copies, two module-scoped WeakMaps [POD-746].
 *
 * The damage is not limited to the migrator: a worktree with no local install resolved
 * @podium/runtime to MAIN's checkout and tested code that was not the code under test —
 * silently, and green. vitest.config.ts anchors the alias to this checkout; this test is
 * what fails if that anchor is ever removed or a lane resolves around it.
 *
 * Deliberately NOT asserted through import.meta.resolve: that is the runtime resolver and
 * it never sees vite's aliases (it still reports the pre-fix paths). Module IDENTITY is the
 * thing that decides whether the WeakMap hits, so identity is what this asserts.
 *
 * This is NOT a migrator bug, whatever the issue title says: sqlite/ has TWO module-scoped
 * WeakMaps, and the loud one is the lucky one.
 *   bun.ts:36         rawByWrapper — throws when it misses (what POD-746 chased)
 *   transaction.ts:19 depths       — would MISS IN SILENCE: a nesting depth read from a map
 *                                    that never saw the handle reads undefined, so a nested
 *                                    transaction runs as a top-level one and its writes
 *                                    commit while the caller still believes they can roll back.
 * One anchor cures both and this one test fails for both — but the silent member is the
 * reason the anchor is not optional, and the reason to reach for the anchor rather than
 * teach each WeakMap to tolerate duplication.
 */

import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { applyBaselineSchema } from '../apps/server/src/migrations'

describe('@podium/runtime resolves to one instance (#746)', () => {
  it('the migrator recognises a database this file opened', () => {
    // The cross-package round trip: openDatabase() here registers the handle in the
    // WeakMap of whichever copy scripts/ resolved; applyBaselineSchema() reads it back
    // through the copy apps/server resolved. Two copies => bunSqliteClient() returns
    // undefined and this throws "does not recognise this database handle".
    const db = openDatabase(':memory:')
    expect(() => applyBaselineSchema(db)).not.toThrow()
    // The schema really was built — a migrator that silently no-ops would also "not throw".
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().length,
    ).toBeGreaterThan(0)
  })
})
