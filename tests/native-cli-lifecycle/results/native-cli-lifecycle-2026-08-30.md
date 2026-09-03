# Native, machine, and attach lifecycle baseline

Measured 2026-08-30T15:56:09.265Z on flatblock (linux 7.0.0-30-generic, 8 × AMD EPYC Processor (with IBPB), 23 GiB).
Run order: claude → codex → grok → opencode. Prompt: `Reply with exactly BENCH_OK and nothing else. Do not use tools.`

Every table is a separate lane and every value is a median. Native timings come from a stock TUI creating and driving its own new session. Machine timings come from the vendor SDK/app-server/ACP/HTTP interface with no Podium process. Attach timings come from a stock TUI joining the session created by the machine lane.

## 1. Native CLI used by a human

| Provider | Samples | First byte | Paint settled | Initial input ready | Response visible | Next input ready | First startup keystroke |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| claude | 3/3 | 523.4 ms | 1107.7 ms | 1544.5 ms | 1865.1 ms | 1959.5 ms | 0/3 echoed |
| codex | 3/3 | 23.7 ms | 2688.6 ms | 187.9 ms | 2355.2 ms | 2467.8 ms | 3/3 echoed |
| grok | 3/3 | 288.9 ms | 1092.1 ms | 504.7 ms | 4247.6 ms | 4336.3 ms | 3/3 echoed |
| opencode | 3/3 | 1196.7 ms | 1716.7 ms | 5249.4 ms | 3663.9 ms | 3822.8 ms | 0/3 echoed |

Native `Response visible` and `Next input ready` are relative to pressing Enter. Startup columns are relative to spawning the stock CLI.

## 2. Machine interface

| Provider | Samples | Session ready | Prompt accepted | First response | Turn complete | Cold → first response | Cold → complete |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| claude | 3/3 | 3250.2 ms | 3250.2 ms | 6102.6 ms | 6277.1 ms | 6102.6 ms | 6277.1 ms |
| codex | 3/3 | 547.6 ms | 39.1 ms | 3999.9 ms | 4188.9 ms | 4526.8 ms | 5063.3 ms |
| grok | 3/3 | 542.2 ms | 13.4 ms | 3000.8 ms | 3140.4 ms | 3666.3 ms | 4019.9 ms |
| opencode | 3/3 | 1707.9 ms | 407.1 ms | 2774.1 ms | 2949.9 ms | 4457.8 ms | 4633.6 ms |

`Cold →` values add session startup and drive intervals, except Claude where SDK query starts the session and prompt together so its drive clock is already cold-to-response. They omit small orchestration gaps.

## 3. Headless session → native attach

| Provider | Samples | Sequence | Session ready → input ready | Attach invoked after ready | Attach first byte | Paint settled | Attach input ready | First attach keystroke |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| claude | 3/3 | after-machine-turn | 4672.1 ms | 3027.4 ms | 607.0 ms | 1200.8 ms | 1641.7 ms | 0/3 echoed |
| codex | 3/3 | after-machine-turn | 4482.9 ms | 4189.1 ms | 28.3 ms | 1991.6 ms | 229.0 ms | 3/3 echoed |
| grok | 3/3 | before-machine-turn | 376.4 ms | 0.1 ms | 200.9 ms | 1304.4 ms | 376.3 ms | 3/3 echoed |
| opencode | 3/3 | before-machine-turn | 4354.5 ms | 0.6 ms | 1283.1 ms | 1799.5 ms | 4352.2 ms | 0/3 echoed |

Grok and OpenCode attach immediately after machine session creation and before the machine turn. Claude attaches after its process-per-turn SDK query; Codex attaches after the first machine turn because app-server thread/start does not create a resumable rollout.

## Raw native samples

| Provider | Run | First byte | Paint settled | Initial input ready | Prompt submitted at | Response visible | Next input ready | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| claude | 1 | 523.4 ms | 1107.7 ms | 1537.9 ms | 1704.9 ms | 1779.1 ms | 1873.5 ms | ok |
| claude | 2 | 515.8 ms | 1086.6 ms | 1544.5 ms | 1710.7 ms | 1865.1 ms | 1959.5 ms | ok |
| claude | 3 | 579.4 ms | 1163.8 ms | 1593.5 ms | 1761.4 ms | 1900.4 ms | 1995.2 ms | ok |
| codex | 1 | 23.7 ms | 2456.8 ms | 187.9 ms | 2624.8 ms | 4810.3 ms | 4912.6 ms | ok |
| codex | 2 | 23.1 ms | 2730.4 ms | 177.0 ms | 2898.7 ms | 2355.2 ms | 2467.8 ms | ok |
| codex | 3 | 45.2 ms | 2688.6 ms | 212.4 ms | 2856.8 ms | 2300.0 ms | 2402.6 ms | ok |
| grok | 1 | 313.6 ms | 1101.3 ms | 524.1 ms | 1418.7 ms | 4247.6 ms | 4336.3 ms | ok |
| grok | 2 | 288.9 ms | 1092.1 ms | 504.7 ms | 1417.6 ms | 3141.5 ms | 3224.6 ms | ok |
| grok | 3 | 159.1 ms | 920.2 ms | 341.9 ms | 1431.4 ms | 8122.7 ms | 8205.8 ms | ok |
| opencode | 1 | 1376.5 ms | 1892.4 ms | 5457.2 ms | 5633.0 ms | 3540.3 ms | 3702.8 ms | ok |
| opencode | 2 | 1150.7 ms | 1687.9 ms | 5249.4 ms | 5416.0 ms | 6291.6 ms | 6443.7 ms | ok |
| opencode | 3 | 1196.7 ms | 1716.7 ms | 4493.3 ms | 4661.7 ms | 3663.9 ms | 3822.8 ms | ok |

## Raw machine and attach samples

| Provider | Run | Session ready | Prompt accepted | First response | Complete | Attach sequence | Attach invoked | Session → input | Attach first byte | Paint settled | Input ready | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| claude | 1 | 3250.2 ms | 3250.2 ms | 6102.6 ms | 6277.1 ms | after-machine-turn | 3027.4 ms | 4672.1 ms | 607.0 ms | 1206.4 ms | 1644.7 ms | ok |
| claude | 2 | 3234.7 ms | 3234.7 ms | 4164.7 ms | 4833.1 ms | after-machine-turn | 1598.5 ms | 3206.3 ms | 586.8 ms | 1168.3 ms | 1607.8 ms | ok |
| claude | 3 | 3368.5 ms | 3368.5 ms | 8066.9 ms | 8244.3 ms | after-machine-turn | 4875.8 ms | 6517.5 ms | 626.3 ms | 1200.8 ms | 1641.7 ms | ok |
| codex | 1 | 547.6 ms | 31.1 ms | 3927.5 ms | 4184.2 ms | after-machine-turn | 4184.4 ms | 4482.9 ms | 31.6 ms | 1991.6 ms | 298.5 ms | ok |
| codex | 2 | 526.3 ms | 63.9 ms | 4000.5 ms | 4986.9 ms | after-machine-turn | 4988.9 ms | 5217.9 ms | 25.7 ms | 2452.8 ms | 229.0 ms | ok |
| codex | 3 | 874.4 ms | 39.1 ms | 3999.9 ms | 4188.9 ms | after-machine-turn | 4189.1 ms | 4388.3 ms | 28.3 ms | 1385.7 ms | 199.2 ms | ok |
| grok | 1 | 1151.3 ms | 13.4 ms | 2740.7 ms | 3140.4 ms | before-machine-turn | 1.5 ms | 940.7 ms | 666.5 ms | 1912.4 ms | 939.2 ms | ok |
| grok | 2 | 542.2 ms | 11.9 ms | 3000.8 ms | 3105.4 ms | before-machine-turn | 0.1 ms | 363.0 ms | 174.0 ms | 1225.1 ms | 362.9 ms | ok |
| grok | 3 | 453.8 ms | 14.0 ms | 3212.5 ms | 3566.1 ms | before-machine-turn | 0.1 ms | 376.4 ms | 200.9 ms | 1304.4 ms | 376.3 ms | ok |
| opencode | 1 | 1707.9 ms | 141.9 ms | 2796.1 ms | 2988.5 ms | before-machine-turn | 0.5 ms | 4327.1 ms | 1244.4 ms | 1760.5 ms | 4326.6 ms | ok |
| opencode | 2 | 1750.1 ms | 407.1 ms | 2014.4 ms | 2234.1 ms | before-machine-turn | 2.3 ms | 4354.5 ms | 1283.1 ms | 1799.5 ms | 4352.2 ms | ok |
| opencode | 3 | 1683.7 ms | 592.1 ms | 2774.1 ms | 2949.9 ms | before-machine-turn | 0.6 ms | 4606.2 ms | 1501.7 ms | 2018.2 ms | 4605.6 ms | ok |

## Mechanisms and evidence

- **claude 2.1.236 (Claude Code):** native = stock claude TUI creates and drives a new session; machine = process-per-turn Agent SDK query; attach = `claude --resume <session>`
- **codex codex-cli 0.151.0:** native = stock codex TUI creates and drives a new session; machine = Unix WebSocket app-server JSON-RPC; attach = `codex resume <thread> --remote unix://<socket>`
- **grok grok 0.2.118 (1e1687c1cf) [stable]:** native = stock grok TUI creates and drives a new session; machine = ACP stdio JSON-RPC; attach = `grok --resume <session>`
- **opencode 1.18.25:** native = stock opencode TUI creates and drives a new session; machine = Basic-auth loopback HTTP/SSE server; attach = `opencode attach <url> --session <session>`

Input probes type unique markers without Enter and require those markers to appear in the rendered terminal composer. “First keystroke” therefore measures whether input sent immediately after the first terminal byte survived startup; it is not inferred from painted output.

These are observations, not stable product budgets. Provider load, network conditions, model choice, account tier, local config/plugins, machine load, and OS cache state all affect them. Consult the sibling JSON for host load, exact per-stage evidence, executable paths, and partial failures.
