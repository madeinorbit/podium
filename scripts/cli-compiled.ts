/** Compiled CLI entry. Native helpers ship beside podium-cli; legacy abduco
 * adoption uses the TypeScript unix-socket client and embeds no executable. */
import { runSnapshotVerifierChildIfRequested } from '../apps/server/src/migrations/snapshot-verifier-child.js'
import { main } from './cli.js'

// The per-turn Claude SDK host child is gone (POD-4499): sessions run one
// long-lived `claude` stream-json engine per session under podium-host,
// spoken directly over the host attachment, and one-shot turns spawn the CLI
// directly. There is no sentinel child to dispatch to any more.
// The recovery-snapshot verifier runs as a child of this same binary (POD-3068).
// Answered before `main` so a verification never boots a server, and gated on an
// environment variable so the CLI grows no public subcommand for it.
if (!(await runSnapshotVerifierChildIfRequested())) {
  await main()
}
