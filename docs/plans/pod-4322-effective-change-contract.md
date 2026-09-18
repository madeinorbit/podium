# Effective-state change contract

Phase D2 adds `engine/effective-changes.ts`, an internal interface and reference
publisher, with no production imports, consumer migration, library, or default-on
work. D3 supplies addressed replica candidates; D4 supplies optimistic candidates;
D5 wires the opt-in presentation model. The reference publisher is not wired today.

The runtime is the sole publisher. It calls `publish` once at the outermost
`ClientRuntime.batch` completion, after reactions and `OptimismLedger` recomputes
have settled, alongside the existing `subStore.publish`. It provides a borrowed,
immutable `EffectiveReadView` over that final commit. `view.row(kind, id)` is the
sole final effective-row read: sessions, issues and issueProjections come from
EngineState after `foldOverlays`, never unpainted `Replica.rows`. Other replica
kinds use the completed binding snapshot (including issueDeps/userLayouts, which
are not EngineState lists). `view.ids(kind)` enumerates that same committed scope.
`view.local(key)` reads the same commit's local EngineState fields, including
drafts, selection, workspaces, pending spawn metadata, and the coarse clock.
Returned values are borrowed read-only data; implementations must retain immutable
references, not closures over live mutable state. This is not another entity owner.

An update invalidates addressed rows by kind/id and local fields by key. Addresses
are candidates, not patches: read the final row, even when several operations
updated, removed, and reinserted the same id. Duplicates collapse in first-touch
order; different kinds with the same id remain distinct. Conservative invalidation
is allowed, including a touched row whose final value equals its prior value.
An empty update is allowed for an otherwise unrelated runtime commit. Consumers
must not interpret address ordering as dependency ordering: apply the entire
publication in one presentation transaction before notifying derived readers.
Draft changes invalidate `drafts`; selection changes invalidate the actual changed
selection/workspace keys. No server delta is required for a local publication.

`presence: absent` invalidates existence AND visibility-dependent derivations. It
means the effective read is undefined, not proof of server deletion. Consumers
must drop cached rows, relationships and absence-dependent computed values.
Readmission of the same id, even with the same revision or object, invalidates it
again. Archived/tombstoned rows still present in the effective view are `present`;
consumer filtering is recalculated from their changed fields. No tombstone cache
may suppress later admission. Optimistic insert, patch, rollback, retirement,
TTL expiry and curation mirrors all supply candidates through the same runtime
boundary; raw replica changed kinds alone cannot meet this contract.

`replace` is distinct from updates: seed, bootstrap and rescope install a COMPLETE
view atomically, including empty kinds and local state. Consumers replace all old
scope indexes and dependencies in one transaction, never a clear event followed
by row events. Replacement wins over ordinary candidates in the same runtime
batch, even if no object/revision changed. D3 must preserve the upstream explicit
bootstrap/rescope boundary; `ReplicaPublication.reason: rows|hydrated` and
`changed: Set<kind>` do not encode it today. Do not infer replacement from all
kinds changing, row counts, hydration timing or revision comparisons.

Subscribe registers and delivers a synchronous `replace/seed` as one operation.
Never independently read a seed then subscribe. A write before subscription is in
the seed; a write during the seed callback is delivered as an update. Each
registration is independent, even for the same callback. Nested runtime writes
inside a batch coalesce before calling publish. Writes from publication listeners
are NEW commits, queued FIFO until all still-subscribed listeners finish the
current event. Each event carries its pinned view, so a nested write cannot make
another listener read future values. A subscription created while delivery is in
progress seeds from the latest accepted commit and is excluded from older queued
updates. Listener order is registration order. Unsubscribe is idempotent and
prevents any not-yet-started callback, including queued work. Callback exceptions
do not starve other listeners or queued commits; delivery drains then throws an
AggregateError. A throwing seed unregisters that registration.

Destroy is irreversible and idempotent: clear listeners and queued deliveries,
ignore late publications, and return a no-op unsubscribe for late subscriptions
without invoking them. A callback already executing may finish. A principal
change destroys the runtime and publisher; it must not reuse either for the new
principal. Ordinary rescope within a principal uses replacement.

Identity reuses the existing Store snapshot object (`view.commit`) and optional
`ClientSwitchTrace.switchId`. Neither is generated here; trace can be absent.
These are correlation identities, not sortable watermarks. FIFO callback order
is the ordering contract. No new sync cursor, wire payload or persisted log exists.

## Evidence and reversal

Comparison baseline remains B13 runtime 4b9d7618b, recorded in
`docs/measurements/POD-4358-post-b-baseline.md` and its numeric JSON: warm rotation
28 worklist derives / 4098.10 ms, switch p95 4471.20 ms. D2 claims zero improvement
to these timings; no production path invokes this code. Its before/after claim is
contract coverage: previously zero addressed effective-change seam scenarios,
now executable assertions for batching, optimism, visibility and replacement.
Focused tests include an armed raw-base counterexample: the same assertion rejects
the server row and accepts the overlay-folded row. Revert this additive change to
remove the seam; until D3–D5 wiring, disabling requires no flag or migration.
