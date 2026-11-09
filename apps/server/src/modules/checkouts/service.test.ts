/**
 * EACH MACHINE'S CHECKOUTS AS RECORDS (POD-6644): what a scan writes, and the
 * scans that write nothing.
 *
 * Over a real store (the `checkouts` table and its repository) with the daemon
 * scan faked: every claim is read back from the table and from the change
 * specs the service handed its writer.
 */

import {
  asMachineId,
  firstAdminMemberId,
  type GitRepositoryWire,
  parseCheckoutRowId,
} from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import type { MachineRecordWriter } from '../machines/service'
import { CheckoutsService, checkoutDiff, checkoutsFromScan } from './service'

type Spec = Parameters<MachineRecordWriter['capture']>[0][number]
const M = asMachineId('m1')
const ROOT = '/home/u/podium'
const WT = '/home/u/.worktrees/podium-feature'

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

async function world(opts: { online?: boolean } = {}) {
  const store = await openTestStore(':memory:')
  stores.push(store)
  await store.machines.upsertMachine({
    id: M,
    name: 'one',
    hostname: 'one',
    tokenHash: 'x',
    ownerUserId: firstAdminMemberId(),
    assignment: { server: false, agentExecution: true },
  })
  await store.repos.addRepo(ROOT, M, 'git@github.com:acme/podium.git')
  const captured: Spec[][] = []
  const published: number[] = []
  let answer: { repositories: GitRepositoryWire[]; diagnostics: [] } = {
    repositories: [],
    diagnostics: [],
  }
  const service = new CheckoutsService({
    store,
    scan: async () => answer,
    online: () => opts.online ?? true,
    writer: () => ({
      capture: async (specs) => {
        captured.push([...specs])
        return []
      },
    }),
    publishRepos: async () => void published.push(1),
    now: () => '2026-11-09T00:00:00.000Z',
  })
  return {
    store,
    service,
    captured,
    published,
    answer: (repositories: GitRepositoryWire[]) => {
      answer = { repositories, diagnostics: [] }
    },
  }
}

const scanned = (worktrees: GitRepositoryWire['worktrees'], branch = 'main'): GitRepositoryWire => ({
  path: ROOT,
  kind: 'repository',
  branch,
  originUrl: 'git@github.com:acme/podium.git',
  worktrees,
})

describe('a scan writes what moved, and only that', () => {
  it('writes the root and each worktree once, and an unchanged scan writes nothing', async () => {
    const w = await world()
    w.answer([scanned([{ path: WT, branch: 'feature', headSha: 'abc' }])])
    await w.service.rescan(M)
    const rows = await w.store.checkouts.ofMachine(M)
    expect(rows.map((row) => [row.path, row.root, row.kind, row.branch])).toEqual([
      [WT, ROOT, 'worktree', 'feature'],
      [ROOT, ROOT, 'repository', 'main'],
    ])
    const first = w.captured.flat()
    expect(first.map((spec) => [spec.entity, spec.op, parseCheckoutRowId(spec.id).path]).sort()).toEqual(
      [
        ['checkout', 'upsert', WT],
        ['checkout', 'upsert', ROOT],
      ],
    )
    // No head on the record: it moves on every commit.
    expect(first.every((spec) => !JSON.stringify(spec).includes('abc'))).toBe(true)

    // The same scan again, and again with only the head moved: nothing written.
    const before = w.captured.length
    await w.service.rescan(M)
    w.answer([scanned([{ path: WT, branch: 'feature', headSha: 'def' }])])
    await w.service.rescan(M)
    expect(w.captured.length).toBe(before)
  })

  it('a branch checkout rewrites that checkout alone', async () => {
    const w = await world()
    w.answer([scanned([{ path: WT, branch: 'feature' }])])
    await w.service.rescan(M)
    w.captured.length = 0
    w.answer([scanned([{ path: WT, branch: 'other' }])])
    await w.service.rescan(M)
    expect(w.captured.flat().map((spec) => [spec.op, parseCheckoutRowId(spec.id).path])).toEqual([
      ['upsert', WT],
    ])
  })

  it('a removed worktree is removed; a scan that did not answer removes nothing', async () => {
    const w = await world()
    w.answer([scanned([{ path: WT, branch: 'feature' }])])
    await w.service.rescan(M)
    w.captured.length = 0
    // The scan timed out: no repositories at all. Unknown is not none (POD-1704).
    w.answer([])
    await w.service.rescan(M)
    expect(w.captured).toEqual([])
    expect((await w.store.checkouts.ofMachine(M)).map((row) => row.path)).toContain(WT)
    // The root answered, without the worktree: now it is gone.
    w.answer([scanned([])])
    await w.service.rescan(M)
    expect(w.captured.flat().map((spec) => [spec.op, parseCheckoutRowId(spec.id).path])).toEqual([
      ['remove', WT],
    ])
    expect((await w.store.checkouts.ofMachine(M)).map((row) => row.path)).toEqual([ROOT])
  })

  it('an offline machine is not asked, and its registered root still gets its row', async () => {
    const w = await world({ online: false })
    await w.service.rescan(M)
    expect((await w.store.checkouts.ofMachine(M)).map((row) => [row.path, row.branch])).toEqual([
      [ROOT, null],
    ])
  })

  it('a removed registration takes its root and worktrees with it', async () => {
    const w = await world()
    w.answer([scanned([{ path: WT, branch: 'feature' }])])
    await w.service.rescan(M)
    await w.store.repos.removeRepo(ROOT, M)
    await w.service.registrationsChanged(M)
    expect(await w.store.checkouts.ofMachine(M)).toEqual([])
  })
})

describe('scanned origins', () => {
  it('records a new remote and republishes the repo once; an unchanged one does nothing', async () => {
    const w = await world()
    w.answer([{ ...scanned([]), originUrl: 'git@github.com:acme/renamed.git' }])
    await w.service.rescan(M)
    expect((await w.store.repos.listRepos(M))[0]?.originUrl).toBe('git@github.com:acme/renamed.git')
    expect(w.published).toHaveLength(1)
    await w.service.rescan(M)
    expect(w.published).toHaveLength(1)
  })
})

describe('the scan reading (pure)', () => {
  it('matches roots by machine path key without rewriting display paths', () => {
    const root = String.raw`C:\Src\Podium`
    const { rows, reported } = checkoutsFromScan(M, [{ path: root, repoId: null, originUrl: null }], [
      { path: 'c:/src/podium', kind: 'repository', worktrees: [] },
    ])
    expect(rows.map((row) => row.path)).toEqual([root])
    expect(reported.size).toBe(1)
  })

  it('a registered root that its main repository lists as a worktree is that worktree', () => {
    const main = '/home/u/podium'
    const linked = '/home/u/.worktrees/podium-feature'
    const { rows } = checkoutsFromScan(
      M,
      [
        { path: main, repoId: null, originUrl: null },
        { path: linked, repoId: null, originUrl: null },
      ],
      [
        { path: main, kind: 'repository', worktrees: [{ path: linked, branch: 'feature' }] },
        // The linked worktree's own listing names its main repository: that
        // does not make the main repository a worktree.
        { path: linked, kind: 'worktree', branch: 'feature', worktrees: [{ path: main, branch: 'main' }] },
      ],
    )
    expect(rows.map((row) => [row.path, row.root, row.kind]).sort()).toEqual([
      [linked, main, 'worktree'],
      [main, main, 'repository'],
    ])
  })

  it('a stored row under no registered root goes, whatever the scan said', () => {
    const stray = {
      machineId: M,
      path: '/gone/wt',
      root: '/gone',
      kind: 'worktree' as const,
      repoId: null,
      branch: null,
      originUrl: null,
      locked: false,
      prunable: false,
    }
    const { removes } = checkoutDiff(M, [], [stray], { rows: [], reported: new Set() })
    expect(removes).toEqual([stray])
  })
})
