# POD-1239 — what the first paint actually carries

The eager source budget went red on `main` (7,694,486 against a 7,650,000 ceiling)
and failed every web build regardless of the change being built. The note at that
ceiling said the next move had to be a paydown rather than another raise, so this
is the measurement that paydown was chosen from — kept because the next cut should
not have to start by taking it again.

## The method

`scripts/web-bundle-budget.ts` sums `sourcesContent` — ORIGINAL source text,
comments included — for every chunk `index.html` references. So the number prices
what a browser must parse before it can paint, and prices house style along with
it. To break it down by owner:

```
bun run --filter @podium/web build      # writes apps/web/dist + its .map files
```

then read `apps/web/dist/assets/*.js.map` for the chunks named in `index.html`,
summing `Buffer.byteLength(sourcesContent[i])` per source and grouping by path.
The build's own report prints the total, the eager file list, and the named
guards; this doc is the same data grouped one level finer.

## What was paid down

Three surfaces that cannot be reached without a gesture were in the eager graph:

| surface | eager because | now |
| --- | --- | --- |
| `IssueContextMenu` | `worklist/UnifiedIssueRow` imported it for every row | `lazy()` on right-click |
| `NewIssueDialog` | `worklist/SidebarRail` imported it | `lazy()` on the `+` |
| `NewIssueDialog` | `worklist/spawn-row` imported it | `lazy()` on the menu item |

`lib/SessionContextMenu` was already deferred exactly this way; these were the two
call sites that had been missed. Measured at `fcbfb2d5c`, with and without:

| budget | before | after | paid down |
| --- | --- | --- | --- |
| eager source | 7,694,486 | 7,560,932 | −133,554 |
| eager raw | 2,192,060 | 2,152,070 | −39,990 |
| eager gzip | 657,037 | 646,516 | −10,521 |
| eager Brotli | 545,626 | 537,763 | −7,863 |

`src/features/issues` in the eager graph went 125,650 → 31,669; the remainder is
the icons, menu surfaces and base-ui pieces those three dragged with them.

The source ceiling went DOWN with it, 7,650,000 → 7,600,000 — the first move down
in this ratchet's history — and `INTERACTION_ONLY_MODULES` in the budget script
now fails the build by name if one of the three returns to the eager graph, so the
next breach names an import edge instead of a byte count.

## What the first paint still carries

Measured after the paydown (7,560,932 total), grouped by owner:

| bytes | owner |
| --- | --- |
| 1,412,830 | `packages/client-core/src` |
| 583,055 | `@base-ui/react` |
| 545,403 | `react-dom` |
| 493,478 | `packages/model/src` |
| 487,375 | `src/features/chat` |
| 391,455 | `packages/protocol/src` |
| 345,535 | `motion-dom` |
| 322,582 | `packages/sync/src` |
| 289,441 | `@xterm/xterm` |
| 281,573 | `src/features/worklist` |
| 149,362 | `zod` |
| 146,216 | `src/features/terminal` |
| 137,961 | `packages/terminal-client/src` |
| 112,144 | `framer-motion` |
| 105,606 | `tailwind-merge` |
| 104,325 | `@dnd-kit/core` |
| 101,972 | `dompurify` |
| 100,856 | `@xterm/addon-webgl` |

Three candidates for the next cut, in the order their argument is easiest to make:

1. **The terminal renderer — 390k** (`@xterm/xterm` + `@xterm/addon-webgl`, plus
   the 138k of `terminal-client` around them). `packages/terminal-client/src/terminal-view.ts`
   imports both at module scope, and `AgentPanel` reaches it through
   `@podium/terminal-client-react` — so the renderer is parsed before any pane has
   shown a terminal, including sessions that open straight into chat. The WebGL
   addon alone (100k) is the cheapest half: `tryLoadWebgl()` already treats it as
   optional and falls back to the DOM renderer, so a dynamic import there changes
   only WHEN the GPU path attaches. Watch the ordering note in `wireRefOverlay` —
   the underline layer is deliberately mounted after the WebGL canvas.
2. **Markdown — 144k** (`dompurify` + `marked`). Needed by the transcript on first
   paint, so this one needs a real answer rather than a `lazy()`, but 144k for two
   libraries is worth an answer.
3. **Drag and drop — 124k** (`@dnd-kit/core` + `/sortable`, via `app/Workspace`).
   A drag cannot precede a pointer down; the obstacle is that `DndContext` wraps
   the tab strip at render time, so deferring means splitting the provider.

Each is a bigger cut than the whole of POD-1239.
