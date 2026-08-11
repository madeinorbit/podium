# Architecture rewrite restart audit — 2026-08-10

## Executive verdict

The first-principles rewrite is in production and its central structure is real: the model,
sync kernel, command surface, gateway/service decomposition, host split, and client slices all
landed. The epic is not finished, however. The remaining work is no longer one large rewrite;
it is a bounded endgame with four kinds of debt:

1. guardrails that are currently red or are not lane-reachable;
2. a cutover that shipped but retained the outgoing browser/wire paths;
3. semantic cleanup that the deletion audit still measures directly; and
4. release proof, documentation, soak, and independent review.

The old plan's phase ordering is now partly fictional. Phase 8 is marked as completed even though
three children it called cutover blockers remain open. Phase 9 is blocked on that open Phase 8,
while its integration child is already closed and the code is on `main`. Several closed parents
also contain open children. Restarting by blindly following `ready` would therefore optimize the
wrong graph.

## Branch and worktree state

- Local `main` was refreshed with `git pull --rebase --autostash origin main` before the audit.
- `issue/279-integration` was then rebased directly onto that refreshed local `main` under the
  `architecture-integration-rebase` advisory lock and force-pushed with lease protection.
- The branch is clean and is exactly four commits ahead of local `main` (`0 4`). Remote ancestry is
  also current (`origin/main...origin/issue/279-integration` = `0 6`, the extra two are local-main
  commits not yet on `origin/main`).
- The four preserved commits are not empty merge residue: they contain the POD-1651 IndexedDB
  apply-scaling benchmark, its `CacheOperation` correction, the POD-1583 setup reachability fix,
  and POD-1654 live-host evidence.

## Current measured state

### Deletion/rearchitecture audit

`bun run audit:rearch -- --sites` reports **32 categories / 122 sites**. The largest live groups are:

| Category | Current | Baseline | Meaning |
| --- | ---: | ---: | --- |
| session shapes | 37 | 37 | hand-restated session field lists |
| machine-id unbranded fields | 25 | 25 | bare string schemas for machine identity |
| issue shapes | 14 | 9 | hand-restated issue fields; **the only currently growing category** |
| legacy issue local wire | 12 | 12 | old issue membership/wire cache path |
| unbranded-by-decision ids | 17 | 17 | explicit branding exceptions requiring disposition |
| legacy wire-v1 adapter | 6 | 6 | concrete pre-cutover adapter that Phase 7 promised to delete |
| adoption/backfill heals | 5 | 5 | boot-time legacy repairs |
| local placeholders | 3 | 3 | retired `local`/`__local__` sentinel residue |
| issue-wire dirty scoping shims | 2 | 2 | interim generation/cache state |
| per-user singleton | 1 | 1 | `IssueViewInput.readAt` |

`bun run audit:rearch` fails because issue shapes grew from 9 to 14. The current sites include
new restatements in automations, message-gate, handoff/workflow ports, issue views, optimistic
spawn, maintenance protocol, and reclaimable-worktree projections. This confirms that
POD-1762 remains real, although its August 7 list of three growing counters is stale: today only
the issue-shape counter is above baseline.

### Composition and construction guard

`bun run audit:composition` fails immediately because the generated composition graph is stale.
This confirms POD-1367 and the regeneration-enforcement part of POD-1395. POD-1411 is a separate,
still-real blind spot: the generator only describes the relay root and cannot see load-bearing
ordering inside service constructors.

### Documentation

The documentation closeout is plainly outstanding. `docs/offline-sync-architecture.md` still
describes the browser/mobile engine as TanStack DB in several diagrams and tables, even though
the rewrite claims a kernel Replica/Outbox cutover. `docs/rearchitecture-v3.md` is a valuable
historical ledger, but is still phase-oriented rather than a compact description of the shipped
system. POD-356 must produce the as-built topology table before POD-336 rewrites the permanent
docs.

### Cutover residue

- `kernel-replica` still says “off is the shipped path”, and `resolveReplicaMode` still returns
  `legacy` when the scoped-authority override does not force kernel mode. POD-1566 is therefore
  still real. The closed TanStack-deletion issue did not achieve its stated end state.
- The concrete `LegacyWireV1Adapter` is still registered and has six audit sites.
- The publication worker still has a `sessionsChanged` snapshot branch beside
  `metadataDelta`; the old issue-wire cache/generation path accounts for another 14 audit sites.
- Cross-tab support exists for local/UI side-cache state, but the kernel/IndexedDB entity store
  still lacks a demonstrated cross-tab invalidation path. POD-1244 remains a release-correctness
  issue until proved otherwise at runtime.
- Database restore implementation and epoch re-minting exist with strong tests, but the operator
  CLI verb remains unwired. POD-806 is now a small finishing task, not a greenfield feature.

## Work already started

| Issue | Actual state | Disposition |
| --- | --- | --- |
| POD-772 (Architecture cleanup ledger) | Hibernated Ludovico session; its two entries were resolved/placed elsewhere. No current implementation work. | Close the standing collector after moving its durable conclusions into this report; new findings already have concrete issues. |
| POD-1407 (VPS daemon soak workload) | Planning only, no session; blocked on a second deployed instance. | Keep as a runbook/workload child of the release soak, not as an implementation task. |
| POD-1651 (The app blocks for 95s after it paints) | Two exited Ludovico sessions. Only the IndexedDB apply-scaling benchmark was preserved on integration; no runtime fix landed. Cold is largely first-load priming, but warm loads still block for seconds. | Resume after guardrails, before final performance/profile gate. Profile with source maps and fix the real main-thread path. |
| POD-1660 (Bug: cannot place work on another machine) | Hibernated Ludovico session identified daemon version skew (`transferId` to `token`) but could not deploy/test. Its required real remote-start acceptance never ran; the named VMI is no longer visible. | Do not merge as “fixed”. Re-probe on a currently visible second machine after versions are aligned; close as stale if the current path succeeds. |

## Recommended construction order

### 1. Restore trustworthy tools first

1. POD-1762: return `audit:rearch` to baseline and close the lane-enforcement gap.
2. POD-1367 + POD-1395: regenerate composition/construction artifacts and make drift fail where
   changes land.
3. POD-1369: classify every `audit:*` command as lane-reachable or deliberately manual, with a
   configuration test. CI currently invokes only a small subset.
4. POD-1643: repair migration snapshot lineage before any cleanup that needs a schema change.
5. Fold POD-769's positive-control doctrine and POD-763's three-dot review rule into the permanent
   docs; they are guidance, not standalone implementation projects.

### 2. Finish the cutover rather than polishing around it

1. Decide the no-IndexedDB posture, then complete POD-1566: kernel becomes the normal browser
   path, legacy fallback/shadow behavior is removed or explicitly bounded.
2. POD-1244: prove and implement cross-tab entity convergence on the kernel store.
3. POD-1208 plus the 12 `issues-legacy-local-wire` and two dirty-scoping sites: one delta/feed
   publication path, no session-embedded issue reconstruction cache.
4. Remove the concrete wire-v1 adapter tracked by POD-337 once current fleet minimum-version data
   allows it; POD-1766 separately gives the daemon-handshake adapter mechanical expiry.
5. POD-806: expose the already-implemented restore/re-mint operation as the supported CLI verb.
6. POD-1247: put issue writes through the shared Authority arbitration engine and delete the
   duplicate `checkExpectedRevision` path. Sequence client revision supply before changing omitted
   precondition behavior.
7. POD-1763: delete the unsent `MutationEnvelope` unless an immediate named production consumer
   emerges. The shipped Outbox command contract already won.
8. POD-803 should be closed by deleting the outgoing TanStack replica, not by optimizing its
   metadata comparison. POD-809 remains a kernel cold-offline acceptance requirement.

### 3. Close the measured semantic debt

Work in compiler/audit-driven batches, keeping the ratchet flat or decreasing after every batch:

1. POD-1764 for storage-row mapping and the 37 session/14 issue shape sites.
2. POD-1361, then POD-1192/POD-1199 for machine IDs and the remaining client/DB/type branding.
3. POD-1360 for four repo boot heals; keep the transcript operational backfill as an explicit
   exception.
4. POD-1236 and POD-1200 for the remaining per-user singleton/pin split; POD-820 for nullable
   empty-string normalization.
5. POD-1107 and POD-1765 for one spawn tuple/default resolver and one session-identity resolver.
6. POD-1771 for harness capability variance at the manifest edge.
7. POD-1767, POD-1768, POD-1769 for command-contract redaction readers, framework convergence,
   and a total optimistic-reducer policy.
8. POD-1773 and POD-1774 for kernel error observability and conformance against the real Authority.
9. POD-1770 and POD-1772 for mobile dead-letter recovery and removal of entity-shaped web polling.
10. POD-1775 is a small deletion. POD-1776 is worthwhile maintainability work but comes last in
    this section; prose reduction must not distract from live dual paths.

### 4. Address production/security blockers before declaring victory

1. POD-1636 is the most serious open architecture decision: multi-user authorization is not a
   host boundary while every agent process shares the OS user and can write `podium.db`. It needs
   a human-selected host isolation mechanism; code inside `session-mint.ts` cannot solve it.
2. POD-1423 and POD-1651 are the concrete live-scale performance blockers. Fix them before the
   broad POD-1590 shipped-performance profile, which should consolidate the final numbers rather
   than rediscover known stalls.
3. POD-1620 is the canonical WS-auth scoping flake; POD-1183 describes the same test family and
   should be merged into it. First distinguish timeout from a wrong-frame leak under load.
4. POD-1666's pointer-mail terminal-state problem is real but separable from the rewrite endgame;
   fix before release metrics rely on queue depth.

### 5. Document, soak, review, and close

1. POD-356 as-built topology table.
2. POD-336 permanent architecture/offline-sync docs, including the historical ledger polish.
3. POD-1544 mobile device smoke and POD-1463/POD-1407 paired-instance/fleet soak once a second
   current stack is available.
4. POD-1590 final shipped performance profile.
5. POD-337 release gate: audit zero, quantitative/chaos evidence, packaged targets, and human soak
   sign-off. Its text should close Phase 7, not the epic.
6. POD-1443 proposed-lane sweep can start once guardrails are trustworthy. Then run POD-1448,
   POD-1449, and POD-1450 independently; curate/fix under POD-1445; finish with POD-1447's grade.
7. Close Phase 9 and then the epic. Do not repeat the already-completed “integrate into main” step.

## Complete open-descendant disposition

Legend: **keep** = verified current work; **reprobe** = plausible but evidence predates major main
movement; **subsume** = fold into a named issue/container; **archive/close** = no independent work
remains; **move out** = real but can ship independently of this epic.

### Phase/gate containers

| Issue | Verdict |
| --- | --- |
| POD-294 (Phase 7) | **keep**, but rewrite its close semantics around the shipped/post-cutover reality. |
| POD-1347 (Main catch-up and integration landing) | **keep** only as the parent of POD-1247; branch catch-up itself is complete. |
| POD-1348 (Guardrail and audit gate health) | **keep**, immediate workstream. |
| POD-1349 (Test lanes and host environment) | **move out** as a test-infrastructure program; only currently reproduced reds may block POD-337. |
| POD-1413 (Phase 8 — Cutover) | **close/reconcile**: the cutover already shipped; move its three residual children into Phase 9/cutover cleanup. |
| POD-1415 (Phase 9 — Post-cutover cleanup) | **keep**, make it the actual endgame container. |
| POD-1546 (Vocabulary and residue cleanup) | **keep** under Phase 9; it owns most measured audit debt. |
| POD-1548 (Blocked on a second running instance) | **keep** as release-evidence container, not implementation. |
| POD-1586 (Fix after the merge) | **subsume** into Phase 9; its only open child is the final performance profile. |

### Guardrails, composition, and developer workflow

| Issue | Verdict |
| --- | --- |
| POD-1102 (Recorded deletion debt from main) | **archive/close** as a historical tally; current audit sites and concrete owners supersede it. |
| POD-1138 (Optional conditional-spread keys) | **keep**, low priority; targeted TypeScript/guardrail hole. |
| POD-1160 (Per-user detector cannot see fixed shape) | **subsume** into the later, proven POD-1165. |
| POD-1165 (Per-user detector blind to composed key) | **keep**, but current audit shows one real singleton rather than the old predicted landing failure. |
| POD-1207 (Perf registry matrix row) | **keep**, small classification decision. |
| POD-1367 (Stale construction-order document) | **keep**, currently reproduced as a broader stale composition graph. |
| POD-1369 (Six audit detectors run in no lane) | **keep**; counts changed, defect remains. |
| POD-1393 (Wire goldens depend on installed CLIs) | **reprobe**, then keep outside critical path if still host-coupled. |
| POD-1395 (Enforce composition artifact regeneration) | **keep**, pair with POD-1367. |
| POD-1411 (Construction order generator root-only) | **keep**, after current graph is green. |
| POD-1419 (Principal refusal guard untested) | **keep**, fold into POD-337 deliberate-violation probes if no smaller unit is needed. |
| POD-1481 (Scar registry row resolution) | **reprobe**, then fold into audit-lane totality. |
| POD-1484 (Per-user detector blind to unstored state) | **reprobe**, combine with POD-1165 if the same detector owns both. |
| POD-1762 (Deletion ratchet red on main) | **keep, first**; current reproduction is issue-shapes 9 to 14. |
| POD-1768 (CommandDef fold census ratchet) | **keep**. |
| POD-1774 (Conformance over real Authority) | **keep**. |
| POD-763 (Three-dot diffs) | **subsume** into POD-336/ledger conventions. |
| POD-769 (Unproven detector doctrine) | **subsume** into POD-336/ledger conventions. |

### Cutover, sync, vocabulary, and command cleanup

| Issue | Verdict |
| --- | --- |
| POD-806 (Database restore verb) | **keep**, small CLI wiring over completed restore/re-mint code. |
| POD-1208 (Publication worker old wire) | **keep**, combine with legacy issue-wire deletion. |
| POD-1244 (Second-tab convergence) | **keep** until real cross-tab kernel entity convergence is demonstrated. |
| POD-1247 (Issue mutations on arbitration engine) | **keep**, high priority. |
| POD-1566 (Web kernel replica cutover) | **keep, high priority**; current source still says default-off/legacy. |
| POD-1763 (MutationEnvelope disposition) | **keep**, default disposition delete. |
| POD-1764 (Session storage row mapper) | **keep**, expand to the measured shape-restatement cleanup or split it deliberately. |
| POD-1765 (One session identity resolver) | **keep**. |
| POD-1766 (Handshake adapter mechanical expiry) | **keep**, but do not confuse it with deleting the separate wire-v1 adapter. |
| POD-1767 (Redaction metadata readers) | **keep**, security-relevant. |
| POD-1769 (Optimistic reducer coverage) | **keep** as a policy/totality decision. |
| POD-1770 (Mobile dead-letter recovery) | **keep**, runtime UI verification required. |
| POD-1771 (Harness capability manifests) | **keep**. |
| POD-1772 (Web polling hooks) | **keep after POD-1566**. |
| POD-1773 (Kernel silent-skip observability) | **keep**. |
| POD-1775 (Domain build detritus) | **keep**, tiny deletion. |
| POD-1776 (Prose diet) | **keep last**, maintainability rather than correctness. |
| POD-803 (Replica byte-identity skip) | **close via legacy deletion**; do not optimize code POD-1566 should retire. |
| POD-809 (Offline cold-start fatal page) | **keep** as kernel cutover acceptance. |
| POD-820 (Empty string as unassigned) | **keep**, low priority/schema-dependent. |
| POD-1106 (Workflow fork lineage) | **move out**: real product defect, not architecture completion. |
| POD-1107 (Spawn tuple restatements) | **keep**, directly violates the semantic-vocabulary goal. |
| POD-1108 (Retry un-skips skipped step) | **move out**: real workflow behavior defect. |
| POD-1110 (Duplicate workflow SQLite error) | **move out**: real UX/domain-error defect. |
| POD-1171 (Workspace fetch borrows handoff ID) | **keep**, low priority boundary cleanup. |
| POD-1192 (Branded IDs across client mirror) | **keep**. |
| POD-1199 (Brand Drizzle/TS ID members) | **keep**, split DB-column and independent-TS work after measuring. |
| POD-1200 (Two pin mechanisms) | **keep**, coordinate with per-user state rather than parallel implementation. |
| POD-1202 (Dead hub-provenance badges) | **keep**, small deletion; preserve only the federation seam vocabulary. |
| POD-1236 (Per-user archived flag) | **keep**, product-semantics decision plus migration. |
| POD-1360 (Legacy repo boot heals) | **keep**, measured five-site category with one explicit operational exception. |
| POD-1361 (Machine ID contract branding) | **keep**, measured 25-site category. |

### Production, security, performance, and fleet

| Issue | Verdict |
| --- | --- |
| POD-1407 (VPS soak workload) | **keep blocked** until a current second instance exists. |
| POD-1423 (SessionRegistry live census boot) | **keep**, performance blocker. |
| POD-1463 (Paired-instance soak) | **keep**, release evidence. |
| POD-1544 (Mobile device smoke) | **keep**, human/runtime gate. |
| POD-1562 (Live placement probe: up to date) | **archive/close**; explicitly filed as a throwaway probe. |
| POD-1590 (Shipped rewrite performance profile) | **keep after POD-1423/POD-1651**, then consolidate final numbers. |
| POD-1620 (Client WS auth scoping flake) | **keep canonical**, security-sensitive. |
| POD-1636 (Mint root host boundary) | **keep, P1/human architecture decision**. |
| POD-1643 (Migration generator lineage) | **keep, immediate unblocker**. |
| POD-1651 (App blocks after paint) | **keep, P1**; benchmark exists, fix does not. |
| POD-1660 (Remote placement failure) | **reprobe** on a currently visible, version-aligned machine; do not accept stale branch evidence. |
| POD-1666 (Pointer mail never settles) | **move out but fix before release metrics**; real delivery-state bug. |

### Test-lane descendants

These are real quality work where stated, but most evidence predates the August 10 package-owned,
Turbo-cached, resource-budgeted test graph. They should not all block the architecture epic.

| Issue | Verdict |
| --- | --- |
| POD-452 (PTY sleeps/process setup) | **move out, keep** as test-performance work. |
| POD-453 (Skipped/brittle tests) | **keep small sweep**; separate behavior coverage from source-token assertions. |
| POD-563 (Hermetic browser E2E) | **keep**, prerequisite for browser isolation. |
| POD-576 (Browser instance isolation matrix) | **keep blocked on POD-563**, release evidence rather than core code. |
| POD-759 (Orphaned router skip) | **keep**, small and directly verifiable. |
| POD-766 (Managed-account spawn in two lanes) | **keep small**; the recorded decision to drop the duplicate was never implemented and current package.json still runs it in multi-instance. |
| POD-1054 (Nested checkout collection) | **reprobe** against the new package-task graph; move out if still real. |
| POD-1126 (Keyboard-fidelity hook timeout) | **reprobe**, then fix as independent test reliability. |
| POD-1152 (Expo locator drift) | **reprobe**; close if the spec/landmark no longer exists. |
| POD-1157 (Composer PTY smoke) | **reprobe** on the current focused lane. |
| POD-1183 (WS auth test flake) | **subsume into POD-1620**. |
| POD-1204 (Experimental settings locator) | **reprobe**; likely stale UI test debt. |
| POD-1205 (Grok catalog expectation) | **reprobe** against deterministic catalog fixtures. |
| POD-1233 (Harness segfault in browser run) | **reprobe** with current harness/host budget. |
| POD-1238 (RepoScanFlow load flake) | **reprobe**; independent test reliability. |
| POD-1240 (Dead settings Save button) | **reprobe**; likely stale spec behavior. |
| POD-1242 (Issues-to-Tasks nav rename) | **reprobe/merge with POD-1517** if selectors still overlap. |
| POD-1243 (Load test fan-out flake) | **move out, keep** as timing-test design. |
| POD-1299 (Worktree mobile build bypass) | **keep** until the harness proves it builds the active worktree. |
| POD-1304 (VMI provisioning) | **archive or replace**: the named VMI is no longer visible; provision a current test host only if needed. |
| POD-1305 (Shared node_modules) | **reprobe** against current install-fingerprint/missing-link refusal; likely superseded in part. |
| POD-1306 (Bun runner segfault) | **reprobe** under package-owned two-worker lanes; likely environment/version-sensitive. |
| POD-1307 (Durable-session reap timeout) | **reprobe** on a quiet host before changing budgets. |
| POD-1363 (Rearch audit timeout) | **reprobe**; current standalone audit completed in about 30 seconds under load. |
| POD-1364 (Browser fixture agent availability) | **keep** if current deterministic fixture still requires native inventory; otherwise close. |
| POD-1381 (Turbo-cache test lanes) | **close as implemented/superseded** by the current package-owned Turbo-cached test graph. |
| POD-1387 (Grok hooks reads real home) | **keep** if current test still touches real home; hermeticity defect. |
| POD-1400 (E2E discovery worker resolution) | **reprobe** with the current e2e harness. |
| POD-1414 (Server tests depend on lane order) | **reprobe** against current generated server shards/reuse plan; likely materially changed. |
| POD-1468 (Session fixtures double-cast) | **keep**, compiler-safety cleanup. |
| POD-1471 (Dead worker looks green) | **keep/move out**, reporting defect; exit code is correct but evidence is misleading. |
| POD-1482 (Daemon PTY lane red/out of CI) | **reprobe**, then keep as host-layer coverage if still outside CI. |
| POD-1499 (Web lane timeouts under fan-out) | **reprobe** under the shared host budget and current suite. |
| POD-1517 (Browser landmark display string) | **reprobe/merge with POD-1242**; prefer stable selectors. |

### Reviews and final closeout

| Issue | Verdict |
| --- | --- |
| POD-336 (Docs rewrite) | **keep**, after POD-356. |
| POD-337 (Release gate) | **keep**, update text to close Phase 7 rather than the epic. |
| POD-356 (Topology closure) | **keep, first documentation step**. |
| POD-1443 (Proposed-lane re-triage) | **keep**, start after guardrails are reliable. |
| POD-1444 (Three review rounds) | **keep** as container. |
| POD-1445 (Review remediation) | **keep** as findings container. |
| POD-1447 (Architecture grade report) | **keep last**. |
| POD-1448 (Fable adversarial review) | **keep**. |
| POD-1449 (Sol adversarial review) | **keep**. |
| POD-1450 (Sol security review) | **keep**. |

## Immediate tracker repairs recommended

1. Make Phase 9 runnable now that the cutover/integration is already on main; remove the stale
   Phase-8 blocker and re-home POD-806/POD-1208/POD-1244 under Phase 9 cutover cleanup.
2. Fold POD-1183 into POD-1620 and POD-1160 into POD-1165.
3. Close/archive POD-1562 and the no-longer-useful POD-772 standing collector.
4. Close POD-1381 as superseded by the current cached package test graph.
5. Move the broad POD-1349 test backlog out of the epic; only current release-lane failures should
   block POD-337.
6. Update POD-1566 to own the full default-path cutover and outgoing browser-replica deletion,
   because the issue that claimed deletion is already closed while the code remains.
7. Correct POD-337's acceptance text: it closes Phase 7; Phase 9/review/grade close the epic.

No implementation should fan out until repairs 1–3 and the guardrail-first sequence are reflected
in the dependency graph. Otherwise `ready` will continue presenting historical test flakes and
post-cutover polish ahead of the red architecture gate and live legacy path.
