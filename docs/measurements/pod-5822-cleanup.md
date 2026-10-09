# Worklist cleanup evidence

POD-5822 follows the frontend data guide rules 3, 4, 5, 8 and 9 and the names approved by POD-5708 on 2026-10-08. The canonical name table was committed before implementation in `4b7de6fe0f`; its approved corrections are in `pod-5822-names.md`.

## Result

Desktop sidebar, rail and phone Work rows read `WorklistIssue`, `WorklistWorktree` or their shared record directly. The three forwarding ports, issue Proxy and per-row helper companion maps are removed. Shared record facts use `IssueModel` names; worklist-specific facts keep one canonical field. The existing departure snapshot remains the only frozen row paint.

Selection and its fold latch are Worklist observable accessors. A row derives `selected` by ID equality; `selectionGone` reads the selected shared model’s replica `exitKind`. The runtime selection property delegates to Worklist while attached, and standalone sources feed Worklist directly. There is no second selection map, eviction value or reaction keeping them aligned. Device persistence remains POD-5797.

Worklist-created membership lists are shallow-equal lazy model/ID fields. Mobile section fields are lazy parts owned by the Worklist and group nodes. The Worklist retains section-key lists and each section's issue/worktree IDs; native SectionList descriptors are formed only at the phone UI boundary. The phone root observes the model counts directly. Worktree roster ordering uses incremental ordered data queries over shared sessions, with shallow-equal visible/stale lists. Folded header counts read narrow shared session flags; navigation activity reads scalar session timestamps. Clock behavior remains POD-5863.

Strict grouped-row validation exposed constant helper factories that read no observables. Following POD-4286's clarification, the two `AttentionFields` helpers, mobile section owners and worktree queries are ordinary owner-lifetime parts; all changing answers remain lazy fields. Optional phone group parts are created on first use because some non-phone group owners have no pool. Query results still clear their rows and subscriptions when their last reader leaves. The shared `@lazy` implementation is unchanged. The pre-fix groups run failed on the dependency-free attention factory with strict enforcement enabled. After correction, all three unchanged grouped-row cases passed, including the #1–#7 row/commit/read/header fences and cold-window loading. The query release file passed all 18 checks; state/header/query proof passed 96 checks together.

The cached `factRow` is replaced by an ephemeral record read inside each scalar model getter. `loadedIssue` and `loadedOrigin` retain shared models or the same LOADING/absent answers. Their only production readers are readiness and the origin's id/seq/title; the data layer's `rollupInputs.loadedIssue` protocol is unchanged. Twelve schema-installed issue paint fields use the existing lazy decorator so an unshown edit does not redraw an unchanged row. All other stored getters stay plain. The departure snapshot is captured in the committed row's layout effect, so its additional fields do not become live observer dependencies.

## Before/after proof

The old implementation is preserved only in test oracles (`issue-before.test-helper.ts`, `lists-before.test-helper.ts`, `query-identity-before.test-helper.ts`, `mobile-before.test-helper.ts`, `heartbeat-before.test-helper.ts`). Production imports none of them. The initial port parity proof ran before deleting adapters, including a deliberately wrong candidate; the expanded proof compares each moved/renamed answer with its frozen predecessor on the same fixtures.

`field-parity.test.ts` covers working, waiting, folded parents, merge decisions, quiet drafts, timed defer, next-message defer and spin-off origins, plus unknown, LOADING and selected evicted records. `state-parity.test.tsx` exercises a real row click (render counts old row 2, new row 2, unrelated row 1), compares old/new mobile sections and roster partitions, and proves an unrelated heartbeat invokes zero roster sorts and zero folded-header count reads. The changed issue’s navigation activity still advances.

Expanded proof: 1,473 checks green. With `POD5822_MUTATE=1`, 1,469 checks fail and the four independent boundary checks pass. The original pre-deletion proof was 373 green; its wrong-answer control failed 371 checks.

Before removing retained raw records, the expanded field and record-fact proof passed 1,530 checks (1,488 field answers and 42 scalar facts). Its wrong-answer control failed 1,527 checks; the three independent boundary checks stayed green. Before wrapping schema-installed issue fields, all 406 stored-field comparisons passed; their wrong-answer control failed all 406. The same fixtures include open, closed, actual private-branch merge, archived, deleted, cold and missing records.

After the pilot rebase and direct section-key correction, 1,936 issue/record-field checks passed. The expanded state proof passed 67 checks, including 16 worktree fields across waiting, working, queued and stale rosters. Its wrong-answer control failed 66 checks; the actual selection click remained an independent green check. The two section-key lists are also compared directly with the frozen keyed section output and fail their wrong-answer control.

The native direct reader exposed an unnecessary roster-identity subscription in non-waiting worktree status labels. Two scalar totals, `sessionCount` and `workingCount`, replace the formatter’s direct list walks for working/done/idle labels. Waiting keeps its existing formatter and clock behavior. Timing and fleet use structural equality for their small rebuilt objects. The expanded worktree parity now passes 75 checks, covering both totals on all four roster fixtures.

The incremental roster query now receives keyed candidate moves from the existing roster index inside the pool publication’s action. The delayed full-reset membership reaction briefly exposed an empty list during a session replacement; removing it keeps the worktree phase unchanged. The existing native hidden-navigation test passes with zero commits, then opens the replacement session when pressed. The expanded state wrong-answer control fails 74 checks; the actual selection click remains green.

The coordinator-requested cold reference test demonstrated the old shared getter returning an empty string instead of the declared `POD-0` identity. `displayRef` now borrows the declared summary’s numeric sequence and shared prefix without demanding the payload. Declared, undeclared and missing identities pass with no load scheduling; the model file passes 13 checks.

`worklist-issue-fields-memory.ts` holds the same desktop/phone paint questions over the existing 4x corpus and reports watched computeds and post-GC heap. The matched comparison differs only in the schema-installed issue stored getters: plain before, lazy after. The initial broad boundary had 19,468 issues, 17,216 sessions and 769 shown rows in both runs. Watched computeds increased from 244,639 to 272,931; watched IssueModel fields increased from 50,449 to 78,741. Total post-GC heap increased from 1,205,619,126 to 1,287,338,039 bytes (6.778%); the worklist increment increased from 1,121,588,575 to 1,178,089,740 bytes (5.038%). POD-4286 rejected that growth and required a narrow boundary, with a matched rerun at approximately 2% or less retained growth or justification for each wrapped field. The current twelve-field boundary and committed snapshot implement that decision; its measurement is pending.

| Lazy stored field | Direct paint question protected from unrelated edits |
| --- | --- |
| `title` | Row label and tooltip text. |
| `color` | Issue tint. |
| `audience` | Internal issue badge. |
| `pinned` | Phone pin mark. |
| `linearIdentifier` | External reference label. |
| `seq` | Numeric reference gutter. |
| `stage` | Stage badge and status text. |
| `closedReason` | Closed status text. |
| `blocked` | Blocked status text. |
| `branch` | Git label and merge affordance. |
| `gitState` | Git stamp and merge affordance. |
| `parentBranch` | Merge tooltip. |

The final narrow comparison, on pilot `69c89de202`, has the same 19,468 issues, 17,216 sessions and 769 shown rows in both runs. Total post-GC heap is 1,204,624,515 before and 1,229,031,782 after (+2.02613069%). Watched computeds are 244,639 before and 256,435 after; watched IssueModel fields are 50,449 before and 62,245 after (+11,796). The worklist increment is 1,095,440,273 before and 1,144,969,708 after (+4.5214%); the separately measured pre-worklist heaps are 109,184,242 and 84,062,074 bytes. Both totals are reported rather than hiding that starting-heap difference. The exact JSON and per-name counts are attached as `Narrow 4x retained heap comparison` and were mailed to POD-4286 and POD-5708 with the field justifications above. The approximately 2% decision's exact 2.026% boundary is awaiting coordinator confirmation.

`worklist-production-smoke.ts` verifies one sidebar row and its issue page from the normal production build in an isolated harness. Flatblock's missing `libasound.so.2` is extracted rootlessly into this test checkout's `.toolchain/browser-libs`, following the documented browser setup; the host package installation is unchanged.

## Shared answers and remaining helpers

Design confirmed separate raw and emphasis questions. After POD-5828 landed the shared raw answer, `WorklistIssue.unread` was removed: raw readers use `IssueModel.unread`, `visibleUnread` adds the drawn-subtree/working rule, and `emphasizeUnread` also handles quiet phone drafts. Before deletion, all 1,936 existing field/record checks passed with the raw mapping pointed at the shared field. Seven additional cursor, archive, shell, deleted and cold cases passed; inverting the shared answer failed all seven.

The full phone corpus then exposed the shared field's missing member-activity fallback when replica timestamps are absent. The added archived-member/no-replica-metadata case failed before correction. The shared getter now borrows the existing addressed seat-summary activity scalar and maintained seat-list size; generic hosts use the shared member-activity answer. The unchanged 1x phone fixture passes all scenario hashes again.

`IssueModel.deferred` now treats `DEFER_NEXT_MESSAGE` as active, as directed by POD-5708; shared `ready` therefore stays false. Other production readers are `mission-view.ts` (ready backlog classification), `UnifiedIssueRow.tsx` (drag eligibility), `pool-sidebar.tsx` (live unsnoozed row) and the existing exit snapshot. Their focused tests are part of validation below.

`createIdentityQuery` and `createMembershipQuery` have no production callers and are deleted. G05/G18 link reads no longer use either helper at this base; data-layer relation lifetime work belongs to POD-5864. The frozen identity helper remains test-only.

`cached.ts` remains because production callers still exist in `header-sessions.ts`, `session-seats.ts`, `mission.ts` and `navigation-activity.ts`. The worklist cachedGroup/cachedKey roster readers and mobile keyed section computeds are removed. `worklist/sidebar.ts` still uses its layout keyed view reader (W03 / POD-5631); other-view caches are outside this issue.

## Validation

All validation runs use the checkout-local pinned Bun on flatblock (`~/podium-test-5822/.toolchain/bun`, with `node` linked to it), focused files, foreground execution and one worker. Ordinary vitest processes are limited to about 3 GiB RSS. The structural census uses the coordinator’s explicit 9.5 GiB exception under `meter:flatblock`, with the MemAvailable/swap stop thresholds.

Final focused consumer tests, full cached typecheck, lean gate, zero-error interaction scan, normal web build and locked structural census: pending.

The current full typecheck passed all 29 projects (17 cached), and the span-effect lint passed. The lean gate then stopped at 170 interaction census errors: 92 stale fingerprints and 78 moved, split or newly traced sites. The reviewed manifest retains all 78 as `REQUIRED REPAIR`, with their predecessor fingerprint and unchanged bounds; none is promoted to a bounded reader. The 2,143 untouched entries retain all metadata unchanged. There are 2,088 repair entries after the migration, versus 2,102 before it. The decrease reflects removed static call paths, not 14 repaired collection operations.

| Reviewed paths | Stale sites | Current sites | Treatment |
| --- | ---: | ---: | --- |
| Phone screens and native descriptor boundary | 3 | 9 | Section descriptors now form at the UI boundary; uncapped section metadata remains debt. |
| Desktop issue/worktree rows, sections, rail and departure snapshot | 24 | 17 | Direct canonical reads replace adapters; fallback partition, represented-issue lookup and outer-band metadata retain their prior bounds. |
| Screen fixtures | 3 | 3 | Canonical names only; fixture collection debt is unchanged. |
| Issue membership fields and their frozen oracle | 3 | 6 | Three direct lazy ID fields plus three test-only old membership reads; relation cardinality is not capped here. |
| Mobile section fields and their frozen oracle | 4 | 7 | The old split loop becomes three fields; four old keyed-reader sites remain test-only. |
| Frozen identity-query oracle | 2 | 2 | No production caller; the old dynamic question and iteration remain tracked in parity evidence. |
| Worktree roster fields | 8 | 9 | Incremental ordering removes heartbeat sorts; roster filters, counts and formatter inputs still have no hard cardinality cap. |
| Shared formatters, keyed helper and pane ownership | 45 | 25 | Upstream origins change or disappear when adapters leave the call graph. The 24 unchanged operation-token sites keep their classifications; unchanged helpers are not claimed as repairs. |

The final shared model/attention/eviction files passed 19 checks, schema-model checks passed 2, the desktop sidebar passed 15 and its newly landed search regression passed 1. Departure paint/memo/mission actions and native section keys also passed their focused runs. Remaining focused runs and final gates are still pending.

Completed focused runs include shared models/attention/eviction (17 checks), roster/query/mission (41 checks), runtime projections/pane (29 checks), and the desktop sidebar (15 checks). The clean full desktop action file passed 42/42, selection inputs 8/8, the refusal mark 1/1 and native sections 13/13. The refusal fixture imports the production Worklist observer row, with its assertions unchanged. These counts are focused-file evidence, not a full suite result.

The native observer library’s Node CommonJS entry bypassed the mobile React alias and loaded a second dispatcher. Its ESM entry now stays inside Vite and uses the mobile renderer’s React. The first screen run then reached its assertions (8 passed, 3 failed), exposing a stale pilot menu fixture and the worktree status subscription above; that run also stopped recorded worker PID 474356 at 3,296,044 KiB RSS. It is incomplete. Before the POD-5880 list-window landing, all 11 screen cases subsequently passed in separate runs without a memory stop: both corpus sizes keep unchanged paint asleep and commit a shown title exactly once, and native bands, search, folds, navigation and launch choices keep their existing assertions. The current-pilot window mismatch is described below.

The coordinator approved adapting the menu mock after the pilot stopped sending copied issue/session arrays. Its fixture now reads visible descendant IDs and the declared raw `pageSessions.unarchived` count, which includes the headless member. Every original count assertion remains. Opening the menu at 1x and 4x reads one row, zero archived payloads and runs five derivations in both cases. Two earlier harness workers were also stopped at the ordinary 3 GiB limit; none of those runs is reported as green.

The full native action file passed all 28 cases against unchanged expected hashes. Its test serializer preserves the old JSON key order. The native boundary also preserves the existing list keys: pinned attention rows use `needs-you:<id>` because they also appear in Pinned; project attention rows use the record ID. Title and unread assertions now read the matching canonical question (`title`, `unread` or `emphasizeUnread`). Native demo and slice files passed 4 and 7 checks respectively.

Strict phone parity also caught dependency-free empty lists for non-project sections. Immutable-kind guards return those constants before entering the lazy project/pinned fields. The diagnostic snapshot reader no longer writes the shared layout while comparing folded layouts; it reads canonical ID lists and uses the existing UI fold formatter. The original mobile field-shape assertion remains, through the canonical serializer.

The unchanged pilot `f4d24bad7f` and the candidate both produce 4x initial phone hash `a4fc2b1d592dd31bf6510228c036f4204ab4aaf6910af26772dad98a20de1459`, while the saved fixture expects `2d3732311dc853654e75ec135e351670814d76bbefbb5b0f749e265de7cef636`. Frozen old ports and the new direct fields have zero value or key-order differences on that same corpus. Expected hashes are unchanged. POD-4286 assigned this pre-existing drift to POD-5885. The candidate diagnostic worker (PID 966363, 3,214,540 KiB RSS) and unchanged-base worker (PID 984452, 3,148,616 KiB RSS) were stopped at the ordinary limit; these runs are incomplete, not green. All four membership cases subsequently passed in fresh workers, including 1x/4x family changes and both broad-scan controls.

On the rebased `8e8efbfa2b` pilot, the interaction census reports 2,215 fingerprints and zero ratchet errors. The coordinator's corrected census resource rule admits at 6 GiB available RAM and stops below 1.5 GiB available RAM or 2 GiB free swap. Current lean/full typecheck/build, matched heap comparison and locked census results remain pending.

On pilot `ff4ca6cf6e`, all three strict grouped-row cases passed. The final field/record proof passed 1,951 checks (1,496 field and 455 record checks), including seven new pendingDecision comparisons. Wrong-answer controls failed all seven decision cases, all eight shared-unread cases, and 74 of the 75 state checks; the actual click remained green. The normal state proof passed all 75 checks. The unchanged command-launch corpus case also passed, including writeBurst50; POD-4286 was informed that this fixes POD-5882. The native action file passed all 28 checks, the 1x phone fixture passed every saved scenario hash, and shared models/attention/eviction passed 19 checks.

The lean gate is green: four of 1,870 collected files, 154 tests. The explicit full typecheck passed all 29 projects (26 cached), and the interaction scan reports 2,217 fingerprints and zero ratchet errors. The normal web build compiled but failed its eager raw-byte budget: 2,150,539 bytes against 2,150,000, an excess of 539 bytes. The unchanged-pilot comparison is pending. The matched heap check ran under the acquired meter lease, followed sequentially by the structural census; census results and production render proof are pending.

The unchanged `ff4ca6cf6e` pilot's normal build passed at 2,145,475 eager raw bytes. Narrowing the boundary and sharing the existing live/departure status formatter reduced the candidate to 2,150,162 bytes; that build still failed the unchanged 2,150,000-byte ceiling. No budget or assertion was relaxed.

On pilot `69c89de202`, the twelve-field boundary passes strict groups (3 checks), record/state parity (530), desktop sidebar (15), and departure/memo checks (3). The lean gate is green, the explicit full typecheck passes all 29 projects (26 cached), and the interaction scan reports 2,227 fingerprints, 2,228 occurrences, 2,092 remaining repair entries and zero ratchet errors. The normal build compiles but fails the unchanged eager-byte ceiling: 2,152,220 versus 2,150,000 bytes (+2,220). The coordinator was mailed that result; no ceiling or other view was edited to make the gate pass.

POD-5880's larger phone list window renders both band copies of the paint fixture's first issue. With the twelve-field boundary, its unshown description edit commits zero rows, while its title edit commits two; the existing assertion expects one. Temporarily restoring the broad boundary produces the same two title commits. The unchanged current pilot also fails this test, at the earlier description assertion (two versus zero). A controlled candidate run using only the preceding window props passes the original zero/one assertions and confirms that this target has two band entries but only one rendered copy in the old window. Both production window props and every original assertion were restored after the comparison. The coordinator was mailed the evidence and asked to assign or authorize the fixture adjustment; that answer is pending.

The earlier canonical structural census passed all 30 checks (7 filtered). The cleanup's additional comparison completed with one ratio-only red: navigation-by-reference element work decreases at both scales, from 91,992 to 91,834 at 1x and 365,603 to 365,064 at 4x, but removing constant work makes the ratio increase slightly. POD-4286 explicitly accepts that exception if it repeats with absolute decreases at both scales and no other regression. The original comparison assertion and baseline remain unchanged; the final narrow-boundary rerun is pending.

The final narrow-boundary census repeats that result under the acquired `meter:flatblock` lease. Canonical `speed:structural` passes all 30 checks (7 filtered). Inspecting every entry in the additional comparison finds seven growing counters before and six after, no new growing keys, no absolute increases among those counters, and exactly the accepted navigation ratio-only red with the same numbers above. Its assertion remains red and is reported as the coordinator's accepted exception, not as a green test. The lease was released after both measurements completed.

The isolated production smoke passes against the normal compiled `69c89de202` candidate: the expanded sidebar displays the created issue, its issue page displays the same title, and there are zero renderer errors. The screenshot is attached as `Production issue page render`. The diagnostic waits for the sidebar to mount before probing its expand button; checking immediately after the loading shell disappeared had missed that button and left the sidebar collapsed.
