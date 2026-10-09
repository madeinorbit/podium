# POD-5868: shared synced record models

Machines, automations and automation runs now have one shared model per ID in
the pool. The schema cites `MachineWire`, `MachineProjection`, `AutomationWire`
and `AutomationRunWire`; their fields use the existing schema installer and
generic tables. No entity adds storage or changes table publication granularity.

## Scope and base

POD-4286 authorized this range on POD-5867's fixed, unlanded tip
`0b36eebe33840d05249fafd66fbb48997b1dfce1`. It superseded the earlier instruction
to wait for landing. Pilot remains `5cefac00403c52651b8148485609548323964953`
at this handoff. Rebase the range onto a replacement prerequisite tip, then onto
the pilot after that prerequisite lands.

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
counted once. The panel's 46 cases pass at `d6bcb578d7`; the phone's four pass
on that source too, including its 1x/4x work checks. Earlier files passed after
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
unchanged. That fixture emits a React update-during-render warning when its
plain input is synchronously ingested on rerender; the revoke repaint assertion
passes. This is a test-fixture limitation recorded for review. The static
schema assertion necessarily lists seven entities instead of four, and its
source-citation resolver recognizes the three added wire types.

## Scan evidence and remaining gates

The light interaction scan reports **0 ratchet errors**, 2,214 fingerprints and
2,215 occurrences. Compared with the exact prerequisite baseline, 110 moved
fingerprints retain their classification, owner, trigger, bound, reason and
guard; twelve obsolete shell-reader entries disappear. Seven new sites are
explicit ingestion work and two sites are bounded test-fixture catalogue work.
The 2,068 remaining `REQUIRED REPAIR` entries are existing debts, not claimed
repairs. This source scan does not substitute for the structural census.

POD-5895 owns the shared lean gate, full typecheck, normal web build, structural
census under `meter:flatblock`, and landing, as assigned by POD-4286. Those gates,
structural flat-or-better proof, prerequisite rebase and ff-only pilot landing
remain pending. This issue stays in progress until their receipts arrive.
