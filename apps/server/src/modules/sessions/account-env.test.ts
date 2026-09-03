import { asAccountId } from '@podium/model'
import { expect, it } from 'vitest'
import { AccountsRepository } from '../../store/accounts'
import { createBunStoreExecutor } from '../../store/executor'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { resolveAccountEnv } from './account-env'

async function repoWith(...rows: Array<Parameters<AccountsRepository['upsert']>[0]>) {
  const db = openMigratedTestDatabase()
  const repo = new AccountsRepository(createBunStoreExecutor({ database: db }))
  for (const r of rows) await repo.upsert(r)
  return repo
}

it('resolves a managed api-key account into env', async () => {
  const repo = await repoWith({
    id: asAccountId('managed:anthropic'),
    provider: 'anthropic',
    kind: 'api-key',
    credential: 'sk-ant-1',
    identity: 'x',
    scope: 'role',
    createdAt: 1,
  })
  expect(resolveAccountEnv(repo, asAccountId('managed:anthropic'))).toEqual({
    env: { ANTHROPIC_API_KEY: 'sk-ant-1' },
  })
})

it('resolves a managed oauth account into CLAUDE_CODE_OAUTH_TOKEN', async () => {
  const repo = await repoWith({
    id: asAccountId('managed:claude-oauth'),
    provider: 'anthropic',
    kind: 'oauth',
    credential: 'oat-1',
    identity: 'x',
    scope: 'role',
    createdAt: 1,
  })
  expect(resolveAccountEnv(repo, asAccountId('managed:claude-oauth'))).toEqual({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oat-1' },
  })
})

it('yields NO env key for a native account — the frame stays as it is today', async () => {
  expect(resolveAccountEnv(await repoWith(), asAccountId('native:claude-code'))).toEqual({})
})

it('yields no env key when the account id has no stored credential', async () => {
  expect(resolveAccountEnv(await repoWith(), asAccountId('managed:anthropic'))).toEqual({})
})
