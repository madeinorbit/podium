# Durable operations framework — Implementation Plan

**Epic:** POD-2087 · **Spec:** `2026-08-14-update-operations-design.md` §3.0–§3.4, §3.7, P1/P3/P4/P6/P8
**Protocol:** `2026-08-14-updater-worker-protocol.md`

**Goal:** The generic operation layer: a persisted, single-flight, timer-driven,
adoptable-on-boot state machine with a frozen wire contract. Zero update-specific logic —
the `update` kind arrives in a later issue; this issue ships with a test kind only.

**Owns:** `packages/protocol/src/operation/**` (new), `apps/server/src/modules/operations/**`
(new), one additive drizzle migration, router mount, boot wiring. Nothing under
`apps/server/src/modules/updates/` and nothing in `apps/web`.

## Context

- Contract discipline to copy: `packages/protocol/src/update/server-version.ts` and its
  conformance test (unknown fields ignored, absent fields tolerated) — the operation object
  gets the same law and the same style of test.
- Migration conventions: `apps/server/src/migrations/schema.ts` (additive only; the
  expand-only audit gate must stay green).
- The engine must use an injected clock — no `setInterval` reachable from unit tests, no
  fixed sleeps (repo rule).

## Tasks

- [ ] **Protocol types** — `packages/protocol/src/operation/operation.ts`: zod schemas for
  `Operation`, `OperationStep`, `StepPlace`, `AwaitingAsk`, `DeferredPlace`,
  `OperationError`, states `pending|running|waiting|done|failed|canceled`, step states
  `pending|running|stalled|done|failed|skipped`. Every field beyond `id`/`kind`/`state` is
  optional-tolerant; parsing uses passthrough so unknown fields survive round-trips. Export
  one shared `parseOperation()` used by every consumer (server tests and, later, web).
- [ ] **Conformance test** — `operation.test.ts`: a payload with extra unknown fields
  parses; a payload with each optional field individually absent parses; a retyped known
  field fails. Prove the test can fire (make it red once).
- [ ] **Storage** — drizzle table `operations`: `id` (text pk), `kind`, `exclusion_group`,
  `state`, `created_at`, `updated_at`, `finished_at` (nullable), `payload` (JSON text).
  Additive migration. `apps/server/src/modules/operations/store.ts`: insert, update (full
  payload write; the row is small), `activeByGroup(group)` (state not terminal),
  `history(kind, limit=20)`, `sweepRetention(kind, keep=20)`.
- [ ] **Kind registry** — `apps/server/src/modules/operations/kinds.ts`:
  `OperationKindDefinition = { kind, exclusionGroup, plan(ctx), reconcile(op, reality),
  runners: Record<stepId, ensure(op, step) => Promise<StepOutcome>>, deadlines:
  Record<stepId, { silenceMs, totalMs }> }`. Registry is a plain map populated at
  composition time.
- [ ] **Engine** — `engine.ts`: `start(kind, ctx)` → single-flight per exclusion group
  (returns `{ alreadyRunning: id }` instead of throwing internals); persists the planned
  operation; drives steps sequentially by calling `ensure()` (idempotent, reality-first —
  the runner's contract, documented on the type); `recordProgress(opId, stepId, patch)`
  stamps `lastProgressAt` + `updatedAt` and persists; terminal transition sets
  `finishedAt` and sweeps retention.
- [ ] **Timer service** — injected `clock: { now(), setTimeout, clearTimeout }`; a single
  scheduler checks the active operation's running step against its deadlines: silence
  (heartbeat stale) → step `stalled` + one `ensure()` retry → step `failed` → operation
  `failed`. All transitions unit-tested with a fake clock; production wiring uses the real
  clock in one composition-root line.
- [ ] **Adoption** — `adoptOnBoot()`: load active operation (if any), call the kind's
  `reconcile(op, reality)`, persist the result, resume the engine loop on the reconciled
  state. `reality` is an interface the caller assembles (the update kind fills it later);
  the framework only defines the shape and the call order.
- [ ] **tRPC** — `apps/server/src/modules/operations/trpc.ts`: `operations.active` (returns
  the raw JSON payload or null), `operations.history({ kind?, limit? })`. Mount in
  `apps/server/src/router.ts`. Wire `adoptOnBoot()` in `apps/server/src/server.ts` startup
  next to the updates module init.
- [ ] **Cancel** — `operations.cancel(id)`: allowed only while the current step's runner
  declares itself reversible (`runners[step].reversible === true`); otherwise returns a
  typed refusal. Persist `canceled`.

## Testing

Engine: single-flight (second start returns the active id), step sequencing, stalled →
retry → failed with fake clock, cancel gating, adoption calls reconcile-then-resume.
Store: round-trip, activeByGroup, retention sweep. Conformance test as above. Gates:
`bun run typecheck`, `bun run test:related -- <changed files>`, then `bun run test`.

## Acceptance

- A registered test kind can be started, heartbeated, stalled by clock advance, retried,
  failed, canceled, adopted after a simulated restart (new engine instance over the same
  store) — all under test.
- `operations.active` serves a payload that the conformance parser accepts.
- No file under `modules/updates/` changed; migration is additive (expand-only gate green).
