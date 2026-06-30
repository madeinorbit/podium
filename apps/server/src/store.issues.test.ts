import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'
import type { IssueRow } from './store'

function issueColumns(store: SessionStore): Set<string> {
  // @ts-expect-error reach the private db for a schema assertion
  const rows = store.db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

function tableNames(store: SessionStore): Set<string> {
  // @ts-expect-error private db
  const rows = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
    name: string
  }[]
  return new Set(rows.map((r) => r.name))
}

describe('issues schema migration (P1)', () => {
  it('fresh DB has all new rich-field columns', () => {
    const cols = issueColumns(new SessionStore(':memory:'))
    for (const c of [
      'priority', 'type', 'assignee', 'parent_id', 'design', 'acceptance', 'notes',
      'due_at', 'defer_until', 'closed_reason', 'superseded_by', 'duplicate_of',
      'pinned', 'estimate_min',
    ]) {
      expect(cols.has(c), `missing column ${c}`).toBe(true)
    }
  })
})

describe('issues child tables (P1)', () => {
  it('creates issue_labels, issue_deps, issue_comments', () => {
    const t = tableNames(new SessionStore(':memory:'))
    expect(t.has('issue_labels')).toBe(true)
    expect(t.has('issue_deps')).toBe(true)
    expect(t.has('issue_comments')).toBe(true)
  })

  it('backfills blocked_by into issue_deps as type=blocks', () => {
    const store = new SessionStore(':memory:')
    // @ts-expect-error private db — seed a legacy row with a blocked_by array
    store.db.prepare(
      `INSERT INTO issues (id, repo_path, seq, title, stage, parent_branch, default_agent,
         blocked_by, created_at, updated_at)
       VALUES ('iss_a','/r',1,'A','backlog','main','claude-code','["iss_b"]','t','t')`,
    ).run()
    // @ts-expect-error private method
    store.backfillIssueDeps()
    // @ts-expect-error private db
    const deps = store.db.prepare('SELECT from_id, to_id, type FROM issue_deps').all()
    expect(deps).toEqual([{ from_id: 'iss_a', to_id: 'iss_b', type: 'blocks' }])
  })
})

function baseRow(over: Partial<IssueRow> = {}): IssueRow {
  return {
    id: 'iss_x', repoPath: '/r', seq: 1, title: 'X', description: '', stage: 'backlog',
    worktreePath: null, branch: null, parentBranch: 'main', defaultAgent: 'claude-code',
    linearId: null, linearIdentifier: null, linearUrl: null, activityNotes: null,
    notesUpdatedAt: null, suggestedStage: null, suggestedReason: null, blockedBy: [],
    dependencyNote: null, prUrl: null, createdAt: 't', updatedAt: 't', archived: false,
    priority: 2, type: 'task', assignee: null, parentId: null, design: null, acceptance: null,
    notes: null, dueAt: null, deferUntil: null, closedReason: null, supersededBy: null,
    duplicateOf: null, pinned: false, estimateMin: null,
    ...over,
  }
}

describe('IssueRow rich fields round-trip (P1)', () => {
  it('persists and reads back new fields', () => {
    const store = new SessionStore(':memory:')
    store.upsertIssue(baseRow({
      priority: 0, type: 'bug', assignee: 'agent:claude', parentId: 'iss_epic',
      design: 'D', acceptance: 'A', notes: 'N', dueAt: '2026-07-01', deferUntil: '2026-07-05',
      closedReason: 'duplicate', supersededBy: 'iss_new', duplicateOf: 'iss_canon',
      pinned: true, estimateMin: 30,
    }))
    const r = store.getIssue('iss_x')!
    expect(r.priority).toBe(0)
    expect(r.type).toBe('bug')
    expect(r.assignee).toBe('agent:claude')
    expect(r.parentId).toBe('iss_epic')
    expect(r.pinned).toBe(true)
    expect(r.estimateMin).toBe(30)
    expect(r.deferUntil).toBe('2026-07-05')
    expect(r.closedReason).toBe('duplicate')
  })

  it('defaults are applied for a minimal legacy-style insert', () => {
    const store = new SessionStore(':memory:')
    store.upsertIssue(baseRow())
    const r = store.getIssue('iss_x')!
    expect(r.priority).toBe(2)
    expect(r.type).toBe('task')
    expect(r.pinned).toBe(false)
  })
})

describe('issue labels (P1)', () => {
  it('sets, reads (sorted), and lists distinct labels', () => {
    const store = new SessionStore(':memory:')
    store.setIssueLabels('iss_a', ['ui', 'backend', 'ui'])
    store.setIssueLabels('iss_b', ['backend'])
    expect(store.getIssueLabels('iss_a')).toEqual(['backend', 'ui'])
    expect(store.listAllLabels()).toEqual(['backend', 'ui'])
  })

  it('setIssueLabels replaces the prior set', () => {
    const store = new SessionStore(':memory:')
    store.setIssueLabels('iss_a', ['x', 'y'])
    store.setIssueLabels('iss_a', ['y', 'z'])
    expect(store.getIssueLabels('iss_a')).toEqual(['y', 'z'])
  })
})
