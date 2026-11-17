/**
 * THE REMAINING STORES ARE A WORKSPACE'S, OR THE INSTALL'S (POD-6959 design 2.4, 2.5; task
 * POD-7023).
 *
 * Two workspaces over one database (`openWorkspaceStores`), each seeded through its own
 * repositories: recap watermarks (`store/read-watermarks.ts`), quota windows
 * (`store/quota-history.ts`) and durable operations (`modules/operations/store.ts`).
 * The ids differ between the workspaces, so a read or write aimed at the other workspace's ids
 * has ids only that workspace holds to miss. Since the key migration (POD-7024) every key
 * leads with workspace_id and the same id is two rows; the cases that hold the same ids in
 * both are marked below, and the rest of the conversion is POD-7025's.
 *
 * For every repository method of those files:
 *   - a read answers only its own workspace's rows, the whole-table listings and counts
 *     included;
 *   - a write in one workspace (an update, a terminal stamp, a delete, a prune, a sweep) aimed
 *     at the other's ids, or reaching every row it may, leaves the other's rows exactly as they
 *     were.
 *
 * Operations show the point of it: single-flight is per workspace, so a group one workspace
 * holds is free in the other.
 *
 * The update recovery checkpoint (`modules/updates/recovery-store.ts`) is an install key of
 * `meta`: every workspace's store reads and writes the same row.
 */

import { asSessionId, asUserId, type QuotaSample, type SessionId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PersistedOperation } from '../modules/operations/store'
import type { ReaderRef } from '../modules/sessions/read-toolkit'
import type { UpdateRecoverySnapshot } from '../modules/updates/recovery-store'
import type { SessionStore } from '../store'
import { openWorkspaceStores } from '../test-support/workspace-stores'

type Tag = 'a' | 'b'
const WS: Record<Tag, string> = { a: 'ws_a', b: 'ws_b' }
const TAGS: readonly Tag[] = ['a', 'b']
const other = (tag: Tag): Tag => (tag === 'a' ? 'b' : 'a')

const SAMPLING = 15 * 60_000
const RESETS = Date.parse('2026-11-24T01:00:00.000Z')
const SEEN = Date.parse('2026-11-17T10:00:00.000Z')

interface RawDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
}
const rawDb = (store: SessionStore): RawDb => (store as unknown as { db: RawDb }).db

/** The workspace tables these repositories read and write. */
const TABLES = ['recap_watermarks', 'quota_windows', 'operations'] as const

function rowsOf(store: SessionStore, tag: Tag): Record<string, unknown[]> {
  return Object.fromEntries(
    TABLES.map((table) => [
      table,
      rawDb(store)
        .prepare(`SELECT * FROM ${table} WHERE workspace_id = ? ORDER BY rowid`)
        .all(WS[tag]),
    ]),
  )
}

const reader = (tag: Tag): ReaderRef => asSessionId(`${tag}-sess-reader`)
const target = (tag: Tag): SessionId => asSessionId(`${tag}-sess-target`)
const account = (tag: Tag, name = 'main'): string => `claude-code::${tag}-${name}@example.com`

function sample(tag: Tag, over: Partial<QuotaSample> = {}): QuotaSample {
  return {
    accountKey: account(tag),
    agent: 'claude-code',
    windowKey: 'weekly-all',
    label: 'Weekly',
    usedPercent: 10,
    resetsAtMs: RESETS,
    windowMinutes: 10080,
    atMs: SEEN,
    source: 'live',
    ...over,
  }
}

const opId = (tag: Tag, name: string): string => `op_${tag}_${name}`

/** An operation of `tag`'s workspace. The exclusion group is the same name in both. */
function operation(
  tag: Tag,
  name: string,
  over: Partial<PersistedOperation> = {},
): PersistedOperation {
  return {
    id: opId(tag, name),
    kind: 'test',
    exclusionGroup: 'lifecycle',
    state: 'running',
    createdAt: 1000,
    updatedAt: 1000,
    steps: [{ id: 'first', state: 'running' }],
    ...over,
  }
}

/** A user-started update approval, the row `approvedTarget` serves. */
function approval(tag: Tag, name: string, version: string, createdAt: number): PersistedOperation {
  return operation(tag, name, {
    kind: 'update',
    exclusionGroup: 'server-update',
    createdBy: 'user',
    createdAt,
    updatedAt: createdAt,
    state: 'done',
    finishedAt: createdAt,
    details: { channel: 'dev', target: { version, critical: false, artifacts: {} } },
  })
}

/** One workspace's rows, written through its own repositories. */
async function seed(store: SessionStore, tag: Tag): Promise<void> {
  await store.readWatermarks.setRecapWatermark(reader(tag), target(tag), `${tag}-mark-1`, 'at-1')

  // Two series: `main` with one window, `spare` with an older and a newer window.
  await store.quotaHistory.record(sample(tag), SAMPLING, null)
  await store.quotaHistory.record(
    sample(tag, { accountKey: account(tag, 'spare'), resetsAtMs: RESETS - 7 * 86_400_000 }),
    SAMPLING,
    null,
  )
  await store.quotaHistory.record(sample(tag, { accountKey: account(tag, 'spare') }), SAMPLING)

  // A live operation holding `lifecycle`, a finished one, a finished one whose cleanup is
  // pending, and two settled approvals.
  await store.operations.insert(operation(tag, 'live'))
  await store.operations.insert(
    operation(tag, 'finished', {
      exclusionGroup: 'reindex',
      state: 'done',
      createdAt: 900,
      updatedAt: 900,
      finishedAt: 900,
    }),
  )
  await store.operations.insert(
    operation(tag, 'cleanup', {
      exclusionGroup: 'reindex',
      state: 'failed',
      createdAt: 800,
      updatedAt: 800,
      finishedAt: 800,
      details: { cleanup: { status: 'pending' } },
    }),
  )
  await store.operations.insert(approval(tag, 'approved-old', `${tag}-1`, 500))
  await store.operations.insert(approval(tag, 'approved-new', `${tag}-2`, 600))
}

let stores: Record<Tag, SessionStore>

beforeEach(async () => {
  const [a, b] = await openWorkspaceStores([WS.a, WS.b], { path: ':memory:' })
  stores = { a, b }
  for (const tag of TAGS) await seed(stores[tag], tag)
})

afterEach(async () => {
  await stores.a.close()
})

/** Runs `write` in `tag`'s workspace and holds the other's rows to what they were before. */
async function leavesOtherUnchanged(tag: Tag, write: (store: SessionStore) => Promise<unknown>) {
  const before = rowsOf(stores[other(tag)], other(tag))
  await write(stores[tag])
  expect(rowsOf(stores[other(tag)], other(tag))).toEqual(before)
}

describe('each workspace holds its own rows', () => {
  it('the seed wrote each workspace its own rows and no more', () => {
    for (const tag of TAGS) {
      const rows = rowsOf(stores[tag], tag)
      expect(rows.recap_watermarks).toHaveLength(1)
      expect(rows.quota_windows).toHaveLength(3)
      expect(rows.operations).toHaveLength(5)
    }
  })
})

describe('recap watermarks (store/read-watermarks.ts)', () => {
  it.each(TAGS)('getRecapWatermark in %s reads only its own cursor', async (tag) => {
    const store = stores[tag]
    expect(await store.readWatermarks.getRecapWatermark(reader(tag), target(tag))).toBe(
      `${tag}-mark-1`,
    )
    expect(
      await store.readWatermarks.getRecapWatermark(reader(other(tag)), target(other(tag))),
    ).toBeNull()
  })

  it.each(TAGS)('setRecapWatermark in %s moves only its own cursor', async (tag) => {
    await leavesOtherUnchanged(tag, async (store) => {
      await store.readWatermarks.setRecapWatermark(
        reader(tag),
        target(tag),
        `${tag}-mark-2`,
        'at-2',
      )
      // A new key of its own: inserted in its workspace only.
      await store.readWatermarks.setRecapWatermark(
        reader(tag),
        asSessionId(`${tag}-sess-new`),
        `${tag}-mark-new`,
        'at-2',
      )
    })
    const store = stores[tag]
    expect(await store.readWatermarks.getRecapWatermark(reader(tag), target(tag))).toBe(
      `${tag}-mark-2`,
    )
    expect(rowsOf(store, tag).recap_watermarks).toHaveLength(2)
  })
})

describe('quota windows (store/quota-history.ts)', () => {
  it.each(TAGS)('list, countAll and trail in %s read only its own windows', async (tag) => {
    const store = stores[tag]
    const own = [account(tag), account(tag, 'spare'), account(tag, 'spare')]
    expect((await store.quotaHistory.list(0, SEEN)).map((w) => w.accountKey)).toEqual(own)
    expect(await store.quotaHistory.countAll()).toBe(3)
    expect(await store.quotaHistory.trail(account(tag), 'weekly-all', RESETS)).not.toEqual([])
    expect(await store.quotaHistory.trail(account(other(tag)), 'weekly-all', RESETS)).toEqual([])
  })

  it.each(TAGS)('listFor in %s reads only its own windows of an owner', async (tag) => {
    // The owner id is the same in both workspaces: only the workspace tells them apart.
    const owner = asUserId('mem_quota_owner')
    for (const t of TAGS) {
      await stores[t].quotaHistory.record(
        sample(t, { accountKey: account(t, 'owned') }),
        SAMPLING,
        owner,
      )
    }
    expect(
      (await stores[tag].quotaHistory.listFor(owner, 0, SEEN)).map((w) => w.accountKey),
    ).toEqual([account(tag, 'owned')])
  })

  it.each(TAGS)('record in %s folds into its own window only', async (tag) => {
    await leavesOtherUnchanged(tag, async (store) => {
      // The fold arm (same window), the older-window arm (a backfill reaching behind the
      // newest), and a new window.
      await store.quotaHistory.record(
        sample(tag, { usedPercent: 40, atMs: SEEN + 60_000 }),
        SAMPLING,
      )
      await store.quotaHistory.record(
        sample(tag, {
          accountKey: account(tag, 'spare'),
          resetsAtMs: RESETS - 7 * 86_400_000,
          usedPercent: 70,
        }),
        SAMPLING,
      )
      await store.quotaHistory.record(sample(tag, { accountKey: account(tag, 'new') }), SAMPLING)
    })
    const windows = await stores[tag].quotaHistory.list(0, SEEN)
    expect(windows.find((w) => w.accountKey === account(tag))?.peakPercent).toBe(40)
    expect(windows).toHaveLength(4)
  })

  it.each(TAGS)('prune in %s drops only its own windows', async (tag) => {
    await leavesOtherUnchanged(tag, async (store) => {
      expect(await store.quotaHistory.prune(Number.MAX_SAFE_INTEGER)).toBe(3)
    })
    expect(await stores[tag].quotaHistory.countAll()).toBe(0)
    expect(await stores[other(tag)].quotaHistory.countAll()).toBe(3)
  })
})

describe('operations (modules/operations/store.ts)', () => {
  it.each(TAGS)('get, active, activeByGroup and history in %s read only its own', async (tag) => {
    const ops = stores[tag].operations
    expect((await ops.get(opId(tag, 'live')))?.id).toBe(opId(tag, 'live'))
    expect(await ops.get(opId(other(tag), 'live'))).toBeUndefined()
    expect((await ops.active()).map((r) => r.id)).toEqual([opId(tag, 'live')])
    expect((await ops.activeByGroup('lifecycle'))?.id).toBe(opId(tag, 'live'))
    expect((await ops.history()).map((r) => r.id)).toEqual(
      ['live', 'finished', 'cleanup', 'approved-new', 'approved-old'].map((n) => opId(tag, n)),
    )
    expect((await ops.history('update', 1)).map((r) => r.id)).toEqual([opId(tag, 'approved-new')])
    expect((await ops.pendingCleanup()).map((r) => r.id)).toEqual([opId(tag, 'cleanup')])
    expect((await ops.approvedTarget('dev'))?.version).toBe(`${tag}-2`)
  })

  it.each(TAGS)('a group held in the other workspace is free in %s', async (tag) => {
    const ops = stores[tag].operations
    // The other's live `lifecycle` operation does not hold this workspace's group.
    await ops.update(operation(tag, 'live', { state: 'done', finishedAt: 2000, updatedAt: 2000 }))
    await leavesOtherUnchanged(tag, async () => {
      expect(await ops.claimGroup(operation(tag, 'claimed', { createdAt: 3000 }))).toEqual({
        claimed: true,
      })
    })
    // And its own live operation does hold it.
    const refused = await ops.claimGroup(operation(tag, 'second', { createdAt: 4000 }))
    expect(refused).toMatchObject({ claimed: false, heldBy: { id: opId(tag, 'claimed') } })
  })

  it.each(
    TAGS,
  )("update and markTerminal in %s aimed at the other's ids change nothing", async (tag) => {
    const ops = stores[tag].operations
    await leavesOtherUnchanged(tag, async () => {
      await ops.update(
        operation(other(tag), 'live', { state: 'done', finishedAt: 2000, updatedAt: 2000 }),
      )
      await ops.markTerminal(opId(other(tag), 'live'), 'failed', 2000)
    })
    // Its own ids move.
    await leavesOtherUnchanged(tag, async () => {
      await ops.update(operation(tag, 'live', { updatedAt: 1500 }))
      await ops.markTerminal(opId(tag, 'finished'), 'canceled', 2000)
    })
    expect((await ops.get(opId(tag, 'live')))?.updatedAt).toBe(1500)
    expect((await ops.get(opId(tag, 'finished')))?.state).toBe('canceled')
  })

  it.each(TAGS)('sweepRetention in %s sweeps only its own history', async (tag) => {
    const ops = stores[tag].operations
    await leavesOtherUnchanged(tag, async () => {
      expect(await ops.sweepRetention('test', 0)).toBe(2)
      // The newest settled approval per channel is kept; the older one goes.
      expect(await ops.sweepRetention('update', 0)).toBe(1)
    })
    expect((await ops.history()).map((r) => r.id)).toEqual([
      opId(tag, 'live'),
      opId(tag, 'approved-new'),
    ])
  })
})

describe('update recovery (modules/updates/recovery-store.ts) is the install’s', () => {
  it('both workspaces read and write the one checkpoint', async () => {
    const snapshot = (lastGrantAuthority: number): UpdateRecoverySnapshot => ({
      format: 1,
      lastGrantAuthority,
      targets: [],
      machines: [],
      grants: [],
      rollouts: [],
    })
    expect(await stores.a.updateRecovery.read()).toBeUndefined()
    await stores.a.updateRecovery.write(() => snapshot(1))
    expect(await stores.b.updateRecovery.read()).toEqual(snapshot(1))
    await stores.b.updateRecovery.write(() => snapshot(2))
    expect(await stores.a.updateRecovery.read()).toEqual(snapshot(2))
    const rows = rawDb(stores.a)
      .prepare("SELECT key FROM meta WHERE key = 'updates.execution.v1'")
      .all()
    expect(rows).toHaveLength(1)
  })
})

/**
 * THE SAME ID IN BOTH WORKSPACES (POD-7024): every ON CONFLICT target leads with workspace_id,
 * so an upsert in A of an id B already holds makes A its own row, B's row stays byte for byte
 * as it was, and A's second upsert of the id updates A's row only.
 */
describe('the same id in both workspaces, upserted through the repository (POD-7024)', () => {
  it("makes a second row, leaves the other workspace's as it was, and updates only its own", async () => {
    const rowsIn = (store: SessionStore, ws: string) =>
      rawDb(store)
        .prepare(
          'SELECT * FROM quota_windows WHERE workspace_id = ? AND account_key = ? ORDER BY rowid',
        )
        .all(ws, SAME)
    const SAME = 'claude-code::same@example.com'
    const { a, b } = stores
    await b.quotaHistory.record(sample('b', { accountKey: SAME }), SAMPLING)
    const before = rowsIn(b, WS.b)
    await a.quotaHistory.record(sample('a', { accountKey: SAME }), SAMPLING)
    expect(rowsIn(a, WS.a)).toHaveLength(1)
    expect(rowsIn(b, WS.b)).toEqual(before)
    await a.quotaHistory.record(
      sample('a', { accountKey: SAME, usedPercent: 40, atMs: SEEN + SAMPLING }),
      SAMPLING,
    )
    expect(rowsIn(a, WS.a)).toEqual([expect.objectContaining({ peak_percent: 40 })])
    expect(rowsIn(b, WS.b)).toEqual(before)
  })
})
