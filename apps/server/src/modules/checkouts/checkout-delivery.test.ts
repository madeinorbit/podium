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
 *    member's reach (`checkout_reach`) and the checkouts a shrink took from
 *    them (`checkout_lost`, kept until their reach covers them again); the
 *    anchor sends what the member's reach covers and evicts only what they lost.
 */

import { asMachineId, asUserId, checkoutRowId, type GitRepositoryWire } from '@podium/model'
import { asCapabilityRef, asDeviceId, type Principal } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import {
  countStatements,
  expectConstantStatements,
  type StatementPin,
} from '../../test-support/statement-count'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'

const reachStores: SessionStore[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  disposeOracles()
  for (const store of reachStores.splice(0)) await store.close()
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
  if (opts.checkouts) {
    await o.store.repos.addRepo(ROOT, MACHINE)
    await o.reg.modules.checkouts.rescan(MACHINE)
  }
  return o
}

const root = checkoutRowId(MACHINE, ROOT)
const worktree = checkoutRowId(MACHINE, WORKTREE)

it('a grant rollback takes its access record, checkout reach and lost paths with it', async () => {
  const o = await fixture({ checkouts: true })
  const before = await o.store.sync.maxChangeSeq()
  await expect(
    o.store.transact(async () => {
      await o.store.grants.remove('machine', MACHINE, BOTH, 'use')
      expect(
        (await o.store.checkouts.reachOfMachines([MACHINE])).get(MACHINE)?.get(BOTH)?.reach,
      ).toBe('roots')
      expect((await o.store.checkouts.lostOfMachines([MACHINE])).get(MACHINE)?.get(BOTH)).toEqual([
        { path: WORKTREE, root: false },
      ])
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')
  expect(await o.store.sync.maxChangeSeq()).toBe(before)
  expect((await o.store.checkouts.reachOfMachines([MACHINE])).get(MACHINE)?.get(BOTH)?.reach).toBe(
    'all',
  )
  expect(
    (await o.store.checkouts.lostOfMachines([MACHINE])).get(MACHINE)?.get(BOTH),
  ).toBeUndefined()
})

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
  expect(await idsTold(o, before, LATE)).toEqual([root])
  expect(await received(o, before, LATE)).toEqual([`upsert ${root}`])
})

it('losing USE evicts exactly the worktrees, and keeps the root a manager still reads', async () => {
  const o = await fixture({ checkouts: true })
  const before = await o.reg.changeLedger.authority.cursor()
  await o.store.grants.remove('machine', MACHINE, BOTH, 'use')
  expect(await received(o, before, BOTH)).toEqual([`evict ${worktree}`, `upsert ${root}`].sort())
  // USE alone, lost: everything it covered goes.
  const later = await o.reg.changeLedger.authority.cursor()
  await o.store.grants.remove('machine', MACHINE, USER, 'use')
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
  await grant(o, SEER, 'see')
  await o.store.repos.removeRepo(ROOT, MACHINE)
  await o.reg.modules.checkouts.registrationsChanged(MACHINE)
  expect(await idsTold(o, cursor, SEER)).toEqual([])
  expect(await idsTold(o, cursor, STRANGER)).toEqual([])
})

it('a member offline during the shrink still receives the evicts when they catch up', async () => {
  const o = await fixture({ checkouts: true })
  // The member's device holds the cursor from before the shrink, and is away.
  const away = await o.reg.changeLedger.authority.cursor()
  await o.store.grants.remove('machine', MACHINE, BOTH, 'use')
  // The server keeps working meanwhile: rescans and publishes that append
  // nothing to this member's access row.
  await o.reg.modules.checkouts.rescan(MACHINE)
  // Catching up from where the device stopped.
  expect(await received(o, away, BOTH)).toEqual([`evict ${worktree}`, `upsert ${root}`].sort())
})

it("a second append to the member's access row before the device catches up still delivers the shrink's evicts", async () => {
  const o = await fixture({ checkouts: true })
  const away = await o.reg.changeLedger.authority.cursor()
  await o.store.grants.remove('machine', MACHINE, BOTH, 'use')
  // The same member's row moves again while the device is still away: the
  // machine reports a new hostname, a SEE fact on every member's row.
  await o.store.machines.touchMachine(MACHINE, 'renamed-host')
  expect(await received(o, away, BOTH)).toEqual([`evict ${worktree}`, `upsert ${root}`].sort())
  // The lost set is the one worktree, not the machine's every path.
  const lost = (await o.store.checkouts.lostOfMachines([MACHINE])).get(MACHINE)?.get(BOTH)
  expect(lost).toEqual([{ path: WORKTREE, root: false }])
})

it('regaining USE re-admits the lost worktree and ends its evicts', async () => {
  const o = await fixture({ checkouts: true })
  await o.store.grants.remove('machine', MACHINE, BOTH, 'use')
  const regrant = await o.reg.changeLedger.authority.cursor()
  await grant(o, BOTH, 'use')
  expect(await received(o, regrant, BOTH)).toEqual([`upsert ${worktree}`, `upsert ${root}`].sort())
  expect(
    (await o.store.checkouts.lostOfMachines([MACHINE])).get(MACHINE)?.get(BOTH),
  ).toBeUndefined()
  // A later move of the row re-admits, and evicts nothing.
  const later = await o.reg.changeLedger.authority.cursor()
  await o.store.machines.touchMachine(MACHINE, 'renamed-host')
  expect(await received(o, later, BOTH)).toEqual([`upsert ${worktree}`, `upsert ${root}`].sort())
})

it('a lost checkout that is gone is still evicted to the member who lost it', async () => {
  const o = await fixture({ checkouts: true })
  const away = await o.reg.changeLedger.authority.cursor()
  await o.store.grants.remove('machine', MACHINE, USER, 'use')
  // The repo is unregistered while the device is away: the removals go to the
  // readers it has now, which no longer include this member.
  await o.store.repos.removeRepo(ROOT, MACHINE)
  await o.reg.modules.checkouts.registrationsChanged(MACHINE)
  await o.store.machines.touchMachine(MACHINE, 'renamed-host')
  expect(await received(o, away, USER)).toEqual([`evict ${root}`, `evict ${worktree}`].sort())
})

type ReachChange = Parameters<SessionStore['checkouts']['applyReach']>[0]

async function reachStore(): Promise<SessionStore> {
  const store = await openTestStore(':memory:')
  reachStores.push(store)
  return store
}

/** Distinct values in a batch catch a shared conflict-update placeholder. */
function reachChange(size: number): Required<ReachChange> {
  const reach = Array.from({ length: size }, (_, i) => ({
    userId: LATE,
    machineId: asMachineId(`reach-machine-${i}`),
    reach: i % 2 === 0 ? ('roots' as const) : ('all' as const),
  }))
  const lost = reach.map((row, i) => ({ ...row, path: WORKTREE, root: i % 2 === 0 }))
  return { reach, lost, found: lost }
}

type ReachWrite = 'reach upserts' | 'reach removals' | 'loss inserts' | 're-admission'

function reachPin(
  write: ReachWrite,
): StatementPin<{ store: SessionStore; change: Required<ReachChange> }> {
  return {
    name: `applyReach ${write}`,
    setup: async (size) => {
      const store = await reachStore()
      const change = reachChange(size)
      if (write === 'reach removals') await store.checkouts.applyReach({ reach: change.reach }, AT)
      if (write === 're-admission')
        await store.checkouts.applyReach({ reach: [], lost: change.lost }, AT)
      return { store, change }
    },
    target: (f) => f.store,
    run: async ({ store, change }) => {
      const changes: Record<ReachWrite, ReachChange> = {
        'reach upserts': { reach: change.reach },
        'reach removals': { reach: change.reach.map((row) => ({ ...row, reach: 'none' })) },
        'loss inserts': { reach: [], lost: change.lost },
        're-admission': { reach: [], found: change.found },
      }
      await store.checkouts.applyReach(changes[write], AT)
    },
    check: async (_, { store, change }) => {
      const machines = change.reach.map((row) => row.machineId)
      if (write === 'reach upserts' || write === 'reach removals') {
        const stored = await store.checkouts.reachOfMachines(machines)
        expect(stored.size).toBe(write === 'reach removals' ? 0 : machines.length)
        if (write === 'reach upserts')
          for (const row of change.reach)
            expect(stored.get(row.machineId)?.get(LATE)?.reach).toBe(row.reach)
      } else {
        const stored = await store.checkouts.lostOfMachines(machines)
        expect(stored.size).toBe(write === 're-admission' ? 0 : machines.length)
        if (write === 'loss inserts')
          for (const row of change.lost)
            expect(stored.get(row.machineId)?.get(LATE)).toEqual([
              { path: row.path, root: row.root },
            ])
      }
    },
    teardown: async ({ store }) => {
      reachStores.splice(reachStores.indexOf(store), 1)
      await store.close()
    },
  }
}

describe('checkout reach batch writes', () => {
  it.each<ReachWrite>([
    'reach upserts',
    'reach removals',
    'loss inserts',
    're-admission',
  ])('%s runs one statement at 5 and 200 machines', async (write) => {
    await expectConstantStatements(reachPin(write), 1)
  })

  it('an empty change executes no statements', async () => {
    const store = await reachStore()
    const counted = await countStatements(store, () =>
      store.checkouts.applyReach({ reach: [] }, AT),
    )
    expect(counted.statements).toBe(0)
  })

  it('chunks all four write paths at 500 rows and preserves every row', async () => {
    const store = await reachStore()
    const change = reachChange(1001)
    const machines = change.reach.map((row) => row.machineId)
    const added = await countStatements(store, () =>
      store.checkouts.applyReach({ reach: change.reach, lost: change.lost }, AT),
    )
    expect((await store.checkouts.reachOfMachines(machines)).size).toBe(1001)
    expect((await store.checkouts.lostOfMachines(machines)).size).toBe(1001)
    const removed = await countStatements(store, () =>
      store.checkouts.applyReach(
        {
          reach: change.reach.map((row) => ({ ...row, reach: 'none' })),
          found: change.found,
        },
        AT,
      ),
    )
    expect(await store.checkouts.reachOfMachines(machines)).toEqual(new Map())
    expect(await store.checkouts.lostOfMachines(machines)).toEqual(new Map())
    // Three chunks for each of the two write paths, excluding transaction control.
    expect(added.statements).toBe(6)
    expect(removed.statements).toBe(6)
  })

  it('a late chunk failure rolls back reach changes, found paths and earlier loss chunks', async () => {
    const store = await reachStore()
    const change = reachChange(501)
    await store.checkouts.applyReach({ reach: change.reach, lost: change.lost }, AT)
    const machines = change.reach.map((row) => row.machineId)
    const beforeReach = await store.checkouts.reachOfMachines(machines)
    const beforeLost = await store.checkouts.lostOfMachines(machines)
    await expect(
      store.checkouts.applyReach(
        {
          reach: change.reach.map((row) => ({ ...row, reach: 'none' })),
          found: change.found,
          lost: change.lost.map((row, i) => ({
            ...row,
            path: i === 500 ? (null as unknown as string) : '/new-loss',
          })),
        },
        'later',
      ),
    ).rejects.toThrow()
    expect(await store.checkouts.reachOfMachines(machines)).toEqual(beforeReach)
    expect(await store.checkouts.lostOfMachines(machines)).toEqual(beforeLost)
  })

  it('deletes only the named composite keys and keeps unrelated losses', async () => {
    const store = await reachStore()
    const otherMachine = asMachineId('another-machine')
    const reach = [MACHINE, otherMachine].flatMap((machineId) =>
      [LATE, USER].map((userId) => ({ userId, machineId, reach: 'all' as const })),
    )
    const lost = reach.flatMap((row) =>
      [ROOT, WORKTREE].map((path) => ({ ...row, path, root: path === ROOT })),
    )
    await store.checkouts.applyReach({ reach, lost }, AT)
    const keys = [
      { userId: LATE, machineId: MACHINE },
      { userId: USER, machineId: otherMachine },
    ]
    await store.checkouts.applyReach(
      {
        reach: keys.map((row) => ({ ...row, reach: 'none' })),
        found: keys.map((row) => ({ ...row, path: ROOT })),
      },
      'later',
    )
    const storedReach = await store.checkouts.reachOfMachines([MACHINE, otherMachine])
    const storedLost = await store.checkouts.lostOfMachines([MACHINE, otherMachine])
    for (const row of reach) {
      const removed = keys.some(
        (key) => key.userId === row.userId && key.machineId === row.machineId,
      )
      expect(storedReach.get(row.machineId)?.get(row.userId)?.reach).toBe(
        removed ? undefined : 'all',
      )
      expect(storedLost.get(row.machineId)?.get(row.userId)).toEqual(
        removed
          ? [{ path: WORKTREE, root: false }]
          : [
              { path: WORKTREE, root: false },
              { path: ROOT, root: true },
            ],
      )
    }
  })

  it('retains a loss on conflict and inserts losses after removing found paths', async () => {
    const store = await reachStore()
    const row = { userId: LATE, machineId: MACHINE, path: ROOT, root: true }
    await store.checkouts.applyReach({ reach: [], lost: [row] }, AT)
    await store.checkouts.applyReach({ reach: [], lost: [{ ...row, root: false }] }, 'later')
    expect((await store.checkouts.lostOfMachines([MACHINE])).get(MACHINE)?.get(LATE)).toEqual([
      { path: ROOT, root: true },
    ])
    await store.checkouts.applyReach(
      { reach: [], found: [row], lost: [{ ...row, root: false }] },
      'later',
    )
    expect((await store.checkouts.lostOfMachines([MACHINE])).get(MACHINE)?.get(LATE)).toEqual([
      { path: ROOT, root: false },
    ])
  })

  it('the last reach wins for repeated keys across removals and upserts', async () => {
    const store = await reachStore()
    const key = { userId: LATE, machineId: MACHINE }
    await store.checkouts.applyReach(
      {
        reach: [
          { ...key, reach: 'all' },
          { ...key, reach: 'none' },
          { ...key, reach: 'roots' },
        ],
      },
      AT,
    )
    expect((await store.checkouts.reachOfMachines([MACHINE])).get(MACHINE)?.get(LATE)?.reach).toBe(
      'roots',
    )
    await store.checkouts.applyReach(
      {
        reach: [
          { ...key, reach: 'none' },
          { ...key, reach: 'all' },
          { ...key, reach: 'none' },
        ],
      },
      AT,
    )
    expect(await store.checkouts.reachOfMachines([MACHINE])).toEqual(new Map())
  })
})
