# Utility transport readers

POD-5169 · 2026-10-02 · integration target `integrate/4286-pilot`.
Baseline: [legacy reader inventory](POD-5082-legacy-reader-inventory.md).

## Change and ownership

Usage, message ledger, mission cost, handoff review events, waterfall activity
history, and the handoff transcript hook now acquire stable handles through
`useStoreHandle<Trpc>().getSnapshot()`. They acquire the existing RPC client and,
for transcripts, the existing replica. They add no snapshot subscription,
runtime, replica, outbox, entity copy, or mutation owner.

The coordinator allocated the five surfaces, their tests, and the transcript
helper before implementation. Waterfall's `coarseNow` and `renameSession`
selectors remain with POD-5077. `FlightDeck.test.tsx`, shared pool/provider
seams, and the files allocated to POD-4973 were not edited.

| Reader | Original selector line | Migrated acquisition |
| --- | ---: | --- |
| `features/usage/UsageView.tsx` | 57 | Existing RPC client |
| `features/messages/MessageLedgerView.tsx` | 109 | Existing RPC client |
| `app/MissionCostChip.tsx` | 101 | Existing RPC client |
| `app/FlightDeckHandoff.tsx` | 118 | Existing RPC client |
| `app/FlightDeckWaterfall.tsx` | 251 | Existing RPC client for activity history only |
| `app/use-handoff-transcript.ts` | 45 | Existing RPC client and transcript replica |

RPC requests, polling, caches, cancellation, transcript pagination/tail writes,
and usage/ledger/cost/handoff pure helpers retain their behavior. The pure
viewmodel imports remain for relocation when the viewmodels retire.

These are RPC/props readers and introduce no pool-backed entity reads. The
coordinator explicitly confirmed unconditional stable acquisition, following
POD-5161. The default-OFF startup switch and week-long retirement window apply
to new pool-backed screen reads; there is no utility fallback to retain here.
The pool's schema, one-reader, resident-index, summary, and batched-LOADING
contracts are unaffected.

## Real Chromium comparison

Run on flatblock in `~/podium-test-5169`, with a copied checkout `.toolchain`,
Bun 1.4.2, and a frozen checkout-local dependency graph. The fixture uses the
real offline core provider, runtime, replica, subscription counters, production
utility components, and production waterfall activity hook. It contains 5,600
synthetic issues and 5,014 sessions. RPC responses are synthetic; no server or
daemon is started.

`utility-readers-proof.ts` runs one arm at a time. The before arm restores only
the six original selector acquisitions; the after arm uses the candidate.
Each original source is restored byte-for-byte in `finally`. Both arms use one
wall clock and the same RPC answers and props. The output comparison reuses
`compareSidebarSnapshots`: each of five surfaces contributes rendered text,
titles, and accessibility labels as section fields. This is an out-of-band
diagnostic, with no comparison installed in the application.

| After 200 unrelated session publications | Before | After |
| --- | ---: | ---: |
| Runtime owners recorded | 1 | 1 |
| Publications | 200 | 200 |
| Selector calls | 1,200 | 0 |
| Snapshot subscriber wakes | 1,200 | 0 |
| Legacy slice derivations | 0 | 0 |
| Utility React commits | 0 | 0 |
| Browser errors | 0 | 0 |

All eight RPC procedures were queried once in each arm. Unrelated activity
caused no additional RPC reads. The final comparison reports **0 differences,
0 pending, 5 sections**. These surfaces contain no pool entity-row comparisons.

One additional Chromium sample held `bench:flatblock`, which was released
immediately afterward:

| CDP metric during the 200-publication phase | Before | After |
| --- | ---: | ---: |
| Task duration | 565.497 ms | 458.485 ms |
| Script duration | 0.089 ms | 0.124 ms |
| React commit duration | 0 ms | 0 ms |

Task duration includes synthetic fixture delivery and browser bookkeeping.
This single sample does not establish a general UI speedup; the reproducible
result is eliminated snapshot-reader work with matching output.

## Focused validation and red controls

The final web-focused typecheck passed all 16 dependency tasks, with 15 cache
hits. Validation used `bun run test:file -- <exact files>` on flatblock:

| File | Tests passed |
| --- | ---: |
| `features/usage/UsageView.test.tsx` | 13 |
| `app/MissionCostChip.test.tsx` | 17 |
| `app/use-handoff-transcript.test.tsx` | 3 |
| `app/utility-readers.test.tsx` | 6 |

The six-reader file uses the real core provider, selector hooks, subscription
store, and store counters, replacing only runtime construction with a bounded
fixture. Each reader receives the existing RPC client, subscribes zero times,
and produces zero selector calls, wakes, and legacy slice derivations across
20 publications. Existing behavior tests preserve the loading/cache, cost, and
transcript contracts. These are focused results, not a suite or lean-gate result.

Each reader guard was proven red independently: copy its source aside, replace
the stable acquisition with a real selector, run that reader's exact test,
observe the snapshot-subscription assertion fail, and restore the original
bytes. All six failed at that assertion. The browser comparator also failed on
a planted output mismatch, reporting `usage`, section position 0, field `text`.
Restoring the original output produced zero differences again.

Initial proof fixtures omitted cost wire fields; those fixture failures were
corrected, and the cost fixtures now use the declared RPC types. The affected
six-reader file and browser comparison were rerun green. No product behavior
was changed in response to a fixture failure.

Operator-data replay was not run: the coordinator explicitly excluded it for
this transport-only slice because the displayed data and derivations do not
change. Automatic approval review rejected a proposed script's direct access
to an operator credential before applying it. No credential or operator payload
was accessed, and the unused replay entry point was removed. Nothing remains
pending on that path.

Counts, timing results, a synthetic browser capture, and redacted validation
logs are attached to the issue. Run a counts-only reproduction with:

```sh
bun --conditions=@podium/source apps/web/test/utility-readers-proof.ts --counts-only
```

The script temporarily rewrites the six allocated acquisitions for its before
arm; run it in an isolated checkout, with no other processes reading those files.
Timed runs require `bench:flatblock`. `--counts-only --red-control` deliberately
exits nonzero with a single rendered-output mismatch.
