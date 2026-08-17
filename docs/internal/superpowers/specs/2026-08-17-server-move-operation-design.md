# Server move as a durable operation

- **Date:** 2026-08-17, surveyed against `origin/main` @ `6120a5681`
- **Issue:** POD-2271 (Server move operations spec), parent epic POD-1747 (Server Transfer Across Machines); finalizes and supersedes the POD-2267 draft (which superseded POD-2257)
- **Status:** implementation-ready, coordinator corrections applied
- **Relation to prior art:** replaces the public surface of `2026-08-06-server-transfer-design.md` (its journal state contract and split-brain internals survive); builds on `2026-08-14-update-operations-design.md` §3.0, which reserved the `lifecycle` exclusion group for exactly this operation.

## 0. Summary

Server transfer becomes a **`server-move` operation** in the operations framework. From the first release, operations are the *only* public model for progress, status, recovery, history, and actions: clients read `operations.active({group:'lifecycle'})` and `operations.history({kind:'server-move'})`, and dispatch recovery through the generic `operations.settleAsk`/`operations.action` surface — and nothing else. The `machines.serverTransferStatus` query (`apps/server/src/router.ts:413`), the `publicStatus()` projection (`apps/server/src/modules/server-transfer/service.ts:211-264`), the bespoke web polling model, and both copies of the phase UI are **removed in the same cutover** — no compatibility projection, no transitional dual surface. `machines.moveServer` (renamed from `machines.transferServer`) is **start-only**: it returns `{started, operationId}` and never awaits the move.

What survives, verbatim and internal-only, is the split-brain safety core: the `.server-transfer` journal, the portable-write fence, promotion and serving proofs, commit-uncertain logic, target-owned stage metadata, and target history continuity. The journal remains authoritative for "may a writable server boot here"; the operation is authoritative for "what should a human see and do."

The framework as it exists cannot host this kind honestly. Three generic engine extensions are part of this design (§2): a **coordinator-handoff seal with a `handed-off` runner outcome and a guarded `reclaimHandoff` reversal** (the engine today has no way for a step to say "the successor owns completion" — `StepOutcome.state` is exactly `done|running|skipped|failed`, `kinds.ts:40-42`), a **kind-owned action handler dispatchable in narrate/query-only mode** (recovery must work on a fenced, read-only store), and **async kind cancel cleanup with a structured result** (`cancel()` is synchronous and hookless, `engine.ts:356-373`). Each is specified as a generic capability with its own tests, not a server-move special case. Notably, **no indefinite-wait extension exists**: post-fence "waiting" is a deterministic read-time projection (§6.1), never persisted engine waiting, so there is no timer that could ever expire.

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

These land in `apps/server/src/modules/operations/` first, kind-agnostic, each with focused tests. The update kind is untouched by all of them (its restart survival is same-process-successor adoption, not cross-machine handoff).

### 2.1 Coordinator handoff: seal, single-owner choreography, `handed-off`

Two pieces, because the handoff write must be durable *before* the irreversible act (for server-move: before the fence makes `podium.db` read-only).

**`engine.sealForHandoff(operationId, stepId, patch)`** — a new engine method a runner calls from inside `ensure()`:

- Performs one final durable `store.update` applying `patch`. The patch describes **the world as of the seal, not the future**: the sealing step stays `running` and any successor steps stay `pending`. Generic example (corrected): a `relocate` kind sealing inside its `detach` step writes `detach: running (detail:'detaching')`, `attach: pending`, `details.handoff = {…}` — it does **not** pre-claim `detach: done`, because after the seal this engine can never amend the row if the detach fails.
- Atomically marks the operation **sealed** in this engine instance: an in-memory set plus a persisted `details._handoff` engine fact in the same write.
- After the seal, in this process, for this operation: `recordProgress` is **dropped** (not thrown), `reensure`/`admitDeferred`/`settleAsk` refuse, all deadline and waiting timers are disarmed and can never re-arm, `driveLocked` becomes a no-op, and `settle`/`finish`/`persist` refuse. The sealed source never writes this row again — with exactly one guarded exception, `reclaimHandoff` (§2.2).

**Single-owner choreography.** Once `sealForHandoff` returns, **the same runner that sealed owns everything that follows** — for server-move: the physical fence, the final snapshot, and the entire cutover choreography (promote → proofs → demote → journal commit → acknowledge → retire), all inside that one `ensure()` invocation — and then returns `{state:'handed-off'}`. **The engine never advances the drive to another runner after a seal.** There is no "next step runs on the sealed source": a sealed operation has exactly two futures in this process — the sealing runner returns `handed-off`, or it invokes `reclaimHandoff` and returns `failed`. Successor steps in the plan are advanced only by the read-time projection (§6.1) and, durably, by the adopting engine on the machine that inherits the row (§5.3).

**`StepOutcome.state: 'handed-off'`** — a fifth outcome state. On receiving it the engine asserts the seal exists (a `handed-off` outcome without a prior seal fails the operation with code `handoff-unsealed` — that ordering bug must be loud), asserts it came from the sealing runner's own drive, stops driving, drops the in-memory context, and keeps no timer. The operation remains non-terminal in the local row forever; **the adopting engine on the machine that inherits the row is the sole durable writer from the seal onward.**

**Exact tests** (`engine.test.ts` additions, engine driven against a store whose connection flips query-only after the seal to prove no write is even attempted):

1. Seal write is durable and applies the patch; a second `sealForHandoff` for the same operation refuses.
2. The seal patch leaves the sealing step `running` and successors `pending` (asserted on row bytes) — the engine refuses a seal patch that marks the sealing step `done`.
3. Post-seal `recordProgress` is dropped silently; the row bytes are unchanged.
4. Post-seal `driveLocked`/`enqueue` never invokes any runner; no step advances; the drive never reaches a successor runner even when the sealing runner's outcome would normally advance it.
5. Post-seal: no timer is armed; a previously armed deadline is disarmed; `clock.setTimeout` receives zero new calls.
6. Post-seal `settleAsk`, `reensure`, `admitDeferred`, `cancel` refuse; `settle` is never reached (operation never goes `waiting`/`done` locally).
7. `'handed-off'` outcome without a seal → operation `failed`, code `handoff-unsealed`.
8. Store-level: after the connection is query-only, none of the above paths throws — the seal check short-circuits before SQLite.
9. Adoption on a *different* engine instance (fresh store handle over the traveled bytes) parses the sealed row, and `reconcile` may rewrite it — the seal is per-process, not in the schema's way.

### 2.2 `reclaimHandoff`: the narrowly guarded reversal

A seal is written *before* the irreversible act, so there is a window where the seal exists but nothing irreversible has happened yet. Failures in that window must not wedge the lifecycle group forever behind an un-finishable sealed row.

**`engine.reclaimHandoff(operationId)`** — callable only by the sealing runner, in the same process that sealed, and only while the operation is still in that runner's `ensure()`. It re-opens exactly one write path: after the kind's reclaim cleanup succeeds, the runner may return `{state:'failed'}` and the engine persists the terminal failure normally (the seal's write-refusals are lifted for that single terminal persist, and `details._handoff` is cleared in the same write).

**The guard, stated as an invariant the kind must prove:** reclaim is legal only when the coordinator can prove **no promote (or equivalent successor-activating message) was ever sent and the successor-authoritative journal fact (`committing`) was never written**. For server-move (§4): the fence runner may reclaim on any failure after the seal but strictly before the journal writes `committing` and strictly before the promote RPC is issued — i.e. through fencing, final snapshot, and restage. From the first byte of a promote send onward, reclaim is forbidden; the only exits are forward or the uncertain posture (§6).

Server-move reclaim cleanup, in order, each step idempotent: abort the target stage (`abortPrepared`), release the physical fence (mirror resume, `portableStateFence.release()`, store back to writable), journal → `aborted`, clear the seal, persist the operation `failed` with the causing code. The machine ends writable, unfenced, with a terminal history row — never a stranded sealed row.

**Exact tests:**

1. Reclaim before any promote: target aborted, fence released, journal `aborted`, `details._handoff` cleared, operation `failed` durable; a subsequent `machines.moveServer` succeeds (lifecycle group is free).
2. Reclaim refuses once the runner has recorded promote-sent (an internal pre-send durable marker, §4 step 7) or the journal reads `committing` — attempting it fails loudly and the operation takes the §6 posture instead.
3. Crash **during** reclaim (crash points between each cleanup sub-step): reboot classifies pre-fence or fenced by the journal exactly as §4's crash matrix; re-running reclaim's cleanup at boot (orphan abort path, §5.5) is idempotent and converges to the same terminal state. No sequence of crashes leaves the lifecycle group wedged.
4. Double reclaim is idempotent-by-refusal; reclaim after `handed-off` was returned refuses.
5. Engine-level: reclaim from a non-sealing runner, another process's adoption, or outside `ensure()` refuses.

### 2.3 Kind-owned recovery action, dispatchable in narrate mode

Recovery must not be a bespoke public RPC. `OperationKindDefinition` gains:

```ts
onAction?(input: {
  operation: Operation,        // possibly projection-shaped (§6.1)
  actionId: string,            // ask id or action id being settled
  principal: Principal,        // the CALLER's live authenticated principal
  mode: 'engine' | 'narrate',  // narrate = recovery-only boot, store query-only
}): Promise<ActionResult>
```

- Dispatch is the **generic operations API only**: `operations.settleAsk` (when the action settles a required ask) or `operations.action` (imperative kind action). Both are existing/extended generic mutations with contract rows, roleFloor admin, `machineVerb:'manage'`. **There is no `machines.recoverServerMove`** or any other kind-named public RPC.
- In `mode:'narrate'` (recovery-only boot, §5.4) the engine performs **no store write**: it routes the call to `onAsk`/`onAction`, which may mutate **only journal and config facts** — file-level writes that are legal under a fenced SQLite. The next projection read (§6.1) reflects the new facts; that *is* the state change. `settleAsk` in narrate mode never touches the operations table.
- In `mode:'engine'` (a live writable engine that reached the same posture without a crash, e.g. lost promote reply), the same handler runs, and the engine settles the ask normally on the next drive after the handler resolves the journal.
- Authorization is the **caller's** live principal only (checked by the generic contract row plus the handler's own `principal` checks); the operation's stored actor is irrelevant to recovery authority (§7.2).

Tests: dispatch reaches the kind handler in both modes; narrate mode performs zero operations-table writes (query-only store proves it); unknown actionId refuses; non-admin caller refused at the contract layer before the handler; handler result is returned to the caller verbatim; idempotent double-dispatch.

### 2.4 Async cancel cleanup with a structured result

`OperationKindDefinition` gains `onCancel?(input: {operation, step, context}): Promise<CancelCleanupResult>` and `engine.cancel` becomes async:

```ts
type CancelCleanupResult = {
  stepPatches?: Record<string, StepProgressPatch>;  // per-step final detail/state hints
  detailsPatch?: Record<string, unknown>;           // merged into operation.details
  cleanup: 'complete' | 'pending';                  // did external cleanup fully land
  pending?: { what: string; retryable: true }[];    // durable record of what remains
};
```

1. Reversibility gate unchanged (`runners[inFlight.id]?.reversible !== true` → refuse `irreversible`).
2. If the kind has `onCancel`: persist the in-flight step as `detail:'canceling'`, run the hook under a deadline budget (default 60 s, kind-overridable via `deadlines['#cancel']`), then `finish(canceled)` applying `stepPatches` and `detailsPatch`.
3. **Cleanup failure or budget breach still finishes `canceled`** — cancel must never wedge an operation in a live state — but releasing the lifecycle group with unfinished external cleanup is legal **only** because the finish write durably records `details.cleanup = {status:'pending', pending:[…], error}`. A generic idempotent **cleanup janitor** re-drives pending cleanup: at engine start and on a periodic tick it scans terminal operations with `cleanup.status:'pending'` and re-invokes the kind's `onCancel` (which must be idempotent) until it reports `complete`, then patches the historical row's cleanup status. The kind may also opportunistically retry at the next `start()` preflight (server-move does: a stale target stage is aborted before a new prepare).
4. Without `onCancel`, behavior is today's, just behind an awaited promise.

`operations.cancel` over tRPC becomes an async mutation returning the same `CancelResult` (wire-compatible shape; latency is the only visible change — acceptable inside this cutover).

Tests: hook runs exactly once per cancel; concurrent cancels coalesce to one hook run and one result; hook success applies stepPatches/detailsPatch on the terminal row; hook failure → `canceled` + durable `cleanup.status:'pending'` with the pending list; janitor re-invokes idempotent `onCancel` until `complete` and patches the row; janitor survives restart (pending record is in the row); refusal paths never invoke the hook; a new `start()` on the group succeeds while cleanup is pending only if the kind's preflight says so (server-move preflight aborts the stale stage first).

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
| `fence` | Pausing this server | **no** | seal + two-phase fence + final snapshot + **entire cutover choreography** (§4) |
| `cutover` | Switching servers | **no** | **row-only step**: never driven by a runner on the source; advanced by projection (§6.1) and target reconcile (§5.3) |

The `cutover` step exists in the plan so progress and history read correctly, but **no source-side cutover runner exists** (§2.1 single-owner rule): the fence runner performs promote → proofs → demote → commit → acknowledge itself and returns `handed-off`. The sealed row durably shows `fence: running`, `cutover: pending`; only the projection and the target's adoption ever advance them.

Idempotency inherits the engine invariants unchanged: `idempotencyKey = transferId`; target `prepare` is digest-keyed with `receivedBytes` resume; `chunk` contiguous-offset; `promote` full-object idempotent replay; `acknowledge` idempotent on `meta.acknowledged`. Restage-on-digest-drift stays inside the `fence` runner as a progress patch pre-seal, and as journal/details facts post-seal (`detail:'state changed during fencing; restaging'` surfaces via the projection), minting the new `transferId` as today and keeping the discarded stage in `record.probe`.

`details` (kind-owned, passthrough): `{ transferId, sourceMachineId, targetMachineId, publicUrl, port, bytesCopied, totalBytes, manifestDigest, authorizedBy, intent, handoff? }`. Journal-state vocabulary never appears in the operation.

Deadlines (`StepDeadlines` per step): preflight 60 s/5 m, stage 3 m/30 m, validate 60 s/5 m — all fail (with target-stage abort where one exists). The `fence` step's engine deadlines are irrelevant past the seal (all timers are disarmed, §2.1); pre-seal it carries 2 m/10 m for the entry checks. Post-seal there is **no engine timer at all** — progress and stall are the journal's facts read through the projection, and the runner's own internal RPC timeouts (idempotent retries) bound each cutover sub-step. Nothing can "expire" a sealed operation into a fabricated terminal state.

Cancel: `preflight`/`stage`/`validate` runners declare `reversible: true`; the kind's `onCancel` (§2.4) aborts the target stage (`abortPrepared`), aborts the journal, releases the lock, and returns the structured result (cleanup `pending` if the target is unreachable — the janitor and next-start preflight retry the abort). `fence`/`cutover` omit `reversible` → engine refuses `irreversible`. Retry of a **failed/canceled** move is a new `start('server-move', …, {retryOf})`; the `aborted` journal is re-beginnable as today. Retry of an **uncertain** move is recovery (§6), never a new operation.

## 4. The fence runner: seal, two-phase marker, full cutover choreography

Today the journal claims `source-fenced` before the fence exists (§1.6). Replaced by two states with exact crash coverage. `TransferJournalState` gains `fence-pending`; `LEGAL_TRANSITIONS` gains `validated → fence-pending`, `fence-pending → source-fenced`, `fence-pending → aborted`; `validated → source-fenced` is removed.

The entire sequence lives inside the **one** `fence` runner (§2.1 single-owner rule — the engine never advances past it on the source):

1. `engine.sealForHandoff` (§2.1). The seal patch deliberately claims nothing that has not happened: it records `fence: running` (`detail:'pausing'`), `cutover: pending`, and `details.handoff = {role:'source', transferId, targetMachineId, publicUrl, port, sealedAt}`. The traveled row therefore never claims a fence that had not happened; target reconcile (§5.3) completes both `fence` and `cutover` from proof.
2. Journal `fence-pending` (fsync + dir-fsync, the §journal atomic protocol).
3. Physical fence: `pauseAndDrain` → `portableStateFence.acquire()` → mirror pause → `store.beginTransferFence()` (`relay.ts` fence composition).
4. Journal `source-fenced` — written only now, after the fence is fact.
5. Final snapshot (carries the sealed operation row and the `source-fenced` journal-external state), restage-on-drift if the digest moved.
6. Reauthorization at the `commit` boundary (§7.2). Denied here → `reclaimHandoff` (§2.2): target stage aborted, fence released, journal `aborted`, seal cleared, operation `failed` with `reauthorization-denied`. Any other failure in steps 2–6 takes the same reclaim exit.
7. Durable **promote-sent marker**: journal `committing` (fsync) is written **before** the promote RPC leaves this machine. From this write onward reclaim is forbidden (§2.2 guard) — the world may contain a promoted target.
8. Cutover choreography, still this runner, all file-level writes legal under a fenced SQLite: promote → `healthProofMatches` (now including port, §8) → **`demoteSource` (config write, fsync) → `journal.commit` (fsync + dir-fsync)** → *only then* `acknowledge` to the target → `afterCommitted` → `retireSourceAfterTransfer`. Demotion and the committed journal are durable **before** the target is told to finalize and before any retirement step. If demotion or the journal-commit write fails after a successful promote, the runner records journal `commit-uncertain` (`committing → commit-uncertain` is legal) and the §6 posture applies — recoverable, never a silently un-demoted source. Acknowledge failure after a durable commit is non-fatal (`result:'pending'` cleanup, as today).
9. Return `{state:'handed-off'}`. The engine stops (§2.1); retirement/supervision retarget proceeds outside the engine.

The engine writes nothing after the seal in step 1 (except the single guarded reclaim terminal write); every later durable fact lives in the journal, in config files, or on the target.

Crash matrix (boot behavior, §5.4 seam):

- **Before the journal intent** (`preparing|staged|validated`, seal may or may not have been written): pre-fence world. With a matching active operation (§5.5) adoption resumes the step; a stale seal from a crashed drive is cleared by adoption before re-driving (only adoption may clear `details._handoff`), and the resumed fence runner re-seals.
- **Between `fence-pending` and the physical fence** (or between fence and `source-fenced`): no `committing` was written, so no promote was ever issued and nothing post-fence left this machine. `fence-pending` is classified **pre-fence for boot recovery**: `blocksWritableServer('fence-pending') = false`; `reconcileSafeServerTransferBoot` treats it like `validated` — resumable with a matching operation, otherwise aborted (the orphan-abort cleanup includes releasing any half-acquired fence, idempotent per §2.2 test 3). The machine is never stranded in recovery-only by a marker written ahead of fact.
- **After `source-fenced`, before `committing`**: recovery-only boot (§5.4). The fence was real, but provably no promote was sent (no `committing`). The projection shows `fence: done`, `cutover: pending` with a recovery ask whose resolution may safely abort (§6.2 — the handler can prove no-promote from the journal and unfence/reclaim at the file level).
- **After `committing`**: recovery-only boot; the target may be promoted. Only proof from the target (or the operator recovery action) moves the world forward. `source-fenced|committing|commit-uncertain` continue to block writable boot.

The public claim discipline: the sealed row can never be rewritten on the source, so **the fence step is presented `done` on the source only through the recovery projection (§6.1), which overlays the journal's durable `source-fenced` fact**, and it is durably recorded `done` only by target reconcile. The row never lies; the projection narrates the journal's facts; the target's adoption writes them.

## 5. Coordinator handoff across machines

The operation row lives in `podium.db`, which is `ROOT_FILES[0]` of the portable payload (`snapshot.ts:13`). The final snapshot is cut after the fence; whatever the sealed row says is what the target inherits: `fence: running`, `cutover: pending` — the truthful pre-cutover shape.

### 5.1 Source epilogue ordering

Pinned by tests (it is §4 steps 7–8): journal `committing` before promote-send; promote → proof → demote (durable) → journal `commit` (durable) → acknowledge → retire. No ack before the committed journal exists on disk.

### 5.2 What the source never does again

After the §4 seal: no persist, no step advance, no timer, no settle (all engine-refused, §2.1 tests; sole exception the guarded reclaim terminal write), and after the fence no SQLite write is possible anyway (query-only). The journal file remains the source's only durable voice, and only for split-brain safety.

### 5.3 Target boot adoption — the sole durable writer

At target boot, promotion has rewritten `config.json` to `mode:'server'` and `podium.db` is the traveled DB. `adoptOnBoot` (`engine.ts:394-420`, awaited before the gateway binds — `server.ts:633`) finds the non-terminal sealed `server-move` row. `reconcile(operation, reality)` with `ServerMoveReality = { promoted: PromotedTargetMetadata | null, journal, machineId, now }` (`readPromotedTargetMetadata`, `target-status.ts:75-101`):

- `promoted` present ∧ `promoted.transferId === details.transferId` ∧ manifest digest ∧ `publicUrl` ∧ port match → steps `fence` and `cutover` → `done`, operation → `done`, `details.handoff.role = 'completed-on-target'`, `finishedAt` stamped. History on the new server shows the completed move — desktop-retarget continuity and history continuity are one mechanism.
- Identity mismatch or no promoted metadata → operation `failed`, code `handoff-orphaned`. A promoted DB with a foreign sealed row is a should-never; fail loudly, never guess.
- No capability check happens here (§7.3): reconciling a cryptographically proven, already-authorized move is fact-recording, not a privileged act.

### 5.4 Recovery-only boot on the source

`serverTransferBootMode(stateDir)` (`journal.ts:292-298`) becomes load-bearing in `server.ts` (today `assertWritableServerBoot` at `server.ts:366` just refuses):

- `'writable'` → normal boot; adoption before bind.
- `'recovery-only'` (`source-fenced | committing | commit-uncertain`) → the server boots with the store **query-only**, no session serving, and a gateway serving exactly: `operations.active`, `operations.history`, `operations.settleAsk`/`operations.action` (narrate dispatch, §2.3), and health. The engine runs in **narrate-only** mode: `createOperations({mode:'narrate'})` — `adoptOnBoot` is not called, no runner is ever driven, no timer armed, and every operations-table write path refuses; `operations.active` is served through the §6.1 projection instead of raw row bytes. Driving a cutover from a half-fenced boot is exactly the split-brain the journal exists to prevent.
- `'daemon-only'` (`committed`) → refuse writable boot as today; supervision retargets. No operations surface on the retired source.

### 5.5 Restart resume vs orphan abort

`reconcileSafeServerTransferBoot` today unconditionally aborts pre-fence journals. New rule, evaluated at adoption (writable boot):

- A pre-fence journal (`preparing|staged|validated|fence-pending`) **with a matching active `server-move` row** resumes: adoption re-drives the in-flight step; runners are idempotent (`prepare` replay, `chunk` offset resume, re-validate). **Exact identity match** required, all four: `journal.record.transferId === details.transferId` ∧ `targetMachineId` ∧ `publicUrl` ∧ (`journal.record.manifestDigest === details.manifestDigest` — with the restage rule that after drift both were rewritten together pre-fence, so they cannot legitimately diverge).
- A pre-fence journal with **no** active operation row, a terminal row, or any field mismatch is an **orphan** (includes every legacy journal written before this release): aborted with `{code:'boot-recovery'}` and cleanup `pending`, exactly today's mechanics plus idempotent fence-release if `fence-pending` got partway (§4 crash matrix); if an active-but-mismatched row exists it is failed with `boot-recovery` too. History then shows "the move was interrupted by a restart" instead of nothing.

Tests: resume-after-restart mid-`stage` continues from `receivedBytes` (acceptance §10.3); each mismatched field aborts; legacy journal aborts; abort is idempotent across double boot.

## 6. Post-fence status and recovery: projection + generic action

### 6.1 The projection — deterministic read, never persisted waiting

Post-fence status is a **pure read-time projection** — `projectRecoveryOperation(row, journalEntry, now)` in the server-transfer module, deterministic, unit-tested field-exact. There is deliberately **no persisted engine waiting state and no timer**: nothing is armed, so nothing can expire, and no grace policy (bounded or otherwise) applies. The projection is a function of (row bytes, journal file), both durable, so it applies **identically and immediately** on a live fenced source (same process that sealed, engine sealed-silent) and after a recovery-only reboot — restart durability is free.

- Base = the persisted sealed operation row, verbatim (`fence: running`, `cutover: pending`).
- `journal.state === 'source-fenced'` → overlay: `fence` step `done` (the journal is the fact the row could not record), `cutover` `pending`, `detail:'ready to switch'`, plus — when the sealing process is gone (recovery boot) — the recovery ask, since no runner will ever finish the cutover.
- `'committing'` → `fence` `done`, `cutover` `running`, `detail:'switching servers'`; on recovery boot, the recovery ask.
- `'commit-uncertain'` → operation presented `state:'waiting'`, `cutover` `stalled`, and one synthesized required ask `{id:'server-move-recovery', required:true, title:"The switch's outcome is unknown", detail:…}` with a **deterministic id** — never persisted, identical after every restart.

`operations.active` in recovery-only mode (and on a live fenced source for the sealed row) serves this projection; elsewhere raw row bytes as today. The projection is still the generic `Operation` shape — clients cannot tell, and there is still no other public API. **`operations.history` is never projected**: it serves raw terminal rows only. A sealed non-terminal row is not history and is never presented as an active operation fabricated from history — the active projection and the raw history are disjoint surfaces.

### 6.2 The recovery action — generic dispatch, kind handler

The `server-move-recovery` ask is settled through the **generic** `operations.settleAsk` (or, where no ask is synthesized — e.g. an operator probing a `source-fenced` recovery boot — `operations.action` with `actionId:'server-move-recovery'`), dispatching to the kind's `onAction` handler (§2.3). No bespoke public RPC exists.

The handler runs under the **calling operator's live principal** (§7.2) and mutates **only journal and config facts** — never the operations table (in narrate mode it cannot; in engine mode it does not need to, the next drive settles):

- Journal `source-fenced` (provably no promote, §4): operator may resolve **abort** — target stage aborted, fence released at file level, journal `aborted`; the machine reboots writable and the orphan/terminal accounting lands at that boot. Or resolve **proceed** is refused (a dead drive cannot be resumed post-fence; the safe forward path is target-side).
- `committing | commit-uncertain`: run `inspectUncertain` (`service.ts:673-722`): target promoted with byte-exact serving proof (incl. port) → `demoteSource` → `journal.resolveCommitted` → acknowledge → outcome `resolved-committed`; target answers aborted/no stage → the journal deliberately refuses `commit-uncertain → aborted` on proof-absence alone; outcome `still-uncertain` with operator guidance. Idempotent, re-runnable after restarts.

On a *writable* engine reaching the uncertain posture without a crash (e.g. lost promote reply, §4 step 8 stalls): the fence runner parks — the projection shows the same waiting shape and ask — and the same handler resolves the journal; the runner's next internal retry (or the engine drive in `mode:'engine'` settle) observes the resolved journal and completes to `handed-off`. The web renders one button — "Check the new server" — that calls `operations.settleAsk`. `checkTarget` and re-mutate recovery are deleted.

If the target did promote and the source dies unresolved: desktop/daemon retarget carries the user to the target, whose adoption already recorded `done` (§5.3). The sealed row on the abandoned source is moot.

## 7. Durable actor and reauthorization

### 7.1 Persisted intent

`engine.start('server-move', context, {createdBy})` records the durable actor (`user:<id>` / `session:<id>` / `system:<slug>`, the issues encoding precedent). `details` carry `{authorizedBy, intent: {targetMachineId, publicUrl, port, confirmation:'satisfied'}}`. The literal confirmation phrase is consumed at start, never persisted. **No request closure exists anywhere**: the current `{ reauthorize }` closure over `ctx` (`fleet/handlers.ts:190-205`) is replaced by identity-based checks.

### 7.2 Reauthorization at every privileged phase

`ServerTransferAuthorization.reauthorize(phase)` is kept as the seam, reimplemented as: at each phase boundary (`prepare|stage|validate|fence|commit`), re-evaluate **current policy for the persisted identity** — `fleetAuthzFailure` against a principal reconstructed from `details.authorizedBy` (a new authz entry point by identity, not by live ctx), plus byte-match of the journal/stage identity against `details.intent`. This works identically for the original drive, a post-restart resumed drive, and `resumeStalled` — there is no live-request special case.

- Actor deleted, demoted below the policy floor, or capability revoked → pre-fence phases fail `reauthorization-denied` (move aborts cleanly, target stage aborted).
- **Denied at the `commit` boundary — after the fence but before `committing` is written and before any promote** (§4 step 6): the runner **safely aborts** via `reclaimHandoff` (§2.2): target stage aborted, fence released, journal `aborted`, seal cleared, operation `failed` with `reauthorization-denied`. The machine ends writable; nothing was ever promoted (provable: no `committing`).
- **Once `committing` is durable or a promote may have been sent**, the stored actor's authorization no longer gates anything: what remains is fact reconciliation, not a privileged act on the old actor's behalf. A revoked-actor resumed drive in this region parks in the §6 posture; finishing requires a **currently authorized operator** invoking the generic recovery action (§6.2), authorized by their own live principal.
- Completing an *already-committed* cutover (target promoted, proof in hand) proceeds regardless of the stored actor — reconciliation of fact.

### 7.3 After adoption

Target reconciliation performs no capability check (§5.3): identity proof (transferId + digest + URL + port vs `PromotedTargetMetadata`, itself gated on a byte-exact `ServerTransferServingProof`) is the authorization — the move already happened under the recorded intent. Any *new* privileged action on the target requires a fresh principal; durable intent authorizes exactly one move, once.

Tests: phase-boundary matrix (each phase × {actor ok, actor revoked, actor missing, intent mismatch}); resumed-drive reauthorization uses stored identity with zero request context; commit-boundary revoked pre-promote → reclaim (writable, unfenced, `failed`, no promote ever observed by the target harness); post-`committing` revoked → parked, resolvable only via the recovery action under a live admin principal; recovery action refuses non-admin callers; adoption never consults authz.

## 8. The explicit port

The promoted target must serve on a port that was decided, carried, written, and proven — never inherited:

- `machines.moveServer` input keeps `port?`; the handler resolves the **effective port** at start (explicit `port`, else the `publicUrl`'s effective port for direct setups, else the instance default) and persists it in `details.intent.port`. The existing URL/port cross-check (`normalizedPublicUrl`, `service.ts:123-143`) is kept.
- `ServerTransferPromoteRequestMessage.port` becomes **required** (`packages/protocol/src/messages/server-transfer.ts:134-146`); the daemon's `persistTargetConfig` always writes `port` into `config.json` (no more falling through to a pre-existing value or `PODIUM_PORT` accident).
- `ServerTransferServingProof` gains `port: number` (protocol L80-95); the daemon builds the expected proof with it; `healthProofMatches` and the target-side `exactServingProof` compare it. A target serving on the wrong port can no longer pass proof.
- `PromotedTargetMetadata` carries the port; §5.3 reconcile matches it.

This is a daemon-wire schema change; §9's capability gating (`server-move.v1`) is what keeps an old daemon from ever receiving the new promote message.

## 9. Eligibility, capability, and the visible-disabled affordance

**Daemon capability reporting.** The handshake already carries `caps: string[]` and `build {appVersion, wireSchemaDigest, installKind}` (`packages/protocol/src/handshake/envelope.ts:173-209`), persisted via `setMachineBuild` (`apps/server/src/store/machines.ts:143-155`). New additive cap token **`server-move.v1`**, advertised by daemons built at or after this release. Eligibility for a target becomes: online ∧ `wireSchemaDigest === wireSchemaDigest()` (today's check, `relay.ts:771`) ∧ caps contain `server-move.v1`. The source side checks itself symmetrically at `preflight`: its own build must advertise the cap (a downgraded source refuses to start a move).

**Placement** (settles prior-draft open question 1): a per-machine `serverMoveEligibility: { eligible: boolean, reason?: 'current-server'|'offline'|'unsupported' }` field on the machines listing (`listMachines`, `machines/service.ts`), computed server-side over the caller-visible fleet exactly as `targetEligibility` is today (`service.ts:219-230`). No dedicated status RPC.

**UI — visible-disabled, always.** "Make server" **remains visible but disabled** with the same-version explanation on every non-eligible online target — including when the *server* is the old party: an older server that lacks `serverMoveEligibility` on its listing, or lacks `machines.moveServer` entirely (`isMissingProcedure`), still renders the disabled button with the same-version copy ("Update this machine to the same Podium version as the server first." — today's rendering, `MachinesPanel.tsx:1101,1158`, rebased onto `serverMoveEligibility` with a client-side `eligible:false, reason:'unsupported'` fallback when the field or procedure is absent). The affordance is **never silently hidden** by version skew in either direction; only current-server and offline rows render no affordance, as today. The explanation always names the remediation: the update system.

**Legacy exclusion — move side and update side.** `preflight` fails with `target-unsupported` (and the same-version sentence) if the target lacks the cap; additionally, a machine carrying a **legacy transfer journal** (any pre-operations `.server-transfer/journal.json` in a non-terminal state, source or target side) is excluded: source-side it is the §5.5 orphan abort before any new move; target-side `prepare` refuses with `target-rejected` and detail "finish or clear the previous transfer, then update this machine". Symmetrically, **update admission explicitly refuses** to start while a legacy non-terminal transfer journal or a held legacy `TransferLock` exists on the machine: legacy moves predate the operations model and are **outside the `lifecycle` exclusion group**, so the group alone cannot exclude them — the update kind's preflight adds an explicit journal/lock check failing with `legacy-transfer-in-progress` and the same finish-or-clear remediation. Tests: update start refused against a doctored non-terminal legacy journal and against a held legacy lock; admitted after the journal is terminal/cleared.

## 10. Public surface cutover, tests, rollout

### 10.1 Removal (same cutover)

Server: delete `machines.serverTransferStatus` (`router.ts:413`), `serverTransferStatusQuery`, `publicStatus` (`service.ts:211-264`); replace `machines.transferServer` with **`machines.moveServer`** (rename settles prior-draft question 3 — un-aliasable cutover): same input schema + `port?`, same policy row (`packages/commands/src/fleet/contracts.ts:814-846` carried over), handler = `engine.start(...)`, returns `{started:true, operationId} | {started:false, alreadyRunning}`. Recovery ships as the generic `operations.settleAsk`/`operations.action` dispatch (§2.3, §6.2) — **no new kind-named RPC of any sort**. Daemon wire protocol stays internal transport (with §8's port change).

Web: delete `apps/web/src/features/machines/server-transfer.ts`, `ServerTransfer.tsx`, and the inline copy in `MachinesPanel.tsx:49-137`; the panel reads `operations.active({group:'lifecycle'})` on the `use-update-state.ts` cadence with a `server-move` presenter beside the update presenter (`operation-view.ts` is kind-agnostic; its update-keyed `errorCopy` and the client's hardcoded `kind:'update'` in `readLatestOperation` (`operations-client.ts:81`) are generalized by kind parameter — a required enabler, since both kinds share the `lifecycle` group). Confirmation dialog survives as UI gating the start call. Settings → Machines gains the history list (`operations.history({kind:'server-move', limit:20})`). Desktop: no supervisor change — `bootstrap.rs` keeps reading the raw journal marker; retarget continuity improves for free via §5.3. CLI promote/retire workers untouched.

Grep-gate test: `serverTransferStatus` exists nowhere outside `packages/protocol` (daemon wire name); `recoverServerMove` exists nowhere. Delete/replace the bespoke web tests, the `publicStatus` cases, and the e2e status-route intercepts.

### 10.2 Error taxonomy

Kind codes = `TRANSFER_FAILURE_CODES` (`types.ts:208-226`) verbatim, plus `handoff-orphaned` (§5.3), `handoff-unsealed` (§2.1), `boot-recovery` (§5.5), `recovery-refused` (§6.2 still-uncertain), `legacy-transfer-in-progress` (§9). Framework codes apply as to any kind. Daemon wire codes stay transport-internal; runners translate at the seam. Every code gets one user sentence in the presenter.

### 10.3 Real two-machine acceptance

Extend `tests/acceptance/server-transfer/` (docker compose: `source`, `target`, `control-proxy`, `edge`, `scenario` — two real machine containers). Scenarios, each asserting through `machines.moveServer` + `operations.*` only:

1. **Happy path**: step progression `preflight→stage→validate→fence→cutover` observed via `operations.active({group:'lifecycle'})` (the fence/cutover advance being the §6.1 projection on the source); on the target, `operations.history({kind:'server-move'})` shows the same operation id `done` — cross-machine row continuity end to end. Assert the target serves on the explicit port from the proof.
2. **Concurrent writes during pre-copy**: a live agent session writes transcripts/DB rows continuously through `stage`; assert the final-fence digest drift triggers restage and the moved server contains the last pre-fence write.
3. **Concurrent writes during the final fence**: writers active while the fence engages; assert `pauseAndDrain`/fence refuses or drains them (no write lands after `source-fenced`), and the snapshot digest matches what shipped.
4. **Lost commit reply, full recovery**: control-proxy drops the promote reply; the source presents the uncertain waiting posture with the `server-move-recovery` ask via the projection; drive recovery **only** via `operations.settleAsk` (the old re-mutate path and any kind-named RPC must not exist); assert convergence to `done` on the target and demoted source.
5. **Post-promotion source persistence failure before ack**: crash-inject the source between successful promote and durable demote/commit (new source-side crash point mirroring the daemon's `ServerTransferCrashPoint` family); assert the source reboots into recovery-only with `commit-uncertain` and serves the projection immediately, target unacknowledged; `operations.settleAsk` completes demote → commit → ack; assert §5.1 ordering held (no ack observed before the committed journal exists on disk — evidenced via the coordination volume).
6. **Live shell after abort**: an interactive agent session with a running shell on the source; cancel the move during `stage`; assert cancel cleanup (§2.4) runs with `cleanup:'complete'` (and, in a variant with the target unreachable, `cleanup:'pending'` later converged by the janitor), the journal aborts, and the same shell session is still live and interactive afterward — the source was never fenced.
7. **Retry after abort**: after scenario 6, a fresh `machines.moveServer` to the same target succeeds; history shows both operations with `retryOf` linkage.
8. **Restart resume**: kill the source mid-`stage`; on reboot the matching operation resumes idempotently from `receivedBytes` (§5.5); a doctored mismatched journal instead aborts as an orphan.
9. **All-in-one desktop → remote**: desktop harness scenario — an all-in-one desktop (`LaunchAction::LocalAllInOne`, `bootstrap.rs`) moves its server to a remote machine; assert `classify_backend_exit` retargets on the committed marker, the webview reconnects to the target URL, the logged-in session survives (cookie/capability carry-over), and the retargeted webview's operations history shows the completed move. Runs as a Rust-side classification test plus a scripted acceptance run with evidence (`TRANSFER_EVIDENCE`) asserting webview URL and session identity before/after.
10. **Reclaim on post-seal failure**: crash-inject/fault-inject between seal and promote-send (fence acquisition failure, snapshot failure, commit-boundary reauth denial); assert `reclaimHandoff` leaves the source writable and unfenced with a terminal `failed` row, the target harness observed **no promote message at any point**, and a fresh move then succeeds.

Focused unit/integration tests are listed inline in §2.1, §2.2, §2.3, §2.4, §4, §5.5, §6.1 (projection field-exact, including identical output pre- and post-reboot for identical (row, journal) inputs), §7 (authz matrix), §9 (update admission vs legacy journal/lock), plus: snapshot-carries-the-sealed-row (fence, cut final snapshot, open the snapshot's `podium.db`, assert the sealed non-terminal row with `fence: running`/`cutover: pending` — the load-bearing claim of §5); recovery-only boot serves the projection with zero store writes; exclusion both directions at the `activeByGroup` level.

### 10.4 Rollout

Single-cutover release; server, web, desktop, daemon ship as one version (the update system converges the fleet). No schema migration — the `operations` table holds any kind; no transfer state was ever in the DB. Old journals: §5.5 orphan-aborts pre-fence ones, `committed` still classifies daemon-only; no retroactive history is fabricated; §9 keeps updates from starting over a live legacy journal/lock. Mixed-version window: web-older-than-server degrades on `isMissingProcedure` (existing tolerance); server-older-than-web renders the visible-disabled affordance with the same-version copy (§9) — never a silent hide; the `server-move.v1` cap (§9) keeps new promote messages away from old daemons. In-flight update vs move interleaving is excluded by the shared `lifecycle` group.

## 11. Getting there

Ordered, each independently landable; removal rides with the cutover, not after:

1. Generic engine extensions (§2: seal/handed-off, reclaimHandoff, kind action dispatch, async cancel + janitor) with their tests; promote `LIFECYCLE_EXCLUSION_GROUP`; durable-actor encoding helper; kind-parameterized web operations client/presenter seams.
2. Journal `fence-pending` state + `committing`-before-promote ordering + boot-classification change (§4, §5.5 resume/orphan rule) behind the existing surface; source-side crash points; update-admission legacy check (§9).
3. Wire: required promote `port`, proof `port`, `server-move.v1` cap advertisement + eligibility on the machines listing (§8, §9).
4. The `server-move` kind, `machines.moveServer`, the recovery `onAction` handler behind `operations.settleAsk`/`operations.action`, the single fence runner with seal/cutover choreography and reclaim, target reconcile, recovery-only boot + projection — **and in the same series** delete `serverTransferStatus`, `publicStatus`, the bespoke web model, and cut the panel over. Grep-gate lands here.
5. Acceptance harness extension (§10.3), desktop scenario, history list, error-copy pass.

## 12. Decisions (formerly open questions)

1. **Eligibility** lives on the machines listing, server-computed (§9). No client-side version math.
2. **Recovery-only surface** is minimal: `operations.active`/`history` (projection for the sealed row, raw for terminal history), `operations.settleAsk`/`operations.action` narrate dispatch, health. No read-only general router in a fenced state, and no kind-named RPC anywhere.
3. **Naming**: `machines.moveServer`, renamed — the un-aliasable cutover is worth the one-time churn; the mixed-version window degrades visibly (disabled + explanation), never silently.
4. **Desktop ask surface**: no separate surface. The desktop webview renders the same web operations UI, including against a recovery-only source; supervisor retarget covers the source-dead case. The ask's `surface` field is left unset (any surface may render it).
5. **History backfill**: none — fabricating rows from overwrite-in-place journals is guesswork.
6. **Cancel semantics**: cancel is allowed strictly pre-fence and always runs kind cleanup asynchronously with the §2.4 structured result; from `fence` onward the only exits are forward (`handed-off`), the guarded reclaim (`failed`, provably pre-promote), or the uncertain posture resolved by an authenticated operator through the generic recovery action.
