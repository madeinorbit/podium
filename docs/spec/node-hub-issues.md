# Spec: Node ⇄ Hub Issues — Visibility + Write Forwarding (Phase P7b)

Status: **approved for implementation** · 2026-07-03
Builds on P7a (`docs/spec/node-hub-sync.md`): the node already receives the hub's
issues and stores them as an unmerged blob (`upstream_issues`). P7b makes them
USABLE from the node — visible in the issues UI and editable with offline-queued,
idempotent write forwarding — WITHOUT merging the two issue stores.

## 1. The store-merge trap (why forwarding, not merging)

Issues are keyed to `repo_path` on a machine; repos themselves are path-keyed
(the known identity-audit gap — `repo_id` by originUrl is a registry follow-on).
Merging a node's and a hub's issue stores without stable repo identity would
conflate different checkouts and split identical repos. So P7b keeps ONE
authority per issue: issues live where they were created; the node gets a live
VIEW of hub issues plus a durable write path to them. True store federation
waits for `repo_id` (file the dependency in the spec's follow-ons).

## 2. Design

### 2.1 Upstream issues in the node's stream (read)

- The `upstream_issues` replica (already durable from P7a) merges into the
  node's ISSUE WIRE only — `issuesChanged` snapshots, `metadataDelta`, and
  `syncChangesSince` include local ∪ upstream — never into `IssueService`'s
  store or its derived logic (ready/blocked/deps stay hub-computed and arrive
  precomputed on `IssueWire`).
- `IssueWire.viaHub?: boolean` (additive) stamped at ingest; `upstreamStale`
  semantics identical to sessions (hub loss = stale-but-visible).
- Id collisions are impossible by construction (`iss_<uuid>`), but guard anyway:
  a local issue id wins; log the anomaly.

### 2.2 Write forwarding (node → hub)

- Issue mutations targeting a `viaHub` issue (update/close/addComment/claim/
  label/defer/… — every `issues.*` write proc) are FORWARDED: the node's router
  detects the viaHub target and hands the call to an `UpstreamForwarder` instead
  of the local IssueService.
- Forwarder = durable outbox (P3 pattern, server-side): `upstream_outbox` table
  `(mutation_id PK, proc, input JSON, queued_at, attempts)`; each entry replays
  to the hub's tRPC with the SAME token/cookie as UpstreamSync and its
  `mutationId` (the hub's P3 idempotency makes retries safe). Drain: serial,
  on enqueue + upstream (re)connect + flat retry timer; PACED (watchdog rule:
  yields between entries).
- UX semantics: the mutation returns `{queued: true}` when the hub is
  unreachable; optimistic application happens NODE-side by patching the
  upstream replica entry (marked `pendingSync: true` additive on the wire) so
  the UI reflects the edit immediately; the hub's next delta/snapshot overwrites
  with truth (replica never argues — P6a invariant reused).
- `issues.create` on the node ALWAYS creates locally in P7b (creating INTO the
  hub needs repo mapping — out of scope; reject `repoPath`s that only exist
  upstream with a clear error if detectable, else document).

### 2.3 Out of scope / follow-ons

Store federation (needs `repo_id`); create-on-hub; hub→node issue commands;
conflict UI beyond pendingSync; issue attachments; steward/assistant flows on
upstream issues (node-side assistants must not act on viaHub issues — gate).

## 3. Invariants

1. `IssueService`'s store never contains upstream rows (test-enforced query).
2. Every forwarded mutation carries a mutationId; a replay after reconnect
   cannot double-apply (hub-side P3 guarantees; node asserts by e2e).
3. Hub unreachable: reads stay (stale), writes queue durably, local issues
   completely unaffected.
4. No upstream config → zero behavior change.

## 4. Testing

Two-instance e2e (P7a harness): hub issue appears in node's issue stream
(viaHub); node edits it while hub UP → hub store changes, node replica converges
via delta; node edits while hub DOWN → `{queued}`, pendingSync visible, hub
restarts → outbox drains, hub has exactly ONE application (idempotency), replica
converges, pendingSync clears. Unit: router forwarding detection, outbox
drain/pacing/retry, replica optimistic patch + truth overwrite, local-store
purity, assistant gate.

## 5. Acceptance

From a node with a configured hub: hub issues appear alongside local ones
(marked), editing one offline queues and shows pending, and reconnecting
delivers the edit to the hub exactly once — while local issues behave as if
none of this existed.
