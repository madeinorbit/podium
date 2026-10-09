# Incremental source membership

The coordinator authorized Step 2 for the six retained walks proved by [the Step 1 report](pod-5631-membership-remeasure.md). Those walks are removed. Membership/order parity and the focused source/native counters pass; the required heavy gates and landing are assigned to POD-5895. This report does not claim a final census or a landing.

Current source candidate: `a368171319`, the complete membership range rebased onto landed lookup pilot `006a4ba7c9c885ab5b196cac5961b8b8abc84d6f`. The normal-build result below is historical, from `2975ac45e5435f689634205aa4431b803ac0ecf5` on pilot `5dc9d5e29401a41f4b11c187388f446d8935f69c`. The original implementation/proof range branched from `2c4e3bd21efd0952c05afb34c9547172d22de85d`.

## Change

- `SortedLanes` now uses the data layer's existing persistent keyed answer. Filing changes tree paths; an unchanged relative position retains its ID snapshot. Historical answers remain immutable. Keyed subscriptions let declared queries receive membership deltas.
- `GroupNode` forwards persistent open/snoozed/closed answers separately. A selection latch inserts or removes one position through the data answer; it never copies or filters a lane. Root metadata reads the head of a maintained root lane. Sidebar band comparison reads small fields and list references rather than comparing all members.
- Phone sections declare an ordered member query, asking/live subsets and a pending total. Each record supplies its lazy section asking fact; retained attention remains distinct from visible, fold-sensitive attention. Counts and subsets update from the changed record. The native library boundary maps output positions on demand instead of comparing/remapping every member.
- The worktree query maintains display order, waiting/working counts and the stale partition. A change considers the changed session and the old/new three-member stale retention prefix; crossing the five-session threshold considers at most six sessions. It publishes persistent visible/hidden answers without filter-copying the roster.

No view-owned identity map or filing reaction was added. The existing data indexes and demanded query facility own these answers. First demand still initializes the declared working set; later updates are keyed. Closed/folded body mount guards are unchanged.

## Proof

Before replacing production code, the frozen group algorithm and existing phone/worktree oracles passed on the same fixtures. Deliberately wrong answers failed the oracle. All six original retained-walk counters failed on the old implementation: group rows 16→64, phone lists 15→63, worktree visible/waiting counts 16→64.

The pre-budget-repair proof covers order/membership before and after click, native fold, issue reorder, snooze membership change, unrelated heartbeat and a roster-tail heartbeat that moves the session first. It also compares folded and cold/LOADING answers without mounting or loading those row bodies. The final wrong-answer run failed both parity cases. Existing waiting/working/queued/stale worktree and phone fold/selection tests pass unchanged. POD-5895 has the exact files to repeat these proofs after the startup-budget repair below; the following counts remain the historical capture until that run completes.

The shown prefix remains five rows. Four bands remain fixed while their issue/roster membership grows 16→64. Every action has identical rows, derivations, distinct elements and visits at both sizes:

| Action | Row reads | Derivation bodies | Elements 1×→4× | Visits 1×→4× |
| --- | ---: | ---: | ---: | ---: |
| Click | 0 | 1 | 33→33 | 69→69 |
| Native fold | 0 | 1 | 6→6 | 7→7 |
| Issue reorder | 22 | 36 | 175→175 | 611→611 |
| Snooze membership | 21 | 34 | 159→159 | 552→552 |
| Unrelated heartbeat | 6 | 7 | 73→73 | 207→207 |
| Roster-tail heartbeat | 8 | 15 | 81→81 | 211→211 |

The broadened replacement counters include query and native projection work: phone 46→46 and worktree 14→14; group fields visit no member arrays. The unrelated heartbeat runs zero group/band, phone section or worktree order-query bodies. Growing shown group headers separately still visits more descriptors, as recorded in [the raw focused counts](pod-5631-membership-incremental.json).

A temporary full-answer visit planted in the flatblock copy of `mapQueryResult` made the aggregate reorder counter fail at 230→422 and the phone counter fail at 61→109. The plant was removed before subsequent validation. This proves that moving a scan into the replacement facility cannot pass merely by removing the old getter name.

## Focused validation

All validation ran in the foreground on flatblock using the checkout-local dependency graph and copied pinned Bun 1.4.2 toolchain (`node -> bun`). No full suite ran.

| Files | Result | Peak recorded RSS |
| --- | --- | ---: |
| `state-parity.test.tsx`, `sidebar-bands.test.ts`, membership proof | 86 passed (75 + 1 + 10), before rebase | 504,724 KiB |
| `query-result.test.ts`, `sorted-lanes.test.ts` | 24 passed on rebased candidate | 280,292 KiB |
| Phone `work-sections.test.ts` | 13 passed; one fixture property renamed | Part of an interrupted combined run; no overall green claimed |
| Web `SidebarUnified.pool.test.tsx` | 15 passed on rebased candidate, including collapse/expand retirement | 454,940 KiB |
| Web `worklist-window.test.tsx` | 9 passed on rebased candidate | 226,288 KiB |
| Final wrong-answer parity mutation | 2 expected failures, 8 filtered | 316,056 KiB |
| Full-answer walk plant | 2 expected counter failures, 8 filtered | 297,572 KiB |
| Shared stacked-tip state/sidebar/membership proofs, each run separately | 75 + 1 + 10 passed at `99acf386b7`, mutation environment unset | Maximum worker RSS 389 MiB |

Validation found a constructor-registration cycle and a lane-reset subscriber loop. Both were fixed. A reset now iterates a snapshot because queries unsubscribe/re-subscribe during notification; a bounded unit regression catches a second visit without hanging. Four ordinary worker attempts crossed the monitor threshold (3,169,296 / 3,151,708 / 3,183,740 / 3,198,440 KiB); a stalled diagnostic was stopped earlier at 1,729,692 KiB. The SIGTERM-only monitor did not ensure exit, and the coordinator had to kill orphan workers. None of those stopped attempts is a passing result.

A lean gate attempt was interrupted during API declaration generation at 3,364,984 KiB, before a complete typecheck or lean result. Following the coordinator's updated shared-lane instruction, this session stopped its own checks, canceled the census queue and released a lease granted during cancellation. Remaining recorded gate PIDs were checked; no further run was started. POD-5895 owns the lean gate, full typecheck, census and final pilot validation/landing. The coordinator subsequently allowed light source scans in this lane and one normal web build specifically for the startup-budget repair.

The shared batch's full typecheck rejected candidate `1384a343f91a06cf89848a032890a7b9f55e355b`: the lane atom passed `debugName()`'s optional result where MobX requires a string. The follow-up repair uses the existing generic `'Atom'` fallback when debug names are disabled. This changes no membership or order logic; shared-lane validation of the repaired candidate remains pending.

The shared scan at `99acf386b7` reported ten stale fingerprints for removed operations and five new/changed fingerprints in the native mapping, query bootstrap and phone answer getters. After POD-4286 authorized light source scans in this lane, the flatblock scan supplied the five exact records. The census retires only the ten absent operations and adds all replacements with their existing `REQUIRED REPAIR` classification; every unaffected entry retains its content and order. The normal source scan then passed with **0 ratchet errors** (2,207 fingerprints, 2,208 occurrences, 2,072 required-repair entries). Checksums confirm that the scanner and all four affected source files in that flatblock copy match this branch. The shared lane still owns validation on the final stacked tip.

## Startup-budget repair

POD-5895 isolated the rejected membership range onto pilot `899243cf3148090bb355ccc52199d825a282eaf4`: eager raw **2,151,327 bytes**, exceeding the unchanged **2,150,000-byte** limit by **1,327 bytes**. The separate owner-work range built green, so this blocker belonged to the membership range.

The repair shares demand bookkeeping, ordered-neighbour lookup, captured subset/partition updates, bounded retention-prefix lookup and sparse latch insertion search. Phone pending totals now read only pending state; asking comes from the existing per-record fact. Phone issue/worktree order remains issue-rank first, then worktrees in locale order. Direct declared-question getters, historical snapshots, independent count signals and closed/folded body guards remain in place. No extra lazy-loading registry, view cache, new dependency or budget allowance was added.

On candidate `2975ac45e5435f689634205aa4431b803ac0ecf5`, the coordinator-authorized **single normal web build** ran in the dedicated flatblock checkout under `heavy:flatblock` and passed:

| Metric | Result |
| --- | ---: |
| Eager raw | **2,149,945 bytes** |
| Eager raw limit | 2,150,000 bytes |
| Remaining raw headroom | 55 bytes |
| Eager gzip / Brotli | 687,914 / 592,347 bytes |
| Build elapsed / exit | 34.71 seconds / 0 |
| Maximum command RSS | 1,414,416 KiB |

The eager output is **1,382 bytes smaller** than the isolated rejected membership build. The heavy lease was released immediately afterward. Exact log: `flatblock:/tmp/podium-5631-budget-build/build.log`.

The normal flatblock light source scan also passed: **2,212 fingerprints**, **2,213 occurrences**, **2,075 REQUIRED REPAIR entries**, **0 ratchet errors**. The final reconciliation changes only three exact dependency token/fingerprint pairs in the query bootstrap, native mapping consumer and existing issue-identities helper consumer; every classification, owner, bound, guard and other metadata is preserved. The issue-identities source was not edited. Scan identities supplied by the flatblock run were checked before updating the census.

The complete rebased candidate and exact focused query, lane, state, sidebar and phone test paths were sent to POD-4286 and POD-5895. Fresh parity/counters, full types, lean admission and the final canonical census/stack build remain with the shared testing lane. The successful build here does not establish those results or a landing.

## Landed lookup reconciliation

The complete 21-commit range at `6bc10046e09e9d93b4d23d93225b795274b449fb` (previous candidate `ff24f8d2400b9aecd10e68dd8f0897058b8c91e6`) was rebased from `5cefac00403c52651b8148485609548323964953` onto the landed POD-5867 pilot `006a4ba7c9c885ab5b196cac5961b8b8abc84d6f`. All 21 original commits are present. Range-diff changes only the necessary lookup-policy reconciliation in three replayed patches; every other patch is identical.

The conflicts in `groups.ts`, `mobile.ts` and `sidebar-roster.ts` retain the pilot's `here`/`omitGone` policies while preserving incremental subscriptions and direct query answers. New phone worktree readers and the frozen group oracle use `here`; the resident worktree fixture uses `requireHere`. A new regression verifies that phone membership omits loading/gone worktrees, counts a pending issue once, and stops counting after the inaccessible load settles.

Fresh focused proof on `fb3be9cdf4` exposed a payload subscription introduced by the landed `pool.resident()` implementation. The existing membership file failed three unchanged bounds: roster-heartbeat row reads **25→73**, aggregate elements **100→148**, and worktree replacement counters **34→82**. Attribution names `WorklistWorktree.pending`, whose session-presence loop was rerun on the changed payload.

The scoped repair at `a368171319` uses `omitGone(pool.model(...))` for pending session and owner checks, preserving loading/gone behavior and borrowing POD-5867's resident presence-only fast path. No pool implementation, fixture, allowance or counter bound changed. The same focused file then passes all 11 cases: roster-heartbeat row reads **9→9**, elements **85→85**, and both worktree replacement counters **18→18**. Phone replacement counters remain **46→46**, group member-array visits **0→0**, and the unrelated heartbeat runs no section/order-query bodies. Membership/order, cold/folded guards and the new lookup regression pass.

Eight focused files pass **148 unique cases**, each in its own foreground `bun run test:file -- <path>` run on flatblock, using Bun 1.4.2 and the local `node -> bun` link:

| File | Cases | Peak recorded process RSS |
| --- | ---: | ---: |
| `packages/client-graph/src/query-result.test.ts` | 21 | 415 MiB |
| `packages/client-graph/src/worklist/sorted-lanes.test.ts` | 3 | 308 MiB |
| `packages/client-graph/src/worklist/state-parity.test.tsx` | 75 | 481 MiB |
| `tests/worklist/harness/src/sidebar-bands.test.ts` | 1 | 382 MiB |
| `tests/worklist/harness/src/sidebar-membership-remeasure.test.ts` | 11 | 421 MiB |
| `apps/mobile/src/lib/work-sections.test.ts` | 13 | 454 MiB |
| `apps/web/src/features/worklist/SidebarUnified.pool.test.tsx` | 15 | 544 MiB |
| `apps/web/src/features/worklist/worklist-window.test.tsx` | 9 | 408 MiB |

Query, lane and band proof ran at `fb3be9cdf4`; those implementations did not change in the pending-read repair. All other final receipts ran at `a368171319`, including the affected state-parity rerun. Every recorded wrapper exited, with no memory stop or remaining recorded descendants. These are focused results, not a full-suite or canonical-census result. Exact runner JSON locations and process receipts are in the attached focused-proof artifact.

The final light source scan on repaired source `a368171319` is green: **2,208 fingerprints, 2,209 occurrences, 2,070 REQUIRED REPAIR entries and zero ratchet errors**. No additional census edits were needed after the rebase or presence-read repair; all carried classifications remain intact.

The permitted source-only estimate transforms the changed modules in a prior production eager closure, comparing the exact `006a4ba7c9` source to `a368171319`. It estimates **+3,533 bytes**: query-result +2,155, phone membership +717, groups +247, sorted lanes +192, roster +160, issue +75, sidebar +41 and worktree −54. This exceeds the coordinator's initial **11-byte** headroom signal. It is not a production build, emitted bundle size or budget result. POD-4286 explicitly directed this lane to hand off after focused proof rather than block on the estimate; POD-5895's real build determines exact bytes, and the startup-budget question is already with the operator. No ceiling, startup allowance or lazy-loading registry was changed here. The estimate and focused receipts are attached to the issue. Full typecheck, lean admission, production build, canonical census and landing remain exclusively assigned to POD-5895. No heavy check or landing was performed in this reconciliation lane.

## Scope

The focused desktop measurement reads source membership, while the phone measurement includes its native array boundary. The unchanged web suites establish behavior and mount guards; they do not establish complete React interaction work ratios. The canonical census still needs to run on the final pilot base.

Step 1 also recorded existing desktop transition-target rebuilding and worktree-navigation relation joins. Those broader consumers were not among the six specifically delegated retained-walk targets and are not claimed fixed here; their limitation was mailed to POD-4286. No structural allowance, unrelated fix or browser-driving substitute was introduced.
