# POD-4973 — One issue record

Historical retirement evidence, 2026-10-02. The deployment gate was waived by
POD-4286: there are no released native/TestFlight clients; Expo web is the current
mobile client. This change lands only on `integrate/4286-pilot`. The operator owns
promotion to `dev/mw`, deployment, and the phone-browser check.

## Contract and removal

Client wire current/minimum advance together to **4**. The daemon window stays
**3 / 1**. The server's v1/v2 entity adapters and old issue entity schema, registry
residue, entity goldens, client collections, and web drop switch are removed.
Mutations and boot reconciliation publish the issue projection and independently
keyed companions. The required `changesSince` snapshot `issues` member is `[]`.
Existing persistent old-kind payloads are deleted by the migration; its fresh feed
epoch forces stale cursors to bootstrap. Domain issue rows remain authoritative.
Web IndexedDB and native SQLite discard unsupported cached kinds while preserving
current rows, personal partitions, cursor semantics and authored outbox entries.

The CLI still returns its original report fields. `IssueReport` describes an
on-demand result, never another replicated entity. A list request loads labels,
dependencies and comment counts once and constructs the children index once.
Only an issue's own normalized projection is reused by immutable row identity;
label changes invalidate that projection. Reports, personal markers, counts and
relations are joined on each request. Tree requests do not load labels or comment
counts. The JSON compatibility test covers create/update/get/list/tree, and a
planted missing `commentCount` makes it fail.

Questions without an asker remain questions: the normalized `asked` projection
keeps the question with optional `by`, `at` and attribution. Known authenticated
callers now record attribution; old rows are never assigned a fictional actor.
A read-only count on ludovico found **1 open question without an asker**. Both web
and mobile reader regressions pass the stored-row question through the actual
server projector; dropping `askedLegacy` made both tests fail.

## Publication work and cost

Same focused production-mutation fixture on flatblock, 16 and 64 issues. Before:
`96fae4b206`; after: `dc5340933e` (production publication behavior unchanged in the
final candidate). One sample per operation; timings are observations, not a
statistical throughput claim. Repository-call and emitted-row counts are pinned
by `apps/server/src/modules/issues/publication-cost.test.ts`.

| Issues | Operation | Before ms | After ms | Feed rows before → after | JSON bytes before → after |
| --- | --- | ---: | ---: | --- | --- |
| 16 | title update | 5.540 | 5.156 | 2 → 1 | 1686 → 827 |
| 16 | reparent | 6.807 | 3.640 | 3 → 1 | 2789 → 881 |
| 16 | close | 14.312 | 6.209 | 3 → 1 | 2904 → 938 |
| 64 | title update | 4.096 | 2.410 | 2 → 1 | 1688 → 827 |
| 64 | reparent | 8.472 | 2.104 | 3 → 1 | 2792 → 881 |
| 64 | close | 9.864 | 3.125 | 3 → 1 | 2907 → 938 |

After retirement, all three paths make **zero** scalar/all-comment-count or
all-dependency queries. The title and reparent paths make no incoming-dependency
query; close retains exactly one to preserve its dependent-issue event semantics.
Before retirement every operation counted comments and read incoming dependencies;
reparent also queried all comments once/all dependencies twice; close did so twice
and three times respectively. Planting a comment-count query made the cost test
fail. Full-list re-emission and the publication-time children scan are gone.

## Operator-sized read and memory methodology

The live server is never restarted, migrated or reconfigured for these measurements.
The initial live CLI baseline on ludovico had 5,152 list rows and 133 tree nodes:
median list **1681.026 ms**, show **542.251 ms**, tree **550.173 ms**, five runs each.
Those include CLI startup and the running server's transport and scheduling.
They are context, not the denominator for the isolated candidate comparison.

The paired comparison opens the live SQLite database in read-only mode and backs
it up into RAM. One anonymous memfd image supplies both revisions; no operator row
is written to disk or printed. Only counts, sizes, timing and heap numbers leave
the process. Baseline `11ba47b2d7` and candidate `4a9bb0798` bundles are built on flatblock and
run on ludovico. Candidate migrations apply only to the anonymous copy. The real
IssueService, IssueCommandDispatcher and runIssueCli implement list/show/tree,
with the operator principal and repository scope. CLI commands are `issue list
--json`, `issue show POD-4973 --json`, and `issue tree POD-4286 --max-nodes=1000
--json`. Transport and process startup are excluded from the paired measurements.

The memory probe opens the real client-core kernel replica and runtime, materializes
all issue render models, and retains the cache/runtime/models across GC. It uses
the same source image, current entity kinds and operator-only personal markers.
The web baseline already dropped the old entity in step 4; mobile still retained
it. The reported heap is Bun JavaScriptCore client-core retained heap, **not** a
measurement of the browser or native UI process. There is no claim about browser
V8, Expo Hermes, DOM, textures or resident-set size.

The final consistent image contains **5,868 issue projections**, **5,175 default
list results**, and **141 epic tree nodes**. Three process pairs, with order reversed
in the second pair, each run one cold round and seven warm interleaved list/show/tree
rounds. The table uses the median of the three within-process warm medians. Full
cold and warm samples are retained in [the counts-only results](POD-4973-read-replay.json).

| CLI request | Before warm ms | After warm ms | Count, identical on both revisions | JSON bytes, identical |
| --- | ---: | ---: | ---: | ---: |
| list | 860.086 | 820.840 | 5,175 | 23,122,573 |
| show | 8.807 | 8.792 | 1 | 37,367 |
| tree, max-nodes 1000 | 559.034 | 542.446 | 141 | 134,721 |

None of the warm medians regressed. Per-run medians vary materially with host load:
list before 754.739–918.945 ms, after 792.628–839.120 ms; tree before
523.427–660.634 ms, after 538.512–549.900 ms. Cold samples overlap broadly; this
is not a claim of a statistically significant latency improvement. It shows no
request-cost regression distinguishable from the observed run noise, alongside
the deterministic one-pass join guards.

| Retained client-core heap | Before bytes | After bytes | Change |
| --- | ---: | ---: | ---: |
| mobile | 168,039,096 | 109,912,351 | −34.59% |
| web | 109,945,583 | 109,935,656 | −0.009% (flat) |

Those are medians of three samples. All **5,868 rendered issue rows** remain on
both clients. Retained payload bytes fall **67,046,425 → 39,146,059 (−41.61%)** on
mobile; web already retained 39,146,059. Baseline heap is sampled only after the
seed-loading stack has unwound and GC has had timed event-loop turns; an earlier
probe caught delayed collection of a temporary SQLite image and was discarded
as invalid rather than reported as a negative heap.

## Minimum-client and bundled-code compatibility

- Desktop packages bundle `apps/web/dist` (`apps/desktop/src-tauri/tauri.conf.json`).
  `local_window_target` in `bootstrap.rs` loads the loopback server page when the
  backend is reachable and uses the baked bundle as its offline fallback. Remote
  mode loads the server URL. macOS therefore carries independent web code even
  though a reachable local server normally supplies the page.
- Native Expo packages bundle JavaScript too, but the coordinator confirmed none
  are released/in use. Expo web and browser/PWA clients load server-served assets;
  their cached copy can still become stale.
- The unchanged version-3 guard and banner at `63aa99e972` passed **53 tests**. A
  mismatch spends at most two reloads against the same server build, then raises
  the visible notice telling the user to open the update panel. The root banner
  is outside setup/login gates (`apps/web/src/app/main.tsx`), so refusal does not
  hide its explanation behind a blocked bootstrap.
- The new guard recognizes all three bundled Tauri origins and immediately raises
  **“Update Podium to continue”**, without reloading. Its three refusal cases fail
  when the origin is deliberately mistaken for an ordinary HTTP page. This fixes
  future packaged-client refusals; it does not retroactively change old bundles.
- The real-socket check is written to cover the minimum supported version's bootstrap/delta,
  previous version refusal, unversioned refusal, future-version refusal and the
  advertised `/version` floor; its execution is blocked by the baseline build
  budget described below. Normalized field, personal-state, Git, repository,
  dependency and comment-count tests cover what that supported client reads.

## Validation and deliberate-defect evidence

Validation ran sequentially on flatblock in `~/podium-test-4973`. The last lean
candidate is `251648110a`, rebased onto `c6a96d0b94`; final type-only refinements at
`cb6ae71519` passed the filtered typecheck. Documentation and one exact test-fixture
audit exclusion follow that code. These are focused results, not a full-suite claim.

| Check | Result |
| --- | --- |
| Lean gate | **153 passed**, 4 of 1,736 node-project files (0.2%); typecheck 26/26 and span-effect lint green |
| Final type-only check | **16/16 tasks**, 10 cached; web and client-core filters with dependencies |
| Mobile package | **1,084 passed**, 4 skipped; 166 files passed, 1 skipped |
| Corrected protocol message goldens | **129 passed** |
| Web attribution and stored unattributed question | **15 passed** across 2 files |
| Web guard, sidebar actions and terminal active panel | **106 passed** across the other 3 files of the restored web group |
| Runtime and issue-view cache | **160 + 11 passed**, including provisional edits, truthful dependency blocking and pending personal state |
| Native cache retirement / database migration | **4 + 1 passed** |
| Normalized wire, supported root lane | **7 passed**; `bun run test:lane -- normalized-wire apps/server/src/issues.normalized-wire.test.ts` |
| Prototype corrected cases | **10 passed**, 23 intentionally filtered out, across 5 files |
| Hidden-row fence after POD-5219 | **6 passed** |
| Optimistic write receipts | **12 passed** |
| CLI/RPC JSON compatibility / publish-cost guard | **3 + 2 passed** |
| Formatting / shadowing lint | Green |

Logs are on flatblock at `/tmp/pod-4973-{lean-final-v9,typeonly-final-v9,mobile-final-v8,corrected-final-v9,restored-final-v8,normalized-wire-root-v9,prototype-corrected-v8,report-test,publication-after}.log`.
The server shard wrapper initially executed all seven normalized-wire cases but
failed to locate its JSON report. **POD-5253** records that runner bug. The supported
root lane then ran and verified the seven cases successfully; no runner was bypassed.

Each of these deliberate defects failed its focused assertion, then was removed:
missing report `commentCount`; dropping the stored unattributed question (web and
mobile); a comment-count query during publication; stale projection reuse after a
label change; dropping provisional optimistic rows; treating the bundled desktop
origin as reloadable; reviving a deleted shipping rank; writing pending session
unread to the wrong collection; deriving dependency blocking from optimistic
neighbor stages; retaining the retired native-cache kind; and leaving the retired
replication rows in the migration. Restored assertions pass. **POD-5178** is closed
with the normalized shipping/read-state assertions and their negative controls.

Additional clean-baseline findings at `11ba47b2d7`:

- `displayed-fields.test.tsx` draws i214 on a sortKey-only change although the
  oracle changes no drawn row. Unclaimed discovery **POD-5236** records the proof.
- The old hidden-row plant expectation in `visible.test.tsx` also failed on the
  unchanged base. **POD-5219** fixed it at `a217dd49c`; this branch rebases that
  contract unchanged and verifies the file afterward.
- The web build budget fails before integration tests can start: baseline gzip
  **528,624**, Brotli **454,064**, parsed source **7,087,032** bytes exceed caps
  520,000 / 447,000 / 7,000,000. The retirement candidate reduces them to
  **527,318 / 452,987 / 7,016,355**, still above the inherited caps. The supported
  integration wrapper unconditionally builds clients and has no skip/prebuilt
  option. `sync-e2e.test.ts` and `gateway/wire-window.integration.test.ts` are
  therefore **blocked by the pre-existing bundle budget**, not passed. POD-4286
  owns budget attribution and explicitly directed continuing the other checks;
  no budget or runner was weakened.

The protocol transparency assertion also fails unchanged on clean `11ba47b2d7`:
**4 failed, 32 passed, 81 filtered out**, in model/runtime/runtime-state/sync. It
reports pre-existing normalization of delivery status and driver-family fields.
**POD-5252** retains the exact cases; the assertion was not weakened.

The deletion audit fails on that clean base in **13 pre-existing counters**;
**POD-5254** records their exact sites. Retirement removes the two obsolete residue
detectors, reduces issue-shape findings **46 → 25**, personal-state findings
**23 → 16**, and dirty publication state **2 → 0**. No inherited debt count was
raised in the committed baseline. One newly visible deck-harness value factory is
explicitly classified alongside the existing test/demo fixtures; its type is
composed from the current render model. The outer `test:rearch` command remains
baseline-red and stops before its unit-test stage. After one clean-base proof,
POD-4286 explicitly directed stopping that investigation and landing.

Existing baseline failures are explicitly outside this retirement's landing gate:
POD-5223 (the representation audit's serialized delegation capability snapshot)
reproduces on clean `63aa99e972`. The three terminal replay assertions reproduce on
clean `5f021bf7c7`: two in `relay.test.ts`, one in `characterization.test.ts`, expecting
PTY replay after the separate picture-catch-up change. POD-4286 directed that those
contracts remain unchanged and assigned their repair under POD-5124. Neither audit
nor terminal assertion was weakened here.

POD-5082's sidebar preference/selection inventory was allocated to POD-5174 and the
client-access work. These are distinct from the removed issue entity. POD-5161's
shared store-handle helper is used only by provider-free fixtures; real-provider
fixtures retain their actual store boundary.

## Recovery

Before deployment, reverting this issue on integration is a normal code rollback.
After migration, an old binary alone is **not** a rollback: the migration downgrade
guard intentionally refuses a database containing an unknown migration. A forward
recovery build must retain the new migration/schema ledger while restoring the old
publication/client code, reconstruct old replication rows from durable issue truth,
and mint a fresh feed epoch before admitting its clients. Alternatively the operator
can use the pre-migration database backup, with the usual loss of later writes.
No recovery or deployment was performed here. Current rows and authored pending
commands are preserved by the retirement, and disk/outbox/rollback/readmission tests
pin that property.
