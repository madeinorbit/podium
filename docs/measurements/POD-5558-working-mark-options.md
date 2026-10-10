# Working mark measured options

**Status: one real Mac browser pass complete; none of the four options qualifies.**
Safari and headed Chrome measurements and eight short sampled recordings are attached
to POD-5558 for the operator through POD-4286. All four options exceed the requested
near-static CPU bar on at least one browser. No animation has been selected or shipped.
Production keeps the static mark. Mac desktop WebKit, iOS WebKit, native phone and
Safari visibility/resumption qualification remain pending.

The first software-renderer comparisons were captured on 2026-10-04 UTC; the real
Mac browser comparisons below were captured on 2026-10-05 UTC. The fixture source is
`acf07461fc`; both Mac browsers served exactly the same HTML SHA256:
`aa7c6462a8e47c5f17e898f537ef68275f96f773328bf834acef4c8bb18ab1a1`.

## Visual candidates

| Option | Motion | Animated rendering object | Asset cost |
| --- | --- | --- | ---: |
| Static baseline | Current fully lit eight dots | None; exact shipped SVG geometry | Existing |
| A: soft pulse | All eight dots gently brighten together, 1.8 s | Opacity of one plain element; dots painted once as radial gradients | CSS only |
| B: single highlight | One bright dot travels through the eight positions, 1.5 s | Transform of one plain circular pseudo-element; stationary gradient grid | CSS only |
| C: APNG wave | Original travelling wave, 45 frames / 1.5 s | One decoded animated image | 24–26 KB per size/colour |
| D: WebP wave | Same wave and timing as C | One decoded animated image | 13–14 KB per size/colour |

The raster options are 32 × 48 pixels, lossless, generated from the original opacity and
scale curves. The preview shows small, medium, badge and large marks on dark and light
surfaces. Size-specific optical radii are retained. All animations are declarative;
there is no requestAnimationFrame loop, visibility observer, scroll handler or custom
geometry cache in the candidate rendering code.

Reduced motion disables both CSS animations. Image candidates use a `<picture>` source
for a still resource, rather than hiding a resource that continues decoding. The manual
preview toggle also replaces the image source. Chrome now verifies the actual media
query, still resource selection and identical frames through both visibility returns.
Other engines and live preference changes still need observation.

## Real Mac browser comparison, 2026-10-05

**None of the four demonstrates CPU within a few percent of static on both engines.**
A is closest to static in Safari, but its added CPU is still about 25% of its adjacent
static baseline. It adds about 612% in headed Chrome. The other options also exceed
the bar. These are measurements of the current prototypes, not a claim that every
possible opacity, transform or image technique must have the same cost.

| Option | Safari CPU | Safari added CPU | Safari typing p95 | Chrome CPU | Chrome added CPU | Chrome typing p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Static baseline | 1.81% | — | 15.0 ms | 0.78% | — | 14.8 ms |
| A: soft pulse | 2.34% | +0.47 pp | 14.0 ms | 5.24% | +4.50 pp | 19.1 ms |
| B: single highlight | 5.34% | +3.45 pp | 15.0 ms | 5.15% | +4.39 pp | 22.8 ms |
| C: APNG wave | 4.81% | +2.94 pp | 15.0 ms | 4.32% | +2.82 pp | 18.3 ms |
| D: WebP wave | 4.61% | +2.87 pp | 15.0 ms | 4.92% | +3.30 pp | 21.1 ms |

CPU is percent of one core for the identified fixture WebContent/renderer process;
`pp` means percentage points. Candidate deltas use the mean of the immediately
preceding and following static arms. The static row reports medians of five arms,
not the candidate-specific brackets. Relative CPU increases for A/B/C/D are
25/182/157/164% in Safari and 612/577/188/203% in Chrome.

Each browser ran **one valid pass** in the same order:
static → A → static → B → static → C → static → D → static.
Each arm measured 20 seconds of idle CPU and 60 trusted keyboard input events,
checking the entire resulting text. All 32 marks were fully visible and the composer
was focused. No screenshots, WebDriver calls, recurring probes or timing timers ran
during idle. The input-to-rAF-to-post-frame-timer p95 is a paint proxy; it is not
physical display latency or full-application typing latency.

The runner is a six-core arm64 Mac VM, macOS 26.6.2 / Darwin 25G83. Safari is 26.6.2;
Chrome for Testing and its matching driver are 154.0.8037.92, running headed.
Both used 12 CSS-pixel marks, DPR 2 and 800 CSS-pixel viewport width. Safari's
viewport was 800 × 600; Chrome's was **800 × 538**, the native window-manager cap
on this runner's available screen. Both displayed all 32 marks. This height difference
is retained explicitly; comparisons are matched to static within each browser,
rather than claiming identical browser viewport heights.

Chrome's diagnostics, taken after all timing, report **hardware-accelerated
compositing and rasterization**. Its renderer is
`ANGLE (Apple, ANGLE Metal Renderer: Apple Paravirtual device, Unspecified Version)`.
This is an accelerated virtual GPU, not the earlier Linux software-renderer lane.
It does not prove that an individual candidate was compositor-only; no layer trace
was taken. Browser UI, GPU process and render-server CPU are outside the reported
page-process metric.

Safari's static CPU range was 1.71–1.97%, with run p95 values 11–16 ms. Chrome's
static CPU range was 0.69–2.25%, with run p95 values 5.8–15.9 ms. The elevated fourth
Chrome static arm is retained. Post-idle one-minute host loads ranged 2.29–3.94 in
Safari and 2.56–5.83 in Chrome. One candidate arm per engine cannot estimate a
confidence interval; frame phase and host variation also affect typing p95. No
successful candidate arm was repeated, as the coordinator requested one pass only.

### Attribution, excluded setup attempts and recordings

Safari first opened multiple owned WebContent processes, so a single-new-PID guard
refused attribution before timing. The next attempt sampled a spare process that
exited during its initial static arm; that arm is invalid and excluded. No candidate
was timed in either attempt. The corrected collector checks the automation app's
responsibility ownership and uses a controlled 500 ms CPU burst in the fixture to
identify its exact page process. The burst is **outside timing**, followed by a
three-second warm-up. Its observed 0.50–0.51 CPU seconds also checks the Mac counter
conversion. The page PID is checked again after idle. Chrome uses the same attribution
probe within its private-profile renderer descendants. Mac cumulative CPU counters
are converted from Mach time units before dividing by monotonic wall time.
[Apple XNU CPU accounting](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/bsd_kern.c)

Two headed Chrome setup attempts stopped before timing because native viewport/focus
guards failed. The final pass used the explicit native height and foreground window
activation. One setup cleanup predicate initially matched command arguments containing
the private app path, including a root SSH wrapper. Those signals failed with EPERM;
no unowned process was stopped. The predicate now matches the private executable
prefix and profile token, and a focused real-process regression verified that it
preserves both an unrelated profile and a command that merely mentions the bundle.
Excluded setup records are retained separately from the nine valid arms per engine.

Eight approximately 2.5-second MP4 clips show A/B/C/D in each native browser. They
are sampled WebDriver screenshots encoded at the observed capture intervals, about
5–8 captured frames per second. They illustrate appearance, not display-frame-rate
performance. The captures and Chrome GPU diagnostics happened after the timing pass.
Original PNGs, frame timestamps/hashes, nine arm records, native window records and
cleanup proof are preserved in `matched-20261005-all.tar.gz`. The self-contained
`working-mark-mac-comparison.html` embeds the table and all eight clips.

## Earlier Chrome software-renderer comparison

This is **headless Chromium 153.0.8010.12 on flatblock**, with renderer arguments showing
`--disable-gpu-compositing`. It measures a software fallback, not normal GPU-composited
Chrome. It cannot establish that either CSS option is compositor-only on Safari or a
hardware Chrome window. No candidate meets the near-static cost bar in this lane.

The isolated fixture has 32 fully visible marks, 800 × 600 CSS viewport, DPR 2 and a
focused native textarea. CPU is cumulative CPU time of the three recorded renderer PIDs
862025 / 862036 / 862038 divided by 20 seconds of monotonic wall time, as a percentage of
one core. This includes the actual fixture renderer; it excludes browser/GPU processes.
During idle there are no driver calls, recurring probes, screenshots or timing timers.

Each typing arm delivers exactly 60 trusted input events at at least 100 ms intervals,
without catching up delayed replies, and checks the complete resulting text. Latency
is event timestamp → requestAnimationFrame → zero-delay post-frame timer, a paint proxy.
It is not a direct physical display measurement. Static arms bracket every candidate;
the second repeat reverses the order.

| Option | Retained arms | Median idle CPU | CPU range | Added CPU vs static | Median run typing p95 | Run p95 range |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Static | 13 | 0.55% | 0.40–1.50% | — | 3.6 ms | 2.4–12.1 ms |
| A: soft pulse | 2 | 7.35% | 6.10–8.60% | +6.80 percentage points | 18.0 ms | 17.8–18.1 ms |
| B: single highlight | 2 | 5.05% | 4.95–5.15% | +4.50 percentage points | 17.6 ms | 15.6–19.6 ms |
| C: APNG | 3 | 5.60% | 5.15–6.54% | +5.05 percentage points | 12.3 ms | 11.5–16.8 ms |
| D: WebP | 3 | 5.25% | 5.20–7.70% | +4.70 percentage points | 17.2 ms | 16.4–17.9 ms |

The table reports the median of retained run p95 values, not a pooled event percentile.
Ranges expose variation; two CSS repeats are insufficient for final qualification.
The synthetic fixture isolates marks and does not certify full-application typing.

### Exclusions

The first collector incorrectly attributed CPU to internal Chrome WebUI PID 862025.
Its CPU readings are invalid, explicitly excluded, and retained with an exclusion note.
The comparison above was recaptured using the full recorded renderer cohort.

POD-5513 announced a concurrent 60–90 s build at 22:05:56 UTC. Conservatively, arms
overlapping 22:05:56–22:07:26 are excluded: repeat 2 signal, repeat 2 soft pulse, and
repeat 2 static orders 7 and 9. The exact build completion has not been confirmed, so
even retained values are preliminary rather than a certified quiet-host acceptance.
Raw samples, process arguments, exact asset sizes and host loads are preserved in gzip.

## Platform visibility observations

Five corrected 10-second off-screen arms used 512 mounted marks inside
`content-visibility:auto` rows, positioned 20,000 px below the viewport. Each arm
asserted that all 512 child marks report skipped before warming and timing. Renderer CPU was:

| Off-screen candidate | Idle CPU, one arm |
| --- | ---: |
| Static | 0.30% |
| A: soft pulse | 0.60% |
| B: single highlight | 1.00% |
| C: APNG | 0.50% |
| D: WebP | 0.40% |

These are software-renderer observations, one arm per option, not hardware qualification.
The corrected idle intervals ran at 23:04:43–23:05:50 UTC, after POD-5513's announced
23:03:42–23:04:12 preparation interval. The earlier diagnostic values were
0.30 / 1.10 / 0.90 / 0.40 / 0.40%, but their visibility query is invalid: it checked the
containment element itself. `checkVisibility({contentVisibilityAuto:true})` tests skipped
ancestors, so the corrected collector checks the child mark after rendering settlement,
then warms again before CPU timing.
[CSSOM View draft, checkVisibility](https://drafts.csswg.org/cssom-view/#dom-element-checkvisibility)

The separate normal-motion boundary probe keeps the same 32 mark nodes while toggling
only the ancestor CSS state. All 32 children report skipped during both off-screen
containment and `display:none`, and zero report skipped after returning. It captures
three element PNGs 400 ms apart while visible: each animated candidate has three
different hashes initially and after both returns; static has one identical hash in
each sequence. Node identity is unchanged throughout. This establishes Chrome skipped rendering
and visible resumption without destroying/recreating the animation nodes. It does not
measure the hidden image decoder's internal clock or expose an invisible CSS timeline.

CSS containment specifies that animations inside skipped content do not advance, but
the shipping engines must be observed. A WebKit report describes CSS animation staying
frozen after returning into view on Safari 18.6/26.0; the runner's newer Safari 26.6.2
must be checked for resumption, not assumed to fix it.
[CSS Containment draft](https://drafts.csswg.org/css-contain-2/#skips-its-contents),
[WebKit issue 301745](https://bugs.webkit.org/show_bug.cgi?id=301745)

The follow-up measured 32 marks with their ancestor `display:none`, and separately
32 fully visible marks under Chrome's actual reduced-motion media preference. These
were one 10-second arm each, with the same three owned renderer processes:

| Candidate | `display:none` CPU | Reduced-motion visible CPU |
| --- | ---: | ---: |
| Static | 0.40% | 0.40% |
| A: soft pulse | 1.10% | 0.30% |
| B: single highlight | 0.50% | 0.30% |
| C: APNG | 0.40% | 0.30% |
| D: WebP | 0.80% | 0.20% |

All hidden arms asserted 32 skipped children. All reduced-motion arms asserted the
real media query matched; none used the manual preview override. The separate
reduced-motion probe then kept the same 32 nodes through both hiding methods: CSS
animation names were `none`, APNG/WebP selected their still resource, and all three
frame hashes were identical initially and after each return. All 25 candidate/state
assertions passed. These short Linux CPU samples have 0.1-percentage-point resolution;
differences below the static arm do not establish a benefit. They do not expose
invisible CSS/image clocks or qualify normal hardware rendering.

Native viewport culling and Safari/iOS resumption are not established. The real Mac
browser visible costs are measured above; their off-screen costs remain unqualified.
Hidden/collapsed rows and platform containment remain the intended controls; no product
visibility logic is proposed.

## Existing techniques and dependencies

Motion's small browser animation API uses native Web Animations and recommends
transform/opacity for hardware acceleration. It wraps the same browser path as these
CSS candidates; it does not add a WebKit visibility guarantee. A dependency has no
demonstrated advantage for this repeating decorative mark.
[Motion performance guide](https://motion.dev/docs/performance),
[Motion animate](https://motion.dev/docs/animate)

Native phone is a separate implementation boundary. React Native's native animation
driver avoids JavaScript on each frame, but the installed implementation uses a
main-thread CADisplayLink to advance active animations. Clipped view removal does not
by itself prove clocks stop. The current native image implementation also uses a
display link. These paths cannot be labelled zero-cost from their APIs alone.
[React Native Animated](https://reactnative.dev/docs/animated),
[React Native VirtualizedList](https://reactnative.dev/docs/virtualizedlist)

Expo Image supports APNG/WebP through SDWebImage on iOS, but is not a current dependency.
SDAnimatedImageView's visibility check covers hidden/alpha/window/superview state,
not intersection with a clipped scroll viewport. Adding it does not establish the
user's visibility requirement.
[Expo Image](https://docs.expo.dev/versions/latest/sdk/image/),
[SDAnimatedImageView source](https://github.com/SDWebImage/SDWebImage/blob/master/SDWebImage/Core/SDAnimatedImageView.m)

Core Animation can animate a layer's already-rendered contents and properties without
per-frame application drawing. A native layer opacity/highlight or decoded bitmap
keyframe prototype is a plausible dependency-free technique, but its application and
render-server cost and off-screen culling have not been measured. No native winner is
claimed or wired into production.
[Apple Core Animation guide](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/CoreAnimation_guide/Introduction/Introduction.html)

## Runner, validation and shipping state

Earlier Mac attempts were blocked by high load, SSH stalls and SafariDriver account
authorization. The operator enabled SafariDriver before the resumed lane on October 5.
Those earlier failures produced no accepted Mac performance data. All runner files,
Chrome for Testing and its driver are inside `/Users/admin/podium-5558`; nothing was
installed globally. The successful Safari pass ended at 10:36:17 UTC and the successful
headed Chrome pass ended at 11:14:57 UTC. A fresh handoff proof at 11:29:55 found no
private Chrome process or automation Safari process, and both owned ports refused
connections. All owned browser, driver and preview processes are stopped. The Mac
lease is no longer held; its TTL expired after cleanup, so the later release request
reported `NOT HELD`. No further run or polling is scheduled.

The checkout ran `bun run setup:worktree` with Bun 1.4.2 before work and committed WIP
early. The flatblock clone is `~/podium-test-5558`, with a copied `.toolchain` and its
own checkout-local frozen install. Original collector/capture files passed focused
foreground Python compilation and Biome checks there. Later collector changes were
compiled foreground on flatblock after concrete startup/attribution failures. The
final two-file batch also verified real OS cleanup: it stopped its recorded private
profile control, preserved a foreign profile and a process merely mentioning the
bundle path, then reaped all three recorded controls. That batch exited zero.
No production TypeScript changed, so no broad test/typecheck/lint sweep or application
build was run. This final report and review package are documentation/evidence only
and need no additional runtime gate.

The real Safari pass used helper revision `d3114b6589`; headed Chrome used
`23862a4c27`. The final helper hashes are:

- `working-mark-bench.py`: `335ad861e85a5c8b0783aa96c5c8efb8295139e8b77e6bf9e041e1b752f3deed`.
- `working-mark-run.py`: `71c9b499e40ba39c804bdf985635871e9e817b91cb791cf8c8ed5d80bfd305c7`.

Older Linux visibility/reduced-motion runs and ownership failures are retained in the
earlier attached archives. The browser was parked before the later handoff. An earlier
39-second lease/process overlap was disclosed to POD-5501 for exclusion if its capture
had already started. Both flatblock leases and all owned flatblock processes are clear.

The issue branch contains candidate fixtures, collectors and reports only. Nothing
has been landed. The only authorized landing target is `integrate/4286-pilot`, after
operator selection and the remaining qualification, focused validation and a confirmed
acquired merge mutex, through an ancestry-checked atomic fast-forward `update-ref`.
Neither `main` nor `dev/mw` is a landing target.

## Review evidence

Attached to POD-5558:

- Self-contained `working-mark-options.html`: all options, real sizes, themes and motion toggle.
- `working-mark-options.webm`: short recording cycling through each option.
- Individual A/B/C/D screenshots and the all-options dark view.
- This report and a compressed evidence archive, including excluded attempts and cleanup.
- A Chrome return-to-view frame gallery and compressed same-node/skip samples.

The new native comparison HTML, eight MP4 clips and compressed Mac source records
are also attached. No current option has qualified for shipping; the operator has not
selected one. Safari/iOS visibility and actual desktop/phone qualification remain open.
No preview control selects or changes the production mark.
