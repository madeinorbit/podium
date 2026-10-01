# POD-4955 — real sidebar pool renderer

The real `SidebarUnified`, its existing rows and folds, and `SidebarRail` now read the app-owned MobX pool when the startup switch is on. The default remains legacy. Synthetic renderer parity, S5, responsive filtering, displayed-row isolation, browser ownership and the closing gates are green. Operator-data parity work is tracked separately by POD-5063 and POD-5056–POD-5060; this report does not claim that their pending integration is complete.

## What changed

The startup choice selects separate mounted hook trees. Legacy keeps its existing derivation and markup; graph modules and the pool attachment remain lazy. Reload with `?mobxSidebar=1` to request the pilot, or `?mobxSidebar=0` for legacy. `mobxSidebarCheck=1` additionally enables the existing S5 diagnostic. The flags never change under mounted hooks.

The pool list reads ordered section IDs and feeds stable slots into the existing `useRowTransitions`. Individual observers supply presentation facts to `UnifiedIssueRow`, `UnifiedWorktreeRow` and `PanelRow`; their markup, menus, folds, search field, NewTaskRow and motion remain the existing components. Computed equality uses displayed fields, so changing placement or transport geometry does not redraw a row body. Guest teardown guards receive the pool's working fact instead of subscribing to the whole legacy session roster.

Search checks the pool's live sidebar rows, including pinned rows and guest lanes, and excludes the archive folds from its count. The collapsed rail reads a composed waiting count maintained by the pool. Project management and the palette use pool section projections. The forbidden-slice test opens those companions and throws if any pool path reads `worklistSlice`.

Reads use `pool.row` or the sidebar model's reader; no new peek caller, per-entity listener, corpus-array row prop, runtime, replica or outbox was added. Existing cold-row behavior remains LOADING with a batched load. Navigation and mutations use the app runtime's existing gesture batch, actions and outbox, including exited-session pane candidates and archived/headless exclusion.

The app attachment clears its stopped S5 callback during teardown. Browser GC also crosses a task between collections: MobX's FinalizationRegistry disposes abandoned-render reactions asynchronously. A synthetic heap trace identified that owner; no operator data was used for debugging.

## Chromium acceptance

`bun run test:sidebar-renderer -- --rows=674 --check-s5` ran in the foreground on flatblock at `38d3673b9`. It mounted the real sidebar and controls over one synthetic StoreProvider runtime per page, with network disabled. Both pages used the same fixture schema, CSS, fonts, viewport and reduced-motion setting.

The fixture has 674 issues, 674 attached sessions and two guests. Its nested, pinned, snoozed and closed cases produce 670 initial issue row bodies and a live filter denominator of 671. The script compares ordered IDs, text, selection, classes, height, font and colours; band and fold text; filtered output; incoming-update paint; rail output; and issue/guest navigation. The title update runs after filter-clear has restored all rows and crossed paint.

| Observation | Legacy | Pool |
| --- | ---: | ---: |
| S5 | Off | Match, 0 differences, 1 comparison |
| Single issue click to next paint | 867.6 ms | 59.6 ms |
| Row bodies committed in the title-update window | 1,340 | 1 |
| Recorded row/derivation main-thread work in that window | 55.2 ms | 2.3 ms |
| Principal change ready | 1,740.5 ms | 945.9 ms |
| Configuration rebuild ready | 1,598.9 ms | 975.6 ms |
| Sign-out dispatch | 67.9 ms | 109.7 ms |
| Whole-page heap after principal change and GC | 71.4 MB | 84.5 MB |
| Whole-page heap after configuration rebuild and GC | 71.6 MB | 87.4 MB |
| Whole-page heap after sign-out and GC | 32.3 MB | 33.8 MB |

The pool's retired pool, tables, relations, worklist, groups, clock and residency objects had **zero survivors** after each principal/configuration/sign-out boundary. Readiness is measured separately from the existing one-second motion tail and the GC/finalizer task boundary.

These are single synthetic development-browser observations, not a distribution or a production speed claim. Pool heaps include the opted-in S5 diagnostic. The measurement shows a larger whole-page footprint while mounted; memory reduction and a resident-row cutoff are not established by this change. Pool computation executions and legacy whole-worklist derivations have different granularity, so their raw derivation counts are not interchangeable.

The issue artifacts contain both synthetic screenshots and the complete JSON observation. Screenshot performance-panel text can lag its report by one sampling interval; the S5 result above comes from the diagnostic report the driver awaited.

## Displayed-row and filter checks

The provider-backed web tests compare legacy and pool row paint and exercise folds, project management, palette opening, rail reads, issue selection and pane choice. A displayed issue title commits its one row once. Reordering, an unused attached-session name and guest geometry each commit zero row bodies. A displayed guest name commits that guest once. The additional navigation check compares exited, headless and archived candidates with legacy while retaining its sessionless-pane rule.

The responsive-filtering performance file passes for both legacy and the actual pool-backed sidebar at **674 rows**. The urgent input commit still contains all 674 rows and `674/674`; the deferred commit settles to one row and `1/674`. This checks event priority directly, without an elapsed-time threshold.

## Negative controls

Each source plant used a `cp` backup and `cp` restore in this issue's flatblock checkout. A clean diff was required before the next run. No planted fault is committed.

| Plant | Observed rejection |
| --- | --- |
| Mount legacy hooks from the pool sidebar/rail branch | Both selected checks throw `Pool path read worklistSlice` |
| Replace pool row-shell IDs while keeping their text | Unit paint comparison rejects the mismatched IDs |
| Freeze row equality and clear the issue pane target | Displayed-title commit and navigation checks fail |
| Include guest geometry in the displayed projection | Geometry update commits the unchanged guest and fails |
| Exclude exited sessions instead of headless sessions | Pool pane differs from the legacy exited-session candidate |
| Remove deferred filtering | Urgent pool commit has 1 row instead of 674 |
| Zero the composed rail decision count | Both 1x and 4x legacy badge comparisons fail |
| Replace pool status text with a planted string | Chromium rejects initial row paint parity |
| Hold the retired pool on a global | Chromium rejects principal teardown after GC and the finalizer task |

The final persistent-retainer control ran at `61c879361` with S5 enabled. It distinguishes the delayed MobX finalizer from an actual strong owner.

## Closing validation

All tests, typechecks and lint ran sequentially over SSH on flatblock in `~/podium-test-4955`, using pinned checkout-local Bun 1.4.2 and dependency links. WIP checkpoints preceded edit batches and validation. Passed checks were not repeated on unchanged code; failed probes were corrected and their changed checks rerun. No full-suite sweep or live-data browser capture ran.

| Check | Result |
| --- | --- |
| Real sidebar pool web checks | 5 green; displayed commits/filter/rail at `185eb029e`, revised navigation at `86eec70c6`, final row-shell paint/guard at `4695f6004` |
| App pool owner/attachment file | 10 green at `185eb029e`; final cleanup also covered by Chromium |
| Focused pre-existing web files | Eight files green, including row memo, search, shortcuts, rename, bring-back, project management, rail and the pool attachment |
| Rail badge test through the prototype package's own config | 2 green, 1x and 4x |
| Responsive-filtering frontend performance lane | 2 green at `edf3fabb2` |
| Chromium renderer with S5, 674 issues | Green at `38d3673b9` |
| Uncached affected-project typecheck | Graph and prototype green at `9a85512a6`; final web green at `8ccf44e7a` |
| Graph and prototype package lint, merge-shadowing | Green at `8ccf44e7a` |
| Span effects | Green: 158 bodies, 0 unclassified effects |
| Lean gate | **Green: 4 of 1,697 files (0.2%), 153 executed tests** |
| Changed-file Biome checks | No new errors; pre-existing palette exceptions below |

The default gate's typecheck step was replaced by the operator-required uncached affected-project checks, followed by its span-effect and four-file lean stages. The lean runner executed boot 16, router wiring 41, daemon connection state 56 and test configuration 40 tests. It did not run the other 1,693 files or the other lanes.

Two baseline verification failures were reproduced with the original files and filed separately: POD-5061 covers the selected closed-fold fixture expectation; POD-5065 covers two pre-existing palette semantic-element lint errors. POD-5067 records the legacy worktree header's stale session/pane callback. The switch-off product code was not changed to address those discoveries.

## Adjacent operator-data work

POD-4954's initial replay found eight differing comparison positions. POD-5063 subsequently reduced the fleet/timing cases to replay-order fidelity and fixed continuation and section-label cases under POD-5056–POD-5059. At this report's closing check, POD-5060 was still in progress and those companion changes had not yet landed on `integrate/4286-pilot`. Their replay inputs and private values remain on ludovico; no export, dump or operator screenshot was copied or attached here.

The renderer lands on `integrate/4286-pilot` with its default switch off. Moving that branch to `dev/mw`, publishing, and completing the adjacent operator-data acceptance remain separate work.
