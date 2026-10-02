# Automation and specification pool readers

2026-10-02. Final runtime candidate: `7dd5565743`, rebased onto
`integrate/4286-pilot` at `35e707ac7e`. The coordinator allocated the automation
screens, specification repository reader, separate graph schema/source/views/checks,
and the app screen-registration seam. Every existing screen registration survived
the rebase.

The enabled readers execute **zero legacy selectors** in real Chromium. The
automation lists, run links, launch choices and specification editor produce the
same text, labels and control values as the legacy readers. Synthetic graph
comparison and persisted operator replay both have **zero differences and zero
pending loads**. Both screen switches remain **OFF by default**. No timing run
was taken, as requested by the coordinator.

## Reader contract

Enable automations with `?mobxAutomations=1` and specification repository choices
with `?mobxSpecs=1`. These choices are independent and latched once at startup;
navigation and principal replacement reuse them. Reload without the overrides
to return to the legacy readers. Adding `mobxAutomationsCheck=1` installs the
on-demand `window.__automationCheck()` differential comparison.

`automation-schema.ts` declares definitions, runs and their resident catalog.
It declares definition-to-target-session, definition-to-repository,
run-to-definition and run-to-session relationships, including their inverses.
The source borrows rows from the existing addressed replica. First demand returns
`LOADING` and batches both collections in one microtask; an absent loaded row is
`undefined`. Addressed edits, deletions and replacement update resident rows and
ID-only relationships. Source disposal releases its subscription and queued work.

Launch and specification choices reuse the existing settings machine/repository
source. Session presence and recency reuse its declared setup summaries, including
session identity, cwd, activity, agent kind, headless/resume/status and source order.
The screen requests these summaries before pool construction and ingestion. No new
index retains unloaded session payloads. Screen values read through `pool.row`, and
observed computations suspend when their consumers unmount.

The provider keeps its existing pool, runtime, replica, UI port, outbox and mutation
owner. Automation RPC mutations, specification RPC/editor behavior and session
navigation acquire stable handles. The enabled hooks never invoke the four legacy
reader derivations. Default-off fallback hooks remain for the operator rollout.

Baseline file and line evidence comes from [the parent inventory](POD-5082-legacy-reader-inventory.md):

| Original reader | Baseline | Replacement |
| --- | --- | --- |
| Automation definitions, runs and RPC handle | `AutomationsView.tsx:18` | Pool list/run groups and stable RPC handle |
| Launch machines, repositories and sessions | `NewAutomationDialog.tsx:110` | Pool target choices and declared summaries |
| Run session and navigation | `ScheduledSection.tsx:304,307` | Pool summary presence and stable navigation handle |
| Specification repositories and RPC handle | `SpecsView.tsx:63` | Pool repositories and stable RPC handle |

## Focused flatblock acceptance

Acceptance ran sequentially in `~/podium-test-5167`, using its checkout-local
`.toolchain`, pinned Bun 1.4.2 and isolated dependency graph. The final scoped
web/graph typecheck completed **16 successful tasks**. Focused MobX lint passed
for the six new graph/source/diagnostic files.

`bun run test:file --` with the following four paths executed **10 passing tests**
in two groups. This is focused evidence, not a suite result.

- `packages/client-graph/src/automation-source.test.ts`: 1 strict observable-publication check.
- `apps/web/src/app/automation-readers.test.tsx`: 5 source, teardown, policy, relationship and enabled-reader checks.
- `apps/web/src/features/automations/data-layer.test.ts`: 2 startup-choice checks.
- `apps/web/src/features/automations/NewAutomationDialog.test.tsx`: 2 existing mutation checks through the new reader boundary.

The reader checks cover coalesced loading, atomic registration/disposal, late
attachment teardown, scoped machine rights, duplicate repository paths, recency,
unavailable saved targets, addressed reparent/delete/replace, system-definition
filtering and zero legacy derivations. Twelve planted reader faults each produced
an executed assertion failure. Three startup-switch controls also failed as
intended: default ON, relatching and coupled screen choices. The restored candidate
passed the focused acceptance above.

The earlier allocated shared-source repair also passed its focused registry,
summary and teardown checks, with planted controls. Its complete unchanged sidebar
replay had 25 passing checks and two adjacent corpus/new-issue failures tracked
in **POD-5261**; it had no teardown failures. That full-file result is not green.

## Real Chromium comparison

Reproduce the final browser count proof on flatblock from its checkout root:

```sh
export PATH="$PWD/.toolchain:$PATH" LD_LIBRARY_PATH="$PWD/.toolchain/lib"
bun --conditions=@podium/source apps/web/test/automations-readers-proof.ts --counts-only
```

The fixture mounts the actual AutomationsView, SpecsView and launch dialog on the
existing provider. Its synthetic corpus contains 5,600 issues, 5,016 sessions,
six definitions and 24 runs. Each arm uses a fresh Chromium page and one runtime;
sidebar uses the pool in both arms. The driver expands run history, opens the
actual launch dialog, delivers 200 kernel session publications and edits an
automation definition. It stops only its recorded Vite PID and closes Chromium.

| Legacy reader calls during activity | Before | Enabled |
| --- | ---: | ---: |
| Definitions and runs | 200 | 0 |
| Launch choices | 201 | 0 |
| Run session presence | 801 | 0 |
| Specification repositories | 200 | 0 |
| Total selectors | **1,402** | **0** |

Both arms have one runtime, 200 publications, one subscription, one specification
list call, one specification get call and zero provider/browser errors. The graph
comparison checks 36 positions across six sections with zero differences or
pending loads. The browser comparison checks three rendered surfaces with zero
differences; it retains authored control IDs and normalizes only React-generated
ID fragments between fresh mounts. Screenshots are attached to the issue as
fixture evidence. Styling and editor behavior did not change.

Both browser checks caught their planted controls: enabling the legacy after arm
failed the zero-selector guard, and planting a differing rendered field failed
the output comparator. Use `--red-control=legacy` or `--red-control=comparison`
with `--counts-only`; each must exit nonzero at its specific guard.

## Ludovico operator replay

`automation-replay.ts` refuses every hostname except ludovico. It opens the local
operator database read-only, sets query-only mode and a two-second busy timeout,
and closes its read transaction before creating an in-memory replica. It uses
only necessary automation/run fields and minimal session, registered-root and
non-credential machine columns. Logs contain counts and numeric positions only.

The final replay uses five definitions, five runs, 5,300 session rows, 35 registered
roots and six machines. It compares 15 positions across five sections with zero
differences and zero pending loads. This covers persisted data; live discovery,
reachability and scoped authority are exercised by the synthetic policy checks.
The planted replay control adds one synthetic definition only to the in-memory
pool side and fails with two differences. It never writes operator data.

```sh
bun --conditions=@podium/source packages/client-graph/diagnostics/automation-replay.ts
bun --conditions=@podium/source packages/client-graph/diagnostics/automation-replay.ts --red-control
```

## Operator rollout and retirement

The operator can review the default-off pilot using the startup overrides. Record
the date when the operator defaults each screen ON. **POD-5249** owns removal of
the legacy hooks and fallback derivations about one week after that rollout, with
focused checks and enabled-path comparison repeated before removal. No rollout
date has been recorded and the legacy paths remain available.
