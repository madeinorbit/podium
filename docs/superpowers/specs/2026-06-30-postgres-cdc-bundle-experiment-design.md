# Experiment: Bundle Postgres (CDC-ready) into the self-contained desktop build

**Date:** 2026-06-30
**Branch / worktree:** `worktree-postgres-cdc-experiment`
**Status:** in progress

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
