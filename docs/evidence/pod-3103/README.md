# POD-3103 headed driver acceptance

## Pins and isolation

The source branch and local `issue/1761-agent-runtime` both pointed to
`fbc2f18baf77d74d370c6469444b3c3d800b0a71`. The OpenCode basic cell used named
instance `p3103-opencode-basic`, product-derived state and agent home, scratch cwd
`/tmp/pod-3103-opencode-basic/repo`, and ports 19971/46971/46972. The verifier read
the server and daemon spawn stamps and fetched the served web stamp; all three were
`fbc2f18`. Port 19797, port 32090, the default instance state, and their processes
were not touched.

The installed harness was OpenCode 1.18.25 from
`~/.opencode/bin/opencode`. The drive used the product session/runtime path; no
provider binary was driven directly.

## 2026-08-30 first batch: OpenCode launch/send control

At 2026-08-30 00:02:49 CEST the session bound `opencode-server`. The initial
nonce prompt was accepted with disposition `delivered`; the exact assistant nonce
arrived in 3,520 ms and the whole probe completed in 3,845 ms. The independent
positive control staged a file containing a second random nonce: the agent read it
and returned the nonce in 1,505 ms (1,808 ms whole probe), with zero approval asks.

Host state immediately after the bounded run was 17,471,201,280 bytes
MemAvailable, 563,666,944 bytes swap used, 73 GiB root free, and load average
14.53/11.53/7.76. The elevated load is part of the reading; these timings are not
presented as an idle-host baseline.

This headless context cell proves current-tip `opencode-server/server` binding,
initial input acceptance, output delivery, and transcript synchronization. It does
not count toward headed acceptance and is not a headed view-switch, interruption, or
recovery verdict; those remain separate cells.

## Current evidence not repeated

The Grok basic Chat/CLI repair at `d77713859196462a59e4898f4f5e4ac0e29c5787`
and the Codex native-view timing cited in the parent release ledger remain current:
`git diff d777138..fbc2f18 -- . ':!docs'` is empty. Repeating those provider runs
would not test changed product bytes.

## Raw cell rows

See `rows.tsv`; each populated line was checked for exactly eight tab-separated

## 2026-08-30 headed OpenCode launch and switching

The valid headed cell used per-spawn `runtimeContract='generic-pty'`; neither
`PODIUM_RUNTIME_DRIVER` nor a daemon-wide driver override was set. Scoring was
refused until the session reported both `driverId=generic-pty` and
`driverFamily=terminal`. The isolated instance was
`p3103-opencode-headed-final`, with product-derived state/agent home, scratch cwd
`/tmp/pod-3103-opencode-headed-final/repo`, and ports 19974/46977/46978.

Creation to observed bind was 1,014 ms. Native attach already had 35,250 terminal
bytes available, required no first-run priming, and raw input echoed. The first
prompt's exact reply arrived in 3,015 ms. Four Chat/Native changes kept the same
`generic-pty/terminal` identity; the second send was accepted as `delivered`,
entered `working`, and reached an exact reply plus `idle` in 1,581 ms. Terminal
bytes grew from 76,094 to 317,602 (+241,508), and raw CLI input echoed both before
and after switching.

Verdict is **PARTIAL**, not PASS: raw PTY frames contain normal full-screen TUI
redraws and cannot establish whether xterm scrollback duplicated or corrupted.
The core launch/input/transcript/identity/terminal-growth clauses pass; the
scrollback clause remains explicitly unmeasured rather than being inferred from
redraw counts. Host state after the run was load 10.74/12.31/10.56,
16,946,188,288 bytes MemAvailable, 1,592,061,952 bytes swap used, and 72 GiB root
free. Server, daemon, and web were pinned to `d6b4ba8bf`; product paths are
byte-identical to the original `fbc2f18b` runtime pin.
