/**
 * `bun build --compile` entry for the unified `podium` CLI. Registers embedded-abduco
 * materialization with the shared launcher, which runs compiled-only state initialization
 * after selecting and claiming the instance root. Only this entry pulls the Bun-only
 * embedded-file import; plain scripts/cli.ts stays Node/test-importable.
 */
import { CLAUDE_SDK_HOST_ENV } from '../apps/daemon/src/claude-sdk-protocol.js'
import { runSnapshotVerifierChildIfRequested } from '../apps/server/src/migrations/snapshot-verifier-child.js'
import { main } from './cli.js'
import { materializeEmbeddedAbduco } from './embedded-abduco.js'

// ONE BINARY SHIPS, so the Claude SDK host cannot be its own executable and cannot
// be handed to a child as a .ts on disk — there is no .ts on disk. Instead the
// daemon re-execs THIS binary with the sentinel set, and that child becomes the
// host. The branch is first and the import is dynamic on purpose: a daemon
// running in this same binary never sets the sentinel, so it never evaluates the
// module and never loads the SDK into its own process. Presence in the image is
// not presence in the heap.
if (process.env[CLAUDE_SDK_HOST_ENV] === '1') {
  await import('../apps/daemon/src/claude-sdk-host.js')
} else {
  // The recovery-snapshot verifier runs as a child of this same binary (POD-3068).
  // Answered before `main` so a verification never boots a server, and gated on an
  // environment variable so the CLI grows no public subcommand for it.
  if (!(await runSnapshotVerifierChildIfRequested())) {
    // Materialization runs AFTER the instance state claim, so a named instance
    // unpacks abduco under its own state root rather than the default's.
    await main({ afterInstanceStateClaim: materializeEmbeddedAbduco })
  }
}
