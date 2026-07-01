// Decide what to do when the server rejects the daemon's upgrade with a 426
// (wire-protocol mismatch). Pure so it can be unit-tested without a socket:
//   - source/dev run (not an installed binary) → just back off + reconnect; a
//     dev can't self-update a `bun`-launched daemon, and the mismatch is
//     usually transient (the local server is mid-redeploy).
//   - installed binary → run `podium update`, then let `decidePostUpdate` read
//     its exit code to choose restart vs give-up.
export function decideOnProtocolMismatch(ctx: { installed: boolean }): {
  action: 'self-update' | 'backoff'
} {
  return ctx.installed ? { action: 'self-update' } : { action: 'backoff' }
}

// Read `podium update`'s exit code to decide what happens after a self-update:
//   - 10 = an update was actually pulled → restart so systemd relaunches into
//     the new binary that speaks the server's wire version.
//   - anything else (0 already-current, 1 failed, null killed-by-signal) → give
//     up loudly rather than hot-loop update→exit→426→update forever, since
//     restarting would just land on the same wire-incompatible binary.
export function decidePostUpdate(status: number | null): 'restart' | 'give-up' {
  return status === 10 ? 'restart' : 'give-up'
}
