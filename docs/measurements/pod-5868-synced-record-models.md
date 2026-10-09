# POD-5868: shared synced record models

Machines, automations and automation runs now have one shared model per ID in
the pool. The schema cites `MachineWire`, `MachineProjection`, `AutomationWire`
and `AutomationRunWire`; their fields use the existing schema installer and
generic tables. No entity adds storage or changes table publication granularity.

## Scope and base

POD-4286 initially authorized this range on POD-5867's fixed, unlanded tip
`0b36eebe33840d05249fafd66fbb48997b1dfce1`. It superseded the earlier instruction
to wait for landing. The initial proof used pilot
`5cefac00403c52651b8148485609548323964953`. History has since landed ff-only at
actual pilot `d12bee410318123f0e7ad26b2d3551a1f381deb0`; the complete 15-commit
model range was rebased without conflicts onto POD-5867's actual replacement
`1a32e0d834350e7937024ac2ee55413396fbe3c1`. This report update follows that
complete rebase and changes no runtime or fixture code. Reconcile again if the
prerequisite gains its remaining proof before the shared freeze.

The coordinator narrowed this issue to synced records. Workflow record models,
spec metadata, request ingestion and request-record retention remain deferred
to POD-5915 while POD-5910 decides the generic machinery. Spec bodies remain
request answers. Workflow placement's machine reader moves here; its workflow
subject and request collections remain outside this range. POD-5874's separate
measurement of field publication can apply to these generic tables too.

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

## Scan evidence and remaining gates

The fresh post-rebase light interaction scan reports **0 ratchet errors**, 2,210
fingerprints and 2,211 occurrences. Compared with the actual prerequisite
`1a32e0d834` baseline, 110 moved
fingerprints retain their classification, owner, trigger, bound, reason and
guard; twelve obsolete shell-reader entries disappear. Seven new sites are
explicit ingestion work and two sites are bounded test-fixture catalogue work.
The 2,063 remaining `REQUIRED REPAIR` entries are existing debts, not claimed
repairs. This source scan does not substitute for the structural census.

POD-5895 owns the shared lean gate, full typecheck, normal web build, structural
census under `meter:flatblock`, and landing, as assigned by POD-4286. Those gates,
structural flat-or-better proof and ff-only pilot landing remain pending. The
actual history-based prerequisite rebase is verified below; its remaining
proof may advance its tip before the shared freeze. This issue stays in
progress until the required receipts arrive.

The initial compatibility preview was not used as a landed base. After the
actual history landing and POD-5867's replacement receipt, the full original
15-commit range `0b36eebe33..eed25fb6a6` was replayed onto `1a32e0d834`, yielding
`5e3e958bdf` before this report update. Range-diff reports fourteen equal
patches. The remaining census patch differs only in its context: the landed
history's 50-row bound replaces the older 200-row bound, and Unicode guard
rendering is semantically identical. The warning-free fixture repair is among
the equal patches.

An assertion over the actual landed history, prerequisite and rebased model
tip confirms that the `appendEvents` bound is 50 rows and its classification,
owner, trigger, reason, guard and occurrence count are identical. Ancestry
`d12bee4103 -> 1a32e0d834 -> 5e3e958bdf` is verified. This is source
reconciliation, not a shared-gate or landing receipt. No focused tests, census
or lease work ran during POD-5911's trace window; POD-5895 retains the final
shared gates after that window.
