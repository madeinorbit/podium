# POD-4446 NOTES — hand-rolled arm, milestone 1

## Decisions

- **Buckets hold ids, not objects.** A content-only session change moves no
  bucket, so the unrelated heartbeat costs zero index writes, zero
  derivations, zero commits. Objects are borrowed by reference from the
  stream and never spread on the hot path.
- **Archived sessions sit in membership buckets, filtered at read.**
  `membersOf` excludes archived + shells + headless (the legacy ownership
  read); the unread rollup reads explicit seats minus shells with archived
  included (the replica `indexSessionsByIssue` rule). One seat system, two
  reads — verified against the oracle (i49: archived member session,
  replica-derived unread keeps the finished row visible in its 7-day window).
- **Issue `unread` is derived, never trusted from the wire.**
  `derivedUnread` replays `deriveIssueRollups` exactly (readAt vs updatedAt
  vs member activity; deleted reads as read). The seed wires carry a static
  `unread: false` that disagrees with the replica derivation — trusting it
  failed parity on i49 at SMALL.
- **Subtree = visible formal subtree for attention, live formal subtree for
  progress.** Started-by provenance nesting is out (spec §6); the corpora
  carry no `startedBySession`, so formal-only matches legacy exactly here.
  Spin-off tip / vacated-origin / continuation machinery is still
  implemented (fixture + seeds carry `discovered-from` edges and it feeds
  rollup units + review-withdrawal), reading the maintained R4 adjacency —
  never a table scan.
- **Snapshot is the unselected baseline.** `snapshot()` always projects with
  `(null, false)` selection like the oracle; the closed-fold latch applies
  to rendered placement only (`setSelection` recomputes the two rows'
  lanes). Engine-driven selection is invisible by row-source design
  (locals-only publications emit no event), so the engine-backed click
  commits 0 rows; the UI click path commits exactly the two rows whose
  selected-ness flips, with 0 derivations (both evidenced in tests).
- **Agent-audience rows need a visible formal host.** The legacy nesting
  pass drops top-level agent rows ("internal issues: nested only"), and the
  oracle flattens what survives — so the flat slice drops agent rows with
  no visible formal ancestor (250 at 1x fixture: 211 rows, matching the
  control exactly). Walk passes through invisible intermediates; the
  started-by fallback is out (spec §6) and absent from the corpora.
  Rescued rows host in a second round (legacy nests after rescue).
- **Merge decisions and awaiting-merge never fire in the worklist.** Both
  read `branch`/`gitState`, which the navigation model never carries
  (`deriveIssueViews` drops them), so the legacy slice only ever decides
  `review`. The arm matches legacy (spec: legacy wins over shorthand) —
  reading the richer wire would fail parity. Same for `dependents`, which
  the arm re-derives from outgoing edges like the model does.
- **`closed` is the fold predicate, not the lane.** Pinned settled rows
  read `closed: true` while rendering in PINNED (the oracle projects
  `rowInClosedFold` directly).
- **Notifications count batches.** `notifications` = dispatch passes (one
  batch = one pass), including no-op passes — the heartbeat records
  `notifications: 1` with zero commits and zero derivations.
- **`rollupsDerived` counts every derivation body execution** (own-summary,
  subtree-aggregate, visibility-predicate). `rowsDerived` counts committed
  rows (new + changed + removed). `indexUpdates` counts mutating bucket
  writes. Bootstrap counts are reset after construction.
- **Native renders full in a ScrollView for M1** (same as the control lane,
  so counts compare directly); the web list is genuinely windowed.
  FlatList recycling is named M3 hardening (open question below).
- **No `@tanstack/react-virtual`.** Windowing is ~40 lines hand-rolled;
  a new dependency for that would cost more than it saves and risk the
  native-incompatible budget.

## Count tables

### 1x engine-backed (GROWTH_CORPORA.x1; 4,867 issues / 4,304 sessions / 500 repos; 3,230 visible rows; `hand-1x-counts.json`)

| Scenario | Rows committed | rowsDerived | rollupsDerived | indexUpdates | notifications | Parity |
|---|---|---|---|---|---|---|
| #1 unrelatedHeartbeat | 0 / 3230 | 0 | 0 | 0 | 1 | green |
| #2 visibleSessionPhaseChange | 1 (i0) | 1 | 3 | 0 | 1 | green |
| #3 selectionClick (engine path) | 0 | 0 | 3¹ | 0 | 1 | green |

¹ The eager mark-read row: readAt moves no summary/visibility/aggregate
value, but the three input checks proving that execute. Zero value changes.

### UI click path (happy-dom, `hand.ui.test.tsx`)

| Action | Rows committed | rowsDerived | rollupsDerived |
|---|---|---|---|
| setSelection A→B | 2 (A, B) | 0 | 0 |
| Phase change on B (chain A+B) | 2 (A, B) | 2 | chain |

### SMALL engine-backed

Identical shape: heartbeat 0/37 all-zero, phase 1 row (i0) + chain of 1,
click 0 rows + 3 evaluations, parity green throughout, rebuild oracle green
after every scenario.

### G2 fixture at 1x (engine-booted, `hand.fixture.test.ts`)

211 visible rows — exactly the control's set. Full-snapshot deep-equal with
`snapshotFromStore` (rows, order, groups) plus the rebuild oracle. This is
the corpus the browser pages measure; the scenario corpora above exercise
the change paths, this one exercises the rule surface (nesting drops,
decay windows, closed fold, defer bands, pinned lanes).

### Browser (1x click input-to-paint)

- Readiness + parity in Chromium (no timing): hand page boots at 1x
  fixture, `snapshotHash` **matches the control exactly** (`6365b567`,
  211 rows), 17/211 rows mounted (windowing verified: 1000px viewport,
  18kpx scroll height).
- Wall timing: first attempt 01:31 at load 14.78 (refused — above 8);
  second window 02:05 at load 5.0 but the G4 driver's serve path 404d
  (fixed: `entries/` fallback in `run.ts`, committed); load then 9.15.
  p50/p95/max table lands when a quiet window holds — counts above are
  the verdict meanwhile.
- Driver note for other arms: `run.ts` `serveDist` did not match vite's
  `dist/entries/` layout (`/hand.html` 404d, page never ready). Fixed
  with an `entries/` fallback; control page unaffected.

## Line count (arm folder, `wc -l`; tests excluded)

3,237 total / 2,801 code-only vs the 800–1,500 budget — OVER, openly.
Breakdown (total): rules ~500, indexes ~480, rollup ~470, visible ~340,
store ~340, groups ~220, summary ~170, order ~150, react ~180, rows ~130,
rebuild ~90, deltas ~80, tables ~70, arm ~50, native ~70.

Where the weight is: faithful transcription of 8 legacy rules with decay
windows, continuation/vacated spin-off graph, rescue chains, closed-fold
grace, prefix containment, merge decisions (defensive wire reads) — plus
~250 lines of exhaustive-switch arms the brief's own definition mandates
(one per handler per kind). Compression applied: archived-in-bucket killed
a whole seat system; member lookup shared; store dispatch unified. Further
compression is comment-trimming, not structure — deferred to H4 review.

## Open questions for H4

1. Line budget vs fidelity: is 3,237 lines (2,801 code) acceptable for a
   parity-exact slice, or should M2 compress (and what may be dropped)?
2. Native windowing: ScrollView-full is fine at 211–3,230 rows in the unit
   renderer; does H4 want FlatList recycling with device evidence?
3. `rollupsDerived` semantics: currently every body execution (including
   vacuous input checks). Keep, or split classification from derivation?
4. Engine-driven selection is invisible to arms by row-source design — the
   #3 budget's "2 rows" only manifests on the UI click path. Confirm this
   reading for the MobX/TanStack arms before they build the wrong probe.
5. Defensive wire reads (`branch`, `gitState`, `name`, `busy`,
   `supersededBy`, `dependents`) are absent from `SliceIssue` but present
   on engine rows and required for parity (merge decisions, draft titles).
   Should the slice type grow them, or is defensive reading the idiom?
