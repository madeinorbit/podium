/**
 * CHECKOUT CHANGES REACH EXACTLY THEIR READERS (POD-6644 follow-ups).
 *
 * A registered root is readable with MANAGE or USE on its machine; a worktree
 * only with USE. Two defects, both read the way a member's device reads the
 * feed (the Authority's `changesSince` for that member, over the real feed
 * visibility):
 *
 *  - A removed root's row was deleted, so the feed read its removal as a
 *    worktree's and a MANAGE-only member kept the dead checkout for good. The
 *    root now keeps a tombstone row (`checkouts.removed_at`).
 *  - A member's access row moving re-sent every checkout of the machine to
 *    them, and each one they could not read went out as an `evict` carrying
 *    its id, which is its path. The access-row writer now records each
 *    member's reach and what a write took away (`checkout_reach`); the anchor
 *    sends what the member's reach covers and evicts only what they lost.
 */

import { asMachineId, asUserId, checkoutRowId, type GitRepositoryWire } from '@podium/model'
import { asCapabilityRef, asDeviceId, type Principal } from '@podium/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'

afterEach(() => {
  vi.restoreAllMocks()
  disposeOracles()
})

const AT = '2026-11-09T00:00:00.000Z'
const MACHINE = asMachineId('m-6644')
const ROOT = '/home/u/podium'
const WORKTREE = '/home/u/.worktrees/feature'
const OWNER = asUserId('user:owner')
/** MANAGE only. */
const MANAGER = asUserId('user:manager')
/** USE only. */
const USER = asUserId('user:user')
/** USE and MANAGE. */
const BOTH = asUserId('user:both')
/** SEE only. */
const SEER = asUserId('user:seer')
/** No grant at all. */
const STRANGER = asUserId('user:stranger')
/** No grant until a test gives one. */
const LATE = asUserId('user:late')

const principal = (user: string): Principal => ({
  kind: 'user',
  user: asUserId(user),
  device: asDeviceId(`device:${user}`),
  capability: asCapabilityRef(`cap:${user}`),
})

type Verb = 'see' | 'use' | 'manage'

async function grant(o: Oracle, grantee: string, verb: Verb): Promise<void> {
  await o.store.grants.upsert({
    resourceKind: 'machine',
    resourceId: MACHINE,
    grantee,
    verb,
    owner: OWNER,
    visibility: 'owned-compute',
    createdAt: AT,
    actorKind: 'user',
    actorId: OWNER,
    onBehalfOf: OWNER,
  })
}

/** The machine with its root and one worktree on record, and every member's
 *  access row (and reach) as it stands before a test's counted changes. */
async function fixture(opts: { checkouts?: boolean } = {}): Promise<Oracle> {
  const o = await makeOracle()
  for (const id of [OWNER, MANAGER, USER, BOTH, SEER, STRANGER, LATE])
    await o.store.users.create(
      { id, displayName: id, role: 'member', createdAt: AT, disabledAt: null },
      'hash',
    )
  // The owner holds custody, so the edges below are live (and admins are
  // not the only managers).
  await o.store.machines.upsertMachine({
    id: MACHINE,
    name: 'shared',
    hostname: 'shared',
    tokenHash: 'x',
    ownerUserId: OWNER,
  })
  await grant(o, MANAGER, 'manage')
  await grant(o, USER, 'use')
  await grant(o, BOTH, 'use')
  await grant(o, BOTH, 'manage')
  await grant(o, SEER, 'see')
  const scan: { repositories: GitRepositoryWire[] } = {
    repositories: [
      {
        path: ROOT,
        kind: 'repository',
        branch: 'main',
        worktrees: [{ path: WORKTREE, branch: 'feature' }],
      },
    ],
  }
  vi.spyOn(o.reg.modules.machines, 'hasDaemon').mockReturnValue(true)
  vi.spyOn(o.reg.modules.rpc, 'scanRepos').mockImplementation(async () => ({
    repositories: scan.repositories,
    diagnostics: [],
  }))
  await o.reg.modules.machines.publishMachines()
  if (opts.checkouts) {
    await o.store.repos.addRepo(ROOT, MACHINE)
    await o.reg.modules.checkouts.rescan(MACHINE)
  }
  return o
}

const root = checkoutRowId(MACHINE, ROOT)
const worktree = checkoutRowId(MACHINE, WORKTREE)

type Cursor = Awaited<ReturnType<Oracle['reg']['changeLedger']['authority']['cursor']>>

/** The checkout changes since `cursor` that this member's device receives:
 *  the last change per checkout, which is what its replica ends up holding. */
async function received(o: Oracle, cursor: Cursor, user: string): Promise<string[]> {
  const delta = await o.reg.changeLedger.authority.changesSince(cursor, principal(user))
  if (delta?.kind !== 'batch') throw new Error(`expected a batch for ${user}, got ${delta?.kind}`)
  const last = new Map<string, string>()
  for (const change of delta.changes)
    if (change.entity === 'checkout') last.set(change.entityId, change.op)
  return [...last].map(([id, op]) => `${op} ${id}`).sort()
}

/** Every checkout id this member's device was ever told about since `cursor`,
 *  whatever the op. */
async function idsTold(o: Oracle, cursor: Cursor, user: string): Promise<string[]> {
  const delta = await o.reg.changeLedger.authority.changesSince(cursor, principal(user))
  if (delta?.kind !== 'batch') throw new Error(`expected a batch for ${user}, got ${delta?.kind}`)
  return [
    ...new Set(
      delta.changes
        .filter((change) => change.entity === 'checkout')
        .map((change) => change.entityId),
    ),
  ].sort()
}

it('a MANAGE-only member receives the root, and its removal, but never the worktree', async () => {
  const o = await fixture()
  const authority = o.reg.changeLedger.authority

  const registered = await authority.cursor()
  await o.store.repos.addRepo(ROOT, MACHINE)
  await o.reg.modules.checkouts.rescan(MACHINE)
  // Positive control: the user sees both, so an empty answer below means something.
  expect(await received(o, registered, USER)).toEqual(
    [`upsert ${worktree}`, `upsert ${root}`].sort(),
  )
  expect(await received(o, registered, MANAGER)).toEqual([`upsert ${root}`])
  expect(await received(o, registered, STRANGER)).toEqual([])

  const unregistered = await authority.cursor()
  await o.store.repos.removeRepo(ROOT, MACHINE)
  await o.reg.modules.checkouts.registrationsChanged(MACHINE)
  expect(await received(o, unregistered, USER)).toEqual(
    [`remove ${worktree}`, `remove ${root}`].sort(),
  )
  // The manager's replica drops the root it was sent.
  expect(await received(o, unregistered, MANAGER)).toEqual([`remove ${root}`])
  expect(await received(o, unregistered, STRANGER)).toEqual([])
  // The tombstone is not a live checkout: no reader lists it.
  expect((await o.store.checkouts.ofMachine(MACHINE)).map((row) => row.path)).toEqual([])
  expect((await o.store.checkouts.all()).filter((row) => row.machineId === MACHINE)).toEqual([])
  expect((await o.store.checkouts.pathsOfMachines([MACHINE])).get(MACHINE)).toBeUndefined()
})

it('registering a removed root again brings it back to its readers', async () => {
  const o = await fixture()
  const authority = o.reg.changeLedger.authority
  await o.store.repos.addRepo(ROOT, MACHINE)
  await o.reg.modules.checkouts.registrationsChanged(MACHINE)
  await o.store.repos.removeRepo(ROOT, MACHINE)
  await o.reg.modules.checkouts.registrationsChanged(MACHINE)

  const again = await authority.cursor()
  await o.store.repos.addRepo(ROOT, MACHINE)
  await o.reg.modules.checkouts.registrationsChanged(MACHINE)
  expect(await received(o, again, MANAGER)).toEqual([`upsert ${root}`])
  expect((await o.store.checkouts.ofMachine(MACHINE)).map((row) => row.path)).toEqual([ROOT])
})

it("a MANAGE-only member's first access row sends the root and no evict", async () => {
  const o = await fixture({ checkouts: true })
  const before = await o.reg.changeLedger.authority.cursor()
  await grant(o, LATE, 'manage')
  await o.reg.modules.machines.publishMachines([MACHINE])
  expect(await idsTold(o, before, LATE)).toEqual([root])
  expect(await received(o, before, LATE)).toEqual([`upsert ${root}`])
})

it('losing USE evicts exactly the worktrees, and keeps the root a manager still reads', async () => {
  const o = await fixture({ checkouts: true })
  const before = await o.reg.changeLedger.authority.cursor()
  await o.store.grants.remove('machine', MACHINE, BOTH, 'use')
  await o.reg.modules.machines.publishMachines([MACHINE])
  expect(await received(o, before, BOTH)).toEqual([`evict ${worktree}`, `upsert ${root}`].sort())
  // USE alone, lost: everything it covered goes.
  const later = await o.reg.changeLedger.authority.cursor()
  await o.store.grants.remove('machine', MACHINE, USER, 'use')
  await o.reg.modules.machines.publishMachines([MACHINE])
  expect(await received(o, later, USER)).toEqual([`evict ${root}`, `evict ${worktree}`].sort())
  // Nobody else's view moved.
  expect(await idsTold(o, before, MANAGER)).toEqual([])
})

it('a SEE-only member never receives a checkout id', async () => {
  const o = await fixture()
  const cursor = await o.reg.changeLedger.authority.cursor()
  await o.store.repos.addRepo(ROOT, MACHINE)
  await o.reg.modules.checkouts.rescan(MACHINE)
  // Their own access row moves (a rename) and the machine's custody edges move.
  await o.store.machines.renameMachine(MACHINE, 'renamed')
  await o.reg.modules.machines.publishMachines([MACHINE])
  await grant(o, SEER, 'see')
  await o.store.repos.removeRepo(ROOT, MACHINE)
  await o.reg.modules.checkouts.registrationsChanged(MACHINE)
  await o.reg.modules.machines.publishMachines([MACHINE])
  expect(await idsTold(o, cursor, SEER)).toEqual([])
  expect(await idsTold(o, cursor, STRANGER)).toEqual([])
})

it('a member offline during the shrink still receives the evicts when they catch up', async () => {
  const o = await fixture({ checkouts: true })
  // The member's device holds the cursor from before the shrink, and is away.
  const away = await o.reg.changeLedger.authority.cursor()
  await o.store.grants.remove('machine', MACHINE, BOTH, 'use')
  await o.reg.modules.machines.publishMachines([MACHINE])
  // The server keeps working meanwhile: rescans and publishes that append
  // nothing to this member's access row.
  await o.reg.modules.checkouts.rescan(MACHINE)
  await o.reg.modules.machines.publishMachines([MACHINE])
  // Catching up from where the device stopped.
  expect(await received(o, away, BOTH)).toEqual([`evict ${worktree}`, `upsert ${root}`].sort())
})
