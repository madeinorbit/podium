/**
 * `packages/harness/src/driver/host.ts` — THE HOST ENTRY (POD-4469, daemon only).
 *
 * The contract (`./contract.js`) PLUS the driver families that act on a host:
 * terminal, codex, opencode, opencode2, grok-acp and claude-sdk. Importing this
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
/** Pi's `--mode json` turn-output fold (moved from the daemon in 1.5: pi has no
 *  driver family, so its turn grammar lives with its adapter; re-exported here
 *  for the supervisor's headless machinery, which stays daemon-owned). */
export * from '../adapters/pi/stream.js'
