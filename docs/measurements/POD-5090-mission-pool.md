# Mission pane pool acceptance

The mission pane now reads the existing MobX pool behind the startup pane choice. `?mobxPane=1/0` takes precedence; otherwise it follows the shared device pilot setting. The legacy path remains the temporary rollback path. Writes still use the existing actions and outbox.

The [initial reader inventory](POD-5090-mission-readers.md) lists every mission read before the conversion. The reviewed slices cover the declared inputs, mission rows and presentation, member and archived sessions, handoff and gesture inputs, supplied guards, Workspace selection and the folded bar. Existing UI components retain their labels, order and layout.

## Reader and ownership

`MissionViewReader` is a service on the existing pool. It reuses the shared mission root/member API and declared relations: `missionSessions` for the archived-inclusive collapsed attachments, `pageSessions` for raw member IDs and counts, `pageDependencies`/`pageDependents` for every edge type and repeated edge, and the existing parent/continuation relations. Resume winners keep their original roster position through `graph.orderKey`.

Rows are borrowed through `pool.row`. Cold issue/session summaries contain only the declared scalar topology, archive and clock facts. Display fields load through the ordinary reader; missing inputs return `LOADING` and request a batch. The reader has no new `peek` caller, row source, replica, runtime, outbox or ownership index. Its handles retain IDs; computed values remain cached only while observed.

FlightDeck's archived reveal uses the selected mission's attachment buckets. It does not call `archivedSessionsForIssue` or traverse the full session slice per row. Rendered row names, titles, notes, presence, continuation, departures, progress and handoff inputs come from the same addressed reader. Menus receive addressed session/issue inputs and supplied close/archive guards.

The store-owner census records legacy reader calls and detects legacy mission-index/session-ownership work nested inside a pool projection. All pool render modes and both menus leave the census empty. The reader audit also checks unchanged global mission/ownership counters, bounded addressed session reads and no `peek` access; an unrelated issue title does not invalidate the selected mission.

## Parity evidence

| Focused check | Result |
| --- | --- |
| Every synthetic mission at 1×, full/working/needs-you; focused fence changes and rescope | Zero differences |
| Representative 4× missions and the same focused change gates | Zero differences |
| Generated seeds 1, 2 and 3, 200 publications each, including overlays, scope, clock and reload | Zero differences |
| Mission reader: cold summaries, batched ancestry, bounded attachment reads, repeated dependency links, raw/resume membership, deadline clock | 7 green |
| Rendered full, working, needs-you, waterfall and handoff views; archived reveal and Enter; issue/session menus; folded bar | 9 green |
| Supplied close/session guards after the shared host and session-pane rebase | 2 green |
| Store-owner census control and addressed-reader/zero-ownership audit | 2 green |
| Existing FlightDeck, Workspace and folded-bar focused tests | 190 green |
| Declared schema and shared edge collections with the mission reader | 73 green |
| Existing MobX/hand relation semantics and the reader audit, focused selection | 27 green |
| Scoped cached web/client-graph/worklist-proto typecheck | 17 successful tasks; 14 cached on the final startup-switch base |
| Focused MobX and memory-cutoff fence lint | Green |
| Focused Biome comparison with integration baseline | 7 inherited errors on both sides; zero new errors |

The comparator covers issue/member fields, row positions and depths, filtered and collapsed crew, activity counts, titles, state/note/presence, continuation, departures, progress, archived sessions and all handoff inputs. The enclosing Workspace comparator also covers root, membership, focused issue, on-screen mission and first-task state. The rendered check compares visible leaf text, labels, element order, authored CSS classes and layout styles; generated IDs and animation progress are excluded.

Every new reader, value, rendered and census check has a planted red control and a restored green run. Controls include a missing-summary false absence, one-at-a-time cold ancestry, an unrelated session read, dropping the second dependency edge, using collapsed rather than raw member IDs, removing the observed clock deadline, changed title/member text, a fresh nonempty legacy mission derivation, and disabled owner attribution. Copies were restored before the green checks.

### Accepted clock difference

POD-4286's delegated operator decision on 2026-10-02 accepts one deliberate behavior change: the pool updates `ready` and `deferred` at the deferral deadline, including readiness-dependent handoff inputs. The old screen waits for another row change. The diagnostic adjusts only these flags on finite deadlines and presentation derived from them; every other value and rendered word/order/layout still requires parity. The observed clock check proves this update happens without publishing a row, and removing its tracked deadline read is red.

### Final private replay

The one final full replay ran on ludovico with uptime checked first and a foreground timeout. It opened the persisted database read-only, used scalar topology in memory, and left the running server and daemon untouched. Display bodies were blank; synthetic and rendered checks cover those fields. Only counts, positions and opaque IDs are emitted.

| Replay count | Value |
| --- | ---: |
| Issues | 5,989 |
| Raw / retained sessions | 5,150 / 5,140 |
| Missions | 2,051 |
| Selections | 8,204 |
| Compared rows | 10,225 |
| Differences / pending values | **0 / 0** |

The initial invocation stopped during module resolution before opening the database. The completed invocation used the documented `--conditions=@podium/source` export condition. No private snapshot was exported.

## Paired browser timing

Pending the shared `bench:flatblock` lease. The owned consumer `apps/web/harness/mission-speed-gate.ts` builds the ordinary minified production fixture once and captures four fresh Chromium runs in off/on/on/off order, two per arm on the same SHA, fixed 4× corpus, seed and targets. The metric is trusted pointerdown to the first actual Chromium Paint after the expected DOM change. It rejects a slower paired mission median, any positive pool-path legacy census, or a greater-than-10% regression against the landed five-action click baseline. It also reports recorded mission reader work and its share of switch latency.

The timing regression control delays only pool mission clicks, records the delay, and must turn the paired gate red before the undelayed comparison is accepted.

## Follow-up and landing

POD-5299 is covered by the landed shared relation engine; this reader reuses it. Old numerical relation guard expectations remain tracked by POD-5303. The seven inherited UI lint findings are separately proposed in POD-5313; no unrelated styling or reset semantics changed here.

Landing is pending green browser timing. Keep the pane rollback switch until the operator enables the screen by default, then remove the legacy screen path within about a week under the coordinator's rollout plan.
