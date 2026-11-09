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
import { expectConstantStatements, type StatementPin } from '../../test-support/statement-count'
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
    await o.store.users.create(
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
  await o.reg.modules.machines.publishMachines()
  await o.reg.modules.checkouts.rescan(machine)
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
  name: 'publishMachines (one machine, every member)',
  setup: fixture,
  target: (f) => f.o.store,
  run: async (f) => {
    // A rename on the store alone, so the rewrite has something to write.
    await f.o.store.machines.renameMachine(f.machine, `direct-${++seq}`)
    await f.o.reg.modules.machines.publishMachines([f.machine])
    return f.machine
  },
}

const unchangedScan: StatementPin<Fixture> = {
  name: 'checkouts.rescan (nothing moved)',
  setup: fixture,
  target: (f) => f.o.store,
  run: async (f) => await f.o.reg.modules.checkouts.rescan(f.machine),
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
    await expectConstantStatements(rename, 31)
  })

  it('the server rewriting one machine’s records does not grow with the members or the fleet', async () => {
    await expectConstantStatements(republish, 10)
  })

  it('a scan that finds nothing new writes nothing, whatever the machine holds', async () => {
    await expectConstantStatements(unchangedScan, 2)
  })

  it('a scan that finds one new worktree writes that one, whatever the machine holds', async () => {
    await expectConstantStatements(oneNewWorktree, 6)
  })
})

// A burst of what an agent at work produces (POD-6644 acceptance): its
// commits and edits move heads and dirty state, which a rescan sees, and its
// machine's heartbeats move presence. None is a checkout or machine record
// change: the change log gains no checkout row, and no machine row.
it('a burst of agent edits, commits and heartbeats writes no worktree or machine rows', async () => {
  const f = await fixture(8)
  // The fixture stores the machine's inventory without publishing it: one
  // publish first, so the burst starts from the records the server holds.
  await f.o.reg.modules.machines.publishMachines([f.machine])
  const before = await f.o.store.sync.maxChangeSeq()
  const repo = f.scan.repositories[0]!
  for (let step = 0; step < 40; step++) {
    repo.headSha = `head-${step}`
    repo.worktrees = repo.worktrees.map((tree, at) => ({ ...tree, headSha: `wt-${at}-${step}` }))
    await f.o.reg.modules.checkouts.rescan(f.machine)
    // A heartbeat from the same host (the fixture's hostname).
    await f.o.store.machines.touchMachine(f.machine, 'test')
    await f.o.reg.modules.machines.publishMachines([f.machine])
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
