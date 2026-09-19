# Principal presentation model

D5 adds an opt-in, principal-owned read model over D2–D4 effective publications.
Set `presentationModel` on `StoreProvider` (or `ClientRuntimeInit`) to enable it.
It defaults to false. Turning it off reconstructs the provider's runtime and removes
the model and effective subscriptions. No production caller enables it in this change.
Commands still come from the existing Store; the model exposes only read cells.

## Ownership and publication

`presentation/model.ts` owns private shallow Maps of borrowed immutable effective
rows, draft strings by address, and explicitly listed navigation fields. `row`,
`draft`, `navigation` and `foregroundIssue` return shared cells exposing only
`getSnapshot` and `subscribe`. `usePresentationCell` uses `useSyncExternalStore`
with the same stable getter for the server snapshot. No kernel, transport,
runtime or command object is made observable; no dependency is added.

The adapter synchronously seeds before the first render. It prepares and validates
all addressed reads, row identities, presence, draft values and shallow navigation
shapes before installing any of a publication. After installing all maps it marks
all affected cells dirty, then delivers notifications. Replacement is explicit and
clears absent rows and drafts, including empty collections. The model does not
infer replacement from a delta's contents.

The runtime serializes the entire legacy/effective publication, including writes
issued by either side's subscribers. The legacy snapshot is installed first, its
first internal observer installs the effective model, and only then do external
legacy subscribers run. Nested commands queue the next dual publication; they do
not advance one public snapshot ahead of the other. Internal command state still
updates synchronously. The same boundary wraps reseeding on restart and public effective-change seeds.
A mutation oracle bypasses the public seed barrier and must fail legacy/model parity.

`dispose` stops the adapter and releases its source subscription. `start` reseeds
the same model from the latest source. `destroy` also clears retained values and
cell subscribers, releases the runtime's internal delivery observer, and prevents
restart. Every source callback carries a generation, so callbacks retained across
stop/start or principal destruction cannot update a live successor. Old cells
read undefined after destruction. Principal changes destroy before constructing
the successor; unauthenticated providers construct neither runtime nor model.

## Explicit input and invalidation inventory

| Cell | Values read | Invalidation |
| --- | --- | --- |
| `row(kind, id)` | Effective immutable row at that address | That exact effective address; explicit replacement |
| `draft(id)` | String at `drafts[id]` | `local.drafts`, diffed by address; explicit replacement |
| `navigation(key)` | Exactly that local field | That local key; explicit replacement |
| `foregroundIssue()` | `view`, `openIssueId`, `selectedIssueId`, visible `issues` map | All four `FOREGROUND_INPUTS`, including issue presence loss without revision change |

`NAVIGATION_INPUTS` lists: view, openIssueId, selectedIssueId, selectedWorktree,
workspaces, paneA, paneB, split, focusedPane, dockTab, superOpen. The inventory lives
next to the implementation. Foreground dependencies are deliberately conservative:
any changed issue invalidates that one shared, lazy derivation. There is no mission
membership or sidebar rollup derivation in D5.

The mutation tests warm the foreground cache, remove each of its four actual
registered dependencies in turn, deliver the complete new data, and require the
oracle to fail. Direct-cell oracles remove the row address, drafts input, or each
of the eleven navigation inputs from the delivered invalidation inventory. Each
unmutated oracle must pass; each omitted-input mutant must fail. Scope eviction is
one of the foreground mutants, rather than relying only on value updates.

## Measured boundary and limitations

The deterministic 200-session subscriber fixture observes **200 coarse wakes →
1 addressed wake** for one changed session (99.5% fewer). The coarse-notification
mutant fails the same isolation assertion. The delta performs **zero collection
enumerations in D5** and two addressed view reads in total: D2's presence check
and D5's preparation. All other 199 cell subscribers remain asleep.

This measures subscription isolation, not browser frame time or heap. D4's pinned
lazy view still builds an **O(collection)** lookup index on the first read of a
changed collection; D5 does not eliminate that upstream cost. Seeds/replacements
are O(total rows); `local.drafts` invalidation scans the draft map because the
upstream contract does not carry draft addresses. Cells are retained lazily for
the principal lifetime and cleared on destruction.

## Verification

The focused `test:file` invocation covers model atomicity, validation failure,
seed/update/replacement, reversible restart, irreversible destruction, retained
callbacks, input mutants, React provider principal/flag transitions, D2 contracts,
and real-runtime legacy/pilot reentrancy. The final rebased candidate ran **60 tests across four files**;
135 unrelated runtime tests were intentionally skipped. This includes eight D5
runtime coordination tests and a public-seed barrier mutant. This is a focused result,
not a full-suite result; the pre-existing restored-file-tab case is outside it.

Client-core, web and mobile passed the scoped cached typecheck wrapper (18 tasks,
13 cache hits). Both client
production builds use the admitted client build lane. Final command outcomes are
recorded on the issue alongside this document.

No browser or desktop-shell driving is needed: this change adds no OS, transport,
new-tab or pointer/keyboard boundary. Independent server-instance identity and
lifecycle are unchanged; the changed lifecycle is the client principal adapter.

## Disable and revert

Leave `presentationModel` absent/false to retain the legacy path with no model or
model subscriptions. The lower-level `effectiveChanges` flag remains independently
available for D2–D4 tests. Revert the D5 commit to remove the model, provider hook
and coordinated-publication queue. The implementation introduces no persistence,
wire, schema or package changes.
