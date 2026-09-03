/**
 * THE BINDING OF THE SERVER'S TWO TABLES TO THE SYNC ADAPTER'S PORT (POD-3249).
 *
 * `SyncRepository` reads `queued_messages` and `upstream_outbox` but does not own
 * them, and `@podium/sync` may not import `apps/server`. It therefore takes them
 * as constructor arguments; this is the one place that pairing is written down,
 * so the six-odd construction sites do not each restate it and drift.
 *
 * The annotation is load-bearing: if a column the adapter reads is renamed or
 * dropped in `./schema.ts`, this assignment stops compiling here rather than
 * failing at runtime in the session inbox.
 */

import type { SyncServerTables } from '@podium/sync'
import { queuedMessages, upstreamOutbox } from './schema'

export const syncServerTables: SyncServerTables = { queuedMessages, upstreamOutbox }
