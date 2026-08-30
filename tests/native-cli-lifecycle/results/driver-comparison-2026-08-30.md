# Podium driver timing comparison

Measured 2026-08-30T17:17:05.748Z on flatblock (linux 7.0.0-30-generic). Standalone baseline: 2026-08-30T15:56:09.265Z.
Each cell is the median of up to 3 sequential live samples. Headed prompt: Reply with exactly DRIVER, then _, then OK; no spaces. Do not use tools. Headless prompt: Reply with exactly BENCH_OK and nothing else. Do not use tools.

## 1. Headed driver vs stock native CLI

| Provider | Samples | Podium first output | Direct first byte | Ratio | Podium composer ready | Direct input ready | Ratio | Podium bind ready | Podium response visible | Direct response visible | Podium turn complete | Podium next composer | Direct next input |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| claude | 3/3 | 633.1 ms | 523.4 ms | 1.21× | 1640.0 ms | 1544.5 ms | 1.06× | 30.6 ms | 1907.0 ms | 1865.1 ms | 1938.8 ms | 2111.0 ms | 1959.5 ms |
| codex | 3/3 | 154.1 ms | 23.7 ms | 6.50× | 311.0 ms | 187.9 ms | 1.66× | 57.8 ms | 3636.0 ms | 2355.2 ms | N/A | 3737.0 ms | 2467.8 ms |
| grok | 3/3 | 184.1 ms | 288.9 ms | 0.64× | 514.0 ms | 504.7 ms | 1.02× | 14.4 ms | 3435.0 ms | 4247.6 ms | N/A | 3638.0 ms | 4336.3 ms |
| opencode | 3/3 | 1097.3 ms | 1196.7 ms | 0.92× | 4361.0 ms | 5249.4 ms | 0.83× | 26.5 ms | 3317.0 ms | 3663.9 ms | N/A | 3525.0 ms | 3822.8 ms |

Podium composer readiness uses the same visible, non-submitted punctuation probe as the direct benchmark. Podium bind readiness remains separate because the first live sample proved a bound PTY can still be too early for input. Response clocks in both columns start at prompt submission.

## 2. Headless driver vs direct machine interface

| Provider | Samples | Podium session ready | Direct session ready | Podium accepted | Direct accepted | Podium first response | Direct first response | Ratio | Podium complete | Direct complete | Ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| claude | 3/3 | 4.9 ms | 3250.2 ms | 2.0 ms | 3250.2 ms | 5505.1 ms | 6102.6 ms | 0.90× | 5510.7 ms | 6277.1 ms | 0.88× |
| codex | 0/3 | N/A | 547.6 ms | N/A | 39.1 ms | N/A | 3999.9 ms | N/A | N/A | 4188.9 ms | N/A |
| grok | 3/3 | 475.9 ms | 542.2 ms | 0.8 ms | 13.4 ms | 5403.1 ms | 3000.8 ms | 1.80× | 5411.5 ms | 3140.4 ms | 1.72× |
| opencode | 3/3 | 3934.3 ms | 1707.9 ms | 82.9 ms | 407.1 ms | 3557.0 ms | 2774.1 ms | 1.28× | 3831.6 ms | 2949.9 ms | 1.30× |

All turn clocks start when Podium receives `sessions.sendText`. Claude SDK creates a lazy driver handle at launch, then starts its process-per-turn query on send; its direct baseline folds SDK initialization into the prompt clock, so turn first/complete are the comparable Claude values, not `session ready` or `accepted`.

## 3. Podium headless session → native CLI attach

| Provider | Samples | Podium session → composer | Direct session → input | Ratio | Podium attach → composer | Direct attach input | Ratio | Podium first output | Direct first byte | Internal writable | Endpoint ready |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| claude | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| codex | 0/3 | N/A | 4482.9 ms | N/A | N/A | 229.0 ms | N/A | N/A | 28.3 ms | N/A | N/A |
| grok | 3/3 | 1631.0 ms | 376.4 ms | 4.33× | 1528.0 ms | 376.3 ms | 4.06× | 170.6 ms | 200.9 ms | 18.1 ms | 20.9 ms |
| opencode | 3/3 | 4095.0 ms | 4354.5 ms | 0.94× | 4006.0 ms | 4352.2 ms | 0.92× | 1126.6 ms | 1283.1 ms | 12.7 ms | 12.7 ms |

Claude SDK native attach is N/A: the current embedded driver intentionally exposes no native CLI attach endpoint. Codex, Grok, and OpenCode attach through the same client-terminal path the native Podium view uses. Composer readiness is the human-usable probe; “Internal writable” and “Endpoint ready” expose how much earlier the driver considers the attach operational.

## Sample failures

- codex headless run 1: session_failed: this spawn asked for runtime driver 'codex-app-server' and it cannot be honoured here — codex app-server driver needs review: codex 0.151.0 is outside the range this driver was exercised against (0.147.x – 0.150.x; fixtures recorded from 0.147.0). Codex has renamed app-server approval methods before, and a driver whose approval method is wrong does not error — it never receives an approval and the session hangs on its first tool call. Re-record the fixtures in packages/agent-runtime/src/drivers/codex/__fixtures__ against the new version (`codex app-server generate-ts --out DIR` emits the protocol) and widen SUPPORTED_CODEX, or spawn this session on the terminal driver.
- codex headless run 2: session_failed: this spawn asked for runtime driver 'codex-app-server' and it cannot be honoured here — codex app-server driver needs review: codex 0.151.0 is outside the range this driver was exercised against (0.147.x – 0.150.x; fixtures recorded from 0.147.0). Codex has renamed app-server approval methods before, and a driver whose approval method is wrong does not error — it never receives an approval and the session hangs on its first tool call. Re-record the fixtures in packages/agent-runtime/src/drivers/codex/__fixtures__ against the new version (`codex app-server generate-ts --out DIR` emits the protocol) and widen SUPPORTED_CODEX, or spawn this session on the terminal driver.
- codex headless run 3: session_failed: this spawn asked for runtime driver 'codex-app-server' and it cannot be honoured here — codex app-server driver needs review: codex 0.151.0 is outside the range this driver was exercised against (0.147.x – 0.150.x; fixtures recorded from 0.147.0). Codex has renamed app-server approval methods before, and a driver whose approval method is wrong does not error — it never receives an approval and the session hangs on its first tool call. Re-record the fixtures in packages/agent-runtime/src/drivers/codex/__fixtures__ against the new version (`codex app-server generate-ts --out DIR` emits the protocol) and widen SUPPORTED_CODEX, or spawn this session on the terminal driver.

The sibling JSON contains every structured timing record and per-sample value. Provider load, account tier, page cache, host load, model choice, and workspace configuration remain part of this live observation.
