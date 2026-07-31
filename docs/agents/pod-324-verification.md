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
- The list-state parser is `parseAbducoList` in `packages/pty/src/abduco.ts`. It preserves
  abduco's incident-critical mapping: `+` is terminated, `*` is attached and alive, and a
  leading space is detached and alive. Async `listSessions` applies it to both successful
  stdout and stdout carried by version-dependent non-zero exits.

## Review regression

- `composer-sync.smoke.test.ts` initially reproduced the review failure 3/3. The PTY
  collaborator's process probe and Unicode argv relied on Bun/node-pty callback ordering;
  `onExit` can arrive before queued `onData`, leaving the engine with no frame.
- The collaborator now uses a FIFO rendezvous: the exact `cat` PID blocks until data and exit
  listeners exist, the test awaits actual frame publication rather than sleeping, and `finally`
  terminates and awaits that PID. Three consecutive focused reruns passed, with zero fixture
  processes left alive.
- Direct callers in both managed-account spawn harnesses now await the async session handler.
  The Bun.Terminal harness passes 3/3 and the Vitest integration harness passes 3/3.
- After rebasing onto POD-415 at `b082bc52`, the old five `*Async` names have zero references
  in `apps/daemon` and `packages/pty`; every surviving daemon invocation is directly awaited
  or belongs to an awaited `Promise.all`. The combined pty, daemon durability, and
  binding-aware managed-account integration selection passes 99/99.
- The reviewer's exact direct command, `bun --bun vitest run
  apps/daemon/src/composer-sync.smoke.test.ts`, passes three consecutive runs on the rebased tree.

## Loop responsiveness

- `bun scripts/loop-probe.mjs 15 docs/agents/pod-324-loop-probe.csv`: daemon HTTP RTT
  p50 2 ms, p99 36 ms, max 67 ms, with 0 samples above the 250 ms stall threshold.
  The live server WebSocket endpoint returned no samples in this environment.
- Isolated real-backend burst: 4 abduco and 4 tmux fixture sessions were created,
  detached, discovered, reattached (8/8), and reaped. Maximum drift of a 10 ms timer
  in the host process was 51.4 ms, below the probe's 250 ms threshold.

## Repository gates

- Pre-rebase `bun run test:unit`: 619 files passed, 3 skipped; 9,138 tests passed, 19 skipped.
- Two post-rebase full unit runs each completed 619 files and found one different unrelated
  shared-host timing failure: `loop-metrics.test.ts` exceeded its long-tick allowance by one,
  then `terminal-view.keyboard.test.ts` exceeded its 10 s hook deadline. Each failing file
  subsequently passed three consecutive isolated runs (loop metrics 1/1 each; keyboard 13/13
  each). No durable-host, binding, or composer test failed in either run.
- `bun run test`: node 619 files / 9,138 tests passed; web 182 files / 1,456 tests
  passed; mobile 34 tests passed; Bun sqlite 14 tests passed.
- `bun run typecheck` reaches the pre-existing ambiguous `Geometry` model-barrel export
  and fails at `packages/pty/src/session.ts`; independent follow-up: POD-1284.
