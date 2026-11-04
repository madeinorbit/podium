import { asAccountId, asUserId } from '@podium/model'
import { expect, it } from 'vitest'
import {
  AccountsRepository,
  type ManagedAccountWrite,
  SHARED_WITH_EVERYONE,
} from '../../store/accounts'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { stageASeam } from '../../test-support/stage-a-seam'
import { MissingManagedKeyError, resolveAccountEnv } from './account-env'

const OWNER = asUserId('user:session-owner')
const OTHER = asUserId('user:other')
const ANTHROPIC = asAccountId('managed:anthropic')

async function repoWith(...rows: ManagedAccountWrite[]) {
  const db = openMigratedTestDatabase()
  const repo = new AccountsRepository(stageASeam(db))
  for (const r of rows) await repo.connect(r)
  return repo
}

const anthropic = (ownerUserId: typeof OWNER, credential: string): ManagedAccountWrite => ({
  ownerUserId,
  accountKey: ANTHROPIC,
  provider: 'anthropic',
  kind: 'api-key',
  credential,
  identity: 'x',
  scope: 'role',
  createdAt: 1,
})

it("resolves the owner's own managed api-key account into env", async () => {
  const repo = await repoWith(anthropic(OWNER, 'sk-ant-1'))
  expect(await resolveAccountEnv(repo, ANTHROPIC, OWNER)).toEqual({
    env: { ANTHROPIC_API_KEY: 'sk-ant-1' },
  })
})

it('resolves a managed oauth account into CLAUDE_CODE_OAUTH_TOKEN', async () => {
  const repo = await repoWith({
    ownerUserId: OWNER,
    accountKey: asAccountId('managed:claude-oauth'),
    provider: 'anthropic',
    kind: 'oauth',
    credential: 'oat-1',
    identity: 'x',
    scope: 'role',
    createdAt: 1,
  })
  expect(await resolveAccountEnv(repo, asAccountId('managed:claude-oauth'), OWNER)).toEqual({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oat-1' },
  })
})

it('yields NO env key for a native account — the frame stays as it is today', async () => {
  expect(
    await resolveAccountEnv(await repoWith(), asAccountId('native:claude-code'), OWNER),
  ).toEqual({})
})

it("prefers the owner's own key over one shared with them", async () => {
  const repo = await repoWith(anthropic(OTHER, 'sk-shared'), anthropic(OWNER, 'sk-own'))
  await repo.share(OTHER, ANTHROPIC, [SHARED_WITH_EVERYONE])
  expect(await resolveAccountEnv(repo, ANTHROPIC, OWNER)).toEqual({
    env: { ANTHROPIC_API_KEY: 'sk-own' },
  })
})

it('uses a key another user explicitly shares, by name or with everyone', async () => {
  const repo = await repoWith(anthropic(OTHER, 'sk-shared'))
  await repo.share(OTHER, ANTHROPIC, [OWNER])
  expect(await resolveAccountEnv(repo, ANTHROPIC, OWNER)).toEqual({
    env: { ANTHROPIC_API_KEY: 'sk-shared' },
  })
  await repo.share(OTHER, ANTHROPIC, [SHARED_WITH_EVERYONE])
  expect(await resolveAccountEnv(repo, ANTHROPIC, OWNER)).toEqual({
    env: { ANTHROPIC_API_KEY: 'sk-shared' },
  })
})

it("never uses another user's unshared key, and says which key is missing", async () => {
  const repo = await repoWith(anthropic(OTHER, 'sk-not-yours'))
  const refusal = resolveAccountEnv(repo, ANTHROPIC, OWNER)
  await expect(refusal).rejects.toBeInstanceOf(MissingManagedKeyError)
  await expect(refusal).rejects.toThrow(/No Anthropic API key is available to you/)
  await expect(refusal).rejects.toThrow(/An admin can share theirs/)
})

it('a revoked share stops the next resolution', async () => {
  const repo = await repoWith(anthropic(OTHER, 'sk-shared'))
  await repo.share(OTHER, ANTHROPIC, [SHARED_WITH_EVERYONE])
  expect(await resolveAccountEnv(repo, ANTHROPIC, OWNER)).toEqual({
    env: { ANTHROPIC_API_KEY: 'sk-shared' },
  })
  await repo.share(OTHER, ANTHROPIC, [])
  await expect(resolveAccountEnv(repo, ANTHROPIC, OWNER)).rejects.toBeInstanceOf(
    MissingManagedKeyError,
  )
})

it('refuses when nobody has the selected managed key', async () => {
  await expect(resolveAccountEnv(await repoWith(), ANTHROPIC, OWNER)).rejects.toThrow(
    MissingManagedKeyError,
  )
})
