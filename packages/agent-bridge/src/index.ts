/**
 * @podium/agent-bridge — agent sessions (spawn, input, resize, redraw, frames) over a
 * swappable PTY backend (node-pty or Bun.Terminal). Speaks @podium/protocol geometry types.
 *
 * Per-CLI variance moved OUT to @podium/harness (POD-397): agent manifests,
 * native-state providers, conversation discovery, machine inventory and the
 * launch dispatcher. What is left is HARNESS-AGNOSTIC by construction and must
 * stay that way — it must not learn that codex, claude or grok exist. POD-396
 * renames this remainder to @podium/pty; POD-399 deletes the package.
 */

export * from './abduco.js'
export * from './abduco-bin.js'
export * from './osc-title.js'
export * from './pty/index.js'
export * from './session'
export * from './tmux.js'
