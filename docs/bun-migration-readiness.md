# Bun migration — readiness report

**Date:** 2026-06-21
**Branch:** `worktree-feat+pty-backend-abstraction` (off `main` @ `030d70f`)

> **Update (2026-06-26):** partly superseded — the committed `scripts/systemd/podium-server.service`
> and `podium-daemon.service` already run the backend on Bun from source
> (`bun --conditions=@podium/source`), and local dev runs on Bun (`bun run host`). Sections below
> that describe a Node/`tsx` present are historical; treat this file as migration history, not
> current onboarding (see `CONTRIBUTING.md` for how to run today).

Goal: run Podium on Bun, shippable as a `bun build --compile` single-file binary, and be
able to flip the live host node→bun on a copy of the existing state.

## What is proven (with how)

| Capability | Proof |
|---|---|
| PTY layer on Bun.Terminal | Backend-parameterized behavioral suite, 12 behaviors, green on both node-pty (vitest) and Bun.Terminal (`bun test`). |
| Durable abduco path on Bun.Terminal | `abduco.bun.test.ts`: create + `sh -c 'exec abduco -a'` attach + chrome strip + OSC title + input + detach-survive + reattach repaint + kill, 2/2. |
| SQLite on Bun | `@podium/runtime/sqlite` shim (node:sqlite ⇄ bun:sqlite); shared spec green on both; full `SessionStore` round-trip on bun:sqlite. |
| Whole stack boots on Bun | `bun scripts/server.ts` serves `/health`; `bun scripts/daemon.ts` connects over WS; zero errors. |
| Single-file binary | `bun build --compile` → `dist-bun/podium-server` + `podium-daemon` (98 MB each, standalone ELF). Both run with **no bun/node installed**. |
| abduco in the binary | Daemon embeds a prebuilt abduco and materializes it to the cache on first start — clean-machine test (no abduco on PATH, fresh state) materialized a working `abduco-0.6` binary. |
| Real session lifecycle through the Bun daemon | `bun-session-smoke.ts`: attach → stream output → input round-trip → resize + take control, through the durable abduco path. Passes. |

## Same-live-state compatibility (node → bun on the existing DB + sessions)

The live state is `~/.podium` (`podium.db`, `discovery.db`, `bin/abduco`) plus ~dozens of
durable abduco masters. Switching the *process* from Node to Bun must read that state as-is.

| Concern | Finding | Verified |
|---|---|---|
| SQLite file format | node:sqlite and bun:sqlite are both standard SQLite3 — same on-disk format. | ✅ |
| **WAL mode + sidecars** | A WAL-mode DB written by node:sqlite opens, reads, and **writes** correctly under bun:sqlite. | ✅ cross-runtime test |
| **FTS5** (the live `conversations_fts` virtual table + triggers) | bun:sqlite has FTS5. Bun **read the node-created FTS index AND wrote new rows through the FTS trigger** (`MATCH` returns them). | ✅ cross-runtime test |
| Discovery cache (`discovery.db`) | Same SQLite compatibility; and it is a regenerable cache regardless. | ✅ |
| Codex/opencode read-only DBs | Opened `{ readOnly: true }` via the shim → bun:sqlite `{ readonly: true }`; proven by the shim spec. | ✅ |
| **abduco master reattach** | A master created *outside* the bun daemon (raw abduco, standing in for a node-era master) is reattached via Bun.Terminal; input round-trips, no chrome leak, kill works. A bun daemon takes over node-created masters. | ✅ cross-process test |
| Hook ingest port | Fixed `45777`, baked into each spawned agent. A clean stop→start frees it so the bun daemon rebinds it and existing agents keep reporting. If `45777` is still held it falls back to an ephemeral port and pre-existing agents lose hook updates until they restart. | ⚠️ requires clean stop→start |
| Graceful shutdown | Bun's `node:http` `server.close()` waits on lingering keep-alive sockets that Node drains promptly. Bounded the SIGTERM handlers (server + daemon) to 4 s so the process always exits promptly; no-op on Node. | ✅ fixed |
| `ws`, `@hono/node-server`, tRPC | Boot + a full session lifecycle exercised them with no errors. **Not** load-tested. | ⚠️ soak |

**Net:** the existing DB (incl. WAL + FTS5) and the live abduco masters are all
forward-compatible with a Bun process. No data migration is required.

## Cutover plan for a test drive (on a copy of the state)

The live backend runs from the **main checkout** via systemd (`podium-server` +
`podium-daemon`, tsx on Node). This switch runs Bun from the **worktree / compiled binary**
— the main checkout is never modified. Default deployment stays Node until a soak passes.

1. **Copy state** (operator): `cp -a ~/.podium ~/.podium-bun` (include `-wal`/`-shm`).
2. **Stop the live backend**: `systemctl --user stop podium-daemon podium-server`. This frees
   port `18787` and the hook port `45777`, and detaches the abduco attach clients (masters
   survive).
3. **Start under Bun**, same ports so the existing web/tailscale-serve keeps working, default
   abduco socket dir so it reattaches the live masters:
   - Compiled binary (the real artifact):
     `PODIUM_STATE_DIR=~/.podium-bun PODIUM_PORT=18787 ./dist-bun/podium-server`
     `PODIUM_STATE_DIR=~/.podium-bun PODIUM_PORT=18787 ./dist-bun/podium-daemon`
   - Or from source: `bun --conditions=@podium/source scripts/server.ts` / `…/daemon.ts`.
4. **Test drive** via the web UI — existing sessions reattach; spawn/type/resize/kill.
5. **Revert**: stop the Bun processes; `systemctl --user start podium-server podium-daemon`
   (back on the original `~/.podium`). New sessions created during the drive live in
   `~/.podium-bun` and are dropped on revert — expected for a copy.

Notes: only one daemon may run at a time (shared abduco masters). The abduco binary on the
host must be the same 0.6 line as the masters (it is — same vendored source).

## Remaining before making Bun the *default* (not blockers for a test drive)

- **Soak / scale**: many concurrent long-lived sessions, reattach storms, multi-hour, under
  real memory pressure. The behavioral suite is the regression net; this is wall-clock.
- **Load behavior** of `ws` backpressure / hono / tRPC under Bun.
- **Web app** (Vite PWA) is unchanged and served separately — out of scope here.
- **systemd units**: production cutover would change `ExecStart` to the binary (or `bun …`)
  and, for the watchdog, keep `Type=notify` (sd-notify over `node:dgram`, supported by Bun).

## Go / no-go

- **Test drive on a copy of live state: GO.** Every blocker is resolved and the same-state
  compatibility (WAL, FTS5, abduco reattach) is verified. The switch is reversible.
- **Make Bun the default on the live host: not yet** — pending the soak above.
