/**
 * WHOSE CREDENTIAL A SPAWN CARRIES (#216, then PDM-280).
 *
 * Two properties, and the second one is new: the env is resolved from the
 * SESSION OWNER's credentials, and a managed slot that owner has no row for
 * REFUSES rather than resolving to nothing or to somebody else's key.
 *
 * The refusal cases assert the throw and its MESSAGE, not merely that no env
 * came back — "nothing was injected" is also what a silently broken lookup
 * produces, so an assertion on absence alone would pass for the wrong reason.
 */

import { asAccountId, asUserId } from '@podium/model'
import { expect, it } from 'vitest'
import { AccountsRepository } from '../../store/accounts'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { stageASeam } from '../../test-support/stage-a-seam'
import { resolveAccountEnv } from './account-env'

const ADA = asUserId('mem_ada')
const BEN = asUserId('mem_ben')

type Row = Parameters<AccountsRepository['upsert']>[1]

async function repoWith(...rows: Array<[typeof ADA, Row]>) {
  const db = openMigratedTestDatabase()
  const repo = new AccountsRepository(stageASeam(db))
  for (const [owner, row] of rows) await repo.upsert(owner, row)
  return repo
}

const anthropicKey = (credential: string): Row => ({
  id: asAccountId('managed:anthropic'),
  provider: 'anthropic',
  kind: 'api-key',
  credential,
  identity: 'x',
  scope: 'role',
  createdAt: 1,
})

it('resolves a managed api-key account into env', async () => {
  const repo = await repoWith([ADA, anthropicKey('sk-ant-1')])
  expect(await resolveAccountEnv(repo, ADA, asAccountId('managed:anthropic'))).toEqual({
    env: { ANTHROPIC_API_KEY: 'sk-ant-1' },
  })
})

it('resolves a managed oauth account into CLAUDE_CODE_OAUTH_TOKEN', async () => {
  const repo = await repoWith([
    ADA,
    {
      id: asAccountId('managed:claude-oauth'),
      provider: 'anthropic',
      kind: 'oauth',
      credential: 'oat-1',
      identity: 'x',
      scope: 'role',
      createdAt: 1,
    },
  ])
  expect(await resolveAccountEnv(repo, ADA, asAccountId('managed:claude-oauth'))).toEqual({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oat-1' },
  })
})

it('resolves each owner’s own credential for the same slot', async () => {
  const repo = await repoWith([ADA, anthropicKey('sk-ant-ada')], [BEN, anthropicKey('sk-ant-ben')])

  expect(await resolveAccountEnv(repo, ADA, asAccountId('managed:anthropic'))).toEqual({
    env: { ANTHROPIC_API_KEY: 'sk-ant-ada' },
  })
  expect(await resolveAccountEnv(repo, BEN, asAccountId('managed:anthropic'))).toEqual({
    env: { ANTHROPIC_API_KEY: 'sk-ant-ben' },
  })
})

it('refuses rather than borrowing another person’s credential for the same slot', async () => {
  // The case the whole change exists for: Ben's agent must not spend Ada's key.
  const repo = await repoWith([ADA, anthropicKey('sk-ant-ada')])

  await expect(resolveAccountEnv(repo, BEN, asAccountId('managed:anthropic'))).rejects.toThrow(
    /no managed credential for 'anthropic'.*mem_ben/s,
  )
  // And it does not leak the credential it refused to use.
  await expect(resolveAccountEnv(repo, BEN, asAccountId('managed:anthropic'))).rejects.not.toThrow(
    /sk-ant-ada/,
  )
})

it('refuses a managed slot nobody has connected, naming the provider and the fix', async () => {
  const repo = await repoWith()

  await expect(resolveAccountEnv(repo, ADA, asAccountId('managed:openai'))).rejects.toThrow(
    /no managed credential for 'openai'/,
  )
  await expect(resolveAccountEnv(repo, ADA, asAccountId('managed:openai'))).rejects.toThrow(
    /Settings → Accounts/,
  )
})

it('yields NO env key for a native account — the frame stays as it is today', async () => {
  // The negative twin of the refusal: a guard that refused everything would pass
  // every case above and fail this one.
  expect(await resolveAccountEnv(await repoWith(), ADA, asAccountId('native:claude-code'))).toEqual(
    {},
  )
})
