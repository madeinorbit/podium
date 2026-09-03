import { asSessionId, asUserId, type UserId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../../store'
import { BLANK_TO_NULL_COLUMNS, normalizeBlankIssueText } from './blank-text'
import { type IssueDeps, IssueService } from './service'
import { issueTestPlumbing } from './service/test-plumbing'

/**
 * POD-820 — `''` and `null` were two spellings of "absent" on every nullable
 * text column. These assert the ONE spelling that survives a write, at the
 * `persistWith` choke point rather than at any single caller.
 */
function harness() {
  const store = new SessionStore(':memory:')
  const deps: IssueDeps = {
    store,
    listSessions: () => [],
    getSettings: () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: 'main',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: vi.fn(() => ({ sessionId: asSessionId('s1'), machine: 'machine-under-test' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing(() => {}),
    setSessionArchived: vi.fn(),
    now: () => '2026-06-30T00:00:00.000Z',
  }
  return { store, svc: IssueService.create(deps) }
}

describe('blank issue text normalizes to null', () => {
  it('collapses an empty assignee written through update()', () => {
    const { store, svc } = harness()
    const created = svc.create({ repoPath: '/repo', title: 'T', startNow: false })
    svc.update(created.id, { assignee: '' as UserId })

    // Read back through the STORE, not the wire: the wire's truthiness omission
    // renders both spellings identically, which is why this was invisible.
    expect(store.issues.getIssue(created.id)?.assignee).toBeNull()
  })

  it('leaves a non-empty value and a legitimately empty description alone', () => {
    const { store, svc } = harness()
    const created = svc.create({ repoPath: '/repo', title: 'T', description: '', startNow: false })
    svc.update(created.id, { assignee: asUserId('user:sole') })

    const row = store.issues.getIssue(created.id)
    expect(row?.assignee).toBe('user:sole')
    // NOT NULL with a legitimate '' value — the rule is scoped to nullable text.
    expect(row?.description).toBe('')
  })

  it('applies to the whole nullable-text class, not just the measured column', () => {
    const { store, svc } = harness()
    const created = svc.create({ repoPath: '/repo', title: 'T', startNow: false })
    svc.update(created.id, { design: '', notes: '', branch: '', closedReason: '' })

    const row = store.issues.getIssue(created.id)
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
