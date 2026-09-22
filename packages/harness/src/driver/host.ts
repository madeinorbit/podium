/**
 * `packages/harness/src/driver/host.ts` — THE HOST ENTRY (POD-4469, daemon only).
 *
 * The contract (`./contract.js`) PLUS the driver families that act on a host:
 * terminal, codex, opencode, opencode2, grok-acp, claude-sdk and headless. Importing this
 * module means taking the capability to spawn agent processes — the
 * architecture manifest restricts it to the machine host (`apps/daemon`) and
 * the build tier, exactly as it restricted `@podium/agent-runtime` before the
 * dissolve. Everyone else imports `@podium/harness/driver` (the contract) and
 * never sees a family.
 *
 * This module replaces `packages/agent-runtime/src/index.ts` one for one: the
 * surface below is byte-identical to that barrel's, only the address changed.
 */

export * from './contract.js'
export * from './configure-catalog.js'
/** The codex app-server driver, WHOLE (POD-1761 W6). Same split as the opencode
 *  driver: everything here is JSON-RPC and bookkeeping, and the one thing a
 *  package may not do — spawn `codex app-server` and write its binding journal —
 *  lives in `apps/daemon/src/runtime/codex-app-server.ts`, reached through
 *  `CodexRuntimeHost`. */
export * from './families/codex/index.js'
/** Claude's process-per-turn Agent SDK driver. The daemon supplies the child
 * process and native-transcript host ports; contract semantics stay here. */
export * from './families/claude-sdk/index.js'
/** Grok's ACP stdio driver. Process ownership and its durable binding journal
 * stay in the daemon; the live protocol, receipts, permissions and reducer
 * integration live in this package. */
export * from './families/grok-acp/index.js'
/** The opencode server driver, WHOLE (POD-1761 W5). Unlike the terminal family,
 *  whose concrete driver had to live in the daemon because it is composed of
 *  daemon internals, this one is composed of HTTP and SSE and so lives here in
 *  full. What stayed in `apps/daemon/src/runtime/opencode-server.ts` is only the
 *  part a package may not do: spawn a child under a systemd scope and write its
 *  binding journal — reached through `OpencodeRuntimeHost`. */
export * from './families/opencode/index.js'
export * from './families/opencode2/index.js'
/** The terminal family's app-independent half (POD-1761 W3): the receipt state
 *  machine, the capability declaration, the exemption table, the envelope
 *  assembly, the pure composer interface. The concrete `RuntimeDriver` lives in
 *  `apps/daemon/src/runtime`, because it is composed of daemon internals this
 *  layer may not import. */
export * from './families/terminal/index.js'
/** The terminal family's host-only machinery, folded into this entry (POD-4498):
 *  hook-install + ingest (`instrumentation.js`), the loopback bind + endpoint
 *  policy (`loopback-listen.js`), and the composer-sync port
 *  (`composer-sync.js`). The daemon reached these through three deep package
 *  entries (`@podium/harness/driver/families/terminal/*`); those entries are
 *  deleted, and the audit guard refuses any `./driver/families/` export key,
 *  so this host entry is the only way to reach them. */
export * from './families/terminal/instrumentation.js'
export * from './families/terminal/loopback-listen.js'
export * from './families/terminal/composer-sync.js'
/** The supervision port every engine host is handed (1.5, spec §4.8): the
 *  supervisor owns spawn/re-attach/kill, families compose argv/env and bind
 *  protocol. Implemented once in the daemon's process-supervision wiring. */
export * from './families/engine-supervision.js'
/** The shared lost-queue reporter every server-family session adapter wires. */
export { reportQueueAbandonment } from './families/queue-report.js'
/** One-shot headless turns under podium-host and the `RuntimeDriver
 *  'headless'` that runs them (POD-4614). The daemon supplies the session
 *  layer's process owner, the child environment and the session registry. */
export * from './families/headless/index.js'
/** The turn failure every one-shot turn implementation throws. */
export { HeadlessTurnFailure } from './families/turn-error.js'
/** Where a family's live handle lives: the supervisor's per-session entry (POD-4610). */
export type { SessionDriverSlots } from './families/session-slots.js'
/** The uniform server-family shape the supervisor composes (1.5). */
export type {
  ServerFamilyJournalEntry,
  ServerFamilyLaunch,
  ServerFamilyRuntime,
  ServerSessionFramePorts,
} from './families/server-family.js'
