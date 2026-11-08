import { asAccountId, asMachineId, asUserId } from '@podium/model'
import { beforeEach, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { stageASeam } from '../test-support/stage-a-seam'
import { AccountsRepository, type ManagedAccountWrite, SHARED_WITH_EVERYONE } from './accounts'

let repo: AccountsRepository
let db: ReturnType<typeof openMigratedTestDatabase>

const ALICE = asUserId('user:alice')
const BOB = asUserId('user:bob')
const CAROL = asUserId('user:carol')
const ANTHROPIC = asAccountId('managed:anthropic')

const key = (ownerUserId: typeof ALICE, credential: string): ManagedAccountWrite => ({
  ownerUserId,
  accountKey: ANTHROPIC,
  provider: 'anthropic',
  kind: 'api-key',
  credential,
  identity: 'sk-a…cret',
  scope: 'role',
  createdAt: 1,
})

beforeEach(() => {
  db = openMigratedTestDatabase()
  repo = new AccountsRepository(stageASeam(db))
})

it('round-trips a managed account, owned and private', async () => {
  await repo.connect(key(ALICE, 'sk-ant-secret'))
  const own = await repo.own(ALICE, ANTHROPIC)
  expect(own).toMatchObject({
    ownerUserId: ALICE,
    accountKey: ANTHROPIC,
    credential: 'sk-ant-secret',
  })
  expect(own?.sharedWith).toEqual([])
  expect(await repo.list()).toHaveLength(1)
  expect((await repo.getFor(ALICE, ANTHROPIC))?.credential).toBe('sk-ant-secret')
  expect((await repo.listFor(ALICE))[0]?.id).toBe(ANTHROPIC)
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

it('keeps one row per owner and account id, and two users each keep their own', async () => {
  await repo.connect(key(ALICE, 'alice-old'))
  await repo.connect(key(ALICE, 'alice-new'))
  await repo.connect(key(BOB, 'bob'))
  expect(await repo.list()).toHaveLength(2)
  expect((await repo.own(ALICE, ANTHROPIC))?.credential).toBe('alice-new')
  expect((await repo.own(BOB, ANTHROPIC))?.credential).toBe('bob')
  expect((await repo.ownedBy(ALICE)).map((row) => row.credential)).toEqual(['alice-new'])
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
const custodyKey = (ownerUserId: typeof ALICE, credential: string) => ({
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
  await repo.upsert(custodyKey(ALICE, 'sk-alice'))
  await repo.upsert(custodyKey(BOB, 'sk-bob'))
  expect((await repo.getFor(ALICE, 'managed:anthropic'))?.credential).toBe('sk-alice')
  expect((await repo.getFor(BOB, 'managed:anthropic'))?.credential).toBe('sk-bob')
  expect((await repo.listFor(BOB)).map((row) => row.credential)).toEqual(['sk-bob'])

  await repo.removeFor(ALICE, 'managed:anthropic')
  expect(await repo.getFor(ALICE, 'managed:anthropic')).toBeUndefined()
  expect((await repo.getFor(BOB, 'managed:anthropic'))?.credential).toBe('sk-bob')
})

it('records a send only for the owner’s own connection, and forgets it on disconnect', async () => {
  const machine = asMachineId('machine-alice')
  await repo.upsert(custodyKey(BOB, 'sk-bob'))
  await repo.markSent(ALICE, 'managed:anthropic', machine, '2026-11-03T00:00:00.000Z')
  expect(await repo.sentTo(ALICE, 'managed:anthropic')).toEqual([])
  expect(await repo.sentTo(BOB, 'managed:anthropic')).toEqual([])

  await repo.markSent(BOB, 'managed:anthropic', machine, '2026-11-03T00:00:00.000Z')
  await repo.markSent(BOB, 'managed:anthropic', machine, '2026-11-04T00:00:00.000Z')
  expect(await repo.sentTo(BOB, 'managed:anthropic')).toEqual([machine])

  await repo.removeFor(BOB, 'managed:anthropic')
  await repo.upsert(custodyKey(BOB, 'sk-bob-2'))
  expect(await repo.sentTo(BOB, 'managed:anthropic')).toEqual([])
})

it('a reconnect keeps the sharing; disconnect removes only the owner’s row', async () => {
  await repo.connect(key(ALICE, 'alice-old'))
  await repo.connect(key(BOB, 'bob'))
  expect(await repo.share(ALICE, ANTHROPIC, [BOB])).toBe(true)
  await repo.connect(key(ALICE, 'alice-new'))
  expect((await repo.own(ALICE, ANTHROPIC))?.sharedWith).toEqual([BOB])

  expect(await repo.disconnect(BOB, ANTHROPIC)).toBe(true)
  expect(await repo.disconnect(BOB, ANTHROPIC)).toBe(false)
  expect((await repo.own(ALICE, ANTHROPIC))?.credential).toBe('alice-new')
})

it('sharedWith answers only keys shared with that user, by name or with everyone', async () => {
  await repo.connect(key(ALICE, 'alice'))
  await repo.connect({ ...key(BOB, 'bob'), createdAt: 2 })
  // Unshared: nobody else gets it.
  expect(await repo.sharedWith(CAROL, ANTHROPIC)).toEqual([])

  await repo.share(ALICE, ANTHROPIC, [CAROL])
  expect((await repo.sharedWith(CAROL, ANTHROPIC)).map((row) => row.credential)).toEqual(['alice'])
  expect(await repo.sharedWith(BOB, ANTHROPIC)).toEqual([])

  await repo.share(BOB, ANTHROPIC, [SHARED_WITH_EVERYONE])
  expect((await repo.sharedWith(CAROL, ANTHROPIC)).map((row) => row.credential)).toEqual([
    'alice',
    'bob',
  ])
  // A user's own key is never among the keys shared with them.
  expect((await repo.sharedWith(BOB, ANTHROPIC)).map((row) => row.credential)).toEqual([])
  expect((await repo.sharedWithUser(ALICE)).map((row) => row.credential)).toEqual(['bob'])

  // Revoking makes it private again.
  expect(await repo.share(ALICE, ANTHROPIC, [])).toBe(true)
  expect((await repo.sharedWith(CAROL, ANTHROPIC)).map((row) => row.credential)).toEqual(['bob'])
  expect((await repo.own(ALICE, ANTHROPIC))?.sharedWith).toEqual([])
})

it('share answers false when the owner has no such key', async () => {
  await repo.connect(key(ALICE, 'alice'))
  expect(await repo.share(BOB, ANTHROPIC, [SHARED_WITH_EVERYONE])).toBe(false)
  expect(await repo.sharedWith(CAROL, ANTHROPIC)).toEqual([])
})

it('an unreadable sharing list shares with nobody (fails closed)', async () => {
  await repo.connect(key(ALICE, 'alice'))
  db.prepare("UPDATE accounts SET shared_with = 'not json'").run()
  expect(await repo.sharedWith(BOB, ANTHROPIC)).toEqual([])
  db.prepare(`UPDATE accounts SET shared_with = '{"users":["*"]}'`).run()
  expect(await repo.sharedWith(BOB, ANTHROPIC)).toEqual([])
})

it('a row with no owner is nobody’s: never listed, never shared', async () => {
  db.prepare(
    `INSERT INTO accounts (id, provider, kind, credential, identity, scope, created_at, shared_with)
     VALUES ('managed:anthropic', 'anthropic', 'api-key', 'orphan', '', 'role', 1, '["*"]')`,
  ).run()
  expect(await repo.list()).toEqual([])
  expect(await repo.sharedWith(BOB, ANTHROPIC)).toEqual([])
})

it('a pre-POD-6360 row keeps its storage id when its owner reconnects', async () => {
  db.prepare(
    `INSERT INTO accounts (id, provider, kind, credential, identity, scope, created_at, owner_user_id, account_key, shared_with)
     VALUES ('managed:anthropic', 'anthropic', 'api-key', 'old', '', 'role', 1, ?, 'managed:anthropic', '["*"]')`,
  ).run(ALICE)
  await repo.connect(key(ALICE, 'new'))
  const rows = await repo.list()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ id: 'managed:anthropic', credential: 'new', sharedWith: ['*'] })
})
