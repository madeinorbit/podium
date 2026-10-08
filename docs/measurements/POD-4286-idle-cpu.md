# Live idle CPU attribution

Capture in progress on ludovico, 2026-10-08. This report compares production web builds of NEW `44809b1850` and PREVIOUS `1082520` against the existing operator backend. No product fixes are included in this issue.

The measurement waits for live hydration and ten seconds of settling, then records sixty seconds of connected idle and sixty seconds with two issue switches and one session switch. Runs are sequential and interleaved; the live backend continues to change. Credentials stay in memory. Reports retain only counts, timings and function names; raw captures stay on ludovico.

The production builds and live captures are the scoped validation. Linux Chromium measurements cannot quantify macOS WebKit CPU or `kernel_task`; any GPU/compositing explanation requires its own evidence.

No causes have yet been established. A cause will be named as proven only after a disposable ablation demonstrates a repeatable reduction in idle work.

The resumed capture verifies every production dist inventory hash before loading each build. The inherited historical admission wrapper no longer matches the installed CLI, so the session holds `test:heavy` explicitly while running foreground builds and captures sequentially. A fresh browser session was interrupted during bootstrap before hydration; it supplies no idle result. The live backend health check returned HTTP 200; retry does not restart any operator process.
