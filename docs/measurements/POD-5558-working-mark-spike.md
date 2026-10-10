# Working mark spike: the cheapest build of each pick (POD-5558)

As of 2026-10-08, on the Mac runner: macOS 26.6.2 in a Tart VM with a paravirtual GPU, a 1024×768-point screen at
2× (pages see `devicePixelRatio` 2) and 6 cores. Browsers: Safari 26.6.2, and Chrome for Testing 154 running headed.

- **Fixture:** `apps/web/harness/working-mark-designs-2.html?bench=1`. It shows 32 rows with a 12 px mark each, two
  columns, a focused composer, and `content-visibility: auto` on the rows like FlightDeck.
- **Collector:** `apps/web/harness/working-mark-run.py` + `working-mark-bench.py`.
- **Each arm:** 15–20 s of idle CPU, then 60 typed keys.
- **CPU:** percent of one core, for the page's process plus the processes that draw it: the browser app, its GPU
  process and WindowServer.
- **Typing:** key event → next frame → zero-delay timer, a paint proxy.
- **Baselines:** static arms run between candidate arms, and each candidate is compared with its neighbours.
- **Event listeners:** from the evening runs on, the page listens for animation events as React's root does.

## Recommendation

1. **Build the mark as a flipbook:** one moving layer per mark, every frame pre-drawn on one sheet.
   - Across the 20 picks, with 32 marks on screen, it beat the dots build in both browsers.

     | Median across the 20 picks | Flipbook | Dots |
     |---|---:|---:|
     | Safari, page process | +0.4 points | +1.4 |
     | Safari, typing p95 | 54 ms | 125 ms |
     | Chrome, all processes | +36 points | +72 |
     | Chrome, typing p95 | 19 ms | 36 ms |

   - Dots also cost far more memory, and in Safari far more CPU when off screen (finding 5 and the memory section).
2. **Keep the flipbook's frames few: a short loop, and each design at its own frame rate.**
   - In Safari, typing delay rises with the flipbook's frame count (rank correlation 0.94 over the 20 picks).
     Möbius (27 frames) had 15 ms p95 and Globe (200 frames) 104 ms.
   - WebKit also keeps about 2 KB for every keyframe of every animation, and each frame is two keyframes.
   - **Each design's own frame rate:** the lowest of 20, 24, 30 and 40 fps at which, at 12 px, no visible dot moves
     more than 0.6 px or fades more than 0.12 between frames. 4 of the 43 designs get 20, 5 get 24, 12 get 30 and
     23 stay at 40.
   - At 20 fps a 12 px dot moves at most 1.3 px from frame to frame. Chrome's added CPU drops by about a quarter with
     32 marks and by up to two thirds with 128.
   - **Frames that look the same share one cell** of the sheet, and a run of them is one hold. That helps designs
     that rest or swing back: Shuffle 80 → 52 cells, Mitosis 80 → 60.
   - **A long loop costs in proportion.** The wobbling binary pair repeats only after three orbits (4.2 s, 3× the
     plain pair's frames), because its orbit turns and rocks once per loop. Fireflies repeat after 4.8 s and move
     too fast for less than 40 fps. Shortening those loops would change how they move.
3. **Start the animations to suit each engine.**
   - **WebKit** (Safari, iPhone, the Mac app): script-started (Web Animations).
     - As flipbooks they cost about nothing hidden (+0.1 points) and off screen (+1.0).
     - On screen, CSS would cost WebKit's main thread 3–8 points more.
   - **Chrome:** one animated image (APNG) per design: about 15 points less in all than any flipbook build, and idle
     off screen and hidden (finding 8). Failing that, CSS animations kept in step by a negative `animation-delay`:
     Chrome drops them under `display: none`, where script-started ones run on its main thread.
   - **Safari's re-sync:** each mark re-syncs when it comes back into view. It revived every frozen mark measured: 6
     of 6 from a hidden pane and 6 of 6 after a scroll round trip, for both kinds.
4. **Draw the sheet as a PNG.** With 128 Globe marks, an SVG sheet cost Chrome's main thread 6–8 points and the PNG
   under 1. In Safari the two cost about the same; one PNG arm out of three read higher.

   The gallery's **Best for this browser** build, its default since 2026-10-08 21:31 UTC, applies points 1–4. It shows
   the shared PNG flipbook at each design's own frame rate, script-started in WebKit and as CSS animations in Chrome.
5. **What still costs:**
   - **WindowServer:** on this VM it adds 20–30 points once anything moves (finding 1). Real Apple hardware wasn't
     measured.
   - **Chrome and FlightDeck's rows:** Chrome renders a main-thread frame every frame while any mark animates in
     `content-visibility: auto` rows (finding 2).
   - **Chrome 154 and off-screen rows:** it runs CSS marks in skipped rows, about 2.5 points of main thread for 32
     marks (finding 6). Stopping that would need logic of our own (pausing marks on `contentvisibilityautostatechange`),
     which the brief rules out unless you choose it.
6. **Not measured:**
   - iPhone: it runs the same WebKit, so its behaviour, though not its costs, should match Safari's;
   - the Mac app itself: it uses the same WebKit as Safari;
   - Chrome on Windows;
   - Apple hardware without a VM.

## Three ways to build a mark

| Build | Moving layers per mark | What moves |
|---|---|---|
| Dots | one per dot (2–12) | each dot's `transform` (translate + scale) and `opacity` |
| Flipbook | one | every frame of the loop is pre-drawn on one sheet (an SVG background), and the sheet steps behind a clipping window |
| Shared flipbook | one | the same sheet drawn once as a bitmap (PNG) that every mark of the design shows in an `<img>` |

- **All builds:**
  - start from script with the Web Animations API, so React's `animationiteration` listeners never wake the page;
    with the gallery's CSS switch (`+css` in the bench), they run as CSS animations instead (finding 4);
  - use only linear keyframes, since `steps()` would leave Safari's GPU path;
  - animate only properties that change.
- **The flipbooks:**
  - hold each frame with a pair of equal keyframes and then jump. The jump lasts 1e-7 of the loop.
    - Until 2026-10-08 20:55 UTC it lasted 1e-4 of the loop (0.2–0.5 ms). A screen refresh that fell inside it,
      about once a second, showed the window between two cells: half of one frame and half of the next.
    - Frozen at that moment in real Safari, a mark matched neither frame (difference 15.5 against 1.1–1.3
      between neighbouring frames); with 1e-7 it shows the frame before.
    - The measurements above ran with 1e-4. The keyframe count is the same, so the cost is too.
  - use frame cells of whole CSS pixels, so nothing shimmers as they step;
  - draw frames only up to the first repeat of the picture. Six equal dots a sixth of a turn on look as they did,
    so that loop needs a sixth of the frames.
- **Each mark of the SVG flipbook paints its own copy of the sheet.** A plain bitmap `<img>` can go to the GPU as it
  is in WebKit, so the shared flipbook may need only one copy for all marks. The memory arms couldn't show whether
  it does (see Memory).
- **The three builds draw the same picture.** At 56 px, the same moment drawn by each build differs by under 1/255
  per pixel on average, in Chromium and in Playwright WebKit. That holds for all 20 picks, and also one repeat
  later in the loop for the three picks whose picture repeats.

### What each pick costs to build, optimized (2026-10-08 22:00 UTC)

The operator's 21 faves at the app's 12 px, built the cheapest way each build allows:
- **Dots** keep only the keyframes their paths need: a sample becomes a keyframe only where a straight blend would
  miss the dot by more than 0.003 em in place or size, or 0.01 in opacity.
- **Flipbooks** run at the design's own frame rate, share one cell between frames that look the same, and cut each
  cell tight to where the design ever draws, plus one device pixel for its anti-aliased edge. The space around a
  mark is layout, not pixels.

Memory per mark is the gallery's Safari estimate: 40 KB per moving dot plus 3 KB per keyframe, and 8 KB per
16 × 16 px of sheet at 2× plus 4.5 KB per flipbook keyframe. Both are fitted to the 32-mark totals in the memory
section; the 22:00 UTC re-measure checks them.

| Points | Design | Loop | Picture repeats every | Moving dots | Dot keyframes, before → now | Dots: memory per mark | Own fps | Flipbook frames | Frame at 12 px | Best build: memory per mark |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3 | Original wave | 1.5 s | — | 8 | 968 → 39 | 0.43 MB | 30 | 43 | 8×12 px | 0.51 MB |
| 3 | Binary pair, wobbling | 4.2 s | — | 2 | 242 → 96 | 0.36 MB | 30 | 124 | 11×12 px | 1.61 MB |
| 3 | Electron cloud | 2.8 s | — | 3 | 363 → 118 | 0.46 MB | 40 | 112 | 12×12 px | 1.48 MB |
| 3 | Tumbling tetrahedron | 4.0 s | 2.00 s | 4 | 484 → 162 | 0.63 MB | 30 | 60 | 12×12 px | 0.79 MB |
| 3 | Fireflies | 4.8 s | — | 3 | 363 → 193 | 0.68 MB | 40 | 192 | 14×12 px | 2.67 MB |
| 2 | Syzygy | 2.7 s | — | 3 | 363 → 119 | 0.47 MB | 40 | 108 | 14×9 px | 1.36 MB |
| 2 | Mitosis | 2.0 s | — | 4 | 644 → 116 | 0.50 MB | 40 | 60 | 12×12 px | 0.83 MB |
| 2 | Globe | 5.0 s | — | 12 | 1452 → 234 | 1.15 MB | 24 | 120 | 12×12 px | 1.58 MB |
| 2 | Shuffle | 2.0 s | — | 8 | 968 → 88 | 0.57 MB | 24 | 32 | 8×12 px | 0.38 MB |
| 1 | Binary pair | 1.4 s | — | 2 | 242 → 38 | 0.19 MB | 30 | 42 | 12×9 px | 0.51 MB |
| 1 | Halo, tumbling | 3.6 s | — | 8 | 968 → 518 | 1.83 MB | 40 | 144 | 12×12 px | 1.90 MB |
| 1 | Halo, coin flip | 2.4 s | — | 8 | 968 → 246 | 1.03 MB | 30 | 72 | 12×12 px | 0.95 MB |
| 1 | Halo of six, tumbling | 3.0 s | — | 6 | 726 → 220 | 0.88 MB | 30 | 90 | 12×12 px | 1.19 MB |
| 1 | Planet and moons | 3.6 s | — | 3 | 363 → 100 | 0.41 MB | 30 | 108 | 14×14 px | 1.60 MB |
| 1 | Black hole | 4.0 s | — | 8 | 968 → 301 | 1.19 MB | 24 | 96 | 14×9 px | 1.21 MB |
| 1 | Tatooine | 4.8 s | — | 3 | 363 → 114 | 0.45 MB | 20 | 96 | 13×8 px | 1.15 MB |
| 1 | Sunflower | 4.0 s | — | 10 | 1210 → 188 | 0.94 MB | 30 | 120 | 16×15 px | 1.93 MB |
| 1 | Knot | 3.6 s | — | 6 | 726 → 276 | 1.04 MB | 40 | 140 | 14×12 px | 1.98 MB |
| 1 | Möbius | 4.0 s | 0.67 s | 6 | 726 → 250 | 0.97 MB | 30 | 20 | 13×9 px | 0.25 MB |
| 1 | Juggler | 1.5 s | 0.50 s | 3 | 363 → 136 | 0.52 MB | 40 | 20 | 14×13 px | 0.29 MB |
| 1 | Twist | 2.4 s | 1.20 s | 8 | 968 → 122 | 0.67 MB | 20 | 24 | 8×12 px | 0.28 MB |

- **Across all 43 designs:**
  - dot keyframes fell from 38,557 to 9,038 (−77%);
  - the mean flipbook cell at 12 px fell from 256 to 154 px² (−40%).
- **The pictures don't change.** Dots, flipbook and shared flipbook still draw the same picture for all 43 designs
  at 12 and 56 px in Chromium and Playwright WebKit. The one difference over the threshold (Squircle at 56 px, mean
  1.5/255) was there before.
- **Dots now often need less memory than the flipbook,** most of all for long loops with few dots: the wobbling
  pair takes 0.36 MB against 1.61 MB.
  - They still cost more on every frame: one compositor animation per dot in Chrome (9–34% of Chrome's compositor
    thread for 32 marks), and main-thread ticks off screen in Safari (finding 5).
  - So the best build stays the flipbook.
- **The tables in the measured sections ran before these optimizations:** 40 fps, 16 × 16 px cells at 12 px, and
  121 keyframes per dot.

### Layers, frame rate and clipping

- **Dots** cost no sheet memory. Their count of moving layers is what the GPU animates.
  - 32 tetrahedron marks are 128 moving layers in Chrome; 32 globes are 384.
  - The flipbooks are 32 layers for 32 marks, whatever the design.
- **At 20 fps a flipbook needs half the frames and half the memory.**
  - At 12 px, a visible dot then moves at most 1.3 px from one frame to the next (Mitosis), and about 1 px or
    less in the other picks.
  - At 40 fps those steps are half as big.
  - Shuffle's two dots trade places at the end of the loop, which looks the same.
- **Chrome also layers the content after each moving dot** when no ancestor clips the marks. With 32 dots marks and
  no `content-visibility` on the rows, it added 31 layers of row text. The rows' `content-visibility: auto` clips
  them, as FlightDeck's do. A flipbook mark clips itself, so it never adds those layers. (Chrome's layer tree via
  the DevTools protocol, Chromium on Linux; layer decisions don't depend on the OS.)

## Findings

### 1. On this VM, anything moving costs WindowServer about 23 points of a core

Safari, all 32 marks visible, 20 s per arm. Each candidate is compared with the static arms next to it.

| Arm | Page process | WindowServer | All processes | Typing median / p95 |
|---|---:|---:|---:|---:|
| Static (×3) | 1.8–2.0% | 6.5–7.5% | 11.2–14.1% | 2 / 14–18 ms |
| Tetrahedron flipbook, 1 mark moving | 1.8% | 30.7% | 34.9% | 5 / 15 ms |
| Tetrahedron flipbook, 8 moving | 2.2% | 31.2% | 37.1% | 13 / 23 ms |
| Tetrahedron flipbook, all 32 moving | 2.1% | 30.0% | 34.8% | 47 / 85 ms |
| Tetrahedron dots, 1 moving | 2.0% | 29.7% | 34.4% | 5 / 16 ms |
| Tetrahedron dots, 8 moving | 4.0% | 33.1% | 45.6% | 25 / 81 ms |
| Tetrahedron dots, all 32 moving | 3.7% | 42.3% | 49.2% | 53 / 98 ms |

- **WindowServer:**
  - The jump comes with the first moving mark.
  - The flipbook adds nothing more as marks are added.
  - Dots add about 12 points for 32 marks (4 dots each).
  - This is the screen being composited on every frame. On this VM's paravirtual GPU that is far more expensive
    than on Apple hardware, so read it as an upper bound.
- **Typing delay:** it grows with the number of moving marks even where CPU doesn't. I read that as the VM's
  compositing throughput. On 2026-10-05 the same VM showed no typing change with 32 animated marks, and two iOS
  simulators (another lane's) have been running since 2026-10-07.

### 2. In Chrome on macOS, any IntersectionObserver or `content-visibility: auto` around running animations renders every frame on the main thread

Chrome traces from the same machine, last 3 s of each run:

| Arm (Chrome 154, macOS, headed) | Main thread | Compositor thread | Main-thread frames |
|---|---:|---:|---:|
| 1 flipbook mark, rows with `content-visibility: auto`, no observer | 2.8% | 5.7% | 119 in 3 s |
| 32 flipbook marks, rows with `content-visibility: auto`, no observer | 9.5% | 16.7% | 121 in 3 s |
| 1 flipbook mark, no `content-visibility`, no observer | **0.0%** | 6.2% | 0 |
| 32 flipbook marks, no `content-visibility`, no observer | **0.0%** | 13.4% | 0 |
| 32 flipbook marks, no `content-visibility`, re-sync observer on the marks | 12.1% | 24.3% | 123 in 3 s |
| 32 flipbook marks, no `content-visibility`, observer on an empty marker beside the moving parts | 6.6% | 11.6% | 128 in 3 s |

- Every one of those main-thread frames runs style and layout, pre-paint, `AnimationHost::TickAnimations` and
  intersection computations.
- `content-visibility: auto` is built on an internal intersection observer, so it behaves like one.
- Chromium composited every animation in all arms (`compositeFailed: 0`).
- **Consequence:** the Safari re-sync (an IntersectionObserver) now runs only on WebKit.
- **Consequence for the app:** in Chrome, a moving mark inside FlightDeck's `content-visibility: auto` rows keeps
  the main thread rendering every frame.
- **Live data agrees.** POD-5504 measured the live app on 2026-10-08, on production build 44809b1850, which still
  runs the old CSS mark animation (`podium-mark-frames`). Pausing that build's four mark animations in Chrome cut
  style recalculation from 607 to 225 ms per connected minute, and restoring them brought it back to 609 ms. GPU
  process CPU barely moved (6.2 → 6.0 → 6.5%). POD-5844 tracks that cost.
  - POD-5844 then ran the same strip in an isolated four-mark page, with no app around it. It recorded no style
    recalculation over 60 s, so the live cost comes from the app around the mark.
  - This finding is one such source: `content-visibility` rows make Chrome render every frame.
  - So is finding 4: a CSS animation wakes the page at the end of every loop while React listens for animation
    events, and marks out of step add wakes.
  - The live data doesn't separate the two.

### 3. Safari's re-sync and the rows' `content-visibility` cost Safari's page process nothing measurable per frame

In Safari, the page process stayed at 1.8–2.2% for 1 to 32 moving flipbook marks, with the re-sync observer on
and the rows' `content-visibility: auto`. That is within the static arms' range.

### 4. Chrome keeps hidden script-started animations running on the main thread; it drops hidden CSS animations

Hidden marks must cost nothing, with no visibility logic of our own (requirement 1). These arms trace the page's
main thread in Chromium 148 (Playwright, Linux, headless) for 4 s. Each has 32 tetrahedron marks, and the page
listens for animation events the way React's root does.

| Marks | Build | Script-started (Web Animations) | CSS animations |
|---|---|---:|---:|
| On screen | flipbook | 0 main-thread frames | 9 |
| On screen | dots | 0 | 5 |
| Under `display: none` | flipbook | **240** (every frame) | 0 (no animations left) |
| Under `display: none` | dots | **241** | 0 |
| Off screen in skipped `content-visibility: auto` rows | flipbook | **221** | 0 (none started) |
| Off screen in skipped `content-visibility: auto` rows | dots | **240** | 0 |

- **Script-started animations:** a hidden mark can't run on the GPU, so Chrome steps it on the main thread every
  frame.
  - That cost grows with the hidden marks: closed tabs and FlightDeck rows below the fold.
  - In a single-dot test page it came to 18–32 ms of main-thread work per second for 32 marks.
- **CSS animations:** the platform cancels them under `display: none` and never starts them in skipped rows.
- **CSS animations on screen:** they wake the main thread once at the end of each loop, because the page listens for
  animation events. React attaches every event it knows to its root, so the app listens.
  - Marks in step share those wakes: 5–10 frames in 4 s.
  - In a test page, 32 marks out of step needed 146 frames in 4 s. So CSS marks must keep a shared phase. A
    negative `animation-delay` taken from the page's clock does that.
- **The CSS build draws the same picture.** Against the script build at the same moment, all 20 picks matched in
  Chromium and in Playwright WebKit. The only differences were single frames at a frame boundary (≤ 0.6/255 mean).
- **WebKit** behaved differently in Playwright's Linux build (WebKit 26.4), with 128 single-dot animations:
  - script-started animations under `display: none` cost nothing;
  - in skipped rows they kept the page process at 27% of a core, against under 1% for static marks;
  - CSS animations in skipped rows cost 7%.

  That build draws in software, so these are only hints. Finding 5 measures real Safari and Chrome on macOS.

### 5. On the Mac, Safari wants script-started flipbook marks and Chrome wants CSS ones

32 tetrahedron marks on the runner, 15 s idle per arm, with the page listening for animation events as React's root
does. Each cell is percent of one core: the page process, then its main thread.

| Marks | Build | Safari, script-started | Safari, CSS | Chrome, script-started | Chrome, CSS |
|---|---|---:|---:|---:|---:|
| Static (neighbouring arms) | — | 1.9–2.9 / 1.0–1.7 | | 0.0–0.3 / 0.0 | |
| On screen | flipbook | 2.0 / 1.5 | 5.1 / 4.3 | 4.3 / 0.4 | 5.3 / 0.8 |
| On screen | dots | 3.9 / 3.2 | 9.8 / 9.3 | 12.8 / 0.4 | 13.8 / 1.0 |
| On screen | shared flipbook | 2.6 / 1.9 | 7.7 / 6.8 | 3.6 / 0.2 | 3.9 / 0.8 |
| Under `display: none` | flipbook | 2.0 / 1.3 | 2.4 / 1.4 | **3.2 / 1.8** | 0.5 / 0.2 |
| Under `display: none` | dots | 2.3 / 1.1 | 1.9 / 1.2 | **5.7 / 4.4** | 0.0 / 0.0 |
| Off screen in skipped rows, never shown | flipbook | 3.1 / 2.0 | 7.0 / 4.9 | **3.6 / 1.9** | **2.8 / 1.7** |
| Off screen in skipped rows, never shown | dots | **20.9 / 18.9** | 6.7 / 4.8 | **5.2 / 4.1** | **4.8 / 3.7** |

- **Safari:**
  - The script-started flipbook stays at the static level in every state: on screen, hidden and off screen (+1.0).
  - CSS costs the main thread 3–8 points more on screen. Its page wakes about as often as with script-started marks,
    so the extra work is per frame, not extra wakes.
  - Script-started dots in skipped rows cost the main thread 19 points. Each of their 128 animations seems to tick on
    every frame there.
- **Chrome:**
  - On screen (rows without `content-visibility`), CSS marks cost about the same as script-started ones: 0.4–0.6
    points more main thread, spent at the end of each loop.
  - Under `display: none`, script-started marks run on the main thread; CSS ones are dropped and cost nothing.
  - In never-shown skipped rows both cost the main thread about 2–4 points. Chromium 148 on Linux (finding 4) never
    started CSS animations there; Chrome 154 does (finding 6).
- **WindowServer** isn't in this table. Hidden and off-screen marks didn't move it.

### 6. Chrome runs an animation on the main thread when it starts on a mark that isn't drawn

Chromium 148 (Playwright, Linux) traces of the bench's skipped rows, 32 tetrahedron flipbook marks, 3 s:

| How the marks reached the skipped rows | Script-started: main-thread frames | CSS: main-thread frames |
|---|---:|---:|
| Never shown | **178** | 0 (no animations) |
| Never shown, but script read their positions (`getBoundingClientRect`) | **180** | **179** |
| Never shown, `checkVisibility()` called on them | — | 0 |
| Shown, then scrolled away | 0 | 6 |

- **An animation that starts while its mark isn't drawn can't go to the GPU.** Chrome then steps it on the main
  thread every frame.
  - That holds for every script-started mark created off screen.
  - It also holds for a CSS mark whose style script forces: reading a position computes the skipped row's style,
    which starts its animation.
- **A mark that was on screen and scrolled away costs almost nothing.** Its animation stays on the GPU.
- **For the app:** marks appear when sessions start working, often in rows below the fold or in closed tabs. As CSS
  animations they start only when their row is first drawn, but only in Chromium 148.

**Chrome 154 starts them in skipped rows anyway.** Traces of the same arms in Chrome for Testing 154 on the runner
(macOS, headed), 3 s:

| Marks (32 flipbooks) | Script-started | CSS |
|---|---:|---:|
| Static marks in skipped rows | 0 main-thread frames | 0 |
| Never shown, in skipped rows | 134 frames, main thread 3.5% busy | 116 frames, 2.5% busy |
| Under `display: none` | 120 frames, 3.1% busy | **0** |

- After the traced window, Chrome 154 reported 32 CSS animations running while all 32 marks were skipped.
- **So in Chrome 154 the platform drops hidden CSS marks but not those in off-screen `content-visibility` rows.**
  - The cost is small per mark: about 2.5 points of main thread for 32 marks, from rendering a main-thread frame
    every frame.
  - Avoiding it would take logic of our own, for example pausing marks on the platform's
    `contentvisibilityautostatechange` event.

### 7. The CSS re-sync revives Safari's frozen marks

The gallery with CSS animations, in real Safari, using window screenshots (as in the freeze doc):

| Scenario | Without the re-sync | With it |
|---|---|---|
| Gallery in a hidden pane (srcdoc iframe, pane under `display: none`), 2 runs × 3 move-only marks | 0 of 6 moving | 6 of 6 moving |
| Gallery view switch (same-page `display: none`), 2 runs × 3 marks | 6 of 6 moving (CSS restarts) | 6 of 6 moving |
| Bench rows (`content-visibility: auto`): scrolled into view, away and back, CSS flipbooks, 2 runs × 3 marks | 3 of 6 moving | 6 of 6 moving |
| The same with script-started flipbooks | 0 of 6 moving (frozen from their first appearance on) | 6 of 6 moving |

- **The re-sync for CSS marks writes a 1 µs change to the animation's delay** and reads nothing back. Setting a CSS
  animation's `currentTime` instead makes WebKit update style once per animation. In the full gallery, one hide and
  show took 84 s in Playwright WebKit that way, against 5.3 s now (5.0 s with no re-sync at all).
- In the hidden-pane runs, the four screenshots after the pane came back took about 4 s longer with the re-sync
  (7.0–7.6 s against 3.2–3.6 s). That page has hundreds of marks; the app shows dozens.

### 8. Animated images: cheapest in Chrome, dearer than the flipbook in Safari

32 tetrahedron marks on the runner, 2026-10-08 21:33–21:57 UTC. Each image was made from the flipbook's own 80 frames
(40 fps, 32 × 32 px for 12 px marks at 2×, with transparency) and shown in the flipbook's window:

| Format | Size |
|---|---:|
| APNG | 29 KB |
| Animated WebP (lossless) | 24 KB |
| Animated AVIF (AV1, colour plus alpha) | 18 KB |
| Animated SVG (SMIL `animateTransform`, discrete) | 28 KB |

Animated JPEG XL couldn't be made: this ffmpeg (6.1) encodes JPEG XL stills only. The runner's Safari 26.6 and
Chrome 154 also predate the versions that animate it.

CPU added over the neighbouring static arms, in percentage points of one core. Each cell gives the page process (its
main thread), then all processes. Typing p95 is in brackets.

| Marks | Flipbook, SVG sheet | Best build | APNG | Animated WebP | Animated AVIF | Animated SVG |
|---|---:|---:|---:|---:|---:|---:|
| Safari, on screen | +0.0 (0.2), +25 [32 ms] | +0.1 (0.2), +25 [47 ms] | +5.7 (5.0), +38 [15 ms] | +5.6 (5.1), +42 [59 ms] | +7.9 (7.0), +49 [21 ms] | +11.3 (10.0), +56 [27 ms] |
| Safari, off screen in skipped rows | — | +1.1, +4.6 | −0.8, −10.0 | −1.4, −12.6 | −1.5, −6.2 | **+6.5**, +9.5 |
| Safari, under `display: none` | — | +0.0 | +0.5 | +2.0 | −0.5 | −0.0 |
| Chrome, on screen (rows without `content-visibility`) | +5.5 (0.3), +50 [53 ms] | +7.2 (1.0), +51 [59 ms] | **+4.2 (−0.1), +35 [20 ms]** | **+4.3 (0.0), +35 [34 ms]** | +7.0 (1.1), +42 [30 ms] | failed to measure |
| Chrome, off screen in skipped rows | — | +2.7 (1.5) | −0.1 | −0.2 | +0.5 | −0.2 |
| Chrome, under `display: none` | — | +0.3 | +0.3 | −0.0 | −0.0 | −0.1 |

Here "best build" is the shared PNG flipbook, script-started in Safari and CSS in Chrome, as it stood before the
animated image.

- **Safari decodes and repaints an animated image on its main thread, frame after frame:** 5–8 points with 32 marks,
  10 for SVG. The flipbook costs it nothing there. Off screen and hidden the images idle, except animated SVG, whose
  SMIL animation keeps running off screen.
- **Chrome steps animated images by itself and draws only when a frame changes.**
  - APNG and WebP cost it about 15 points less in all than either flipbook build, with typing p95 20–34 ms against
    53–59.
  - Chrome left them idle off screen and hidden. The CSS flipbook still costs about 2.7 points in skipped rows
    (finding 6).
- **So the best build differs by engine.** The gallery's Best for this browser now gives:
  - WebKit the shared PNG flipbook, script-started;
  - Chrome one animated image (APNG) per design, size, colour and pixel density, built in the browser from the
    flipbook's own frames and holds.
- **Not measured yet:**
  - memory for the images (these arms shared one page process);
  - a repeat of the Chrome arms (one arm per format);
  - Chrome's animated-SVG arm, which failed to identify its page process.

## The 20 picks, measured

32 marks of each pick on screen, script-started animations, run on 2026-10-08 between 18:10 and 19:09 UTC.

- **Chunks:** four picks each, dots and SVG flipbook, with static arms between every two picks. Each arm is compared
  with the static arms next to it.
- **Chrome's arms** leave out the rows' `content-visibility`, so they measure the marks and not finding 2's
  main-thread frames.

Each cell gives:
- CPU added, all processes (page, browser app, GPU process, WindowServer);
- CPU added, page process;
- typing p95.

| Design | Moving layers per mark (dots) | Safari, dots | Safari, flipbook | Chrome, dots | Chrome, flipbook |
|---|---:|---:|---:|---:|---:|
| R Original wave | 8 | +37 / +3.1 / 163 ms | +24 / +0.3 / 24 ms | +75 / +23.6 / 62 ms | +47 / +5.5 / 25 ms |
| Binary pair, wobbling | 2 | +25 / +0.6 / 66 ms | +23 / +0.9 / 76 ms | +82 / +13.3 / 69 ms | +46 / +8.3 / 19 ms |
| Halo of six, tumbling | 6 | +35 / +2.2 / 107 ms | +26 / +0.2 / 93 ms | +80 / +17.1 / 37 ms | +55 / +3.0 / 19 ms |
| Syzygy | 3 | +32 / +1.3 / 92 ms | +26 / +0.7 / 44 ms | +63 / +11.3 / 24 ms | +36 / +4.3 / 18 ms |
| Electron cloud | 3 | +27 / +0.6 / 83 ms | +24 / +0.1 / 46 ms | +72 / +13.2 / 21 ms | +35 / +4.2 / 18 ms |
| Tumbling tetrahedron | 4 | +26 / +0.6 / 115 ms | +23 / +0.3 / 32 ms | +88 / +19.9 / 84 ms | +41 / +4.4 / 29 ms |
| Planet and moons | 3 | +29 / +1.3 / 66 ms | +26 / +1.1 / 67 ms | +73 / +13.6 / 21 ms | +39 / +5.1 / 18 ms |
| Black hole | 8 | +39 / +3.5 / 175 ms | +24 / +0.6 / 74 ms | +102 / +34.0 / 86 ms | +58 / +15.9 / 22 ms |
| Trojans | 5 | +28 / -0.2 / 140 ms | +26 / -0.6 / 108 ms | +71 / +17.1 / 105 ms | +38 / +6.4 / 19 ms |
| Tatooine | 3 | +26 / +0.4 / 63 ms | +28 / +0.2 / 113 ms | +66 / +12.4 / 128 ms | +46 / +9.6 / 21 ms |
| Sunflower | 10 | +35 / +1.4 / 224 ms | +16 / -0.7 / 87 ms | +82 / +25.1 / 43 ms | +34 / +4.5 / 19 ms |
| Mitosis | 4 | +24 / +0.2 / 151 ms | +14 / -1.3 / 27 ms | +52 / +13.0 / 28 ms | +31 / +3.6 / 19 ms |
| Knot | 6 | +33 / +1.8 / 122 ms | +29 / +0.7 / 60 ms | +81 / +20.5 / 35 ms | +33 / +2.7 / 24 ms |
| Möbius | 6 | +34 / +1.9 / 128 ms | +26 / +0.7 / 15 ms | +65 / +16.8 / 23 ms | +34 / +1.5 / 19 ms |
| Globe | 12 | +46 / +3.8 / 249 ms | +27 / +0.9 / 104 ms | +88 / +29.0 / 44 ms | +37 / +8.2 / 19 ms |
| Nautilus | 8 | +43 / +4.0 / 505 ms | +26 / +0.5 / 48 ms | +89 / +31.8 / 45 ms | +30 / +1.9 / 18 ms |
| Counter-spin | 6 | +26 / +0.9 / 93 ms | +20 / +0.1 / 34 ms | +44 / +9.6 / 24 ms | +26 / +2.9 / 19 ms |
| Twist | 8 | +33 / +1.8 / 162 ms | +26 / +0.9 / 29 ms | +52 / +14.4 / 20 ms | +25 / +2.7 / 16 ms |
| Shuffle | 8 | +30 / +1.6 / 185 ms | +19 / -0.2 / 35 ms | +56 / +17.2 / 33 ms | +34 / +9.4 / 18 ms |
| Fireflies | 3 | +22 / +0.3 / 66 ms | +26 / +0.5 / 108 ms | +57 / +10.0 / 24 ms | +29 / +4.0 / 18 ms |

| | Safari, dots | Safari, flipbook | Chrome, dots | Chrome, flipbook |
|---|---:|---:|---:|---:|
| All processes, median (range) | +31 (+22 to +46) | **+26** (+14 to +29) | +72 (+44 to +102) | **+36** (+25 to +58) |
| Page process, median | +1.4 | **+0.4** | +17.0 | **+4.3** |
| Typing p95, median (range) | 125 ms (63–505) | **54 ms** (15–113) | 36 ms (20–128) | **19 ms** (16–29) |
| Static arms | 9–26% all, 1.2–4.6% page, p95 8–28 ms | | 0.2–8.5% all, 0.0–8.2% page | |

- **The flipbook costs about the same for every pick.** It's one moving layer per mark, so the design doesn't
  change what the GPU does.
- **Dots cost more with more dots, much more in Chrome.** There each dot is a compositor animation:
  - Chrome's compositor thread ran at 9–34% for 32 dots marks, against 2.5–6.7% for 32 flipbooks;
  - its GPU process ran at 12–29%, against 4–10%.
- **Most of the "all processes" cost is the VM's WindowServer** (finding 1). It's the same order for every arm with
  anything moving, and it should be far smaller on real Apple hardware, which this spike couldn't measure.
- **Noise:**
  - the runner's load jumped to 8–19 during some arms;
  - Safari's Halo of six, Tatooine and Trojans pairs ran during such jumps; the table shows them measured again
    at 19:36 UTC;
  - five Chrome flipbook arms (Binary pair, Black hole, Tatooine, Globe, Shuffle) used 1.5–4.2 points of main
    thread, where the other fifteen used 0.2–0.8. Two of them ran at high load (19 and 9).
    - Measured again as CSS marks, Globe and Black hole used 0.5–0.8.
    - With 128 marks, Globe's SVG sheet cost Chrome's main thread 8 points and its PNG sheet 0.6 (the frame-rate
      and sheet section below).

### In Safari, typing delay follows the flipbook's frame count

Safari, 32 flipbook marks on screen. "Frames" are the flipbook's frames at 40 fps:

| Pick | Frames | Typing p95 | | Pick | Frames | Typing p95 |
|---|---:|---:|---|---|---:|---:|
| Möbius | 27 | 15 ms | | Knot | 144 | 60 ms |
| Twist | 48 | 29 ms | | Planet and moons | 144 | 67 ms |
| R Original wave | 60 | 24 ms | | Black hole | 160 | 74 ms |
| Mitosis | 80 | 27 ms | | Sunflower | 160 | 87 ms |
| Shuffle | 80 | 35 ms | | Trojans | 160 | 108 ms |
| Tumbling tetrahedron | 80 | 32 ms | | Binary pair, wobbling | 168 | 76 ms |
| Counter-spin | 96 | 34 ms | | Fireflies | 192 | 108 ms |
| Syzygy | 108 | 44 ms | | Tatooine | 192 | 113 ms |
| Electron cloud | 112 | 46 ms | | Globe | 200 | 104 ms |
| Halo of six, tumbling | 120 | 93 ms | | | | |
| Nautilus | 128 | 48 ms | | | | |

- **The two rise together** (rank correlation 0.94), while Safari's page process stays at the static level for all
  of them.
- **Memory and keyframes follow the frame count too.** So the work most likely lands in drawing the screen.
  - Each frame is a cell of the sheet and two keyframes.
  - Each mark's layer holds the whole sheet.
- **With 128 marks the effect grows:**

  | 128 marks, Safari | Typing p95 |
  |---|---:|
  | Möbius flipbook | 23–33 ms |
  | Globe flipbook | 344–457 ms |
  | Globe flipbook at 20 fps (half the frames) | 101–183 ms |

## Memory

### Totals with 32 marks

Each arm ran in a fresh browser session, so each footprint is a total from a clean page process: Safari's WebContent
process and Chrome's renderer, measured at the end of a 15 s idle window on 2026-10-08 at 20:14–20:28 UTC.

| 32 marks | Safari page process | Chrome renderer | Chrome GPU process |
|---|---:|---:|---:|
| Static (two runs) | 55 / 45 MB | 35 / 36 MB | 82 / 82 MB |
| Tetrahedron, dots | 93 MB | 174 MB | 157 MB |
| Tetrahedron, flipbook | 84 MB | 69 MB | 77 MB |
| Tetrahedron, shared PNG flipbook | 90 MB | 70 MB | 97 MB |
| Tetrahedron, flipbook at 20 fps | 72 MB | 54 MB | 133 MB |
| Möbius, dots | 126 MB | 244 MB | 178 MB |
| Möbius, flipbook | 63 MB | 58 MB | 130 MB |
| Globe, dots | 233 MB | 348 MB | 149 MB |
| Globe, flipbook | 156 MB | 95 MB | 111 MB |
| Globe, shared PNG flipbook | 133 MB | 83 MB | 94 MB |

- **Per mark in Safari, over static:**

  | | Dots | Flipbook |
  |---|---:|---:|
  | Möbius | 2.4 MB | 0.4 MB |
  | Tetrahedron | 1.3 MB | 1.1 MB (0.7 MB at 20 fps) |
  | Globe | 5.7 MB | 3.3 MB |

  - The flipbook takes about 17 KB per frame per mark.
  - Dots take about 3.4 KB per keyframe of each moving dot, and each dot has 121 keyframes.
  - The gallery's cost bars use these two figures.
- **Per mark in Chrome's renderer:**

  | | Dots | Flipbook |
  |---|---:|---:|
  | Möbius | 6.5 MB | 0.7 MB |
  | Tetrahedron | 4.3 MB | 1.1 MB |
  | Globe | 9.8 MB | 1.9 MB |

- **Chrome's GPU process** moved by 70–96 MB for the dots arms. For the flipbook arms it moved by −5 to +51 MB, which
  is within its noise.
- **The browser app** stayed at 76–91 MB throughout.

### Totals with 32 marks, optimized builds

The same measurement on 2026-10-08 at 21:58–22:13 UTC, after the optimizations above:
- dots with only the keyframes their paths need;
- the best build: the shared PNG flipbook at each design's own frame rate, cut tight;
- in Chrome this run still used the CSS flipbook, not the later animated image.

The runner's load was high during this run (up to 18), so its CPU numbers are not used here. Memory is the page
process; the earlier totals are in brackets.

| 32 marks | Safari, dots | Safari, best build | Chrome, dots | Chrome, best build |
|---|---:|---:|---:|---:|
| Static (two runs) | 46 / 58 MB | | 35 / 36 MB | |
| Tetrahedron | 90 MB (93) | 68 MB (flipbook 84) | 103 MB (174) | 66 MB (flipbook 69) |
| Möbius | 99 MB (126) | 55 MB (63) | 130 MB (244) | 59 MB (58) |
| Globe | 106 MB (233) | 91 MB (156) | 145 MB (348) | 76 MB (95) |
| Fireflies | 77 MB | 111 MB | 92 MB | 77 MB |
| Binary pair, wobbling | — | 85 MB | — | 76 MB |

- **Dots** take half or less of what they did, Globe most of all: 233 → 106 MB in Safari, 348 → 145 MB in Chrome.
- **The best build** saves a fifth to two fifths against the plain flipbook at 40 fps.
- **Where a loop is long and the dots are few, dots now need less memory than the flipbook in Safari:** Fireflies
  77 MB against 111.
  - They still cost more on every frame.
  - In Chrome this run's dots took 31–71 points of page process (most on its compositor thread), against 9–21 for
    the best build.

### 128 marks, and why

Footprint of the page process at the end of the idle window, 128 Globe marks (12 dots, 200 flipbook frames).
Safari and Chrome both keep the same page process across arms, and it doesn't give back what earlier arms used, so
only an arm right after a fresh process is clean:

| Arm | Before (static, fresh process) | After |
|---|---:|---:|
| Safari, dots | 43 MB | 664 MB |
| Safari, SVG flipbook | 165 MB | 536 MB |
| Chrome, dots | renderer 43 MB, GPU process 123 MB | renderer 866 MB, GPU process 226 MB |

- **That's about 4.9 MB per Globe mark as dots and 2.9 MB as a flipbook in Safari, and 6.4 MB as dots in Chrome.**
- **WebKit keeps a full style for every keyframe of every animation.** Measured in Playwright WebKit (Linux), web
  process private memory:

  | Animations × keyframes | Memory added |
  |---|---:|
  | 1,536 tiny elements, no animation | 20 MB |
  | 1,536 × 121 (dots: 120 samples per loop) | 438 MB |
  | 1,536 × 13 | 119 MB |
  | 128 × 400 (Globe flipbook at 40 fps) | 159 MB |
  | 128 × 54 (Möbius flipbook at 40 fps) | 39 MB |
  | 1,536 × 121, as CSS animations | 269 MB |

  That is roughly 2 KB per keyframe of each animation, plus about 40 KB per animation.
- **The shared PNG saved a little for the largest sheet only** (Globe: 133 against 156 MB in Safari, 83 against 95
  in Chrome). For the tetrahedron it didn't. So WebKit doesn't seem to share one bitmap across the marks' layers.

## Frame rate and sheet format

Globe, the largest sheet. CPU is points of one core added over the neighbouring static arms: all processes, then
main thread (Chrome) or page process (Safari, two runs each).

| | Chrome, 128 marks | Chrome, 32 marks (CSS) | Safari, 128 marks |
|---|---:|---:|---:|
| SVG sheet, 40 fps | +83 / +7.8 | +39 / +0.8 | +27, +36 / page +1.8, +2.7 |
| PNG sheet, 40 fps | +78 / +0.5 | +32 / +0.6 | +30, +73 / page +1.9, +17.7 |
| SVG sheet, 20 fps | +53 / +5.7 | +28 / +1.1 | +33, +35 / page +1.7, +2.8 |
| PNG sheet, 20 fps | +28 / +0.0 | +25 / +0.3 | +26, +37 / page +0.9, +2.7 |

- **Chrome draws a frame only when something changed.** Holding each picture for two display frames instead of one
  cuts its compositor, GPU and WindowServer work:
  - by about a quarter with 32 marks;
  - by up to two thirds with 128 (PNG).
- **Safari composites every display frame while anything animates,** so 20 fps barely changes its CPU. Its typing
  delay still drops (above).
- **An SVG sheet costs Chrome main-thread time at scale** (6–8 points for 128 Globe marks); a PNG sheet doesn't.
- **In Safari the two formats cost about the same.** One PNG arm (page +17.7) was far off its repeat (+1.9).

## The shortlist: Original wave and Tumbling tetrahedron (2026-10-09)

The operator narrowed the picks to two designs on 2026-10-09 and asked for every cheaper way to run them to be tried.

### Builds added for the shortlist

| Build | How it moves | Bench name |
|---|---|---|
| Sprite | every frame of the loop in order on one shared bitmap; one animation per mark with two keyframes, `steps(F)` (a second pair steps the rows when the frames don't fit one row) | `sprite` |
| Canvas drawn by a worker | one `OffscreenCanvas` per mark; one worker draws the marks that an IntersectionObserver reports in view, and only when the picture changes | `worker` |
| GIF | 30 fps, matted on the row colour (GIF has only 1-bit transparency) | `gif` |
| Video, opaque | H.264 MP4, 30 fps, matted on the row colour; plays in both engines | `mp4` |
| Video, transparent | VP9 WebM with alpha (Chrome), HEVC with alpha (Safari; written with AVFoundation on the Mac) | `webm`, `mov` |

- Every file is 32 × 32 px (a 16 px window at 2×), made from the flipbook's own frames.
- **Pause when idle** (`+idle<s>`): the marks stop after *s* seconds without a key, click, pointer move or wheel,
  and when the window loses focus or the page is hidden. They restart on the next input, focus or show.
  - Script and CSS animations are paused.
  - Videos are paused.
  - An animated image shows its still picture.
  - The worker stops drawing.
- **More marks on one screen:** with more than 32 marks, the bench's rows show only the id and the mark, so all
  256 fit in the window.
- The bench's server now answers byte-range requests: Safari plays video only from a server that does.

### Chrome 154

32 marks on screen unless noted, rows without `content-visibility` as in the earlier Chrome arms, 2026-10-09
10:25–11:15 UTC. CPU is percentage points of one core added over the neighbouring static arms, all processes; the
static arms' typing p95 was 3–17 ms.

| Tetrahedron, 30 fps | Added CPU | Of which page process | GPU process | WindowServer | Typing p95 |
|---|---:|---:|---:|---:|---:|
| Animated image built in the page (best) | +15.5, +20.2 | +2.2, +2.6 | +5.4, +7.3 | +8.1, +10.1 | 15, 16 ms |
| GIF | +17.5 | +2.5 | +6.0 | +9.3 | 16 ms |
| Sprite | +19.9 | +2.7 | +3.8 | +13.6 | 18 ms |
| Stepped flipbook | +21.4 | +2.7 | +5.0 | +13.3 | 18 ms |
| APNG file, 40 fps | +22.3 | +2.9 | +8.2 | +10.9 | 15 ms |
| Animated SVG, 40 fps | +26.7 | +6.4 (main thread +3.4) | +8.2 | +11.6 | 16 ms |
| Video, H.264 (opaque) | +41.1 | +15.4 | +9.3 | +16.1 | 25 ms |
| Video, VP9 with alpha | +55.7 | +20.9 | +25.2 | +9.3 | 24 ms |
| Canvas drawn by a worker | +73.7 | +18.0 | +39.0 | +16.7 | 6 ms |

- **The animated image stays the cheapest.** GIF is close, but it has only 1-bit transparency, so it must be matted
  on a known background.
- **Video costs Chrome 2–3 times the image.** Each `<video>` is its own player with its own decoder threads, even
  when every mark plays the same file in step. The transparent VP9 costs more than the opaque H.264, mostly in the
  GPU process.
- **The worker canvas is the dearest:** every changed frame of every canvas goes to the GPU process as a new
  picture.

**Frame rate.** The animated image redraws only when its picture changes, so a lower rate costs less. The sprite
doesn't get cheaper: Chrome's compositor ticks a running animation on every display frame.

| Added CPU | 30 fps | 20 fps | 15 fps | 12 fps |
|---|---:|---:|---:|---:|
| Tetrahedron, image | +15.5, +20.2 | +16.2 | +12.1 | +12.4 |
| Wave, image | +16.7 | | +14.9 | +13.0 |
| Tetrahedron, sprite | +19.9 | | +16.2 | +19.1 |

**Mark count.** Most of the cost is the fixed price of having anything move at all (WindowServer about 8 points,
the GPU process about 5, the compositor about 2). It grows slowly with the number of marks on screen, except for
video:

| Marks moving on screen | 1 | 8 | 32 | 64 | 128 | 256 |
|---|---:|---:|---:|---:|---:|---:|
| Tetrahedron, image | +17.0 | +16.2 | +15.5, +20.2 | +17.6 | +19.7 | +21.3 |
| Wave, image | +14.6 | +14.8 | +16.7 | +16.1 | +16.8 | +22.8 |
| Tetrahedron, sprite | | | +19.9 | +20.0 | +22.3 | +25.3 |
| Tetrahedron, video (H.264) | | | +41.1 | +54.0 | +109.9 | +221.4 |

- Typing p95 stayed at 12–18 ms for the image and 15–22 ms for the sprite at every count; with video it rose to
  40 ms at 128 marks.
- **So Chrome has no practical limit up to 256 marks on one screen** with the animated image: 256 cost about 5 points
  more than one.

**Memory** of the page process (renderer), each arm in a fresh browser session:

| Page process | 32 marks | 256 marks |
|---|---:|---:|
| Static | 35, 36 MB | 48 MB |
| APNG file / WebP file / GIF | 38 / 36 / 36 MB | |
| Animated image built in the page (best) | 49 MB | 59 MB |
| Canvas drawn by a worker | 52 MB | |
| Stepped flipbook | 62 MB | |
| Sprite | 64 MB | 87 MB |
| Video, VP9 with alpha | 69 MB | 309 MB |
| Video, H.264 | 77 MB | 358 MB |

- **Video takes about 1.0–1.2 MB per mark** even though all marks play one file: memory is per player, not per
  file. Chrome also caps a page at 1000 media players
  ([media_factory.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/renderer/media/media_factory.cc)).
- The animated image adds 11 MB for 256 marks.

**Pause when idle.** With `+idle2`, the 15 s idle window cost the same as static marks for the image, the sprite
and video (−1.5 to −0.7 points). Restarting took 1.0–6.8 ms in the page, and the first keystroke's delay was
3–7 ms (typing p95 13–20 ms). So pausing saves the whole cost while nobody is typing or pointing, and the restart
is not noticeable.

**Off screen and hidden**, everything new stays idle except the sprite: Chrome 154 still runs its CSS animation in
skipped rows (+4.9 points, finding 6).
- Chrome pauses muted autoplay video that is out of view.
- The worker draws nothing once its observer reports the marks out of view.

### Safari 26.6

32 marks on screen unless noted, 2026-10-09 12:10–13:12 UTC (SafariDriver re-enabled first; a login agent on the
runner now keeps it enabled). CPU is percentage points of one core added over the neighbouring static arms, all
processes; the static arms' typing p95 was 13–16 ms.

| Tetrahedron, 30 fps | Added CPU | Of which page process | GPU process | WindowServer | Typing p95 |
|---|---:|---:|---:|---:|---:|
| GPU flipbook (best) | +17.3, +16.8 | +0.4, −0.5 | −0.4, −0.6 | +17.7, +17.7 | 30, 19 ms |
| APNG built in the page | +23.8 | +5.1 | +4.8 | +11.4 | 14 ms |
| Sprite | +24.6 | +8.8 | +0.4 | +12.2 | 17 ms |
| GIF | +25.0 | +4.9 | +5.6 | +12.0 | 26 ms |
| Stepped flipbook | +26.5 | +14.8 | +0.2 | +9.5 | 17 ms |
| Shared canvas (`-webkit-canvas()`) | +41.8 | +8.7 | +14.3 | +15.0 | 18 ms |
| Video, VP9 with alpha | +105.8 | +8.6 | +68.8 | +26.1 | 12 ms |
| Video, H.264 | +109.8 | +7.5 | +79.5 | +20.6 | 13 ms |
| Canvas drawn by a worker | +110.5 | +18.4 | +48.4 | +29.0 | 19 ms |
| Video, HEVC with alpha | +146.9 | +10.1 | +110.6 | +23.4 | 15 ms |

- **The GPU flipbook is still the cheapest at 30 fps,** but its typing delay is the worst, and WindowServer is
  nearly all of its cost.
- **Video costs Safari the most:** each `<video>` decodes in the GPU process.
- **The builds that redraw only when the picture changes get cheaper at lower frame rates.** The GPU flipbook
  doesn't, because Safari composites every display frame while it runs.

  | Added CPU | 30 fps | 20 fps | 15 fps | 12 fps |
  |---|---:|---:|---:|---:|
  | Tetrahedron, sprite | +24.6 | +16.0 | +16.1 | +11.8 |
  | Tetrahedron, APNG | +23.8 | | +16.7 | +12.9 |
  | Tetrahedron, shared canvas | +41.8 | | +17.5 | +21.7 |
  | Wave, sprite | +27.1 | | +15.4 | +17.1 |
  | Wave, GPU flipbook | +19.3 | | | |

  At 12–15 fps the sprite and the APNG cost less than the GPU flipbook, with typing at static's level
  (14–16 ms).

**Mark count.** Typing p95 in brackets.

| Marks moving on screen | 1 | 8 | 32 | 64 | 128 | 256 |
|---|---:|---:|---:|---:|---:|---:|
| Tetrahedron, GPU flipbook | +13.5 [15] | +8.5 [19] | +17.3 [30], +16.8 [19] | +20.8 [61] | +26.4 [60] | +39.5 [133] |
| Wave, GPU flipbook | | | +19.3 [22] | +19.3 [31] | +20.8 [57] | +29.0 [71] |
| Tetrahedron, sprite | +9.1 [16] | +9.3 [14] | +24.6 [17] | +24.9 [21] | +28.2 [17] | +38.7 [40] |
| Wave, sprite | | | +27.1 [25] | +31.0 [30] | +30.4 [16] | +60.1 [23] |
| Tetrahedron, shared canvas | | | +41.8 [18] | +29.2 [14] | +26.8 [14] | +34.8 [16] |
| Tetrahedron, HEVC video | | | +146.9 [15] | +281 [11] | | |

- **The GPU flipbook's typing delay grows with the mark count** and passes 50 ms from 64 marks on.
- **The sprite's main-thread work grows with the count** (page process +9 at 32 marks, +20 at 256).
- **The shared canvas stays flat:** about +30 points and 14–16 ms typing from 64 to 256 marks, because one canvas
  per design is drawn once per frame whatever the count.

**Memory** of the page process (WebContent), each arm in a fresh Safari session; the GPU process in brackets where it
moved:

| Page process | 32 marks | 256 marks |
|---|---:|---:|
| Static | 45, 39 MB | 69 MB |
| WebP file | 45 MB | |
| APNG file | 57 MB | |
| Sprite | 58 MB | 138 MB |
| Video, H.264 | 60 MB (GPU 49) | 56 MB (GPU 432) |
| Video, HEVC with alpha | 61 MB | 81 MB (GPU 176) |
| Worker canvas | 61 MB | |
| Shared canvas | 69 MB | 108 MB |
| GPU flipbook (best) | 70 MB | 216 MB |
| Stepped flipbook | 78 MB | |
| GIF | 137 MB | |

- At 256 marks the shared canvas needs the least (+39 MB), the GPU flipbook the most of the non-video builds
  (+147 MB): WebKit keeps every keyframe of every animation.
- Video's decoders live in the GPU process: 432 MB for 256 H.264 marks.
- **GIF takes three times as much as anything else in Safari.**

**Pause when idle** (`+idle2`):
- The sprite (+3.5), the shared canvas (+1.1) and HEVC video (+1.5) idle at about static's cost.
- **The GPU flipbook did not:** +22.0 while paused (WindowServer +19.2), and the first key afterwards took 63 ms.
  WebKit keeps compositing the window at full rate for a paused GPU animation. The pause now cancels
  script-started animations in WebKit and restarts them on the shared clock; that version is measured after the
  table.

**Off screen** in skipped rows:
- The sprite costs +9.0: WebKit keeps stepping a script-started `steps()` animation on its main thread there
  (+6.3).
- Video, GIF, the worker and the shared canvas stay idle.

**Under `display: none`** every build stays idle.

## The final table: both shortlisted designs, every variant, every way to draw (2026-10-09/10)

Asked by the operator on 2026-10-09: CPU and memory for each variant of the two designs and each way to draw them, per
browser. Mac runner (macOS 26.6 VM, 6 cores), 32 marks on screen at 12 px, 800×600 window. Every cell is its own fresh
browser session: CPU added over the median of the four nearest static runs (percentage points of one core, all
processes: page, browser, GPU process, WindowServer), the page process's memory over static, typing p95 (key to
screen). Statics every 6th run.

- Pass 1 ran in priority order (Safari 2026-10-09 13:16–16:11 UTC, Chrome 16:11–18:46 UTC with a 16:18–17:02 pause
  while the host MacBook slept). Pass 2 re-ran the contenders (all but video, worker and SVG) in reverse order
  (Safari 19:11–20:33, Chrome 20:33–21:45); the 256-mark runs 18:52–19:11. Where a cell ran twice it shows the mean: one run is ±5 points, and one Safari
  static read 62. Page dd848ca99f/ab4b873763 (the builds measured didn't change between them).
- "Shorter loop" is 30 fps on the shorter loop (wave 1.2 s, tetrahedron 3 s). "Mirrored" draws half the tetrahedron's
  frames and flips the mark.
- Cells read: CPU points / page memory / typing p95. The HTML version (issue artifact "Working mark costs") colours
  them and gives the split per process on hover.

### Safari 26.6 (WebKit, as in the Mac app)

| Way to draw | Wave 30 fps | Wave 20 fps | Wave 15 fps | Wave 12 fps | Wave shorter loop | Tetra 30 fps | Tetra 20 fps | Tetra 15 fps | Tetra 12 fps | Tetra shorter loop | Tetra mirrored |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Dots | +22 / +22 MB / 19 ms | — | — | — | +22 / +33 MB / 15 ms | +20 / +36 MB / 34 ms | — | — | — | +31 / +28 MB / 28 ms | — |
| GPU flipbook | +15 / +18 MB / 18 ms | +28 / +23 MB / 26 ms | +11 / +12 MB / 14 ms | +9 / +9 MB / 13 ms | +25 / +21 MB / 18 ms | +17 / +23 MB / 20 ms | +20 / +13 MB / 25 ms | +12 / +8 MB / 16 ms | +20 / +25 MB / 17 ms | +22 / +24 MB / 24 ms | +41 / +9 MB / 17 ms |
| Stepped flipbook | +22 / +15 MB / 19 ms | +32 / +13 MB / 19 ms | +17 / +7 MB / 18 ms | +7 / +7 MB / 16 ms | +29 / +17 MB / 16 ms | +23 / +33 MB / 17 ms | +34 / +17 MB / 28 ms | +11 / +5 MB / 16 ms | +14 / +17 MB / 16 ms | +32 / +14 MB / 23 ms | +48 / +20 MB / 28 ms |
| Sprite | +19 / +10 MB / 16 ms | +26 / +2 MB / 26 ms | +12 / +8 MB / 17 ms | +9 / +6 MB / 15 ms | +24 / +8 MB / 17 ms | +18 / +19 MB / 16 ms | +22 / +16 MB / 19 ms | +18 / +19 MB / 20 ms | +12 / +19 MB / 19 ms | +20 / +9 MB / 17 ms | +32 / +18 MB / 33 ms |
| Shared canvas | +22 / +11 MB / 14 ms | +28 / +8 MB / 17 ms | +13 / +5 MB / 13 ms | +8 / +5 MB / 16 ms | +58 / +41 MB / 25 ms | +20 / +10 MB / 13 ms | +20 / +2 MB / 14 ms | +22 / +22 MB / 17 ms | +13 / +7 MB / 13 ms | +51 / +16 MB / 19 ms | +29 / +11 MB / 20 ms |
| Worker canvas | +128 / +13 MB / 23 ms | +137 / +6 MB / 22 ms | +100 / +18 MB / 25 ms | +109 / +1 MB / 15 ms | +141 / +14 MB / 17 ms | +111 / +10 MB / 27 ms | +145 / +2 MB / 41 ms | +122 / +6 MB / 19 ms | +105 / +11 MB / 17 ms | +133 / +11 MB / 46 ms | +124 / +14 MB / 51 ms |
| APNG | +20 / +15 MB / 14 ms | +18 / +34 MB / 15 ms | +11 / +7 MB / 14 ms | +8 / +22 MB / 14 ms | +25 / +25 MB / 16 ms | +21 / +17 MB / 12 ms | +39 / +24 MB / 42 ms | +14 / +6 MB / 15 ms | +14 / +12 MB / 18 ms | +27 / +16 MB / 23 ms | — |
| WebP | +20 / +17 MB / 16 ms | +23 / +6 MB / 14 ms | +13 / +5 MB / 16 ms | +10 / +11 MB / 14 ms | +33 / +37 MB / 15 ms | +16 / +19 MB / 12 ms | +22 / -3 MB / 14 ms | +11 / +2 MB / 13 ms | +13 / +6 MB / 15 ms | +26 / +33 MB / 21 ms | — |
| AVIF | +17 / +21 MB / 14 ms | +18 / +7 MB / 14 ms | +12 / +13 MB / 14 ms | +10 / +8 MB / 15 ms | +39 / +26 MB / 19 ms | +19 / +13 MB / 14 ms | +17 / -2 MB / 18 ms | +26 / +19 MB / 17 ms | +16 / +7 MB / 16 ms | +20 / +25 MB / 15 ms | — |
| GIF (matted) | +19 / +15 MB / 13 ms | +24 / +24 MB / 14 ms | +6 / +19 MB / 14 ms | +13 / +9 MB / 13 ms | +23 / +33 MB / 21 ms | +17 / +14 MB / 14 ms | +32 / -2 MB / 24 ms | +9 / +12 MB / 14 ms | +21 / +36 MB / 16 ms | +25 / +54 MB / 26 ms | — |
| Animated SVG | +46 / +58 MB / 14 ms | +41 / +21 MB / 20 ms | +52 / +46 MB / 16 ms | +30 / +29 MB / 16 ms | +51 / +23 MB / 17 ms | +43 / +29 MB / 15 ms | +82 / +114 MB / 36 ms | +86 / +100 MB / 22 ms | +40 / +66 MB / 15 ms | +44 / -5 MB / 52 ms | — |
| Video, H.264 (matted) | +142 / +19 MB / 15 ms | +232 / +13 MB / 13 ms | +89 / -3 MB / 16 ms | +101 / +3 MB / 10 ms | +266 / +21 MB / 17 ms | +138 / +7 MB / 19 ms | +186 / -5 MB / 14 ms | +146 / +6 MB / 15 ms | +85 / +7 MB / 15 ms | +223 / -4 MB / 18 ms | — |
| Video, VP9 (Safari drops the alpha: a black box) | +84 / +8 MB / 14 ms | +131 / -2 MB / 12 ms | +76 / +14 MB / 14 ms | +78 / +14 MB / 14 ms | +224 / +42 MB / 13 ms | +85 / +0 MB / 15 ms | +133 / -1 MB / 23 ms | +59 / +15 MB / 14 ms | +62 / +4 MB / 10 ms | +129 / -2 MB / 16 ms | — |
| Video, HEVC with alpha | +162 / +1 MB / 11 ms | +197 / -5 MB / 14 ms | +123 / -4 MB / 14 ms | +161 / +2 MB / 13 ms | +250 / +10 MB / 22 ms | +135 / -4 MB / 12 ms | +219 / -29 MB / 12 ms | +128 / +10 MB / 14 ms | +72 / -7 MB / 13 ms | +242 / +27 MB / 17 ms | — |
- Best (30 fps): AVIF (+18 points, +17 MB)
- Best (20 fps): AVIF (+18 points, +2 MB)
- Best (15 fps): WebP (+12 points, +3 MB)
- Best (12 fps): Shared canvas (+11 points, +6 MB)
- Best (shorter loop): Sprite (+22 points, +8 MB)

#### Safari 26.6 (WebKit, as in the Mac app): 256 marks on one screen

| Design and build | CPU, 32 marks | CPU, 256 | Page memory, 256 | Typing p95, 256 |
|---|---:|---:|---:|---:|
| Tetrahedron, APNG, 30 fps | +21 | +25 | +5 MB | 14 ms |
| Tetrahedron, WebP, 30 fps | +16 | +25 | -0 MB | 13 ms |
| Tetrahedron, AVIF, 30 fps | +19 | +26 | +5 MB | 14 ms |
| Wave, APNG, 30 fps | +20 | +29 | +24 MB | 15 ms |
| Wave, WebP, 30 fps | +20 | +26 | +6 MB | 15 ms |
| Wave, AVIF, 30 fps | +17 | +28 | +21 MB | 14 ms |
| Tetrahedron, APNG, 15 fps | +14 | +17 | +9 MB | 13 ms |
| Tetrahedron, WebP, 15 fps | +11 | +17 | +2 MB | 14 ms |
| Tetrahedron, Shared canvas, 15 fps | +22 | +19 | +17 MB | 14 ms |
| Tetrahedron, Sprite, 15 fps | +18 | +21 | +50 MB | 17 ms |
| Wave, APNG, 15 fps | +11 | +18 | +26 MB | 15 ms |
| Wave, WebP, 15 fps | +13 | +14 | +20 MB | 14 ms |
| Wave, Shared canvas, 15 fps | +13 | +23 | +2 MB | 15 ms |
| Wave, Sprite, 15 fps | +12 | +23 | +32 MB | 18 ms |

### Chrome 154

| Way to draw | Wave 30 fps | Wave 20 fps | Wave 15 fps | Wave 12 fps | Wave shorter loop | Tetra 30 fps | Tetra 20 fps | Tetra 15 fps | Tetra 12 fps | Tetra shorter loop | Tetra mirrored |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Dots | +53 / +33 MB / 22 ms | — | — | — | +38 / +36 MB / 19 ms | +36 / +33 MB / 18 ms | — | — | — | +34 / +34 MB / 18 ms | — |
| GPU flipbook | +26 / +13 MB / 17 ms | +18 / +11 MB / 16 ms | +19 / +11 MB / 17 ms | +20 / +10 MB / 18 ms | +19 / +13 MB / 17 ms | +22 / +15 MB / 16 ms | +20 / +12 MB / 17 ms | +20 / +11 MB / 19 ms | +17 / +11 MB / 17 ms | +21 / +14 MB / 18 ms | +20 / +17 MB / 18 ms |
| Stepped flipbook | +21 / +10 MB / 18 ms | +18 / +9 MB / 18 ms | +20 / +8 MB / 18 ms | +17 / +8 MB / 16 ms | +21 / +10 MB / 17 ms | +21 / +11 MB / 17 ms | +20 / +10 MB / 17 ms | +19 / +9 MB / 17 ms | +14 / +8 MB / 18 ms | +22 / +10 MB / 16 ms | +20 / +14 MB / 17 ms |
| Sprite | +22 / +13 MB / 17 ms | +18 / +11 MB / 17 ms | +18 / +10 MB / 16 ms | +16 / +8 MB / 17 ms | +20 / +11 MB / 17 ms | +19 / +13 MB / 18 ms | +19 / +11 MB / 17 ms | +20 / +10 MB / 17 ms | +19 / +9 MB / 16 ms | +19 / +12 MB / 17 ms | +20 / +14 MB / 16 ms |
| Worker canvas | +68 / +14 MB / 12 ms | +42 / +12 MB / 7 ms | +41 / +11 MB / 4 ms | +41 / +14 MB / 10 ms | +59 / +13 MB / 8 ms | +70 / +15 MB / 9 ms | +44 / +11 MB / 8 ms | +40 / +11 MB / 7 ms | +39 / +10 MB / 7 ms | +53 / +13 MB / 17 ms | +54 / +13 MB / 2 ms |
| APNG | +20 / +13 MB / 16 ms | +18 / +7 MB / 14 ms | +14 / +8 MB / 14 ms | +15 / +6 MB / 14 ms | +18 / +9 MB / 13 ms | +19 / +14 MB / 15 ms | +20 / +12 MB / 16 ms | +13 / +9 MB / 15 ms | +13 / +10 MB / 14 ms | +20 / +10 MB / 14 ms | — |
| WebP | +20 / +3 MB / 14 ms | +18 / +3 MB / 15 ms | +14 / +3 MB / 16 ms | +13 / +4 MB / 14 ms | +18 / +3 MB / 13 ms | +19 / +3 MB / 14 ms | +18 / +4 MB / 17 ms | +13 / +3 MB / 13 ms | +14 / +2 MB / 13 ms | +19 / +3 MB / 14 ms | — |
| AVIF | +21 / +6 MB / 16 ms | +17 / +6 MB / 16 ms | +15 / +6 MB / 16 ms | +14 / +6 MB / 14 ms | +18 / +6 MB / 16 ms | +18 / +8 MB / 16 ms | +19 / +5 MB / 12 ms | +15 / +6 MB / 17 ms | +12 / +7 MB / 13 ms | +18 / +5 MB / 15 ms | — |
| GIF (matted) | +20 / +4 MB / 16 ms | +20 / +3 MB / 14 ms | +14 / +4 MB / 14 ms | +13 / +3 MB / 15 ms | +19 / +3 MB / 16 ms | +20 / +3 MB / 14 ms | +18 / +2 MB / 16 ms | +15 / +2 MB / 16 ms | +12 / +4 MB / 13 ms | +17 / +3 MB / 13 ms | — |
| Animated SVG | +20 / +9 MB / 15 ms | +20 / +7 MB / 16 ms | +18 / +7 MB / 16 ms | +16 / +7 MB / 15 ms | +20 / +9 MB / 16 ms | +20 / +9 MB / 14 ms | +18 / +6 MB / 18 ms | +16 / +6 MB / 14 ms | +15 / +6 MB / 15 ms | +20 / +9 MB / 17 ms | — |
| Video, H.264 (matted) | +37 / +42 MB / 26 ms | +35 / +41 MB / 21 ms | +31 / +40 MB / 58 ms | +27 / +41 MB / 62 ms | +41 / +43 MB / 29 ms | +44 / +41 MB / 24 ms | +38 / +41 MB / 26 ms | +26 / +41 MB / 58 ms | +28 / +40 MB / 58 ms | +39 / +43 MB / 31 ms | — |
| Video, VP9 with alpha | +52 / +32 MB / 22 ms | +47 / +32 MB / 21 ms | +39 / +37 MB / 54 ms | +38 / +32 MB / 54 ms | +55 / +32 MB / 32 ms | +59 / +33 MB / 24 ms | +46 / +32 MB / 25 ms | +40 / +31 MB / 59 ms | +37 / +31 MB / 59 ms | +52 / +33 MB / 21 ms | — |
- Best (30 fps): WebP (+19 points, +3 MB)
- Best (20 fps): WebP (+18 points, +3 MB)
- Best (15 fps): WebP (+13 points, +3 MB)
- Best (12 fps): WebP (+13 points, +3 MB)
- Best (shorter loop): WebP (+18 points, +3 MB)

#### Chrome 154: 256 marks on one screen

| Design and build | CPU, 32 marks | CPU, 256 | Page memory, 256 | Typing p95, 256 |
|---|---:|---:|---:|---:|
| Tetrahedron, WebP, 30 fps | +19 | +23 | -2 MB | 15 ms |
| Tetrahedron, AVIF, 30 fps | +18 | +22 | +1 MB | 17 ms |
| Tetrahedron, GIF (matted), 30 fps | +20 | +20 | -2 MB | 17 ms |
| Wave, WebP, 30 fps | +20 | +19 | -2 MB | 13 ms |
| Wave, AVIF, 30 fps | +21 | +22 | +1 MB | 17 ms |
| Wave, GIF (matted), 30 fps | +20 | +20 | -2 MB | 17 ms |

**Pause when idle, Safari, after the fix** (pause cancels script-started animations; 2026-10-09 18:47 UTC, one session):
the paused GPU flipbook cost +0.5 points over static (running: +12.6), the paused dots +0.8; the first keys after
resuming: typing p95 19–23 ms. Before the fix the paused flipbook kept WindowServer busy (+22).

**Safari ignores VP9's alpha:** the transparent WebM plays as an opaque picture, a black box behind each mark (runner
screenshot). It's cheaper than HEVC there, but it isn't transparent; Safari's transparent video stays HEVC.

### What the table says

**Safari (and the Mac app, and iOS: all WebKit)**
- **The frame rate is the lever.** The image files, the APNG, the sprite, the flipbooks and the shared canvas cost
  +15 to +23 points at 30 fps, mostly +11 to +14 at 15 fps (single cells up to +26) and +7 to +16 at 12 fps (one
  cell +20). 20 fps measured no cheaper than 30 in either pass (unexplained).
- **The shorter loop costs the same or more** at 30 fps. **Mirroring saves frames but not CPU:** the flip is a second
  animation (+29 to +48 against +17 to +23).
- **At 256 marks the image files stay flat:** WebP +25 (30 fps) and +14 to +17 (15 fps), page memory +0 to +20 MB,
  typing 13–15 ms, the same as static. The sprite grows (+50 MB), the GPU flipbook's typing grows (133 ms, earlier
  run).
- **Out:** video (+72 to +266, every `<video>` decodes in the GPU process), the worker canvas (+100 to +145), animated
  SVG (+30 to +86, up to +114 MB).

**Chrome**
- **The image files are cheapest and the frame rate helps them:** WebP, AVIF, APNG and GIF +18 to +21 at 30 fps,
  +12 to +15 at 15 and 12 fps. WebP adds 3 MB. The flipbooks and the sprite stay at +14 to +26 whatever the rate.
- **Flat to 256 marks:** WebP, AVIF and GIF +19 to +23.
- **Out:** video (+26 to +59, typing up to 62 ms, +40 MB), the worker canvas (+39 to +70), dots (+34 to +53).

**One build for every engine: an animated WebP per design at 15 fps** (one file per colour and size: the colour is
baked in). Safari +11/+13, Chrome +13/+14 points with 32 marks; Safari +14/+17 and Chrome about +20 with 256; typing at
static's level in both; 2–6 MB. The APNG built in the page costs about the same (Safari +11/+14, Chrome +13/+14,
+7–9 MB) and takes any colour at run time. 12 fps saves a little more in Safari only, if the look holds. With pause
when idle, both drop to static's cost whenever nobody types or points.

**The gallery's Best for this browser** now picks from this table per frame rate, loop and mirror, averaging the two
designs: transparent builds only; within 3 points of the cheapest, one that stays flat with many marks, then the least
memory. It draws WebP in Chrome at every rate, and in WebKit WebP at 30, 20 and 15 fps and the shared canvas at 12.

**AVIF looked wrong in the Mac app** (operator, 2026-10-10: the tumbling tetrahedron under Best, which then drew AVIF
in WebKit). The file decodes like its source frames (ffmpeg), and Safari on the runner drew it like the WebP; the
runner is a VM that decodes AV1 in software, so a real Mac's AV1 path is the likely difference (not proven). Best
leaves AVIF out in WebKit; WebP costs the same there.
