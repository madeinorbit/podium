# Server move as a durable operation

- **Date:** 2026-08-17, surveyed against `origin/main` @ `1d254f7db`
- **Issue:** POD-2257 (Server move operations spec), parent epic POD-1747 (Server Transfer Across Machines)
- **Status:** draft — awaiting coordinator review
- **Relation to prior art:** replaces the public surface of `2026-08-06-server-transfer-design.md` (its §3 state contract and §7 recovery internals survive unchanged); builds on `2026-08-14-update-operations-design.md` §3.0, which reserved the `lifecycle` exclusion group for exactly this operation.

## 0. Summary

Server transfer becomes a **`server-move` operation** in the operations framework. Operations are the *only* public model for progress, status, recovery, and history: clients read `operations.active({group:'lifecycle'})` and `operations.history({kind:'server-move'})`, and nothing else. The `machines.serverTransferStatus` query, its `publicStatus()` projection, the web polling model built on it, and every test that stubs it are **removed in the same change** — there is no compatibility projection and no transitional dual surface.

What survives, verbatim and internal-only, is the split-brain safety core: the `.server-transfer` journal, the portable-write fence, promotion and serving proofs, commit-uncertain logic, and the target-owned stage metadata. These are correctness mechanisms, not status surfaces. The operation *narrates* them; it never *replaces* them. The journal remains authoritative for "may a writable server boot here"; the operation is authoritative for "what should a human see and do."

The one genuinely new architectural idea is the **coordinator handoff** (§5): the operation row lives in `podium.db`, and `podium.db` is itself part of the portable payload. The source engine records, *before* the fence, a durable statement that the remainder of the move will be finished elsewhere; the fenced final snapshot carries that row to the target; the target's boot adoption reconciles it to `done` against its own promotion metadata. The operation therefore survives the death of its own coordinator — the exact property the framework was built for (update spec §3.4), extended across machines.

## 1. Diagnosis: why the current shape is wrong

The transfer implementation is correct at the safety layer and bespoke at every layer above it. Concretely, on `origin/main`:

1. **A parallel status universe.** `machines.serverTransferStatus` (`apps/server/src/router.ts:413`, `apps/server/src/modules/fleet/queries.ts:85`) projects a hand-rolled shape from `ServerTransferService.publicStatus` (`apps/server/src/modules/server-transfer/service.ts:211-263`) with no command contract, no authz entry, and no zod output schema — client typing is structural inference off the router type. The web client (`apps/web/src/features/machines/server-transfer.ts`) reimplements polling, backoff, generation guards, and stale-read discarding that `use-update-state.ts` already implements for operations.
2. **A parallel exclusion universe.** Transfer exclusivity is a pid-file lock (`apps/server/src/modules/server-transfer/lock.ts`); update exclusivity is the `lifecycle` exclusion group (`apps/server/src/modules/updates/operation.ts:82`). Consequence today: **an update and a transfer can run concurrently**, which is exactly the class of disaster the exclusion group exists to prevent.
3. **No history.** The journal is overwritten per transfer; `aborted` journals are re-beginnable and `clearReviewedOutcome` deletes them. A completed or failed move leaves no queryable record anywhere.
4. **Recovery is a client protocol.** Commit-uncertain recovery is "call `machines.transferServer.mutate` again with the same arguments" (`apps/web/src/features/machines/server-transfer.ts` `checkTarget`). The retry contract lives in a React hook instead of the engine.
5. **Duplicated UI.** `SERVER_TRANSFER_PHASES` + `ServerTransferProgress` exist twice with divergent copy (`apps/web/src/app/MachinesPanel.tsx:49-137` and `apps/web/src/features/machines/ServerTransfer.tsx:24-115`).
6. **Ephemeral actor.** `TransferRecord.operationId` is a local uuid (`service.ts:299`); nothing durable records who authorized the move or under what intent. Phase reauthorization (`ServerTransferAuthorization.reauthorize`) is bound to the live tRPC principal and cannot survive a coordinator restart, let alone adoption on another machine.

## 2. First principles

- **P1 — One progress model.** A durable lifecycle change is an operation. Its steps, progress, error, history, cancelability, and recovery affordances are expressed only in the `Operation` object (`packages/protocol/src/operation/operation.ts`). No kind gets a private status RPC.
- **P2 — Safety is not status.** The journal and fence decide what the *processes* may do (boot writable, accept writes, demote). The operation decides what the *human* sees. The journal never becomes public; the operation never becomes a boot gate.
- **P3 — The operation outlives every coordinator.** Source restart pre-fence: adoption resumes or fails cleanly. Source retirement post-commit: the row has already traveled in the snapshot and the target finishes it. There is no state in which the move happened but no operation records it.
- **P4 — Authorization is durable intent plus live checks.** The initiating principal's identity and the confirmed intent (target machine, public URL) are persisted on the operation. While the initiating server lives, every phase re-checks live authorization. After adoption, no live principal exists; the durable intent is verified against cryptographic identity (manifest digest, serving proof) instead, and any *new* privileged action requires fresh authorization.
- **P5 — Replacement, not projection.** The old surface is deleted in the same change that ships the new one. A half-migrated status surface is worse than either endpoint.

## 3. The `server-move` operation kind

### 3.1 Registration

New module `apps/server/src/modules/server-transfer/operation.ts` exporting `serverMoveOperationKind(): OperationKindDefinition<ServerMoveContext, ServerMoveReality>`, registered alongside `update` at the operations composition seam (`apps/server/src/relay.ts`, mirroring `updateOperationKind()` registration):

```ts
export const SERVER_MOVE_OPERATION_KIND = 'server-move'
// exclusionGroup: LIFECYCLE_EXCLUSION_GROUP ('lifecycle') — imported from updates/operation.ts:82,
// promoted to a shared module (e.g. modules/operations/lifecycle.ts) so neither kind imports the other.
```

Sharing `lifecycle` closes defect §1.2 by construction: at most one of {update, server-move} is non-terminal at a time, enforced by `store.activeByGroup` columns (`apps/server/src/modules/operations/store.ts:152-157`), which also means a deployed *older* binary still refuses to start an update while a newer binary's server-move row is active. The `TransferLock` pid file is retained (§8) as a cross-*process* guard — the exclusion group is cross-*request* within one server; the lock protects against a second server process on the same state dir.

### 3.2 The step plan (idempotent)

`plan(context)` returns five steps. Step ids are stable identifiers; titles are UI copy.

| id | title | reversible | maps to today | places |
|---|---|---|---|---|
| `preflight` | Checking the move | yes | confirmation/url validation, target eligibility, `sourceHealthy()`, capacity (`service.ts:266-340`) | `source`, `target` |
| `stage` | Copying server state | yes | initial snapshot + prepare RPC + chunk upload (`service.ts` stage; daemon `prepare`/`chunk`) | `target` (percent = `bytesCopied/totalBytes`) |
| `validate` | Verifying the copy | yes | validate RPC + proof match (`ServerTransferProof`) | `target` |
| `fence` | Pausing this server | **no** | journal `source-fenced` + `deps.fence()` + final snapshot + restage-on-drift (`service.ts:366-…`) | `source` |
| `cutover` | Switching servers | **no** | `committing` → promote → serving-proof check → demote → `journal.commit` → acknowledge → retire (`service.ts:404-495`) | `target`, `source` |

Idempotency inherits the existing engine invariants unchanged: `idempotencyKey === transferId`; target `prepare` is digest-keyed idempotent with `receivedBytes` resume; `chunk` is contiguous-offset; `promote` compares the whole promotion object and returns the stored serving proof; `acknowledge` is idempotent on `meta.acknowledged`. A step runner that re-runs (engine `resumeStalled`, adoption re-drive) therefore converges rather than duplicates. The post-fence restage-on-digest-drift path stays inside the `fence` runner and reports as a progress patch (`detail: 'state changed during fencing; restaging'`), not a step failure — it mints the new `transferId` exactly as today and records the discarded stage in `record.probe`.

Operation `details` (kind-owned, `.passthrough()`): `{ transferId, sourceMachineId, targetMachineId, publicUrl, port?, bytesCopied, totalBytes, manifestDigest, handoff?: HandoffMarker }` — everything `publicStatus()` used to expose that the UI still needs, minus the journal-state vocabulary. Journal states never appear in the operation; they are internal.

### 3.3 Progress and deadlines

Progress is pushed by the runners via `engine.recordProgress` (chunk loop reports `bytesCopied` on a ≥1 s / ≥1 MiB debounce), never polled. Deadlines use the framework's `StepDeadlines` (`transitions.ts:166-186` breach model), replacing the ad-hoc per-RPC constants as *step* budgets while the RPC timeouts in `apps/server/src/modules/machines/rpc.ts` stay as transport guards beneath them:

| step | silenceMs | totalMs | on total breach |
|---|---|---|---|
| `preflight` | 60 s | 5 m | fail |
| `stage` | 3 m | 30 m | fail (abort target stage) |
| `validate` | 60 s | 5 m | fail (abort target stage) |
| `fence` | 2 m | 10 m | fail → unfence + abort stage (still pre-commit) |
| `cutover` | 2 m | 10 m | **never auto-fail** — breach reports `stalled` with `describeStall` copy; resolution is §6 recovery only |

The `cutover` exception is deliberate: past `committing`, a deadline cannot know whether the target promoted. The framework's silence-retry (one `reensure`) is safe there because every RPC in the runner is idempotent; the *total* breach maps to the commit-uncertain posture (§6), not to `failed`.

### 3.4 Cancel and retry boundaries

- `operations.cancel` succeeds while the in-flight step is `preflight`/`stage`/`validate` (runners declare `reversible: true`): the runner aborts the target stage (`abortPrepared`), the journal goes `aborted`, cleanup outcome is recorded (`cleaned`/`pending` as today), operation state `canceled`.
- `fence` and `cutover` runners omit `reversible` → engine refuses with `{canceled:false, refused:'irreversible', step}` (`engine.ts:356`), rendered by the standard `cancelRefusalSentence`. This is strictly safer than today (today there is no cancel at all) while keeping the invariant that a fenced source never silently reopens.
- Retry of a **failed** move = a new `start('server-move', …)` with `retryOf: <previous operation id>` (`OperationPlan.retryOf`). The `aborted` journal is re-beginnable exactly as today. Retry never reuses an operation row.
- Retry of an **uncertain** move is not a new operation — it is recovery of the existing one (§6).

## 4. Durable actor and authorization intent

### 4.1 What is persisted

`engine.start('server-move', context, { createdBy })` records the durable actor using the issues/automations encoding precedent (`apps/server/src/modules/issues/service/projection.ts:128-139`): `user:<id>` / `session:<id>` / `system:<slug>`, not the current hardcoded `'user'`. The operation `details` additionally carry the **authorization intent**: `{ authorizedBy: <actor>, intent: { targetMachineId, publicUrl, port?, confirmation: 'satisfied' } }`. The literal confirmation phrase is consumed at start and never persisted.

### 4.2 Phase reauthorization while the source lives

The five-gate `ServerTransferAuthorization { reauthorize(phase) }` seam (`apps/server/src/modules/server-transfer/types.ts:78-80`, called at every phase boundary in `service.ts`) is **kept** and bound per-drive: when a step runner begins on the initiating server with the starting request still live, it reauthorizes against that principal exactly as `machineTransferServerHandler` does today (`apps/server/src/modules/fleet/handlers.ts:198-212`). When the engine re-drives after a coordinator restart (adoption, `resumeStalled`), no live principal exists. This is precisely the durable-replay shape the composition layer already legislates for reactions (`apps/server/src/composition/reactions.ts:646-647` — "durable replay must reauthorize at apply time"), and the operation follows the same rule:

- **Replay reauthorization** = re-evaluating the persisted intent against current policy: the recorded actor must still hold `machines.transferServer`-level capability over the recorded target (`fleetAuthzFailure` with a reconstructed principal reference), and the journal/stage identity must byte-match the intent (`transferId`, `targetMachineId`, `publicUrl`, `manifestDigest`). Mismatch → fail with `reauthorization-denied` pre-fence; post-fence it forces the uncertain posture rather than proceeding.
- If the recorded actor no longer exists or no longer holds the capability, resumption pre-fence fails `reauthorization-denied`; post-fence, safety work (finishing an already-committed cutover, §6) proceeds regardless — completing a committed move is reconciliation of fact, not a new privileged action.

### 4.3 After adoption on the target

The target has no session for the initiating actor. Post-adoption reconciliation (§5.3) performs **no capability check at all** — it only verifies cryptographic identity: the traveled operation's `details.transferId`/`manifestDigest` must match the target-owned `PromotedTargetMetadata` (which itself required a byte-exact `ServerTransferServingProof`). Identity match ⇒ the move already happened under the recorded authorization; the target records the outcome. Any *new* privileged action on the target (starting another move, retiring machines) requires a fresh live principal — durable intent authorizes exactly one move, once.

## 5. Coordinator handoff after the source fence

This is the heart of the design. The operation row lives in the `operations` table of `podium.db`; `podium.db` is `ROOT_FILES[0]` of the portable payload (`apps/server/src/modules/server-transfer/snapshot.ts:13-14`). The final snapshot is taken **after** the fence. Therefore: whatever the operation row says at fence time is what the target inherits.

### 5.1 The handoff write

The `fence` runner's last action *before* engaging the fence (journal `source-fenced` intent is written first, as today — that ordering is untouched) is one final operation persist:

- step `fence` → `done`; step `cutover` → `pending` with `detail` copy "finishing on the new server";
- `details.handoff = { role: 'source', fencedAt, transferId, targetMachineId, publicUrl }`.

Then the fence engages (`PRAGMA query_only = ON` among others — `apps/server/src/store.ts:408-420`), the final snapshot is cut, and **no further operations-table write is possible or attempted on the source**. From this point the source engine narrates nothing durable; the journal alone records `committing`/`committed`/`commit-uncertain`. This is the coordinator-handoff semantic: *the durable narration authority transfers with the fence.* The source engine must treat every post-fence `recordProgress` as best-effort in-memory only (the engine's store `update` will throw against a query-only connection; the `cutover` runner wraps persistence in a fence-aware writer that drops writes after handoff instead of failing the step).

### 5.2 Source epilogue

On successful commit, the source retires exactly as today (`retireSourceAfterTransfer`, `apps/server/src/modules/server-transfer/lifecycle.ts`): its local `podium.db` — including its stale copy of the operation row — is abandoned with the demoted role. No reconciliation of the source copy is needed or wanted; a demoted source never serves `operations.*` again.

On pre-commit failure after the handoff write but before `committing` (e.g. final restage fails), the runner unfences, aborts the stage, and — the DB being writable again — rewrites the operation to `failed` with the real error, clearing `handoff`. The handoff marker is thus only ever visible in a snapshot cut between fence and unfence, which is exactly the window where it is true.

### 5.3 Target boot reconciliation

At target boot, promotion has already rewritten `config.json` to `mode:'server'` and `podium.db` is the traveled source DB. `adoptOnBoot` (`apps/server/src/modules/operations/engine.ts:394-420`) finds the non-terminal `server-move` row. The kind's `reconcile(operation, reality)` receives `ServerMoveReality = { promoted: PromotedTargetMetadata | null, journal: TransferJournalEntry | null, machineId, now }` (promoted metadata via `readPromotedTargetMetadata`, `apps/server/src/modules/server-transfer/target-status.ts:75-101`):

- `promoted` present ∧ `promoted.transferId === details.transferId` ∧ digests match → step `cutover` → `done`, operation → `done`, `details.handoff.role = 'completed-on-target'`, `finishedAt` stamped. History on the new server now shows the completed move — **desktop retarget continuity and history continuity are the same mechanism**.
- Identity mismatch (a promoted stage for a *different* transferId, or none) → operation → `failed` with code `handoff-orphaned` (§9). This is a should-never state (promotion is what put this DB here); failing loudly beats guessing.
- On the **source** rebooting into an aborted/failed pre-fence world (crash before commit): the same `reconcile` sees `journal.state === 'aborted'` (boot reconciliation aborted it — §6.1) and fails the operation with the journal's recorded error; sees `preparing|staged|validated` → adoption resumes the in-flight step via the normal drive (runners are idempotent); sees `commit-uncertain` → §6.2.

`reconcile` must also tolerate adoption of a row whose *plan shape* predates the running binary (framework rule: `.passthrough()` + closed state enums) — unknown detail fields survive rewrite.

### 5.4 The recovery-only pre-bind seam

`serverTransferBootMode(stateDir)` (`journal.ts:292-298`) — today defined and unit-tested but unused — becomes load-bearing. Boot order in `apps/server/src/server.ts` (today `reconcileSafeServerTransferBoot` + `assertWritableServerBoot` run before the store opens, `server.ts:365-367`):

- `'writable'` → normal boot; `adoptOnBoot` runs, as today for updates, **before** the gateway binds (`server.ts:633-644`), so a resumed move is driving before any client can observe a gap.
- `'recovery-only'` (journal `source-fenced|committing|commit-uncertain`) → the server boots a **recovery-only mode**: read-only store, no session serving, gateway serves only `operations.active`/`operations.history` and the recovery actions of §6. Today this state refuses boot entirely (`assertWritableServerBoot` throws), which leaves the operator with a dead process and a journal file as the only UI. The pre-bind seam is: journal classification → store open mode (query-only) → operations adoption in *narrate-only* mode (no runners driven; the row is surfaced, not resumed) → bind. Recovery-only never engages step runners — driving a cutover from a half-fenced boot is exactly the split-brain the journal exists to prevent.
- `'daemon-only'` (journal `committed`) → as today, the writable server refuses; supervision (desktop or `--takeover` daemon spawn) retargets. No operations surface on the source.

## 6. Commit-uncertain, recovery, and the death of `checkTarget`

### 6.1 Pre-fence crash

Unchanged: `reconcileSafeServerTransferBoot` aborts `preparing|staged|validated` journals with `boot-recovery` and pending cleanup (`journal.ts:278-288`). New: adoption then fails the traveling operation with the same error (§5.3), so the user sees "the move was interrupted by a restart" in history instead of nothing.

### 6.2 Uncertain posture

`inspectUncertain` (`service.ts:673-723`) is preserved as the engine's recovery routine, but its trigger moves from "the client re-mutates" to the operation:

- The operation enters `waiting` with a **required ask** (`AwaitingAsk`, surface `'web'`): title "The switch's outcome is unknown", detail explaining that the new server may already be serving, with the single action **"Check the new server"**. Settling the ask (`engine.settleAsk`) runs `inspectUncertain`: target promoted with matching serving proof → demote source → `journal.resolveCommitted` → acknowledge → operation `done`; target answers `aborted`/no stage → unfence is *not* automatic (the journal refuses `commit-uncertain → aborted` by design, `journal.ts:21-33`) — the operation stays `waiting` with error `commit-uncertain` and operator guidance. The framework's `waitingGraceMs` is set to `null`-equivalent (a very long grace with `describeWaitingExpiry` that re-arms rather than fails): an uncertain move must never auto-fail into a lie.
- The web `checkTarget` path (`server-transfer.ts:154-…` re-calling `machines.transferServer.mutate`) is deleted; the ask button is the whole recovery UX, rendered by the existing `operationView` ask machinery.
- If the target *did* promote and the source dies before resolving: the desktop/daemon retarget takes the user to the target, whose adoption already completed the operation (§5.3). The uncertain row on the abandoned source is moot.

## 7. Public surface cutover (removal is part of this change)

### 7.1 Server

Removed in the same commit series that registers the kind:

- `machines.serverTransferStatus` procedure (`router.ts:413`), `serverTransferStatusQuery` (`fleet/queries.ts:85-86`), `ServerTransferService.publicStatus` (`service.ts:211-263`) and its `localPromotedTransfer` wiring for status (`relay.ts:765` — `readPromotedTargetMetadata` itself survives for §5.3 reality).
- `machines.transferServer` is **replaced** by `machines.moveServer`: same input schema (`targetMachineId`, `publicUrl`, `confirmation: 'TRANSFER SERVER'` literal retained, `port?`), same contract policy (roleFloor admin, hub-only, manage verb — `packages/commands/src/fleet/contracts.ts:819-852` carried over), but the handler is now `engine.start('server-move', context, {createdBy: durableActor(ctx)})` returning `{started:true, operationId} | {started:false, alreadyRunning}` — it no longer awaits the move. Eligibility data (`targetEligibility`) moves to the existing machines listing (a per-machine `serverMoveEligibility` field on the machines query the panel already reads), not a dedicated status RPC.
- Daemon wire protocol (`packages/protocol/src/messages/server-transfer.ts`) is untouched — it is internal transport, including `serverTransferStatusRequest` which `inspectUncertain` still needs.

### 7.2 Web

- Delete `apps/web/src/features/machines/server-transfer.ts` (the whole bespoke poll/controller model) and both copies of `SERVER_TRANSFER_PHASES`/`ServerTransferProgress`.
- `MachinesPanel` renders the move from the same operations context the update panel uses: `operations.active({group:'lifecycle'})` via the existing polled query (`use-update-state.ts` cadence: 1 s active / 30 s idle), `stepRows(operation)` + `operationView` for rendering. Kind-specific copy (phase titles of §3.2, uncertain-ask copy of §6.2) is a `server-move` presenter beside the update presenter — the view machinery (`operation-view.ts`) is already kind-agnostic.
- The confirmation dialog survives as UI (typed phrase gating the `machines.moveServer` call); its post-start body is the operation step list.
- Move history: Settings → Machines gains the same history list Settings → Updates has (`operations.history({kind:'server-move', limit:20})`, cf. `settings/sections/updates.tsx:149`).

### 7.3 Desktop

No behavioral change. The Rust supervisor keeps reading the raw journal marker (`bootstrap.rs:6,84-110,199-300`) — it is an internal consumer of the internal journal, and its `Retarget`/`Hold`/`Respawn` classification is boot-safety, not status. Continuity *after* retarget improves for free: the retargeted webview reads `operations.*` from the target, which shows the completed move (§5.3). The cookie-copy, capability-grant, and `transferred_server_url` mechanics (`main.rs:97-220`) are untouched.

### 7.4 CLI

`server-transfer-promote` / `server-transfer-retire-daemon` (`apps/cli/src/cli.ts:148-149,470-481,1230-1244`) are internal lifecycle workers invoked by daemons/supervisors, not status clients — untouched. No CLI operations surface is added in this change (none exists for `update` either).

## 8. What is preserved, verbatim

| mechanism | files | why it stays |
|---|---|---|
| `.server-transfer/journal.json` state machine, `LEGAL_TRANSITIONS`, atomic fsync write protocol | `journal.ts`, `types.ts` | split-brain boot safety; §P2 |
| Portable-write fences (server, SQLite `query_only`, daemon `pauseAndDrain`) | `portable-fence.ts`, `store.ts:391-420`, `apps/daemon/src/portable-state-fence.ts` | write-quiescence for a consistent snapshot |
| Promotion + serving proofs, byte-exact `healthProofMatches` | `service.ts:94-121,436-445`, protocol L80-95, daemon `promote()` | the only ground truth for demotion |
| Commit-uncertain journal state + `inspectUncertain` | `journal.ts`, `service.ts:673-723` | §6 |
| Target `StageMeta` / `PromotedTargetMetadata`, backups, promotion inventory | daemon `server-transfer.ts`, `target-status.ts` | target-owned lifecycle metadata; §5.3 reality |
| `TransferLock` pid file | `lock.ts` | cross-process guard beneath the exclusion group (§3.1) |
| Role transition policy, cutover/retirement | `packages/runtime/src/transfer-lifecycle.ts`, `role-reconcile.ts`, `lifecycle.ts` | process-level choreography |
| Snapshot/manifest identity binding | `snapshot.ts`, protocol manifest digest | proofs depend on it |

The `ServerTransferService` itself is refactored from one linear `transfer()` into the five step runners; its internals (stage, validate, fence-with-restage, commit, ack, cleanup) move bodily into runner bodies. `ServerTransferPhase` (the UI vocabulary) is deleted — steps replace it. `TransferJournalState` is unchanged.

## 9. Error taxonomy

Operation errors use the framework's open `OperationError.code`. The kind namespace is the current `TRANSFER_FAILURE_CODES` (`types.ts`), carried over verbatim so daemon/service internals map 1:1: `active-transfer, invalid-confirmation, invalid-url, target-not-found, target-is-source, target-offline, target-unsupported, source-unhealthy, disk-full, snapshot-failed, source-changed, reauthorization-denied, target-rejected, target-proof-missing, source-config-failed, commit-uncertain, internal` — plus new codes `handoff-orphaned` (§5.3) and `boot-recovery` (§6.1, promoted from journal-internal to operation error). Framework codes (`stalled`, `operation-adoption-failed`, …) apply as to any kind. Daemon wire codes (`ServerTransferErrorCode`, protocol L45-64) remain transport-internal; runners translate them to kind codes at the seam, as `classifyMachineFailure` does for updates. Every code gets one user sentence in the web presenter (`presentOperationError` extension), replacing `transferErrorMessage`.

## 10. Rollout and data migration

Single-cutover release; server, web, and desktop artifacts ship together as one version (the update system already converges the fleet atomically).

- **Schema:** none. The `operations` table (`20260816092917_operations-table`) already holds any kind. No transfer state was ever in the DB, so there is nothing to migrate.
- **Old journals:** boot reconciliation semantics are unchanged, so a machine upgrading with a stale pre-fence journal aborts it exactly as before; a `committed` journal still classifies `daemon-only`. Old journals produce no retroactive operation rows — history begins at this release. (Decision: fabricating history from overwrite-in-place journal files is guesswork; we don't.)
- **Mixed-version window:** a web bundle older than the server would call the removed `serverTransferStatus` → tRPC `NOT_FOUND`. The machines panel must degrade to "no move in progress" on missing procedure (the updates client already has this exact tolerance — `isMissingProcedure`, `operations-client.ts`). A server older than the web bundle lacks `machines.moveServer`; the panel hides the move affordance on missing procedure. Both windows close at converge.
- **In-flight move during upgrade:** excluded by construction — `server-move` and `update` share the `lifecycle` group, so an update cannot start mid-move and vice versa. This is new protection, not a new risk.
- **Desktop:** no marker format change (journal `formatVersion` stays 1), so old and new desktop builds interoperate with old and new servers.

## 11. Testing strategy

### 11.1 Removal enforcement

- Repo-wide assertion that `serverTransferStatus` no longer exists outside `packages/protocol` (the daemon-wire name) — a grep-gate test in the same spirit as `vps-bootstrap.test.ts:5-16`.
- Delete/replace: `apps/web/src/features/machines/server-transfer.test.tsx`, `ServerTransfer.test.tsx` (bespoke model), the `serverTransferStatus.query` stubs in `MachinesPanel.test.tsx`, `service.test.ts` `publicStatus` cases (398-470), and the e2e route intercept for `machines.serverTransferStatus` (`tests/e2e/browser/server-transfer.browser.e2e.ts:91`).

### 11.2 Focused (unit/integration)

- **Kind tests** (`operation.test.ts` beside the kind, patterned on the update kind's): plan shape; runner idempotency under re-drive; cancel accepted pre-fence and refused from `fence` on; deadline table incl. the cutover no-auto-fail rule; `reconcile` matrix of §5.3/§6 (promoted-match → done, mismatch → `handoff-orphaned`, aborted journal → failed, pre-fence journal → resume, uncertain → waiting+ask); replay reauthorization accept/deny.
- **Handoff persistence:** fence runner writes the §5.1 row before `deps.fence()`; post-fence `recordProgress` is dropped, not thrown; pre-commit failure after handoff rewrites to `failed` and clears `handoff`. Verified by driving the engine against a store whose connection flips query-only mid-test.
- **Snapshot carries the row:** integration test that fences, cuts the final snapshot, opens the snapshot's `podium.db`, and asserts the non-terminal `server-move` row with `handoff` is inside — this is the load-bearing claim of §5 and must be pinned.
- **Recovery-only boot:** `serverTransferBootMode` wiring — fenced journal ⇒ store opens query-only, adoption is narrate-only, `operations.active` serves the row, no runner executes.
- **Exclusion:** `start('update')` refused while a `server-move` is active and vice versa (columns-level, per `store.test.ts` conventions).
- Existing suites kept as-is: `journal.test.ts`, `snapshot.test.ts`, daemon `server-transfer.test.ts` (incl. crash points), `transfer-lifecycle` tests both sides, protocol wire tests, desktop `bootstrap.rs` inline tests.

### 11.3 Real two-machine acceptance

Extend `tests/acceptance/server-transfer/` (docker harness, `scenario.ts`):

1. Happy path driven entirely through `machines.moveServer` + polling `operations.active({group:'lifecycle'})`; assert step progression `preflight→stage→validate→fence→cutover`, then on the **target** `operations.history({kind:'server-move'})` shows the same operation `done` — cross-machine row continuity, end to end.
2. Uncertain-commit recovery: kill at the harness's existing crash point during commit; assert operation `waiting` with the required ask; settle the ask; assert convergence to `done` on the target. (Replaces the "repeat `machines.transferServer.mutate`" recovery scenario at `scenario.ts:351,402`.)
3. Idempotent re-drive: restart the source pre-fence mid-`stage`; adoption resumes; byte counters continue from `receivedBytes`.
4. Update exclusion smoke: with a move active, `updates` start is refused `alreadyRunning`.
5. Browser e2e (`server-transfer.browser.e2e.ts`) rewritten to stub `operations.active` payloads instead of the removed status route; asserts the step list renders and the connected outcome appears from operation `done`.

## 12. Getting there

Ordered, each independently landable; removal rides with cutover (P5), not after:

1. Promote `LIFECYCLE_EXCLUSION_GROUP` to a shared module; durable-actor encoding helper for `createdBy`.
2. Refactor `ServerTransferService.transfer()` into runner-shaped internals behind the existing tRPC surface (pure mechanical split; existing tests keep passing).
3. Land the `server-move` kind + `machines.moveServer` start handler + handoff write + target/source reconcile + recovery-only boot mode, **and in the same series** delete `machines.serverTransferStatus`, `publicStatus`, the web bespoke model, and cut the web panel over to operations. §11.1 grep-gate lands here.
4. Acceptance harness rewrite (§11.3).
5. History list in Settings → Machines; error-copy pass.

## 13. Open questions (for coordinator review)

1. **Eligibility placement** (§7.1): folding `targetEligibility` into the machines listing vs. computing it client-side from machine records. The spec assumes the listing; if machines already expose enough (online, version-supported, not-current-server), no server change is needed.
2. **Recovery-only surface scope** (§5.4): minimal (operations read + ask settle only) vs. the full read-only router. Spec assumes minimal; full read-only is more code and more surface in a fenced state.
3. **`machines.moveServer` naming**: rename chosen to make the cutover un-aliasable; if churn on the commands package is unwanted, keeping the `machines.transferServer` name with the new start-only semantics is workable but risks stale-client confusion inside the mixed-version window.
4. **Desktop ask surface**: §6.2 scopes the uncertain ask to `'web'`. Should a desktop-surface ask exist too, given the desktop may be the only client alive during a bad cutover?
