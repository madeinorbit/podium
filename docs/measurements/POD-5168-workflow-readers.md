# Workflow placement and run targets

POD-5168 · 2026-10-03 · integration target `integrate/4286-pilot`.

Execution profile placement and run subject resolution now use the provider's existing pool when the workflow pilot is enabled. Workflow, profile and run wires remain owned by the single `useWorkflows` RPC hook. There is no additional runtime, replica, outbox, source subscription or mutation owner for those wires.

## Scope and reader contract

The coordinator allocated the three workflow production files, verification of the shared merge-queue lock handle, an additive `pool-screens.ts` entry, and the new workflow schema, readers, diagnostics and fixtures. The two existing workflow test files change only their mocked transport boundary; their assertions remain intact. Session-pane ownership remains POD-5092. Shared pool internals, relation machinery and app connection plugs are untouched.

The [baseline inventory](POD-5082-legacy-reader-inventory.md) identifies `ExecutionProfiles.tsx:61` reading machines, `RunProgress.tsx:97–98` resolving issues and sessions, and `use-workflows.ts:83` selecting only `trpc`. It also identifies `MergeQueuePanel.tsx:78` as an RPC lease consumer and `client-core/viewmodels/slices/workflows.ts:1–21` as pure RPC-fed functions, not a published store slice.

`WORKFLOW_SCHEMA` declares the existing machine catalog/source aliases, an issue identity summary, the existing setup session summary, and no maintained relations. Profiles and runs are RPC inputs, so the pool does not manufacture replicated workflow entities or retain another collection. Machine reads use `pool.row`; issue targets use its declared summary read. Session targets reuse the existing summary view, including resume-twin suppression and source-order tie breaking. A raw keyed session row would incorrectly expose a suppressed parked twin.

Cold target identities resolve through declared summaries while their full rows remain outside the resident table. Initial source demand returns `LOADING` and batches loads. The enabled hooks also return loading while the shared pool attaches; they never choose the fallback by pool availability. Unknown or scoped-out subjects keep the pure policy's `pending` reference state and the existing opaque “no access” rendering once loading finishes.

Placement eligibility, unavailable reasons, unplaced profiles, run advancement and actor attribution keep the existing pure functions. Writes, denied-write reconciliation, selection and history stay in the existing RPC owner. `useWorkflows` obtains only the stable transport handle without a store subscription. The merge-queue hook already acquired that handle through [POD-5161](POD-5161-client-access.md); this change verifies its existing single polling service rather than installing another one.

## Startup and comparison

The switch uses `webPoolSwitch('mobxWorkflows', 'mobxWorkflowsCheck')`, defaults OFF without a stored pilot choice, and latches once before the first render. The shared MobX pilot setting and the independent workflow URL override follow the existing recipe. Initial-load `mobxWorkflows=1` enables the screen; `mobxWorkflows=0` forces rollback. A later pool attachment, URL edit or principal rebuild does not relatch it.

With `mobxWorkflowsCheck=1` and the enabled arm, `window.__workflowCheck({ profiles, runs })` compares caller-owned RPC inputs against the existing runtime snapshot and pool. It issues no queries or subscriptions and retains no RPC rows. The comparison extends the sidebar-check pattern and reports counts plus numeric mismatch positions, omitting machine option payloads and hostnames.

One synchronous, disposable MobX reaction shares the session-summary computation across all targets in a diagnostic snapshot. This works inside an action and disposes every observer before returning. The focused probe checks 500 references with one traversal of 34 summary rows and unchanged observers; physically removing tracking or disposal makes the check fail.

## Real Chromium evidence

`apps/web/test/workflows-readers-proof.ts` ran on flatblock in `~/podium-test-5168` with checkout-local Bun 1.4.2 and `.toolchain` libraries. Each fresh page mounts the actual `ExecutionProfiles`, `RunProgress` and `MergeQueuePanel` over the real offline provider/replica and one RPC hook. The synthetic corpus contains 5,600 issues, 5,016 sessions, eight profiles, six machines and six runs. Each arm drives the machine selector and name input once, then delivers 200 session activity events. This is a count/render proof; the coordinator required no timing capture for this screen.

| Measurement over 200 publications | Legacy arm | Pool arm |
| --- | ---: | ---: |
| Actual provider runtimes | 1 | 1 |
| Publishing runtime owners | 1 | 1 |
| Accepted publications | 200 | 200 |
| Store selector calls | 2,612 | 0 |
| Workflow machine derivations | 200 | 0 |
| Workflow subject derivations | 6 | 0 |
| All captured legacy derivations | bounded baseline | 0 |
| Browser/provider errors | 0 | 0 |

Both arms make one query each for workflow list, bindings, profiles, runs, detail and repository locks, plus one discovery request. The graph comparison returns **0 differences, 0 pending, 14 positions**. Removing an issue and session target and making the previously available machine unreachable produces the same result. The three rendered surfaces then compare with **0 differences and 0 pending**, including text, accessible labels and control values. Only generated React control IDs are normalized.

The first browser guard exposed an existing instrumentation problem: `sessionById` records each immutable session array as a counter owner, filling the global 32-owner ring and evicting runtime totals. Proposed POD-5335 tracks that independently shippable repair. The proof uses the existing capture window, which retains the first publishing owner, and separately counts actual provider attachments. It checks exactly 200 publications in both arms and zero dropped owners, selectors and all legacy derivations in the enabled arm. The baseline's aggregate derivation count is bounded by the capture's owner limit; its workflow counters above remain exact. No shared counter code was changed.

## Persisted operator replay

`packages/client-graph/diagnostics/workflow-replay.ts` runs only on ludovico. It opens the existing database read-only, sets `query_only`, reads minimal target/placement projections in one transaction, then rolls back and closes the database before constructing an in-memory comparison. It reads no credentials, workflow instructions or authored issue/session text. It starts or changes no operator service. Only counts and numeric positions are retained.

The replay covers 6,009 issue identities, 5,317 session identities, six persisted machines, zero profiles and 260 persisted runs. Adding every persisted issue/session identity gives **11,586 target references**, with **0 differences, 0 pending and no first mismatch**. Machine replay represents persisted offline placement, not live scoped fleet availability; all six live availability classes are covered by the synthetic checks.

The planted replay control adds an in-memory visible issue for a target absent from the legacy projection. It exits nonzero with exactly one subject-state difference at section 2, row 11,586, and zero pending loads. Operator records remain unchanged.

## Focused validation and controls

All tests, typechecks and lint ran on flatblock with the checkout toolchain, foreground timeouts and no overlapping lanes. Each batch waited while the one-minute load exceeded eight. The scoped `@podium/web` and `@podium/client-graph` typecheck passed all 16 dependency tasks; the final browser-probe typecheck passed with 15 cache hits. Focused graph lint passed for the two new schema/view files and the two diagnostics.

The final exact-file selection executed **18 passing tests across five files**: reader attachment/parity/lifecycle/ownership/denial (6), startup switching (5), existing execution profiles (1), existing workflow view (5), and shared stable transport/lock acquisition (1). This is focused evidence, not a lean-gate or full-suite result.

Reproduction:

```sh
export PATH="$PWD/.toolchain:$PATH" LD_LIBRARY_PATH="$PWD/.toolchain/lib"
bun run typecheck -- --filter @podium/web --filter @podium/client-graph
bun run test:file -- apps/web/src/features/workflows/readers.test.tsx apps/web/src/features/workflows/data-layer.test.ts apps/web/src/features/workflows/ExecutionProfiles.test.tsx apps/web/src/features/workflows/WorkflowsView.test.tsx packages/client-core/src/react/stable-transport.test.tsx
bun --conditions=@podium/source apps/web/test/workflows-readers-proof.ts
```

Every new test case has a physical failing control, restored immediately afterward:

| Check | Planted defect |
| --- | --- |
| Default OFF / startup latch | Forced pool default; reinitialized the switch |
| Independent overrides / shared setting | Coupled to the automation key; ignored the stored choice |
| Placement | Forced an unreachable machine online |
| Cold issue target / one reader | Removed target presence; used `peek` |
| Resume-twin parity | Read the raw session row |
| Batched loading | Suppressed catalog pending state |
| Real attachment | Suppressed loading before the pool exists |
| Zero legacy reads / RPC owner | Restored the RPC snapshot selector |
| Denied write | Discarded the error after one denied mutation |
| Diagnostic traversal / lifetime | Removed tracking; retained the reaction |
| Chromium enabled path | Ran the legacy arm under the enabled assertion |
| Chromium rendered comparison | Changed an actual rendered profile name |
| Operator replay | Added a pool-only target identity in memory |

The hermetic controls cover 14 planted mutations, the browser controls cover two, and the operator replay covers one. Each must fail its executed assertion or comparison, not merely fail to start.

## Rollout and retirement

The startup default remains OFF. The operator default-ON date is not yet recorded. Proposed POD-5331 tracks removing the fallback readers and temporary workflow switch about a week after that date, preserving the single RPC/lock service and repeating the focused parity/count checks. Session-pane retirement remains with POD-5092.
