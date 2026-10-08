# Working mark style work

The current `integrate/4286-pilot` source already removes the measured
`podium-mark-frames` path. POD-5508 landed that product fix at `e7ba535149`,
including the removal commit `53d141c1f6`; both are ancestors of this issue's
checkout. This issue adds a reproducible counter collector and evidence, with
**no further product change**. The operator's installed production build is
outside this verification; this report does not mean it has been updated.

The existing fix preserves the eight-dot geometry, size-dependent dot radii,
working colour, decorative accessibility behavior and caller-owned working-state
gating. Labels and the ticking timer still indicate work. The mark itself is
fully lit and static, following POD-5508's previously accepted product decision.
It owns no frame span, animated mask, keyframes, `will-change` allocation or
JavaScript animation clock. Consequently hidden and offscreen marks also own
no perpetual animation. POD-5558 owns the operator's selection of a future
animated replacement; this issue does not choose or introduce one.

## Original live proof

POD-5504's report and count-only companion summary are retained on its branch
at `8ff46fd2a3` as `docs/measurements/POD-4286-idle-cpu.md` and
`docs/measurements/POD-4286-idle-cpu-summary.json`. These captures used production
NEW `44809b1850` on ludovico, connected to the operator's live backend, with
CPU sampling and timeline recording disabled. Only the four
`podium-mark-frames` animations were paused and restored; the two progress
sweeps and status-strip animation continued running.

| Connected idle arm | Style recalculations | Style time (ms) | Incoming messages | Total Chromium CPU (% of one core) | Main busy (%) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Running | 1,262 | 606.885 | 213 | 44.78 | 27.77 |
| Marks paused | 804 | 224.832 | 203 | 34.07 | 19.21 |
| Restored | 1,219 | 609.287 | 185 | 36.06 | 19.43 |

Each connected window lasted approximately 60 seconds. The repeatable
named-path reduction is **382.053–384.455 ms of style work per minute**, about
0.64% of one core in task-time terms. The 10.71-point first total-CPU difference
includes changing script/input work and is not an isolated mark saving.
Restored total CPU is 1.99 points above paused and main busy is 0.22 points
above; varying live row contents prevent precise allocation even though the
paused window received more messages than restored. The same animation also
runs in PREVIOUS `1082520`.

## Isolated mark reproduction

The new collector imports the current `WorkingMark` and server-renders its
actual markup. It also extracts and imports NEW's exact historical component,
motion CSS and three SVG mask strips from Git. A private ephemeral loopback
server serves only these public source assets and four synthetic Working rows;
it has no backend proxy, credential or live operator data. The page receives
no React updates or messages.

One Chromium context runs four sequential 60-second arms after three seconds
of settling each: legacy running, the same animations paused, restored, then
the current component and stylesheet. `Performance.getMetrics` boundaries
record style/layout/script/task durations and style counts without a CPU
profiler or trace recorder. Animation time and visible mark/dot counts are
checked outside those boundaries. All four marks must be visible; each retains
eight circles. Paused animation times must hold and running times must advance.

Collected on ludovico on 2026-10-08 using headless Chromium **148.0.7778.96**,
1600 × 1000, with reduced motion disabled. Current component/CSS provenance is
`d3d67cf8e1`; historical provenance is `44809b1850`. The
[count-only companion](POD-5844-working-mark-style-summary.json) retains the
metric boundaries and animation-state checks.

| Isolated arm | Seconds | Running / paused animations | Style recalculations | Style time (ms) | Browser main-task time (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Legacy running | 60.031 | 4 / 0 | 0 | 0 | 169.415 |
| Legacy paused | 60.005 | 0 / 4 | 0 | 0 | 1.057 |
| Legacy restored | 60.004 | 4 / 0 | 1 | 0.219 | 59.345 |
| Current static | 60.004 | 0 / 0 | 0 | 0 | 0.595 |

All arms record zero layout and script duration. Running animation clocks
advance for the full window; paused clocks hold. All arms retain four visible
marks and 32 circles. The legacy arms have **zero recurring style work**, with
one isolated recalculation in the restored window. Thus this fixture does
**not** reproduce the live
application's style-duration reduction. It demonstrates that the strip can
advance without recorded style work in this small Chromium document; it does
not establish that the strip is free in the app or on WebKit. The live
disable/restore evidence remains the attribution proof. The current static
component has zero mark animations, so the named periodic source is absent.
Main-task duration includes other browser work and is not a total-process CPU
measurement. Its two running readings differ substantially, so this report
does not assign a precise main-task saving to the strip either.

The legacy mark already had `contain: strict`, a translated HTML strip and
`will-change: transform`. Recommending those same declarations would not be a
new fix. The original strip is 45 cells tall and advances in 45 steps over
1.5 seconds through an external SVG mask. The discrepancy between isolated and
live measurements leaves the exact surrounding invalidation mechanism
unresolved; no compositor-only guarantee is inferred from the CSS. POD-5558
received this finding so future candidates can be measured in the application
context as well as in a small fixture. Progress-sweep GPU cost stays in
POD-5838.

## Reproduction and validation

From a checkout with Bun matching `mise.toml` and checkout-local dependencies:

```sh
bun run setup:worktree
mkdir -p .artifacts/POD-5844
bun apps/web/harness/working-mark-style.tsx \
  --output .artifacts/POD-5844/working-mark-style.json
```

An installed Playwright Chromium is required. `--marks`, `--window` and
`--legacy-ref` may override the defaults of 4, 60 seconds and `44809b1850`.
The collector closes its own browser and server and deletes its temporary
historical module. It never touches an operator process or installed app.

Validation consists of source/ancestry verification and the sequential browser
counter capture. Product tests, typecheck and the lean gate are skipped:
this issue changes only measurement documentation and an opt-in collector,
with no application imports, build entrypoints or product behavior changed.
Existing product regression coverage remains in
`apps/web/src/lib/motion/motion.test.tsx` and the native/mobile-web mark tests;
this issue does not claim to have rerun those tests.
