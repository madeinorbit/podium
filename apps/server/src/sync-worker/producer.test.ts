import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asIssueId, asMachineId, asUserId } from '@podium/model'
import { SYNC_LINE_MAX_BYTES, SyncComplete, SyncMeta } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import {
  Authority,
  DEVICE_GRADE_PRINCIPAL,
  GrantEdgeVisibilityPolicy,
  NoDelegationsGranted,
} from '@podium/sync'
import { fixtureWriteScope } from '@podium/sync/testing'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { makeFeedVisibility } from '../feed-visibility'
import type { SessionStore } from '../store'
import { openTestStore, testStoreLocation } from '../test-support/open-test-store'
import { testStoreEngine } from '../test-support/pg-test-database'
import { testStoreRecords } from '../test-support/record-writer'
import { storeSql } from '../test-support/store-sql'
import { produceBootstrap } from './producer'
import { type BootstrapJob, SyncWorkerError } from './types'

const T0 = '2026-09-01T00:00:00.000Z'
const principal = (user: string) => ({ ...DEVICE_GRADE_PRINCIPAL, user: asUserId(user) })
const job = (user: string): BootstrapJob => ({
  transferId: user,
  principal: principal(user),
  feedId: 'feed',
  epoch: 'epoch',
  encoding: 'identity',
  deadlineMs: Date.now() + 60_000,
})
const issue = (id: string) => ({
  id: asIssueId(id),
  repoPath: '/r',
  seq: 1,
  title: 'Issue',
  description: '',
  ownerUserId: asUserId('owner'),
  visibility: 'personal' as const,
  createdByActor: 'owner',
  createdByOnBehalfOf: asUserId('owner'),
  stage: 'backlog',
  worktreePath: null,
  branch: null,
  parentBranch: 'main',
  defaultAgent: 'claude-code',
  defaultModel: 'auto',
  defaultEffort: 'auto',
  machineId: asMachineId('machine'),
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
  acceptance: null,
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
  createdAt: T0,
  updatedAt: T0,
  archived: false,
})
async function records(source: AsyncIterable<Uint8Array>) {
  let text = ''
  for await (const chunk of source) text += new TextDecoder().decode(chunk)
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

/**
 * Read sessions holding a snapshot of the store at `path` open now, the store's own
 * connections aside: on SQLite a reader keeps a full checkpoint from finishing; on
 * Postgres it is a session of the database in a transaction.
 */
function snapshotProbe(store: SessionStore, path: string) {
  if (testStoreEngine() === 'pg') {
    return {
      open: async () =>
        (
          await storeSql(store).get<{ open: number }>(
            sql.raw(
              'SELECT count(*)::int AS open FROM pg_stat_activity ' +
                'WHERE datname = current_database() AND pid <> pg_backend_pid() ' +
                'AND xact_start IS NOT NULL',
            ),
          )
        )?.open,
      close: () => {},
    }
  }
  const writer = openDatabase(path)
  return {
    open: async () =>
      (writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }).busy,
    close: () => writer.close(),
  }
}
describe('snapshot bootstrap producer', () => {
  it('matches Authority for owner, granted user and stranger without any anchor inputs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-visibility-'))
    const path = join(dir, 'test.db')
    const store = await openTestStore(path)
    const location = await testStoreLocation(path)
    try {
      await store.issues.upsertIssue(fixtureWriteScope(), issue('shared'))
      await store.issues.upsertIssue(fixtureWriteScope(), {
        ...issue('private'),
        seq: 2,
        description: 'Issue body',
        brief: 'Issue brief',
      })
      await store.grants.upsert({
        resourceKind: 'issue',
        resourceId: 'shared',
        grantee: 'reader',
        verb: 'read',
        owner: 'owner',
        visibility: 'personal',
        createdAt: T0,
        actorKind: 'user',
        actorId: 'owner',
        onBehalfOf: 'owner',
      })
      // The world is the model tables (POD-6770): the two issue rows above.
      // One appended change gives the feed a head for the load to be stamped
      // with; its payload is never read.
      await store.sync.appendChanges(
        [{ entity: 'issueProjection', entityId: 'shared', op: 'upsert', payload: '{}' }],
        1,
      )
      const forbidden = (): never => {
        throw new Error('bootstrap invoked anchor input')
      }
      const built = testStoreRecords(store)
      const feed = makeFeedVisibility({
        store,
        audiencesFor: forbidden,
        authorizationRevision: forbidden,
        currentRecords: built.build,
      })
      const authority = new Authority({
        store: store.sync,
        now: () => 1,
        transact: (fn) => store.transact(fn),
        // The same builders the worker streams, on the main thread.
        records: built,
        visibility: new GrantEdgeVisibilityPolicy(feed.state, new NoDelegationsGranted()),
        anchors: feed.anchors,
      })
      for (const user of ['owner', 'reader', 'stranger']) {
        const expected = await authority.bootstrap(principal(user))
        let meta: unknown
        const output = await records(
          produceBootstrap(location, job(user), new AbortController().signal, (value) => {
            meta = value
          }),
        )
        const rows = output.filter((r) => r.type === 'feedBootstrap').flatMap((r) => r.changes)
        const stubs = output.filter((r) => r.type === 'feedStubs').flatMap((r) => r.changes)
        // The first download is the policy's collections (POD-7085): the same
        // issue records as the Authority's, and no body: the brief and the
        // description load when the issue is opened.
        const issues = (list: readonly { entity: string; entityId: string; value: unknown }[]) =>
          list
            .filter((r) => r.entity === 'issueProjection')
            .map((r) => ({ entityId: r.entityId, value: r.value }))
            .sort((x, y) => (x.entityId < y.entityId ? -1 : x.entityId > y.entityId ? 1 : 0))
        expect(issues(rows)).toEqual(issues(expected.changes as never))
        expect(rows.some((r) => r.entity === 'issueBrief' || r.entity === 'issueDescription')).toBe(
          false,
        )
        // Every issue this viewer may see arrives, whole or as its stub
        // (an issue the download already sent whole needs no stub).
        expect(
          [
            ...new Set([...issues(rows).map((r) => r.entityId), ...stubs.map((r) => r.entityId)]),
          ].sort(),
        ).toEqual(issues(expected.changes as never).map((r) => r.entityId))
        expect([...rows, ...stubs].every((r) => r.seq === output[0].seq)).toBe(true)
        expect(SyncMeta.safeParse(output[0]).success).toBe(true)
        expect(SyncComplete.safeParse(output.at(-1)).success).toBe(true)
        // Every line between the header and the completion, and every row of them.
        expect(output.at(-1).records).toBe(output.length - 2)
        expect(output.at(-1).rows).toBe(rows.length + stubs.length)
        expect(output[0]).toEqual(meta)
        // One pass: the count is known only at the end, on the last chunk.
        expect(output[0].totalRows).toBeUndefined()
        const last = output.filter((r) => r.type === 'feedBootstrap').at(-1)
        expect(last.last).toBe(true)
        expect(last.totalRows).toBe(rows.length + stubs.length)
        expect(output.at(-1).seq).toBe(output[0].seq)
      }
    } finally {
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('releases the read transaction after abort and emits a terminal oversized-row error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-abort-'))
    const path = join(dir, 'test.db')
    const store = await openTestStore(path)
    const location = await testStoreLocation(path)
    const snapshots = snapshotProbe(store, path)
    try {
      // A real record too large for one line, in the part the first download
      // carries (an open issue's main part; its body would load later).
      await store.issues.upsertIssue(fixtureWriteScope(), {
        ...issue('huge'),
        acceptance: 'x'.repeat(SYNC_LINE_MAX_BYTES + 1),
      })
      await store.sync.appendChanges(
        [{ entity: 'issueProjection', entityId: 'huge', op: 'upsert', payload: '{}' }],
        1,
      )
      const abort = new AbortController()
      const producer = produceBootstrap(location, job('owner'), abort.signal, () => {})
      expect((await producer.next()).done).toBe(false)
      abort.abort(new SyncWorkerError('cancelled'))
      await expect(producer.next()).rejects.toMatchObject({ reason: 'cancelled' })
      expect(await snapshots.open()).toBe(0)
      const oversized = produceBootstrap(
        location,
        job('owner'),
        new AbortController().signal,
        () => {},
      )
      // The policy's earlier steps answer first; the oversized issue's line is refused.
      let error: unknown
      for (let line = 0; line < 100 && error === undefined; line += 1) {
        const next = await oversized.next()
        if (next.done) break
        const record = JSON.parse(new TextDecoder().decode(next.value))
        if (record.type === 'syncError') error = record
      }
      expect(error).toMatchObject({ type: 'syncError', reason: 'row-too-large' })
      await expect(oversized.next()).rejects.toMatchObject({ reason: 'row-too-large' })
      expect(await snapshots.open()).toBe(0)
    } finally {
      snapshots.close()
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
