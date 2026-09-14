/**
 * THE RAW ROUTE POPULATION GATE (PDM-353) — every door this server answers on
 * outside tRPC is classified, and the population is derived from THE ROUTE TABLE
 * THIS SERVER ACTUALLY SERVES rather than from a list anyone maintains.
 *
 * This is `projection-census.test.ts`'s argument applied to the other transport.
 * That file governs the tRPC read surface and says so at its own line 64: the
 * raw HTTP, WebSocket and file-route families are outside it. The audit that
 * covered them instead — the raw-HTTP section of
 * `docs/gates/pdm-248-served-read-census.md` — is HAND-READ ("Each row below was
 * read at this pin"), so it has no way to notice a route added after it was
 * written. It did not notice: six `/updates/feed/dev/*` routes and two of the
 * three `/mcp` methods are served and absent from it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE BOOTS A SERVER
 * ---------------------------------------------------------------------------
 *
 * `appRouter` is a module-level object, so the tRPC census costs nothing. The
 * Hono table has no module-level equivalent: fourteen `register*(app, …)` calls
 * inside `startServer`, a build-time plugin's own `register({ hono })`, and the
 * static mounts all write into one `app` that exists only after a boot. Reading
 * the SOURCE instead would mean writing down where routes may live, and a
 * hand-coded "where things may live" list is the blind spot an audit like this
 * exists to find. So: one real server on port 0, `ServerHandle.httpRoutes`, and
 * a route added anywhere by anyone enters this population with nobody
 * remembering anything.
 *
 * ---------------------------------------------------------------------------
 * A SCAN THAT FINDS NOTHING PASSES EVERYTHING — AND THIS FILE PROVES OTHERWISE
 * ---------------------------------------------------------------------------
 *
 * Every assertion is a comparison against a discovered population, so a
 * discovery that silently stopped working would turn this file green and mean
 * nothing. Three things close that off, in increasing strength:
 *
 *  1. The instrument check below asserts the table was read at all, that BOTH
 *     shapes came back from it (a table of only middleware, or only handlers,
 *     would satisfy every claim beneath it perfectly), and that the CONDITIONAL
 *     registrations are present — a fixture that stopped booting the dev
 *     publisher would otherwise shrink the population silently.
 *  2. `proves its own failure witness` calls the same residue function the real
 *     assertion calls, on the real population plus one route that is in no list,
 *     and requires it to be named. A census that classified nothing would fail
 *     that case.
 *  3. `sees a route a plugin adds to the real app` does it FOR REAL: a second
 *     server boots carrying a probe plugin that registers an ungoverned route on
 *     the actual Hono app, and the census must go red about that route. That is
 *     the deliberate-addition witness performed rather than described.
 *
 * And the same test names the hole it cannot close: the probe plugin also serves
 * a path from `onRequest`, which runs before `app.fetch`, and that path is shown
 * to be absent from the population while the request still succeeds.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WEBSOCKET_UPGRADE_PATHS } from './gateway/ws-server'
import { noJanitorWorkerForTests } from './janitor-host'
import type { SessionListCaller } from './modules/sessions/view'
import {
  buildSuperagentTools,
  type SuperagentToolDeps,
} from './modules/superagent/tools'
import type { PodiumPlugin } from './plugins'
import {
  RAW_ROUTE_POLICIES,
  type RouteEntry,
  rawRouteCensusKeys,
  rawRouteResidue,
  routeKey,
  UNCENSUSED_TRANSPORTS,
  UNGOVERNED_RAW_ROUTES,
  WEBSOCKET_PLANE_POLICIES,
} from './served-route-census'
import { startServer } from './server'
import { defaultDbPath } from './store'

/** Hono registers `app.use(...)` middleware under this verb. */
const MIDDLEWARE_VERB = 'ALL'

const PROBE_REGISTERED_PATH = '/__census-probe/registered'
const PROBE_INTERCEPTED_PATH = '/__census-probe/intercepted'

/**
 * The whole served table, and the two partitions every assertion is measured
 * against. `served` is populated by the boot in `beforeAll`; nothing below it
 * may be evaluated at module load.
 */
let served: readonly RouteEntry[] = []
const handlers = (): RouteEntry[] => served.filter((route) => route.method !== MIDDLEWARE_VERB)
const middleware = (): RouteEntry[] => served.filter((route) => route.method === MIDDLEWARE_VERB)
const handlerKeys = (): string[] => [...new Set(handlers().map(routeKey))].sort()

/** The census population: unique handler keys. Middleware is measured separately. */
const population = (): RouteEntry[] => {
  const seen = new Set<string>()
  return handlers().filter((route) => {
    const key = routeKey(route)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

describe('the raw route scan found the fleet', () => {
  let handle: Awaited<ReturnType<typeof startServer>>
  const wsProbeStatus: Record<string, number> = {}
  const wsProbeBody: Record<string, string> = {}

  beforeAll(async () => {
    handle = await startServer({
      dbPath: defaultDbPath(),
      janitorWorkerForTests: noJanitorWorkerForTests,
      port: 0,
    })
    served = handle.httpRoutes
    // Ask each WebSocket path what it does with an ordinary request that carries
    // no credential. Done HERE, against the running server, because the claim
    // `/daemon` and `/machine` accept first and authenticate second is the kind
    // of claim a comment can make falsely and a request cannot.
    for (const path of WEBSOCKET_UPGRADE_PATHS) {
      const response = await fetch(`http://127.0.0.1:${handle.port}${path}`)
      wsProbeStatus[path] = response.status
      wsProbeBody[path] = (await response.text()).trim()
    }
  }, 120_000)

  afterAll(async () => {
    await handle.close()
  })

  it('read the route table, and got both shapes back from it', () => {
    // The population every other assertion uses is a FILTER over this array. If
    // `app.routes` reshaped, or Hono stopped recording `use` under `ALL`, the
    // filter would return nothing and "every served route is classified" would
    // be vacuously true. Asserting both partitions are non-empty is what makes
    // that silence impossible.
    expect(served.length).toBeGreaterThan(40)
    expect(handlers().length).toBeGreaterThan(20)
    expect(middleware().length).toBeGreaterThan(5)
  })

  it('discovers 61 registered entries: 45 handlers over 43 paths, and 16 middleware', () => {
    // Three numbers that must agree, so no partition can absorb another
    // silently. The 45/43 gap is real and named in the census: `/mobile` and
    // `/mobile/*` are each registered twice, once as the dist-absent fallback
    // and once as the bundle server.
    expect(served).toHaveLength(61)
    expect(handlers()).toHaveLength(45)
    expect(handlerKeys()).toHaveLength(43)
    expect(middleware()).toHaveLength(16)
  })

  it('discovers routes from every module that registers one', () => {
    // One named member per registering call site, so a family that stopped being
    // mounted — or was renamed — reddens here rather than quietly shrinking the
    // population every assertion below is measured against.
    for (const expected of [
      'GET /health', // server.ts, before every middleware
      'GET /version', // registerVersionRoute
      'POST /maintenance/command', // registerMaintenanceRoute
      'GET /readiness', // registerReadinessRoute
      'GET /setup/config', // registerSetupRoute
      'GET /auth/status', // registerAuthRoute
      'GET /auth/members/list', // registerMemberRoutes (a mounted sub-app)
      'GET /auth/client-sessions', // registerMobilePairingRoutes
      'GET /files/asset', // registerAssetRoute
      'GET /files/artifact/:issueId/:artifactId/*', // registerArtifactRoute
      'POST /mcp', // registerMcpRoute
      'GET /desktop', // registerMobileRouting
    ]) {
      expect(handlerKeys()).toContain(expected)
    }
  })

  it('shows the upgrade planes answering differently, which is the finding', () => {
    // NOT A RESTATEMENT OF THE POLICY TEXT — the running server's own answer to
    // a credential-less request on each plane. `/client` resolves a principal
    // and refuses without one; `/daemon` and `/machine` present nothing to
    // refuse, so they reach `server.upgrade` and fail there for being an
    // ordinary GET. Describing both as "authenticated by the pairing ledger",
    // as the hand-read audit does, hides that the socket is accepted first and
    // questioned second.
    // 400 is `server.upgrade` refusing an ordinary GET — i.e. the request got
    // all the way to the upgrade with nothing asked of it.
    expect(wsProbeStatus['/daemon']).toBe(400)
    expect(wsProbeStatus['/machine']).toBe(400)
    expect(wsProbeBody['/daemon']).toBe('WebSocket upgrade failed')
    expect(wsProbeBody['/machine']).toBe('WebSocket upgrade failed')
    // `/client` never reaches the upgrade: it is refused first. On THIS boot the
    // refusal is 503 rather than 401, and that is worth saying rather than
    // normalising away — the readiness gate sits AHEAD of `principalForClient`
    // in `handleRequest`, so on an unconfigured instance the plane closes before
    // it ever asks who is calling. Asserted as "not the upgrade's answer" so the
    // structural claim survives a boot profile that gets as far as the principal.
    expect(wsProbeStatus['/client']).not.toBe(400)
    expect(wsProbeStatus['/client']).toBe(503)
  })

  it('discovers the CONDITIONAL registrations too, so a shrunken fixture is red', () => {
    // These three families are registered only under some boot profiles, which
    // makes the population boot-config dependent — the one real weakness of
    // deriving from a running server. Naming them here converts it from a
    // silent shrink into a failure: the dev feed exists only when a dev bundle
    // publisher was wired, and the two static mounts only when their dist dir
    // resolves.
    expect(handlerKeys()).toContain('GET /updates/feed/dev/podium-update.json') // dev publisher
    expect(handlerKeys()).toContain('GET /*') // registerDesktopWebStatic
    expect(handlerKeys()).toContain('GET /mobile/*') // registerWebStatic (phone bundle)
    // …and the phone pair really is registered twice. A single registration
    // would mean one of the two call sites stopped running.
    expect(handlers().filter((route) => route.path === '/mobile')).toHaveLength(2)
  })
})

describe('every raw route this server serves is classified', () => {
  it('classifies every served route', () => {
    // Default-closed: a route added without a census entry is a door nobody
    // decided on, so the gate names it here. This is the assertion the hand-read
    // audit could not make at all — a route absent from the document was absent
    // from its comparison too, because it had no comparison.
    expect(rawRouteResidue(population()).missing).toEqual([])
  })

  it('classifies nothing that is not served', () => {
    // The second direction, and not a formality: without it an EMPTY route table
    // satisfies every claim this census makes. It also catches a route deleted
    // while its policy stayed, which is how an audit surface starts describing a
    // server that no longer exists.
    expect(rawRouteResidue(population()).phantom).toEqual([])
  })

  it('puts every route in exactly one list', () => {
    const governed = new Set(RAW_ROUTE_POLICIES.map(routeKey))
    const both = UNGOVERNED_RAW_ROUTES.filter((entry) => governed.has(routeKey(entry)))
    // A route that is both classified and a finding would let a reviewer find
    // whichever answer they came for.
    expect(both.map(routeKey)).toEqual([])
    expect(new Set(rawRouteCensusKeys()).size).toBe(rawRouteCensusKeys().length)
  })

  it('proves its own failure witness', () => {
    // THE COUNTERFACTUAL, RUN RATHER THAN CLAIMED. The same function the two
    // assertions above call, on the same real population, plus one route that is
    // deliberately in no list. A census that had quietly stopped comparing —
    // because the population went empty, or because the key spelling drifted —
    // passes those two and fails this one.
    const planted: RouteEntry = { method: 'GET', path: '/__census-probe/unclassified' }
    const residue = rawRouteResidue([...population(), planted])
    expect(residue.missing).toEqual(['GET /__census-probe/unclassified'])
    // And the other direction: a route that stops being served must surface as a
    // phantom rather than as one fewer row nobody notices.
    const withoutOne = population().filter((route) => routeKey(route) !== 'GET /files/asset')
    expect(rawRouteResidue(withoutOne).phantom).toEqual(['GET /files/asset'])
  })

  it('keeps the ungoverned list a finding list, not a waiver', () => {
    // EMPTY TODAY, AND THAT IS A MEASUREMENT RATHER THAN A CLEAN BILL. The first
    // run of this census, one pin earlier, carried `GET /files/asset` here: it
    // served checkout bytes behind `clientAuthGuard`, which is authentication,
    // with the `root` arm asking about PATHS and the `sessionId` arm asking
    // nothing. PDM-262 landed while this file was being written and the row
    // moved into `RAW_ROUTE_POLICIES`.
    //
    // `toEqual([])` rather than a length check, for `derived-family.ts`'s
    // reason: it fails the moment any future raw route is recorded at this
    // severity, which is exactly the signal to raise, and turning it back into a
    // populated list is then a deliberate edit. And an empty list cannot be
    // reached by quietly dropping a row — `classifies every served route` above
    // refuses a route that is in neither list, independently of this one.
    expect(UNGOVERNED_RAW_ROUTES.map(routeKey)).toEqual([])
    for (const entry of UNGOVERNED_RAW_ROUTES) {
      expect(['B', 'C', 'F']).toContain(entry.owner)
      expect(entry.finding.length).toBeGreaterThan(80)
    }
  })

  it('states a guard and a reason for every classified route', () => {
    for (const policy of RAW_ROUTE_POLICIES) {
      // "Classified" is only an answer if someone wrote down what the door asks
      // and why that is the right question for that kind of door. An unstated
      // guard is an unclassified route with better manners.
      expect(policy.guard.length).toBeGreaterThan(3)
      expect(policy.rationale.length).toBeGreaterThan(20)
    }
  })

  it('counts the routes that reach rows about people, and scopes all five', () => {
    const reads = RAW_ROUTE_POLICIES.filter((policy) => policy.kind === 'reads-stored-rows')
    // The interesting partition, stated as a number so it cannot drift
    // unnoticed: FIVE raw routes of kind `reads-stored-rows` reach rows this
    // instance stores about people, and at this pin every one of them scopes
    // the reader. A sixth arriving is a door that has to be argued for, and it
    // reddens here before anyone has to notice it in a diff.
    //
    // FIVE is this kind, not "every door that can return a stored row".
    // POST /mcp is kind `bridge` and the belt's own tools do read stored rows;
    // that population is classified on that row (see the MCP-door describe
    // below), not absorbed into this count.
    expect(reads.map(routeKey).sort()).toEqual([
      'GET /auth/client-sessions',
      'GET /auth/members/list',
      'GET /files/artifact/:issueId/:artifactId/*',
      'GET /files/asset',
      'POST /auth/members/inspect',
    ])
    expect(reads.length + UNGOVERNED_RAW_ROUTES.length).toBe(5)
  })
})

describe('the middleware chain is part of the exposure story', () => {
  it('records how many middlewares cover each prefix', () => {
    const byPath = new Map<string, number>()
    for (const entry of middleware()) byPath.set(entry.path, (byPath.get(entry.path) ?? 0) + 1)
    // A guard added to or removed from a prefix is a change to what these routes
    // are protected by, and it must not be invisible. `/files/*` carrying three
    // is the case that matters: cors, the readiness boundary and
    // `clientAuthGuard` — three middlewares, none of which is authorization,
    // which is precisely why `/files/asset` is a finding despite sitting behind
    // all three.
    expect(Object.fromEntries([...byPath].sort())).toEqual({
      '/*': 1,
      '/auth/*': 2,
      '/auth/members/*': 1,
      '/auth/status': 1,
      '/files/*': 3,
      '/readiness': 1,
      '/setup/*': 1,
      '/trpc/*': 5,
      '/version': 1,
    })
  })

  it('keeps the whole tRPC surface behind one prefix, where the other census takes over', () => {
    // The two censuses meet HERE. Every one of the 108 reads
    // `projection-census.test.ts` governs is served through this one prefix, and
    // it appears in this table as middleware and nothing else — no per-procedure
    // entry. A route added beside `/trpc/*` rather than inside the router is
    // therefore this census's problem, not that one's, which is the seam the two
    // files divide on.
    expect(middleware().some((entry) => entry.path === '/trpc/*')).toBe(true)
    expect(handlerKeys().filter((key) => key.includes('/trpc'))).toEqual([])
  })
})

describe('the WebSocket planes are a second population, derived separately', () => {
  it('derives the population from the object the upgrade decides on', () => {
    // NOT from the Hono table, which cannot see these paths at all: the
    // composition root calls `ws.handleRequest(request)` first and only falls
    // through to `app.fetch` when it returns null. `handleRequest` matches
    // against WEBSOCKET_UPGRADE_PATHS, so a fourth upgrade path has to join that
    // list to be routed — which is what puts it in this population without
    // anyone remembering to add it.
    expect([...WEBSOCKET_UPGRADE_PATHS].sort()).toEqual(['/client', '/daemon', '/machine'])
    for (const path of WEBSOCKET_UPGRADE_PATHS) {
      expect(handlerKeys().some((key) => key.endsWith(` ${path}`))).toBe(false)
    }
  })

  it('classifies every upgrade path, in both directions', () => {
    const classified = WEBSOCKET_PLANE_POLICIES.map((policy) => policy.path).sort()
    expect(classified).toEqual([...WEBSOCKET_UPGRADE_PATHS].sort())
    for (const policy of WEBSOCKET_PLANE_POLICIES) {
      expect(policy.guard.length).toBeGreaterThan(20)
      // Where the ROW SCOPING lives, stated separately from what the upgrade
      // asks. Collapsing the two is how "the socket is authenticated" comes to
      // stand in for "the socket's rows are scoped", which are different claims.
      expect(policy.rowScoping.length).toBeGreaterThan(20)
    }
  })
})

describe('the transports this census does not cover', () => {
  let handle: Awaited<ReturnType<typeof startServer>>
  let pluginRoutes: readonly RouteEntry[] = []
  let interceptedStatus = 0
  let interceptedBody = ''

  /**
   * A PLUGIN THAT USES BOTH HALVES OF THE SEAM: one route registered on the real
   * Hono app, and one path answered from `onRequest` without registering
   * anything. The OSS server ships no plugins and the cloud build ships one, so
   * this is the shape the census has to be honest about.
   */
  const probe: PodiumPlugin = {
    name: 'pdm-353-census-probe',
    onRequest: (request) =>
      new URL(request.url).pathname === PROBE_INTERCEPTED_PATH
        ? new Response('intercepted', { status: 200 })
        : undefined,
    register: ({ hono }) => {
      hono.get(PROBE_REGISTERED_PATH, (c) => c.text('registered'))
    },
  }

  beforeAll(async () => {
    handle = await startServer({
      dbPath: defaultDbPath(),
      janitorWorkerForTests: noJanitorWorkerForTests,
      port: 0,
      plugins: [probe],
    })
    pluginRoutes = handle.httpRoutes
    const response = await fetch(`http://127.0.0.1:${handle.port}${PROBE_INTERCEPTED_PATH}`)
    interceptedStatus = response.status
    interceptedBody = await response.text()
  }, 120_000)

  afterAll(async () => {
    await handle.close()
  })

  it('sees a route a plugin adds to the real app, and goes red about it', () => {
    // THE DELIBERATE-ADDITION WITNESS, PERFORMED. A route that is in no census
    // list is added to the actual Hono app of an actual booted server, exactly
    // as a new feature would add one, and the census names it. Without this the
    // file could assert the residue is empty forever while having lost the
    // ability to see anything at all.
    const key = `GET ${PROBE_REGISTERED_PATH}`
    expect(pluginRoutes.map(routeKey)).toContain(key)
    expect(rawRouteResidue(pluginRoutes).missing).toContain(key)
  })

  it('cannot see a path a plugin answers from onRequest, and says so', () => {
    // THE HOLE, DEMONSTRATED RATHER THAN DESCRIBED. `onRequest` runs before the
    // WebSocket upgrade and before `app.fetch`, so it can serve any path without
    // registering one. The request below succeeds; the path is in no route
    // table; no derivation reaches it. A reader who takes this census for full
    // coverage of "what the server answers on" would be wrong in exactly this
    // one way, which is why it is asserted here instead of left to a comment.
    expect(interceptedStatus).toBe(200)
    expect(interceptedBody).toBe('intercepted')
    expect(pluginRoutes.map((route) => route.path)).not.toContain(PROBE_INTERCEPTED_PATH)
    expect(UNCENSUSED_TRANSPORTS.map((entry) => entry.name)).toEqual(['PodiumPlugin.onRequest'])
    for (const entry of UNCENSUSED_TRANSPORTS) expect(entry.why.length).toBeGreaterThan(80)
  })
})

/**
 * Own-tool names as the MCP path actually builds them: `issueBelt` off, so
 * this set is the population `modules/issues/registry.ts` does not reach.
 * Search stays on so `search_conversations` is in the set rather than being
 * dropped by the index gate — the census has to classify the tool whether or
 * not a given boot offers it.
 */
const ownBeltToolNames = async (): Promise<string[]> =>
  (
    await buildSuperagentTools(
      {
        modules: {} as SuperagentToolDeps['modules'],
        repos: { list: async () => [] },
        store: { searchIndexEnabled: true } as SuperagentToolDeps['store'],
        waitPollMs: 1,
      },
      '',
    )
  ).map((tool) => tool.spec.name)

describe('the MCP door covers both populations behind it', () => {
  it('the belt has own tools that are not issue-registry commands', async () => {
    // Derived from the builder, not retyped. A hand list here compared to
    // the census would be two copies of the same assumption (catalogue shape 7).
    const own = await ownBeltToolNames()
    expect(own.length).toBeGreaterThan(15)
    expect(own).toContain('list_sessions')
    expect(own).toContain('search_conversations')
    expect(own).toContain('read_session_transcript')
    expect(own).toContain('recap_session')
    expect(own.some((name) => name.startsWith('issue_'))).toBe(false)
  })

  it('the POST /mcp rationale names those own tools and what classifies them', async () => {
    // Production change that would make this fail: restore the sentence that
    // classified the whole door by `modules/issues/registry.ts` and said the
    // belt "serves no projection of its own". That sentence is true of the
    // bridged issue_* half and false of list_sessions.
    const own = await ownBeltToolNames()
    const policy = RAW_ROUTE_POLICIES.find((row) => routeKey(row) === 'POST /mcp')
    expect(policy).toBeDefined()
    expect(policy!.kind).toBe('bridge')
    const rationale = policy!.rationale

    // Bridged half — still true, still named.
    expect(rationale).toMatch(/modules\/issues\/registry\.ts/)
    expect(rationale).toMatch(/classification-totality\.test\.ts/)

    // Own half — the hole this issue exists to close.
    expect(rationale).toMatch(/modules\/superagent\/tools\.ts/)
    expect(rationale).toContain('list_sessions')
    expect(own.includes('list_sessions')).toBe(true)

    // `listAllTool` is a SessionListCaller (perf), not a scope. Pin the type
    // so a new meaning of the label is a type error here, not a silent
    // rationale. Catalogue shape 19: pin the property next to the assertion.
    const callers: SessionListCaller[] = ['bootstrap', 'rpc', 'listAllTool']
    expect(callers).toContain('listAllTool')
    expect(rationale).toMatch(/listAllTool/)
    expect(rationale).toMatch(/SessionListCaller/)
    expect(rationale).toMatch(/INTERNAL_PROJECTION_READ/)
    expect(rationale).toMatch(/memoryReader/)

    // The sentence that classified the whole door by the issue registry.
    expect(rationale).not.toMatch(/serves no projection of its own/)
  })
})
