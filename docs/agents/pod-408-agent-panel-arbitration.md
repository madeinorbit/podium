# POD-408 — the AgentPanel's arbitration, named

**Measured at:** `apps/web/src/features/terminal/AgentPanel.tsx`, 1,329 lines, on
`origin/issue/279-integration` at `b120c56d`.

This is the companion to `pod-330-slice-ownership-map.md` for the terminal
panel: POD-330 asked *who owns each derivation*, and this asks the same question
one layer down, of a component whose state machine was never written down.

---

## 1. The states, which nothing named before

The panel decided what to show by RENDER ORDER — one nested ternary — and then
re-spelled the same four booleans at eight other call sites (the mount gate, the
`active` gate, the mode segment, Take control, the offer dock, the dock's resize
effect, the snooze control, the hibernate item). Every one of those was a
hand-written `!hibernated && !exited && …`, and they did not all agree.

There are **four states**, one of which carries a view axis:

| state | when | shows |
|---|---|---|
| `transit` | the session is moving to another machine ([spec:SP-3f7a]) | the handover veil over the pane's own colour |
| `parked` | hibernated — process stopped, conversation intact | transcript + wake banner, or the recovery pane when there is no transcript |
| `ended` | exited — process gone | transcript + exit banner, or the recovery pane |
| `live` | everything else, INCLUDING a not-yet-reconciled optimistic spawn | the terminal, with chat overlaid when the view is `chat` |

`parked` and `ended` each split on `chatCapable` into `transcript` / `recovery`;
`live` splits on the panel mode into `chat` / `native`. Seven leaves.

**Precedence is a rule, not an accident.** A move STOPS the process, so a moving
session is also briefly a parked one. `transit` wins, or the operator watches the
pane fall through every read-only state on the way. In the ternary that rule was
expressed by which branch happened to be written first.

## 2. The transitions

| edge | what it does | had a test before? |
|---|---|---|
| mount → arbitrated | writes the derived mode back to the store, which is what `reactions.reportViewState` reads to tell the server which sessions render native | partly — `the initial active reflects chat mode` |
| `pick(chat\|native)` | persists per-session (#35) and as the per-device default | yes, at the e2e layer (`ui-state-persistence`) |
| `native → chat` | terminal stays MOUNTED, stops being `active` | yes — `warm-toggle: reuses ONE terminal…` |
| `chat → native` | re-arms the one-shot chat→native draft flush | yes — `re-injects a chat-authored draft…` |
| pane shown / hidden | `active` flips; the terminal stays mounted | yes — `calls setActive(false)…` / `(true)…` |
| `live → transit → live` | PTY torn down, veil up, re-attach against the new daemon | the veil, yes (`handover-pane`); **the PTY teardown, no** |
| `live → parked` (hibernate) | **no test** | **no** |
| `parked → live` (resurrect) | rejection-retryable only | one half — `makes a rejected hibernated resume retryable` |
| `live → ended` → recovery | which surface, which verb | **no** |
| pending spawn → confirmed | releases the PTY mount (#119) | **no** |

**The list of edges with no test at all before this issue: hibernate, the
exited-surface choice, the spawn-confirmation mount gate, and the PTY teardown
half of transit.** Every one is now covered — see §5.

And one more the census would have missed, because it is a GATE rather than an
edge: **no test asserted the snooze control's visibility from this header at
all.** It was found by mutation, not by reading — see §5.1.

## 3. Rule 1, both directions

### Published nothing. Consumer count: 1.

`panelSurface` / `panelGates` live in `apps/web/src/features/terminal/`, beside
the only feature that renders them, and **no `SliceDefinition` was added**.

The count is one and it is not close to two: `apps/mobile` renders no equivalent
panel (`grep 'hibernated'` across `apps/mobile/src` finds one demo-data literal
and nothing else), and the arbitration takes per-PANE arguments — `paneActive`,
`spawnConfirmed` — that no store snapshot carries, so it could not be a published
slice keyed on the snapshot even if a second reader appeared. This is POD-409's
answer, for POD-409's reason: a slice with one consumer is the god object behind
a nicer hook.

### Imported rather than re-derived. Two derivations, counts 2 and 3.

| derivation | where it already lived | consumers | what the panel did before |
|---|---|---|---|
| `effectivePanelMode` | client-core `ui-state.ts` | the panel + the engine's `reportViewState` (via `st.panelMode`) | already imported it — unchanged |
| `sessionMenuEligibility().canHibernate` | `apps/web/src/lib/SessionContextMenu.tsx` | `SessionContextMenu`, `CommandPalette` | **re-derived it, wrongly** |

The panel's own copy read `!hibernated && !exited && resumable === true`. The
shared rule reads `status === 'live' && resumable && !working`. The two disagree
on `starting` and `reconnecting`: the panel offered Hibernate on a session whose
process does not exist yet, where the shared rule — and the server — say no.
`lifecycle-actions.ts` now imports the shared predicate and the divergence is
gone; `hibernateAction` adds only the ONE thing the panel legitimately needs and
the menu does not, which is to OFFER the action mid-turn and say why it is
blocked, where a menu simply hides what you cannot do now.

> A re-derivation is not caught by asking whether the numbers match today. It is
> caught by asking which module OWNS the question — and then reading both
> answers side by side.

## 4. The visibility foundation, and the one correctness change

`viewState` is where the client tells the server which sessions it is rendering.
`PanelDeck` `display:none`s every panel that is not the visible pane, and the
engine derives viewState `visible` from the same pane selection. So a warm hidden
panel is mounted, attached, and **measures zero height**.

The dock's open/close ran a `fit()` + `sendResize()` gated only on
`effectiveMode !== 'native'`. An offer arriving on a warm HIDDEN panel therefore
pinned a zero-height surface, fitted the PTY against it, and sent the resulting
grid to a live agent nobody was looking at.

All PTY-size operations now hang off `gates.ptySizingAllowed`, which requires
`paneActive` — the same flag viewState is derived from. The dock still opens on a
hidden panel (un-animated, exactly as it already did under reduced-motion); only
the sizing is withheld, and the ResizeObserver fits correctly when the pane
becomes visible.

**This is a resize-correctness change, so it has tests and not only a click:**
`REFUSES PTY sizing on a warm but hidden pane` (pure) and `does NOT winch the PTY
when the offer docks on a warm HIDDEN pane` (rendered, asserting on `fit` /
`sendResize` spies).

One smaller alignment came with it: the offer dock's target used to ignore
`inTransit` (it checked mode + hibernated + exited only), so a move left the dock
target flipped underneath the veil. `offerDockOffered` derives from the surface,
so transit excludes it by construction.

## 5. Mutation results

Ten mutants, one at a time, each asserted APPLIED (exact-count guard, then
grepped back) and each reverted by copying back a byte-verified snapshot with
`md5sum -c` plus a grep for the mutant string returning rc=1. Lane:
`apps/web src/features/terminal` (12 files / 102 tests).

| # | mutant | result |
|---|---|---|
| M1 | `terminalMounted: live && spawnConfirmed` → `live` | **killed ×2** — `holds the mount back until an optimistic spawn reconciles (#119)`, `holds the terminal mount until an optimistic spawn reconciles (#119)` |
| M2 | `terminalActive: active` → `live` | **killed ×7** — incl. `warm-toggle: reuses ONE terminal across a native->chat->native cycle`, `the initial active reflects chat mode…` |
| M3 | `ptySizingAllowed: active` → `native` (the pre-POD-408 rule) | **killed ×2** — `REFUSES PTY sizing on a warm but hidden pane`, `does NOT winch the PTY when the offer docks on a warm HIDDEN pane` |
| M4 | the chat→native edge never fires `onEnterNative` | **killed ×1** — `re-injects a chat-authored draft into the native composer on a later chat→native toggle` |
| M5 | a refused wake stays stuck busy (`setBusy(false)` → `true` on reject) | **killed ×2** — `wakes a parked session from the banner and stays retryable when refused`, `makes a rejected hibernated resume retryable` |
| M6 | `transit` no longer wins precedence over `parked`/`ended` | **killed ×2** — `lets the move win over the read-only state it passes through`, `covers the pane while the session is in flight, instead of the parked transcript` |
| M7 | hibernate eligibility back to the panel's old local rule | **killed ×2** — `does not offer it before the process exists — the divergence this replaced`, `does not offer Hibernate before the process exists` |
| M8 | `takeControlOffered: native` → `live` | **killed ×1** — `offers Take control and the offer dock only where a native PTY is on screen` (pure only; see below) |
| M9 | `showSnooze`'s surface gate → `true` | **SILENT** → see §5.1 |
| M10 | the flush never types the draft (`sendInput(want)` removed) | **killed ×1** — the draft-flush test, through the EXTRACTED `draft-sync.ts` |
| M11 | `rearm()` no longer resets the one-shot guard | **killed ×1** — same test |

M4, M6, M10 and M11 are the ones that matter for the refactor's honesty: each
targets what a DELETED inline branch used to produce, and each is killed by a
test that existed BEFORE this issue. The old contracts still hold through the new
path; the old code did not take its coverage with it.

M8's kill came only from the new pure test — nothing asserts at the RENDERED
layer that Take control disappears in chat mode. Recorded rather than papered
over.

### 5.1 M9 — the silent mutant, and which of the three it was

Narrowing `showSnooze` from `!hibernated && !exited` to `surface.kind === 'live'`
was **silent across all 102 tests**. Per the three meanings: a `throw` on the same
line reddened **24 named tests** (the whole of `agent-panel-arbitration`,
`agent-panel-active` and `handover-pane`), so the line is entered constantly.

That makes it an **assertion gap**, not dead code and not an equivalence — and the
untested behaviour is a real change: the narrowing also excludes `transit`, so the
panel no longer offers Snooze over the handover veil, where before it did. Three
tests were added (`offers snooze for a live, non-working session`, `withholds
snooze from a parked or ended session`, `withholds snooze while the session is in
transit`), each fixture explicitly `phase: 'idle'` so "no snooze" cannot pass for
the wrong reason. Re-running M9 against them kills it (×2).

## 6. What the file split cost and bought

| file | lines | question it answers |
|---|---|---|
| `AgentPanel.tsx` | 1,329 → **941** | what does this panel RENDER |
| `panel-surface.ts` | 151 | which of four states is this panel in, and what may it do |
| `use-panel-surface.ts` | 142 | what happens on each transition |
| `lifecycle-actions.ts` | 135 | what is the way back, and what is it called |
| `SessionLifecyclePanes.tsx` | 193 | the four read-only surfaces, rendered from a descriptor |
| `draft-sync.ts` | 182 | how do the PTY composer and the chat draft stay in sync |

941 is still well over any 400-line budget, and the split was by QUESTION rather
than by size — the remaining bulk is the header's JSX (~230 lines) and the live
body's (~170), which is presentation with no second question in it. Splitting
those would produce two files sharing one decision, which is the failure POD-330
§0 recorded.

The duplication that went: waking a session was written FOUR times, each with its
own `useState`, its own `.then(ok, err)` pair and its own label ladder. It is one
`useLifecycleRunner` now, and the mutant that breaks the rejection path (M5) is
killed by tests from BOTH the old and the new suite — which is the evidence that
the four copies really were one rule.
