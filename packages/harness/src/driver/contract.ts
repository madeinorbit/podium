/**
 * `packages/harness/src/driver/contract.ts` — THE DRIVER CONTRACT (POD-4469).
 *
 * Everything a caller needs to TALK ABOUT a session, without the capability to
 * drive one: the `RuntimeDriver`/`AgentSessionHandle` interfaces, capabilities,
 * events, turns, interactions, errors, tiers, schemas, binding, configuration
 * and history. No driver family lives behind this module — families (and the
 * host-only configuration catalog built over them) are in `./host.js`, which
 * the daemon reaches through `@podium/harness/driver/host`.
 *
 * `@podium/harness/driver` (the server-reachable contract entry,
 * `src/driver.ts`) re-exports a NAMED subset of this module. This file itself
 * may use `export *`: it is not the entry, and widening the entry still
 * requires editing `src/driver.ts` by name.
 */

// Stream identity is cursor arithmetic, not a host capability (POD-2820).
// Re-exported by name so the contract surface is unchanged for the drivers.
export { streamIdOfCursor, streamItemIdOf } from '../store/stream-identity.js'
export * from './attach.js'
export * from './binding.js'
export * from './boundary-context.js'
export * from './capabilities.js'
export * from './configure.js'
export * from './delivery-queue.js'
export * from './driver.js'
export * from './errors.js'
export * from './events.js'
export * from './families.js'
export * from './headless-interrupt.js'
export * from './headless-turn.js'
export * from './health.js'
export * from './history.js'
export * from './interactions.js'
export * from './permitted-failures.js'
export * from './procedures.js'
export * from './queue-abandonment.js'
export * from './runtime.js'
export * from './schemas.js'
export * from './session-spec.js'
export * from './tiers.js'
export * from './turns.js'
