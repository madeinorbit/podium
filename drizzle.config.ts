import { defineConfig } from 'drizzle-kit'

// Schema migrations [spec:SP-4428]. drizzle-kit AUTHORS migrations (generate/check);
// the runtime applier is apps/server/src/migrations/drizzle-runner.ts, not drizzle's.
// Run from the repo root: `bun run migration:new <name>`, `bun run migration:check`.
export default defineConfig({
  dialect: 'sqlite',
  schema: './apps/server/src/migrations/schema.ts',
  out: './apps/server/src/migrations/drizzle',
  // Never let drizzle manage the two migration ledgers or the environment-
  // conditional FTS objects (created per-boot by the conversations repository).
  tablesFilter: ['!*_fts', '!*_fts_*', '!sqlite_*', '!schema_version', '!__drizzle_migrations'],
})
