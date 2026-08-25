/**
 * `bun build --compile` entry for the unified `podium` CLI. Materializes the embedded
 * abduco (so durable sessions work on a clean box), then runs the mode-driven launcher.
 * Only this entry pulls the Bun-only embedded-file import; plain scripts/cli.ts stays
 * Node/test-importable.
 */
import { CLAUDE_SDK_HOST_ENV } from '../apps/daemon/src/claude-sdk-protocol.js'
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
  await materializeEmbeddedAbduco()
  await main()
}
