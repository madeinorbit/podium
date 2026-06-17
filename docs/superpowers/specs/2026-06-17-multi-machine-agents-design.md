# Multi-machine agents — design

2026-06-17 · branch `worktree-multi-machine-agents`

## Goal

Let one Podium **server** orchestrate agents across **several machines**, each running its own
**daemon**. A daemon on a laptop, a desktop, and a cloud box all connect to the same server;
the user starts, watches, and drives agents on any of them from one UI. Per the user: *where*
an agent runs is not important day-to-day, but the information must be visible if you look for
it. The dropdown for starting an agent becomes machine-aware; everything in the DB, server, and
protocol learns which machine a session/repo/conversation belongs to.

The transport seam already exists — the daemon connects to the server over a WebSocket
(`startDaemon({ serverUrl })`, `scripts/host.ts:18`). What is missing is **identity**
(no machine id anywhere), **a registry** (the server holds a single `daemonSend` socket,
`relay.ts:55`), **auth** (the `/daemon` endpoint is open), and **attribution** (no session,
repo, or conversation records which machine it lives on). `relay.ts:408-412` already flags this:
*"When multi-daemon lands, sessions will need a host id (none exists today)…"*. This design adds
exactly that.

## Non-goals

- **Moving a live agent between machines.** A session is born on a machine and stays there.
- **Server-initiated daemon install / provisioning.** The user installs and runs the daemon;
  Podium only pairs and tracks it.
- **Cross-machine filesystem access.** A daemon only ever spawns agents against its *own* disk.
  "Open this repo on machine B" means B has its own clone of that repo.
- **Sharing one repo working tree between machines.** Repos are matched across machines by
  identity (git origin), not shared storage.

## Identity & pairing

Each daemon owns a **stable `machineId`** (a UUID) and an **auth token**, both persisted locally
in `~/.podium/daemon.json` (alongside the existing state dir). The `machineId` survives restarts,
reboots, and hostname changes, so it — not the OS hostname — is the join key everywhere.

**First connection is unauthenticated and rejected.** To admit a machine the user mints a
**pairing code** in the UI (Settings → Machines → "Add machine"). The code is short
(e.g. `XXXX-XXXX`), single-use, and expires in ~10 minutes. The codes live in memory on the
server (a dead pairing code after a restart is fine — mint another).

Pairing handshake (over the same `/daemon` WebSocket, before any session traffic):

```
daemon -> server   { type: 'pair',  code, machineId, hostname, name? }
server -> daemon   { type: 'paired', token, machineId, name }      // success
server -> daemon   { type: 'pairRejected', reason }                // bad/expired code
```

On success the server creates the `machines` row (or updates it if `machineId` already exists),
stores `token_hash`, and returns the token. The daemon writes `{ machineId, token, serverUrl }`
to `~/.podium/daemon.json`. Thereafter the daemon authenticates on connect:

```
daemon -> server   { type: 'hello', machineId, token, hostname }
server -> daemon   { type: 'helloOk', name }                       // token matches the machineId
server -> daemon   { type: 'helloRejected', reason }               // unknown/forbidden -> daemon must re-pair
```

`hello`/`pair` must be the **first frame**; the server ignores all other control traffic on a
socket until it has authenticated and bound a `machineId`. Token check is a constant-time compare
against `token_hash` (sha-256). Revoking a machine deletes the row + hash, so its next `hello`
is rejected and it falls back to needing a new pairing code.

**Name** defaults to the reported `hostname` and is user-editable (Settings → Machines). The name
is display-only; nothing keys off it.

### Local-daemon bootstrap (no pairing friction for the common case)

The bundled single-box setup (`scripts/host.ts`) must keep working with zero pairing. `startServer`
mints a one-time **bootstrap token** at startup and exposes it on its handle; `scripts/host.ts`
passes it straight to `startDaemon`, which sends it in `hello`. The server trusts the bootstrap
token for exactly one machine — the localhost daemon — auto-creating its `machines` row (named
after its hostname) and adopting the `'__local__'` rows on that first registration. Pairing is
only the path for *remote* daemons.

## Data model (SQLite migration v3 → v4)

New table:

```sql
CREATE TABLE IF NOT EXISTS machines (
  id            TEXT PRIMARY KEY,   -- stable UUID minted by the daemon
  name          TEXT NOT NULL,      -- custom; defaults to hostname
  hostname      TEXT NOT NULL,      -- last reported os.hostname()
  token_hash    TEXT NOT NULL,      -- sha-256 of the auth token
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL       -- updated on every authenticated connect / heartbeat
)
```

Attribution columns:

- `sessions.machine_id TEXT` — which machine the session runs on.
- `conversations.machine_id TEXT` — which machine discovered the conversation.
- `repos` re-keyed from `PRIMARY KEY (path)` to `PRIMARY KEY (machine_id, path)`, plus a new
  `origin_url TEXT` column (normalized git remote, the cross-machine match key) and `repo_name`.

**Migration runs at server startup, before any daemon's `machineId` is known**, so existing rows
are tagged with the placeholder machine id `'__local__'`. The first **bootstrap (localhost)
daemon** to register rewrites `'__local__'` → its real `machineId` in one `UPDATE` across
sessions, repos, and conversations (pre-multi-machine, all data belonged to the single local
box). This avoids NULLs in the new `repos` primary key and the migration-time ordering problem.
Because `repos`' primary key changes, the v4 migration rebuilds that table (create `repos_v4`,
copy rows stamping `machine_id = '__local__'`, drop, rename) rather than `ALTER`. All other
changes are additive `ALTER TABLE … ADD COLUMN`, matching the existing migration style in
`store.ts` (`migrate()`).

**Repo identity** (the "which machine has this repo" key): normalized git **origin URL** —
lowercased host, `.git` stripped, scp-style rewritten to a canonical form so
`git@github.com:me/x.git` and `https://github.com/me/x` match. Fallbacks when there is no remote:
repo basename, then exact path (so a remote-less repo only matches itself on its own machine).
The normalizer is a pure, tested function in `@podium/core`.

**Schema version** bumps to **4** in the `meta` table.

## Protocol changes (`@podium/protocol`)

- `SessionMeta` gains `machineId: string` and `machineName: string` (so the web never has to
  join client-side just to label a session).
- Daemon→server discovery messages (`conversationsChanged`, repo scans, `hostMetrics`) no longer
  need a hostname field — the server attributes them to the **authenticated `machineId` of the
  socket** they arrive on. `hostMetrics` keys by `machineId` instead of `hostname`.
- New server→client `machinesChanged` message: `{ type, machines: MachineWire[] }` where
  `MachineWire = { id, name, hostname, online, lastSeenAt }`. Broadcast on connect/disconnect,
  pair, rename, revoke, and on client attach.
- New auth/pairing frames listed above (`pair`/`paired`/`pairRejected`/`hello`/`helloOk`/
  `helloRejected`).
- Spawn/resume control messages need **no** target field — they are routed by *which socket the
  server sends them on*. The server sets `sessions.machine_id` when it picks the target.

## Server: registry & routing (`apps/server/src/relay.ts`)

The single `daemonSend` becomes a registry:

```
private daemons = new Map<machineId, DaemonConn>   // { send, hostname, name, connectedAt }
```

- **Attach/detach** are per machine. `attachDaemon` now takes the authenticated `machineId`.
  A second socket for the same `machineId` (reconnect) replaces the old entry.
- **`toDaemon(machineId, msg)`** replaces the global send. Per-machine pending queues hold
  messages for a momentarily-disconnected daemon; a message for an *unknown* machine errors
  loudly (surfaced to the client) instead of silently queueing forever.
- **Spawn/resume** resolve a target `machineId` (chosen by the web, validated server-side: the
  machine must be online and must have the repo) and route there; the new session row records it.
- **Per-session control** (input, resize, redraw, kill, reattach, transcript read) routes to
  `session.machineId`'s daemon.
- **Disconnect** marks only *that machine's* live sessions `reconnecting` (today a single
  detach blanks every session). Reconnect by `machineId` re-attaches and re-tails transcripts,
  reusing the existing `seedBootState` / `tailResumeTranscript` resume path.
- **`hostMetrics` and the hibernation cooldown** become per-machine maps, closing the
  `relay.ts:408-412` TODO — each machine has its own memory budget and cooldown.

## Web UI (`apps/web`)

### Store

- `machines: MachineWire[]` and `hostMetrics` re-keyed by `machineId` (the existing
  `HostIndicators` switch from hostname to machineId is mechanical).
- A derived helper `machinesForRepo(originUrl)` → machines that have the repo (with that
  machine's local path), and `lastUsedMachine` = the machine of the most recently *created*
  session (derived from session `createdAt`, server-side or in the store).

### New-agent dropdown (`NewPanelMenu.tsx`)

**One machine → today's menu, unchanged.** Single-machine users see no difference.

**More than one machine**, top to bottom:

1. **Agent options** — New Claude / Codex / Grok / Shell, exactly as today. Clicking one opens on
   the **most-recently-used machine that has this repo** (`lastUsedMachine` filtered to
   `machinesForRepo`; if the MRU machine lacks the repo, the next-most-recent that has it; there
   is always at least the owning machine). cwd = that machine's local path for the repo.
2. **Machines** section — one row per machine. A machine that does **not** have the current repo
   is **disabled and grayed**, with a hover tooltip (`<name> doesn't have this repo`). An enabled
   machine opens a **submenu** repeating the agent options **plus that machine's own resume
   convos**; choosing an option opens the agent on *that* machine (cwd = its local path).
3. **Resume convos** — the existing recency-first mini-search, scoped to the current repo across
   machines (each hit already knows its machine, so resume routes correctly).

The "default quick action = most-recently-used machine" requirement is satisfied by (1): the
plain agent options *are* the quick path and target the MRU-with-repo machine; the Machines
section is the explicit override.

### Workspace / home — merge by repo

The same git repo discovered on multiple machines collapses into **one** workspace/home entry
(deduped by normalized origin), instead of one entry per machine. The machine is chosen at
agent-open time via the dropdown above. A repo present on only one machine appears once (only
that machine enabled). Worktrees nest under their merged repo as today; a worktree belongs to the
machine that reported it. (`reposToViews` / `derive.ts` gain a merge-by-origin pass; `WorktreeView`
carries `machineId` + per-machine path.)

### Surfacing machine on a session

When (and only when) more than one machine is connected, a subtle **machine badge** appears on the
session — in the chat/terminal header and in FleetView — showing `machineName`. With one machine
it is hidden, so the common case stays clean. The badge is read-only.

### Settings → Machines (full panel)

A new settings panel lists every machine: **name, hostname, online/offline, last seen**. Actions:

- **Add machine** → mint a pairing code (shown with copy button + the daemon command to run).
- **Rename** → inline edit of `name`.
- **Revoke / remove** → delete the machine (and its token); its sessions show as orphaned until
  it re-pairs. Confirm first.

## Daemon (`apps/daemon`)

- On startup, load `~/.podium/daemon.json`. If a token exists → `hello`. If not and a pairing code
  is supplied (CLI flag / prompt) → `pair`, then persist the returned token + machineId.
- New small module `apps/daemon/src/identity.ts` — read/write `daemon.json`, generate the
  `machineId` once, hold the token.
- CLI: `podium-daemon --server <url>` connects with the stored identity; `--pair <code>` redeems
  a pairing code. The in-process bootstrap path (`scripts/host.ts`) passes the trusted bootstrap
  token so localhost needs no code.
- Discovery (conversations, repos, metrics) is unchanged except it no longer self-labels by
  hostname — the server attributes by socket identity. Repo scan additionally reports
  `originUrl` per repo so the server can populate `repos.origin_url`.

## Error handling & edge cases

- **Spawn targets an offline/unknown machine** → server rejects with a clear error; the web
  disables offline machines in the dropdown so this is hard to hit.
- **Repo present on no online machine** → its agent options are disabled (can't run it anywhere
  right now); tooltip explains.
- **Token mismatch / revoked machine** → `helloRejected`; daemon stops and instructs the user to
  re-pair.
- **Duplicate `machineId`** (cloned config) → last writer wins on the socket; this is a misuse
  case, documented, not specially handled.
- **`machineId` is the join key, never hostname** — two machines may share a hostname; renames and
  re-images don't orphan sessions.
- **Back-compat**: existing single-daemon installs migrate cleanly — the v4 migration stamps all
  existing sessions/repos/conversations with `'__local__'`, and the first bootstrap daemon to
  register rewrites that placeholder to its real `machineId` (see Data model).

## Components touched

| Area | Files |
|------|-------|
| Identity, pairing frames, MachineWire, SessionMeta fields | `@podium/protocol/src/messages.ts` |
| Origin-URL normalizer (pure, tested) | `@podium/core` |
| `machines` table, v4 migration, machine-scoped repos/conversations/sessions | `apps/server/src/store.ts` |
| Daemon registry, routing, per-machine attach/detach/metrics/cooldown, pairing | `apps/server/src/relay.ts`, `server.ts` |
| tRPC: machines list / rename / revoke / mint-pairing-code | `apps/server/src/router.ts` |
| Daemon identity file, hello/pair, repo origin reporting | `apps/daemon/src/daemon.ts`, new `apps/daemon/src/identity.ts` |
| Machines store + onMachinesChanged | `packages/terminal-client`, `apps/web/src/store.tsx` |
| Machine-aware dropdown | `apps/web/src/NewPanelMenu.tsx` |
| Merge-by-repo | `apps/web/src/derive.ts`, `types.ts` |
| Machine badge | session/chat header, FleetView |
| Settings → Machines panel | `apps/web` settings views |

## Testing

- **Unit**: origin-URL normalizer (scp/https/`.git`/case variants); v4 migration (round-trips
  v3 data, tags it with the local machine, re-keys repos); pairing-code lifecycle (mint → redeem →
  single-use → expiry); token hello accept/reject.
- **Server**: two fake daemon sockets → spawn routes to the chosen machine; input/kill route to the
  owning daemon; one daemon disconnect only marks *its* sessions reconnecting; reconnect re-attaches.
- **Web**: dropdown with 2 machines — options target MRU-with-repo; machine lacking repo is
  disabled with tooltip; submenu opens on the chosen machine; merge-by-repo collapses duplicates.
- **E2E** (Playwright harness, per memory): pair a second fake daemon, open an agent on it, drive
  it, confirm the badge shows its name.

## Rollout / staging

One spec, but implementable in reviewable stages: (1) identity + DB + protocol + registry/routing
(no UI), proven with the existing single daemon still green; (2) pairing + Settings → Machines;
(3) dropdown + merge-by-repo + badge; (4) E2E with a second daemon. Each stage keeps the
single-machine experience byte-for-byte unchanged.
