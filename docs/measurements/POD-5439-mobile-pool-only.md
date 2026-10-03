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
neighbourhood ratio. The whole-corpus long-press bridge is also tracked in
POD-5422; it is being measured rather than excluded from the guard.
