/**
 * Issue schema integrity [spec:SP-4428] — referential integrity + value
 * constraints on the issue tables (originally issue #164 step 2), verified
 * against a FRESH drizzle-built database: ON DELETE CASCADE onto child
 * tables, ON DELETE SET NULL for scalar back-references, and CHECKed
 * stage/type/priority.
 *
 * The legacy-data sanitation tests that used to live here (coercing
 * out-of-enum values and dangling references on a populated pre-drizzle DB,
 * dropping mirrored parent-child dep rows, folding the retired `verifying`
 * stage back into `review`) tested one-time DATA heals that ran as part of
 * the now-deleted legacy migration chain. That chain — and the
 * `legacy-schema.fixture` it seeded — is gone [spec:SP-4428]. There is no
 * fresh-schema equivalent for those tests, so they are dropped, not adapted.
 */

import { FIRST_ADMIN_USER_ID, SOLE_USER_ID, asIssueId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { IssueRow } from '../store'
import { SessionStore } from '../store'

/** White-box seam: the store's own SQLite connection (FKs enabled). */
function rawDb(s: SessionStore): {
  prepare(q: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown }
} {
  return (s as unknown as { db: ReturnType<typeof rawDb> }).db
}

function issueRow(over: Partial<IssueRow> = {}): IssueRow {
  return {
    id: asIssueId('iss_x'), repoPath: '/r', seq: 1, title: 'X', description: '', stage: 'backlog',
    ownerUserId: FIRST_ADMIN_USER_ID, visibility: 'personal', createdByActor: FIRST_ADMIN_USER_ID,
    createdByOnBehalfOf: FIRST_ADMIN_USER_ID,
    worktreePath: null, branch: null, parentBranch: 'main', defaultAgent: 'claude-code',
    defaultModel: 'auto', defaultEffort: 'auto',
    linearId: null, linearIdentifier: null, linearUrl: null, activityNotes: null,
    notesUpdatedAt: null, suggestedStage: null, suggestedReason: null, blockedBy: [],
    dependencyNote: null, prUrl: null, createdAt: 't', updatedAt: 't', archived: false,
    priority: 2, type: 'task', assignee: null, parentId: null, design: null, acceptance: null,
    notes: null, dueAt: null, deferUntil: null, closedReason: null, closedAt: null, supersededBy: null,
    duplicateOf: null, estimateMin: null,
    needsHuman: false, humanQuestion: null,
    ...over,
  }
}

describe('issue schema: FK behavior at runtime', () => {
  it('deleting an issue cascades onto labels/deps/comments/messages', () => {
    const s = new SessionStore(':memory:')
    s.issues.upsertIssue(issueRow({ id: asIssueId('iss_a'), seq: 1 }))
    s.issues.upsertIssue(issueRow({ id: asIssueId('iss_b'), seq: 2 }))
    s.issues.setIssueLabels('iss_a', ['ui'])
    s.issues.addIssueDep(asIssueId('iss_a'), asIssueId('iss_b'), 'blocks')
    s.issues.addIssueDep(asIssueId('iss_b'), asIssueId('iss_a'), 'related')
    s.issues.addIssueComment({ id: 'cmt_1', issueId: asIssueId('iss_a'), author: 'me', body: 'hi', createdAt: 't' })
    s.issues.addIssueMessage({
      id: 'msg_1', issueId: asIssueId('iss_a'), fromAuthor: 'me', body: 'mail', createdAt: 't',
      status: 'unread', claimedBy: null, claimedAt: null,
    })

    s.issues.deleteIssue('iss_a')

    expect(s.issues.getIssueLabels('iss_a')).toEqual([])
    expect(s.issues.listIssueDeps(asIssueId('iss_a'))).toEqual([])
    expect(s.issues.listIssueDeps(asIssueId('iss_b'))).toEqual([]) // edge pointing AT the deleted issue too
    expect(s.issues.listIssueComments(asIssueId('iss_a'))).toEqual([])
    expect(s.issues.listIssueMessages('iss_a')).toEqual([])
    s.close()
  })

  it("deleting a parent nulls children's parent_id (and supersede/duplicate back-refs)", () => {
    const s = new SessionStore(':memory:')
    s.issues.upsertIssue(issueRow({ id: asIssueId('iss_parent'), seq: 1 }))
    s.issues.upsertIssue(issueRow({ id: asIssueId('iss_child'), seq: 2, parentId: asIssueId('iss_parent') }))
    s.issues.upsertIssue(issueRow({ id: asIssueId('iss_dup'), seq: 3, duplicateOf: asIssueId('iss_parent'), supersededBy: asIssueId('iss_parent') }))

    s.issues.deleteIssue('iss_parent')

    expect(s.issues.getIssue('iss_child')?.parentId).toBeNull()
    expect(s.issues.getIssue('iss_dup')?.duplicateOf).toBeNull()
    expect(s.issues.getIssue('iss_dup')?.supersededBy).toBeNull()
    s.close()
  })

  it('rejects a child row for an issue that does not exist', () => {
    const s = new SessionStore(':memory:')
    expect(() =>
      rawDb(s)
        .prepare("INSERT INTO issue_comments (id, issue_id, author, body, created_at) VALUES ('c', 'iss_ghost', 'a', 'b', 't')")
        .run(),
    ).toThrow(/foreign key/i)
    s.close()
  })

  it('CHECK rejects a garbage stage/type/priority at the SQL layer', () => {
    const s = new SessionStore(':memory:')
    s.issues.upsertIssue(issueRow({ id: asIssueId('iss_ok') }))
    const upd = (col: string, v: unknown) =>
      rawDb(s).prepare(`UPDATE issues SET ${col} = ? WHERE id = 'iss_ok'`).run(v)
    expect(() => upd('stage', 'bogus')).toThrow(/check/i)
    expect(() => upd('type', 'sasquatch')).toThrow(/check/i)
    expect(() => upd('priority', 9)).toThrow(/check/i)
    // The legal values still pass.
    expect(() => upd('stage', 'review')).not.toThrow()
    s.close()
  })
})
