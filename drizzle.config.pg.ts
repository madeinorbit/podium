import { defineConfig } from 'drizzle-kit'

// The Postgres migration chain [POD-6981, POD-6958 design 2.7]. drizzle-kit AUTHORS the
// Postgres migrations after the baseline; the runtime applier is
// apps/server/src/migrations/pg/index.ts, not drizzle's. The baseline itself is written
// by `bun run migration:pg-baseline`, from the same schemas, so it can be checked.
// Run from the repo root: `bun run migration:new <name>` writes both chains.
export default defineConfig({
  dialect: 'postgresql',
  // The Postgres twins of the two SQLite schema files (drizzle.config.ts). The identity
  // tables come in through the server schema's re-export of the identity package's twin.
  schema: [
    './apps/server/src/migrations/pg/schema.ts',
    './packages/sync/src/adapters/pg/schema.ts',
  ],
  out: './apps/server/src/migrations/pg/drizzle',
})
