import { asIssueId, asRepoId, asSessionId, firstAdminMemberId } from '@podium/model'
import { Ledger } from '@podium/sync'
import { fixtureWriteScope, testLedgerWriter } from '@podium/sync/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from '../modules/sessions/session'
import { RUNTIME_EVENT_LOG_KIND } from '../store/events'
import { installChangeLogHooks } from '../test-support/change-log-hooks'
import { issueRowFixture } from '../test-support/issue-row'
import { openTestStore } from '../test-support/open-test-store'
import { logStoreRecords } from '../test-support/record-writer'
import { seedRows } from '../test-support/seed-rows'
import { installSessionSourceWrites } from './session-source-writes'

const stores: Awaited<ReturnType<typeof openTestStore>>[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
})

async function fixture() {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const ledger = new Ledger({
    repo: store.sync,
    records: await logStoreRecords(store),
    now: () => Date.parse('2026-11-11T00:00:00Z'),
    transact: (fn) => store.transact(fn),
  })
  const writer = testLedgerWriter(ledger)
  installSessionSourceWrites(store, writer)
  installChangeLogHooks(store, writer)
  const session = new Session({
    sessionId: asSessionId('source-session'),
    ownerUserId: await firstAdminMemberId(store),
    machineId: store.hostMachineId,
    durableLabel: 'source-session',
    agentKind: 'claude-code',
    cwd: '/repo/work',
    title: 'Source session',
    origin: { kind: 'spawn' },
    createdAt: '2026-11-10T00:00:00Z',
    geometry: { cols: 80, rows: 24 },
    toDaemon: () => {},
  })
  const save = async () =>
    await writer.commit({
      write: async (scope) => await store.sessions.upsertSession(scope, session.toRow()),
    })
  await save()
  const changes = async (cursor: number) =>
    ((await ledger.changesSince(cursor)) ?? []).filter((change) => change.entity === 'session')
  return { store, ledger, writer, session, save, changes }
}

describe('session source writes compare before they write', () => {
  it('logs queue membership immediately, dedups an unchanged queue and rolls back a failed append', async () => {
    const f = await fixture()
    const queued = { id: 'queued', sessionId: f.session.sessionId, text: 'hello', queuedAt: 1 }
    const cursor = await f.ledger.cursor()
    await f.store.sync.enqueueMessage(queued)
    expect(await f.changes(cursor)).toHaveLength(1)
    const afterEnqueue = await f.ledger.cursor()
    await f.store.sync.enqueueMessage(queued)
    expect(await f.changes(afterEnqueue)).toEqual([])
    vi.spyOn(f.store.sync, 'appendChanges').mockRejectedValueOnce(new Error('append refused'))
    await expect(f.store.sync.deleteQueuedMessage(queued.id)).rejects.toThrow('append refused')
    expect(await f.store.sync.listQueuedMessages(f.session.sessionId)).toHaveLength(1)
    await f.store.sync.deleteUnreservedQueuedMessage(queued.id)
    expect(await f.changes(afterEnqueue)).toHaveLength(1)
  })

  it('logs a conversation mapping for a parked session, including a batched discovery', async () => {
    const f = await fixture()
    f.session.resume = { kind: 'claude-session', value: 'native-session' }
    await f.save()
    const cursor = await f.ledger.cursor()
    await f.store.conversations.registry.ensureMany(f.store.hostMachineId, [
      { nativeId: 'native-session', providerId: 'claude-code' },
    ])
    expect(await f.changes(cursor)).toHaveLength(1)
    const after = await f.ledger.cursor()
    await f.store.conversations.registry.ensure({
      machineId: f.store.hostMachineId,
      nativeId: 'native-session',
      providerId: 'claude-code',
    })
    expect(await f.changes(after)).toEqual([])
  })

  it('logs the repository identity a permanent draft ref derives from the registry', async () => {
    const f = await fixture()
    f.session.refDraft = 1
    await f.save()
    const cursor = await f.ledger.cursor()
    await f.store.repos.addRepo(
      '/repo',
      f.store.hostMachineId,
      'https://example.com/team/repo.git',
      'TEST',
    )
    expect(await f.changes(cursor)).toHaveLength(1)
    const after = await f.ledger.cursor()
    await f.store.repos.removeRepo('/repo', f.store.hostMachineId)
    expect(await f.changes(after)).toHaveLength(1)
  })

  it('logs a birth issue number changed by the source issue write', async () => {
    const f = await fixture()
    const issue = issueRowFixture({
      seq: 1,
      repoPath: '/repo',
      parentId: null,
      ownerUserId: f.session.ownerUserId,
    })
    await seedRows(f.store, () => f.store.issues.upsertIssue(fixtureWriteScope(), issue))
    f.session.refIssueId = issue.id
    f.session.refLetter = 'A'
    await f.save()
    const repoId = asRepoId('repo-upgraded')
    await seedRows(f.store, () =>
      f.store.issues.upsertIssue(
        fixtureWriteScope(),
        issueRowFixture({
          id: asIssueId('target-issue'),
          repoPath: '/other',
          repoId,
          seq: 1,
          parentId: null,
          ownerUserId: f.session.ownerUserId,
        }),
      ),
    )
    const cursor = await f.ledger.cursor()
    await f.store.issues.assignRepoIdToIssuesUnder(repoId, '/repo')
    expect(await f.changes(cursor)).toHaveLength(1)
    expect(await f.ledger.authority.snapshot('session')).toContainEqual(
      expect.objectContaining({ sessionId: f.session.sessionId, refSeq: 2, refRepoId: repoId }),
    )
  })

  it('logs the loss of transcript evidence in the retention write', async () => {
    const f = await fixture()
    const eventId = await f.store.events.appendEvent({
      ts: '2026-01-01T00:00:00Z',
      kind: RUNTIME_EVENT_LOG_KIND,
      subject: f.session.sessionId,
      payload: { t: 'item', item: { kind: 'complete' } },
    })
    await f.store.events.saveRuntimeEventProjectionCursor(
      'runtime.board.v1',
      eventId,
      '2026-11-11T00:00:00Z',
    )
    const cursor = await f.ledger.cursor()
    await f.store.events.pruneEventBatch({ cutoff: '2026-02-01T00:00:00Z', capThroughId: 0 })
    expect(await f.changes(cursor)).toHaveLength(1)
  })
})
