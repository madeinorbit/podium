# Phone target search memory

The compact source scan gives back **13.00 MiB at 1x and 51.16 MiB at 4x** of
startup heap, equivalent to 87.4% / 87.6% of POD-5487's measured 14.876 / 58.373 MiB
rise. At 4x, the first text question takes 6.2 ms median / 7.4 ms maximum, and
typing takes 3.6 ms median / 6.5 ms p95. Exact before/after comparison preserves
all 6,780 ordered search and roster answers exercised on the synthetic corpora.

## Design decision

Choose option (b): one ordered ID array per repository path, plus a compact
record of each eligible issue's sequence, normalized title, repository identity
and normalized sequence text. The record replaces the old sequence-order value
and full-title facet. It does not retain a row or a pool model.

Title/ref uni-, bi- and trigrams, sequence-prefix facets, their membership Sets
and their duplicate ordered posting arrays are removed. Empty-query opens,
existence checks and unfiltered pagination stop after the requested window.
Nonempty questions scan the queried path's compact scalars and stop at the
requested result limit. Ordering remains descending sequence, then ascending
ID. Reference matching still requires a digit, uses the current joined repository
prefix, strips punctuation, and combines with exact title-substring matching.
Edits, repository moves, deletion, eviction and replacement update the same
path revisions as before. Text edits now advance only their path publication;
there are no private text-membership clock increments to pay for.

The representation is O(eligible issue count + title text), with one scalar
record per issue and one ID per path membership. It removes the per-gram and
per-prefix amplification rather than claiming constant space for the source's
entire history. There is no query cache or open-search lifecycle to keep alive.
The command roster facets are retained: they have separate declared consumers,
and their removal is unnecessary to recover most of the measured rise.

The alternatives were measured in real Chromium on the largest repository in
the same corpus. The lazy prototype starts without text facets, then replays
only the queried repository's issues into the existing posting builder on first
text demand. It is a concrete implementation estimate including scalar filing,
not a claim that all possible lazy layouts have this cost.

| Representation | First text, 1x ms | First text, 4x ms | Typing p95, 1x ms | Typing p95, 4x ms |
| --- | ---: | ---: | ---: | ---: |
| Eager postings | 0.1 | 0.1 | 0.1 | 0.1 |
| Lazy existing postings | 298.7 | 3,032.6 | 0.1 | 0.1 |
| Scan general facet Sets | 5.3 | 24.3 | 5.2 | 26.2 |
| Final compact scalar scan | 1.4 | 6.2 | 0.4 | 6.5 |

The deferred posting builder exceeds the coordinator's 100 ms opening target.
Scanning general Sets also spends too long finding and slicing the title facet
on each row. A compact scalar record makes the scan fast enough without gram
postings. A server-backed question would add a transport/replica synchronization
boundary; the existing declared source question meets the measured budget.

The final search-index publication benchmark is 22.1 / 113.6 ms at 1x/4x versus
420.7 / 3,710.5 ms for the eager builder in the original design run. These are
isolated reader-index timings, not full application startup timings.

## Heap proof

The unchanged `apps/web/harness/pool-memory.ts` ran the pool arm at 1x/4x, three
fresh contexts per cell, with the existing GC procedure and one compressed
snapshot per cell. The following are original `Runtime.getHeapUsage().usedSize`
readings, before releasing fixture construction inputs, in MiB.

| Cell | Before samples | Before median | After samples | After median | Saved |
| --- | --- | ---: | --- | ---: | ---: |
| 1x | 120.609, 120.616, 120.632 | 120.616 | 107.561, 107.643, 107.616 | 107.616 | 13.000 |
| 4x | 435.005, 434.968, 435.005 | 435.005 | 383.722, 383.877, 383.845 | 383.845 | 51.161 |

Before: `b7ae303013d2252c533c9a75fc85bfaaae5380cd`, a report-only WIP on
POD-5498's landed `545ca1d4fc`. After:
`d4be302ac0f2cc31f3f388aa8be09b8359dcae84`. The reader source blobs are
`6aad344aca31e72fb22daa0b279cd5b2836b63fc` and
`e5ca0db94ca66aa43f0a794386f1d547b2de20bf`. A later test-only type correction
and rebase onto POD-5423 leave the measured runtime source blob unchanged.
These matched measurements do not attribute POD-5495, POD-5498 or POD-5423's
separate changes to this saving.

The pool's placed rows are identical before and after: issue/session/worktree/
repo counts 2,795/1,432/485/11 at 1x and 10,917/5,969/1,889/11 at 4x. The heap
fixture's corpus has 4,867 / 19,468 issues and 4,302 / 17,208 sessions in its
effective feed. No historical rows are materialized to answer text questions.

## Search and work proof

The exact comparison bundles both the pre-change reader and final reader into
the same browser, feeds each identical rows, and compares the returned arrays
without sorting them. It exercises 246 / 229 distinct queries at 1x/4x, limits
0/1/14/70, and nine archive/shell roster filters over sampled issue IDs. The
same comparisons repeat after a rename and sequence change, repository move,
eviction and session archive update, then principal replacement: 3,492 / 3,288
equal answers.

The committed focused tests also use an independent ordered substring oracle
over mixed repositories, digit-bearing and absent prefixes, sequence ties,
deleted and archived rows, Unicode/case/whitespace, repeated and false gram
matches, fractional/negative/NaN/infinite limits, and publications. A storage
probe rejects any title, gram or sequence-prefix facet/Map entry across all
declared question kinds, searches, edits, removals and replacement.

An empty-query window still visits 15 IDs for 14 results at both scales,
including the excluded owner. Text scans visit only their requested path's
source scalars; a counted source-row proxy proves they never read publication
rows again. The pool keeps the existing one-row reader, resident-only indexes,
declared cold-question bridge and absent = `LOADING` plus batched-load behavior.
The mobile picker API and row-loading path do not change.

Final validation ran on `f5d12b46a8717962a7b1b223478b5c4e2c2deb4f`, after the
test-only correction and rebase onto `efe63b9cc6`. Focused client-graph typecheck
is green (9 tasks, 8 cache hits). The named file gate executed **40 passing
tests in four files**, with 11 intentionally unselected tests skipped. Its
footer reports `2 groups, 0 failed — 4 files named; this is not a suite result`.

```sh
bun run typecheck -- --filter @podium/client-graph
bun run test:file -- \
  packages/client-graph/src/shared/mobile-issue-targets.test.ts \
  packages/client-graph/src/reader-queries.test.ts \
  packages/worklist-proto/harness/src/work-per-change.test.tsx \
  apps/mobile/src/components/IssueTargetSheet.test.tsx \
  -t 'mobile target identity question|readers behind declared cold questions|pool screens work ratios|IssueTargetSheet scale boundary'
```

The structural capture covers **47 reader projections × 9 clicks/deltas × two
scales**, evaluating 1,558 counters. It reports zero unexpected failures and
337 existing, named exceptions. The legacy whole-data control remains red as
intended, so the meter's negative control is intact.

A direct comparison with POD-5423's saved `efe63b9cc6` capture finds **no
per-reader row, derivation or collection-element increases** for any action at
either scale. Aggregate row calls and derivations are identical in all 18
cells. Collection elements and visits are identical for eight actions and
decrease by 38 elements / 384 visits for reference navigation, at both scales.
This is before/after evidence in addition to the growth-ratio check; the
existing exceptions are not claimed fixed by this change.

## Latency method and limits

Chromium 153.0.8010.12, flatblock, Bun 1.4.2, seed 4443. The search corpus has
4,867 / 19,468 issues and 4,304 / 17,216 sessions; the largest path contains
3,928 / 15,651 issue rows. Final first-search measurements use seven fresh
indexes per scale. Per-key timings use 12 queries × 10 loops × 7 indexes (840
samples per scale), including short text, missing matches, an exact title,
sequence substring and joined reference. Each call returns at most 14 IDs.

| Final question timing | 1x ms | 4x ms |
| --- | ---: | ---: |
| Empty-query open, median / maximum | 0.1 / 0.3 | <0.1 / 0.1 |
| First text, median / maximum | 1.4 / 2.4 | 6.2 / 7.4 |
| Per key, median / p95 / maximum | 0.2 / 0.4 / 0.8 | 3.6 / 6.5 / 13.3 |

Sub-0.1 ms values are below this browser clock's resolution. These are the
declared question's synchronous times, excluding React rendering, network
transport and row hydration. Sparse text questions are deliberately linear
in the queried path; ordinary empty-query clicks remain bounded. The corpus
and measured scale are synthetic evidence, not an on-device timing claim.

## Reproduction and evidence

Every executable ran in foreground SSH in `~/podium-test-5500` on flatblock,
using its own copied `.toolchain` and checkout-local dependency links, installed
first with `bun run setup:worktree`. Commands select Bun from that copied
toolchain; no other checkout's dependency tree or Bun installation was changed.
Each measurement run held `podium lock acquire meter:flatblock --wait --ttl 45m`
and released the lease immediately on process exit. No stashes or process-wide
kills were used. POD-5498 was confirmed landed and the branch rebased before
the first product edit; POD-5497's files were not edited.

Heap commands, at each measured SHA after checkout:

```sh
export PATH="$PWD/.toolchain:$PATH"
export LD_LIBRARY_PATH="$PWD/.toolchain/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
bun apps/web/harness/pool-memory.ts --phase=build
bun apps/web/harness/pool-memory.ts --phase=capture --lease-confirmed \
  --cells=1x,4x --arms=pool --samples=3 --out=phone-search-before
# Use --out=phone-search-after for the final reader.
```

The issue's evidence bundle contains the raw heap samples, provenance and
summary, all latency samples, exact-parity counts and runner, measurement-only
source prototypes, the before/after structural captures and comparison, and
the focused validation log. The unchanged probe's
full gzip snapshots and metadata remain on flatblock under
`~/podium-test-5500/.artifacts/pool-memory/phone-search-{before,after}/`.
The artifact runner is `.artifacts/phone-search/latency.ts`; use no flag for the
design run, `--compact-only` for the refined prototype, and `--product-only` for
the final implementation and exact parity check. The archived prototype sources
are frozen from the post-POD-5498 baseline; regenerating them from the final
source is not a reproduction of the alternative designs.
