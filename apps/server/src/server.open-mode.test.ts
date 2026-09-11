import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstAdminMemberId, MemberId } from '@podium/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { noJanitorWorkerForTests } from './janitor-host'
import { startServer } from './server'

/**
 * OPEN MODE IS A POLICY ON A MEMBER (A2, spec §8 "Open mode as a policy").
 *
 * With no credentials configured, an unauthenticated LOCAL request is served as
 * this instance's first admin. That is what it always did; what changed is where
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

describe('open mode acts as the earliest admin member', () => {
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
