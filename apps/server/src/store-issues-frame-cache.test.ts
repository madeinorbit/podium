import { FIRST_ADMIN_USER_ID, asIssueId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'
import type { IssueRow } from './store/types'

/**
 * THE FRAME READ CACHE [POD-1931].
 *
 * The publish fan-out resolves the owning issue of every session it admits, so
 * one event-loop frame was measured issuing 242 `getIssues` calls over 94,138
 * rows plus 5,163 `getIssue` calls — the same rows, re-parsed. The cache serves
 * the second read of an id from the first read's answer, for the duration of
 * ONE synchronous turn.
 *
 * The conserved quantity is the NUMBER OF READS, counted with a probe on the
 * table. Each test asserts both a saved read and a read that still happens, so
 * the probe cannot be silently dead.
 */
// SQLite has no SELECT trigger, so the probe counts the statements the
// repository prepares rather than the rows it touches.
const readProbe = (store: SessionStore): (() => number) => {
  const raw = (store as unknown as { db: { prepare(sql: string): unknown } }).db
  let reads = 0
  const original = raw.prepare.bind(raw)
  raw.prepare = (sql: string) => {
    if (sql.includes('FROM issues WHERE id')) reads += 1
    return original(sql)
  }
  return () => reads
}

const issue = (id: string, over: Partial<IssueRow> = {}): IssueRow =>
  ({
    id: asIssueId(id), repoPath: '/r', seq: 1, title: 'A title', description: 'desc',
    ownerUserId: FIRST_ADMIN_USER_ID, visibility: 'personal' as const,
    createdByActor: FIRST_ADMIN_USER_ID, createdByOnBehalfOf: FIRST_ADMIN_USER_ID,
    stage: 'backlog', worktreePath: null, branch: null, parentBranch: 'main',
    defaultAgent: 'claude-code', defaultModel: 'auto', defaultEffort: 'auto',
    linearId: null, linearIdentifier: null, linearUrl: null,
    activityNotes: null, notesUpdatedAt: null, suggestedStage: null, suggestedReason: null,
    blockedBy: [] as string[], dependencyNote: null, prUrl: null,
    priority: 2, type: 'task', assignee: null, parentId: null, design: null, acceptance: null,
    notes: null, dueAt: null, deferUntil: null, closedReason: null, closedAt: null,
    supersededBy: null, duplicateOf: null, pinned: false, estimateMin: null,
    needsHuman: false, humanQuestion: null,
    createdAt: 't0', updatedAt: 't0', archived: false,
    ...over,
  }) as IssueRow

/**
 * Boot runs its heals through the same write path, which disables caching for
 * the frame that opened the store. Yielding once puts every test in a frame of
 * its own — which is exactly the guarantee under test.
 */
const freshStore = async (): Promise<SessionStore> => {
  const store = new SessionStore(':memory:')
  await Promise.resolve()
  return store
}

describe('issue frame read cache', () => {
  it('serves a repeat read of the same id from the frame, then re-reads next turn', async () => {
    const store = await freshStore()
    store.issues.upsertIssue(issue('iss_a'))
    await Promise.resolve()
    const reads = readProbe(store)

    expect(store.issues.getIssue('iss_a')?.title).toBe('A title')
    const afterFirst = reads()
    expect(afterFirst).toBeGreaterThan(0)
    store.issues.getIssue('iss_a')
    store.issues.getIssue('iss_a')
    expect(reads()).toBe(afterFirst)

    // The turn ends at the first await: the next read goes back to the table.
    await Promise.resolve()
    store.issues.getIssue('iss_a')
    expect(reads()).toBeGreaterThan(afterFirst)
  })

  it('hands every caller its own object, so one mutation cannot reach another', async () => {
    const store = await freshStore()
    store.issues.upsertIssue(issue('iss_a'))
    await Promise.resolve()
    const first = store.issues.getIssue('iss_a')
    expect(first).not.toBeNull()
    if (first) first.title = 'Mutated by its reader'
    expect(store.issues.getIssue('iss_a')?.title).toBe('A title')
  })

  it('a write inside the frame is visible to the read that follows it', async () => {
    const store = await freshStore()
    store.issues.upsertIssue(issue('iss_a'))
    await Promise.resolve()
    expect(store.issues.getIssue('iss_a')?.stage).toBe('backlog')
    store.issues.upsertIssue(issue('iss_a', { stage: 'in_progress' }))
    expect(store.issues.getIssue('iss_a')?.stage).toBe('in_progress')
    // And a delete is not served from the cache either.
    store.issues.deleteIssue(asIssueId('iss_a'))
    expect(store.issues.getIssue('iss_a')).toBeNull()
  })

  it('getIssues serves the frame and still asks for the ids it has not seen', async () => {
    const store = await freshStore()
    store.issues.upsertIssue(issue('iss_a'))
    store.issues.upsertIssue(issue('iss_b', { seq: 2, title: 'Second' }))
    await Promise.resolve()
    const reads = readProbe(store)

    expect(store.issues.getIssues(['iss_a']).get('iss_a')?.title).toBe('A title')
    const afterFirst = reads()
    // 'iss_a' is known, 'iss_b' is not — the batch still runs, for the miss.
    const both = store.issues.getIssues(['iss_a', 'iss_b'])
    expect(both.get('iss_a')?.title).toBe('A title')
    expect(both.get('iss_b')?.title).toBe('Second')
    expect(reads()).toBeGreaterThan(afterFirst)

    // Now both are known: no statement at all.
    const afterSecond = reads()
    expect(store.issues.getIssues(['iss_a', 'iss_b']).size).toBe(2)
    expect(reads()).toBe(afterSecond)
  })

  it('an absent id is an answer and is not re-asked inside the frame', async () => {
    const store = await freshStore()
    const reads = readProbe(store)
    expect(store.issues.getIssues(['iss_missing']).size).toBe(0)
    const afterFirst = reads()
    expect(store.issues.getIssues(['iss_missing']).size).toBe(0)
    expect(store.issues.getIssue('iss_missing')).toBeNull()
    expect(reads()).toBe(afterFirst)
  })
})
