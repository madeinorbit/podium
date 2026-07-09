# Data, upgrades, and backups

Where Podium keeps your data, what `podium update` does, and what happens to the
database when a new version starts.

## Where your data lives

Podium keeps all of its state in one directory: **`~/.podium`** by default, or
`$PODIUM_STATE_DIR` if set. Everything below is relative to that directory.

| Path | What it is |
|---|---|
| `podium.db` | The SQLite database (WAL mode — `podium.db-wal` / `podium.db-shm` sidecars appear alongside it). Sessions, repos, issues, conversations, machines, settings — all server state. |
| `config.json` | Install config: deployment mode (`all-in-one` / `daemon` / `client` / `server`), port, server URL, update channel, persistence choice, upstream hub sync. |
| `run/` | The run registry — one pidfile per role (`server.pid`, `daemon.pid`, …) recording pid, port, launch mode, and start time, so `podium status` / `podium stop` can find and manage running components. |
| `logs/` | stdout/stderr of components launched in detached mode. |
| `daemon.json` | The daemon's stable machine identity (a UUID minted once) plus its pairing token, for daemons joined to a remote server. |
| `daemon.secret` | Owner-only (0600) shared secret that lets the same-host `podium-daemon` process authenticate to `podium-server` without pairing. Don't delete it while a daemon is running. |
| `bin/` | The vendored `abduco` session helper, compiled on first daemon start (this is what makes agent sessions survive daemon restarts). |
| `hooks/` | Per-session hook plumbing the daemon injects into agent CLIs. |
| `uploads/` | Files you attach/upload into sessions, grouped per session id. |

The agent CLIs themselves (Claude Code, Codex, …) keep their own state in their own
homes (`~/.claude`, `~/.codex`, …) — Podium observes those but does not own them.

Backing up `~/.podium` (ideally with the server stopped, or at least including the
`-wal` sidecar) captures a complete Podium installation.

## What `podium update` does

`podium update` self-updates a headless install (the desktop app uses Tauri's own
updater):

1. **Picks a channel.** `podium channel` shows or sets it — `stable` (default) follows
   the `latest` GitHub release; `edge` follows the rolling `edge` prerelease. The choice
   is stored as `updateChannel` in `config.json`.
2. **Fetches the channel's manifest** (`podium-update.json`) from GitHub Releases and
   compares its version against the installed bundle's `VERSION` file. Already up to
   date → no-op.
3. **Downloads the release tarball and verifies its Ed25519 signature** against the
   public key baked into the binary, *before* anything is extracted. A missing, wrong,
   or tampered signature aborts the update and leaves the install untouched.
4. **Swaps atomically.** The new bundle is staged in a sibling temp directory on the
   same filesystem, the old install is moved aside, and the new one is renamed into
   place — with rollback if the swap fails partway. A crash never leaves you without a
   working install.
5. **Asks you to restart.** The update replaces files on disk; the running server keeps
   running until restarted (`podium stop` then `podium`, or `systemctl --user restart
   podium-server podium-daemon` for systemd-supervised installs).

Updating never touches `~/.podium` — your database and config are only ever changed by
the *new version starting up*, which is where migrations come in.

## Schema migrations on startup

When `podium-server` starts, it opens `podium.db` and runs a **versioned, forward-only
migration chain** before serving anything:

- Each migration is numbered, runs in its own transaction, and is recorded in the
  database's `schema_version`. Re-running is idempotent — already-applied versions are
  skipped, so a normal restart does nothing.
- **Downgrade protection:** a database whose schema version is *newer* than the running
  code refuses to open with a clear error, rather than corrupting newer data. If you
  roll a binary back past a schema change, restore the matching database backup (below)
  or move forward again.

## Backups before migrations

Before any **version-advancing** migration run (i.e. a startup that will actually
change the schema — not a routine restart), the server backs up the database first: it
checkpoints the WAL, then copies `podium.db` (and its sidecar files) to a timestamped
sibling next to the original (`podium.db.backup-v<from>-<to>-<timestamp>`), keeping the
last 3 backups. If a migration ever goes
wrong, the pre-upgrade state is sitting right next to `podium.db` in `~/.podium`.

To restore: stop Podium (`podium stop`), replace `podium.db` (and remove any stale
`podium.db-wal` / `podium.db-shm`) with the backup copy, and start the matching binary
version again.
