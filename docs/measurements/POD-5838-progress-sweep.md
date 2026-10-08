# Progress sweep visibility

The row progress sheen now pauses outside the sidebar's scrollable viewport and
in hidden documents. Static progress segments, colours, widths, labels and reduced
motion remain available. A computing row with no underway segment mounts no
sheen. Visible sweeps retain the original `translateX(-100%)` to
`translateX(100%)`, 1.6-second duration and `ease-in-out` timing.

One `IntersectionObserver` and one visibility listener serve the mounted sweeps
in each document. They observe stationary run segments, rather than the moving
sheen, and write only animation play state. There are no new timers, per-frame
JavaScript callbacks or React visibility updates. Pause/resume retains the CSS
animation's phase. The last unmount disconnects observation and removes the
listener. Webviews without `IntersectionObserver` retain visible motion and
still pause in hidden documents.

## Measured suspension

Measured on **flatblock, 2026-10-08**, in isolated headless Chromium
**156.0.8078.4**, at 1600 × 1000. The fixture bundles the actual production
`RowProgressMeter` before (`54019d214a`) and after (`9af3ba25f0`), with their
respective motion styles. It renders two meters in a 100px scroll container.
The meter layout and theme colours are supplied by fixture CSS; there is no
backend, incoming traffic, mark animation or JavaScript animation loop.

Scrolling the container clips both stationary run segments. Separate untraced
30-second windows measure GPU-process CPU through Chromium's process counters
and renderer `Compositor` thread CPU through Linux thread ticks. Percentages are
relative to **one core**, and GPU-process CPU is CPU time, not GPU utilization.

| Both meters clipped | Seconds | GPU-process CPU | Compositor CPU |
| --- | ---: | ---: | ---: |
| Original | 30.008 | 3.60% | 4.17% |
| Visibility suspension | 30.012 | 0.17% | 0.10% |
| Original restored | 30.016 | 3.13% | 3.43% |

Independent ten-second traces count native frame events. Rates below are
normalized to a minute; these are not sixty-second captures or display FPS.
The old clipped component still schedules begin frames even though clipping
prevents drawing. Suspending the fixed component removes that work. Scrolling
the fixed meters back into view resumes their original motion.

| Trace state | Seconds | BeginFrame count | BeginFrame/minute | DrawFrame count |
| --- | ---: | ---: | ---: | ---: |
| Original visible | 10.034 | 609 | 3642 | 579 |
| Original clipped | 10.008 | 602 | 3609 | 0 |
| Fixed clipped | 10.032 | 0 | 0 | 0 |
| Fixed visible again | 10.007 | 602 | 3609 | 593 |

Both fixed animation clocks stay at **1033.287 ms** throughout the untraced
and traced clipped windows, then advance after scrolling back. A pixel comparison
at an identical 400ms animation phase is **byte-identical** before and after;
keyframes, easing, widths and accessible labels also agree.

## Scope and validation

The [count-only summary](POD-5838-progress-sweep-summary.json) retains all seven
accepted windows and animation-state observations. The collector is attached to
the issue. An initial diagnostic run was discarded because the pixel probe's
Web Animations `play()` call overrode CSS suspension. The accepted run recreates
the page after the pixel comparison and refuses to measure a fixed clipped
animation unless its actual animation state is paused.

Headless Chromium reports the fixture visible even after opening another tab;
that action is not claimed as a hidden-tab measurement. Hidden-document handling,
mounting while hidden, edge contact, growth from zero width, shared observation,
StrictMode ref replay, cleanup and the compatibility fallback have focused
component regression coverage.

These fixture measurements establish the removal of unnecessary compositing
work. They do not quantify a whole-app CPU saving or attribute macOS
`kernel_task`. Visible animations still consume CPU. The original live production
attribution remains in [the idle CPU report](POD-4286-idle-cpu.md).

Final checks on flatblock at product candidate `9af3ba25f0`:

- `bun run test`: **lean gate green**, including full cached typecheck and the
  span-effect, interaction-scan, private-API, untracked-read and clock-read gates.
  The interaction scan reports **zero ratchet errors**. The lean gate runs four
  of 1857 collected files, not the whole suite.
- `bun run test:file -- apps/web/src/features/worklist/row-progress-sweep.test.tsx
  apps/web/src/features/worklist/SidebarUnified.progress.test.tsx`: the six new
  sweep cases pass. The six existing sidebar cases fail before row rendering
  because `mock-screen-pool.ts` rejects `worklist.view`. The fixture and its
  `pool-sidebar.tsx` consumer are unchanged from the baseline. This independent
  fixture repair is filed as **POD-5853**, with a discovered-from link.
- `bun run speed:structural`, under `meter:flatblock`: **30 cases pass**, seven
  skipped by the lane's standard filter, across all three named files. Peak
  observed worker RSS is 6300 MiB, within the census exception.
- `bun run --cwd apps/web build`: normal production build succeeds.

Only sweep components/styles, focused sweep tests and this evidence change in
the issue branch. The working-mark lane remains separate.
