# ADR 14 — Postgres store beside SQLite

- **Status:** Accepted, 2026-11-17
- **Issue:** POD-6994 (server on Postgres end to end), the last task of POD-6958 (Postgres
  store beside SQLite), under POD-6951 (multi-tenant cloud hosting)
- **Design:** `docs/design/POD-6958-postgres-store-design.md` on branch
  `issue/6958-postgres-store-beside-sqlite` (sections 0, 2 and 4)
- **Amends:** [ADR 6 D5.3](0006-replica-storage.md) (the server's query layer and engines)
- **Supersedes:** section 1 of [`docs/internal/pod-3221-spec.md`](../internal/pod-3221-spec.md),
  the sentence "Postgres is not pursued", and its section 7 decision 5 (SQLite dialect
  everywhere, hosted Turso through libsql)

## Context

ADR 6 D5.3, as amended by POD-3221 on 2026-09-07, made drizzle with the SQLite dialect the
server's query layer, with bun:sqlite locally and Turso through the libsql remote client for
hosted. The POD-3221 specification recorded "Postgres is not pursued".

Hosted Podium now targets a shared multi-tenant store (ADR 13), and the operator decided on
2026-11-16 that hosted Postgres is the primary target: "i'd like to optimize for postgres and
work around things on sqlite / self-hosted. Hosted is the primary target." POD-6958 designed a
Postgres store beside the SQLite one, and its tasks built it: the driver, the schema twin and
its migration chain, change capture in the write statement, the Postgres forms of every query
definition, search, the sync worker's and the janitor's read sessions, and, in POD-6994, the
store opening on a Postgres URL.

## Decisions

### D1 — Two engines, one repository layer

The server store runs on SQLite (self-hosted installs and the desktop sidecar, unchanged) or
on Postgres (hosted). Repositories, transaction logic and the executor are the same on both.
Each query definition is built on the engine's own drizzle dialect over the engine's own
tables; most definitions are one source for both, the rest carry a hand-written Postgres form
next to the SQLite form behind the same typed inputs and outputs. No SQL is translated at
runtime.

This amends ADR 6 D5.3: drizzle stays the query layer and the executor still owns
transaction boundaries and routing, but the dialects are SQLite and Postgres, and the libsql
remote driver is no longer a hosted path.

### D2 — The engine is chosen once, from the store's location

A file path (`:memory:` included) opens SQLite; a `postgres://` or `postgresql://` URL opens
Postgres (`storeEngineFor`, `apps/server/src/store-database.ts`). The server takes the URL from
the `PODIUM_DATABASE_URL` environment variable only, never from `config.json`, because it
carries a credential; a config key naming the database is refused at boot. Nothing below the
store asks which engine it runs on: the store-lifecycle port
(`apps/server/src/migrations/store-lifecycle.ts`) has one implementation per engine, and the
sync worker and the janitor open their read sessions from the same location.

### D3 — Lifecycle: SQLite keeps its file-level steps; Postgres leaves them to the platform

On SQLite the boot migrates with its pre-migration backup, runs the one-time imports, keeps
planner statistics, the traffic temp store, recovery snapshots and the transfer steps, as
before. On Postgres migrating is a deploy step (`podium server migrate`; the server checks the
ledger at boot and refuses a database that is behind or carries an unknown migration), and
backups, point-in-time recovery and statistics (autovacuum, autoanalyze) are the platform's. A
Postgres store has no server transfer and no legacy files to import.

### D4 — Concurrency: one writer per workspace

A Postgres write transaction runs at READ COMMITTED and first locks its workspace's
`sync_feed` row. That is the single-writer rule SQLite keeps per file, kept per workspace, so
different workspaces write in parallel. Lifting it is POD-7029 (measure first).

### D5 — Change capture in the write statement

Postgres has no capture triggers. Each write on a source table is one statement that writes
the row and its capture rows (`apps/server/src/sync/capture-pg.ts`); the deferred guard that
refuses an undrained commit is the same on both engines, and a test oracle holds both engines
to the same captured rows. Before a store attaches its change capture (the boot, and a test
store before its change log attaches), a Postgres write transaction drops its own capture rows
before COMMIT, which is what SQLite does by having no triggers then.

### D6 — The operator's decisions on the open questions

Recorded 2026-11-16 (design section 4):

- **OD1, the unlanded libsql and Turso-remote work** (POD-3270, POD-3271, POD-3272, branch
  `integration/3221-turso`): decided to close them as superseded and keep the branch
  unmerged as a record.
  In-process Turso later comes through its Postgres frontend (POD-6969), not libsql.
- **OD2, a round-trip budget for hosted:** the move to Postgres and the round-trip reductions
  happen one after the other. The engine ships with today's statement counts, identical on
  both engines, and records round trips (POD-6992); the reductions are POD-7030.
- **OD3, the Postgres backend in the open-source server:** yes. Drivers, bindings, schema and
  migrations live in `apps/server`; podium-cloud keeps deployment, credentials and the hosted
  composition (POD-6965).
- **OD4, search results that differ between engines:** accepted. The same matches are pinned
  for whole words and prefixes; ranking, snippets and tokenisation may differ.
- **OD5, native types** (decided against the design's first recommendation): the Postgres
  baseline uses native types (`timestamptz(3)`, `json`, `boolean`, `bigint`, `COLLATE "C"`
  text); repositories still read ISO strings, JSON text and numbers on both engines.

## Consequences

- Every schema change is written for both migration chains in one commit (POD-6958 contract
  C10), and the schema parity and chain parity checks in the lean gate hold the two together.
- A store test file runs on both engines unless `apps/server/test-store-engines.json` lists it
  as SQLite-only with a reason; the Postgres leg is the `server-store-pg` lane.
- SQLite stays deletable as whole files and the `sqlite:` arms of the two-form definitions
  (POD-6969).
- Server-side query rules for two engines: `docs/agents/server-data.md`, rule 9 and "How
  queries execute".
