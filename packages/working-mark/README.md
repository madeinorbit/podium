# @podium/working-mark

The animated working mark: 44 dot designs and one component that draws them the cheapest way measured for the
browser it runs in (POD-5558; numbers in `docs/measurements/POD-5558-working-mark-spike.md`, "The final table").

```tsx
import { tetra } from '@podium/working-mark/designs'
import { WorkingMark } from '@podium/working-mark/react'

<WorkingMark design={tetra} size={12} className="pod-mark" />   // drawn in the element's CSS `color`
```

Plain DOM: `createWorkingMark(tetra, { size: 12 }).element`. Every design, for pickers and galleries:
`import { allDesigns, designGroups } from '@podium/working-mark/all'`.

**What ships.** Designs are separate named exports built on first use, and the package is `sideEffects: false`, so
an app that imports `tetra` ships only the tetrahedron: about 4 KB gzipped with the runtime, against 10.5 KB for all
44 (Vite build, measured; `test/treeshake.test.ts` keeps it so). Importing `/all` pulls in every design.

**How it draws (`method`).**

| Method | Where | What |
|---|---|---|
| `auto` (default) | every browser | `image` |
| `image` | every browser | One animated PNG per design, size, frame rate, colour and pixel density, built in the page; every mark of a design shows it. The browser steps it by itself and leaves it idle off screen, in skipped `content-visibility` rows and under `display: none`. No visibility logic, and immune to WebKit's frozen-animation bug. |
| `canvas` | WebKit (Safari, the Mac app, iOS); elsewhere it falls back to `image` | One canvas per design painted into every mark (`-webkit-canvas()`), redrawn only when the picture changes and only while a mark is in view. Same cost as `image` at 12–15 fps; flat with many marks. |
| `still` | everywhere | The resting picture. |

`workingMarkMethods()` lists the methods worth offering in the current browser.

**Frame rate (`fps`).** Default 15: with 32 marks it costs Safari +11 to +14 points of one core over static marks and
Chrome +13 to +14, flat to 256 marks, typing at static's level. `fps={30}` is smoother and costs Safari about a third
more. `fps="smooth"` uses the design's own lowest smooth rate (20–40).

**Motion off.** Reduced motion shows the resting picture. `pauseWorkingMarksWhenIdle({ idleMs: 5000 })` (call once at
start-up; it returns a stop function) shows it after 5 s without input and while the window is unfocused or hidden:
paused marks cost what static marks cost. `setWorkingMarksPaused(on)` does it by hand.

**Colour.** The colour is baked into the image. A theme switch through `<html>`'s `class`, `data-theme` or `style`, or
the system colour scheme, redraws the marks on its own; after any other change call `refreshWorkingMarks()`.
