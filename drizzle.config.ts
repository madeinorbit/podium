import { defineConfig } from 'drizzle-kit'

// Schema migrations [spec:SP-4428]. drizzle-kit AUTHORS migrations (generate/check);
// the runtime applier is apps/server/src/migrations/drizzle-runner.ts, not drizzle's.
// Run from the repo root: `bun run migration:new <name>`, `bun run migration:check`.
export default defineConfig({
  dialect: 'sqlite',
  /**
   * TWO schema files, ONE out directory (POD-305). drizzle-kit unions the
   * schemas and emits into a single journal, so GLOBAL migration ordering stays
   * the journal's — folder-timestamp order plus the snapshot prevId DAG — with
   * no second ordering authority to keep in step.
   *
   * A second `out` directory for the kernel's tables was rejected: two journals
   * have no defined order between them, so a migration in one depending on a
   * table created in the other is correct on the machine that authored it and a
   * boot failure everywhere else. That is the problem drizzle adoption removed.
   *
   * Ownership is LAYERED (POD-279 review finding 5): the sync adapter owns the
   * generic sync tables (changes, applied_mutations); feature-owned tables —
   * including queued_messages and upstream_outbox, which that adapter READS but
   * does not own — stay in the server's schema.
   */
  schema: [
    './apps/server/src/migrations/schema.ts',
    './packages/sync/src/adapters/sqlite/schema.ts',
  ],
  out: './apps/server/src/migrations/drizzle',
  // Never let drizzle manage the two migration ledgers or the environment-
  // conditional FTS objects (created per-boot by the conversations repository).
  tablesFilter: ['!*_fts', '!*_fts_*', '!sqlite_*', '!schema_version', '!__drizzle_migrations'],
})
