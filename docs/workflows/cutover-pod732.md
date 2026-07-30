# POD-732 — the workflow cutover, and what was actually deleted

Companion to `pinned-behaviour-pod730.md` (the oracle) and POD-731's contracts.
This file is the deletion accounting and the evidence, written down because a
deletion issue that reports a delta without checking the destination is
reporting a number, not a deletion.

## 1. The surface

`workflows: t.router({ … })` held **18 hand-written procedures**, 11 of them
`.mutation(`. It now reads:

```ts
workflows: t.router(workflowFamilyProcedures()),
```

Verified with the audit's own brace matcher against the real file:

```
block text: "(workflowFamilyProcedures())"
t.procedure count: 0
.mutation( count: 0
```

The eleven writes are built from `WORKFLOW_CONTRACTS`, the seven reads from the
new `modules/workflows/queries.ts`. Both tables are read by **both** transports.

## 2. VANISHED vs MOVED

Every construct claimed deleted, grepped across `apps/`, `packages/`, `scripts/`.

| Construct | Before | After | Verdict |
|---|---|---|---|
| `const workflowInputs` (18 restated schemas) | 1 decl, 23 uses | 0 | **VANISHED** |
| `WorkflowService.dispatch` (reflective 2nd dispatcher) | 1 | 0 | **VANISHED** |
| `workflows.dispatch(` call in `relay.ts` | 1 | 0 | **VANISHED** |
| The eleven three-line shims + `private run<T>` | 12 | 0 | **VANISHED** |
| `validated?: boolean` unvalidated door | 1 | 0 | **VANISHED** |
| `WorkflowAccess.toRunVisible` (0 callers, unread param) | 1 | 0 | **VANISHED** |
| `_input` params on `bindings`/`profiles`/`prime` | 3 | 0 | **VANISHED** |

Residual textual matches are the audit's own `--probe` fixtures (which must
contain the deleted text so the checks can say YES) and two explanatory
comments. `private run<T>` also exists in `modules/specs/service.ts` — unrelated.

**One genuine MOVE, reported as such.** The `router-triple-access` ratchet went
**86 → 68** sites, and the detector scans **only `apps/server/src/router.ts`**.
Grepping the destination: `modules/workflows/trpc.ts` contains **2** matching
sites (`mods(ctx)` inside the two generic builders). So **16 VANISHED, 2 MOVED**
— 18 per-procedure reach-throughs collapsed into 2 generic ones. This is the
same shape POD-1180 records for POD-382; the detector's roots were **not**
widened here, because doing so unilaterally would leave it inconsistent with the
issues and sessions derived routers it also does not scan.

Baseline lowered to 68 (`bun run audit:rearch --update-baseline`), never raised.

`service.ts` 830 → 714 lines; `router.ts` 1410 → 1354.

## 3. POD-731's three open items

**1. `startRun`'s null human — CLOSED.** POD-731 recorded `null` because the
session-start path had no caller and inventing a human would be a lie in an
audit trail. That reasoning is inherited: the human is not invented, it is
**resolved** through the one seam every other apply uses
(`WorkflowAccess.onBehalfOf` → `workflowPrincipal`) for the actor the event
already names. An explicit `onBehalfOf` still wins, and `null` still means
REVOKED (ADR 9 D5 A1) — pinned by a counterfactual test that starts a second run
with a **different** actor and the field absent, so the assertion cannot pass
against an unconditional null. Mutant `!== undefined` → truthiness: **KILLED**.

**2. `adopt`'s duplicate — CLOSED for an identified delivery; nothing refused.**
POD-731's three reasons against *refusing* an unidentified adopt all still hold
and none changed at the cutover. What changed is that adopt's callers became
enumerable, so the CLI mints one mutation id per invocation: a repeated
**delivery** of that invocation is a ledger replay (handler not invoked, first
result verbatim), while two separate invocations remain two intents and still
supersede. Pinned with that counterfactual. Mutant removing the ledger recall:
**KILLED**. The unidentified-adopt refusal stays open and stays POD-731's
six-pin problem; the contract records the new state.

**3. task read/write scope asymmetry — LOOKED AT, DECLINED, reason named.** The
one rule would have to answer whether a capability's SUBTREE ROOT is a write
reach or only a read reach. That is ADR 9 D2's grant model (POD-1079), which
does not exist to re-derive from. Deciding it here means either widening every
subtree agent's write reach (readiness §3.1.3 A2 inverted, inside a migration)
or narrowing a read POD-730 pinned. The cutover did leave exactly **one site per
arm**, on one class, instead of two arms across sixteen guards.

## 4. The one pin the cutover moved, and why it is not a behaviour change

POD-731 predicted the contract parse would turn pinned domain errors into
ZodErrors, and kept a `validated` door for the shims. Measured: **1 of 88 pins**
moved — `create` with `scopeRef: ''`. That schema has carried `.min(1)` since
**before** POD-731, so no tRPC or relay caller could ever reach the domain error
the pin asserted; it described a path only an unparsed shim could take. The pin
is re-stated at its site against what the wire actually does, and the door is
deleted rather than inherited.

## 5. Evidence

- Both typechecks, **instrument probed first** (a deliberate TS2322 injected into
  `modules/workflows/trpc.ts` was REPORTED by in-package `tsgo` *and* by
  repo-wide `bun run typecheck --force`, then reverted with hash restored).
  Repo-wide: **23/23 tasks, 0 cached**.
- Targeted lanes (`apps/server`, `packages/commands`, `packages/model`,
  `packages/sync`, workflow CLI): **240 files, 3735 passed, 1 skipped**.
- POD-730's characterization suite green **through** the cutover, driving the
  production door (`WorkflowService.execute`) via an argument-order Proxy keyed
  on `isWorkflowCommand` — not eleven re-added methods, so it cannot drift from
  the contracts.
- Integration lane: `workflow-cli.e2e.test.ts`, real CLI → real tRPC client →
  real `startServer()`, **3 passed**.
- `bun run audit:workflows` (6 probes + 4 checks), `bun run audit:sessions`,
  `check-boundaries` (56 allowlisted, **0 new**), `rearch-audit` (baseline
  exact), `check-no-nul-bytes`. No schema change, so no `migration:check`.
- `check-boundaries` caught a violation of mine and it is fixed rather than
  allowlisted: the cutover test first *imported* the audit script, making
  `apps/server` (L4) import UP into `scripts` (L5). It now SPAWNS the script, so
  the layer order holds and the gate still runs inside `bun run test` — which is
  the one thing POD-382's fully-separate split gives up. Mutant confirming the
  spawned gate still fails the lane: **KILLED**.
- Mutation testing, one mutant per call, each verified APPLIED (unique match,
  hash change, grep-back) and reverted atomically: **8 mutants, 8 KILLED** —
  after the exposure mutant SURVIVED on the first pass and the guard was made
  reachable from a test.
