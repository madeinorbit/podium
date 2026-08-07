# POD-516 — conformance spec

Extracted verbatim from the approved artifact
`POD-491-operator-workspace-final.html` (its inner prototype and its doctrine
sections), plus the four corrections the human raised after clicking the preview.

This file is the target. Where this file and anyone's memory of the design
disagree, this file wins. Where this file and the artifact disagree, the
artifact wins — go read it.

Artifact path:
`/home/podium/podium/.worktrees/issue-491-multi-agent-operator-workspace/.design/POD-491-operator-workspace-final.html`

## 0. Standing constraints (from the POD-516 brief — still in force)

- Reuse today's Podium shell. The artifact's outer documentation chrome is NOT
  the product; only its inner prototype is.
- Keep: current sidebar design, centre tabs/content, right-rail chrome, the
  recent density/font/spacing rework, resizable columns, warm panel behaviour,
  canonical icons.
- No decorative coloured/rounded outline cards. No AI-slop borders.
- **Do NOT add the prototype's named phase pixels** (`.phase-pulse` /
  `.phase-pixel`). They exist in the artifact and are explicitly excluded.
- Stay in UI + client-derived selectors. No stored aggregates, no embedded
  session objects on issues.
- Do not add: archived state history, native-child transcript deep links,
  mission-scoped concierge ownership. All three are deferred in the artifact's
  own architecture ledger.

## 1. The human's four corrections

These are the reason this pass exists. Each is a defect against the artifact,
not a new request.

### 1.1 Column 1 still shows nested, foldable children — it must be flat

The artifact's `workRow` / `renderWork` build a **flat list of mission roots**
and nothing else. There is no recursion, no child list, no per-row disclosure
twist, no session rows.

The complete column-1 contents, in order:

1. Collapse button + folded rail label ("Tasks").
2. The "New Codex in <repo>" primary button.
3. Repo label.
4. `worklist` — one `work-row` **per mission root**, flat.
5. Exactly two fold rows at the bottom: `▸ Proposed <n>` and `▸ Closed <n>`.
   **These two group headers are the only foldable things in column 1.**
6. Footer icons.

`work-row` anatomy:

- `id-square` — colour-tinted ref chip; ref split as `<small>POD</small>516`;
  `draft` variant; literal `NEW` for the draft vessel.
- `work-main`
  - `work-title-line` — the title, plus a `need-pill` reading `Needs you` (1)
    or `N need you` (n) when the mission's subtree has attention.
  - `fleet-copy` — one short state line.
  - (phase pixels would go here in the artifact — **omitted by the brief**)
- `fleet-summary` — `fleet-stack` of **real harness-kind icons**, then
  `fleet-total` when total > 1, then `native-count` `×N` when the mission has
  native children. Tooltip: "N live agents · M native children".
- Row classes: `selected`, `attention`, `has-fleet`.

Not present, at all: subtasks, sessions, native subagents, per-entry folds.

### 1.2 The Superagent pane is only the superagent — remove the tray entirely

The artifact's `super` dock-view contains exactly four things:

- `dock-top` — `✦ Superagent` label + close chevron.
- `super-head` — star, `Portfolio copilot`, "One thread across every task and
  session."
- `super-feed` — messages; one of them is `Current focus` naming the currently
  inspected mission (`#super-focus`).
- `super-compose` — "Ask across all tasks…".

Remove tray functionality completely: code, UI, and traces. Two hard rules
while doing it:

- Do not remove anything the tray merely *shares* with a live surface. Every
  deletion must be justified by "nothing else reaches this".
- The right rail keeps its tabs (`Task`, `Superagent` + badge, `Git`, `Files`,
  `Tools`, `Messages`). Removing the tray must not disturb the rail.

### 1.3 The Task view was not recomposed

Target: **one single scroll**, in this order.

`inspect-head` (fixed, above the scroll):
- `inspect-id` — stage glyph + ref + `TASK` scope chip
- `inspect-title` — the title
- `inspect-desc` — the description
- `task-controls` — stage dropdown button (glyph + stage word + `⌄`), one
  primary action button, `•••`
  - primary action resolves: needs-you → `Answer` (or `Mark done` on a handed-
    off origin); else active sessions → `Open coordinator`; else → `Start work`
  - the needs-you variant carries the `warn` treatment

`decision-band` — only when the issue needs you: bold `Needs you` + one line
saying what the decision is.

`inspect-scroll`:
1. **Current update** — author harness tile + "Current · <session> · <age>" +
   the update text; then `subtree-meter`: segmented done/run bar + "N of M
   done".
2. **Work `<n>`** — only when the issue has children. Open children as unified
   rows, then `› Show N completed` for done children.
3. **Agents & sessions `<n>`** — up to 5 `session-row`s (harness tile, name,
   phase). Overflow → `› N more active`. Retired → `› Retired · N`. When there
   are none, a presence note instead: moved → "Session moved to X", otherwise
   "▷ Ready to start".
4. **Relations**.
5. **Evidence & checks** — only when the issue actually has them.
6. **Recent activity `5`** — five existing comment/event items, then
   `Open full activity ↗`.
7. Footnote.

Sessionless / fresh-agent dock (no inspected issue): `inspect-id` reads
`LIVE SESSION · READY`, title "Conversation workspace", then a **Taking shape**
section with three `intake-field`s (Task / Plan / Team, the first in `loading`),
then the footnote "Podium does not force a task." **Never** show missing-task
error copy and never force task creation.

### 1.4 The Flight Deck hierarchy is inverted — sessions attach to issues

Doctrine, quoted from the artifact:

> Issues hold the operator's place. Sessions and native workers attach to their
> owning issue. … A session is shown directly beneath the issue it belongs to;
> its spawn parent and native workers are secondary details, **not a competing
> navigation tree**.

So the only legal nesting is:

```
issue-branch
  issue-line                 (twist, stage glyph, ref + title, state/collapsed payload)
  agent-band                 ← one per SESSION owned by this issue
    agent-line[data-session] (harness tile, name + small role label, state + time)
    native-list              ← native subagents of THAT session
      native-row             (harness svg, "type · id", working/waiting)
  relation-note              ("↳ …")
  issue-children             ← recursion into child ISSUES
```

An agent must never parent a session. Spawn parentage is not the tree.
A native subagent hangs off its parent session; clicking it focuses the parent
session (no direct child transcript).

**Where the defect actually is.** An audit found `FlightDeck.tsx` and
`mission.ts` already obey this: `mission.ts:275-282` hangs
`sessions: sessionsByIssue.get(id)` off each **issue**, `FlightDeck.tsx:273-282`
renders those session rows flat under the task strip, and `FlightDeck.tsx:183`
puts `NativeRows` inside each `SessionRow`. Do **not** rewrite them.

The forbidden construct the operator saw is in **column 1**:
`UnifiedIssueRow.tsx:313-325` renders a band literally labelled `Agents · N`,
and `sidebar-common.tsx:313` (`groupSessionsByParent`) nests the sessions inside
it into a spawn-parent tree. Flattening column 1 (§1.1) removes it. Two
secondary Flight Deck facts reinforced the impression and are worth fixing:
child task strips indent by `8 + depth*16`px (`FlightDeck.tsx:222`) while
session rows use a fixed `ml-3` (`:145`), so a depth-1 child renders further
right than its parent's session rows and reads as hanging off them.

## 2. Column 2 — Flight Deck, the rest of it

**`mission-head`** (roomier, larger text than the rows below it):
- `mission-ref` — stage glyph + ref + stage word
- `mission-title` — the title + `brief` reading `done / total`
- `mission-summary` — the mission brief
- `progress-line` — segmented bar `done | run | block | wait` + label
  "N done · M active"

Progress arithmetic, from the artifact: `total` = non-external issues in scope;
`done` = stage done; `run` = in_progress or review; `block` = state blocked;
`wait` = total − done − run − block.

**`filters`** — `Full spine` (default) | `Active` | `Needs you <count>` +
search/display tools. Semantics:
- Full spine — everything; done work **stays in place**.
- Active — hides done work **while preserving its ancestors** as context rows.
- Needs you — exceptions only, each shown **with its path**.
A non-matching issue with matching descendants renders as a `context` row.
These are device-local display state; they never mutate issue stage or agent
state.

**Collapse payload** — a collapsed branch must say what it is hiding, in the
`issue-meta` slot: done/run counts for the subtree, up to two live harness-kind
tiles, and a needs-you flag. Folds are remembered.

**Dependency-specific presence notes** — when an issue has no session, say why:

| condition | note |
|---|---|
| `movedTo` | `→ Session moved to <ref>` |
| state blocked | `⦸ Blocked by <dep>` |
| `waitFor` | `↓ Waiting for <ref> to complete` |
| stage done | `Completed · session retired` |
| stage review | `Review ready · session ended` |
| stage planning/backlog | `▷ Ready to start` |
| stage in_progress, no session | `! Agent left · choose a handoff` — **attention** |

An issue with sessions *and* a `waitFor` still gets the waiting note underneath.
Only vacated in-progress work without a handoff becomes attention.

**Empty flight deck** (no mission root — fresh chat): the intake canvas.
Kicker with the harness tile, "Ready when you are", "The agent will organize
this workspace as you talk.", three `intake-field`s (Task = `loading` /
"Waiting for your first message", Plan, Team), one `agent-line` for the fresh
session, and the hint "Names and rows crossfade into place; no task is
invented." Fresh Codex keeps a normal chat with the composer available.

**State vocabulary** (five agent states, distinct from task stage):

| mark | state | meaning |
|---|---|---|
| spinner | Working | observed live agent phase |
| `⌛` | Next / waiting | not blocked; no action yet |
| `⦸` | Blocked | dependency, not automatically yours |
| `!` | Needs you | amber always has an action |
| `✓` | Done | stays in place in Full spine |

Task stage is a separate channel from agent state and must read as separate.

⚠ The artifact renders this table as a `.legend` block, but that block sits
**outside** `.shell-frame` — it is documentation chrome, not product. Build the
vocabulary into the rows; do **not** ship a legend panel.

## 3. Column 4 — the dock and rail

Two dock views (`task`, `super`) switched by the right rail; each has a
`dock-top` with its label and a close chevron. Rail tabs in order: `#` Task,
`✦` Superagent (with unread badge), Git, Files, Tools, Messages.

## 4. Selection contract (artifact section 03)

- **Column 1 click** — selects the mission root; keeps manual order and tuck
  state.
- **Task or agent click in the spine** — inspects the issue and chooses its
  coordinator/member session when one exists.
- **Session tab click** — selects that exact session and highlights its owning
  issue and its agent row.
- **Task dock** — follows the inspected issue; utilities name their
  session/worktree scope.
- **Mission click fallback order** — coordinator session → lone member → most
  recently active member → no-session task state.
- **Sessionless task click** — inspect it and expose `Run`. Keep the current
  central session; do **not** create a fake tab.
- **Split pane** — use the actually focused pane session. Pane A may be a file
  and is not a safe session identity.

Focus is bidirectional and atomic: one engine action, not scattered setters.

## 5. Scale rules

A 290-agent mission uses the same model — virtualization and remembered branch
folds, **not** summaries that replace the children. Stable parent order; sticky
root context while filtering; descendant attention bubbles up to column 1;
search by task, session, agent or ref; counts describe the visible world only.

## 6. Remaining fidelity gaps found by audit (beyond the human's four)

Verified against the artifact with file:line evidence. `FlightDeck.tsx` and
`mission.ts` are good work against the doctrine — these are fidelity fixes, not
a redo.

**F1 — Deck mode and branch folds are not remembered.** The artifact's ledger
marks "Remembered tree folds and Full / Active / Needs-you view — device-local
display preference" as **required now**. `FlightDeck.tsx:320`
`useState<FlightDeckMode>('full')` and `:321` `useState<ReadonlySet<string>>(new
Set())` both reset on remount. (The *column's* folded state was persisted in
689186ccb; the deck's internal state was not.) POD-540 is building a shared
`usePersistedUiState` hook for exactly this class of bug — use it.

**F2 — Mission progress is filter-dependent and single-segment.**
`mission.ts:136-142` computes `total = rows.length - 1` and `done` over the
**filtered** rows, so `Active` mode (which excludes done work, `:229-233`) reads
`0/N`. The artifact's `progress()` runs over all issues regardless of filter and
emits four segments (done / run / block / wait). `FlightDeck.tsx:39-53` renders
one segment.

**F3 — Collapsed payload is a separate row, not the row's own meta.** Artifact
`collapsedPayload()` renders inline in `.issue-meta`: an `N tasks` chip, a
28px two-tone mini progress bar, stacked agent tiles, attention dot.
`FlightDeck.tsx:253-271` renders a full-width button *below* the strip.

**F4 — Task strips carry no state mark, and ref/title order is inverted.**
Artifact: `sg(stage)` then `issue-label` = `issue-ref` **then** title, then
`issue-meta` = `stateMark(state)` + `state-word`. `FlightDeck.tsx:243-250` puts
glyph, then title, then ref right-aligned, then a word-only state (`:55-87`
documents the omission). The state mark is the only motion cue on a working row.

**F5 — No sessionless presence bands.** The state *coverage* in
`mission.ts:320-340` is good (`Moving`, `Blocked by X`, `Agent retired`,
`Ready to run`) but it is one right-aligned word. The artifact emits an inset
explanatory band per §2's table, plus a `relation-note` (`↳ …`), plus a waiting
note that appears *alongside* live sessions when the issue has a `waitFor`.

**F6 — Deck header controls differ.** Artifact: `Full spine` (not `Full`) /
`Active` / `Needs you` with an amber count, plus a `⌕ · ⋮` search+display
affordance. `FlightDeck.tsx:31-35,431,438-440` labels it `Full`, has no count
(colour only), no search, and puts a `Users` live-count readout there instead.
Mission head is missing the root's stage glyph (`:395-397` prints ref +
lowercase stage word) and the `done / total` brief on the title row.

**F7 — Split-pane selection rule not implemented.** Artifact: "use the actually
focused pane session; pane A may be a file and is not a safe session identity."
`FlightDeck.tsx:294,345,355,449` reads `paneA` unconditionally; `paneB` is never
consulted and no focused-pane concept exists (`grep focusedPane` → 0 hits).

**F8 — Mission-click fallback order altered.** Contract: coordinator → lone
member → most recently active member → no-session state.
`FlightDeck.tsx:353-356` inserts `paneA` as the second preference.

**F9 — Dead branch in the tab→deck link.** `Workspace.tsx:369-373`:
`if (t.session.issueId) { setFocusedIssueId(t.session.issueId ?? missionRoot?.id ?? null) }`
— the fallbacks are unreachable inside their own guard, so a session tab with no
`issueId` leaves deck focus stale instead of falling back to the mission root.

**F10 — Focus resolution uses the filtered row set.** `FlightDeck.tsx:330-334`
resolves focus against `new Set(rows.map(r => r.issue.id))` where `rows` is
already mode-filtered, so switching to `Needs you` can silently move the
highlight (and the Task dock) to the root. `RightDock.tsx:91-94` resolves against
the *unfiltered* `missionIssueIds`, so the two columns can disagree.

**F11 — Column 1 gained something the artifact does not have.** The branch added
a mission progress meter at `UnifiedIssueRow.tsx:467-492`. The artifact's
`work-row` has no progress bar; the subtree progress lives in the Flight Deck's
`mission-head`. (The POD-516 brief asked for "a slim subtree progress bar" in the
sidebar — keep it only if it survives the flat row model without adding a second
progress surface; otherwise drop it and say so.)

## 7. Tray removal — classification (do not re-derive this)

**Delete outright (web Superagent only):**
`features/superagent/Tray.tsx`, `TrayCard.tsx`, `TrayCard.test.ts`;
`lib/motion/motion.css` `.tray-ins` rules; the tray half of
`SuperagentView.tsx` (~200 lines: tray SectionBar, card stack, drag separator,
`onSplitPointerDown`, `trayActions`, `dismissedOffers`, and the now-dead
`prefillComposer` / `focusComposer`); `SectionBar.tsx`'s `CountPill` (its only
consumer is the tray bar).

**Edit, don't delete:** `column-state.ts` (drop `TRAY_OPEN_KEY`,
`TRAY_HEIGHT_KEY`, `TRAY_MIN_HEIGHT`, `TRAY_MAX_HEIGHT_RATIO`, `readTrayHeight`;
**keep** `SUPER_CHAT_OPEN_KEY` and `readSectionOpen`) and its test;
`SuperagentView.test.tsx` (drop tray describes, keep chat/thread);
`SectionBar.tsx` (keep `SectionBar` + `UnreadDot` — the Super-agent bar uses
them); `packages/client-core/src/ui-state.ts:187,189` (drop the two replicated
tray keys); `packages/harness/src/issue-system-pointer.ts:46,59,62` (prompt copy
says offers show "as a card in the Tray" — mobile's Tray survives, so this
becomes half-true; adjust the wording).

**Move, do not delete:** `features/superagent/derive-tray.test.ts` tests
`deriveTrayItems`, which lives in **client-core** and survives. Relocate the test
to `packages/client-core` or the coverage is lost.

**KEEP — removing these breaks something:**
`packages/client-core/src/viewmodels/tray.ts` and its `index.ts:40` re-export
(`apps/mobile` TrayScreen / SessionScreen / its own TrayCard all import it, and
mobile is explicitly out of scope); `--radius-tray` in `index.css:112` and
`rounded-tray` in `lib/menu-surface.ts:19` (a *radius scale name* used by every
popover and menu surface, not the Tray feature);
`apps/server/src/modules/files/path-search.test.ts` (uses `SuperagentView.tsx` as
a path fixture — breaks only if that file is renamed).

**The rail badge is a decision, not a deletion.** `RightRail.tsx:5,55,129-131`
sources the Superagent badge from `trayCount`. The artifact *does* want a badge
there (`<span class="rail-badge">2</span>`), and the superagent copy explains it:
"Two tasks across your portfolio need a decision." So keep the badge and
re-source the number from the portfolio actionable count — do not drop it.

**Comment-only traces** (no runtime effect, clean them for the "traces" ask):
`index.css:44,46,109,608,611,628`; `styles.css:545`; `components/IdSquare.tsx:72`;
`lib/issueColors.ts:86,88`; `app/theme-tokens.test.ts:83`; and the doc comments
naming "the Tray's answer chips" in `packages/model/src/fields/issue.ts:280`,
`packages/model/src/entities/issue.ts:236`,
`packages/commands/src/issues/contracts.ts:390`,
`packages/issue-client/src/commands.ts:1191` (the `suggestedAnswers` data stays).

Ignore `derive-issue-nav.test.ts:178` (`id: 'stray'`) — homonym.
