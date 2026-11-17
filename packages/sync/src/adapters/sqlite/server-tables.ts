/**
 * THE TWO SERVER-OWNED TABLES THIS ADAPTER READS, AS AN INJECTED PORT (POD-3249).
 *
 * `queued_messages` (the session inbox) and `upstream_outbox` (the retired
 * node→hub forwarder's queue) are FEATURE-owned: they are declared in
 * `apps/server/src/migrations/schema.ts` and they stay there, because this
 * adapter reads them and reading a table is not owning it (see `./schema.ts`).
 *
 * WHY THEY ARE INJECTED RATHER THAN IMPORTED. A package may not import from
 * `apps/server` — `@podium/sync` depends only on `@podium/protocol` and
 * `@podium/runtime` — so the conversion to drizzle (POD-3221 Stage A) has
 * exactly two ways to name these tables: a SECOND declaration here, or the
 * server's own objects handed in. A second declaration is the option this
 * repository has already ruled out for the tables it does own: two definitions
 * of one table can disagree, and the one that runs is whichever door the write
 * came through. So the composition root passes the objects it already has.
 *
 * WHY THE TYPES ARE STRUCTURAL AND NOT `typeof queuedMessages`. Naming the
 * server's binding is the import this file exists to avoid. The shapes below say
 * only what this adapter uses — drizzle's SQLite table type plus the columns it
 * reads — and the real tables satisfy them structurally, so a column this
 * adapter depends on cannot be dropped from the server's schema without a
 * compile error at the composition root.
 *
 * This type is the ADAPTER's, and it stays there: `check-boundaries` rule 11
 * keeps the kernel free of SQLite and of anything under `adapters/`, and drizzle
 * is on its forbidden-specifier list for kernel modules.
 */

import type { MutationId, SessionId } from '@podium/model'
import type { AnySQLiteColumn, SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'

/** `queued_messages` — the session inbox (spec docs/spec/outbox-write-path.md). */
export type QueuedMessagesTable = SQLiteTable & {
  readonly workspaceId: SQLiteColumn
  readonly id: SQLiteColumn
  readonly sessionId: AnySQLiteColumn<{ data: SessionId; notNull: true }>
  readonly text: SQLiteColumn
  readonly queuedAt: SQLiteColumn
  readonly attempts: SQLiteColumn
  readonly deliveryOwner: SQLiteColumn
  readonly inputOrigin: SQLiteColumn
  readonly principalKind: SQLiteColumn
  readonly principalRef: SQLiteColumn
  readonly delegationRef: SQLiteColumn
  readonly actorKind: SQLiteColumn
  readonly actorId: SQLiteColumn
  readonly onBehalfOf: SQLiteColumn
  readonly sourceMessageId: SQLiteColumn
  readonly delivery: SQLiteColumn
  readonly attachmentsJson: SQLiteColumn
  readonly retractRequestedAt: SQLiteColumn
}

/** `upstream_outbox` — ARCHIVED at POD-309; this adapter has the one surviving
 *  reader (`SyncRepository.listParkedUpstreamMutations`). */
export type UpstreamOutboxTable = SQLiteTable & {
  readonly workspaceId: SQLiteColumn
  readonly mutationId: AnySQLiteColumn<{ data: MutationId; notNull: true }>
  readonly proc: SQLiteColumn
  readonly queuedAt: SQLiteColumn
}

/**
 * The server's change-capture wrapper for a write on a source table
 * (`apps/server/src/sync/capture-pg.ts`, POD-6982): it returns the drizzle insert,
 * update or delete builder it is handed, unchanged on SQLite (the triggers capture)
 * and rendering its capture form on Postgres. `queued_messages` is a source of the
 * session record, so the adapter's inbox writes go through it (POD-6989).
 *
 * INJECTED FOR THE SAME REASON AS THE TABLES: the capture forms are generated from
 * the server's record sources, which a package may not import.
 */
export type CaptureWrite = <B>(write: B) => B

/** What the composition root hands {@link SyncRepository} alongside the connection. */
export interface SyncServerTables {
  readonly queuedMessages: QueuedMessagesTable
  readonly upstreamOutbox: UpstreamOutboxTable
  readonly captureWrite: CaptureWrite
}
