/**
 * `@podium/agent-runtime` — THE AGENT RUNTIME CONTRACT (POD-1761).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PACKAGE IS
 * ---------------------------------------------------------------------------
 *
 * The complete set of primitives every harness session sits behind, whatever
 * drives it (spec §2, §3 — `docs/2026-08-07-agent-runtime-architecture.html`).
 * Podium features may touch a session ONLY through this surface. That is the
 * whole point: it is built in FRONT of today's PTY stack rather than after it,
 * so that codex-terminal → codex-server becomes a driver swap no feature
 * notices.
 *
 * Everything the spec calls "deliberately not in the surface" — raw PTY writes,
 * hook ingest, transcript file paths, abduco socket names, screen/VT state,
 * harness settings files — is private to a driver and appears nowhere here. The
 * one exception is the frame stream, which appears only inside an
 * `AttachEndpoint`.
 *
 * ---------------------------------------------------------------------------
 * FIVE RULES govern what earns a place (spec §3)
 * ---------------------------------------------------------------------------
 *
 *   1. A primitive earns its place only if a Podium feature consumes it, AND
 *      every family can implement it or honestly decline it (`Declared<T>` —
 *      consumers branch and degrade; never a silent substitution).
 *   2. Guarantees are family-invariant; fidelity is declared. `send()` means the
 *      same thing on every driver — what varies is the declared mechanism and
 *      confidence, never the semantics.
 *   3. Every write returns a receipt or a typed refusal. Never fire-and-hope.
 *   4. Every read is causally enveloped — see `CausalEnvelope` in ./events.ts.
 *   5. Machine-transparent: every primitive relays identically over the daemon
 *      WS for local, remote and cloud machines.
 *
 * TWO TIERS, so rule 1 has counter-pressure. The CORE contract is what a new
 * driver MUST implement or explicitly decline, and is all the conformance suite
 * pins. The EXTENDED tier is feature seams that never block a driver: a driver
 * shipping only the core is COMPLETE. New primitives default to extended and
 * must argue their way into core. The boundary is DATA, not prose — see
 * ./tiers.ts, which is total over the primitive names, so adding a primitive
 * without tiering it is a compile error.
 *
 * ---------------------------------------------------------------------------
 * HOST CAPABILITY
 * ---------------------------------------------------------------------------
 *
 * Importing this barrel means taking the capability to drive agent processes:
 * the drivers behind this contract spawn PTYs, harness servers and SDK worker
 * children. The architecture manifest restricts this package's consumers to the
 * machine host (`apps/daemon`) and the build tier.
 *
 * Everyone else — `apps/server` above all — imports
 * `@podium/agent-runtime/metadata`, which carries FACTS ABOUT THE CONTRACT (its
 * tiers, its families, its permitted-failures table, its wire schemas) and no
 * way to act on a host. Drivers under test import
 * `@podium/agent-runtime/testing` for the conformance corpus.
 */

// Stream identity moved down to `packages/transcript` in POD-2820 — it is
// cursor arithmetic, not a host capability, and this package's consumer
// restriction was refusing the server the one function it legitimately needed.
// Re-exported by name so the contract surface is unchanged for the drivers.
export { streamIdOfCursor, streamItemIdOf } from '@podium/transcript'
export * from './attach.js'
export * from './binding.js'
export * from './capabilities.js'
export * from './driver.js'
/** The codex app-server driver, WHOLE (POD-1761 W6). Same split as the opencode
 *  driver: everything here is JSON-RPC and bookkeeping, and the one thing a
 *  package may not do — spawn `codex app-server` and write its binding journal —
 *  lives in `apps/daemon/src/runtime/codex-app-server.ts`, reached through
 *  `CodexRuntimeHost`. */
export * from './drivers/codex/index.js'
/** Claude's process-per-turn Agent SDK driver. The daemon supplies the child
 * process and native-transcript host ports; contract semantics stay here. */
export * from './drivers/claude-sdk/index.js'
/** Grok's ACP stdio driver. Process ownership and its durable binding journal
 * stay in the daemon; the live protocol, receipts, permissions and reducer
 * integration live in this package. */
export * from './drivers/grok-acp/index.js'
/** The opencode server driver, WHOLE (POD-1761 W5). Unlike the terminal family,
 *  whose concrete driver had to live in the daemon because it is composed of
 *  daemon internals, this one is composed of HTTP and SSE and so lives here in
 *  full. What stayed in `apps/daemon/src/runtime/opencode-server.ts` is only the
 *  part a package may not do: spawn a child under a systemd scope and write its
 *  binding journal — reached through `OpencodeRuntimeHost`. */
export * from './drivers/opencode/index.js'
/** The terminal family's app-independent half (POD-1761 W3): the receipt state
 *  machine, the capability declaration, the exemption table, the envelope
 *  assembly. The concrete `RuntimeDriver` lives in `apps/daemon/src/runtime`,
 *  because it is composed of daemon internals this layer may not import. */
export * from './drivers/terminal/index.js'
export * from './errors.js'
export * from './events.js'
export * from './families.js'
export * from './headless-interrupt.js'
export * from './health.js'
export * from './interactions.js'
export * from './permitted-failures.js'
export * from './queue-abandonment.js'
export * from './runtime.js'
export * from './schemas.js'
export * from './session-spec.js'
export * from './tiers.js'
export * from './turns.js'
