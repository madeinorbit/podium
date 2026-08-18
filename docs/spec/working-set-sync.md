# Spec: Bounded Working-Set Sync

Status: **proposed** · 2026-08-17

Architecture context: POD-1826's architecture assessment, industry comparison, and
working-set gap analysis; POD-2262's live typing-stall profile. This specification is the
full fix. It replaces the principal's full-world client feed with named, bounded
subscriptions while preserving Podium's existing Authority, Replica, Outbox, command
contracts, SQLite deployment, and separate live-stream planes.

## 1. Decision

Podium will adopt a **Zero-like client contract** over an **Electric-like delivery model**:

- Screens declare named, parameterized subscriptions. The union of active subscriptions,
  recently used subscriptions within retention, and explicit offline pins is the device's
  working set.
- The server remains authoritative. Existing commands are the only write path; optimistic
  state remains an overlay over authoritative rows.
- Subscription snapshots and changes are cursor-addressed and resumable. A server may lose
  all in-memory subscription state and recover from SQLite plus the durable change log.
- The existing normalized Replica store remains. Subscription membership becomes provenance
  on rows in that store; it is not a second query cache.
- Query maintenance is incremental only where it can prove equivalence with a fresh query.
  Otherwise the same contract falls back to a bounded snapshot. Correctness never depends on
  an incomplete invalidation list.

This is closer to **Zero** in product behavior: active queries define what is local, their
results stay synchronized, overlapping results share one local store, and commands can be
optimistic. It is closer to **Electric v2** operationally: writes remain in the application's
API, reads are bounded shapes with cursors, and correctness does not require a durable
per-client server cache.

It is not an adoption of either product. Podium keeps SQLite, its command vocabulary,
Authority, global ordering, Replica recovery ladder, and Outbox. It adds the missing scope
contract to those components.

## 2. Problem

Today a client's default sync scope is effectively “every row this principal may see.” That
makes several costs grow with installation history rather than with the open screen:

- bootstrap and reconnect payloads;
- client storage and derivation work;
- server authorization, joining, and wire projection;
- publication work after a small mutation.

The live profile measured `sessionView.list` at 486.9 ms p50, 951.4 ms p99, and 4.53 s
maximum over 1,889 sessions. The input handler itself averaged about 2.6 ms. Typing stalls
occur because a keystroke waits behind unrelated full-world work on the same event loop.

Time-slicing publication limits one pause, but it does not remove the total work. Narrow
server reads remove some work, but the client still asks for a world. The full fix changes
the unit of synchronization from a principal-visible world to a bounded working set.

## 3. Goals

1. First useful paint and steady-state publication scale with active subscriptions, not with
   tenant history.
2. A small source change projects only affected query results.
3. The client keeps one normalized, durable, offline-capable store.
4. Authorization and query membership remain server decisions.
5. Loss, restart, compaction, authorization change, and version skew always converge without
   a stale row becoming permanent.
6. No long-lived projection cache becomes a second source of truth.
7. Migration is domain-by-domain and can fall back to the current world feed until measured
   gates pass.

## 4. Non-goals

- An arbitrary client-defined query language or ZQL clone.
- Replacing SQLite with Postgres, adding `zero-cache`, or embedding Electric.
- Changing command semantics, write arbitration, Outbox durability, or optimistic reducers.
- CRDT or peer-to-peer writes.
- Changing PTY, presence, transcript-stream, daemon, or machine-control planes.
- Active-active authorities or multi-region ordering.
- Deleting the world feed before every migrated domain passes equivalence and performance
  gates.

## 5. Terms

**Named query** — a server-owned, versioned query definition such as
`sessions.sidebar.v1` or `issues.board.v1`. Clients may choose parameters, but cannot send an
arbitrary predicate.

**Subscription key** — query name, query version, and canonical parameters. It is stable on
the client and contains no authorization claim.

**Scope token** — an opaque server value binding a subscription key to the authenticated
principal, feed identity, query-definition version, and current authorization generation.
It changes whenever an existing cursor can no longer describe the same result set.

**Working set** — rows retained by at least one active subscription, an inactive subscription
inside its TTL, or an explicit offline pin.

**Membership provenance** — the set of subscription keys currently retaining a row. It
prevents closing one subscription from evicting a row still used by another.

**Source cursor** — the existing global Authority sequence. Filtered subscriptions advance
through source ranges even when no matching row exists, using watermarks.

## 6. Architecture

```text
 command
    |
    v
 Authority: authorize -> arbitrate -> write + append -> publish
                               |
                               | immutable ordered source changes
                               v
                    Named-query evaluator registry
                      | snapshot       | affected rows
                      v                v
                 bounded slice   scoped delta/watermark
                      \                /
                       cursor-resumable serving
                                |
                                v
                   Subscription coordinator
                                |
                                v
              Replica base + membership provenance
                                |
                                v
                       optimistic overlay -> UI
```

The Authority remains the only durable truth and the only component that orders changes.
Named-query evaluators are derived read logic. Their in-memory queues and shared computation
may be discarded at any time; clients recover through a bounded subscription snapshot or an
exact replay.

### 6.1 Named-query registry

Every query is registered centrally and has one implementation:

```ts
interface SyncQueryDefinition<Params> {
  readonly name: string
  readonly version: number
  readonly params: Schema<Params>
  readonly outputKinds: readonly MetadataEntityKind[]
  readonly dependencyKinds: Readonly<Record<MetadataEntityKind, DependencyMode>>

  authorize(principal: Principal, params: Params): void
  snapshot(read: ConsistentRead, principal: Principal, params: Params): QueryRow[]

  // Optional. Without a certified incremental evaluator, a relevant change
  // produces refresh-required and the client obtains a bounded snapshot.
  affected?(change: ImmutableSourceChange, params: Params): readonly EntityKey[]
  project?(
    read: ConsistentRead,
    principal: Principal,
    params: Params,
    candidate: EntityKey,
  ): QueryRow | 'absent'
}
```

`dependencyKinds` is exhaustive. Adding a new source kind requires every query definition to
classify it as `irrelevant`, `incremental`, or `refresh`. Omission is a build failure, not an
implicit “unrelated” decision.

Queries are data-layer contracts, not component names. A view may compose several named
queries, and web/mobile/desktop use the same definitions. The first pilot is
`sessions.sidebar.v1`, bounded by status/archive policy plus an explicit page size. Point reads
use `sessions.byId.v1`; issue membership uses `sessions.forIssue.v1`.

### 6.2 Safe baseline and certified incrementality

The protocol has one contract with two legal server answers:

1. **Bounded snapshot** — evaluate the named query at a consistent source cursor and replace
   only that subscription's membership.
2. **Scoped delta** — advance from one source cursor to another with explicit upserts,
   removals/evictions, and a watermark.

A query begins in snapshot/refresh mode. It may enter incremental mode only when all of the
following are true:

- every dependency kind is classified;
- `affected` returns every result key whose membership or value might change, using immutable
  source-change facts rather than mutable current state;
- `project` evaluates those candidates under the same authorization and projection code as
  `snapshot`;
- a property test proves that applying generated deltas after any valid mutation sequence
  equals a fresh snapshot at the same cursor;
- a planted missing dependency makes that test or the dependency audit fail.

Over-invalidation is correct and initially acceptable. Under-invalidation is forbidden. If
an evaluator cannot identify prior members safely—for example, a join change lacks enough
before-state—the server sends `refresh-required`; it never guesses.

This fallback is what prevents cache-invalidation bugs while query families are migrated.
The client contract does not change when a query later gains certified incremental delivery.

### 6.3 Immutable source changes

Incremental evaluation must not read a mutable live object and attach an older cursor to its
newer value. A source change therefore carries, or can transactionally resolve, the facts
needed to evaluate the transition at that sequence:

- entity kind and key;
- operation and authoritative post-image;
- routing facts before and after the change for predicates supported incrementally;
- explicit affected keys for cross-entity dependencies that cannot be derived from the
  changed key alone.

These facts are written with the entity mutation and change-log append. They are internal
Authority data, not a second public entity representation. Existing change rows without the
facts remain valid; crossing that history horizon returns a bounded snapshot.

Grant, role, or other authorization changes do not rely on row-by-row routing. They advance
the principal's authorization generation. Live subscribers receive an ordered scope reset;
offline subscribers discover the changed scope token on reconnect and atomically replace
that subscription before its old rows are considered current.

### 6.4 Server subscription serving

The durable serving API is logically:

```ts
openSubscription({ key, resume? }) ->
  | { kind: 'snapshot', scopeToken, throughSeq, rows }
  | { kind: 'delta', scopeToken, fromExclusive, throughSeq, changes }
  | { kind: 'refresh-required', scopeToken, throughSeq }
```

Snapshots may use the Replica's existing chunked-install mechanism. Delta changes retain the
existing distinction between global deletion and principal/query eviction.

A WebSocket registration supplies low-latency pushes for active subscription keys. It is an
optimization, not required state: every pushed range is recoverable through
`openSubscription`. Reconnect may land on any server process that can reach the same SQLite
authority.

The source cursor stays global. A scoped response explicitly carries `fromExclusive` and
`throughSeq`; omitted source rows are known non-members, not transport gaps. A response with
no row changes still advances through a watermark.

If the source log no longer contains enough history, the feed identity changed, the query
version changed, authorization generation changed, or exact replay is not certified, the
server returns a bounded snapshot. It never reconstructs a historical delta by reading a
newer database head.

### 6.5 Incremental publication and event-loop fairness

Each subscription scope has an ordered FIFO of source ranges. The evaluator processes a
bounded number of candidates or at most an 8 ms CPU budget, then yields to the event loop and
continues. It never evaluates a later source range ahead of an earlier one for the same scope.

Work shared by identical query keys and authorization scopes may be computed once and fanned
out. That shared result is disposable; catch-up recomputes it from durable truth.

Volatile session changes use the existing per-session dirty version:

1. mutation increments the version and enqueues the session id;
2. a time-sliced worker builds an immutable wire row from current truth;
3. it publishes the row only if the version is unchanged after capture;
4. if the version changed, the candidate remains queued and is recomputed;
5. cursor/order becomes visible only after the captured row is in the Authority change path.

Thus a yield can delay publication but cannot publish stale state or lose a newer mutation.
Coalescing may skip intermediate volatile values; the final value and durable ordering are
preserved. Any operation requiring multi-row atomic visibility stays in one Authority commit
and is not split by this worker.

### 6.6 Client subscription coordinator

The client keeps one Replica-backed normalized store. It adds durable subscription metadata:

```text
subscription key -> scope token, cursor, active/retained state, member entity keys
entity key       -> authoritative value, authority seq, retaining subscription keys, pins
```

Applying a subscription response is one local unit of work:

- apply authoritative entity operations;
- update that subscription's membership provenance;
- advance its cursor and scope token;
- retire any optimistic mutations acknowledged by the Authority;
- emit one batched client notification.

A subscription snapshot replaces only that subscription's membership. A row is physically
evicted only when no active/retained subscription and no offline pin retains it. A global
delete removes the entity from every membership. A query exit or authorization revocation
removes only the named membership and records the existing remove-versus-evict distinction.

Overlapping subscriptions can deliver the same entity. Membership operations are ordered by
their subscription cursor. Authoritative row values carry the global source sequence; an
older duplicate cannot overwrite a newer value. This is transport ordering, not client-side
write arbitration—the Authority still decides the value.

The UI reads only from this store and cannot tell whether a row arrived from disk, a snapshot,
or a delta. Missing online data opens the appropriate named subscription. Offline, retained
subscriptions remain visible and explicitly stale, preserving the Replica's current
stale-visible behavior.

### 6.7 Retention and offline pins

Closing a screen stops its live server registration but does not immediately discard data.
Each query family declares a client retention TTL and size ceiling. Recently used scopes
remain available offline until either bound is crossed.

Explicit offline pins retain the minimum rows and relations required for selected projects,
issues, or sessions. Pending Outbox commands implicitly pin the rows needed to render and
reconcile their optimistic overlays. Effectful machine commands retain their existing
online-only policy.

Archived, closed, and stale history leaves default subscriptions through server-owned query
predicates. Archive/search screens use their own bounded subscriptions; history does not
silently rejoin the default world.

## 7. Correctness invariants

1. **One truth:** SQLite entity state plus the Authority log is authoritative. Query results,
   membership inventories, and client rows are replaceable derivatives.
2. **One write path:** every mutation still follows authorize → arbitrate → write and append
   atomically → publish.
3. **Server-owned visibility:** clients never evaluate authorization or infer query membership.
4. **Cursor consistency:** every snapshot is read at its advertised `throughSeq`; every delta
   covers exactly `(fromExclusive, throughSeq]`.
5. **Scope identity:** a cursor is valid only with the same feed identity, feed epoch, query
   name/version/parameters, and authorization generation.
6. **Atomic local progress:** subscription membership, entity operations, cursor, and Outbox
   retirements commit together where they intersect.
7. **No permanent invalidation:** any uncertain dependency, missing history, scope change, or
   evaluator failure produces a bounded snapshot, never an optimistic cursor advance.
8. **Incremental equivalence:** for every certified query and cursor, snapshot at A plus deltas
   through B equals snapshot at B.
9. **Overlap safety:** removing one subscription cannot remove a row retained by another or by
   an offline/Outbox pin.
10. **Revocation safety:** a scope reset atomically makes revoked membership unavailable; stale
    unauthorized rows are not displayed while a replacement snapshot loads.
11. **Bounded execution:** subscription maintenance yields within its CPU budget; backlog may
    increase latency but cannot block input indefinitely or reorder a scope.
12. **Failure isolation:** one query evaluator failure resets only its subscription, not the
    entire client replica.

## 8. Protocol evolution

The change is additive behind a new capability, for example `workingSetSyncV1`. Old clients
continue using the world feed during migration.

Required protocol concepts:

- canonical named-query key and parameters;
- opaque scope token;
- per-subscription snapshot begin/chunk/end or existing equivalent;
- scoped delta with `fromExclusive` and `throughSeq`;
- watermark with no row operations;
- `refresh-required` / scope-reset reason;
- explicit subscribe and unsubscribe registration for low-latency push;
- lenient handling of newer query names and result kinds.

Query-definition versioning is independent of the global wire version. A semantic query
change increments that query's version and causes only that scope to snapshot.

## 9. Migration plan

Each phase is independently releasable and retains a kill switch to the world feed.

### Phase 0 — Bound the existing world

Add server-owned active/archive horizons for existing feed kinds. Remove archived, closed,
and stale history from the default scope using existing eviction semantics. This is the
smallest first benefit and reduces bootstrap cost before subscriptions ship.

### Phase 1 — Named-query contract, snapshot mode

Add the registry, protocol key, scope token, and bounded snapshot serving. Add client
membership provenance to the existing Replica store. Pilot `sessions.sidebar.v1` while the
world feed remains authoritative for production rendering.

Shadow mode compares every pilot result with the equivalent slice of the world projection.
Any mismatch fails the pilot gate and leaves rendering on the old path.

### Phase 2 — First-screen cutover

Render the session sidebar from its subscription. Keep world warming optional and
interruptible in the background. Point reads and issue-scoped session reads move to their
named queries. This phase should already remove the profiled full-session work from typing
and issue-mutation paths even if every update uses a bounded refresh.

### Phase 3 — Certified session deltas

Add immutable routing facts and the incremental evaluator for the session query family.
Time-slice volatile capture and subscription projection. Enable live deltas only after the
incremental-equivalence and planted-dependency tests pass.

### Phase 4 — Retention and offline policy

Enable TTL/size eviction, recent-scope offline reads, explicit pins, and Outbox implicit pins.
Measure storage and offline behavior before shrinking the old replica scope.

### Phase 5 — Domain expansion

Migrate issue board/page, machine reachability, conversations, and other screens one query
family at a time. Joined queries begin in snapshot/refresh mode and earn incremental mode
separately.

### Phase 6 — Retire world paths

For a domain whose subscription path beats the old path on correctness and performance gates,
stop world-feed delivery, remove its global client joins, then delete its compatibility code.
Do not carry two permanent data models.

## 10. Verification

### 10.1 Correctness

- Property test: randomized source mutations satisfy snapshot(A) + deltas(A, B) = snapshot(B)
  for every certified query.
- Mutation test: delete each declared dependency or affected-key edge and prove a test fails.
- Authorization tests: grant, revoke, role change, and principal switch atomically rescope and
  never expose a row after revocation.
- Overlap tests: two subscriptions share rows; closing, resetting, and expiring either one
  preserves rows retained by the other.
- Crash tests: fail between every local entity/membership/cursor/Outbox operation; restart
  yields either the old committed state or the new committed state, never a mixed cursor.
- Recovery tests: lost frames, duplicated notifications, compaction, feed restore, query
  version change, and server restart converge through delta or bounded snapshot.
- Oracle test: every narrow server read and named query matches the current full projection
  filtered to the same parameters during shadow mode.

### 10.2 Performance gates

Use a corpus at least as large as the profiled installation: 2,000 sessions, 1,000 referenced
issues, and a representative multi-user grant graph.

- A one-session mutation wires and authorizes work proportional to affected subscriptions and
  result rows, not to 2,000 sessions.
- No subscription-maintenance turn exceeds its 8 ms work budget; any unavoidable atomic
  commit is measured separately.
- Typing-input p99 remains below 50 ms during session, issue, and agent-relay mutation storms,
  with no sync/projection-attributed stall above 100 ms.
- Initial sidebar rows and bytes are bounded by its declared page/window size and remain
  approximately constant when archived tenant history grows 10×.
- Reconnect inside retention transfers only matching subscription changes; outside retention
  transfers only bounded subscription snapshots, never the principal's world.
- Client entity count stays within active scopes + retained TTL scopes + explicit pins.

### 10.3 Operational gates

- In-memory subscription state can be deleted while clients recover through the durable API.
- Existing world-feed clients continue to work throughout additive rollout.
- Kill switch returns a migrated domain to the world feed without data migration.
- Per-query backlog, snapshot count, refresh fallback, evaluator duration, result size, and
  rescope reason are observable.

## 11. Alternatives rejected

### Cache the full `SessionMeta[]`

Rejected. It reduces repeated computation but creates a broad dependency-invalidation problem
across session state, overlays, grants, issues, machines, harness capabilities, and occupancy.
It also leaves bootstrap, network, and client costs proportional to the world.

### Build a universal incremental dependency graph first

Rejected as the first implementation. It is a large framework whose correctness would be
harder to establish than named domain queries. The registry allows shared machinery to emerge
after several proven query families instead of guessing it in advance.

### Invalidate and refetch forever

Correct but incomplete. It is the mandatory fallback and a safe pilot implementation, but
high-churn queries need certified deltas to avoid chatter and repeated projection.

### Adopt stock Zero

Rejected for now. It requires Postgres and `zero-cache`, replaces the client store and command
integration, and weakens the current single-binary SQLite deployment. Podium needs Zero's
working-set contract, not that infrastructure migration.

### Adopt stock Electric

Rejected for now. Electric's table shapes and external write API validate the read/write split,
but Podium already owns the Authority log, authorization semantics, local Replica, and
optimistic Outbox. Replacing them would discard the hardest working parts.

## 12. Acceptance

The full fix is complete when:

1. First-screen domains render exclusively from bounded named subscriptions.
2. Their online and offline behavior passes the correctness, recovery, authorization, and
   overlap suites.
3. Their measured server work, payload, and client storage scale with the working set.
4. The world-feed implementation for those domains is deleted.
5. The live typing benchmark no longer attributes visible stalls to session projection or
   volatile publication at the profiled corpus size.

