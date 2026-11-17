/**
 * LOGINS FOUND ON A MACHINE (credential management §4, §6 way 3; epic plan
 * Task 9, acceptance 4 and the review focus on concurrent reports).
 *
 * A machine's inventory is handed in as the daemon reports it. Identities are
 * obviously fake.
 */

import { asMachineId, asUserId, type Inventory, type MachineId, type UserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { memberFacts } from '../../store/fixtures/test-support'
import { openTestStore } from '../../test-support/open-test-store'
import { type FoundLoginsDeps, recordFoundLogins } from './found-logins'
import { listCredentials } from './queries'
import { IdentitySerial } from './sign-in'

const OWNER = asUserId('user:found-owner')
const OTHER = asUserId('user:found-other')
const ONE = asMachineId('machine:found-one')
const TWO = asMachineId('machine:found-two')
const NOBODYS = asMachineId('machine:found-nobodys')
const FP = 'fp-FAKE-found-claude'
const EMAIL = 'found@example.invalid'

async function setup(): Promise<{ store: SessionStore; deps: FoundLoginsDeps }> {
  const store = await openTestStore(':memory:')
  for (const id of [OWNER, OTHER]) {
    await memberFacts(store).create(
      { id, displayName: id, role: 'member', createdAt: new Date().toISOString(), disabledAt: null },
      'not-a-real-hash',
    )
  }
  const machine = async (id: MachineId, owner?: UserId) =>
    await store.machines.upsertMachine({
      id,
      name: id,
      hostname: `${id}.invalid`,
      tokenHash: `hash-${id}`,
      ...(owner ? { ownerUserId: owner } : {}),
    })
  await machine(ONE, OWNER)
  await machine(TWO, OWNER)
  await machine(NOBODYS)
  return {
    store,
    deps: { store, serial: new IdentitySerial(), now: Date.now, isWaitingFor: () => false },
  }
}

/** A machine reporting Claude Code in its default home, and Codex logged out. */
function report(
  login: { state: 'in' | 'out'; identity?: { fingerprint: string; email?: string } },
  extra: Inventory['agents'][number]['logins'] = [],
): Inventory {
  return {
    os: 'linux',
    arch: 'x64',
    tools: [],
    agents: [
      {
        kind: 'claude-code',
        installed: true,
        login,
        logins: [{ homeId: 'default', ...login }, ...extra],
      },
      { kind: 'codex', installed: true, login: { state: 'out' } },
    ],
  } as Inventory
}

const IN = { state: 'in' as const, identity: { fingerprint: FP, email: EMAIL } }

describe('a login in a default home (acceptance 4)', () => {
  it('creates exactly one credential, owned by the machine’s custodian; nothing is placed', async () => {
    const { store, deps } = await setup()
    const created = await recordFoundLogins(deps, ONE, report(IN))
    expect(created).toHaveLength(1)
    const [record] = await store.credentials.listVisibleTo(OWNER)
    expect(record).toMatchObject({
      id: created[0],
      ownerUserId: OWNER,
      type: 'anthropic.claude-login',
      label: EMAIL,
      status: 'ok',
      identity: { fingerprint: FP, email: EMAIL },
    })
    expect(await store.credentials.listPlacements(record!.id)).toEqual([])
    expect(await store.credentials.listVisibleTo(OTHER)).toEqual([])
  })

  it('a repeated report creates nothing', async () => {
    const { store, deps } = await setup()
    await recordFoundLogins(deps, ONE, report(IN))
    expect(await recordFoundLogins(deps, ONE, report(IN))).toEqual([])
    expect(await store.credentials.listVisibleTo(OWNER)).toHaveLength(1)
  })

  it('the same identity on two machines is one credential with two homes', async () => {
    const { store, deps } = await setup()
    await recordFoundLogins(deps, ONE, report(IN))
    expect(await recordFoundLogins(deps, TWO, report(IN))).toEqual([])
    await store.machines.setMachineInventory(ONE, JSON.stringify(report(IN)))
    await store.machines.setMachineInventory(TWO, JSON.stringify(report(IN)))
    const views = await listCredentials(store, OWNER)
    expect(views).toHaveLength(1)
    expect(views[0]?.homes).toEqual(
      expect.arrayContaining([
        { machineId: ONE, homeId: 'default', state: 'in' },
        { machineId: TWO, homeId: 'default', state: 'in' },
      ]),
    )
    expect(views[0]?.homes).toHaveLength(2)
  })

  it('two reports arriving together create one credential', async () => {
    const { store, deps } = await setup()
    await Promise.all([
      recordFoundLogins(deps, ONE, report(IN)),
      recordFoundLogins(deps, TWO, report(IN)),
      recordFoundLogins(deps, ONE, report(IN)),
    ])
    expect(await store.credentials.listVisibleTo(OWNER)).toHaveLength(1)
  })

  it('a harness that reports no identity creates no row', async () => {
    const { store, deps } = await setup()
    expect(await recordFoundLogins(deps, ONE, report({ state: 'in' }))).toEqual([])
    expect(await recordFoundLogins(deps, ONE, report({ state: 'out' }))).toEqual([])
    expect(await store.credentials.listVisibleTo(OWNER)).toEqual([])
  })

  it('a machine nobody holds custody of creates no row', async () => {
    const { store, deps } = await setup()
    expect(await recordFoundLogins(deps, NOBODYS, report(IN))).toEqual([])
    expect(await store.credentials.listVisibleTo(OWNER)).toEqual([])
  })

  it('a login the custodian already holds as a credential creates nothing', async () => {
    const { store, deps } = await setup()
    await store.credentials.insert({
      ownerUserId: OWNER,
      label: 'Mine',
      type: 'anthropic.claude-login',
      identity: { fingerprint: FP },
    })
    expect(await recordFoundLogins(deps, ONE, report(IN))).toEqual([])
    expect(await store.credentials.listVisibleTo(OWNER)).toHaveLength(1)
  })
})

describe('a Podium home signed in with no sign-in waiting (server restart)', () => {
  const HOME_ID = 'cred_00000000-0000-4000-8000-0000000000f1:claude-code'
  const HOME = { homeId: HOME_ID, state: 'in' as const, identity: { fingerprint: 'fp-FAKE-home', email: 'home@example.invalid' } }

  it('binds it once for the custodian, under the id the home is named for', async () => {
    const { store, deps } = await setup()
    const created = await recordFoundLogins(deps, ONE, report({ state: 'out' }, [HOME]))
    expect(created).toEqual(['cred_00000000-0000-4000-8000-0000000000f1'])
    expect(await store.credentials.listPlacements(created[0]!)).toEqual([
      expect.objectContaining({ homeId: HOME_ID, state: 'present' }),
    ])
    expect(await recordFoundLogins(deps, ONE, report({ state: 'out' }, [HOME]))).toEqual([])
    expect(await store.credentials.listVisibleTo(OWNER)).toHaveLength(1)
  })

  it('leaves a home a waiting sign-in will bind', async () => {
    const { store, deps } = await setup()
    await recordFoundLogins({ ...deps, isWaitingFor: () => true }, ONE, report({ state: 'out' }, [HOME]))
    expect(await store.credentials.listVisibleTo(OWNER)).toEqual([])
  })
})
