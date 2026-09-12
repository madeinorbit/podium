import { firstAdminMemberId, asSessionId, asUserId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { openTestStore } from '../../test-support/open-test-store'
import { BLANK_TO_NULL_COLUMNS, normalizeBlankIssueText } from './blank-text'
import { type IssueDeps, IssueService } from './service'
import { issueTestPlumbing } from './service/test-plumbing'
import { sessionReadPorts } from '../../test-support/session-facts'

/**
 * POD-820 — `''` and `null` were two spellings of "absent" on every nullable
 * text column. These assert the ONE spelling that survives a write, at the
 * `persistWith` choke point rather than at any single caller.
 */
async function harness() {
  const store = await openTestStore(':memory:')
  const deps: IssueDeps = {
    store,
    ...sessionReadPorts(() => []),
    getSettings: async () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: 'main',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: vi.fn(async () => ({ sessionId: asSessionId('s1'), machine: 'machine-under-test' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing(() => {}),
    setSessionArchived: vi.fn(),
    now: () => '2026-06-30T00:00:00.000Z',
  }
  return { store, svc: await IssueService.create(deps) }
}

describe('blank issue text normalizes to null', () => {
  // THE TWO `assignee` CASES ARE GONE WITH THE COLUMN (A2), not skipped.
  //
  // POD-820 measured this defect's live blast radius at two rows, both of them
  // `assignee = ''`, and these tests were written over it. `design` below carries
  // the same property, and the class-wide test after it is the one that always
  // mattered: the rule was never about `assignee` specifically, it is about
  // nullable text columns having two spellings of absent.
  //
  // The accountable human is now `owner_user_id`, which is NOT NULL — so the
  // empty-string spelling is not merely normalized away, it is unrepresentable.
  it('leaves a legitimately empty description alone', async () => {
    const { store, svc } = await harness()
    const created = await svc.create({ repoPath: '/repo', title: 'T', description: '', startNow: false })
    await svc.update(created.id, { design: 'a design' })

    const row = await store.issues.getIssue(created.id)
    expect(row?.design).toBe('a design')
    // NOT NULL with a legitimate '' value — the rule is scoped to nullable text.
    expect(row?.description).toBe('')
  })

  it('the accountable owner has no empty spelling to normalize', async () => {
    const { store, svc } = await harness()
    const created = await svc.create({ repoPath: '/repo', title: 'T', startNow: false })

    // A create that names nobody still lands on a real member, so there is no
    // state in which an issue is owned by '' or by null — which is what made the
    // old `assignee` normalization necessary in the first place.
    const row = await store.issues.getIssue(created.id)
    expect(row?.ownerUserId).toBe(firstAdminMemberId())

    // And reassignment moves that same field rather than a second one.
    await svc.update(created.id, { ownerUserId: asUserId('mem_other') })
    expect((await store.issues.getIssue(created.id))?.ownerUserId).toBe('mem_other')
  })

  it('applies to the whole nullable-text class, not just the measured column', async () => {
    const { store, svc } = await harness()
    const created = await svc.create({ repoPath: '/repo', title: 'T', startNow: false })
    await svc.update(created.id, { design: '', notes: '', branch: '', closedReason: '' })

    const row = await store.issues.getIssue(created.id)
    expect(row?.design).toBeNull()
    expect(row?.notes).toBeNull()
    expect(row?.branch).toBeNull()
    expect(row?.closedReason).toBeNull()
  })

  it('normalizes every listed column in one pass', () => {
    // Guards the loop itself: a column present in the list but skipped at
    // runtime (a typo'd key, a short-circuit) fails here rather than waiting for
    // a caller that happens to write that column.
    const row = Object.fromEntries(BLANK_TO_NULL_COLUMNS.map((c) => [c, ''])) as never
    const normalized = normalizeBlankIssueText(row) as unknown as Record<string, unknown>
    for (const column of BLANK_TO_NULL_COLUMNS) {
      expect({ column, value: normalized[column] }).toEqual({
        column,
        value: null,
      })
    }
  })
})
