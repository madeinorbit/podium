# The six terminal objects — where they live and what may import them

Standing description of the runtime stack POD-4414 ends with. This page says
**here**: each object, its one place in the tree, and the import direction the
`terminal-objects-*` boundary lint enforces so the structure cannot drift back.
Design history (the ten conceptual layers, the alternatives rejected) lives in
`docs/plans/pod-4414-terminal-layers-in-code.html`; construction and failure
ownership live in ADR 10 (`docs/adr/0010-harness-adapter-and-driver-boundary.md`,
"Construction and failure ownership", as amended by user decision 2026-09-28).

## The objects

| Object | Lives in | May import | Must never import |
|---|---|---|---|
| podium-host | `packages/pty/vendor/podium-host/` (Rust), driven by `@podium/process/durable` | libc, its pinned crates | anything |
| DurableProcess | `@podium/process/durable` (`packages/pty/src/durable-process.ts`) | the host adapter, the adoption-only abduco adapter, scope helpers | SessionId, protocol frames, daemon context, any driver |
| Terminal | `apps/daemon/src/terminal/terminal.ts` (`Terminal`, `TerminalKind`), over `@podium/process/screen`; built only by `Terminal.attach` | DurableAttachment, TerminalScreen, protocol terminal frames | the durable door, any driver, harness manifests |
| RuntimeDriver | `@podium/harness/driver/families/*` (contract in `@podium/harness/driver`, construction in `/driver/host`); daemon keeps only wiring in `apps/daemon/src/runtime/host.ts` (builds `TerminalHostPorts`) | the Terminal port it is handed; its own protocol client; harness manifests; the session's engine port | DurableProcess spawn/kill, podium-host's socket, the engine's socket path, the binding journal |
| Session | daemon mirror `apps/daemon/src/session/` (`registry.ts`, `daemon-session.ts`, `engines.ts`, `journal.ts`, `driver-slots.ts`); server record `apps/server/src/modules/sessions/` | DurableProcess, Terminal, the driver registry, protocol frames | screen internals, harness manifests beyond driver selection (daemon); anything in the daemon or the process package (server) |
| Viewer | `packages/client-core`, `apps/web` | the server socket | daemon or process code |

Families at the time of writing: `codex`, `claude-sdk`, `grok-acp`,
`opencode`, `opencode2`, `headless`, `terminal`.

## The rules, and the lint that pins them

- **Process purity** (`terminal-objects-process`): the kernel names no
  session, no frame, no daemon, no driver. Type-only counts — naming is the
  coupling.
- **Terminal surface** (`terminal-objects-terminal`): the Terminal holds the
  attachment it is handed and refers to (never owns) the process. The durable
  door belongs to the Session.
- **Driver port** (`terminal-objects-driver`): a headless driver never holds a
  process primitive, a podium-host socket or the engine's socket path, and
  never writes the binding journal. It asks the session's engine port
  (`EngineProcessOwner`, implemented by `SessionEngineScope` in
  `apps/daemon/src/session/engines.ts`) to start, re-attach or stop its
  engine. A driver family MAY own its own protocol listener (the OpenCode
  free-port probe, the terminal family's hook receiver) — `node:net` /
  `node:http` are not violations. What no family may touch is podium-host's
  socket.
- **Server half** (`terminal-objects-server`): the server holds no process and
  no socket; it decides lifetime policy (`terminal-lifetime.ts`), the daemon
  executes it. Applies to product code. Contract tests that drive daemon
  internals on purpose (e.g. `apps/server/src/store/terminal-answer-contract.test.ts`)
  are exempt via `isTestFile`: they are the seam's characterization, not
  coupling.
- **Primitives** (`terminal-objects-primitives`): nothing outside
  `packages/pty` reaches a process primitive except through the
  `@podium/process` package door (whose consumers the manifest already holds
  to `apps/daemon` + the build tier). `scripts/` is exempt as the L5 build
  tier.

## Behaviour claims

The lint pins import direction only. Behavioural claims ("never/only/always")
are pinned by characterization tests from POD-4616 (daemon half:
`apps/daemon/src/session/layer-claims.test.ts`; server half:
`apps/server/src/modules/sessions/inbox-gateway-delivery.test.ts`) and the
POD-4611 engine-lifecycle suites — cited, not re-derived, here.
