import { asAccountId } from '@podium/model'
import { beforeEach, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { stageASeam } from '../test-support/stage-a-seam'
import { AccountsRepository } from './accounts'

let repo: AccountsRepository

beforeEach(() => {
  const db = openMigratedTestDatabase()
  repo = new AccountsRepository(stageASeam(db))
})

it('round-trips a managed account', async () => {
  await repo.upsert({
    id: asAccountId('managed:anthropic'),
    provider: 'anthropic',
    kind: 'api-key',
    credential: 'sk-ant-secret',
    identity: 'sk-a…cret',
    scope: 'role',
    createdAt: 1,
  })
  expect((await repo.get('managed:anthropic'))?.credential).toBe('sk-ant-secret')
  expect(await repo.list()).toHaveLength(1)
})

it('upsert replaces an existing id rather than duplicating', async () => {
  const base = {
    id: asAccountId('managed:anthropic'),
    provider: 'anthropic',
    kind: 'api-key' as const,
    identity: 'x',
    scope: 'role' as const,
    createdAt: 1,
  }
  await repo.upsert({ ...base, credential: 'old' })
  await repo.upsert({ ...base, credential: 'new' })
  expect(await repo.list()).toHaveLength(1)
  expect((await repo.get('managed:anthropic'))?.credential).toBe('new')
})

it('remove deletes the row', async () => {
  await repo.upsert({
    id: asAccountId('managed:anthropic'),
    provider: 'anthropic',
    kind: 'api-key',
    credential: 'sk',
    identity: 'x',
    scope: 'role',
    createdAt: 1,
  })
  await repo.remove('managed:anthropic')
  expect(await repo.get('managed:anthropic')).toBeUndefined()
  expect(await repo.list()).toEqual([])
})
