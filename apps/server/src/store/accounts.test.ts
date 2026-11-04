import { asAccountId, asMachineId, asUserId } from '@podium/model'
import { beforeEach, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { stageASeam } from '../test-support/stage-a-seam'
import { AccountsRepository } from './accounts'

let repo: AccountsRepository
const ALICE = asUserId('mem_alice')

beforeEach(() => {
  const db = openMigratedTestDatabase()
  repo = new AccountsRepository(stageASeam(db))
})

it('round-trips a managed account', async () => {
  await repo.upsert({
    id: asAccountId('managed:anthropic'),
    ownerUserId: ALICE,
    provider: 'anthropic',
    kind: 'api-key',
    credential: 'sk-ant-secret',
    identity: 'sk-a…cret',
    scope: 'role',
    createdAt: 1,
  })
  expect((await repo.getFor(ALICE, 'managed:anthropic'))?.credential).toBe('sk-ant-secret')
  expect(await repo.listFor(ALICE)).toHaveLength(1)
})

it('upsert replaces the owner’s existing id rather than duplicating', async () => {
  const base = {
    id: asAccountId('managed:anthropic'),
    ownerUserId: ALICE,
    provider: 'anthropic',
    kind: 'api-key' as const,
    identity: 'x',
    scope: 'role' as const,
    createdAt: 1,
  }
  await repo.upsert({ ...base, credential: 'old' })
  await repo.upsert({ ...base, credential: 'new' })
  expect(await repo.listFor(ALICE)).toHaveLength(1)
  expect((await repo.getFor(ALICE, 'managed:anthropic'))?.credential).toBe('new')
})

it('remove deletes the row', async () => {
  await repo.upsert({
    id: asAccountId('managed:anthropic'),
    ownerUserId: ALICE,
    provider: 'anthropic',
    kind: 'api-key',
    credential: 'sk',
    identity: 'x',
    scope: 'role',
    createdAt: 1,
  })
  await repo.removeFor(ALICE, 'managed:anthropic')
  expect(await repo.getFor(ALICE, 'managed:anthropic')).toBeUndefined()
  expect(await repo.listFor(ALICE)).toEqual([])
})

// POD-6300: a connection belongs to one member. The same account id is a
// separate row per owner, and nothing reaches across.
const BOB = asUserId('mem_bob')
const key = (ownerUserId: typeof ALICE, credential: string) => ({
  id: asAccountId('managed:anthropic'),
  ownerUserId,
  provider: 'anthropic',
  kind: 'api-key' as const,
  credential,
  identity: 'x',
  scope: 'role' as const,
  createdAt: 1,
})

it('keeps two members’ connections with the same id apart', async () => {
  await repo.upsert(key(ALICE, 'sk-alice'))
  await repo.upsert(key(BOB, 'sk-bob'))
  expect((await repo.getFor(ALICE, 'managed:anthropic'))?.credential).toBe('sk-alice')
  expect((await repo.getFor(BOB, 'managed:anthropic'))?.credential).toBe('sk-bob')
  expect((await repo.listFor(BOB)).map((row) => row.credential)).toEqual(['sk-bob'])

  await repo.removeFor(ALICE, 'managed:anthropic')
  expect(await repo.getFor(ALICE, 'managed:anthropic')).toBeUndefined()
  expect((await repo.getFor(BOB, 'managed:anthropic'))?.credential).toBe('sk-bob')
})

it('records a send only for the owner’s own connection, and forgets it on disconnect', async () => {
  const machine = asMachineId('machine-alice')
  await repo.upsert(key(BOB, 'sk-bob'))
  await repo.markSent(ALICE, 'managed:anthropic', machine, '2026-11-03T00:00:00.000Z')
  expect(await repo.sentTo(ALICE, 'managed:anthropic')).toEqual([])
  expect(await repo.sentTo(BOB, 'managed:anthropic')).toEqual([])

  await repo.markSent(BOB, 'managed:anthropic', machine, '2026-11-03T00:00:00.000Z')
  await repo.markSent(BOB, 'managed:anthropic', machine, '2026-11-04T00:00:00.000Z')
  expect(await repo.sentTo(BOB, 'managed:anthropic')).toEqual([machine])

  await repo.removeFor(BOB, 'managed:anthropic')
  await repo.upsert(key(BOB, 'sk-bob-2'))
  expect(await repo.sentTo(BOB, 'managed:anthropic')).toEqual([])
})
