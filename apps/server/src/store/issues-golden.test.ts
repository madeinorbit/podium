/**
 * Golden tests for the issues aggregate, written BEFORE its drizzle conversion
 * [POD-3397, execution method §3 Stage A item 10].
 *
 * WHAT THESE ARE FOR. The coverage census (docs/internal/pod-3244) found one
 * method of `IssuesRepository` that no test executes (`purgeIssueUserState`)
 * and ten that are executed only incidentally, never named by an assertion:
 * `listIssueCwdRows`, `listIssueParentEdges`, `assignRepoIdToIssuesUnder`,
 * `issuesMissingRepoId`, `listIssueLabelsByIssue`, `listAllIssueDeps`,
 * `countIssueComments`, `countIssueCommentsByIssue`, `searchIssueComments` and
 * `deleteIssueMessagesForIssue`. A method in either group has no oracle, so its
 * conversion could change behaviour with the suite still green.
 *
 * THE REVISION PRECONDITION IS PINNED HERE TOO, though `upsertIssue` is
 * well covered: POD-3373 showed the precondition standing in front of a silent
 * data loss, and what the existing tests exercise is the write, not the refusal
 * and its exact triggering condition. A conversion may not weaken it (accept a
 * write it refuses today) or widen it (refuse one it accepts), and neither
 * direction is visible from a test that only writes rows.
 */

import { asIssueId, asMachineId, asUserId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { IssueRow, SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import { StaleIssueRevisionError } from './issue-revision'

function issueRow(over: Partial<IssueRow> = {}): IssueRow {
  return {
    id: asIssueId('iss_x'),
    repoPath: '/r',
    seq: 1,
    title: 'X',
    description: '',
    stage: 'backlog',
    ownerUserId: FIRST_ADMIN_USER_ID,
    visibility: 'personal',
    createdByActor: FIRST_ADMIN_USER_ID,
    createdByOnBehalfOf: FIRST_ADMIN_USER_ID,
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
    blockedBy: [],
    dependencyNote: null,
    prUrl: null,
    createdAt: 't',
    updatedAt: 't',
    archived: false,
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
    estimateMin: null,
    needsHuman: false,
    humanQuestion: null,
    ...over,
  }
}

async function seed(store: SessionStore, over: Partial<IssueRow> = {}): Promise<IssueRow> {
  const row = issueRow(over)
  await store.issues.upsertIssue(row)
  return row
}

/**
 * The parent rows a child-table test needs. Every child table
 * (`issue_labels`, `issue_deps`, `issue_comments`, `issue_messages`) has a
 * foreign key onto `issues`, so a test writing children without them is
 * refused by the schema rather than testing anything.
 */
async function seedIssues(store: SessionStore, ids: readonly string[]): Promise<void> {
  for (const [i, id] of ids.entries()) {
    await seed(store, { id: asIssueId(id), seq: i + 1 })
  }
}

describe('IssuesRepository: the revision precondition (POD-3373)', () => {
  it('bumps the revision on every accepted write, starting at 1', async () => {
    const store = await openTestStore(':memory:')
    const row = await seed(store, { id: asIssueId('iss_1') })
    // The bump is structural — it happens in the writer, with no cooperation
    // from the caller — and it stamps the caller's row in place.
    expect(row.revision).toBe(1)
    await store.issues.upsertIssue(row)
    expect(row.revision).toBe(2)
    expect((await store.issues.getIssue('iss_1'))?.revision).toBe(2)
    store.close()
  })

  it('accepts a write whose expectedRevision matches the stored one', async () => {
    const store = await openTestStore(':memory:')
    const row = await seed(store, { id: asIssueId('iss_1') })
    await store.issues.upsertIssue({ ...row, title: 'second' }, { expectedRevision: 1 })
    expect((await store.issues.getIssue('iss_1'))?.title).toBe('second')
    store.close()
  })

  it('REFUSES a write whose expectedRevision is behind the stored one, and writes nothing', async () => {
    const store = await openTestStore(':memory:')
    const row = await seed(store, { id: asIssueId('iss_1') })
    // Somebody else committed in the gap: the row is now at revision 2 while
    // this caller's draft was cut from 1. Persisting it would write the draft's
    // whole field set back over the winner's columns.
    await store.issues.upsertIssue({ ...row, title: 'winner' })

    await expect(
      (async () =>
        await store.issues.upsertIssue({ ...row, title: 'loser' }, { expectedRevision: 1 }))(),
    ).rejects.toThrow(StaleIssueRevisionError)

    expect((await store.issues.getIssue('iss_1'))?.title).toBe('winner')
    store.close()
  })

  it('a null expectedRevision means "this row must not exist yet"', async () => {
    const store = await openTestStore(':memory:')
    // The spelling matters: null is not "no precondition", it is the
    // precondition for a first write. A conversion that folded null into
    // "unchecked" would let a create silently overwrite a live row.
    await store.issues.upsertIssue(issueRow({ id: asIssueId('iss_1') }), {
      expectedRevision: null,
    })
    await expect(
      (async () =>
        await store.issues.upsertIssue(issueRow({ id: asIssueId('iss_1'), title: 'again' }), {
          expectedRevision: null,
        }))(),
    ).rejects.toThrow(StaleIssueRevisionError)
    expect((await store.issues.getIssue('iss_1'))?.title).toBe('X')
    store.close()
  })

  it('omitting the option checks nothing — the precondition is opt-in', async () => {
    const store = await openTestStore(':memory:')
    const row = await seed(store, { id: asIssueId('iss_1') })
    await store.issues.upsertIssue({ ...row, revision: 99, title: 'stale-copy' })
    // The stored revision, not the caller's copy, is what the bump is computed
    // from — so a hand-built or stale `revision` field cannot jump the counter.
    expect((await store.issues.getIssue('iss_1'))?.revision).toBe(2)
    store.close()
  })

  it('refuses against the STORED revision rather than the one on the caller row', async () => {
    const store = await openTestStore(':memory:')
    const row = await seed(store, { id: asIssueId('iss_1') })
    await expect(
      (async () =>
        await store.issues.upsertIssue({ ...row, revision: 5 }, { expectedRevision: 5 }))(),
    ).rejects.toThrow(StaleIssueRevisionError)
    store.close()
  })
})

describe('IssuesRepository: purgeIssueUserState (no test executes this today)', () => {
  it('drops the rows of every user for one issue and leaves other issues alone', async () => {
    const store = await openTestStore(':memory:')
    const other = asUserId('usr_other')
    await store.issues.setIssueUserState(FIRST_ADMIN_USER_ID, asIssueId('iss_1'), { readAt: 't' })
    await store.issues.setIssueUserState(other, asIssueId('iss_1'), { pinnedAt: 't' })
    await store.issues.setIssueUserState(FIRST_ADMIN_USER_ID, asIssueId('iss_2'), { readAt: 't' })

    await store.issues.purgeIssueUserState(asIssueId('iss_1'))

    // The rows follow the USER, so the purge is keyed on the issue alone: both
    // people lose their markers for iss_1 and neither loses iss_2.
    expect(
      await store.issues.getIssueUserState(FIRST_ADMIN_USER_ID, asIssueId('iss_1')),
    ).toBeUndefined()
    expect(await store.issues.getIssueUserState(other, asIssueId('iss_1'))).toBeUndefined()
    expect(await store.issues.getIssueUserState(FIRST_ADMIN_USER_ID, asIssueId('iss_2'))).toEqual({
      readAt: 't',
      tuckedAt: null,
      pinnedAt: null,
    })
    store.close()
  })

  it('is a no-op for an issue nobody has touched', async () => {
    const store = await openTestStore(':memory:')
    await store.issues.setIssueUserState(FIRST_ADMIN_USER_ID, asIssueId('iss_1'), { readAt: 't' })
    await store.issues.purgeIssueUserState(asIssueId('iss_untouched'))
    expect((await store.issues.listIssueUserState(FIRST_ADMIN_USER_ID)).size).toBe(1)
    store.close()
  })
})

describe('IssuesRepository: the projections (executed, never named)', () => {
  it('listIssueCwdRows returns the four columns, ordered by repo path then seq', async () => {
    const store = await openTestStore(':memory:')
    await seed(store, { id: asIssueId('iss_b2'), repoPath: '/b', seq: 2, worktreePath: '/wt/b2' })
    await seed(store, { id: asIssueId('iss_a1'), repoPath: '/a', seq: 1 })
    await seed(store, { id: asIssueId('iss_b1'), repoPath: '/b', seq: 1, archived: true })

    const rows = await store.issues.listIssueCwdRows()

    expect(rows).toEqual([
      { id: 'iss_a1', repoPath: '/a', worktreePath: null, deletedAt: null, archived: false },
      { id: 'iss_b1', repoPath: '/b', worktreePath: null, deletedAt: null, archived: true },
      { id: 'iss_b2', repoPath: '/b', worktreePath: '/wt/b2', deletedAt: null, archived: false },
    ])
    store.close()
  })

  it('listIssueCwdRows keeps soft-deleted rows, carrying their deletedAt', async () => {
    const store = await openTestStore(':memory:')
    // A tombstoned issue still owns its worktree path, so the cwd index must
    // see it and decide for itself — filtering here would let a second issue
    // claim a directory the first has not released.
    await seed(store, {
      id: asIssueId('iss_1'),
      worktreePath: '/wt/1',
      deletedAt: '2026-01-01T00:00:00Z',
    })
    expect(await store.issues.listIssueCwdRows()).toEqual([
      {
        id: 'iss_1',
        repoPath: '/r',
        worktreePath: '/wt/1',
        deletedAt: '2026-01-01T00:00:00Z',
        archived: false,
      },
    ])
    store.close()
  })

  it('listIssueParentEdges excludes tombstones, on either end of the edge', async () => {
    const store = await openTestStore(':memory:')
    await seed(store, { id: asIssueId('iss_parent'), seq: 1 })
    await seed(store, { id: asIssueId('iss_child'), seq: 2, parentId: asIssueId('iss_parent') })
    await seed(store, {
      id: asIssueId('iss_gone'),
      seq: 3,
      parentId: asIssueId('iss_parent'),
      deletedAt: '2026-01-01T00:00:00Z',
    })

    const edges = await store.issues.listIssueParentEdges()

    // A deleted child's spend must not roll up into a parent the operator can
    // see nowhere else in the app (POD-1858).
    expect(edges).toEqual([
      { id: 'iss_parent', parentId: null },
      { id: 'iss_child', parentId: 'iss_parent' },
    ])
    store.close()
  })

  it('issuesMissingRepoId counts zero on rows a live writer produced', async () => {
    const store = await openTestStore(':memory:')
    await seed(store, { id: asIssueId('iss_1') })
    // `upsertIssue` resolves a repo_id before it inserts, so any non-zero
    // answer means a database from before POD-1360 rather than a live defect.
    expect(await store.issues.issuesMissingRepoId()).toBe(0)
    store.close()
  })
})

describe('IssuesRepository: assignRepoIdToIssuesUnder (executed, never named)', () => {
  it('stamps the repo id on every issue at or under the path', async () => {
    const store = await openTestStore(':memory:')
    await store.repos.addRepo('/root', asMachineId('m1'))
    const repoId = await store.repos.resolveRepoIdForPath('/root')
    await seed(store, { id: asIssueId('iss_at'), repoPath: '/root', seq: 1, repoId: null })
    await seed(store, { id: asIssueId('iss_under'), repoPath: '/root/sub', seq: 2, repoId: null })
    await seed(store, { id: asIssueId('iss_sibling'), repoPath: '/rootless', seq: 3, repoId: null })

    await store.issues.assignRepoIdToIssuesUnder(repoId, '/root')

    expect((await store.issues.getIssue('iss_at'))?.repoId).toBe(repoId)
    expect((await store.issues.getIssue('iss_under'))?.repoId).toBe(repoId)
    // `/rootless` merely shares a prefix as TEXT; the match is on a path
    // boundary, so it must not be swept in.
    expect((await store.issues.getIssue('iss_sibling'))?.repoId).not.toBe(repoId)
    store.close()
  })

  it('renumbers a colliding seq, oldest row keeping its number', async () => {
    const store = await openTestStore(':memory:')
    // Two SEPARATE path-keyed buckets, each holding its own seq 1 — the state a
    // repo-identity upgrade merges into one logical repo.
    await store.repos.addRepo('/root', asMachineId('m1'))
    await store.repos.addRepo('/root/clone', asMachineId('m1'))
    const repoId = await store.repos.resolveRepoIdForPath('/root')
    const cloneId = await store.repos.resolveRepoIdForPath('/root/clone')
    expect(cloneId).not.toBe(repoId)
    await seed(store, {
      id: asIssueId('iss_old'),
      repoPath: '/root',
      seq: 1,
      repoId,
      createdAt: '2026-01-01T00:00:00Z',
    })
    await seed(store, {
      id: asIssueId('iss_new'),
      repoPath: '/root/clone',
      seq: 1,
      repoId: cloneId,
      createdAt: '2026-01-02T00:00:00Z',
    })

    await store.issues.assignRepoIdToIssuesUnder(repoId, '/root')

    // UNIQUE(repo_id, seq) makes this a correctness requirement, not a
    // preference: the incumbent keeps 1 and the newcomer takes the next free.
    expect((await store.issues.getIssue('iss_old'))?.seq).toBe(1)
    expect((await store.issues.getIssue('iss_new'))?.seq).toBe(2)
    expect((await store.issues.getIssue('iss_new'))?.repoId).toBe(repoId)
    store.close()
  })

  it('renumbers in creation order, so the oldest merged row takes the lower seq', async () => {
    const store = await openTestStore(':memory:')
    // THREE buckets, not two: the ordering only decides anything when more than
    // one row is being restamped, and a two-row fixture passes whichever way the
    // rows are walked (the incumbent keeps its number by the holder check, not
    // by the ORDER BY).
    await store.repos.addRepo('/root', asMachineId('m1'))
    await store.repos.addRepo('/root/older', asMachineId('m1'))
    await store.repos.addRepo('/root/newer', asMachineId('m1'))
    const repoId = await store.repos.resolveRepoIdForPath('/root')
    await seed(store, {
      id: asIssueId('iss_incumbent'),
      repoPath: '/root',
      seq: 1,
      repoId,
      createdAt: '2026-01-01T00:00:00Z',
    })
    await seed(store, {
      id: asIssueId('iss_older'),
      repoPath: '/root/older',
      seq: 1,
      repoId: await store.repos.resolveRepoIdForPath('/root/older'),
      createdAt: '2026-01-02T00:00:00Z',
    })
    await seed(store, {
      id: asIssueId('iss_newer'),
      repoPath: '/root/newer',
      seq: 1,
      repoId: await store.repos.resolveRepoIdForPath('/root/newer'),
      createdAt: '2026-01-03T00:00:00Z',
    })

    await store.issues.assignRepoIdToIssuesUnder(repoId, '/root')

    expect((await store.issues.getIssue('iss_incumbent'))?.seq).toBe(1)
    expect((await store.issues.getIssue('iss_older'))?.seq).toBe(2)
    expect((await store.issues.getIssue('iss_newer'))?.seq).toBe(3)
    store.close()
  })

  it('is a no-op when every issue already carries the id', async () => {
    const store = await openTestStore(':memory:')
    await store.repos.addRepo('/root', asMachineId('m1'))
    const repoId = await store.repos.resolveRepoIdForPath('/root')
    await seed(store, { id: asIssueId('iss_1'), repoPath: '/root', seq: 7, repoId })

    await store.issues.assignRepoIdToIssuesUnder(repoId, '/root')

    // The selection excludes rows already on the target id, so a re-run cannot
    // renumber a row against itself.
    expect((await store.issues.getIssue('iss_1'))?.seq).toBe(7)
    store.close()
  })
})

describe('IssuesRepository: the batched child reads (executed, never named)', () => {
  it('listIssueLabelsByIssue groups by issue, labels sorted within each', async () => {
    const store = await openTestStore(':memory:')
    await seedIssues(store, ['iss_1', 'iss_2'])
    await store.issues.setIssueLabels(asIssueId('iss_2'), ['zeta', 'alpha'])
    await store.issues.setIssueLabels(asIssueId('iss_1'), ['beta'])

    const byIssue = await store.issues.listIssueLabelsByIssue()

    expect([...byIssue.entries()]).toEqual([
      ['iss_1', ['beta']],
      ['iss_2', ['alpha', 'zeta']],
    ])
    store.close()
  })

  it('listIssueLabelsByIssue omits issues with no labels rather than mapping them to []', async () => {
    const store = await openTestStore(':memory:')
    await seedIssues(store, ['iss_1'])
    await store.issues.setIssueLabels(asIssueId('iss_1'), ['a'])
    await store.issues.setIssueLabels(asIssueId('iss_1'), [])
    expect(await store.issues.listIssueLabelsByIssue()).toEqual(new Map())
    store.close()
  })

  it('listAllIssueDeps returns every edge in a stable order', async () => {
    const store = await openTestStore(':memory:')
    await seedIssues(store, ['iss_a', 'iss_b', 'iss_c'])
    await store.issues.addIssueDep(asIssueId('iss_b'), asIssueId('iss_a'), 'blocks')
    await store.issues.addIssueDep(asIssueId('iss_a'), asIssueId('iss_c'), 'relates')
    await store.issues.addIssueDep(asIssueId('iss_a'), asIssueId('iss_c'), 'blocks')

    // The ledger's full-truth reconcile diffs by id, but the order is what keeps
    // its change log readable and this expectation deterministic (POD-822).
    expect(await store.issues.listAllIssueDeps()).toEqual([
      { fromId: 'iss_a', toId: 'iss_c', type: 'blocks' },
      { fromId: 'iss_a', toId: 'iss_c', type: 'relates' },
      { fromId: 'iss_b', toId: 'iss_a', type: 'blocks' },
    ])
    store.close()
  })

  it('countIssueComments and countIssueCommentsByIssue agree, and absence reads as zero', async () => {
    const store = await openTestStore(':memory:')
    await seedIssues(store, ['iss_1', 'iss_2'])
    for (const [i, issueId] of ['iss_1', 'iss_1', 'iss_2'].entries()) {
      await store.issues.addIssueComment({
        id: `cmt_${i}`,
        issueId: asIssueId(issueId),
        author: 'a',
        body: 'b',
        createdAt: 't',
        actor: null,
        onBehalfOf: null,
      })
    }

    const counts = await store.issues.countIssueCommentsByIssue()

    expect(counts.get('iss_1')).toBe(await store.issues.countIssueComments(asIssueId('iss_1')))
    expect(counts.get('iss_1')).toBe(2)
    // An issue with no comments is ABSENT from the map, and read as 0 by the
    // caller — the grouped read never emits a zero row.
    expect(counts.has('iss_none')).toBe(false)
    expect(await store.issues.countIssueComments(asIssueId('iss_none'))).toBe(0)
    store.close()
  })

  it('deleteIssueMessagesForIssue removes the mail of that issue only', async () => {
    const store = await openTestStore(':memory:')
    await seedIssues(store, ['iss_1', 'iss_2'])
    for (const [i, issueId] of ['iss_1', 'iss_2'].entries()) {
      await store.issues.addIssueMessage({
        id: `msg_${i}`,
        issueId: asIssueId(issueId),
        fromAuthor: 'a',
        body: 'b',
        createdAt: 't',
        status: 'unread',
        claimedBy: null,
        claimedAt: null,
      })
    }

    await store.issues.deleteIssueMessagesForIssue(asIssueId('iss_1'))

    expect(await store.issues.getIssueMessage('msg_0')).toBeNull()
    expect(await store.issues.getIssueMessage('msg_1')).not.toBeNull()
    store.close()
  })
})

describe('IssuesRepository: searchIssueComments (executed, never named)', () => {
  async function withComments(store: SessionStore, bodies: readonly string[]): Promise<void> {
    await seedIssues(store, ['iss_1'])
    for (const [i, body] of bodies.entries()) {
      await store.issues.addIssueComment({
        id: `cmt_${i}`,
        issueId: asIssueId('iss_1'),
        author: 'a',
        body,
        createdAt: `t${i}`,
        actor: null,
        onBehalfOf: null,
      })
    }
  }

  it('matches a substring anywhere in the body, newest first', async () => {
    const store = await openTestStore(':memory:')
    await withComments(store, ['nothing here', 'a needle inside', 'needle at the start'])

    const hits = await store.issues.searchIssueComments('needle')

    expect(hits.map((h) => h.body)).toEqual(['needle at the start', 'a needle inside'])
    store.close()
  })

  it('treats % and _ in the query as LITERAL characters', async () => {
    const store = await openTestStore(':memory:')
    // Unescaped, "100%" would match every comment and "a_c" would match "abc".
    // The escape is the whole reason the query is not passed straight to LIKE.
    await withComments(store, ['done 100% of it', 'plain text', 'abc', 'a_c'])

    expect((await store.issues.searchIssueComments('100%')).map((h) => h.body)).toEqual([
      'done 100% of it',
    ])
    expect((await store.issues.searchIssueComments('a_c')).map((h) => h.body)).toEqual(['a_c'])
    store.close()
  })

  it('returns nothing for a blank query without touching the database', async () => {
    const store = await openTestStore(':memory:')
    await withComments(store, ['anything'])
    expect(await store.issues.searchIssueComments('   ')).toEqual([])
    store.close()
  })

  it('clamps the limit into 1..200, and a null limit means unbounded', async () => {
    const store = await openTestStore(':memory:')
    await withComments(store, ['needle a', 'needle b', 'needle c'])

    expect(await store.issues.searchIssueComments('needle', 2)).toHaveLength(2)
    // Zero and negative clamp UP to one rather than returning nothing, which is
    // what a caller passing a computed remaining-budget of 0 gets today.
    expect(await store.issues.searchIssueComments('needle', 0)).toHaveLength(1)
    expect(await store.issues.searchIssueComments('needle', -5)).toHaveLength(1)
    expect(await store.issues.searchIssueComments('needle', null)).toHaveLength(3)
    store.close()
  })
})
