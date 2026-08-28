/**
 * `bun build --compile` entry for the unified `podium` CLI. Registers embedded-abduco
 * materialization with the shared launcher, which runs compiled-only state initialization
 * after selecting and claiming the instance root. Only this entry pulls the Bun-only
 * embedded-file import; plain scripts/cli.ts stays Node/test-importable.
 */
import { runSnapshotVerifierChildIfRequested } from '../apps/server/src/migrations/snapshot-verifier-child.js'
import { main } from './cli.js'
import { materializeEmbeddedAbduco } from './embedded-abduco.js'

// The recovery-snapshot verifier runs as a child of this same binary (POD-3068).
// Answered before `main` so a verification never boots a server, and gated on an
// environment variable so the CLI grows no public subcommand for it.
if (!(await runSnapshotVerifierChildIfRequested())) {
  await main({ afterInstanceStateClaim: materializeEmbeddedAbduco })
}
