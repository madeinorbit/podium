# Warm-session-cache measurement: WebGL context cap, per-terminal memory, hide/show latency

Experiment branch `experiment/webgl-warmset` (off main `ccde8c2`). **Throwaway — not for merge.**
Purpose: produce real numbers to set the parameters of a "warm session cache" (keep
recently-viewed terminals mounted, evict LRU, optionally drop the WebGL renderer when a
terminal is hidden).

## TL;DR / Recommendation

- **Hard cap on WebGL-retaining warm set: 25 live WebGL terminals** (measured, SwiftShader).
  The 26th terminal evicts the oldest context (`Too many active WebGL contexts. Oldest
  context will be lost.`). On a real GPU this cap is typically **~16** (documented Chrome
  `max active WebGL contexts` for hardware ANGLE) — so **treat ~16 as the production bound**,
  25 as the software-renderer bound. Either way the warm set must stay well under it.
- **Per-terminal JS-heap cost is ~9 MB regardless of renderer mode** (WebGL 9.6 MB, DOM/
  disposed 8.9 MB). Dropping the WebGL addon on hide saves only **~0.7 MB of JS heap** — its
  real value is **freeing 1 of the scarce ~16 GPU contexts**, which JS-heap metrics do NOT
  capture (GPU/VRAM is invisible to `performance.memory`).
- **Return-to-typeable latency:** retain = **~16.6 ms** (one frame, effectively free);
  drop-and-recreate = **~27 ms median (+11 ms), with an 80 ms+ tail** under context
  contention. DOM renderer = ~16.7 ms (same as retain).

**Decision:**

| Knob | Recommendation |
|---|---|
| Warm-set N (desktop) | **8** mounted terminals (the visible one + 7 warm). Comfortably below the ~16 hardware GPU-context cap with headroom for any other canvases the app holds. |
| Warm-set N (mobile)  | **2–3** mounted terminals. Mobile RAM is the constraint (~9 MB/terminal JS heap + GPU atlas), not contexts; keep the active + 1–2 warm. |
| Drop WebGL on hide?  | **Desktop: keep WebGL while warm** (return is free; 8 ≪ 16 contexts, no eviction risk). **Drop WebGL beyond the warm set** (i.e. an LRU terminal that ages out of the warm set but is kept mounted for state). **Mobile: drop WebGL on hide** — contexts/VRAM are scarcer and the +11 ms return penalty is acceptable on a tap-to-switch interaction. |

Rationale: retaining WebGL costs almost nothing to return from (≤1 frame) but consumes a GPU
context, of which there are only ~16. A warm set of 8 leaves 8 contexts of headroom on
desktop. Dropping the addon buys back a context for ~11 ms of extra show latency — worth it
once you exceed the warm set or on a context-constrained device, not worth it inside it.

## Environment

- **Chromium 148.0.7778.96** (Playwright-bundled), launched `headless=new`.
- WebGL: **software (SwiftShader)** — `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device
  (Subzero)), SwiftShader driver)`, WebGL 2.0. `WEBGL_debug_renderer_info` → software=true.
  WebGL **did** initialize; `WebglAddon` loaded without throwing. So context-cap and
  *relative* latency are meaningful; **absolute GPU/VRAM numbers are NOT captured** and a real
  GPU will differ (notably the context cap drops to ~16, and absolute paint times shrink).
- Terminal config mirrors `packages/terminal-client/src/terminal-view.ts`: `@xterm/xterm`
  5.5.0, `@xterm/addon-fit` 0.10.0, `@xterm/addon-webgl` 0.18.0; `scrollback:5000`,
  `fontSize:13`, Podium mono stack + theme; `WebglAddon` loaded **after** `open()` with
  `onContextLoss → dispose` (the exact Podium fallback).
- Grid **120 cols × 40 rows**, filled with **5000 lines** of realistic colored scrollback
  (SGR colors, paths, dim trace text) to match `scrollback:5000`.

## Methodology

Standalone micro-bench — **no Podium server/daemon**. `perf/webgl-warmset/harness.html`
loads the three xterm UMD bundles (vendored under `perf/webgl-warmset/vendor/`) and exposes
`window.__bench.*`. `perf/webgl-warmset/run-bench.mjs` serves the dir over a throwaway HTTP
server, drives it with Playwright Chromium, and reads JS heap two ways:
`performance.memory.usedJSHeapSize` (`--enable-precise-memory-info`) and a CDP
`Performance.getMetrics` → `JSHeapUsedSize`. Memory samples are taken after a forced
`HeapProfiler.collectGarbage`, so deltas reflect **retained** memory, not allocator slack.

Reproduce (from the **main** checkout, where node_modules + Playwright browsers live):

```
node /home/user/src/other/podium/.worktrees/webgl-measure/perf/webgl-warmset/run-bench.mjs
```

## (A) WebGL context cap — RAW

Added WebGL-backed, 5000-line terminals one at a time, each registering
`onContextLoss`, until an earlier context was evicted.

| Terminals live | WebGL OK? | Context loss? |
|---|---|---|
| 1 … 25 | yes | none |
| 26 | — | **yes — oldest (term #0) lost** |

- **Cap = 25 live WebGL terminals** (software). Console: `WARNING: Too many active WebGL
  contexts. Oldest context will be lost.` then `webglcontextlost`.
- `new WebglAddon()` / `loadAddon` never threw — eviction is silent context-loss, exactly
  what Podium's `onContextLoss → dispose` fallback handles.
- **Production bound: ~16** (Chrome's documented hardware-ANGLE max active contexts).

## (B) Per-terminal memory — RAW (steady-state, post-GC)

Per-terminal **delta** after adding each 5000-line terminal (idx 1 carries one-time
renderer/atlas fixed cost; steady-state = idx ≥ 3):

| Mode | JS heap / terminal (`performance.memory`) | CDP `JSHeapUsedSize` / terminal |
|---|---|---|
| WebGL renderer | **9.62 MB** | 1.13 MB |
| DOM renderer | **8.90 MB** | 1.11 MB |
| Addon-disposed (term kept, WebGL dropped) | **8.90 MB** | 1.12 MB |

Steady-state per-add deltas (`performance.memory`, MB):

```
WebGL    : 9.62, 9.62, 9.62, 9.61, 9.62, 9.62
DOM      : 8.90, 8.90, 8.90, 8.90, 8.89, 8.90
disposed : 8.91, 8.90, 8.90, 8.89, 8.90, 8.90
```

- **WebGL adds ~0.7 MB JS heap over DOM.** Disposing the addon returns the terminal to the
  DOM-renderer footprint (8.90 MB) — i.e. dropping WebGL reclaims that 0.7 MB **and** the GPU
  context.
- The two JS-heap meters disagree on the absolute "used" figure (`performance.memory` counts
  more), but **agree on the per-terminal delta and the WebGL≈DOM+0.7 MB relationship**.
- **GPU/VRAM is NOT in either number.** The real cost of retaining WebGL is the texture atlas
  + framebuffers in GPU memory + the context slot, none of which JS-heap metrics see. This is
  the dominant reason to drop on hide on memory-constrained devices, and it is **unmeasured
  here** (software renderer).

## (C) Return-to-typeable latency — RAW (ms, 3 runs × 12 iters, fresh terminal)

Time from `display:''` (show) to the next painted frame (`requestAnimationFrame`) after a
write + `refresh`. Lower-bounded by the ~16.6 ms rAF quantum.

| Strategy | median | trimmed mean | min | tail (max) |
|---|---|---|---|---|
| **Retain WebGL** (display:none → display) | **16.7** | 16.6 | 1.6 | 24 |
| **Drop+recreate WebGL** (dispose → new+load) | **27.1** | 29.8 | 17.7 | 88.6 |
| DOM renderer (reference) | 16.7 | 16.9 | 12.2 | 38.8 |

- Retain ≈ DOM ≈ one frame — **returning a retained terminal is effectively free.**
- Drop+recreate adds **~11 ms median (one extra frame)**, occasionally spiking past 80 ms
  while a new SwiftShader context is acquired. On a real GPU absolute times shrink but the
  rebuild-atlas + new-context penalty (the *relative* gap) remains.

## Caveats (REQUIRED)

1. **Software WebGL (SwiftShader), not a real GPU.** Context cap (25) and absolute paint
   times are software-specific. Real hardware: context cap **~16**; absolute latencies lower;
   GPU-memory cost real but **unmeasured**.
2. **JS-heap metrics exclude GPU/VRAM.** The (B) numbers undercount the true per-WebGL-terminal
   cost. The case for dropping-on-hide rests largely on the *unmeasured* GPU side (context +
   VRAM), not the measured 0.7 MB JS-heap.
3. Latency lower bound is the rAF quantum (~16.6 ms); sub-frame renderer work is invisible.
   The meaningful figure is the **delta** between strategies (~+11 ms for drop).
4. Bench is in-page xterm+addons only; it omits Podium's WS/transcript/React overhead, which
   adds per-session JS heap on top of the ~9 MB terminal cost (so real warm-set RAM is higher
   — another reason mobile N stays small).
