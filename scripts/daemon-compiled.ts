/**
 * `bun build --compile` entry for the daemon. Materializes the embedded abduco binary
 * (so durable sessions work on a machine with no abduco and no C compiler), then hands
 * off to the normal daemon boot in scripts/daemon.ts. Only this entry pulls in the
 * Bun-only embedded-file import; the plain `scripts/daemon.ts` stays Node-runnable.
 */
import { materializeEmbeddedAbduco } from './embedded-abduco.js'

await materializeEmbeddedAbduco()
// daemon.ts runs its boot at module top-level and then awaits forever; importing it
// here starts the daemon and keeps this process alive.
await import('./daemon.js')
