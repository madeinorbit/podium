/**
 * RECORDS FROM THE DATABASE EQUAL THE PUBLISHED RECORDS (POD-6763).
 *
 * A real in-process server on a file store writes records through its
 * production paths (boot seeds, issue writes, markers, a session, an
 * automation, a layout key, a read mark). Then, for every one of the 24
 * database-only kinds, `build(ids)` of every `change_latest` id must equal its
 * payload, and `streamAll()` must stream exactly the published ids, both
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
  type SessionId,
  type UserId,
} from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { RecordBuilderRegistry } from '@podium/sync/record-builders'
import { fixtureWriteScope } from '@podium/sync/testing'
import { describe, expect, it } from 'vitest'
import { userCommandPrincipal } from '../command-principal'
import { SessionRegistry } from '../relay'
import type { SessionStore } from '../store'
import type { MessageRow } from '../store/types'
import { recordReadsOver } from '../sync-worker/record-reads'
import { attachHostDaemon } from '../test-support/host-daemon'
import { openTestStore } from '../test-support/open-test-store'
import { quietShipping } from '../test-support/statement-count'
import type { WriteContexts } from '../write-contexts'
import { DATABASE_ONLY_BUILDERS, type RecordReads, serverRecordBuilders } from './record-builders'
import { atParity, type KindParity, kindParity } from './record-parity'

/** Kinds this fixture writes, so their parity is not vacuous. */
const POPULATED = [
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
  await store.messages.markDelivered(fixtureWriteScope(), 'msg_done', sessionId, 't')
  await store.messages.addMessage(fixtureWriteScope(), chat('msg_open', sessionId, sender, 2))
  await store.messages.addMessage(fixtureWriteScope(), chat('msg_gone', sessionId, sender, 3))
  await store.messages.markCancelled(fixtureWriteScope(), 'msg_gone')
}

async function parityOf(store: SessionStore, reads: RecordReads): Promise<KindParity[]> {
  const registry = serverRecordBuilders()
  const out: KindParity[] = []
  for (const builder of DATABASE_ONLY_BUILDERS) {
    const published = (await store.sync.installedStatesOf(builder.kind)).map((row) => ({
      entityId: row.entityId,
      payload: row.payload,
    }))
    out.push(
      await kindParity(registry, reads, builder.kind, published, {
        keepValues: true,
        // POD-6767 moves these out of the issue record; both sides change with it.
        ...(builder.kind === 'issueProjection'
          ? { ignoreFields: ['brief', 'panel', 'description', 'activityNotes'] }
          : {}),
      }),
    )
  }
  return out
}

describe('record builders (POD-6763)', () => {
  it('registers the 29 database-only kinds once each', () => {
    const kinds = serverRecordBuilders().kinds()
    expect(kinds).toHaveLength(29)
    expect(new Set(kinds).size).toBe(29)
    for (const left of [
      'repo',
      'shipLane',
      'userPreferences',
    ] as const) {
      expect(kinds).not.toContain(left)
    }
    expect(
      () => new RecordBuilderRegistry([...DATABASE_ONLY_BUILDERS, DATABASE_ONLY_BUILDERS[0]!]),
    ).toThrow(/already registered/)
  })

  it('builds every published record equal to its change_latest payload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-6763-parity-'))
    const path = join(dir, 'podium.db')
    const store = await openTestStore(path)
    const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    try {
      await attachHostDaemon(reg, () => {}, { repos: ['/repo'] })
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
      await ask(reg, sessionId, 'ixn_open')
      await chatTraffic(store, sessionId, owner)
      // Retention takes the oldest events, issue events among them; the feed
      // lets them go (POD-6766: the window is the events that exist).
      await settle(reg)
      const carriedBefore = (await store.sync.installedStatesOf('issueEvent')).length
      await store.events.pruneEventBatch(
        await store.events.planEventPrune({ maxAgeDays: 3650, maxRows: 2 }),
      )
      await settle(reg)
      expect((await store.sync.installedStatesOf('issueEvent')).length).toBeLessThan(carriedBefore)
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
        userCommandPrincipal(owner, 'admin'),
      )
      await reg.modules.layout.set(
        writes.sync(asMutationId('m-pod-6763-layout')),
        owner,
        { dockTab: 'chat' },
        '2026-11-10T12:00:00Z',
      )
      await reg.modules.readPosition.advance(
        writes.sync(asMutationId('m-pod-6763-read')),
        owner,
        'issueEvents',
        { lastEventId: 3, seenAt: '2026-11-10T12:00:00Z' },
        '2026-11-10T12:00:00Z',
      )
      await settle(reg)

      const inProcess = await parityOf(store, {
        store,
        effectExecutors: reg.modules.effects!.executors,
        now: Date.now,
      })
      const readOnly = openDatabase(path, { readOnly: true })
      readOnly.exec('BEGIN')
      const { reads, close } = recordReadsOver(readOnly, {
        effectExecutors: reg.modules.effects!.executors,
      })
      let onWorkerConnection: KindParity[]
      try {
        onWorkerConnection = await parityOf(store, reads)
      } finally {
        readOnly.exec('ROLLBACK')
        await close()
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

  it('corrects at boot a feed that is out of step with the tables (the 2026-11-09 gaps)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-6766-boot-'))
    const path = join(dir, 'podium.db')
    let store = await openTestStore(path)
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
      await ask(reg, sessionId, 'ixn_open')
      await chatTraffic(store, sessionId, owner)
      await settle(reg)
      const machineId = store.hostMachineId
      await reg.dispose()
      await store.close()

      // While the server is down, the feed falls out of step with the tables
      // in the three ways measured on 2026-11-09: an issue event retention
      // pruned, an ask that closed, a message in an older shape.
      store = await openTestStore(path, machineId)
      const prunedEvent = issueEventRowId(999_999, 'POD-1')
      const closedAsk = interactionRowId(sessionId, 'ixn_closed')
      const message = messageRecordRowId({ sessionId, senderUserId: owner, messageId: 'msg_open' })
      const current = (await store.sync.installedStatesOf('message')).find(
        (row) => row.entityId === message,
      )
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

      const results = await parityOf(store, {
        store,
        effectExecutors: reg.modules.effects!.executors,
        now: Date.now,
      })
      const failing = results.filter((result) => !atParity(result))
      expect(failing, JSON.stringify(failing, null, 2)).toEqual([])
      for (const kind of ['issueEvent', 'pendingInteraction', 'message'] as const) {
        const result = results.find((r) => r.kind === kind)!
        expect(result.published, `${kind} has published records`).toBeGreaterThan(0)
        expect(result.byteEqual, `${kind} is byte-equal`).toBe(result.published)
      }
      const ids = async (kind: 'issueEvent' | 'pendingInteraction') =>
        (await store.sync.installedStatesOf(kind)).map((row) => row.entityId)
      expect(await ids('issueEvent')).not.toContain(prunedEvent)
      expect(await ids('pendingInteraction')).not.toContain(closedAsk)
    } finally {
      await reg.dispose()
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
