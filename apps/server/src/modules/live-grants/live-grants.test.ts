/**
 * Client grants from the server's rules (POD-7311 acceptance 2, first half):
 * the grant never names an id the member may not see, with private sessions
 * and machine grants; and the route and the key sources around it.
 *
 * Runs on both engines.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LiveGrantKeyRing,
  LiveGrantSigningUnavailable,
  mintLiveGrantKey,
  verifyLiveGrant,
} from '@podium/live-grants'
import type { UserId } from '@podium/model'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mayReachPrivate } from '../../issue-authz'
import { checkMachineVerb, ownershipSnapshotFromMachines } from '../../machine-access'
import { SELF_HOSTED_WORKSPACE_ID } from '../../self-hosted-workspace'
import type { SessionStore } from '../../store'
import {
  ALICE,
  BOB,
  CAROL,
  grantEdge,
  grantMachineSource,
  grantSources,
  M_ALICE,
  M_PRIVATE,
  M_SHARED,
  MACHINES,
  PEOPLE,
  principalOf,
  ROLE,
  S,
  SESSIONS,
  seedGrantWorld,
} from '../../test-support/live-grant-fixture'
import { openTestStore } from '../../test-support/open-test-store'
import { storeSql } from '../../test-support/store-sql'
import { DATABASE_RING_TTL_MS, liveGrantKeySource } from './keys'
import { registerLiveGrantRoutes } from './route'
import { clientGrantScopes } from './scopes'

let store: SessionStore
beforeAll(async () => {
  store = await openTestStore(':memory:')
  await seedGrantWorld(store)
})
afterAll(async () => {
  await store.close()
})

const scopesFor = async (user: UserId) =>
  await clientGrantScopes(grantSources(store), principalOf(user), {
    sessions: SESSIONS,
    machines: MACHINES,
  })

const sorted = (list: readonly string[] | undefined) => [...(list ?? [])].sort()

describe('client grant scopes', () => {
  it('names only the sessions a member owns, and `use` only where they may run', async () => {
    const scopes = await scopesFor(ALICE)
    expect(Object.keys(scopes.sessions).sort()).toEqual([S.aliceOnHers, S.aliceOnPrivate].sort())
    expect(sorted(scopes.sessions[S.aliceOnHers])).toEqual(['use', 'view'])
    // Her session on a machine she may not use: watched as a record, never driven.
    expect(scopes.sessions[S.aliceOnPrivate]).toEqual(['view'])
    expect(Object.keys(scopes.machines).sort()).toEqual([M_ALICE, M_SHARED].sort())
    expect(sorted(scopes.machines[M_ALICE])).toEqual(['manage', 'use', 'view'])
    expect(sorted(scopes.machines[M_SHARED])).toEqual(['use', 'view'])
    expect(scopes.roots).toEqual({ [M_ALICE]: ['/alice'], [M_SHARED]: ['/shared'] })
    // Her own machine's logins are hers; a `use` grant on Bob's makes Bob's plan not hers.
    expect(scopes.logins).toEqual([M_ALICE])
  })

  it('gives an admin manage on every machine, but no use, no roots and no one else’s session', async () => {
    const scopes = await scopesFor(CAROL)
    expect(scopes.sessions).toEqual({})
    for (const machine of [M_ALICE, M_SHARED, M_PRIVATE]) {
      expect(sorted(scopes.machines[machine])).toEqual(['manage', 'view'])
    }
    expect(scopes.roots).toEqual({})
    expect(scopes.logins).toEqual([])
  })

  it('never names an id the existing rules hide, for any member', async () => {
    const ownership = await ownershipSnapshotFromMachines(grantMachineSource(store))
    const facts = await store.sessions.bindingConfirmations(SESSIONS)
    for (const user of PEOPLE) {
      const scopes = await scopesFor(user)
      for (const id of SESSIONS) {
        const fact = facts[id]!
        const visible = !fact.closed && mayReachPrivate(user, { id, owner: fact.owner })
        expect(id in scopes.sessions, `${user} ${id}`).toBe(visible)
      }
      for (const id of MACHINES) {
        const verb = (v: 'see' | 'use') =>
          checkMachineVerb(principalOf(user), id, ownership, v) === undefined
        expect(id in scopes.machines, `${user} ${id}`).toBe(verb('see'))
        expect(id in scopes.roots, `${user} roots ${id}`).toBe(verb('use'))
      }
    }
    expect(Object.keys((await scopesFor(BOB)).sessions)).toEqual([S.bobOnShared])
  })

  it('follows a revoked share at the next grant', async () => {
    await store.grants.remove('machine', M_SHARED, ALICE, 'use')
    try {
      const scopes = await scopesFor(ALICE)
      expect(scopes.machines[M_SHARED]).toBeUndefined()
      expect(scopes.roots[M_SHARED]).toBeUndefined()
    } finally {
      await grantEdge(store, 'machine', M_SHARED, ALICE, 'use', BOB)
    }
  })
})

describe('POST /live/grant', () => {
  const WS = SELF_HOSTED_WORKSPACE_ID
  const ring = new LiveGrantKeyRing([mintLiveGrantKey('k-test')])

  function appFor(opts: { member?: UserId; keys?: { ring(): Promise<LiveGrantKeyRing> } }) {
    const app = new Hono()
    registerLiveGrantRoutes(app, {
      member: async () =>
        opts.member ? { principal: principalOf(opts.member), role: ROLE[opts.member]! } : undefined,
      workspaceOf: () => WS,
      storeWorkspace: WS,
      sources: grantSources(store),
      keys: opts.keys ?? { ring: async () => ring },
    })
    return app
  }

  const post = async (app: Hono, body: unknown) =>
    await app.request('/live/grant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  it('answers a signed grant naming what the member may see', async () => {
    const response = await post(appFor({ member: ALICE }), {
      sessions: SESSIONS,
      machines: MACHINES,
      connectionKey: 'thumb',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = (await response.json()) as { grant: string; expiresAt: number; refreshAt: number }
    const result = verifyLiveGrant(body.grant, {
      keys: ring.publicOnly(),
      workspace: WS,
      kind: 'client',
    })
    if (!result.ok) throw new Error(result.refusal)
    const grant = result.grant
    expect(grant.member).toBe(ALICE)
    expect(grant.role).toBe('member')
    expect(grant.connectionKey).toBe('thumb')
    expect(grant.expiresAt).toBe(body.expiresAt)
    expect(body.refreshAt).toBe(grant.issuedAt + (body.expiresAt - grant.issuedAt) / 2)
    expect(sorted([...grant.sessionIds()])).toEqual(sorted([S.aliceOnHers, S.aliceOnPrivate]))
    expect(grant.allowsSession(S.bobOnShared, 'view')).toBe(false)
    expect(grant.allowsSession(S.aliceOnHers, 'use')).toBe(true)
    expect(grant.mayAskPath(M_SHARED, '/shared/src')).toBe(true)
    expect(grant.mayAskPath(M_PRIVATE, '/secret')).toBe(false)
    expect(grant.maySeeLogins(M_ALICE)).toBe(true)
    // Refused elsewhere: the audience is the bound workspace.
    expect(verifyLiveGrant(body.grant, { keys: ring.publicOnly(), workspace: 'ws_other' })).toEqual(
      {
        ok: false,
        refusal: 'wrong-workspace',
      },
    )
  })

  it('refuses nobody, a bad body and too many ids', async () => {
    expect((await post(appFor({}), { sessions: [] })).status).toBe(401)
    const app = appFor({ member: ALICE })
    expect((await post(app, '{')).status).toBe(400)
    // The workspace is the binding, never the body's.
    expect((await post(app, { sessions: [], workspace: 'ws_other' })).status).toBe(400)
    const many = Array.from({ length: 1001 }, (_, i) => `s-${i}`)
    expect((await post(app, { sessions: many })).status).toBe(400)
  })

  it('answers 503 where no key is configured', async () => {
    const keys = liveGrantKeySource({ hosted: true, secrets: store.secrets })
    expect((await post(appFor({ member: ALICE, keys }), { sessions: [] })).status).toBe(503)
  })
})

describe('key sources', () => {
  it('hosted without a key file signs nothing and never mints one', async () => {
    const keys = liveGrantKeySource({ hosted: true, secrets: store.secrets })
    await expect(keys.ring()).rejects.toBeInstanceOf(LiveGrantSigningUnavailable)
    expect(await store.secrets.liveGrantKeys({})).toBeUndefined()
  })

  it('self-hosted mints one ring in the database, shared by every process, and reads a rotation live', async () => {
    let clock = 1_000_000
    const first = liveGrantKeySource({ hosted: false, secrets: store.secrets, now: () => clock })
    const second = liveGrantKeySource({ hosted: false, secrets: store.secrets, now: () => clock })
    const kid = (await first.ring()).signingKey()?.kid
    expect(kid).toBeDefined()
    expect((await second.ring()).signingKey()?.kid).toBe(kid)

    // An operator rotates: the new key first, the old one kept.
    const rotated = new LiveGrantKeyRing([mintLiveGrantKey('next'), ...(await first.ring()).keys])
    await storeSql(store).run(
      sql`UPDATE server_secrets SET value = ${rotated.toJson({ includePrivate: true })}
          WHERE key = 'liveGrants.signingKeys'`,
    )
    expect((await first.ring()).signingKey()?.kid).toBe(kid)
    clock += DATABASE_RING_TTL_MS
    expect((await first.ring()).signingKey()?.kid).toBe('next')
    expect((await first.ring()).publicKey(kid!)).toBeDefined()
  })

  it('reads a configured key file, and refuses one with no private key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-grant-keys-'))
    try {
      const path = join(dir, 'keys.json')
      const ring = new LiveGrantKeyRing([mintLiveGrantKey('file-key')])
      writeFileSync(path, ring.toJson({ includePrivate: true }))
      const keys = liveGrantKeySource({ file: path, hosted: true, secrets: store.secrets })
      expect((await keys.ring()).signingKey()?.kid).toBe('file-key')
      writeFileSync(path, ring.toJson({ includePrivate: false }))
      expect(() =>
        liveGrantKeySource({ file: path, hosted: true, secrets: store.secrets }),
      ).toThrow(LiveGrantSigningUnavailable)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
