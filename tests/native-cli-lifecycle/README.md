# Native CLI lifecycle benchmark

This is a live, Podium-independent benchmark for the native mechanisms used by
the Claude, Codex, Grok, and OpenCode headless runtimes. It imports no Podium
packages and starts no Podium server, daemon, relay, database, browser, abduco
master, or systemd scope.

The report deliberately separates three independent lanes:

1. **Native CLI used by a human** — a stock TUI starts a new session in a real
   pseudo-terminal, accepts a typed prompt, renders a unique response, and
   becomes ready for the next prompt. Startup values are relative to CLI spawn;
   response values are relative to pressing Enter.
2. **Machine interface** — the vendor SDK/app-server/ACP/HTTP interface creates
   a session and drives one turn. It records session-ready, prompt-accepted,
   first-response, completion, and cold aggregate clocks.
3. **Headless session to native attach** — the machine interface creates the
   session, then a fresh stock TUI joins that exact session. The headline
   `sessionReadyToInputReadyMs` clock includes the gap from machine session-ready
   through a visibly usable attached composer.

Both TUI lanes prove input readiness by typing randomized punctuation without
Enter and observing it in the visible composer. The benchmark never submits the
probe. It also records first byte, last initial-paint byte, output quiescence,
whether the very first probe survived startup, and raw evidence for every clock.

The provider mechanisms are intentionally direct:

| Provider | Machine interface | Drive | Native attach |
| --- | --- | --- | --- |
| Claude | process-per-turn Agent SDK query | SDK stream | `claude --resume <session>` |
| Codex | `codex app-server` over a Unix WebSocket | JSON-RPC `turn/start` | `codex resume … --remote unix://…` |
| Grok | `grok agent stdio` | ACP `session/prompt` | `grok --resume <session>` |
| OpenCode | authenticated `opencode serve` on loopback | HTTP async prompt + SSE | `opencode attach <url> --session <session>` |

Grok and OpenCode can attach immediately after machine session creation, before
the benchmark machine turn. Claude's SDK creates the resumable session as part
of its query, so attach follows that turn. Codex `thread/start` has no resumable
rollout yet, so Codex attach follows its first completed machine turn. The JSON
labels every sample `before-machine-turn` or `after-machine-turn`; the Markdown
does not blend those sequences into an unlabeled median.

The harness removes provider API-key environment variables before child launch,
matching the native-login/subscription path instead of accidentally benchmarking
an inherited API key. It does not copy credentials or alter provider config.

Failed model turns retain any independently proven start and attach timings but are
excluded from drive medians. JSON and Markdown outputs are checkpointed after
every sample so a later provider timeout does not erase earlier evidence.

When Claude opens a benchmark-owned temporary directory, its native client may
show the workspace-trust gate. The harness accepts that one gate, records the
time and action count, and continues probing; it never auto-accepts trust for a
caller-supplied `--workdir`.

## Compare Podium drivers

`driver-comparison.ts` drives an already-running isolated Podium source host through its public tRPC and client WebSocket doors. It reads `daemon:agent-runtime-timing` records from that host’s NDJSON log, uses visible punctuation probes for headed and attached native composers, and compares the resulting medians with a standalone baseline JSON.

Start a source host with a dedicated state directory, ports, info logging, and the same provider executable PATH used by the standalone run. Unset an inherited `NOTIFY_SOCKET` when selecting the detached file sink. Then run:

```bash
bun --cwd tests/native-cli-lifecycle compare-drivers \
  --base-url http://127.0.0.1:18828 \
  --log /tmp/podium-driver-timing/logs/host.ndjson \
  --runs 3 \
  --baseline results/native-cli-lifecycle.json \
  --output results/driver-comparison.json \
  --markdown results/driver-comparison.md
```

Use `--providers`, `--modes`, and `--timeout-ms` for focused live shards. `--merge-results headed.json,headless.json` combines completed shards and renders a report without starting new sessions. The driver run spends provider quota; a named driver that fails admission remains a failed sample rather than silently degrading.

## Run

From the repository root:

```bash
bun --cwd tests/native-cli-lifecycle bench --runs 3 \
  --output results/native-cli-lifecycle.json \
  --markdown results/native-cli-lifecycle.md
```

Useful options:

```text
--providers claude,codex,grok,opencode
--runs <count>
--workdir <existing-directory>
--timeout-ms <model-turn-timeout>
--attach-timeout-ms <native-client-timeout>
--attach-quiet-ms <initial-paint-quiescence-window>
--no-native
--no-machine
--no-attach
```

Executable overrides are `NATIVE_CLI_BENCH_CLAUDE_BIN`,
`NATIVE_CLI_BENCH_CODEX_BIN`, `NATIVE_CLI_BENCH_GROK_BIN`, and
`NATIVE_CLI_BENCH_OPENCODE_BIN`. Optional model overrides use the same prefix
with `_MODEL`; the OpenCode value must be `provider/model`.

This is a quota-spending live benchmark, not a hermetic test. Samples run
sequentially to avoid cross-provider CPU and memory contention. OS page cache,
provider load, network conditions, account tier, config, plugins, and model
choice remain part of the observation, so keep the raw JSON with every report.
The harness records host load, CLI versions, run order, and exact evidence used
for every milestone.
