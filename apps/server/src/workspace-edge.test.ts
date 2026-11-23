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

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIdentityCore, type WorkspaceIdentity } from '@podium/identity'
import { asUserId, newMemberId } from '@podium/model'
import { hashPassword, isPasswordHash, verifyPasswordHash } from '@podium/runtime/auth-store'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clientAuthGuard } from './auth-route'
import { createMemberOfRequest, type MemberOfRequest } from './identity/member-of-request'
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

const BOUND_ENTRIES = WORKSPACE_ENTRY_POINTS.filter((entry) => entry.binding !== 'unbound')
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
    for (const entry of WORKSPACE_ENTRY_POINTS) {
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
    ;[A, B] = await openWorkspaceStores(['ws_a', 'ws_b'])
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
    identityA = core.workspace(A.workspaceId, { rows: A.users.memberRows, sameDatabase: true })
    identityB = core.workspace(B.workspaceId, { rows: B.users.memberRows, sameDatabase: true })
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
    for (const entry of WORKSPACE_ENTRY_POINTS.filter((e) => e.binding === 'unbound')) {
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

describe('no handler reads a workspace from the request', () => {
  const root = fileURLToPath(new URL('.', import.meta.url))
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return name === 'test-support' ? [] : sources(path)
      return name.endsWith('.ts') && !name.includes('.test.') ? [path] : []
    })
  /** What a selector read looks like: the headers, the query, the path parameter. */
  const SELECTOR_READ =
    /Podium-Workspace|podium-workspace|(?:searchParams\.(?:get|getAll|has)|\.query|\.param)\(\s*['"]workspace['"]/

  it('reads the selector only at the edge', () => {
    const readers = sources(root)
      .filter((path) => SELECTOR_READ.test(readFileSync(path, 'utf8')))
      .map((path) => relative(root, path))
      .sort()
    // The artifact route compares its path segment with the BOUND workspace,
    // so a request bound to one workspace that names another is not found; it
    // never selects one.
    expect(readers).toEqual(['file-artifact-route.ts', 'workspace-edge.ts'])
  })
})
