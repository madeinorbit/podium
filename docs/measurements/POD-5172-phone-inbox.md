# Phone inbox pool readers

The phone Inbox, proposal screening, Pulse live health, reference chips and link host now read the app-owned pool when the existing mobile pilot is enabled. The device switch still defaults OFF and is latched once; an enabled screen waits through asynchronous pool attachment without mounting a legacy reader. Mutations, RPC polling, transcript requests, optimism and the outbox remain with the existing runtime.

The isolated reader acceptance and seeded production lane are green. The launch child owned by POD-5356 landed with POD-4977 at `68605eaa9e`; this branch now includes it, and complete mounted Inbox acceptance is being finished in POD-5373. POD-5370's phone startup fix landed at `8db927c57f`. Work, Issues, Issue and Mission screens remain with their allocated lanes. Legacy retirement is proposed in POD-5376 for about a week after the operator defaults the screen ON.

## Scope and declarations

The branch started at `integrate/4286-pilot 55876784de`. POD-4286 allocated the five screen/component files, new accessor-only hooks, graph declarations/views/source/diagnostics, focused tests, replay and browser fixtures before implementation. Additional mail allocated mobile `lib/podium-link.ts`, its normalized fixture repair, the shared issue-reference reader, and additive claimant forwarding through the kernel facade and existing row source/runtime loader. After POD-4977 landed, the coordinator allocated NewWorkButton's remaining machine accessor to POD-5373: ON uses the existing `pool.headerViews.machines()` projection, while OFF keeps its original `useMachines`. `pool.ts`, `residency.ts`, `header-views.ts`, `MobileClientProvider.tsx` and other screen lanes are untouched.

The inventory baseline is [POD-5082](POD-5082-legacy-reader-inventory.md): Inbox originally called `useSessions` at line 122, `useIssues` at 123, `useBooting` at 127 and `useOutboxSize` at 128; proposal screening called `useIssues` at 58 and `useBooting` at 61; Pulse called `useMachines` at 107; the link host called `useIssues`, `useSessions` and `useBooting` at 38–40; mobile RefChip called `useIssues` at 88. These are baseline locations, not current line numbers.

`mobile-inbox-schema.ts` declares cursor readiness, shared visible reference prefixes, session triage/permanent-reference summaries, issue screening summaries, `window.outboxSize`, and reused machine/host metric inputs before reading them. It reuses issue-page summary declarations and the core repo, tree, page-session, page-issue and birth-issue relations. `PoolSources.ensure` uses the fixed `mobile-inbox` key on the existing pool attachment. Displayed data passes through `pool.row`; cold rows use declared summaries and the existing batched loader. Prefix membership work is shared once per pool, rather than repeated by each retained chip. No cold payload index or second runtime is created.

Inbox addresses only its visible session cards and their issue pages. Screening derives the queue from summaries, retaining the original ancestor exclusions, sort order, decided deck prefix and retry behavior; only current, next and failure cards and their parents need full rows. Pulse reuses header machines/metrics through independent projections, preserving the machine array identity so a health update does not restart quota polling. Reference taps use the existing addressed reader, including early taps before attachment and a missing cold reference that defers OS fallback until resolution and opens it once. OFF activators keep their synchronous behavior.

## Focused correctness

All tests, typecheck and lint ran on flatblock in `~/podium-test-5172`, with the checkout `.toolchain` and Bun 1.4.2. Validation commands were sequential. No whole-repository suite or web click speed gate was run for this mobile scope.

`bun run test:file --` collected seven named files and passed **55 tests**: the new mobile pool file (14), existing mobile RefChip (4), PodiumLinkHost (4), podium-link (23), web shared-reference pool (7), web reference fence (2), and kernel claimant index (1). This is focused evidence, not a suite result. The tests include real null-to-pool attachment, exact rendered OFF/ON parity, zero enabled selector/issue/slice derivations, positive OFF counts, outbox/optimistic updates, cold references, shared prefix work, stable Pulse polling, source coalescing/disposal, routes, handoffs and single deferred OS fallback.

Twenty-two planted production faults collected failing tests, then restored their original files: changed outbox projection, a legacy issue hook on the enabled path, a comparison that hides differences, permanently pending chips, lost decided deck prefix, a missing addressed chip reader, wrong permanent-session routing, empty health readings, missing source coalescing, dropped pending outbox count, asynchronous OFF activation, premature OS fallback, dropped early taps, last-wins resident aliases, last-wins cold alias resolution, reversed kernel claimant order, inverted triage membership, missing proposal-ancestor exclusion, reversed priority, accepting an unknown prefix, stalled cursor readiness, and accepting a zero-padded bare alias. The pending-chip control exposed a diagnostics census omission; the comparison now counts provisional rows and cannot report green while they are pending.

Focused typecheck passed all 15 tasks for mobile, client-graph, worklist-proto and their dependencies. The graph MobX/fence lint passed. Two narrowly scoped fence annotations identify static summary-field spreads that the syntactic table-walk rule misclassified; they do not permit runtime table walks. Focused Biome lint passed with existing shared-module formatting retained and the two pre-existing kernel assignment-expression diagnostics excluded from this additive change.

Two old podium-link fixtures were repaired to normalized session homes without changing any assertions. Commit `49b7f54965` (POD-5114) retired the computed wire session fields/raw fallback that those fixtures had still supplied.

## Reference collision parity and operator replay

The initial in-memory operator replay found seven route differences, all bare `#seq` aliases with multiple claimants. The shared resident index now keeps claimants in replica row order, and passes ownership to the next resident claimant on physical deletion/eviction. The phone source demands the existing batched authority lookup for bare aliases even if a later claimant is already resident, so an earlier cold owner cannot lose to a warmed row. The additive kernel accessor returns the existing claimant set in order; `IssueRefIndex.id()` and the facade's unique-only API still return undefined for ambiguous aliases. No second kernel index was added.

Web legacy `resolveIssueReference` also selects the first matching issue for its valid prefixed-token grammar. Bare aliases are accepted by mobile link routing but are outside web chip token grammar. The existing web pool and fence tests remain green.

Mobile routing also preserves the literal bare-alias rule: `#099999` remains unavailable when only `#99999` exists. Prefixed tokens retain their existing parser behavior. The affected 14-test file passed again after this correction and after rebasing onto `803ecfa597`; the incoming mobile settings/preferences attachment was retained.

The corrected full replay ran only on ludovico against the existing operator instance, in memory: **6,055 issues, 5,164 sessions, 22,348 route targets and 38,610 comparison positions; zero differences and zero pending reads**. The report contains counts and numeric mismatch locations only. Operator titles, refs, records and values were neither exported to flatblock nor persisted as artifacts.

## Browser and production evidence

The seeded production mobile web lane passed on candidate `0db6318933` after POD-5370's startup fixes. The supported `test:browser` wrapper exported the production phone build, postprocessed and compressed it, and ran one collected Pixel Chromium test: **one passed in 16.2 s (11.5 s in the test)**. Its stamp was `wireSchemaDigest=cb9f0786c0a97c2c`, `wireVersion=4`, `sourceSha=0db6318`, `appVersion=dev+0db6318`, `bundleVersion=bundle+1f8f5d3ca6b7f58204d51e14506d73fb`.

The production check proves OFF remains latched after editing the setting, an ON restart loads the pool chunk, seeded proposal text updates live, Skip advances the deck, the addressed chip changes from Backlog to Review, its actual markdown link reaches the expected task, and Pulse shows streamed machines. No page errors or application console errors were reported. The fixture publishes its normal repository identity with `repos.setPrefix` before seeding issues; the harness's low-level repository registration otherwise omits the logical repo feed row. A twenty-third planted fault sent the addressed prefixed route to `/wrong-issue/`; the runner collected **one failing test at `toHaveURL`**, then the source was restored before the green run.

The clean interleaved capture passed on `23d4493446`, Chromium **148.0.7778.96**, Bun **1.4.2**, on flatblock while holding `bench:flatblock`. It ran OFF/ON/OFF/ON in separate pages at 430×1050. Earlier incomplete fixture runs and the run started before its lease grant are excluded; the lease was released after every completed/failed capture. The evidence uses **5,600 synthetic issues and 5,016 sessions**: 5,014 linked sessions plus two guest sessions inherited from the shared fixture. The screenshot header shows the linked subtotal. Twelve linked sessions remain unarchived; the remainder supplies cold history.

The fixture mounts the actual five readers with the existing store/provider attachment and real startup latch. Router/profile adapters, native swipe animation, launch, storage and refresh siblings are explicit stubs. Five SVG DOM adapters preserve the actual stage-glyph geometry and colours; they supply the browser primitives that Expo normally supplies. This is an isolated development reader measurement. InboxScreen has no current Expo app route; complete mounted Inbox acceptance removes the launch stub after POD-4977 lands.

Enabled mount, activity, relevant updates and reference actions recorded **zero selectorRuns, zero rowBuilds and zero legacy slice derivations**. The OFF mount built 5,600 issue rows and ran 107 selectors. Each OFF activity arm ran 761 selectors and built 27 rows; each OFF relevant-update arm ran 638 selectors and built 20 rows. Both ON comparison arms matched **27 visible positions with zero differences and zero pending reads**. Known issue and permanent session taps reached their expected routes; a missing reference opened the actual RN Web popup destination once per arm. The proposal Skip button advanced the existing deck. There were no page errors or synthetic runtime failures.

| Phase | OFF A commits / task ms | ON A commits / task ms | OFF B commits / task ms | ON B commits / task ms |
| --- | ---: | ---: | ---: | ---: |
| 30 activity publications | 43 / 1,400.7 | 25 / 1,617.7 | 43 / 1,612.0 | 25 / 1,668.0 |
| 20 issue/health updates | 40 / 1,032.3 | 21 / 1,313.5 | 40 / 1,093.5 | 21 / 1,139.6 |

Task time is the CDP `Performance.TaskDuration` delta for the whole publication loop, including the retained proposal screen and platform work. Average React commit duration fell from 608.2 to 332.9 ms for activity and from 502.0 to 401.0 ms for relevant updates. Total task time increased about 9% and 15%, respectively, in these two development-fixture samples. This does not establish an end-to-end speed gain or a production regression; Proposed POD-5387 records the attribution/reproduction work. The device default remains OFF. Initial async attachment took 12–13 ON commits versus eight OFF commits; startup task time and heap were not measured.

Reproduce from the committed candidate in the dedicated checkout:

```sh
podium lock acquire bench:flatblock --ttl 10m --wait
# Wait for the grant, then on flatblock:
cd ~/podium-test-5172
export PATH="$HOME/podium-test-5172/.toolchain:$PATH"
export LD_LIBRARY_PATH="$HOME/podium-test-5172/.toolchain/lib"
timeout 600 bun apps/mobile/test/inbox-proof.ts
# Release the lease immediately after capture, including a failure:
podium lock release bench:flatblock
```

Raw synthetic capture results and Inbox/proposal screenshots are attached to the issue, alongside the seeded production proposal and Pulse screenshots. The production suite uses the unchanged issue detail only as a rich-text host and does not migrate that screen. InboxScreen has no current Expo app route, so its complete mounted acceptance uses the isolated browser fixture with the actual reader siblings rather than claiming production-route coverage.
