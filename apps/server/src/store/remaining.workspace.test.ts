/**
 * THE REMAINING STORES ARE A WORKSPACE'S, OR THE INSTALL'S (POD-6959 design 2.4, 2.5; task
 * POD-7023).
 *
 * Two workspaces over one database (`openWorkspaceStores`), each seeded through its own
 * repositories: recap watermarks (`store/read-watermarks.ts`), quota windows
 * (`store/quota-history.ts`) and durable operations (`modules/operations/store.ts`).
 * Both workspaces hold the SAME ids and natural keys (POD-7025): every key leads with
 * workspace_id (POD-7024), so the same id is two rows, told apart only by the workspace. The
 * content differs (a watermark's value, a window's label, an operation's step and approved
 * version), so a read that crossed over would answer the other workspace's content. Where a
 * case needs an id the other workspace does not hold, it plants one only the other holds.
 *
 * For every repository method of those files:
 *   - a read answers only its own workspace's rows, the whole-table listings and counts
 *     included;
 *   - a write in one workspace (an update, a terminal stamp, a delete, a prune, a sweep) of an
 *     id both hold, of an id only the other holds, or reaching every row it may, leaves the
 *     other's rows exactly as they were.
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

/** The same ids in both workspaces. */
const READER: ReaderRef = asSessionId('sess-reader')
const TARGET: SessionId = asSessionId('sess-target')
const account = (name = 'main'): string => `claude-code::${name}@example.com`

function sample(tag: Tag, over: Partial<QuotaSample> = {}): QuotaSample {
  return {
    accountKey: account(),
    agent: 'claude-code',
    windowKey: 'weekly-all',
    // The workspace's own content: a read that crossed over would answer the other label.
    label: `Weekly ${tag}`,
    usedPercent: 10,
    resetsAtMs: RESETS,
    windowMinutes: 10080,
    atMs: SEEN,
    source: 'live',
    ...over,
  }
}

/** The same operation id in both workspaces. */
const opId = (name: string): string => `op_${name}`

/** An operation of `tag`'s workspace: the id and the exclusion group are the same in both, the
 *  step id is the workspace's own. */
function operation(
  tag: Tag,
  name: string,
  over: Partial<PersistedOperation> = {},
): PersistedOperation {
  return {
    id: opId(name),
    kind: 'test',
    exclusionGroup: 'lifecycle',
    state: 'running',
    createdAt: 1000,
    updatedAt: 1000,
    steps: [{ id: `${tag}-first`, state: 'running' }],
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
  await store.readWatermarks.setRecapWatermark(READER, TARGET, `${tag}-mark-1`, 'at-1')

  // Two series: `main` with one window, `spare` with an older and a newer window.
  await store.quotaHistory.record(sample(tag), SAMPLING, null)
  await store.quotaHistory.record(
    sample(tag, { accountKey: account('spare'), resetsAtMs: RESETS - 7 * 86_400_000 }),
    SAMPLING,
    null,
  )
  await store.quotaHistory.record(sample(tag, { accountKey: account('spare') }), SAMPLING)

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
    // The same key in both: each reads its own value.
    expect(await stores[tag].readWatermarks.getRecapWatermark(READER, TARGET)).toBe(`${tag}-mark-1`)
    // A key only the other workspace holds is not there.
    const onlyOther = asSessionId('sess-only-other')
    await stores[other(tag)].readWatermarks.setRecapWatermark(READER, onlyOther, 'x', 'at-1')
    expect(await stores[tag].readWatermarks.getRecapWatermark(READER, onlyOther)).toBeNull()
  })

  it.each(TAGS)('setRecapWatermark in %s moves only its own cursor', async (tag) => {
    await leavesOtherUnchanged(tag, async (store) => {
      // The key both hold moves in this workspace only.
      await store.readWatermarks.setRecapWatermark(READER, TARGET, `${tag}-mark-2`, 'at-2')
      // A new key of its own: inserted in its workspace only.
      await store.readWatermarks.setRecapWatermark(
        READER,
        asSessionId('sess-new'),
        `${tag}-mark-new`,
        'at-2',
      )
    })
    expect(await stores[tag].readWatermarks.getRecapWatermark(READER, TARGET)).toBe(`${tag}-mark-2`)
    expect(rowsOf(stores[tag], tag).recap_watermarks).toHaveLength(2)
    expect(await stores[other(tag)].readWatermarks.getRecapWatermark(READER, TARGET)).toBe(
      `${other(tag)}-mark-1`,
    )
  })
})

describe('quota windows (store/quota-history.ts)', () => {
  it.each(TAGS)('list, countAll and trail in %s read only its own windows', async (tag) => {
    const store = stores[tag]
    const own = [account(), account('spare'), account('spare')].map((key) => [key, `Weekly ${tag}`])
    expect((await store.quotaHistory.list(0, SEEN)).map((w) => [w.accountKey, w.label])).toEqual(
      own,
    )
    expect(await store.quotaHistory.countAll()).toBe(3)
    expect(await store.quotaHistory.trail(account(), 'weekly-all', RESETS)).not.toEqual([])
    // A series only the other workspace holds has no trail here.
    await stores[other(tag)].quotaHistory.record(
      sample(other(tag), { accountKey: account('only-other') }),
      SAMPLING,
    )
    expect(await store.quotaHistory.trail(account('only-other'), 'weekly-all', RESETS)).toEqual([])
  })

  it.each(TAGS)('listFor in %s reads only its own windows of an owner', async (tag) => {
    // The owner id is the same in both workspaces: only the workspace tells them apart.
    const owner = asUserId('mem_quota_owner')
    // So is the account: each workspace answers its own window of it.
    for (const t of TAGS) {
      await stores[t].quotaHistory.record(
        sample(t, { accountKey: account('owned') }),
        SAMPLING,
        owner,
      )
    }
    expect(
      (await stores[tag].quotaHistory.listFor(owner, 0, SEEN)).map((w) => [w.accountKey, w.label]),
    ).toEqual([[account('owned'), `Weekly ${tag}`]])
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
          accountKey: account('spare'),
          resetsAtMs: RESETS - 7 * 86_400_000,
          usedPercent: 70,
        }),
        SAMPLING,
      )
      await store.quotaHistory.record(sample(tag, { accountKey: account('new') }), SAMPLING)
    })
    const windows = await stores[tag].quotaHistory.list(0, SEEN)
    expect(windows.find((w) => w.accountKey === account())?.peakPercent).toBe(40)
    expect(windows).toHaveLength(4)
    const others = await stores[other(tag)].quotaHistory.list(0, SEEN)
    expect(others.find((w) => w.accountKey === account())?.peakPercent).toBe(10)
  })

  it.each(TAGS)('prune in %s drops only its own windows', async (tag) => {
    await leavesOtherUnchanged(tag, async (store) => {
      expect(await store.quotaHistory.prune(Number.MAX_SAFE_INTEGER)).toBe(3)
    })
    expect(await stores[tag].quotaHistory.countAll()).toBe(0)
    expect(await stores[other(tag)].quotaHistory.countAll()).toBe(3)
  })
})

/** The id of an operation row's first step: the workspace's own content (in its payload). */
const stepOf = (row: { payload: string } | undefined): string | undefined =>
  row && (JSON.parse(row.payload) as PersistedOperation).steps?.[0]?.id

describe('operations (modules/operations/store.ts)', () => {
  it.each(TAGS)('get, active, activeByGroup and history in %s read only its own', async (tag) => {
    const ops = stores[tag].operations
    const own = `${tag}-first`
    // The same id in both: each reads its own row, told by its step.
    expect(stepOf(await ops.get(opId('live')))).toBe(own)
    // An id only the other workspace holds is not there.
    await stores[other(tag)].operations.insert(operation(other(tag), 'only-other'))
    expect(await ops.get(opId('only-other'))).toBeUndefined()
    expect((await ops.active()).map((r) => [r.id, stepOf(r)])).toEqual([[opId('live'), own]])
    expect(stepOf(await ops.activeByGroup('lifecycle'))).toBe(own)
    expect((await ops.history()).map((r) => [r.id, stepOf(r)])).toEqual(
      ['live', 'finished', 'cleanup', 'approved-new', 'approved-old'].map((n) => [opId(n), own]),
    )
    expect((await ops.history('update', 1)).map((r) => r.id)).toEqual([opId('approved-new')])
    expect((await ops.pendingCleanup()).map((r) => [r.id, stepOf(r)])).toEqual([
      [opId('cleanup'), own],
    ])
    expect((await ops.approvedTarget('dev'))?.version).toBe(`${tag}-2`)
  })

  it.each(TAGS)('a group held in the other workspace is free in %s', async (tag) => {
    const ops = stores[tag].operations
    // The other's live `lifecycle` operation, of the same id, does not hold this workspace's
    // group.
    await ops.update(operation(tag, 'live', { state: 'done', finishedAt: 2000, updatedAt: 2000 }))
    expect((await stores[other(tag)].operations.activeByGroup('lifecycle'))?.id).toBe(opId('live'))
    await leavesOtherUnchanged(tag, async () => {
      expect(await ops.claimGroup(operation(tag, 'claimed', { createdAt: 3000 }))).toEqual({
        claimed: true,
      })
    })
    // And its own live operation does hold it.
    const refused = await ops.claimGroup(operation(tag, 'second', { createdAt: 4000 }))
    expect(refused).toMatchObject({ claimed: false, heldBy: { id: opId('claimed') } })
  })

  it.each(TAGS)('update and markTerminal in %s move only its own rows', async (tag) => {
    const ops = stores[tag].operations
    // An id only the other workspace holds: nothing to update here, nothing made.
    await stores[other(tag)].operations.insert(operation(other(tag), 'only-other'))
    await leavesOtherUnchanged(tag, async () => {
      await ops.update(
        operation(tag, 'only-other', { state: 'done', finishedAt: 2000, updatedAt: 2000 }),
      )
      await ops.markTerminal(opId('only-other'), 'failed', 2000)
    })
    expect(await ops.get(opId('only-other'))).toBeUndefined()
    // The ids both hold move in this workspace only.
    await leavesOtherUnchanged(tag, async () => {
      await ops.update(operation(tag, 'live', { updatedAt: 1500 }))
      await ops.markTerminal(opId('finished'), 'canceled', 2000)
    })
    expect((await ops.get(opId('live')))?.updatedAt).toBe(1500)
    expect((await ops.get(opId('finished')))?.state).toBe('canceled')
    expect((await stores[other(tag)].operations.get(opId('finished')))?.state).toBe('done')
  })

  it.each(TAGS)('sweepRetention in %s sweeps only its own history', async (tag) => {
    const ops = stores[tag].operations
    await leavesOtherUnchanged(tag, async () => {
      expect(await ops.sweepRetention('test', 0)).toBe(2)
      // The newest settled approval per channel is kept; the older one goes.
      expect(await ops.sweepRetention('update', 0)).toBe(1)
    })
    expect((await ops.history()).map((r) => r.id)).toEqual([opId('live'), opId('approved-new')])
    expect(await stores[other(tag)].operations.history()).toHaveLength(5)
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
 * THE SAME ID UPSERTED FIRST IN THE OTHER WORKSPACE (POD-7024): every ON CONFLICT target leads with workspace_id,
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
