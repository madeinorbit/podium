# Task workspace — design audit and rebuild plan

**Method:** ⚠️ DEGRADED: single-context — this session is instructed not to spawn sub-agents, so
Assessment A (design review) and Assessment B (detector + browser evidence) ran sequentially in
one context rather than as two isolated agents.

**Surfaces:** the Tasks kanban board (`IssuesKanban.tsx`, `IssuesView.tsx`) and the task detail
page (`IssuePage.tsx` + `issue-page/*`). Task peek, sidebar and workspace columns are explicitly
out of scope.

**Evidence:** live instance at `:18787` (POD-516, the richest task on the board — 15 sessions, 26
artifacts, 19 todos, 4 spin-offs), captured at 1600×1000 @2×. Mechanical scan:
`detect.mjs` over `apps/web/src/features/issues/` — 46 findings, all `design-system-font-size`
advisories for 13px. Mode: **Operate**.

---

## Design health

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of system status | 2 | The board shows agent liveness as a bare dot+count; the detail page shows *less* live state than the sidebar row for the same task — no branch, no ahead/behind, no uncommitted count, no timer. |
| 2 | Match system / real world | 2 | `Published by 1a1766e3-b8d0-…` renders a full uuid on exactly the dense row `AttributionPair`'s own `compact` mode exists for. Activity events read `read` — a machine kind name with its prefix stripped. |
| 3 | User control and freedom | 3 | Esc → board, inline edit escape, undo-by-re-edit. No undo for a drag that changed stage. |
| 4 | Consistency and standards | 2 | Timestamps are relative in mail/comments and raw ISO-8601 in the event feed. Card badges are pills, aside labels are pills, status strip is pills — three pill vocabularies. Native `<input type=date>` sits beside custom `PropertyMenu` triggers. |
| 5 | Error prevention | 3 | Bulk delete confirms and names the session count. Drag has no drop preview, so the only feedback that you hit the wrong column is the card arriving there. |
| 6 | Recognition rather than recall | 2 | Shift-click multi-select and the `s/p/a/l` property hotkeys are undiscoverable. No keyboard hint anywhere on the board. |
| 7 | Flexibility and efficiency | 3 | Genuinely good: j/k/arrows, `c`, `x`, `Enter`, bulk bar, context menu. Held back by "Show 25 more tasks" instead of windowed scroll on a 140-card column. |
| 8 | Aesthetic and minimalist design | 1 | The card's metadata row is an unranked wrapping bag of up to 12 atoms. The activity feed is 30+ consecutive `read` lines. Three buttons under all 140 proposal cards. |
| 9 | Error recovery | 2 | Errors surface as a bare toast strip pinned under the page; no recovery action, no retry. |
| 10 | Help and documentation | 2 | Only the parent-scope hint in the aside. No empty-state teaching, no shortcut surface. |
| **Total** | | **22/40** | **Acceptable — significant work needed** |

## Design specificity

**The board could belong to any tracker.** Grey rounded column boxes, bordered white-ish cards, a
wrapping badge row: that is the default Trello/Jira/GitHub Projects composition. Podium's own
signature — the issue-color tint channel, the braille spinner, the carved elevation, the mono
machine voice — appears on the board *nowhere*. The one place brand color does appear is
`hover:border-primary/60`, which puts Superade Yellow on every card the mouse passes over. That
inverts The Signal Rule: the brand's one job is to mark what is asking for you, and hovering asks
nothing.

**The detail page is more specific but under-built.** It knows things no generic tracker knows —
15 agent sessions, agent-published todos and artifacts, mail between agents, spin-off provenance —
and renders almost all of it as unstyled text lists. The richest data in the product gets the
plainest treatment on the page.

**Deterministic scan:** 46 `design-system-font-size` advisories, all 13px, across 12 files. These
are *not* false positives in aggregate even though 13px is a legal Reading Tier step: the detail
page half-adopted the Reading Tier (13px prose) while keeping a 22px title that is on no ramp at
all, and the board sits at 13px where the shell's own density is 12px. The finding is real; it is
"the ladder was never finished", not "13px is wrong".

## What works

- **The keyboard model.** `j/k`, arrows across columns, `x` to select, `Enter` to open, `c` to
  create, and property menus on `s/p/a/l` — with a pure reducer (`issues-keys.ts`) that drops ids
  which vanished from the visual order. That is better than most trackers ship.
- **The composition discipline.** Tasks' controls live in the command bar's dynamic centre instead
  of in per-view bars, and the page has no H1 restating the mode tab. Both are correct calls that
  bought real vertical budget.
- **Progressive rendering with a required-id escape hatch** — focus and selection force their card
  into the rendered window, so keyboard nav never lands on an unrendered row.

---

## Priority issues

### [P0] The activity feed is an unfiltered event dump with raw ISO timestamps
Thirty-plus consecutive rows reading `read`, each stamped `2026-08-07T20:21:24.588Z`. Two defects
compound: `formatIssueEvent`'s `default:` branch turns any unrecognised kind into a one-word line
(`issue.read` → "read"), and `buildActivityFeed` passes the ISO string straight through as `ts`
while `ActivityEvent` prints it verbatim — the same page uses `relativeTime` for mail and comments.
The result buries every real transition and every comment.
*Fix:* allowlist the kinds worth a line; roll consecutive low-value events into one expandable
summary; `relativeTime` with the ISO on `title`; day dividers; comments visually dominant.

### [P1] The card's metadata row is an unranked bag
Up to twelve atoms — priority, Deleted, Epic, type, three labels, `+N`, `2/6`, live dot, per-stage
chips, blocked flag, blocking flag, needs-human, due, estimate, `▣ 5` — wrap across two or three
lines in arbitrary order. Card heights vary unpredictably, so the column cannot be scanned.
*Fix:* a fixed three-slot grammar (ref+priority+avatars+age / title / one state line that never
wraps), state line present only when the task has state, overflow to `+N`.

### [P1] The detail page shows less than the sidebar row for the same task
The sidebar says `41 commits ahead · 2 uncommitted · 15 agents · 12h ago`. The page's Git block is
three buttons and no state at all; its session block is fifteen plain-text titles. The operator has
to leave the task's own page to find out where the task stands.
*Fix:* a carved "Now" block at the top — live agents with phase and timer, the worktree path,
ahead/behind/uncommitted — plus a GitStamp in the context bar.

### [P1] Yellow is spent on hover, and withheld where attention is asked
`hover:border-primary/60` on every card; a permanent yellow **FF-only merge** button in the aside
of every task whether or not it can merge; a 2px `ring-primary/50` on the drag-over column. Mean-
while "needs you" is a 12px amber `CircleUser` icon among eleven other atoms.
*Fix:* hover is a tonal wash and issue-tint step. Yellow goes to needs-you, to Approve, and to a
merge button only when the branch is actually mergeable.

### [P2] Drag and drop has no drop feedback, and the aside clips its own content
Native HTML5 DnD with no insertion line, no lifted proxy, no reflow — the card teleports. The aside
is a fixed 280px with no ellipsis: `POD-540 · Bug: replicated UI layou` and
`iss_16876518-c5cc-45d7-b472-070b` run off the edge. (The bare id itself is CORRECT — it is
`issue-edges.tsx`'s documented `pending` fallback for a referent this replica cannot resolve, and
inventing a `POD-` ref for it is exactly what that module forbids. The defect is only that it
never truncates.)
*Fix:* pointer-based drag with a proxy, an issue-colored insertion line, an opening gap and a
180ms settle. Truncate with ellipsis; resolve every edge to its display ref.

---

## Persona red flags

**Alex (power user, 8 agents running).** Cannot see from the board which of his tasks is blocked on
*him* versus blocked on a dependency — both render as a small flag glyph. Has to open each
in-progress task to learn whether its branch is mergeable. Hits "Show 25 more tasks" four times to
reach the bottom of Proposed. His shift-click selection works but nothing on screen ever told him
it existed.

**Sam (keyboard + screen reader).** Every card is a `<button>` containing a second interactive
`role="button"` span for the assignee menu — the source comments acknowledge the invalid nesting
they worked around. Blocked/blocking are distinguished only by flag *color* (orange vs red), which
is meaning by color alone. The activity feed's 30 identical "read" rows are 30 identical
announcements.

**Riley (edge cases).** Opens the epic with 15 sessions and 26 artifacts: the page renders all of
them, the aside clips, and the comment box is six thousand pixels down. Opens a brand-new task: the
same page renders eight empty property rows, two native date pickers and a Defer button that does
nothing yet.

---

## The rebuild list

Ordered by impact. B = board, D = detail, S = shared.

### Correctness — these are bugs, not taste
1. **D** Activity events: `relativeTime` instead of raw ISO, ISO on `title`.
2. **D** Activity events: allowlist meaningful kinds; roll consecutive low-value events into one
   expandable line; never surface a de-prefixed kind name as prose.
3. **D** The `pending` edge fallback truncates instead of overflowing; full id stays in `title`.
4. **D** The publisher attribution row passes `compact`, so the uuid stops evicting the human half.
5. **D** Every rail row truncates with ellipsis; nothing clips silently.
6. **S** Card is a single interactive element; the assignee menu moves out of the card button.

### Board
7. Fixed three-slot card grammar; state line only when there is state; overflow to `+N`.
8. Issue-color tint on every card via the existing `issue-mix-*` channel (Tint, Never Fill).
9. Columns lose their grey boxes: hairline seams, headers on the 36px section datum, carved.
10. Hover = tonal wash, not a yellow border. Drop target = tint wash, not a yellow ring.
11. Pointer drag: lifted proxy, insertion line, opening gap, 180ms settle, `prefers-reduced-motion`
    respected.
12. Hover-revealed selection checkbox in the ref's slot; bulk bar rises from the bottom.
13. Proposal actions move to hover overlay (no reflow) + the existing bulk bar; Approve is the one
    yellow control.
14. Windowed rendering replaces "Show 25 more tasks".
15. Column header carries a stage-pressure hairline (per-card issue color, live cards brighter).
16. Empty column teaches: one line plus a `＋ New task` affordance.
17. A discoverable shortcut surface (`?` sheet or a status-strip hint).

### Detail
18. The **Now** block: live agents with phase + timer, worktree path, ahead/behind/uncommitted.
19. Context bar carries live state: needs-you, working count, GitStamp; breadcrumb shows the real
    parent chain.
20. Dossier line replaces the chip strip — ordinary facts as mono text, only exceptions
    (agent-created, draft, internal, hub·stale) earn a chip.
21. One section ladder for Description / Brief / Design / Acceptance / Notes with mono eyebrows.
22. Todos: keep the meter, cap the open list, fold completed under one "N done".
23. Artifacts become a single-shape horizontal filmstrip; images and docs share one card height.
24. Subtasks get the board's state-line grammar so the operator learns one language.
25. Relations render as ref-first chips, grouped by edge kind.
26. Composer pins to the bottom of the main column.
27. Rail ranked: status/priority/assignee → sessions → branch → **More fields** disclosure for the
    empty long tail. Native date inputs replaced with the app's own popover.
28. Sessions block gets harness avatar, live state and timer — it is the most Podium-specific data
    on the page and currently the plainest.
29. Rail folds to a 44px bar like the shell's other columns.
30. Title takes a documented type step (18px/600) — and **DESIGN.md gains that step**, rather than
    the page keeping an undocumented 22px.

### Desktop-app feel (shared)
31. `:focus-visible` rings only; no focus ring on mouse interaction.
32. No text selection on chrome; real pointer cursors; overscroll containment per column.
33. One-shot morphs on stage change (150–400ms ease-out) then stillness; the braille spinner stays
    the only perpetual motion.
34. `⌘↵` posts; `⌘K` reachable; Esc semantics preserved.

### Follow-ups filed separately
- Daylight (light theme) pass over both surfaces.
- List/flat mode parity with the new card grammar.
- Mobile parity for the detail page.
