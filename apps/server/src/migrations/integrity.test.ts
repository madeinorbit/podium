/**
 * Migration 006 — referential integrity + value constraints on the issue
 * tables (issue #164 step 2): ON DELETE CASCADE onto child tables, ON DELETE
 * SET NULL for scalar back-references, CHECKed stage/type/priority, and the
 * legacy-data sanitation that lets a populated DB converge.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../store'
import type { IssueRow } from '../store'
import { LEGACY_SCHEMA_SQL } from './legacy-schema.fixture'

function tmpDb(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'podium-integrity-')), name)
}

/** White-box seam: the store's own SQLite connection (FKs enabled). */
function rawDb(s: SessionStore): {
  prepare(q: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown }
} {
  return (s as unknown as { db: ReturnType<typeof rawDb> }).db
}

function issueRow(over: Partial<IssueRow> = {}): IssueRow {
  return {
    id: 'iss_x', repoPath: '/r', seq: 1, title: 'X', description: '', stage: 'backlog',
    worktreePath: null, branch: null, parentBranch: 'main', defaultAgent: 'claude-code',
    defaultModel: 'auto', defaultEffort: 'auto',
    linearId: null, linearIdentifier: null, linearUrl: null, activityNotes: null,
    notesUpdatedAt: null, suggestedStage: null, suggestedReason: null, blockedBy: [],
    dependencyNote: null, prUrl: null, createdAt: 't', updatedAt: 't', archived: false,
    priority: 2, type: 'task', assignee: null, parentId: null, design: null, acceptance: null,
    notes: null, dueAt: null, deferUntil: null, closedReason: null, supersededBy: null,
    duplicateOf: null, pinned: false, estimateMin: null,
    needsHuman: false, humanQuestion: null,
    ...over,
  }
}

describe('migration 006: FK behavior at runtime', () => {
  it('deleting an issue cascades onto labels/deps/comments/messages', () => {
    const s = new SessionStore(':memory:')
    s.issues.upsertIssue(issueRow({ id: 'iss_a', seq: 1 }))
    s.issues.upsertIssue(issueRow({ id: 'iss_b', seq: 2 }))
    s.issues.setIssueLabels('iss_a', ['ui'])
    s.issues.addIssueDep('iss_a', 'iss_b', 'blocks')
    s.issues.addIssueDep('iss_b', 'iss_a', 'related')
    s.issues.addIssueComment({ id: 'cmt_1', issueId: 'iss_a', author: 'me', body: 'hi', createdAt: 't' })
    s.issues.addIssueMessage({
      id: 'msg_1', issueId: 'iss_a', fromAuthor: 'me', body: 'mail', createdAt: 't',
      status: 'unread', claimedBy: null, readAt: null, claimedAt: null,
    })

    s.issues.deleteIssue('iss_a')

    expect(s.issues.getIssueLabels('iss_a')).toEqual([])
    expect(s.issues.listIssueDeps('iss_a')).toEqual([])
    expect(s.issues.listIssueDeps('iss_b')).toEqual([]) // edge pointing AT the deleted issue too
    expect(s.issues.listIssueComments('iss_a')).toEqual([])
    expect(s.issues.listIssueMessages('iss_a')).toEqual([])
    s.close()
  })

  it("deleting a parent nulls children's parent_id (and supersede/duplicate back-refs)", () => {
    const s = new SessionStore(':memory:')
    s.issues.upsertIssue(issueRow({ id: 'iss_parent', seq: 1 }))
    s.issues.upsertIssue(issueRow({ id: 'iss_child', seq: 2, parentId: 'iss_parent' }))
    s.issues.upsertIssue(issueRow({ id: 'iss_dup', seq: 3, duplicateOf: 'iss_parent', supersededBy: 'iss_parent' }))

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
    s.issues.upsertIssue(issueRow({ id: 'iss_ok' }))
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

describe('migration 006: legacy-data sanitation', () => {
  it('coerces out-of-enum values and clears dangling references on a populated legacy DB', () => {
    const file = tmpDb('legacy.db')
    {
      const db = openDatabase(file)
      for (const sql of LEGACY_SCHEMA_SQL) db.exec(sql)
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (1, ?, ?)').run(
        'baseline',
        't',
      )
      db.exec(
        `INSERT INTO issues (id, repo_path, seq, title, stage, type, priority, parent_id, superseded_by, default_agent, created_at, updated_at)
         VALUES ('iss_bad', '/r', 1, 'garbage row', 'weird-stage', 'not-a-type', 9, 'iss_gone', 'iss_gone', 'claude-code', 't', 't')`,
      )
      db.exec("INSERT INTO issue_labels (issue_id, label) VALUES ('iss_gone', 'orphan')")
      db.exec("INSERT INTO issue_deps (from_id, to_id) VALUES ('iss_bad', 'iss_gone')")
      db.exec(
        `INSERT INTO issue_comments (id, issue_id, author, body, created_at)
         VALUES ('c1', 'iss_gone', 'a', 'orphan', 't')`,
      )
      db.close()
    }

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const s = new SessionStore(file)
      const row = s.issues.getIssue('iss_bad')
      expect(row?.stage).toBe('backlog')
      expect(row?.type).toBe('task')
      expect(row?.priority).toBe(2)
      expect(row?.parentId).toBeNull()
      expect(row?.supersededBy).toBeNull()
      expect(s.issues.getIssueLabels('iss_gone')).toEqual([])
      expect(s.issues.listIssueDeps('iss_bad')).toEqual([])
      expect(s.issues.listIssueComments('iss_gone')).toEqual([])
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('out-of-range stage'))
      s.close()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('migration 007: single parent storage', () => {
  it('drops the mirrored parent-child dep rows; real dep types survive', () => {
    const file = tmpDb('parent.db')
    {
      const db = openDatabase(file)
      for (const sql of LEGACY_SCHEMA_SQL) db.exec(sql)
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (1, ?, ?)').run(
        'baseline',
        't',
      )
      db.exec(
        `INSERT INTO issues (id, repo_path, seq, title, stage, parent_id, default_agent, created_at, updated_at)
         VALUES ('iss_epic', '/r', 1, 'epic', 'backlog', NULL, 'claude-code', 't', 't'),
                ('iss_kid', '/r', 2, 'kid', 'backlog', 'iss_epic', 'claude-code', 't', 't')`,
      )
      db.exec(
        `INSERT INTO issue_deps (from_id, to_id, type)
         VALUES ('iss_kid', 'iss_epic', 'parent-child'), ('iss_kid', 'iss_epic', 'blocks')`,
      )
      db.close()
    }
    const s = new SessionStore(file)
    expect(s.issues.listIssueDeps('iss_kid')).toEqual([{ toId: 'iss_epic', type: 'blocks' }])
    expect(s.issues.getIssue('iss_kid')?.parentId).toBe('iss_epic') // the column is the storage
    s.close()
  })
})

describe('migration 010: the verifying stage is gone', () => {
  it('folds legacy verifying rows (and stale suggestions) back into review', () => {
    const file = tmpDb('verifying.db')
    {
      const db = openDatabase(file)
      for (const sql of LEGACY_SCHEMA_SQL) db.exec(sql)
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (1, ?, ?)').run(
        'baseline',
        't',
      )
      db.exec(
        `INSERT INTO issues (id, repo_path, seq, title, stage, suggested_stage, default_agent, created_at, updated_at)
         VALUES ('iss_v', '/r', 1, 'mid-verify', 'verifying', NULL, 'claude-code', 't', 't'),
                ('iss_s', '/r', 2, 'stale-hint', 'review', 'verifying', 'claude-code', 't', 't')`,
      )
      db.close()
    }
    const s = new SessionStore(file)
    // Not 'done': verification wasn't finished, so it stays on the board.
    expect(s.issues.getIssue('iss_v')?.stage).toBe('review')
    expect(s.issues.getIssue('iss_s')?.suggestedStage).toBe('review')
    s.close()
  })
})
