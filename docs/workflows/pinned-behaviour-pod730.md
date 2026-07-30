# Workflow engine — pinned behaviour (POD-730)

The oracle for POD-731 (workflow contracts + handlers) and POD-732 (cutover).

Every row below is asserted in `apps/server/src/modules/workflows/characterization.test.ts`
against the CURRENT hand-written procs in `apps/server/src/modules/workflows/service.ts`.
87 tests, green at the commit that added them. **No production code was changed by POD-730.**

This is an oracle for a migration, **not a specification of the target**. Rows are marked:

| Mark | Meaning |
| --- | --- |
| **PIN** | Should survive the migration unchanged. A red PIN under POD-731 is a regression. |
| **ARTEFACT** | Exists only because Podium has had exactly one human. POD-731 is expected to change it. A red ARTEFACT is the *proof* the replacement happened — re-pin it against the new semantics, do not restore the old behaviour. |
| **BUG** | Wrong today, characterized as-is, filed separately. Fixing it is a deliberate change. |

Error messages are asserted **verbatim**, and every assertion also pins that there is
**no error `code`** on this surface — only a bare `Error` with a message.

## Governing ADRs

POD-730 pins today's single-operator behaviour; it does **not** implement these. Each ARTEFACT row
below is traceable to the decision that replaces it, so POD-731 can be reviewed against the ADR
rather than against taste.

| Decision | What it means for this surface |
| --- | --- |
| **ADR 9 D1.5** | `OPERATOR` — role `admin`, scope `all` — **is the single-operator vocabulary ADR 9 replaces.** It survives only as a migration artefact: the first account of an upgraded instance. "Code that constructs an unconstrained capability from *someone authenticated* is out of compliance once D1 lands." That sentence describes `workflowCaller()` exactly (§1). |
| **ADR 9 D1** | A principal is `(user, device, capability)`, derived from the **authenticated transport only**; payload identity is inert. Today this surface has no user at all. |
| **ADR 3 Am.1 / ADR 9 D5 A1** | Apply-time re-auth resolving the delegation chain **live** — never a capability snapshot. Note the tension with §4: a run pins an **immutable execution-profile snapshot**, which is correct for *reproducibility* but must not become the model for *authorization*. |
| **ADR 9 D5 A3** | Attribution is a **pair** — actor plus on-behalf-of — not a substitution. §9 pins today's single identity so the widening is visible. |
| **ADR 9 D5 A2** | The human is a **ceiling**, not the default grant. Every ARTEFACT in §1 is a missing ceiling. |
| **ADR 9 D6 M1–M2** | Machines are owned compute with `see` / `use` / `manage`; **`use` is a code-execution boundary, not a privacy boundary**. §4 pins that today there is no reachability concept at all to distinguish a use-grant refusal from. |
| **ADR 9 D3 / D4** | Five visibility classes, **default-closed with a totality test**. §10's existence leaks and §2's "any caller may create and revise global content" are the default-open holes. |
| **ADR 1 D5** | **Not multi-tenancy** — no `instance_id`. Where this document says "every run in the instance", that is the single-tenant reading. |

---

## 1. The eleven mutations, and where authorization is decided

`create · revise · fork · publish · assign · profileSave · checkpoint · assignStep · skip · retry · adopt`

Authorization is decided at 16 sites in `service.ts`. All 16 are pinned. Enumerated by a
**byte-wise scan** (not grep — see §7):

| Line | Site | Arm | Mark |
| --- | --- | --- | --- |
| 154 | `sessionFor` | a session whose row is gone loses write + read | PIN |
| 169 | `assertIssueScope` | early return for operator / `overrideScope` | ARTEFACT |
| 176 | `assertWorkflowWrite` | early return for operator / `overrideScope`; **and for any global workflow** | ARTEFACT |
| 196 | `assertCreateScope` | early return for operator / `overrideScope` / **`scope === 'global'`** | ARTEFACT |
| 204 | `canReadWorkflow` | `true` for operator / `overrideScope` / **any global workflow** | ARTEFACT |
| 320 | `publish` | refuses a *session* without `protectedWrite` on global — the one existing brake | PIN |
| 338 | `bindings` | full list for the operator, session-filtered view otherwise | ARTEFACT |
| 361 | `assign` | global/repository default needs `protectedWrite`; checked **before** the published-revision rule | PIN |
| 375 | `assign` | a session may bind only its own session target | PIN |
| 398 | `profileSave` | refuses a *session* without `protectedWrite` — the inverse shape | ARTEFACT |
| 461 | `runs` | **every run in the instance** for the operator; a session gets only its own live run | ARTEFACT |
| 636 | `runFor` | any run id for the operator; a session must be coordinator, assignee, or on the run's issue | ARTEFACT |
| 681 | `assertCoordinator` | operator may perform any transition on any run | ARTEFACT |
| 723 | `checkpoint` allowed check | operator accepted for any step, assigned or not | ARTEFACT |
| 730 | `checkpoint` assignee fallback | an operator checkpoint does **not** overwrite the assignee | PIN |
| — | `profiles()` | **no gate at all** — lists every profile, with `accountId`, to any caller | ARTEFACT |

Three of these (`bindings`, `runs`, `runFor`) sit in **queries, not mutations**, and are the
easiest to miss. They become cross-user reads the moment there is a second human.

**Transport edge — the compliance question for POD-731.** `workflowCaller()` in
`apps/server/src/router.ts` maps *any* caller with no `actorSessionId` to
`{ actor: { kind: 'operator', id: null }, protectedWrite: true }` unconditionally. "Operator"
today means *not an agent* — there is no owner, no admin role, and no human principal.

This is **literally the construct ADR 9 D1.5 names as out of compliance**: an unconstrained
capability built from "someone authenticated". Replacing it is the point of POD-731, and every
ARTEFACT row above is downstream of it — the sixteen guards are unconstrained *because* the
principal handed to them already is. A reviewer checking POD-731 should start here: if
`workflowCaller()` still mints an unconstrained capability, the guards below cannot have been
fixed no matter what they now say.

Not directly testable from this suite (the function is unexported and the service takes an
already-built `WorkflowCaller`), so it is recorded rather than pinned. Worth a reviewer's eye.

## 2. Library CRUD

| Behaviour | Mark |
| --- | --- |
| `create` writes workflow + v1 revision + one `workflow.created`; the revision starts **unpublished** | PIN |
| `revise` appends a version; a prior revision is **never** edited in place | PIN |
| `revise` on a *published* revision still only appends — publication is not a lock | PIN |
| `listRevisions` returns newest-first | PIN |
| `fork` copies the named revision's body (not the latest) into a brand-new workflow | PIN |
| `fork` records **no lineage whatsoever** — no `forkedFrom` field, and it emits a plain `workflow.created` whose payload does not mention the source. Fork provenance is unrecoverable. | **BUG** |
| `publish` stamps `publishedAt`; a duplicate delivery is **value-idempotent** but appends a second `workflow.published` event | PIN |
| duplicate `create` with the same scope+name surfaces a **raw SQLite UNIQUE constraint error** — no pre-check, no domain message | PIN |
| duplicate step ids are rejected by the *schema*, not the service | PIN |

## 3. Scope resolution

| Behaviour | Mark |
| --- | --- |
| `scopeRef` supplied for a global workflow is **silently discarded**, not rejected | PIN |
| `repository`/`task` without `scopeRef` → `"<scope> workflows require scopeRef"` | PIN |
| repository resolves through `repoIdForPath(session.cwd)`; a session in a non-repo directory can never create a repository workflow | PIN |
| task matches the **session id** *or* the **session's issue id** | PIN |
| **Any caller may CREATE a global workflow** | ARTEFACT |
| **Any caller may REVISE a global workflow** — including a foreign session in another repo | ARTEFACT |
| **Any caller may READ a global workflow** | ARTEFACT |
| the task **read** arm also accepts `capability.scope.rootId`, which the **write** arm does not — a caller can read a task workflow it cannot write | ARTEFACT |
| `overrideScope` short-circuits create, write and read exactly like the operator arm | PIN |
| a global binding is the floor: once one exists, `resolveRevision` never returns null | PIN |
| binding precedence: session → issue → repository → global, first hit wins | PIN |

## 4. Execution profiles

| Behaviour | Mark |
| --- | --- |
| `machineId` defaults to `null` (machine-agnostic); an explicit `null` clears a pin; `model`/`effort` default to `"auto"` | PIN |
| `profileSave` upserts by supplied id and emits **no workflow event at all** — profile changes leave no audit trail | PIN |
| a run pins an **immutable snapshot**; the live profile may drift away from it. `executionProfileForLaunch` with run+step returns the snapshot, without them the live row | PIN |
| an **unreachable / mismatched machine is a non-blocking WARNING**, never a refusal; the checkpoint succeeds | PIN |
| a session with no `machineId` produces **no warning at all** — indistinguishable from a machine that exists but is unreachable. **ADR 9 D6 M5** needs a use-grant refusal distinguishable from unreachable; today there is no reachability concept to distinguish it from, and per **M2** `use` is a code-execution boundary — so this arm has to become a **refusal**, not the warning it is now. | ARTEFACT |
| a missing snapshot warns and does not block | PIN |

## 5. Run advances — state machine, persistence, ordering

Step statuses: `pending → active ⇄ blocked → complete`, plus `skipped`.
Run statuses: `active ⇄ blocked → complete`, plus `superseded`.

| Behaviour | Mark |
| --- | --- |
| `startRun` persists run + step rows; `workflow.run_started` is attributed to the coordinator **session** | PIN |
| the `run_started` payload **omits `startStepId` entirely** when not supplied | PIN |
| a second `startRun` for a live subject returns the **existing** run — fully idempotent, no second event (`workflow_runs_one_live_subject`) | PIN |
| `startRun` with `startStepId` marks earlier steps `skipped` with summary `"Skipped when adopting workflow"` and emits **no `step_skipped` events** for them | PIN |
| `checkpoint` advances one step; `blocked → active` is reversible and blocks/unblocks the run | PIN |
| `currentStep` prefers `active`/`blocked` over `pending` — a blocked step is still "current" | PIN |
| `startedAt` is sticky; `completedAt` set only on `complete` | PIN |
| `currentStep` and `nextStep` in the returned packet are **the same object** — the packet has no notion of "the step I just finished" | PIN |
| a prompt-only (zero-step) run has its own checkpoint arm, gated on `assertCoordinator`, emitting `workflow.run_<status>` | PIN |
| `assignStep` does **not** validate that the session exists | PIN |
| `retry` resets the step, bumps `attempt`, **keeps the assignee**, and clears the run's `completedAt` | PIN |
| `retry` has no status precondition: it **resurrects a skipped step**, and nothing records that it was ever skipped | BUG |
| git observation is persisted verbatim; dirty-worktree warns only on `complete` | PIN |
| `notifyCoordinator` fires only for a non-coordinator session, falls back to `"(no summary)"`, and never fires for an operator | PIN |

## 6. Idempotency and duplicate delivery

There is **no mutation id, no idempotency key and no state precondition** on any advance.

| Delivery | Today |
| --- | --- |
| **duplicate `checkpoint` with NO `stepId`** | **BUG — double-advance.** The second delivery re-resolves `currentStep`, finds the **next** step, and completes it with the **first** delivery's summary and evidence. A third delivery finishes the run. A retried RPC or relay redelivery silently marks work complete that nobody did. **POD-731's no-double-advance is a CHANGE, and this pin is what proves it.** |
| duplicate `checkpoint` WITH an explicit `stepId` | refused: `step <id> is not the current linear step`. Naming the step is the **only** protection against the above. |
| duplicate non-terminal `checkpoint` on the same step | idempotent in effect; the event log is **not** deduplicated |
| duplicate `checkpoint` on a prompt-only run | idempotent; two `run_complete` events |
| duplicate `assignStep` | fully idempotent |
| duplicate `skip` | refused: `only the current step may be skipped` |
| duplicate `retry` | **not** refused — each delivery bumps `attempt` |
| duplicate `publish` / `assign` | value-idempotent; events still appended |

## 7. Out-of-order attempts

| Behaviour | Mark |
| --- | --- |
| only the current linear step may be checkpointed / assigned / skipped | PIN |
| a run whose steps are all terminal → `workflow has no remaining step` | PIN |
| a step cannot be retried once a later step has **left pending** — merely *active* is enough, and a *skipped* later step also locks it | PIN |
| only an `active` or `blocked` run may `adopt` | PIN |
| `prepareStart` refuses an implicit revision switch on a pinned issue | PIN |

## 8. adopt mid-run

| Behaviour | Mark |
| --- | --- |
| the live run becomes `superseded` with `completedAt` stamped; its step history survives | PIN |
| the new run carries `supersedesRunId` and emits `workflow.run_adopted` (payload **includes** `startStepId` when given) | PIN |
| steps before `startStepId` are written `skipped` / `"Skipped when adopting workflow"` / `completedAt` set / `assignedSessionId` null — and **no `step_skipped` events** are emitted | PIN |
| completed work is **not carried forward**; adopting a zero-step revision yields a run with no steps | PIN |
| adopt validates everything (revision exists → read scope → step exists → start scope) **before** superseding; every failure leaves the live run untouched | PIN |
| a session must be the coordinator | PIN |

## 9. Attribution and history

| Behaviour | Mark |
| --- | --- |
| every advance records **one** identity: a session id, or `operator / null` | ARTEFACT |
| an operator action is recorded as `operator / null` — an **unattributable write** | ARTEFACT |
| `startRun` hard-codes a **session** actor; there is no way to record that the operator or a human initiated a run | ARTEFACT |
| no `completedBy` on a step — the assignee is the only identity a step carries | ARTEFACT |
| `workflow_events` is **WRITE-ONLY**: `appendEvent` is the only event method on the repository and there is **no reader anywhere in the product**. Run history is reachable only by raw SQL. POD-731 must not drop the appends on the assumption nothing reads them — they are the only durable audit trail this surface has. | PIN |

**ADR 9 D5 A3** (readiness 3.1.3) makes attribution a **pair** — actor plus on-behalf-of — not a
substitution. The single-identity rows above are what makes that widening visible in the diff.
**ADR 9 D5 A4** additionally makes agent output owned by the delegating human: note that workflows,
revisions and runs have **no owner column at all** today, so A4 needs a schema change here, not
just an attribution change.

## 10. Error shape — the existence leak

3.1.5 requires an id the caller may not see to be **indistinguishable** from an id that does not
exist — the read side of **ADR 9 D4**'s default-closed rule. Today they differ on every path, and
the suite asserts the **divergence** so POD-731's convergence is documented rather than silent.

| Path | unknown id | out-of-scope id | in-scope id |
| --- | --- | --- | --- |
| `get` (read) | `unknown workflow: <id>` | `workflow is outside this session` | succeeds |
| `revise` (write, task) | `unknown workflow: <id>` | `task workflow is outside this session` | succeeds |
| `revise` (write, repository) | `unknown workflow: <id>` | `repository workflow is outside this session` | succeeds |
| `status` (run) | `no active workflow run for this session` | `workflow run is outside this session` | succeeds |
| revision id | `unknown workflow revision: <id>` | `workflow is outside this session` (existence **confirmed**) | succeeds |

An unknown *run* id collapses into the caller's no-run message — the only path that does not name
the id back. Everything else confirms existence.

## 11. Persistence and restart mid-run

| Behaviour | Mark |
| --- | --- |
| a run survives a full store close/reopen: status, step statuses, assignees, summaries, evidence, and the pinned profile snapshot | PIN |
| the recovery paths a resumed session uses — `prepareExistingSession`, `prepareStart`, `runs` — all resolve the same live run after restart, and the run continues where it stopped | PIN |
| pre-restart events remain, in order | PIN |
| `notifyCoordinator` is the **only** out-of-band effect and is **fire-and-forget**: it is not persisted and not replayed. A restart between a blocking checkpoint and the coordinator reading its inbox **loses the nudge**; only the blocked state survives. | PIN |
| nothing else is volatile — there is no in-memory run state, and **no client fan-out**: workflow mutations write no change-feed or `podium_events` row, so clients only see a workflow advance by re-querying | PIN |

## 12. How this suite was validated

**Mutation testing.** Twelve mutations were applied to `service.ts`, the suite run, and the
mutation reverted. All twelve were caught, each with named red tests (never merely a non-zero exit
— an early run was flagged `CAUGHT` by a full disk, not by a failing assertion, and was re-verified
after reclaiming space):

| Mutation | Red tests |
| --- | --- |
| M1 no-double-advance (the POD-731 change) | 1 |
| M2 drop the operator arm of `assertWorkflowWrite` | 13 |
| M3 drop the linear-step guard on `checkpoint` | 2 |
| M4 converge unknown-workflow onto the out-of-scope message | 1 |
| M5 drop the retry-after-later-step guard | 1 |
| M6 drop the only-current-step guard on `skip` | 2 |
| M7 session-filter `runs()` for the operator too | 2 |
| M8 rename the `workflow.step_skipped` event kind | 3 |
| M9 let a session change execution profiles | 1 |
| M10 prefer `pending` over `active`/`blocked` in `currentStep` | 3 |
| M11 skip `assertCoordinator` entirely | 2 |
| M12 drop the machine-mismatch warning | 1 |

**Completeness, not by grep.** The claims "every operator branch is pinned" and "`workflow_events`
has no reader" were re-verified with a **byte-wise scan of 1787 files** that reads bytes and
ignores NUL framing, because a single NUL byte makes plain grep report *no match* over an entire
module and exit 0. That scan found exactly one NUL-carrying file in this worktree —
`packages/client-core/src/engine/engine.ts` (fixed on `issue/279-integration` in 3d31eee7, after
this worktree branched) — and it contains none of the workflow identifiers, so no conclusion here
rests on a grep that silently skipped it.

**No fixed sleeps.** The suite is fully synchronous; there is no timer anywhere in it.
