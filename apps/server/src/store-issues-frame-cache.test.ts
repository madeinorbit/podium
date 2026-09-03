import { asIssueId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'
import { type LegacyHandleHolder, probeLegacyStatements } from './store/executor'
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
// repository EXECUTES rather than the rows it touches.
/**
 * THE PROBE SITS AT THE EXECUTION SEAM, NOT ON `prepare` [POD-3281].
 *
 * It used to count PREPARATIONS by patching `store.db.prepare`. The executor's
 * driver keeps one prepared statement per SQL text, so under a converted
 * repository that count is 1 forever however many times the read runs — the
 * probe would report a cache that works whether or not it does. The seam counts
 * EXECUTIONS on whichever feed issued them, so the number survives the
 * conversion. Today the store is unconverted and the two counts coincide, which
 * is exactly why this moves now rather than in a conversion commit.
 */
const readProbe = (store: SessionStore): (() => number) => {
  let reads = 0
  probeLegacyStatements(store as unknown as LegacyHandleHolder, (observation) => {
    if (observation.sql.includes('FROM issues WHERE id')) reads += 1
  })
  return () => reads
}

const issue = (id: string, over: Partial<IssueRow> = {}): IssueRow =>
  ({
    id: asIssueId(id),
    repoPath: '/r',
    seq: 1,
    title: 'A title',
    description: 'desc',
    ownerUserId: FIRST_ADMIN_USER_ID,
    visibility: 'personal' as const,
    createdByActor: FIRST_ADMIN_USER_ID,
    createdByOnBehalfOf: FIRST_ADMIN_USER_ID,
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    linearId: null,
    linearIdentifier: null,
    linearUrl: null,
    activityNotes: null,
    notesUpdatedAt: null,
    suggestedStage: null,
    suggestedReason: null,
    blockedBy: [] as string[],
    dependencyNote: null,
    prUrl: null,
    priority: 2,
    type: 'task',
    assignee: null,
    parentId: null,
    design: null,
    acceptance: null,
    notes: null,
    dueAt: null,
    deferUntil: null,
    closedReason: null,
    closedAt: null,
    supersededBy: null,
    duplicateOf: null,
    pinned: false,
    estimateMin: null,
    needsHuman: false,
    humanQuestion: null,
    createdAt: 't0',
    updatedAt: 't0',
    archived: false,
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

  /**
   * THE ARM THE HAPPY CASE NEVER WALKS [POD-3261, spec rule 14].
   *
   * A write disables caching for the rest of the scope, and the comment on that
   * flag says why: a row read INSIDE an open transaction must not be served
   * after that transaction rolls back. Every other test here walks the commit
   * arm, where clearing the cache on the write is enough on its own — so
   * deleting the disable flag entirely leaves the whole suite green while the
   * guard is gone. This is the rollback arm, where the two differ.
   *
   * Without the flag, the read below returns `in_progress` from a cache holding
   * a row the database rolled back.
   */
  it('does not serve a row a rolled-back transaction put in the cache', async () => {
    const store = await freshStore()
    store.issues.upsertIssue(issue('iss_a'))
    await Promise.resolve()
    expect(store.issues.getIssue('iss_a')?.stage).toBe('backlog')

    expect(() =>
      store.transact(() => {
        store.issues.upsertIssue(issue('iss_a', { stage: 'in_progress' }))
        // The read that would fill the cache from inside the transaction.
        expect(store.issues.getIssue('iss_a')?.stage).toBe('in_progress')
        throw new Error('rolled back')
      }),
    ).toThrow('rolled back')

    // Same turn, so the cache is still the one the transaction touched.
    expect(store.issues.getIssue('iss_a')?.stage).toBe('backlog')
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
