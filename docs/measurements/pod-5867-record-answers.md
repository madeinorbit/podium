# POD-5867: three-way record answers

The addressed APIs now return `Lookup<T> = T | typeof LOADING | Gone`: a resident model/row, one batched load in progress, or terminal absence with reason `removed` or `not-visible`. `MobxPool.model`, `MobxPool.row`, `MobxPool.issue` and `EntityModel.row` preserve this contract. The frontend guide documents the API and caller policies.

Replica exits remain canonical: `createRowSource` forwards `exitKind` from the sync replica, with issue projections mapped to issue lookups. A removed record immediately answers `Gone(removed)` and never starts a load. Cold, unknown and evicted issue/session lookups share the existing batch; an unsuccessful addressed load settles as `Gone(not-visible)` and does not retry until publication of that ID or scope replacement. Readmission returns the same resident/model identity policy. Resident rows carrying soft-delete metadata remain readable for restore flows.

## Caller migration

[The caller census](pod-5867-lookup-callers.csv) lists all 888 addressed lookup calls/property reads in 232 files, with source lines, expressions and policies. It includes production code, internal forwarders, support code and test/control consumers. Raw entries are explicit three-state branches, identity forwarding, contract assertions or planted demand-count controls; they were reviewed individually.

| Policy | Callers | Meaning |
| --- | ---: | --- |
| `omitGone` | 708 | A nullable view/list omits terminal absence and preserves loading. |
| `here` | 110 | Optional resident details omit both pending and gone. |
| `requireHere` | 23 | A resolved record or resident fixture is required. |
| Explicit branch/assertion/forwarding | 47 | The raw contract is handled or asserted directly. |

The omission helpers are policies at the caller boundary; the public lookup never returns `undefined`. Typed core rows and partial declared summaries retain the loading/gone union. Compile-only assertions reject reading fields before narrowing and reject checking only `LOADING` while leaving `Gone` unhandled.

The production `PoolRowSlot` now branches on `LOADING` and `Gone` directly. Its existing cold loading presentation remains; a previously unknown addressed ID can briefly use its supplied loading renderer while the first batch resolves, then disappears when gone. No current app caller supplies this optional renderer. Existing nullable view endpoints preserve their existing cold loading handling; default addressed unknown issue/session reads now report pending until the one-shot load settles. Callers using `here` keep their existing omission presentation. Cold header/summary probes continue to use `mark` and shared model identities, preventing accidental hydration of entire catalogs. Saved selection is installed before row attachment without deriving its placement prematurely.

Existing fixture values and expected assertions are unchanged. Their lookup expressions/imports explicitly select the nullable or resident policy. The coordinator authorized directly affected contract assertions; this migration did not weaken expected data or census bounds. Newly landed POD-5831 comparison fixtures are migrated too, and its deleted card/picker/catalog paths remain deleted.

The full candidate range was rebased onto exact pilot base `f337607628ec030852620f5272c0c03203141b4b` after the shared lane excluded the previous candidate for a phone-board conflict. The landed POD-5865 per-issue facts, compared lists, hierarchy rules and six-lane scan bounds remain intact. Relative to this base, `mobile-tasks.ts` changes only its policy import and its two lookup expressions. The phone row and both board reference fixtures use explicit lookup policies; the newly landed `mobile-tasks.parity.test.ts` is unchanged.

## Focused proof on flatblock

Before deleting the old implementation, the same-fixture comparison was run against it: all four initial contract cases failed with the old wrong answers. The retained old `row`/`model` controls compare resident identity and nullable caller policies on those same fixtures. The new contract additionally covers batched cold/evicted reload, deleted records that never request a load, observation of removal, failed invisible loads that settle once, readmission and a rendered loading slot that terminates for gone records.

After the exact-base rebase, four focused files ran sequentially, one file per command, on flatblock: `mobile-tasks.parity.test.ts` (4), `record-lookup.test.ts` (6), `record-source-lookup.test.ts` (1) and `models.test.ts` (13). All 24 tests are green. The board parity proof includes its planted wrong-answer control, unchanged list identities and proposal reactivity; its assertions were not edited. The source test drives a real sync authority/replica through server deletion, visibility revocation and readmission before checking pool answers. No recorded Vitest process exceeded the ordinary 3 GiB stop threshold. These are focused results, not a suite result.

The preceding candidate also passed the 18-test reference-card parity file without changing its expected answers. That historical result is separate from the 24 tests rerun after this rebase. No focused run started while POD-5895 held the census lease.

## Shared gate and landing

Operator decision relayed by POD-4286 on 2026-10-09 moved full typecheck, lean gate, interaction scans, normal web build, structural census and batch landing to POD-5895. This issue canceled its queued heavy/meter leases and handed off the committed candidate. Final shared-gate/census and landing evidence will be added when that lane reports. No green heavy-gate or flat-or-better census claim is made yet.

The production render-smoke driver v3 is attached to the issue and on flatblock at `/tmp/pod5867-render-smoke-v3.ts` (also `/tmp/pod5867-render-smoke.ts`). It builds ordinary minified product components against synthetic private data, blocks external requests, checks page errors, and covers sidebar, mission pane, workspace/issue dock, a cold archived issue panel and phone Work. Its scratch adapters extend the fixture's route/profile exports and erase an Expo declaration-only leaf while retaining the real Expo web runtime. Its browser control chooses the cold target from the fixture's own corpus and verifies that it is absent from pool memory before opening. It writes JSON and screenshots for review. The shared lane owns this run; candidate-specific results remain pending.
