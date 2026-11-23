/**
 * THE WORKSPACE EDGE (POD-7309; workspace-edge.ts).
 *
 * Two workspaces in one database, served by one edge: the test builds the two
 * workspaces' stores and member resolvers by hand over ONE identity core with
 * ONE signing secret, as a hosted process holds it (POD-6954 design 4.2;
 * production still serves the one workspace it loaded). Behind the edge stand
 * the real admission steps of each entry point's class: the client guard on
 * `member` routes, the signed-in gate on the people routes.
 */

import { createHash } from 'node:crypto'
import { createIdentityCore, type WorkspaceIdentity } from '@podium/identity'
import { asUserId, newMemberId } from '@podium/model'
import { decodePairingEnvelope } from '@podium/protocol'
import { hashPassword, isPasswordHash, verifyPasswordHash } from '@podium/runtime/auth-store'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clientAuthGuard, registerAuthRoute } from './auth-route'
import { createMemberOfRequest, type MemberOfRequest } from './identity/member-of-request'
import { identitySeamDeps } from './identity/server-identity'
import { registerMcpRoute } from './mcp-route'
import { registerMemberRoutes } from './member-routes'
import { registerMobilePairingRoutes } from './mobile-pairing-route'
import { SELF_HOSTED_WORKSPACE_ID } from './self-hosted-workspace'
import type { SessionStore } from './store'
import { memberFacts } from './store/fixtures/test-support'
import { cookieOf, httpsFacts } from './test-support/test-identity'
import { testWorkspaceId } from './test-support/workspace-binding'
import { openWorkspaceStores } from './test-support/workspace-stores'
import {
  boundMemberOfRequest,
  createWorkspaceEdge,
  type EntryPoint,
  entryPointOf,
  fallbackEntry,
  maybeBoundServedWorkspaceOf,
  readWorkspaceSelectors,
  type ServedWorkspace,
  WORKSPACE_ENTRY_POINTS,
  type WorkspaceEdge,
} from './workspace-edge'

const ORIGIN = 'https://podium.test'

/** A concrete path an entry point answers. */
function samplePath(entry: EntryPoint): string {
  if (entry.path.endsWith('/')) return `${entry.path}sample`
  return entry.path
}

/** The rows a request can reach (not a hook or the unix control socket). */
const ROUTED = WORKSPACE_ENTRY_POINTS.filter(
  (entry) => entry.transport === 'http' || entry.transport === 'socket',
)
const BOUND_ENTRIES = ROUTED.filter((entry) => entry.binding !== 'unbound')
const HTTP_BOUND = BOUND_ENTRIES.filter((entry) => entry.transport === 'http')
const SOCKETS = BOUND_ENTRIES.filter((entry) => entry.transport === 'socket')

describe('the entry-point table', () => {
  it('says how every entry point is bound, or why it is not', () => {
    for (const entry of WORKSPACE_ENTRY_POINTS) expect(entry.why.length).toBeGreaterThan(10)
    const unbound = WORKSPACE_ENTRY_POINTS.filter((e) => e.binding === 'unbound').map((e) => e.path)
    expect(unbound).toEqual(
      expect.arrayContaining(['/health', '/version', '/.well-known/', '/readiness']),
    )
  })

  it('finds every row by its own path, the narrower row first', () => {
    for (const entry of ROUTED) {
      expect(entryPointOf('POST', samplePath(entry), entry.transport === 'socket')).toBe(entry)
    }
    expect(entryPointOf('POST', '/auth/members/complete', false).binding).toBe('credential')
    expect(entryPointOf('POST', '/auth/members/list', false).binding).toBe('signed-in')
    expect(entryPointOf('GET', '/.well-known/podium/locate', false).binding).toBe('unbound')
    // A socket path reached without an upgrade is an ordinary request.
    expect(entryPointOf('GET', '/client', false)).toEqual(fallbackEntry('GET'))
  })

  it('leaves page loads unbound and binds any other route nobody listed', () => {
    expect(entryPointOf('GET', '/w/acme/issues', false).binding).toBe('unbound')
    expect(entryPointOf('POST', '/some/new/route', false).binding).toBe('member')
  })
})

describe('reading the selector', () => {
  const read = (path: string, headers: Record<string, string> = {}) =>
    readWorkspaceSelectors(new Request(`${ORIGIN}${path}`, { headers }))

  it("reads the hosted router's order: id header, header, query, artifact path", () => {
    expect(
      read('/files/artifact/workspace/d/iss/art/x?workspace=c', {
        'Podium-Workspace-Id': 'a',
        'Podium-Workspace': 'b',
      }),
    ).toEqual({
      kind: 'selectors',
      selectors: [
        { source: 'id-header', value: 'a' },
        { source: 'header', value: 'b' },
        { source: 'query', value: 'c' },
        { source: 'artifact-path', value: 'd' },
      ],
    })
    expect(read('/trpc/x')).toEqual({ kind: 'selectors', selectors: [] })
  })

  it('refuses an empty, repeated or undecodable selector', () => {
    expect(read('/trpc/x', { 'Podium-Workspace': ' ' }).kind).toBe('invalid')
    expect(read('/trpc/x?workspace=a&workspace=b').kind).toBe('invalid')
    expect(read('/files/artifact/workspace/%E0%A4%A/iss/art/x').kind).toBe('invalid')
  })
})

const PASSWORDS = { alice: 'alice password 1', bea: 'bea password 22' }

describe('hosted edge, two workspaces in one database', () => {
  let A: SessionStore
  let B: SessionStore
  let identityA: WorkspaceIdentity
  let identityB: WorkspaceIdentity
  let servedA: ServedWorkspace
  let servedB: ServedWorkspace
  let edge: WorkspaceEdge
  let memberOfRequest: MemberOfRequest
  let aliceCookie: string
  let beaCookie: string

  async function admin(
    identity: WorkspaceIdentity,
    store: SessionStore,
    name: string,
    password: string,
  ): Promise<string> {
    const email = `${name.toLowerCase()}@example.test`
    const view = await identity.memberships.adopt({
      by: 'setup',
      role: 'admin',
      status: 'active',
      account: { kind: 'new', name, email, password },
    })
    await identity.catchUp()
    // A shared-account edition signs in only an address that was verified.
    const accountId = (await store.users.get(asUserId(view.memberId)))?.accountId
    if (!accountId) throw new Error(`${name} has no account`)
    await memberFacts(store).verifyAccountEmail(accountId)
    const issued = await identity.core.signIn.password(
      { email, password, device: { kind: 'browser' }, delivery: 'cookie' },
      httpsFacts(),
    )
    if ('refused' in issued) throw new Error(`${name} could not sign in: ${issued.refused}`)
    return cookieOf(issued)
  }

  beforeEach(async () => {
    ;[A, B] = await openWorkspaceStores(['ws_a', 'ws_b'], { path: ':memory:' })
    // ONE core and ONE secret for the process, as on hosted.
    const core = await createIdentityCore({
      database: A.identityDatabase(),
      secret: 'workspace-edge-test-secret-0123456789abcdef',
      loginMethods: { password: true },
      mail: null,
      selfSignUp: false,
      accounts: 'shared',
      hosts: { kind: 'self-hosted' },
      sameMachine: null,
      passwordHashing: {
        hash: hashPassword,
        verify: ({ password, hash }) => verifyPasswordHash(password, hash),
        isHash: isPasswordHash,
      },
      rateLimit: { storage: 'memory' },
      newMemberId,
    })
    // As on hosted, the memberships are the core's and each workspace's member
    // rows are applied after the commit, by its own catch-up.
    const bind = (store: SessionStore) => {
      const deps = identitySeamDeps(store)
      return core.workspace(store.workspaceId, {
        rows: deps.memberRows,
        sameDatabase: false,
        cursor: deps.appliedCursor,
      })
    }
    identityA = bind(A)
    identityB = bind(B)
    aliceCookie = await admin(identityA, A, 'Alice', PASSWORDS.alice)
    beaCookie = await admin(identityB, B, 'Bea', PASSWORDS.bea)
    const resolver = (identity: WorkspaceIdentity, store: SessionStore) =>
      createMemberOfRequest({ identity, users: store.users, trustedProxyHops: 0 })
    servedA = { id: A.workspaceId, slug: 'acme', memberOfRequest: resolver(identityA, A) }
    servedB = { id: B.workspaceId, slug: 'beta', memberOfRequest: resolver(identityB, B) }
    edge = createWorkspaceEdge({ mode: 'hosted', served: [servedA, servedB] })
    memberOfRequest = boundMemberOfRequest(edge)
  })

  afterEach(async () => {
    await A.close()
  })

  /** The edge, each class's admission step, and a handler that says where it landed. */
  function app(): Hono {
    const hono = new Hono()
    hono.use('*', edge.middleware)
    const guard = clientAuthGuard({ memberOfRequest, renew: async () => new Headers() })
    for (const prefix of ['/trpc/*', '/sync/*', '/files/*']) hono.use(prefix, guard)
    hono.use('/auth/*', edge.signedInGate)
    // A route nobody listed is bound and members only, by the same guard.
    hono.use('/some/*', guard)
    hono.all('*', (c) => c.json({ bound: maybeBoundServedWorkspaceOf(c.req.raw)?.id ?? null }))
    return hono
  }

  const call = (path: string, headers: Record<string, string>) =>
    app().request(`${ORIGIN}${path}`, { method: 'POST', headers })

  /** A socket upgrade as the server judges it: the edge, then the member for /client. */
  async function upgrade(path: string, headers: Record<string, string>) {
    const request = new Request(`${ORIGIN}${path}`, { headers })
    const answer = await edge.bind(request, true)
    if (answer.kind !== 'bound') return answer
    if (answer.entry.binding !== 'member') return answer
    const member = await memberOfRequest(request)
    return member.kind === 'member' ? answer : { kind: 'refused' as const, member }
  }

  it('refuses every bound entry point a request without a selector', async () => {
    for (const entry of [...HTTP_BOUND, fallbackEntry('POST')]) {
      const path = entry.path === '*' ? '/some/route' : samplePath(entry)
      const response = await call(path, { cookie: aliceCookie })
      expect(response.status, path).toBe(400)
      expect(await response.json(), path).toMatchObject({ error: 'workspace_required' })
    }
    for (const entry of SOCKETS) {
      const answer = await upgrade(entry.path, { cookie: aliceCookie })
      expect(answer, entry.path).toMatchObject({
        kind: 'refused',
        refusal: { status: 400, body: { error: 'workspace_required' } },
      })
    }
  })

  it('refuses a workspace this process has not loaded, on every bound entry point', async () => {
    for (const entry of HTTP_BOUND) {
      const response = await call(samplePath(entry), {
        cookie: aliceCookie,
        'Podium-Workspace': 'ws_not_loaded',
      })
      expect(response.status, entry.path).toBe(404)
      expect(await response.json(), entry.path).toMatchObject({ error: 'workspace_not_served' })
    }
    for (const entry of SOCKETS) {
      expect(
        await upgrade(`${entry.path}?workspace=ws_not_loaded`, { cookie: aliceCookie }),
      ).toMatchObject({ kind: 'refused', refusal: { status: 404 } })
    }
  })

  it('refuses a member of A who names B on every member and signed-in entry point', async () => {
    for (const entry of HTTP_BOUND.filter((e) => e.binding !== 'credential')) {
      for (const naming of [
        { 'Podium-Workspace': 'beta' },
        { 'Podium-Workspace-Id': 'ws_b' },
      ] as Record<string, string>[]) {
        const response = await call(samplePath(entry), { cookie: aliceCookie, ...naming })
        expect(response.status, entry.path).toBe(403)
        expect(await response.json(), entry.path).toMatchObject({ error: 'not_workspace_member' })
      }
    }
    expect(await upgrade('/client?workspace=ws_b', { cookie: aliceCookie })).toMatchObject({
      kind: 'refused',
      member: { kind: 'not-a-member' },
    })
    // The member routes nobody listed are refused the same way.
    expect(
      (await call('/some/route', { cookie: aliceCookie, 'Podium-Workspace': 'beta' })).status,
    ).toBe(403)
  })

  it('binds a credential entry point to the workspace it names, which then proves the credential there', async () => {
    for (const entry of HTTP_BOUND.filter((e) => e.binding === 'credential')) {
      const response = await call(samplePath(entry), {
        cookie: aliceCookie,
        'Podium-Workspace': 'beta',
      })
      expect(await response.json(), entry.path).toEqual({ bound: 'ws_b' })
    }
    for (const entry of SOCKETS.filter((e) => e.binding === 'credential')) {
      expect(await upgrade(`${entry.path}?workspace=ws_b`, {})).toMatchObject({
        kind: 'bound',
        workspace: { id: 'ws_b' },
      })
    }
  })

  it('admits a member to their own workspace, named by id or by slug, and binds it', async () => {
    for (const entry of HTTP_BOUND) {
      for (const naming of [
        { 'Podium-Workspace': 'acme' },
        { 'Podium-Workspace': 'ws_a' },
        { 'Podium-Workspace-Id': 'ws_a' },
      ] as Record<string, string>[]) {
        const response = await call(samplePath(entry), { cookie: aliceCookie, ...naming })
        expect(response.status, entry.path).toBe(200)
        expect(await response.json(), entry.path).toEqual({ bound: 'ws_a' })
      }
    }
    // The member resolution carries the workspace it was resolved in.
    const own = new Request(`${ORIGIN}/trpc/x`, {
      headers: { cookie: aliceCookie, 'Podium-Workspace': 'acme' },
    })
    await edge.bind(own)
    expect(await memberOfRequest(own)).toMatchObject({ kind: 'member', workspaceId: 'ws_a' })
    expect(await upgrade('/client?workspace=acme', { cookie: aliceCookie })).toMatchObject({
      kind: 'bound',
      workspace: { id: 'ws_a' },
    })
    // And the other way round: B's member in B, refused in A.
    expect((await call('/trpc/x', { cookie: beaCookie, 'Podium-Workspace': 'beta' })).status).toBe(
      200,
    )
    expect((await call('/trpc/x', { cookie: beaCookie, 'Podium-Workspace': 'acme' })).status).toBe(
      403,
    )
  })

  it('classifies the decoded path Hono routes, so a percent-encoded path is no way around it (review F1)', async () => {
    /** The row's sample path with its first letter percent-encoded. */
    const encoded = (path: string) =>
      path.replace(
        /^(\/(?:auth\/)?)([a-z])/,
        (_m, head: string, letter: string) => `${head}%${letter.charCodeAt(0).toString(16)}`,
      )
    const named = [
      '/%66iles/asset',
      '/%74rpc/machines.list',
      '/%73ync/bootstrap',
      '/%6cive/grant',
      '/auth/%6dobile-pair/start',
    ]
    const paths = [...named, ...HTTP_BOUND.map((entry) => encoded(samplePath(entry)))]
    for (const path of paths) {
      expect(path, path).toMatch(/%/)
      for (const method of ['GET', 'POST']) {
        const none = await app().request(`${ORIGIN}${path}`, {
          method,
          headers: { cookie: aliceCookie },
        })
        expect(none.status, `${method} ${path}`).toBe(400)
        expect(await none.json(), path).toMatchObject({ error: 'workspace_required' })
      }
    }
    // Named B: refused as the canonical path is, on every member and signed-in row.
    for (const path of [
      '/%66iles/asset',
      '/%74rpc/x',
      '/%73ync/bootstrap',
      '/%6cive/grant',
      '/auth/%6dobile-pair/start',
      '/auth/%6dembers/list',
      '/auth/%61dmin/viewer',
    ]) {
      const response = await call(path, { cookie: aliceCookie, 'Podium-Workspace': 'beta' })
      expect(response.status, path).toBe(403)
    }
  })

  it('binds an unlisted GET on hosted and admits only a member, except the static files (review F2)', async () => {
    expect(
      (await app().request(`${ORIGIN}/some/route`, { headers: { cookie: aliceCookie } })).status,
    ).toBe(400)
    const named = (headers: Record<string, string>) =>
      app().request(`${ORIGIN}/some/route`, { headers: { 'Podium-Workspace': 'acme', ...headers } })
    expect((await named({})).status).toBe(401)
    expect((await named({ cookie: beaCookie })).status).toBe(403)
    expect(await (await named({ cookie: aliceCookie })).json()).toEqual({ bound: 'ws_a' })
    for (const path of ['/', '/w/acme/issues', '/mobile/', '/assets/index-1.js', '/icon.png']) {
      expect(await (await app().request(`${ORIGIN}${path}`)).json(), path).toEqual({ bound: null })
    }
    expect(entryPointOf('GET', '/some/route', false, 'hosted').binding).toBe('member')
    expect(entryPointOf('GET', '/some/route', false, 'self-hosted').binding).toBe('unbound')
  })

  it('resolves an unbound request on hosted as nobody, whatever it carries (review F1)', async () => {
    const page = new Request(`${ORIGIN}/w/acme/issues`, { headers: { cookie: aliceCookie } })
    expect(await edge.bind(page)).toMatchObject({ kind: 'unbound' })
    expect(await memberOfRequest(page)).toEqual({ kind: 'unauthenticated' })
  })

  it('matches a plugin row after the server rows, never before them', () => {
    const plugin = [
      { transport: 'http', path: '/hooks/', binding: 'credential', why: 'a plugin webhook' },
      { transport: 'http', path: '/trpc/', binding: 'unbound', why: 'a plugin trying to shadow' },
    ] as const
    expect(entryPointOf('POST', '/hooks/stripe', false, 'hosted', plugin).binding).toBe(
      'credential',
    )
    expect(entryPointOf('POST', '/trpc/x', false, 'hosted', plugin).binding).toBe('member')
  })

  it('does not let the id header name a workspace by its slug', async () => {
    const response = await call('/trpc/x', { cookie: aliceCookie, 'Podium-Workspace-Id': 'acme' })
    expect(response.status).toBe(404)
  })

  it('refuses a request whose selectors name two workspaces', async () => {
    const response = await call('/trpc/x?workspace=ws_b', {
      cookie: aliceCookie,
      'Podium-Workspace': 'acme',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'workspace_selector_conflict' })
    const artifact = await call('/files/artifact/workspace/beta/iss/art/x', {
      cookie: aliceCookie,
      'Podium-Workspace': 'acme',
    })
    expect(artifact.status).toBe(400)
  })

  it('passes unbound routes and CORS preflights through without a selector or binding', async () => {
    for (const entry of ROUTED.filter((e) => e.binding === 'unbound')) {
      const response = await call(samplePath(entry), {})
      expect(await response.json(), entry.path).toEqual({ bound: null })
    }
    const page = await app().request(`${ORIGIN}/w/acme/issues`)
    expect(await page.json()).toEqual({ bound: null })
    const preflight = await app().request(`${ORIGIN}/trpc/x`, { method: 'OPTIONS' })
    expect(await preflight.json()).toEqual({ bound: null })
  })

  it('does not accept a sign-in made for workspace A in workspace B (one core, one secret)', async () => {
    const request = new Request(`${ORIGIN}/trpc/x`, { headers: { cookie: aliceCookie } })
    // The same signed token, valid for the process, resolved in each workspace.
    expect(await identityA.resolve(request, httpsFacts())).toMatchObject({ kind: 'member' })
    expect(await identityB.resolve(request, httpsFacts())).toMatchObject({
      kind: 'not-a-member',
      membership: 'none',
    })
    expect(await servedB.memberOfRequest(request)).toMatchObject({ kind: 'not-a-member' })
    // The same holds the other way round, for B's sign-in in A.
    const bea = new Request(`${ORIGIN}/trpc/x`, { headers: { cookie: beaCookie } })
    expect(await identityA.resolve(bea, httpsFacts())).toMatchObject({ kind: 'not-a-member' })
  })

  /**
   * THE REAL CREDENTIAL ROUTES (review F3). One app per loaded workspace with
   * that workspace's own sign-in, invitation, pairing and MCP routes, behind
   * one edge that dispatches each request to its bound workspace's app, as a
   * process holding one registry per workspace would.
   */
  describe('credential routes of the bound workspace', () => {
    const SECRET = Buffer.alloc(32, 7)
    const CLAIM_HASH = createHash('sha256').update(SECRET).digest('hex')
    const MCP_TOKEN = { ws_a: 'mcp-token-of-a', ws_b: 'mcp-token-of-b' } as const

    function workspaceApp(store: SessionStore, identity: WorkspaceIdentity): Hono {
      const sub = new Hono()
      const memberOfAccount = (id: string) => store.users.findMemberByAccount(id)
      registerAuthRoute(sub, {
        identity,
        memberOfRequest,
        memberOfAccount,
        syncBoundaryId: (request) => maybeBoundServedWorkspaceOf(request)?.id,
      })
      registerMemberRoutes(sub, {
        users: store.users,
        identity,
        resolveUserId: async (request) => {
          const member = await memberOfRequest(request)
          return member.kind === 'member' ? member.memberId : undefined
        },
        appUrl: () => ORIGIN,
      })
      registerMobilePairingRoutes(sub, {
        identity,
        memberOfRequest,
        memberOfAccount,
        serverIdentity: () => ({
          publicUrl: ORIGIN,
          instanceId: 'instance',
          workspaceId: store.workspaceId,
        }),
      })
      registerMcpRoute(
        sub,
        { mcpToolSpecs: async () => [], callMcpTool: async () => 'called' },
        MCP_TOKEN[store.workspaceId as keyof typeof MCP_TOKEN],
      )
      return sub
    }

    function server(): Hono {
      const apps = new Map([
        [A.workspaceId as string, workspaceApp(A, identityA)],
        [B.workspaceId as string, workspaceApp(B, identityB)],
      ])
      const hono = new Hono()
      hono.use('*', edge.middleware)
      hono.use('/auth/*', edge.signedInGate)
      hono.all('*', async (c) => {
        const bound = maybeBoundServedWorkspaceOf(c.req.raw)
        const app = bound && apps.get(bound.id)
        return app ? await app.fetch(c.req.raw) : c.json({ error: 'unbound' }, 404)
      })
      return hono
    }

    const post = (path: string, naming: string, body: unknown, headers = {}) =>
      server().request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Podium-Workspace': naming, ...headers },
        body: JSON.stringify(body),
      })

    it("refuses A's password at B's login, and signs in at A's", async () => {
      const login = { email: 'alice@example.test', password: PASSWORDS.alice }
      const inB = await post('/auth/login', 'beta', login)
      expect(inB.status).toBe(401)
      expect(await inB.json()).toEqual({ error: 'invalid password' })
      expect(inB.headers.getSetCookie()).toEqual([])
      const inA = await post('/auth/login', 'acme', login)
      expect(inA.status).toBe(200)
      expect(await inA.json()).toMatchObject({ ok: true, syncBoundaryId: 'ws_a' })
    })

    it("reports A's sign-in as no member at B's status, and as A's member at A's", async () => {
      const status = (naming: string) =>
        server().request(`${ORIGIN}/auth/status`, {
          headers: { cookie: aliceCookie, 'Podium-Workspace': naming },
        })
      const inB = await (await status('beta')).json()
      expect(inB).toMatchObject({ authed: false, denied: 'not_workspace_member' })
      expect(inB.syncBoundaryId).toBeUndefined()
      expect(await (await status('acme')).json()).toMatchObject({
        authed: true,
        syncBoundaryId: 'ws_a',
      })
    })

    it("finds no invitation of A at B's inspect and complete", async () => {
      const alice = (await A.users.earliestAdmin())?.id
      if (!alice) throw new Error('A has no admin')
      const { invitation } = await identityA.memberships.invite({
        actor: { memberId: alice },
        role: 'member',
        email: 'carol@example.test',
      })
      const inspectB = await post('/auth/members/inspect', 'beta', { token: invitation.token })
      expect(inspectB.status).toBe(400)
      const completeB = await post('/auth/members/complete', 'beta', {
        token: invitation.token,
        email: 'carol@example.test',
        password: 'carol password 1',
        displayName: 'Carol',
      })
      expect(completeB.status).toBe(400)
      const emailsOfB = (await identityB.memberships.list()).map((m) => m.account?.email)
      expect(emailsOfB).not.toContain('carol@example.test')
      const inspectA = await post('/auth/members/inspect', 'acme', { token: invitation.token })
      expect(inspectA.status).toBe(200)
      expect(await inspectA.json()).toMatchObject({ kind: 'invitation' })
    })

    it("never pairs a phone into B for A's member: B's gate refuses them, B's completion revokes the sign-in", async () => {
      const start = await post('/auth/mobile-pair/start', 'acme', {}, { cookie: aliceCookie })
      expect(start.status).toBe(200)
      const started = (await start.json()) as { pairingId: string; envelope: string }
      const envelope = decodePairingEnvelope(started.envelope)
      if (envelope.v !== 2 || envelope.mode !== 'pair') throw new Error('wrong envelope')
      // The envelope names the workspace the pairing was started in.
      expect(envelope).toMatchObject({ workspaceId: 'ws_a' })
      // Starting, reading and approving in B are refused for A's member.
      for (const path of ['/auth/mobile-pair/start', '/auth/mobile-pair/approve']) {
        const refused = await post(
          path,
          'beta',
          { pairingId: started.pairingId },
          {
            cookie: aliceCookie,
          },
        )
        expect(refused.status, path).toBe(403)
        expect(await refused.json(), path).toMatchObject({ error: 'not_workspace_member' })
      }
      // The code is the account's, so a phone can claim it through B.
      const claim = await post('/auth/mobile-pair/claim', 'beta', {
        pairCode: envelope.pairCode,
        claimHash: CLAIM_HASH,
        deviceId: 'device-1',
        deviceName: 'Phone',
        platform: 'ios',
        delivery: 'browser',
      })
      expect(claim.status).toBe(200)
      const { claimId } = (await claim.json()) as { claimId: string }
      const approved = await post(
        '/auth/mobile-pair/approve',
        'acme',
        { pairingId: started.pairingId },
        { cookie: aliceCookie },
      )
      expect(approved.status).toBe(200)
      const complete = await post('/auth/mobile-pair/complete', 'beta', {
        claimId,
        claimSecret: SECRET.toString('base64url'),
      })
      // B's completion finds no member of B for the account: it revokes the
      // sign-in it just made and answers as for any unusable code.
      expect(complete.status).toBe(400)
      const alice = await A.users.earliestAdmin()
      const accountId = alice ? (await A.users.get(asUserId(alice.id)))?.accountId : undefined
      if (!accountId) throw new Error('Alice has no account')
      const phones = (await identityA.core.deviceSignIns.listForAccount(accountId)).filter(
        (signIn) => signIn.kind === 'phone',
      )
      expect(phones).toEqual([])
    })

    it("refuses A's MCP token at B's /mcp", async () => {
      const call = (naming: string, token: string) =>
        post(
          '/mcp',
          naming,
          { jsonrpc: '2.0', id: 1, method: 'tools/list' },
          { authorization: `Bearer ${token}` },
        )
      expect((await call('beta', MCP_TOKEN.ws_a)).status).toBe(401)
      expect((await call('acme', MCP_TOKEN.ws_a)).status).toBe(200)
      expect((await call('beta', MCP_TOKEN.ws_b)).status).toBe(200)
    })
  })
})

describe('self-hosted edge', () => {
  const served: ServedWorkspace = {
    id: SELF_HOSTED_WORKSPACE_ID,
    slug: null,
    memberOfRequest: Object.assign(async () => ({ kind: 'unauthenticated' as const }), {
      factsOf: () => ({ scheme: 'https' as const, sameMachine: false, clientAddress: null }),
    }),
  }

  it('binds every request to its one workspace and reads no selector', async () => {
    const edge = createWorkspaceEdge({ mode: 'self-hosted', served: [served] })
    for (const headers of [
      {},
      { 'Podium-Workspace': 'some-slug' },
      { 'Podium-Workspace-Id': 'ws_x' },
    ] as Record<string, string>[]) {
      const answer = await edge.bind(new Request(`${ORIGIN}/trpc/x?workspace=other`, { headers }))
      expect(answer).toMatchObject({ kind: 'bound', workspace: { id: SELF_HOSTED_WORKSPACE_ID } })
    }
  })

  it('refuses to serve more than one workspace', () => {
    expect(() =>
      createWorkspaceEdge({
        mode: 'self-hosted',
        served: [served, { ...served, id: testWorkspaceId('ws_b') }],
      }),
    ).toThrow(/exactly one/)
  })
})
