/**
 * Issue writes that read other issues run a fixed number of statements,
 * whatever the number of issues (POD-6192, server-data rule 8).
 *
 * Creating an issue reads its manual-order key space to mint a key above the
 * top; moving one reads its siblings; a reparent or an ancestor walk reads one
 * row per level. These used to be answered from the in-memory issue map; since
 * POD-6192 the key space is one narrow indexed read and the walk one row per
 * level, so 200 issues in the repository cost what 5 do.
 */

import { asIssueId, asSessionId, firstAdminMemberId, spreadSortKeys } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import type { IssueRow, SessionStore } from '../../../store'
import { issueRowFixture } from '../../../test-support/issue-row'
import { openTestStore } from '../../../test-support/open-test-store'
import { sessionReadPorts } from '../../../test-support/session-facts'
import { expectConstantStatements } from '../../../test-support/statement-count'
import { type IssueDeps, IssueService } from '../service'
import { issueTestPlumbing } from './test-plumbing'

interface Fixture {
  store: SessionStore
  svc: IssueService
}

/** `size` top-level issues with valid, distinct manual-order keys, and a
 *  three-level chain under the first one. */
async function fixture(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  await store.repos.addRepo('/repo', store.hostMachineId, undefined, 'POD')
  const owner = firstAdminMemberId()
  const keys = spreadSortKeys(size)
  const row = (seq: number, patch: Partial<IssueRow> = {}): IssueRow =>
    ({
      ...issueRowFixture({ id: `iss_${seq}`, repoPath: '/repo', seq, ownerUserId: owner, createdByActor: owner, createdByOnBehalfOf: owner }),
      repoId: undefined,
      machineId: store.hostMachineId,
      stage: 'backlog',
      parentId: null,
      worktreePath: null,
      branch: null,
      revision: undefined,
      ...patch,
    }) as IssueRow
  await store.transact(async () => {
    for (let seq = 1; seq <= size; seq++) await store.issues.upsertIssue(row(seq, { sortKey: keys[seq - 1]! }))
    await store.issues.upsertIssue(row(size + 1, { parentId: asIssueId('iss_1') }))
    await store.issues.upsertIssue(row(size + 2, { parentId: asIssueId(`iss_${size + 1}`) }))
    await store.issues.upsertIssue(row(size + 3, { parentId: asIssueId(`iss_${size + 2}`) }))
  })
  const deps: IssueDeps = {
    store,
    ...sessionReadPorts(() => []),
    getSettings: async () =>
      normalizeSettings({
        gitWorkflow: { defaultParentBranch: '', mergeStyle: 'ff-only', autoRebaseBeforeMerge: true },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: vi.fn(async () => ({ sessionId: asSessionId('s1'), machine: 'machine-under-test' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing(() => {}),
    setSessionArchived: vi.fn(),
  }
  return { store, svc: await IssueService.create(deps) }
}

const pin = (name: string, run: (f: Fixture, size: number) => Promise<unknown>, check: (result: unknown, size: number) => void) => ({
  name,
  setup: fixture,
  target: (f: Fixture) => f.store,
  run,
  check: (result: unknown, _f: Fixture, size: number) => check(result, size),
  teardown: async (f: Fixture) => await f.store.close(),
})

describe('issue writes that read other issues: pinned statement counts at 5 and 200 issues', () => {
  it('create at the top of a repository: one read of its key space', async () => {
    await expectConstantStatements(
      pin('crud.create', async (f) => await f.svc.crud.create({ repoPath: '/repo', title: 'New work', startNow: false }),
        (wire) => expect(wire).toMatchObject({ title: 'New work' })),
      13,
    )
  })

  it('move among siblings: one read of the key space', async () => {
    await expectConstantStatements(
      pin('crud.move', async (f) => await f.svc.crud.move('iss_3', { before: 'iss_2' }),
        (wire) => expect(wire).toMatchObject({ id: 'iss_3' })),
      8,
    )
  })

  it('ancestors: one row per level', async () => {
    await expectConstantStatements(
      pin('hierarchy.ancestorIds', async (f, size) => await f.svc.hierarchy.ancestorIds(`iss_${size + 3}`),
        (ids, size) => expect(ids).toEqual([`iss_${size + 2}`, `iss_${size + 1}`, 'iss_1'])),
      4,
    )
  })
})
