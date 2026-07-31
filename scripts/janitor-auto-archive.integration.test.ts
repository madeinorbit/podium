/**
 * WHOSE "read" auto-archive means, pinned against the REAL storage [POD-1210].
 *
 * `issues.read_at` and `sessions.read_at` were dropped by POD-1077's per-user
 * state migration and the janitor kept selecting them, so both auto-archive jobs
 * threw on every tick — on the live instance, not only in tests. The janitor's
 * own unit lane could not have caught it: it hand-rolls its tables, so it would
 * have kept a column the product no longer has.
 *
 * These tests therefore build the database the way the SERVER builds it (migrations
 * via `SessionStore`) and write read state through the SERVER's own writers
 * (`setIssueUserState`, `markSessionRead`). If read state is re-keyed a second
 * time, this file goes red rather than the live janitor going quiet.
 *
 * They also pin the JUDGEMENT, not just the absence of a crash: "read" is the
 * BROADCAST VIEWER's read, because `archived` is still a shared column and the
 * server's apply-side revalidation asks that same user. The `user:other` cases
 * are the ones that fail if anybody re-reads it as "read by ANY user" — which is
 * the cheaper query, and the reason it is written down here.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asIssueId, asSessionId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IssueAutoArchiveReader, SessionAutoArchiveReader } from '../apps/janitor/src/janitor'
import { type IssueRow, type SessionRow, SessionStore } from '../apps/server/src/store'

const OTHER_USER = 'user:other'
const READ_OLD = '2026-07-01T00:00:00.000Z'
const READ_RECENT = '2026-07-20T00:00:00.000Z'
const CUTOFF = '2026-07-11T00:00:00.000Z'
const STOPPED = '2026-06-30T00:00:00.000Z'

/** `(repo_id, seq)` is UNIQUE in the real schema, so seeds cannot share a seq. */
let nextSeq = 1

function issueRow(id: string, over: Partial<IssueRow> = {}): IssueRow {
  return {
    id: asIssueId(id),
    repoPath: '/repo',
    seq: nextSeq++,
    title: id,
    description: '',
    stage: 'done',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'shell',
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
    createdAt: STOPPED,
    updatedAt: STOPPED,
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

function seedSession(store: SessionStore, id: string, over: Partial<SessionRow> = {}): void {
  store.sessions.upsertSession({
    id: asSessionId(id),
    agentKind: 'shell',
    cwd: '/repo',
    title: id,
    name: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: null,
    resumeValue: null,
    status: 'exited',
    exitCode: 0,
    durableLabel: `podium-${id}`,
    createdAt: STOPPED,
    lastActiveAt: STOPPED,
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    archived: false,
    workState: null,
    machineId: '__local__',
    stoppedAt: STOPPED,
    issueId: null,
    ...over,
  })
}

describe('janitor auto-archive candidates over per-user read state [POD-1210]', () => {
  let dir: string
  let dbPath: string
  let store: SessionStore
  let db: SqlDatabase
  let priorStateDir: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-janitor-archive-'))
    dbPath = join(dir, 'podium.db')
    priorStateDir = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = dir
    store = new SessionStore(dbPath)
    db = openDatabase(dbPath, { readOnly: true })
  })

  afterEach(() => {
    db.close()
    store.close()
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('proposes an issue the broadcast viewer read before the cutoff', async () => {
    store.issues.upsertIssue(issueRow('iss_read'))
    store.issues.setIssueUserState(FIRST_ADMIN_USER_ID, 'iss_read', { readAt: READ_OLD })

    const candidates = await new IssueAutoArchiveReader(db).read({
      cutoffReadAt: CUTOFF,
      limit: 100,
    })

    // The instrument can say YES. Every "does not propose" assertion below is
    // only meaningful because this one fires on the same fixture shape.
    expect(candidates.map((c) => c.issueId)).toEqual(['iss_read'])
    // The observation must carry the value the server's apply-side revalidation
    // compares against (`issueOverlay(id).readAt !== observed.readAt` →
    // 'precondition'), or every proposal is silently rejected.
    expect(candidates[0]?.readAt).toBe(
      store.issues.getIssueUserState(FIRST_ADMIN_USER_ID, 'iss_read')?.readAt,
    )
  })

  it('does NOT propose an issue only a DIFFERENT user has read', async () => {
    store.issues.upsertIssue(issueRow('iss_theirs'))
    store.issues.setIssueUserState(OTHER_USER, 'iss_theirs', { readAt: READ_OLD })

    const candidates = await new IssueAutoArchiveReader(db).read({
      cutoffReadAt: CUTOFF,
      limit: 100,
    })

    // "read by ANY user" would archive this out from under the viewer who has
    // never seen it. `archived` is a shared column; one colleague's read is not
    // the instance's read.
    expect(candidates).toEqual([])
    // ...and the SAME fixture is a candidate when the reader IS that user, so
    // the empty result above is scoping, not an accidentally-empty query.
    const theirs = await new IssueAutoArchiveReader(db, OTHER_USER).read({
      cutoffReadAt: CUTOFF,
      limit: 100,
    })
    expect(theirs.map((c) => c.issueId)).toEqual(['iss_theirs'])
  })

  it('does NOT propose an unread issue or one read after the cutoff', async () => {
    store.issues.upsertIssue(issueRow('iss_unread'))
    store.issues.upsertIssue(issueRow('iss_recent'))
    store.issues.setIssueUserState(FIRST_ADMIN_USER_ID, 'iss_recent', { readAt: READ_RECENT })

    const candidates = await new IssueAutoArchiveReader(db).read({
      cutoffReadAt: CUTOFF,
      limit: 100,
    })

    expect(candidates).toEqual([])
  })

  it('does NOT propose an open, archived, deleted or child issue the viewer read', async () => {
    store.issues.upsertIssue(issueRow('iss_open', { stage: 'in_progress' }))
    store.issues.upsertIssue(issueRow('iss_archived', { archived: true }))
    store.issues.upsertIssue(issueRow('iss_deleted', { deletedAt: STOPPED }))
    store.issues.upsertIssue(issueRow('iss_parent'))
    store.issues.upsertIssue(issueRow('iss_child', { parentId: asIssueId('iss_parent') }))
    for (const id of ['iss_open', 'iss_archived', 'iss_deleted', 'iss_child']) {
      store.issues.setIssueUserState(FIRST_ADMIN_USER_ID, id, { readAt: READ_OLD })
    }

    const candidates = await new IssueAutoArchiveReader(db).read({
      cutoffReadAt: CUTOFF,
      limit: 100,
    })

    expect(candidates).toEqual([])
  })

  it('keyset-paginates past the 25-row page on a TIED read_at, each issue once', async () => {
    // One shared `read_at` for 60 issues: the timestamp alone is not a cursor, so
    // this is the fixture where a non-total order loops or drops rows. `id` is the
    // tiebreaker and the join pins one row per issue, which is what keeps it total.
    const ids: string[] = []
    for (let i = 0; i < 60; i++) {
      const id = `iss_p${String(i).padStart(3, '0')}`
      ids.push(id)
      store.issues.upsertIssue(issueRow(id, { seq: i }))
      store.issues.setIssueUserState(FIRST_ADMIN_USER_ID, id, { readAt: READ_OLD })
    }

    const candidates = await new IssueAutoArchiveReader(db).read({
      cutoffReadAt: CUTOFF,
      limit: 100,
    })

    expect(candidates).toHaveLength(60)
    expect(new Set(candidates.map((c) => c.issueId)).size).toBe(60)
    expect(candidates.map((c) => c.issueId)).toEqual(ids)
  })

  it('proposes a stopped session the broadcast viewer read, and not another user’s', async () => {
    seedSession(store, 'ses_mine')
    seedSession(store, 'ses_theirs')
    store.sessions.markSessionRead(FIRST_ADMIN_USER_ID, asSessionId('ses_mine'), READ_OLD)
    store.sessions.markSessionRead(OTHER_USER, asSessionId('ses_theirs'), READ_OLD)

    const candidates = await new SessionAutoArchiveReader(db).read({
      cutoffReadAt: CUTOFF,
      limit: 100,
    })

    expect(candidates.map((c) => c.sessionId)).toEqual(['ses_mine'])
    expect(candidates[0]?.readAt).toBe(
      store.sessions.getReadAt(FIRST_ADMIN_USER_ID, asSessionId('ses_mine')),
    )
  })

  it('does NOT propose a session the viewer has never opened', async () => {
    seedSession(store, 'ses_unread')

    const candidates = await new SessionAutoArchiveReader(db).read({
      cutoffReadAt: CUTOFF,
      limit: 100,
    })

    expect(candidates).toEqual([])
  })
})
