# Mission deck row window (POD-5441)

The windowed deck landed on `integrate/4286-pilot` at `44fe1e8accb507ae5222776a4de61a297a11ae4b`.
Task bands and individual session rows share measured geometry and three rows of overscan.
This also bounds a task with a large session roster. Offscreen rows retain sized placeholders;
proposal and archived tails use the same window. Indexed reveal opens the relevant ancestors,
keyboard focus pins its row, and each deck view retains its scroll position. Measurements adjust
only deck scroll, preserving the transcript pane's separate anchor ownership.

The named [source audit section](pod-5428-render-cost.md#1-the-deck-renders-the-whole-mission-not-the-screen)
was read before editing. The landing contains six files: the deck, its window helper, their
focused fixtures and the baseline-aligned pool snapshots. Sidebar components and pool readers
were not changed.

## Existing live measurements

POD-5509 compared stock pilot `61cf5320dd` with composition `16c81ad378`, which contains the same
six window files from owner `771a22f0ef`. The landed owner rebases those files onto pilot
`90f8056a7e`. These are POD-5509's existing measurements, reported in its October 4 messages at
21:57 and 22:32 UTC; they are not a new timing run of `44fe1e8acc`.

Four targets per group, milliseconds as median / maximum:

| Selection | Stock | Windowed | Median change |
|---|---:|---:|---:|
| First mission click | 668.9 / 1,621.4 | 348.6 / 766.5 | −47.9% |
| Mission revisit | 463.3 / 909.0 | 234.8 / 382.3 | −49.3% |

The large deck census fell from **33,546 to 4,287 DOM nodes**, a reduction of **87.2%**.
One candidate revisit selected a cold pane, so this is not evidence for four matched hot-pane
reveals. Lightweight placeholder DOM still scales with mission size; rich row trees and their
menus are bounded by the viewport.

## Focused validation

Foreground on flatblock, private checkout-local dependencies and the copied `.toolchain`, with
plain `bun --version` confirming the pinned **1.4.2**:

```sh
bun run test:file -- apps/web/src/app/FlightDeck.test.tsx apps/web/src/app/FlightDeck.pool.test.tsx apps/web/src/app/FlightDeck.departures.test.tsx apps/web/src/app/flight-deck-window.test.tsx
bun run typecheck -- --filter @podium/web --concurrency=1
```

**162 checks in four focused files passed** in 34.67 seconds: 130 deck, 12 pool, six departure and
14 window checks. Web typecheck was green: 15 successful tasks, 14 cached, 9.54 seconds. This is
focused evidence, not a full-suite result.

The window guard traverses 406- and 1,624-row rosters with the same 560px fixture viewport and
25-row mount ceiling. Other checks cover offscreen focus, both Tab directions, focused/selected
row retention, height compensation, cleanup and indexed archived-session reveal. The seven pool
parity cases preserve words, labels, order and layout; stale goldens were refreshed on untouched
pilot source before applying the window.

## Verification limits

The coordinator relayed the operator's approval of the windowed version and requested landing
after focused checks and types. At 22:35 UTC it canceled further native Find and interleaved
1×/4× timing follow-ups, requesting this short handoff instead. No new production mounted/visible
ratio capture, transcript interaction capture or 1×/4× POD-5093 timing result is claimed here.

Native browser Find selection handoff is unverified on the landed build. A suspected task-block
wrapper replacement during that handoff is recorded separately as **POD-5573 (Mission Find
selection handoff)**, Proposed and unclaimed. The operator waived browser Find as a landing
requirement. Runner logs and the measurement receipt are attached to POD-5441 alongside this
report and the landed patch.
