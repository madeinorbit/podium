# Typing latency measurement and diagnosis

Measured 2026-08-10.

## Answer

Podium had an opt-in `echoHud` diagnostic, but its "echo" measurement ended when a terminal WebSocket output frame reached the browser. It did not include xterm rendering or browser paint, and collection continued even when the HUD was hidden. It therefore was not an actual end-to-end typing-latency probe.

The probe now measures the interval from the real browser keyboard event through the first visible terminal paint. It retains the useful split between input-to-output-frame and output-frame-to-paint, is disabled by default, clears state when disabled, and does only one boolean check on the disabled hot path. A bounded standalone Firefox benchmark makes the same measurement repeatable without manual timing.

## How to run it

- Add `?echoHud=1` to the web URL for a one-off live HUD. `?echoHud=0` explicitly turns it off, even if the persistent `podium.echoHud` UI-state setting is on.
- With `?e2e=1`, inspect the current structured result with `window.__podium.echoLatency()`.
- Run a repeatable real-browser sample with `bun run perf:typing -- --samples=60 --out=.artifacts/typing-latency.json`.
- Prove that the disabled path collects nothing with `bun run perf:typing -- --verify-off --out=.artifacts/typing-off.json`.

The full recipe is documented in `docs/agents/driving-podium.md` under “Measure real typing latency.”

## Isolated real-browser baseline

Forty real Firefox keypress/backspace samples against an isolated Podium stack produced:

| Stage | p50 | p90 | maximum |
| --- | ---: | ---: | ---: |
| Keyboard event to visible paint | 37 ms | 51 ms | 853 ms |
| Keyboard event to output frame | 10 ms | 23 ms | 822 ms |
| Output frame to visible paint | 28 ms | 32 ms | 56 ms |

The sole large outlier was almost entirely before the output frame reached the browser: 822 ms before the frame and at most 56 ms in rendering/paint. The isolated process log recorded a matching roughly 794 ms all-in-one process stall. Paint remained stable.

The explicit off run performed a real keypress and backspace and returned `enabled: false`, `count: 0`, and no timing samples.

## Current slowdown attribution

The current typing pauses are backend shared-event-loop starvation, not xterm rendering or browser paint. The important distinction is that the cost of one bootstrap is now healthy and improving; the regression is how often bootstrap runs.

In a three-minute live-server window, Podium logged 101 event-loop stalls: 33.7 per minute, p50 275 ms, p90 363 ms, p99 469 ms, and maximum 614 ms. Sixty-one of those stalls contained the feed bootstrap’s latest-change fold over approximately 5,500–6,100 rows; 24 also contained issue point-read work. The SQL calls themselves were usually about 50–80 ms, while the surrounding JavaScript occupied roughly 400–1,100 ms of own CPU in the affected passes.

The earlier accumulated live performance snapshot reinforced the event-loop attribution:

| Operation | samples | p50 | p90 | p99 | maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| `feedBootstrap.total` | 473 | 315 ms | 421 ms | 1,071 ms | 2,663 ms |
| `feedBootstrap.read` | 473 | 225 ms | 293 ms | 584 ms | 2,544 ms |
| `visibility.issue.getIssue` | — | 49.7 ms | 64.8 ms | 215 ms | 433 ms |
| `feedPublish.total` | — | 0.025 ms | — | 1.9 ms | 45.9 ms |

An independent six-minute verification then observed 184 stalls, or 30.7 per minute, with a 268 ms p50 and 176 of 184 classified busy. Its longer performance snapshot contained 536 `feedBootstrap.read` samples at a 219.7 ms p50. That per-bootstrap p50 has improved from 4,698 ms before the earlier fixes, through 1,096 ms and 351.9 ms, to 219.7 ms now. The bootstrap implementation is therefore not getting slower.

The cadence is the defect: 536 bootstrap reads in 1,584 seconds is 20.3 bootstraps per minute. At the observed median cost, they consume approximately 118 seconds, or 7.4% of all wall-clock time. That is close to the original 6.5% event-loop occupancy, but it has returned through excessive invocation rather than excessive per-call cost. In the same snapshot there were only 26 `ws.attach` operations and 16 client switches. Since `serveWorld` should run on peer connection and is guarded against an already-connected peer, the large mismatch means peers are churning, the connection guard is ineffective, or another call path invokes bootstrap outside initial connection.

Each unnecessary pass rebuilds the whole workspace feed and latest-change state. Because that work shares the server event loop with PTY input/output routing, it can delay terminal echo before the browser receives an output frame. Warm client terminal switches were mostly 67–107 ms, with a cold 409 ms switch and one cold 8,064 ms switch. A separate fresh-client/corpus freeze remains tracked by POD-1651 (Terminal switch latency attribution); it is distinct from the steady-state typing path diagnosed here.

The reusable fix for repeated feed reconstruction is proposed as POD-1790 (Repeated feed bootstrap stalls), discovered from this work.

## Verification

- Focused related tests: 12 files, 85 tests passed.
- Typecheck: 23 tasks succeeded (19 cached).
- Real Firefox enabled run: 40 end-to-end samples collected.
- Real Firefox disabled run: real input produced zero samples.
- Repository-wide `bun run test`: the probe-related packages passed their focused checks, but the shared working tree's server package failed 28 tests in five unrelated suites involving revision-contract counts, daemon-frame counts, derived-family counts, and oracle tags. Concurrent server changes are present in the working tree and were not modified as part of this work.
