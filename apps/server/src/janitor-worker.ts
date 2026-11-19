/**
 * THE JANITOR WORKER THREAD'S ENTRY [POD-2505, POD-6993].
 *
 * The janitor package runs the worker (`serveJanitorWorker`: its control messages, its
 * heartbeat, its compatibility refusal); this entry hands it the database it serves,
 * opened on the store's engine from the location the host passed (`janitor-database.ts`).
 * The entry is the server's because the janitor's reads are the store's query
 * definitions. Embedded in the compiled binary as `JANITOR_WORKER_ENTRY`.
 */

import { serveJanitorWorker } from '@podium/janitor/worker'
import { openJanitorDatabase } from './janitor-database'

await serveJanitorWorker((options) => openJanitorDatabase(options.dbPath))
