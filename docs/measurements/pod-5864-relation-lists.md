# Stable relation lists

POD-5864 replaces fresh native relation wrappers and permanently settled model
collections with live, shallow-equal lazy lists. Relation and declared-subset ID
lists retain their identity while membership is unchanged. Model collections
retain shared models, follow hydration and deletion, and do not freeze their
first `ready` or `loading` answer. A member's own fields remain live without
changing the membership list.

## Implementation

`PoolRelations` owns a demand-scoped slot index. Each populated slot answers
through `@lazy({ equals: compareShallow })`; its holder leaves the index when
the membership atom loses demand. Empty slots pass on one frozen empty list
and observe the same membership atom, so the first join wakes their readers
without allocating an empty-list computed. No application code compares its
answer with a previous result.

Schema-installed model relation and subset getters use the existing lazy
decorator. Their handles contain stable descriptors; `ready` answers a
shallow-equal list of shared models and `loading` answers the cold-member count.
Retained handles remain live. As with other lazy fields, identity is retained
while watched or during an imperative synchronous run, rather than across
released observation lifetimes.

POD-5822 already removed production `createIdentityQuery` and its callers.
POD-5864 found no remaining production caller to migrate. The existing frozen
query-identity test oracle remains test-only.

## Answer and identity proof

`relation-lists-before.test-helper.ts` preserves the old native iterators and
model collection settle operation only for tests. The parity test compares
every declared collection and subset against those readers on the same
fixtures, then repeats after membership, payload and archived-state changes.
An independent relation index supplies the old ID answers. The wrong-answer
control (`PODIUM_RELATION_NEGATIVE_CONTROL=1`) replaces a populated candidate
answer with an empty list and fails the actual parity assertion.

Eight focused checks cover parity; ID/model identity across unrelated and
member-field edits; joins and leaves; declared subsets; hydration and cold
loading; deletion and re-addition; demand release; imperative reads; unchanged
index replacement; and the first join into an empty list. The existing model
and pool collection files pass unchanged: 13 and 4 checks respectively.

The reader audit covers all 69 syntactic relation/subset call sites in the
client graph, web and mobile production paths. Five belong to the separate
one-argument relation-bucket interface and one to the plain cold index. The
changed native readers' consumers use iteration, spread, a Set constructor,
the first iterator item, or query ID providers, all preserved by readonly ID
arrays. Model readers retain the existing `LazyCollection.ready/loading`
interface. No consumer needed a copied snapshot or an identity adapter.

The unchanged native relation file passes 53 of 54 checks. Its bookkeeping
golden expects 192 plain writes and observes 189, with all other counters
unchanged (outside 0, deleted 4, iterated 112, copied 0). Restoring both changed
production files to the current pilot `2c4e3bd21e` reproduces the same failure.
The assertion is unchanged and the adjacent drift was mailed to POD-4286.
Sidebar attention passes five checks and the two semantic worklist view-model
checks pass unchanged.

## Matched memory

The existing `worklist-issue-fields-memory.ts` probe ran before and after in
separate flatblock Bun processes on pilot `2c4e3bd21e`. Both hold the same
desktop/phone paint demand over 19,468 issues, 17,216 sessions and 769 shown
rows, with forced GC before reading heap size.

| Measurement | Before | After | Change |
| --- | ---: | ---: | ---: |
| Watched computeds | 256,435 | 260,186 | +3,751 (+1.46%) |
| Watched IssueModel fields | 62,245 | 62,245 | 0 |
| Retained worklist heap, bytes | 1,144,898,289 | 1,153,920,372 | +9,022,083 (+0.79%) |
| Total post-GC heap, bytes | 1,254,123,539 | 1,237,986,418 | -16,137,121 |

The pre-worklist heap varied (109,225,250 versus 84,066,046 bytes), so the
worklist increment is the matched retained-demand comparison. Every watched
IssueModel field count is identical. The initial implementation allocated a
computed for empty relation slots too: it added 16,196 watched computeds and
3.21% total heap at the previous pilot base. The shared empty answer reduces
that overhead while its dedicated join/leave proof preserves liveness.

## Final gates and structural census

The operator moved heavy validation and landing to the shared POD-5895 lane
on 2026-10-09. Its final gates and census are pending the candidate handoff.
Earlier lean gate, full typecheck, zero-ratchet scan, normal web build and
isolated production sidebar/issue-panel render were green before the empty-slot
optimization. Those earlier gates are not claimed as validation of the final
tip. The two production render screenshots are attached to POD-5864.
