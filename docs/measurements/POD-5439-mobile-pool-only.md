# Mobile screens pool-only

The phone reads exclusively through the shared pool. Legacy read twins,
the WorkScreen legacy arm, three-way dispatchers, side-by-side diagnostics,
the mobile pilot setting, URL overrides and startup latches are removed.
Work and its actions, sessions, inbox and pulse, preferences, settings,
banners, issues and missions use the permanent pool declarations.
Store action mapping and screening writers remain byte-identical to the
accepted control; this issue adds no writer, store-action or outbox change.

Final verification is green on local source `8849c99fb375e35cf339c7b36db680e337d4332b`,
tree `fdcecf47ae0e42507d22ecb314821106568bdda8`, based on integration `b1acfd4be9cf2b6dfe79cf812a1dfd9c4e63727f`.
The final report is the only later tracked change. The issue's attached
`phone-pool-only-review.html` contains all 13 production phone captures,
their cumulative counters and the measured comparisons below.

## Scope and dependencies

Review findings 24 and 26 were read in full before the first edit. The mobile
switch and setting were removed last, after POD-5081 landed at `b4d0134f17`.
POD-5437's compatible host convention is retained: permanent phone screens
omit `initialize` and `enabled`; neither host file is edited here. The branch
also includes POD-5433's keyed inputs, POD-5407's resident-only attach and
POD-5421's shared session-seat caches. Incoming `archivedCount` is preserved.
Other lanes' writer changes are inherited from integration, rather than
introduced by this retirement.

After POD-5407 landed, its last green phone OFF control was recorded before
removing `_phone-profile.ts`'s toggle and the warm-start OFF arm. Its accepted
ON samples, visible assertions and median method remain. No shared protocol
key, web control, host switch or pool-transactions pilot is retired here;
POD-5438 receives the actual landing SHA to release that separate work.

## Accepted outputs and last green controls

Legacy control arms were deleted only after their green runs were recorded
on the issue. Retained tests ask the actual pool for the same expected values.

| Accepted control | Recorded result | Retained coverage |
| --- | --- | --- |
| `33327a75ee` / `5d771a4e44` | Seven rendered files, 37 checks, 100 snapshots | Work, sessions, inbox, pulse, preferences, settings and banners |
| `5d771a4e44` | Eight work-corpus checks, 670 fingerprints | Worklist/publication outputs; the inherited clock limitation below is explicit |
| `7f7f5c49e9` | Two real-provider controls, four snapshots | Exact launch form HTML and launch plans |
| POD-5081 `b4d0134f17` | 1×/4× corpus and mounted OFF/ON equality | 9,714 corpus digests and 30 mounted fingerprints |
| Flatblock `a4cfa62e7c` | 17 board and 10 screening checks, 00:38:24.207–00:38:31.259 UTC, exit 0 | Literal order, nesting, progress and ordered actions |
| Unchanged `b4d0134f17`, WIP `04f788f81` | Whole banner HTML OFF/ON equality, 01:54:53.770–01:55:05.364 UTC, exit 0 | Positive OFF selectors and zero ON selectors/helpers |
| POD-5407 landed design report | Both rounds, all 12 OFF samples, zero bootstraps | Warm-start visible assertions and accepted ON medians retained |

The corpus bank SHA256 remains
`52215048ad65a438ec7a487936687a482014348ce9ddb45a954834eba285cf4a`;
the mounted bank remains
`22db0fd577420a6d5cc99652b70af7b5f5920e9c611e4fc0ae672e5a0733a903`.
Both are byte-identical to the POD-5081 control. Renamed snapshot keys preserve
their accepted bodies. No snapshot generator refreezes the candidate.

The final shared-seat regression executes three files and 14 checks at
05:42:37.550–05:50:00.353 UTC, flatblock WIP `23388d504b`, exit 0.
The 1× and 4× corpora each traverse 18 gates, covering 47,737 and 67,681
positions respectively: 115,418 total. Every corpus digest and mounted
fingerprint matches, with cumulative legacy counts zero. The preceding
keyed/attach rebase run has nine green files and 74 executed checks, including
WorkScreen, inbox, board, screening, settings and target-picker budgets.

## One reader and bounded input work

The pool is the only row reader. Indexes contain resident rows only; cold
questions are declared; absence returns LOADING and queues a batched load.
The repository menu uses the existing command root-activity question.
The parent picker reads its ordered window when opened, while a pressed issue
menu asks only for that issue, its origin, children and session roster.
Session task candidates stay lazy and clicked references use `pool.references`.
No second row cache, whole cold-table scan or replacement writer is added.

| Operation | Before rows 1× / 4× | After rows 1× / 4× | After derivations 1× / 4× |
| --- | ---: | ---: | ---: |
| Pressed issue menu | 65,392 / 358,849 | 6 / 6 | 0 / 0 |
| Parent picker | 2,400 / 9,600 | 29 / 29 | 15 / 15 |
| New-task repositories | 28,803 / 115,203 | 6 / 6 | 2 / 2 |

The menu reads zero archived payloads with six neighbours at either scale.
Delete count uses maintained `graph.size(pageSessions)`, preserving raw
membership 34/130 even when the visual roster is collapsed. The coordinator
approved `commandIssueSessions` with `archived=false` and `includeShells=true`.
Menu close and launch open/close read zero rows and run zero derivations.
The final focused fold reads 394/13 rows and runs 502/8 derivations within
the 13/18 visible-neighbourhood allowance. Picker source visits stay 15/15
on open and 12/12 for the specific search, with literal choices unchanged.

Meaningful plants fail independently: an eager picker reads 1,229/4,829 rows;
a broad prefix visits 23/99 candidates; an archived menu reads 38/134 rows,
including 32/128 archived payloads; a collapsed-count plant returns 649 instead
of 34. Every fault was restored to the clean source. The source-facet plant
keeps the exact target IDs yet reads the path 18 times instead of the allowed
one. All 23 query and five target assertions are green after restoration.
The production provider selector plant reaches the literal launch form then
fails at 16 selector runs versus zero allowed; its exact clean bytes are restored.

## Census and complete speed gate

All six measured bare-pool/write-idle/write-pending 1×/4× census checks are
green at 05:52:38.825–05:54:04.649 UTC, WIP `d4a965d9df`. The baseline-writing
case is skipped, and every measured count equals the unchanged baseline.
Its SHA256 is
`e24d1734dcc41086a70c3f9b0305c00aa2181bee7382940444f7c0dc3e64d6d8`,
byte-identical to POD-5407's `01e22dd14d` landing and the current integration.
No own baseline edit, growth allowance or update environment is used.

The inherited baseline shrink belongs to POD-5407: attach reads
416,921/1,632,267 become 13,900/55,727; map entries 33,246/134,784 become
6,747/27,124; set members 18,221/73,915 become 15/27. Relation atoms move
from maintenance to the first observed slot. POD-5432's earlier write-only
bookkeeping shrink is already inherited; its previously unblessed growth is
historical evidence, not the result of this final measured census.

Unmodified root `bun run speed:gate` is green on WIP `3904f989f0e782b1773bb1d181f131fe2651b4c0`,
2026-10-04T06:06:33.481292651Z–2026-10-04T06:14:08.85311818Z, fresh admission load 7.35.
The final matrix has 47 readers × nine events × two scales, 1,599 counters,
zero unexpected failures and zero resolved exceptions. Its 363 inherited
expected comparisons retain their existing owners: POD-5421 (45), POD-5453
(193), POD-5423 (28), POD-5420 (71), POD-5422 (26). This phone removal has no
remaining exception; the moved heartbeat counters belong to POD-5423.
The mobile long press reads three rows, runs one derivation and visits eight
collection elements at both scales, with six neighbours. Four fewer counters
than the preceding run are explained by the incoming shared-seat cache.

Exactly two structural files execute 16 checks; 11 filtered checks do not run.
The real legacy whole-data negative control and supporting planted faults
remain enforced. Production web timing takes its actual bench lease and
releases it. Six samples per action and two warmups use the fixed 10% gate
margin; measured same-code spread (17.639%) does not relax that margin.

| Web median, ms | Landed baseline | Pool-only branch | Change |
| --- | ---: | ---: | ---: |
| Sidebar issue | 159.506 | 168.580 | +5.7% |
| Mission switch | 4020.656 | 902.358 | -77.6% |
| Session pane | 3405.917 | 715.530 | -79.0% |
| Issue rename | 2972.887 | 691.802 | -76.7% |
| Background update | 3257.451 | 623.631 | -80.9% |

Sidebar paint is 5.7% slower, within the existing margin; the other four
medians improve. Actual capture load 11.78–13.29 is retained in the raw
report, separately from fresh admission. No claim is made that all web
actions became faster or that inherited whole-app expected failures vanished.

## Production phone proof and accepted ON timing

The actual mobile production export passes one Pixel 7 emulation case at
2026-10-04T06:16:22.131865848Z–2026-10-04T06:20:24.736535954Z, WIP `6427493d08279c3d1231c42cadc0b6fe088b9bf3`.
All 13 settled checkpoints have zero selectors, issue-model row builds and
legacy derivations, with zero page errors. Counters are enabled before runtime
construction and the real bootstrap placeholder leaves before capture.
Work, Tasks and saved folds, launch/details, screening, Mission, session,
Pulse and Settings render their accepted controls. Obsolete OFF parameters
still use the pool, and the pilot row is absent. Work, Mission and Settings
PNGs are inspected. This is browser device emulation of a production build.

Final accepted-ON action timing is green at 2026-10-04T06:21:53.684260061Z–2026-10-04T06:25:05.211120856Z,
WIP `5fa1af96e5605eb3ca4139b6186a12df9280fe15`. Chrome 148.0.7778.96, 6,100 issues,
5,200 sessions, 20 visible title updates, three untraced samples and three
diagnostic traced samples match POD-5081's accepted capture. Each measured
launch is warm with zero bootstraps. The unchanged accepted ON baseline is
used directly; all seven medians pass its existing 10% allowance.

| Phone median, ms | Accepted ON | Pool-only | Change |
| --- | ---: | ---: | ---: |
| Work CPU per update | 18.667 | 17.274 | -7.5% |
| Mission tap to paint | 159.593 | 90.665 | -43.2% |
| Mission CPU per update | 30.647 | 24.634 | -19.6% |
| Details open to paint | 51.040 | 47.473 | -7.0% |
| Details CPU per update | 26.191 | 25.619 | -2.2% |
| Tasks open to paint | 84.646 | 92.087 | +8.8% |
| Tasks CPU per update | 67.046 | 63.618 | -5.1% |

Tracing is diagnostic and excluded from acceptance. Raw arm bounds, loads,
samples, errors and the genuine lease receipt are attached with the timing
proof. This session owns `bench:flatblock` throughout the capture and releases
it on completion. No own validations overlap and no other structural meter
is present at admission.

## Private counts and focused validation

The final private ludovico walk completes 6,267/6,267 planned questions and
28,588 positions: 6,154 issues, 5,203 sessions, 2,087 roots, 63 sequential
pools, pending zero and legacy issue-model builds zero. Four additional live
roots explain 12 more questions than the prior walk. Credentials, operator
rows and native errors remain in memory; exported proof contains counts only.
The diagnostic fixture's keyed-input mismatch is proven red first, then fixed
with canonical `withKeyedInputs` and its empty ledger seam retained. No
production read or write body changes for that diagnostic repair.

Independent private controls were recorded before deletion: work has 6,124
issues, 5,192 sessions, 21 sections and 896 rows; inbox has 6,126 issues,
5,183 sessions, 22,528 targets and 38,978 positions. Both completed comparisons
have zero differences and zero pending results.

The source audit covers 300 production phone files and finds zero legacy
reader references. Store action mapping and the screening write tail are
byte-identical to `b4d0134f17`; the own diff against current integration has
no client-core writer or graph write-path edits.

Tests, typecheck and lint run foreground on flatblock in `~/podium-test-5439`
with Bun 1.4.2 and its `.toolchain`, through focused root wrappers. Each run
has a WIP commit, recorded PID and UTC bounds. The mobile/e2e compiler has
16 successful tasks, 216 resolved runtime imports and 303 procedure contracts;
the final changed graph compiler has nine successful tasks, eight trusted
cache hits. Focused phone, graph, released-helper and diagnostic lint is green
with existing warnings retained. Only inspected generator ordering changes
are restored to tracked bytes. No full-suite result, forced cache bypass,
stash or unrecorded process termination is claimed. Earlier timed-out and
stopped dispatches remain excluded rather than counted as green.

## Approved fixture changes and independent limitations

The accepted recovery copy from POD-5430 `edcd56288d` (operator-signed ADR 3
amendment 2) changes exactly one sentence in the frozen banner bank, with
coordinator approval `msg_62abf481`. Reversing that substitution reproduces
every original byte. The new bank SHA256 is
`97ae6cb5191dc79769fa7c5f16493c5182cf01e3365b2ad97911cdbfe3c6176e`.
All five banner checks are green. No other expected bank value changes.
The approved STALE-42-B repair is test-only: its old assertion is already red
on `b4d0134f17`; absent repo now expects `Author agent` and rejects the stale
raw ref, preserving the cleared-prefix check. No retired fallback is restored.

POD-5477 remains Proposed for the independent pending mark-read hash fixture.
The old 670-fingerprint bank's optimisticPress/seed3 cells vary because
wall-time `queuedAt` paints `readAt`, also reproduced on unchanged integration.
Its bank and writer clock are untouched. POD-5432's 7,241 settled sidebar and
mission fingerprints cannot see pending paint; existing owned-pending
work-per-change and transaction tests retain their wrong-reducer guards.

POD-5473 remains Proposed for the inherited `?demo=1` crash after `b890298e4d`.
Automatic review rejected the demo replica-constructor change; the coordinator
explicitly directed excluding it from this landing for operator review.
LiveProvider, sync, replica/outbox factories and store actions remain untouched.
The real-server `trpc.repos.list` behavior is retained as directed.
The independent launch initialization correction already landed as POD-5449
at `41e907ef043511bcfa21540ddd114e81b08568cc`.
