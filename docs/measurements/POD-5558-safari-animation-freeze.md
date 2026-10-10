# Safari freezes animations that come back from hiding (POD-5558)

As of 2026-10-08: Safari 26.6.2 (WebKit 7624.5.1.11.3) on macOS 26.6.2, on the Mac runner. The Podium Mac
app uses the same system WebKit. Evidence is window screenshots taken through SafariDriver. Window shots are
UI-process snapshots, so they show what the GPU draws. Element screenshots are painted in the web process,
which doesn't show transforms accurately (WebKit bug 242215). Each table cell is one probe mark: moving, or
frozen across four shots about 130 ms apart.

## What freezes

| Hide path, then show again | Script-started animation (`element.animate`) | CSS animation |
|---|---|---|
| Ancestor of an iframe set to `display: none` (Podium's `PanelDeck` hiding a tab with an HTML file in a sandboxed `srcdoc` iframe) | transform frozen, opacity keeps running | transform frozen, opacity keeps running |
| Ancestor in the same page set to `display: none` (Podium's hidden tabs) | stops completely | restarts from 0 and runs |
| `content-visibility: auto`, scrolled away and back (WebKit bug 301745) | stops completely | stops completely |
| `content-visibility: hidden`, then visible | stops completely | stops completely |
| Switching browser tabs, minimising the window | fine | fine |

The first row is what the operator saw: the design gallery open as a tab in the Mac app kept fading but stopped
moving after they switched away and back.

## What revives them

| Re-sync on the animation | Revives all four freezes |
|---|---|
| `a.currentTime = a.currentTime` | yes |
| `a.effect.updateTiming({})` | yes |
| `a.effect.setKeyframes(a.effect.getKeyframes())` | yes (heavier) |
| `a.startTime = a.startTime` | no |
| `a.pause(); a.play()` | no (the play cancels the still-pending pause) |

The trigger is one shared `IntersectionObserver` on every mark. When a mark comes back into view, the observer
re-seeks that mark's own animations. It fired on all three hide paths, including inside the hidden iframe.

Keep each mark's list of animations rather than calling `getAnimations()` in the callback. `getAnimations()`
flushes style, and interleaving it with the re-seeks cost one full style recalculation per mark. In the gallery,
with about 250 marks, a single tab switch took 70–90 s that way.

Results with a control arm (the same page with the observer removed):

| Scenario | Without the re-sync | With it |
|---|---|---|
| Gallery in a hidden pane (srcdoc iframe), 3 runs × 3 move-only marks | 0 of 9 moving | 9 of 9 moving |
| Gallery view switch (same-page `display: none`), 2 runs × 3 marks | 0 of 6 moving | 6 of 6 moving |
| `content-visibility: auto` scroll round trip, 6 animation shapes | 0 of 6 moving | 6 of 6 moving (`currentTime` and `updateTiming` alike) |

## Cost

Re-sending an animation to the GPU isn't free.

- In the gallery, showing the cards view again kept Safari busy for about 3 s without the re-sync and about
  4.4 s with it (two runs each, timed as three animation frames after the show).
  - The page has about 1,750 animations of 120 keyframes each. Only the marks in view (several hundred
    animations) were re-sent.
  - Two runs is too few for a per-animation cost.
- The app shows dozens of marks, not hundreds.
- The spike measures this with the chosen design, the real mark count and fewer keyframes.

## Where it comes from (WebKit 26.6.2 source)

- Opacity reaches Core Animation as one plain animation. Transforms go as animation groups that are rebuilt on
  every update (`GraphicsLayerCA.cpp` 3444–3655). Layer moves carry only the groups. This fits the iframe case,
  where transforms freeze and opacity survives.
- Skipped `content-visibility` content isn't composited (`RenderLayerCompositor.cpp` 3293–3297). The skip
  bookkeeping covers only CSS animations (`WebAnimation.cpp` 1941–1950).
- Setting `currentTime` reaches `animationDidChangeTimingProperties`, queues `UpdateProperties`, and rebuilds the
  layer animations (`KeyframeEffect.cpp` 2370–2427).
- Related WebKit bugs:
  - 301745: `content-visibility`; open.
  - 311329: `display: none` restarts; fixed in main as d39bde2caea5, but not in 26.6.2.
  - I found no WebKit bug for the iframe case.

## Reproduce

Serve `apps/web/harness/` over http. Then:

- **Same-page cases:** open `safari-animation-freeze-probe.html` and use its buttons.
- **Hidden-pane iframe case:** open `safari-animation-freeze-host.html`.

In the probe, rows N0–N5 show the freeze. N1–N5 come back when you press "Nudge"; N6 and N7 re-sync
themselves.

Not yet checked: the Mac app itself (same WebKit and the same hide path, but not run there), and Chrome (not tested
for these freezes).
