import { openDatabase } from '@podium/runtime/sqlite'
import { beforeEach, expect, it } from 'vitest'
import { applyBaselineSchema } from '../migrations'
import { AccountsRepository } from './accounts'

let repo: AccountsRepository

beforeEach(() => {
  const db = openDatabase(':memory:')
  applyBaselineSchema(db)
  repo = new AccountsRepository(db)
})

it('round-trips a managed account', () => {
  repo.upsert({
    id: 'managed:anthropic',
    provider: 'anthropic',
    kind: 'api-key',
    credential: 'sk-ant-secret',
    identity: 'sk-a…cret',
    scope: 'role',
    createdAt: 1,
  })
  expect(repo.get('managed:anthropic')?.credential).toBe('sk-ant-secret')
  expect(repo.list()).toHaveLength(1)
})

it('upsert replaces an existing id rather than duplicating', () => {
  const base = {
    id: 'managed:anthropic',
    provider: 'anthropic',
    kind: 'api-key' as const,
    identity: 'x',
    scope: 'role' as const,
    createdAt: 1,
  }
  repo.upsert({ ...base, credential: 'old' })
  repo.upsert({ ...base, credential: 'new' })
  expect(repo.list()).toHaveLength(1)
  expect(repo.get('managed:anthropic')?.credential).toBe('new')
})

it('remove deletes the row', () => {
  repo.upsert({
    id: 'managed:anthropic',
    provider: 'anthropic',
    kind: 'api-key',
    credential: 'sk',
    identity: 'x',
    scope: 'role',
    createdAt: 1,
  })
  repo.remove('managed:anthropic')
  expect(repo.get('managed:anthropic')).toBeUndefined()
  expect(repo.list()).toEqual([])
})
