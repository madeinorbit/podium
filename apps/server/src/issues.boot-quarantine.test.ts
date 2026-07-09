import { normalizeSettings } from '@podium/runtime'
/**
 * Boot crash-loop hardening (Phase 1, deliverable 3): a corrupt issue row must
 * never prevent IssueService construction/hydration — it is quarantined
 * (skipped + logged + counted) and every healthy row still loads.
 */

import { describe, expect, it, vi } from 'vitest'
import { IssueService, type IssueDeps } from './modules/issues/service'
import { issueTestPlumbing } from './modules/issues/service/test-plumbing'
import { SessionStore } from './store'

function deps(store: SessionStore): IssueDeps {
  return {
    store,
    listSessions: () => [],
    getSettings: () =>
      normalizeSettings({
        gitWorkflow: { defaultParentBranch: '', mergeStyle: 'ff-only', autoRebaseBeforeMerge: true },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: vi.fn(() => ({ sessionId: 's1' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing(),
  }
}

/** White-box seam: reach the store's own SQLite connection to inject corrupt rows. */
function rawDb(s: SessionStore): { prepare(q: string): { run(...a: unknown[]): unknown } } {
  return (s as unknown as { db: { prepare(q: string): { run(...a: unknown[]): unknown } } }).db
}

describe('IssueService boot quarantine', () => {
  it('constructs without touching the DB; hydration is explicit (init) or lazy', () => {
    const store = new SessionStore(':memory:')
    const listSpy = vi.spyOn(store.issues, 'listIssueRows')
    const svc = new IssueService(deps(store))
    expect(listSpy).not.toHaveBeenCalled() // constructor no longer hydrates
    svc.init()
    expect(listSpy).toHaveBeenCalledTimes(1)
  })

  it('a structurally corrupt row (NULL id) is skipped; the other rows load and boot proceeds', () => {
    const store = new SessionStore(':memory:')
    const svc = new IssueService(deps(store))
    const good1 = svc.create({ repoPath: '/r', title: 'healthy one', startNow: false })
    const good2 = svc.create({ repoPath: '/r', title: 'healthy two', startNow: false })
    // SQLite permits NULL in a TEXT PRIMARY KEY — a genuinely corrupt row.
    rawDb(store)
      .prepare(
        `INSERT INTO issues (id, repo_path, seq, title, stage, default_agent, created_at, updated_at)
         VALUES (NULL, '/r', 99, 'poisoned', 'backlog', 'claude-code', 't', 't')`,
      )
      .run()

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // Fresh service over the same store simulates the next boot.
      const rebooted = new IssueService(deps(store))
      expect(() => rebooted.init()).not.toThrow()
      const ids = rebooted.list('/r').map((w) => w.id)
      expect(ids).toContain(good1.id)
      expect(ids).toContain(good2.id)
      expect(ids).toHaveLength(2)
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('quarantined corrupt row'))
    } finally {
      errSpy.mockRestore()
    }
  })

  it('bad JSON in a column quarantines the VALUE but keeps the row', () => {
    const store = new SessionStore(':memory:')
    const svc = new IssueService(deps(store))
    const w = svc.create({ repoPath: '/r', title: 'keep me', startNow: false })
    rawDb(store).prepare('UPDATE issues SET blocked_by = ? WHERE id = ?').run('{not json', w.id)

    const rebooted = new IssueService(deps(store))
    expect(() => rebooted.init()).not.toThrow()
    const row = rebooted.get(w.id)
    expect(row?.id).toBe(w.id)
    expect(store.issues.getIssue(w.id)?.blockedBy).toEqual([])
  })
})
