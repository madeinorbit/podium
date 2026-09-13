# The served-read census: what it counts, what it excludes, and who owns the rest

PDM-248 (A5.4), repairing A3/PDM-129. Measured at OSS `b7248a5a2aff5a8484eddb5d483a0c5e93853b1b`.

## The defect this repairs

`apps/server/src/projection-census.test.ts` existed to prove every externally reachable read is
classified. It discovered the served population by importing twenty-nine query tables into a
`SERVED` array and appending one named hand-written exception, then compared the census against
that array. **A read absent from both lists was absent from the comparison too**, so the file was
green while measuring nothing about it.

That is not a hypothetical weakness. A3's receipt reported **69 externally reachable reads with
`machines.list` as the only hand-written exception**. The router actually mounts **108 tRPC
reads**, and seven hand-written queries were outside every instrument.

## What the gate now does

Discovery is bound to `appRouter._def.procedures` — the dispatch table tRPC itself routes on,
with `_def.type` as the verb it enforces on the wire. This is the same source
`router.settings-guard.test.ts` reads, and the only one that can see what is actually served. A
new family, a new query table, or a fourteenth hand-written query enters the population the moment
it is mounted, with nobody remembering anything.

## The real number

| | count |
|---|---|
| tRPC reads the router serves | **108** |
| classified by a command definition elsewhere (excluded, see below) | 32 |
| **the projection census owns** | **76** |
| — governed (`PROJECTION_POLICIES`) | 54 |
| — ungoverned findings (`UNGOVERNED_PROJECTIONS`) | 22 |

The test asserts 108, 76 and 32 separately so neither list can absorb the other silently.

### The seven reads that were outside every instrument

None had been waived; their families had simply never been added to the array the old test
discovered from. Four had no table to be forgotten from at all — they are `t.procedure.query(...)`
written out in a module the array never named.

| read | classification | why |
|---|---|---|
| `settings.viewer` | governed · `caller-only` · `settings-domain` · member | PDM-248's reported finding. Answers which settings commands **this caller** may attempt so a control renders disabled-with-a-reason (POD-421). Takes no input; `settingsAuthzDeps` resolves the principal from `ctx.capability` and reads `roleOf` for that principal's own user, so there is no way to ask about anybody else. Returns booleans, no settings value — which is why nothing is forbidden here while `settings.get` forbids three fields. |
| `layout.get` | governed · `caller-only` · `none` · member | `getSnapshot(actor)` with `actor` resolved from the principal; no input, so naming another person's layout is unrepresentable rather than refused (ADR 3 D7). A principal with no user is refused FORBIDDEN before the read. |
| `readPosition.get` | governed · `caller-only` · `none` · member | Identical shape to `layout.get`. How far someone has read is a fact about that person. |
| `updates.proposal` | governed · `instance-wide` · `global` · **admin** | `releaseProposalFor` checks `ctx.capability.role !== 'admin'` and returns `null` rather than throwing — a member is told there is nothing to approve, not refused. The sibling write re-checks the same grade and throws. |
| `updates.fleet` | **ungoverned** · owner **F** | Returns every machine's update state with no reader scoping, while `machines.list` — the only other fleet-wide read — routes through `visibleMachinesFor`. Two reads over the same population, one scoped and one not. |
| `operations.active` | **ungoverned** · owner **F** | Serves the live operation's stored bytes verbatim with no reader scoping. All three sibling *mutations* in the same file run `assertActionAuthorized` (admin grade, then a `manage` verb on `details.targetMachineId`); the read reaches that identical `details` object and asks neither question. |
| `operations.history` | **ungoverned** · owner **F** | The operation audit trail, same route and same missing question. The more durable disclosure of the two: a live operation ends, its record does not. |

## The 32 excluded reads, and why the exclusion is checkable

These are served through a definition that **already carries an ADR 3 policy**. They are
classified — on the command side, where `classification-totality.test.ts` keeps the population
total. A second `ProjectionPolicy` would be two answers to "how is this authorized", which is the
fork POD-386 spent a phase removing.

| family | reads | classifying table | instrument that keeps that table total |
|---|---|---|---|
| `issues` | 27 | `modules/issues/registry.ts` joined to `ISSUE_CONTRACTS` | `classification-totality.test.ts` (population) + `registry.test.ts` (the join, by object identity) |
| `messages` | 3 (`show`, `status`, `ledger`) | `modules/messages/registry.ts` joined to the mail contracts | `classification-totality.test.ts`, plus `mailQuery`/`mailMutation` refusing at module load when the wire verb and the contract action disagree |
| `lock` | 1 (`status`) | `modules/lock/registry.ts` (`defineCommands`) | `framework-facet-rules.test.ts` |
| `settings` | 1 (`secretPresence`) | `SETTINGS_CONTRACTS` | `router.settings-guard.test.ts` (whole-map equality, both directions) |

**The exclusion is derived and checked, never asserted.** `CLASSIFIED_ELSEWHERE` in the test reads
those real tables, and `resolves every exclusion it claims` requires each excluded name to produce
a declared `action` from the table that supposedly classifies it. A bare name cannot buy a read out
of the census: a hand-written `issues.probe` is not a key of `issueRegistry.defs`, so it lands in
the residue like any other unclassified read. The counterfactual below proves exactly that.

`issues.linearSearch` is worth naming: it declares `action: 'write'` on a procedure served as a
query, deliberately ("a query that requires write authority"). It is excluded because it is
classified, not because it is a read.

## The counterfactual — restore and break

Three uncensused reads were planted in `apps/server/src/router.ts`, chosen to attack the exclusion
rather than only the happy path:

1. `settings.counterfactualProbe` — a hand-written query inside a family that **has** a
   contract-table exclusion;
2. `messages.counterfactualProbe` — the same, inside the mail-join family;
3. `counterfactual.listEverything` — an entire newly mounted family, the "new table nobody listed"
   case the finding named.

The gate failed on three assertions and named all three paths:

```
× discovers 108 externally reachable tRPC reads
    expected [ 'accounts.list', …(110) ] to have a length of 108 but got 111
× splits them into 76 census reads and 32 classified elsewhere
    expected [ 'accounts.list', …(78) ] to have a length of 76 but got 79
× classifies every served read
    expected [ …(3) ] to deeply equal []
    + [ "counterfactual.listEverything", "messages.counterfactualProbe", "settings.counterfactualProbe" ]

Tests  3 failed | 14 passed (17)
```

`router.ts` was then restored byte-identical to the pin (`git diff` on it is empty) and the file
returned to **17 passed (17)**.

Note what (1) and (2) prove: the family-level exclusion does **not** absorb a hand-written query
added beside the contracted ones. Only the exact names the real tables produce are excluded.

## Outside this census: the raw HTTP, WebSocket and file route families

The census governs the **tRPC read surface**. The server also serves a raw Hono HTTP surface and
three WebSocket paths. Those are excluded from the projection census by decision, and recorded here
rather than left to a query-table count that stands in for the whole reachable surface. Each row
below was read at this pin.

### HTTP reads that return stored rows

| route | guard actually applied | verdict |
|---|---|---|
| `GET /auth/members/list` | admin: `roleOf(actor) === 'admin'`, else 403 | **governed.** Returns every member and the actor's invites behind an explicit admin floor. |
| `GET /auth/client-sessions` | authenticated, then `listMobileClientSessions(userId)` for the **caller's own** id | **governed, caller-only.** The caller's own devices; `current` is computed from the presented credential. |
| `GET /auth/status` | none needed | **governed.** Answers the caller's own auth state and the instance's readiness; returns no other person's rows. `userId` echoed is the caller's. |
| `GET /files/artifact/:issueId/:artifactId/*` | `clientAuthGuard` only (authentication) | **FINDING — owner B.** Any authenticated caller may fetch any issue's artifact bytes by id. No reader scoping of any kind; the route's own comment says "auth matches the rest of `/files/*`", which is authentication, not authorization. Same material and same gap as `files.read`, already an ungoverned census entry at owner B. |
| `GET /files/asset` | `clientAuthGuard`; the worktree arm additionally prefix-matches `allowsRoot` against registered repo roots after collapsing `..` | **FINDING — owner B.** The `root` arm is bounded to registered repos, which is a real rule but a rule about *paths*, not about *people*. The `sessionId` arm consults no session ownership at all and relies on the daemon's path sandbox. Same gap as `files.read`/`files.list`/`files.search`. |

### HTTP routes that are not reads of stored rows

`GET /version`, `GET /health`, `GET /readiness`, `GET /setup/mobile`, `GET /setup/config` — instance
facts about no person, the HTTP analogue of the census's `instance-wide` scope. `GET /` `/desktop`
`/mobile` `/mobile/*` serve the static bundle. **Excluded; no owner needed.**

`POST /auth/login`, `/auth/logout`, `/auth/users`, `/auth/server-transfer-claim`,
`/auth/members/{invite,revoke,remove,inspect,complete}`, `/auth/mobile-pair/*`,
`/auth/client-sessions/revoke`, `/maintenance/{handshake,command}` — **writes.** Outside a read
census by definition; they belong to the command classification, and PDM-247's migrations work and
the auth lanes own them. **Excluded.**

### `POST /mcp`

Token-gated (`x-podium-mcp-token`, a per-process UUID plus per-thread tokens), then dispatches
into the superagent's tool belt, which bridges the **issue command registry** — the same
definitions, with the same `authz`, that the `issues` tRPC family is excluded for. It serves no
projection of its own. **Excluded; classified by the issue registry**, owner as for the `issues`
family above.

### WebSocket `/client`, `/daemon`, `/machine`

`/client` refuses on origin, then resolves a principal (`principalForClient`) and a role and
answers 401 when either is absent, then prepares the machine set through
`prepareMachines(userClientPrincipal(...))` — a per-principal computation, not an ambient one. What
it then *streams* is the feed, whose row scoping is the owner-or-grant predicate in
`apps/server/src/feed-visibility.ts`.

**Excluded from this census, owner C (PDM-144).** The three `sync.*` reads are already in
`UNGOVERNED_PROJECTIONS` at owner C for precisely this reason: the feed principal fallback is the
seam C4 replaces, and classifying it here would either freeze today's predicate in a second place
or pre-empt C4's decision. The WebSocket arm reaches the same predicate, so it inherits the same
owner rather than acquiring a second, competing answer.

`/daemon` and `/machine` upgrade to the daemon and machine planes — infrastructure peers
authenticated by the pairing/enrollment ledger, not human-facing read surfaces. **Excluded.**

## What this document does not claim

- It does not claim the 76 are all *correctly* governed. 22 of them are recorded findings with
  named owning phases; that is the census reporting what it found.
- It does not change the task read predicate. Phase A stays off task delivery; C4/PDM-144 owns it.
- It does not extend the tRPC gate to the HTTP and WebSocket families. The two findings above
  (`/files/artifact/*`, `/files/asset`) are recorded with owner B, beside the `files.*` entries they
  duplicate over a different transport, and a gate over the Hono route table is work phase B can
  take with them.

---

## Closures recorded after this snapshot

Append-only, newest last. **The rows above are not edited.** Each was true at this document's
pin (`b7248a5a2aff5a8484eddb5d483a0c5e93853b1b`) and stays true about that moment; a row rewritten
to say "fixed" would turn a dated measurement into a status board nobody re-derives. Ruled by the
PDM-107 coordinator on 2026-09-13.

Each line is a **pointer, not a claim of correctness**. What proves a row closed is the instrument
re-run — so each line says which instrument, and says so honestly when there is none.

- **2026-09-13** — row: `GET /files/artifact/:issueId/:artifactId/*` (HTTP reads that return
  stored rows). Closed by **PDM-261** at OSS `9db408f600a5e7e270641a6b32cd0755bb3d9219` on
  `issue/pdm-261-artifact-route-authz`, branched from `issue/pdm-107-multi-user` at
  `6ab16399971aaf76713f33e4e2043bb383947911`. **Not yet landed on the integration ref** at the time
  of writing — the coordinator lands it.
  The route no longer receives `registry.modules.issueArtifacts`; it receives one caller's
  `FileAccessGate` and reads through `readArtifact`, which runs `checkIssueAccess` — the same rule
  `files.read` runs over these same bytes.

  **NO COMMAND RE-DERIVES THIS ROW, and that is the honest answer rather than a missing one.**
  `projection-census.test.ts` governs the tRPC surface only and says so at its own line 64: *"The
  raw HTTP, WebSocket and file-route families are OUTSIDE this census."* This section of the
  document was hand-read at the pin — *"Each row below was read at this pin"* — so there is no
  instrument to re-run, which is the same gap "What this document does not claim" names when it
  says a gate over the Hono route table is work phase B can take.

  What witnesses the closure instead is a test, not an audit:
  `apps/server/src/file-artifact-route.authz.test.ts` drives this route and `files.read` over one
  constructed `fileAccessGate`. Deleting the single `checkIssueAccess` call inside `readArtifact`
  reddens four cases there and one in `modules/files/queries.authz.test.ts` at once — which is what
  shows the two transports run one rule rather than two lookalikes. Run it with:

      bun run --cwd apps/server test:boundary -- src/file-artifact-route.authz.test.ts

  A closure line is worth exactly as much as the thing it points at; this one points at a test that
  fails when the rule is removed.

- **2026-09-13** — NOT A ROW CLOSURE. **The instrument this document said phase B could take now
  exists**, and the sections above are superseded as a source of truth about the raw HTTP and
  WebSocket surfaces. *"What this document does not claim"* ends by saying a gate over the Hono
  route table is work phase B can take; **PDM-353** took it, at OSS
  `d277c91edd1809fb1400cfe8a805c3cc3d32d2b8` on `issue/pdm-353-raw-route-census`, branched from
  `issue/pdm-107-multi-user` at `4d5ba336c785ac122a48322174501c64e07f9a2b`. **Not yet landed on the
  integration ref** at the time of writing — the coordinator lands it.

      bun run --cwd apps/server test:boundary -- src/served-route-census.test.ts

  `apps/server/src/served-route-census.test.ts` derives its population from
  `ServerHandle.httpRoutes` — `app.routes` snapshotted after every registration has run — so a
  route added anywhere enters the census with nobody remembering anything. The WebSocket planes are
  a second population derived from `WEBSOCKET_UPGRADE_PATHS`, which is now the object
  `handleRequest` itself decides on.

  **THE HAND-READ SECTIONS ABOVE HAD ALREADY GONE STALE, and the first derived measurement is what
  showed it.** They are not edited — they are a dated measurement and stay true about their own pin
  — but a reader must not take them for the current surface:

  - The **`/updates/feed/dev/*` family is absent from them entirely**. The server serves six routes
    there (`latest.json`, `podium-update.json`, and GET+HEAD on two artifact patterns).
  - **`POST /mcp` is listed alone.** `GET /mcp` and `DELETE /mcp` are also registered; both answer
    405 and reach nothing, which is harmless — and is exactly the kind of omission a derived
    population cannot make.
  - The **`/client` exclusion's justification no longer holds.** It reads: *"The three `sync.*`
    reads are already in `UNGOVERNED_PROJECTIONS` at owner C for precisely this reason."* At this
    pin no `sync.*` entry remains in that list. The exclusion may still be right; the reason given
    for it is not. PDM-353 re-read all three planes from `gateway/ws-server.ts` rather than carrying
    any verdict across, and records that `/daemon` and `/machine` are **upgraded before anything is
    asked of them** — authentication is deferred to `wireDaemonSocket`'s handshake acceptor.
    Describing them as "authenticated by the pairing/enrollment ledger", as the row above does,
    hides that ordering.

  What did NOT change: `GET /files/asset` is still the one raw route that reads stored rows with no
  reader scoping, and the census lands asserting it as such. PDM-262 has a fix on
  `issue/pdm-262-asset-route-gate`, which is not an ancestor of this pin.
