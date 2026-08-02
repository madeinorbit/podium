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

## 5. What this map commits to

- `derive.ts` is deleted; nothing named `*-helpers` or `*-common` replaces it.
- The import graph above is a DAG and is enforced, not merely intended.
- Single-user parity is the regression guard: one admin owning everything must produce output
  indistinguishable from today's.
