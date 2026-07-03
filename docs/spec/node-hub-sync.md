# Spec: Node ⇄ Hub Sync — Upstream Read Path (Phase P7a)

Status: **approved for implementation** · 2026-07-03
Architecture context: `docs/offline-sync-architecture.md` §3–§4. P7 lands in
slices: **P7a (this spec) = the upstream sync foundation, read path** — a node
mirrors its hub's fleet (sessions/conversations) through the SAME protocol thin
clients use, plus the core/hub module boundary. P7b = write path (issue authoring
node→hub via the P3 outbox semantics). P7c = interacting with remote sessions
from a node. The ease-in rule: a node is just another client with a durable store.

## 1. Problem

A desktop connected to a remote/hosted hub today is a THIN client: hub gone =
everything gone. The architecture's answer is the full local node — but nothing
in the server can act as a *client of another server* yet, and the core/hub
module boundary ("day one rule", §4) was never actually enforced.

## 2. Design

### 2.1 Config

`~/.podium/config.json` gains `upstream?: { url: string, token: string }`
(parsed in @podium/core config alongside mode/serverUrl; absent = today's
behavior, byte-identical). `token` is a hub-minted client-session token (P7a
provisioning: `podium upstream mint` — a tiny CLI/proc on the HUB that inserts a
long-lived client_sessions row and prints the token; pairing UX comes later).

### 2.2 UpstreamSync (new core module, `apps/server/src/upstream.ts`)

A node-side client of the hub, reusing the THIN-CLIENT protocol end-to-end:
- WS to `<url>/client?v=<WIRE_VERSION>` with the token as the session cookie;
  hello advertises `caps: ['metadataDelta']`. Reconnect with backoff (mirror
  SocketHub's posture; simple flat/exponential is fine server-side).
- Catch-up via hub tRPC `sync.changesSince(cursor)` over HTTP with the same
  cookie; cursor persisted in the node's store (meta table) so restarts resume
  with a delta.
- Applies sessions + conversations into an **upstream mirror** (below). Issues
  are RECEIVED and stored for P7b but not merged into the node's IssueService
  yet (two issue stores merge in P7b — deliberately out of scope).

### 2.3 Upstream mirror (registry surface)

- `registry.setUpstreamSessions(list)` / `setUpstreamConversations(list)`:
  entities from the hub, EXCLUDING those originating from this node itself
  (filtered by machineId — the node's own machine registers with the hub daemon-
  side in some topologies; avoid echo duplicates).
- `listSessions()` returns local ∪ upstream, upstream entries marked
  (`machineName` from the hub payload already distinguishes; additionally
  `SessionMeta.viaHub?: boolean`, additive wire field) so the UI can badge them.
  Upstream sessions are read-only surfaces in P7a: command paths
  (sendText/kill/attach…) reject them with a clear reason ('remote session —
  managed via the hub').
- **Staleness semantics**: hub unreachable → mirror KEEPS last-known entries,
  marked stale (`upstreamStale: true` on the meta, additive) — that is the whole
  point (§3: "agents on other machines are read-only-stale until the link
  returns"). Local entities are never affected by upstream state.
- Mirror entries flow through the normal broadcast/oplog pipeline so node
  clients (browser/webview) see them live — but they are EXCLUDED from the
  node's own upstream PUSH (P7b) to prevent loops. Mark provenance now.

### 2.4 Module boundary (the deferred day-one rule)

- Create `apps/server/src/hub/` and move the FIRST clearly hub-only unit into it
  (pairing/PairingManager is the natural candidate — verify imports allow it
  cheaply; if the move is invasive, create the folder with the lint test and a
  README stating the rule, and move pairing in a follow-on — do not force a
  risky refactor into this slice).
- Enforcement: a unit test (not a linter plugin) that walks `apps/server/src`
  imports and fails on core→hub imports. Cheap, effective, no new tooling.

### 2.5 Out of scope (P7b/P7c)

Issue-store merging + node→hub write path; commands on remote sessions;
pairing UX; hub-side fleet management; transcript-lake sync node⇄hub; desktop
bootstrap changes (LocalDaemon mode keeps working unchanged).

## 3. Invariants

1. No upstream config = zero new behavior (all new code paths gated).
2. Upstream entities never enter the node's outbox/push path (provenance).
3. Hub loss degrades to stale-visible, never to blank; local work unaffected.
4. The node authenticates with a revocable hub credential (client_sessions row).
5. core never imports from hub/ (test-enforced).

## 4. Testing

- UpstreamSync against a REAL second registry/server instance (the sync-e2e
  startServer harness): node mirrors hub sessions/conversations; delta updates
  flow; cursor resumes across UpstreamSync restart; hub down → stale flag, data
  retained; node's own-machine entities filtered (no echo).
- Command rejection on viaHub sessions.
- Token auth: bad token → clean retry/log, no crash loop.
- Import-boundary test red/green.

## 5. Acceptance

- Two podium instances: node configured with upstream → hub's sessions appear
  in the node's UI stream (viaHub-marked), update live, survive a hub restart
  (delta resume), and persist as stale when the hub is stopped — while the
  node's local sessions/issues keep working untouched.
