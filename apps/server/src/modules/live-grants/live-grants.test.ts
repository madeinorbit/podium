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
import { asMachineId, asSessionId, asUserId, type UserId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { userClientPrincipal } from '../../gateway/client-principal'
import { mayReachPrivate } from '../../issue-authz'
import {
  checkMachineVerb,
  machineUseDecision,
  machineVerbsFor,
  ownershipSnapshotFromMachines,
} from '../../machine-access'
import { SELF_HOSTED_WORKSPACE_ID } from '../../self-hosted-workspace'
import type { SessionStore } from '../../store'
import {
  ALICE,
  BOB,
  CAROL,
  grantEdge,
  grantSources,
  M_ALICE,
  M_PRIVATE,
  M_REVOKED,
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
import { session } from '../../test-support/workspace-seeds/sessions'
import { openWorkspaceStores } from '../../test-support/workspace-stores'
import {
  contextFromOwnership,
  controlSubjectFromClient,
  mayDrive,
  mayWatch,
} from '../sessions/session-control-policy'
import { DATABASE_RING_TTL_MS, liveGrantKeySource } from './keys'
import { registerLiveGrantRoutes } from './route'
import { clientGrantScopes } from './scopes'

let store: SessionStore
let sources: ReturnType<typeof grantSources>
beforeAll(async () => {
  store = await openTestStore(':memory:')
  await seedGrantWorld(store)
  sources = grantSources(store)
})
afterAll(async () => {
  sources.machines.dispose()
  await store.close()
})

const scopesFor = async (user: UserId) =>
  await clientGrantScopes(sources, principalOf(user), {
    sessions: SESSIONS,
    machines: MACHINES,
  })

const sorted = (list: readonly string[] | undefined) => [...(list ?? [])].sort()

describe('client grant scopes', () => {
  it('names only the sessions a member owns, and `use` only where they may run', async () => {
    const scopes = await scopesFor(ALICE)
    expect(Object.keys(scopes.sessions).sort()).toEqual(
      [S.aliceOnHers, S.aliceOnPrivate, S.aliceOnRevoked].sort(),
    )
    expect(sorted(scopes.sessions[S.aliceOnHers])).toEqual(['use', 'view'])
    // Her sessions on a machine she may not use, or on a revoked one: watched as a
    // record, never driven.
    expect(scopes.sessions[S.aliceOnPrivate]).toEqual(['view'])
    expect(scopes.sessions[S.aliceOnRevoked]).toEqual(['view'])
    // Every machine the workspace has is viewable, as its record is (review F6).
    expect(Object.keys(scopes.machines).sort()).toEqual(
      [M_ALICE, M_SHARED, M_PRIVATE, M_REVOKED].sort(),
    )
    expect(sorted(scopes.machines[M_ALICE])).toEqual(['manage', 'use', 'view'])
    expect(sorted(scopes.machines[M_SHARED])).toEqual(['use', 'view'])
    expect(scopes.machines[M_PRIVATE]).toEqual(['view'])
    // Revoked: her custody keeps the record in view, and nothing else.
    expect(scopes.machines[M_REVOKED]).toEqual(['view'])
    expect(scopes.roots).toEqual({ [M_ALICE]: ['/alice'], [M_SHARED]: ['/shared'] })
    // Her own machine's logins are hers; a `use` grant on Bob's makes Bob's plan not
    // hers, and a revoked machine's logins are nobody's.
    expect(scopes.logins).toEqual([M_ALICE])
  })

  it('gives an admin manage on every machine, but no use, no roots and no one else’s session', async () => {
    const scopes = await scopesFor(CAROL)
    expect(scopes.sessions).toEqual({})
    for (const machine of [M_ALICE, M_SHARED, M_PRIVATE, M_REVOKED]) {
      expect(sorted(scopes.machines[machine])).toEqual(['manage', 'view'])
    }
    expect(scopes.roots).toEqual({})
    expect(scopes.logins).toEqual([])
  })

  it('names exactly what the existing rules allow, action by action, for every member', async () => {
    const ownership = await ownershipSnapshotFromMachines(sources.machines)
    const facts = await store.sessions.bindingConfirmations(SESSIONS)
    for (const user of PEOPLE) {
      const principal = principalOf(user)
      const scopes = await scopesFor(user)
      for (const id of SESSIONS) {
        const fact = facts[id]!
        // The record rule: the owner reads it (sessions are private).
        const view = !fact.closed && mayReachPrivate(user, { id, owner: fact.owner })
        expect(id in scopes.sessions, `${user} ${id}`).toBe(view)
        if (!view || fact.owner === null || fact.machineId === null) continue
        // The live channel's rules: watching and typing (session-control-policy.ts).
        const subject = controlSubjectFromClient(userClientPrincipal('oracle', user, ROLE[user]!))
        const context = contextFromOwnership(
          { owner: asUserId(fact.owner) },
          machineUseDecision(principal, asMachineId(fact.machineId), ownership),
        )
        const watch = mayWatch(subject, context) === true
        expect(mayDrive(subject, context) === true, `${user} ${id} drive`).toBe(watch)
        expect(scopes.sessions[id]?.includes('use'), `${user} ${id} use`).toBe(watch)
      }
      for (const id of MACHINES) {
        const verbs = machineVerbsFor(principal, id, ownership)
        const exists = ownership.rowFor(id) !== undefined
        expect(id in scopes.machines, `${user} ${id}`).toBe(exists)
        expect(scopes.machines[id]?.includes('use') ?? false, `${user} ${id} use`).toBe(
          verbs.has('use'),
        )
        expect(scopes.machines[id]?.includes('manage') ?? false, `${user} ${id} manage`).toBe(
          verbs.has('manage'),
        )
        expect(id in scopes.roots, `${user} roots ${id}`).toBe(
          checkMachineVerb(principal, id, ownership, 'use') === undefined,
        )
      }
    }
    expect(Object.keys((await scopesFor(BOB)).sessions)).toEqual([S.bobOnShared])
  })

  it('follows a revoked share at the next grant', async () => {
    await store.grants.remove('machine', M_SHARED, ALICE, 'use')
    try {
      const scopes = await scopesFor(ALICE)
      expect(scopes.machines[M_SHARED]).toEqual(['view'])
      expect(scopes.roots[M_SHARED]).toBeUndefined()
    } finally {
      await grantEdge(store, 'machine', M_SHARED, ALICE, 'use', BOB)
    }
  })
})

describe('two workspaces in one database', () => {
  it('names nothing of workspace B in a grant asked of workspace A, even for the same people and ids', async () => {
    const [a, b] = await openWorkspaceStores(['ws_live_a', 'ws_live_b'], { path: ':memory:' })
    const inA = grantSources(a)
    const inB = grantSources(b)
    try {
      // B holds the whole world; A holds one session of its own and no machine.
      await seedGrantWorld(b)
      await a.sessions.upsertSessions(fixtureWriteScope(), [
        session('a', 6, { id: asSessionId('s-only-a'), ownerUserId: ALICE, machineId: M_ALICE }),
      ])
      const request = { sessions: [...SESSIONS, asSessionId('s-only-a')], machines: MACHINES }
      const fromA = await clientGrantScopes(inA, principalOf(ALICE), request)
      // A has no machine row: its own session is a record without a usable host.
      expect(fromA).toEqual({
        sessions: { 's-only-a': ['view'] },
        machines: {},
        roots: {},
        logins: [],
      })
      // The same request in B sees B's world, and not A's session.
      const fromB = await clientGrantScopes(inB, principalOf(ALICE), request)
      expect(Object.keys(fromB.sessions)).not.toContain('s-only-a')
      expect(sorted(fromB.sessions[S.aliceOnHers])).toEqual(['use', 'view'])
      expect(fromB.logins).toEqual([M_ALICE])
    } finally {
      inA.machines.dispose()
      inB.machines.dispose()
      await a.close()
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
      sources,
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
    expect(sorted([...grant.sessionIds()])).toEqual(
      sorted([S.aliceOnHers, S.aliceOnPrivate, S.aliceOnRevoked]),
    )
    expect(grant.allowsSession(S.bobOnShared, 'view')).toBe(false)
    expect(grant.allowsSession(S.aliceOnHers, 'use')).toBe(true)
    expect(grant.mayAskPath(M_SHARED, '/shared/src')).toBe(true)
    expect(grant.mayAskPath(M_PRIVATE, '/secret')).toBe(false)
    expect(grant.maySeeLogins(M_ALICE)).toBe(true)
    // Refused elsewhere: the audience is the bound workspace.
    expect(
      verifyLiveGrant(body.grant, {
        keys: ring.publicOnly(),
        workspace: 'ws_other',
        kind: 'client',
      }),
    ).toEqual({
      ok: false,
      refusal: 'wrong-workspace',
    })
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

  it('answers 413, by name, when a machine has more roots than a grant holds (review F7)', async () => {
    const app = new Hono()
    const roots = Array.from({ length: 1025 }, (_, i) => ({ machineId: M_ALICE, path: `/r${i}` }))
    registerLiveGrantRoutes(app, {
      member: async () => ({ principal: principalOf(ALICE), role: ROLE[ALICE]! }),
      workspaceOf: () => WS,
      storeWorkspace: WS,
      sources: { ...sources, repos: { listRepos: async () => roots } },
      keys: { ring: async () => ring },
    })
    const response = await post(app, { machines: [M_ALICE] })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'live grant too large', reason: 'roots' })
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
