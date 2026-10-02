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
the process. Baseline `63aa99e972` and candidate bundles are built on flatblock and
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

Final paired timing and heap results are recorded below after the completed run.

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
- The real-socket check covers the minimum supported version's bootstrap/delta,
  previous version refusal, unversioned refusal, future-version refusal and the
  advertised `/version` floor. Normalized field, personal-state, Git, repository,
  dependency and comment-count tests cover what that supported client reads.

## Validation and deliberate-defect evidence

Final run totals and remaining baseline failures are recorded below.

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
