import { asMachineId } from '@podium/model'
import { SERVER_MOVE_CAPABILITY, wireSchemaDigest } from '@podium/protocol'
import { sql } from 'drizzle-orm'
import { afterEach, expect, it } from 'vitest'
import { storedMachineRecordFacts } from '../modules/machines/record-facts'
import { SessionRegistry } from '../relay'
import type { SessionStore } from '../store'
import { recordReadsOf } from '../sync-worker/record-reads'
import { openTestStore } from '../test-support/open-test-store'
import { storeSql } from '../test-support/store-sql'

let store: SessionStore | undefined
let registry: SessionRegistry | undefined
afterEach(async () => {
  await registry?.dispose()
  registry = undefined
  await store?.close()
  store = undefined
})

it('reports the install capability identically through server and sync-worker record reads', async () => {
  store = await openTestStore(':memory:', null)
  const id = asMachineId('remote')
  await store.machines.upsertMachine({
    id,
    name: 'Remote',
    hostname: 'remote.example.test',
    tokenHash: 'test',
    ownerUserId: null,
    assignment: { server: true, agentExecution: true },
  })
  await store.machines.setMachineBuild(
    id,
    { appVersion: 'test', wireSchemaDigest: wireSchemaDigest() },
    [SERVER_MOVE_CAPABILITY],
    new Date().toISOString(),
    'legacy-daemon',
  )
  const worker = recordReadsOf(store.database.queries, {
    effectExecutors: { get: () => undefined },
  })
  for (const available of [true, false, true]) {
    await store.machines.recordContext.setServerMoveAvailable(available)
    for (const reads of [store, worker.store]) {
      const [facts] = await storedMachineRecordFacts(reads, [id])
      expect(facts?.see.serverMoveSupported).toBe(available)
      expect(facts?.see.hostsServer).toBe(available)
    }
  }
})

it('publishes the changed capability to machine-access records', async () => {
  store = await openTestStore(':memory:', null)
  registry = await SessionRegistry.create(store, undefined, {
    instanceId: 'no-host',
    serverPlacement: { kind: 'external' },
  })
  const id = asMachineId('remote')
  await store.machines.upsertMachine({
    id,
    name: 'Remote',
    hostname: 'remote.example.test',
    tokenHash: 'test',
    ownerUserId: null,
    assignment: { server: true, agentExecution: true },
  })
  await store.machines.setMachineBuild(
    id,
    { appVersion: 'test', wireSchemaDigest: wireSchemaDigest() },
    [SERVER_MOVE_CAPABILITY],
    new Date().toISOString(),
    'legacy-daemon',
  )
  const before = await store.sync.maxChangeSeq()
  await store.machines.recordContext.setServerMoveAvailable(true)
  const changes = (await store.sync.changesSince(before)).filter(
    (c) => c.entity === 'machineAccess',
  )
  expect(changes.length).toBeGreaterThan(0)
  for (const change of changes)
    expect(JSON.parse(change.payload!)).toMatchObject({ serverMoveSupported: true })
})

it('sets install capability without parsing an unrelated update checkpoint', async () => {
  store = await openTestStore(':memory:', null)
  await storeSql(
    store,
  ).run(sql`INSERT INTO meta (key, value) VALUES ('updates.execution.v1', 'unreadable-checkpoint')
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
  expect(await store.machines.recordContext.setServerMoveAvailable(true)).toBe(false)
  expect(await store.machines.recordContext.setServerMoveAvailable(false)).toBe(true)
})
