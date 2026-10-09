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

The timing matrix is collecting. Eight unprofiled cold/warm pairs per cell
are required before reporting a median.

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
  --checkout=podium-test-5594 --surface=web --samples=8 --round=1 --meter --no-profile
python3 apps/mobile/harness/startup-baseline.py \
  --checkout=podium-test-5594 --samples=8 --round=1
```

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
  --ledger=.artifacts/startup-baseline/web-r1.json \
  --out=.artifacts/startup-baseline/web-summary.json
# Repeat for phone-r1.json and phone-summary.json.
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
