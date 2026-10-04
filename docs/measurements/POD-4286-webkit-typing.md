# WebKit chat typing — POD-5508

Safari reproduces the reported multi-second stalls on `1aa0ec71f6`. Native WebKit sampling identifies repeated compositing-tree work as the largest named cost. Disabling permanent animations and replacing the working mark's external SVG mask both reduce it. Following the operator's static-mark direction, the product removes the animated mask and retains the still, fully lit cell. **The 1× Safari target is met: three correctly paced repeats have p95 20, 25 and 17 ms.** The 4× stress runs have p95 51 and 39 ms, with an initial outlier described below.

## Reproduction and data boundary

The machine is `podium-apple-runner`, Apple arm64, six cores, 10 GB, macOS 26.6.2 and Safari 26.6.2. Safari runs through Apple's `safaridriver` with a foreground automation window, 800 × 600 content viewport and device-pixel ratio 2. All application assets and data are served from an owned loopback preview on port 19678. Bun 1.4.2 and Chrome for Testing are installed only under `~/podium-5508`; no global installation is changed.

The input is POD-5501's validated synthetic corpus, seed 4443. The 1× corpus contains 4,867 issues and 4,304 sessions; 4× contains 19,468 issues and 17,216 sessions. Semantic SHA-256:

- 1×: `2458ea73e0e6182b8f67ae7b0aa618e882fcb60bc9dd9eaf5778e42e1261363e`
- 4×: `b6ad3a359fa48bd74c113577bd43484507e2acc0ce08cb81843a8296a94cf82a`

Member-state keys are remapped to the isolated harness member. A generated control session adds a 4,400-item transcript, including 1,600 Bash calls and their results, Markdown and code blocks. Its initial tail mounts 200 transcript rows and 2,542 transcript DOM elements. The original 1× view has approximately 4,500 DOM elements and 23 working-mark animations; the accepted fixed view has zero working-mark animations. This is an operator-size *data* corpus with a bounded visible roster, not the operator's private expanded mission DOM. No live issue, session, transcript, cookie or draft from the operator is transferred to the runner.

The original production arm is `1aa0ec71f6`. The first composer-fixed arm is POD-5506 source `92b3b5fe35`; final combined acceptance uses source `35bdefb48f`, whose production files are byte-equivalent to the landed composer/caret/replay repair at `f9da51c7df`. This source also contains the static marks landed at `e7ba535149`. Build-version stamps in copied preview assets describe their build checkout, so source provenance is recorded separately. Composer, hooks and ChatView ownership was coordinated by issue mail; this issue changes the shared working-mark assets and CSS.

## Collector and interpretation

`apps/web/harness/webkit-typing.py` uses the W3C native keyboard path and requires exactly 60 trusted input events and an intact final value. It records each input's event timestamp, `performance.now()` at dispatch, the next `requestAnimationFrame`, and a zero-delay timer posted from that frame. The reported latency is **input timestamp → post-frame timer**, the requested paint proxy; Safari has neither Event Timing nor Long Tasks. A separate recursive 4 ms timeout records timer drift. Drift includes rendering, JavaScript, scheduling and timer coalescing; it is not a JavaScript-only duration.

The early W3C `actions` arm requests a 100 ms pause after each character, but Safari adds keyboard tick overhead: even the fast ablation delivers characters about 306 ms apart. Those rows establish the original stall and same-method causal comparisons. Later captures send one native character against each 100 ms deadline through the local driver; actual event intervals remain in every raw JSON file. Delayed delivery is reported rather than silently treated as 100 ms pacing. The final collector schedules the next native request no earlier than the next 100 ms deadline, advancing the deadline past a delayed reply rather than issuing catch-up bursts. The foreground state, focus, viewport, motion preference/count, loaded replica cardinality, DOM count and device scale accompany each capture. Background-timer-throttled, unmounted, interrupted and overloaded-host attempts are excluded from acceptance.

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

Removing composer shadows/filters did not establish an additional cause (static marks: p95 58 ms; additionally removing composer effects: 70 ms). Local feed/composer containment produced one 38 ms result but was inconsistent and was not adopted. POD-5506 reports no gain from those local rules in its separate Chrome experiment. The existing pilot mission-root containment comes from POD-5506's independent paint proof.

## Native WebKit cause ranking

`xctrace record --template 'Time Profiler' --attach <owned-WebContent-PID>` records the actual Safari WebContent process during the native-key capture. This runner exposes Time Profiler but no named Safari/WebKit template (`xctrace list templates` is retained in the raw evidence). The 40-second trace is exported with the `time-profile` table to XML; its actual WebCore stacks provide native rendering attribution, rather than a Safari Inspector event-duration breakdown. Reference-aware stack decoding in the attached analyzer accounts for 18,311 sampled main-thread milliseconds, including 200 ms with unavailable stacks. Percentages below are exclusive *sample attribution*, not instrumented event durations or an additive per-key budget.

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

1. **Animated external SVG mask invalidation.** `LegacyRenderSVGModelObject::styleDidChange` and SVG resource invalidation run inside repeated rendering updates. The exact replacement of the external SVG with a raster PNG cuts the Safari tail while preserving animation. The native WebKit SVG/resource path and the single-variable mask substitution establish this amplification in WebKit. A paired cross-engine mask comparison was not captured, so the evidence does not establish that Chrome is unaffected.
2. **Compositing traversal from the tall transformed frame layers.** `RenderLayerCompositor::computeCompositingRequirements` accounts for 5,512 inclusive sampled ms; `traverseUnchangedSubtree` 2,773 ms and `updateCompositingLayers` 7,437 ms. The hierarchy is revisited while 23 masked layers, each 45 cells tall with `will-change: transform`, move every frame. Stopping the animation reduces the tail substantially. Removing the animated mask and shell status-strip transform removes this permanent update source entirely.
3. **Layout and paint over the surrounding tree.** `Page::layoutIfNeeded`, `LocalFrameViewLayoutContext::updateCompositingLayersAfterStyleChange`, style tree resolution and paint participate in the same render cycles. They are secondary measured costs, not proof that a particular shadow, backdrop filter or flex ancestor should be removed. The transcript remains 200 rows throughout the animation ablations.

Inclusive function weights overlap and must not be summed. Identified-script attribution is a lower bound because some JIT frames are unsymbolized. The startup-only trace and all-process tracing experiment are excluded from the typing attribution. An additional sampled WebContent stack dump agrees with the compositing/overlap-map path but is supporting evidence, not a timeline duration.

## Product change and regression

`WorkingMark` keeps the eight-dot SVG geometry, size-dependent radii, colour token, decorative accessibility role and phase gating. Its dots are fully lit and still at every motion preference. The additional frame span, mask CSS, transform animation, `will-change` allocation, generator and unused strip assets are removed. The shell's braille status indicator also uses one still cell. Labels and the existing once-per-second timer continue to communicate the working state. Responsive desktop layouts use this same mark.

The mobile web client had a separate eight-circle CSS wave, while native mobile used a repeating Reanimated clock and eight animated opacity props. Both are removed under the operator's direction that marks be static everywhere. Native and mobile web retain the same geometry, tint, density ladder and accessible working label. The native mark schedules no clock or animation on mount/unmount; mobile web defines no keyframe or animation at either motion preference. This is an explicit product policy change, not a claim that desktop mask removal alone fixes the separate iPhone memory-growth issue (POD-5517).

The motion regression checks that the mark has eight circles and no animated mask, SVG animation or image layer; its existing cases retain decorative/accessibility, density and phase guarantees. Native acceptance additionally records the page's animation count. No frame timer, component render loop, new dependency or raster asset is introduced by the final change.

The fixed-size **66 × 100 APNG** prototype retained the 45-frame, 1.5-second travelling wave and eliminated the oversized CSS transform layer. Native Safari element screenshots taken 350 ms apart prove that animated image masks advance. It was not selected for shipping after the operator requested static marks; its timing during runner overload is excluded. Its generated assets and screenshots remain in the raw evidence rather than product imports.

## Acceptance and runner exclusions

The final build meets the requested **p95 < 50 ms at 1× in all three repeats**. Each contains exactly 60 trusted events and the intact final text; Safari is foreground/focused, at 800 × 600 and DPR 2, with reduced motion disabled. The selected transcript has a visible Working tail and 200 mounted rows, 2,558 transcript elements and 4,516 total DOM elements. Existing tool output changes once per second without appending rows. Working marks own zero browser animations; the only animation returned by `getAnimations()` is a finished `brief-shelf-in` entrance.

The loaded production replica contains 4,868 issues / 4,306 sessions at 1× and 19,469 / 17,218 at 4×. These include the validated corpus plus one control issue and two harness sessions. Five retired rows belonged to the old harness rather than the corpus and are removed from the new strict bootstrap; all final records pass the production decoder.

Values are median / p95 / maximum ms for input, p95 / maximum for drift and median / p95 for actual native input intervals.

| Scale / repeat | Input → post-frame timer | 4 ms drift | Actual input interval |
| --- | ---: | ---: | ---: |
| 1x-r1 | 7 / 20 / 44 | 8 / 84 | 107 / 244 |
| 1x-r2 | 7 / 25 / 131 | 8 / 109 | 107 / 245 |
| 1x-r3 | 9 / 17 / 95 | 8 / 85 | 123 / 238 |
| 4x-r1 | 14 / 51 / 437 | 15 / 16990 | 117 / 247 |
| 4x-r2 | 13 / 39 / 64 | 18 / 387 | 159 / 267 |

The first 4× run has a 437 ms first-character paint and a 16,990 ms sampler gap beginning before the first input. The second run has p95 39 ms and maximum 64 ms. These stress results remain in the evidence; the 1× target does not establish a 4× latency guarantee. Drift includes driver preparation before typing and is reported without being relabelled as JavaScript execution time.

Earlier final-build attempts at host load 17.25 / 11.89 / 10.84 produced p95 52 / 25 / 61 ms. Additional attempts used a collector that caught up delayed driver replies, delivering median intervals 59–87 ms and bursts. Both sets are excluded from paced acceptance and retained as diagnostic attempts. The accepted 1× load averages are 4.81 / 4.30 / 3.79, and actual median intervals are 107 / 107 / 123 ms.

Native Safari passes all four separate caret boundaries on the landed composer/replay repair: insertion at index 5 leaves the caret at 6; backward selection replacement leaves it at 6; authoritative external append retains 5; backward range 5–8 and its direction survive the append. An additional stale-echo probe decoded the fixture's plain HTTP response as a WebDriver response and stopped before the native clear/replay sequence. Its raw file contains zero checks and supplies no acceptance result; it is not a product failure or a passing regression test. The fixture probe decoder was corrected locally, but no further Mac lane was taken after the coordinator gave the runner to POD-5517.

## Chrome comparison

Chrome for Testing **154.0.8037.92** and its driver were installed beneath the owned runner directory. The same event/rAF/post-frame-timer and 4 ms drift instrumentation captured the original `1aa0ec71f6` application with the same 1× synthetic corpus and 200 transcript rows. These exploratory native-key captures predate the corrected pacing collector. They use headless Chrome at DPR 1, so they are not a matched browser ratio or final-build acceptance.

| Original Chrome capture | Input median / p95 / max ms | Drift p95 / max ms | Actual input interval median / p95 ms | Content viewport |
| --- | ---: | ---: | ---: | --- |
| 1× r1 | 97.2 / 299.7 / 476.2 | 117.9 / 1,105 | 44.9 / 243.2 | 800 × 544 |
| 1× r2 | 79.7 / 235.2 / 526.7 | 151.9 / 2,880.3 | 145.1 / 1,386 | 800 × 600 |

For additional context, POD-5506 reported its live Chrome original at 32.2 / 44.4 / 60 ms and composer-fixed input at 8.03 / 18.35 / 22.45 ms (frame p95 39.41 ms). Its final capture used reduced motion, and its live dataset remains on ludovico. Those numbers are independently reported context, not equivalent synthetic-runner measurements; they do not supply mask attribution. No live data was copied. Final Chrome at Safari's DPR 2 was not captured before the priority runner handoff.

## Validation and landing

The focused gate ran foreground on flatblock in the owned checkout with Bun 1.4.2 from its copied `.toolchain`: scoped web/mobile typecheck **16/16 tasks**; exact-file tests **32 cases across three files** (web motion 15, native mobile mark 14, mobile web mark 3). `biome check --write` on the changed mark sources and profiling scripts exited zero; it reported existing stylesheet specificity warnings and two non-blocking template-style suggestions in the harness. No full test suite or browser test lane ran. Both production clients built successfully.

The tested static marks were fast-forwarded onto `integrate/4286-pilot` at **`e7ba535149`**, under its canonical merge mutex, including the landed composer caret defense `d59d5e169c`. The pilot is not checked out in another worktree: landing used an ancestry-checked, expected-old-ref atomic update. Issue-tip ancestry was verified and the mutex released. Neither `main` nor `dev/mw` moved. The final collector and report are handed off for review. The Mac lane is released to POD-5517; further matched browser and stale-replay checks are outside this accepted capture.

At 16:43 UTC the shared runner reported load averages 294.77 / 228.72 / 123.55 during a concurrent simulator first-boot migration. The fixed-size APNG exploratory arm recorded 35 / 108 / 162 ms in that period, with foreground/focus verified; it is **excluded** from target acceptance. A newer composer capture made after Chrome gained focus is also excluded from drift attribution because its timer samples show background throttling. The urgent iPhone investigation received the runner lease; both this issue's browsers were parked at `about:blank` and its trace recorder was stopped.

Only recorded, verified owned process IDs are stopped. After the coordinator requested full runner cleanup, the Safari/WebContent/GPU/networking cohort, safaridriver, previews, evidence server, Chrome and its helpers were stopped; no simulator was booted by this issue. A follow-up owned-process scan recorded the remaining Chrome PIDs before terminating them. The runner's current load was 5.25 at 17:00 UTC. Stalled local SSH connections were stopped only after their commands, worktree paths and parent chains were recorded and verified. Operator server and daemon processes, existing simulator state, system installations and live data are outside the fixture.

Tests, scoped typecheck and lint run foreground only in `flatblock:~/podium-test-5508` with its copied `.toolchain`. Landing is restricted to `integrate/4286-pilot` under its merge mutex.

At 19:33 UTC, after command approval review timed out and the benchmark lease expired, cleanup verified and stopped the owned Safari automation PID 46807, WebContent PIDs 46823/47135, driver wrappers 46650/46653/46704/46705 and private preview PID 46589. The changed-command WebContent was checked again and was absent. No capture ran after 19:10. POD-5517 received the explicit cleanup handoff; its simulator and processes were untouched.

## Evidence attached to the issue

- `composer-svg-typing-samples.xml.gz`: complete native WebContent timeline export; its summary and reference-aware `analyze-trace.py` are attached separately.
- `typing-raw.tgz`: original Safari and Chrome inputs, timer ticks, throwaway CSS/JavaScript switches and source IDs.
- `final-acceptance-raw.tgz`: five accepted final typing runs, native caret observations, public-asset manifest and recorded cleanup ownership. The zero-check replay attempt is retained and explicitly excluded.
- `final-complete-raw.tgz`: accepted and excluded final attempts, runner load readings, available Instruments templates and the exact runner helpers used.
- `final-fixture-preflight.json`: validated synthetic stream counts and production decoder checks.

The reproducible collectors are `apps/web/harness/webkit-typing.py` and `webkit-caret.py`; isolated synthetic previews are `webkit-typing-server.mjs` and `webkit-local-preview.mjs`. Run the keyboard collector only against a synthetic fixture, with `--keys send-keys --viewport 800x600 --expect-working --expect-static` for final acceptance. Collect native sampling separately so profiler overhead does not enter the accepted timing runs.

The local synthetic preview PID 568532 and its harness child 568581 were also verified against this worktree and their recorded commands, then stopped; the parent cleanup left neither running.
