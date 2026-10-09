# Worklist cleanup evidence

POD-5822 follows the frontend data guide rules 3, 4, 5, 8 and 9 and the names approved by POD-5708 on 2026-10-08. The canonical name table was committed before implementation in `4b7de6fe0f`; its approved corrections are in `pod-5822-names.md`.

## Result

Desktop sidebar, rail and phone Work rows read `WorklistIssue`, `WorklistWorktree` or their shared record directly. The three forwarding ports, issue Proxy and per-row helper companion maps are removed. Shared record facts use `IssueModel` names; worklist-specific facts keep one canonical field. The existing departure snapshot remains the only frozen row paint.

Selection and its fold latch are Worklist observable accessors. A row derives `selected` by ID equality; `selectionGone` reads the selected shared model’s replica `exitKind`. The runtime selection property delegates to Worklist while attached, and standalone sources feed Worklist directly. There is no second selection map, eviction value or reaction keeping them aligned. Device persistence remains POD-5797.

Worklist-created membership lists are shallow-equal lazy model/ID fields. Mobile section fields are lazy parts owned by the Worklist and group nodes. The Worklist retains section-key lists and each section’s issue/worktree IDs; native SectionList descriptors are formed only at the phone UI boundary. The phone root observes the model counts directly. Worktree roster ordering uses incremental ordered data queries over shared sessions, with shallow-equal visible/stale lists. Folded header counts read narrow shared session flags; navigation activity reads scalar session timestamps. Clock behavior remains POD-5863.

The cached `factRow` is replaced by an ephemeral record read inside each scalar model getter. `loadedIssue` and `loadedOrigin` retain shared models or the same LOADING/absent answers. Their only production readers are readiness and the origin's id/seq/title; the data layer's `rollupInputs.loadedIssue` protocol is unchanged. Schema-installed issue fields use the existing lazy decorator so a sort-only edit does not redraw an unchanged title/color reader; other entity getters are unchanged.

## Before/after proof

The old implementation is preserved only in test oracles (`issue-before.test-helper.ts`, `lists-before.test-helper.ts`, `query-identity-before.test-helper.ts`, `mobile-before.test-helper.ts`, `heartbeat-before.test-helper.ts`). Production imports none of them. The initial port parity proof ran before deleting adapters, including a deliberately wrong candidate; the expanded proof compares each moved/renamed answer with its frozen predecessor on the same fixtures.

`field-parity.test.ts` covers working, waiting, folded parents, merge decisions, quiet drafts, timed defer, next-message defer and spin-off origins, plus unknown, LOADING and selected evicted records. `state-parity.test.tsx` exercises a real row click (render counts old row 2, new row 2, unrelated row 1), compares old/new mobile sections and roster partitions, and proves an unrelated heartbeat invokes zero roster sorts and zero folded-header count reads. The changed issue’s navigation activity still advances.

Expanded proof: 1,473 checks green. With `POD5822_MUTATE=1`, 1,469 checks fail and the four independent boundary checks pass. The original pre-deletion proof was 373 green; its wrong-answer control failed 371 checks.

Before removing retained raw records, the expanded field and record-fact proof passed 1,530 checks (1,488 field answers and 42 scalar facts). Its wrong-answer control failed 1,527 checks; the three independent boundary checks stayed green. Before wrapping schema-installed issue fields, all 406 stored-field comparisons passed; their wrong-answer control failed all 406. The same fixtures include open, closed, actual private-branch merge, archived, deleted, cold and missing records.

After the pilot rebase and direct section-key correction, 1,936 issue/record-field checks passed. The expanded state proof passed 67 checks, including 16 worktree fields across waiting, working, queued and stale rosters. Its wrong-answer control failed 66 checks; the actual selection click remained an independent green check. The two section-key lists are also compared directly with the frozen keyed section output and fail their wrong-answer control.

The native direct reader exposed an unnecessary roster-identity subscription in non-waiting worktree status labels. Two scalar totals, `sessionCount` and `workingCount`, replace the formatter’s direct list walks for working/done/idle labels. Waiting keeps its existing formatter and clock behavior. Timing and fleet use structural equality for their small rebuilt objects. The expanded worktree parity now passes 75 checks, covering both totals on all four roster fixtures.

The incremental roster query now receives keyed candidate moves from the existing roster index inside the pool publication’s action. The delayed full-reset membership reaction briefly exposed an empty list during a session replacement; removing it keeps the worktree phase unchanged. The existing native hidden-navigation test passes with zero commits, then opens the replacement session when pressed. The expanded state wrong-answer control fails 74 checks; the actual selection click remains green.

The coordinator-requested cold reference test demonstrated the old shared getter returning an empty string instead of the declared `POD-0` identity. `displayRef` now borrows the declared summary’s numeric sequence and shared prefix without demanding the payload. Declared, undeclared and missing identities pass with no load scheduling; the model file passes 13 checks.

`worklist-issue-fields-memory.ts` holds the same desktop/phone paint questions over the existing 4x corpus and reports watched computeds and post-GC heap. The comparison around the issue getter change is pending; a heap increase above about 5% requires coordinator review before landing. `worklist-production-smoke.ts` will verify one sidebar row and its issue page from the normal production build in an isolated harness.

## Shared answers and remaining helpers

Design confirmed three separate unread questions: `unread` is unread activity in the retained subtree, `visibleUnread` suppresses desktop emphasis while working, and `emphasizeUnread` also handles quiet phone drafts. Each field documents its scope.

`IssueModel.deferred` now treats `DEFER_NEXT_MESSAGE` as active, as directed by POD-5708; shared `ready` therefore stays false. Other production readers are `mission-view.ts` (ready backlog classification), `UnifiedIssueRow.tsx` (drag eligibility), `pool-sidebar.tsx` (live unsnoozed row) and the existing exit snapshot. Their focused tests are part of validation below.

`createIdentityQuery` and `createMembershipQuery` have no production callers and are deleted. G05/G18 link reads no longer use either helper at this base; data-layer relation lifetime work belongs to POD-5864. The frozen identity helper remains test-only.

`cached.ts` remains because production callers still exist in `header-sessions.ts`, `session-seats.ts`, `mission.ts` and `navigation-activity.ts`. The worklist cachedGroup/cachedKey roster readers and mobile keyed section computeds are removed. `worklist/sidebar.ts` still uses its layout keyed view reader (W03 / POD-5631); other-view caches are outside this issue.

## Validation

All validation runs use the checkout-local pinned Bun on flatblock (`~/podium-test-5822/.toolchain/bun`, with `node` linked to it), focused files, foreground execution and one worker. Ordinary vitest processes are limited to about 3 GiB RSS. The structural census uses the coordinator’s explicit 9.5 GiB exception under `meter:flatblock`, with the MemAvailable/swap stop thresholds.

Final focused consumer tests, full cached typecheck, lean gate, zero-error interaction scan, normal web build and locked structural census: pending.

Completed focused runs include shared models/attention/eviction (17 checks), roster/query/mission (41 checks), runtime projections/pane (29 checks), and the desktop sidebar (15 checks). The clean full desktop action file passed 42/42, selection inputs 8/8, the refusal mark 1/1 and native sections 13/13. The refusal fixture imports the production Worklist observer row, with its assertions unchanged. These counts are focused-file evidence, not a full suite result.

The native observer library’s Node CommonJS entry bypassed the mobile React alias and loaded a second dispatcher. Its ESM entry now stays inside Vite and uses the mobile renderer’s React. The first screen run then reached its assertions (8 passed, 3 failed), exposing a stale pilot menu fixture and the worktree status subscription above; that run also stopped recorded worker PID 474356 at 3,296,044 KiB RSS. It is incomplete. All 11 screen cases subsequently passed in separate runs without a memory stop: both corpus sizes keep unchanged paint asleep and commit a shown title exactly once, and native bands, search, folds, navigation and launch choices keep their existing assertions.

The coordinator approved adapting the menu mock after the pilot stopped sending copied issue/session arrays. Its fixture now reads visible descendant IDs and the declared raw `pageSessions.unarchived` count, which includes the headless member. Every original count assertion remains. Opening the menu at 1x and 4x reads one row, zero archived payloads and runs five derivations in both cases. Two earlier harness workers were also stopped at the ordinary 3 GiB limit; none of those runs is reported as green.
