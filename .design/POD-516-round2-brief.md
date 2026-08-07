# POD-516 round 2 — the operator's second pass

Round 1 fixed *what was missing*. This round is about **how it looks and feels**.
The operator has clicked through it and wants this to land as the new layout in
alpha/beta, so the bar is "best possible UX", not "conformant".

Read `.design/POD-516-conformance-spec.md` first — it is still the target and
nothing in it is repealed. This file adds the operator's second round of notes.

## Two references, both authoritative

1. **The prototype**
   `/home/podium/podium/.worktrees/issue-491-multi-agent-operator-workspace/.design/POD-491-operator-workspace-final.html`
   — the inner shell, its CSS, and its scenario JS.
2. **`.design/POD-516-r2-target-flight-deck.png`** — a screenshot of that
   prototype's Flight Deck that the operator attached as "this is what I want".
   It shows detail the doctrine text does not. Study it pixel by pixel.

Where they disagree with each other, the screenshot is the prototype rendered,
so they cannot — if you think they do, you have misread one.

## What the screenshot shows that we do not currently build

Working from the operator's own reference image:

- **Session role labels.** Every session row carries a dim mono role after the
  name: `coordinator`, `phase lead`, `operator-added peer`, `by Spine designer`.
  We show `coord` on coordinators only, so a nine-agent mission reads as eight
  anonymous rows.
- **Per-session elapsed timers**, mono, right-aligned: `42m`, `1h 18m`, `33m`,
  `12m`, `28m`, `18m`, `6m`. DESIGN.md §5 pairs the spinner *with* a counting
  timer; we render the glyph alone.
- **Native subagent rows** under their session, with an L-shaped connector:
  `Explore · 09a5efab  working`, `Plan · b7b3c212  waiting`.
- **Tree guide lines** down the left of each nesting level, connecting a parent
  to its children — not just an indent.
- **Named blocking reasons** as an indented line under the row:
  `Blocked by POD-507`, `Waiting for POD-507 to complete`,
  `Completed · session retired`.
- **State words with their glyphs**, right-aligned and consistent:
  `Running` (spinner), `Done` (check), `Waiting` (hourglass), `Blocked` (⊘),
  `Next` (hourglass).
- **Row treatment**: issue rows read as distinct bands with a soft edge; the
  selected root carries a visible focus ring. Session rows are quieter and
  inset. Note the *hierarchy of quietness* — issue > session > native.

⚠ The standing "no decorative coloured/rounded outline cards, no AI-slop
borders" constraint still holds, and so does DESIGN.md's carved-not-floating
elevation. The screenshot's separation is achieved with restraint. Reproduce the
**structure and hierarchy**, using this app's own elevation and hairline
language — do not paste the prototype's chrome.

## The operator's notes, verbatim intent

### Left sidebar

1. **Bring the artifact's dynamic status bar** — how many issues are done,
   waiting, progressing, with animation on the in-progress signal.
2. **Surface a little relevant information** — how many agents, how many tasks —
   **without overloading the column.** Restraint is the requirement, not a
   caveat. If it starts to look busy, cut.
3. **Remove the Proposed fold.** Not needed. The only folds in that column are
   the tucked-away group and suspended/closed.

### Flight Deck

4. **Polish to match the artifact.** Content is already close; the design is
   not. Compare again against both references above.
5. **"Needs you" belongs on the SESSION, not the task.** Today the task row
   carries it. A task does not need you — the *session* stopped and asked you
   something. Move the attention marker to the session row. The task should
   carry at most a colour indicator that something inside it needs you.
   **The Needs-you filter must follow this** — it selects sessions that need you
   and shows them with their task path.

### Task dock (the "issue sidebar")

6. **It does not scroll.** Straight bug. Content below the fold is unreachable.
   Fix it and add a regression test.
7. **Remove the offer cards.** Fold the needs-you information into the session
   list instead — the session that asked is the thing the operator acts on.
8. **Look very hard at content and design.** The operator says it is
   "completely different than what we agreed on in the artifact". Re-derive it
   from the prototype's `renderTaskFinal()` rather than adjusting what is there.

### Right dock surface (bonus, and the operator likes it)

9. **The artifact darkens the right sidebar.** We currently pull the selected
   issue's tint into it, but the dock is not always showing the selected task,
   so the tint misleads. **Use a dark default surface for the right dock.**
   This deliberately narrows the issue-colour tint channel on this one surface;
   that is the operator's call, made with the tradeoff understood. Keep the
   ID square's own colour — it identifies a specific issue and is not the
   surface.

### Superagent

10. **Remove the second header.** The pane has a `Superagent` dock title and
    then a `Portfolio copilot` heading under it. One header. Drop the second.

## How this round is judged

Round 1 shipped things that were *present but wrong* — a CSS class that never
existed, a progress meter computed over filtered rows, a badge that disagreed
with the column it summarised. All three were caught by an agent re-checking a
peer rather than by tests.

So: **verify at the real tree, not the cached one.** `bun run typecheck` can
replay a cache-hit log from a tree that no longer exists — compile your package
directly with `cd apps/<pkg> && bunx tsgo --noEmit`. And when you report a
number, say which tree it describes.

Do not leave the work half-done. If you cannot finish something, say so
explicitly and name what remains — a silent gap is worse than a stated one.
