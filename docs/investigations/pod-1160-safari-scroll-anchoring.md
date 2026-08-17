# Safari transcript scroll: the engine fights the feed (POD-1160)

**TL;DR.** Both remaining Safari symptoms — "jump to bottom is unreliable" and
"if I manually scroll to the bottom it jumps up after a second or two" — are
WebKit's newly-shipped scroll anchoring acting on the feed scroller, in two
distinct ways: (1) anchoring **reverts scroll position changes** (programmatic
writes and user wheel alike) to keep its chosen anchor node in place, and (2)
the engine's own maximum-scroll bookkeeping **runs stale behind layout**, so a
user scroll physically cannot reach the bottom the app compares against, which
is why the `gap <= 4` re-pin never fires in WebKit. The fix that measures clean
in both engines: exclude every feed child from anchor selection, **except the
last child while the reader is pinned** — the engine then holds the bottom
natively (and keeps its geometry fresh), and stops being able to fight a reader
who has scrolled up. Validated end-to-end in Playwright WebKit and Chromium
against the live app; numbers below.

All measurements: `apps/web/e2e/pod1160-probe.ts` against the live instance
(127.0.0.1:18787), Playwright WebKit v26.4 / Chromium, transcript POD-1098
(offer card present; window `sh=7326, ch=481` or `sh=4246, ch=537` depending on
load). Methodology per scenario is in the probe's header comment.

## Timeline of findings

### 1. The app's writes are not what they seem in WebKit

Wrapping the element's `scrollTop` setter and watching scroll events shows, at
a pinned bottom rest (`poke` scenario, no app writes in flight):

```
t=16860  write 3709 → 3509 (−200, harness)
t=17932  first scroll EVENT: top=3624 — the write applied 1072ms late, and only −85 of −200
t=18483  scroll event: top=3709 — the engine returned to the bottom. No write. Nobody wrote.
```

Repeated 5× (`fix` scenario, app writers silenced via the wheel-up latch):
a −200 write **applies late (0.3–3s), partially (−39), or never**, and often
reverts to 0 within 2.5s. The reverter is scroll anchoring: with anchor
candidates removed (see §4) the same write applies fully every time and stays.

This alone explains symptom (2): `jumpToBottom` writes the bottom and
`settleToBottom` re-asserts it for 10 frames; anchoring undoes it after the
loop ends. Whoever writes last wins, and the engine always writes last.

### 2. Playwright's "WebKit can't wheel this scroller" was the same bug

POD-993's harness limitation (wheel events arrive, scroller doesn't move) is
not a Playwright input problem: `scrollBy({behavior:'smooth'})`, keyboard
scrolling, and `mouse.wheel` all move a minimal fixture injected into the SAME
page and all move the feed **0px** (`why` scenario). Anchoring undoes them.
With anchor candidates excluded, `mouse.wheel` drives the feed perfectly —
which is what finally made escape testing possible in WebKit at all.

### 3. The engine keeps a second, SHORTER maximum — and enforces it

With anchoring quiet, a new defect becomes visible (`escape`/`stale`
scenarios): the engine's user-scroll machinery holds a maximum scroll that is a
**constant K short of layout's** (K = 115px on the `sh=4246` load, 161px on
`sh=7326`; POD-993 measured 444px under `overflow-anchor:none`; main today
shows ~39px). At rest at the true bottom the engine pulls the view up to its
own max — measured as a spontaneous 115px upward scroll 1.7s after load with
zero writes and zero DOM changes, and as an indefinite 0↔115px oscillation
after a wheel-down arrival. A user's wheel clamps at the engine max, K short of
the true bottom.

K is not a stale snapshot of total height (appending 300px does not grow it,
and container rebuilds don't reset it); it behaves like a refresh that runs one
layout change behind, where the refresh channel is the scroll-anchoring
controller: with the scroller unregistered (`overflow-anchor:none` on the
scroller — POD-993) the refresh never happens (K=444); with anchoring active
(main) adjustments keep K small (~39) at the price of fighting every scroll;
with all children excluded, adjustments never run and K grows to 115–161.

**This is the missing mechanism for symptom (3) on main today**: the reader
wheels down; the engine clamps them ~39px short; `gap <= 4` is unreachable, so
the intent latch never clears and `pinnedToBottom` stays false; the next tail
unmount/remount cycle (the "Churned for…" divider and "Waiting on your
decision" row — exactly the operator's "UI under the last message") clamps the
view up by the tail's height with nothing willing to restore it. The "second or
two" is the next tail clock tick / activity commit.

### 4. The fix: anchor eligibility follows the pin

No static CSS works — the matrix (`fix`/`escape`/`stale` scenarios):

| config                                  | writes stick | wheel works | bottom holds | escape |
|-----------------------------------------|--------------|-------------|--------------|--------|
| main today (anchor everywhere)          | no — reverted | no (0px)   | via app writes | 0px |
| `overflow-anchor:none` on scroller      | — POD-993: K=444, feed opens short — |||
| all children excluded                   | yes          | yes         | **decays K short in ~2s** | 1440px |
| last child eligible (always)            | yes          | yes         | yes (pull-up 0) | **0px — reader imprisoned** |

The working design keeps the two states the app already tracks:

- **Pinned** (following the tail): `> :last-child` is anchor-eligible, all
  other children excluded. The engine anchors the end of the feed: native
  stick-to-bottom, geometry refresh intact (pull-up 0px; growth at the end
  self-heals on the next layout change — measured `gap 161 → 0` on the first
  subsequent tick).
- **Released** (wheel-up / touchstart intent, the existing latch): every child
  excluded. The engine has no anchor to defend; the reader is free.
- **Restore on downward movement** (any scroll event that moves down, so
  wheel, touch and scrollbar drags all count): re-grant last-child eligibility
  *before* arrival. The style flip itself refreshes the engine's stale max, so
  the true bottom becomes reachable again, and an eligible anchor below the
  viewport is inert until the reader actually gets there.

Full journey, emulated in-page and run twice per engine (`flip` scenario):

```
WebKit:   escape 0→1481px; holds 1481 for 8s; wheel down lands gap=0, stays 0 for 12s; cycle 2 same
Chromium: escape 0→1440px; holds 1440 for 8s; wheel down lands gap=0, stays 0 for 12s; cycle 2 same
```

Chromium behavior is unchanged in substance (its anchoring is sane either
way); aligning both engines on explicit anchor eligibility removes the
class of "worked in Chrome, fought in Safari" divergence.

## What this exonerates

- The 80px/4px thresholds and the fractional-residue theory: residue is real
  (0–1px) but irrelevant; the re-pin failed because the engine clamps the
  reader tens of px short, not because of rounding.
- `claimScrollForArrival` (POD-1158): predates nothing, conflicts with
  nothing measured here; while pinned it writes the same bottom the engine
  holds.
- The IntersectionObserver tail sentinel: solves the wrong layer. The reader
  was not failing to *detect* the bottom; the engine was refusing to *let them
  reach or keep* it.
- `scrollend` / write-inside-rAF-vs-observer: moot for the same reason.

## Traps for whoever touches this next

- Runtime style toggles do NOT reproduce from-load behavior for anchoring
  registration (the POD-993 landmine fires at first layout). The probe's
  `P1160_CSS` env injects CSS at document-start for that reason.
- The live instance redeploys on every merge to local main; a run that spans a
  redeploy dies with asset 404s ("Importing a module script failed").
- The transcript of a hibernated session loads as a skeleton with zero
  overflow for several seconds; wait for `sh > ch + 500` before instrumenting.
- Periodic whole-body markdown re-renders (`chat-md` subtree replaced, hundreds
  of nodes) happen every ~40s on an open transcript. They did not move the
  needle in any measurement here, but they are the loudest DOM noise in every
  event log — filter before reading.
- WebKit applies queued wheel notches over SECONDS under load (12 notches took
  19s of scroll events in one run). Time your waits by observed scroll events,
  not by when you sent the input.

## Upstream

Two WebKit behaviors here are out of contract and worth filing with the probe
output: (a) anchoring adjustments reverting programmatic `scrollTop` writes
(the spec suppresses anchoring on explicit scrolls), and (b) the user-scroll
maximum running a constant offset behind layout overflow when anchoring
adjustments are quiescent. POD-993's finding (scroller-level
`overflow-anchor:none` freezing the scrollable region) is a third face of the
same registration coupling in `ScrollAnchoringController`.
