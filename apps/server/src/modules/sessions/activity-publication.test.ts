import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, firstAdminMemberId } from '@podium/model'
import type { SessionObservationCheckpointV1 } from '@podium/protocol'
import { CLIENT_WIRE_VERSION } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import { Ledger } from '@podium/sync'
import { fixtureWriteScope, testLedgerWriter } from '@podium/sync/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRIZZLE_MIGRATIONS } from '../../migrations/drizzle-manifest.generated'
import { SELF_HOSTED_WORKSPACE_ID } from '../../self-hosted-workspace'
import type { SessionStore } from '../../store'
import { serverRecordBuilders } from '../../sync/record-builders'
import { testClientPrincipal } from '../../test-support/client-principal'
import { openTestStore } from '../../test-support/open-test-store'
import { logStoreRecords } from '../../test-support/record-writer'
import { seedRows } from '../../test-support/seed-rows'
import { countStatements, expectConstantStatements } from '../../test-support/statement-count'
import { SessionActivityPublication } from './activity-publication'
import { disposeOracles, makeOracle } from './oracle-support'
import { SessionRecords } from './records'
import { Session } from './session'

const BASE = Date.parse('2026-11-11T00:00:00.000Z')
const iso = (ms: number) => new Date(BASE + ms).toISOString()
let now = BASE
const stores = new Set<SessionStore>()
const directories: string[] = []

beforeEach(() => {
  now = BASE
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})
afterEach(async () => {
  await disposeOracles()
  for (const store of stores) await store.close()
  stores.clear()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function publication(store: SessionStore) {
  const ledger = new Ledger({
    repo: store.sync,
    records: await logStoreRecords(store),
    now: () => now,
    transact: (fn) => store.transact(fn),
  })
  const writer = testLedgerWriter(ledger)
  const publisher = new SessionActivityPublication({ store, writer, now: () => now })
  return { ledger, writer, publisher }
}

async function fixture(count = 1, file = ':memory:') {
  const store = await openTestStore(file)
  stores.add(store)
  const ownerUserId = await firstAdminMemberId(store)
  const sessions = Array.from(
    { length: count },
    (_, index) =>
      new Session({
        sessionId: asSessionId(`activity-${index}`),
        ownerUserId,
        machineId: store.hostMachineId,
        durableLabel: `activity-${index}`,
        agentKind: 'codex',
        cwd: '/work',
        title: 'Activity',
        origin: { kind: 'spawn' },
        createdAt: iso(0),
        geometry: { cols: 80, rows: 24 },
        toDaemon: () => {},
      }),
  )
  const p = await publication(store)
  const save = async (session = sessions[0]!) =>
    await p.writer.commit({
      write: async (scope) => await store.sessions.upsertSession(scope, session.toRow()),
    })
  for (const session of sessions) await save(session)
  const session = sessions[0]!
  const changes = async (cursor: number) =>
    ((await p.ledger.changesSince(cursor)) ?? []).filter((change) => change.entity === 'session')
  const built = async () =>
    (
      await serverRecordBuilders().build(
        { store, effectExecutors: { get: () => undefined }, now: () => now },
        'session',
        [session.sessionId],
      )
    )[0]!.value
  return { store, sessions, session, save, changes, built, ...p }
}

describe('session activity publication', () => {
  it('seeds publication from the existing exact timestamp during migration', () => {
    const db = openDatabase(':memory:')
    try {
      db.exec(
        'CREATE TABLE sessions (id TEXT PRIMARY KEY, last_active_at TEXT NOT NULL, deleted_at TEXT)',
      )
      // The migration bumps the session kind's generation, a table of its time.
      db.exec('CREATE TABLE sync_kind (kind TEXT PRIMARY KEY, generation INTEGER NOT NULL)')
      db.prepare('INSERT INTO sessions (id, last_active_at) VALUES (?, ?)').run('existing', iso(0))
      const migration = DRIZZLE_MIGRATIONS.find((m) =>
        m.name.endsWith('_session-activity-publication'),
      )!
      db.exec(migration.sql)
      expect(
        db
          .prepare('SELECT published_last_active_at, last_active_publish_after FROM sessions')
          .get(),
      ).toEqual({
        published_last_active_at: iso(0),
        last_active_publish_after: 0,
      })
    } finally {
      db.close()
    }
  })
  it('keeps server reads exact, publishes other fields immediately and trails the final activity', async () => {
    const f = await fixture()
    const cursor = await f.ledger.cursor()
    for (const ms of [1_000, 10_000, 59_999]) {
      now = BASE + ms
      f.session.lastActiveAt = iso(ms)
      await f.save()
      expect(await f.changes(cursor)).toEqual([])
      expect(f.session.lastActiveAt).toBe(iso(ms))
      expect(await f.store.sessions.getSession(f.session.sessionId)).toMatchObject({
        lastActiveAt: iso(ms),
        publishedLastActiveAt: iso(0),
      })
      const records = new SessionRecords({ store: f.store, sessions: new Map() })
      expect(
        (await records.read([f.session.sessionId])).get(f.session.sessionId)?.lastActiveAt,
      ).toBe(iso(ms))
      expect(await f.built()).toMatchObject({ lastActiveAt: iso(0) })
    }
    f.session.title = 'New title'
    await f.save()
    expect(await f.changes(cursor)).toHaveLength(1)
    expect(await f.built()).toMatchObject({ title: 'New title', lastActiveAt: iso(0) })
    await f.publisher.flush()
    expect(await f.changes(cursor)).toHaveLength(1)
    now = BASE + 60_000
    await f.publisher.flush()
    expect(await f.changes(cursor)).toHaveLength(2)
    expect(await f.built()).toMatchObject({ lastActiveAt: iso(59_999) })
    await f.publisher.flush()
    expect(await f.changes(cursor)).toHaveLength(2)

    // A trailing write starts a full new window, even though its event was older.
    now = BASE + 60_001
    f.session.lastActiveAt = iso(60_001)
    await f.save()
    expect(await f.changes(cursor)).toHaveLength(2)
    now = BASE + 120_000
    await f.publisher.flush()
    expect(await f.built()).toMatchObject({ lastActiveAt: iso(60_001) })
  })

  it('uses publication time for the limit, regardless of the event clock', async () => {
    const f = await fixture()
    const cursor = await f.ledger.cursor()
    now = BASE + 1_000
    f.session.lastActiveAt = iso(3_600_000)
    await f.save()
    expect(await f.changes(cursor)).toEqual([])
    now = BASE + 60_000
    await f.save()
    expect(await f.changes(cursor)).toHaveLength(1)
    now = BASE + 60_001
    f.session.lastActiveAt = iso(7_200_000)
    await f.save()
    expect(await f.changes(cursor)).toHaveLength(1)
    now = BASE + 120_000
    await f.publisher.flush()
    expect(await f.built()).toMatchObject({ lastActiveAt: iso(7_200_000) })
  })

  it('does not spend an eligible publication on unchanged activity', async () => {
    const f = await fixture()
    now = BASE + 70_000
    f.session.title = 'Metadata only'
    await f.save()
    now = BASE + 71_000
    f.session.lastActiveAt = iso(71_000)
    await f.save()
    expect(await f.built()).toMatchObject({ lastActiveAt: iso(71_000) })
  })

  it('keeps deadlines independent for sessions in a batched row write', async () => {
    const f = await fixture(2)
    now = BASE + 30_000
    f.sessions[1]!.lastActiveAt = iso(30_000)
    // Advance only session 1 at the boundary before creating a shared pending batch.
    now = BASE + 60_000
    await f.save(f.sessions[1]!)
    now = BASE + 61_000
    for (const session of f.sessions) session.lastActiveAt = iso(61_000)
    await f.writer.commit({
      write: async (scope) =>
        await f.store.sessions.upsertSessions(
          scope,
          f.sessions.map((session) => session.toRow()),
        ),
    })
    expect(await f.store.sessions.getSession(f.sessions[0]!.sessionId)).toMatchObject({
      publishedLastActiveAt: iso(61_000),
    })
    expect(await f.store.sessions.getSession(f.sessions[1]!.sessionId)).toMatchObject({
      publishedLastActiveAt: iso(30_000),
    })
    now = BASE + 120_000
    await f.publisher.flush()
    expect(await f.store.sessions.getSession(f.sessions[1]!.sessionId)).toMatchObject({
      publishedLastActiveAt: iso(61_000),
    })
  })

  it('rolls publication value and deadline back with a failed log append and retries', async () => {
    const f = await fixture()
    now = BASE + 10_000
    f.session.lastActiveAt = iso(10_000)
    await f.save()
    now = BASE + 60_000
    const cursor = await f.ledger.cursor()
    vi.spyOn(f.store.sync, 'appendChanges').mockRejectedValueOnce(new Error('append refused'))
    await expect(f.publisher.flush()).rejects.toThrow('append refused')
    expect(await f.changes(cursor)).toEqual([])
    expect(await f.built()).toMatchObject({ lastActiveAt: iso(0) })
    await f.publisher.flush()
    expect(await f.changes(cursor)).toHaveLength(1)
    expect(await f.built()).toMatchObject({ lastActiveAt: iso(10_000) })
  })

  it('rechecks eligibility when activity was published after the due read', async () => {
    const f = await fixture()
    now = BASE + 10_000
    f.session.lastActiveAt = iso(10_000)
    await f.save()
    now = BASE + 60_000
    const ids = await f.store.sessions.activityPublicationsDue(now)
    f.session.lastActiveAt = iso(60_000)
    await f.save()
    const cursor = await f.ledger.cursor()
    await f.writer.commit({
      write: async (scope) => await f.store.sessions.publishActivity(scope, ids, now),
    })
    expect(await f.changes(cursor)).toEqual([])
    expect(await f.built()).toMatchObject({ lastActiveAt: iso(60_000) })
  })

  it('finishes a stopped session after reopening the store, without a resident Session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'podium-activity-publication-'))
    directories.push(directory)
    const file = join(directory, 'state.sqlite')
    const f = await fixture(1, file)
    now = BASE + 10_000
    f.session.lastActiveAt = iso(10_000)
    f.session.status = 'exited'
    await f.save()
    const cursor = await f.ledger.cursor()
    const machine = f.store.hostMachineId
    await f.store.close()
    stores.delete(f.store)
    const store = await openTestStore(file, machine)
    stores.add(store)
    const p = await publication(store)
    now = BASE + 59_999
    await p.publisher.flush()
    expect(await store.sessions.getSession(f.session.sessionId)).toMatchObject({
      publishedLastActiveAt: iso(0),
    })
    now = BASE + 60_000
    await p.publisher.flush()
    expect(await store.sessions.getSession(f.session.sessionId)).toMatchObject({
      status: 'exited',
      lastActiveAt: iso(10_000),
      publishedLastActiveAt: iso(10_000),
    })
    expect(
      (await p.ledger.changesSince(cursor))?.filter((c) => c.entity === 'session'),
    ).toHaveLength(1)
  })

  it('does not let checkpoint-derived activity bypass the stored publication value', async () => {
    const f = await fixture()
    await seedRows(
      f.store,
      async () =>
        await f.store.observationCheckpoints.advanceGeneration(
          f.session.sessionId,
          'codex',
          'thread',
        ),
    )
    const checkpoint: SessionObservationCheckpointV1 = {
      schemaVersion: 1,
      podiumSessionId: f.session.sessionId,
      provider: 'codex',
      providerSessionId: 'thread',
      bindingVersion: 1,
      lifecycleObservationGeneration: 1,
      providerCursor: { segmentId: 'rollout', components: { file: 42 } },
      bootstrapCursor: { segmentId: 'rollout', components: { file: 42 } },
      lastAcceptedLiveCursor: null,
      turnEpoch: 0,
      providerTurnId: null,
      providerPromptId: null,
      turnState: { phase: 'idle', since: iso(0), workingMsTotal: 0, nativeSubagentCount: 0 },
      terminalFence: null,
      providerAt: iso(10_000),
      acceptedAt: iso(10_000),
      lastLiveReceiptAt: null,
      lastTransitionId: 'snapshot-42',
    }
    now = BASE + 10_000
    f.session.lastActiveAt = iso(10_000)
    await f.writer.commit({
      write: async (scope) => {
        await f.store.observationCheckpoints.save(checkpoint)
        await f.store.sessions.upsertSession(scope, f.session.toRow())
      },
    })
    const cursor = await f.ledger.cursor()
    checkpoint.providerAt = iso(20_000)
    await seedRows(f.store, async () => await f.store.observationCheckpoints.save(checkpoint))
    const records = new SessionRecords({ store: f.store, sessions: new Map() })
    expect((await records.read([f.session.sessionId])).get(f.session.sessionId)?.lastActiveAt).toBe(
      iso(20_000),
    )
    expect(await f.built()).toMatchObject({ lastActiveAt: iso(0) })
    // Accepted checkpoints are persisted with the exact Session row by the ingress funnel.
    f.session.applyObservationCheckpoint(checkpoint)
    await f.save()
    // The save rewrites the row's state column, so its commit may append the
    // record (POD-6920: the checkpoint above was seeded outside the log; the
    // ingress funnel saves both in one commit). It never carries the
    // checkpoint's activity: only the publisher moves the published time.
    const saved = await f.changes(cursor)
    expect(saved.map((change) => (change.value as { lastActiveAt?: string }).lastActiveAt)).toEqual(
      saved.map(() => iso(0)),
    )
    const flushedFrom = await f.ledger.cursor()
    now = BASE + 60_000
    await f.publisher.flush()
    expect(await f.changes(flushedFrom)).toHaveLength(1)
    expect(await f.built()).toMatchObject({ lastActiveAt: iso(20_000) })
  })

  it('uses the lifecycle activity tick for shell activity without another event', async () => {
    const o = await makeOracle({ now: () => now })
    const { sessionId } = await o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/work',
    })
    const sessions = o.reg.modules.sessions
    const session = sessions.sessions.get(sessionId)!
    const initial = session.lastActiveAt
    now = BASE + 10_000
    session.terminal.attachClient({
      id: 'shell-reader',
      principal: testClientPrincipal('shell-reader'),
      send: () => {},
      workspaceId: SELF_HOSTED_WORKSPACE_ID,
      viewports: new Map(),
      attached: new Set(),
      caps: new Set(),
      wireVersion: CLIENT_WIRE_VERSION,
      transcriptSubs: new Set(),
      visible: true,
      viewVisible: new Set(),
      focused: null,
      viewModes: {},
    })
    session.terminal.handleInput('shell-reader', Buffer.from('ls\r').toString('base64'))
    const exactActivity = session.lastActiveAt
    await sessions.flushActivity()
    expect(exactActivity > initial).toBe(true)
    expect(await o.store.sessions.getSession(sessionId)).toMatchObject({
      lastActiveAt: exactActivity,
      publishedLastActiveAt: initial,
    })
    now = BASE + 60_000
    await sessions.flushActivity()
    expect(await o.store.sessions.getSession(sessionId)).toMatchObject({
      publishedLastActiveAt: exactActivity,
    })
  })

  it('keeps a failed outer transaction from spending the next publication', async () => {
    const f = await fixture()
    now = BASE + 60_000
    f.session.lastActiveAt = iso(60_000)
    await expect(
      f.store.transact(async () => {
        await f.save()
        throw new Error('outer rollback')
      }),
    ).rejects.toThrow('outer rollback')
    expect(await f.built()).toMatchObject({ lastActiveAt: iso(0) })
    await f.save()
    expect(await f.built()).toMatchObject({ lastActiveAt: iso(60_000) })
  })

  it('adds no read or statement to the session upsert at either batch size', async () => {
    await expectConstantStatements(
      {
        name: 'throttled activity row upsert',
        setup: async (size) => {
          const f = await fixture(size)
          now = BASE + 10_000
          for (const session of f.sessions) session.lastActiveAt = iso(10_000)
          return f
        },
        target: (f) => f.store,
        run: async (f) =>
          await f.store.sessions.upsertSessions(
            fixtureWriteScope(),
            f.sessions.map((s) => s.toRow()),
          ),
        check: async (_result, f) => {
          expect(await f.store.sessions.getSession(f.session.sessionId)).toMatchObject({
            lastActiveAt: iso(10_000),
            publishedLastActiveAt: iso(0),
          })
        },
      },
      1,
    )
  })

  it('reads and updates all due publication rows in two statements at either population', async () => {
    await expectConstantStatements(
      {
        name: 'trailing activity storage batch',
        setup: async (size) => {
          now = BASE
          const f = await fixture(size)
          now = BASE + 10_000
          for (const session of f.sessions) session.lastActiveAt = iso(10_000)
          await f.store.sessions.upsertSessions(
            fixtureWriteScope(),
            f.sessions.map((s) => s.toRow()),
          )
          now = BASE + 60_000
          return f
        },
        target: (f) => f.store,
        // The store-level write runs as a seed: the publisher's commit drains
        // the capture the same way, one statement more (POD-6920).
        run: async (f) =>
          await seedRows(f.store, async () => {
            const ids = await f.store.sessions.activityPublicationsDue(now)
            await f.store.sessions.publishActivity(fixtureWriteScope(), ids, now)
            return ids
          }),
        check: async (result, f, size) => {
          expect(result).toHaveLength(size)
          expect(await f.store.sessions.getSession(f.session.sessionId)).toMatchObject({
            publishedLastActiveAt: iso(10_000),
          })
        },
      },
      3,
    )
  })

  it('bounds a tick and reads an idle pending index with one statement', async () => {
    const f = await fixture(300)
    now = BASE + 10_000
    for (const session of f.sessions) session.lastActiveAt = iso(10_000)
    await f.store.sessions.upsertSessions(
      fixtureWriteScope(),
      f.sessions.map((s) => s.toRow()),
    )
    now = BASE + 60_000
    expect(await f.store.sessions.activityPublicationsDue(now)).toHaveLength(256)
    await f.publisher.flush()
    expect(await f.store.sessions.activityPublicationsDue(now)).toHaveLength(44)
    await f.publisher.flush()
    const counted = await countStatements(f.store, () => f.publisher.flush())
    expect(counted.statements).toBe(1)
    expect(await f.store.sessions.activityPublicationsDue(now)).toEqual([])
  })
})
