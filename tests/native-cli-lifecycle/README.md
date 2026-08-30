# Native CLI lifecycle benchmark

This is a live, Podium-independent benchmark for the native mechanisms used by
the Claude, Codex, Grok, and OpenCode headless runtimes. It imports no Podium
packages and starts no Podium server, daemon, relay, database, browser, abduco
master, or systemd scope.

Each sample creates a fresh native conversation in an otherwise empty temporary
working directory and measures three user-visible phases:

1. **Start** — process/API invocation to an addressable native conversation.
2. **Drive** — prompt submission to native acceptance evidence, first assistant
   output, and the provider's completion fence.
3. **Attach** — a fresh stock TUI in a real pseudo-terminal, including first
   output, initial-paint quiescence, and input readiness. Input readiness is
   proven by typing a unique marker without Enter and observing it echo in the
   composer's terminal output; the benchmark never submits that marker.

The provider mechanisms are intentionally direct:

| Provider | Engine/SDK | Drive | Fresh native client |
| --- | --- | --- | --- |
| Claude | process-per-turn Agent SDK query | SDK stream | `claude --resume <session>` |
| Codex | `codex app-server` over a Unix WebSocket | JSON-RPC `turn/start` | `codex resume … --remote unix://…` |
| Grok | `grok agent stdio` | ACP `session/prompt` | `grok --resume <session>` |
| OpenCode | authenticated `opencode serve` on loopback | HTTP async prompt + SSE | `opencode attach <url> --session <session>` |

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
