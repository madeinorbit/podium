import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstAdminMemberId, MemberId } from '@podium/model'
import { CAP_SYNC_HTTP_V1, CLIENT_WIRE_VERSION } from '@podium/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { noJanitorWorkerForTests } from './janitor-host'
import { startServer } from './server'

/**
 * OPEN MODE IS A POLICY ON A MEMBER (A2, spec §8 "Open mode as a policy").
 *
 * With no credentials configured, an unauthenticated LOCAL request is served as
 * this instance's sole active member (on a fresh install, its first admin). What changed is where
 * the answer comes from. It used to synthesise `FIRST_ADMIN_USER_ID` — a
 * principal named by the build, which no row had to exist for. It now resolves
 * the earliest admin MEMBER, so the id it reports is one that a query returns
 * and a person could log in as.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS BOOTS A REAL SERVER
 * ---------------------------------------------------------------------------
 *
 * `requestPrincipal` is a closure inside `startServer`, and the policy it
 * implements is the composition of three things assembled there: the credential
 * lookup, the `loginRequired` predicate, and the locality of the request. A test
 * that reconstructed any of those would be asserting its own assembly. The same
 * reasoning `server.context-users.test.ts` records, for the same reason: a bug
 * shaped like "production and the tests assemble different contexts" is exactly
 * what a hand-built context cannot catch.
 *
 * `/auth/status` is the surface used because it REPORTS the resolver's answer —
 * `resolveUserId` in the composition root is the same resolver tRPC and the
 * WebSocket upgrade use — so the id it prints is the principal, not a proxy for
 * it.
 */
const priorStateDir = process.env.PODIUM_STATE_DIR

describe('open mode acts as the sole active member', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>>
  const url = (path: string): string => `http://127.0.0.1:${handle.port}${path}`

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-open-mode-'))
    // Configured before boot, or the readiness boundary answers `unconfigured`
    // and nothing reaches the resolver this file is about.
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({ configVersion: 2, mode: 'all-in-one', persistence: 'systemd' }),
    )
    process.env.PODIUM_STATE_DIR = stateDir
    handle = await startServer({ janitorWorkerForTests: noJanitorWorkerForTests, port: 0 })
  })

  afterAll(async () => {
    await handle.close()
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('serves a local unauthenticated request as a real mem_ member', async () => {
    const res = await fetch(url('/auth/status'))
    const body = (await res.json()) as { needsAuth: boolean; authed: boolean; userId?: string }

    expect(body.needsAuth, 'no credentials configured — this instance is in open mode').toBe(false)
    expect(body.authed).toBe(true)
    // Through the boundary schema: the point of A2 is that this is an ordinary
    // member id, not `'user:sole'` and not any other shape a build could invent.
    expect(() => MemberId.parse(body.userId)).not.toThrow()
  })

  it('names the member the database holds, not one it made up', async () => {
    // The counterfactual for the assertion above. A resolver that minted an id
    // per request would satisfy `MemberId.parse`; only equality with the row in
    // `users` says it RESOLVED one.
    const status = (await (await fetch(url('/auth/status'))).json()) as { userId?: string }
    const again = (await (await fetch(url('/auth/status'))).json()) as { userId?: string }
    expect(status.userId).toBe(again.userId)

    // `firstAdminMemberId()` is what the boot primed from this instance's
    // database — the same member, reached the other way round.
    expect(status.userId).toBe(firstAdminMemberId())
  })

  it('opens the /client socket for a local unauthenticated browser [POD-4664]', async () => {
    // The same principal over the other transport. Bun upgrades the request it
    // was handed, which never carries the native peer stamp the HTTP app reads, so
    // the locality clause judged the upgrade "not local" and every browser in open
    // mode sat on "Syncing your workspace" behind a 401 while `/auth/status`
    // above said it was authed.
    const opened = await new Promise<boolean>((resolve) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${handle.port}/client?v=${CLIENT_WIRE_VERSION}&cap=${CAP_SYNC_HTTP_V1}`,
      )
      socket.onopen = () => {
        socket.close()
        resolve(true)
      }
      socket.onerror = () => resolve(false)
      socket.onclose = () => resolve(false)
    })
    expect(opened).toBe(true)
  })

  it('gates the data plane on the same locality, not just the principal', async () => {
    // The guard and the resolver must agree about who open mode is open to. They
    // used to be one question — "is a password configured" — and the locality
    // clause splits it in two, which is exactly the shape that lets a gate pass a
    // caller the resolver then declines to name. That combination is a 500 where
    // the honest answer is "log in".
    const res = await fetch(url('/trpc/instance.info?input=%7B%7D'), {
      headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-host': 'podium.example.com' },
    })
    expect(res.status).toBe(401)
  })

  it('does not use open-mode authorization for pairing control or device management', async () => {
    expect((await fetch(url('/auth/client-sessions'))).status).toBe(401)
    for (const path of [
      'mobile-pair/status',
      'mobile-pair/approve',
      'mobile-pair/deny',
      'client-sessions/revoke',
    ]) {
      expect(
        (
          await fetch(url(`/auth/${path}`), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
      ).toBe(401)
    }
  })

  it('refuses a request that did not come from this host', async () => {
    // THE ONE BEHAVIOURAL CHANGE (spec §8). Open mode exists for loopback — the
    // all-in-one desktop's embedded server, where a password would be theatre.
    // Off box it was an unauthenticated data plane the boot log could only WARN
    // about; locality is part of the policy now, so it can be refused instead.
    //
    // The forwarding headers are how a request claims to have come from
    // elsewhere, and `isHostLocalRequest` reads them: a proxied caller is not
    // host-local however loopback the socket looks.
    const res = await fetch(url('/auth/status'), {
      headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-host': 'podium.example.com' },
    })
    const body = (await res.json()) as { authed: boolean; userId?: string }

    expect(body.authed).toBe(false)
    expect(body.userId).toBeUndefined()
  })
})

/**
 * MU-01 (POD-6285): open mode is one person's. It acts as the instance's SOLE
 * active member, and a second active member ends it, password or not. Before,
 * it acted as the earliest admin for as long as nobody had a password, so a
 * local request from anyone on a two-member instance was Alice's.
 */
describe('open mode ends once a second active member exists (MU-01)', () => {
  const boot = async (config: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-open-mode-mu01-'))
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ configVersion: 2, mode: 'all-in-one', persistence: 'systemd', ...config }),
    )
    process.env.PODIUM_STATE_DIR = dir
    const server = await startServer({ janitorWorkerForTests: noJanitorWorkerForTests, port: 0 })
    const status = async () =>
      (await (await fetch(`http://127.0.0.1:${server.port}/auth/status`)).json()) as {
        needsAuth: boolean
        authed: boolean
        userId?: string
      }
    const trpcStatus = async () =>
      (await fetch(`http://127.0.0.1:${server.port}/trpc/instance.info?input=%7B%7D`)).status
    const addBob = async () =>
      await server.registry.sessionStore.users.createUnclaimed({
        id: 'mem_bob_open_mode',
        displayName: 'Bob',
        email: 'bob@example.test',
        role: 'member',
        createdAt: new Date().toISOString(),
        disabledAt: null,
      })
    const close = async () => {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
    return { server, status, trpcStatus, addBob, close }
  }

  afterAll(() => {
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
  })

  it('a second member with no password ends open mode; disabling them restores it', async () => {
    const f = await boot({})
    try {
      // Control: one member, open mode as that member.
      const alone = await f.status()
      expect(alone).toMatchObject({ needsAuth: false, authed: true })
      expect(alone.userId).toBe(firstAdminMemberId())

      await f.addBob()
      const shared = await f.status()
      expect(shared.needsAuth).toBe(true)
      expect(shared.authed).toBe(false)
      expect(shared.userId).toBeUndefined()
      // The data plane agrees with the status route: log in.
      expect(await f.trpcStatus()).toBe(401)

      // A disabled member is not a second person who can act.
      await f.server.registry.sessionStore.users.disable(
        'mem_bob_open_mode' as never,
        new Date().toISOString(),
      )
      expect(await f.status()).toMatchObject({ needsAuth: false, authed: true, userId: alone.userId })
    } finally {
      await f.close()
    }
  })

  it('turning login off does not keep open mode once two members exist', async () => {
    const f = await boot({ auth: { openMode: true } })
    try {
      expect(await f.status()).toMatchObject({ needsAuth: false, authed: true })
      await f.addBob()
      expect(await f.status()).toMatchObject({ needsAuth: true, authed: false })
    } finally {
      await f.close()
    }
  })
})
