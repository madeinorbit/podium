/**
 * THE RAW ROUTE CENSUS (PDM-353) — what the server answers on OUTSIDE tRPC, and
 * what each of those doors asks before it answers.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS FILLS
 * ---------------------------------------------------------------------------
 *
 * `projection-census.test.ts` derives its population from
 * `appRouter._def.procedures` and governs the tRPC read surface. It says so at
 * its own line 64: *"The raw HTTP, WebSocket and file-route families are OUTSIDE
 * this census entirely and are audited separately."*
 *
 * That separate audit is the raw-HTTP section of
 * `docs/gates/pdm-248-served-read-census.md`, and it is a HAND-READ one — *"Each
 * row below was read at this pin."* A hand-read audit does not re-derive, so it
 * goes stale the moment a route is added, and nothing anywhere says so. Twice in
 * phase B a raw route turned out to serve another member's bytes
 * (`/files/artifact/*`, PDM-261; `/files/asset`, PDM-262) and BOTH were found by
 * a person reading rather than by an instrument, because no instrument was
 * looking at this surface at all.
 *
 * It went stale exactly as predicted, and this file's first measurement proves
 * it: the hand-read audit lists no `/updates/feed/dev/*` route, though the
 * server serves six of them, and lists `POST /mcp` without the `GET`/`DELETE`
 * entries beside it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE POPULATION MUST BE DERIVED, AND WHY IT COSTS A BOOT
 * ---------------------------------------------------------------------------
 *
 * The tRPC census is cheap because `appRouter` is a module-level object. The
 * Hono surface has no equivalent. Its routes are registered by FOURTEEN separate
 * `register*(app, …)` calls inside `startServer`, plus a build-time plugin's own
 * `register({ hono })`, plus the static-web mounts — and several of those are
 * conditional on the boot profile. There is no module-level object that knows
 * the table; the only thing that knows it is `app`, and `app` exists only after
 * a boot.
 *
 * A source scan over "the files where routes live" was the obvious cheap
 * alternative and is the wrong answer: a hand-coded list of WHERE things may
 * live is precisely the blind spot an audit like this exists to find (false-green
 * catalogue shape 26). So the census test boots one real server on port 0 and
 * reads `ServerHandle.httpRoutes`, which is `app.routes` snapshotted after every
 * registration has run. A route added anywhere, by anyone, in any module, enters
 * this population with nobody remembering anything — which is the one property
 * that makes this an instrument and not a list.
 *
 * ---------------------------------------------------------------------------
 * THREE TRANSPORTS, AND THIS FILE SAYS WHICH IT COVERS
 * ---------------------------------------------------------------------------
 *
 * The sentence in pdm-248 excludes THREE families, not one. Stated plainly, so
 * no reader has to infer coverage that was not built:
 *
 *  1. **Raw HTTP (the Hono route table)** — COVERED here, population derived
 *     from `app.routes`. The file-route family is part of it: `/files/asset` and
 *     `/files/artifact/*` are ordinary rows below, not a separate family.
 *  2. **WebSocket upgrades** — COVERED here, as a SEPARATE population derived
 *     from {@link WEBSOCKET_UPGRADE_PATHS}, because these paths never reach the
 *     Hono table at all: the composition root calls `ws.handleRequest(request)`
 *     first and only falls through to `app.fetch` when it returns null. A census
 *     derived from the route table alone would report `/daemon` as not existing
 *     rather than as unexamined — which is the router-anchored form of the
 *     failure PDM-251 found on the model-anchored side (catalogue: *a census
 *     cannot see a site that declines to ask*).
 *  3. **The plugin `onRequest` seam** — NOT COVERED, and named here as the hole
 *     it is. `PodiumPlugin.onRequest` runs before BOTH the WebSocket upgrade and
 *     `app.fetch` and can answer any path without registering anything. It is
 *     unreachable from any derived population; the census test demonstrates the
 *     hole rather than describing it, by booting a plugin that serves a path
 *     through `onRequest` and showing that path is absent from `httpRoutes`.
 *     See {@link UNCENSUSED_TRANSPORTS}.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A MEASUREMENT, NOT A CLEAN BILL
 * ---------------------------------------------------------------------------
 *
 * Every row below was read at this pin — and unlike the document it replaces,
 * *re-read*: none of pdm-248's verdicts were carried across. That mattered. Its
 * WebSocket row justifies excluding `/client` on the grounds that "the three
 * `sync.*` reads are already in `UNGOVERNED_PROJECTIONS` at owner C"; at this pin
 * no `sync.*` entry remains in that list. A rebuilt instrument does not
 * re-verify the rows it carries, so this one carried none.
 *
 * `UNGOVERNED_RAW_ROUTES` is a FINDING LIST, not a waiver. The census is landed
 * with today's answers asserted as they actually are so that every later change
 * to this surface is visible; fixing what it found is separate work with its own
 * issues.
 */

/** One entry of a served route table: a verb and the pattern it is matched on. */
export interface RouteEntry {
  readonly method: string
  readonly path: string
}

/** The census key for a route. Verb included: `GET /mcp` and `POST /mcp` are
 *  different doors with different answers, and a path-keyed census would have
 *  classified one of them and called the other covered. */
export const routeKey = (route: RouteEntry): string => `${route.method} ${route.path}`

/**
 * WHAT KIND OF DOOR THIS IS — the first question, because it decides which
 * further question is even meaningful.
 *
 * `reads-stored-rows` is the only kind this census GOVERNS in the projection
 * sense: a door that answers with rows this instance stores about people, where
 * "which people's rows may this caller see" is a real question with a right
 * answer. Everything else is classified and then explicitly set aside, with the
 * reason recorded, rather than being absent from the comparison — which is how
 * pdm-248's hand-read list silently stopped covering the update feed.
 */
export type RawRouteKind =
  /** Answers with rows this instance stores about people. */
  | 'reads-stored-rows'
  /** Mutates. Belongs to the COMMAND classification, not a read census. */
  | 'write'
  /** A fact about the instance or about the caller's own session; no other person's rows. */
  | 'instance-fact'
  /** Serves build/update bytes: the same artifact for every caller. */
  | 'build-artifact'
  /** Serves the built SPA, or redirects to wherever it lives. */
  | 'static-shell'
  /** Dispatches into a surface that is censused somewhere else, and names where. */
  | 'bridge'
  /** Answers a refusal (405) and reaches nothing. */
  | 'method-refusal'

/** A classified raw HTTP route, read at this pin. */
export interface RawRoutePolicy extends RouteEntry {
  readonly kind: RawRouteKind
  /** The guard ACTUALLY APPLIED, as the handler runs it — not the one its neighbours run. */
  readonly guard: string
  /** Why that guard is the right answer for this kind of door. */
  readonly rationale: string
}

/** A raw HTTP route with no reader scoping, recorded as a finding with an owner. */
export interface UngovernedRawRoute extends RouteEntry {
  readonly owner: 'B' | 'C' | 'F'
  readonly finding: string
}

/**
 * EVERY RAW HTTP ROUTE THIS SERVER SERVES, classified — 42 of the 43 unique
 * `METHOD path` keys the route table produces. The forty-third is in
 * {@link UNGOVERNED_RAW_ROUTES}.
 */
export const RAW_ROUTE_POLICIES: readonly RawRoutePolicy[] = [
  // -------------------------------------------------------------------------
  // Reads of stored rows — the doors this census exists for
  // -------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/auth/members/list',
    kind: 'reads-stored-rows',
    guard:
      "member-routes.ts `admin()`: resolveUserId, then users.roleOf(actor) === 'admin', else 403",
    rationale:
      "Returns every member row plus the actor's own invites. The admin floor is applied in the handler itself, not inherited from a prefix, and `invites.list(actor)` is scoped to the caller. Re-read at this pin.",
  },
  {
    method: 'GET',
    path: '/auth/client-sessions',
    kind: 'reads-stored-rows',
    guard:
      'mobile-pairing-route.ts: resolveUserId → 401 when absent, then listMobileClientSessions(userId) for THAT id',
    rationale:
      "Caller-only by construction: the route takes no user parameter, so naming another person's devices is unrepresentable rather than refused. `current` is computed from the presented credential's own token hash.",
  },
  {
    method: 'GET',
    path: '/files/artifact/:issueId/:artifactId/*',
    kind: 'reads-stored-rows',
    guard:
      "per-request `doorFor` builds one caller's FileAccessGate from `requestPrincipal`; `readArtifact` runs `checkIssueAccess`",
    rationale:
      "Closed by PDM-261, which landed on the epic line before this pin. The route no longer receives the store; it receives one caller's gate and runs the SAME issue-access rule `files.read` runs over these same bytes. Witnessed by file-artifact-route.authz.test.ts, which reddens when that single call is deleted.",
  },
  {
    method: 'POST',
    path: '/auth/members/inspect',
    kind: 'reads-stored-rows',
    guard:
      'member-invites.ts `validInvite`: a 43-char token whose hash must match a live, unexpired invite row',
    rationale:
      'A POST that reads rather than writes, so a verb-blind reading of this surface would misfile it. Holding the invite token IS the authorization — that is what an invite link is — and the reply is narrowed to `{ email, expiresAt }` of that one invite, never the invite list.',
  },

  // -------------------------------------------------------------------------
  // Writes — outside a read census by definition, classified so they are not absent from it
  // -------------------------------------------------------------------------
  {
    method: 'POST',
    path: '/auth/login',
    kind: 'write',
    guard: 'password verification plus the per-identifier attempt throttle',
    rationale:
      'Mints a credential. The command classification owns it; recorded here so it is set aside deliberately.',
  },
  {
    method: 'POST',
    path: '/auth/users',
    kind: 'write',
    guard: 'first-admin provisioning path in auth-route.ts',
    rationale: 'Creates a member. Command classification.',
  },
  {
    method: 'POST',
    path: '/auth/logout',
    kind: 'write',
    guard: 'the presented credential',
    rationale: "Retires the caller's own session. Command classification.",
  },
  {
    method: 'POST',
    path: '/auth/server-transfer-claim',
    kind: 'write',
    guard: 'the transfer token carried in the posted form',
    rationale: "Adopts a moved server's session. Command classification.",
  },
  {
    method: 'POST',
    path: '/auth/members/invite',
    kind: 'write',
    guard: 'member-routes.ts `admin()` → 403',
    rationale: 'Command classification; the admin floor is in the handler.',
  },
  {
    method: 'POST',
    path: '/auth/members/revoke',
    kind: 'write',
    guard: 'member-routes.ts `admin()` → 403',
    rationale: 'Command classification; the admin floor is in the handler.',
  },
  {
    method: 'POST',
    path: '/auth/members/remove',
    kind: 'write',
    guard: 'member-routes.ts `admin()` → 403',
    rationale: 'Command classification; the admin floor is in the handler.',
  },
  {
    method: 'POST',
    path: '/auth/members/complete',
    kind: 'write',
    guard: 'member-invites.ts `validInvite`, re-checked inside the serialized write transaction',
    rationale: 'Redeems an invite into a member row. Command classification.',
  },
  {
    method: 'POST',
    path: '/auth/mobile-pair/start',
    kind: 'write',
    guard: 'credentialPrincipal → 401 when absent',
    rationale:
      "Pairing is session mutation and requires a real credential; open mode's first-admin policy is deliberately not accepted here. Command classification.",
  },
  {
    method: 'POST',
    path: '/auth/mobile-pair/claim',
    kind: 'write',
    guard: 'the pairing code presented by the claiming device',
    rationale: 'Command classification.',
  },
  {
    method: 'POST',
    path: '/auth/mobile-pair/status',
    kind: 'write',
    guard: 'credentialPrincipal → 401 when absent',
    rationale: 'Advances the pairing state machine. Command classification.',
  },
  {
    method: 'POST',
    path: '/auth/mobile-pair/approve',
    kind: 'write',
    guard: 'credentialPrincipal → 401 when absent',
    rationale: 'Command classification.',
  },
  {
    method: 'POST',
    path: '/auth/mobile-pair/deny',
    kind: 'write',
    guard: 'credentialPrincipal → 401 when absent',
    rationale: 'Command classification.',
  },
  {
    method: 'POST',
    path: '/auth/mobile-pair/complete',
    kind: 'write',
    guard: 'the completed pairing record, which mints the mobile client session',
    rationale: 'Command classification.',
  },
  {
    method: 'POST',
    path: '/auth/client-sessions/revoke',
    kind: 'write',
    guard: 'resolveUserId → 401, then `deleteOwnedMobileClientSession(sessionId, userId)`',
    rationale:
      "The ownership check is IN the store call rather than beside it, so a caller naming someone else's session id gets 404. Command classification.",
  },
  {
    method: 'POST',
    path: '/maintenance/handshake',
    kind: 'write',
    guard: 'Bearer token checked by `authenticateToken`, 401 first',
    rationale: 'The local janitor transport. Not human-facing. Command classification.',
  },
  {
    method: 'POST',
    path: '/maintenance/command',
    kind: 'write',
    guard: 'Bearer token checked by `authenticateToken`, 401 first',
    rationale: 'The local janitor transport. Not human-facing. Command classification.',
  },

  // -------------------------------------------------------------------------
  // Instance facts — about the instance, or about the caller's own session
  // -------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/health',
    kind: 'instance-fact',
    guard:
      'none, deliberately — registered before every middleware so a supervisor can reach it during a deferred data plane',
    rationale: 'Answers `ok` or a 503 text. Reaches no store row.',
  },
  {
    method: 'GET',
    path: '/version',
    kind: 'instance-fact',
    guard:
      'none, deliberately — the login screen and every client probe it before there is a credential',
    rationale:
      'Wire version, schema fingerprint, and the identity of the bundles THIS process serves. No person appears in it.',
  },
  {
    method: 'GET',
    path: '/readiness',
    kind: 'instance-fact',
    guard: 'none, deliberately — a platform health check reads the status code and nothing else',
    rationale: 'The lifecycle projection, 200 or 503. Explicitly non-secret.',
  },
  {
    method: 'GET',
    path: '/setup/config',
    kind: 'instance-fact',
    guard: 'none, deliberately — it must answer before a login exists',
    rationale:
      'Unauthenticated by design and therefore narrowed at the handler: it forwards the readiness projection and `stale` field NAMES, never config VALUES, because the config can hold `upstream.token` and `pairCode`. Authenticated readers use the `setup.info` tRPC procedure instead.',
  },
  {
    method: 'GET',
    path: '/auth/status',
    kind: 'instance-fact',
    guard: 'none needed; answers about whoever presented the request',
    rationale:
      "Caller-only: `userId` echoed is the caller's own, and the admission reason is computed only when nobody was admitted. It is upstream of any transport that must be authorized, which is why the open-mode principal resolver deliberately does not fire here.",
  },

  // -------------------------------------------------------------------------
  // Static shell — the built SPA and the redirects that stand in for it
  // -------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/',
    kind: 'static-shell',
    guard: 'none',
    rationale: 'Phone/desktop entry routing, then the desktop bundle. Serves build output.',
  },
  {
    method: 'GET',
    path: '/*',
    kind: 'static-shell',
    guard: 'none',
    rationale:
      'The desktop SPA catch-all, registered after every API route so it cannot shadow one.',
  },
  {
    method: 'GET',
    path: '/desktop',
    kind: 'static-shell',
    guard: 'none',
    rationale:
      'Redirect to the desktop shell, or to the configured app URL on an API-only deployment.',
  },
  {
    method: 'GET',
    path: '/mobile',
    kind: 'static-shell',
    guard: 'none',
    rationale:
      'Registered TWICE and that is not a duplicate: `registerMobileRouting` installs the fallback that owns the dist-absent case, and `registerWebStatic` installs the server of the phone bundle behind it.',
  },
  {
    method: 'GET',
    path: '/mobile/*',
    kind: 'static-shell',
    guard: 'none',
    rationale: 'Same pair as `/mobile`: fallback first, then the bundle.',
  },
  {
    method: 'GET',
    path: '/setup/mobile',
    kind: 'static-shell',
    guard: 'none',
    rationale:
      'A self-contained HTML notice served while the data plane is unavailable. Interpolates only its own two literal strings.',
  },
  {
    method: 'GET',
    path: '/auth/server-transfer-claim',
    kind: 'static-shell',
    guard: 'none',
    rationale:
      'Inert HTML under a `default-src none` CSP whose script moves the token out of the URL fragment and POSTs it to the sibling route. Reads nothing; the POST is where the authority is.',
  },

  // -------------------------------------------------------------------------
  // Build artifacts — the dev update feed
  // -------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/updates/feed/dev/latest.json',
    kind: 'build-artifact',
    guard: 'NONE, deliberately public',
    rationale:
      "The desktop updater manifest. Tauri's updater cannot attach machine credentials, so this document is public by decision; it contains only GitHub URLs whose bytes stay protected by the shell's baked release key. ABSENT FROM pdm-248's hand-read audit entirely, along with the five rows below it.",
  },
  {
    method: 'GET',
    path: '/updates/feed/dev/podium-update.json',
    kind: 'build-artifact',
    guard: 'artifact-route.ts `authenticate`: `Bearer <artifactToken>` or `?token=` — 401 FIRST',
    rationale:
      "The headless manifest names artifact URLs carrying this server's credential, so it is authenticated ahead of everything else. The token is an INSTANCE secret, not a per-member credential: this is instance-wide material, the HTTP analogue of the projection census's `instance-wide` scope.",
  },
  {
    method: 'GET',
    path: '/updates/feed/dev/artifact/:version/:platform',
    kind: 'build-artifact',
    guard:
      'artifact-route.ts `authenticate` — 401 FIRST, then fail-closed 404s that do not enumerate',
    rationale:
      'Streams a published bundle. Same instance token; same artifact for every caller who holds it.',
  },
  {
    method: 'HEAD',
    path: '/updates/feed/dev/artifact/:version/:platform',
    kind: 'build-artifact',
    guard: 'artifact-route.ts `authenticate` — 401 FIRST',
    rationale:
      'The HEAD arm of the row above, registered by the same `app.on([GET, HEAD], …)` call and therefore a separate census key.',
  },
  {
    method: 'GET',
    path: '/updates/feed/dev/artifact/:version',
    kind: 'build-artifact',
    guard: 'artifact-route.ts `authenticate` — 401 FIRST',
    rationale:
      "Kept for a daemon holding a URL minted before one build published several platforms. Serves the host's bundle.",
  },
  {
    method: 'HEAD',
    path: '/updates/feed/dev/artifact/:version',
    kind: 'build-artifact',
    guard: 'artifact-route.ts `authenticate` — 401 FIRST',
    rationale: 'The HEAD arm of the row above.',
  },

  // -------------------------------------------------------------------------
  // Bridges and refusals
  // -------------------------------------------------------------------------
  {
    method: 'POST',
    path: '/mcp',
    kind: 'bridge',
    guard:
      'a per-process UUID in `x-podium-mcp-token` (or bearer), plus an opaque per-thread token',
    rationale:
      "Dispatches into the superagent's tool belt, which bridges the ISSUE COMMAND REGISTRY — the same definitions, carrying the same `authz`, that the `issues` tRPC family is excluded from the projection census for. It serves no projection of its own; classified by `modules/issues/registry.ts`, whose totality `classification-totality.test.ts` keeps.",
  },
  {
    method: 'GET',
    path: '/mcp',
    kind: 'method-refusal',
    guard: 'n/a — answers 405 with `allow: POST` and reaches nothing',
    rationale:
      "Registered by the same `app.on([GET, DELETE], …)` call as the row below. Neither appears in pdm-248's audit, which records `POST /mcp` alone — harmless here, and exactly the kind of omission a derived population cannot make.",
  },
  {
    method: 'DELETE',
    path: '/mcp',
    kind: 'method-refusal',
    guard: 'n/a — answers 405 with `allow: POST` and reaches nothing',
    rationale:
      'The DELETE arm of the same registration. Neither method reaches the tool belt; both answer before any dispatch.',
  },
]

/**
 * RAW HTTP ROUTES WITH NO READER SCOPING. A finding list with owners, not a
 * waiver — the same contract `UNGOVERNED_PROJECTIONS` carries on the tRPC side.
 *
 * WHOEVER LANDS PDM-262 HAS TWO EDITS TO MAKE HERE, and they are named so the
 * landing is not a surprise. Move `GET /files/asset` into
 * {@link RAW_ROUTE_POLICIES} with the guard it then actually runs, and delete
 * `keeps the ungoverned list a finding list, not a waiver`'s non-empty
 * assertion in the test — which is deliberately the thing that has to be
 * removed by hand, so a list emptied by deleting rows cannot look like a list
 * emptied by fixing routes. The totality assertions independently refuse a
 * route that ends up in neither list, so nothing can be lost in the move.
 */
export const UNGOVERNED_RAW_ROUTES: readonly UngovernedRawRoute[] = [
  {
    method: 'GET',
    path: '/files/asset',
    owner: 'B',
    finding:
      "Serves checkout bytes with no reader scoping in either arm. The `/files/*` prefix applies cors, the readiness boundary and `clientAuthGuard` — AUTHENTICATION, which establishes that the caller is signed in and nothing about whose material this is. The `root` arm then prefix-matches `allowsRoot` against registered repo roots after collapsing `..`, which is a real rule about PATHS and not a rule about PEOPLE; the `sessionId` arm consults no session ownership at all and relies on the daemon's path sandbox. Same material and same gap as the artifact route PDM-261 closed, over the other file transport. PDM-262 has a fix on `issue/pdm-262-asset-route-gate` which is NOT an ancestor of this pin — verified, not assumed — so the route is ungoverned as this census measures it.",
  },
]

/** A WebSocket upgrade path and what the UPGRADE itself asks. */
export interface WebSocketPlanePolicy {
  readonly path: string
  /** The guard applied before `server.upgrade`, as the upgrade runs it. */
  readonly guard: string
  /** Where the row scoping for what this plane then streams actually lives. */
  readonly rowScoping: string
}

/**
 * THE THREE WEBSOCKET PLANES, classified at this pin.
 *
 * Read from `gateway/ws-server.ts` directly rather than carried from pdm-248 —
 * whose justification for `/client` has gone stale (it rests on `sync.*` being
 * in `UNGOVERNED_PROJECTIONS`, and no `sync.*` entry is in that list at this
 * pin).
 */
export const WEBSOCKET_PLANE_POLICIES: readonly WebSocketPlanePolicy[] = [
  {
    path: '/client',
    guard:
      'wire-version gate → `wsOriginVerdict` 403 → readiness 503 → `principalForClient`/`roleForClient`, 401 when either is absent',
    rowScoping:
      "`prepareMachines(userClientPrincipal('upgrade', userId, userRole))` is a per-principal computation done AT the upgrade; what the socket then streams is the feed, whose row scoping is the owner-or-grant predicate in `feed-visibility.ts` and `relay.ts`. That predicate is not decided here and this census does not restate it.",
  },
  {
    path: '/daemon',
    guard:
      'wire-version gate → `wsOriginVerdict` 403, AND NOTHING ELSE. `data` is `{ kind: "daemon", url }`; no credential is presented or checked before `server.upgrade`.',
    rowScoping:
      'AUTHENTICATION IS DEFERRED, not absent: `wireDaemonSocket` holds `principal: MachinePrincipal | undefined` and `createDaemonAcceptor` enforces the handshake order, refusing pre-auth binary frames. Stating this as "authenticated by the pairing ledger" — as the hand-read audit does — hides that the socket is accepted first and questioned second.',
  },
  {
    path: '/machine',
    guard: 'wire-version gate → `wsOriginVerdict` 403, AND NOTHING ELSE. Same shape as `/daemon`.',
    rowScoping: 'Deferred to `wireMachineSocket` and the same handshake acceptor. See `/daemon`.',
  },
]

/**
 * TRANSPORTS THIS CENSUS DOES NOT COVER, said out loud.
 *
 * A census that quietly stops at the edge of what it could derive is the same
 * defect as the hand-read audit it replaces. Each entry names what is uncovered,
 * why no derivation reaches it, and what the census test does instead.
 */
export const UNCENSUSED_TRANSPORTS: readonly { readonly name: string; readonly why: string }[] = [
  {
    name: 'PodiumPlugin.onRequest',
    why: "A build-time plugin may answer ANY path from `onRequest`, which the composition root calls before the WebSocket upgrade and before `app.fetch`, WITHOUT registering a route. Nothing observable records the paths such a hook claims, so no population can be derived from it. The OSS server ships no plugins; the cloud build ships one. `served-route-census.test.ts` demonstrates the hole with a probe plugin rather than describing it: the plugin's REGISTERED route appears in the census population, and its `onRequest`-only path does not.",
  },
]

// ---------------------------------------------------------------------------
// The comparison, as one function — so the counterfactual can use it too
// ---------------------------------------------------------------------------

/** Every route key the census claims to have an answer for. */
export const rawRouteCensusKeys = (): string[] => [
  ...RAW_ROUTE_POLICIES.map(routeKey),
  ...UNGOVERNED_RAW_ROUTES.map(routeKey),
]

/**
 * THE ONE COMPARISON, in both directions.
 *
 * `missing` is a served route no list classifies — default-closed, the assertion
 * the hand-read audit could not make. `phantom` is a classified route nothing
 * serves — without which an EMPTY route table would satisfy every claim this
 * census makes.
 *
 * It is a pure function of two populations for a reason: the census test calls
 * it once on the real table and again on the real table PLUS a route that is
 * deliberately absent from every list, and asserts the second call names that
 * route. That is the file proving its own failure witness rather than asserting
 * it, and it is what stops a census that lists nothing from passing everything.
 */
export function rawRouteResidue(
  served: readonly RouteEntry[],
  censusKeys: readonly string[] = rawRouteCensusKeys(),
): { missing: string[]; phantom: string[] } {
  const claimed = new Set(censusKeys)
  const servedKeys = new Set(served.map(routeKey))
  return {
    missing: [...servedKeys].filter((key) => !claimed.has(key)).sort(),
    phantom: [...claimed].filter((key) => !servedKeys.has(key)).sort(),
  }
}
