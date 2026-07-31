# POD-324 verification

## API deletion gate

- `bun scripts/rearch-audit.ts --phase POD-324`: all one deletion-audit items at zero.
- `scripts/rearch-audit.test.ts`: 72/72 passed after the completed detector gained
  source-root and synthetic matcher anchors.
- The committed `durable-host-sync-async-twins` baseline is 0.

## Durable-session behavior

- Focused pty integration (`abduco.test.ts`, `tmux.test.ts`): 33/33 passed.
- Focused daemon durability (`durable-headless.test.ts`, `daemon.test.ts`): 63/63 passed.
- Bun.Terminal abduco behavior: 2/2 passed.
- Full `bun run test:integration`: 38 files passed, 285 tests passed, 6 skipped;
  acceptance: 1/1 passed.
- Scope reclaim, cgroup placement/survival, detach-key remapping, alt-screen stripping,
  list-state parsing, detach survival, reattach, and explicit reap remain covered by those lanes.

## Loop responsiveness

- `bun scripts/loop-probe.mjs 15 docs/agents/pod-324-loop-probe.csv`: daemon HTTP RTT
  p50 2 ms, p99 36 ms, max 67 ms, with 0 samples above the 250 ms stall threshold.
  The live server WebSocket endpoint returned no samples in this environment.
- Isolated real-backend burst: 4 abduco and 4 tmux fixture sessions were created,
  detached, discovered, reattached (8/8), and reaped. Maximum drift of a 10 ms timer
  in the host process was 51.4 ms, below the probe's 250 ms threshold.

## Repository gates

- `bun run test`: node 619 files / 9,138 tests passed; web 182 files / 1,456 tests
  passed; mobile 34 tests passed; Bun sqlite 14 tests passed.
- `bun run typecheck` reaches the pre-existing ambiguous `Geometry` model-barrel export
  and fails at `packages/pty/src/session.ts`; independent follow-up: POD-1284.
