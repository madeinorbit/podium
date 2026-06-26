# Podium typing-latency: root-cause findings (data, not guesses)

Date: 2026-06-23. Live host: 8 cores, 92 abduco PTY sessions, ~30 live agents.

## TL;DR
Typing stalls because the **backend event loops are periodically blocked by
synchronous work** — not the host, not the network, not the browser. Two
periodic offenders are confirmed by direct measurement. When a loop blocks, the
focused session's keystroke echo (which round-trips PTY→daemon→server→browser)
freezes, then the queued characters flush in a burst on unblock. That burst-replay
*is* the symptom.

## How we know it's in-process loop blocking (the proof)
A triangulating black-box prober (`scratchpad/loop-probe.mjs`) sampled three
signals at 10 Hz for 6 min:
- `own_lag` — the prober's OWN event-loop delay (host-scheduler control)
- `server_rtt` — WS ping→pong to :18787 (server JS loop)
- `daemon_rtt` — HTTP RTT to :45777 (daemon JS loop)

Result (6 min, 3,361 samples each):
```
own_loop_lag : p50=4   p99=50   max=150 ms   stalls>250ms = 0   (0.0%)
server_ws_rtt: p50=1   p99=77   max=1209 ms  stalls>250ms = 24  (0.7%)
daemon_rtt   : p50=2   p99=138  max=2473 ms  stalls>250ms = 27  (0.8%)
```
**`own_lag` stays low while server/daemon RTT spike to 0.5–2.5s.** If this were
CPU oversubscription, the prober's own loop would spike too. It doesn't → the
stalls are **in-process JS blocking on the backend**, not host scheduling.

The stalls are **periodic (~16 s)** and **cascade**: a daemon stall (700–950 ms)
is followed ~1 s later by a server stall (~500 ms), 20+ times:
```
[34s] daemon 760ms  -> [35s] server 670ms
[67s] daemon 828ms  -> [68s] server 462ms
[277s] daemon 929ms -> [278s] server 490ms
[248-250s] daemon 2473ms (sustained) + server 1209ms   <- worst case
```
Mechanism of the cascade: while the daemon loop is frozen it stops draining 92
sessions' PTY output; on unblock the backlog floods the server, which then
burst-processes it and blocks ITS loop.

## Root cause #1 (PRIMARY, confirmed): discovery scan blocks the daemon loop
The daemon runs a conversation discovery scan every **15 s**
(`DEFAULT_DISCOVERY_SCAN_INTERVAL_MS`) over `~/.claude/projects` (2021 files) +
`~/.grok` (177) + `~/.codex` etc. — **2,744 conversations**.

Running the real scan (`scanAgentConversations`) with a loop-lag monitor:
```
scan 0: wall=3431ms  loop_lag_max=374ms   conversations=2744
scan 1: wall=2392ms  loop_lag_max=808ms   conversations=2744
scan 2: wall=2373ms  loop_lag_max=806ms   conversations=2744
```
**A single contiguous ~800 ms loop block per scan.** That magnitude and the 15 s
cadence match the daemon stalls in the probe exactly.

Why contiguous (not interleaved): the scan does `await Promise.all` over thousands
of files. When the reads resolve together, their CPU-bound parse continuations
(`JSON.parse` of each file head) **drain as one unbroken microtask storm** — async
I/O fanned out wide still produces a synchronous CPU stall. The 15 s cadence + the
~800 ms block is exactly the ~16 s observed period (15 s gap + ~0.8 s execution).
(The deployed daemon uses the *cached* scan; the probe measured it directly still
stalling 700–950 ms, so the mtime cache does not save us — active sessions change
many transcripts every 15 s, and the per-file cache lookups + continuation storm
remain.)

## Root cause #2 (SECONDARY, confirmed): memoryBreakdown /proc walk
`HostMemoryView.tsx:170` polls `trpc.hosts.memoryBreakdown` **every 5 s** while
that view is open. The daemon services it with a **synchronous** `readFileSync`
walk over every `/proc/<pid>` (`smaps_rollup` + `stat` + `cmdline` + readlink cwd).
Measured on this host (`snapshotProcesses`):
```
~1.1 s per call (1077–1252 ms), 1030 pids, 64 processes >100 MB
```
`smaps_rollup` forces a kernel page-table walk per large process. This is an
independent ~1.1 s daemon-loop freeze every 5 s whenever the memory view is open,
and it overlaps with the 15 s scan to produce the 2.5 s super-stalls.

## Amplifiers (real, secondary)
- **Host oversubscribed:** load avg 9–10 on 8 cores. Raises the floor and jitter.
- **Leaked runaway process:** pid 880672 = `timeout 12 bun … scripts/server.ts`
  (a 12-second smoke run in the `feat+pty-backend-abstraction` worktree) that
  escaped its timeout and has been **busy-looping at 99.9% on a full core for 2+
  days** (R state). Pure waste; not the live server (live = pid 1904392). Kill it.

## What we RULED OUT (measured, so we don't chase them)
- Per-frame server work (`session.ts:406` base64 re-decode + `SCREEN_RESET`
  regex + broadcast encode): **≤23 ms even for a 4 MB frame to 4 clients.**
- `broadcastSessions` `JSON.stringify` of 92 sessions: sub-ms (tens of KB).
- `scanResult` parse+zod ingest on the server: **≤40 ms** even at 2,200–4,000
  conversations.
- The input path itself: 18 hops, all microsecond-scale per keystroke; the
  problem is the loop being busy, not the per-keystroke cost.

## Architectural roots (why this is structurally fragile)
1. **One shared event loop per process** does every session's I/O *and* the
   background scans/walks. No isolation between "the keystroke I'm typing now"
   and "rescan 2,744 transcripts."
2. **No focused/visible-session prioritization.** A `presence{visible}` signal
   already exists (`messages.ts:329`, stored as `ClientConn.visible`) but is used
   ONLY to gate push notifications — never to prioritize I/O or defer background
   work for unwatched sessions.
3. **Heavy work runs synchronously / as wide fan-outs** that microtask-storm,
   instead of being chunked-with-yields, incremental, or on a worker thread.
4. **No output coalescing** (every PTY frame is an independent sync hop).
5. **No event-loop-lag instrumentation** — these multi-hundred-ms stalls were
   completely invisible; the only stall detector is the 30 s systemd watchdog.

## First-principles fix directions (for discussion — not yet implemented)
- **Get heavy work off the keystroke loop:** run the discovery scan and the
  /proc memory walk in a worker thread, OR make them incremental and bounded per
  tick (cap to e.g. ≤5 ms of sync work, yield, resume) so no single tick exceeds
  a frame budget. The scan should also only re-summarize files whose mtime
  changed, and chunk the parse continuations.
- **Prioritize realtime I/O:** treat the focused/visible session's input+echo as
  high priority; defer/spread background-session work and the periodic scans when
  input is in flight. The `visible` signal is the existing hook to build on.
- **Make it observable & keep it that way:** add `monitorEventLoopDelay` lag
  metrics + per-task "long tick" attribution (env-gated) to server and daemon, so
  regressions are caught, and so we can confirm the server-cascade hypothesis in
  production.
- **Cheap immediate wins:** kill the 99.9% orphan; gate/relax the 5 s memory poll
  and make the walk async; space out / jitter the scan.

## Reusable tooling produced
- `scratchpad/loop-probe.mjs` — the triangulating loop-responsiveness prober
  (own-lag vs server vs daemon). Good permanent home: `scripts/` next to
  `profile-backend.sh`. Run: `bun loop-probe.mjs <durationSec> <csvPath>`.
- `scratchpad/probe-passive.csv` / `.log` — the 6-min dataset above.
