# POD-355 — Orchestrator / attention / telemetry: boundary and ownership review

**Verdict: DO NOT MERGE any of the three proposal nouns. Keep the current boundaries.**

Measured on integration `be22fa6f`, 2026-08-02, by the POD-279 coordinator.

The second adversarial review round revised this issue from a mandated merge into a
*boundary and ownership review*, on the grounds that "steward+notify and
hosts+quota+usage are not automatically cohesive services, and merging solely to
match the proposal's nouns would be churn". This review confirms that concern with
evidence: **the proposal's nouns are naming conventions, not observed cohesion.**

## Evidence

Sizes (production files, excluding tests):

| Module | Lines | Fan-in (non-test importers) |
| --- | --- | --- |
| `apps/server/src/steward.ts` | 1080 | 7 |
| `apps/server/src/modules/issues/service/attention.ts` | 457 | — (capability module of IssueService) |
| `apps/server/src/notify.ts` | 143 | 5 |
| `apps/server/src/telemetry.ts` | 82 | 5 |
| `apps/server/src/application/issue-attach-orchestrator.ts` | 41 | — (L3, POD-321) |

Coupling, which is the decisive measurement:

- `steward.ts` imports **neither** `notify` **nor** `telemetry`.
- `notify.ts` imports **neither** `steward` **nor** `telemetry`.
- `modules/hosts/service.ts` imports **zero** symbols matching quota / usage / models.

Three services with independent fan-in and **no direct dependency edges between
them** are not one service wearing three names. Merging them would create a larger
module whose parts do not call each other — the textbook churn this issue was
revised to prevent.

## Decision per noun

**Orchestrator — already resolved by POD-321, do not create a service.** The real
orchestration need was caller-visible cross-feature workflows, and POD-321 answered
it structurally with L3 application orchestrators (`IssueAttachOrchestrator`,
`IssueSessionLifecycle`) plus a 26-entry reaction registry for genuinely async
effects. A separate "orchestrator service" noun would now duplicate that seam. The
distinction to preserve is POD-321's, not this issue's: atomic-from-the-caller work
is an orchestrator; semantically asynchronous work is a registered reaction.

**Attention — keep inside IssueService as a capability module.** `attention.ts` is
457 lines over the shared `IssueStore`, reached through narrow constructor ports
since POD-320 dissolved the inheritance chain. Its state is issue state; extracting
it would re-introduce a cross-service edge to read rows it currently owns locally.
No evidence of a second consumer that would justify the split.

**Telemetry — keep standalone.** At 82 lines with fan-in 5 and no outbound edges to
steward or notify, it is already a leaf. Folding a leaf into a 1080-line module
strictly reduces cohesion.

## Ownership notes carried forward

- `steward.ts` at 1080 lines is the largest of the three and is a **review signal,
  not a defect** under the epic's own rule (module size is a signal with justified
  exceptions). It is not a god object by the Phase 4 audit definition and no cycle
  runs through it; POD-321's construction-order generator now proves the composition
  root that builds it is topological.
- POD-1327 (Steward cursor spy recursion) is an open **baseline** defect touching
  `steward.test.ts`, root-caused to the `IssueService` constructor-returned Proxy
  (the POD-1318 family). It is a test-observability defect, not a boundary problem,
  and must not be mistaken for evidence that steward needs restructuring.

## What would change this verdict

A future measurement showing a direct dependency edge between any two of the three
nouns, or a second consumer of `attention` outside IssueService. Re-run the coupling
measurement above before revisiting; do not re-decide from the proposal's noun list.
