# Mobile screens pool-only

The phone now reads through its existing shared pool. Its legacy twins,
WorkScreen arm, three-way dispatchers, diagnostics, mobile pilot setting,
startup latch and URL switches are removed. Store actions and outbox remain
with their existing owner. This candidate is still in progress: final production
phone proof, timing and landing are pending.

Findings 24 and 26 were read in full before the first edit. The branch includes
POD-5437's optional host declarations, POD-5081's final mobile readers and
POD-5432's overlay retirement at `1771dbb415`, POD-5438's behavior-preserving
transaction URL latch separation at `cca0cf29cc`, and POD-5430's independent
outbox partition drainers at `d9870eabd9`; these writer changes are
inherited, rather than edits in this issue. Shared host files are not edited.
The phone declarations omit `initialize` and `enabled`. The branch also includes
POD-5421's mission reader landing at `ba1171ee9d`. Its `archivedCount` interface
is retained in the empty mobile deck; the rebase preserves the deleted legacy
checker rather than restoring its control arm.

## Accepted outputs and retained controls

Each legacy arm was removed after its green control was recorded on the issue.
Tests now read the actual pool against those accepted values. Expected outputs
are not regenerated.

| Accepted source | Recorded control | Retained regression |
| --- | --- | --- |
| `33327a75ee`, `5d771a4e44` | Phone read controls; seven rendered files, 37 checks and 100 snapshots | Work, sessions, inbox, pulse, preferences, settings and banners |
| `5d771a4e44` | Eight work corpus checks and 670 fingerprints | Worklist and publication outputs; wall-time failures below remain visible |
| `7f7f5c49e9` | Two real-provider launch controls and four snapshots | Exact form HTML and launch plans |
| `b4d0134f17` from POD-5081 | 1x/4x corpus and mounted OFF/ON controls | 9,714 corpus digests and 30 mounted fingerprints |
| `a4cfa62e7c` on flatblock | 17 board and 10 screening controls, UTC00:38:24.207–31.259Z, exit0 | Actual pool board/screening reader, literal order, nesting, progress and ordered actions |
| `04f788f81` on unchanged `b4d0134f17` | One complete banner OFF/ON control, UTC01:54:53.770–01:55:05.364Z, exit0 | Exact whole HTML equality; positive OFF selectors and zero ON selectors/helpers |

The 30-file foreground phone run at source `318aa438b5`, flatblock WIP
`b439293e4e9013660c99407388d1f0ee33305e5a`, UTC01:34:26.597–01:46:21.854Z,
load7.49→6.03, has 27 green files and three fixture failures: 205 assertions
pass and three fail. Both corpus scales match all 9,714 digests through
115,418 positions and 18 gates each. The mounted bank's 30 fingerprints pass
across 11 cumulative phases with selectors, issue-model row builds and all
legacy slice derivations zero. Session-context, MissionDeck, slices, board,
screening, WorkScreen and all 28 action controls are green. The action file
retains its 91 state comparisons and 33 literal menu outputs.

Two fixture repairs are committed at `a1d9a42490`: the synthetic complete
bootstrap now marks absent personal markers known, and the complete inbox
snapshot settles its declared archived/absent reference requests through the
existing batched loader. Custom replicas still control their own posture.
Production joins and expected outputs are unchanged. The seven-file focused
retry started at load6.00 but reached its 20-minute limit:
UTC01:58:33.888–02:18:39.429Z, exit124, endload17.60, with shared load31–34
during the run. Its collected partial report proves both repaired files green:
session-homes has four assertions, including4,304 corpus routes; inbox has14,
including its complete frozen bank. WorkScreen logs green menu/click budgets
and1xpaint0/1 but has no final file result. The remaining five files subsequently
completed green at source `2ba88fc1f4`, flatblock WIP
`04daa12a9d54763345f6b7f46a04f40206d37f8e`, UTC02:50:14.250–02:53:35.726Z,
load5.99→8.69, exit0: WorkScreen11, MissionDeck10, mobile slices7, board17 and
screening10, totaling55 checks. Literal native rows/styles, paint counts,
search identity and the menu/click1x/4x budgets pass. Together with the two
completed files from the interrupted run, all seven files have green results;
the interrupted invocation itself remains exit124.

The mission dependency rebase has a separate green three-file run at source
`6ab3da11d5`, tree `9a8e2e42d977e482ee125261d05482f8363af857`, flatblock WIP
`93543174a75e9f7a2979413dc7064cd442866887`, UTC03:05:56.975–03:13:17.963Z,
freshload7.53→9.84, exit0. Corpus2, mounted-screen2 and MissionDeck10 total14
checks. Both scales preserve all 9,714 corpus digests through 115,418 positions
and 18 gates each; all 30 mounted fingerprints and cumulative zero legacy
counts remain unchanged. The capture owner has the exact overlap bounds.

The two converted snapshot test keys were mechanically renamed to match their
new test names. Their expected bodies were checked byte-for-byte. No expected
screen value was generated from the retirement candidate.

## One reader and bounded input work

The pool remains the only row reader. Cold questions are declared; missing
rows return LOADING and queue batched loads. The existing command root-activity
question orders repositories. Relation-picker membership is read when the
picker opens, and the selected menu asks only for its issue, origin, children
and roster. No new row cache or cold-table scan is introduced.

| Scripted operation | Before 1x / 4x row reads | After 1x / 4x row reads | After 1x / 4x derivations |
| --- | ---: | ---: | ---: |
| Pressed issue menu | 65,392 / 358,849 | 6 / 6 | 0 / 0 |
| Parent picker | 2,400 / 9,600 | 29 / 29 | 15 / 15 |
| New-task repository choices | 28,803 / 115,203 | 6 / 6 | 2 / 2 |

The menu reads no archived payloads, with six neighbours at both scales.
Raw delete membership stays 34/130. Menu close and launch open/close perform
zero reads and derivations. The fold reads586/13 and runs532/8 derivations;
its 4x work stays within the 18/13 visible-neighbourhood allowance. Target
search source visits stay15/15 on open and12/12 for the specific search.

Recorded negative controls independently fail for an eager picker, broad
reference-prefix work, archived menu payloads and resident-only raw membership.
Examples: eager picker reads1,229/4,829, broad prefix visits23/99, archived
menu reads38/134 including32/128 archived payloads, and the collapsed-count
plant incorrectly returns649 instead of34. Clean source was restored after
all faults. Literal choices and menu outputs remain unchanged.

The source-facet correction reads each scalar once while publishing text-gram
keys. Its meaningful counter tests both short and long text, asserting exact
target IDs before a one-path-read budget. The planted repeated path read keeps
the exact target output but fails at18 reads versus1 allowed. The clean source
is restored. At source `a1d9a42490`, flatblock WIP`a2b359c7dc44c4b68978bb728e7e5a9ea3872528`,
UTC01:56:24.353–01:57:34.835Z, load6.55→6.68, all23 query and5 target assertions pass.

## Census and strict speed guard

The measured census retains integration's known growth: one `sessionsChanged`
standalone observable value, one constructor value, and the source's larger
first-reactive scope. This growth predates this retirement and is confirmed
on unchanged `b4d0134f17`, `13a2b74917` and by the owner of `1771dbb415`.
No growth exception or own baseline update is added.

| First-reactive count | Integration control 1x / 4x | Retirement 1x / 4x |
| --- | ---: | ---: |
| Row reads | 432,769 / 1,728,293 | 416,546 / 1,663,705 |
| Distinct rows | 9,174 / 36,690 | 9,174 / 36,690 |
| Standalone values | 197 / 787 | 197 / 787 |

All six bare/write-idle/write-pending variants have the same figures. Scalar
caching explains the read shrink of16,223/64,588, with no retained cache,
index or observable growth. All six strict census checks still fail against
the older baseline because inherited growth remains deliberately unblessed.

The current baseline is byte-identical to `1771dbb415`, SHA256
`7473cbc739176da0efcac85ae9f687358026316d0386b8ceb1a9c87a5d2119fb`.
Its change from the earlier baseline is POD-5432's explained write-* overlay
bookkeeping shrink: one map, one atom and2,389/9,616 tracked `has()` values,
with pending create reads moving to first paint. This issue does not edit it.

The last strict structural matrix has1,614 comparisons,700 expected failures
owned by other issues,25 resolved counts and14 unexpected heartbeat comparisons
assigned to POD-5423. Its15 supporting checks are green; the matrix exits2.
No heartbeat exemption is added and no timing green is claimed from that run.
The final structural rerun is pending.

Phone timing will compare production Pixel7 pool-only samples with POD-5081's
accepted ON capture: the same6,100-issue/5,200-session corpus, Chromium version,
20 updates and three untraced samples plus diagnostic traced samples. The
comparison uses the existing speed gate's fixed 10% median noise margin and
retains the raw medians and deltas for review. Timing
runs only under this session's `bench:flatblock` lease. POD-5407 released its
capture lease at02:47:46Z; POD-5421 acquired it at03:01:17Z. The shared phone
OFF/warm-start helper remains untouched until POD-5407's landing notice.

## Zero legacy readers and private counts

The final source audit at `6ab3da11d5` scans 300 production files and finds zero
legacy reader references, including twins, selectors, slices, switches and
removed board/screening builders. The store action mapping, screening command
interface, decision function and tally are byte-identical to `b4d0134f17`.
The accepted corpus bank's SHA256 remains
`52215048ad65a438ec7a487936687a482014348ce9ddb45a954834eba285cf4a`,
and the mounted bank remains
`22db0fd577420a6d5cc99652b70af7b5f5920e9c611e4fc0ae672e5a0733a903`.

Private replays ran on ludovico; raw operator rows were not exported. Recorded
independent controls have zero differences/pending: work6,124 issues/5,192
sessions,21 sections/896 rows; inbox6,126 issues/5,183 sessions,22,528 targets
and38,978 positions. The inbox's first timeout is excluded; only its completed
longer run is evidence.

The final counts-only pool walk completes6,255/6,255 questions and28,537 positions:
6,146 issues,5,200 sessions,2,083 roots,63 sequential pools over one captured
runtime, pending0 and legacy issue-model builds0. Six additional live roots
explain18 additional questions since the last independent comparison. This
walk proves pool completion, rather than manufacturing another legacy result.

## Validation limits and outstanding work

All validation runs are foreground, focused and on flatblock in its issue test
checkout with Bun1.4.2 and the checkout's `.toolchain`. Every run has a WIP
commit, PID and UTC bounds. No full suite, stash, global cache deletion or
unrecorded process termination is used. While POD-5407 holds the bench lease,
new runs initially required fresh one-minute load below8. At02:26:35Z the
coordinator imposed a stricter quiet window after the shared host reached
22of23GB and a capture was aborted: no new validation of any kind until
POD-5407 explicitly releases the bench, regardless of load. That release was
received at02:47:46Z and the coordinator restored normal admission at02:47:57Z.
While another lane holds the bench, new test/compiler/lint runs require a fresh
one-minute load below8. The coordinator separately holds structural meters
until approximately03:48Z while POD-5430 runs its final4x meter. No timing is
started under another session's lease.

The latest filtered mobile/e2e compiler is green after the mission dependency
rebase at source `935646f2a6`, flatblock WIP
`ff4703196399dc553d8a502c364c738fb8f506e6`, tree
`cd608e7116c031f4878b081cd04e10b50249ef14`.
UTC03:24:43.518–03:26:12.803Z, freshload7.80→14.02, Bun1.4.2, exit0:
16/16 tasks, zero cache hits or bypasses, all216 e2e runtime imports resolve
and303 procedure contracts are generated. The bench owner has its overlap
bounds. No new run starts at the high end load. The generated API declaration
has only property/union/procedure ordering changes; that diff is retained and
the generator output is restored to the candidate's tracked bytes.

The preceding filtered mobile/e2e compiler is green at source`52b7940f9f`,
flatblock WIP`e2bd21033e20dc5d99e80cc6c2453f333d215f29`,
UTC02:29:11.994–02:30:08.336Z, load5.64→7.01:16successful tasks,
no cache hits or bypasses, and216 e2e runtime imports resolve. Focused follow-up
lint is green for8 explicit phone files and2 graph files,
UTC02:27:43.829–02:27:45.669Z atload6.35. Biome's two formatting-only changes
were mirrored back to the issue branch. Earlier92-file phone/7-file graph lint
and compiler evidence remains recorded on the issue.

The stricter quiet-window mail was read here after those runs had finished;
exact timestamps were sent to POD-4286 and POD-5407 for capture-overlap exclusion.
A checkout-scoped process audit finds no surviving Node/Bun/timeout validation
process. The clean rebase onto `d9870eabd9` inherits only its three outbox files;
all phone and graph source bytes are unchanged from that checkpoint. The later
mission rebase changes the empty-deck interface; its focused regressions and
filtered compiler above are green. Earlier admission attempts stopped before
committing or starting the compiler at loads8.58 and8.00; they are not gate
results.

The first production Pixel7 proof attempt reaches the unchanged web bundle
budget guard and exits1 before any browser case. At source`2ba88fc1f4`, flatblock
WIP`94afc49563d3de39ee6ade0873b257667eb1d1a9`,
UTC02:55:29.293–02:58:36.935Z, load7.97→10.19, the guard rejects eagerly loaded
`IssueContextMenu.tsx` and `machine-handoff.ts`. No web/model edit or guard
bypass is made in this lane. POD-4286 assigned the required lazy import repair
to POD-5438 under blocking POD-5476; the duplicate blocker POD-5475 is closed
as moved. Production screenshots/counters and their actual startup-selector
negative control wait for that landing. Strict structural verification and
ON timing remain pending. This report makes no physical-device claim.

The old670-fingerprint work bank's optimisticPress and seed3 pending mark-read
hashes vary with wall-clock queuedAt. The original independent controls fail
those same hashes on unchanged integration while semantic legacy/pool equality
passes. Their expected digests and writer clock remain untouched. POD-5432
confirms the pending readAt is constructed from wall time.

The only banner bank difference is intended recovery copy already changed by
POD-5430 in `edcd56288d`: “They didn’t reach the server. Decide what to do with
each one.” became “Your other changes don’t wait for them. One sent again goes
after them. Decide what to do with each one.” Fresh complete OFF/ON equality on
`b4d0134f17` is green. POD-4286 approved exactly that sentence substitution,
but automatic approval review rejected mutating a frozen expectation without
direct operator authorization. The bank stays unchanged; artifact14 contains
the exact proposed adjustment. No production copy or writer changes are proposed.

DemoProvider's inherited `?demo=1` crash after `b890298e4d` is separately Proposed
as POD-5473. Automatic review rejected switching its replica constructor despite
coordinator approval; the coordinator directed leaving it outside this landing
for operator review. LiveProvider and its storage/sync/outbox factories are
unchanged. The real-server `trpc.repos.list` fallback remains as directed.

The launch descriptor initialization fix was isolated and landed separately as
POD-5449 at `41e907ef043511bcfa21540ddd114e81b08568cc`, with its meaningful
old-order red, focused green, compiler and lint evidence. Final production proof,
ON timing, frozen-copy authorization and fast-forward landing remain outstanding.
