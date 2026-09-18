# Reactive pilot decision

**Decision: use MobX 7.0.3 and mobx-react-lite 5.0.3 for the disabled pilot.**

> **Read this with [D7](4364-keyed-store-comparison.md).** This record answers "which
> library, if a library". D7 answers the prior question, "is a library needed at all",
> and recommends **no**: a 130-line hand-written keyed store matches every isolation
> assertion here, uses 37–42% less mounted heap, adds zero library bytes, and cuts
> mission calls per relevant delta from 200 to 5 and group session visits from 40,000
> to 200 — a reduction neither library achieved. The two records do not conflict: this
> one stands as the library choice should the operator want one. The operator has not
> chosen between them.

Date: 2026-09-19. Owner: POD-4321, coordinated by POD-4286. This freezes the pilot conventions; it does not enable a feature, migrate a production consumer, or approve a production rollout.

Both candidates met the same row-isolation and semantic assertions. MobX has substantially lower bootstrap, full-rescope and mounted-heap costs in this topology. TanStack DB expresses the relational summary and ordering natively, but leaves the mission/provenance/nesting work in JavaScript. Those benefits do not offset its measured per-reader graph cost here. Legend State was not invoked: MobX passed React 19, Vite and Expo native-module builds. No additional framework is introduced.

The baseline is [B13 post-B](../measurements/POD-4358-post-b-baseline.md), with its [numeric capture](../measurements/POD-4358-post-b-live.json), not C1. That live warm window recorded 28 worklist derivations / 4,098.10 ms. It is context, not a matched control for this synthetic fixture. This proof claims no production latency reduction and credits none of Phase B’s gains to MobX. A manual keyed implementation was not benchmarked, so these results do not establish that a library is necessary.

**Proof and interpretation.** [Executable source](../../packages/client-core/proofs/d1/README.md) and [all aggregate measurements](../measurements/POD-4321-reactive-proof.json) are retained. The fixture copies A3’s issue/session wire shapes and cardinalities: 4,867 issues / 4,304 sessions, and 9,734 / 8,608 for growth rescope. Repository paths span 500 / 1,000 repositories; unused repository/worktree entity tables are not materialized. Five-issue families, mixed working/needs-user/done phases, pinning and an expiring defer enrich A3’s flat all-working data. This is synthetic data at live scale, not customer state.

Each mounted cohort has N session row readers, two consumers of the same issue summary, and a 200-issue worklist group (40 five-issue families). “Same” means all readers address s0; “distinct” means s0…s(N−1), with a separate findOne graph per TanStack reader in both cases. Sharing one TanStack row query among repeated-ID consumers is possible but is not this measured topology. s4000 is the unrelated delta; s0 is relevant. Both receive 20 increasing activity timestamps, identical inputs, and the real missionRollup, nestStartedByIssues and ordering rules. Reassignment, readAt, child completion, reparenting and clock expiry are checked against the same domain oracle. Only TanStack’s four virtual metadata fields are removed from the equality comparison.

Times are shared-host action-entry through settled React act, not browser paint, native-device latency or isolated CPU time. p50/p95 use sorted element floor(q×n), capped at n−1; with 20 deltas p95 is the largest sample. Bootstrap is one point per cohort, not a distribution. Rescope is three full replacements, growth → live → growth, retaining the mounted readers. It is not incremental feed-scope reconciliation. The raw record also contains synchronous mutation time. Web uses Bun 1.4.2 / React 19.2.7; the mobile unit lane uses React 19.2.3 and react-native-web in happy-dom. Expo iOS/Android results establish bundle/module compatibility, not a device run.

**Isolation, before/after and shared reads.**

| Scenario, per delta | MobX | TanStack DB |
| --- | ---: | ---: |
| Unrelated session, N=200 | 0 row reads / 0 committed effects | 0 / 0 |
| Unrelated session, N=1000 | 0 / 0 | 0 / 0 |
| Relevant session, all readers address it | N reads / N committed effects | N / N |
| Relevant session, distinct addresses | 1 read / 1 committed effect | 1 / 1 |
| Unrelated summary/group renders | 0 / 0 | 0 / 0 |

Committed effects count each row component’s committed render, with StrictMode off; they are not root-commit or paint counts. The coarse-subscription control produces **200 → 0 and 1,000 → 0** unrelated row reads/committed effects when comparing the armed control with either candidate. The exact zero-isolation assertion demonstrably throws for that control. This proves detector sensitivity, not that the shipped post-B UI currently commits all N rows. MobX computes one shared summary per relevant delta for its two consumers. TanStack shares the aggregate/query collections; each consumer assembles its phase-count object from their outputs.

**Wall time, milliseconds.** Each delta cell is p50 / p95. All figures below are from the final explicitly indexed TanStack run, without index-fallback or teardown warnings.

**Web**

| Candidate | N / addresses | Bootstrap | Unrelated delta | Relevant delta | Full rescope p50 / p95 |
| --- | --- | ---: | ---: | ---: | ---: |
| mobx | 200 / same | 65.76 | 0.014 / 0.629 | 3.949 / 11.299 | 27.685 / 54.984 |
| mobx | 200 / distinct | 18.01 | 0.008 / 0.266 | 2.033 / 3.893 | 21.560 / 22.084 |
| mobx | 1000 / same | 32.78 | 0.008 / 0.839 | 8.766 / 14.015 | 30.423 / 33.169 |
| mobx | 1000 / distinct | 26.27 | 0.009 / 0.238 | 2.367 / 5.186 | 25.874 / 36.549 |
| tanstack | 200 / same | 865.07 | 1.995 / 22.532 | 28.586 / 84.381 | 1738.239 / 2069.893 |
| tanstack | 200 / distinct | 370.58 | 0.497 / 2.677 | 4.532 / 7.226 | 1528.028 / 2067.655 |
| tanstack | 1000 / same | 480.88 | 3.298 / 4.661 | 115.016 / 271.917 | 4915.247 / 5096.643 |
| tanstack | 1000 / distinct | 524.12 | 3.422 / 107.660 | 9.666 / 64.760 | 3784.197 / 4651.612 |

**Mobile unit renderer**

| Candidate | N / addresses | Bootstrap | Unrelated delta | Relevant delta | Full rescope p50 / p95 |
| --- | --- | ---: | ---: | ---: | ---: |
| mobx | 200 / same | 74.66 | 0.033 / 4.005 | 10.699 / 26.494 | 44.938 / 240.032 |
| mobx | 200 / distinct | 27.10 | 0.009 / 0.225 | 2.602 / 10.959 | 39.708 / 40.735 |
| mobx | 1000 / same | 56.66 | 0.007 / 5.080 | 16.854 / 24.039 | 48.491 / 50.820 |
| mobx | 1000 / distinct | 57.39 | 0.009 / 6.753 | 3.433 / 7.284 | 62.062 / 74.407 |
| tanstack | 200 / same | 1006.21 | 1.553 / 4.847 | 51.061 / 68.565 | 3254.829 / 3727.969 |
| tanstack | 200 / distinct | 771.47 | 0.760 / 2.228 | 4.782 / 11.233 | 3297.196 / 4337.667 |
| tanstack | 1000 / same | 994.26 | 3.431 / 14.313 | 181.272 / 409.882 | 9219.838 / 10789.678 |
| tanstack | 1000 / distinct | 1113.62 | 2.475 / 11.740 | 7.160 / 14.064 | 8968.894 / 10806.247 |

**Mounted heap.** One fresh Bun process per case mounts the same React components and group. Library imports and the input fixture precede the baseline; three synchronous-GC samples at each endpoint supply the median. This measures graph plus renderer allocation, not mobile-device RSS. Sequential unit-process deltas (including negative values) remain in the raw evidence but are rejected for the memory comparison. The post-disposal column still includes initialized React/library caches and retained harness variables; it is not a leak estimate.

| Candidate | N / addresses | Mounted delta MiB | After disposal delta MiB |
| --- | --- | ---: | ---: |
| mobx | 200 / same | 8.95 | 2.78 |
| mobx | 200 / distinct | 8.97 | 2.96 |
| mobx | 1000 / same | 12.90 | 3.60 |
| mobx | 1000 / distinct | 13.59 | 3.55 |
| tanstack | 200 / same | 60.70 | 11.80 |
| tanstack | 200 / distinct | 60.65 | 11.81 |
| tanstack | 1000 / same | 86.74 | 13.04 |
| tanstack | 1000 / distinct | 86.74 | 13.04 |

**Native work versus JavaScript.** Physical source lines, including comments/blanks: MobX adapter 76; TanStack adapter 105; shared fixture/helpers 69. Inside the shared file, summaryJS is 13 lines, worklistJS 15, and the band wrapper 4. TanStack’s phase/latest/child aggregates plus summary joins occupy 19 lines including their index declarations; its group membership/clock/rank declarations occupy 16 lines. These are auditable source regions, not an assertion that every adapter line is a derivation.

| Concern | MobX | TanStack DB |
| --- | --- | --- |
| Addressed row | Native keyed observable dependency + observer | Native indexed findOne query + useLiveQuery |
| Sessions by issue / children by parent | Hand-maintained observable membership maps | Explicit BasicIndex indexes on source and derived join keys |
| Phase counts, latest activity, unread, child done | 13-line JavaScript summary under one computed | Native groupBy/count/max/sum/caseWhen/joins; phase object assembly remains JavaScript |
| Clock-dependent rank | Existing JavaScript band predicate and sort | Same JavaScript band predicate in fn.select; native orderBy on band/manual key/creation/sequence/id |
| Mission, provenance, cycle handling, nesting, bubbling | Existing JavaScript under computed | Same existing JavaScript over query outputs |

The existing modules containing those domain rules remain unchanged: mission.ts 2,549 lines, worklist/rows.ts 480, row-order.ts 71. These are module sizes, not executed-line counts or newly written code. Neither candidate natively replaces the recursive mission/provenance rules. This proof intentionally exposes that residual rather than substituting a simpler domain algorithm.

| Instrumented work per activity delta in the 200-issue group | MobX unrelated / relevant | TanStack unrelated / relevant |
| --- | ---: | ---: |
| Summary JavaScript evaluations | 0 / 1 | 0 / 0 (native relational summary) |
| Session visits in shared helper | 0 / 40,001 | 0 / 40,000 |
| Child visits in summary helper | 0 / 4 | 0 / 0 |
| Existing missionRollup calls | 0 / 200 | 0 / 200 |
| Existing nesting calls | 0 / 1 | 0 / 1 |
| JavaScript top-level sort calls | 0 / 1 | 0 / 0 |
| Shared-query output records | not applicable | 1 / 3 |

The 40,000 session visits are the explicit 200×200 row-materialization loop, not hidden library work. Mission-call counts include memoized calls and do not imply 200 full mission recomputations. TanStack additionally performs two phase-output visits (one per summary consumer), 40 root-map inserts and 200 rank-to-row lookups per relevant group render. Its shared-query output count excludes the N addressed-row queries, whose reader/commit work is shown separately. Internal differential-dataflow operator counts are unavailable through the public API; output counts must not be presented as total engine operations. Clock/rescope counters are retained together in the raw record. Native orderBy is actually consumed by the resulting row group and checked against the existing sorter.

This is also the pilot’s limiting negative: **neither prototype eliminates the real mission/nesting JavaScript remainder**. A session → per-issue computed → worklist-row migration must remove that repeated group materialization and demonstrate the B13 acceptance budgets. Selecting MobX alone is not evidence that the application budgets pass.

**Lifetime and disposal.** Both lanes verify one MobX onBecomeUnobserved notification, no summary work for an unobserved update, and two recomputations for two unobserved get() calls. Computeds suspend; they are not permanent memo tables. TanStack findOne reaches cleaned-up after unsubscribe with gcTime=1 ms (observed after a 20 ms timer). Source collections use gcTime=0 and require explicit owner disposal. Dependent queries must be disposed before their source queries: a source-first counterfactual emits the error that the dependency-ordered path avoids. Both paths are tested. The isolated memory run also disposes immediately after unmount without library errors.

**Bundle costs and compatibility.** Sizes are bytes and gzip bytes from actual emitted bundles. Vite library entries export the APIs used here, including BasicIndex for TanStack, and externalize React; full proof bundles add existing domain rules. Expo bundles include React and the platform runtime. These are standalone proof costs, not an additive prediction for a future application chunk.

| Candidate | Build | Bytes | Gzip bytes |
| --- | --- | ---: | ---: |
| mobx | Vite isolated proof; React external | 274,522 | 64,849 |
| mobx | Vite library-only; React external | 68,741 | 18,160 |
| mobx | Expo web isolated entry; includes React | 835,343 | 205,900 |
| mobx | Expo ios isolated entry; includes React | 899,798 | 222,811 |
| mobx | Expo android isolated entry; includes React | 899,798 | 222,811 |
| tanstack | Vite isolated proof; React external | 589,147 | 139,190 |
| tanstack | Vite library-only; React external | 379,877 | 91,570 |
| tanstack | Expo web isolated entry; includes React | 1,250,349 | 308,099 |
| tanstack | Expo ios isolated entry; includes React | 1,304,785 | 326,115 |
| tanstack | Expo android isolated entry; includes React | 1,304,785 | 326,115 |

Exact pins: mobx 7.0.3; mobx-react-lite 5.0.3; @tanstack/db 0.9.2; @tanstack/react-db 0.4.1; @tanstack/db-sqlite-persistence-core 0.2.23. MobX remains dev-only. The requested DB upgrade exposed an existing companion mismatch: 0.2.8 depended on DB 0.6.16 and failed the new sync types. POD-4362 aligns the companion to 0.2.23, which depends on DB 0.9.2; no legacy adapter code changed. The existing SQLite and contract tests pass. Mobile Vitest must transform mobx-react-lite’s ESM entry so it uses mobile’s React 19.2.3 instead of client-core’s 19.2.7 CJS peer graph. All Expo platform entries build without that test-only alias.

**Frozen pilot conventions.**

1. **Ownership:** one private MobX read model per existing kernel runtime/account scope. The kernel remains the sole mutation/optimism owner. Feed only its effective post-optimism rows into shallow observable maps keyed by branded IDs. Do not copy the outbox, author mutations through MobX, or add persistence to this layer. Treat row values and membership arrays as immutable; update old/new index buckets with the row in one action.
2. **Reads:** observer leaves read an addressed ID during render. Shared issue summaries are one computed per issue, reused by both consumers. Keep stable model references in context; do not copy observed values into React state or take an untracked snapshot outside the observer and expect it to update. Expose readonly read methods, not writable maps. This proof establishes row-level isolation, not same-row property-level isolation.
3. **Lifetimes:** use lazy computed values without keepAlive. Suspended computations may be recomputed by unobserved get(); imperative callers must not rely on a hidden permanent cache. Remove registry entries on entity removal/rescope and clear them on owner disposal. Every explicit reaction/subscription has a disposer. Preserve stable intermediate computed arrays with shallow identity equality so a clock tick does not manufacture new issue/session inputs.
4. **Actions:** each already-coalesced effective kernel batch enters one synchronous runInAction, covering row changes and membership-index changes atomically. No network/storage work or await inside the action. Computeds remain pure; diagnostic counters in this proof are measurement instrumentation only. The existing coarse clock is an explicit observable input; do not read Date.now invisibly inside a computed or start per-row timers.
5. **Migration boundary:** session read → shared issue summary → worklist row, in that order, behind the pilot’s disabled path. Preserve missing-row semantics and existing mission/provenance/cycle/visibility/order rules. Move the arbitrary derivation into bounded per-issue dependencies before expanding to a whole worklist. Validate insert/delete/reassignment/rescope and optimistic echo/rejection at that boundary. Do not migrate unrelated views or introduce a multi-library production adapter. The pilot uses MobX only.

These conventions agree with [MobX computed suspension](https://mobx.js.org/computeds.html) and [React observer reads](https://mobx.js.org/react-integration.html); the executable assertions above are the version-pinned evidence. TanStack’s relational scope is described in its [live-query documentation](https://tanstack.com/db/latest/docs/guides/live-queries).

**Retirement, disable path and validation.** [ADR 6](../adr/0006-replica-storage.md) rejected TanStack DB + localStorage as replica persistence. [The retirement plan §6.3](../agents/pod-378-tanstack-retirement.md) and POD-1245 schedule deletion of the legacy adapter and TanStack dependencies. TanStack loses this read-model proof, so this decision does not reverse that retirement. The disposable comparison harness is not a new production consumer: when POD-1245 drops the dependencies, remove the comparison directory, its two app test entries, its mobile-test alias/inline entries and its two Turbo proof inputs/env entries too. Keep this decision and the consolidated measurements in docs. The planned deletion can proceed; it must not retain TanStack solely to keep this historical experiment executable.

Disable now: omit PODIUM_D1_PROOF=1 (ordinary unit runs skip the expensive comparison and do not rewrite its results). Remove the proof directory and its test/config additions to discard the experiment; revert the manifest/lockfile pins to restore the pre-proof dependency graph. No feature flag, production route, installed build or database state was changed. The comparison directory is test-only, not a multi-library application abstraction.

Validation command: `bun scripts/test-heavy.ts -- bun packages/client-core/proofs/d1/validate.ts`. The enabled candidate code at 6270b48d0 passed scoped web/mobile typechecks (18 tasks including dependencies), **11 web proof tests + 11 mobile proof tests + 12 legacy tests = 34 executed tests across four files**, eight isolated memory processes, both Vite proof/library builds, all six Expo platform proof bundles, and both ordinary client builds. The latter were built once and restored from the shared cache in the final run. No index-fallback/teardown warning remains. The later ordinary-unit output guard only affects the disabled test mode; it leaves the enabled proof unchanged. This is scoped evidence, not a full web/mobile suite, lean gate, browser interaction or native-device performance claim.

The coordinator’s integration branch gained only a documentation baseline note during the final comparison; no further Phase B runtime fix landed, so B13 remains the comparison baseline. Landing is restricted to integrate/4286-frontend-perf. Enabling the pilot or landing on dev/mw/main remains outside this proof.
