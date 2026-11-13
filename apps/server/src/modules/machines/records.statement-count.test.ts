import { memberFacts } from '../../store/fixtures/test-support'
/**
 * The machine record writes cost a constant number of statements (POD-6644,
 * rule 8 of docs/agents/server-data.md).
 *
 *  - A rename (`records.machine.edit`) and the server's own rewrite of one
 *    machine's records, against `size` members and `size` other machines: the
 *    write reads that machine, its grants and the members once each, and its
 *    change log once, whatever the fleet holds.
 *  - A checkout scan of a machine holding `size` worktrees: one that finds
 *    nothing new writes nothing, and one that finds one new worktree writes
 *    that row alone.
 */

import {
  type asMachineId,
  asMutationId,
  asUserId,
  firstAdminMemberId,
  type GitRepositoryWire,
} from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  countStatements,
  expectArmed,
  expectConstantStatements,
  type StatementPin,
} from '../../test-support/statement-count'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { appliedReply, envelope, submit } from '../sync-write/outbox-test-support'

afterEach(() => {
  vi.restoreAllMocks()
  disposeOracles()
})

const AT = '2026-11-09T00:00:00.000Z'
const ROOT = '/home/u/podium'
let seq = 0

interface Fixture {
  readonly o: Oracle
  readonly machine: ReturnType<typeof asMachineId>
  readonly scan: { repositories: GitRepositoryWire[] }
}

async function fixture(size: number): Promise<Fixture> {
  const o = await makeOracle()
  const machine = o.store.hostMachineId
  for (let i = 0; i < size; i++) {
    await memberFacts(o.store).create(
      {
        id: `user:member-${i}`,
        displayName: `m${i}`,
        role: 'member',
        createdAt: AT,
        disabledAt: null,
      },
      'hash',
    )
    await o.store.machines.upsertMachine({
      id: `other-${i}`,
      name: `other-${i}`,
      hostname: `other-${i}`,
      tokenHash: 'x',
      ownerUserId: asUserId(`user:member-${i}`),
    })
  }
  await o.store.repos.addRepo(ROOT, machine)
  const scan = {
    repositories: [
      {
        path: ROOT,
        kind: 'repository' as const,
        branch: 'main',
        worktrees: Array.from({ length: size }, (_, i) => ({
          path: `/home/u/.worktrees/wt-${i}`,
          branch: `b-${i}`,
        })),
      },
    ],
  }
  vi.spyOn(o.reg.modules.machines, 'hasDaemon').mockReturnValue(true)
  vi.spyOn(o.reg.modules.rpc, 'scanRepos').mockImplementation(async () => ({
    repositories: scan.repositories,
    diagnostics: [],
  }))
  // The records and checkouts as they stand before the counted run.
  await o.reg.modules.checkouts.rescan(machine)
  // The setup's own deliveries run before the count, not inside it.
  await o.reg.changeLedger.authority.settled()
  return { o, machine, scan }
}

const rename: StatementPin<Fixture> = {
  name: 'records.machine.edit (rename)',
  setup: fixture,
  target: (f) => f.o.store,
  run: async (f) =>
    appliedReply(
      await submit(
        f.o,
        envelope(
          'records.machine.edit',
          { id: f.machine, patch: { name: `renamed-${++seq}` } },
          asMutationId(`rename-${seq}`),
        ),
      ),
    ),
  check: (reply) => expect((reply as ReturnType<typeof appliedReply>).replayed).toBe(false),
}

const republish: StatementPin<Fixture> = {
  name: 'stored machine rename (every member)',
  setup: fixture,
  target: (f) => f.o.store,
  run: async (f) => {
    // The repository source write carries the record comparison.
    await f.o.store.machines.renameMachine(f.machine, `direct-${++seq}`)
    return f.machine
  },
}

const unchangedScan: StatementPin<Fixture> = {
  name: 'checkouts.rescan (nothing moved)',
  setup: fixture,
  target: (f) => f.o.store,
  run: async (f) => await f.o.reg.modules.checkouts.rescan(f.machine),
}

const grantWrite: StatementPin<Fixture> = {
  name: 'machine grant source write',
  setup: fixture,
  target: (f) => f.o.store,
  run: async (f) => {
    const actor = await firstAdminMemberId(f.o.store)
    await f.o.store.grants.upsert({
      resourceKind: 'machine',
      resourceId: f.machine,
      grantee: 'user:member-0',
      verb: 'see',
      owner: actor,
      visibility: 'owned-compute',
      createdAt: AT,
      actorKind: 'user',
      actorId: actor,
      onBehalfOf: actor,
    })
  },
}

const memberRole: StatementPin<Fixture> = {
  name: 'member role comparison reads (every machine)',
  setup: fixture,
  target: (f) => f.o.store,
  // The stored copy still writes each appended record until POD-6771. The
  // comparison reads each table once per build across the affected fleet.
  count: async (f, run) => {
    const counted = await countStatements(f.o.store, run)
    const byQuery = new Map([...counted.byQuery].filter(([query]) => /^select\b/i.test(query)))
    return {
      result: counted.result,
      statements: [...byQuery.values()].reduce((total, count) => total + count, 0),
      byQuery,
    }
  },
  run: async (f) => await memberFacts(f.o.store).setRole(asUserId('user:member-0'), 'admin'),
}

// Keep the reach writes visible while POD-6771 separately batches change_latest.
const memberRoleReach: StatementPin<Fixture> = {
  ...memberRole,
  name: 'member role checkout_reach writes (every machine)',
  count: async (f, run) => {
    const counted = await countStatements(f.o.store, run)
    const byQuery = new Map(
      [...counted.byQuery].filter(([query]) =>
        /^(insert into|delete from) "checkout_reach"/i.test(query),
      ),
    )
    return {
      result: counted.result,
      statements: [...byQuery.values()].reduce((total, count) => total + count, 0),
      byQuery,
    }
  },
  check: async (_, f, size) => {
    const machines = [
      f.machine,
      ...Array.from({ length: size }, (_, i) => `other-${i}` as ReturnType<typeof asMachineId>),
    ]
    const reach = await f.o.store.checkouts.reachOfMachines(machines)
    for (const machine of machines)
      expect(reach.get(machine)?.get('user:member-0')?.reach).toBe(
        machine === 'other-0' ? 'all' : 'roots',
      )
  },
}

const oneNewWorktree: StatementPin<Fixture> = {
  name: 'checkouts.rescan (one new worktree)',
  setup: fixture,
  target: (f) => f.o.store,
  run: async (f) => {
    const repo = f.scan.repositories[0]!
    repo.worktrees = [...repo.worktrees, { path: `/home/u/.worktrees/new-${++seq}`, branch: 'new' }]
    return await f.o.reg.modules.checkouts.rescan(f.machine)
  },
}

describe('statement counts of the machine record writes', () => {
  it('a rename does not grow with the members or the fleet', async () => {
    // Observed at both sizes on the supplied epic base, before reach batching.
    // POD-6920: derived change capture (no build before the write; one drain after it): records.machine.edit (rename) 25 -> 18.
    // POD-6934: the setup's own deliveries now run before the count (they had spilled into it): 18 -> 17.
    await expectConstantStatements(rename, 17)
  })

  it('the server rewriting one machine’s records does not grow with the members or the fleet', async () => {
    // POD-6920: derived change capture (no build before the write; one drain after it): stored machine rename (every member) 16 -> 9.
    await expectConstantStatements(republish, 9)
  })

  it('a grant write does not grow with the members or the fleet', async () => {
    // Observed at both sizes on the supplied epic base, before reach batching.
    // POD-6864: re-measured on integrate/6253-sync-log 964ad37114: 25 -> 24.
    // POD-6920: derived change capture (no build before the write; one drain after it): machine grant source write 24 -> 21.
    // A share is not the custody edge, so it reaches the access rows and not the machine record: 21 -> 18.
    // POD-6934: the setup's own deliveries now run before the count (they had spilled into it): 18 -> 16.
    await expectConstantStatements(grantWrite, 16)
  })

  it('a member role comparison reads a fixed number of times across the fleet', async () => {
    // POD-6920: derived change capture (no build before the write; one drain after it): member role comparison reads (every machine) 12 -> 11.
    // POD-6934: the role change is applied through dev/mw's membership writer: 11 -> 12.
    await expectConstantStatements(memberRole, 12)
  })

  it('a member role change batches checkout_reach writes at 5 and 200 machines', async () => {
    await expectConstantStatements(memberRoleReach, 1)
  })

  it('the fleet checkout_reach pin catches a planted write per machine', async () => {
    await expectArmed(memberRoleReach, 1, (f, size) => {
      const apply = f.o.store.checkouts.applyReach.bind(f.o.store.checkouts)
      const spy = vi
        .spyOn(f.o.store.checkouts, 'applyReach')
        .mockImplementation(async (change, at) => {
          await apply(change, at)
          for (let i = 0; i < size; i++)
            await apply(
              { reach: [{ userId: 'user:member-0', machineId: f.machine, reach: 'roots' }] },
              at,
            )
        })
      return () => spy.mockRestore()
    })
  })

  it('a scan that finds nothing new writes nothing, whatever the machine holds', async () => {
    // POD-6934: the setup's own deliveries now run before the count (they had spilled into it): 2 -> 1.
    await expectConstantStatements(unchangedScan, 1)
  })

  it('a scan that finds one new worktree writes that one, whatever the machine holds', async () => {
    // POD-6769: the new checkout is built before the write and after it, in
    // place of one read of the stored copy (6 -> 7).
    // POD-6920: derived change capture (no build before the write; one drain after it): checkouts.rescan (one new worktree) 7 -> 8.
    // POD-6934: the setup's own deliveries now run before the count (they had spilled into it): 8 -> 7.
    await expectConstantStatements(oneNewWorktree, 7)
  })
})

// A burst of what an agent at work produces (POD-6644 acceptance): its
// commits and edits move heads and dirty state, which a rescan sees, and its
// machine's heartbeats move presence. None is a checkout or machine record
// change: the change log gains no checkout row, and no machine row.
it('a burst of agent edits, commits and heartbeats writes no worktree or machine rows', async () => {
  const f = await fixture(8)
  const before = await f.o.store.sync.maxChangeSeq()
  const repo = f.scan.repositories[0]!
  for (let step = 0; step < 40; step++) {
    repo.headSha = `head-${step}`
    repo.worktrees = repo.worktrees.map((tree, at) => ({ ...tree, headSha: `wt-${at}-${step}` }))
    await f.o.reg.modules.checkouts.rescan(f.machine)
    // A heartbeat from the same host (the fixture's hostname).
    await f.o.store.machines.touchMachine(f.machine, 'test')
  }
  const changed = (await f.o.store.sync.changesSince(before)).filter(
    (row) =>
      row.entity === 'checkout' || row.entity === 'machine' || row.entity === 'machineAccess',
  )
  expect(changed).toEqual([])
})

// Checks the fixture reaches the counted run (the checkouts exist at size).
it('the fixture holds its worktrees as records', async () => {
  const f = await fixture(3)
  expect((await f.o.store.checkouts.ofMachine(f.machine)).length).toBe(4)
  void firstAdminMemberId
})
