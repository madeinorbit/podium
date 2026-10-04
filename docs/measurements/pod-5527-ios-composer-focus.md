# iOS composer focus at the transcript tail

POD-5527, 2026-10-04. Focusing the mobile web composer at the transcript tail
must leave Safari's software keyboard open and allow typing. The fix adds a
viewport-only reconciliation guard and makes mobile web keyboard dismissal
respond to reader gestures. It preserves real transcript growth, reading-anchor
correction and POD-5517's existing 80-row mounted limit.

Runtime checkpoint before final landing: `42df877ac5`. The issue branch is based
on `integrate/4286-pilot`; no `dev/mw` or `main` ref is changed by this issue.

## Two paths could dismiss the keyboard

The existing ResizeObserver reconciliation repinned the transcript when Safari
reduced the visual viewport to accommodate the keyboard. In the retained native
before-fix capture, the viewport changed from 714 px to 377 px, the controller
wrote `scrollTop` from 2324 to 2661, and the composer lost focus 35 ms later.
The keyboard closed and the viewport returned to 714 px.

Suppressing that controller write alone was insufficient on mobile web. React
Native Web's `ScrollView` implements `keyboardDismissMode="on-drag"` by dismissing
the keyboard on every scroll event. Safari's automatic adjustment can therefore
blur the textarea even before the controller writes an offset. A native run
with only the controller guard reproduced that second path.

The controller now records observed row heights in a WeakMap. While an input,
textarea or editable element has focus, a viewport/content-only delivery updates
its geometry cache without changing an offset or correcting an anchor. Row
height changes and new rows still reconcile genuine content growth, including
net-zero reflow around a reading anchor. No focus or blur operation is added.

The mobile web adapter disables React Native Web's automatic scroll-event
dismissal and implements its existing `on-drag` policy with passive `touchmove`
and `wheel` listeners. Automatic browser adjustments and live-output following
retain focus; reader gestures still dismiss the keyboard. Other ScrollView
props and the native adapter retain their existing behavior.

## Focused validation on flatblock

All product checks ran sequentially in the foreground in `~/podium-test-5527`,
using its copied `.toolchain`, Bun 1.4.2 and checkout-local frozen dependencies.

| Check | Result |
|---|---|
| `apps/web/src/features/chat/use-transcript-scroll.test.tsx` | 26 cases green |
| `apps/mobile/src/components/TranscriptViewport.test.tsx` | 7 cases green |
| Scoped `@podium/client-core` and `@podium/mobile` typecheck | 14 tasks successful; 7 cached |

The focused file command was `bun run test:file --` followed by those two paths.
The type command was `bun run typecheck -- --filter @podium/client-core --filter
@podium/mobile`. This is 33 focused cases, not a full suite or lean-gate result.
The first combined run passed all web cases but exposed incomplete synthetic
touch data and scroll-throttle timing in the mobile test harness. After fixing
those test-only issues, only the mobile file was rerun and all seven cases passed.

The new cases focus the composer, resize the bottom viewport and assert retained
textarea focus with no `scrollTop`, `scrollTo`, `scrollIntoView`, focus or blur
operation. They also cover keyboard-related content padding, genuine row growth,
net-zero anchor reflow, and gesture-only keyboard dismissal. Existing bounded-row,
history and search cases remain in the mobile file. Restoring the pre-guard
observer implementation made both focused resize regressions red; restoration
of the candidate was verified.

## Native Safari boundary

The leased Mac runner is `admin@podium-apple-runner`, using iPhone 17 Pro simulator
`C75D44CB-8908-4AAA-B70E-CA5A465801EA`, iOS 26.5 and Xcode 26.6. A private synthetic
fixture serves the real `VisualViewportRoot.web`, `TranscriptViewport.web`,
keyboard-visibility hook and React Native Web multiline TextInput. It contains
40 retained rows and appends five rows after receiving `focus-check`. No operator
instance or user data is used.

The check uses normal Mobile Safari and a small native XCTest UI runner, because
SafariDriver suppresses the software keyboard. It taps the composer at the tail,
checks the actual native keyboard, enters text and checks that the keyboard stays
open. DOM telemetry independently records focus, visual-viewport transitions,
programmatic scroll calls and live-content following.

The final fresh-runner native check passed: **one case, zero failures**. Its
screenshot shows the software keyboard open with `focus-check` in the composer.
The independently checked DOM sample has a 377 px visual viewport, composer
focus, zero focus-out events and **zero programmatic scrolls during viewport-only
resizing**. Five data rows then arrive (mounted block wrappers increase from 41
to 46, including the footer); one content-following offset write runs with focus
intact, following remains enabled and the tail error is **0 px**.

The earlier fixed capture already recorded a 714-to-377 px keyboard transition
without a viewport-only scroll write or focus loss. After typing, five rows were
appended and one content-following offset write ran with `composer` still focused;
the final tail error was 0 px. Its native typing/keyboard assertions passed, but
a brittle accessibility lookup for a particular live-row label failed. The final
check replaces that lookup with separate DOM evidence and a unique page label.

Rejected runs are retained as diagnostics: an initial baseline mapped to the
candidate by mistake; another baseline and subsequent retries recorded no tap
or focus event on the intended page. The retry failure still named the previous
locator despite updated source, identifying a stale installed UI-test runner.
A fresh private runner build and bundle identity produced the passing final
check. Rejected runs do not count as reproduction or acceptance evidence. The
valid before-fix reproduction is `before-corrected`; final acceptance is
`after-freshproof`.

This is a native keyboard correctness check on a small synthetic transcript,
not the production corpus, a Safari performance benchmark or a 1×/4× timing run.
Raw native logs, screenshots, telemetry, fixture source and focused-check logs
are attached to the issue. Owned Safari, preview and native test processes are
stopped before releasing the Mac bench to POD-5508.

## Original mission-open measurement remains incomplete

POD-5443's observer change and structural/anchor guards are landed. Its full
post-composer zero-forced-reflow timing remeasurement was **not done**, following
the coordinator's wrap-up instruction. This keyboard fix does not fill that gap,
claim a measured three-to-one reflow reduction or relax the whole-trace guard.
The remaining ChatView mount-geometry follow-up is Proposed POD-5523. See
[the original evidence report](pod-5443-transcript-layout.md).
