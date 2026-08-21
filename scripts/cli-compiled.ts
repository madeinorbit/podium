/**
 * `bun build --compile` entry for the unified `podium` CLI. Registers embedded-abduco
 * materialization with the shared launcher, which runs compiled-only state initialization
 * after selecting and claiming the instance root. Only this entry pulls the Bun-only
 * embedded-file import; plain scripts/cli.ts stays Node/test-importable.
 */
import { main } from './cli.js'
import { materializeEmbeddedAbduco } from './embedded-abduco.js'

await main({ afterInstanceStateClaim: materializeEmbeddedAbduco })
