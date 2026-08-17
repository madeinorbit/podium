# The phone's hibernated transcript: what was actually wrong (POD-1251)

Two questions, measured against the live instance's phone app (`/mobile`) in
Playwright at an iPhone viewport, with the probes in `apps/mobile/e2e/pod1251-*`.

## 1. "A hibernated session blocks the transcript from scrolling"

It does not block the gesture — a real touch drag moves the feed on a hibernated
session exactly as on a live one (measured: `scrollTop` 0 → 517 → 282). What it
does is open the transcript **at the oldest loaded row and leave it there**:

| | before | after |
|---|---|---|
| `scrollTop` on open | 0 | 1783 |
| distance to the newest message | 1790px | 0px |
| jump-to-newest pill | hidden | not needed |

The pill is hidden because `atTail` only ever changes in `onScroll`, so the list
believes it is at the tail while the reader is a screen and a half above it.
There is no control offered, nothing arrives to move the feed, and the newest
message — the thing you opened the session to read — is off-screen. That is the
"stuck" the report describes.

### Root cause

`TranscriptList` pins the feed by calling `FlatList.scrollToEnd()` from
`onContentSizeChange`. Without `getItemLayout`, `VirtualizedList.scrollToEnd`
computes its target as `_averageCellLength * lastIndex`, and on the first
content-size change no cell has been measured yet, so the average is 0 and the
"end" it scrolls to is **0**. Instrumenting the scroller from first paint shows
the content growing 735px → 2525px with *no scroll write and no scroll event at
all* — the pin fired and asked for offset 0.

A live session hides this: its content grows again when the next message lands,
by which time cells are measured and the pin lands correctly. A hibernated
session never grows again, so it stays at the top forever.

The fix (`tailOffset` in `apps/mobile/src/lib/transcript-tail.ts`) computes the
offset from the two heights the list has just been handed — content height minus
the feed's own measured height — and uses `scrollToOffset`. Both the DOM and the
native scroll views clamp an overshoot, so an unmeasured viewport still lands at
the bottom instead of at 0.

## 2. "Why is the hibernate banner red?"

The hibernated bar was gold, not red — but the **exited** bar was a red slab
(`3-exited-before.png`), and both were tinted slabs of a colour the design system
reserves for something else. Web deleted exactly this in POD-747: hibernation is
a STATE, not a request, so the bar spends none of the yellow that means "waiting
on you", and a fault takes warning ink on its glyph and its state word only,
never as a fill.

The phone now renders the same object web does: the `bar` chrome tier, one
hairline seam, machine voice, `Hibernated` in strong ink, the moon faint, and —
for an exited session — the glyph in warning ink over the same chrome ground.
In `4-exited-after.png` the only yellow left in the frame is the offer's own
button, which is the one thing on screen actually asking for the operator.

## Screenshots

| file | what |
|---|---|
| `1-hibernated-before.png` | shipped: yellow slab, feed parked at the oldest row |
| `2-hibernated-after.png` | fixed: chrome bar, feed open at the newest message |
| `3-exited-before.png` | shipped: the red slab (the "red banner" in the report) |
| `4-exited-after.png` | fixed: chrome bar, warning ink on the glyph only |

## Also measured, not fixed here

The phone paints a transcript **10–20s** after the route opens (13.6s, 15.2s,
19.7s across runs; a live session is no faster). The server answers
`sessions.transcriptRead` in 34–44ms, so the wait is entirely client-side boot
and render. During it the feed is a zero-overflow skeleton that genuinely cannot
scroll — filed separately.
