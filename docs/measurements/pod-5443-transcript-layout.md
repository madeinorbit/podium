# Transcript geometry after layout

POD-5443, 2026-10-04. The transcript controller no longer reads geometry during
React's commit. Its initial and subsequent ResizeObserver deliveries preserve the
tail and reading anchor after the browser's natural layout, before paint.
The focused controller guard is green. **The full mission-open trace guard is
still red; no mission-click speed improvement or zero-reflow result is claimed.**

POD-4286's operator order moved this change ahead of POD-5441 (mission-deck
windowing), overriding the original issue sequence. The coordinator subsequently
authorized landing this controller change independently of the geometry reads
owned by POD-5506, and requested full remeasurement after that lane lands.

## Change and behavior

Removed the layout effect that called `reconcileLayout` whenever the transcript's
row identity changed. ResizeObserver already observes the content, scroller and
individual rows; its initial delivery now also opens a conversation at its tail.
The observer is renewed on conversation changes, including when a retained panel
has the same rows. Commit-time intent reset remains, without a geometry read.

Following intent, history requests, selection, hidden-panel activation, row-key
aliases, compositor movement and compensation for reflow above the reader keep
one existing scroll authority. The phone DOM viewport uses the same controller.
No FlightDeck, sidebar, pool-reader, composer or ChatView product file changed.

## Focused evidence

All checks ran sequentially, in the foreground on flatblock in
`~/podium-test-5443`, with a copied `.toolchain`, Bun 1.4.2 and checkout-local
frozen dependencies. The candidate was rebased onto POD-5497's pilot landing
`e22a8b6bd9`; final code/test checkpoint is `59d6374d27`.

| Exact file | Executed cases | Result |
|---|---:|---|
| `apps/web/src/features/chat/use-transcript-scroll.test.tsx` | 22 | green |
| `apps/web/test/mission-layout-guard.test.ts` | 11 | green |
| `apps/web/src/app/FlightDeck.pool.test.tsx` | 12 | green; existing words, labels, order and layout parity |
| `apps/mobile/src/components/TranscriptViewport.test.tsx` | 2 | green |

This is 47 focused cases, not a suite result or the lean gate. The first phone
run exposed a missing `unobserve` method in the new test shim. After correction,
only that file was rerun. Passed mission-parity cases were not repeated.

The new commit guard was proved red by copying aside the controller, restoring
the original synchronous implementation, and running its single new case. The
case rejected eight `scrollHeight` reads during commit. Exact source restoration
was verified. Dropping forced events from the trace classifier made its commit
and post-Paint cases red (two failures); restoring it returned its eleven cases
to green. The two restored guard files passed together with 33 executed cases.

The smallest isolated real-Chromium check reused the existing transcript-scroll
fixture. One wheel interaction per desktop/phone DOM consumer was followed by
simultaneous tail growth and growth above the reader, then a jump to bottom and
more tail growth. Both opened at the tail, kept reading intent and the same row
with **0 px anchor error**, and resumed following after the jump. No operator
instance, data or sessions were used.

## Measurement and remaining reads

POD-5093's collector was copied, keeping its trusted pointer input, expected DOM,
Chromium Paint boundary, synthetic seed 4443, production renderer, 1800×1000
viewport and alternating arm order. The copy selects mission switches only and
records through settling plus at least 100 ms after first Paint. The classifier
requires those marks, complete layouts, JavaScript events and the input renderer
thread; layouts inside an ordinary rendering task are not counted as forced.

The old legacy OFF arm is unavailable in the current acceptance fixture:
`mode()` and `paneMode()` already return `pool`. The adapted comparison holds the
pool path and all sixteen old startup settings enabled in both arms. OFF uses
the synchronous transcript build; ON uses the observer build. The initial
collector rejection occurred before any timing sample and was discarded.

Fresh pre-edit counts under `meter:flatblock` found **three forced reflows** at
both 1× (`i1766`, 4,867 issues / 4,302 sessions) and 4× (`i13916`, 19,468 issues /
17,208 sessions). These count-only runs do not report timings.

The paired timing capture held `bench:flatblock`, acquired at 15:11:36 UTC and
released immediately after the first retained ON sample failed. Both compiled
arms were based on `1aa0ec71f6`, before old-store deletion: frozen synchronous
build checkpoint `2409ddeb62`, observer checkpoint `8699abb96c`. The collector's
per-record `sourceSha` identifies its candidate checkout; the OFF build's source
is the separate frozen checkpoint above. The landing candidate was subsequently
rebased onto the required deletion landing without restoring any legacy path.

The capture retained **one sample per arm at 1×**, after two warmups, before the
zero-reflow guard stopped it. It is not the planned twenty-sample acceptance
matrix. No 4× after-change timing or timing percentile is available yet.

The observer sample still forced three layouts totaling **110.057 ms**, including
one after first Paint. The compiled source map confirms the removed transcript
effect is absent. CPU samples inside the largest layout (107.398 ms) map to
`ChatComposer.tsx`'s passive textarea sizing effect (function begins at line 277
in that build). Removing the transcript read exposed this next geometry reader;
it did not remove the page's layout cost. POD-5506 owns and is replacing this
sizing path. A 1.366 ms post-Paint reflow maps to the ChatView readiness rAF
(`ChatView.tsx:289–300` in the frozen build); its current helper also reads
focusability geometry and transcript scroll range. That smaller follow-up was
reported to the coordinator and is not silently excluded from the full guard.

The whole-trace CLI guard remains strict:

```sh
bun apps/web/harness/mission-layout-guard.ts <profiles-directory>
```

After POD-5506 lands, rebase, build matched synchronous/observer controls on the
same resulting product tree, and finish the interleaved 1×/4× capture under the
timing lease. Report the full guard's actual result, including any remaining
ChatView read, separately from the green controller commit-read regression.
Raw synthetic traces, CPU profile, mapped sources, collector and check logs are
retained as issue artifacts.
