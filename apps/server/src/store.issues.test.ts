import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

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
