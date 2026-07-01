// Decide what to do when the server rejects the daemon's upgrade with a 426
// (wire-protocol mismatch). Pure so it can be unit-tested without a socket:
//   - source/dev run (not an installed binary) → just back off + reconnect; a
//     dev can't self-update a `bun`-launched daemon, and the mismatch is
//     usually transient (the local server is mid-redeploy).
//   - installed binary → run `podium update` + exit so systemd restarts into
//     the new binary that speaks the server's wire version.
//   - installed but we've retried N times and there's no newer version to pull
//     → give up loudly rather than hot-loop update→exit→update forever.
export function decideOnProtocolMismatch(ctx: {
  installed: boolean
  consecutive: number
  updatedAvailable?: boolean
}): { action: 'self-update' | 'backoff' | 'give-up' } {
  if (!ctx.installed) return { action: 'backoff' }
  if (ctx.consecutive >= 3 && ctx.updatedAvailable === false) return { action: 'give-up' }
  return { action: 'self-update' }
}
