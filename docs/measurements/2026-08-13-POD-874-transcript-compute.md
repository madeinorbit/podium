# POD-874 transcript compute measurement

Date: 2026-08-13

## Baseline

This measurement was taken after POD-845/POD-846 and the current chat changes,
before moving any transcript work. It uses the source modules directly under Bun
with repeated warm samples per case; the reported values are medians and p95s in
milliseconds. The transcript inputs are synthetic but exercise the same loaded
window limits used by the clients.

| Case | Median | p95 |
| --- | ---: | ---: |
| Pair tool results + build rows, 1,000 loaded items | 1.69 | 2.16 |
| Search 1,000 loaded items | 0.67 | 3.57 |
| `marked.parse`, 112 ordinary messages from that window | 12.11 | 26.02 |
| `marked.parse`, 300 rich messages (heading, emphasis, link, list, table) | 54.77 | 86.78 |
| `marked.lexer`, 300 rich messages | 43.79 | 99.60 |
| `marked.lexer`, 10 rich messages (native visible window) | 1.05 | 2.06 |

The shaping and search paths are below a frame budget in isolation. Rich web
Markdown parsing crosses it by a wide margin, so it is material on the browser
UI thread. Mobile parses a virtualized ten-message window in about 1 ms; that is
not material enough to justify a new native worker boundary. Mobile still gets a
bounded token cache and avoids repeating transcript shaping when only the query
changes.

## Resulting boundary

The shared `@podium/client-core/viewmodels` `computeTranscript` contract now
produces paired blocks, rows, and search state from one immutable input. Web
requests that contract through one module worker and receives unsafe cached HTML
keyed by source Markdown. The worker keeps an index for search-only requests and
bounds its mirrored Markdown cache at 2,048 sources; search-only requests send
only the query and cursor after the initial index transfer, while later index
updates return only newly parsed Markdown rather than cloning the full cache.
The client preserves block/row identity when only the query or cursor changes,
including in hosts where Worker construction is unavailable. Streaming Markdown
is quiet-edge debounced so superseded token partials do not fill the shared queue.

The browser remains responsible for the security and interaction boundary:
`DOMPurify`, file/ref linkification, external-link targeting, click dispatch, and
DOM insertion all stay on the main thread. Worker HTML is never inserted without
the main-thread `sanitizeRenderedMarkdown` pass.

Mobile uses the same shared shaping contract behind a `WeakMap` indexed by the
immutable item snapshot and verbosity, plus a 256-entry Markdown-token LRU. Its
search remains synchronous because the measured native search window is below the
materiality threshold; no worker/native dependency is added for that path.
