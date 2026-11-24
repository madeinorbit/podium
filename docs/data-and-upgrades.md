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
| `bin/` | The `abduco` attach client, compiled or unpacked on first need. It is kept only to adopt sessions an older release started on abduco; new sessions run on podium-host, which ships beside the `podium` CLI in the installed bundle. A `bin/podium-host` here is the retired C host an older version unpacked; nothing current uses it. |
| `hooks/` | Per-session hook plumbing the daemon injects into agent CLIs. |
| `uploads/` | Files you attach/upload into sessions, grouped per session id. |

Outside the state directory: the vault key file, `~/.config/podium/vault-<instance>.key`
by default (see [The vault key](#the-vault-key)).

The agent CLIs themselves (Claude Code, Codex, …) keep their own state in their own
homes (`~/.claude`, `~/.codex`, …) — Podium observes those but does not own them.

Backing up `~/.podium` (ideally with the server stopped, or at least including the
`-wal` sidecar) captures a complete Podium installation, except for the vault key
below, which is kept outside it on purpose.

### The vault key

The API keys, tokens and other secrets Podium stores (provider keys, the Linear key,
the Telegram bot token) are encrypted in `podium.db`. The key that opens them is
**not** in the state directory. It is a file:

`$PODIUM_VAULT_KEY_FILE`, else `$XDG_CONFIG_HOME/podium/vault-<instance>.key`, else
`~/.config/podium/vault-<instance>.key` (`<instance>` is `default` unless you run a
named instance).

The server creates it the first time it stores a secret, readable only by its
owner (mode `0600`, in a `0700` directory when it creates the directory). A copy
of the database or of the state directory therefore opens nothing without it.
Keys that were stored before the vault existed are moved into it automatically
at start. Each old plain copy is then destroyed, but only once the key has been read
back from the vault: it is overwritten, the database is compacted so no deleted copy
stays in unused space, and the same keys are removed from the snapshots Podium keeps
next to the database (`podium.db.backup-v*`). A key whose move could not be confirmed
(for example because the vault key file was missing at that start) stays where it was,
is named in the server log, and is tried again at the next start.

What this does not reach:

- **Backups made before the upgrade still hold the keys in plain text.** That includes
  copies of the state directory you made yourself and any machine backups. Podium cannot
  clean them.
- **Restoring one of Podium's snapshots with the previous version means adding the keys
  again** (provider keys, the Linear key and the Telegram bot token): the snapshots no
  longer hold them, and the previous version cannot read the vault.
- **If an old backup cannot be trusted** (lost, shared, kept somewhere others can read),
  replace the key at its provider: revoke it there, create a new one, and add the new
  one to Podium. Deleting the backup does not undo a copy someone already has.

**Back the key file up separately from the state directory.** A backup that holds
both is as sensitive as the keys themselves.

**Moving the server.** Podium's own server transfer moves the key for you. It
copies the database to the new machine, then hands the vault's key over in the
final step, the one that makes the new machine the server. The key travels in that
message only, never as a file in the copied package, and the new machine writes it
into the database wrapped by its own key file (created there with mode `0600` if
it has none). Before the old server gives up its role, the new machine proves that
it can open the vault. If it cannot, the transfer stops: the old server stays the
server and keeps its key, and the new machine removes what it received. When the
transfer completes, the old server deletes its own key file, so it keeps no way
into the vault. If that file cannot be deleted (a mounted secret, say), the
transfer still completes and reports the file; delete it yourself. A transfer to a
machine whose connection to the server is not encrypted (plain `ws` to another
computer, outside a network declared trusted) is refused before anything is
copied, and so is a transfer to a machine running a Podium too old to take the key.

**Moving the server by hand.** Copy the state directory and the key file, and put
the key file at the path the new machine expects (above). Then delete the old
copy of the key file. A database that arrives without its key file starts locked,
as described next.

If the server starts without its key (a database restored on another machine, a
lost file), it still starts. `podium vault status` shows the vault as **locked**
and names the path where it expects the file. Stored credentials read "needs
attention", the Linear and Telegram integrations act as not configured, and
nothing new can be stored; no new key replaces the old one by itself. Put the
file back and restart. If it is lost for good, `podium vault reset --confirm` (an
admin only) deletes the stored secrets so that they can be added again; nothing
else is lost.

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

The package swap does not change the live database. A managed server update does create
a recovery snapshot beside it immediately before requesting the restart; the database
schema and data are only changed by the *new version starting up*, which is where
migrations come in.

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

### Updates that would land on the wrong side of that refusal

Downgrade protection stops a server from opening a database it does not understand —
but on a machine that has already been swapped, it stops it every time, and the thing
that would put the working version back is the server that will not start. So the
update path refuses **before** the swap instead.

A machine that holds a database converges only to a version that says it can open what
that database has already applied. Every published target declares the migrations its
build defines; a machine compares that list against its own migration ledger and
declines the move if anything is missing, reporting one of:

- `schema-advanced` — the target genuinely cannot open this database. It names the
  first migration it lacks.
- `schema-unknown` — the target does not declare its schema (every release published
  before this check existed) *and* is not a version this machine can prove is newer than
  the one it runs, so nothing can tell whether the move is safe.
- `schema-unreadable` — this machine's own ledger could not be read, so the same.

**Moving forward is never gated by a missing declaration.** An update to a provably newer
version cannot strand a database: the schema only ever advances through migrations the
new build itself carries, and releases are expand-only, so a newer build defines
everything an older one did. Only a step backwards — or between two labels with no
order at all, such as `dev+<sha>` — has to be proven.

In all three cases **nothing is fetched and nothing is swapped**: the machine stays on
the version that works and keeps running. A downgrade whose schema did *not* advance is
unaffected and still converges — that is the ordinary one-release rollback the
expand-and-contract policy below exists to keep cheap.

Going further back than that is not something Podium can do for you, and the refusal
says so: it needs a database restore by hand (see *Backups before migrations*), because
restoring silently would discard every write made since the schema advanced. Machines
that hold no database — every remote worker — are never gated at all.

## Expand-and-contract policy

Releases use an **expand-and-contract** migration policy. Release N may add
tables, indexes, or columns that the older binary can ignore; a destructive
contract step ships no earlier than release N+1, after the old schema contract is
no longer needed.

This makes a one-release rollback a plain binary swap: the older binary ignores
columns it does not know, so rolling back the release needs no down migration and
no database work. A destructive change is never hidden behind a pretend inverse;
the next release performs the contract step only after the compatibility window
has closed.

The `bun run audit:expand-only` gate enforces this policy against every generated
migration. It flags dropped tables or columns, renames, SQLite table rebuilds, and
`ADD COLUMN ... NOT NULL` without a default. If the gate reports a finding, split
the migration into an additive expand step and a later contract step. Its `--probe`
mode proves each check can fire before a clean result is trusted.
## Snapshots before update migrations

The recovery point for a migration is the snapshot the **new** server takes when it starts
with migrations pending, before it applies any of them. Nothing else is writing at that
moment, so it checkpoints the WAL and copies the database file. Every way of reaching a new
binary takes it: a managed update, a desktop update, a manual install or a source run. A
routine restart with no pending migrations does not.

When a managed update reaches its **server** step, the old server first checks that the
disk can hold the new server's snapshot (the database and its sidecars plus 10%). If it
cannot, the update fails there and the old server keeps running; nothing has stopped yet.
The new server repeats the same check before copying and refuses to migrate if the disk
filled in between.

If the release may migrate (it declares a migration this database has not applied, or
declares none) and the disk has the room the new server's upgrade check asks for (2.5
times the database), the old server then copies the database file to
`podium.db.backup-seed` while it still serves, and flushes it to disk. The copy stops,
and is removed, if free space falls below that while it runs. From then until the new
server boots, the seed takes the snapshot's space beside the database the old server is
still serving. The new server's snapshot starts from that file: it compares it with the
database block by block and rewrites only the blocks that changed since, so the snapshot
holds the same bytes a full copy would, but the server is not down for the whole copy.
The seed is never restored or listed as a snapshot. A missing seed (or one that is not a
plain file of its own) means a full copy; a damaged or stale one means more is rewritten.
A seed that no boot uses (a canceled update, a release with no migration) is removed.

Snapshots use names such as `podium.db.backup-vdrizzle-<applied-count>-<timestamp>`; older
installations may also hold `podium.db.backup-vupdate-<from>-to-<target>-<timestamp>` files
from before this change. Podium writes the database and any present SQLite sidecars to
temporary `.partial-` names, fsyncs them, and atomically publishes the main snapshot name
last. If copying stops partway (including because the disk fills), no truncated file is
published under a restorable name and the migration does not run. A background check
verifies each snapshot after boot; a later schema-downgrade refusal names the newest
verified one.

Podium keeps the newest **3 verified snapshots**. Cleanup runs after every successful
snapshot; it removes older snapshots only after they pass SQLite's integrity check.
Unreadable snapshots and `.partial-` files are preserved, do not count toward the
three, and are reported in the server log. A cleanup failure is also logged but does not
turn a successfully snapshotted update into a failed update.

To restore the path named by the update failure: stop Podium (`podium stop`), replace
`podium.db` with that snapshot, remove any stale `podium.db-wal` /
`podium.db-shm`, and start the matching older binary version again.

## Rehearse a candidate against real state

From the candidate checkout, install its own dependencies with `bun run setup:worktree`, then:

```bash
bun --conditions=@podium/source scripts/rehearse-upgrade.ts /absolute/path/to/real/state
# Optional second argument: a new, nonexistent directory for the retained copy.
# Real databases under load may need longer than the default 10-minute boot budget:
bun --conditions=@podium/source scripts/rehearse-upgrade.ts /absolute/path/to/real/state /tmp/my-upgrade --timeout-seconds 900
```

The script reads only `podium.db` through a read-only SQLite connection and uses
`VACUUM INTO` to create a consistent snapshot, including committed WAL pages. SQLite
writes the snapshot to disk with an 8 MiB page cache; the script never serializes the
database into RAM, checkpoints the source, or changes the running installation. It
copies no config, credential files, transcripts, symlinks or previous backups. The
copied database itself still contains private data. The copy gets a fresh local machine
identity and a fresh update-signing key solely for the isolated boot. This database-only
drill does not verify legacy identity-file import; the customer-upgrade fixtures do.

Before copying, the script requires free disk for three times the source's logical size
(snapshot, the candidate's pre-migration backup and growth) plus a 1 GiB live-state reserve.
Use a small representative real source when a large copy would crowd the live instance.

The copy has its own `PODIUM_STATE_DIR`, agent home, `XDG_RUNTIME_DIR`, cache and temporary
roots. A whitelisted child environment removes inherited session relays, supervisor credentials
and instance overrides. The server binds loopback on an ephemeral port with
`PODIUM_CONNECT=off`, `PODIUM_TELEMETRY=off` and `PODIUM_REHEARSAL=1`. No supervisor or daemon is launched.

**Loopback and a copied database alone are not isolation.** Copied sessions and issues still
point at real repositories: the 2026-09-18 rehearsal attempted `git worktree add` in one.
Rehearsal mode skips session restoration, queued-input wake, issue boot reconciliation,
janitor/reaper workers, superagent turn adoption/reaping, messaging, source publishing,
update adoption and Connect publication. Session spawn and daemon startup refuse outright.
HTTP and WebSocket traffic other than `/health` and `/version` returns 503, preventing an
external daemon or client from activating copied sessions. Database migrations still run.
Never remove the flag or boot a supervisor/daemon against this copy.

The command checks health and the session-traffic fences, closes the server, and retains
`state/`, private `boot.log`, sanitized `boot-stages.json`, `result.json` and
`rehearsal.json` in the printed directory. The boot budget defaults to 600 seconds;
`--timeout-seconds` overrides it. Snapshot time is separate from the boot budget.
On timeout the script kills its own child process group, records the signal and exits
nonzero. `rehearsal.json` records candidate commit, Bun version, logical and copied database
sizes, available/required disk, snapshot/migration/boot/total times, exit code, signal and
whether the timeout fired. Attach that report to the issue; do not attach `boot.log` or
the database without sanitizing them. Keep the copy private and remove only your own
scratch directory after retaining evidence.

For a matched **database-only rollback** drill, first boot a consistent copy under the
previous binary in a fully isolated rehearsal instance. Verify its health, fences and
version, stop it, and take a consistent backup of that established database. Upgrade a
further copy with the command above. Restore the established backup to a fresh isolated
state root (no stale WAL/SHM files) and boot the same previous binary again. Compare the
preserved data and verify health/version again. Record the binary version and hash,
schema ledger, database sizes, timings and exit codes. This proves restoring the database
with its matching binary; it does not prove restoration of external files or credentials
stored outside the database.

This rehearsal proves server migration/boot safety, not daemon ONLINE attachment; the
customer-upgrade fixture arms and skew lane provide that separate evidence.
