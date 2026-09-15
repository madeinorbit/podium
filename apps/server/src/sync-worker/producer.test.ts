import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { SyncMeta, SyncComplete, SYNC_LINE_MAX_BYTES } from '@podium/protocol'
import { asIssueId, asMachineId, asUserId } from '@podium/model'
import { DEVICE_GRADE_PRINCIPAL, Authority, GrantEdgeVisibilityPolicy, NoDelegationsGranted } from '@podium/sync'
import { openDatabase } from '@podium/runtime/sqlite'
import { makeFeedVisibility } from '../feed-visibility'
import { WorldIndex } from '../modules/world-index'
import { openTestStore } from '../test-support/open-test-store'
import { produceBootstrap } from './producer'
import { SyncWorkerError, type BootstrapJob } from './types'

const principal = (user: string) => ({ ...DEVICE_GRADE_PRINCIPAL, user: asUserId(user) })
const job = (user: string): BootstrapJob => ({ transferId: user, principal: principal(user), feedId: 'feed', epoch: 'epoch', encoding: 'identity', deadlineMs: Date.now() + 60_000 })
const issue = (id: string) => ({
  id: asIssueId(id), repoPath: '/r', seq: 1, title: 'Issue', description: '',
  ownerUserId: asUserId('owner'), visibility: 'personal' as const, createdByActor: 'owner', createdByOnBehalfOf: asUserId('owner'),
  stage: 'backlog', worktreePath: null, branch: null, parentBranch: 'main', defaultAgent: 'claude-code', defaultModel: 'auto', defaultEffort: 'auto', machineId: asMachineId('machine'),
  linearId: null, linearIdentifier: null, linearUrl: null, activityNotes: null, notesUpdatedAt: null, suggestedStage: null, suggestedReason: null, blockedBy: [] as string[], dependencyNote: null,
  prUrl: null, priority: 2, type: 'task', assignee: null, parentId: null, design: null, acceptance: null, notes: null, dueAt: null, deferUntil: null, closedReason: null, closedAt: null,
  supersededBy: null, duplicateOf: null, pinned: false, estimateMin: null, needsHuman: false, humanQuestion: null, createdAt: 't0', updatedAt: 't0', archived: false,
})
async function records(source: AsyncIterable<Uint8Array>) {
  let text = ''
  for await (const chunk of source) text += new TextDecoder().decode(chunk)
  return text.trim().split('\n').map(line => JSON.parse(line))
}
describe('snapshot bootstrap producer', () => {
  it('matches Authority for owner, granted user and stranger without any anchor inputs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-visibility-'))
    const path = join(dir, 'test.db')
    const store = await openTestStore(path)
    try {
      await store.issues.upsertIssue(issue('shared'))
      await store.issues.upsertIssue({ ...issue('private'), seq: 2 })
      await store.grants.upsert({ resourceKind: 'issue', resourceId: 'shared', grantee: 'reader', verb: 'read', owner: 'owner', visibility: 'personal', createdAt: 't0', actorKind: 'user', actorId: 'owner', onBehalfOf: 'owner' })
      await store.sync.appendChanges([
        { entity: 'issue', entityId: 'shared', op: 'upsert', payload: JSON.stringify({ id: 'shared' }) },
        { entity: 'issueProjection', entityId: 'shared', op: 'upsert', payload: '{}' },
        { entity: 'issue', entityId: 'private', op: 'upsert', payload: JSON.stringify({ id: 'private' }) },
        { entity: 'repo', entityId: '/r', op: 'upsert', payload: '{}' },
      ], 1)
      const forbidden = (): never => { throw new Error('bootstrap invoked anchor input') }
      const world = await WorldIndex.load(store)
      const feed = makeFeedVisibility({ store, worldIndex: world.reader, audienceResourceIds: forbidden, audienceFor: forbidden, issueEventSubjects: forbidden, authorizationRevision: forbidden })
      const authority = new Authority({ store: store.sync, now: () => 1, transact: fn => store.transact(fn), visibility: new GrantEdgeVisibilityPolicy(feed.state, new NoDelegationsGranted()), anchors: feed.anchors })
      for (const user of ['owner', 'reader', 'stranger']) {
        const expected = await authority.bootstrap(principal(user))
        let meta: unknown
        const output = await records(produceBootstrap(path, job(user), new AbortController().signal, value => { meta = value }))
        const rows = output.filter(r => r.type === 'feedBootstrap').flatMap(r => r.changes)
        expect(rows).toEqual(expected.changes)
        expect(SyncMeta.safeParse(output[0]).success).toBe(true)
        expect(SyncComplete.safeParse(output.at(-1)).success).toBe(true)
        expect(output.at(-1).records).toBe(output.filter(r => r.type === 'feedBootstrap').length)
        expect(output.at(-1).rows).toBe(rows.length)
        expect(output[0]).toEqual(meta)
        expect(output[0].totalRows).toBe(rows.length)
        expect(output.at(-1).seq).toBe(output[0].seq)
      }
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('releases the read transaction after abort and emits a terminal oversized-row error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-abort-'))
    const path = join(dir, 'test.db')
    const store = await openTestStore(path)
    const writer = openDatabase(path)
    try {
      await store.sync.appendChanges([{ entity: 'repo', entityId: '/r', op: 'upsert', payload: JSON.stringify({ text: 'x'.repeat(SYNC_LINE_MAX_BYTES + 1) }) }], 1)
      const abort = new AbortController()
      const producer = produceBootstrap(path, job('owner'), abort.signal, () => {})
      expect((await producer.next()).done).toBe(false)
      abort.abort(new SyncWorkerError('cancelled'))
      await expect(producer.next()).rejects.toMatchObject({ reason: 'cancelled' })
      expect((writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {busy:number}).busy).toBe(0)
      const oversized = produceBootstrap(path, job('owner'), new AbortController().signal, () => {})
      await oversized.next()
      const error = await oversized.next()
      expect(JSON.parse(new TextDecoder().decode(error.value!))).toMatchObject({ type: 'syncError', reason: 'row-too-large' })
      await expect(oversized.next()).rejects.toMatchObject({ reason: 'row-too-large' })
      expect((writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {busy:number}).busy).toBe(0)
    } finally { writer.close(); await store.close(); rmSync(dir, { recursive: true, force: true }) }
  })
})
