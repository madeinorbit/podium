# Legacy issue retention (POD-4970)

Measured on 2026-10-02 for step 4 of POD-4949. Dropping the old `issue` record
saved **39.8 MiB on the operator replay**: **35.0%** of retained V8 heap with
the legacy sidebar and **23.7%** with the pool sidebar. The measured percentages
are below the epic's approximately 40% estimate. On the synthetic corpus the
saving was **2.3 MiB at 1×** and **9.1 MiB at 4×**.

All 30 before/after model and sidebar comparisons matched. Every dropped arm
kept all issue projections and retained **zero** old issue records.

## Retained heap

Medians of five fresh browser contexts per arm. MiB means bytes / 1,048,576.
Each comparison changes only `dropLegacyIssues`; the sidebar mode stays fixed.

| Data | Sidebar | Old rows before → after | V8 before (MiB) | V8 after (MiB) | Saved (MiB) | Saved |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Operator | Legacy | 5,729 → 0 | 113.79 | 73.96 | 39.83 | 35.00% |
| Operator | Pool | 5,729 → 0 | 168.03 | 128.21 | 39.82 | 23.70% |
| Corpus 1× | Legacy | 4,867 → 0 | 29.81 | 27.52 | 2.29 | 7.70% |
| Corpus 1× | Pool | 4,867 → 0 | 65.75 | 63.40 | 2.35 | 3.57% |
| Corpus 4× | Legacy | 19,468 → 0 | 90.89 | 81.82 | 9.07 | 9.98% |
| Corpus 4× | Pool | 19,468 → 0 | 222.44 | 213.31 | 9.12 | 4.10% |

The largest five-sample range within any arm was 0.10 MiB on flatblock and
0.09 MiB on ludovico. The operator's old records free about 7.3 KB per issue;
the corpus frees about 0.5 KB per issue. The corpus therefore reproduces the
retention behavior but understates the byte saving on the operator's content.

## Method and provenance

The capture uses the production sidebar fixture from
[POD-5133's memory breakdown](POD-pool-memory-breakdown.md): real
`StoreProvider`, kernel facade, IndexedDB store and outbox, plus
`SidebarUnified` and its command palette. Both arms use the same production
Vite build, with no minification or source maps, an offline API, seed 4443 for
the corpus, and `Date.now` anchored at 2026-09-20 noon.

| Property | Corpus | Operator replay |
| --- | --- | --- |
| Host | flatblock | ludovico |
| Browser | Chromium 153.0.8010.12 (build 1243) | Chromium 151.0.7922.34 (build 1234) |
| Capture SHA | `ce85a8b375260f1d1f4814519a5a9702e15acbe0` | `d178234a28a0ace168c269f0416351899898af3d` |
| Samples per arm and sidebar mode | 5 at each of 1× and 4× | 5 |
| Normalized issue rows, unchanged | 4,867 / 19,468 | 5,729 |
| Session view rows, unchanged | 4,302 / 17,208 | 5,054 |
| Visible sidebar rows, unchanged | 194 / 775 | 262 |
| Before/after comparisons | 20, zero differences | 10, zero differences |
| One-minute host load range | 1.03–3.15 | 3.50–6.88 |

Capture SHAs differ only by empty checkpoints. The corpus timing lease
`bench:flatblock` was held throughout its capture and released afterward.
Compare each before/after pair on its own host; the absolute heaps across the
two browsers are separate measurements.

The driver alternates which arm runs first and creates a fresh isolated
browser context for every sample. It waits for fonts, two animation frames,
then three consecutive stable model/sidebar/visible-row hashes 250 ms apart.
An initial capture stopped on the pool's unsettled visible window; only the
subsequent settled capture is included above.

The construction corpus and seed rows are released **before every heap sample**.
After a 500 ms wait, the driver forces two collections 150 ms apart and reads
`Runtime.getHeapUsage.usedSize`. Releasing the input is necessary here: otherwise
the fixture itself would keep the old records alive after the app dropped them.
POD-5133's V8-usage samples preceded its fixture-input release, and its product
tree also predates this cutover, so its absolute totals are not this control arm.

For parity, the browser hashes all normalized issue view models, sidebar text
and ordered visible issue-row attributes. Only comparison counts and byte/row
totals are published. The operator export used the existing `readLive` bootstrap
and discovery/pins path, once, and was replayed through `corpusFromLive`. That
adapter upgrades older projection spellings for description, draft, origin and
asked, and supplies an older repo's missing path from its issue rows. Both arms
use exactly the same converted input.

The operator bootstrap contained 5,729 issue rows, 5,729 projections and 5,064
session rows. It contained zero `issueUserState` or `issueGitState` rows; those
empty arrays were preserved. The sidebar fixture seeds issues, projections,
personal/git rows, sessions, repo rows and dependencies. Other bootstrap kinds
and main panes are outside this measurement, as in the POD-5133 fixture. These
numbers describe the retained heap of this offline production-sidebar replay.

The private operator input was written with mode 0600, remained on ludovico,
and was **deleted after capture**. No operator payload, row ID, title, text or
heap snapshot was copied, committed, attached or mailed. Published evidence
contains only counts, byte totals and capture provenance.

## Storage behavior and validation

The feed still delivers the old record. `dropLegacyIssues` defaults true in
the web composition root and false in shared/mobile replica constructors.
Web IndexedDB filters the kind on snapshot and delta ingest, and retires old
disk rows while opening an existing cache. The facade's `issues` collection is
empty. Legacy replica bootstraps also omit the kind and advance their cursor
past discarded buffered changes. Other kinds and authored outbox rows keep
their existing behavior; opening an older cache needs no schema reset.

All checks ran on flatblock in `~/podium-test-4970`, using checkout-local
dependencies and Bun 1.4.2. The operator capture above is the explicit local
offline-data exception.

- POD-4968's normalized-reader prerequisite: 9 tests green, its landing is an
  ancestor of this issue, and `temporary-issue-input.ts` is absent.
- Focused compatibility results: 17 files covering 233 tests, including legacy
  replica/bootstrap, kernel facade/binding, normalized optimism and rollback,
  IndexedDB storage/crash/quota/conformance, HTTP bootstrap, cross-tab rescope,
  attribution, outbox and migration. The affected files were green after
  correcting test setup; this is focused evidence, not a full web-suite run.
- The new offline-cache test opens a real web assembly over an older IndexedDB
  cache with both issue representations. It compares normalized models and the
  production `IssueListView` and `IssuesKanban` before/after reopening with the
  web default. Cursor 10 and both screens survive, old rows disappear, and a
  subsequent old-only frame advances the cursor to 11 without restoring them.
- New retention tests also cover defaults, unknown-kind leniency, principal
  isolation, queued writes, abort, eviction versus deletion, readmission and
  replacement/rescope. All **14 planted defects** caused assertion failures;
  restoring the source returned the new tests to green.
- `bun run test:perf:frontend`: **5 files, 29 tests green**, with the benchmark
  cache and facade dropping the old kind.
- Uncached affected compiler graph: **16 tasks green, zero Turbo cache hits**,
  using the epic's required `--uncached-because` exception. The revised memory
  fixture was included in the final web compiler check.
- Scoped Biome and `lint:span-effects` green; the latter checked 162 span bodies
  and reported zero unclassified effects.

The 14 plants removed the adapter policy, hydration filter, disk retirement,
snapshot filter, delta filter, web default, kind policy, legacy-blob isolation,
legacy-snapshot guard, bootstrap staging guard, bootstrap buffer filter,
buffered-cursor accounting and addressed-row guard, and broke the shared
keep-all default. Counts-only evidence records each assertion failure and
the restored green exit.

## Rollback and reproduction

To restore retention, dispose the current assembly and reopen it with
`dropLegacyIssues: false`, then call `assembly.feed.requestRebootstrap()`.
A full snapshot restores the retired old rows while preserving authored
outbox entries. Merely resuming the old cursor would leave previously retired
rows absent. Shared/mobile callers continue to retain the old record by default.

Build once, then run captures in the foreground with a timeout and a checkpoint
before each run:

```bash
timeout 300s bun --conditions=@podium/source apps/web/harness/pool-memory.ts --phase=build
# On flatblock, with bench:flatblock held:
timeout 1500s bun --conditions=@podium/source apps/web/harness/legacy-issue-memory.ts \
  --lease-confirmed --samples=5
# On ludovico only:
timeout 180s bun --conditions=@podium/source apps/web/harness/legacy-issue-memory.ts --export-operator
timeout 900s bun --conditions=@podium/source apps/web/harness/legacy-issue-memory.ts \
  --operator=packages/worklist-proto/harness/.live/POD-4970-memory-input.json \
  --out=.artifacts/legacy-issue-memory/operator-counts.json --samples=5
# Delete the private input after replay; publish only the counts files.
```

The issue artifacts contain this report and a combined counts-only JSON with
all 60 retained-heap samples and the 14 mutation proofs. The report belongs in
the repository; the copied evidence artifact outlives the temporary captures.
