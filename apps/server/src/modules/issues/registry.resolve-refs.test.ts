import { asIssueId, asMachineId, asUserId, firstAdminMemberId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IssueRow, SessionStore } from '../../store'
import { applyAfterCommit, spanOpen } from '../../store/executor/executor'
import { OPERATOR } from '../../test-support/capabilities'
import { openTestStore } from '../../test-support/open-test-store'
import { IssueCommandCtx } from './command-ctx'
import { issueRegistry } from './registry'
import { IssueStore } from './service/core'
import { IssueReportsModule } from './service/reads'
import type { IssueDeps } from './service/types'

const stores: SessionStore[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) await store.close()
})

function row(seq: number, patch: Partial<IssueRow> = {}): IssueRow {
  return {
    id: asIssueId(`iss_${seq}`),
    repoPath: '/repo',
    seq,
    title: 'Reference lookup fixture',
    description: '',
    ownerUserId: firstAdminMemberId(),
    visibility: 'personal',
    createdByActor: firstAdminMemberId(),
    createdByOnBehalfOf: null,
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'codex',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    linearId: null,
    linearIdentifier: null,
    linearUrl: null,
    activityNotes: null,
    notesUpdatedAt: null,
    suggestedStage: null,
    suggestedReason: null,
    blockedBy: [],
    dependencyNote: null,
    prUrl: null,
    priority: 2,
    type: 'task',
    assignee: null,
    parentId: null,
    design: null,
    acceptance: null,
    notes: null,
    dueAt: null,
    deferUntil: null,
    closedReason: null,
    closedAt: null,
    supersededBy: null,
    duplicateOf: null,
    estimateMin: null,
    needsHuman: false,
    humanQuestion: null,
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    archived: false,
    ...patch,
  }
}

async function harness(initial: IssueRow[] = []) {
  const store = await openTestStore(':memory:')
  stores.push(store)
  await store.repos.addRepo('/repo', store.hostMachineId, undefined, 'POD')
  await store.transact(async () => {
    for (const issue of initial) await store.issues.upsertIssue(issue)
  })
  // Reference lookup needs only the repository and the real commit fold port.
  const issues = await new IssueStore({
    store,
    applyCommit: { spanOpen, onCommit: applyAfterCommit },
  } as IssueDeps).init()
  return { store, issues, reports: new IssueReportsModule(issues) }
}

/** Count actual visits to the hydrated map, including an accidental map copy.
 * Successful point reads are counted separately from iteration over rows. */
function countRows(issues: IssueStore) {
  const rows = issues.rows
  const counts = { scanned: 0, hits: 0 }
  const values = rows.values.bind(rows)
  vi.spyOn(rows, 'values').mockImplementation(function* (): Generator<IssueRow, undefined> {
    for (const row of values()) {
      counts.scanned++
      yield row
    }
    return undefined
  })
  const entries = rows.entries.bind(rows)
  const countedEntries = function* (): Generator<[string, IssueRow], undefined> {
    for (const entry of entries()) {
      counts.scanned++
      yield entry
    }
    return undefined
  }
  vi.spyOn(rows, 'entries').mockImplementation(countedEntries)
  vi.spyOn(rows, Symbol.iterator).mockImplementation(countedEntries)
  vi.spyOn(rows, 'forEach').mockImplementation((callback) => {
    for (const [id, row] of entries()) {
      counts.scanned++
      callback(row, id, rows)
    }
  })
  const get = rows.get.bind(rows)
  vi.spyOn(rows, 'get').mockImplementation((id) => {
    const row = get(id)
    if (row) counts.hits++
    return row
  })
  return counts
}

describe('batched chip identities', () => {
  it('deduplicates a bounded indexed batch and hides unreadable identities from two principals', async () => {
    const alice = asUserId('alice'),
      bob = asUserId('bob')
    const { reports } = await harness([
      row(1, { ownerUserId: alice }),
      row(2, { ownerUserId: bob }),
    ])
    const call = async (user: typeof alice) => {
      const ctx = new IssueCommandCtx(
        { issues: { reports } } as never,
        { capability: OPERATOR, principal: { kind: 'user', user, capability: OPERATOR } },
        'resolveRefs',
      )
      return await issueRegistry.defs.resolveRefs.handler(ctx, {
        refs: ['POD-1', 'POD-2', 'POD-404', 'POD-1'],
      })
    }
    expect(await call(alice)).toEqual([
      { ref: 'POD-1', id: 'iss_1' },
      { ref: 'POD-2', id: null },
      { ref: 'POD-404', id: null },
    ])
    expect(await call(bob)).toEqual([
      { ref: 'POD-1', id: null },
      { ref: 'POD-2', id: 'iss_2' },
      { ref: 'POD-404', id: null },
    ])
    expect(
      issueRegistry.defs.resolveRefs.input.safeParse({ refs: Array(201).fill('POD-1') }).success,
    ).toBe(false)
    expect(
      issueRegistry.defs.resolveRefs.input.safeParse({ refs: Array(200).fill('POD-1') }).success,
    ).toBe(true)
  })

  it('visits only the hit for a single lookup and 50 hits for a batch, with no issue-row scan', async () => {
    const { store, issues, reports } = await harness(
      Array.from({ length: 1000 }, (_, i) => row(i + 1)),
    )
    await store.repos.addRepo('/other', store.hostMachineId, undefined, 'OTH')
    // The same numbers in another repo must not increase prefix lookup work.
    await store.transact(async () => {
      for (let i = 1; i <= 50; i++)
        await store.issues.upsertIssue(
          row(i, {
            id: asIssueId(`iss_other_${i}`),
            repoPath: '/other',
          }),
        )
    })
    const counts = countRows(issues)
    const reloads = vi.spyOn(store.issues, 'listIssueRows')
    const prefixes = vi.spyOn(store.repos, 'repoForPrefix')
    expect(await issues.resolveRef('POD-1')).toBe('iss_1')
    console.log('reference-index single', JSON.stringify({ rows: 1050, ...counts }))
    expect.soft(counts.scanned).toBe(0)
    expect.soft(counts.hits).toBe(1)
    counts.scanned = counts.hits = 0
    prefixes.mockClear()
    const refs = Array.from({ length: 50 }, (_, i) => `POD-${i + 1}`)
    expect(await reports.resolveRefs([...refs, 'POD-1'])).toEqual(
      refs.map((ref, i) => ({ ref, id: `iss_${i + 1}` })),
    )
    console.log('reference-index batch', JSON.stringify({ rows: 1050, refs: 50, ...counts }))
    expect.soft(counts.scanned).toBe(0)
    expect.soft(counts.hits).toBe(50)
    expect(prefixes).toHaveBeenCalledTimes(1)
    expect(reloads).not.toHaveBeenCalled()
    counts.scanned = counts.hits = 0
    expect(await issues.resolveRef('POD-9999')).toBe('POD-9999')
    expect(await reports.resolveRefs(['POD-9999', 'ZZZ-1', 'garbage'])).toEqual([
      { ref: 'POD-9999', id: null },
      { ref: 'ZZZ-1', id: null },
      { ref: 'garbage', id: null },
    ])
    expect(counts).toEqual({ scanned: 0, hits: 0 })
  })

  it('keeps the batch numeric grammar and returns null for ambiguous #N', async () => {
    const { store, reports } = await harness([row(1), row(2)])
    await store.repos.addRepo('/other', store.hostMachineId, undefined, 'OTH')
    await store.issues.upsertIssue(row(1, { id: asIssueId('iss_other'), repoPath: '/other' }))
    expect(
      await reports.resolveRefs(['#1', '#2', ' #2 ', '2', '/repo#2', 'iss_2', 'pod-2', 'POD-0']),
    ).toEqual([
      { ref: '#1', id: null },
      { ref: '#2', id: 'iss_2' },
      { ref: ' #2 ', id: 'iss_2' },
      { ref: '2', id: null },
      { ref: '/repo#2', id: null },
      { ref: 'iss_2', id: null },
      { ref: 'pod-2', id: 'iss_2' },
      { ref: 'POD-0', id: null },
    ])
  })
})

describe('maintained issue reference index', () => {
  it('uses a renamed prefix immediately and allows the old prefix to identify another repo', async () => {
    const { store, issues, reports } = await harness([row(1)])
    // Warm both entry points before the rename, with no issue write or reload.
    expect(await issues.resolveRef('POD-1')).toBe('iss_1')
    expect(await reports.resolveRefs(['POD-1'])).toEqual([{ ref: 'POD-1', id: 'iss_1' }])
    await store.repos.setRepoPrefix(store.hostMachineId, '/repo', 'NEW')
    expect(await issues.resolveRef('POD-1')).toBe('POD-1')
    expect(await issues.resolveRef(' new-1 ')).toBe('iss_1')
    expect(await reports.resolveRefs(['POD-1', 'NEW-1'])).toEqual([
      { ref: 'POD-1', id: null },
      { ref: 'NEW-1', id: 'iss_1' },
    ])
    await store.repos.addRepo('/other', store.hostMachineId, undefined, 'POD')
    await store.issues.upsertIssue(row(1, { id: asIssueId('iss_other'), repoPath: '/other' }))
    expect(await issues.resolveRef('POD-1')).toBe('iss_other')
    expect(await reports.resolveRefs(['POD-1', 'NEW-1'])).toEqual([
      { ref: 'POD-1', id: 'iss_other' },
      { ref: 'NEW-1', id: 'iss_1' },
    ])
  })

  it('observes a prefix write inside its span and forgets it after rollback', async () => {
    const { store, issues, reports } = await harness([row(1)])
    await expect(
      store.transact(async () => {
        await store.repos.setRepoPrefix(store.hostMachineId, '/repo', 'NEW')
        expect(await issues.resolveRef('NEW-1')).toBe('iss_1')
        expect(await reports.resolveRefs(['POD-1', 'NEW-1'])).toEqual([
          { ref: 'POD-1', id: null },
          { ref: 'NEW-1', id: 'iss_1' },
        ])
        throw new Error('rollback prefix')
      }),
    ).rejects.toThrow('rollback prefix')
    expect(await issues.resolveRef('POD-1')).toBe('iss_1')
    expect(await issues.resolveRef('NEW-1')).toBe('NEW-1')
  })

  it('preserves internal, numeric, scoped, path-qualified and stable repo-id references', async () => {
    const { store, issues } = await harness([row(1)])
    await store.repos.addRepo('/other', store.hostMachineId, undefined, 'OTH')
    await store.issues.upsertIssue(row(1, { id: asIssueId('iss_other'), repoPath: '/other' }))
    const otherRepo = await store.repos.resolveRepoIdForPath('/other')
    expect(await issues.resolveRef('iss_1')).toBe('iss_1')
    expect(await issues.resolveRef('iss_missing')).toBe('iss_missing')
    expect(await issues.resolveRef('garbage')).toBe('garbage')
    expect(await issues.resolveRef('999')).toBe('999')
    await expect(issues.resolveRef('1')).rejects.toThrow(
      'ambiguous issue ref #1 (matches /repo#1, /other#1)',
    )
    await expect(issues.resolveRef('#1', '/unknown')).rejects.toThrow('ambiguous issue ref #1')
    expect(await issues.resolveRef('#1', '/repo')).toBe('iss_1')
    expect(await issues.resolveRef('1', '/other')).toBe('iss_other')
    expect(await issues.resolveRef('/repo#1')).toBe('iss_1')
    expect(await issues.resolveRef('other#1')).toBe('iss_other')
    expect(await issues.resolveRef(`${otherRepo}#1`)).toBe('iss_other')
    expect(await issues.resolveRef('/unknown#1')).toBe('/unknown#1')
    await store.repos.addRepo('/nested/repo', store.hostMachineId)
    await store.issues.upsertIssue(
      row(1, { id: asIssueId('iss_nested'), repoPath: '/nested/repo' }),
    )
    await expect(issues.resolveRef('repo#1')).rejects.toThrow('ambiguous issue ref repo#1')
    await store.issues.upsertIssue(row(2))
    expect(await issues.resolveRef(' 2 ', '/unknown')).toBe('iss_2')
  })

  it('unifies checkouts by repository identity, including a scope from another machine', async () => {
    const { store, issues, reports } = await harness()
    const remote = asMachineId('remote-fixture')
    const origin = 'https://example.test/reference-repo.git'
    await store.repos.addRepo('/first/checkout', store.hostMachineId, origin, 'ONE')
    await store.repos.addRepo('/second/checkout', remote, origin)
    await store.issues.upsertIssue(
      row(1, {
        id: asIssueId('iss_shared'),
        repoPath: '/first/checkout',
        machineId: store.hostMachineId,
      }),
    )
    await store.issues.upsertIssue(row(1, { id: asIssueId('iss_other'), repoPath: '/repo' }))
    expect(await issues.resolveRef('ONE-1')).toBe('iss_shared')
    expect(await issues.resolveRef('#1', '/second/checkout')).toBe('iss_shared')
    expect(await reports.resolveRefs(['ONE-1', 'POD-1'])).toEqual([
      { ref: 'ONE-1', id: 'iss_shared' },
      { ref: 'POD-1', id: 'iss_other' },
    ])
  })

  it('resolves legacy rows through the live machine-aware repo identity resolver', async () => {
    const { store, issues, reports } = await harness()
    const remote = asMachineId('remote-fixture')
    await store.repos.addRepo('/shared', store.hostMachineId, 'https://example.test/one.git', 'ONE')
    await store.repos.addRepo('/shared', remote, 'https://example.test/two.git', 'TWO')
    issues.installRow(
      'iss_one',
      row(7, {
        id: asIssueId('iss_one'),
        repoPath: '/shared',
        repoId: null,
        machineId: store.hostMachineId,
      }),
    )
    issues.installRow(
      'iss_two',
      row(7, { id: asIssueId('iss_two'), repoPath: '/shared', repoId: null, machineId: remote }),
    )
    expect(await issues.resolveRef('ONE-7')).toBe('iss_one')
    expect(await issues.resolveRef('TWO-7')).toBe('iss_two')
    expect(await reports.resolveRefs(['ONE-7', 'TWO-7'])).toEqual([
      { ref: 'ONE-7', id: 'iss_one' },
      { ref: 'TWO-7', id: 'iss_two' },
    ])
    issues.installRow('iss_two', null)
    await store.repos.addRepo('/later', remote, 'https://example.test/one.git')
    expect(await issues.resolveRef('#7', '/later')).toBe('iss_one')
    issues.installRow(
      'iss_one',
      row(7, { id: asIssueId('iss_one'), repoPath: '/shared', repoId: null, machineId: remote }),
    )
    expect(await issues.resolveRef('ONE-7')).toBe('ONE-7')
    expect(await issues.resolveRef('TWO-7')).toBe('iss_one')
    await store.repos.removeRepo('/shared', remote)
    await store.repos.addRepo('/shared', remote, 'https://example.test/one.git')
    expect(await issues.resolveRef('ONE-7')).toBe('iss_one')
    expect(await issues.resolveRef('TWO-7')).toBe('TWO-7')
  })

  it('tracks direct repository inserts, identity upgrades with renumbering, deletion and reload', async () => {
    const { store, issues, reports } = await harness([row(1)])
    await store.repos.addRepo('/other', store.hostMachineId, undefined, 'OTH')
    await store.issues.upsertIssue(row(1, { id: asIssueId('iss_other'), repoPath: '/other' }))
    const target = await store.repos.resolveRepoIdForPath('/other')
    await store.issues.assignRepoIdToIssuesUnder(target, '/repo')
    expect(await issues.resolveRef('POD-1')).toBe('POD-1')
    expect(await issues.resolveRef('OTH-2')).toBe('iss_1')
    expect(await issues.resolveRef('#1')).toBe('iss_other')
    expect(await issues.resolveRef('/repo#2')).toBe('iss_1')
    expect(await reports.resolveRefs(['POD-1', 'OTH-1', 'OTH-2'])).toEqual([
      { ref: 'POD-1', id: null },
      { ref: 'OTH-1', id: 'iss_other' },
      { ref: 'OTH-2', id: 'iss_1' },
    ])
    await issues.reload()
    expect(await issues.resolveRef('OTH-2')).toBe('iss_1')
    await store.issues.deleteIssue('iss_1')
    expect(await issues.resolveRef('OTH-2')).toBe('OTH-2')
    expect(await reports.resolveRefs(['OTH-2'])).toEqual([{ ref: 'OTH-2', id: null }])
    await store.issues.upsertIssue(row(3))
    expect(await issues.resolveRef('POD-3')).toBe('iss_3')
  })

  it('indexes staged rekeys and new rows without copying committed rows, then drops rolled-back entries', async () => {
    const { store, issues, reports } = await harness([row(1)])
    await store.repos.addRepo('/other', store.hostMachineId, undefined, 'OTH')
    const target = await store.repos.resolveRepoIdForPath('/other')
    const original = issues.rows.get('iss_1')
    if (!original) throw new Error('fixture issue missing')
    const counts = countRows(issues)
    await expect(
      store.transact(async () => {
        issues.installRow('iss_1', { ...original, seq: 9, repoId: target })
        issues.installRow('iss_new', row(10, { id: asIssueId('iss_new'), repoId: target }))
        expect(await issues.resolveRef('POD-1')).toBe('POD-1')
        expect(await issues.resolveRef('OTH-9')).toBe('iss_1')
        expect(await reports.resolveRefs(['OTH-9', 'OTH-10'])).toEqual([
          { ref: 'OTH-9', id: 'iss_1' },
          { ref: 'OTH-10', id: 'iss_new' },
        ])
        issues.installRow('iss_1', null)
        expect(await issues.resolveRef('OTH-9')).toBe('OTH-9')
        expect(counts.scanned).toBe(0)
        throw new Error('rollback rows')
      }),
    ).rejects.toThrow('rollback rows')
    expect(await issues.resolveRef('POD-1')).toBe('iss_1')
    expect(await reports.resolveRefs(['OTH-9', 'OTH-10'])).toEqual([
      { ref: 'OTH-9', id: null },
      { ref: 'OTH-10', id: null },
    ])
    await store.transact(async () => {
      issues.installRow('iss_1', { ...original, seq: 9, repoId: target })
    })
    expect(await issues.resolveRef('OTH-9')).toBe('iss_1')
    expect(await issues.resolveRef('POD-1')).toBe('POD-1')
  })
})
