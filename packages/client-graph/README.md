# @podium/client-graph

The MobX worklist data layer, extracted from the round-three prototype. The name
`client-graph` describes the client entity models, declared relations and residency
that the worklist is built on. It leaves room for other client paths to use the
same graph without naming a sidebar UI. Apps may import this
package; no product app entry imports it yet.

`createWorklistPool(source, locals)` follows caller-owned row and local channels
and returns `{ pool, dispose }`. `createWritableWorklistPool` adds the existing
write API over a caller-supplied outbox transport. These functions create no
client runtime, replica or durable outbox. Disposal removes the pool's subscriptions
and timers; the caller still owns the channels and transport.

`@podium/client-graph/react` exports `observer` and `PoolRowSlot`. The slot resolves
an issue through the pool's one reader, observes residency separately from the row's
field reads, and accepts render callbacks for the existing UI and a loading
placeholder. Row components reading model fields must be observers.

The package declares MobX and its React bindings. React and React DOM are peers.
Draft labels use the canonical `@podium/harness/browser` descriptor fallback;
the current row/local channels do not carry served descriptors. No legacy
worklist derivation is imported for labels.
TanStack Virtual, demo row layouts, native lists, commit instrumentation, strict
MobX test setup, snapshots, scan oracles, generators and tests stay in
`tests/worklist`. Prototype imports use this package's source exports;
there is one copy of the implementation.

The enumeration module is `src/enumerate.ts`; ordinary updates maintain resident
rows and declared relation indexes. All row reads keep using `MobxPool.row`, including
its LOADING and batched-load behavior. The memory cutoff remains deferred.

Run lint with `bun run --cwd packages/client-graph lint`. Its ESLint config reuses
the prototype's development-only fence plugin, alongside the MobX rules; that tool
is outside all product exports. Tests remain in the prototype's package config.
