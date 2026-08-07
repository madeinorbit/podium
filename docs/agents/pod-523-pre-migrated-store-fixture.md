# Pre-migrated server test databases — POD-523

Item 1 of the ordered plan in the POD-515 test-gate economy review: *"Build one
current-schema empty database per test run (or a versioned serialized image) and clone
it for ordinary `SessionStore` fixtures."*

## What changed

Ordinary `apps/server` tests get a database that is already at the head of the migration
chain. The chain still runs — once, in vitest's main process — and its result is kept as
a SQLite page image that each store is seeded from.

| | Real chain | Cloned | |
| --- | ---: | ---: | ---: |
| `new SessionStore(':memory:')`, warm | 757.6 ms | 124.6 ms | **6.1x** |
| — building the schema | 507.9 ms | 81.4 ms | 6.2x |
| — the rest of the constructor | 249.7 ms | 249.7 ms | — |
| Full 54-step chain runs per suite run | 2,341 | 1 | |

Twelve constructions per arm, interleaved in one process so both arms see the same host
conditions, after warming both paths. Read the RATIO, not the absolutes: this is a shared
8-core development host and the run above sat at load average 29. An earlier measurement
on the same host at load 26 gave 468.8 ms / 65.3 ms — 7.2x, and its 468.8 ms matches the
~474 ms the POD-515 review measured independently. Absolute numbers move with the host by
a factor of 1.6; the ratio holds at 6–7x.

The constructor's post-migration work is untouched and is now the larger half of what
remains. It is not one hot spot — the per-boot heal that looked most suspect,
`migrateLegacyMachineIdentity`, measured 6.6 ms — so it is filed separately rather than
guessed at here.

## The mechanism

`sqlite3_serialize` / `sqlite3_deserialize`, exposed as `serializeDatabase` and
`openDatabaseFromImage` on `@podium/runtime/sqlite`.

The image is **the byte image of a database built by running the real migrations** —
`test-support/pre-migrated-store.image.ts` opens `:memory:`, runs all 54, and serializes.
It is not a schema dump and not a checked-in `.db`. Nothing anywhere transcribes the
schema, so nothing can drift from the migrations. It carries what the chain produces:
tables, indexes, triggers, the `__drizzle_migrations` ledger, and the rows the ten
migrations with DML insert.

`SessionStore` acquires its connection through one seam, `store-database.ts`:

```ts
this.db = openStoreDatabase(path)   // === openDatabase(path) unless a test installed an opener
```

A hook rather than a constructor argument because there are 389 `new SessionStore(...)`
sites across 95 test files; threading an option through all of them would have been the
change rather than a detail of it. `installStoreDatabaseOpener` **refuses outside a test
runner**, so the shipped binary has no reachable path that installs one.

The migrator still runs on the cloned database. It finds nothing pending and returns —
exactly what the second boot of a real install does.

## Acceptance evidence

### 1. Identical ordinary-suite results, old vs cloned fixtures

`PODIUM_TEST_NO_SCHEMA_FIXTURE=1` puts the whole suite back on the real chain. Full
`@podium/server` regular project, both arms:

<!-- AB-RESULTS -->

### 2. The clone invalidates automatically

The image's **filename is a SHA-256 over every migration's name and sql**, plus a format
version (`schemaFingerprint`). Schema DDL lives only in `src/migrations/` [spec:SP-4428],
so:

> a schema change is a manifest change → a different digest → a different filename → a
> rebuild.

There is no step anyone can forget and no cache to clear. A stale image is not trusted;
it is unreachable. `pre-migrated-fixture.test.ts` pins this against a renamed migration,
an edited migration, and an added migration.

Belt and braces on top: a freshly built image is checked against the manifest's ledger
before it is cached, which catches what a hash cannot — a truncated write, a file left by
another tool, a hand edit.

This is the criterion that protects the in-flight sync rewrite. With the schema churning,
a stale clone would hide a real defect rather than fail; the digest makes staleness
impossible rather than unlikely.

### 3. State cannot cross test cases

`sqlite3_deserialize` copies the image into a new database, and the fixture hands it a
private copy on top of that — so isolation does not rest on bun's ownership semantics.
Three tests prove it directly: two stores do not see each other's rows; ~4 MB of writes
against the 816 KB image leave the image byte-identical; and the store built after those
writes still opens empty.

### 4. Migration suites still execute the full 54-step path

Everything under `apps/server/src/migrations/` is opted out **structurally** — the
setupFile reads the test file's own path, so it cannot be forgotten the way an opt-in
call can. `pre-migrated-fixture.test.ts` lives in that directory and its first assertion
is that no opener is installed for it; the second is that a fresh database still applies
all 54 by name.

Nothing outside that directory turned out to need the allowlist: the suites that build
old databases (`machine-identity`, `store.machines`, `store.repo-id`) simulate old *data*
on a current schema, and the file branch of the opener leaves an existing database alone
so their upgrade paths are unchanged. `REAL_MIGRATION_CHAIN_TESTS` exists, documented and
empty, for the next file that does.

Two suites that read schema *shape* — `characterization.test.ts` dumps all of
`sqlite_master`, `store.issues.test.ts` walks `PRAGMA table_info` — deliberately stayed
on the clone, where they double as canaries that the clone and the chain agree.

### 5. Cold server phase timing

<!-- TIMING -->

## Also converted

Sixteen suites built a bare `openDatabase(':memory:')` and called `applyBaselineSchema` /
`runDrizzleMigrations` on it directly, paying the same schema-build cost without going through
`SessionStore` at all. They now call `openMigratedTestDatabase()`
(`test-support/migrated-database.ts`), which clones when an image exists and runs the
chain when it does not.

## Two things worth knowing before changing this

**The module split is load-bearing.** `test-support/pre-migrated-store.ts` is imported by
a setupFile, i.e. by all ~291 apps/server test files including the ~200 that never
construct a store. The first version imported the migration chain there, and a pure
policy file's setup phase went from 0.4 s to 43 s. Import time is already 53.5% of this
lane's work (POD-515) — paying it everywhere to save migrations somewhere would have been
a net loss. The migrator now lives in two sibling modules that run once, in the main
process, and even there it is behind the cache-miss branch.

**The cache is not in tmp**, deliberately. The hermetic setup repoints `TMPDIR` at a
per-file container deleted when the fork exits [spec:SP-0be7], so a tmp cache would be
rebuilt ~291 times per run. It lives in `node_modules/.cache/podium-test-schema/` — the
conventional home for a derived artifact, already ignored, wiped by a clean install.

## Deferred

- **The rest of the constructor** (POD-534). With the chain gone, the per-boot heals and
  the 28 repository constructions are what a store costs, and they run 2,341 times too.
  They are not addressed here because they are PRODUCTION code on the real boot path —
  making them cheaper is a change to how the server starts, not to a test fixture, and it
  deserves its own measurement rather than being folded into this one. The one candidate
  worth naming was ruled out by measurement: `migrateLegacyMachineIdentity`, which walks
  `sqlite_master` and issues a `PRAGMA table_info` per table, costs 6.6 ms.
