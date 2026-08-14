# The Codex app-server driver — what the binary actually does

POD-2024 (W6 of the POD-1761 agent-runtime epic). Everything below was measured
against **codex-cli 0.147.0** on a live app-server with a real ChatGPT
subscription. Where this contradicts the plan, the plan was written from
web-sourced research and the binary won.

The single most useful thing found: **the binary describes its own protocol.**

```
codex app-server generate-ts          --out DIR   # ts-rs bindings, every method
codex app-server generate-json-schema --out DIR   # the same as JSON Schema
```

That is why the fixtures in `packages/agent-runtime/src/drivers/codex/__fixtures__`
are exact rather than reverse-engineered, and why re-recording them when the pin
moves is cheap. `protocol-pins.json` records that every method this driver
speaks exists on the pinned binary, and a test asserts that list is complete.

---

## The two deviations from the plan

### 1. The transport is the child's stdio, not a unix socket

The plan preferred a per-session unix socket at 0600 and allowed
stdio-as-child as a fallback "if only stdio exists". Both exist. The socket is
still not usable, and this is the measurement rather than an impression:

| What was tried | Result |
| --- | --- |
| `--listen unix://PATH`, then connect + newline-JSON `initialize` | Socket created at `srw-------` (0600). Server **closes the connection** without answering. Reproduced with a 5s settle after the socket appears and 2s after connect, sending nothing but `initialize` — not a race, not a poisoned session. |
| Same, with LSP-style `Content-Length` framing | No response. |
| `codex app-server proxy --sock <path>` — the **first-party bridge** | Connects (exit 0), forwards, returns nothing. Tested with stdin held open, so not an early-EOF artifact. |
| `codex app-server daemon start` + `proxy` | The daemon's socket is at a **fixed, machine-global** path (`~/.codex/app-server-control/app-server-control.sock`) that `daemon version`/`stop` speak. |
| `codex app-server` on **stdio**, newline-JSON `initialize` | Answers immediately and carries the entire flow. |

Codex's own log names it: `app-server **control socket** listening`. It is a
daemon-management control plane, not the per-session client surface — and a
machine-global socket would contradict the epic's settled process-per-session
decision anyway.

**An inherited pipe is the stronger posture, not the weaker one.** Spec §6 asks
that the channel not be reachable by other local processes. A pipe has no
filesystem object to find, no path to leak, no mode bits to get wrong, no stale
socket to reclaim — and no `SUN_LEN` limit, which bites for real: a socket under
the instance state dir is refused outright with `path must be shorter than
SUN_LEN`.

### 2. `adopt()` resumes the thread; it does not rebind a survivor

`codex app-server` **exits cleanly (code 0) the moment its stdin reaches EOF** —
verified. The transport is the child's stdio, so when the daemon dies its pipes
close and every codex child dies with it. There is no orphan to find.

What survives is the thing that matters. Codex writes each thread to its own
rollout JSONL, so `adopt()` starts a fresh child and `thread/resume`s the
journalled thread id. Session id, thread id, transcript, resume ref, turn epoch
and event seq all hold across the restart (the last two via the journal); the
binding version increments and an `adopted` process event says so.

> **For anyone writing an e2e:** an assertion shaped like opencode's — "the
> server process is still alive after the daemon restarts" — will fail here and
> should not be written that way. The right assertion is conversational
> continuity: same session id, same thread id, transcript intact, new binding
> version.

The same property is why this driver can claim `archive.byteFaithful: true`
where the opencode driver could not: one file per thread, owned by nothing else.

---

## Protocol facts that cost time to find

These are invisible in the generated type definitions. Each is pinned by a test.

**Responses omit `jsonrpc`.** JSON-RPC 2.0 says a response carries
`"jsonrpc":"2.0"`; codex does not send it. A client that validates it rejects
*every* reply the server ever makes, and the failure presents as "all my
requests time out".

**Handshake violations are silence, not errors — and they poison the
connection.** A `thread/start` before `initialize` gets no response, *and* the
`initialize` that follows never answers either. There is nothing to recover to,
so the client refuses to send at the call site rather than trying and timing
out.

**Server→client request ids start at ZERO.** `if (msg.id)` is the obvious way to
test for a request id and it is false for the first approval of every session —
so the very first permission prompt a user ever sees would be the one silently
dropped, and the turn would park with nothing to show for it.

**`turn/start`'s ack lands *before* `turn/started`, and a steer in that window is
refused.** The response carries a `Turn` with `status: inProgress` — that is the
protocol ack the `accepted` receipt rests on — but the turn is not *steerable*
until the notification arrives. A `turn/steer` fired in between gets
`-32600 no active turn to steer`. The driver parks the id as pending and waits.

**`availableDecisions` is on the wire and not in the generated bindings.** It is
the only honest source for whether an always-allow is on offer: the live ask
listed `['accept', {acceptWithExecpolicyAmendment: …}, 'cancel']` — no
`acceptForSession` *and no* `decline`. A driver assuming the full decision enum
would offer a user a button whose answer the server rejects.

**The subscription assertion is `authMethod`, not `auth_mode`.** `getAuthStatus`
returns `{authMethod: 'chatgpt', authToken: null, requiresOpenaiAuth: true}`.
Reading the field the plan guessed would make the assertion silently vacuous —
`undefined !== 'chatgpt'` looks exactly like an API key winning.

**`thread/status/changed` carries `activeFlags: ['waitingOnApproval']`.** That is
the one flag that changes the meaning of `active`: the thread is not computing,
the user is what it is waiting for. Folding it into plain activity puts
"working" on the badge of a session that is waiting for the person reading it.

---

## What is new in the fleet

**Native steer.** Codex has `turn/steer`, exercised live: steering into an open
turn returns `{turnId}`, the words join *that* turn, and the steered content
appears in its output. This is the first driver in the epic to report
`deliveredAs: 'steer'` because it steered, rather than reporting the `queue`
downgrade. The turn epoch is unchanged, because a steer joins a turn rather than
opening one.

The permitted-failures table does **not** move. The server row still permits
`no-native-steer` and this driver passes that row verbatim, because the corpus
requires the claim to equal the family row. The real check is the one W5's review
added: `deliveredAs` must name a delivery the driver *declared* native, in both
directions. This driver is the first case where the family ceiling and the
per-driver truth differ — precisely the case that reshaping was written for.

**The approval inversion.** The server asks *us* questions over the same pipe and
blocks until answered, with no timeout of its own behind it. An interaction here
is not an event observed and later replied to out of band — it *is* an open
JSON-RPC request whose response is the answer. That is also why the ask id is
the request id: replying means answering that exact id, and
`serverRequest/resolved` reports closure by the same id (including when somebody
else answered it, at an attached TUI).

**Subscription auth, headless, proven rather than assumed.** The child is spawned
with `OPENAI_API_KEY` / `CODEX_API_KEY` / `CODEX_ACCESS_TOKEN` /
`OPENAI_ORGANIZATION` / `OPENAI_BASE_URL` stripped — Codex *prefers* an inherited
key over the stored ChatGPT login, so without this a session would bill an API
account while the operator believed otherwise, invisibly. The strip is the
mechanism; asking the server which credential it actually chose is the proof, and
they are not the same thing, because Codex resolves credentials from several
places and a strip only proves what *we* did.

---

## Evidence

| Layer | Where | Runs |
| --- | --- | --- |
| Recorded frames from a live 0.147.0 | `drivers/codex/__fixtures__` + `protocol.test.ts` | every run |
| Driver behaviour vs a fake built from those frames | `runtime.test.ts`, `map.test.ts` | every run |
| The shared conformance corpus, zero extra exemptions | `codex-app-server.conformance.test.ts` | every run |
| Daemon half: env hygiene, version gate, selection | `apps/daemon/src/runtime/codex-app-server.test.ts` | every run |
| **A real subscription, real turns, real steer** | `drivers/codex/live.test.ts` | opt-in, `PODIUM_CODEX_LIVE=1` |

The live run is opt-in because it spends real quota and takes ~20 minutes of wall
clock on a loaded box; a gate that is occasionally red for reasons unrelated to
the change is a gate people learn to ignore. It passed: auth `chatgpt`, a real
turn fenced on the provider's own completion, a steer landing in the running
turn, and hibernate/resume into a fresh child on the same thread.

## Known gaps, stated rather than discovered

- **`attach` is declared but no shipped host wires it.** The capability says
  `supported({kinds:['client']})` and the driver's half is real — it asks its
  host, refuses a take-over another holder has, and takes the lease only when a
  host answers. But `createCodexHost` is built with `memoryBytes` alone, so
  `attach()` in production always answers `unsupported`. Making it true is
  `codex --remote`, which the plan puts out of scope as attach v2. It is not
  declared `unsupported` instead because `PERMITTED_FAILURES.server` does not
  carry `no-attach` (only the embedded family does), and that table belongs to
  POD-2085 — a driver may not edit it to make its own declaration fit.

- **MCP is built but unfed.** The mount works end to end — `codexAppServerConfigArgs`
  builds the `-c mcp_servers.…` overrides through the manifest's own verified
  `codexMcpArgs`, and `SessionSpec.mcpServers` carries the declaration to it —
  but the interactive `spawn` frame has no MCP config field, because interactive
  sessions have always mounted MCP through the CLI's own config file. An
  app-server session mounts whatever `~/.codex/config.toml` declares. Adding the
  wire field is a one-line change at the caller.
- **The default stays terminal.** The driver is an explicit per-spawn opt-in, as
  the plan requires; the terminal driver remains Codex's permanent fallback.
  Promoting it in the manifest ranking is a separate decision that belongs to
  whoever has run it long enough to argue for it.
- **`question` interactions are not declared.** `item/tool/requestUserInput`
  exists in the bindings but never fired in any live run, and declaring a kind
  this driver has never seen would promise an ask it cannot produce.
- **Restart-adoption is wired end to end, and it RESUMES rather than rebinds.**
  The daemon's reattach path consults every server-family journal, and a codex
  entry resumes its thread in a fresh child (`codex-driver.ts`'s
  `adoptFromJournal`, tested at the daemon layer). It cannot rebind a survivor,
  because there is never one: `codex app-server` exits on stdin EOF and the
  channel is the child's stdio. Session id, thread id, transcript, resume ref
  and turn epoch all hold; the process is new and says so.

- **The web-UI demonstration is by construction, not by observation.** The daemon
  half emits the same `bind` / `transcriptDelta` / `agentState` / `agentExit`
  vocabulary W5 proved against the existing UI; this session verified the driver
  end to end against the real binary but did not drive a browser.
