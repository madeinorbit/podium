# Shell controls pool comparison

The shell controls, approval and continuation dialogs, browser overlay, dock, rail,
link host, close-tab utility and machines panel now read the existing MobX pool on
the enabled path. The startup choice remains OFF by default and freezes once.
The shared-pilot browser comparison recorded zero legacy selectors, derivations
and direct `sessionById` calls, with matching data and rendered output.

## Scope and ownership

The coordinator allocated these files after the navigation lane landed. AppShell
uses its landed `missionView` reader for the selected root; Workspace, FlightDeck,
navigation providers and connection observers retain their existing owners.
CommandPaletteBoundary already uses `useCommandPaletteOpen` from the command
lane and needs no further edit. Its reader is included in the browser fixture.

Baseline locations come from
[the legacy reader inventory](POD-5082-legacy-reader-inventory.md), rather than the
new line numbers after migration.

| Baseline reader | Baseline lines | Enabled source |
| --- | --- | --- |
| AppShell chrome | 416, 440, 459, 460, 462, 474, 477 | Window controls, counts, color ancestry, landed mission-root reader; stable actions |
| ApprovalDialog | 22 | Resident approvals and stable actions |
| AutoContinueDialog | 21 | Prompt session ID and stable actions |
| BrowserOpenOverlay | 60, 61 | Session summaries and stable hub |
| CommandPaletteBoundary | 18 | Existing command reader, preserved |
| MachinesPanel | 157 | Pool machine rows and stable settings/API actions |
| RightDock | 124, 138 | Session/file focus, worktree scope, issues, shipping orders and lanes |
| RightRail | 125, 137 | Scoped shipping counts |
| PodiumLinkHost | 73, 85 | Session/issue summaries; full artifact manifest on demand |
| use-desktop-close-tab | 19 | Selected workspace layout and file tabs |

`shell-schema.ts` declares window controls, approval/file/workspace/lane entities,
their resident relations and required issue/session summaries before attaching
the reader. Shared header sources continue to own machine, repository and order
rows. `ShellSource` borrows the existing runtime and replica through one
`sources.ensure('shell-controls', ...)` registration; lane deltas use addressed
replica rows. Actions and transports are acquired once from the existing owner.
No runtime, replica, outbox or mutation owner is added.

Views read through `pool.row`. Missing summaries return `LOADING` and request the
existing batched loader; artifact links demand a full manifest, retry their
accepted click and release completed or expired watches. Pending link queues
and artifact watches are bounded. Relation buckets contain resident rows.
Large reads run in the component observer, without inline pool projections.
Cached chrome results contain only consumed window and mission fields. The rail
uses a separate cached shipping-count result, so pane/clock changes with equal
counts do not wake its observer.

## Browser count and render proof

Real Chromium runs on flatblock in `~/podium-test-5162` with that checkout's
`.toolchain` Bun 1.4.2 and library path. The offline fixture has 5,600 issues,
5,016 sessions, three machines, four shipping orders and one lane. Both arms
enable the previously landed shared-pilot screens; only `mobxShell` changes.
Two hundred material session feed updates produce 201 runtime publications,
including the navigation follow-up, in each arm.

| Recorded count | Shell OFF | Shell ON |
| --- | ---: | ---: |
| Publishing runtimes | 1 | 1 |
| Legacy selectors | 4,690 | 0 |
| Legacy derivations in the census | 3,716 | 0 |
| Direct `sessionById` calls | 419 | 0 |
| Dropped census records | 344 | 0 |
| Subscriber wakes | 4,221 | 1,809 |

The OFF derivation census is a lower bound: the legacy session index registers
immutable session arrays as owners and fills its 32-owner ring. The fixture
therefore also counts every `sessionById` entry directly, including cache hits,
using a Vite transform of the unchanged function. The ON census drops no
records. Optional comparison derivations are bracketed out of these counts.
These are count results, not latency measurements.

The global zero budget uses the coordinator's shared-pilot startup configuration.
An earlier partial configuration with navigation/pane readers OFF still reached
`navigationSession` in `client-core/engine/state.ts`, which calls the legacy
session index. This lane preserves that owner; its landed pool switches remove
those calls in the measured configuration.

The field comparison matches 10,637 positions across twelve sections with no
pending rows or differences. Seven rendered frames compare 49 sections exactly:
selected root, child, completed mission, empty selection, approval, continuation
prompt and pending login. The fixture mounts the production utility components
and the production AppShell chrome reader. It does not mount the entire AppShell,
Workspace or FlightDeck, or stand in for native desktop transport.

An actual click selecting an existing session changes the focused pane while
keeping the selected issue fixed. React Profiler records the same commits in
both arms: chrome 0, dock 1, rail 0 and machines 0. A fixture-only Vite transform
restores an unused pane dependency in the real chrome reader; that control adds
one chrome commit and the check exits 1. The development profiler counts commits;
the separate minified production speed gate measures actual Paint.

With `mobxHeader=0&mobxSettings=0` in both arms, the additional comparison still
records zero enabled selectors, derivations, direct session-index calls and
dropped evidence, with all 49 rendered sections matching. Navigation and command
readers retain the shared-pilot setting in that comparison.

Each arm observes one new browser tab, one forwarded callback, one close-tab
effect, one activated issue link and one opened artifact tab. The enabled artifact
is cold before an actual anchor click. The browser red controls separately force
the enabled arm onto legacy reads and corrupt a rendered section.

Run the proof from the dedicated checkout with its pinned toolchain:

```sh
bun --conditions=@podium/source apps/web/test/shell-readers-proof.ts
bun --conditions=@podium/source apps/web/test/shell-readers-proof.ts --red=legacy
bun --conditions=@podium/source apps/web/test/shell-readers-proof.ts --red=render
bun --conditions=@podium/source apps/web/test/shell-readers-proof.ts --red=commits
bun --conditions=@podium/source apps/web/test/shell-readers-proof.ts --isolated
```

## Operator replay and planted faults

Replay runs only on ludovico. The final count-only report covers 6,051 issues,
5,162 sessions, six machines and 585 repository scans. Seven selection contexts
compare 78,617 positions with zero differences and zero pending rows, including
AppShell's compact/expanded mission decision. Window controls
and file layouts are constructed in memory; this is not a replay of private
saved device layouts. The operator corpus currently has no shipping orders or
lanes; the synthetic fixtures provide that coverage.

Bootstrap and discovery data stay in process memory. The offline parser adapts
only the bootstrap framing version metadata (operator wire version 4), without
changing entity payloads. No private rows, names, paths or identifiers are
exported to flatblock or attached as artifacts. No operator window setting is
written, and no operator process is restarted.

The replay palette inversion reports seven differences and exits 1. Twelve
production-reader faults also reach and fail the parity assertion: window,
approval order, file path, close workspace, chrome count, dock attachment,
shipping count, order order, lane destination, machine name, session name and
issue prefix. Two additional observer controls restore unused chrome dependencies
and bypass the rail-count cache. The runner restores each source file in
`finally`. Comparator unit controls additionally verify every diagnostic section.

```sh
# flatblock, dedicated checkout only
bun packages/client-graph/diagnostics/shell-red-controls.ts
# ludovico only; these emit counts and mismatch positions
bun --conditions=@podium/source packages/client-graph/diagnostics/shell-replay.ts
bun --conditions=@podium/source packages/client-graph/diagnostics/shell-replay.ts --red-control
```

## Production click timing

The ordinary minified production speed gate is green on flatblock at candidate
`fa41e9aa2b935206a93d18d767036437602b6139`, with only `mobxShell=1` passed to
the gate. Chromium 153 records trusted pointerdown, or background feed delivery,
to the first Paint after the expected DOM change. The four-times corpus uses two
warmups and six measured samples per action; the full capture, including the
production build, takes 142.796 seconds.

| Action | Fixed baseline median, ms | Shell ON median, ms | Shell ON worst, ms |
| --- | ---: | ---: | ---: |
| Sidebar issue | 159.506 | 166.724 | 293.286 |
| Mission switch | 4,020.656 | 1,382.817 | 1,568.861 |
| Session pane | 3,405.917 | 1,129.778 | 1,216.396 |
| Issue rename | 2,972.887 | 998.964 | 1,013.464 |
| Background update | 3,257.451 | 1,154.659 | 1,394.648 |

All medians stay within the fixed ten-percent failure margin. The report records
17.639% maximum same-code median spread across two independent captures, so the
table establishes the gate result without attributing every speed difference to
this lane. The baseline is the coordinator's corrected pilot-OFF reference at
`0f77a997ed217117cf284f9fa142080c453efae6`; promotion remains with the
coordinator. The attached `speed-gate.json` preserves samples, environment,
baseline values, source SHA and the passing verdict. No baseline is changed.

```sh
# flatblock, dedicated checkout; hold bench:flatblock
bun run speed:gate -- --lease-confirmed --switch=mobxShell=1
```

## Startup and retirement

Use `?mobxShell=1` to opt into the shell screen at startup, `?mobxShell=0` for
rollback, and `?mobxShellCheck=1` with the enabled screen for the optional
five-second comparison. `window.__shellCheck` reports counts and numeric mismatch
positions; it does not expose row values. Changing a setting or URL after
initialization does not change the selected reader until a fresh startup.

MachinesPanel and RightRail use the shell reader independently of the existing
header and settings reader choices. The shared pilot setting remains under
operator control. Legacy removal is Proposed in POD-5357, conditional on roughly
seven days after the operator defaults the screen ON. POD-5365 separately tracks
the existing login-toast pointer overlap seen in both browser arms.

## Focused validation

The candidate is rebased onto current `integrate/4286-pilot`, including the shared
projection subscription fixes and temporary build-budget adjustments. On flatblock, scoped
typecheck for `@podium/client-graph` and `@podium/web` is green: 15 tasks succeed
through the normal cache-aware wrapper. One `test:file` invocation names ten files and finishes
with two groups, zero failed: eleven graph tests and 157 web tests.
This is focused evidence, not the full suite or the lean gate.
Scoped graph ESLint is green for the eight shell source/test/diagnostic files;
merge-shadowing lint reports no shadowed declarations in 5,832 files. Both new
production observer faults are rejected by the focused equality assertion.

```sh
bun run typecheck -- --filter=@podium/client-graph --filter=@podium/web
bun run test:file -- \
  packages/client-graph/src/shell.test.ts \
  apps/web/src/app/shell-pool-screen.test.tsx \
  apps/web/src/app/RightDock.test.tsx \
  apps/web/src/app/RightRail.test.tsx \
  apps/web/src/app/BrowserOpenOverlay.test.tsx \
  apps/web/src/app/Workspace.test.tsx \
  apps/web/src/app/workspace-close.test.ts \
  apps/web/src/features/settings/MachinesPanel.test.tsx \
  apps/web/src/components/PodiumLinkHost.test.tsx \
  apps/web/src/lib/podium-link-open.test.ts
```
