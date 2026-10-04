# WebKit chat typing — POD-5508

Safari reproduces the reported multi-second stalls on `1aa0ec71f6`. Native WebKit sampling identifies repeated compositing-tree work as the largest named cost. Disabling permanent animations and replacing the working mark's external SVG mask both reduce it. Following the operator's static-mark direction, the product removes the animated mask and retains the still, fully lit cell. **Final acceptance is pending; the under-50 ms p95 target is not yet claimed.**

## Reproduction and data boundary

The machine is `podium-apple-runner`, Apple arm64, six cores, 10 GB, macOS 26.6.2 and Safari 26.6.2. Safari runs through Apple's `safaridriver` with a foreground automation window, 800 × 600 content viewport and device-pixel ratio 2. All application assets and data are served from an owned loopback preview on port 19678. Bun 1.4.2 and Chrome for Testing are installed only under `~/podium-5508`; no global installation is changed.

The input is POD-5501's validated synthetic corpus, seed 4443. The 1× corpus contains 4,867 issues and 4,304 sessions; 4× contains 19,468 issues and 17,216 sessions. Semantic SHA-256:

- 1×: `2458ea73e0e6182b8f67ae7b0aa618e882fcb60bc9dd9eaf5778e42e1261363e`
- 4×: `b6ad3a359fa48bd74c113577bd43484507e2acc0ce08cb81843a8296a94cf82a`

Member-state keys are remapped to the isolated harness member. A generated control session adds a 4,400-item transcript, including 1,600 Bash calls and their results, Markdown and code blocks. Its initial tail mounts 200 transcript rows and 2,542 transcript DOM elements. The measured 1× view has approximately 4,500 DOM elements and 23 working-mark animations. This is an operator-size *data* corpus with a bounded visible roster, not the operator's private expanded mission DOM. No live issue, session, transcript, cookie or draft from the operator is transferred to the runner.

The original production arm is `1aa0ec71f6`. The first composer-fixed arm is POD-5506 source `92b3b5fe35`; later combined acceptance uses its landed source `1140016cea` and pilot `51f59c6f34`. Build-version stamps in copied preview assets describe their build checkout, so source provenance is recorded separately. Composer, hooks and ChatView ownership was coordinated by issue mail; this issue changes the shared working-mark assets and CSS.

## Collector and interpretation

`apps/web/harness/webkit-typing.py` uses the W3C native keyboard path and requires exactly 60 trusted input events and an intact final value. It records each input's event timestamp, `performance.now()` at dispatch, the next `requestAnimationFrame`, and a zero-delay timer posted from that frame. The reported latency is **input timestamp → post-frame timer**, the requested paint proxy; Safari has neither Event Timing nor Long Tasks. A separate recursive 4 ms timeout records timer drift. Drift includes rendering, JavaScript, scheduling and timer coalescing; it is not a JavaScript-only duration.

The early W3C `actions` arm requests a 100 ms pause after each character, but Safari adds keyboard tick overhead: even the fast ablation delivers characters about 306 ms apart. Those rows establish the original stall and same-method causal comparisons. Later captures send one native character against each 100 ms deadline through the local driver; actual event intervals remain in every raw JSON file. Delayed delivery is reported rather than silently treated as 100 ms pacing. The foreground state, focus, viewport, motion count, DOM count and device scale accompany each capture. Background-timer-throttled, unmounted, interrupted and overloaded-host attempts are excluded from acceptance.

Raw evidence includes trusted input samples, every drift tick, CSS ablation text, source revision, native trace export and its stack attribution. The trace is collected separately from clean timing: a sampler changes timing and must not supply acceptance numbers.

## Original and causal measurements

Each row contains 60 characters at 1×. Values are median / p95 / maximum in milliseconds. These exploratory captures precede the final quiet-host paired acceptance.

| Production arm / throwaway switch | Input → post-frame timer | Drift p95 / max | Keyboard method |
| --- | ---: | ---: | --- |
| Original `1aa0ec71f6` | 285 / 2,416 / 35,325 | 142 / 30,368 | actions |
| Original, all CSS animations/transitions stopped | 162 / 329 / 813 | 69 / 744 | actions |
| Original, only mark animation stopped | 233 / 947 / 1,853 | 148 / 1,667 | actions |
| Composer fixes `92b3b5fe35`, original SVG masks | 46 / 471 / 1,815 | 40 / 3,698 | actions |
| Same composer, identical moving mask changed to PNG | 46 / 195 / 471 | 38 / 565 | actions |
| Same composer, all CSS animations/transitions stopped | 20 / 61 / 288 | 9 / 472 | actions |
| Same composer, bounded PNG cell, animated mask position | 28 / 78 / 794 | 43 / 508 | send-keys |
| Same composer, static marks and stopped status spinner | 28 / 58 / 213 | 31 / 331 | send-keys |

SVG → PNG alone cuts p95 **58.6%** with the same mask geometry, transform, DOM and keyboard method. Stopping all animation after the composer fixes cuts p95 **87.0%**. These changes overlap; savings must not be added. The composer fix accounts for separate React and textarea amplifiers, described in [POD-5506's report](POD-5506-chat-composer.md).

Removing composer shadows/filters did not establish an additional cause (static marks: p95 58 ms; additionally removing composer effects: 70 ms). Local feed/composer containment produced one 38 ms result but was inconsistent and was not adopted. Chrome's separate matched experiment also found no gain from those local rules. The existing pilot mission-root containment comes from POD-5506's independent paint proof.

## Native WebKit cause ranking

`xctrace record --template 'Time Profiler' --attach <owned-WebContent-PID>` records the actual Safari WebContent process during the native-key capture. The 40-second trace is exported with the `time-profile` table to XML. Reference-aware stack decoding in the attached analyzer accounts for 18,311 sampled main-thread milliseconds, including 200 ms with unavailable stacks. Percentages below are exclusive *sample attribution*, not instrumented event durations or an additive per-key budget.

| Named cost | Sampled main-thread time | Share |
| --- | ---: | ---: |
| Compositing | 8,087 ms | 44.16% |
| Layout | 2,397 ms | 13.09% |
| Paint | 1,436 ms | 7.84% |
| Identified script | 773 ms | 4.22% |
| Style / SVG resource | 684 ms | 3.74% |
| Other / unsymbolized native and script work | 4,627 ms | 25.27% |
| Unavailable stack | 200 ms | 1.09% |
| Idle / wait | 107 ms | 0.58% |

1. **Animated external SVG mask invalidation.** `LegacyRenderSVGModelObject::styleDidChange` and SVG resource invalidation run inside repeated rendering updates. The exact replacement of the external SVG with a raster PNG cuts the Safari tail while preserving animation. This is a WebKit-specific amplification of a shared CSS design.
2. **Compositing traversal from the tall transformed frame layers.** `RenderLayerCompositor::computeCompositingRequirements` accounts for 5,512 inclusive sampled ms; `traverseUnchangedSubtree` 2,773 ms and `updateCompositingLayers` 7,437 ms. The hierarchy is revisited while 23 masked layers, each 45 cells tall with `will-change: transform`, move every frame. Stopping the animation reduces the tail substantially. Removing the animated mask and shell status-strip transform removes this permanent update source entirely.
3. **Layout and paint over the surrounding tree.** `Page::layoutIfNeeded`, `LocalFrameViewLayoutContext::updateCompositingLayersAfterStyleChange`, style tree resolution and paint participate in the same render cycles. They are secondary measured costs, not proof that a particular shadow, backdrop filter or flex ancestor should be removed. The transcript remains 200 rows throughout the animation ablations.

Inclusive function weights overlap and must not be summed. Identified-script attribution is a lower bound because some JIT frames are unsymbolized. The startup-only trace and all-process tracing experiment are excluded from the typing attribution. An additional sampled WebContent stack dump agrees with the compositing/overlap-map path but is supporting evidence, not a timeline duration.

## Product change and regression

`WorkingMark` keeps the eight-dot SVG geometry, size-dependent radii, colour token, decorative accessibility role and phase gating. Its dots are fully lit and still at every motion preference. The additional frame span, mask CSS, transform animation, `will-change` allocation, generator and unused strip assets are removed. The shell's braille status indicator also uses one still cell. Labels and the existing once-per-second timer continue to communicate the working state.

The motion regression checks that the mark has eight circles and no animated mask, SVG animation or image layer; its existing cases retain decorative/accessibility, density and phase guarantees. Native acceptance additionally records the page's animation count. No frame timer, component render loop, new dependency or raster asset is introduced by the final change.

The fixed-size **66 × 100 APNG** prototype retained the 45-frame, 1.5-second travelling wave and eliminated the oversized CSS transform layer. Native Safari element screenshots taken 350 ms apart prove that animated image masks advance. It was not selected for shipping after the operator requested static marks; its timing during runner overload is excluded. Its generated assets and screenshots remain in the raw evidence rather than product imports.

## Acceptance and runner exclusions

Final 1× repeats, 4× measurements, matched Chrome comparison, focused flatblock check results and cleanup are pending.

At 16:43 UTC the shared runner reported load averages 294.77 / 228.72 / 123.55 during a concurrent simulator first-boot migration. The fixed-size APNG exploratory arm recorded 35 / 108 / 162 ms in that period, with foreground/focus verified; it is **excluded** from target acceptance. A newer composer capture made after Chrome gained focus is also excluded from drift attribution because its timer samples show background throttling. The urgent iPhone investigation received the runner lease; both this issue's browsers were parked at `about:blank` and its trace recorder was stopped.

Only recorded, verified owned process IDs are stopped. After the coordinator requested full runner cleanup, the Safari/WebContent/GPU/networking cohort, safaridriver, previews, evidence server, Chrome and its helpers were stopped; no simulator was booted by this issue. A follow-up owned-process scan recorded the remaining Chrome PIDs before terminating them. The runner's current load was 5.25 at 17:00 UTC. Stalled local SSH connections were stopped only after their commands, worktree paths and parent chains were recorded and verified. Operator server and daemon processes, existing simulator state, system installations and live data are outside the fixture.

Tests, scoped typecheck and lint run foreground only in `flatblock:~/podium-test-5508` with its copied `.toolchain`. Landing is restricted to `integrate/4286-pilot` under its merge mutex.
