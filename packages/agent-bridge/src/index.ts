/**
 * @podium/agent-bridge — EMPTY. Both halves of the old bridge have been extracted
 * and this package is a shell awaiting deletion by POD-399.
 *
 * The PTY half — backends, durable hosts (abduco/tmux/scopes), byte framing, OSC
 * title scan and redraw — is **@podium/pty** (POD-396).
 * The HARNESS half — per-CLI manifests, agent-state classification, conversation
 * discovery, inventory and the launch dispatcher — is **@podium/harness** (POD-397).
 *
 * Nothing is re-exported from here on purpose. A forwarding barrel is exactly the
 * tombstone the deletion audit counts (reexport-shims), so there is one home per
 * concern and nothing transitional for POD-399 to chase. Import the two packages
 * directly.
 */

export {}
