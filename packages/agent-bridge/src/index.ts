/**
 * @podium/agent-bridge — the HARNESS half of the old bridge: per-CLI adapters
 * (launch/exec/headless flags), agent-state classification, conversation
 * discovery and inventory. Speaks @podium/protocol vocabulary types.
 *
 * The PTY half — backends, durable hosts (abduco/tmux/scopes), byte framing, OSC
 * title scan and redraw — moved to **@podium/pty** (POD-396). Import it directly;
 * this barrel deliberately does NOT re-export it, so there is one home per
 * concern and no transitional shim for the deletion audit to chase.
 */

export * from './agent-state/index.js'
export * from './cursor/cli.js'
export * from './cursor/paths.js'
export * from './discovery/index.js'
export * from './harness/adapter.js'
export * from './harness/instructions.js'
export * from './harness/issue-system-pointer.js'
export * from './harness/registry.js'
export * from './harness/transcript-source.js'
export * from './inventory/build-inventory.js'
export * from './jsonl-stream.js'
export * from './launch.js'
export * from './opencode/cli.js'
export * from './opencode/db.js'
