# POD-516 — rework verification

What the operator rejected after clicking the preview, and what the four
columns do now. Driven with Playwright at 1920×1080 against this worktree's
own build (`vite preview` on `127.0.0.1:19321`, the origin behind the
tailscale preview URL), against the live replica — so the mission under test
is a real one.

## The four corrections

| # | The complaint | Verdict then | State now |
|---|---|---|---|
| 1 | Sidebar unchanged; still shows subagents and subtasks with foldable items under each entry | Confirmed — every nesting mechanism was byte-identical to `main` | **Flat.** 0 roster bands, 0 native-subagent indicators, 0 coordinator badges anywhere in column 1. One row per mission; the only folds are the artifact's two group headers, and both render (`Proposed`, `Closed`). Attention reads in words — 2 need-pills on screen. |
| 2 | Tray must be gone from the Superagent pane | Confirmed — nothing had been removed | **Gone.** The rendered pane matches no `/tray/i` anywhere in its text. It reads: `Portfolio copilot` · "One thread across every task and session." · `CURRENT FOCUS` naming the inspected mission · composer. No dangling imports; `client-core/viewmodels/tray.ts` and `--radius-tray` deliberately kept. |
| 3 | Nothing done on the Task view | Partly confirmed — it changed, but was never recomposed | **Single scroll.** `0` native `<select>` elements and `0` section chevrons in the panel. Head is stage glyph + `#516` + `TASK` chip, title, description, then exactly three controls: `In Progress` dropdown, `Answer`, `•••`. Decision band renders under it. An `Agents & sessions` section exists for the first time. |
| 4 | Flight Deck has agents parenting sessions | Right observation, wrong file — the deck was already correct | **Visible and correct.** Column 2 renders issue → its sessions → child issues. Fourteen session rows sit directly under `#516`; `#540`, `#539`, `#555`, `#559` nest as child *issues*, each with its own sessions. The forbidden spawn-parent tree was in column 1 and is gone with the flattening. |

## Measurements

**Type scale.** Font-size histogram over every leaf node in the Flight Deck:
`{8px: 2, 9px: 6, 10.5px: 31, 12px: 35, 13px: 1, 14.5px: 1}`.
**Nothing at 16px** — the `shell-type-meta` regression this issue inherited
stays fixed, and the mission intro at 14.5px is the largest text in the column.

**Layout.** `document.documentElement.scrollWidth === window.innerWidth ===
1920`. No horizontal overflow with the Task dock open.

**Console.** Zero errors and zero page errors across the full drive
(load → expand deck → select mission → open Task → open Superagent).

## What the Flight Deck actually rendered

Mission head: `#516 in progress` · title · `2 / 6` · brief · four-segment
progress · `2 done · 2 active` · `16 live  0 coords`.
Filters: `Full spine` | `Active` | `Needs you 2` + search + fold-all.

Spine, in order: `#516` with a `Needs you` mark, then its session rows
(Persisted UI layout state, Workspace concept synthesis, Superagent pane
rework, Runtime verification and preview, Task inspector single scroll,
Operator workspace takeover, Red web test gates, Operator workspace build,
Mission model tests, Operator workspace coordination `35:52`, Issue events
subject filter, Flat mission sidebar, Design conformance audit, Flight Deck
fidelity fixes), then `↳ Discovered from #491`, then the child issues —
`#559` and `#555` reading `Proposed · not started` with `Ready to run`,
`#540` with `Needs you` and its own session, `#539` marked `Done` with its
session `Retired`.

That is the artifact's presence vocabulary working end to end: a task with no
session says *why* rather than showing a blank, and a done task keeps its
place in Full spine.

## Deviations worth naming

- **Offer cards sit between the decision band and Current update** in the Task
  dock. They are Podium's existing needs-you payload and they read coherently
  under the band, but the spec's scroll order starts at Current update. Left
  as is; flagged rather than silently accepted.
- **The mission progress counts the root as a task** (`2 / 6` for five
  children), because the artifact's own `progress()` includes the root in its
  issues array. A solo mission therefore reads `0 / 1`.
- **F11 — the column-1 progress meter was dropped**, not kept. The Flight
  Deck's mission head owns subtree progress; two bars for one number a column
  apart read as two facts, and the design audit had already caught them
  filling in different colours.
