# Experiment: Bundle Postgres (CDC-ready) into the self-contained desktop build

**Date:** 2026-06-30
**Branch / worktree:** `worktree-postgres-cdc-experiment`
**Status:** complete — results below

## Goal

Measure what it costs — in **bundle size** and **idle memory** — to replace the
podium server's main SQLite database with a **real PostgreSQL server**, bundled
into the self-contained desktop build, configured so that a CDC-based sync
engine (ElectricSQL / PowerSync / Rocicorp Zero) could attach on top.

This is an **experiment**, not a production migration. Success = credible
before/after numbers + a proof that the bundled Postgres is CDC-capable.

## Why Postgres (not PGlite)

The user's intent is sync-readiness. ElectricSQL, PowerSync and Rocicorp Zero
all replicate *from* a Postgres source via **logical replication** (`wal_level =
logical`, a publication, a replication slot, the built-in `pgoutput` plugin —
i.e. CDC). PGlite (in-process WASM) is a *replica target*, not a replication
source, so it cannot fill this role. Therefore the bundled DB must be a real
Postgres server with logical replication enabled.

## Current state (the "before")

- **Main DB:** `~/.podium/podium.db`, opened via built-in `node:sqlite` /
  `bun:sqlite` (no native addon, no external package).
- **Abstraction:** a 5-method `SqlDatabase` interface in
  `packages/core/src/sqlite/`; *all* queries funnel through one `SessionStore`
  class (`apps/server/src/store.ts`, ~1337 lines). Raw SQL, positional `?`,
  FTS5, WAL.
- **Packaging:** Tauri 2 shell + three Bun-compiled binaries
  (`podium`, `podium-server`, `podium-daemon`) staged into Tauri `resources/`.
  SQLite costs ~0 extra bundle (built into Bun) and ~0 extra process memory
  (in-process).
- **Scope:** only the server's main `podium.db`. The 3 other SQLite DBs
  (discovery cache, codex, opencode) are left untouched.

## Design (scope: "boot + basic ops")

The measurements (bundle size, idle RSS/PSS) only require the server to boot
against Postgres, create its schema, and run basic CRUD. Full query parity
(FTS5, every migration) is **out of scope**.

1. **Bundle a real Postgres.** Use `embedded-postgres` binaries (a self-contained
   Postgres tarball — exactly what a desktop bundle would ship). Launch the
   `postgres` server as a child process of the daemon, mirroring the existing
   embedded-abduco extract-to-`~/.podium/bin` pattern. Init flags:
   `wal_level=logical`, `max_wal_senders>=1`, `max_replication_slots>=1`.

2. **Postgres `SqlDatabase` adapter, synchronous via `bun:ffi` + libpq.**
   `SessionStore` is fully synchronous; Postgres clients are async. Rather than
   rewrite 1337 lines async, the adapter calls libpq's **blocking**
   `PQconnectdb` / `PQexecParams` through `bun:ffi`, preserving the sync
   `prepare/run/get/all` shape with **zero changes to `SessionStore`**.
   Translate `?` -> `$n`. (Fallback if FFI fights us: `spawnSync` psql — enough
   to boot and measure.)

3. **Port schema DDL + core queries** to Postgres dialect: `AUTOINCREMENT` ->
   `GENERATED`/`SERIAL`, `INSERT OR IGNORE` -> `ON CONFLICT DO NOTHING`, drop
   `PRAGMA`, adjust a few types. **Stub FTS5** (the `conversations_fts` virtual
   table + triggers) — not needed for the measurement.

4. **CDC proof.** Create a publication + logical replication slot, write a row,
   confirm `pg_logical_slot_peek_changes` emits the change — i.e. an
   Electric/PowerSync/Zero consumer could attach. We do **not** wire up an
   actual sync engine.

## Measurements

| Metric | Before (SQLite) | After (Postgres) |
|---|---|---|
| Backend binary size (`du` of `dist-bun/podium`) | baseline | + adapter code |
| Bundled DB engine size | ~0 (built-in) | embedded-postgres tarball |
| AppImage size (if Tauri builds on this host) | baseline | + Postgres |
| Idle process count | 1 (podium) | podium + postmaster group |
| Idle memory (sum RSS) | baseline | podium + all postgres procs |
| Idle memory (sum PSS) | baseline | PSS to net out shared_buffers |

- **Memory** is measured on an **isolated** podium instance
  (`PODIUM_STATE_DIR` + `PODIUM_PORT` + `PODIUM_NO_SCOPE` +
  `PODIUM_PTY_BACKEND=node-pty`) so the live Podium is untouched.
- **PSS** (from `/proc/<pid>/smaps_rollup`) is reported alongside RSS because
  Postgres shares one large `shared_buffers` segment across its process group;
  summing RSS double-counts it.

## Expected result (hypothesis)

Bundle grows by **tens of MB**; idle memory grows by **~100MB and several extra
processes** — the real cost of CDC-readiness for a local, single-user desktop
app. The writeup states the number and lets the user decide if it's worth it.

## Out of scope

- FTS5 / full-text search parity.
- Wiring up an actual sync engine.
- Migrating the 3 secondary SQLite DBs.
- Production-grade lifecycle (crash recovery, upgrades, multi-platform binaries).
- Data migration from existing SQLite DBs.

---

# RESULTS (measured 2026-06-30, linux-x64, Postgres 18.4-beta via embedded-postgres)

## Headline

| | Before (SQLite) | After (Postgres, CDC-ready) | Delta |
|---|---|---|---|
| **Bundle (raw)** | 0 (built into Bun) | embedded-postgres native dir **60 MB** | **+60 MB** |
| **Bundle (gzipped)** | 0 | **22 MB** | **+22 MB** |
| **Backend binary** | 98 MB | 98 MB | **~0** (libpq dlopen'd; PG is a child proc) |
| **Idle processes** | 1 | 1 + 9 (postmaster group) | **+9** |
| **Idle RSS** | 65 MB | 65 MB + 76 MB | **+76 MB** (naive sum) |
| **Idle PSS** | 62 MB | 62 MB + 26 MB | **+26 MB** (honest; nets out shared_buffers) |

So bundling a CDC-ready Postgres costs **~+22 MB download / +60 MB on disk** and
**~+26 MB resident RAM across +9 processes** for an idle, single-user desktop app.

## Bundle breakdown (the 60 MB)

- `lib/` 46 MB — **ICU alone is ~30 MB**; also a version-matched `libpq.so.5.18`.
- `bin/` 9.7 MB — `postgres` server 9.8 MB + `initdb` + client tools.
- `share/` 5.2 MB — initdb templates, timezone, locale.
- **Trimmable to ~29 MB raw** by dropping ICU (`initdb --locale-provider=builtin`,
  C.UTF-8) and the unused client binaries.

## Memory detail (idle, default `shared_buffers=128MB`)

9 processes: postmaster (RSS 26M/PSS 17M), 3 async io workers, checkpointer,
background writer, walwriter, autovacuum launcher, logical replication launcher
(each ~1–2M PSS). Total **RSS 76 MB / PSS 26 MB**. Note PG18's new async io
workers add ~3 procs vs PG16. Tuning `shared_buffers` down would reduce this.

## CDC proof ✅

With `wal_level=logical`: `test_decoding` streamed the writes
(`table public.cdc_demo: INSERT: id[integer]:1 val[text]:'hello-from-cdc'`), and
a **`pgoutput`** logical slot + a `FOR ALL TABLES` publication were created — the
exact mechanism ElectricSQL / PowerSync / Rocicorp Zero consume. A sync engine
could attach to this bundled server.

## Boot + basic ops ✅ (15/15)

The **real** `SessionStore` (`apps/server/src/store.ts`, unchanged except a
1-param injectable-db seam) ran its full `migrate()` and representative CRUD on
Postgres through the synchronous libpq FFI adapter: repos (INSERT-OR-IGNORE →
ON CONFLICT, `rowid`→`ctid`), pins, snoozes, tab-order, drafts, `upsertSession`
(big INSERT…ON CONFLICT DO UPDATE, int/bool coercion), superagent messages
(IDENTITY id via `lastval()`), settings (INSERT-OR-REPLACE → ON CONFLICT). All
360 existing server tests still pass (SQLite path untouched).

## What made the swap small

The persistence layer's design did the heavy lifting: a 5-method `SqlDatabase`
interface + a single `SessionStore` funnel meant the whole backend swap was a
**~260-line FFI adapter** (`packages/core/src/postgres/index.ts`) doing dialect
rewrites (placeholders, `PRAGMA`, `sqlite_master`, `AUTOINCREMENT`,
`INSERT OR IGNORE/REPLACE`, `rowid`) + a **one-line constructor seam** — zero
changes to 1337 lines of query code.

## Packaging gotchas found (real costs of bundling)

1. **Soname symlinks**: Bun skips the platform package's postinstall, so the
   `libic*.so.60` → `.60.2` symlinks (in `pg-symlinks.json`) must be materialized
   or `initdb`/`postgres` fail to load.
2. **`LD_LIBRARY_PATH`**: the bundled binaries need their own `lib/` on the
   library path (or an rpath patch) to find ICU/libpq.
3. Postgres won't run as root and needs a writable data dir → first-run `initdb`
   step the desktop app must own (mirrors the embedded-abduco extract pattern).

## Verdict

Cheap in CPU/code to integrate; **not cheap in footprint** for a local app:
SQLite is 0 MB + 0 procs in-process, Postgres is ~22–60 MB + a 9-process,
~26 MB-RAM server. Worth it only if CDC-driven sync (Electric/PowerSync/Zero) is
the actual goal — which is exactly the premise here. If sync is wanted without
the server cost, the alternative is keeping SQLite as source-of-truth and syncing
at the app layer (the PGlite-as-replica direction), not bundling a Postgres
server.
