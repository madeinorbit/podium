import { requireHere } from '../lookup'
import { runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { draftOf } from './draft-of'
import { MobxPool } from '../pool'
import { WriteContractError } from './commands'
import { createPoolTransactions } from './transactions'

const stamp = '2026-10-07T12:00:00Z'
const row = (patch: object = {}) => ({
  id: 'i-1', seq: 1, title: 'Fix login', description: '', stage: 'backlog', audience: 'human',
  deps: [], parentId: null, repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp, readAt: stamp, ...patch,
}) as never

function fixture() {
  const enqueue = vi.fn(async () => {})
  const tx = createPoolTransactions({
    userId: 'u',
    outbox: { pending: () => [], awaiting: () => [], deadLetters: () => [], subscribe: () => () => {} },
    outcomes: () => () => {}, enqueue, addressed: () => () => {},
  })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.attachTransactions(tx)
  pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'i-1', value: row() }] })
  const issue = requireHere(pool.issue('i-1'))!
  return { enqueue, pool, issue, dispose() { tx.dispose(); pool.dispose() } }
}

describe('draftOf(issue)', () => {
  it('drafts the issues.update fields, never mark-read', () => {
    const f = fixture()
    try {
      const d = draftOf(f.issue)
      expect([d.title, d.stage]).toEqual(['Fix login', 'backlog'])
      expect('readAt' in d).toBe(false)
      expect(d.model).toBe(f.issue)
    } finally { f.dispose() }
  })

  it('keeps edits local, and follows the live issue on untouched fields', () => {
    const f = fixture()
    try {
      const d = draftOf(f.issue)
      d.stage = 'review'
      expect(f.enqueue).not.toHaveBeenCalled()
      expect(f.issue.stage).toBe('backlog')
      runInAction(() => f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'i-1', value: row({ title: 'Fix the login' }) }] }))
      expect([d.title, d.stage]).toEqual(['Fix the login', 'review'])
    } finally { f.dispose() }
  })

  it('submits every change as ONE transaction of the edit log', () => {
    const f = fixture()
    try {
      const d = draftOf(f.issue)
      d.title = 'Fix login page'
      d.stage = 'review'
      const txId = d.submit()
      expect(f.enqueue).toHaveBeenCalledTimes(1)
      expect(f.enqueue).toHaveBeenCalledWith(
        'issueUpdate', { id: 'i-1', patch: { title: 'Fix login page', stage: 'review' } }, expect.objectContaining({ mutationId: txId }),
      )
      expect(d.isDirty).toBe(false)
    } finally { f.dispose() }
  })

  it('refuses a stage the form may not set at submit, keeping the edits', () => {
    const f = fixture()
    try {
      const d = draftOf(f.issue)
      d.title = 'Fix login page'
      d.stage = 'done'
      expect(() => d.submit()).toThrow(WriteContractError)
      expect(f.enqueue).not.toHaveBeenCalled()
      expect(d.changedValues).toEqual(new Map<string, string>([['title', 'Fix login page'], ['stage', 'done']]))
    } finally { f.dispose() }
  })
})
