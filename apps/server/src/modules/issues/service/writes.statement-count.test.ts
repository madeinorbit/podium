import { TEST_MACHINE_ID } from '../../../test-support/machine-id'

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
import { fixtureWriteScope } from '@podium/sync/testing'
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
  const store = await openTestStore(':memory:', TEST_MACHINE_ID)
  await store.repos.addRepo('/repo', TEST_MACHINE_ID, undefined, 'POD')
  const owner = firstAdminMemberId()
  const keys = spreadSortKeys(size)
  const row = (seq: number, patch: Partial<IssueRow> = {}): IssueRow =>
    ({
      ...issueRowFixture({
        id: `iss_${seq}`,
        repoPath: '/repo',
        seq,
        ownerUserId: owner,
        createdByActor: owner,
        createdByOnBehalfOf: owner,
      }),
      repoId: undefined,
      machineId: TEST_MACHINE_ID,
      stage: 'backlog',
      parentId: null,
      worktreePath: null,
      branch: null,
      revision: undefined,
      ...patch,
    }) as IssueRow
  await store.transact(async () => {
    for (let seq = 1; seq <= size; seq++)
      await store.issues.upsertIssue(fixtureWriteScope(), row(seq, { sortKey: keys[seq - 1]! }))
    await store.issues.upsertIssue(
      fixtureWriteScope(),
      row(size + 1, { parentId: asIssueId('iss_1') }),
    )
    await store.issues.upsertIssue(
      fixtureWriteScope(),
      row(size + 2, { parentId: asIssueId(`iss_${size + 1}`) }),
    )
    await store.issues.upsertIssue(
      fixtureWriteScope(),
      row(size + 3, { parentId: asIssueId(`iss_${size + 2}`) }),
    )
  })
  const deps: IssueDeps = {
    resolveMachine: async () => TEST_MACHINE_ID,
    store,
    ...sessionReadPorts(() => []),
    getSettings: async () =>
      normalizeSettings({
        gitWorkflow: { defaultParentBranch: '', autoRebaseBeforeMerge: true },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: vi.fn(async () => ({
      sessionId: asSessionId('s1'),
      machine: 'machine-under-test',
    })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing(() => {}, { store }),
    setSessionArchived: vi.fn(),
  }
  const svc = await IssueService.create(deps)
  // The change log is attached before anything is measured (POD-6920).
  await store.attachChangeLog()
  return { store, svc }
}

const pin = (
  name: string,
  run: (f: Fixture, size: number) => Promise<unknown>,
  check: (result: unknown, size: number) => void,
) => ({
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
      pin(
        'crud.create',
        async (f) =>
          await f.svc.crud.create(f.svc.reports.store.serverWriter, {
            repoPath: '/repo',
            title: 'New work',
            startNow: false,
          }),
        (wire) => expect(wire).toMatchObject({ title: 'New work' }),
      ),
      // POD-6218: two earliest-admin lookups, one statement each (the row), not two: 13 -> 11.
      // POD-6341: creating a task starts it for the creating member (POD-6290
      // f97c15fe73, design §4.4). The first-writer start record reads that
      // member's row (#923cf158) and writes it (#e7334576): 11 -> 13, constant
      // in the number of issues.
      // POD-6769: compare at save. The issue and its members' personal records
      // are listed and built before the write and again after it, in place of
      // one read of the stored copies: +6, constant in the number of issues.
      // POD-6765 stored the git observation: one read of it per issue write.
      // POD-6767 split the body headers into a record of their own, built
      // before and after like the issue's: 13 -> 22.
      // POD-6770: the git observation compares at save too. Its one declared
      // read becomes a build before the write and one after: 22 -> 23.
      // POD-6791: the issue and its body headers share each read: 23 -> 21.
      // POD-6920: derived change capture. No list and no build before the
      // write; after it, the drain (one statement), the mapping of the new
      // issue row to the sessions that reference it, and the builds of the
      // records it reached: 21 -> 23, constant in the number of issues.
      // An issue created with no brief or description reaches neither of
      // those records, so one build fewer: 23 -> 22.
      22,
    )
  })

  it('move among siblings: one read of the key space', async () => {
    await expectConstantStatements(
      pin(
        'crud.move',
        async (f) =>
          await f.svc.crud.move(f.svc.reports.store.serverWriter, 'iss_3', { before: 'iss_2' }),
        (wire) => expect(wire).toMatchObject({ id: 'iss_3' }),
      ),
      // POD-6769: compare at save, as for `crud.create` (+5), and POD-6765's
      // read of the stored git observation (+1), and the body headers'
      // two builds (POD-6767): 8 -> 16.
      // POD-6770: the git observation is built before and after, where it
      // was read once: 16 -> 17.
      // POD-6791: the issue and its body headers share each read: 17 -> 15.
      // POD-6920: derived change capture. No build before the write; the
      // drain names only the records whose columns moved: 15 -> 12.
      // A sort key is no column of its sessions' records: 12 -> 11.
      11,
    )
  })

  it('ancestors: one row per level', async () => {
    await expectConstantStatements(
      pin(
        'hierarchy.ancestorIds',
        async (f, size) => await f.svc.hierarchy.ancestorIds(`iss_${size + 3}`),
        (ids, size) => expect(ids).toEqual([`iss_${size + 2}`, `iss_${size + 1}`, 'iss_1']),
      ),
      4,
    )
  })
})
