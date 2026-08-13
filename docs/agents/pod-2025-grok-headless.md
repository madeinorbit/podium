# Grok headless feasibility (POD-2025, epic POD-1761 / W7)

**Question.** Can grok run as a **server-family** driver (a persistent headless process we speak a
protocol to), an **embedded/resume-exec-style** driver, or does it stay **terminal-only**?

**Recommendation: server driver via ACP.** Build `drivers/grok-acp` over `grok agent stdio`.

**Verdict on spec §2: the "Grok, Cursor — terminal only" row MUST BE AMENDED** for grok. Grok belongs
in the `server` family. (I make no claim about Cursor; it was not in scope.) This is a spec change
only the coordinator can make — flagged as such, not made here.

Probed against **grok 0.2.118 (1e1687c1cf) [stable]**, logged in via grok.com, Linux, 2026-08-13.
Everything below marked "verified" was executed. Where I only read docs, or only saw a capability
advertised without exercising it, it says so.

---

## 1. What Podium already knows

`docs/agent-harness-reference/grok.md` (verified against 0.2.101) already records the agent modes as
*(established)*: §2 lists `grok agent stdio` (ACP JSON-RPC), `grok agent serve --bind 127.0.0.1:2419
--secret <tok>`, `grok agent headless` (xAI relay), and the leader model; §7 ranks `updates.jsonl`
as "the ACP stream, equally authoritative if you consume ACP"; §13's matrix answers "Structured
control protocol: **Yes**".

So the modes were never a discovery. **What was missing is the verification** that they meet spec
§3's core contract — and a verdict. That is what this report supplies. It also corrects four entries
in that reference (§"Corrections", below), because my probes contradict them.

Current integration, for contrast:

- **Terminal path:** PTY + TUI, with `packages/harness/src/agent-state/grok.ts` polling
  `~/.grok/sessions/<pct-encoded-cwd>/<id>/updates.jsonl` every **700 ms**, tailing the last 128 KB.
- **Headless path:** `packages/harness/src/manifests/grok.ts` declares
  `headless: {driver: 'resume-exec', outputFormat: 'text'}`, building
  `grok [--resume <id> | --session-id <uuid>] [--model …] [--permission-mode auto] [--rules …] --single <prompt>`.
- **Hooks:** `apps/daemon/src/grok-hooks.ts` idempotently maintains `$GROK_HOME/hooks/podium.json`
  across 14 lifecycle events, env-gated by `PODIUM_GROK_HOOK_URL`.

## 2. Verifying the ACP server modes against spec §3

Driving `grok agent stdio` from a hand-written ACP client (`initialize` → `session/new` →
`session/prompt`) against a real logged-in account:

| Spec §3 core requirement | Result |
| --- | --- |
| **Persistent multi-turn process** | **Yes.** Turn 1 stored a codeword, turn 2 recalled it on the same process. ~1.8–2.5 s per trivial turn, no PTY warm-up |
| **(a) Resume an existing session by id** | **Yes.** `SIGKILL` the process, start a fresh one, `session/load` the same id → **329 ms**, transcript replayed as `session/update` notifications, and the model still recalled the pre-kill codeword |
| **(b) Structured permission asks + structured answers** | **Yes.** Server→client JSON-RPC request `session/request_permission`, carrying the tool call, a structured `rawInput`, and typed options. Answering it let the tool run |
| **(c) Interrupt an in-flight turn** | **Yes.** `session/cancel` → the pending `session/prompt` returned `{stopReason: "cancelled"}` in **10 ms** |
| **(d) Cursor-fenced updates** | **Yes.** Every notification carries `_meta.eventId` = `<sessionId>-<n>`, monotonic per session — a ready-made contract cursor. `updates.jsonl` offsets remain available as a second cursor |
| **Turn receipt** | **Yes.** `session/prompt` *returns* `{stopReason: "end_turn"}` — a protocol-level receipt, not a heuristic. A grok ACP driver would never need the contract's `unverified` outcome |

Captured traffic, permission request (elided for width):

```json
{"method":"session/request_permission","params":{
  "sessionId":"019ffd59-…","toolCall":{"toolCallId":"call-71f7c51c-…-0","kind":"execute",
    "title":"Execute `echo ZEPHYR > probe.txt`",
    "rawInput":{"variant":"Bash","command":"echo ZEPHYR > probe.txt","description":"Write ZEPHYR to probe.txt"}},
  "options":[{"optionId":"allow-once","name":"Yes, proceed","kind":"allow_once"},
             {"optionId":"reject-once","name":"No, and tell Grok what to do differently","kind":"reject_once"}]}}
```

answered with `{"outcome":{"outcome":"selected","optionId":"allow-once"}}`, after which the tool ran
and the turn closed `end_turn`.

`agentCapabilities` from `initialize`: `loadSession: true`, `sessionCapabilities.list`,
`mcpCapabilities: {http: true, sse: true}`, `promptCapabilities.embeddedContext: true` (no
image/audio).

`session/update` kinds observed in one session — a superset of what grok.md §7 lists:
`user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`,
`tool_call_delta_chunk`, `available_commands_update`, `model_changed`, `session_info_update`,
`hook_execution`, `response_completed`, `turn_completed`, `session_summary_generated`, and
**`pending_interaction` / `interaction_resolved`**.

`session/set_mode {modeId: "default"}` succeeded and flipped the session out of the config's
auto-approve into prompting — **permission behaviour is settable per session over the protocol**,
not just per config file. That matters: the driver controls it, not the user's `config.toml`.

### `grok agent serve` (WebSocket)

Defaults to `127.0.0.1:2419`. `--secret` sets the token (env `GROK_AGENT_SECRET`); **if omitted the
server generates one and prints it**. The banner prints the URL form, which is not documented
elsewhere: `ws://127.0.0.1:<port>/ws?server-key=<secret>`.

Auth is enforced — four connections tested against a live server:

| Attempt | Result |
| --- | --- |
| `/ws`, no key | **refused** |
| `/ws?server-key=WRONG` | **refused** |
| `Authorization: Bearer <secret>` on `/` | **refused** (query param is the only accepted form) |
| `/ws?server-key=<correct>` | **connected**; ACP `initialize` returned the same capabilities as stdio |

So spec §6's connect-without-secret conformance test passes against grok's server mode **as
shipped**, with no work on our side. Sequential reconnects handshake cleanly.

### `grok agent leader` — available, deliberately rejected

Creates a unix socket (default `~/.grok/leader.sock`, `--leader-socket` overrides) so several
clients share one agent backend. Rejected for two reasons:

1. It contradicts the epic's standing decision of **process-per-session, dedicated servers only**.
   A shared backend puts unrelated Podium sessions in one blast radius.
2. Its purpose is the grok.com relay, not a local API. `grok leader info` failed with *"no reachable
   leader found for target wss://code.grok.com/ws/code-agent"* — discovery is keyed to the relay
   target. My attempt to attach via `grok agent --leader … stdio` produced no handshake in 30 s; I
   did not chase it, since the mode is the wrong shape regardless.

Also: the socket was created `0755` (`srwxrwxr-x`). Other local users cannot connect (that needs
write permission), but it is not the `0600` the spec mandates for Codex sockets — one more reason to
prefer stdio, which needs no filesystem rendezvous at all.

`grok agent headless` dials **out** to `wss://code.grok.com/…`. Not applicable: it is xAI's
remote-control path, not a local API.

## 3. ACP by name — and it generalizes past grok

Grok implements the [Agent Client Protocol](https://agentclientprotocol.com), created by Zed, with a
public spec and published SDKs (TypeScript `@agentclientprotocol/sdk`, Rust, Python, Go, Kotlin). It
is a standard, not a grok-private RPC surface.

The spec's [prompt-turn lifecycle](https://agentclientprotocol.com/protocol/prompt-turn) defines
exactly the vocabulary I observed. `stopReason` ∈ `end_turn` | `max_tokens` | `max_turn_requests` |
`refusal` | `cancelled` — a closed set that maps cleanly onto the contract's `TurnReceipt` and
`TurnFailed` reasons, with no provider-specific guesswork. Cancellation semantics are specified:
on `session/cancel` the agent stops model requests and tool calls, the client answers any pending
permission request with a cancelled outcome, and the agent closes the turn `cancelled` rather than
erroring. Grok's 10 ms `cancelled` matches the spec exactly.

**The strategic point the checklist asks about: an ACP driver generalizes well beyond grok.**
Per Zed's own listings, agents implementing ACP include **Codex CLI, Gemini CLI, Claude Agent,
GitHub Copilot, Cline, and Goose**; clients include Zed, Neovim, Emacs, and marimo. So
`drivers/acp` — with grok as its first instance — is plausibly a *shared substrate* rather than a
one-off, and it bears directly on **W6 (Codex)**, which currently plans a bespoke `codex app-server`
JSON-RPC client. Whether codex's ACP surface is first-party and equivalent to its app-server is a
real question I did **not** investigate (out of scope: "anything about codex/opencode"). I flag it
as a lead for the coordinator, not a conclusion.

One caution: ACP's own introduction notes "full support for remote agents is a work in progress",
and grok layers private `_x.ai/*` extension methods over the core (`_x.ai/session/update`,
`_x.ai/models/update`, `_x.ai/queue/changed`, `_x.ai/sessions/changed`). Core ACP is the stable part;
the `_x.ai/*` namespace is grok's to churn.

## 4. The fallback: multi-turn headless without a server

Assessed against the contract, since the plan named `resume-exec` as the alternate recommendation.
It is **viable but strictly worse**, and today's implementation leaves value on the table:

- **Receipts — available, and currently discarded.** grok.md §12 documents
  `--output-format json` → `{"text","stopReason","sessionId","requestId"}`. Podium's manifest
  declares `outputFormat: 'text'` and `runResumeExecTurn` in `apps/daemon/src/headless-drivers.ts`
  falls through to the generic branch that collects stdout and relies on the child's **exit code**.
  So the explicit `stopReason` and `sessionId` grok already offers are thrown away. Switching to
  `--output-format json` is a cheap, independent improvement to the *existing* headless path,
  needing no driver work at all.
- **Interactions — observable, not answerable.** `events.jsonl` is the highest-authority stream and
  does carry them. From my probe session:
  ```json
  {"ts":"…","type":"permission_requested","tool_name":"run_terminal_command"}
  {"ts":"…","type":"permission_resolved","tool_name":"run_terminal_command","decision":"allow","wait_ms":68}
  {"ts":"…","type":"turn_ended","outcome":"completed"}
  {"ts":"…","type":"turn_ended","outcome":"cancelled","cancellation_category":"mid_turn_abort"}
  ```
  But this is a *read* channel. A one-shot child has no way to receive the answer, so the only real
  options are pre-empting with `--permission-mode`/`--always-approve` (i.e. no interactions at all)
  or the PTY keystroke path. W2's PendingInteraction aggregate would be observe-only. **The ACP path
  makes them answerable**; resume-exec cannot.
- **Interrupt** is child `SIGKILL` — a blunt fence, versus ACP's 10 ms cooperative `cancelled`.
- **Cursoring across one-shots** works (`events.jsonl` / `updates.jsonl` offsets survive between
  children) but re-derives per-turn what the live stream hands over continuously.
- **Cost:** a fresh process per turn, re-reading session state each time, versus a warm process.

Also worth noting for anyone tempted by resume-exec: `events.jsonl` fired **122 `phase_changed`
against 3 `turn_started`** in my short session. grok.md §7's debounce warning is not theoretical.

**Conclusion for item 4:** resume-exec is the right *fallback* if the ACP surface turns out to churn
badly across grok 1.x, and its `--output-format json` upgrade is worth doing regardless. It is not
the recommendation.

## 5. The finding that most changes the cost estimate

**Podium's existing grok observer is already parsing ACP frames off disk.**

I dumped `updates.jsonl` after my probe session. Its records are **verbatim ACP JSON-RPC
notifications** — the identical objects the live stream pushes:

```json
{"timestamp":1786661939,"method":"_x.ai/session/update","params":{"sessionId":"019ffd59-…",
 "update":{"sessionUpdate":"hook_execution","event_name":"session_start",
           "runs":[{"name":"global/podium:session_start[0].hooks[0]","status":{"status":"success","elapsed_ms":43}}]},
 "_meta":{"eventId":"019ffd59-…-2","agentTimestampMs":1786661939811}}}
```

The file contained exactly the `session/update` and `_x.ai/session/update` methods I had just
watched go by on stdout. grok.md §7 says as much in prose; this confirms it byte-for-byte.

So `GrokCausalObserver` and the grok reducer **already speak the driver's event language**. A grok
ACP driver is not a new event vocabulary plus a new reducer — it is swapping a 700 ms file tail for
a live push stream feeding the reducer that exists, with `_meta.eventId` as the causal cursor. Most
of the read path is already written; what is missing is the transport and the write path.

Two corollaries:

- **Podium's hooks fire inside ACP sessions.** My probe emitted
  `hook_execution {event_name: "session_start", runs: [{name: "global/podium:session_start[0].hooks[0]", status: success}]}`
  and the same for `user_prompt_submit`. The global install in `apps/daemon/src/grok-hooks.ts` is
  transport-independent — it works on the ACP path unchanged. (Hook-anchored receipts are moot
  there, since `session/prompt` returns a real receipt, but the other 12 events still land.)
- **`initialize` advertises blocking hooks:**
  `_meta["x.ai/hooks"] = {blockingEvents: ["pre_tool_use","stop","subagent_stop"], decisions: ["deny","block"], stopSignals: ["continue","stopReason","additionalContext"]}`.
  Spec §135 says *"Grok mail delivery sacrifices a denied tool call because there is no blocking
  Stop hook"*, and grok.md §8 says *"passive Stop output is ignored by Grok"*. Grok now advertises a
  blocking `stop` with `continue` + `additionalContext` — the exact primitive that workaround
  substitutes for. **I did not verify the blocking behaviour end-to-end**, so I am not calling either
  document wrong; filed as **POD-2026** for a dedicated check.

## Recommendation

**Build a server-family driver over `grok agent stdio` (ACP).** Grok clears every core requirement
in spec §3 — persistent process, protocol-level turn receipts with a closed `stopReason` set, 10 ms
cooperative interrupt, 329 ms resume-after-SIGKILL, structured answerable permissions, and a
monotonic event cursor — and it clears them *as shipped*, needing none of the terminal family's
permitted failures. Prefer **stdio over the WebSocket `serve` mode**: the daemon owns the child's
pipes, so OS process isolation replaces the loopback-port-plus-random-secret machinery W5 must build
for opencode (strictly less security surface), process-per-session falls out for free, and stdio is
the transport grok documents and every ACP client uses. Keep `serve` as the documented fallback for
the day something outside the daemon's process tree must attach — same protocol, same client code,
different pipe. Sequence it **after W5**: not because it is hard, but because ACP would be a third
protocol dialect and the contract's shape should be proven once before a third driver is poured into
it. Once W1/W2/W3/W5 land, grok is plausibly the **shortest** remaining driver, because the reducer
and hook channel already exist and the transport is a standard with an off-the-shelf SDK.

### Scope sketch for the work item (filed as POD-2027)

**`packages/agent-runtime/src/drivers/grok-acp/`**

- **Process.** Spawn `grok agent stdio` per session under the existing systemd-scope machinery
  (the non-PTY `systemd-run --user --scope` path `packages/pty` already has). No port, no secret,
  no socket. `--cwd` is the session workspace; auth rides `~/.grok/auth.json` untouched. Keep
  `XAI_API_KEY` out of the spawn env (it flips grok to API-key mode — grok.md §4).
- **Client.** A thin ACP JSON-RPC client over the child's pipes — either
  `@agentclientprotocol/sdk` or ~200 lines hand-written (my throwaway probe client was ~90).
  Methods needed: `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`,
  `session/set_mode`, plus handling the server→client `session/request_permission` and
  `fs/read_text_file` requests.
- **Mapping.**
  - `create/resume` → `session/new` / `session/load` (`loadSession: true` is advertised).
  - `send()` → `session/prompt`; receipt = `accepted` on dispatch, turn closes on the returned
    `stopReason`. Map `end_turn`→completed, `cancelled`→interrupted, `refusal`/`max_tokens`/
    `max_turn_requests`→`TurnFailed` reasons. **`unverified` is never needed.**
  - `events()` → `session/update` notifications into the **existing** grok reducer
    (`packages/harness/src/agent-state/grok.ts`, `GrokCausalObserver`) — the payloads are already
    the shapes it parses. Cursor = `_meta.eventId`.
  - `interrupt()` → `session/cancel`; the fence is provider-confirmed by the `cancelled` stopReason.
  - Interactions → `session/request_permission` into W2's PendingInteraction aggregate; answer with
    `{outcome:{outcome:"selected",optionId}}` from `options[].optionId`.
  - `transcript.history` / `export()` → reuse the existing session-dir readers unchanged.
- **Selection.** Manifest `runtime.server` spec for grok + per-spawn override; default stays
  terminal until proven.
- **Version pin.** Record the range, refuse outside it with a machine diagnostic (the codex-hooks
  gate pattern), plus recorded-fixture tests for the protocol shapes used.

**Open questions the driver must settle** (none look blocking):

1. **Version.** Probed 0.2.118; the binary reported **1.0.3** available. A major-version jump sits
   between what I tested and current. Re-probe on 1.x before committing to the surface — especially
   the `_x.ai/*` extensions, which are freer to churn than core ACP.
2. **Client fs callbacks.** Declaring `clientCapabilities.fs.readTextFile: true` makes grok delegate
   file reads *back to the client* via an `fs/read_text_file` request. My first probe **deadlocked**
   on exactly this. Declare fs capabilities `false` and let grok do its own IO, or implement the
   callbacks properly — never declare a capability you do not serve.
3. **`pending_interaction` vs `session/request_permission`.** Grok emits both. Which is
   authoritative for W2's aggregate needs a read; my guess is the request is the answerable one and
   the update is the observable mirror, unconfirmed.
4. **Flag mapping.** `--sandbox` and `--worktree` are top-level CLI flags with no obvious ACP
   equivalent. If Podium relies on them for grok today, check how they map before switching sessions.

## Corrections to `docs/agent-harness-reference/grok.md`

That reference was verified against 0.2.101; four entries are now wrong or incomplete on 0.2.118.
Filed as **POD-2028**.

1. **§5 "Pricing / cost: not supported"** and **§5 / Open-questions "per-turn input/output/cache/
   reasoning token split — not in plain files / likely absent"** — **both wrong on the ACP path.**
   Every `session/prompt` result carries `_meta.usage` with exactly that split, plus cost:
   ```json
   {"inputTokens":32832,"outputTokens":56,"totalTokens":32888,"cachedReadTokens":32640,
    "cacheCreationTokens":0,"reasoningTokens":49,"modelCalls":1,"apiDurationMs":1660,
    "costUsdTicks":170400000,
    "modelUsage":{"grok-4.6-build":{…}}}
   ```
   Per-turn accounting and a per-turn cost figure are both available — over the protocol, not on disk.
2. **§7 `updates.jsonl` sessionUpdate list is incomplete.** Add `tool_call_delta_chunk`,
   `model_changed`, `session_info_update`, `response_completed`, `turn_completed`,
   `session_summary_generated`, `pending_interaction`, `interaction_resolved`.
3. **§8 "passive Stop output is ignored by Grok"** — contradicted by what `initialize` advertises
   (`blockingEvents` includes `stop`). Unverified either way; see POD-2026.
4. **§2/§15 `agent serve`** — record the URL form `/ws?server-key=<secret>` (Bearer headers are
   refused), and that omitting `--secret` **auto-generates and prints one** rather than disabling auth.
5. Minor drift: §1 verifies 0.2.101; §5's catalog (`grok-4.5` + `grok-composer-2.5-fast`) is now
   `grok-4.6` (default) + `grok-4.5`.

## Reproducing

Probe scripts were throwaway and are not committed. The core check is ~20 lines: spawn
`grok agent stdio`, write newline-delimited JSON-RPC to stdin, and send

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,
 "clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false}}}}
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp/x","mcpServers":[]}}
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"…",
 "prompt":[{"type":"text","text":"hello"}]}}
```

Answer any server→client `session/request_permission` with
`{"outcome":{"outcome":"selected","optionId":"allow-once"}}`. Keep `fs` capabilities `false` or you
will deadlock on `fs/read_text_file`. For the permission path, `session/set_mode {modeId:"default"}`
first, or a config with `[ui] permission_mode = "auto"` will auto-approve and you will see nothing.

**Scope note.** Investigation only, per W7 — no implementation, no manifest changes, and nothing
outside this document changed.
