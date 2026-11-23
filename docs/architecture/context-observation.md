# Context observation

The composer reads one normalized context sample through `SessionModel`. A new
harness supplies that sample through its adapter; it needs no consumer branch.
Context occupancy describes the active window or a labelled latest-request
proxy. Session billing totals and account quota are separate measurements.

## Adapter extension

Declare `runtime.context.forDriver(driver)` in the adapter manifest. Return a
supported `HarnessContextStrategy` or a reasoned decline for each mechanism. The
ports are defined in [context-types.ts](../../packages/harness/src/context-types.ts)
and resolved by [the registry](../../packages/harness/src/registry.ts). Declaration,
machine availability and a session's current measurement are distinct facts.

A strategy provides `capability`, bounded `probe`, and `bind`. Optional
`initialize` extends an opaque family initialization payload. `bind` receives the
exact native session identity when known, causal revision, an already-owned
probe transport, lifetime signal and `publish` callback. Its session strategy
implements `observe`, `invalidate`, `summary` and `detail`.

Pass raw native input to `observe` before lossy family translation. The adapter
selects meaningful boundaries, validates native fields, admits versions, resolves
capacity and calculates tokens. Async work captures the binding/revision before
awaiting, coalesces reads, and publishes only while that captured lifetime is
current. A probe never creates a model turn. Detail never launches a native child.

[RuntimeContextRelay](../../packages/harness/src/driver/context-relay.ts) supplies
generic binding, causal admission, cancellation and coarse metadata/replay.
[Driver families](../../packages/harness/src/driver/families/) supply transport and
lifetime mechanisms; operation payloads and responses remain opaque there.
Native endpoints, field grammars, version rules and model tables belong in
[adapter-owned context strategies](../../packages/harness/src/adapters/), including
their fixtures. See the [Claude](../../packages/harness/src/adapters/claude-code/context.ts),
[Codex](../../packages/harness/src/adapters/codex/context.ts) and
[Pi](../../packages/harness/src/adapters/pi/context.ts) strategies for different
observation sources. A mode without a verified source should decline explicitly.

Invocation helpers use the existing adapter instrumentation declaration and the
[headless invocation owner](../../packages/harness/src/driver/families/headless/).
Opt in through `driverIds` with session scope; respect `extensionsAllowed` and the
real child's cleanup lifetime. Adoption must not manufacture fresh executable or
writer provenance. Do not add another session writer, polling process or hover
subprocess to recover missing telemetry.

## Measurement semantics

Use the existing [model schemas](../../packages/model/src/context.ts), re-exported
by [the driver contract](../../packages/harness/src/driver/context.ts):

- `ContextSummary` replaces the whole reading. `available` carries a sample;
  `stale` retains its original sample and denominator with a reason. `pending`,
  `unavailable` and `unsupported` clear an earlier measurement. Absence remains
  compatible with older peers. Pending/unavailable may retain known model,
  capacity and compaction policy without inventing occupancy.
- `occupancy.basis` distinguishes current context, last request and native
  estimate. Use the latest attributable primary request for a request proxy;
  never substitute cumulative session, turn, helper or billing totals.
- Quantities carry `accuracy` (`reported` or `estimated`) and `source`. Zero is a
  measured value; omitted fields are unknown. A reported native counter does not
  prove vendor tokenizer accuracy. Count-only and percentage-only samples are
  valid; consumers must not reverse a rounded percentage into counts.
- `effectiveCapacity` is the applicable window; `modelCapacity` is separately
  established model metadata. Compaction thresholds and reserves describe policy,
  not the denominator or extra occupied content. Capacity carries its own basis.
  Adapters supply percentage and remaining tokens; consumers do not calculate
  missing values. Normalized over-capacity values survive; only the legacy
  percentage projection omits values outside its old range.
- `ContextDetailResult` names the exact immutable summary sample. Its optional
  `lastRequest` has inclusive input/output: cache read/write are disjoint subsets
  of input, and reasoning is within output. Do not add subsets to parents. Partial
  subcounts remain useful when a parent total is unknown.
- Composition roots are disjoint; children attribute tokens within their parent.
  Reserve, free, excluded and deferred rows do not add occupancy. Preserve partial
  coverage, unknown attribution and truncation; obey the shared row/depth bounds.

## Identity, clears and replay

Sample identity includes binding version, observer generation, turn epoch,
context revision, original event time and opaque native anchors. Repeating or
replaying a measurement retains its identity. Requested model settings cannot
relabel an observed sample. Genuine enrichment produces a new immutable sample.

Model changes, compaction, reset, fork, rewind, genuine native resume mutations
and rebinding invalidate old data. Advance `contextRevision`, cancel pending work
and emit an explicit clear; do not release a fence on a newer timestamp alone.
Reject old generations, foreign sessions and late pre-boundary results. Transport
reconnect and replay of a verified retained observation preserve its sample;
idle age alone does not invalidate it.

`context-observation` is coarse metadata, including clears. The driver retains or
reconstructs its envelope in `SessionSnapshot.context` through its existing replay
owner. Bootstrap/reconnect must retain the sample's original causal identity.
When the runtime stream has a separate cursor, metadata carries the original
observation envelope in `source`. The server restores that envelope before
folding the reading and rejects a source from another observer generation.
Server/client live values are demand-bound and unsaved: the declared
[`SessionConditionLive.context`](../../packages/model/src/records/live-payloads.ts)
flows through [session live topics](../../apps/server/src/modules/sessions/live-topics.ts)
and LiveStore into [`SessionModel.context`](../../packages/client-graph/src/models.ts).
Do not add stored session metadata, replica facts or a parallel chat container.
The model derives offline/stale presentation without rewriting the sample.

## Capability and detail demand

The [machine inventory projection](../../apps/daemon/src/control/inventory.ts)
reports context support once per machine, as the `context` part of each
driver's record in `Inventory.driverCapabilities`. The outer key is the
canonical driver id (a retired alias such as `claude-pty` reports under
`generic-pty`); the inner key is the open harness id, so harnesses sharing
`generic-pty` or `headless` keep separate entries. Executor-only headless modes
appear there without becoming launch choices: `runtimeDrivers` is unchanged.

```json
"driverCapabilities": {
  "generic-pty": {
    "context": {
      "codex": {
        "capability": { "summary": "passive", "detail": "on-demand" },
        "availability": { "status": "unavailable", "reason": { "code": "not-probed", "message": "…" } }
      },
      "antigravity": {
        "availability": { "status": "unsupported", "reason": { "code": "unsupported-implementation", "message": "…" } }
      }
    }
  },
  "headless": { "context": { "codex": { "capability": { … }, "availability": { … } } } }
}
```

`capability` is absent when the implementation declines; `availability` keeps
the reason. A consumer resolves the canonical bound driver, then the harness,
with [`driverContextFor`](../../packages/model/src/entities/machine.ts), which
reads own keys only. [`SessionModel.contextImplementation`](../../packages/client-graph/src/models.ts)
does exactly that through the session's machine:

```ts
driverContextFor(machine.driverCapabilities, canonicalDriverIdOf(session.driverId), session.agentKind)
```

Sessions do not store capability copies. An inventory without
`driverCapabilities`, or without the driver or harness entry, means unknown
support, never unsupported. Later per-driver facts (family, configure fields,
attach kinds) join the same record beside `context`.

[`CAP_CONTEXT_OBSERVATION_V1` and `CAP_CONTEXT_READ_V1`](../../packages/protocol/src/messages/runtime.ts)
are negotiated separately. Observation support does not authorize detail frames.
The [server read broker](../../apps/server/src/modules/sessions/context-reads.ts)
authorizes each waiter, coalesces matching requests, bounds deadlines/rows and
reauthorizes after I/O. The [daemon dispatcher](../../apps/daemon/src/runtime/context-reads.ts)
checks the current handle and its declared reader. Closing the last waiter or
disconnecting cancels work; late results cannot update another sample or binding.

[`ContextDetailView`](../../packages/client-graph/src/context-detail.ts) owns one
visible opening's answer. Construction and `open()` do not probe. The
[composer indicator](../../apps/web/src/features/chat/ContextUsageIndicator.tsx)
deliberately calls `load()` when hover, keyboard focus or touch opens its panel.
Repeated intents reuse the attempt; retry is explicit. Hide, close, unmount,
sample/model/binding changes and offline transitions release demand and discard
late answers. Keystrokes, hidden views and pushed summary changes do not request
detail or refresh snapshots.

## Conformance references

Use the repository [validation wrappers and lane triggers](../agents/testing.md).
These tests exercise the contract rather than native implementation details:

- [Model semantics](../../packages/model/src/context.test.ts): measured zero,
  unknown/over-limit, inclusive subsets, capacity/policy and bounded composition.
- [Generic relay](../../packages/harness/src/driver/context-relay.test.ts) and
  [synthetic driver](../../packages/harness/src/driver/testing/context.conformance.test.ts),
  plus [cross-layer delivery](../../scripts/context-delivery.test.ts):
  immutable replay, coarse clears, invalidation, generation and late-result fences.
- [Source/import boundaries](../../scripts/context-contract-boundary.test.ts) and
  [harness census](../../packages/harness/src/harness-context.conformance.test.ts):
  total declarations and isolation from ambient machine/native assumptions.
- [Shared session model](../../packages/client-graph/src/session-context.test.ts):
  future harnesses, one machine capability, offline and reader isolation.
- [Real read round trip](../../scripts/context-reads.test.ts):
  authenticated mux, wrong-RPC-family refusal, coalescing, bounds and cancellation.
- [Detail lifetime](../../packages/client-graph/src/context-detail.test.ts) and
  [composer](../../apps/web/src/features/chat/ContextUsageIndicator.test.tsx):
  zero hidden/typing reads, explicit retry, late answers and unknown-harness UI.
