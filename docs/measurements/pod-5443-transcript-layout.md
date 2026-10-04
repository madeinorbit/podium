# Transcript geometry after layout

POD-5443, 2026-10-04. The transcript controller no longer reads geometry during
React's commit. Its initial and subsequent ResizeObserver deliveries preserve the
tail and reading anchor after the browser's natural layout, before paint.
The focused controller guard is green. **The full zero-reflow timing remeasurement
was not done.** The retained diagnostic trace before the composer fix is red;
no mission-click speed improvement or full zero-reflow result is claimed.

POD-4286's operator order moved this change ahead of POD-5441 (mission-deck
windowing), overriding the original issue sequence. The coordinator subsequently
authorized landing this controller change independently of the geometry reads
owned by POD-5506. After that lane landed, the coordinator directed this issue
to leave the benchmark queue and hand off in review: the operator wanted fewer
running lanes and the timing slot was needed for urgent bugs. This report records
the available evidence and that measurement gap.

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

This is 47 focused cases, not a suite result or the lean gate. These checks are
from the controller candidate, not a new post-composer acceptance run. The first phone
run exposed a missing `unobserve` method in the new test shim. After correction,
only that file was rerun. Passed mission-parity cases were not repeated.

The new commit guard was proved red by copying aside the controller, restoring
the original synchronous implementation, and running its single new case. The
case rejected eight `scrollHeight` reads during commit. Exact source restoration
was verified. Dropping forced events from the trace classifier made its commit
and post-Paint cases red (two failures); restoring it returned its eleven cases
to green. The two restored guard files passed together with 33 executed cases.
The final report update changes documentation only; no further validation lane
was run for it.

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
matrix. No 4× after-change timing or timing percentile was collected.

The observer sample still forced three layouts totaling **110.057 ms**, including
one after first Paint. The compiled source map confirms the removed transcript
effect is absent. CPU samples inside the largest layout (107.398 ms) map to
`ChatComposer.tsx`'s passive textarea sizing effect (function begins at line 277
in that build). Removing the transcript read exposed this next geometry reader;
it did not remove the page's layout cost. POD-5506 subsequently removed the
native Chromium autosize read path and landed at `51f59c6f34` (runtime change
`1140016cea`); its owner reported zero autosize reads over sixty keystrokes.
That is separate structural evidence, not a post-composer mission-open trace.
A 1.366 ms post-Paint reflow maps to the ChatView readiness rAF
(`ChatView.tsx:289–300` in the frozen build); its current helper also reads
focusability geometry and transcript scroll range. That smaller follow-up was
reported to the coordinator and is not silently excluded from the full guard.
POD-5506 explicitly left the mount-only viewport/readiness geometry unchanged.

| Evidence boundary | Observed result |
|---|---|
| Synchronous baseline, count-only at 1× / 4× | Three forced reflows at each scale |
| Observer diagnostic before composer fix, one retained 1× sample | Three forced reflows; transcript commit read absent; composer and ChatView reads remain |
| Transcript commit-read regression | Zero geometry reads during commit; planted original implementation rejected |
| Composer follow-up | Native autosize read path removed by POD-5506; separate owner-reported per-key counts |
| ChatView follow-up | 1.366 ms after-Paint force in the frozen trace; mount geometry remains in source |
| Full post-composer 1× / 4× zero-reflow timing remeasurement | **Not done** |

This evidence does not establish a measured reduction from three forced reflows
to one. The remaining ChatView read is a source-backed follow-up, with its cost
observed only in the earlier frozen trace.

## Post-composer attempt and handoff

The issue branch was rebased onto `51f59c6f34`, which includes the observer and
lazy-menu changes. Matched production builds were compiled locally using pinned
Bun 1.4.2 and transferred to the private flatblock checkout while its timing
slot was busy. ON is the unchanged observer tree; OFF restores only the original
transcript reconciliation layout effect through a build-only plugin. Both build
logs name the same source SHA. No global Bun or shared dependency tree was used.

The next `bench:flatblock` grant was at 16:45:35 UTC. Startup rejected before
any warmup or retained timing observation: the copied collector still expected
4,302 replica sessions, while the current fixture and runtime report the exact
`BASE_COUNTS` unit of 4,867 issues / 4,304 sessions. The lease was released at
16:47:01 UTC immediately after that rejection. The diagnostic is retained;
it supplies no timing result.

The collector was corrected to check both runtime and corpus counts at exactly
4,867 / 4,304 times scale (19,468 / 17,216 at 4×), keeping pool mode and all
startup settings fixed in both arms. The corrected collector was attached and
requeued. On the coordinator's wrap-up instruction, the queue entry was
cancelled; the corrected capture never ran. There are no post-composer mission
timings, no twenty-sample-per-arm matrix and no full zero-reflow acceptance result.

The whole-trace CLI guard remains strict:

```sh
bun apps/web/harness/mission-layout-guard.ts <profiles-directory>
```

The guard has not been weakened to accept the remaining read. The landed
controller is handed off with green structural and anchor evidence, while full
timing acceptance remains unconfirmed. Remaining mount geometry and its complete
trace remeasurement are recorded in **POD-5523 (ChatView mount geometry reads)**,
an unclaimed Proposed discovery; no additional lane was started.

Raw synthetic traces, CPU profile, mapped sources, collector, build/startup
records and focused-check logs are retained as issue artifacts. No operator
data is included. This issue has released its flatblock leases and cancelled
its benchmark queue entry.
