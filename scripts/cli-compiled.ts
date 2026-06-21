/**
 * `bun build --compile` entry for the unified `podium` CLI. Materializes the embedded
 * abduco (so durable sessions work on a clean box), then runs the mode-driven launcher.
 * Only this entry pulls the Bun-only embedded-file import; plain scripts/cli.ts stays
 * Node/test-importable.
 */
import { main } from './cli.js'
import { materializeEmbeddedAbduco } from './embedded-abduco.js'

await materializeEmbeddedAbduco()
await main()
