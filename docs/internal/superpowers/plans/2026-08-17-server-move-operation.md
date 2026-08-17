# Server move as a durable operation — implementation plan

- **Date:** 2026-08-17
- **Issue:** POD-2271, parent epic POD-1747
- **Spec:** `docs/internal/superpowers/specs/2026-08-17-server-move-operation-design.md` (approved through commit `6fe7fde64`); section references (§) below are into that spec. The spec is the contract; this plan is the execution order.
- **Audience:** a fresh implementation agent per phase. Each task is small, names its files and symbols, lists its dependencies, and states test-first acceptance criteria. Tests are written before or with the change and are the phase's evidence.

**Validation discipline (repo doctrine, `docs/agents/testing.md`):** one lane per task, at the end, never stacked "for confidence." Each task below names its single lane. Engine/kind/service work uses `bun run --cwd apps/server test:services`; store work `test:store`; router/contract surface `test:boundary` or `test:contracts`; protocol/daemon `bun run test:bun`; web `bun run test:related -- <files>`; the Docker harness is its own scripted acceptance run (phase G), not a Vitest lane. Tasks touching only docs or generated rosters run `bun run test` once. After adding/moving/deleting any `apps/server` test file, run `bun scripts/server-test-shards.ts --write` before validating. Do **not** run `test:full`, `oracle`, or browser lanes in ordinary tasks.

**Global prohibitions (grep-gated in E6):** no compatibility projection of the old status shape; no `machines.serverTransferStatus` outside `packages/protocol` (daemon wire name); no `machines.recoverServerMove` or any kind-named recovery RPC anywhere.

---

## Phase A — generic engine extensions (§2)

All in `apps/server/src/modules/operations/`; kind-agnostic; the update kind must be behaviorally untouched (its existing tests are the regression net).

### A1. Seal + `handed-off` outcome (§2.1)

- **Files:** `apps/server/src/modules/operations/engine.ts`, `kinds.ts`, `engine.test.ts`.
- **Change:** add `engine.sealForHandoff(operationId, stepId, patch)`; extend `StepOutcome.state` union (`kinds.ts:40-42`) with `'handed-off'`. Seal semantics: one final durable `store.update` applying `patch` + `details._handoff`; engine refuses a seal patch that marks the sealing step `done` (sealing step must stay `running`, successors `pending`); in-memory sealed set; post-seal `recordProgress` dropped, `reensure`/`admitDeferred`/`settleAsk`/`cancel` refuse, `driveLocked` no-op, all timers disarmed and never re-armed, `settle`/`finish`/`persist` refuse. On `'handed-off'`: assert seal exists (else fail operation with code `handoff-unsealed`), assert same-drive origin, stop driving, drop context, no timer; row remains non-terminal. The engine never advances the drive past a sealed operation to another runner.
- **Depends:** none.
- **Tests first:** the nine §2.1 tests verbatim, including the query-only-store-after-seal proof and the seal-patch-refuses-`done` check.
- **Lane:** `bun run --cwd apps/server test:services`.

### A2. `reclaimHandoff` (§2.2)

- **Files:** `engine.ts`, `engine.test.ts`.
- **Change:** `engine.reclaimHandoff(operationId)` — legal only from the sealing runner, same process, inside the same `ensure()`. Lifts the seal's write-refusal for exactly one terminal `failed` persist, clearing `details._handoff` in the same write. Engine-level guard only; the kind-level no-promote invariant is proven in C4/G10.
- **Depends:** A1.
- **Tests first:** §2.2 tests 4–5 (double reclaim refuses; reclaim after `handed-off` refuses; reclaim from non-sealing runner/other process/outside `ensure()` refuses) plus: reclaim → runner returns `failed` → terminal row durable, `_handoff` gone, group free for a new `start`.
- **Lane:** `bun run --cwd apps/server test:services`.

### A3. Sealed action dispatch at the router/facade (§2.3)

- **Files:** `apps/server/src/modules/operations/` facade (where `operations.settleAsk` is implemented; extend with `operations.action` if absent), `kinds.ts` (`onAction` signature, `mode: 'engine' | 'sealed'`), contract rows in `packages/commands/` for `operations.action` (roleFloor admin, `machineVerb:'manage'`), facade tests.
- **Change:** routing rule, exactly §2.3: unsealed row → queued engine path unchanged; sealed row (or narrate boot) → validate `actionId` against the deterministic projected ask/action computed from (row bytes, journal via a kind-provided projector hook), then call the kind's `onAction` **directly, outside the engine write queue**, `mode:'sealed'`, zero operations-table writes. Not-offered/unknown `actionId` refuses.
- **Depends:** A1 (seal detection). The kind projector hook lands generically here (a `projectSealed?(row, kindFacts)` slot on `OperationKindDefinition`); server-move's projector arrives in D2.
- **Tests first:** the §2.3 list, headlined by the **deadlock concurrency test**: a stub kind whose sealing runner's `ensure()` blocks unresolved on a never-resolving promise (holding the engine queue); dispatch a sealed action; assert the handler ran to completion, mutated only its stub fact file, and zero operations-table writes occurred (query-only store).
- **Lane:** `bun run --cwd apps/server test:services`.

### A4. Async cancel + structured result + janitor (§2.4)

- **Files:** `engine.ts` (`cancel` → async), `kinds.ts` (`onCancel`, `CancelCleanupResult`), a new `cleanup-janitor.ts` in the operations module, `engine.test.ts`; `operations.cancel` tRPC mutation made async (facade + its contract test).
- **Change:** per §2.4 items 1–4: `detail:'canceling'` persist, `deadlines['#cancel']` budget (default 60 s), finish `canceled` applying `stepPatches`/`detailsPatch`; failure/breach still `canceled` with durable `details.cleanup = {status:'pending', pending, error}`; janitor scans terminal rows with pending cleanup at engine start + periodic tick, re-invokes idempotent `onCancel` until `complete`, patches the historical row.
- **Depends:** none (parallel to A1–A3).
- **Tests first:** the §2.4 test list verbatim (exactly-once, coalescing concurrent cancels, pending record, janitor convergence and restart survival via row-persisted record, refusal paths never invoke hook, next-start preflight interplay stubbed).
- **Lane:** `bun run --cwd apps/server test:services`.

### A5. Shared lifecycle group + durable actor helper + kind-parameterized web client seams

- **Files:** new `apps/server/src/modules/operations/lifecycle.ts` exporting `LIFECYCLE_EXCLUSION_GROUP` (moved from `apps/server/src/modules/updates/operation.ts:82`; update the import there); a durable-actor encode/decode helper (`user:<id>`/`session:<id>`/`system:<slug>`, follow the issues-module encoding precedent) beside the engine; web: generalize `apps/web/src/features/operations/operations-client.ts` `readLatestOperation` (hardcoded `kind:'update'` at `operations-client.ts:81`) and `operation-view.ts` update-keyed `errorCopy` to take a kind parameter, update presenter unchanged in behavior.
- **Depends:** none.
- **Tests first:** update-kind tests still green after the constant move (no new behavior); actor helper round-trip test; existing web operations-client tests updated to pass the kind explicitly.
- **Lane:** server side `bun run --cwd apps/server test:services`; web seam `bun run test:related -- apps/web/src/features/operations/operations-client.ts` (run whichever matches the task split if A5 is landed as two commits).

---

## Phase B — journal, boot classification, crash points (§4, §5.4, §5.5), update admission (§9)

All behind the existing public surface; nothing user-visible changes in this phase.

### B1. `fence-pending` journal state + committing-before-promote ordering

- **Files:** `apps/server/src/modules/server-transfer/journal.ts` (`TransferJournalState`, `LEGAL_TRANSITIONS`), `service.ts` (the fence sequence around `service.ts:366-367` which today writes `source-fenced` before `this.deps.fence()`), journal tests.
- **Change:** add `fence-pending`; transitions `validated → fence-pending`, `fence-pending → source-fenced`, `fence-pending → aborted`; **remove** `validated → source-fenced`. Reorder the existing service fence path: journal `fence-pending` → physical fence → journal `source-fenced` (§4 steps 2–4). Separately pin the §4 step 7 ordering: journal `committing` is written durably **before** any promote RPC send (adjust the existing commit path in `service.ts` accordingly).
- **Depends:** none.
- **Tests first:** transition-table tests (removed transition refuses); service-level ordered-writes test using an fs spy: `fence-pending` durable before fence acquisition, `source-fenced` only after, `committing` before the transport send is invoked.
- **Lane:** `bun run --cwd apps/server test:services`.

### B2. Boot classification: `fence-pending` is pre-fence; resume vs orphan rule

- **Files:** `journal.ts` (`blocksWritableServer`, `serverTransferBootMode` at `journal.ts:292-298`), `reconcileSafeServerTransferBoot` (same module), tests.
- **Change:** `blocksWritableServer('fence-pending') = false`. Replace unconditional pre-fence abort with §5.5: resume when a matching active `server-move` row exists (all four identity fields byte-match: `transferId`, `targetMachineId`, `publicUrl`, `manifestDigest`); otherwise orphan-abort with `{code:'boot-recovery'}` (legacy journals always orphan — they have no row); active-but-mismatched row → row failed `boot-recovery`. Orphan cleanup of a partial `fence-pending` includes idempotent fence release. Adoption clears a stale `details._handoff` before re-driving (only adoption may).
- **Depends:** B1; row matching needs only the row shape (stub rows in tests), not the D-phase kind.
- **Tests first:** §5.5 list: each mismatched field aborts; legacy journal aborts; double-boot idempotent abort; `fence-pending` classified writable; stale-seal clear on adoption.
- **Lane:** `bun run --cwd apps/server test:services`.

### B3. Source-side crash points

- **Files:** `apps/server/src/modules/server-transfer/service.ts` (or a small `crash-points.ts`), mirroring the daemon's `ServerTransferCrashPoint` family; env-var triggered, test/harness only.
- **Change:** injectable crash points at minimum: after seal/before `fence-pending`; between `fence-pending` and physical fence; between fence and `source-fenced`; after final snapshot; after `committing`/before promote send; after promote success/before demote; after demote/before journal commit; after commit/before ack; between each reclaim cleanup sub-step (§2.2 test 3, §4 crash matrix).
- **Depends:** B1.
- **Tests first:** each crash point fires exactly at its seam (unit-level with the fs/transport spies from B1).
- **Lane:** `bun run --cwd apps/server test:services`.

### B4. Update admission refuses legacy transfer journal/lock (§9)

- **Files:** `apps/server/src/modules/updates/operation.ts` (update kind preflight), `server-transfer/lock.ts` (expose a read-only held-check), tests in the updates module.
- **Change:** update preflight fails with code `legacy-transfer-in-progress` (user sentence: finish or clear the previous transfer, then update) when a non-terminal `.server-transfer/journal.json` exists or the legacy `TransferLock` is held — legacy moves are outside the `lifecycle` group, so the group cannot exclude them.
- **Depends:** none (reads existing journal/lock).
- **Tests first:** refused against a doctored non-terminal legacy journal; refused against a held lock; admitted once terminal/cleared.
- **Lane:** `bun run --cwd apps/server test:services`.

---

## Phase C — wire, protocol, capability (§8, §9)

### C1. Required promote port + proof port

- **Files:** `packages/protocol/src/messages/server-transfer.ts` (`ServerTransferPromoteRequestMessage.port` required, `:134-146`; `ServerTransferServingProof` gains `port: number`, L80-95), daemon `persistTargetConfig` (always writes `port` into `config.json` — no `PODIUM_PORT`/pre-existing fallback), daemon proof builder, server-side `healthProofMatches` and target `exactServingProof` (compare port), `PromotedTargetMetadata` (+port) and `readPromotedTargetMetadata` (`target-status.ts:75-101`).
- **Depends:** none. This changes the daemon wire schema digest — that is intended; C2's cap is the compatibility guard.
- **Tests first:** schema round-trip with required port; `persistTargetConfig` writes the exact port; proof mismatch on wrong port fails `healthProofMatches`; metadata carries port.
- **Lane:** `bun run test:bun` (daemon + protocol); if the task is split, server-side proof comparisons use `bun run --cwd apps/server test:services`.

### C2. `server-move.v1` capability + eligibility on the machines listing

- **Files:** daemon handshake caps advertisement (`packages/protocol/src/handshake/envelope.ts:173-209` consumers), `apps/server/src/store/machines.ts:143-155` (`setMachineBuild` already persists caps — verify, no change expected), `apps/server/src/modules/machines/service.ts` (`listMachines` gains per-machine `serverMoveEligibility: {eligible, reason?: 'current-server'|'offline'|'unsupported'}`, computed server-side exactly as `targetEligibility` at `service.ts:219-230`: online ∧ digest match (`relay.ts:771` rule) ∧ caps ∋ `server-move.v1`), listing contract/output schema.
- **Depends:** C1 lands first so the cap and the schema change ship together in daemon builds.
- **Tests first:** eligibility matrix (current-server / offline / cap-missing / digest-mismatch / eligible); listing schema test.
- **Lane:** `bun run --cwd apps/server test:contracts` (the listing output shape is the risk; it also exercises the service computation).

---

## Phase D — the `server-move` kind, recovery, recovery-only boot (§3–§7)

### D1. Kind skeleton, plan, start, cancel

- **Files:** new `apps/server/src/modules/server-transfer/operation.ts` (`serverMoveOperationKind()`), registration beside the update kind (`relay.ts:2241`), group from A5's `lifecycle.ts`.
- **Change:** §3.2 five-step plan (ids `preflight|stage|validate|fence|cutover`; `cutover` is row-only — **no runner registered for it**); `idempotencyKey = transferId`; `details` shape per §3.2; deadlines per §3.2 (fence 2 m/10 m pre-seal only); reversible flags (`preflight|stage|validate` true); `onCancel` per §3.2/§2.4 returning the structured result (target `abortPrepared`, journal abort, lock release; `cleanup:'pending'` when target unreachable; next-start preflight aborts a stale stage). Runners for `preflight|stage|validate` wrap today's `service.ts:642-671` checks, snapshot/prepare/chunk (progress percent = bytes), validate + `ServerTransferProof` match.
- **Depends:** A1–A5, B1–B3, C1–C2.
- **Tests first:** plan/ids/reversibility snapshot test; exclusion both directions at `store.activeByGroup` (`store.ts:152-157`) — update blocks move and vice versa; cancel mid-`stage` returns structured result and aborts journal+stage; restage-on-drift pre-seal patches progress and re-mints `transferId` keeping `record.probe`; resume-mid-stage from `receivedBytes` at adoption (B2 rule against a real row now).
- **Lane:** `bun run --cwd apps/server test:services`.

### D2. The fence runner: seal → fence → snapshot → full cutover → handed-off; reclaim exits; sealed projector

- **Files:** `operation.ts` (fence runner), `service.ts` (choreography extraction so the runner drives it), `projectRecoveryOperation(row, journalEntry, now)` in the server-transfer module wired into A3's `projectSealed` hook.
- **Change:** §4 steps 1–9 exactly, single runner: seal patch (`fence: running`, `cutover: pending`, `details.handoff`), journal `fence-pending`, physical fence (`pauseAndDrain` → `portableStateFence.acquire()` → mirror pause → `store.beginTransferFence()`), `source-fenced`, final snapshot + restage-on-drift, commit-boundary reauth (D4), `committing` before promote send, promote → proof → `demoteSource` → `journal.commit` → ack → `afterCommitted` → `retireSourceAfterTransfer`, return `handed-off`. Reclaim exit (A2) on any failure after seal and strictly before `committing`/promote-send: abort target stage, release fence, journal `aborted`, seal cleared, `failed`. **On any post-`committing` uncertainty** (lost reply, ambiguous proof, demote/commit write failure): record `commit-uncertain` as needed, return `handed-off`, never resume. Projection per §6.1: overlays from journal state; recovery ask (deterministic id `server-move-recovery`) synthesized for `commit-uncertain` always, and for `source-fenced|committing` when no in-flight drive owns the row; `operations.history` never projected.
- **Depends:** D1.
- **Tests first:** ordered-write test across the whole sequence (fs+transport spies; ack never before durable commit — §5.1); reclaim-per-failure-point matrix using B3 crash points (§2.2 tests 1–3: writable+unfenced+terminal `failed`, no promote send ever observed, fresh move succeeds, crash-during-reclaim converges at boot); `handed-off` end state (row non-terminal, engine silent); projection unit tests field-exact per §6.1 including identical output pre/post-reboot for identical `(row, journal)` inputs; **snapshot-carries-the-sealed-row**: fence, cut final snapshot, open the snapshot's `podium.db` (`ROOT_FILES[0]`, `snapshot.ts:13`), assert non-terminal row with `fence: running`/`cutover: pending`.
- **Lane:** `bun run --cwd apps/server test:services`.

### D3. Recovery `onAction` handler (§6.2) and target adoption reconcile (§5.3)

- **Files:** `operation.ts` (`onAction`), `service.ts` (`inspectUncertain` at `service.ts:673-722` extended), reconcile in `operation.ts` using `ServerMoveReality = {promoted, journal, machineId, now}`.
- **Change:** handler always `mode:'sealed'` for post-fence postures; mutates only journal/config facts. `source-fenced` (provably no `committing`): resolve-abort → abort target stage, file-level unfence, journal `aborted`, **trigger supervised process restart**; next writable boot adoption clears the stale seal and lands the terminal row via B2 accounting; never same-process `reclaimHandoff` from the handler; resolve-proceed refuses. `committing|commit-uncertain`: convergent `inspectUncertain` — (a) target promoted + byte-exact proof (incl. port) → `demoteSource` → `journal.resolveCommitted` → ack → `resolved-committed`; (b) target reports exact matching validated/staged transfer (transferId+digest+URL+port) not promoted → **reissue byte-identical promote idempotently**, verify proof, demote → commit → ack; (c) mismatch/unreachable/unknowable → `still-uncertain`; journal refuses `commit-uncertain → aborted` on proof absence alone. Reconcile at target boot per §5.3: full identity match → `fence`+`cutover` `done`, operation `done`, `handoff.role='completed-on-target'`; else `failed` `handoff-orphaned`; **no authz consulted**.
- **Depends:** D2, A3.
- **Tests first:** §6.2 focused list (dropped-request reissue converges; dropped-reply proof path converges without reissue; mismatch stays uncertain; idempotent double dispatch; abort→restart→boot-adoption clears seal and lands terminal row); reconcile matrix (match → done; each mismatched field → `handoff-orphaned`; no-metadata → orphaned; adoption never consults authz).
- **Lane:** `bun run --cwd apps/server test:services`.

### D4. Durable actor + identity reauthorization (§7)

- **Files:** `apps/server/src/modules/server-transfer/` authorization seam (`ServerTransferAuthorization.reauthorize`), replacing the `{reauthorize}` ctx closure in `apps/server/src/modules/fleet/handlers.ts:190-205`; a by-identity authz entry point beside `fleetAuthzFailure`.
- **Change:** `engine.start` records `createdBy` via A5's helper; `details.{authorizedBy, intent}` per §7.1 (confirmation phrase consumed, never persisted). Phase-boundary re-evaluation (`prepare|stage|validate|fence|commit`) against the persisted identity + intent byte-match; pre-fence denial → `reauthorization-denied` abort with target-stage abort; commit-boundary denial pre-`committing`/pre-promote → reclaim exit (D2); post-`committing` the stored actor gates nothing (recovery is the D3 action under the caller's live principal).
- **Depends:** D1–D3.
- **Tests first:** §7 matrix verbatim (each phase × actor states × intent mismatch; zero-request-context resumed drive; commit-boundary revoked → reclaim with no promote observed; recovery action refuses non-admin at contract layer).
- **Lane:** `bun run --cwd apps/server test:services`.

### D5. Recovery-only boot (§5.4)

- **Files:** `apps/server/src/server.ts` (today `assertWritableServerBoot` at `server.ts:366` refuses; `adoptOnBoot` awaited before bind at `server.ts:633`), operations facade narrate construction (`createOperations({mode:'narrate'})`).
- **Change:** `serverTransferBootMode` drives boot: `writable` → adoption then bind; `recovery-only` (`source-fenced|committing|commit-uncertain`) → store query-only, no session serving, gateway serving exactly `operations.active` (projection), `operations.history` (raw terminal), `operations.settleAsk`/`operations.action` (A3 sealed dispatch), health; no `adoptOnBoot`, no runner, no timer; `daemon-only` (`committed`) → refuse as today, no operations surface.
- **Depends:** D2, D3, A3.
- **Tests first:** recovery-only boot serves the projection with zero store writes (query-only store); the minimal-surface allowlist (any other procedure 404s); `daemon-only` unchanged.
- **Lane:** `bun run --cwd apps/server test:boundary` (this is router/boot composition; it covers the wiring the lean gate would otherwise check — run it instead of `test`).

---

## Phase E — public surface cutover (§10.1), same series as D, lands atomically with it

Phase D and E merge together (one landing series): the kind must not ship while the bespoke surface exists, nor vice versa.

### E1. `machines.moveServer` (rename, start-only)

- **Files:** `apps/server/src/router.ts`, `packages/commands/src/fleet/contracts.ts:814-846` (carry the policy row to the new name), `fleet/handlers.ts`.
- **Change:** replace `machines.transferServer` with `machines.moveServer`: same input + `port?`; handler resolves effective port (§8) into `details.intent.port` and calls `engine.start('server-move', …)`; returns `{started:true, operationId} | {started:false, alreadyRunning}`. No awaiting the move.
- **Depends:** D1, D4, C1.
- **Tests first:** contract test (authz row, input/output schema); handler returns immediately with `operationId`; `alreadyRunning` when the lifecycle group is busy.
- **Lane:** `bun run --cwd apps/server test:contracts`.

### E2. Server deletions

- **Files:** `apps/server/src/router.ts:413` (`serverTransferStatus`), `serverTransferStatusQuery`, `publicStatus` (`service.ts:211-264`), their tests.
- **Change:** delete all three and every reference; no compatibility projection. Regenerate server shards (`bun scripts/server-test-shards.ts --write`).
- **Depends:** E1 (replacement exists in the same series).
- **Tests first:** delete the `publicStatus` cases; the E6 grep-gate is the acceptance criterion.
- **Lane:** `bun run --cwd apps/server test:boundary`.

### E3. Web cutover

- **Files:** delete `apps/web/src/features/machines/server-transfer.ts`, `ServerTransfer.tsx`, and the inline phase UI in `apps/web/src/app/MachinesPanel.tsx:49-137`; delete the `checkTarget` re-mutate hook (`MachinesPanel.tsx:865`); add a `server-move` presenter beside the update presenter over the A5 kind-parameterized client; panel reads `operations.active({group:'lifecycle'})` on the `use-update-state.ts` cadence; confirmation dialog kept as UI gating `machines.moveServer`; recovery button "Check the new server" → `operations.settleAsk`; Settings → Machines history list via `operations.history({kind:'server-move', limit:20})`.
- **Depends:** A5, E1; D3 for the settle target.
- **Tests first:** presenter unit tests (step copy, §10.2 error-code sentences incl. `handoff-orphaned`, `handoff-unsealed`, `boot-recovery`, `recovery-refused`, `legacy-transfer-in-progress`); recovery ask renders the one button dispatching `operations.settleAsk`; delete the bespoke web tests and e2e status-route intercepts.
- **Lane:** `bun run test:related -- apps/web/src/app/MachinesPanel.tsx` (bounded exact evidence; not `test:web` unless the diff sprawls package-wide).

### E4. Visible-disabled affordance with skew fallback (§9)

- **Files:** `MachinesPanel.tsx` (rebase the existing disabled rendering at `MachinesPanel.tsx:1101,1158` onto `serverMoveEligibility`).
- **Change:** render "Make server" visible-disabled with the same-version copy ("Update this machine to the same Podium version as the server first.") for every non-eligible **online** target — including client-side fallback `({eligible:false, reason:'unsupported'})` when the listing lacks `serverMoveEligibility` or the server lacks `machines.moveServer` (`isMissingProcedure`). Never silently hidden by skew in either direction; current-server and offline rows render no affordance, as today.
- **Depends:** C2, E3.
- **Tests first:** rendering matrix: eligible → enabled; cap/digest-mismatch → disabled+copy; old-server/missing-field → disabled+copy (the fallback); missing-procedure → disabled+copy; offline/current-server → absent.
- **Lane:** `bun run test:related -- apps/web/src/app/MachinesPanel.tsx` (covered by E3's run when landed together — one lane, not two).

### E5. Desktop

- **Files:** none required in `bootstrap.rs` — it keeps reading the raw journal marker; retarget continuity comes from D3 reconcile. Verify only.
- **Change:** none; add a Rust-side classification test if one does not already cover `classify_backend_exit` on the committed marker (see G9).
- **Depends:** D3.
- **Lane:** covered in phase G scenario 9; no separate lane here.

### E6. Grep-gate

- **Files:** a small test (server shard `contracts` or a `scripts/` check) asserting: `serverTransferStatus` appears nowhere outside `packages/protocol`; `recoverServerMove` appears nowhere; `transferServer` (the old mutation name) appears nowhere in `apps/`/`packages/commands`.
- **Depends:** E1–E4.
- **Lane:** `bun run test` (the gate itself is hermetic; run once at series end).

---

## Phase F — error taxonomy and copy (§10.2)

### F1. Codes and presenter sentences

- **Files:** `apps/server/src/modules/server-transfer/types.ts:208-226` (`TRANSFER_FAILURE_CODES` + `handoff-orphaned`, `handoff-unsealed`, `boot-recovery`, `recovery-refused`, `legacy-transfer-in-progress`), web presenter copy map.
- **Depends:** D-phase codes exist; E3 presenter.
- **Tests first:** every code has exactly one presenter sentence (exhaustiveness test over the union).
- **Lane:** `bun run test:related -- <presenter file>` (or folded into E3's run when landed together).

---

## Phase G — two-machine Docker acceptance (§10.3)

Extend `tests/acceptance/server-transfer/` (compose: `source`, `target`, `control-proxy`, `edge`, `scenario`). Every scenario asserts through `machines.moveServer` + `operations.*` only. This lane is the scripted acceptance harness — run it as the phase's single validation (it is not part of `test`/`test:full`); evidence via the coordination volume and `TRANSFER_EVIDENCE`.

| # | Scenario | Key assertions (§10.3) |
|---|---|---|
| G1 | Happy path | step progression via `operations.active({group:'lifecycle'})` (fence/cutover advance = projection); same operation id `done` in target history; target serves on the explicit proof port |
| G2 | Concurrent writes pre-copy | digest drift → restage; last pre-fence write present on target |
| G3 | Concurrent writes during fence | no write lands after `source-fenced`; snapshot digest matches shipped bytes |
| G4a | Dropped promote **reply** | uncertain posture + `server-move-recovery` ask via projection; recovery **only** via `operations.settleAsk`; converges to target `done` + demoted source |
| G4b | Dropped promote **request** | same posture; handler detects target staged/validated with matching identity, reissues byte-identical promote, converges; assert the reissue happened |
| G5 | Post-promotion source crash before ack | B3 crash point between promote and durable demote/commit; source reboots recovery-only with `commit-uncertain`, serves projection immediately; `operations.settleAsk` completes demote→commit→ack; **no ack before the committed journal exists on disk** (coordination volume) |
| G6 | Live shell after cancel | cancel during `stage`; structured cleanup `complete` (variant: target unreachable → `pending`, janitor converges); journal aborted; shell still live — source never fenced |
| G7 | Retry after abort | fresh `machines.moveServer` succeeds; history shows both with `retryOf` |
| G8 | Restart resume | kill mid-`stage`; reboot resumes from `receivedBytes`; doctored mismatched journal orphan-aborts |
| G9 | All-in-one desktop → remote | `classify_backend_exit` retargets on committed marker (Rust unit test + scripted run); webview reconnects to target URL; session survives; retargeted history shows the move (`TRANSFER_EVIDENCE`) |
| G10 | Reclaim on post-seal failure | fault-inject between seal and promote-send (fence failure, snapshot failure, commit-boundary reauth denial); source ends writable/unfenced with terminal `failed`; target harness observed **no promote message at any point**; fresh move succeeds |

- **Depends:** all prior phases.
- **Lane:** the `tests/acceptance/server-transfer/` scripted run itself (one invocation covering the scenario matrix). Do not additionally run `test:integration`/`test:e2e` for this phase.

---

## Landing order and dependency summary

```
A1 ─┬─ A2 ─┐
    ├─ A3 ─┤
A4 ─┘      │
A5 ────────┤
B1 ─ B2 ─┐ │        (A and B phases are independent of each other)
B1 ─ B3 ─┤ │
B4 ──────┤ │
C1 ─ C2 ─┴─┴─ D1 ─ D2 ─ D3 ─ D4 ─ D5 ─┐
                                       ├─ E1 ─ E2 ─ E3 ─ E4 ─ E6   (one landing series with D)
                                       │        F1
                                       └───────────── G1…G10
```

Phases A, B, C are independently landable behind the existing surface. Phase D+E is **one series** — the cutover is atomic (§10.1/§10.4: single-cutover release; server, web, desktop, daemon ship as one version; the `server-move.v1` cap keeps new promote messages away from old daemons; the update system converges the fleet). No schema migration is needed: the `operations` table already holds any kind, and transfer state was never in the DB. Old journals: B2 orphan-aborts pre-fence ones at boot; `committed` still classifies daemon-only; no history backfill.
