# Host memory indicator — design

2026-06-11 · branch `feat/host-memory-indicator`

## Goal

Show the memory pressure of the machine(s) hosting Podium daemons, so the user can see how
their dev box is doing while agents run. First of a family of host indicators (connection
stability etc. will follow), so the placement and wire shape must leave room for siblings.

## What number to show

**Used = MemTotal − MemAvailable, out of MemTotal**, rendered as `used/total GB` with a
percentage-driven severity color. Rationale:

- `MemAvailable` (Linux `/proc/meminfo`, kernel ≥ 3.14) is the standard "how much can
  applications still allocate without swapping" estimate. Subtracting *free* instead would
  count page cache as used and permanently show ~95% on any warm box — the classic
  `linuxatemyram.com` mistake. `htop`, `free`, and every modern monitor use available.
- **Swap is not folded into the headline.** The convention everywhere (free, htop, macOS
  Activity Monitor) is RAM and swap as separate lines: mixing them produces a number that
  is neither capacity nor pressure. Swap totals ride along on the wire and surface in the
  chip tooltip; a dedicated pressure treatment (PSI) can come later.
- Severity: `ok` < 75%, `warn` 75–90%, `critical` ≥ 90% — coloring the chip, not alarming
  prose.

Sampling: Node has no cross-platform "available", so the daemon parses `/proc/meminfo`
(MemTotal, MemAvailable, SwapTotal, SwapFree) and falls back to `os.totalmem()` /
`os.freemem()` where that file doesn't exist (macOS — freemem is pessimistic there, but
correct-ish and better than nothing). Every 5 s; payload is ~100 bytes.

## Multiple machines

The protocol is multi-host from day one: each daemon reports under its `os.hostname()`,
the server keeps *latest sample per hostname* and broadcasts the full list. One machine →
one chip with no hostname label; several machines → one chip per host, labeled. The server
currently holds a single daemon socket, so today the list has length ≤ 1 — when multi-daemon
lands, the metrics path needs zero changes. On daemon detach the server clears the map and
broadcasts the empty list, so a dead daemon's numbers never linger as truth.

## Wire shape

```
// daemon -> server, every 5 s
{ type: 'hostMetrics', hostname, sampledAt,        // ISO 8601
  memory: { totalBytes, availableBytes, swapTotalBytes, swapFreeBytes } }

// server -> client, on change + on client attach
{ type: 'hostMetricsChanged', hosts: [{ hostname, sampledAt, memory }] }
```

## Components

- `apps/daemon/src/host-metrics.ts` — `parseMeminfo(text)` (pure, tested) +
  `sampleHostMemory()` (proc-or-fallback) ; daemon.ts starts a 5 s interval alongside the
  discovery timer, pushes only while the ws is open.
- `apps/server/src/relay.ts` — `latestHostMetrics: Map<hostname, HostMetricsWire>`;
  update + broadcast on `hostMetrics`, snapshot on `attachClient`, clear + broadcast on
  `detachDaemon`.
- `packages/terminal-client` SocketHub — `hostMetrics()` / `onHostMetrics(cb)` mirroring
  the sessions/conversations observer pattern.
- `apps/web` — store exposes `hostMetrics`; `HostIndicators.tsx` renders the chips;
  formatting/severity helpers live in `derive.ts` (pure, tested). Desktop: a status strip
  pinned at the bottom of the sidebar (the future home of the connection indicator).
  Mobile: the same compact chip in the `mobile-head` header.

## Error handling

- Unreadable/garbled meminfo → fallback to `os` totals; sampler never throws into the
  interval (failure skips the tick).
- No metrics yet / daemon gone → strip renders nothing (no zero-state lying).
- Malformed wire messages are already dropped by the zod codecs.

## Testing

Protocol round-trip tests; meminfo parser unit tests; daemon test asserts periodic
`hostMetrics` over the ws harness (fake interval); relay tests for broadcast/snapshot/clear;
SocketHub routing test; derive formatting/severity tests; shell structure test for the strip.
