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

## 6. Size

**`SidebarUnified.tsx` went 2,296 → 2,313. It got BIGGER, by 17 lines.**

Stating that plainly because the epic frames size as a review signal and it would be easy to quote
the three new modules (330 lines, 194 of them non-comment) as if they had come out of the total. They
did not, on net. What actually happened:

- the menu and rename bodies left (~90 lines);
- the multi-user contract items came in — machine views and the gated spawn resolution, the evict
  effect with its seen-latch, and the reasoning comments each carries.

So the extraction is real but the file is not smaller, and this is **nowhere near** the parent's
~400-line target. The reason it is not is structural rather than effort: the bulk of the file is row
RENDERING — `WorkRowShell` (~400), `UnifiedIssueRow` (~350), `WorkSections` (~390) — and none of that
is the menu/rename structure this issue was scoped to extract. Decomposing those is the work that
would actually move the number, it is not claimed here, and it should be scoped on its own rather
than smuggled into a behaviour-parity issue.
