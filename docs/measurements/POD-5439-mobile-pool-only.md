# Mobile screens pool-only

This removal keeps the provider-owned store actions, replica and outbox. The
phone's screen reads move to the existing pool; no pool mutation API or second
write owner is introduced. Findings 24 and 26 in the architecture review were
read in full before the first edit.

## Recorded controls

Legacy control arms are removed only after their collected green result is
recorded on the issue. Expected outputs are captured while those arms still
exist and compare equal. The removal candidate must use the same expectations
without a snapshot update.

| Committed source | Green control | Preserved expectation |
| --- | --- | --- |
| `33327a75ee` | Mobile reader controls; 93 green, one inherited notice retry failure | Session, inbox, preference, settings, banner and work values; cumulative ON legacy derivations zero |
| `5d771a4e44` | Seven rendered files, 37 checks, 100 snapshots | Exact accepted native screen and reader outputs |
| `5d771a4e44` | Eight corpus checks, 670 snapshots | 1x/4x work cases and three 200-publication seeds |
| `5d771a4e44` | Native bands and memo: 13 checks | Bands, folds, searching and one-row paint isolation |
| `5d771a4e44` | Remaining normalized issue/session/new-task readers: 12 checks | Literal issue relationships, session homes and unrelated-publication isolation |
| `7f7f5c49e9` | Launch forms: two checks, four snapshots | Exact form HTML and normalized launch plans; old selectors positive, pool selectors zero |
| `5d771a4e44` | Mobile/demo probes: 11 checks in two files | Counts, titles, paths, shared clock, connectivity, metrics and machine refusal values |

The real mobile action file's 28 controls supplied 91 zero-difference
comparisons before retirement. Its existing write, held request, refusal,
confirmation, navigation and raw delete-membership assertions remain, alongside
the frozen pool output fingerprints.

The inherited notice retry failure is not counted as a green control. Its
existing write callback is unchanged; final regression evidence must resolve
or explicitly account for that failure.

## Private replay — counts only

Both replays ran on ludovico. Raw operator rows were neither copied to flatblock
nor exported in the attached evidence.

| Screen | Issues | Sessions | Other counts | Differences | Pending |
| --- | ---: | ---: | --- | ---: | ---: |
| Work | 6,124 | 5,192 | 21 sections, 896 rows | 0 | 0 |
| Inbox | 6,126 | 5,183 | 22,528 targets, 38,978 compared positions | 0 | 0 |

The inbox's initial 180-second limit produced no result. The longer foreground
retry completed and was recorded before removing its legacy control. Only that
completed replay counts as evidence.

## Remaining direct query and isolated fix

`NewIssueScreen` retains its existing `trpc.repos.list` server fallback, as
directed by the coordinator. It is a remaining direct server query, not a read
of the legacy client store. Its action callbacks are unchanged.

The launch descriptor initialization crash was isolated in POD-5449 and landed
as `41e907ef043511bcfa21540ddd114e81b08568cc`. Its literal real-provider form
regression failed on the original order and passed on the fix. The focused
mobile typecheck reported 14 successful tasks; two-file Biome lint was green.
The released Expo source and `dev/mw` contain the same crash on the new-task
form and configured issue launch sheet.

## Final acceptance still in progress

POD-5081 supplies the remaining issue and mission readers and accepted
expectations. Its landing precedes removal of their legacy arms and the final
mobile setting, latch and overrides. The shared host's compatible optional
initializer/enabled change comes from POD-5437.

The final candidate needs its zero-reader grep and counters, census comparison,
planted-fault rejections, focused flatblock regression/type/lint results and
production Expo/Pixel 7 emulation evidence. Phone interaction timings are
captured only while holding `bench:flatblock`. This report does not yet claim
those final results or physical-device verification.

The scripted 1x/4x work guard includes fold, launch open/close and row-menu
gestures. Row reads and derivation runs must stay within the measured visible
neighbourhood ratio. The whole-corpus long-press bridge is assigned to internal
POD-5450. Before its fix, source `d6d55b214a` read 65,392 rows and ran 5,599
derivations for one menu press at 1x; at 4x it read 358,849 rows and ran 21,175
derivations. The guard rejected that growth against the visible 18/14
neighbourhood ratio. All 28 action controls were green, with 91 action-state
expectations and 33 exact menu outputs frozen before narrowing the reader.
Later click row-read counts are deltas; the first press's recorded counts
start from zero.

## Bounded phone inputs

The menu candidate keeps all 91 accepted action-state and 33 menu fingerprints.
At source `a492c463c6`, the same long press reads six rows and runs zero
MobX derivations at both 1x and 4x. Close and launch open/close read zero rows;
the fold's 4x work is below its visible-neighbourhood allowance. The fixed
pressed issue, origin, children and roster are identical at both sizes.

The new-task form's old session sort read 28,803 and 115,203 row/field values
at 1x and 4x for three choices. At `c6591714ba`, its existing declared
`commandRootActivity` question reads six rows and runs two derivations at
both sizes, preserving the literal repository order. Historical sessions in
that fixture have explicit stop timestamps and are asserted cold.

Planted faults at `e89e124719` execute two named checks: a whole-table menu
loop increases menu reads to 2,436/9,757 and fails the 18/13 neighbourhood
allowance; exact-root matching loses nested-worktree activity and changes the
repository order, failing the literal output check. Both source files are
restored and their clean diff is verified. The preserved runner log is the
result; the temporary JSON report is automatically removed by `test:file`.

The issue page's before-fix real-kernel control (`cac38ed71b`) preserves the
same closed-page fingerprint at both sizes, but reads 43,190/164,942 values
and uses eleven legacy selectors. Its growth check is red. The approved
replacement reads only the displayed neighbourhood and asks for picker
catalogs when they open. Its final green result waits for the shared clock
and host retirement. The earlier compatibility-replica fixture failure is
excluded from evidence.

The clock control at `f922f86779` also records its actual old mechanism: ten
legacy selector runs and no repaint after the first real pool tick. Its pool
clock regression, including forward ticks and rewind, remains to pass after
the generic hook retirement.

The actual parent-picker control at `0c94ed68f9` renders the same newest-first
fourteen literal choices at both sizes, including archived tasks. Opening it
still reads 2,400/9,600 values and runs 1,201/4,801 derivations. Its visible
neighbourhood ratio is one, so the guard is red. The declared identity-query
scope was approved by POD-4286 in `msg_3ed6d6f5-d2ee-4557-ae99-3e4d912ff9c0`.

The committed replacement at `ad9747168c` uses the declared
`mobileIssueTargets` question over source identity/facet postings, with no
pool index or row cache. It takes joined prefixes from the existing pool repo
facts, including multiple repositories at the same path. Only mounted choices
read title, reference and stage through the pool; missing facts stay loading.
The unchanged target-search controls were last green at `9f7114b4d4` before
their eager array filter was removed (three focused checks, recorded in the issue).

The foreground flatblock regression batch has nine green checks across three
named files: five source-question checks, three sheet checks, and the actual
parent-sheet click. The closed-page clock case is deliberately filtered until
the generic hook retirement. The actual picker reads 29/29 rows and runs 15/15
derivations for the same fourteen visible choices, with unchanged literal order
and three literal title/reference searches. Source identity visits are 15/15
for an open and 12/12 for the two specific searches. The source guard first
rejected numeric suffix scanning at `7aca1b4ea4` (23/99 visits for identical
search results); the sequence-prefix correction preserved those results and
made that counter flat. Compiler, lint and planted eager-catalog evidence for
the original checkpoint were still pending; this was not final acceptance.

The rebased source `fb41c2ea5a` passed fourteen compiler tasks and eleven
focused picker/source-roster checks, preserving the same 29/29 row calls,
15/15 derivations and literal searches. Another six-file phone group preserved
68 existing checks, including the frozen action/menu, launch-form and
navigation expectations. The existing command-launch file added seven green
checks. No expected output was updated; the runner's snapshot whitespace
normalization was restored to the recorded bytes.

POD-4286 approved extending the existing `commandIssueSessions` question with
`archived=false` and `includeShells=true`. The menu keeps headless and shell
close concerns and visual resume collapse. Delete uses the already-maintained
`graph.size(pageSessions)` scalar, including archived and raw resume-twin
membership; it does not iterate those historical IDs or payloads. This creates
no new resident relation subset or census cells.

At `032ea94d17`, the additional 32/128 archived-sender fixture has six addressed
neighbours at both sizes. Its menu press reads 6/6 rows, runs 0/0 derivations
and reads zero archived payloads; raw delete counts remain 34/130. Fourteen
compiler tasks and that one corrected focused case are green. Its first
version failed an incorrect cold-state assertion: bound sessions inherit a
live issue's residency under the declared schema. The corrected test measures
payload reads and click growth directly. The existing output expectations are
unchanged. Focused Biome found five errors awaiting correction; graph lint and
the additional planted-fault runs are still pending. No final timing is claimed.

The long-press fix also retires this issue's exact `rows` and `elements`
exceptions in the shared structural speed guard. Other issues' exceptions
remain unchanged; the candidate must satisfy those two comparisons outright.

## Integrated structural checkpoint is red

Source `5fd5a2369d` ran the foreground structural-only gate on flatblock:
47 readers × nine clicks/deltas × two scales, 1,614 individual comparisons.
The run has 700 known failures owned by other issues, 25 resolved counts and
16 unexpected comparisons; it is not a green speed gate. Fifteen focused
checks passed, including the real legacy and planted scan negative controls,
and the per-action correctness/parity assertions completed.

Two unexpected comparisons belong to the menu: row calls and elements are
35/131 for the same six visible neighbours. This fixture grows archived
history under the pressed task, which the earlier two-session native control
does not. `issueCloseConcerns` already drops archived sessions, but the menu
input builder reads their payloads first. The fix must retain live headless
and shell concerns and the raw non-shell delete count. Its old exceptions
remain removed; the gate reports this regression directly.

POD-4286 assigned the fourteen heartbeat-only zero-to-positive mission/inbox
comparisons to POD-5423 (review finding 9). Internal POD-5458 is closed as moved
and its blocking edge is removed. Their exact counts and owner are attached in
`heartbeat-ownership.json`. Automatic approval review rejected adding them as
new exceptions without direct operator authorization. The strict manifest
therefore remains unchanged for heartbeat; those failures stay visible. This
report does not relabel the old red structural run as green.

The current branch is rebased onto landed POD-5437 at `e6c2313ca2`, including
the already-landed transaction changes and optional host screen fields. The
shared host files are untouched by this issue. POD-5081 has not landed; its
session context/conversation files, generic hooks and final mobile switch and
setting remain held. This removal still has no own write-path changes. The
structural result above remains attached to its measured source; the rebased
candidate has not yet run its final gate.
