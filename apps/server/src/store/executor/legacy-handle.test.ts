/**
 * The transitional legacy handle [POD-3254].
 *
 * Every repository the store composes now takes the EXECUTOR, and the ones that
 * have not been converted to the query layer yet reach the connection through
 * `executor.legacy`. Two things about that arrangement can be wrong in ways
 * nothing else would notice, and both are arms no ordinary test walks:
 *
 *  1. `legacy` and the driver's connection could be DIFFERENT databases. On the
 *     bun composition they are the same object by construction, and this asserts
 *     the construction rather than the intent — a converted and an unconverted
 *     repository in one set reading two files would be a silent split brain, not
 *     a failure.
 *  2. `legacy` is OPTIONAL, because a fake driver or the remote one has no
 *     bun:sqlite handle to offer. An unconverted repository built over such an
 *     executor has to refuse at CONSTRUCTION. The tempting alternative — reach
 *     for it lazily at the first statement — fails somewhere the stack no longer
 *     says which repository was mis-wired.
 *
 * POD-3267 deletes the field, the accessor and this file together at the end of
 * Stage A, when nothing reads a raw handle any more.
 */

import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { createBunStoreExecutor } from './bun-driver'
import { createStoreExecutor, legacyHandle } from './executor'
import { asyncFakeDriver } from './harness'

describe('the executor legacy handle', () => {
  it('is the same connection the bun driver runs on', () => {
    const database = openDatabase(':memory:')
    const executor = createBunStoreExecutor({ database })
    expect(legacyHandle(executor)).toBe(database)
    database.close()
  })

  it('refuses when the executor has none, naming the conversion as the fix', () => {
    // A driver with no bun:sqlite connection behind it — the shape the remote
    // driver has, and the shape every harness fake has.
    const executor = createStoreExecutor({ driver: asyncFakeDriver() })
    expect(executor.legacy).toBeUndefined()
    expect(() => legacyHandle(executor)).toThrow(/has not been converted/)
  })
})
