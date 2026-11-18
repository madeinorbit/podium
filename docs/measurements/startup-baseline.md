# Startup baseline

The baseline and the safety check for POD-5592 (First screen before history).
Measurement and test infrastructure only: no product or protocol change.

## Corpus

The startup corpus is the two-axis fixture (`buildCorpusCell`, POD-4747):
history (closed, archived and deleted work and its sessions) and active work
(open issues, live sessions, visible rows, lanes) grow separately. History x10
keeps every active row of the base cell exactly; active x4 keeps every history
row exactly (`tests/worklist/harness/src/fixture/cells.test.ts`). Seeded
PRNG only, no wall clock, no operator data.

`apps/web/harness/old-vs-new-corpus.mjs --cell=<cell> [--seed=4443]` writes the
cell's corpus and the wire rows the cold-start collector feeds the app, as
`.artifacts/old-vs-new/{corpus,rows}-<cell>.json`, and prints their digests.

| Cell | History | Active | Issues | Sessions | Wire rows | Rows SHA-256 (seed 4443) |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `h1a1` | x1 | x1 | 4,867 | 4,304 | 21,958 | `5b65dceb…8069e` |
| `h10a1` | x10 | x1 | 27,601 | 30,611 | 136,128 | `06d70c9c…0ff5` |
| `h1a4` | x1 | x4 | 11,890 | 8,447 | 49,572 | `fbe4793a…4cb18` |
| `h10a4` | x10 | x4 | 34,624 | 34,754 | 163,742 | `da1f49f5…d89252` |

`h10a1` against `h1a1` is the key case: the same active work under ten times
the history. Determinism, shown on flatblock 2026-10-09: two `h10a1` runs with
seed 4443 wrote byte-identical row files (`cmp`); seed 777 wrote different rows
(135,699 rows, `7cd75882…`).

## The "no wrong number" check

`tests/worklist/harness/src/startup/no-wrong-number.ts` asks one fixed list of
questions of a CONTROL pool (the full bootstrap) and a CANDIDATE pool in any
intermediate startup state. Every candidate answer must equal the control's or
be `LOADING` (rule 7 of `docs/agents/frontend-data.md`: here, on its way, or
gone). Anything else is a wrong number.

The questions (`startupQuestions`), over targets picked from the control's rows
(`startupTargets`):

- **first screen**: the sidebar row of each open top-level issue;
- **counts**: issue and session counts, undeleted issues, the board's tab
  counts, proposed issues;
- **search**: command palette issues; per needle, the local text index, chat
  mention matches and the board's search;
- **board archive**: every explorer tab (the closed work sits in `done` and
  `cancelled`) and the archived issues;
- **closed-children progress**: per parent with closed children, the child
  counts question, the issue model's counts, the mission pane's progress and
  the board card's progress.

To use it from a later issue (POD-5595, 5597, 5598, 5599):

```ts
const qs = startupQuestions(startupTargets(feed.rows))
const report = checkNoWrongNumber(ask(controlPool, qs), ask(candidatePool, qs))
assertNoWrongNumber(report, 'active rows painted, history arriving')
```

`startup-states.ts` opens the real engine's pooled feed on a cell and builds
the states this issue proves the check on: `fullPool` (control),
`partialPool` (active rows only, no markers) and `lazyPool` (the production
lazy pool on the whole feed, before and after `hydrateAll`).

Results on `h1a1` (flatblock, 2026-10-09, candidate `561a53b930` rebased onto
pilot `2c4e3bd21e`; `no-wrong-number.test.ts` and
`no-wrong-number.lazy.test.ts`), answers per group as equal / LOADING / wrong:

| Candidate state | First screen | Counts | Search | Board archive | Closed children |
| --- | --- | --- | --- | --- | --- |
| Second full bootstrap | 24 / 0 / 0 | 5 / 0 / 0 | 13 / 0 / 0 | 9 / 0 / 0 | 96 / 0 / 0 |
| Partial store, no markers | 23 / 0 / **1** | 1 / 0 / **4** | 1 / 0 / **12** | 0 / 0 / **9** | 18 / 0 / **78** |
| Lazy pool, history cold | 23 / 1 / 0 | 5 / 0 / 0 | 13 / 0 / 0 | 9 / 0 / 0 | 62 / 34 / 0 |
| Lazy pool, history loaded | 24 / 0 / 0 | 5 / 0 / 0 | 13 / 0 / 0 | 9 / 0 / 0 | 96 / 0 / 0 |

The check is armed: a pool given only the active rows, with nothing saying
history is missing, answers smaller counts, misses search hits, shows empty or
short closed tabs and lower closed-children progress (147 questions, 104
wrong). That is the state POD-5597 paints first, and POD-5595's markers must
turn every one of those answers into LOADING. Today's lazy pool stays honest
because its cold index still holds every row the feed carried: its unloaded
rows answer LOADING (first-screen rows and closed-children progress) or from
their declared summaries (counts, search, closed tabs), and after loading
(1,544 rows) every answer equals the control. The second full bootstrap shows
the check is not noisy.

### The policy set with markers (POD-7086)

Since POD-7085 the first download is the policy's collections, so the device
holds the policy set: live, asking and recent sessions, the sidebar and recent
issues, what they come with (parents, a session's issue, a sidebar issue's
sessions that are not archived), every other kind whole, and every issue as a
stub, each collection with its marker. Today's readers read whole records from
the pool (stubs are kept out of it) and do not read markers, so they answer
smaller numbers instead of LOADING. `policySetPool` in `startup-states.ts`
builds this state; `no-wrong-number.test.ts` asserts these answers exactly, so
a change that makes them worse fails. POD-7088 moves the readers onto markers
and stubs and must bring every wrong answer to zero (vega, 2026-11-18, `h1a1`,
seed 4443; equal / LOADING / wrong):

| Candidate state | First screen | Counts | Search | Board archive | Closed children |
| --- | --- | --- | --- | --- | --- |
| Policy set with markers | 24 / 0 / 0 | 0 / 0 / **4** | 0 / 25 / 0 | 0 / 0 / **1** | 39 / 0 / **57** |

The wrong answers: all four counts (issues, sessions, undeleted issues,
proposed); the archived issues; and the child counts, model
counts and mission progress of the parents whose closed children are not in
the policy set (one board card's progress among them). The full list is in
the test's result file, `startup-no-wrong-number-policy-set-h1a1`.

### The moved readers (POD-7088)

POD-7088 moved the counts, the board's columns and closed tabs, and the
closed-children readers onto collections, markers and stubs, and extended the
question list with them: the undeleted count, "first task", the proposal
deck's total, every board column's count (with and without agent tasks), the
archived and closed tabs' counts, and the board card's child counts. The
device's own counts (`heldCount`) are not asked: they are no question of all
history. `no-wrong-number.test.ts` now requires zero wrong answers outside
search in the policy set and in every first-download state; the search
surfaces are POD-7089's and may not get worse (vega, 2026-11-18, `h1a1`, seed
4443; equal / LOADING / wrong):

| Candidate state | First screen | Counts | Search | Board archive | Closed children |
| --- | --- | --- | --- | --- | --- |
| Policy set with markers | 11 / 13 / 0 | 17 / 0 / 0 | 4 / 0 / **9** | 3 / 0 / 0 | 121 / 23 / 0 |
| First download, always and live | 0 / 24 / 0 | 1 / 16 / 0 | 0 / 0 / **13** | 0 / 3 / 0 | 0 / 144 / 0 |

The 13 first-screen answers that are LOADING in the policy set read a record
the device does not hold: these pools have no residency, and since POD-7088
such a lookup asks the loader as a production pool does, instead of answering
"gone". The lazy pool proof (`no-wrong-number.lazy.test.ts`) does not finish
loading within its 16 rounds since the board column questions were added;
that is open.


### Device-first search (POD-7089)

The search group now asks 25 questions: one typed command-palette search, and
local text, mentions, board text, phone link targets, phone Work and shared web
target choices for each of four needles. A device answer stays visible at once;
the search answer declares itself incomplete until its server request succeeds.
The check reads that completeness as `LOADING`, so an incomplete device result
is never mistaken for the full-history answer. Server result IDs go through the
collection loader as cached one-record instances; rows read the shared models.

On the policy set and every first-download state, the search group is
**0 equal / 25 LOADING / 0 wrong**. The focused search check also passes on
`h1a1`, `h1a4`, `h10a1` and `h10a4` (seed 4443), for the first step and the
policy set of each. Its control uses the old full-device local results; an
intentionally corrupted search ID is rejected in every cell. Separate surface
and real-loader tests cover the eventual server answer, offline behavior and
superseded requests. These measurements ran on an agent VM on 2026-11-18. The four-cell proof
is from the initial candidate. The later legacy all-history lazy comparison
still reaches its sixteen-round hydration limit (POD-7110), even after narrowing
the added web/phone questions to IDs and completeness. This remains an open phase-owned validation
failure; the phase coordinator took it after the sibling screen task reproduced
it. The later search follow-up passes 17 palette/shared-picker tests and the
lean gate (165 tests), including the typecheck-cache audit after moving the pure
ID reader into client-graph. That follow-up does not rerun the legacy comparison.

The current sidebar returns a WorklistIssue companion. The check reads its
displayed fields explicitly; recursively serializing its model/view ownership
would encounter a cycle. A regression test requires failed reads, cyclic
answers and duplicate questions to throw, and `ask` requires every question to
produce an answer. MobX reaction errors cannot silently truncate a comparison.
The older pre-rebase report's 118 wrong answers compared the previous sidebar
payload; it is replaced by this complete 147-question proof on the current API.

Memory: the questions are the heavy part (about 0.9 GB of heap to ask them of
a 1x pool); the engine that publishes the feed is dropped once its rows are
read. `PODIUM_STARTUP_MEMORY=1` logs RSS and heap per stage. Both files stay
under the 3 GB worker cap at 1x (lazy proof peak RSS about 2.5 GiB); a 10x run of the check needs the
`meter:flatblock` lease.

## First paint

Web and phone admission is complete: eight unprofiled cold/warm pairs per
cell on each surface, 64 admitted pairs in total. Values below are seconds,
median (minimum–maximum).

| Surface | Cell | Cold Paint | Warm Paint |
| --- | --- | ---: | ---: |
| Web | `h1a1` | 4.69 (3.89–6.61) | 3.74 (2.90–4.73) |
| Web | `h10a1` | 14.44 (12.95–17.30) | 10.47 (9.20–12.61) |
| Web | `h1a4` | 9.36 (8.68–10.92) | 7.27 (6.39–7.85) |
| Web | `h10a4` | 19.62 (17.31–22.51) | 16.13 (13.67–17.50) |
| Phone web | `h1a1` | 4.40 (3.86–5.01) | 3.56 (2.82–4.84) |
| Phone web | `h10a1` | 13.87 (12.73–19.43) | 11.42 (10.28–12.26) |
| Phone web | `h1a4` | 9.06 (8.44–10.32) | 7.78 (6.77–8.39) |
| Phone web | `h10a4` | 19.54 (17.15–21.95) | 15.52 (13.67–17.73) |

The same active work under ten times the history raises observed web cold
median from 4.69 to 14.44 seconds. Individual samples and provenance are in
[web-summary.json](startup-baseline/web-summary.json); the accepted paths and
exclusions are in [web-ledger.json](startup-baseline/web-ledger.json).
Phone samples and provenance are in
[phone-summary.json](startup-baseline/phone-summary.json), with all 32 pairs
admitted from [phone-ledger.json](startup-baseline/phone-ledger.json).

The measured source is `75ec571b04`, on product base `2c4e3bd21e`, preserved
as `refs/measurements/5594-startup-baseline` in the local repository and
flatblock's transfer repository. Later candidate rebases do not change this
baseline. Normal production bundles: web `bundle+CkDtfcea`, phone
`bundle+bb0d20a1d3a22fe327c832d601101ce7`; wire version 4, schema digest
`366458d430049fd2`. Both outputs were built under the heavy lease; subsequent
harness-only commits used the canonical build stamp after verifying unchanged
product source.

Host: flatblock, 8 logical CPUs, AMD EPYC Processor (with IBPB), Linux;
Chromium `153.0.8010.12`. Web viewport: 1800 × 1000. Phone: Playwright's
Pixel 7 preset on the production phone web Work tab. The capture controller
runs locally over SSH; every app, browser, test and build runs on flatblock.
Timing windows yield to the shared census and resume the saved schedule.
The summary retains the individual samples, dates, source and product tree
hashes, load readings and lease windows.

Web round 3's sample block 5 was excluded after `h10a4` logged an abnormal
WebSocket close (1006) and reconnect during its warm navigation. Its cold
24.02 seconds and warm 44.52 seconds are excluded from the table. All four
cells in that block were repeated in the same order, under the same logical
cohort, as round 4. Each cell still occupies every position twice. Original
bytes remain in their capture directories with `EXCLUDED.json`; the ledger
records the reason and each replacement. This is 36 completed web cohort
pairs, 32 admitted pairs and four explicitly excluded pairs. Two preliminary
captures also stopped before completing a pair while correcting the visible-row
observer; neither contributes a sample. No latency-only trimming.

## How to rerun

Run all validation and builds on **flatblock**, in an issue-owned checkout
(`~/podium-test-5594` here). Its `.toolchain/bun` must match `mise.toml`, and
`.toolchain/node` must link to that Bun. Run `bun run setup:worktree` after
updating the checkout; never share a complete `node_modules` tree.

Generate each cell once on flatblock, under `meter:flatblock`:

```sh
.toolchain/bun --conditions=@podium/source apps/web/harness/old-vs-new-corpus.mjs --cell=h1a1
# Repeat for h10a1, h1a4, h10a4; compare independent same-seed output with cmp.
```

Build normal production clients (`bun run --cwd apps/web build`, then
`bun run --cwd apps/mobile build`) using the checkout-local toolchain on PATH.
No diagnostic transforms, production flags or ablations enter this baseline.
Hold `heavy:flatblock` only during each build, one build at a time, after
checking MemAvailable ≥ 6 GiB. The coordinator's shared testing lane owns
the remaining full gates; the two client builds and timing are this issue's
measurement exception.

From the local **issue worktree**, run the lightweight SSH controller:

```sh
python3 apps/web/harness/cold-start-pair.py --cells=h1a1,h10a1,h1a4,h10a4 \
  --checkout=podium-test-5594 --surface=web --samples=8 --round=5 --meter --no-profile
python3 apps/mobile/harness/startup-baseline.py \
  --checkout=podium-test-5594 --samples=8 --round=5
```

Choose an unused round number; rounds 1–4 already contain this baseline's
capture history in the measurement checkout.

The controller holds `meter:flatblock` and `bench:flatblock`, renews both,
and starts exactly one collector process tree at a time. It rotates and
reverses the four cell orders across sample rounds, putting every cell in
every position twice. Each invocation captures one
cold navigation and its warm reload, closes its browser and isolated server,
then gives the next cell its turn. Eight samples per cell, per surface.
When yielding the host to shared gates, `--max-pairs=<n>` pauses after a
complete pair and releases the leases; `--resume` continues the saved prefix
of the same balanced schedule. A local
`.artifacts/startup-baseline/<surface>-r<round>.pause` file also stops admission
of the next pair. Remove that file before resuming. Saved pairs are never
overwritten; the raw captures and summary record each separate lease window.
The phone entry uses the same seeded full-bootstrap feed and Paint collector
as web; its boundary is an unobscured issue row on `/mobile/work`, at Pixel 7
viewport settings. It measures the production phone **web** client, not native
device performance.

Cold means fresh browser context/application storage. Warm retains committed
IndexedDB rows and preferences and resumes its cursor without an augmented
snapshot. Request routing disables HTTP cache for both. The complete seeded
corpus must reach durable storage before each warm reload. Timing ends at an
actual Chromium Paint after the first visible issue row and after the boot
splash disappears, rather than at a DOM mutation or a readiness promise.

The controller writes `.artifacts/startup-baseline/<surface>-r<round>.json`
locally, listing raw remote `run.json` paths. Copy that ledger into the same
path in the flatblock checkout, then summarize there:

```sh
python3 apps/web/harness/startup-summary.py \
  --ledger=.artifacts/startup-baseline/web-r5.json \
  --out=.artifacts/startup-baseline/web-summary.json
# Repeat for phone-r5.json and phone-summary.json.
```

The summary reuses `cold-start-guard.py`'s provenance, full-population and
browser-error checks, requires eight unprofiled cold/warm pairs, and reports
median and min–max spread. It does not certify the existing 2.5-second startup
budget. Raw traces remain next to each remote ledger.
The raw browser messages are retained. Admission recognizes the fixture's
blocked-service-worker messages and the phone web build's exact React Native
native-animation warning (its documented JS fallback). Changed warnings and
application errors still reject the capture.

`flatblock-budget.py` wraps each capture in foreground, admitting it only at
MemAvailable ≥ 6 GiB and SwapFree ≥ 2 GiB. The memory-heavy corpus uses the
operator's census exception under the measurement lease: stop below 1.5 GiB
available or 2 GiB swap free. Ordinary Vitest workers stop above 3 GiB RSS.
Only recorded process IDs whose session and start time still match are stopped;
resource observations are saved beside each collector log.

Correctness and fixture proof use focused files through the repository lane:

```sh
bun run test:file -- tests/worklist/harness/src/fixture/cells.test.ts scripts/cold-start-guard.test.ts
bun run test:file -- tests/worklist/harness/src/startup/no-wrong-number.test.ts
bun run test:file -- tests/worklist/harness/src/startup/no-wrong-number.lazy.test.ts
```

Run those commands sequentially. The normal landing evidence is the lean gate,
full typecheck, interaction scan check, normal web build, and structural census
under `meter:flatblock`. POD-5895 runs the shared full gates; submit the candidate
to POD-4286 rather than starting a competing run. The report records what
actually ran.

## Verification

The startup code range through `22fa58d60e` landed in POD-5895's green shared
batch at `899243cf31`. Its [gate receipt](startup-baseline/gate-receipt.json)
records the checked tip, commands, exit codes, resource observations and
fast-forward landing. The full original receipt is also issue artifact
`.artifacts/5895/batch2/gate-summary.json` on POD-5895.

| Check | Result |
| --- | --- |
| Two-axis fixture and original guard files | 17 fixture tests + 6 guard tests passed |
| Full and unmarked partial startup states | 5 tests passed; all 147 questions answered; 104 wrong answers exposed in partial control |
| Lazy startup state, before/after hydration | 1 test passed; 112 exact + 35 LOADING before; all 147 exact afterward |
| Lean gate and full typecheck, shared batch | Lean gate green; both commands exited 0 |
| Interaction scans, shared batch | Green; 0 ratchet errors |
| Normal web build and production renders, shared batch | Green; render receipt reports no page errors |
| Structural census, shared batch under meter | 30 passed, 7 filtered skips; exit 0 |
| Final focused guard file | 7 tests passed on flatblock at `85f7ca1307`, including strict phone warning admission |

Span-effects, MobX-private, untracked-reads and clock-read checks passed on
the batch's full superset and were reused after dropping the rejected mission
range. The final lean, full typecheck, interaction scan, web build, renders and
structural census ran on the landed green stack. This records focused and
lean evidence; no full-suite sweep was run for this issue.

Earlier local-lane lean attempts produced no gate result: checkout admission
found stale generated declaration directories, then two attempts stopped at
the resource floor during generation/typecheck. Those logs remain in the
flatblock checkout; the shared green result supersedes them. The final timing
and report work changes no product code, so the coordinator explicitly waived
another heavy run.
