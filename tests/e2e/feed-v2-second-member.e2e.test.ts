/**
 * POD-376 / POD-378 second-account check (PDM-432).
 *
 * `divergence-matrix.test.ts` and `removal-family.test.ts` already drive two
 * `FeedPrincipal` values through the shipped client consumer. They could not
 * evidence per-person isolation against the authenticator: one shared password
 * made two connections the same person. That premise is gone.
 *
 * These cases log in two members, then run the client consumer those files
 * own against a live `/client` socket whose upgrade cookie is the member's.
 * A private row of A must never appear on B's replica; a revoked share must
 * leave B as an evict, not a deletion, while A still holds the row.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FeedAuthorityClient,
  FeedSink,
  PushedBootstrapSource,
} from '@podium/client-core/replica/feed'
import { firstAdminMemberId } from '@podium/model'
import { type ServerMessage, WIRE_VERSION } from '@podium/protocol'
import { hashPassword } from '@podium/runtime/auth-store'
import { IndexedDbSyncStore, type IdbFactoryLike } from '@podium/sync/adapters/indexeddb'
import { Replica } from '@podium/sync/replica'
import type { FeedServerFrame } from '@podium/terminal-client'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { IDBFactory } from 'fake-indexeddb'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { noJanitorWorkerForTests } from '../../apps/server/src/janitor-host'
import type { AppRouter } from '../../apps/server/src/router'
import { startServer } from '../../apps/server/src/server'
import { defaultDbPath } from '../../apps/server/src/store'

const FEED_TYPES = new Set(['feedDelta', 'feedBootstrap', 'feedRescope', 'feedResyncRequired'])

const priorStateDir = process.env.PODIUM_STATE_DIR
const adminEmail = 'feed-admin@example.com'
const adminPassword = 'feed-admin-password'
const memberEmail = 'feed-member@example.com'
const memberPassword = 'feed-member-password'

describe('POD-376 · two authenticated persons, live v2 feed', () => {
  let stateDir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string
  let adminId: string
  let memberId: string
  let adminCookie: string
  let memberCookie: string
  let adminTrpc: ReturnType<typeof createTRPCClient<AppRouter>>
  let memberTrpc: ReturnType<typeof createTRPCClient<AppRouter>>
  let factory: IdbFactoryLike
  const sockets: WebSocket[] = []

  const url = (path: string) => `${baseUrl}${path}`
  const post = (path: string, body: unknown, cookie?: string) =>
    fetch(url(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    })

  async function readJson(response: Response): Promise<unknown> {
    const text = await response.text()
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error(`${response.status} ${response.url}: ${text}`)
    }
  }

  async function login(email: string, password: string, userId: string) {
    const response = await post('/auth/login', { email, password })
    const body = await readJson(response)
    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true, userId })
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toMatch(/^podium_session=.+/)
    return cookie!
  }

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-feed-v2-second-member-'))
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({ configVersion: 2, mode: 'all-in-one', persistence: 'systemd' }),
    )
    process.env.PODIUM_STATE_DIR = stateDir
    server = await startServer({
      dbPath: defaultDbPath(),
      port: 0,
      janitorWorkerForTests: noJanitorWorkerForTests,
    })
    baseUrl = `http://127.0.0.1:${server.port}`
    const users = server.registry.sessionStore.users
    adminId = await firstAdminMemberId(server.registry.sessionStore)
    await users.setEmail(adminId, adminEmail)
    await users.setPasswordHash(adminId, await hashPassword(adminPassword), new Date().toISOString())
    adminCookie = await login(adminEmail, adminPassword, adminId)
    const invited = await post(
      '/auth/members/invite',
      { email: memberEmail, role: 'member' },
      adminCookie,
    )
    const invitedBody = (await readJson(invited)) as { invite: { token: string } }
    expect(invited.status).toBe(200)
    const claimed = await post('/auth/members/complete', {
      token: invitedBody.invite.token,
      email: memberEmail,
      displayName: 'Feed Member',
      password: memberPassword,
    })
    const claimedBody = (await readJson(claimed)) as { userId: string }
    expect(claimed.status).toBe(200)
    memberId = claimedBody.userId
    expect(memberId).not.toBe(adminId)
    memberCookie = await login(memberEmail, memberPassword, memberId)
    adminTrpc = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `${baseUrl}/trpc`, headers: { cookie: adminCookie } })],
    })
    memberTrpc = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `${baseUrl}/trpc`, headers: { cookie: memberCookie } })],
    })
    factory = new IDBFactory() as unknown as IdbFactoryLike
  }, 60_000)

  afterAll(async () => {
    for (const s of sockets) s.close()
    await server?.close()
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    if (stateDir) rmSync(stateDir, { recursive: true, force: true })
  })

  const until = async (pred: () => boolean, ms = 8000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for condition')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  interface LiveClient {
    readonly replica: Replica
    readonly store: IndexedDbSyncStore
    readonly framesSeen: string[]
    keys(): string[]
  }

  async function openClient(
    name: string,
    cookie: string,
    trpc: ReturnType<typeof createTRPCClient<AppRouter>>,
  ): Promise<LiveClient> {
    const store = await IndexedDbSyncStore.open({
      factory,
      databaseName: `feed-second-member-${name}`,
      onDegraded: (d) => {
        throw new Error(`storage degraded during the e2e: ${JSON.stringify(d)}`)
      },
    })
    const view = store.viewFor('default')
    const framesSeen: string[] = []
    let socket: WebSocket | undefined

    const bootstraps = new PushedBootstrapSource({
      requestFreshWorld: () => {
        socket?.close()
        void openSocket()
      },
    })

    const replica = new Replica({
      store: view.cache,
      authority: new FeedAuthorityClient({
        fetchChangesSince: async (cursor) =>
          (await trpc.sync.feedChangesSince.query({ cursor })) as never,
        bootstraps,
      }),
    })
    const sink = new FeedSink({
      replica,
      bootstraps,
      onFrame: (kind) => framesSeen.push(kind),
    })

    async function openSocket(): Promise<void> {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/client?v=${WIRE_VERSION}`, {
        headers: { cookie },
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
              wireVersion: WIRE_VERSION,
            }),
          )
          resolve()
        })
      })
      sink.connected()
    }

    await openSocket()
    return {
      replica,
      store,
      framesSeen,
      keys: () =>
        replica
          .entities()
          .map((row) => `${row.entity}:${row.entityId}`)
          .sort(),
    }
  }

  async function sliceOf(trpc: ReturnType<typeof createTRPCClient<AppRouter>>): Promise<string[]> {
    const slice = await trpc.sync.feedSlice.query({})
    return slice.rows.map((r) => `${r.entity}:${r.entityId}`).sort()
  }

  it('a private row of user A never appears on user B’s client', async () => {
    const created = await adminTrpc.issues.create.mutate({
      repoPath: '/repo',
      title: 'alice-private',
      startNow: false,
    })
    const issueKey = `issue:${created.id}`

    const alice = await openClient('alice', adminCookie, adminTrpc)
    const bob = await openClient('bob', memberCookie, memberTrpc)
    await until(
      () => alice.framesSeen.includes('feedBootstrap') && bob.framesSeen.includes('feedBootstrap'),
    )
    await alice.replica.settled()
    await bob.replica.settled()

    // INSTRUMENT: both sockets actually received a world. Without this, Bob
    // holding nothing is indistinguishable from a client that never attached.
    expect(alice.replica.cursor).not.toBeNull()
    expect(bob.replica.cursor).not.toBeNull()

    const aliceSlice = await sliceOf(adminTrpc)
    const bobSlice = await sliceOf(memberTrpc)
    expect(aliceSlice).toContain(issueKey)
    expect(bobSlice).not.toContain(issueKey)
    expect(alice.keys()).toContain(issueKey)
    expect(bob.keys()).not.toContain(issueKey)
  })

  it('revoking a share evicts the row from B and leaves A holding it, not as a deletion', async () => {
    const created = await adminTrpc.issues.create.mutate({
      repoPath: '/repo',
      title: 'shared-then-revoked',
      startNow: false,
    })
    const issueKey = `issue:${created.id}`
    const grant = { id: created.id, grantee: memberId, verb: 'write' as const }
    await adminTrpc.issues.share.mutate(grant)

    const alice = await openClient('alice-revoke', adminCookie, adminTrpc)
    const bob = await openClient('bob-revoke', memberCookie, memberTrpc)
    await until(
      () => alice.framesSeen.includes('feedBootstrap') && bob.framesSeen.includes('feedBootstrap'),
    )
    await alice.replica.settled()
    await bob.replica.settled()
    await until(() => bob.keys().includes(issueKey), 8000)
    expect(alice.keys()).toContain(issueKey)

    await adminTrpc.issues.unshare.mutate(grant)
    await until(() => !bob.keys().includes(issueKey), 8000)
    await bob.replica.settled()
    await alice.replica.settled()

    expect(alice.keys()).toContain(issueKey)
    expect(bob.keys()).not.toContain(issueKey)
    expect((await sliceOf(adminTrpc)).includes(issueKey)).toBe(true)
    expect((await sliceOf(memberTrpc)).includes(issueKey)).toBe(false)
    // THE DISTINCTION the removal family exists for: gone-from-my-view is an
    // evict, not a domain deletion. A fold of evict into remove would still
    // empty Bob's keys and fail here.
    expect(bob.replica.exitKind('issue', created.id)).toBe('evicted')
    expect(alice.replica.exitKind('issue', created.id)).not.toBe('removed')
  })
})
