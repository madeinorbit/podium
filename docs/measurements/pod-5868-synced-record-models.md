# POD-5868: shared synced record models

Machines, automations and automation runs now have one shared model per ID in
the pool. The schema cites `MachineWire`, `MachineProjection`, `AutomationWire`
and `AutomationRunWire`; their fields use the existing schema installer and
generic tables. No entity adds storage or changes table publication granularity.

## Scope and base

The complete 29-commit candidate `036a78dd91..3fb5ea2701` is now replayed
onto publication-suppression pilot `8f5ae42e45587ed9dd83e5a05abff6e67200a91d`.
All 29 commits remain, ending at validated runtime `36f19a5fde`; this report
update changes only documentation. The original synced-model range, four-key
diagnostic repair and shell field preservation remain contained in full.
Focused model tests, the two-package typecheck and the light scan are green.
The worklist feed fence has two failures that also reproduce on the exact
landed pilot; their assertions remain unchanged and the coordinator has the
isolation evidence. Shared validation and landing remain with POD-5895.

The coordinator narrowed this issue to synced records. Workflow record models,
spec metadata, request ingestion and request-record retention remain deferred
to POD-5915 while POD-5910 decides the generic machinery. Spec bodies remain
request answers. Workflow placement's machine reader moves here; its workflow
subject and request collections remain outside this range. POD-5874's separate
measurement of field publication can apply to these generic tables too.

## Publication suppression pilot proof

The complete 29-commit rebase onto `8f5ae42e45` has 28 equal patches and one
context change. Its only conflict was the snapshot branch of
`packages/client-graph/src/shared/row-source.ts`: automation and automationRun
join the companion kinds while the landed `seededKinds`, `published`, `retain`,
structural comparison and publication bookkeeping remain intact. No test
fixture or expected value changed. The earlier session/pane fields and shared
machine, automation and run definitions are preserved.

At exact runtime `36f19a5fde`, the focused two-package typecheck passed:

```sh
bun run typecheck -- --filter=@podium/client-graph --filter=@podium/worklist-tests --only
```

Exactly two tasks succeeded, at concurrency one, with no dependency-package
tasks. Turbo summary on flatblock:
`/home/mgw/podium-test-5868/.turbo/runs/3KTT61PlAQYSNp3mzaQYGSiFdIU.json`.

The requested focused files executed through `bun run test:file -- <paths>`:

| Focused file | Passed | Failed |
| --- | ---: | ---: |
| `packages/client-graph/src/synced-record-models.test.ts` | 6 | 0 |
| `packages/client-graph/src/deferred-models.test.ts` | 1 | 0 |
| `packages/client-graph/src/models.test.ts` | 13 | 0 |
| `packages/client-graph/src/shared/row-source.test.ts` | 19 | 0 |
| `tests/worklist/shared/src/row-source.test.ts` | 22 | 2 |
| **Candidate total** | **61** | **2** |

The 19 client-graph feed cases include revision-only/identical issue publication
suppression with and without git data, actual title/stage/description changes,
masked remote changes and rollback, and snapshots that must not swallow pending
updates or inserts. They all pass unchanged on the combined source.

The two failed worklist cases are the pooled and truth visited-per-publication
fences at line 1690: heartbeat visits one row while the fixture expects two.
Both feed files are byte-identical to the landed pilot. Running only those two
cases on exact `8f5ae42e45`, without any model commits, reproduces both failures
with 22 cases filtered. Parsed candidate/baseline cost tables are equal for
every step in both modes and at both scales. Heartbeat and settled heartbeat
visit/emit one row, and a burst of 50 visits/emits 50; the fixture's ADDRESSED
map still expects two and 100 respectively. This is inherited expectation debt,
not a changed result from the model rebase. Assertions remain untouched; the
coordinator received the adjacent-work diagnostic and routing request.

Saved flatblock logs: `/tmp/pod5868-8f5-models.log`,
`/tmp/pod5868-8f5-feed.log` and `/tmp/pod5868-8f5-baseline-feed.log`.
All three focused invocations ran sequentially in the foreground using
checkout-local Bun 1.4.2 and `node -> bun`. No memory stop occurred; the guard
sampled at most 620.1 MiB process RSS and confirmed no recorded PID remained
live. Baseline failures are isolation evidence and are not counted a second
time in the candidate totals.

The light scan at `36f19a5fde` is GREEN: **2,074 fingerprints, 2,075 occurrences,
1,912 existing REQUIRED REPAIR entries and zero ratchet errors**, saved at
`flatblock:/tmp/pod5868-8f5-scan.json`. Rebase required no manual census changes.

No full gates, builds, structural census or landing ran in this continuation.
POD-5895's earlier green shared receipts belong to `3fb5ea2701` on `036a78dd91`;
they do not validate this new base. This complete replacement is handed through
POD-4286 with the inherited feed failure called out. Shared checks and landing
remain with POD-5895, and the issue remains in progress.

## Historical shell pilot proof

POD-4286 requested this reconciliation after POD-5878's shell range and
POD-5925's interrupted-transfer fix landed. Range-diff of the complete
27-commit replacement has 22 equal patches and five context changes:
three product replay patches and two census patches. No commit was dropped.

The product resolutions retain the shell's `IssueGitState` import and complete
issue projection contract alongside the synced-model types/exports, and retain
`Geometry` alongside the four added wire schema types. The landed
`SessionModel` class block and session geometry declaration are byte-for-byte
identical to `036a78dd91`. Existing shell pane, dock and attachment code stays
intact. The shell machine catalogue reads `here(pool.model('machine', id))`,
retaining the pilot's omission policy while returning the shared machine model.

The two focused package typechecks passed on flatblock at `d965538b2b`:

```sh
bun run typecheck -- --filter=@podium/client-graph --filter=@podium/worklist-tests --only
```

Exactly two tasks ran successfully, sequentially at concurrency one; no
dependency-package tasks ran. Turbo summary:
`flatblock:/home/mgw/podium-test-5868/.turbo/runs/3KTOsMRf2nGgulhR3B1S7R9x0Gc.json`.
The subsequent scan reconciliation changes no typechecked source.

All nine files in the previous membership proof below passed again at runtime
tip `546d97aea8`, with the same 121 executed cases. The additional unchanged
`packages/client-graph/src/shell-pane-fields.test.ts` passed all six cases,
covering attachment/path-boundary parity, session geometry and dock routing.
Its heartbeat witness records zero stamp, ownership, chrome and dock routing
reader runs, while the legacy stamp and dock readers each run once.
That is **127 passing cases across ten focused files**, not a suite result.

The seven sequential, foreground `bun run test:file -- <paths>` invocations
used the existing flatblock checkout's Bun 1.4.2 and `node -> bun` alias.
Their saved runner logs are `/tmp/pod5868-036a-<label>.log` on flatblock:
`models` (26), `automation-readers` (6), `workflow-readers` (6), `updates` (36),
`machines` (46), `mobile` (4) and `bundle` (3). The census lease was checked
free before each submitted command. The recorded-PID guard stopped no worker,
sampled at most 720.6 MiB process RSS, and confirmed no recorded process remained
live. No React/MobX warning appeared; the unchanged mobile configuration retains
Bun's existing unsupported `moduleSuffixes` warning.

The light scan is GREEN at `546d97aea8`: **2,073 fingerprints, 2,074 occurrences,
1,912 existing REQUIRED REPAIR entries and zero ratchet errors**, saved at
`flatblock:/tmp/pod5868-036a-light-scan.log`. The first scan found 43 stale
fingerprints and 12 replacements left by the model/shell replay. Each replacement
has a unique corresponding operation in the actual pilot. Reconciliation copies
its exact classification, owner, trigger, bound, reason, guard and multiplicity,
refreshes its scan fields, and drops the obsolete fingerprints. This is scan
reconciliation, not a claimed runtime work reduction or a new allowance.

No full gates, builds, structural census, merge lease or landing ran here.
The complete replacement goes through POD-4286; POD-5895 retains all shared
checks and integration. The issue stays in progress pending those receipts,
and workflow/spec record work stays held.

## Historical membership pilot proof

All 24 original commits are retained. Range-diff against the submitted
`52556201c0..cdd6c8aa1c` has 22 equal patches and two census-context changes.
Rebase conflicts were confined to the census file; no product-code conflict
required a manual change. The pilot's existing classification, owner, trigger,
bound, reason, guard and multiplicity are preserved.

The M3 diagnostic now requires `issue`, `session`, `worktree` and `repo` in
its `known` map. Other entity keys remain optional for relation enumeration,
so the existing empty-bucket/reporting behavior is unchanged. This fixes all
four TS18048 reads at the former lines 277–278. Fixture values and expected
assertions are unchanged.

The explicitly authorized focused typechecks passed on flatblock at
`0eeab44061`, before the census-only refresh:

```sh
bun run typecheck -- --filter=@podium/worklist-tests --only
bun run typecheck -- --filter=@podium/client-graph --only
```

Each ran exactly one package task, with no dependency tasks. Turbo summaries:
`flatblock:/home/mgw/podium-test-5868/.turbo/runs/3KTMEKmUjvrjzYk1vHamIkDUV2q.json`
and `flatblock:/home/mgw/podium-test-5868/.turbo/runs/3KTMGSCrdGN9jM7N70gs1PTuh25.json`.
The subsequent census refresh changes no typechecked source.

The following files passed at exact runtime candidate `c1a45eefe5` through
`bun run test:file -- <paths>`. Saved runner output is on flatblock under
`/tmp/pod5868-d05-<label>.log`; each count is read from its executed-test summary.

| Focused file | Passed | Log label |
| --- | ---: | --- |
| `packages/client-graph/src/synced-record-models.test.ts` | 6 | `models` |
| `packages/client-graph/src/deferred-models.test.ts` | 1 | `models` |
| `packages/client-graph/src/models.test.ts` | 13 | `models` |
| `apps/web/src/app/automation-readers.test.tsx` | 6 | `automation-readers` |
| `apps/web/src/features/workflows/readers.test.tsx` | 6 | `workflow-readers` |
| `apps/web/src/features/settings/sections/updates.test.tsx` | 36 | `updates` |
| `apps/web/src/features/settings/MachinesPanel.test.tsx` | 46 | `machines` |
| `apps/mobile/src/screens/SettingsScreen.pool.test.tsx` | 4 | `mobile` |
| `apps/web/test/pool-bundle-boundary.test.ts` | 3 | `bundle` |
| **Total** | **121** | **Nine focused files, not a suite result** |

All seven invocations ran sequentially and in the foreground in the existing
`flatblock:~/podium-test-5868` checkout, with its Bun 1.4.2 and `node -> bun`
alias. The meter lease was checked free before each submitted command. The
recorded-PID guard sampled a maximum process RSS of 492.7 MiB, stopped no
worker, and confirmed no recorded process remained live. No React or MobX
warning appeared. Phone settings retains Bun's existing unsupported
`moduleSuffixes` warning from the unchanged mobile configuration.

The repaired light scan is GREEN: **2,120 fingerprints, 2,121 occurrences,
1,959 existing REQUIRED REPAIR entries and zero ratchet errors**, logged at
`flatblock:/tmp/pod5868-d05-light-scan.log`. Its initial eight errors identified
four stale entries and four replacements: three mission model-origin shifts
and one token shift in the already-landed fixture callback. Only their scan
fields changed; classifications and all human metadata stayed intact. The
three mission fingerprint repairs match the prior local correction, which was
included only after this fresh scan showed it was still needed.

No full gates, builds, structural census or landing ran in this continuation.
All shared checks and integration remain with POD-5895. Workflow/spec record
work remains held by the coordinator, so this issue stays in progress.

## Historical owner-totals reconciliation and proof

POD-5895 excluded the earlier proposed POD-5866 opening-owned range after its
retained summary control failed. Its five reader conflicts were against that
unlanded range; it is absent from the actual `52556201c0` pilot. No transient
reader registry or opening code was restored or manually changed during this
rebase. A future opening-owned replacement must retain its ownership rules
with the shared record models underneath.

The following focused files passed on exact runtime tip
`93d751ee325a3c417bab75fa6de2126423ea66ac`. The subsequent report update changes
documentation only. All fixture values and expected assertions remain intact.

| Focused file | Passed | Flatblock runner receipt |
| --- | ---: | --- |
| `packages/client-graph/src/synced-record-models.test.ts` | 6 | `/tmp/podium-focused-tests-OiAQIZ/results.json` |
| `packages/client-graph/src/deferred-models.test.ts` | 1 | `/tmp/podium-focused-tests-OiAQIZ/results.json` |
| `packages/client-graph/src/models.test.ts` | 13 | `/tmp/podium-focused-tests-OiAQIZ/results.json` |
| `apps/web/src/app/automation-readers.test.tsx` | 6 | `/tmp/podium-focused-tests-bSIbL4/results.json` |
| `apps/web/src/features/workflows/readers.test.tsx` | 6 | `/tmp/podium-focused-tests-Q5hmod/results.json` |
| `apps/web/src/features/settings/sections/updates.test.tsx` | 36 | `/tmp/podium-focused-tests-ng66nw/results.json` |
| `apps/web/src/features/settings/MachinesPanel.test.tsx` | 46 | `/tmp/podium-focused-tests-Yejv2X/results.json` |
| `apps/mobile/src/screens/SettingsScreen.pool.test.tsx` | 4 | `/tmp/podium-focused-tests-ynWDUi/results.json` |
| `apps/web/test/pool-bundle-boundary.test.ts` | 3 | `/tmp/podium-focused-tests-GQH1XP/results.json` |
| **Total** | **121** | **Nine focused files, not a suite result** |

The same complete-field fixture was run separately with
`PODIUM_RECORD_NEGATIVE_CONTROL=1`: one expected failure at `machine.name`
(`Wrong answer` versus `Workstation`), five filtered cases, exit 1. Its receipt
is `/tmp/podium-focused-tests-VaUwcl/results.json`. The ordinary six cases pass
above; the control changed no production source or assertion.

Every run was sequential and foreground on flatblock with Bun 1.4.2 and its
checkout-local node alias. The meter was checked free before each run; no
memory stop occurred. The
eight recorded validation wrappers were checked after completion and none
remained live. Machine-panel, deferred-loading and other web/model runs emitted
no warnings. Phone settings still prints Bun's existing unsupported
`moduleSuffixes` warning; the mobile configuration and Bun pin are unchanged
against `52556201c0`. No React/MobX warning was introduced or suppressed.

The fresh light scan is GREEN: **2,202 fingerprints, 2,203 occurrences, 2,055
existing REQUIRED REPAIR debts and zero ratchet errors**, logged at
`flatblock:/tmp/pod5868-owner-base-scan.log`. Rebase required no manual census
changes. History's `IssueActivityHistory/appendEvents` classification, owner,
trigger, 50-row bound, reason, guard and count are identical at `006a`, `525`
and this candidate.

POD-4286 confirmed that startup budget is no longer an owner-lane blocker under
the standing headroom rule. POD-5895's actual `525` baseline build measured
2,149,830 eager raw bytes, leaving 170 bytes under the current 2,150,000 ceiling.
The earlier +1,558-byte source estimate below remains historical; it is not a
production measurement of this rebased candidate. No ceiling, allowance or
generic deferred-entity admission change is included here. The private proposed
budget change was withdrawn by the testing lane. The candidate's full
typecheck, normal web build, lean gate, structural census and landing remain
exclusively with POD-5895 after coordinator selection.

## Ownership and readers

Replica bootstrap, replacement and addressed updates feed all three kinds into
the generic pool tables. Header machine indexes reference that same machine
table. The existing live/replica merge preserves its precedence and live-only
membership across replacement; removals release model identities.

`AutomationSource` retains catalogue IDs and relation links. Its definition/run
facts live in the owning pool; its standalone test API uses the same generic
pool implementation. Source registration binds the owning pool before reads.
Settings-only hosts feed live machines through the existing applying path;
hosts with a header attachment retain that attachment as their live source.

The machine panel and update controls read `MachineModel` fields in observer
rows. The settings view owns a shallow-compared lazy model list built from
catalogue IDs; selected server-move targets retain IDs. Shell machine lists,
workflow placement, automation target machines and phone settings resolve the
same machine identities. The unlisted setup catalogue keeps its existing API.

Automation cards/dialog selection uses models and IDs. Open history keeps its
requested synced-run window as IDs and resolves `AutomationRunModel` fields.
Automation session links resolve `SessionModel` while preserving the existing
setup-session presence and loading policy.

## Shared-gate rejection and repair

POD-5895 rejected candidate `924b6785cb` in B12. The full typecheck emitted
12 diagnostics at seven sites: two production typings, a diagnostic callback,
and four fixture maps that still named only four entity kinds. The normal web
build also exceeded the unchanged eager budget: 2,154,878 bytes against
2,150,000. Removing this range cleared the type errors; the isolated
prerequisite `38732017a0` still exceeded that budget by five bytes. The actual
pilot `d12bee4103` built green. These are attributed failures, not gate passes.

Repair `04def30478` keeps source membership keyed by strings, preserves the
boolean setup-presence policy, explicitly types the diagnostic's model input,
and narrows fixture tables to the entities they actually contain. Fixture
values, expected answers, assertion predicates and pinned cold-set digests are
unchanged; the read-fence probe ignores every kind except issue/session.

Repair `a9b0d53bf9` defers the complete new field declarations and constructors
in `synced-models.ts`. The seven generic table identity/residency entries remain
available at receipt. A pending model lookup subscribes to class registration
and returns `LOADING`; registration uses the same field/relation installers as
the startup kinds. It neither ingests records on read nor creates another row
store. The complete field declarations and constructor bodies were relocated
byte-for-byte from the prior candidate.

The emitted-source boundary test also checks that the synced-model module is
absent from the pool's eager sources; no byte ceiling changed. Schema/model
fixtures and structural instrumentation load the definitions by imports,
preserving their existing checks. A new focused test covers input rows already
in the tables before loading, two waiting views per kind, shared identity after
loading and later field changes. Inspection of the prior production import graph
confirmed runtime attachment was already deferred, so no projection extraction
or unrelated startup refactor remains in the candidate.

The new loading fixture initially imported `LOADING` from `lookup.ts`, which
does not export that symbol. Its first run failed and emitted observer warnings;
repair `54e8aeccb9` uses the canonical `loading.ts` leaf. The unchanged fixture
then passed with no warnings, together with all 61 schema checks and the source
test. The existing 13 model cases and six synced-record parity cases also passed
on the repaired lifecycle base. No warnings were suppressed.

The 190-case table below records the previous focused migration proof. The
latest repair receipts are separate so an older pass cannot be mistaken for
validation of deferred loading. POD-4286 withdrew its temporary typecheck/build
exceptions: those commands remain exclusively in POD-5895's lane. No remote
validation ran during the POD-5911 trace window.

### Historical focused receipts on the lifecycle prerequisite

The final runtime source is `54e8aeccb9`, on actual landed base `006a4ba7c9`.
All twelve files in the earlier 190-case migration table passed again. The
following repair-specific selections add fourteen passing cases:

| Focused file/selection | Passed | Filtered |
| --- | ---: | ---: |
| `packages/client-graph/src/deferred-models.test.ts` | 1 | 0 |
| `tests/worklist/harness/src/active-work-coverage.test.ts` | 2 | 0 |
| `tests/worklist/harness/src/active-work-parity.test.ts` | 3 | 0 |
| `tests/worklist/harness/src/reads-probe.test.tsx` | 3 | 0 |
| `tests/worklist/harness/review/m3-shape-probes.test.tsx`, bucket-sized work | 2 | 6 |
| `apps/web/test/pool-bundle-boundary.test.ts` | 3 | 0 |

Together these are **204 unique passing cases in 18 focused files**, not a suite
result. The first model run's nineteen unaffected passing cases are retained;
its failed new loading fixture was fixed and rerun separately as described
above. All later selections exited green, sequentially in the pinned flatblock
checkout. The meter was checked free before each run; no memory stop occurred.

The complete-field wrong-answer control was rerun on this repaired source:
`PODIUM_RECORD_NEGATIVE_CONTROL=1` makes the unchanged fixture assertion fail
at `machine.name` (`Wrong answer` versus `Workstation`), with one expected RED
and five filtered cases. The ordinary six-case file is GREEN. Its prior run
outcome and placement controls remain recorded below.

There are no new React or MobX warnings. The mobile invocation still prints
Bun's unsupported `moduleSuffixes` option warning from the unchanged mobile
`tsconfig.json`; that configuration and the Bun pin have no diff against the
landed prerequisite. It is separate from the repaired observer/render warnings.

Selected runner receipts on flatblock:

- schema/source/deferred loading: `/tmp/podium-focused-tests-Si5A4s/results.json`
- machine panel: `/tmp/podium-focused-tests-nxjDc1/results.json`
- compiler fixture helpers: `/tmp/podium-focused-tests-q9ghJt/results.json`
- targeted shape helper: `/tmp/podium-focused-tests-OLceWM/results.json`
- phone settings: `/tmp/podium-focused-tests-72lcLz/results.json`
- emitted-source boundary: `/tmp/podium-focused-tests-SxrvyB/results.json`
- planted wrong answer: `/tmp/podium-focused-tests-tuhHhM/results.json`
- light scan: `/tmp/pod5868-light-scan-repair.log` — 2,210 fingerprints,
  2,211 occurrences, 2,063 carried repair debts, **0 ratchet errors**.

### Historical startup estimate and operator hold

The landed prerequisite's normal production build contains 2,149,989 eager raw
bytes, leaving 11 bytes under the unchanged 2,150,000-byte ceiling. An isolated
esbuild source transform of changed modules in that build's eager import closure
estimates the model range at **+1,558 bytes**:

| Eager source | Minified source delta (bytes) |
| --- | ---: |
| `models.ts` | +577 |
| `pool.ts` | +507 |
| `shared/schema.ts` | +426 |
| `source-registry.ts` | +65 |
| `header-entities.ts` | +36 |
| `shell-views.ts` | +9 |
| `tables.ts` | -29 |
| `enumerate.ts` | -22 |
| `workflow-schema.ts` | -11 |
| `header-schema.ts`, `index.ts` | 0 |
| **Total** | **+1,558** |

This transforms individual TypeScript modules without bundling. It is an
estimate, not a replacement production build or a budget pass. The large new
field declarations and model bodies are deferred; the estimate covers generic
class registration, identity/residency declarations and receipt-time composition.

POD-4286 rejected compacting existing metadata and confirmed that generic
deferred-entity admission is held under POD-5910. The uncommitted compaction was
discarded completely. The candidate therefore keeps the readable, correct eager
stub and explicitly **needs about +1.6 KB startup budget**, pending the operator's
decision. No ceiling, allowance, source citation or storage/publication contract
was changed to hide that cost. POD-5895 holds the shared gates until that decision.

## Focused proof

All test commands ran sequentially on flatblock in `~/podium-test-5868`, using
its copied, pinned `.toolchain/bun` and `node -> bun` link. The recorded-PID
guard required no worker stop. These are focused results, not a suite result.

Before replacing the old paths, commit `f4c02b6b6c` added the same-fixture
old/new parity tests. All five initial cases failed on the old implementation,
which lacked the canonical tables/models. The final six-case file also checks
the complete wire/projection field sets, every fixture field, shared identity,
two simultaneous readers per kind, addressed updates without enumeration,
live merge, replacement/removal and migrated view identities.

| Focused file | Passing tests |
| --- | ---: |
| `packages/client-graph/src/synced-record-models.test.ts` | 6 |
| `packages/client-graph/src/automation-source.test.ts` | 1 |
| `tests/worklist/shared/src/schema.test.ts` | 61 |
| `packages/client-graph/src/models.test.ts` | 13 |
| `packages/client-graph/src/companion-joins.test.ts` | 8 |
| `packages/client-graph/src/automation-targets.work.test.ts` | 1 |
| `packages/client-graph/src/header-offline-machines.work.test.ts` | 2 |
| `apps/web/src/app/automation-readers.test.tsx` | 6 |
| `apps/web/src/features/workflows/readers.test.tsx` | 6 |
| `apps/web/src/features/settings/sections/updates.test.tsx` | 36 |
| `apps/web/src/features/settings/MachinesPanel.test.tsx` | 46 |
| `apps/mobile/src/screens/SettingsScreen.pool.test.tsx` | 4 |

There are 190 unique passing cases; repeated runs of the six model tests are
counted once. The panel's 46 cases pass again at `c29489618a`, without warnings
or errors in the run output; the phone's four pass on `d6bcb578d7`, including
its 1x/4x work checks. The later fixture repair changes no production code.
Earlier files passed after
the applicable model/source/reader repairs; subsequent panel-only changes did
not change those readers. Companion work remains one addressed companion and
zero session writes at 1x/4x. Offline machine/header behavior remains green.

### Assertion-boundary exceptions and negative controls

POD-4286 expressly authorized reading actual model getters into declared-field
records at three diagnostic boundaries. Fixtures, expected values and behavioral
assertions remain unchanged:

1. `automation-check.ts` normalizes actual automation and run snapshot values.
2. `automation-readers.test.tsx` normalizes the two actual history assertions:
   the newest run window and its first run.
3. `workflow-check.ts` normalizes actual placement lists to `MachineWire` fields.

The helper reads the model getters, rather than bypassing them through raw
rows. A planted wrong machine name fails the complete model parity check
(`PODIUM_RECORD_NEGATIVE_CONTROL`). A wrong run outcome fails the normalized
history-window assertion (`PODIUM_AUTOMATION_NEGATIVE_CONTROL`). A wrong
placement machine name produces a legacy/new snapshot difference and fails
the unchanged parity assertion (`PODIUM_WORKFLOW_NEGATIVE_CONTROL`). Each
targeted control ran RED; the corresponding ordinary file ran GREEN.

The machine-panel test changes only imports to the real model pool and an
isolated ID-only catalogue bridge. All 46 assertions and fixture values stay
unchanged. The bridge's render wrapper now publishes fixture input before
mount and rerender; its pool hooks only read the prepared pool. The static
schema assertion necessarily lists seven entities instead of four, and its
source-citation resolver recognizes the three added wire types.

### Render-warning trace and repair

The earlier panel run emitted React's update-during-render warning. POD-4286
required its removal before accepting the candidate. The source trace locates
it in the test path: `pool-fixture.ts`'s `useFixturePool()` calls
`syncPoolFixture()` during render; when a plain fixture changes on rerender,
that function applies its machine rows and wakes already-mounted observers.
The isolated bridge previously invoked that hook while `MachinesPanel`
rendered. This was fixture ingestion on read.

Production attaches through `StoreProvider`'s `useEffect`
(`packages/client-core/src/react/provider.tsx:298`). `createPoolHost.attach`
asynchronously creates the runtime pool
(`packages/client-graph/src/host/pool-host.ts:132`); its production hooks read
that attached pool. Machine bootstrap and changes are installed through
`header-source.ts`'s keyed source callback and, for settings-only hosts,
`SettingsSource.attach`'s initial input and `owner.onList` callback. Neither
production pool hook invokes fixture synchronization or machine ingestion.

Repair `c29489618a` makes the isolated fixture's `renderSettingsPool()` publish
before calling testing-library `render()`. Its `rerender()` publishes inside
`act()` before calling React's rerender. The mocked pool hooks then read only
that prepared pool; they throw if no fixture has been published. The test file
still changes only imports. No production code, fixture value or assertion was
changed for this repair, and no console output was suppressed.

The existing 46-case file was rerun on flatblock with the recorded-PID guard:
46 passed, zero failures, and no warnings or errors in the complete tool output.
The revoke-update case still passes. Validation PID was `3268849`; no worker
crossed the stop threshold. The run receipt is also in
`/tmp/pod5868-fixture-before-render.log` in this session, with the runner's JSON
report at `/tmp/podium-focused-tests-ny2qRx/results.json` on flatblock.

## Historical scan evidence and remaining gates

The earlier post-rebase light interaction scan reported **0 ratchet errors**,
2,210 fingerprints and 2,211 occurrences. Compared with the source prerequisite
`1a32e0d834` baseline, 110 moved
fingerprints retain their classification, owner, trigger, bound, reason and
guard; twelve obsolete shell-reader entries disappear. Seven new sites are
explicit ingestion work and two sites are bounded test-fixture catalogue work.
The 2,063 remaining `REQUIRED REPAIR` entries are existing debts, not claimed
repairs. This source scan does not substitute for the structural census.

POD-5895 owns the shared lean gate, full typecheck, normal web build, structural
census under `meter:flatblock`, and landing, as assigned by POD-4286. Those gates,
structural flat-or-better proof and ff-only pilot landing remain pending for
this model range. The prerequisite's green shared receipts and actual landing
do not validate this candidate. This issue stays in progress until the required
receipts arrive. The coordinator has since lifted the owner-lane budget blocker;
current receipts and remaining shared checks are listed above.

The initial compatibility preview was never used as a landed base. Complete
source reconciliation preserves history's `appendEvents` bound at **50 rows**
and its classification, owner, trigger, reason, guard and occurrence count.
Replaying the later complete range onto actual prerequisite `006a4ba7c9` kept
nineteen patches equal; the one pool conflict was the identical prerequisite
resident-presence consolidation. Resolution keeps that presence check before
payload reads, retains both terminal reasons, and adds the deferred-class check.
The reconciled pool body is byte-identical to the prepared body before rebase.
Ancestry `d12bee4103 -> 006a4ba7c9 -> 54e8aeccb9` is verified. This is source
reconciliation, not a shared-gate or landing receipt. No validation ran during
POD-5911's priority trace window.
