import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

function issueColumns(store: SessionStore): Set<string> {
  // @ts-expect-error reach the private db for a schema assertion
  const rows = store.db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]
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
