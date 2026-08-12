# Lazy web surface bundle report

Both measurements are production `@podium/web` builds from this worktree. The baseline was built
before source edits. Raw sizes are filesystem bytes; gzip uses zlib level 9; Brotli uses quality 11.
The eager graph is the entry script plus every JavaScript `modulepreload` emitted into `index.html`.
Precache bytes are the raw sizes of every URL in Workbox's generated `precacheAndRoute` manifest.

## Bundle sizes

| Reading | Baseline | Lazy surfaces | Delta |
| --- | ---: | ---: | ---: |
| Main chunk, raw | 2,897,127 B | 1,558,977 B | -1,338,150 B (-46.2%) |
| Main chunk, gzip | 834,969 B | 454,260 B | -380,709 B (-45.6%) |
| Main chunk, Brotli | 663,675 B | 366,520 B | -297,155 B (-44.8%) |
| Full eager JS graph, raw | 2,897,127 B | 2,319,834 B | -577,293 B (-19.9%) |
| Full eager JS graph, gzip | 834,969 B | 687,115 B | -147,854 B (-17.7%) |
| Full eager JS graph, Brotli | 663,675 B | 568,949 B | -94,726 B (-14.3%) |

The final eager graph contains 17 chunks because Rolldown extracted shared dependencies and emitted
them as module preloads. Reporting only the smaller entry chunk would therefore overstate the startup
reduction; the full eager-graph line is the honest cold-start comparison.

## Parsed eager sources

The baseline entry source map contained all of the requested cold surfaces:

| Surface family | Baseline source entries | Baseline parsed source bytes | Final eager entry module |
| --- | ---: | ---: | --- |
| Settings | 21 | 235,917 B | absent |
| Usage | 2 | 35,681 B | `UsageView` absent; shared `useUsageFeed` remains for the status strip |
| Automations | 6 | 76,958 B | absent |
| Issues | 59 | 507,479 B | `IssuesView` absent; shared issue chrome/models remain |
| Workflows | 7 | 57,547 B | absent |
| Merge queue | 2 | 23,460 B | panel absent |
| Messages | 2 | 8,976 B | panel absent |
| Superagent | 2 | 16,644 B | panel absent |
| Git | 4 | 40,509 B | panel absent |
| Files | 2 | 11,924 B | right-dock tree absent |
| Motion demo | 1 | 4,909 B | absent |
| Flight Deck | 1 | 107,602 B | open deck absent; folded bar remains eager |
| Command Palette | 1 | 32,202 B | palette absent; 895-byte activation boundary remains |

Final source-map inspection also confirms `AgentPanel` (54,460 source bytes) and `DockShellPanel`
(8,917 source bytes) remain eager. Their xterm mount, warm-set, chat/native, and attach paths were not
deferred or edited.

## Install and update bytes

| Reading | Baseline | Lazy surfaces | Delta |
| --- | ---: | ---: | ---: |
| Workbox entries | 52 | 86 | +34 |
| Workbox precache bytes | 5,957,419 B | 5,979,353 B | +21,934 B (+0.37%) |

The Workbox configuration and glob remain unchanged, so the new async chunks are still precached.
Installed-PWA offline cold-start semantics are preserved: this change reduces the browser's eager
evaluation graph, but intentionally does not make cold surfaces network-only or reduce install/update
payloads.

## Boundary behavior

- Settings and Usage use inset-sheet fallbacks with the same dialog titles and close behavior.
- Secondary routes and dock panels reserve their existing flexible region while loading.
- Each non-terminal right-dock tool has its own async entry; the Shell panel stays eager.
- Flight Deck is deferred only while folded, matching its existing unmount lifecycle.
- Command Palette loads on first open and remains mounted afterward so task/repository child flows
  survive the palette dialog closing.
- MotionDemo loads only on the existing `?e2e=1&motion-demo=1` branch.
