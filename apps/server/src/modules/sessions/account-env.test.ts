import { openDatabase } from '@podium/runtime/sqlite'
import { expect, it } from 'vitest'
import { applyBaselineSchema } from '../../migrations'
import { AccountsRepository } from '../../store/accounts'
import { resolveAccountEnv } from './account-env'

function repoWith(...rows: Array<Parameters<AccountsRepository['upsert']>[0]>) {
  const db = openDatabase(':memory:')
  applyBaselineSchema(db)
  const repo = new AccountsRepository(db)
  for (const r of rows) repo.upsert(r)
  return repo
}

it('resolves a managed api-key account into env', () => {
  const repo = repoWith({
    id: 'managed:anthropic',
    provider: 'anthropic',
    kind: 'api-key',
    credential: 'sk-ant-1',
    identity: 'x',
    scope: 'role',
    createdAt: 1,
  })
  expect(resolveAccountEnv(repo, 'managed:anthropic')).toEqual({
    env: { ANTHROPIC_API_KEY: 'sk-ant-1' },
  })
})

it('resolves a managed oauth account into CLAUDE_CODE_OAUTH_TOKEN', () => {
  const repo = repoWith({
    id: 'managed:claude-oauth',
    provider: 'anthropic',
    kind: 'oauth',
    credential: 'oat-1',
    identity: 'x',
    scope: 'role',
    createdAt: 1,
  })
  expect(resolveAccountEnv(repo, 'managed:claude-oauth')).toEqual({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oat-1' },
  })
})

it('yields NO env key for a native account — the frame stays as it is today', () => {
  expect(resolveAccountEnv(repoWith(), 'native:claude-code')).toEqual({})
})

it('yields no env key when the account id has no stored credential', () => {
  expect(resolveAccountEnv(repoWith(), 'managed:anthropic')).toEqual({})
})
