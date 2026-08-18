# Spec: Narrow Session Projection Bridge

Status: **proposed** · 2026-08-17

Architecture context: POD-2262's live typing-stall profile and POD-2294's bounded
working-set sync specification. This is the **small bridge**, not the full working-set
architecture. It keeps the current protocol, world feed, client Replica, and database schema
unchanged while removing avoidable full-session projection work and bounding volatile
publication turns.

## 1. Decision

Make two server-only changes:

1. Replace internal “build every `SessionMeta`, then keep one or a few” call sites with
   candidate-first reads over the live session source. The selected candidates still pass
   through the existing visibility and wire projection code.
2. Drain volatile session captures in version-checked, time-budgeted slices. Regular
   publication yields between slices; an explicit shutdown/test barrier may still drain all
   remaining work synchronously.

Do **not** add a long-lived `SessionMeta` cache, dependency graph, materialized projection,
new feed, or client subscription API.

The bridge is correct by construction: every read starts from current live truth, and every
published volatile row is recomputed from current truth before entering the existing
Authority/change-log path. There is no new cache to invalidate.

## 2. Why this is the bridge

The profile measured `sessionView.list` at 486.9 ms p50, 951.4 ms p99, and 4.53 s maximum
over 1,889 sessions. Many internal callers ask a point, membership, or policy question but
pay for authorization, issue/grant lookup, overlay resolution, machine/harness fields, and
wire allocation for every session.

The existing code already proves the narrow-read pattern:

- `SessionView.byId()` is equivalent to `list().find(id)` and projects one candidate;
- `SessionView.listForIssue()` is equivalent to filtering the full list and projects issue
  members only;
- `SessionView.spawnedByOf()` answers one authorization-chain fact without wiring a row;
- the live sessions are already keyed by id in `Map<SessionId, Session>`;
- volatile changes are already coalesced by session id and carry a mutation version.

The bridge finishes that decomposition on hot production paths and uses the existing dirty
map as a work queue. It does not introduce the bounded client working set, named
subscriptions, per-subscription cursors, TTL eviction, or reduced reconnect payloads from
the full architecture.

## 3. Goals

1. Point and issue-scoped server questions perform expensive work proportional to their
   candidates, not to the full session corpus.
2. No ordinary volatile-publication turn monopolizes the event loop for hundreds of
   milliseconds.
3. Reader visibility, wire fields, ordering, deduplication, retry, and shutdown durability
   remain unchanged.
4. No cross-call projection cache or invalidation registry is created.
5. The resulting narrow query seams can later back named working-set subscriptions without
   another call-site migration.

## 4. Non-goals

- Changing what sessions any client receives.
- Reducing cold-start rows, reconnect bytes, or durable client storage.
- Adding Electric/Zero-style subscriptions or shapes.
- Replacing the Authority, change log, Replica, Outbox, commands, or SQLite.
- Making every intentional full-world operation incremental in this change.
- Time-slicing Authority transactions that require atomic multi-row visibility.
- Changing PTY/input routing, daemon frames, or client behavior.

## 5. Read model

### 5.1 Three read classes

Every production session read must be classified as one of these:

| Class | Examples | Required API |
| --- | --- | --- |
| Reader-scoped narrow projection | session by id, sessions for one issue, a known set of ids | `sessionById`, `listSessionsForIssue`, `sessionsById` |
| Trusted internal fact | existence, worktree use, parent id, lifecycle/machine eligibility | a named fact read owned by the sessions module |
| Intentional full reader projection | full client bootstrap/list, explicit “list all sessions” tool | `listSessions` with an allowlisted reason |

Naming: `sessionById` / `listSessionsForIssue` / `sessionsById` are the sessions-module
facade operations; `byId` / `listForIssue` / `byIds` are the underlying `SessionView`
methods they delegate to. Migration tables use the facade names because that is what call
sites import.

The distinction matters. A reader-scoped result must still run `canReadSession` and
`SessionView.wire`. A trusted policy path should not allocate public wire rows merely to read
an internal field, but it must not expose its unscoped facts to a client response.

### 5.2 Candidate-first projection

`SessionView` keeps one projection body:

```ts
project(candidates: Iterable<Session>, principal?: SessionStatePrincipal): SessionMeta[]
```

All reader-scoped methods select candidates first, then call this body:

```ts
byId(id, principal)                    // Map lookup; 0 or 1 candidate
listForIssue(path, issueId, principal) // cheap raw-field scan; usually a few candidates
byIds(ids, principal)                  // cheap source-order scan; 0..ids.length candidates
list(principal)                        // all candidates; explicitly expensive
```

`byIds` is the only new generic projection shape in this bridge. It deduplicates the requested
ids, scans the live map in its existing source order, and therefore returns exactly the order
that `list().filter(requestedIds)` returned. It uses one per-call memo and applies the same
visibility/wire path as `list`. Callers must not use it with an unbounded id set as a disguised
full list.

Candidate selection may scan the live `Map` when the predicate is cheap. For the profiled
corpus, scanning 1,889 raw objects is acceptable; wiring and authorizing 1,889 public rows is
the measured problem. Do not add an issue/worktree membership index in this bridge.

### 5.3 Named internal fact reads

Trusted internal callers that do not return `SessionMeta` use named operations owned by the
sessions module. Examples include:

```ts
hasReadableSession(id, principal): boolean
sessionSpawnedBy(id, principal): string | undefined // already exists
sessionIdsUsingWorktree(path): SessionId[]
sessionFactsForIssue(path, issueId): SessionPolicyFacts[]
```

Add only facts required by migrated hot callers. Do not expose `Session[]`, the backing map,
or a generic predicate callback across the module boundary. That would turn internal model
shape into an ambient API and allow authorization to be bypassed accidentally.

Fact DTOs contain the minimum fields the named policy operation needs. They are not cached,
not persisted, and not valid as wire responses.

### 5.4 Production call-site migration

Migrate these patterns wherever they occur on mutation, authorization, delivery, issue, or
lifecycle paths:

| Existing pattern | Replacement |
| --- | --- |
| `listSessions().find(s => s.sessionId === id)` | `sessionById(id)` |
| `listSessions().some(s => s.sessionId === id)` | `hasReadableSession(id)` or `sessionById(id) !== undefined` |
| `sessionsForIssue(path, listSessions(), issueId)` | `listSessionsForIssue(path, issueId)` |
| filter a known id set after `listSessions()` | `sessionsById(ids)` |
| full wire list used only for worktree/lifecycle facts | a named internal fact read |

Initial audited targets include:

- message delivery, mailbox, rendering, and handler context point lookups;
- issue-session lifecycle and issue membership resolution;
- session teardown/worktree-use checks;
- issue mail nudge selection in session wiring;
- messaging's issue-recipient selection;
- relay and command paths that keep one id after a full list.

Full projections may remain only where the output is intentionally the entire reader-visible
session world, such as compatibility bootstrap/list serving and an explicit list-all tool.
Supervisory code that needs every session but only internal fields must use a fact read, not
public `SessionMeta` projection.

### 5.5 Enforcement

Add a source audit over production files that rejects:

- `listSessions().find(...)`;
- `listSessions().some(...)`;
- `sessionsForIssue(..., listSessions(), ...)`;
- a new `listSessions()` dependency outside an explicit allowlist.

Each allowlist entry names the full-world consumer and why a narrow result cannot satisfy it.
Tests and compatibility fixtures may use the full list as an oracle.

## 6. Why there is no cache invalidation problem

The bridge stores no projected result across calls:

1. candidate selection reads the current live `Session` objects;
2. visibility reads current grants/issues through the existing `SessionStateService`;
3. wiring reads current overlay, machine, occupancy, harness, and reference data;
4. the result is returned or published and then discarded;
5. the existing per-call memo dies with that one projection pass.

A future field added to `SessionView.wire` therefore appears automatically in point, issue,
id-set, and full reads because they share the same projection body. No mutation writer must
remember to invalidate a second object.

The only persistent lookup is the existing live session map, which is already the runtime
source of truth. The bridge changes how many of its values are projected, not how that map is
maintained.

## 7. Volatile publication

### 7.1 Current behavior

`pendingVolatileSessions` already maps each dirty session id to:

- a monotonically increasing mutation version;
- the durable fields to preserve on rollback;
- the `issueRelevant` marker.

`flushVolatileSessionCaptures()` currently copies the whole pending map, wires every resident
session synchronously, captures one batch, and then removes unchanged-version entries. A
large dirty set therefore becomes one long event-loop turn.

### 7.2 Sliced drain API

Split scheduled draining from the explicit full barrier:

```ts
drainVolatileCaptureSlice(budget: {
  maxItems: number
  maxCpuMs: number
}): { changes: MetadataChange[]; remaining: number }

drainAllVolatileCaptures(): MetadataChange[] // dispose and deterministic tests only
```

Initial internal budgets are `maxItems = 32` and `maxCpuMs = 8`. The loop checks elapsed time
between candidates, so one candidate is never abandoned halfway through. These constants are
observable and testable; they are not user configuration in this bridge.

### 7.3 One slice

Per selected pending entry:

1. record `(sessionId, version, preserve, issueRelevant)`;
2. read the resident session;
3. if resident, build its current wire row through `SessionView.wire` and add it to this
   slice's capture specs.

Then, once per slice:

4. capture the accumulated specs through the existing ledger/Authority path, with
   `issueRelevant` computed over this slice's entries (today it is computed over the whole
   batch; per-slice is strictly more precise);
5. only after successful capture, update `capturedSessionStates` and remove each pending
   entry whose current version still equals its recorded version.

If a session disappeared, preserve current behavior: it produces no upsert and its matching
pending entry is cleared after the successful no-op slice.

There is no `await` inside one candidate or ledger capture. A newer mutation can occur only
between event-loop turns. If it does, it increments the map version; the equality check keeps
that session pending for a later slice. A yield can delay the newest value but cannot lose it
or replace it with an older cached value.

### 7.4 Scheduling and ordering

Regular publication performs one slice, flushes the resulting ordered deltas, and, when work
remains, schedules one zero-delay timer for the next slice. It must not recursively drain the
remainder or use a microtask chain, because either would recreate event-loop starvation.

The pending map remains the coalescing queue:

- at most one entry exists per session;
- repeated mutations replace its version and merge preservation flags;
- no duplicate FIFO grows during churn;
- insertion order provides deterministic progress.

Rows keep Authority order between slices. One slice commits before the next starts. Volatile
fields are per-session final-state updates, so separate batches are legal. Any operation with
a real multi-row atomic-visibility requirement must bypass this queue and remain one explicit
Authority commit.

One accepted semantic change: A→B→A churn that today lands in a single drain dedupes to no
durable change, but if the two mutations straddle a slice boundary the intermediate value B
is durably captured before A is captured again. The client-visible final state is identical;
only the durable change count differs. Tests must assert final-state equality, not
durable-change counts, across slice boundaries.

### 7.5 Flush barrier and shutdown

`flushBroadcasts()` retains its current barrier semantics for deterministic tests and graceful
shutdown: it drains all pending slices synchronously, then flushes deltas. The scheduled timer
must call a new one-slice entry point rather than this barrier. Concretely: today
`SessionRepository.scheduleVolatileSessionCapture` fires `ports.flushBroadcasts()`, whose
flush chain runs the full `flushVolatileSessionCaptures()` drain. The timer callback switches
to `drainVolatileCaptureSlice` + delta flush; the barrier path (`lifecycle.dispose` and test
harnesses) keeps the full drain.

Production request, daemon-frame, and timer-driven publication must never call the full
barrier. The source audit records the small allowlist: shutdown/dispose and test harnesses.

This separation keeps graceful shutdown from losing a resize or geometry update without
letting ordinary traffic use shutdown semantics.

### 7.6 Failure and retry

If capture of a slice throws:

- remove none of that slice's pending entries;
- update no captured durable-state checkpoint;
- publish no cursor or delta from the failed transaction;
- schedule the existing delayed retry;
- retain successfully committed earlier slices.

A repeatedly failing session can delay later entries only until the slice fails. On retry the
same deterministic slice is attempted. Logging includes the slice size, pending count, and
oldest pending age so a poison row is diagnosable.

## 8. Instrumentation

Retain the existing phase metrics and add:

- `sessionView.list`, `.byId`, `.listForIssue`, and `.byIds`: count, duration, candidate count,
  visible count, and a bounded caller label;
- `volatileCapture.slice`: duration, candidates, captured rows, and remaining backlog;
- `volatileCapture.retry`: failures and oldest pending age;
- `volatileCapture.barrier`: duration and reason (`dispose` or `test`).

Caller labels are a closed vocabulary defined at the narrow ports, not arbitrary strings from
every call site. This makes any remaining full-list hot path attributable.

## 9. Migration and rollout

### Step 1 — Finish narrow reads

Add `byIds` and only the named fact reads required by the audited hot callers. Migrate point,
issue, id-set, and policy call sites. Land the source audit with the intentional full-list
allowlist.

This step is behavior-preserving and can ship independently. It should reduce total CPU even
before publication is sliced.

### Step 2 — Slice volatile capture

Introduce the slice entry point, continuation timer, full barrier, retry behavior, and metrics.
Keep the existing capture payload, ledger, deduplication, and feed serving unchanged.

The implementation may carry a server feature flag for immediate rollback during the first
live profile. The off path is today's full drain; no stored-data migration is involved.

### Step 3 — Re-profile

Repeat the live typing workload and compare the same phase/task metrics from POD-2262. Remove
the flag after the bridge meets its gates and remains stable through one normal workload
window.

## 10. Verification

### 10.1 Narrow-read equivalence

- For randomized session corpora and principals, assert:
  - `byId(id, p) === list(p).find(id)`;
  - `listForIssue(path, issue, p) === sessionsForIssue(path, list(p), issue)`;
  - `byIds(ids, p) === list(p).filter(row => ids.has(row.sessionId))`, including source order.
- Include absent, invisible, archived, explicit-issue, cwd-derived, and overlapping-id cases.
- Existing narrow and full paths must call the same `project`/`wire` implementation.

### 10.2 Scaling

Use projection counts, not wall-clock assertions:

- by-id: at most one visibility check and one wire regardless of corpus size;
- by-ids: at most the number of distinct requested resident ids;
- issue-scoped: visibility/wire count equals candidate members, not corpus size;
- named internal fact reads: zero `SessionView.wire` calls;
- no hot mutation/eligibility path calls `SessionView.list` in a 2,000-session corpus.

### 10.3 Volatile drain

With a deterministic scheduler and clock, prove:

- a backlog larger than `maxItems` drains over multiple timer turns;
- elapsed budget stops a slice between candidates;
- deltas preserve session changes and Authority sequence across slices;
- a mutation between slices remains pending and publishes its newest value;
- same-turn A→B→A churn still deduplicates to no durable change;
- capture failure removes nothing from the failed slice and retry converges;
- non-resident sessions retain current no-upsert behavior;
- `flushBroadcasts()` drains all work for dispose/tests;
- regular scheduled publication drains only one slice per turn.

### 10.4 Live acceptance gates

Profile at no less than 2,000 sessions and 1,000 referenced issues:

- `sessionView.list` is absent from point, issue-mutation, message-delivery, authorization, and
  volatile-capture hot paths;
- a point read's projection count stays constant as the corpus grows;
- ordinary `volatileCapture.slice` p99 is below 16 ms and no slice exceeds 50 ms; any single
  candidate exceeding the 8 ms target is separately attributed;
- typing-input p99 remains below 50 ms during the profiled agent/issue mutation workload;
- no server stall above 100 ms is attributed to full session projection or scheduled volatile
  publication;
- final client session state equals the unsliced control after identical mutation sequences.

## 11. Relationship to the full fix

This bridge is **not** Electric v2 or Zero. Clients still receive the principal-visible world,
and bootstrap, reconnect bytes, and client storage still scale with that world.

It is compatible with the full design:

- `byId`, `listForIssue`, and `byIds` are candidate selectors a later named-query registry can
  reuse;
- one shared `project` body preserves the oracle the full subscription evaluator needs;
- sliced publication supplies the event-loop fairness a subscription worker also needs;
- no temporary projection cache must be removed or migrated later.

The full working-set architecture remains specified separately in
`docs/spec/working-set-sync.md`. Implementing this bridge neither commits Podium to that
architecture nor makes later adoption harder.

## 12. Acceptance

The bridge is complete when:

1. Hot production point, issue, id-set, and internal-fact reads no longer build a full
   `SessionMeta[]`.
2. A source audit prevents those anti-patterns from returning.
3. Scheduled volatile publication yields between bounded slices with no lost or stale final
   value.
4. Equivalence, scaling, retry, ordering, shutdown, and live performance gates pass.
5. The protocol, client store, database schema, and externally visible session results remain
   unchanged.

