# Mission pane pool acceptance

The mission pane now reads the existing MobX pool behind the startup pane choice. `?mobxPane=1/0` takes precedence; otherwise it follows the shared device pilot setting. The legacy path remains the temporary rollback path. Writes still use the existing actions and outbox.

The [initial reader inventory](POD-5090-mission-readers.md) lists every mission read before the conversion. The reviewed slices cover the declared inputs, mission rows and presentation, member and archived sessions, handoff and gesture inputs, supplied guards, Workspace selection and the folded bar. Existing UI components retain their labels, order and layout.

## Reader and ownership

`MissionViewReader` is a service on the existing pool. It reuses the shared mission root/member API and declared relations: `missionSessions` for the archived-inclusive collapsed attachments, `pageSessions` for raw member IDs and counts, `pageDependencies`/`pageDependents` for every edge type and repeated edge, and the existing parent/continuation relations. Resume winners keep their original roster position through `graph.orderKey`.

Rows are borrowed through `pool.row`. Cold issue/session summaries contain only the declared scalar topology, archive and clock facts. Display fields load through the ordinary reader; missing inputs return `LOADING` and request a batch. The reader has no new `peek` caller, row source, replica, runtime, outbox or ownership index. Its handles retain IDs; computed values remain cached only while observed.

FlightDeck's archived reveal uses the selected mission's attachment buckets. It does not call `archivedSessionsForIssue` or traverse the full session slice per row. Rendered row names, titles, notes, presence, continuation, departures, progress and handoff inputs come from the same addressed reader. Menus receive addressed session/issue inputs and supplied close/archive guards.

The store-owner census records legacy reader calls and detects legacy mission-index/session-ownership work nested inside a pool projection. All pool render modes and both menus leave the census empty. The reader audit also checks unchanged global mission/ownership counters, bounded addressed session reads and no `peek` access; an unrelated issue title does not invalidate the selected mission.

The mission wrapper reads a structurally compared computed projection inside its MobX observer, retaining the mission's computed rows across session selection. The subscription helper remains limited to the small action menus. The rendered check uses the real projection subscription and proves that initial mount derives the mission once and selecting a session does not derive it again. Restoring the previous pane subscription makes this check fail with two derivations. A real pool publication with equal host-catalog output adds no roster render commit; removing the equality filter adds two commits (five to seven). A changed mission title still reaches the header; planting an always-equal filter hides it and turns the check red. Both exact copies were restored for the green run.

## Parity evidence

| Focused check | Result |
| --- | --- |
| Every synthetic mission at 1×, full/working/needs-you; focused fence changes and rescope | Zero differences |
| Representative 4× missions and the same focused change gates | Zero differences |
| Generated seeds 1, 2 and 3, 200 publications each, including overlays, scope, clock and reload | Zero differences |
| Mission reader: cold summaries, batched ancestry, bounded attachment reads, repeated dependency links, raw/resume membership, deadline clock | 7 green |
| Rendered full, working, needs-you, waterfall and handoff views; archived reveal and Enter; issue/session menus; folded bar | 9 green |
| Observed mission retention on mount and session selection | Green; previous subscription planted red |
| Equal catalog output retains the rendered roster; changed mission title updates the header | Green; missing and always-equal filters planted red |
| Supplied close/session guards after the shared host and session-pane rebase | 2 green |
| Store-owner census control and addressed-reader/zero-ownership audit | 2 green |
| Existing FlightDeck, Workspace and folded-bar focused tests | 190 green |
| Declared schema and shared edge collections with the mission reader | 73 green |
| Existing MobX/hand relation semantics and the reader audit, focused selection | 27 green |
| Scoped web/client-graph/worklist-proto typecheck | 16 successful tasks on the current pilot |
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

Timing remains a required follow-up after the switch-off code landing, per POD-4286's 2026-10-02 instruction. The owned consumer `apps/web/harness/mission-speed-gate.ts` builds the ordinary minified production fixture once and captures four fresh Chromium runs in off/on/on/off order, two per arm on the same SHA, fixed 4× corpus, seed and targets. The sidebar stays on the pool in both arms; only `mobxPane` changes. The metric is trusted pointerdown to the first actual Chromium Paint after the expected DOM change. It rejects a slower paired mission median, any positive pool-path legacy census, or a greater-than-10% regression against the landed five-action click baseline. It also reports recorded mission reader work and its share of switch latency.

The timing regression control delays only pool mission clicks, records the delay, and must turn the paired gate red before the undelayed comparison is accepted. The prepared control uses 7,500 ms. The complete four-capture consumer has a 35-minute foreground allowance; repetitions, targets, metric and failure thresholds remain fixed. The reported calibration noise belongs to the landed baseline.

The complete planted control at `39dae804665a15aa0f1c824c09c1b0944fa4f683` is red as required: the paired mission median rises from 1,235.890 to 9,277.009 ms with the 7,500 ms delay. All four captures completed, with six retained samples per action per capture and zero pool-path legacy reads. The exact harness copy was restored.

The first valid undelayed pair at `3b77d7467478bf9c893e6edc7934d7abda41b035` is rejected: mission latency is 1,615.642 ms off versus 1,687.193 ms on, **4.429% slower**. All five fixed-baseline checks pass and legacy reads are zero, but the strict paired mission check fails. Recorded mission-reader work falls from 574.85 to 128.90 ms, or 35.580% to 7.640% of switch time. No sample is discarded and this result is not acceptance evidence. POD-5327's separate profile identifies a second mission-row pass and expensive projection subscription work.

The direct-observer attempt at `4d2c5ecc602295b6b5c04c928f7d2108314ff739` is also rejected: 1,415.212 ms off versus 2,927.109 ms on, **106.832% slower**, with all four captures complete and legacy reads zero. It removes duplicate reader derivation but loses the projection's equality filter. The render-commit control above demonstrates the extra commits.

The corrected observed computed projection at `c56e85d02a244bcb268ce416fb4bce20d1c7c126` retains that equality filter without the original untracked first read. Its complete four-capture pair is also rejected: mission latency is 1,615.241 ms off versus 2,609.811 ms on, **61.574% slower**. Every fixed-baseline check passes and legacy reads are zero. Recorded mission-reader work falls from 647.50 to 95.30 ms, or 40.087% to 3.652% of switch time. The focused projection and reader checks are 21 green, both new equality controls are planted red and restored, scoped typecheck reports 16 successful tasks, and the two changed UI files have no Biome errors. All three rejected pairs retain every sample and the strict failure threshold; none is acceptance evidence.

### Adjacent issue-panel cost

A focused CPU/commit profile at `eee9ea659d74afdf57e97b51c2c33670d210c6bf` uses the same product tree as the corrected pair. It changes only the pane switch, with the sidebar on the pool and the session pane and chips on their existing paths. The ordinary minified production fixture records three retained mission clicks per arm after two warm-ups, interleaved with the first arm reversed each pair. Profiling adds overhead, so its latency is diagnostic and does not replace the speed gate.

| Profile measure | Pane off | Pane on |
| --- | ---: | ---: |
| Median React render work | 862.534 ms | 1,174.641 ms |
| Median React passive effects | 48.462 ms | 1,473.742 ms |
| Median garbage collection | 76.398 ms | 329.094 ms |
| Rendered task-row instances, median | 239 | 478 |
| Workspace renders, median | 2 | 3 |

The dominant pool cost is the embedded issue panel, which shares the pane startup choice: `PoolIssuePanelView`'s projection calls `issuePages.panel/data`, rebuilding the global `issues/summary` catalog. The panel callback accounts for 1,384.73 ms mean inclusive CPU time and projection subscription for 1,032.78 ms; these overlap and must not be added. The issue-page memo bypasses its computed cache for an unobserved read, and the profiled projection performed that first read before subscribing. This profile identifies the next cost to remove; it does not establish a successful fix.

POD-5367 records this required blocking work under the mission issue. POD-5091 owns the panel and issue-page summary files and is optimizing them. POD-4286 routed the panel cost to that lane and instructed the mission lane to retain its current wrapper, await the landing, then rebase and repeat the strict pair. POD-5347's shared projection correction has separately landed at `e3b8928e1a`; it will be included in that rebase. The CPU analysis is attached to the mission issue as `.artifacts/5090-mission-profile-analysis.json`; the benchmark lease was released before analysis and edits.

The first timing control was invalid: its legacy arm completed, but the pool arm stopped before fixture readiness with React error 311. An isolated production startup probe traced this to the fixture freezing screen choices only in `attachRuntime`, after Workspace had first chosen its hooks. The ordinary app already initializes screens before descendants in AppShell. The fixture now does the same in its root, before rendering children. With the correction, the full 4× pool fixture becomes ready and a trusted click on the fixed mission target opens the FlightDeck scroller, with zero page errors and no pending settling work. The CommandPalette fix independently landed by POD-5308 did not remove the original error; this was a separate fixture startup contract violation. No timing number from the aborted control is accepted as a paired result.

A later incomplete control completed its first off/on captures without the startup error, but its legacy capture took 528 seconds. Four captures at that rate cannot finish within the original 20-minute allowance. The recorded own runner PID was stopped, the exact harness copy restored, and the benchmark lease released before preparing the longer allowance. These partial captures are also excluded from the accepted paired result.

## Follow-up and landing

POD-5299 is covered by the landed shared relation engine; this reader reuses it. Old numerical relation guard expectations remain tracked by POD-5303. The seven inherited UI lint findings are separately proposed in POD-5313; no unrelated styling or reset semantics changed here.

POD-4286 explicitly authorized fast-forward landing while the startup switch remains off by default, so the issue-page lane could rebase; the main migration landed at `f27a9d4d23` and the fixture startup correction at `36aed40e3c`. The complete planted delay control is red as required. The paired mission speed gate remains red, with its adjacent issue-panel cost tracked by POD-5367; this issue stays active until a concrete fix passes the unchanged gate. Keep the pane rollback switch until the operator enables the screen by default, then remove the legacy screen path within about a week under the coordinator's rollout plan.
