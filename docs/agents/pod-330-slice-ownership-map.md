# POD-330 — viewmodel slice ownership map

**Measured at:** `c3b8247e` (branch `issue/330-6-3-viewmodel-slices-split-derive-ts-int`, integration + main).
**Subject:** `packages/client-core/src/viewmodels/derive.ts` — **2,585 lines**, 133 exported symbols.
(The brief's 1,430 and 1,697 are both stale.)

This document is the answer to the one question that has to be settled before any code moves:
**which derivations do two or more of worklist / chat / issues / terminal / machines both read, and
who owns each one.** It is written before the cut, deliberately.

---

## 0. Why the first attempt produced cycles

`wip/330-first-pass-wrong-seam` (7e49ed0a) cut by **file size**, not by ownership. Its own filenames
are the diagnosis:

| File it created | What it reveals |
|---|---|
| `slices/worklist-helpers.ts` (38 lines) | a shared-helpers bag — the god object with an extra hop |
| `slices/nav-types.ts` (37 lines) | a second one, for the types the bag could not hold |
| `slices/terminal-sidebar.ts` (408 lines) | the **sidebar** landed under **terminal** — the ownership question never got asked |

A mechanical cut moves code without deciding who owns what, so state that was implicit inside one
file becomes import cycles between five. The cycles were not an obstacle on the way to the split;
they were the split reporting that the seam was wrong.

---

## 1. The measured shared set

Every symbol declared in `derive.ts`, cross-referenced against every consumer in `apps/web/src`,
`apps/mobile/src` and `packages/client-core/src`, bucketed by feature surface.

**Ten symbols are read by two or more core slices. That list is the whole design.**

| Symbol | Read by | Verdict |
|---|---|---|
| `panelLabel` | machines, terminal, worklist | → **F1** |
| `isSessionWorking` | issues, terminal, worklist | → **F1** |
| `sessionDotTone` | terminal, worklist | → **F1** |
| `agentBadge` | terminal, worklist | → **F1** |
| `agentColorHex` | terminal, worklist | → **F1** |
| `chatActivity` | chat, terminal | → **F1** |
| `reposToViews` | issues, machines, terminal | → **machines** (published output) |
| `spawnTargetForRepo` | terminal, worklist | → **machines** (published output) |
| `resolveDefaultAgent` | terminal, worklist | → **machines** (published output) |
| `sidebarSections` | terminal, worklist | → **worklist** (published output) |

Plus one family the census under-counts because its members are consumed *inside* `derive.ts`
rather than across the app — `indexSessionOwnership` / `sessionsForIssueNav` /
`sessionsForWorktree` / `archivedSessionsFor*` / `issueIdOwningSession`. Three slices ask this
question. → **F2**.

Everything else — 40 single-slice symbols and the internal helpers behind them — has exactly one
owner and moves without argument.

---

## 2. Two shared derivations, each with a name and an owner

These are **not** a helpers bag. Each answers one question, each has a signature shape it never
departs from, and neither can import a slice — so neither can participate in a cycle.

### F1 — `viewmodels/session-status.ts` — *what one session is doing*

`agentBadge` · `sessionDotTone` · `isSessionWorking` · `motionPhase` · `motionTiming` ·
`formatClock` · `chatActivity` · `panelLabel` · `defaultChatCapable` · `agentColorHex` ·
`isUnstartedSession` · `nativeSubagentCountOf` · `nativeSubagentLabel` ·
`sessionHasNativeSubagents` · `resumeCommand` · `exitedRecovery` (+ their types)

**The invariant that makes it a module and not a bag: one session in — optionally with its own
issue for the finished-offer rule — one presentation value out.** No collections, no cross-entity
state, no lists, no ordering. It depends on `@podium/model` and `../focus` and on nothing else in
`viewmodels/`.

This is not a new idea imposed on the tree: `session-card.ts` **already** imports exactly
`{ DotTone, panelLabel, sessionDotTone }` from `derive.ts` today. F1 is the module that import was
always reaching for.

Consumers: all five slices.

### F2 — `viewmodels/session-ownership.ts` — *which sessions belong to what*

`SessionOwnershipIndex` · `indexSessionOwnership` · `sessionsForWorktree` · `sessionsForIssueNav` ·
`archivedSessionsForIssue` · `archivedSessionsForWorktreePath` · `issueIdOwningSession`

A genuine cross-entity derivation (sessions × issues × worktree roots), not a lookup — and it is
the question worklist rows, terminal tab strips and issue pages all ask. One question, one module.

Consumers: worklist, terminal, issues.

---

## 3. The five slices, and the single slice→slice edge

```
             F1  session-status     F2  session-ownership   F3  session-urgency
             (no viewmodel deps)    (no viewmodel deps)      (no viewmodel deps)
                         │
        ┌────────────┬───┴────────┬────────────┬────────────┐
        │            │            │            │            │
    machines ──▶ worklist ──▶  issues      terminal       chat
   (F1)          (F1,F2,F3,     (F1,F2,F3)  (F1,F2)       (F1)
                  machines,
                  issues)
```

**No slice imports another slice except `worklist → machines` and `worklist → issues`, both one
way.** Still a DAG; no cycle.

### 3.0 F3 — `viewmodels/session-urgency.ts` — *how sessions rank against each other*

`STALE_INACTIVE_MS` · `sortSessionsForSidebar` · `sessionUrgencyRank` · `mostUrgentSession`

A third named shared derivation, found by applying §1's own lesson to the issues cut: the census
counted EXTERNAL consumers, and `sortSessionsForSidebar` has none outside tests. Its real callers
are `issueNavList` (issues) and `sidebarSections` (worklist), both **inside** the file being cut.
Left in the worklist it would have made `issues → worklist` an edge on top of `worklist → issues`
— a cycle, arrived at by not looking inside the file. F1 cannot hold it: F1's invariant is one
session in, one presentation value out, with no collections and no ordering. Ranking IS the
collection question.

Invariant: **a collection of sessions in, an order or a rank out.** No issues, no rows, no repos,
no presentation strings. Consumers: worklist, issues.

| Slice | Owns |
|---|---|
| **machines** | `reposToViews`, `RepoView`/`WorktreeView`, `repoBranchForCwd`, `isKnownWorktreePath`, `repoUsageAt`, `spawnTargetForRepo`, `resolveDefaultAgent`, `hostMemoryView`/`formatMemBytes`, and the see/use/manage verb publication over `packages/model/src/predicates/machine-selection.ts` |
| **worklist** | `sidebarSections`/`RepoNavView`, unified row construction, banding/ordering/grouping, snoozed + closed folds, `rowStatusLine`/`rowMotionTiming`/`rowWaitingCount`, per-user unread/snooze/pin inputs, `tray.ts` |
| **issues** | `IssueNavigationModel`, `subIssuesOf`, `issueNavList`/`filterIssueNav`, `branchRollup`, `draftIssueLabel`/`isDraftAgentVessel`, `issueFinishedAt`/`isClosedTopLevelIssue`, the `issuePendingDecision` family, `resolveIssueEdge` (cross-boundary policy), `board-scope.ts` |
| **terminal** | `session-card.ts`, `orderTabs`, `elevateCoordinatorSession`, `pickPaneSession`, `orphanSessionFor`, `planWorktreeMoves`, `dock-panel.ts` |
| **chat** | `chat.ts`, `transcript.ts`, `cursor-order.ts`, `ask-question.ts`, transcript windows, pending reconciliation |

### 3.1 Why `worklist → machines` is an edge and not a cycle

Today it looks like a cycle: `sidebarSections` (worklist) calls `reposToViews` (machines), while
`spawnTargetForRepo` (machines) takes `RepoNavView` (worklist). This is precisely where the first
attempt got stuck.

**The evidence that the dependency is simply pointed the wrong way is inside
`spawnTargetForRepo` itself** — it opens by declaring a local `viewFor()` whose entire job is to
strip `repoName` / `sessions` / `issues` back off the nav view:

```ts
const viewFor = (worktree: WorktreeNavView | WorktreeView): WorktreeView => {
  const { repoName: _repoName, sessions: _sessions, issues: _issues, ...view } = worktree as WorktreeNavView
  return view
}
```

Every field the function actually reads — `path`, `name`, `worktrees`, `machines`, `repoId` — is
available without the nav decoration, so retyping the parameter removes machines' type dependency
on worklist. That is what breaks the cycle.

**Correction, from doing it.** The pre-cut version of this section claimed `RepoNavView` was
structurally assignable to `RepoView`, so the retype would need no call-site changes. That was
wrong, and the compiler said so: `RepoView.machines` is **required** while `RepoNavView.machines`
is **optional**, so the assignment fails in both directions. Checking that the fields were present
is not the same as checking assignability, and I had only done the first.

The fix is better than the original plan anyway: the parameter is now `SpawnRepoTarget`, a type
that names exactly what spawn placement needs (`path`, `name`, `worktrees`, optional `machines`,
optional `repoId`). `RepoView` and `RepoNavView` both satisfy it, neither is imported by the
machines slice, and no call site changed. Naming the real contract beats borrowing whichever
existing type looked closest.

> **A helper whose first act is to undo its own parameter type is the seam telling you which side
> owns it.**
>
> This generalises past this issue, and it is a better test for a wrong-way dependency than the
> import graph: the import graph shows you the **edge**, while this shows you the **intent**. An
> edge can be load-bearing or accidental and the graph cannot tell them apart. A function that
> immediately destructures away the very fields that distinguish its parameter's type is telling
> you, in code, that it never wanted that type — which is the same thing as telling you which
> module should have owned it.

The repo/worktree/machine structure is a machines fact (doc §3.1.1, "owned compute" — repos,
prefixes and worktrees inherit their machine's scoping); the `sessions[]`/`issues[]` decoration on
top of it is the worklist's. Split there and the cycle is gone by construction, not by a helpers
module.

### 3.2 One non-finding, recorded so it is not relitigated

`issueVisibleInSidebar` / `sessionVisibleInSidebar` and the finished-grace + unread windows *read*
like shared worklist/issues state. They are not: every consumer is a worklist row-placement
decision. They stay in worklist. Naming this here because it is the most plausible wrong answer.

---

## 4. Where the multi-user requirements attach

| Requirement (brief / `docs/multi-user-readiness.md`) | Owner |
|---|---|
| Referent tri-state — present / **not-visible** / not-yet-arrived | **F2**. Every "referenced entity is absent" question in `derive.ts` today is a membership lookup that returns `[]` or `null` and so collapses all three. F2 is the one place that can distinguish them. |
| `evict` is not a deletion — no tombstone, no removal state, no heal loop (§3.1 ¶2) | **F2** + **worklist**. `packages/sync/src/replica/types.ts` already carries `ExitKind = 'removed' \| 'evicted'`; the slices must recompute cleanly across it. |
| Machine `see` / `use` / `manage` as separate verbs; unauthorized ≠ unreachable (§3.1.4 M1, M5) | **machines**. `resolveTargetMachine` must never return a machine the principal lacks `use` on. |
| actor + on-behalf-of pair, never synthesised; owner as a published field (§3.1.3 A3/A4) | **F1** publishes the pair per session; worklist and issues surface it. |
| Per-user unread / snooze / pin from replicated rows, never localStorage (§3.3) | **worklist**. POD-329 owns the enforcement boundary. |
| Presence — ephemeral, outside the memoized entity slices, never in the funnel (§3.4) | **its own publisher**, deliberately not a slice. |
| Cross-boundary edges renderable as hidden **or** opaque (§3.1.2) | shape supported by **F2**; the shipped choice recorded in the ledger, never a slice default. |

---

## 4b. Two ways this issue's instruments reported success while measuring nothing

Both were caught during POD-330 and both belong to the same family, so they are recorded here for
whoever picks the work up.

**The render probe that reported `0` as a pass.** The first version of
`apps/web/src/perf/slice-render-count.test.tsx` re-rendered the *same element object* on every
simulated store publish. React bails out before the component runs in that case, so the probe
recorded **zero derivation executions — and passed**, because zero is comfortably under any
ceiling. It was caught only because zero was implausible, not because anything failed. The probe
now asserts it fired before it trusts its own numbers:

```ts
expect(derivations.sidebarSections).toBeGreaterThan(atMount.sidebarSections)
```

> **Prove the instrument can say YES before believing what it says.** A performance probe that
> measures nothing reports the best possible result, which makes it the most dangerous shape of
> all.

**Green from the wrong tree.** This worktree had **no `node_modules` at all**, so every
`@podium/*` import resolved out to the *main* checkout rather than the code under test. The
worklist suite appeared to be failing (`isIssueDeferred is not a function`) purely because of it,
and — far more dangerous — **any green measured here before `bun install` was meaningless**. Green
from the wrong tree is indistinguishable from green.

Check `ls node_modules/@podium` in a fresh worktree before quoting any result from it. The linker
is `hoisted` (see `bunfig.toml`), so the links land at the repo root, not under `apps/*`.

## 4a. The publication mechanism, and the bar it had to clear

`viewmodels/slices/publish.ts` + `react/use-slice.ts`.

A slice is derived ONCE per snapshot and handed to every reader; three components reading the
worklist cause one derivation, not three. That is the whole point of publishing.

The bar was not performance. `react/provider.tsx` had already written it down, in the comment that
kept its own hand-rolled selector cache:

> When POD-330 lands its slice mechanism it should be measured against exactly this: **it must
> invalidate on shrink-without-revision-change, not merely on update.**

Under the scoped feed the world can SHRINK when the authority evicts a row — a removal from your
view that is not a deletion and that moves no revision. A cache keyed on entity identity, on a
dependency set of ids, or on a revision high-water mark is wrong under all three, because each
encodes "a row I cannot see is merely LATE".

The key is therefore the snapshot OBJECT and nothing else, which makes evict, rescope and ordinary
update indistinguishable to it: all three miss, all three re-derive from what is visible now. And
the reason that is STRUCTURAL rather than disciplined is worth stating — **the publisher is generic
over its source and never sees an id, a revision or a collection, so it could not key on one if it
wanted to. The wrong cache is unwritable here, not merely avoided.**

The same property carries the principal boundary: a new principal is a new runtime, so a new
handle, so a new publisher holding nothing. Nothing has to be TOLD that a sign-out happened — and a
cache that must be told is a cache that one day will not be.

Presence does not come through here. It is stream-plane, ephemeral and blank offline (POD-1078), so
it gets its own publisher and is deliberately not expressible as a `SliceDefinition`.

## 4d. Audit item zero — what a refresh KEY was hiding

The superagent view kept a shadow mirror: its own `SuperThread` interface, its own `useState` copy
of the list, its own tRPC fetch, and a `superRefreshKey` counter that actions bumped from the other
side of the app to make it refetch. Four mechanisms where the store already had one of each.

**The counter is the part worth naming.** A refresh key is a subscription written by hand, badly:
it can say only *something, somewhere, changed*, so every bump refetches everything, and a bump
nobody remembered to add is a view that silently shows a stale list with no error and no warning.
`refreshSuperThreads()` says what it does; the store publishes the result; the view reads a slice.

Per-user privacy (doc §3.1.6 S2) is structural rather than checked: the authority scopes
`listThreads` to the caller, and the slice exposes no lookup that takes a bare id and goes looking,
so there is nothing here that could address another user's thread.

Scope note, because the criterion's parenthetical is easy to misread: the rearch audit item
literally named `superagent-shadow-types` counts declarations in `apps/mobile/src/client/trpc.ts`
and carries `phase: 'POD-332'`. It is NOT this issue's to zero. What POD-330 owed — and deleted —
is the WEB mirror the criterion describes in prose.

## 4c. LEDGER — what the phase shipped for cross-boundary edges (§3.1.2)

The acceptance criterion asks for the shipped choice to be *recorded here, not baked into a slice
default*. What shipped:

**The mechanism, with no default.** `resolveIssueEdge(targetId, lookup, policy, exitOf)` in the
issues slice takes `policy: 'hidden' | 'opaque'` as a **required argument**. There is no default
value, so a caller cannot acquire a policy by omission — picking one is a visible act at the call
site, and changing product policy later is a call-site edit, not a slice rewrite.

**Which shape the surfaces use: not yet decided, and deliberately not decided here.** No consumer
passes a policy today, because no consumer has been ported to the slices yet (POD-331 owns that).
On the current single-user tree the question is unobservable: with one admin owning everything,
`not-visible` never occurs, so `hidden` and `opaque` produce byte-identical output. The choice is a
product decision that belongs to whoever ports the surfaces, with §3.1.2's own framing — an opaque
reference is honest about the existence of work you cannot see, and hiding leaks nothing at all.

**What the slice guarantees either way**, and what the tests pin:
- `not-visible` never renders as `removed`. Eviction is not deletion.
- An opaque edge is ANONYMOUS: `resolution.value` is undefined, so no title, ref or stage leaks
  through it. Publishing the id of an issue the principal may not resolve is the leak the policy
  question is about.
- `pending` is neither shape — it is the one state a spinner is correct for.
- `branchRollup` counts only what the replica HOLDS. It does not surface "and N more you cannot
  see": a count IS an existence fact, and §3.1.2 lists counts as an open policy question, so
  publishing one by default would settle it silently.

## 4e. The ~400-line criterion: one split, one argued exception

Two modules were over the acceptance criterion's ~400 lines (both were under it at their cut —
390 and 380 — and grew afterwards). They got opposite answers, on purpose.

**`slices/machines.ts` (464) was SPLIT, and the line count was the prompt rather than the reason.**
Asked what questions it answered, it had three:

| module | lines | question |
|---|---|---|
| `slices/machines/facts.ts` | 217 | what IS on this machine — repos, worktrees, host metrics |
| `slices/machines/authority.ts` | 160 | what may this principal DO with it — see / use / manage |
| `slices/machines/placement.ts` | 126 | where does a new agent GO — worktree, machine, agent kind |

The facts/authority line is the one worth having: a FACT the authority sends is not a DECISION the
authority made, and `use` is a code-execution boundary. Placement separates from authority for the
same reason in the other direction — placement that could also authorize would be a
code-execution decision hidden inside a layout helper. A split by line count would have put half
the verbs in each file.

**`session-status.ts` (451) was NOT split, and the exception is argued with a predicate a test
enforces** (`session-status.invariant.test.ts`). F1 answers exactly one question, and its stated
membership invariant is the thing that would actually be violated if it drifted:

> one session in — optionally with its own issue — one presentation value out. No collections, no
> cross-entity state, no ordering, no lists.

The test's mechanical half: **no exported function may take a COLLECTION of sessions, and the
module may not import a slice.** Both mutate to red (an exported `anyWorking(all: SessionMeta[])`,
and an added slice import), and the parser asserts it matched something before trusting its own
verdicts — a source-scanning check that matches nothing passes every assertion it makes.

The day that predicate fails is the day the exception expires, because it means the one question
has become two. That is the difference between an exception and a note: **an exception is a claim
with a check attached; a note is a claim.**

### 4e.1 The limit of a shape predicate, found the day after it was written

POD-1503 moved `elevateCoordinatorSession` into F3 (`session-urgency.ts`) to delete the
`worklist -> terminal` edge, and justified it against F3's invariant *verbatim*: "a collection of
sessions in, an order or a rank out. No issues, no rows, no repos." It fits — I checked the tip
rather than the report, and F3 still imports only `@podium/model` and `../focus`. The invariant
also REFUSED the function sitting immediately below it, `isCoordinatorSession`, because that one
takes an `IssueWire`. Two adjacent symbols, one claimed and one refused, arbitrated by a written
sentence rather than by anyone's judgement. That is what an invariant is for.

**But note exactly what did the arbitrating: the SHAPE clause, not the QUESTION clause.** F3's
question is *how sessions rank against each other*, and coordinator elevation does not rank
sessions against each other — it honours an external designation. Shape said yes; question was
never consulted, because the question is not mechanically checkable and the shape is.

That is the honest limit of §4e's predicate, and it applies to F1's just as much:

> **A shape predicate is a NECESSARY condition, not a sufficient one.** It refuses a symbol whose
> shape is wrong. It cannot refuse a symbol whose shape is right and whose question is foreign —
> which is the drift that actually produces god objects, since nobody adds a symbol that looks
> wrong.

The mechanical half is still worth having: it catches the drift a reviewer would have to notice by
reading, and it fails loudly on the day someone hands F1 a list. It just must not be mistaken for
the whole invariant. Where the two halves disagree, the WRITTEN QUESTION should be widened or the
symbol moved — a module whose stated question no longer describes its contents is worse than one
13% over its line budget, because the sentence is what does the arbitration next time.

## 5. What this map commits to

- `derive.ts` is deleted; nothing named `*-helpers` or `*-common` replaces it.
- The import graph above is a DAG and is enforced, not merely intended.
- Single-user parity is the regression guard: one admin owning everything must produce output
  indistinguishable from today's.

---

## 6. POD-1496 — the row half, and what the cut measured

**Measured at:** `09e4fe07` (branch `issue/1496-worklist-row-machinery`).
`derive.ts` is **deleted**. The map's §5 commitment is met: nothing named
`*-helpers` or `*-common` replaced it.

### 6.1 The six row modules, and why six

The row machinery was one interlocking body because a row's SHAPE, its ORDER,
its ATTENTION and its LANE were all reachable from each other inside one file.
Split by question, each edge points one way and the whole thing is a DAG:

```
        row-types.ts ──┬──▶ row-order.ts ──┐
        (what a row IS)│                   ├──▶ rows.ts  (which work earns a row)
                       └──▶ row-attention.ts    ▲
                                  │             │
                                  ▼        visibility.ts
                              folds.ts     (has finished work decayed out)
                           (which lane)
```

**Corrected after review (POD-330 reviewing POD-1496).** The first version of this
section claimed `row-types.ts` "is the leaf and imports nothing from worklist",
and named TWO outgoing slice edges. Both statements were false, and the second
is the dangerous one: POD-331, its six children and POD-332 inherit this map as
their brief, and an incomplete edge list is exactly the blind spot that has
already cost this issue two near-misses. The full census, measured rather than
recalled:

| module | lines | reads from outside worklist |
|---|---|---|
| `row-types.ts` | 71 | F1 session-status, F3 session-urgency, **issues** (type), `./nav` (type) |
| `visibility.ts` | 61 | **issues** |
| `row-order.ts` | 71 | — (worklist-internal only) |
| `row-attention.ts` | 268 | F1, F3, **issues** |
| `rows.ts` | 376 | F1, F2 session-ownership, F3, **issues**, **terminal** |
| `folds.ts` | 180 | **issues** |

`row-order.ts` is the only true leaf. `row-types.ts` is a leaf of the *value*
graph but not of the import graph: it takes `IssueNavigationModel` and
`WorktreeNavView` as TYPES, which erase at runtime and cannot cycle, but which a
reader looking for the module with no dependencies will not find here.

**THE THIRD SLICE EDGE: `worklist -> terminal` — FOUND, THEN DELETED.** `rows.ts`
imported `elevateCoordinatorSession` from the terminal slice — a VALUE import,
not a type — and the map named only two outgoing edges. POD-279 directed the
edge be removed rather than documented, and it was (POD-1503, landed here).

`elevateCoordinatorSession` is *sessions in, an order out*, which is verbatim F3
`session-urgency.ts`'s stated invariant ("a collection of sessions in, an order
or a rank out. No issues, no rows, no repos, no presentation strings"). It was
never a terminal concern; the tab strip was merely its first caller. It now
lives in F3, and both terminal and worklist reach it the same way every slice
reaches a shared derivation. The outgoing edge set is back to **two**:

```
    worklist ──▶ machines   (via nav.ts)
    worklist ──▶ issues     (row-types, visibility, row-attention, rows, folds)
```

**The invariant did the work, and that is the transferable part.** Its sibling
`isCoordinatorSession` stayed in terminal without anyone arbitrating: it takes
an `IssueWire`, and F3's stated shape ("no issues") REFUSES it on sight. Two
functions sitting adjacently in one file, one claimed and one refused, by
reading the invariant rather than by judgement.

> **A module with a written invariant can claim or refuse a symbol without a
> meeting. That is what an invariant is FOR — the ownership question answers
> itself at the point of the move.**

Verified, not asserted: mutating the moved function so the coordinator is
elevated to the BACK instead of the front (`unshift` → `push`) reddens **four
named tests**, including `elevates coordinator among issue sessions and nests
started-by children` — the WORKLIST caller. Coverage did not get orphaned by
the move, which is the failure this map warns about in §6.5. A second mutant
(`i <= 0` → `i < 0`) was silent and is genuinely equivalent: when the
coordinator is already first, the mutant splices and re-inserts it into the same
position, differing only in array identity, not in order.

### 6.2 `orderMap` was NOT duplicated — it had no callers

The brief asked for `orderMap` to be copied into the row-ordering module WITH
its comment, as a deliberate non-edge. It was not, because the copy in
`derive.ts` was **dead**: the only reference to it in the whole tree was its own
declaration, and the only live copy is `slices/terminal.ts`'s — which already
carries the comment explaining why the duplication is deliberate.

The non-edge is real and the comment is right. But carrying a dead helper across
a cut in order to honour it would make the non-edge HARDER to see, not easier: a
future reader finds two copies, one of which nothing calls, and cannot tell
whether the duplication is a decision or an accident. The decision survives where
it is load-bearing.

> **A non-edge is documented by the comment on the live copy, not by the number
> of copies.**

### 6.3 `UnifiedWorkRow.rank` is computed state with no reader

`rowRank` runs on every row, on every build, and on every nesting pass. Mutating
it (`Math.min` → `Math.max` — the most urgent session becomes the least urgent)
was **SILENT across both lanes**, 86 client-core and 91 web tests green.

It is not an assertion gap. A `throw` on the same line reddens **51 named tests**
across both lanes, so the function is entered constantly. And a tree-wide census
of `.rank` readers finds none: the only `.rank` in the codebase outside this
family is `apps/server/src/modules/memory/search.ts`, an unrelated relevance
score.

**Why nobody noticed, added on review.** A reader census is not quite enough on
its own: `rank` DOES appear in `apps/web/src/lib/derive-unified.test.ts` at six
sites — `rank: 0`, `rank: 4` — where fixtures CONSTRUCT it to satisfy the type.
Not one test asserts on it (`grep '\.rank' apps/web/src --include=*.test.*`
returns nothing). A field kept alive by fixtures reads as consumed to anyone
grepping for its name, which is exactly how a dead field survives review after
review. **Count the READS, not the occurrences — a fixture that constructs a
field is evidence about the type, not about the field.**

So the mutant is **genuinely equivalent**, and the reason is that the field has
no consumer. It is a leftover from when the sidebar sorted by urgency; §3 of the
`row-order.ts` header records why it no longer does ("attention is carried
per-row by the square language, never by reordering", #64). Removing it is a
separate change with its own blast radius — filed, not smuggled into this cut.

> **A silent mutant has three meanings and you must name which. Here the probe
> said the code RUNS, and the census said nothing READS it — which makes the
> silence a finding about the design, not about the tests.**

### 6.4 The render probe: no regression, and no improvement yet

Post-cut, on the deleted-derive tree:

```
[POD-330 worklist] per publish: commits=2.2 sidebarSections=1 unifiedWorkList=1
```

Byte-identical to the ceilings measured on the uncut tree at `c3b8247e`. The
split cost nothing, and gained nothing — as predicted. The gain is one
derivation per CHANGE instead of one per CONSUMER, and it needs the published
slice hook, which is NOT in this commit.

**A caveat for whoever measures it.** The probe renders `SidebarUnified` and
nothing else, so it observes ONE consumer. A published hook would move the
number from 1-per-consumer to 1-per-change, but with one consumer those are the
same number: **the probe as written cannot show the improvement it exists to
measure.** Landing the hook must also add a second consumer to the probe's tree
(`CommandPalette` calls `sidebarSections` independently; `SidebarUnified` itself
calls it at two separate call sites, lines 247 and 947) — otherwise the hook
will land, be correct, and measure as a flat 1, and someone will read that as
"no gain".

### 6.5 What remains after this commit

- The published worklist slice — POD-1502. The HOOK MECHANISM already landed on
  integration at `1b7784db` (`slices/publish.ts`, `react/use-slice.ts`); what is
  missing is a `defineSlice` over `sidebarSections` / `unifiedWorkList` and the
  consumer port, plus the probe's second consumer per §6.4.
- `superagent-shadow-types` → zero: see §6.6, it is POD-332's and it is not a
  deletion.
- Removing `UnifiedWorkRow.rank` (§6.3) — POD-1501. Note the six fixture sites in
  `derive-unified.test.ts` construct it; they must be updated, and none asserts
  on it.
- ~~Moving `elevateCoordinatorSession` to F3~~ — **DONE**, POD-1503, in this
  branch. See §6.1: the edge is deleted, not documented.

### 6.6 Two things POD-330 still owns — and an as-of that was missing

Confirmed by POD-330's own review of this branch, and NOT part of POD-1496.

**Two modules are over the ~400-line criterion**: `slices/machines.ts` at 464 and
`session-status.ts` at 451. Both were under it at the cut (390 and 380) and grew
afterwards. POD-330 declines to split them by line count, and its reasoning is
worth keeping rather than just its verdict:

- `session-status.ts` is F1, whose invariant is ONE session in, ONE presentation
  value out. It is one question. Splitting it by size would produce two modules
  with no separate answer between them — the exact failure the first attempt
  made when it cut by size and produced `worklist-helpers.ts` and `nav-types.ts`.
  **A module 13% over budget while answering one question beats two under budget
  sharing a decision.**
- `machines.ts` is the genuine candidate, because it plausibly holds TWO
  questions: what repos/worktrees/metrics exist on a machine (facts), and what
  this principal may DO with it (see/use/manage). If anyone splits it, **the
  verbs are the seam, not the byte count** — and it needs a mutation pass in
  both lanes first.

**The superagent shadow mirror — and the correction that matters more than the
item.** An earlier version of this section named
`apps/web/src/features/superagent/SuperagentView.tsx` lines 32, 115 and 169 as
still carrying the mirror. That was true of the tree it was measured on
(integration at `e33b21c4`) and is already false elsewhere: POD-330 deleted the
interface, the `useState` copy, the cast and the `superRefreshKey` counter in
`11cc7997`, which is pushed but NOT an ancestor of integration.

Neither of us was wrong; the claim simply had no *as-of*.

> **A finding about another issue's file is a claim about a TREE, not about a
> file, and it must carry the SHA it was measured at. Branch-local fixes are
> invisible to every other branch's census, and a census that quotes line
> numbers reads as current long after it stops being true.**

Same family as the "measured claims need an as-of" hazard: on a moving tree a
MEASURED verdict reads as settled and never expires. The mobile half
(`apps/mobile/src/client/trpc.ts`) is a separate matter — it has no canonical
type in `@podium/protocol` or `@podium/model` to point at, so reaching audit
zero there means CREATING the shared type first. The audit assigns the whole
item to **POD-332**.
