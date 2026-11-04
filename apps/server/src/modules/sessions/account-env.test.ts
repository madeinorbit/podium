import { asAccountId, asMachineId, asUserId, SHARED_MACHINE_ACCOUNT_WARNING } from '@podium/model'
import { expect, it } from 'vitest'
import { AccountsRepository, type ManagedAccountRow } from '../../store/accounts'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { stageASeam } from '../../test-support/stage-a-seam'
import { type AccountEnvPorts, resolveAccountEnv, SpawnAccountRefusal } from './account-env'

const ALICE = asUserId('mem_alice')
const BOB = asUserId('mem_bob')
const ALICE_MACHINE = asMachineId('machine-alice')
const BOB_MACHINE = asMachineId('machine-bob')
const UNOWNED = asMachineId('machine-unowned')

async function portsWith(
  ...rows: ManagedAccountRow[]
): Promise<AccountEnvPorts & { repo: AccountsRepository }> {
  const db = openMigratedTestDatabase()
  const repo = new AccountsRepository(stageASeam(db))
  for (const r of rows) await repo.upsert(r)
  const custody = new Map([
    [ALICE_MACHINE, ALICE],
    [BOB_MACHINE, BOB],
  ])
  return {
    repo,
    accounts: repo,
    machines: {
      custodian: async (id) => custody.get(asMachineId(id)) ?? null,
      getMachine: async (id) => ({ name: id }),
    },
  }
}

const row = (ownerUserId = ALICE, credential = 'sk-ant-1'): ManagedAccountRow => ({
  id: asAccountId('managed:anthropic'),
  ownerUserId,
  provider: 'anthropic',
  kind: 'api-key',
  credential,
  identity: 'x',
  scope: 'role',
  createdAt: 1,
})

const own = { ownerUserId: ALICE, machineId: ALICE_MACHINE }

it('resolves a managed api-key account into env', async () => {
  expect(
    await resolveAccountEnv(await portsWith(row()), asAccountId('managed:anthropic'), own),
  ).toEqual({
    env: { ANTHROPIC_API_KEY: 'sk-ant-1' },
  })
})

it('resolves a managed oauth account into CLAUDE_CODE_OAUTH_TOKEN', async () => {
  const ports = await portsWith({
    ...row(),
    id: asAccountId('managed:claude-oauth'),
    kind: 'oauth',
    credential: 'oat-1',
  })
  expect(await resolveAccountEnv(ports, asAccountId('managed:claude-oauth'), own)).toEqual({
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oat-1' },
  })
})

it('yields NO env key for a native account on the owner’s machine — the frame stays as it is today', async () => {
  expect(
    await resolveAccountEnv(await portsWith(), asAccountId('native:claude-code'), own),
  ).toEqual({})
})

it('yields no env key for a native account on a machine nobody looks after (machine access decides)', async () => {
  expect(
    await resolveAccountEnv(await portsWith(), asAccountId('native:claude-code'), {
      ownerUserId: ALICE,
      machineId: UNOWNED,
    }),
  ).toEqual({})
})

// MU-26: a missing selection never falls through to another member's account.
it('refuses a managed account the owner has no connection for, even when another member has one', async () => {
  const ports = await portsWith(row(BOB, 'sk-bob'))
  const refusal = resolveAccountEnv(ports, asAccountId('managed:anthropic'), own)
  await expect(refusal).rejects.toBeInstanceOf(SpawnAccountRefusal)
  await expect(refusal).rejects.toThrow(/You have no Anthropic connection/)
})

it('uses each member’s own connection with the same id', async () => {
  const ports = await portsWith(row(ALICE, 'sk-alice'), row(BOB, 'sk-bob'))
  expect(await resolveAccountEnv(ports, asAccountId('managed:anthropic'), own)).toEqual({
    env: { ANTHROPIC_API_KEY: 'sk-alice' },
  })
  expect(
    await resolveAccountEnv(ports, asAccountId('managed:anthropic'), {
      ownerUserId: BOB,
      machineId: BOB_MACHINE,
    }),
  ).toEqual({ env: { ANTHROPIC_API_KEY: 'sk-bob' } })
})

// MU-28: Bob on Alice's machine.
const bobOnAlice = { ownerUserId: BOB, machineId: ALICE_MACHINE }

it('refuses a native account on someone else’s machine: the login there is theirs', async () => {
  const refusal = resolveAccountEnv(
    await portsWith(),
    asAccountId('native:claude-code'),
    bobOnAlice,
  )
  await expect(refusal).rejects.toBeInstanceOf(SpawnAccountRefusal)
  await expect(refusal).rejects.toThrow(
    /someone else's machine.*never runs your agents on another person's login/,
  )
})

it('refuses a fingerprinted native account on someone else’s machine too', async () => {
  await expect(
    resolveAccountEnv(await portsWith(), asAccountId('native:claude-code:fp-alice'), bobOnAlice),
  ).rejects.toBeInstanceOf(SpawnAccountRefusal)
})

it('shows the shared-machine warning before the first run of an unsent connection there', async () => {
  const refusal = resolveAccountEnv(
    await portsWith(row(BOB, 'sk-bob')),
    asAccountId('managed:anthropic'),
    bobOnAlice,
  )
  await expect(refusal).rejects.toBeInstanceOf(SpawnAccountRefusal)
  await expect(refusal).rejects.toThrow(SHARED_MACHINE_ACCOUNT_WARNING)
})

it('uses the owner’s own connection on someone else’s machine once it was sent there', async () => {
  const ports = await portsWith(row(BOB, 'sk-bob'), row(ALICE, 'sk-alice'))
  await ports.repo.markSent(BOB, 'managed:anthropic', ALICE_MACHINE, '2026-11-03T00:00:00.000Z')
  expect(await resolveAccountEnv(ports, asAccountId('managed:anthropic'), bobOnAlice)).toEqual({
    env: { ANTHROPIC_API_KEY: 'sk-bob' },
  })
})
