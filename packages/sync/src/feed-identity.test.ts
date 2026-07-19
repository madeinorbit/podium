import { describe, expect, it } from 'vitest'
import { minAvailableSeq, pruneChangeLog } from './change-log'
import {
  ensureFeedIdentity,
  type FeedIdentity,
  type FeedIdentityStore,
  newEpoch,
  newFeedId,
  remintEpoch,
} from './feed-identity'
import { Ledger } from './ledger'
import { createTestSyncRepository } from './test-support'

/**
 * Feed identity (ADR 2 D1) and the published retention horizon (D5). These pin
 * the properties the protocol actually leans on: minted once per authority,
 * re-minted (never re-derived) on restore, feedId stable across a re-mint, and
 * — the one a counter would silently fail — two re-mints of the SAME starting
 * value never collide.
 */

/** A counting minter, so every id in a test is distinguishable at a glance. */
function seqMint(prefix: string): () => string {
  let n = 0
  return () => `${prefix}_${++n}`
}

describe('ensureFeedIdentity', () => {
  it('mints once per authority database and returns the SAME pair on every later call', () => {
    const repo = createTestSyncRepository()
    const first = ensureFeedIdentity(repo, seqMint('id'))
    // A different minter proves the second call read persisted state rather than
    // minting again: if it minted, the ids would carry the other prefix.
    const second = ensureFeedIdentity(repo, seqMint('other'))
    expect(second).toEqual(first)
    expect(repo.readFeedIdentity()).toEqual(first)
  })

  it('persists the pair durably (a fresh read sees it)', () => {
    const repo = createTestSyncRepository()
    const minted = ensureFeedIdentity(repo, seqMint('id'))
    expect(repo.readFeedIdentity()).toEqual({ feedId: minted.feedId, epoch: minted.epoch })
  })

  it('mints feedId and epoch as DISTINCT ids (a shared value would alias two questions)', () => {
    const identity = ensureFeedIdentity(createTestSyncRepository())
    expect(identity.feedId).not.toBe(identity.epoch)
  })

  it('initFeedIdentity is a no-op once a row exists — a second mint must never re-identify a live feed', () => {
    const repo = createTestSyncRepository()
    const original = ensureFeedIdentity(repo, seqMint('id'))
    repo.initFeedIdentity({ feedId: 'usurper', epoch: 'usurper' })
    expect(repo.readFeedIdentity()).toEqual(original)
  })
})

describe('remintEpoch', () => {
  it('replaces the epoch and KEEPS the feedId — a restore is the same feed on a new generation', () => {
    const repo = createTestSyncRepository()
    const before = ensureFeedIdentity(repo, seqMint('id'))
    const after = remintEpoch(repo, seqMint('epoch'))
    expect(after.feedId).toBe(before.feedId)
    expect(after.previousEpoch).toBe(before.epoch)
    expect(after.epoch).not.toBe(before.epoch)
    expect(repo.readFeedIdentity()).toEqual({ feedId: before.feedId, epoch: after.epoch })
  })

  it('NEVER re-collides: re-minting the same starting epoch twice yields two different epochs', () => {
    // THE anti-counter property, and the reason ADR 2 D1 spends its longest
    // paragraph on it. Restoring one backup twice — a second rollback attempt, a
    // re-run runbook, a botched first restore — re-presents the SAME stored
    // epoch to the bump. A counter maps it to the same successor both times
    // ("3 → 4", then "3 → 4" again) and hands a second, different timeline an
    // epoch clients have already accepted, silently, in exactly the situation
    // the epoch exists to catch. A minted id cannot.
    const restoreOnce = (): string => {
      const repo = createTestSyncRepository()
      repo.initFeedIdentity({ feedId: 'feed_A', epoch: 'epoch_FROM_THE_BACKUP' })
      return remintEpoch(repo).epoch
    }
    const first = restoreOnce()
    const second = restoreOnce()
    expect(first).not.toBe('epoch_FROM_THE_BACKUP')
    expect(second).not.toBe('epoch_FROM_THE_BACKUP')
    expect(first).not.toBe(second)
  })

  it('mints a fresh pair when there is nothing to re-mint (a database from before D1)', () => {
    const repo = createTestSyncRepository()
    const r = remintEpoch(repo, seqMint('fresh'))
    expect(r.previousEpoch).toBe('')
    expect(repo.readFeedIdentity()).toEqual({ feedId: r.feedId, epoch: r.epoch })
  })
})

describe('minted ids', () => {
  it('newEpoch and newFeedId never repeat', () => {
    const ids = new Set([
      ...Array.from({ length: 200 }, newEpoch),
      ...Array.from({ length: 200 }, newFeedId),
    ])
    expect(ids.size).toBe(400)
  })
})

describe('Ledger feed identity', () => {
  it('mints on construction and reuses the persisted pair on the next boot', () => {
    const repo = createTestSyncRepository()
    const first = new Ledger({
      repo,
      now: () => 1_000,
      transact: (fn) => fn(),
      newId: seqMint('boot1'),
    }).feedIdentity()
    // Reboot over the same database with a minter that would produce different
    // ids: a re-mint here would silently re-identify a live feed.
    const second = new Ledger({
      repo,
      now: () => 2_000,
      transact: (fn) => fn(),
      newId: seqMint('boot2'),
    }).feedIdentity()
    expect(second).toEqual(first)
  })

  it('two independent authorities are different feeds', () => {
    const identity = () =>
      new Ledger({
        repo: createTestSyncRepository(),
        now: () => 1_000,
        transact: (fn) => fn(),
      }).feedIdentity()
    expect(identity().feedId).not.toBe(identity().feedId)
  })
})

describe('minAvailableSeq (ADR 2 D5)', () => {
  const append = (repo: ReturnType<typeof createTestSyncRepository>, n: number, at = 1_000) => {
    for (let i = 0; i < n; i++) {
      repo.appendChanges([{ entity: 'issue', entityId: `i${i}`, op: 'upsert', payload: '{}' }], at)
    }
  }

  it('is 1 on a virgin log — the next change it writes will be seq 1', () => {
    expect(minAvailableSeq(createTestSyncRepository())).toBe(1)
  })

  it('is the lowest RETAINED seq once rows exist', async () => {
    const repo = createTestSyncRepository()
    append(repo, 5)
    expect(minAvailableSeq(repo)).toBe(1)
    await pruneChangeLog(repo, { keepRows: 2, maxAgeMs: Number.MAX_SAFE_INTEGER, now: 1_000 })
    expect(minAvailableSeq(repo)).toBe(4)
  })

  it('is max + 1 when the log is FULLY pruned — not 0, and not a null every caller must special-case', async () => {
    const repo = createTestSyncRepository()
    append(repo, 3, 1_000)
    // Age every row out. maxChangeSeq survives via sqlite_sequence; the rows do not.
    await pruneChangeLog(repo, { keepRows: 20_000, maxAgeMs: 1, now: 10_000 })
    expect(repo.minChangeSeq()).toBeNull()
    expect(repo.maxChangeSeq()).toBe(3)
    expect(minAvailableSeq(repo)).toBe(4)
  })

  it('AGREES with the servability rule it advertises: cursor + 1 >= minAvailableSeq iff a delta is served', async () => {
    // The number is only worth publishing if a replica acting on it reaches the
    // same verdict the authority would. Sweep every cursor against both.
    const repo = createTestSyncRepository()
    append(repo, 6)
    await pruneChangeLog(repo, { keepRows: 3, maxAgeMs: Number.MAX_SAFE_INTEGER, now: 1_000 })
    const ledger = new Ledger({ repo, now: () => 1_000, transact: (fn) => fn() })
    const horizon = ledger.minAvailableSeq()
    expect(horizon).toBe(4) // rows 4,5,6 retained
    for (let cursor = 0; cursor <= 6; cursor++) {
      const servedByAuthority = ledger.changesSince(cursor) !== null
      const predictedByReplica = cursor + 1 >= horizon
      expect({ cursor, servedByAuthority }).toEqual({
        cursor,
        servedByAuthority: predictedByReplica,
      })
    }
  })
})

describe('FeedIdentityStore contract', () => {
  it('is satisfiable without a database (the Ledger never reaches for a concrete repo)', () => {
    // Pins the injection seam: LedgerDeps takes the narrow interface, so an
    // authority could persist identity somewhere else entirely.
    let row: FeedIdentity | null = null
    const store: FeedIdentityStore = {
      readFeedIdentity: () => row,
      initFeedIdentity: (next) => {
        row ??= next
      },
      setEpoch: (epoch) => {
        if (row) row = { ...row, epoch }
      },
    }
    const minted = ensureFeedIdentity(store, seqMint('mem'))
    expect(ensureFeedIdentity(store, seqMint('other'))).toEqual(minted)
    expect(remintEpoch(store, seqMint('re')).feedId).toBe(minted.feedId)
  })
})
