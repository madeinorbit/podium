# Server move as a durable operation

- **Date:** 2026-08-17, surveyed against `origin/main` @ `9bc669e4d`
- **Issue:** POD-2267 (Server move operations spec), parent epic POD-1747 (Server Transfer Across Machines); supersedes the POD-2257 draft
- **Status:** implementation-ready
- **Relation to prior art:** replaces the public surface of `2026-08-06-server-transfer-design.md` (its journal state contract and split-brain internals survive); builds on `2026-08-14-update-operations-design.md` §3.0, which reserved the `lifecycle` exclusion group for exactly this operation.

## 0. Summary

Server transfer becomes a **`server-move` operation** in the operations framework. From the first release, operations are the *only* public model for progress, status, recovery, and history: clients read `operations.active({group:'lifecycle'})` and `operations.history({kind:'server-move'})`, and nothing else. The `machines.serverTransferStatus` query (`apps/server/src/router.ts:413`), the `publicStatus()` projection (`apps/server/src/modules/server-transfer/service.ts:211-264`), the bespoke web polling model, and both copies of the phase UI are **removed in the same cutover** — no compatibility projection, no transitional dual surface. `machines.moveServer` (renamed from `machines.transferServer`) is **start-only**: it returns `{started, operationId}` and never awaits the move.

What survives, verbatim and internal-only, is the split-brain safety core: the `.server-transfer` journal, the portable-write fence, promotion and serving proofs, commit-uncertain logic, target-owned stage metadata, and target history continuity. The journal remains authoritative for "may a writable server boot here"; the operation is authoritative for "what should a human see and do."

The framework as it exists cannot host this kind honestly. Three generic engine extensions are part of this design (§2): a **coordinator-handoff runner outcome** (the engine today has no way for a step to say "the successor owns completion" — `StepOutcome.state` is exactly `done|running|skipped|failed`, `kinds.ts:40-42`), an **indefinite safety wait** (waiting is always bounded by `waitingGraceMs ?? 10min`, `engine.ts:790-804`, and `kinds.ts:126-129` explicitly forbids "forever"), and **async kind cancel cleanup** (`cancel()` is synchronous and hookless, `engine.ts:356-373`). Each is specified as a generic capability with its own tests, not a server-move special case.

## 1. Diagnosis: why the current shape is wrong

On `origin/main`:

1. **A parallel status universe.** `machines.serverTransferStatus` projects a hand-rolled shape with no contract, no authz entry, no output schema. The web client (`apps/web/src/features/machines/server-transfer.ts`, plus a second copy of the phase UI inline in `apps/web/src/app/MachinesPanel.tsx:49-137`) reimplements polling, backoff, and stale-read discarding that `use-update-state.ts` already implements for operations.
2. **A parallel exclusion universe.** Transfer exclusivity is a pid-file lock (`server-transfer/lock.ts`); update exclusivity is the `lifecycle` group (`updates/operation.ts:82`). Today an update and a transfer can run concurrently.
3. **No history.** The journal is overwritten per transfer; a completed or failed move leaves no queryable record.
4. **Recovery is a client protocol.** Commit-uncertain recovery is "call the mutate again" from a React hook (`MachinesPanel.tsx:865` `checkTarget`). The retry contract lives in the browser.
5. **Ephemeral actor.** Reauthorization closes over the live tRPC request (`fleet/handlers.ts:190-205`); nothing durable records who authorized the move, and no re-drive after a restart could ever reauthorize.
6. **The fence marker lies.** The journal writes `source-fenced` *before* the physical fence engages (`service.ts:366-367`). A crash in between leaves a machine claiming to be fenced that never was, stranded in recovery-only for no safety reason.
7. **The promoted port is implicit.** `promote` carries `port?` optionally; when absent the target's config keeps whatever port it had and the bind resolves through `PODIUM_PORT` → `config.port` → default (`packages/runtime/src/config.ts:458-468`). The serving proof carries no port at all — the URL string is the only cross-check.

## 2. Generic engine extensions

These land in `apps/server/src/modules/operations/` first, kind-agnostic, each with focused tests. The update kind is untouched by all three (its restart survival is same-process-successor adoption, not cross-machine handoff).

### 2.1 Coordinator handoff (correction 1)

Two pieces, because the handoff write must be durable *before* the irreversible act (for server-move: before the fence makes `podium.db` read-only).

**`engine.sealForHandoff(operationId, stepId, patch)`** — a new engine method a runner calls from inside `ensure()`:

- Performs one final durable `store.update` applying `patch` (for server-move: `fence` step → `done`, `cutover` → `pending`, `details.handoff = {…}`).
- Atomically marks the operation **sealed** in this engine instance: an in-memory set plus a persisted `details._handoff` engine fact in the same write.
- After the seal, in this process, for this operation: `recordProgress` is **dropped** (not thrown), `reensure`/`admitDeferred`/`settleAsk` refuse, all deadline and waiting timers are disarmed and can never re-arm, `driveLocked` becomes a no-op, and `settle`/`finish`/`persist` refuse. The sealed source never writes this row again.

**`StepOutcome.state: 'handed-off'`** — a fifth outcome state. The runner performs the irreversible act (fence + final snapshot) *after* sealing, then returns `{state:'handed-off'}`. On receiving it the engine asserts the seal exists (a `handed-off` outcome without a prior seal fails the operation with code `handoff-unsealed` — that ordering bug must be loud), stops driving, drops the in-memory context, and keeps no timer. The operation remains non-terminal in the local row forever; **the adopting engine on the machine that inherits the row is the sole durable writer from the seal onward.**

**Exact tests** (`engine.test.ts` additions, engine driven against a store whose connection flips query-only after the seal to prove no write is even attempted):

1. Seal write is durable and applies the patch; a second `sealForHandoff` for the same operation refuses.
2. Post-seal `recordProgress` is dropped silently; the row bytes are unchanged.
3. Post-seal `driveLocked`/`enqueue` never invokes a runner; no step advances.
4. Post-seal: no timer is armed; a previously armed deadline is disarmed; `clock.setTimeout` receives zero new calls.
5. Post-seal `settleAsk`, `reensure`, `admitDeferred`, `cancel` refuse; `settle` is never reached (operation never goes `waiting`/`done` locally).
6. `'handed-off'` outcome without a seal → operation `failed`, code `handoff-unsealed`.
7. Store-level: after the connection is query-only, none of the above paths throws — the seal check short-circuits before SQLite.
8. Adoption on a *different* engine instance (fresh store handle over the traveled bytes) parses the sealed row, and `reconcile` may rewrite it — the seal is per-process, not in the schema's way.

### 2.2 Indefinite safety wait (correction 6)

`OperationKindDefinition` gains `waitingPolicy?: { graceMs: number } | { indefinite: true }` (superseding bare `waitingGraceMs`, which remains as sugar for `{graceMs}`). With `{indefinite: true}`:

- `armWaitingGrace` arms **no expiry**. Instead it arms a re-narration tick (re-announce via `onChanged` every 10 minutes) so the wait stays visible without ever resolving itself.
- `describeWaitingExpiry` is refused at registration when the policy is indefinite (dead code must not look load-bearing).
- The waiting operation still ends normally through `settleAsk`/drive or through `reconcile` at adoption.

The POD-2149 concern ("an unbounded wait is the defect the grace exists to close") is answered by making indefinite an explicit per-kind declaration reviewed in a diff, reserved for waits where auto-resolution would be a lie. Commit-uncertain is the canonical case: auto-`done` fabricates a move that may not have happened; auto-`failed` invites a second writable server. Tests: indefinite policy arms no expiry timer at all; the wait survives arbitrary clock advance; registration with both `indefinite` and `describeWaitingExpiry` throws; bounded kinds behave exactly as before.

### 2.3 Async cancel cleanup (correction 6)

`OperationKindDefinition` gains `onCancel?(input: {operation, step, context}): Promise<StepProgressPatch | void>`. `engine.cancel` becomes async:

1. Reversibility gate unchanged (`runners[inFlight.id]?.reversible !== true` → refuse `irreversible`).
2. If the kind has `onCancel`: persist the in-flight step as `detail:'canceling'`, run the hook under a deadline budget (default 60 s, kind-overridable via `deadlines['#cancel']`), then `finish(canceled)` with the hook's patch applied. Hook failure or budget breach still finishes `canceled`, with `details.cleanup = 'pending'` and the error recorded — cancel must never wedge an operation in a live state.
3. Without `onCancel`, behavior is today's, just behind an awaited promise.

`operations.cancel` over tRPC becomes an async mutation returning the same `CancelResult` (wire-compatible shape; latency is the only visible change — acceptable inside this cutover). Tests: hook runs exactly once; concurrent cancels coalesce; hook failure → `canceled` + `cleanup:'pending'`; refusal paths never invoke the hook.

## 3. The `server-move` operation kind

### 3.1 Registration

New module `apps/server/src/modules/server-transfer/operation.ts` exporting `serverMoveOperationKind(): OperationKindDefinition<ServerMoveContext, ServerMoveReality>`, registered beside the update kind (`relay.ts:2241`). `LIFECYCLE_EXCLUSION_GROUP` is promoted from `updates/operation.ts:82` to a shared module (`modules/operations/lifecycle.ts`) so neither kind imports the other. Sharing `lifecycle` closes defect §1.2 by construction via `store.activeByGroup` (`store.ts:152-157`): at most one of {update, server-move} is ever non-terminal. The `TransferLock` pid file is retained as the cross-*process* guard beneath the cross-*request* group.

### 3.2 Step plan

`plan(context)` returns five steps; ids stable, titles UI copy:

| id | title | reversible | maps to today |
|---|---|---|---|
| `preflight` | Checking the move | yes | target/source/version/capacity checks (`service.ts:642-671`) |
| `stage` | Copying server state | yes | initial snapshot + prepare + chunk upload; percent = bytes |
| `validate` | Verifying the copy | yes | validate RPC + `ServerTransferProof` match |
| `fence` | Pausing this server | **no** | two-phase fence of §4 + final snapshot + restage-on-drift |
| `cutover` | Switching servers | **no** | promote → proofs → demote → commit → seal-completed-elsewhere |

Idempotency inherits the engine invariants unchanged: `idempotencyKey = transferId`; target `prepare` is digest-keyed with `receivedBytes` resume; `chunk` contiguous-offset; `promote` full-object idempotent replay; `acknowledge` idempotent on `meta.acknowledged`. Restage-on-digest-drift stays inside the `fence` runner as a progress patch (`detail:'state changed during fencing; restaging'`), minting the new `transferId` as today and keeping the discarded stage in `record.probe`.

`details` (kind-owned, passthrough): `{ transferId, sourceMachineId, targetMachineId, publicUrl, port, bytesCopied, totalBytes, manifestDigest, authorizedBy, intent, handoff? }`. Journal-state vocabulary never appears in the operation.

Deadlines (`StepDeadlines` per step): preflight 60 s/5 m, stage 3 m/30 m, validate 60 s/5 m, fence 2 m/10 m — all fail (with target-stage abort where one exists). `cutover` **never auto-fails**: silence retry (`reensure`) is safe because every RPC is idempotent, but total breach maps to the uncertain posture (§6), never to `failed` — past `committing` a deadline cannot know whether the target promoted.

Cancel: `preflight`/`stage`/`validate` runners declare `reversible: true`; the kind's `onCancel` (§2.3) aborts the target stage (`abortPrepared`), aborts the journal, releases the lock, and records cleanup outcome. `fence`/`cutover` omit `reversible` → engine refuses `irreversible`. Retry of a **failed/canceled** move is a new `start('server-move', …, {retryOf})`; the `aborted` journal is re-beginnable as today. Retry of an **uncertain** move is recovery (§6), never a new operation.

## 4. The fence: two-phase marker (correction 2)

Today the journal claims `source-fenced` before the fence exists (§1.6). Replaced by two states with exact crash coverage. `TransferJournalState` gains `fence-pending`; `LEGAL_TRANSITIONS` gains `validated → fence-pending`, `fence-pending → source-fenced`, `fence-pending → aborted`; `validated → source-fenced` is removed.

Sequence inside the `fence` runner:

1. `engine.sealForHandoff` (§2.1). The seal patch deliberately does **not** claim the fence: it records `fence: running` (`detail:'pausing'`), `cutover: pending`, and `details.handoff = {role:'source', transferId, targetMachineId, publicUrl, port, sealedAt}`. The traveled row therefore never claims a fence that had not happened; target reconcile (§5.3) completes both `fence` and `cutover` from proof.
2. Journal `fence-pending` (fsync + dir-fsync, the §journal atomic protocol).
3. Physical fence: `pauseAndDrain` → `portableStateFence.acquire()` → mirror pause → `store.beginTransferFence()` (`relay.ts` fence composition).
4. Journal `source-fenced` — written only now, after the fence is fact.
5. Final snapshot (carries the sealed operation row and the `source-fenced` journal-external state), restage-on-drift if the digest moved.
6. The fence runner returns `{state:'done'}` in-memory only (the engine's persist of that outcome is dropped by the seal — the step's durable completion belongs to the target). The drive proceeds to the **cutover** runner, which still coordinates from the source process: promote → proofs → demote → `journal.commit` (all file-level writes, legal under a fenced SQLite) → acknowledge → return `{state:'handed-off'}`; retirement follows. The engine writes nothing after the seal in step 1; every later durable fact lives in the journal or on the target.

Crash matrix (boot behavior, §5.4 seam):

- **Before the journal intent** (`preparing|staged|validated`, seal may or may not have been written): pre-fence world. With a matching active operation (§5.5) adoption resumes the step; the seal, if present, is cleared by the resuming fence runner re-sealing (seal is idempotent-per-operation via refusal + explicit `resealForRetry` on the resumed drive — engine detail: a resumed adoption may clear `details._handoff` before re-driving, and only adoption may).
- **Between `fence-pending` and the physical fence** (or between fence and `source-fenced`): no final snapshot was cut, so no promote was ever issued and nothing post-fence left this machine. `fence-pending` is classified **pre-fence for boot recovery**: `blocksWritableServer('fence-pending') = false`; `reconcileSafeServerTransferBoot` treats it like `validated` — resumable with a matching operation, otherwise aborted. The machine is never stranded in recovery-only by a marker written ahead of fact.
- **After `source-fenced`**: recovery-only boot (§5.4). The fence was real; only proof from the target (or an operator recovery command) moves the world forward. `source-fenced` continues to block writable boot.

The public claim discipline: the sealed row can never be rewritten on the source, so **the fence step is presented `done` on the source only through the recovery projection (§6.1), which overlays the journal's durable `source-fenced` fact**, and it is durably recorded `done` only by target reconcile. The row never lies; the projection narrates the journal's facts; the target's adoption writes them.

## 5. Coordinator handoff across machines

The operation row lives in `podium.db`, which is `ROOT_FILES[0]` of the portable payload (`snapshot.ts:13`). The final snapshot is cut after the fence; whatever the sealed row says is what the target inherits.

### 5.1 Source epilogue (correction 10)

Ordering in the cutover runner, pinned by tests: promote → `healthProofMatches` (now including port, §8) → **`demoteSource` (config write, fsync) → `journal.commit` (fsync + dir-fsync)** → *only then* `acknowledge` to the target → `afterCommitted` → `retireSourceAfterTransfer`. Demotion and the committed journal are durable **before** the target is told to finalize and before any retirement step. If demotion or the journal-commit write fails after a successful promote, the runner records `commit-uncertain` (the journal refuses nothing here: `committing → commit-uncertain` is legal) and the posture of §6 applies — recoverable, never a silently un-demoted source. Acknowledge failure after a durable commit is non-fatal (`result:'pending'` cleanup, as today).

### 5.2 What the source never does again

After the §4 seal: no persist, no step advance, no timer, no settle (all engine-refused, §2.1 tests), and after the fence no SQLite write is possible anyway (query-only). The journal file remains the source's only durable voice, and only for split-brain safety.

### 5.3 Target boot adoption — the sole durable writer

At target boot, promotion has rewritten `config.json` to `mode:'server'` and `podium.db` is the traveled DB. `adoptOnBoot` (`engine.ts:394-420`, awaited before the gateway binds — `server.ts:633`) finds the non-terminal sealed `server-move` row. `reconcile(operation, reality)` with `ServerMoveReality = { promoted: PromotedTargetMetadata | null, journal, machineId, now }` (`readPromotedTargetMetadata`, `target-status.ts:75-101`):

- `promoted` present ∧ `promoted.transferId === details.transferId` ∧ manifest digest ∧ `publicUrl` ∧ port match → steps `fence` and `cutover` → `done`, operation → `done`, `details.handoff.role = 'completed-on-target'`, `finishedAt` stamped. History on the new server shows the completed move — desktop-retarget continuity and history continuity are one mechanism.
- Identity mismatch or no promoted metadata → operation `failed`, code `handoff-orphaned`. A promoted DB with a foreign sealed row is a should-never; fail loudly, never guess.
- No capability check happens here (§7.3): reconciling a cryptographically proven, already-authorized move is fact-recording, not a privileged act.

### 5.4 Recovery-only boot on the source

`serverTransferBootMode(stateDir)` (`journal.ts:292-298`) becomes load-bearing in `server.ts` (today `assertWritableServerBoot` at `server.ts:366` just refuses):

- `'writable'` → normal boot; adoption before bind.
- `'recovery-only'` (`source-fenced | committing | commit-uncertain`) → the server boots with the store **query-only**, no session serving, and a gateway serving exactly: `operations.active`, `operations.history`, health, and the authenticated recovery command of §6.2. The engine runs in **narrate-only** mode: `createOperations({mode:'narrate'})` — `adoptOnBoot` is not called, no runner is ever driven, no timer armed, and every write path refuses; `operations.active` is served through the §6.1 projection instead of raw row bytes. Driving a cutover from a half-fenced boot is exactly the split-brain the journal exists to prevent.
- `'daemon-only'` (`committed`) → refuse writable boot as today; supervision retargets. No operations surface on the retired source.

### 5.5 Restart resume vs orphan abort (correction 4)

`reconcileSafeServerTransferBoot` today unconditionally aborts pre-fence journals. New rule, evaluated at adoption (writable boot):

- A pre-fence journal (`preparing|staged|validated|fence-pending`) **with a matching active `server-move` row** resumes: adoption re-drives the in-flight step; runners are idempotent (`prepare` replay, `chunk` offset resume, re-validate). **Exact identity match** required, all four: `journal.record.transferId === details.transferId` ∧ `targetMachineId` ∧ `publicUrl` ∧ (`journal.record.manifestDigest === details.manifestDigest` — with the restage rule that after drift both were rewritten together pre-fence, so they cannot legitimately diverge).
- A pre-fence journal with **no** active operation row, a terminal row, or any field mismatch is an **orphan** (includes every legacy journal written before this release): aborted with `{code:'boot-recovery'}` and cleanup `pending`, exactly today's mechanics; if an active-but-mismatched row exists it is failed with `boot-recovery` too. History then shows "the move was interrupted by a restart" instead of nothing.

Tests: resume-after-restart mid-`stage` continues from `receivedBytes` (acceptance §10.3); each mismatched field aborts; legacy journal aborts; abort is idempotent across double boot.

## 6. Commit-uncertain and recovery without writes (correction 3)

### 6.1 The projection

In recovery-only mode the store cannot persist asks, adoption rewrites, or anything else. Therefore recovery status is a **pure read-time projection** — `projectRecoveryOperation(row, journalEntry, now)` in the server-transfer module, deterministic, unit-tested field-exact:

- Base = the persisted sealed operation row, verbatim.
- `journal.state === 'source-fenced'` → overlay: `fence` step `done` (the journal is the fact the row could not record), `cutover` `pending`, `detail:'ready to switch'`.
- `'committing'` → `cutover` `running`, `detail:'switching servers'`.
- `'commit-uncertain'` → operation `state:'waiting'`, `cutover` `stalled`, and one synthesized required ask `{id:'server-move-recovery', required:true, title:'The switch's outcome is unknown', detail:…}` with a **deterministic id** — never persisted, identical after every restart. Restart durability is free: the projection is a function of (row bytes, journal file), both durable.

`operations.active`/`history` in recovery-only mode serve this projection; on a healthy writable server they serve raw row bytes as today. The projection is still the generic `Operation` shape — clients cannot tell, and there is still no other public API.

### 6.2 The recovery command

The ask is settled not by `settleAsk` (a write) but by an **authenticated command**: `machines.recoverServerMove` — contract beside `machines.moveServer` (roleFloor admin, `machineVerb:'manage'`, hub/recovery-serving), input `{operationId}`. It runs `inspectUncertain` (`service.ts:673-722`) under the **calling operator's live principal** (§7.2): target promoted with byte-exact serving proof (incl. port) → `demoteSource` → `journal.resolveCommitted` → acknowledge → outcome `resolved-committed`; target answers aborted/no stage → the journal deliberately refuses `commit-uncertain → aborted`; outcome `still-uncertain` with operator guidance. Journal and config writes are file-level and legal under a fenced SQLite. The command is idempotent and available on both a live source (uncertain while still writable-booted? no — uncertain implies fenced; it is served by the recovery-only gateway) and re-runnable after restarts.

`waitingPolicy` for the kind is `{indefinite: true}` (§2.2): an uncertain move never auto-resolves. On a *writable* engine, the same uncertain posture (reached without a crash, e.g. lost promote reply) is the operation `waiting` with the same ask; the web renders one button — "Check the new server" — that calls `machines.recoverServerMove`. The engine-side settle happens on the next drive after the command resolves the journal. `checkTarget` and re-mutate recovery are deleted.

If the target did promote and the source dies unresolved: desktop/daemon retarget carries the user to the target, whose adoption already recorded `done` (§5.3). The uncertain row on the abandoned source is moot.

## 7. Durable actor and reauthorization (correction 5)

### 7.1 Persisted intent

`engine.start('server-move', context, {createdBy})` records the durable actor (`user:<id>` / `session:<id>` / `system:<slug>`, the issues encoding precedent). `details` carry `{authorizedBy, intent: {targetMachineId, publicUrl, port, confirmation:'satisfied'}}`. The literal confirmation phrase is consumed at start, never persisted. **No request closure exists anywhere**: the current `{ reauthorize }` closure over `ctx` (`fleet/handlers.ts:190-205`) is replaced by identity-based checks.

### 7.2 Reauthorization at every privileged phase

`ServerTransferAuthorization.reauthorize(phase)` is kept as the seam, reimplemented as: at each phase boundary (`prepare|stage|validate|fence|commit`), re-evaluate **current policy for the persisted identity** — `fleetAuthzFailure` against a principal reconstructed from `details.authorizedBy` (a new authz entry point by identity, not by live ctx), plus byte-match of the journal/stage identity against `details.intent`. This works identically for the original drive, a post-restart resumed drive, and `resumeStalled` — there is no live-request special case.

- Actor deleted, demoted below the policy floor, or capability revoked → pre-fence phases fail `reauthorization-denied` (move aborts cleanly, target stage aborted).
- Post-fence (`commit` phase on a resumed drive): a revoked actor does **not** proceed to promote — it parks the operation in the §6 uncertain-shaped waiting posture with error `reauthorization-denied`; finishing requires an operator with live authority via `machines.recoverServerMove`. Completing an *already-committed* cutover (target promoted, proof in hand) proceeds regardless — reconciliation of fact, not a privileged act.
- The recovery command itself is authorized by its **caller's** live principal only; the stored actor is irrelevant to recovery authority.

### 7.3 After adoption

Target reconciliation performs no capability check (§5.3): identity proof (transferId + digest + URL + port vs `PromotedTargetMetadata`, itself gated on a byte-exact `ServerTransferServingProof`) is the authorization — the move already happened under the recorded intent. Any *new* privileged action on the target requires a fresh principal; durable intent authorizes exactly one move, once.

Tests: phase-boundary matrix (each phase × {actor ok, actor revoked, actor missing, intent mismatch}); resumed-drive reauthorization uses stored identity with zero request context; post-fence revoked → parked not promoted; recovery command refuses non-admin callers; adoption never consults authz.

## 8. The explicit port (correction 8)

The promoted target must serve on a port that was decided, carried, written, and proven — never inherited:

- `machines.moveServer` input keeps `port?`; the handler resolves the **effective port** at start (explicit `port`, else the `publicUrl`'s effective port for direct setups, else the instance default) and persists it in `details.intent.port`. The existing URL/port cross-check (`normalizedPublicUrl`, `service.ts:123-143`) is kept.
- `ServerTransferPromoteRequestMessage.port` becomes **required** (`packages/protocol/src/messages/server-transfer.ts:134-146`); the daemon's `persistTargetConfig` always writes `port` into `config.json` (no more falling through to a pre-existing value or `PODIUM_PORT` accident).
- `ServerTransferServingProof` gains `port: number` (protocol L80-95); the daemon builds the expected proof with it; `healthProofMatches` and the target-side `exactServingProof` compare it. A target serving on the wrong port can no longer pass proof.
- `PromotedTargetMetadata` carries the port; §5.3 reconcile matches it.

This is a daemon-wire schema change; §9's capability gating (`server-move.v1`) is what keeps an old daemon from ever receiving the new promote message.

## 9. Eligibility, capability, and the visible-disabled affordance (correction 7)

**Daemon capability reporting.** The handshake already carries `caps: string[]` and `build {appVersion, wireSchemaDigest, installKind}` (`packages/protocol/src/handshake/envelope.ts:173-209`), persisted via `setMachineBuild` (`apps/server/src/store/machines.ts:143-155`). New additive cap token **`server-move.v1`**, advertised by daemons built at or after this release. Eligibility for a target becomes: online ∧ `wireSchemaDigest === wireSchemaDigest()` (today's check, `relay.ts:771`) ∧ caps contain `server-move.v1`. The source side checks itself symmetrically at `preflight`: its own build must advertise the cap (a downgraded source refuses to start a move).

**Placement** (settles prior-draft open question 1): a per-machine `serverMoveEligibility: { eligible: boolean, reason?: 'current-server'|'offline'|'unsupported' }` field on the machines listing (`listMachines`, `machines/service.ts`), computed server-side over the caller-visible fleet exactly as `targetEligibility` is today (`service.ts:219-230`). No dedicated status RPC.

**UI.** "Make server" **remains visible but disabled** on an online, digest-or-cap-mismatched target — today's rendering survives the cutover (`MachinesPanel.tsx:1101,1158`: disabled button, "Same version required", title copy "Update this machine to the same Podium version as the server first."), rebased onto `serverMoveEligibility` instead of the deleted status snapshot. Offline and current-server rows keep rendering no affordance.

**Legacy exclusion with update path.** `preflight` fails with `target-unsupported` (and the same-version sentence) if the target lacks the cap; additionally, a machine carrying a **legacy transfer journal** (any pre-operations `.server-transfer/journal.json` in a non-terminal state, source or target side) is excluded: source-side it is the §5.5 orphan abort before any new move; target-side `prepare` refuses with `target-rejected` and detail "finish or clear the previous transfer, then update this machine". The remediation in every mismatch sentence is the update system — converge the fleet, then move.

## 10. Public surface cutover, tests, rollout

### 10.1 Removal (same cutover)

Server: delete `machines.serverTransferStatus` (`router.ts:413`), `serverTransferStatusQuery`, `publicStatus` (`service.ts:211-264`); replace `machines.transferServer` with **`machines.moveServer`** (rename settles prior-draft question 3 — un-aliasable cutover): same input schema + `port?`, same policy row (`packages/commands/src/fleet/contracts.ts:814-846` carried over), handler = `engine.start(...)`, returns `{started:true, operationId} | {started:false, alreadyRunning}`. Add `machines.recoverServerMove` (§6.2). Daemon wire protocol stays internal transport (with §8's port change).

Web: delete `apps/web/src/features/machines/server-transfer.ts`, `ServerTransfer.tsx`, and the inline copy in `MachinesPanel.tsx:49-137`; the panel reads `operations.active({group:'lifecycle'})` on the `use-update-state.ts` cadence with a `server-move` presenter beside the update presenter (`operation-view.ts` is kind-agnostic; its update-keyed `errorCopy` and the client's hardcoded `kind:'update'` in `readLatestOperation` (`operations-client.ts:81`) are generalized by kind parameter — a required enabler, since both kinds share the `lifecycle` group). Confirmation dialog survives as UI gating the start call. Settings → Machines gains the history list (`operations.history({kind:'server-move', limit:20})`). Desktop: no supervisor change — `bootstrap.rs` keeps reading the raw journal marker; retarget continuity improves for free via §5.3. CLI promote/retire workers untouched.

Grep-gate test: `serverTransferStatus` exists nowhere outside `packages/protocol` (daemon wire name). Delete/replace the bespoke web tests, the `publicStatus` cases, and the e2e status-route intercepts.

### 10.2 Error taxonomy

Kind codes = `TRANSFER_FAILURE_CODES` (`types.ts:208-226`) verbatim, plus `handoff-orphaned` (§5.3), `handoff-unsealed` (§2.1), `boot-recovery` (§5.5), `recovery-refused` (§6.2 still-uncertain). Framework codes apply as to any kind. Daemon wire codes stay transport-internal; runners translate at the seam. Every code gets one user sentence in the presenter.

### 10.3 Real two-machine acceptance (correction 9)

Extend `tests/acceptance/server-transfer/` (docker compose: `source`, `target`, `control-proxy`, `edge`, `scenario` — two real machine containers). Scenarios, each asserting through `machines.moveServer` + `operations.*` only:

1. **Happy path**: step progression `preflight→stage→validate→fence→cutover` observed via `operations.active({group:'lifecycle'})`; on the target, `operations.history({kind:'server-move'})` shows the same operation id `done` — cross-machine row continuity end to end. Assert the target serves on the explicit port from the proof.
2. **Concurrent writes during pre-copy**: a live agent session writes transcripts/DB rows continuously through `stage`; assert the final-fence digest drift triggers restage and the moved server contains the last pre-fence write.
3. **Concurrent writes during the final fence**: writers active while the fence engages; assert `pauseAndDrain`/fence refuses or drains them (no write lands after `source-fenced`), and the snapshot digest matches what shipped.
4. **Lost commit reply, full recovery**: control-proxy drops the promote reply; operation reaches the uncertain waiting posture with the `server-move-recovery` ask; drive recovery **only** via `machines.recoverServerMove` (the old re-mutate path must not exist); assert convergence to `done` on the target and demoted source.
5. **Post-promotion source persistence failure before ack**: crash-inject the source between successful promote and durable demote/commit (new source-side crash point mirroring the daemon's `ServerTransferCrashPoint` family); assert the source reboots into recovery-only with `commit-uncertain`, target unacknowledged; `machines.recoverServerMove` completes demote → commit → ack; assert §5.1 ordering held (no ack observed before the committed journal exists on disk — evidenced via the coordination volume).
6. **Live shell after abort**: an interactive agent session with a running shell on the source; cancel the move during `stage`; assert cancel cleanup (§2.3) runs, the journal aborts, and the same shell session is still live and interactive afterward — the source was never fenced.
7. **Retry after abort**: after scenario 6, a fresh `machines.moveServer` to the same target succeeds; history shows both operations with `retryOf` linkage.
8. **Restart resume**: kill the source mid-`stage`; on reboot the matching operation resumes idempotently from `receivedBytes` (§5.5); a doctored mismatched journal instead aborts as an orphan.
9. **All-in-one desktop → remote**: desktop harness scenario — an all-in-one desktop (`LaunchAction::LocalAllInOne`, `bootstrap.rs`) moves its server to a remote machine; assert `classify_backend_exit` retargets on the committed marker, the webview reconnects to the target URL, the logged-in session survives (cookie/capability carry-over), and the retargeted webview's operations history shows the completed move. Runs as a Rust-side classification test plus a scripted acceptance run with evidence (`TRANSFER_EVIDENCE`) asserting webview URL and session identity before/after.

Focused unit/integration tests are listed inline in §2.1, §2.2, §2.3, §4, §5.5, §6.1 (projection field-exact), §7 (authz matrix), plus: snapshot-carries-the-sealed-row (fence, cut final snapshot, open the snapshot's `podium.db`, assert the sealed non-terminal row — the load-bearing claim of §5); recovery-only boot serves the projection with zero store writes; exclusion both directions at the `activeByGroup` level.

### 10.4 Rollout

Single-cutover release; server, web, desktop, daemon ship as one version (the update system converges the fleet). No schema migration — the `operations` table holds any kind; no transfer state was ever in the DB. Old journals: §5.5 orphan-aborts pre-fence ones, `committed` still classifies daemon-only; no retroactive history is fabricated. Mixed-version window: web-older-than-server degrades on `isMissingProcedure` (existing tolerance); server-older-than-web hides the affordance the same way; the `server-move.v1` cap (§9) keeps new promote messages away from old daemons. In-flight update vs move interleaving is excluded by the shared `lifecycle` group.

## 11. Getting there

Ordered, each independently landable; removal rides with the cutover, not after:

1. Generic engine extensions (§2) with their tests; promote `LIFECYCLE_EXCLUSION_GROUP`; durable-actor encoding helper; kind-parameterized web operations client/presenter seams.
2. Journal `fence-pending` state + boot-classification change (§4, §5.5 resume/orphan rule) behind the existing surface; source-side crash points.
3. Wire: required promote `port`, proof `port`, `server-move.v1` cap advertisement + eligibility on the machines listing (§8, §9).
4. The `server-move` kind, `machines.moveServer`, `machines.recoverServerMove`, seal/handoff in the fence and cutover runners, target reconcile, recovery-only boot + projection — **and in the same series** delete `serverTransferStatus`, `publicStatus`, the bespoke web model, and cut the panel over. Grep-gate lands here.
5. Acceptance harness extension (§10.3), desktop scenario, history list, error-copy pass.

## 12. Decisions (formerly open questions)

1. **Eligibility** lives on the machines listing, server-computed (§9). No client-side version math.
2. **Recovery-only surface** is minimal: `operations.active`/`history` (projection), health, `machines.recoverServerMove`. No read-only general router in a fenced state.
3. **Naming**: `machines.moveServer`, renamed — the un-aliasable cutover is worth the one-time churn; the mixed-version window degrades gracefully both ways.
4. **Desktop ask surface**: no separate surface. The desktop webview renders the same web operations UI, including against a recovery-only source; supervisor retarget covers the source-dead case. The ask's `surface` field is left unset (any surface may render it).
5. **History backfill**: none — fabricating rows from overwrite-in-place journals is guesswork.
6. **Cancel semantics**: cancel is allowed strictly pre-fence and always runs kind cleanup asynchronously; from `fence` onward the only exits are forward (done), failure pre-commit with unfence, or the indefinite uncertain posture resolved by an authenticated operator command.
