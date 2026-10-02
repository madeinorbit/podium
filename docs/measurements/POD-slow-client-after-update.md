# Client slowness after the sidebar pilot landing

Issue: POD-5175, under POD-4286. Date: 2026-10-02.

Status: measurement in progress. No performance or memory conclusions yet.

Compare production web clients built in detached worktrees at `a5f55925f` and
`721dd6937`, against the operator’s running server on ludovico. The report branch
starts at `integrate/4286-pilot` (`e3108bf53f`). No product changes are planned.

Use one local headless Chromium sequentially, with isolated browser storage and the
existing CLI session. Exercise startup, idle, incoming updates and scrolling only.
Measure retained heap after forced GC for at least ten minutes in each supported
mode: sidebar off, sidebar on, and sidebar on with the legacy comparison enabled.
Capture CPU attribution and allocation/GC evidence locally, reduce to counts,
timings, function names and sizes, and delete raw captures before handoff.

The Linux Chromium measurements can distinguish shared web-client costs. They do
not establish the operator’s macOS switch state or reproduce WebKit/native-shell
costs; those limits will remain explicit.
