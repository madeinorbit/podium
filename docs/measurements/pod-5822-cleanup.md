# Worklist cleanup evidence

POD-5822 follows the frontend data guide rules 3, 4, 5, 8 and 9 and the names approved by POD-5708 on 2026-10-08. The canonical name table was committed before implementation in `375e79a8b4`; its approved corrections are in `pod-5822-names.md`.

## Result

Desktop sidebar, rail and phone Work rows read `WorklistIssue`, `WorklistWorktree` or their shared record directly. The three forwarding ports, issue Proxy and per-row helper companion maps are removed. Shared record facts use `IssueModel` names; worklist-specific facts keep one canonical field. The existing departure snapshot remains the only frozen row paint.

Selection and its fold latch are Worklist observable accessors. A row derives `selected` by ID equality; `selectionGone` reads the selected shared model’s replica `exitKind`. The runtime selection property delegates to Worklist while attached, and standalone sources feed Worklist directly. There is no second selection map, eviction value or reaction keeping them aligned. Device persistence remains POD-5797.

Worklist-created membership lists are shallow-equal lazy model/ID fields. Mobile section fields are lazy parts owned by the Worklist and group nodes; native SectionList descriptors are formed at the UI boundary. Worktree roster ordering uses incremental ordered data queries over shared sessions, with shallow-equal visible/stale lists. Folded header counts read narrow shared session flags; navigation activity reads scalar session timestamps. Clock behavior remains POD-5863.

## Before/after proof

The old implementation is preserved only in test oracles (`issue-before.test-helper.ts`, `lists-before.test-helper.ts`, `query-identity-before.test-helper.ts`, `mobile-before.test-helper.ts`, `heartbeat-before.test-helper.ts`). Production imports none of them. The initial port parity proof ran before deleting adapters, including a deliberately wrong candidate; the expanded proof compares each moved/renamed answer with its frozen predecessor on the same fixtures.

`field-parity.test.ts` covers working, waiting, folded parents, merge decisions, quiet drafts, timed defer, next-message defer and spin-off origins, plus unknown, LOADING and selected evicted records. `state-parity.test.tsx` exercises a real row click (render counts old row 2, new row 2, unrelated row 1), compares old/new mobile sections and roster partitions, and proves an unrelated heartbeat invokes zero roster sorts and zero folded-header count reads. The changed issue’s navigation activity still advances.

Expanded proof: 1,473 checks green. With `POD5822_MUTATE=1`, 1,469 checks fail and the four independent boundary checks pass. The original pre-deletion proof was 373 green; its wrong-answer control failed 371 checks.

## Shared answers and remaining helpers

Design confirmed three separate unread questions: `unread` is unread activity in the retained subtree, `visibleUnread` suppresses desktop emphasis while working, and `emphasizeUnread` also handles quiet phone drafts. Each field documents its scope.

`IssueModel.deferred` now treats `DEFER_NEXT_MESSAGE` as active, as directed by POD-5708; shared `ready` therefore stays false. Other production readers are `mission-view.ts` (ready backlog classification), `UnifiedIssueRow.tsx` (drag eligibility), `pool-sidebar.tsx` (live unsnoozed row) and the existing exit snapshot. Their focused tests are part of validation below.

`createIdentityQuery` and `createMembershipQuery` have no production callers and are deleted. G05/G18 link reads no longer use either helper at this base; data-layer relation lifetime work belongs to POD-5864. The frozen identity helper remains test-only.

`cached.ts` remains because production callers still exist in `header-sessions.ts`, `session-seats.ts`, `mission.ts` and `navigation-activity.ts`. The worklist cachedGroup/cachedKey roster readers and mobile keyed section computeds are removed. `worklist/sidebar.ts` still uses its layout keyed view reader (W03 / POD-5631); other-view caches are outside this issue.

## Validation

All validation runs use the checkout-local pinned Bun on flatblock (`~/podium-test-5822/.toolchain/bun`, with `node` linked to it), focused files, foreground execution and one worker. Ordinary vitest processes are limited to about 3 GiB RSS. The structural census uses the coordinator’s explicit 9.5 GiB exception under `meter:flatblock`, with the MemAvailable/swap stop thresholds.

Final focused consumer tests, full cached typecheck, lean gate, zero-error interaction scan, normal web build and locked structural census: pending.
