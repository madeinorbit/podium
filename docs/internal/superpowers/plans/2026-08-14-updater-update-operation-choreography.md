# Update operation choreography — Implementation Plan

**Epic:** POD-2087 · **Spec:** `2026-08-14-update-operations-design.md` §3.1–§3.6, §7, §8
**Protocol:** `2026-08-14-updater-worker-protocol.md`
**Blocked by:** Durable operations framework (must be merged to integration first).

**Goal:** The `update` operation kind: plan computation, step runners that drive the
existing update machinery, adoption across the coordinator restart, single-flight +
`nextTarget` queueing, and typed errors. After this issue, a dev-source update is one
durable operation that survives the server's own restart. The old client keeps working
(its polled endpoints remain); the new panel arrives in a later issue.

**Owns:** `apps/server/src/modules/updates/operation.ts` (new), `trpc.ts`, targeted edits
in `service.ts` and `dev-publisher-wiring.ts`, `apps/server/src/relay.ts` composition.
Does not touch the daemon, protocol frames (beyond reading), or `apps/web`.

## Context

- Today's choreography to replace: `startUpdate` / `continueDevelopmentUpdate` /
  `restartCoordinatorAfterDevelopmentFleet` in `apps/server/src/modules/updates/trpc.ts:172-389`
  (250 ms polling loops, 60-min backstop) and the client-side wait loops it implies.
- The muscle that stays: `UpdatesService` (`service.ts`) wave orchestration + grants;
  the dev publisher (`dev-bundle.ts`, `dev-publisher-wiring.ts`); web/mobile dist builds
  (`dev-web-build.ts`); `source-redeploy.ts` for the coordinator restart.
- Mid-update target mutation to remove: `setTarget` re-publish tick (`service.ts:161-169`).
- Restart-boundary proof already exists: `machineCrossedRestartBoundary` (`service.ts:452-464`).

## Tasks

- [ ] **Plan computation** — `operation.ts` `planUpdateOperation(target, fleet, surfaceCtx)`:
  pure function → step list. Steps, included only when applicable (per-artifact digests +
  fleet snapshot): `prepare` (dev identity target needs a tarball pack; or nothing for
  feed/bundle targets), `machines` (connected, channel-matching, non-supervised machines
  behind target; offline ones → `deferred`), `server` (server behind target), `web` (served
  web/mobile dist behind target digest). All-in-one context → no server/machines runner
  authority; instead `awaiting: [{ kind: 'desktop-install', machine }]` and state `waiting`
  (§5 — the desktop issue wires the client side; the state must exist now). Table-driven
  tests.
- [ ] **Step runners** (each idempotent, reality-first):
  - `prepare`: reuse `requestDestBundle()` path; on publisher refusal map its public reason
    → `preparation-failed`.
  - `machines`: `markAuthorized` + `tick(channel)` against the existing wave planner;
    progress = fleet convergence states projected into `steps[].places`; completion =
    every planned machine `current` at target (or moved to deferred/error).
  - `server`: persist step `running` **before** `requestCoordinatorRestart()`; the step
    completes only via adoption (below) — no in-process wait loop.
  - `web`: reality check first (`webDistMatchesHead` / dist stamp vs target digest), then
    the existing build path; completion by stamp equality, checked on engine ticks, not a
    blocking loop.
- [ ] **Reconcile (adoption)** — `reconcileUpdateOperation(op, reality)` where reality =
  `{ appVersion, servedWebDigest, machineDirectory }`: server step running + appVersion ==
  target → done; != target after restart began → operation `failed:
  server-did-not-reach-target`. Web/machines steps re-derived the same way. Unit tests for
  the §8 rows: successor at target, successor at wrong version, machines mid-wave.
- [ ] **Single-flight + queueing** — `updates.start` (new mutation; keep `updates.converge`
  as a thin alias for one release): engine `start('update', …)`; `ALREADY_RUNNING` maps to
  returning the active operation id. `setTarget` while an exclusive operation is active
  stores `nextTarget` per channel (in the service) instead of mutating the wave; on
  terminal transition the engine publishes `nextTarget` (which re-creates the *offer*, not
  an operation). Delete the re-publish tick behavior.
- [ ] **Typed errors** — the §7 code table as a discriminated union in
  `packages/protocol/src/operation/` additions or `modules/updates/operation.ts`; map
  existing detail strings (grant `rejected/stuck` details, `GRANT_TIMED_OUT_DETAIL`,
  publisher reasons, dirty-checkout refusals) onto codes. `describeUpdateFailure`'s inputs
  keep working (the panel issue consumes the codes later).
- [ ] **Retry** — `updates.retry(opId)`: new operation planned from the remainder (places
  not at target), `retryOf` set.
- [ ] **Compose** — register the kind in `relay.ts` next to the `UpdatesService`
  construction; assemble `reality` for `adoptOnBoot()` from instance version + web stamp +
  machine directory.
- [ ] **Keep the old read path serving** — `updates.fleet` remains untouched for the
  current dialog and Settings; this issue must not regress the existing UI. Add
  `operationId` to its payload so the old panel could link (no UI change here).

## Testing

Table-driven plan tests; runner idempotence (`ensure()` twice = once); reconcile scenarios;
single-flight under two concurrent starts (existing `router.updates.test.ts` extends);
nextTarget queue/publish; typed-error mapping. Then `bun run typecheck`, focused tests,
`bun run test`, and `bun run test:e2e` (server/daemon/grant/restart behavior changed —
required by `docs/agents/updater-acceptance.md` cadence 2).

## Acceptance

- Kill-and-adopt drill under test: operation started, server step marked running, engine
  torn down, new engine over the same store with successor reality at target → operation
  resumes and completes; at wrong version → `failed: server-did-not-reach-target`.
- Two concurrent `updates.start` yield one operation id.
- Publishing a new target mid-operation does not change the running wave; the queued
  target appears as an offer only after the operation terminates.
- Existing dialog still functions against the branch (drive it once per
  `docs/agents/driving-podium.md`).
