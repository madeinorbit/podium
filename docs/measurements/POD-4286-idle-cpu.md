# Live idle CPU attribution

Capture in progress on ludovico, 2026-10-04. This report compares production web builds of NEW `44809b1850` and PREVIOUS `1082520` against the existing operator backend. No product fixes are included in this issue.

The measurement waits for live hydration and ten seconds of settling, then records sixty seconds of connected idle and sixty seconds with two issue switches and one session switch. Runs are sequential and interleaved; the live backend continues to change. Credentials stay in memory. Reports retain only counts, timings and function names; raw captures stay on ludovico.

The production builds and live captures are the scoped validation. Linux Chromium measurements cannot quantify macOS WebKit CPU or `kernel_task`; any GPU/compositing explanation requires its own evidence.

No causes have yet been established. A cause will be named as proven only after a disposable ablation demonstrates a repeatable reduction in idle work.
