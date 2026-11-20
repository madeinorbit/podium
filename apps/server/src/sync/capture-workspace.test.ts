/**
 * A CAPTURED ROW NAMES ITS WORKSPACE, AND THE DRAIN HOLDS IT TO ITS OWN
 * (POD-7021, POD-6959 design 2.7, contract C9).
 *
 * Every source on a workspace table captures `workspace_id` first; the drain
 * of a workspace's transaction refuses a captured row of another workspace
 * rather than append its change to the wrong feed. Also here: the per-workspace
 * kind generation bump, and that no record value carries the workspace column
 * the tables gained.
 */

import { asMachineId, layoutRowId, type UserId } from '@podium/model'
import type { MetadataEntityKind } from '@podium/protocol'
import type { CapturedRow } from '@podium/sync'
import { fixtureWriteScope } from '@podium/sync/testing'
import { eq, getTableName, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { type StoreDrizzle, storeTables } from '../store/executor/sync-drizzle'
import { classifyTable } from '../store/workspace-manifest'
import { issueRowFixture } from '../test-support/issue-row'
import { seedRows } from '../test-support/seed-rows'
import { openWorkspaceStores } from '../test-support/workspace-stores'
import { captureWrite } from './capture-pg'
import { captureTriggerStatements } from './capture-triggers'
import { kindGenerationBump } from './kind-tokens'
import type { RecordReads } from './record-builders'
import { assertCapturedInWorkspace, databaseRecords, ForeignCaptureError } from './record-source'
import { RECORD_SOURCES, sourceTableName } from './record-sources'

let a: SessionStore
let b: SessionStore
let raw: StoreDrizzle
let admin: UserId

const readsOf = (store: SessionStore): RecordReads =>
  ({ store, effectExecutors: { get: () => undefined }, now: () => 0 }) as unknown as RecordReads

/**
 * A layout row in `workspace`, written below the repositories but through the capture
 * form every source-table write takes (`captureWrite`): on SQLite the triggers capture it,
 * on Postgres the statement itself does (POD-6994).
 */
const writeLayoutRow = async (workspace: string, key: string) => {
  const t = storeTables(raw)
  await captureWrite(
    raw.insert(t.userLayout).values({
      workspaceId: workspace,
      userId: admin,
      key,
      value: '{}',
      updatedAt: '2026-11-17T00:00:00.000Z',
    } as never),
  )
}

beforeAll(async () => {
  ;[a, b] = await openWorkspaceStores(['ws_a', 'ws_b'], { path: ':memory:' })
  await a.attachChangeLog()
  raw = (a as unknown as { queries: { rootDb: StoreDrizzle } }).queries.rootDb
  // The image seeds its people in the self-hosted workspace (POD-7019: members are the
  // workspace's), so ws_a has none; the rows below need only an existing user id.
  const [seeded] = (await raw.all(
    sql`SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL ORDER BY created_at, id LIMIT 1`,
  )) as { id: string }[]
  if (seeded === undefined) throw new Error('the test image seeds no administrator')
  admin = seeded.id as UserId
}, 60_000)

afterAll(async () => {
  await a?.close()
})

describe('the capture keys (contract C9)', () => {
  it('lead with workspace_id on every workspace table, and only there', () => {
    const wrong: string[] = []
    for (const [kind, sources] of Object.entries(RECORD_SOURCES)) {
      sources.forEach((source, index) => {
        const table = sourceTableName(source)
        const workspace = classifyTable(table)?.class === 'workspace'
        const leads = source.keys[0]?.name === 'workspace_id'
        if (workspace !== leads) wrong.push(`${kind}[${index}] on ${table}`)
      })
    }
    expect(wrong).toEqual([])
  })

  it('are what the generated triggers write into sync_capture', () => {
    const layout = captureTriggerStatements().filter((statement) =>
      statement.includes('"sync_capture__userLayout__0__'),
    )
    expect(layout).toHaveLength(3)
    for (const statement of layout) {
      expect(statement).toContain('json_array(')
      expect(statement).toMatch(/json_array\((NEW|OLD)\."workspace_id", \1\."user_id", \1\."key"\)/)
    }
    // A session satellite's row filter reads the session of the row's own workspace.
    const offer = captureTriggerStatements().find((statement) =>
      statement.includes('"sync_capture__session__1__i"'),
    )
    expect(offer).toContain('workspace_id = NEW.workspace_id AND id = NEW.session_id')
    expect(getTableName(RECORD_SOURCES.session[1]!.table)).toBe('offers')
  })
})

describe('the drain (POD-6959 design 2.7)', () => {
  it("drains a row of its own workspace into that workspace's records", async () => {
    const records = databaseRecords(readsOf(a), ['userLayout'])
    const touched = await a.transact(async () => {
      await writeLayoutRow('ws_a', 'own')
      return await records.drainCapture(0)
    })
    expect(touched).toEqual(new Map([['userLayout', [layoutRowId(admin, 'own')]]]))
  })

  it('throws on a captured row of another workspace, and the write rolls back', async () => {
    const records = databaseRecords(readsOf(a), ['userLayout'])
    await expect(
      a.transact(async () => {
        await writeLayoutRow('ws_b', 'foreign')
        await records.drainCapture(0)
      }),
    ).rejects.toBeInstanceOf(ForeignCaptureError)
    expect(await raw.all(sql`SELECT key FROM user_layout WHERE key = 'foreign'`)).toEqual([])
  })

  it('throws on a row moved out of the workspace by an update', async () => {
    await seedRows(a, async () => await writeLayoutRow('ws_a', 'moving'))
    const records = databaseRecords(readsOf(a), ['userLayout'])
    await expect(
      a.transact(async () => {
        const t = storeTables(raw)
        await captureWrite(
          raw
            .update(t.userLayout)
            .set({ workspaceId: 'ws_b' } as never)
            .where(eq(t.userLayout.key, 'moving')),
        )
        await records.drainCapture(0)
      }),
    ).rejects.toThrow(
      'a userLayout row of workspace ws_b was captured in a transaction of workspace ws_a',
    )
  })

  it('holds a global transaction to no workspace row, and lets an install row through', () => {
    const row = (kind: MetadataEntityKind, source: number, key: unknown[]): CapturedRow => ({
      id: 1,
      kind,
      source,
      op: 'i',
      oldKey: null,
      newKey: key,
    })
    // The machine record's third source is the fleet's update context, in `meta`.
    expect(sourceTableName(RECORD_SOURCES.machine[2]!)).toBe('meta')
    expect(() =>
      assertCapturedInWorkspace([row('machine', 2, ['machines.fleet-channel.v1'])], undefined),
    ).not.toThrow()
    expect(() =>
      assertCapturedInWorkspace([row('userLayout', 0, ['ws_a', admin, 'k'])], undefined),
    ).toThrow(ForeignCaptureError)
    expect(() =>
      assertCapturedInWorkspace([row('userLayout', 0, ['ws_a', admin, 'k'])], 'ws_a'),
    ).not.toThrow()
  })
})

describe('kind generations (POD-6959 design 2.7)', () => {
  it('a bump moves the kind once in every workspace with a feed', async () => {
    const generation = async (store: SessionStore, kind: string) =>
      (await store.sync.readKindGenerations()).find((row) => row.kind === kind)?.generation ?? 0
    const before = [await generation(a, 'pin'), await generation(b, 'pin')]
    const session = [await generation(a, 'session'), await generation(b, 'session')]
    await raw.run(sql.raw(kindGenerationBump(['pin', 'pin'])))
    expect([await generation(a, 'pin'), await generation(b, 'pin')]).toEqual(
      before.map((value) => value + 1),
    )
    expect([await generation(a, 'session'), await generation(b, 'session')]).toEqual(session)
  })
})

describe('the workspace column stays off the records', () => {
  it('no record value of any kind carries workspace_id', async () => {
    const machineId = asMachineId(a.hostMachine!.id)
    await seedRows(a, async () => {
      const t = storeTables(raw)
      await captureWrite(
        raw
          .insert(t.machines)
          .values({
            workspaceId: 'ws_a',
            id: machineId,
            name: 'm',
            hostname: 'm',
            tokenHash: 'hash',
            createdAt: '2026-11-17T00:00:00.000Z',
            lastSeenAt: '2026-11-17T00:00:00.000Z',
          } as never)
          .onConflictDoNothing(),
      )
      await writeLayoutRow('ws_a', 'listed')
      await a.issues.upsertIssue(
        fixtureWriteScope(),
        issueRowFixture({
          id: 'iss_scope',
          machineId,
          ownerUserId: admin,
          createdByActor: admin,
          createdByOnBehalfOf: null,
          parentId: null,
          supersededBy: null,
          duplicateOf: null,
          coordinatorSessionId: null,
          startedBySession: null,
          humanQuestionAskedBy: null,
        }),
      )
    })
    const records = databaseRecords(readsOf(a))
    const seen = new Set<string>()
    const carrying: string[] = []
    for await (const page of records.streamAllKinds()) {
      for (const record of page.records) {
        seen.add(page.entity)
        const text = JSON.stringify(record)
        if (text.includes('workspace_id') || text.includes('workspaceId'))
          carrying.push(`${page.entity}/${record.id}`)
      }
    }
    expect([...seen]).toEqual(expect.arrayContaining(['machine', 'issueProjection', 'userLayout']))
    expect(carrying).toEqual([])
  })
})
