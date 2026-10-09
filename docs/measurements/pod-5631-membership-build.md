# Incremental source membership

The coordinator authorized Step 2 for the six retained walks proved by [the Step 1 report](pod-5631-membership-remeasure.md). Those walks are removed. Membership/order parity and the focused source/native counters pass; the required heavy gates and landing are assigned to POD-5895. This report does not claim a final census or a landing.

Production candidate before this evidence commit: `0d886470deee0a2b9f9ff94ef8648a84c3ff7020`, rebased cleanly onto pilot `2c4e3bd21efd0952c05afb34c9547172d22de85d`.

## Change

- `SortedLanes` now uses the data layer's existing persistent keyed answer. Filing changes tree paths; an unchanged relative position retains its ID snapshot. Historical answers remain immutable. Keyed subscriptions let declared queries receive membership deltas.
- `GroupNode` forwards persistent open/snoozed/closed answers separately. A selection latch inserts or removes one position through the data answer; it never copies or filters a lane. Root metadata reads the head of a maintained root lane. Sidebar band comparison reads small fields and list references rather than comparing all members.
- Phone sections declare an ordered member query, asking/live subsets and a pending total. Each record supplies its lazy section asking fact; retained attention remains distinct from visible, fold-sensitive attention. Counts and subsets update from the changed record. The native library boundary maps output positions on demand instead of comparing/remapping every member.
- The worktree query maintains display order, waiting/working counts and the stale partition. A change considers the changed session and the old/new three-member stale retention prefix; crossing the five-session threshold considers at most six sessions. It publishes persistent visible/hidden answers without filter-copying the roster.

No view-owned identity map or filing reaction was added. The existing data indexes and demanded query facility own these answers. First demand still initializes the declared working set; later updates are keyed. Closed/folded body mount guards are unchanged.

## Proof

Before replacing production code, the frozen group algorithm and existing phone/worktree oracles passed on the same fixtures. Deliberately wrong answers failed the oracle. All six original retained-walk counters failed on the old implementation: group rows 16→64, phone lists 15→63, worktree visible/waiting counts 16→64.

The final proof covers order/membership before and after click, native fold, issue reorder, snooze membership change, unrelated heartbeat and a roster-tail heartbeat that moves the session first. It also compares folded and cold/LOADING answers without mounting or loading those row bodies. The final wrong-answer run failed both parity cases. Existing waiting/working/queued/stale worktree and phone fold/selection tests pass unchanged.

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

A lean gate attempt was interrupted during API declaration generation at 3,364,984 KiB, before a complete typecheck or lean result. Following the coordinator's updated shared-lane instruction, this session stopped its own checks, canceled the census queue and released a lease granted during cancellation. Remaining recorded gate PIDs were checked; no further run was started. POD-5895 owns the lean gate, full typecheck, scan ratchet, normal web build, census and final pilot validation/landing.

The shared batch's full typecheck rejected candidate `1384a343f91a06cf89848a032890a7b9f55e355b`: the lane atom passed `debugName()`'s optional result where MobX requires a string. The follow-up repair uses the existing generic `'Atom'` fallback when debug names are disabled. This changes no membership or order logic; shared-lane validation of the repaired candidate remains pending.

The shared scan at `99acf386b7` reported ten stale fingerprints for removed operations and five new/changed fingerprints in the native mapping, query bootstrap and phone answer getters. After POD-4286 authorized light source scans in this lane, the flatblock scan supplied the five exact records. The census retires only the ten absent operations and adds all replacements with their existing `REQUIRED REPAIR` classification; every unaffected entry retains its content and order. The normal source scan then passed with **0 ratchet errors** (2,207 fingerprints, 2,208 occurrences, 2,072 required-repair entries). Checksums confirm that the scanner and all four affected source files in that flatblock copy match this branch. The shared lane still owns validation on the final stacked tip.

The same shared stack's web build exceeded its eager raw limit by 1,160 bytes (2,151,160 against 2,150,000). Attribution is pending isolation; this report does not claim a green build.

## Scope

The focused desktop measurement reads source membership, while the phone measurement includes its native array boundary. The unchanged web suites establish behavior and mount guards; they do not establish complete React interaction work ratios. The canonical census still needs to run on the final pilot base.

Step 1 also recorded existing desktop transition-target rebuilding and worktree-navigation relation joins. Those broader consumers were not among the six specifically delegated retained-walk targets and are not claimed fixed here; their limitation was mailed to POD-4286. No structural allowance, unrelated fix or browser-driving substitute was introduced.
