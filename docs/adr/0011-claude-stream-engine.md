# ADR 11: Claude stream engine under podium-host

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-09-21 |
| **Issue** | POD-4499 (decision 2.3 of the 1.R Phase 1 review, POD-4480 deviation D5) |
| **Related** | ADR 10 (adapter/driver boundary; construction table); POD-4433 (engines under podium-host); POD-4497 (follows: moves remaining process/routing decisions) |

## Context

Podium drove headless Claude sessions process-per-turn through a bespoke
helper: the driver family spawned `claude-sdk-host` per turn, which called
the Agent SDK's `query()` with `resume`, which spawned the `claude` CLI —
two new processes per turn, self-spawned by the family, nothing under
podium-host, nothing surviving a daemon restart. The justification was crash
isolation of the SDK library from the daemon. The competitor survey (t3-code,
synara, paseo, superset, cmux, humanlayer, multica) found nobody wraps the
SDK in a helper process and nobody argues for crash isolation of the SDK
library itself: all keep one long-lived `claude` child per session.

## Decision

The engine for a headless Claude session is the `claude` CLI child in
streaming-input mode: one per session, long-lived, spawned by DaemonSession
under podium-host `--no-pty` exactly like codex/opencode/grok
(`EngineSupervisor.spawnHeadless`; stdio rides the host ring + WRITE).
The family speaks the CLI's stream-json control protocol directly over the
attachment (`initialize` / `user` / `control_response` in,
`control_request` / transcript messages out — the shapes recovered from the
SDK 0.3.201 bundle, whose `spawnClaudeCodeProcess` seam exists precisely so
the transport can be replaced), and the `@anthropic-ai/claude-agent-sdk`
dependency is dropped: there is no SDK parent left to host, in the daemon
or anywhere else. Restart adopts the surviving child by durable label with a
fresh `initialize` (the SDK's own `reinitialize()` shape for transport gaps,
including pending-permission redelivery); only when nothing survived does a
fresh child start with `--resume` off the journalled harness session id. A
live-but-unbindable engine is kept and reported as
`EngineBindUnrecoverable`, never silently orphaned and never quietly reaped.
The daemon still never loads the SDK — the isolation test now guards an
absence rather than a single edge — and the family never forks (spec §7, now
a test rather than a grep).

What is lost against the SDK, stated so no later lane re-litigates it:
in-process hook callbacks, in-process (`type: 'sdk'`) MCP servers,
`sessionStore` transcript mirroring, elicitation and user-dialog handlers,
and token-refresh callbacks — none of which Podium ever set (its permission
answers, MCP config, model/effort/permission-mode and system-prompt append
all travel on the wire). What is kept: structured permission asks
(`can_use_tool` over `--permission-prompt-tool stdio`, answered exactly as
the SDK answers them), tool call/result transcript pairs, partial text,
interrupt with a provider ack (5 s) escalating to SIGINT via the host, and
the fail-closed no-tools mode. One-shot A2A turns stay per-turn by nature
but spawn the CLI directly in the daemon's one-shot runner (backend=none
safe) instead of through a helper. Production restart-adopt routing for
Claude sessions (machine-runtime's embedded source → server list) is
POD-4497's move; this issue delivers the engine, the journal, the adopt
shape and the survival test.

## Consequences

"How does Podium talk to Claude" has one answer readable from imports (the
stream engine host) instead of three files of helper plumbing; a Claude
session survives a daemon SIGKILL with its child pid intact and its
in-flight turn completing, proved by the extended survival test. The cost is
a protocol surface Podium now owns: the wire shapes are bundle-recovered,
not CLI-contracted, and no authenticated `claude` CLI exists in this
environment to answer — real-CLI interop (initialize payload acceptance,
`--session-id` minting, permission round-trip, interrupt ack) is verified by
a live run, recorded in VERIFY, and any divergence lands here as an
amendment, not as a helper process.

## Amendment 1 (POD-4612): the routing move landed, and the family is `server`

The move deferred above is done. The Claude session runtime sits in the
machine runtime's server list beside codex, opencode and grok; the
bespoke daemon arm that adopted or resumed a Claude session
(`control/session.ts`) and its separate kill branch are deleted. Reattach
goes through the generic journal adopt (`adoptServerDriverSession`), which
now also refuses a row whose resume ref names a different conversation than
the journal — the one check the bespoke arm carried. Teardown goes through
the generic server reap, measured against the engine's own identity: the
handle binding carries the engine's durable label, its scope unit, and its
pid while held. Hibernate-then-adopt wakes the session on its own
conversation and model, as the server family's conformance properties
require.

The driver's family is `server`: there is no `embedded` family any more.
The manifest keeps its `runtime.embedded` axis (the vendor ships no server
mode; Podium hosts the CLI's engine), and that axis's driver classifies as
`server`. Wire parsers still accept an older peer's `embedded` and
normalize it to `server` where it enters (`DriverFamilyWire`); nothing in
this build produces it. The server family now permits `no-attach`, pinned
per driver (`NO_ATTACH_DRIVERS` = `claude-sdk`), the same pattern as
`no-native-steer`.
