# Native CLI lifecycle baseline

Measured 2026-08-30T09:32:09.096Z on flatblock (linux 7.0.0-30-generic, 8 × AMD EPYC Processor (with IBPB), 23 GiB).
Run order: claude → codex → grok → opencode. Prompt: `Reply with exactly BENCH_OK and nothing else. Do not use tools.`

Start values are medians over samples that reached a native session; drive values are medians over verified successful turns; attach values include any sample whose native client probe succeeded. Start is measured from native engine/SDK process invocation; drive is relative to prompt submission; attach is relative to spawning a fresh stock CLI in a PTY.

| Provider | Samples | Session ready | Prompt accepted | First response | Turn complete | Attach first byte | Attach input ready | First attach keystroke |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| claude | 0/3 | 1084.9 ms | — | — | — | 675.2 ms | 1700.6 ms | 0/3 echoed |
| codex | 3/3 | 1392.5 ms | 30.1 ms | 3513.6 ms | 4185.0 ms | 22.8 ms | 274.4 ms | 3/3 echoed |
| grok | 3/3 | 356.7 ms | 7.7 ms | 2604.9 ms | 3162.5 ms | 188.2 ms | 399.9 ms | 3/3 echoed |
| opencode | 3/3 | 1575.1 ms | 22.5 ms | 2421.1 ms | 2692.4 ms | 1189.1 ms | 3310.0 ms | 0/3 echoed |

## Raw samples

| Provider | Run | Session ready | Prompt accepted | First response | Complete | Attach first byte | Paint settled | Input ready | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| claude | 1 | 1060.9 ms | — | — | — | 1071.6 ms | 1691.8 ms | 2121.8 ms | Claude completed without the expected BENCH_OK response |
| claude | 2 | 1084.9 ms | — | — | — | 657.4 ms | 1662.8 ms | 1680.5 ms | Claude completed without the expected BENCH_OK response |
| claude | 3 | 1113.0 ms | — | — | — | 675.2 ms | 2198.9 ms | 1700.6 ms | Claude completed without the expected BENCH_OK response |
| codex | 1 | 1702.2 ms | 41.0 ms | 3513.6 ms | 4185.0 ms | 26.0 ms | 1131.1 ms | 232.5 ms | ok |
| codex | 2 | 1392.5 ms | 30.1 ms | 3250.1 ms | 3449.6 ms | 22.8 ms | 2143.9 ms | 294.8 ms | ok |
| codex | 3 | 539.4 ms | 19.9 ms | 4302.6 ms | 4535.4 ms | 18.7 ms | 1896.9 ms | 274.4 ms | ok |
| grok | 1 | 933.7 ms | 20.0 ms | 6695.5 ms | 33095.6 ms | 196.3 ms | 1377.8 ms | 544.8 ms | ok |
| grok | 2 | 356.7 ms | 7.6 ms | 2604.9 ms | 2888.1 ms | 186.0 ms | 1314.4 ms | 399.9 ms | ok |
| grok | 3 | 346.3 ms | 7.7 ms | 2500.3 ms | 3162.5 ms | 188.2 ms | 1219.4 ms | 372.1 ms | ok |
| opencode | 1 | 1467.9 ms | 22.5 ms | 2261.5 ms | 2692.4 ms | 1090.6 ms | 1611.1 ms | 3149.7 ms | ok |
| opencode | 2 | 1575.1 ms | 18.0 ms | 2436.1 ms | 2765.0 ms | 1221.5 ms | 1735.5 ms | 3422.3 ms | ok |
| opencode | 3 | 2139.4 ms | 30.0 ms | 2421.1 ms | 2633.2 ms | 1189.1 ms | 1704.3 ms | 3310.0 ms | ok |

## Run limitation

Claude start and attach measurements are valid, but all three Claude model turns were excluded because the installed native login reported an expired OAuth session that could not be refreshed. Its temporary-directory trust gate was accepted once per attach and is included in `setupGateMs` and `setupActions`.

## Mechanisms and evidence

- **claude 2.1.236 (Claude Code):** process-per-turn Agent SDK worker; native resume TUI
- **codex codex-cli 0.151.0:** Unix WebSocket app-server JSON-RPC; remote resume TUI
- **grok grok 0.2.118 (1e1687c1cf) [stable]:** ACP stdio JSON-RPC; native-store resume TUI
- **opencode 1.18.25:** Basic-auth loopback HTTP/SSE server; authenticated attach TUI

The attach input probe types a unique marker after the first terminal byte and never presses Enter. “First attach keystroke” therefore means the first attempted input survived native startup and visibly reached the composer; it is not inferred from a painted screen.

These are observations, not stable product budgets. Provider load, network conditions, model choice, account tier, local config/plugins, machine load, and OS cache state all affect them. Consult the sibling JSON for host load, exact per-stage evidence, executable paths, and partial failures.
