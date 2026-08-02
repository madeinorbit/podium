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
                    F1  session-status        (no viewmodel deps)
                    F2  session-ownership     (no viewmodel deps)
                         │
        ┌────────────┬───┴────────┬────────────┬────────────┐
        │            │            │            │            │
    machines ──▶ worklist       issues      terminal       chat
   (F1)          (F1,F2,machines) (F1,F2)    (F1,F2)       (F1)
```

**No slice imports another slice except `worklist → machines`, one way.**

| Slice | Owns |
|---|---|
| **machines** | `reposToViews`, `RepoView`/`WorktreeView`, `repoBranchForCwd`, `isKnownWorktreePath`, `repoUsageAt`, `spawnTargetForRepo`, `resolveDefaultAgent`, `hostMemoryView`/`formatMemBytes`, and the see/use/manage verb publication over `packages/model/src/predicates/machine-selection.ts` |
| **worklist** | `sidebarSections`/`RepoNavView`, unified row construction, banding/ordering/grouping, snoozed + closed folds, `rowStatusLine`/`rowMotionTiming`/`rowWaitingCount`, per-user unread/snooze/pin inputs, `tray.ts` |
| **issues** | `subIssuesOf`, `issueNavList`/`filterIssueNav`, `branchRollup`, the `issuePendingDecision` family, `board-scope.ts` |
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

## 5. What this map commits to

- `derive.ts` is deleted; nothing named `*-helpers` or `*-common` replaces it.
- The import graph above is a DAG and is enforced, not merely intended.
- Single-user parity is the regression guard: one admin owning everything must produce output
  indistinguishable from today's.
