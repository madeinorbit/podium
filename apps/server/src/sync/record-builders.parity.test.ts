/**
 * RECORDS FROM THE DATABASE EQUAL THE PUBLISHED RECORDS (POD-6763).
 *
 * A real in-process server on a file store writes records through its
 * production paths (issue writes, markers, a session, an
 * automation, a layout key, a read mark). Then, for every one of the 37
 * database-only kinds, a model load followed by the change log must equal
 * `build(ids)` and `streamAll()`, both
 * in process and on a read-only connection like the sync worker's.
 *
 * The same comparison runs on a real database copy with
 * `apps/server/scripts/record-builders.ts parity`; this test is its guard.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  actorUser,
  asMutationId,
  asThreadId,
  firstAdminMemberId,
  type IssueId,
  interactionRowId,
  issueEventRowId,
  messageRecordRowId,
  RECORD_KINDS,
  recordOf,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { MetadataEntityKind } from '@podium/protocol'
import {
  type BuiltRecord,
  collectRecords,
  RecordBuilderRegistry,
  type RecordIdsByKind,
} from '@podium/sync/record-builders'
import { fixtureWriteScope } from '@podium/sync/testing'
import { describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from '../command-principal'
import { SessionRegistry } from '../relay'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import type { SessionStore } from '../store'
import type { MessageRow } from '../store/types'
import { openWorkerReadSession } from '../sync-worker/read-session'
import { recordReadsOf } from '../sync-worker/record-reads'
import { installCaptureOracle } from '../test-support/capture-oracle'
import { attachHostDaemon } from '../test-support/host-daemon'
import { issueRowFixture } from '../test-support/issue-row'
import { loggedRows } from '../test-support/logged-rows'
import { openTestStore } from '../test-support/open-test-store'
import { quietShipping } from '../test-support/statement-count'
import type { WriteContexts } from '../write-contexts'
import { DATABASE_ONLY_BUILDERS, type RecordReads, serverRecordBuilders } from './record-builders'
import { atParity, type KindParity, kindParity, type PublishedRow } from './record-parity'
import { RECORD_SOURCES } from './record-sources'

/** Kinds this fixture writes, so their parity is not vacuous. */
const POPULATED = [
  'session',
  'sessionUserState',
  'issueProjection',
  'issueDep',
  'issueUserState',
  'issueEvent',
  'pendingInteraction',
  'message',
  'automation',
  'userLayout',
  'userReadPosition',
  'instancePreferences',
  'superagentThread',
] as const

async function settle(reg: SessionRegistry): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  await reg.modules.sessions.flushBroadcasts()
  await new Promise((resolve) => setTimeout(resolve, 20))
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** A person's chat message into a session, as the send path stores it. */
function chat(id: string, sessionId: SessionId, sender: UserId, n: number): MessageRow {
  return {
    id,
    threadId: asThreadId(id),
    inReplyTo: null,
    fromKind: 'operator',
    fromSession: null,
    fromIssue: null,
    attribution: { actor: actorUser(sender), onBehalfOf: sender },
    toKind: 'session',
    toId: sessionId,
    kind: 'message',
    urgency: 'next-turn',
    lifecycle: 'wait',
    body: `text of ${id}`,
    expiresAt: null,
    createdAt: `2026-11-10T12:00:${String(n).padStart(2, '0')}.000Z`,
    deliveryStatus: 'stored',
    deliveredAt: null,
    deliveredTo: null,
    ackedBy: null,
    hop: 0,
    clampedFrom: null,
    remindedAt: null,
    expectsResponse: false,
  }
}

/** An open ask in a session, as a protocol driver raises it. */
async function ask(reg: SessionRegistry, sessionId: SessionId, id: string): Promise<void> {
  await reg.modules.interactions.ask({
    interaction: {
      id,
      sessionId,
      kind: 'question',
      payload: {
        v: 1,
        questions: [{ question: 'Which?', multiSelect: false, previewLayout: false, options: [] }],
      },
      source: 'protocol',
      answerable: 'structured',
      fingerprint: `fp-${id}`,
    },
  })
}

/** Write chat messages: one confirmed, one on its way, one cancelled. */
async function chatTraffic(store: SessionStore, sessionId: SessionId, sender: UserId) {
  await store.messages.addMessage(fixtureWriteScope(), chat('msg_done', sessionId, sender, 1))
  await store.messages.markDelivered(
    fixtureWriteScope(),
    'msg_done',
    sessionId,
    '2026-11-17T00:00:00.000Z',
  )
  await store.messages.addMessage(fixtureWriteScope(), chat('msg_open', sessionId, sender, 2))
  await store.messages.addMessage(fixtureWriteScope(), chat('msg_gone', sessionId, sender, 3))
  await store.messages.markCancelled(fixtureWriteScope(), 'msg_gone')
}

interface LoadedRecords {
  cursor: number
  kinds: Map<MetadataEntityKind, Map<string, PublishedRow>>
}

/** A client loads model records once, then follows changes after that cursor. */
async function loadRecords(reg: SessionRegistry, reads: RecordReads): Promise<LoadedRecords> {
  return await reg.sessionStore.transact(async () => {
    const kinds = new Map<MetadataEntityKind, Map<string, PublishedRow>>()
    const builders = serverRecordBuilders()
    for (const kind of builders.kinds()) {
      const rows = new Map<string, PublishedRow>()
      for await (const page of builders.streamAll(reads, kind)) {
        for (const row of page)
          rows.set(row.id, { entityId: row.id, payload: JSON.stringify(row.value) })
      }
      kinds.set(kind, rows)
    }
    return { cursor: await reg.changeLedger.cursor(), kinds }
  })
}

async function parityOf(
  store: SessionStore,
  reads: RecordReads,
  loaded?: LoadedRecords,
): Promise<KindParity[]> {
  const registry = serverRecordBuilders()
  const out: KindParity[] = []
  const changes = await store.sync.changesSince(loaded?.cursor ?? 0)
  for (const builder of DATABASE_ONLY_BUILDERS) {
    const held = new Map(loaded?.kinds.get(builder.kind))
    for (const row of changes) {
      if (row.entity !== builder.kind) continue
      if (row.op === 'remove') held.delete(row.entityId)
      else held.set(row.entityId, { entityId: row.entityId, payload: row.payload })
    }
    out.push(
      await kindParity(registry, reads, builder.kind, [...held.values()], { keepValues: true }),
    )
  }
  return out
}

describe('record builders (POD-6763)', () => {
  it('registers every record kind once', () => {
    const kinds = serverRecordBuilders().kinds()
    expect(kinds).toHaveLength(40)
    expect(new Set(kinds).size).toBe(40)
    expect(
      () => new RecordBuilderRegistry([...DATABASE_ONLY_BUILDERS, DATABASE_ONLY_BUILDERS[0]!]),
    ).toThrow(/already registered/)
  })

  it('builds exactly the declared kinds, and reads tables for each (POD-7084)', () => {
    expect([...serverRecordBuilders().kinds()].sort()).toEqual([...RECORD_KINDS].sort())
    expect(Object.keys(RECORD_SOURCES).sort()).toEqual([...RECORD_KINDS].sort())
    // A declared kind with no builder, and a builder with no declaration, are refused.
    const withoutCheckout = DATABASE_ONLY_BUILDERS.filter((builder) => builder.kind !== 'checkout')
    expect(() => new RecordBuilderRegistry(withoutCheckout, [], RECORD_KINDS)).toThrow(
      /checkout is declared but has no builder/,
    )
    expect(
      () =>
        new RecordBuilderRegistry(
          DATABASE_ONLY_BUILDERS,
          [],
          [...RECORD_KINDS.filter((kind) => kind !== 'repo')],
        ),
    ).toThrow(/repo has a builder but no declaration/)
    // Every body part a declaration names is a built record of its own.
    for (const kind of RECORD_KINDS) {
      for (const bodyKind of Object.keys(recordOf(kind).body)) {
        expect(serverRecordBuilders().has(bodyKind as MetadataEntityKind), bodyKind).toBe(true)
      }
    }
  })

  it('shares one issue read while preserving each kind’s requested ids and order', async () => {
    const store = await openTestStore(':memory:')
    await installCaptureOracle(store)
    try {
      for (const [index, id] of ['a', 'b', 'c', 'empty'].entries()) {
        await store.issues.upsertIssue(
          fixtureWriteScope(),
          issueRowFixture({
            id,
            seq: index + 1,
            parentId: null,
            description: id === 'empty' ? '' : `Body of ${id}`,
            brief: id === 'b' ? 'Brief of b' : null,
          }),
        )
      }
      const reads: RecordReads = { store, effectExecutors: { get: () => undefined }, now: Date.now }
      const registry = serverRecordBuilders()
      const asked: RecordIdsByKind = new Map([
        ['issueDescription', ['b', 'a', 'empty', 'missing', 'b']],
        ['issueBrief', ['a', 'b', 'empty']],
        ['issueProjection', ['c', 'a', 'missing', 'c']],
      ])
      const expected = new Map<string, readonly BuiltRecord[]>()
      for (const [kind, ids] of asked) expected.set(kind, await registry.build(reads, kind, ids))
      const getIssues = vi.spyOn(store.issues, 'getIssues')
      try {
        const built = new Map<string, readonly BuiltRecord[]>()
        for await (const { entity, records } of registry.buildMany(reads, asked)) {
          built.set(entity, records)
        }
        expect(built).toEqual(expected)
        expect(built.get('issueProjection')?.map(({ id }) => id)).toEqual(['c', 'a'])
        expect(built.get('issueDescription')).toEqual([
          { id: 'b', value: { id: 'b', text: 'Body of b' } },
          { id: 'a', value: { id: 'a', text: 'Body of a' } },
        ])
        // Only `b` has a brief; an empty field has no record.
        expect(built.get('issueBrief')).toEqual([
          { id: 'b', value: { id: 'b', text: 'Brief of b' } },
        ])
        expect(getIssues).toHaveBeenCalledTimes(1)
        expect(new Set(getIssues.mock.calls[0]![0])).toEqual(
          new Set(['a', 'b', 'c', 'empty', 'missing']),
        )
      } finally {
        getIssues.mockRestore()
      }
    } finally {
      await store.close()
    }
  })

  it('keeps a loaded client plus subsequent changes equal to database records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-6763-parity-'))
    const path = join(dir, 'podium.db')
    const store = await openTestStore(path)
    await installCaptureOracle(store)
    const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    try {
      const loaded = await loadRecords(reg, {
        store,
        effectExecutors: reg.modules.effects!.executors,
        now: Date.now,
      })
      await attachHostDaemon(reg, () => {}, { repos: [] })
      const issues = reg.issues.reports.store
      await issues.commitRepoWrite(
        issues.serverWriter,
        async () => await store.repos.addRepo('/repo', store.hostMachine!.id),
      )
      await quietShipping(reg)
      const owner = await firstAdminMemberId(store)
      const writer = reg.issues.reports.store.serverWriter
      const ids: IssueId[] = []
      for (let i = 0; i < 4; i++) {
        const created = await reg.issues.crud.create(writer, {
          repoPath: '/repo',
          title: `Issue ${i}`,
          startNow: false,
          parentBranch: 'main',
        })
        ids.push(created.id)
      }
      await reg.issues.crud.update(writer, ids[0]!, { title: 'Renamed' })
      await reg.issues.hierarchy.addDep(writer, ids[1]!, ids[0]!)
      await reg.issues.crud.markIssueRead(writer, ids[2]!, undefined, owner)
      await reg.issues.crud.markIssueRead(writer, ids[3]!, undefined, owner)
      const { sessionId } = await reg.modules.sessions.createSession({
        agentKind: 'codex',
        cwd: '/other/w1',
      })
      await reg.modules.sessions.state.markRead(
        reg.modules.sessions.serverWriter,
        await reg.modules.sessions.view.principalForTrustedUser(owner),
        sessionId,
      )
      await ask(reg, sessionId, 'ixn_open')
      await chatTraffic(store, sessionId, owner)
      // Retention takes the oldest events, issue events among them; the feed
      // lets them go (POD-6766: the window is the events that exist).
      await settle(reg)
      const carriedBefore = (await loggedRows(store, 'issueEvent')).length
      await store.events.pruneEventBatch(
        await store.events.planEventPrune({ maxAgeDays: 3650, maxRows: 2 }),
      )
      await settle(reg)
      expect((await loggedRows(store, 'issueEvent')).length).toBeLessThan(carriedBefore)
      // And a newer issue event arrives after the prune.
      await reg.issues.crud.create(writer, {
        repoPath: '/repo',
        title: 'After the prune',
        startNow: false,
        parentBranch: 'main',
      })
      const writes = (reg as unknown as { writes: WriteContexts }).writes
      await reg.modules.automations.create(
        writes.sync(asMutationId('m-pod-6763-automation')),
        {
          name: 'Nightly sweep',
          repoPath: '/repo',
          cron: '0 3 * * *',
          agentKind: 'claude-code',
          prompt: 'sweep',
          enabled: false,
        },
        userCommandPrincipal(SELF_HOSTED_WORKSPACE_ID, owner, 'admin'),
      )
      await reg.modules.layout.set(
        writes.sync(asMutationId('m-pod-6763-layout')),
        owner,
        { dockTab: 'chat' },
        '2026-11-10T12:00:00.000Z',
      )
      await reg.modules.readPosition.advance(
        writes.sync(asMutationId('m-pod-6763-read')),
        owner,
        'issueEvents',
        { lastEventId: 3, seenAt: '2026-11-10T12:00:00.000Z' },
        '2026-11-10T12:00:00.000Z',
      )
      await settle(reg)

      const inProcess = await parityOf(
        store,
        {
          store,
          effectExecutors: reg.modules.effects!.executors,
          now: Date.now,
        },
        loaded,
      )
      // The worker's own read session on the store's engine (POD-6994): a read-only
      // SQLite connection, or a Postgres REPEATABLE READ snapshot.
      const session = await openWorkerReadSession(store.database.location)
      const reads = recordReadsOf(session.executor.queries, {
        workspaceId: store.workspaceId,
        effectExecutors: reg.modules.effects!.executors,
      })
      let onWorkerConnection: KindParity[]
      try {
        onWorkerConnection = await parityOf(store, reads, loaded)
      } finally {
        await session.close()
      }

      // The parts a record carries are the declared ones (POD-7084): a built
      // record never carries a live field or a body field.
      const recordReads = { store, effectExecutors: reg.modules.effects!.executors, now: Date.now }
      for (const kind of ['session', 'issueProjection', 'machine'] as const) {
        const declaration = recordOf(kind)
        const notCarried = [
          ...declaration.live,
          ...Object.keys(declaration.liveReadings),
          // `panel.todos` travels as its own records: the record has no `panel`.
          ...Object.values(declaration.body)
            .flat()
            .map((field) => field.split('.')[0]!),
        ]
        const built = await collectRecords(serverRecordBuilders().streamAll(recordReads, kind))
        expect(built.length, `${kind} records`).toBeGreaterThan(0)
        for (const { value } of built) {
          for (const field of notCarried) {
            expect((value as Record<string, unknown>)[field], `${kind}.${field}`).toBeUndefined()
          }
        }
      }

      for (const results of [inProcess, onWorkerConnection]) {
        const failing = results.filter((result) => !atParity(result))
        expect(failing, JSON.stringify(failing, null, 2)).toEqual([])
        for (const kind of POPULATED) {
          const result = results.find((r) => r.kind === kind)!
          expect(result.published, `${kind} has published records`).toBeGreaterThan(0)
          expect(result.byteEqual, `${kind} is byte-equal`).toBe(result.published)
        }
      }
    } finally {
      await reg.dispose()
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('reloads current records from tables while leaving stale historical log rows alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-6766-boot-'))
    const path = join(dir, 'podium.db')
    let store = await openTestStore(path)
    await installCaptureOracle(store)
    let reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    try {
      await attachHostDaemon(reg, () => {}, { repos: ['/repo'] })
      await quietShipping(reg)
      const owner = await firstAdminMemberId(store)
      await reg.issues.crud.create(reg.issues.reports.store.serverWriter, {
        repoPath: '/repo',
        title: 'Issue',
        startNow: false,
        parentBranch: 'main',
      })
      const { sessionId } = await reg.modules.sessions.createSession({
        agentKind: 'codex',
        cwd: '/other/w1',
      })
      await reg.modules.sessions.state.markRead(
        reg.modules.sessions.serverWriter,
        await reg.modules.sessions.view.principalForTrustedUser(owner),
        sessionId,
      )
      await ask(reg, sessionId, 'ixn_open')
      await chatTraffic(store, sessionId, owner)
      await settle(reg)
      const machineId = store.hostMachine!.id
      await reg.dispose()
      await store.close()

      // While the server is down, the feed falls out of step with the tables
      // in the three ways measured on 2026-11-09: an issue event retention
      // pruned, an ask that closed, a message in an older shape.
      store = await openTestStore(path, machineId)
      await installCaptureOracle(store)
      const prunedEvent = issueEventRowId(999_999, 'POD-1')
      const closedAsk = interactionRowId(sessionId, 'ixn_closed')
      // The confirmed message: its delivery is over, so the rebooted registry's delivery
      // sweep never writes it again. An open one is dispatched by that sweep, which
      // re-captures it, if the sweep runs before the check (POD-6994: on Postgres it does).
      const message = messageRecordRowId({ sessionId, senderUserId: owner, messageId: 'msg_done' })
      const current = (await loggedRows(store, 'message')).find((row) => row.entityId === message)
      expect(current?.payload).toBeTruthy()
      await store.sync.appendChanges(
        [
          {
            entity: 'issueEvent',
            entityId: prunedEvent,
            op: 'upsert',
            payload: JSON.stringify({ id: prunedEvent, eventId: 999_999, subject: 'POD-1' }),
          },
          {
            entity: 'pendingInteraction',
            entityId: closedAsk,
            op: 'upsert',
            payload: JSON.stringify({ id: 'ixn_closed', sessionId }),
          },
          {
            entity: 'message',
            entityId: message,
            op: 'upsert',
            payload: JSON.stringify({ ...JSON.parse(current!.payload!), legacy: true }),
          },
        ],
        1,
      )
      reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
      await settle(reg)

      const reads = { store, effectExecutors: reg.modules.effects!.executors, now: Date.now }
      const results = await parityOf(store, reads)
      const windows = results.filter((result) =>
        ['issueEvent', 'pendingInteraction', 'message'].includes(result.kind),
      )
      expect(
        windows
          .filter((result) => !atParity(result))
          .map((result) => result.kind)
          .sort(),
      ).toEqual(['issueEvent', 'message', 'pendingInteraction'])
      // A generation-triggered reload replaces records from the tables. It does
      // not repair history or copy its stale values back into current state.
      const loaded = await loadRecords(reg, reads)
      const reloaded = await parityOf(store, reads, loaded)
      expect(reloaded.filter((result) => !atParity(result))).toEqual([])
      expect(loaded.kinds.get('issueEvent')?.has(prunedEvent)).toBe(false)
      expect(loaded.kinds.get('pendingInteraction')?.has(closedAsk)).toBe(false)
      expect(
        JSON.parse(loaded.kinds.get('message')?.get(message)?.payload ?? '{}'),
      ).not.toHaveProperty('legacy')
      const logged = (await loggedRows(store, 'issueEvent')).map((row) => row.entityId)
      expect(logged).toContain(prunedEvent)
    } finally {
      await reg.dispose()
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
