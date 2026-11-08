/**
 * MY PER-USER RECORDS ACROSS MY DEVICES, AGAINST A REAL SERVER (POD-6673).
 *
 * Pins, tab orders, personal settings and read positions are synced records of
 * their owner. This file checks the product claim end to end on the real stack:
 * a booted server, real WebSockets announcing wire v2, the shipped feed consumer
 * (`FeedSink` → kernel `Replica` over IndexedDB) on each client, and on the
 * writing device the shipped kernel outbox, draining into `sync.submit` with the
 * entries the app builds (`recordCreateEntry` / `recordEditEntry`).
 *
 *  - Two devices of the same person (two session tokens of one account): a pin,
 *    a tab order, a setting and a read position made on device A while it is
 *    OFFLINE are queued and sent nothing; once A is online they reach device B
 *    as feed deltas, without B reloading, and A's entries retire by their
 *    receipts once A's own replica reaches them.
 *  - A second member, connected the whole time, never receives any of them. The
 *    positive control is the member's own pin, which does reach the member: an
 *    empty slice from a socket that was never the member would prove nothing.
 *
 * What is wired by hand is what the engine wires (the outbox's online probe,
 * and retiring through the replica's cursor); everything that carries a byte is
 * the shipped code.
 */

import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PodiumClientApi } from '@podium/client-core/api'
import type { OutboxEntry, OutboxStorage } from '@podium/client-core/outbox'
import { recordCreateEntry, recordEditEntry } from '@podium/client-core/records'
import type { Replica as ClientReplica } from '@podium/client-core/replica'
import {
  FeedAuthorityClient,
  FeedSink,
  PushedBootstrapSource,
} from '@podium/client-core/replica/feed'
import {
  asMutationId,
  asUserId,
  firstAdminMemberId,
  pinRowId,
  readPositionRowId,
  tabOrderRowId,
  type UserId,
  userPreferencesRowId,
} from '@podium/model'
import { CLIENT_WIRE_VERSION, type ServerMessage } from '@podium/protocol'
import { type IdbFactoryLike, IndexedDbSyncStore } from '@podium/sync/adapters/indexeddb'
import { InMemoryOutboxStore } from '@podium/sync/outbox'
import { Replica } from '@podium/sync/replica'
import type { FeedServerFrame } from '@podium/terminal-client'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { IDBFactory } from 'fake-indexeddb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { hashToken } from '../../apps/server/src/auth-route'
import type { AppRouter } from '../../apps/server/src/router'
import { startServer } from '../../apps/server/src/server'
// The kernel queue alone: the engine's index also loads the decorated client
// models, which this node lane does not transform.
import { openKernelEngineOutbox } from '../../packages/client-core/src/engine/kernel-outbox'

const FEED_TYPES = new Set(['feedDelta', 'feedBootstrap', 'feedRescope', 'feedResyncRequired'])
const PER_USER_KINDS = new Set(['pin', 'tabOrder', 'userPreferences', 'userReadPosition'])
const priorStateDir = process.env.PODIUM_STATE_DIR

const MEMBER = asUserId('usr_member_6673_e2e')

describe('POD-6673 · my per-user records on my other device (live server)', () => {
  let stateDir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let factory: IdbFactoryLike
  /** The instance's first admin: me, the person with two devices. */
  let ME: UserId
  const sockets: WebSocket[] = []

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-per-user-e2e-'))
    process.env.PODIUM_STATE_DIR = stateDir
    server = await startServer({ port: 0 })
    factory = new IDBFactory() as unknown as IdbFactoryLike
    ME = await firstAdminMemberId(server.registry.sessionStore)
    await server.registry.sessionStore.users.createUnclaimed({
      id: MEMBER,
      displayName: 'Member',
      email: null,
      role: 'member',
      createdAt: new Date().toISOString(),
      disabledAt: null,
    })
  })

  afterAll(async () => {
    for (const s of sockets) s.close()
    await server.close()
    rmSync(stateDir, { recursive: true, force: true })
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
  })

  const until = async (pred: () => boolean, ms = 8000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for condition')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  /** A signed-in device: its own session token for `user`, as a login mints. */
  async function signIn(user: UserId): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    const expires = new Date(Date.now() + 3_600_000).toISOString()
    await server.registry.sessionStore.auth.createClientSession(hashToken(token), user, expires)
    return token
  }

  const trpcFor = (token: string) =>
    createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `http://127.0.0.1:${server.port}/trpc`,
          headers: { authorization: `Bearer ${token}` },
        }),
      ],
    })

  interface Device {
    readonly replica: Replica
    readonly trpc: ReturnType<typeof trpcFor>
    /** `(entity, entityId)` of the per-user rows this device holds. */
    perUser(): string[]
    framesSeen: string[]
  }

  /** One device: a real socket announcing wire v2, the shipped consumer, IndexedDB. */
  async function openDevice(name: string, user: UserId): Promise<Device> {
    const token = await signIn(user)
    const trpc = trpcFor(token)
    const store = await IndexedDbSyncStore.open({
      factory,
      databaseName: `per-user-e2e-${name}`,
      onDegraded: (d) => {
        throw new Error(`storage degraded during the e2e: ${JSON.stringify(d)}`)
      },
    })
    const framesSeen: string[] = []
    let socket: WebSocket | undefined
    const bootstraps = new PushedBootstrapSource({
      requestFreshWorld: () => {
        socket?.close()
        void openSocket()
      },
    })
    const replica = new Replica({
      store: store.viewFor('default').cache,
      authority: new FeedAuthorityClient({
        fetchChangesSince: async (cursor) =>
          (await trpc.sync.feedChangesSince.query({ cursor })) as never,
        bootstraps,
      }),
    })
    const sink = new FeedSink({ replica, bootstraps, onFrame: (kind) => framesSeen.push(kind) })

    async function openSocket(): Promise<void> {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/client?v=${CLIENT_WIRE_VERSION}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      sockets.push(ws)
      socket = ws
      ws.on('message', (data) => {
        const message = JSON.parse(String(data)) as ServerMessage
        if (!FEED_TYPES.has(message.type)) return
        sink.frame(message as FeedServerFrame)
      })
      await new Promise<void>((resolve, reject) => {
        ws.on('error', reject)
        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              type: 'hello',
              clientId: '',
              viewport: { cols: 80, rows: 24, dpr: 1 },
              wireVersion: CLIENT_WIRE_VERSION,
            }),
          )
          resolve()
        })
      })
      sink.connected()
    }

    await openSocket()
    await until(() => framesSeen.includes('feedBootstrap'))
    await replica.settled()
    return {
      replica,
      trpc,
      framesSeen,
      perUser: () =>
        replica
          .entities()
          .filter((row) => PER_USER_KINDS.has(row.entity))
          .map((row) => `${row.entity}:${row.entityId}`)
          .sort(),
    }
  }

  const memoryStorage = (): OutboxStorage => {
    let entries: OutboxEntry[] = []
    return {
      load: () => entries,
      save: (next) => {
        entries = [...next]
      },
    }
  }

  /** The writing device's queue: the shipped kernel outbox over its own api. */
  async function openOutbox(device: Device, principal: UserId) {
    let online = false
    const api = device.trpc as unknown as PodiumClientApi
    const create = await openKernelEngineOutbox({
      store: new InMemoryOutboxStore([]),
      principal,
      api,
      onDegraded: (detail) => {
        throw new Error(`outbox degraded: ${JSON.stringify(detail)}`)
      },
      confirmedThrough: () => device.replica.cursor,
    })
    const dropped: OutboxEntry[] = []
    const outbox = create({
      api,
      replica: {
        outboxStorage: memoryStorage,
        outboxAwaitingStorage: memoryStorage,
        outboxDeadLetterStorage: memoryStorage,
      } as unknown as ClientReplica,
      notices: { error: () => {}, info: () => {} } as never,
      isOnline: () => online,
      onDropped: (entry) => dropped.push(entry),
    })
    return {
      outbox,
      dropped,
      goOnline: () => {
        online = true
      },
      /** What the engine does as its replica advances: retire through its cursor. */
      retireThroughReplica: async () => {
        const through = device.replica.cursor
        if (through !== null) await create.overlay.retire({ matches: [], through, install: false })
      },
    }
  }

  it('a pin, a tab order, a setting and a read position made offline on A reach B, and never another member', async () => {
    const a = await openDevice('me-a', ME)
    const b = await openDevice('me-b', ME)
    const member = await openDevice('member', MEMBER)

    // A session I can read, for the tab order to name.
    const { sessionId } = await a.trpc.sessions.create.mutate({ agentKind: 'shell', cwd: '/p' })

    const pin = pinRowId(ME, 'repo', '/repo/mine')
    const order = tabOrderRowId(ME, '/repo/mine')
    const preferences = userPreferencesRowId(ME)
    const read = readPositionRowId(ME, 'issueEvents')
    const written = [
      `pin:${pin}`,
      `tabOrder:${order}`,
      `userPreferences:${preferences}`,
      `userReadPosition:${read}`,
    ].sort()

    // A IS OFFLINE: each write is queued and nothing is sent.
    const queue = await openOutbox(a, ME)
    await queue.outbox.enqueue(
      'recordCreate',
      recordCreateEntry('pin', pin, { userId: ME, kind: 'repo', entityId: '/repo/mine' }),
      { mutationId: asMutationId('e2e-pin') },
    )
    await queue.outbox.enqueue(
      'recordEdit',
      recordEditEntry({ kind: 'tabOrder', id: order }, { sessionIds: [sessionId] }),
      { mutationId: asMutationId('e2e-tab') },
    )
    await queue.outbox.enqueue(
      'recordEdit',
      recordEditEntry(
        { kind: 'userPreferences', id: preferences },
        { 'sidebar.repoSort': 'custom' },
      ),
      { mutationId: asMutationId('e2e-pref') },
    )
    await queue.outbox.enqueue(
      'recordEdit',
      recordEditEntry(
        { kind: 'userReadPosition', id: read },
        { lastEventId: 5, seenAt: '2026-11-08T12:00:00.000Z' },
      ),
      { mutationId: asMutationId('e2e-read') },
    )
    await queue.outbox.drain()
    expect(queue.outbox.pending().map((e) => e.mutationId)).toEqual([
      'e2e-pin',
      'e2e-tab',
      'e2e-pref',
      'e2e-read',
    ])
    // Nothing reached the server: B holds none of them. (The server may
    // already have written my settings record on its own, so that one id is
    // not the evidence here; the other three are.)
    const offlineB = b.perUser()
    for (const id of [`pin:${pin}`, `tabOrder:${order}`, `userReadPosition:${read}`]) {
      expect(offlineB).not.toContain(id)
    }

    // A RECONNECTS: the queue drains, and B receives every row as a delta.
    queue.goOnline()
    await queue.outbox.drain()
    await until(() => written.every((id) => b.perUser().includes(id)))
    await b.replica.settled()
    expect(queue.dropped).toEqual([])
    expect(b.framesSeen).toContain('feedDelta')

    // The values B holds are the ones A wrote.
    const value = (entity: string, id: string) =>
      b.replica.entities().find((row) => row.entity === entity && row.entityId === id)?.value as
        | Record<string, unknown>
        | undefined
    expect(value('tabOrder', order)).toMatchObject({ sessionIds: [sessionId] })
    expect(value('userPreferences', preferences)).toMatchObject({ 'sidebar.repoSort': 'custom' })
    expect(value('userReadPosition', read)).toMatchObject({ lastEventId: 5 })

    // A's entries retire by their receipts, once A's own replica reaches them.
    await until(() => written.every((id) => a.perUser().includes(id)))
    await a.replica.settled()
    await queue.retireThroughReplica()
    await until(() => queue.outbox.pending().length === 0 && queue.outbox.awaiting().length === 0)

    // ANOTHER MEMBER NEVER RECEIVES THEM. Positive control first: the member's
    // own pin reaches the member's socket.
    const memberPin = pinRowId(MEMBER, 'repo', '/repo/theirs')
    const reply = await member.trpc.sync.submit.mutate({
      mutationId: asMutationId('e2e-member-pin'),
      command: 'records.pin.create',
      version: 1,
      // The kernel envelope's shape: the record's id and fields, and the
      // mutation id repeated in the input.
      input: {
        id: memberPin,
        fields: { userId: MEMBER, kind: 'repo', entityId: '/repo/theirs' },
        mutationId: 'e2e-member-pin',
      },
    })
    expect(reply.outcome).toBe('applied')
    await until(() => member.perUser().includes(`pin:${memberPin}`))
    await member.replica.settled()
    for (const id of written) expect(member.perUser()).not.toContain(id)
    // And mine stay mine: the member's pin is not on my device.
    expect(b.perUser()).not.toContain(`pin:${memberPin}`)
  })
})
