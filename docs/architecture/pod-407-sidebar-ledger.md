# POD-407 — SidebarUnified onto the worklist slice: ledger

**Base:** `434e4318` · **Scope:** `apps/web/src/features/worklist/**` plus the machines and worklist
slices it reads.

This records what shipped, what deliberately did NOT ship, and which decisions were handed forward
still open. It is the "record what shipped" half of the brief's §3.1.2 obligation.

---

## 1. The existence-leak question: what shipped

`docs/multi-user-readiness.md` §3.1.2 lists *"this worktree is in use"* among the named-but-undecided
existence leaks, and the brief asks for a worktree-in-use marker that **can be suppressed**, with the
shipped choice recorded here.

**Shipped: no marker. The surface has none, and none was added.**

The flag exists on the wire — `GitWorktreeWire.locked`, carrying its own comment that it is *"ON THE
§3.1.2 OPEN BOUNDARY"* — and is rendered **nowhere in `apps/web`** (verified by grep over
`apps/web/src`, and it is absent from `packages/client-core/src/viewmodels` too). So there is nothing
to suppress: the sidebar leaks no worktree-occupancy fact today.

This is deliberate rather than an omission. Building a marker in order to make it suppressible would
have **added** an existence leak to a surface that does not have one, on a question the human record
explicitly leaves open. The suppressible-by-construction requirement is satisfied in the strongest
available form — the affordance does not exist, so its default is off, and whoever decides §3.1.2
gets to choose without first having to unpick a shipped behaviour.

**Handed forward:** if a marker is ever wanted, `locked` is the field, and the decision it needs is
§3.1.2's, not a rendering one.

## 2. Machine `use`: the placement surface now fails closed

| Before | After |
|---|---|
| `resolveTargetMachine` (gates on `online` only) | `resolveSpawnTargetMachine` (gates on `use` **before** the pick) |
| Submenu disabled rows on `!online` alone | Three states: `available` / `unreachable` / `unauthorized` |
| Unauthorized indistinguishable from offline | Distinct icon, label (`no access` vs `offline`) and title |

`packages/model`'s `resolveTargetMachine` is **unchanged**. It is documented as a pure lookup whose
gate is applied to the candidate set before it, and `resolveSpawnTargetMachine`
(`viewmodels/slices/machines/authority.ts`, POD-330) is that gate. The AC's "never selects a machine
the principal lacks USE on" is met by calling the gated resolver, which is the design its own header
prescribes — not by adding a second, weaker check inside the pure predicate.

**Parity hinge.** `MachineWire.use` is optional and omission means NOT EVALUATED. The per-LIST
reading — scoping engages only when *some* machine in the list carries a decision — moved out of the
automations composer into `machineViewsFromWire` so both surfaces share one spelling. Two spellings
of "may I run here" is how one surface comes to offer what another refuses.

**Deliberate non-parity:** an `unauthorized` refusal now **stops** a spawn that previously fell
through to the repo's primary checkout. `no-repo` and `unreachable` still fall through exactly as
before, which is what keeps single-machine deployments unchanged.

## 3. Per-user state: already correct, now held there

Unread, snooze, pins and tuck are **already** per-user replicated server-side (POD-1076): `readAt`
and `pinned` on `IssueWire`, `readAt`/`unread` on `SessionMeta`, `tuckedAt` read straight off the
row. The component keeps no local mirror and touches no storage directly — `markIssueRead` /
`markSessionRead` / `setIssueTucked` are commands.

The one thing that was **unheld** rather than wrong: the fold keys. `useCollapsed` routes through
`Store.uiState`, which decides device-local vs per-user-replicated **by key spelling**
(`layoutKeyFromLegacy` maps `podium:sidebar:<name>` → `sidebar.section.<name>`). A rename would keep
every test green, keep the UI working on one machine, and silently drop the state out of the per-user
family. The keys now have one home (`fold-keys.ts`) and a test asserting the routing, probed to
confirm it discriminates a plausible rename.

**No parity test needed updating.** The brief anticipated that per-user replication would change
semantics and require deliberate test updates; it did not, because the replication had already landed
upstream and the sidebar was already reading it.

## 4. The shared clock — correcting a recorded count

POD-331 published that `Store.coarseNow` replaced "eleven per-component `useNow(60_000)` intervals".
It replaced **three**. Seven remained in `apps/web`, two of them in this surface. Of those two:

- `sidebar-common.tsx` `PanelRow` — **moved onto `coarseNow`.** Not mainly for the timer count: the
  slice orders and folds these same sessions against `coarseNow`, so a row deciding its own snooze
  state on a separately phased clock could paint "snoozed" for up to a minute after the slice had
  lapsed it and reordered. A row and its placement must not be able to disagree.
- `time-indicators.tsx` `WorkingTimer` — **left alone, deliberately.** It ticks per second below an
  hour and owns its interval so the second-hand never re-renders the sidebar. `coarseNow` is
  minute-granularity; moving it would break the display it exists to drive.

## 5. Deferred / handed forward

| Item | Where |
|---|---|
| Session rows showing the actor + on-behalf-of pair (AC 6) | **POD-1516** — `SessionMeta` carries no attribution field; the wire must land first |
| Server-side scoping of the repo broadcast | Noted in `machine-scope.ts`; the client bound is a rendering bound, not a security boundary |
| Worktree-in-use marker | §1 above — open on §3.1.2, nothing shipped |
| `lint:shadowing` false positive on function overloads | **POD-1521** — pre-existing, red on a clean tree |
| `unified-sidebar.browser.e2e.ts` expects "New issue", UI says "New task…" | **POD-1523** — pre-existing label drift |

## 6. Size — the decomposition half

| | lines |
|---|---|
| `SidebarUnified.tsx` at the drift audit | ~1,092 |
| at this issue's base (`434e4318`) | 2,296 |
| after the contract commit | 2,313 (**bigger**) |
| **after the decomposition commit** | **464** |

The first commit closed the multi-user contract items and left the file larger
than it found it; that was reported as such rather than dressed up. This is the
half the acceptance criteria gate on.

Nine modules, all moved **verbatim** — no logic rewritten, and no props
interface restated (`audit:rearch` rejects hand-declared session field lists;
the rows read `SessionMeta` and the nav models from their existing homes):

| module | lines | what |
|---|---|---|
| `UnifiedIssueRow.tsx` | 496 | the issue row, fleet summary, lineage flash |
| `WorkRowShell.tsx` | 436 | row chrome: notch, tint channel, grip, label block |
| `spawn-row.tsx` | 339 | `useDefaultSpawn` + `NewWorkRow` + `AppToolsRow` |
| `work-folds.tsx` | 330 | section labels, snoozed/closed folds, placement types |
| `use-unified-work.ts` | 279 | rows + selection actions (shared with the rail) |
| `NewAgentMenu.tsx` | 221 | the agent→repo→machine submenu |
| `UnifiedWorktreeRow.tsx` | 97 | worktree row + orphan provenance |
| `use-inline-rename.ts` | 70 | the rename lifecycle and its commit policy |
| `fold-keys.ts` / `derivation.ts` / `agent-icon.ts` | 82 | shared seams |

`derivation.ts` exists because THREE surfaces read the slice — sidebar, rail and
work hook — and leaving the type inside one of them meant the other two
importing it from a consumer, which is how an import cycle starts. `agent-icon.ts`
is the same shape for one function.

Removed on the way through: dead store reads the file's size had been hiding —
unused `repos`/`pins` selector fields in two hooks, a dead `useReplicaIssues()`
subscription, and an unused `repoNavs`. Fewer subscriptions, no behaviour change.

## 7. Runtime verification

`tests/e2e/browser/sidebar-rename-spawn.browser.e2e.ts` — green twice in a row
on chromium-desktop. It real-clicks the two flows the extraction moved: the
inline rename (no-op blur writes nothing, then edit + Enter, **polling the
server** rather than trusting the repaint) and the new-agent submenu's
availability states.

Three findings from getting there, recorded because each cost time:

1. `issues.create` lands in `backlog`, and the sidebar is the ACTIVE work list —
   a backlog row renders on the Tasks board and deliberately not in the aside.
   The fixture moves the stage; the empty aside was not a broken sidebar.
2. Before believing that, the repo-scoping pass from §1 was A/B'd by forcing
   `reposVisibleOnMachines` to pass through: the aside was byte-identical, so
   the filter was not the cause. Probe reverted and the file confirmed clean.
3. The no-op and rename checks began as two specs; the second passed alone and
   failed when run after the first — an ordering dependence on leftover sidebar
   rows that would have read as a flake forever. They are now one spec over one
   row, which is also the stronger assertion.
