/**
 * A MANAGED CREDENTIAL BELONGS TO A PERSON (PDM-280).
 *
 * The first case below is the whole issue in one assertion: two people holding
 * `managed:anthropic` at the same time. It is not expressible against the table
 * this repository used to read, whose primary key was the account id alone — so
 * it fails on a dropped owner term in the WHERE clause AND on a reversion of the
 * key, which is the pair of directions the schema change has to survive.
 *
 * Written against the REAL repository over a REAL migrated database, for the
 * reason `user-preferences.test.ts` gives for the same shape: the property under
 * test IS a WHERE clause, and a fake would have to re-implement it and then
 * agree with itself.
 *
 * BOTH OWNERS ARE SEEDED WITH DIFFERENT VALUES AT THE SAME SLOT. A cross-owner
 * test passes trivially when the second person simply has nothing; each case
 * here gives them a DIFFERENT credential under the SAME id, so a read that lost
 * its owner term returns the wrong secret rather than an empty result.
 */

import { asAccountId, asUserId } from '@podium/model'
import { beforeEach, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { stageASeam } from '../test-support/stage-a-seam'
import { AccountsRepository } from './accounts'

let repo: AccountsRepository

const ADA = asUserId('mem_ada')
const BEN = asUserId('mem_ben')

const anthropic = (credential: string) => ({
  id: asAccountId('managed:anthropic'),
  provider: 'anthropic',
  kind: 'api-key' as const,
  credential,
  identity: 'sk-a…cret',
  scope: 'role' as const,
  createdAt: 1,
})

beforeEach(() => {
  const db = openMigratedTestDatabase()
  repo = new AccountsRepository(stageASeam(db))
})

it('holds the same slot for two people at once, each reading their own', async () => {
  await repo.upsert(ADA, anthropic('sk-ant-ada'))
  await repo.upsert(BEN, anthropic('sk-ant-ben'))

  expect((await repo.get(ADA, 'managed:anthropic'))?.credential).toBe('sk-ant-ada')
  expect((await repo.get(BEN, 'managed:anthropic'))?.credential).toBe('sk-ant-ben')
  expect(await repo.list(ADA)).toHaveLength(1)
  expect(await repo.list(BEN)).toHaveLength(1)
})

it('lists only the owner asked for', async () => {
  await repo.upsert(ADA, anthropic('sk-ant-ada'))
  await repo.upsert(BEN, {
    ...anthropic('sk-oai-ben'),
    id: asAccountId('managed:openai'),
    provider: 'openai',
  })

  expect((await repo.list(ADA)).map((row) => row.id)).toEqual(['managed:anthropic'])
  expect((await repo.list(BEN)).map((row) => row.id)).toEqual(['managed:openai'])
})

it('round-trips a managed account', async () => {
  await repo.upsert(ADA, anthropic('sk-ant-secret'))
  expect((await repo.get(ADA, 'managed:anthropic'))?.credential).toBe('sk-ant-secret')
  expect(await repo.list(ADA)).toHaveLength(1)
})

it('upsert replaces this owner’s row rather than duplicating it', async () => {
  await repo.upsert(ADA, anthropic('old'))
  await repo.upsert(ADA, anthropic('new'))
  expect(await repo.list(ADA)).toHaveLength(1)
  expect((await repo.get(ADA, 'managed:anthropic'))?.credential).toBe('new')
})

it('upsert leaves another owner’s row at the same slot untouched', async () => {
  await repo.upsert(ADA, anthropic('sk-ant-ada'))
  await repo.upsert(BEN, anthropic('sk-ant-ben'))
  await repo.upsert(ADA, anthropic('sk-ant-ada-rotated'))

  expect((await repo.get(BEN, 'managed:anthropic'))?.credential).toBe('sk-ant-ben')
})

it('remove deletes only the owner’s row', async () => {
  await repo.upsert(ADA, anthropic('sk-ant-ada'))
  await repo.upsert(BEN, anthropic('sk-ant-ben'))

  await repo.remove(ADA, 'managed:anthropic')

  expect(await repo.get(ADA, 'managed:anthropic')).toBeUndefined()
  expect(await repo.list(ADA)).toEqual([])
  expect((await repo.get(BEN, 'managed:anthropic'))?.credential).toBe('sk-ant-ben')
})

it('removing a slot the caller does not hold is silent, exactly as removing one nobody holds', async () => {
  await repo.upsert(BEN, anthropic('sk-ant-ben'))

  // `accounts.disconnect`'s errorConsistency: an account this principal may not
  // see must fail exactly as one that does not exist. Here both are the same
  // no-op, which is what makes that claim true by construction rather than by a
  // matched pair of error paths.
  await repo.remove(ADA, 'managed:anthropic')
  await repo.remove(ADA, 'managed:openrouter')

  expect((await repo.get(BEN, 'managed:anthropic'))?.credential).toBe('sk-ant-ben')
})
