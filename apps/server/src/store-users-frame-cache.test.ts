import { asUserId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { SessionStore } from './store'
import { type LegacyHandleHolder, probeLegacyStatements } from './store/executor'
import { openTestStore } from './test-support/open-test-store'

/**
 * THE ACCOUNT FRAME CACHE [POD-1931].
 *
 * Every authorization decision asks who the principal is, so the account read
 * rides the publish fan-out. One event-loop frame on the live server issued
 * 1,221 `SELECT * FROM users WHERE id = ?` statements against a table holding
 * ONE row — the same answer, 1,221 times.
 *
 * The conserved quantity is the NUMBER OF READS. Each test asserts both a read
 * that is saved and a read that still happens, so the probe cannot be dead.
 */
/**
 * THE PROBE SITS AT THE EXECUTION SEAM, NOT ON `prepare` [POD-3281].
 *
 * It used to count PREPARATIONS by patching `store.db.prepare`. The executor's
 * driver keeps one prepared statement per SQL text, so under a converted
 * repository that count is 1 forever however many times the read runs — the
 * probe would report a cache that works whether or not it does. The seam counts
 * EXECUTIONS on whichever feed issued them, so the number survives the
 * conversion. Today the store is unconverted and the two counts coincide, which
 * is exactly why this moves now rather than in a conversion commit.
 */
const readProbe = (store: SessionStore): (() => number) => {
  let reads = 0
  probeLegacyStatements(store as unknown as LegacyHandleHolder, (observation) => {
    if (observation.sql.includes('FROM users WHERE id')) reads += 1
  })
  return () => reads
}

const freshStore = async (): Promise<SessionStore> => {
  const store = openTestStore(':memory:')
  await Promise.resolve()
  return store
}

describe('account frame read cache', () => {
  it('reads the account once per frame and re-reads on the next turn', async () => {
    const store = await freshStore()
    const reads = readProbe(store)

    const first = store.users.get(FIRST_ADMIN_USER_ID)
    const afterFirst = reads()
    expect(afterFirst).toBeGreaterThan(0)

    store.users.get(FIRST_ADMIN_USER_ID)
    store.users.roleOf(FIRST_ADMIN_USER_ID)
    expect(reads()).toBe(afterFirst)
    expect(store.users.get(FIRST_ADMIN_USER_ID)?.role).toBe(first?.role)

    await Promise.resolve()
    store.users.get(FIRST_ADMIN_USER_ID)
    expect(reads()).toBeGreaterThan(afterFirst)
  })

  it('caches "no account" as an answer, because that is the verdict callers act on', async () => {
    const store = await freshStore()
    const reads = readProbe(store)
    expect(store.users.get(asUserId('user-nobody'))).toBeUndefined()
    const afterFirst = reads()
    expect(store.users.get(asUserId('user-nobody'))).toBeUndefined()
    expect(store.users.roleOf(asUserId('user-nobody'))).toBeUndefined()
    expect(reads()).toBe(afterFirst)
  })

  it('hands every caller its own object', async () => {
    const store = await freshStore()
    const first = store.users.get(FIRST_ADMIN_USER_ID)
    expect(first).toBeDefined()
    if (first) first.displayName = 'Mutated by its reader'
    expect(store.users.get(FIRST_ADMIN_USER_ID)?.displayName).not.toBe('Mutated by its reader')
  })

  it('a mint inside the frame is visible to the read that follows it', async () => {
    const store = await freshStore()
    expect(store.users.get(asUserId('user-minted'))).toBeUndefined()
    store.users.create(
      {
        id: 'user-minted',
        displayName: 'Minted',
        role: 'member',
        createdAt: 't0',
        disabledAt: null,
      },
      'hash',
    )
    expect(store.users.get(asUserId('user-minted'))?.displayName).toBe('Minted')
  })
})
