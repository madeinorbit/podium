/**
 * TABLES ONLY THE POSTGRES SCHEMA HAS [POD-6990, POD-6958 design 2.2, 2.6].
 *
 * Each is listed in `PG_ONLY_TABLES` (`./schema-overrides.ts`) with why it has no SQLite
 * twin, and the generated twin (`./schema.ts`) re-exports it, so the Postgres baseline
 * creates it with the rest of the schema. The parity test accepts exactly these tables.
 */

import { sql } from 'drizzle-orm'
import { customType, index, pgTable } from 'drizzle-orm/pg-core'
import { int8, textC } from '../../../../../packages/sync/src/adapters/pg/schema'
import { searchVectorOf, TRANSCRIPT_SEARCH_CHARACTERS } from './schema-overrides'

/** A `tsvector`: written by Postgres only (a generated column), never read back by a query. */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
})

/**
 * The transcript search rows on Postgres: what `transcript_fts` holds on SQLite, with the
 * workspace and segment `transcript_fts_keys` adds there as ordinary columns. `id` is the
 * insertion order `transcript_fts`'s rowid gives. The search vector covers the first
 * {@link TRANSCRIPT_SEARCH_CHARACTERS} characters of `content`.
 */
export const transcriptText = pgTable(
  'transcript_text',
  {
    id: int8('id').primaryKey().generatedByDefaultAsIdentity(),
    workspaceId: textC('workspace_id').notNull(),
    machineId: textC('machine_id').notNull(),
    nativeId: textC('native_id').notNull(),
    itemUuid: textC('item_uuid'),
    // The transcript's own timestamp text, kept as written, as SQLite keeps it.
    ts: textC('ts'),
    content: textC('content').notNull(),
    search: tsvector('search')
      .notNull()
      .generatedAlwaysAs(
        sql.raw(searchVectorOf(`left("content", ${TRANSCRIPT_SEARCH_CHARACTERS})`)),
      ),
  },
  (table) => [
    index('idx_transcript_text_segment').on(
      table.workspaceId,
      table.machineId,
      table.nativeId,
      table.id,
    ),
    index('idx_transcript_text_search').using('gin', table.search),
  ],
)
