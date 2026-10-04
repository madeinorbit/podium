# iPhone Safari mission reload

Issue: POD-5517. Baseline: `51f59c6f34` on `integrate/4286-pilot`.

The operator reports repeated mission page reloads in iPhone Safari. Reproduction
uses an isolated iPhone simulator on `podium-apple-runner` and POD-5508's
operator-size synthetic corpus; operator data stays on its original host.

## First proven growth path

The mobile RN Web viewport mounted every loaded transcript row. Live frames
append to the shared controller's held history, so the DOM grew for the entire
time the chat stayed open. Desktop already limits its mounted following window.
The mobile viewport was introduced by `1d2ff316c7` on October 1; this path is not
new in the October 4 commits named by the operator.

On the iPhone 17 Pro simulator (iOS 26.5, 23F77), a production build of the
`51f59c6f34` product and the isolated synthetic corpus held 3,000 turns / 33,000
items on the server, then appended one mixed 11-item turn every 250 ms. No
operator records were copied. The mobile session chat grew from 3,886 DOM nodes
at 49 seconds to 14,156 at 131 seconds. Its WebContent PID 32570 grew from
546 MiB physical footprint at 22 seconds, after bootstrap, to 743 MiB at 138
seconds (about 1.7 MiB/s). The initial 140 MiB sample includes startup and must
not be used as a steady-state growth rate.

## Mobile render-window comparison

The same production build with only the mobile viewport change rendered at
most 80 settled rows plus its footer while following. A fresh three-minute
streaming capture stayed at 81 transcript rows and 1,060–1,073 total DOM nodes.
Older loaded rows are revealed before disk paging. Reading retains mounted
history and its row anchor; search can reveal an unmounted target; returning to
newest restores the bounded tail. Native FlatList is unchanged.

RN Web also replaces the host node's browser `scrollTo` with its `{x,y}` API.
The viewport restores the native browser method for the shared DOM scroll
authority's `{top,behavior}` calls, preserving search navigation.

The candidate's two WebContent processes still used about 612–617 MiB at the
end, and the runner experienced substantial CPU pressure. Bounding mounted DOM
does not bound the controller's held items or the full-history compute work.
POD-5534 tracks that remaining path. This is a proven fix for mounted-node
growth, not evidence that all memory pressure is solved.

Neither capture recorded a JavaScript exception loop, React #185, an automatic
reload, or a jetsam termination. Recorded exits were capture cleanup. The
operator's repeated device reload has not been reproduced conclusively on the
simulator. SafariDriver automation suppresses the software keyboard, so these
captures do not validate the separate keyboard-focus issue.

## Validation and reproduction

Product validation ran foreground on flatblock in `~/podium-test-5517`, with
its own copy of `.toolchain` and Bun 1.4.2: focused Biome checks, scoped mobile
typecheck (14 tasks), and all five `TranscriptViewport.test.tsx` tests passed.
The production client build succeeded. No broad suite result is claimed.

The reusable capture and isolated preview are
`apps/web/harness/ios-mission-memory.py` and `ios-mission-preview.mjs`. The
preview reads only the synthetic fixture in `IOS_PREVIEW_ROOT`, binds loopback
port 19687, and streams for at most three minutes with `IOS_STREAM=1`.
`IOS_MOBILE_ARM=mobile-window` selects the comparison export. Capture evidence
and the baseline screenshot are attached to POD-5517. Landing is ff-only on
`integrate/4286-pilot`; neither main nor dev/mw is advanced.
