# POD-516 round 2 — verification

Driven with Playwright at 1920×1080 against this worktree's own build
(`vite preview` on `127.0.0.1:19321`, the origin behind the tailscale preview
URL), against the live replica. Measured at commit `27fe88642`.

## The operator's ten notes

| # | Note | State |
|---|---|---|
| 1 | Dynamic status bar — done / waiting / progressing, with animation | **Done.** Column 1 leads with `6/45 done`, a segmented bar, and `11 running` beside a braille spinner. |
| 2 | Relevant info without overloading | **Done.** Two numbers and one motion cue. Agent and task counts ride the existing rows rather than adding a second band. |
| 3 | No Proposed section | **Done.** `hasProposedFold: false` in the rendered column; its fold key went with it. Only the tucked group and `Closed · 3` remain. |
| 4 | Flight Deck polish to the artifact | **Done** — see the gap table below. |
| 5 | Needs-you on the session, not the task; filter follows | **Done.** The `!` marker and the words sit on the session row. Filter measured: Full spine 72 rendered lines → Needs you 12, narrowed to the one session that asked, shown with its task path. |
| 6 | Task dock does not scroll | **Fixed.** Measured: fixed region a constant 222px in a 1012px dock, scroll viewport 746px over 4970px of content, and `scrollTop` reaches 4224. |
| 7 | Remove the offer cards; needs-you with the session list | **Done.** No `OFFER` text anywhere in the panel. The asking session carries the headline and its answers as inline chips, and needs-you sessions sort first. |
| 8 | Dock content and design re-derived from the artifact | **Done.** Head is stage glyph + ref + `TASK` chip, title, description, then exactly three controls; decision band; then one scroll. |
| 9 | Dark default for the right dock | **Done.** Measured backgrounds: rail `rgb(5,9,18)` < dock `rgb(7,11,22)` < pane `rgb(10,15,28)`. A tonal step down, from tokens rather than literals, so Daylight steps down too instead of going black. |
| 10 | One header on Superagent | **Done.** `mentionsPortfolioCopilot: false`. The only heading is the dock title. |

## The reference screenshot, gap by gap

Against `.design/POD-516-r2-target-flight-deck.png`:

| Gap | State at `27fe88642` |
|---|---|
| Session role labels | Present — `operator-added peer`, `by Operator workspace coordination`, `by Operator workspace takeover`, `by Workspace concept synthesis` |
| Per-session elapsed timers | Present — `114:24`, `42:45`, `15:13`, `36:51`, `70:27`, `152:24` |
| Native subagent rows under their session | Present — three `general-purpose · <id>  working` rows hung off their parent session on their own guide |
| Tree guide lines per nesting level | Present — drawn from the spine's geometry rather than an indent |
| Named blocking reasons | Present — `Proposed · not started`, `Completed · session retired`, `↳ Discovered from POD-516` |
| State words with glyphs | Present — `Running`, `Done`, `Next`, `Standing by` |
| Issue > session > native quietness | Present |

Divergence worth naming: the timer format is the app's own `PhaseTimer`
(`114:24`) rather than the artifact's `1h 18m`. Consistent with the rest of
Podium, less readable than the reference at large values.

## Health

- Direct compile, not the cached lane: `cd apps/web && bunx tsgo --noEmit` → exit 0.
- `bunx vitest run src/features/worklist` → 21 files / 99 tests.
- `bunx vitest run src/app src/lib/mission.test.ts` → 31 files / 333 tests.
- `bunx vitest run src/features/issues` → 41 files / 283 tests (at `e592fc4ee`).
- Zero console errors and zero page errors across the full drive.
- `document.documentElement.scrollWidth === window.innerWidth === 1920` with the dock open — no horizontal overflow.

## Deliberately not done

- **`StageGlyph`'s `in_progress` is `text-amber-500`** — breaks the amber rule
  and diverges from the artifact (which uses blue, `#7699d9`). It is imported by
  17 files, so changing it repaints every issue surface in the product. Filed as
  POD-583 rather than taken here.
- **Offer artifact thumbnails** no longer appear beside the answer in the dock.
  The same artifacts still render in *Evidence & checks* lower in the scroll.
- **Free-text offer actions** now hand off to the conversation instead of
  opening a textarea in the dock — deliberate, since an unbounded box in the
  fixed region is what caused note 6.
- **~186 lines of pre-existing formatting drift in `AppShell.tsx`**, left alone
  rather than bundled into an unrelated commit.
