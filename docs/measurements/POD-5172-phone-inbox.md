# Phone inbox pool readers

The phone Inbox, proposal screening, Pulse live health, reference chips and link host now read the app-owned pool when the existing mobile pilot is enabled. The device switch still defaults OFF and is latched once; an enabled screen waits through asynchronous pool attachment without mounting a legacy reader. Mutations, RPC polling, transcript requests, optimism and the outbox remain with the existing runtime.

This report covers isolated reader acceptance. The unchanged launch child is owned by POD-5356 and is stubbed in this proof; complete mounted Inbox acceptance and a seeded production export are tracked in POD-5373 after POD-5356 and POD-5370 land. Work, Issues, Issue and Mission screens remain with their allocated lanes. Legacy retirement is proposed in POD-5376 for about a week after the operator defaults the screen ON.

## Scope and declarations

The branch started at `integrate/4286-pilot 55876784de`. POD-4286 allocated the five screen/component files, new accessor-only hooks, graph declarations/views/source/diagnostics, focused tests, replay and browser fixtures before implementation. Additional mail allocated mobile `lib/podium-link.ts`, its normalized fixture repair, the shared issue-reference reader, and additive claimant forwarding through the kernel facade and existing row source/runtime loader. `pool.ts`, `residency.ts`, `header-views.ts`, `MobileClientProvider.tsx` and other screen lanes are untouched.

The inventory baseline is [POD-5082](POD-5082-legacy-reader-inventory.md): Inbox originally called `useSessions` at line 122, `useIssues` at 123, `useBooting` at 127 and `useOutboxSize` at 128; proposal screening called `useIssues` at 58 and `useBooting` at 61; Pulse called `useMachines` at 107; the link host called `useIssues`, `useSessions` and `useBooting` at 38–40; mobile RefChip called `useIssues` at 88. These are baseline locations, not current line numbers.

`mobile-inbox-schema.ts` declares cursor readiness, shared visible reference prefixes, session triage/permanent-reference summaries, issue screening summaries, `window.outboxSize`, and reused machine/host metric inputs before reading them. It reuses issue-page summary declarations and the core repo, tree, page-session, page-issue and birth-issue relations. `PoolSources.ensure` uses the fixed `mobile-inbox` key on the existing pool attachment. Displayed data passes through `pool.row`; cold rows use declared summaries and the existing batched loader. Prefix membership work is shared once per pool, rather than repeated by each retained chip. No cold payload index or second runtime is created.

Inbox addresses only its visible session cards and their issue pages. Screening derives the queue from summaries, retaining the original ancestor exclusions, sort order, decided deck prefix and retry behavior; only current, next and failure cards and their parents need full rows. Pulse reuses header machines/metrics through independent projections, preserving the machine array identity so a health update does not restart quota polling. Reference taps use the existing addressed reader, including early taps before attachment and a missing cold reference that defers OS fallback until resolution and opens it once. OFF activators keep their synchronous behavior.

## Focused correctness

All tests, typecheck and lint ran on flatblock in `~/podium-test-5172`, with the checkout `.toolchain` and Bun 1.4.2. Validation commands were sequential. No whole-repository suite or web click speed gate was run for this mobile scope.

`bun run test:file --` collected seven named files and passed **55 tests**: the new mobile pool file (14), existing mobile RefChip (4), PodiumLinkHost (4), podium-link (23), web shared-reference pool (7), web reference fence (2), and kernel claimant index (1). This is focused evidence, not a suite result. The tests include real null-to-pool attachment, exact rendered OFF/ON parity, zero enabled selector/issue/slice derivations, positive OFF counts, outbox/optimistic updates, cold references, shared prefix work, stable Pulse polling, source coalescing/disposal, routes, handoffs and single deferred OS fallback.

Sixteen planted production faults collected failing tests, then restored their original files: changed outbox projection, a legacy issue hook on the enabled path, a comparison that hides differences, permanently pending chips, lost decided deck prefix, a missing addressed chip reader, wrong permanent-session routing, empty health readings, missing source coalescing, dropped pending outbox count, asynchronous OFF activation, premature OS fallback, dropped early taps, last-wins resident aliases, last-wins cold alias resolution, and reversed kernel claimant order. The pending-chip control exposed a diagnostics census omission; the comparison now counts provisional rows and cannot report green while they are pending.

Focused typecheck passed all 15 tasks for mobile, client-graph, worklist-proto and their dependencies. The graph MobX/fence lint passed. Two narrowly scoped fence annotations identify static summary-field spreads that the syntactic table-walk rule misclassified; they do not permit runtime table walks. Focused Biome lint passed with existing shared-module formatting retained and the two pre-existing kernel assignment-expression diagnostics excluded from this additive change.

Two old podium-link fixtures were repaired to normalized session homes without changing any assertions. Commit `49b7f54965` (POD-5114) retired the computed wire session fields/raw fallback that those fixtures had still supplied.

## Reference collision parity and operator replay

The initial in-memory operator replay found seven route differences, all bare `#seq` aliases with multiple claimants. The shared resident index now keeps claimants in replica row order, and passes ownership to the next resident claimant on physical deletion/eviction. The phone source demands the existing batched authority lookup for bare aliases even if a later claimant is already resident, so an earlier cold owner cannot lose to a warmed row. The additive kernel accessor returns the existing claimant set in order; `IssueRefIndex.id()` and the facade's unique-only API still return undefined for ambiguous aliases. No second kernel index was added.

Web legacy `resolveIssueReference` also selects the first matching issue for its valid prefixed-token grammar. Bare aliases are accepted by mobile link routing but are outside web chip token grammar. The existing web pool and fence tests remain green.

The corrected full replay ran only on ludovico against the existing operator instance, in memory: **6,055 issues, 5,164 sessions, 22,348 route targets and 38,610 comparison positions; zero differences and zero pending reads**. The report contains counts and numeric mismatch locations only. Operator titles, refs, records and values were neither exported to flatblock nor persisted as artifacts.

## Browser and production evidence

The production build and interleaved Chromium capture are the remaining gates for this report. Browser evidence uses 5,600 synthetic issues and 5,014 synthetic sessions with the actual five readers, existing store/provider attachment and the real startup latch. Platform router/profile adapters, native animation, launch, storage and refresh siblings are explicit fixture stubs; it is an isolated reader measurement, not complete phone application acceptance.

