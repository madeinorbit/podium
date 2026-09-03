# The store boundary lint family (POD-3252)

Four rules in `scripts/check-boundaries.ts`, beside `checkSyncKernelPurity`, with their
fixtures in `scripts/check-boundaries.test.ts`. They run in `bun run lint:boundaries` — the
blocking CI step (`.github/workflows/ci.yml`), never the `continue-on-error` `bun run lint`
bundle. POD-744 is the cautionary tale for why that distinction is load-bearing: a guardrail
bundled under a swallowed red reported green for weeks while exiting 1.

They do two jobs, in sequence.

**Before the conversion** they are the completeness proof for Stage A of POD-3221. A repository
is converted when it no longer holds a raw SQLite handle, and nothing but a lint can tell you
that about forty files at once (execution method §2, first row: "completeness comes from the
compiler and a lint, never from grep or memory").

**After it** they are the permanent guard. What they ban is what a remote connection cannot rely
on, or what belongs to the driver and the migrations alone — and the hosted server runs on Turso
(spec §2.7, §6 rules 1-2, §7 decision 5).

## The rules

| Rule | What it refuses | Where |
|---|---|---|
| `store-raw-handle` | An import of `@podium/runtime/sqlite`; `.prepare(`; a WHOLE raw statement handed to `db.all/get/run/values(sql\`…\`)`; `PRAGMA`, `sqlite_master` or `ATTACH` inside a `sql` template body | `apps/server/src/store/**`, `apps/server/src/modules/operations/store.ts`, `packages/sync/src/adapters/sqlite/**` |
| `store-transaction-port` | drizzle's own `db.transaction` / `tx.transaction` — the store's `transact` port is the only transaction boundary | anywhere under `apps/` or `packages/` a drizzle handle can reach |
| `drizzle-import-home` | `drizzle-orm` imported outside persistence | everywhere under `apps/` or `packages/` except the store, the operations store, `apps/server/src/migrations/**` and `packages/sync/src/adapters/sqlite/**` |
| `sql-raw-literal` | `sql.raw` of anything that is not a string literal written down in full | everywhere under `apps/` or `packages/` except the SearchIndex port |

The lint scans template bodies, not only import lines: `sqlTemplateBodies` extracts the text of
every `sql\`…\`` tag, dropping `${…}` holes, so a `PRAGMA` reads as a `PRAGMA` wherever it is
written.

## What is deliberately NOT banned

Under the one-dialect decision both bun:sqlite and Turso accept rowid ordering, `INSERT OR
REPLACE`, `INSERT OR IGNORE`, `ON CONFLICT`, `RETURNING`, `GLOB`, `lastInsertRowid` and the JSON
functions. None of them is a portability problem and none is flagged; a fixture pins that.

The `sql` TAG is not banned either. Spec §6 rule 1 says fragments inside builder queries are fine
anywhere — `.where(sql\`…\`)` is the epic's own idiom. Only a whole statement handed to a
raw-execution method is refused, and the fixtures pin both sides of that line.

The per-site "an `OR REPLACE` conversion must name every column" check stays a **reviewer** rule.
It is a property of the column list against the schema, which source text cannot see.

`scripts/` is out of scope for all four rules. It is the build tier for every other rule in this
file, `scripts/new-migration.ts` and `scripts/build-drizzle-manifest.ts` are exactly the tooling
that legitimately knows about drizzle, and this lint's own fixtures live in
`scripts/check-boundaries.test.ts` — `stripComments` does not strip string literals, so a fixture
source held in a template literal reads to `extractImports` as a real import.

## The three exemptions, and why each is a path list rather than a glob

- **The SearchIndex port** — `store/conversations/index.ts` and `store/conversations/transcript-index.ts`.
  FTS5 stays behind the search port (spec §2.7): `MATCH` is not a builder construct and the index
  is a virtual table drizzle has no model for. A `conversations/**` glob would have carried
  `mirror.ts` and `registry.ts` along, which are ordinary repositories.
- **The executor's driver seam** — `executor/driver.ts`, `executor/bun-driver.ts`,
  `executor/harness.ts`. The driver interface, its bun:sqlite implementation, and the
  deterministic interleaving harness (test scaffolding whose filename does not say so).
  `executor/executor.ts` is deliberately absent: see the ledger below.
- **Test files** — by `isTestFile`, which is `*.test.ts` plus the `test-support/` and `fixtures/`
  directories the repository had already decided are test infrastructure.

## `STAGE_A_UNCONVERTED` — the ledger, and why it is not an allowlist

Rule `store-raw-handle` is red on the tree it was written against, by construction: Stage A has
not run, so 38 repository files still hold a raw handle. Armed with nothing, the rule would paint
the blocking CI step red for every worker on the integration branch until the last wave lands —
and Phase 0's own exit gate is `bun run lint:boundaries` green.

So the family ships with a ledger: `STAGE_A_UNCONVERTED`, one exact path per line, listing the
files that have not been converted yet. A file on it is exempt from the rule's raw-handle clauses
and from nothing else. **It is not an allowlist of violations** — it excuses no construct, it
names a file that has not been started, and the "only allowlist is a `// DECISION POD-<n>` line"
rule (method §4) is about sites and is unchanged.

Three checks in `checkStoreBoundaryLedger` stop it rotting:

- **slack** — a listed file with no raw-handle violation left has been converted, and its line
  must go in the same commit. Without this the list is only as accurate as somebody remembering
  to prune it.
- **stale** — a listed file that does not exist is a rename that turned an entry into a silent
  no-op.
- **out of scope** — a listed file outside the store boundary is exempting nothing.

There are no COUNTS, only paths, so a partial conversion cannot be recorded as progress: a file
is unconverted until it holds no raw handle at all.

The initial contents were **derived, not hand-written** — printed by the rule itself against the
branch tip. A hand-built list would be a second opinion about which files are unconverted, and
the rule's opinion is the one that gates.

**Stage A is complete when the array is empty.** `executor/executor.ts` is on it rather than in
the driver-seam exemption because its import is `readonly legacy: SqlDatabase | undefined` — the
executor's legacy field, which Stage A's exit gate deletes by name (method §5, Phase A exit). So
the ledger's last remaining line is the exit gate itself, and both clauses of that gate empty
together.

## Converting a file

1. Convert it. Delete its line from `STAGE_A_UNCONVERTED` in the same commit — the build will
   tell you if you forget.
2. If you hit a site no rule covers: convert it in the most literal form, mark the line
   `// DECISION POD-<n>`, and file the decision issue (method §4). Stage A's exit gate requires
   zero markers, so every marker is a filed question rather than a permanent excuse.

## Cost

The family adds about 13 s to `bun run lint:boundaries` on flatblock (1 m 39 s → 1 m 52 s,
measured 2026-09-03). Rules 14-16 open with a superset pre-filter on the raw source, because
`extractImports` over every file under `apps/` and `packages/` is the most expensive thing in the
script; a mention inside a comment costs one wasted scan and can never cost a miss.
