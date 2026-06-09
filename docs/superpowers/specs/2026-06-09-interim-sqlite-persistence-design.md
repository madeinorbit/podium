# Interim SQLite Persistence + tmux-backed Session Survival — Design

- **Date:** 2026-06-09
- **Status:** Approved (design) → ready for implementation plan
- **Scope:** Make **repos** and **work panels (sessions)** survive a backend restart
  (`tsx watch` reload, systemd restart, reboot) — the explicit non-goal *"registry persistence
  across server restarts"* of `2026-06-03-multiple-sessions-design.md` §12. Two coupled pieces:
  **(1)** a durable server-side **SQLite** store for repos + a `sessions` registry, and
  **(2)** running each agent inside its **own tmux server** so the agent process *outlives the
  daemon* and the daemon re-binds to the live PTY on boot. The session model is built
  **hibernation-ready** (an explicit `live | hibernated | exited` lifecycle carrying a resume
  ref) so a future idle-shutdown policy needs no new storage. Single-daemon, localhost-only,
  as today.

---

## 1. Goal

After a backend restart, **nothing is lost and we re-attach to Podium**:

- The **repo list** and the **work-panel list** are intact — durable in SQLite, not memory.
- **Live agents survive** the restart (each runs in a per-session tmux server). On boot the
  daemon re-attaches a fresh PTY to the still-running tmux session and re-binds; clients
  reconnect and see the live terminal, with the current screen repainted.
- A panel whose process *did* die (the whole box rebooted, tmux gone) reloads as `exited` and
  is **re-resumable** via the existing `--resume <conversationId>` path.
- A user can **`tmux -L podium-<id> attach`** to any session from a plain shell, outside Podium;
  Podium surfaces the command.
- **User→agent input fidelity is provably unchanged** by the tmux hop (its own acceptance gate —
  see §10).

This is the **interim** server-side store the persistence-direction evaluation reserved before
any RxDB/client-side/SaaS-sync tier. It is deliberately small, single-writer, and local.

---

## 2. Decisions (the forks that shaped this design)

| Fork | Decision | Why |
|------|----------|-----|
| What "reattach" must deliver | **Keep agents alive across restart**, not just restore a list | The user's product bar: come back to a running agent, not a re-spawn. Restore-only is the *fallback* when the process truly died. |
| Process-survival mechanism | **tmux, one server per session** (`tmux -L podium-<id>`) | Only option that gives *usable* outside-attach (tmux is ~1,680× more installed than abduco — measured via Homebrew/Debian popcon) **and** failure isolation (no shared-fate OOM) **and** free current-screen restore on attach. |
| Why per-session servers (not one shared) | **One tmux server per session** | A single shared server is shared-fate: one OOM kill drops every pane (the crash the user hit). Per-session servers isolate failures; each server is ~2–3 MB, negligible next to the agents. |
| Durable store | **SQLite via `node:sqlite`** (built-in, Node ≥22.5, synchronous) | Zero new native deps — `node-pty` stays the only native addon; fits the single-binary self-host ethos. Sync writes are fine at session-lifecycle frequency. Fallback: `better-sqlite3` if the experimental flag is unacceptable. |
| Repo storage | **Move repos from `repos.json` into SQLite**, one-time import | One durable store, one backup unit, consistent with sessions. The JSON file is imported on first boot and then ignored. |
| Session id | **Durable id (`crypto.randomUUID()`), persisted** | Today's in-memory counter (`s0`, `s1`) resets each restart → ids collide and aren't stable tmux handles. A stable id (Node's built-in `crypto.randomUUID()`, no dep) is the join key across DB ⇄ tmux ⇄ clients. |
| Memory pressure | **Solved by future hibernation, not by the supervisor** | The agents are the heavy thing and cost the same under any supervisor. The real lever is killing idle agents; this design lays the substrate (`hibernated` status + resume ref) without building the policy. |
| Scrollback on reattach | **Current screen only** (free via tmux repaint-on-attach) | Above-the-fold history replay is a separate seq/ring-buffer concern (per the persistence-direction note); out of scope here. |
| tmux absent | **Graceful degradation** to today's ephemeral node-pty spawn + a diagnostic | Dev without tmux must still work; survival is simply unavailable there. |

---

## 3. Architecture & process topology

Placement follows `ARCHITECTURE.md` — note the table already lists *"PTY/tmux spawn, attach,
resize, kill"* under `@podium/agent-bridge` and *"persistence"* under `apps/server`.

```
 apps/daemon (Node, tsx)                 apps/server (Node, Hono)                 ~/.podium/
 ┌─────────────────────────┐    WS       ┌────────────────────────────┐          ┌─────────────┐
 │ Map<sessionId, bridge>  │◄──────────►│ SessionRegistry (cache)     │◄────────►│ podium.db   │
 │  @podium/agent-bridge   │  protocol   │   write-through to store    │  sqlite  │  repos      │
 │  tmux -L podium-<id>:    │  (routed    │ ──────────────────────────  │ (node:   │  sessions   │
 │   new-session/attach/    │   by        │ SessionStore (node:sqlite)  │  sqlite) │  meta       │
 │   has-session/kill       │   session)  │   repos + sessions + meta   │          └─────────────┘
 │  on connect: reconcile   │             │ on boot: load rows → reg.   │
 └─────────────────────────┘             └────────────────────────────┘
        │ node-pty attaches to                         ▲ WS (multiplexed, sessionId-routed)
        │ `tmux -L podium-<id> attach`                 ▼
        ▼                                       apps/web (clients auto-reconnect → re-attach)
   [ tmux server podium-<id> ]  ── holds ──►  [ agent process: claude / codex ]
   (outlives the daemon)
```

- **`apps/server`** gains a **`SessionStore`** (SQLite). `RepoRegistry` folds into it (same
  public surface; storage swapped JSON→SQLite + import). `SessionRegistry` becomes a
  **write-through cache** over `SessionStore`: it stays the in-memory routing/relay object, but
  every lifecycle mutation also writes the row, and on boot it **loads** rows.
- **`@podium/agent-bridge`** gains a **tmux-backed `AgentSession`** implementing the *same*
  `AgentSession` interface, plus helpers `tmuxHasSession(label)`, `killTmuxServer(label)`,
  `tmuxConfigArgs()`. The daemon's per-bridge wiring barely changes.
- **`apps/daemon`** gains a **reconcile step** on WS connect: for each session the server says
  should be live, check `has-session` and re-attach, else report it dead.
- **`@podium/protocol`** gains two additive messages + a status value (§5).

The substance stays in the two packages; the apps stay thin.

---

## 4. Data model (`node:sqlite`)

DB file: `$PODIUM_STATE_DIR/podium.db`, else `~/.podium/podium.db` (reusing the
`repo-registry` env convention). `journal_mode=WAL`, single writer (the server).

```sql
CREATE TABLE repos (
  path      TEXT PRIMARY KEY,
  added_at  TEXT NOT NULL              -- ISO 8601
);

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,     -- durable, uuid-ish; survives restart
  agent_kind      TEXT NOT NULL,        -- 'claude-code' | 'codex' | 'shell'
  cwd             TEXT NOT NULL,
  title           TEXT NOT NULL,
  origin_kind     TEXT NOT NULL,        -- 'spawn' | 'resume'
  conversation_id TEXT,                 -- resume conversationId (origin=resume) / for re-resume
  resume_kind     TEXT,                 -- ResumeRef.kind  (nullable)
  resume_value    TEXT,                 -- ResumeRef.value (nullable)
  status          TEXT NOT NULL,        -- 'starting' | 'live' | 'hibernated' | 'exited'
  exit_code       INTEGER,              -- present when status='exited'
  tmux_label      TEXT NOT NULL,        -- 'podium-<id>'
  created_at      TEXT NOT NULL,        -- ISO 8601
  last_active_at  TEXT NOT NULL         -- ISO 8601; updated on bind/input/title
);

CREATE TABLE meta ( key TEXT PRIMARY KEY, value TEXT NOT NULL );  -- schema_version, etc.
```

`SessionStore` API (synchronous): `loadRepos()/addRepo()/removeRepo()`,
`loadSessions()/upsertSession(row)/setStatus(id,status,exitCode?)/touch(id)/deleteSession(id)`,
plus `migrate()` (creates tables, sets `schema_version`, imports `repos.json` if present and
the `repos` table is empty, then leaves the JSON file untouched).

---

## 5. Protocol additions (`@podium/protocol`)

Additive to the existing discriminated unions; all current messages are unchanged.

- **server → daemon:** `reattach { sessionId, tmuxLabel, geometry }` — "re-bind to this
  already-running tmux session."
- **daemon → server:** `reattachFailed { sessionId, reason }` — the tmux session is gone;
  success simply reuses the existing **`bind`** message.
- **`SessionStatus`** gains **`hibernated`**. A transient server-side **`reconnecting`** marks a
  loaded-but-not-yet-rebound session; it is collapsed to `live`/`exited` once the daemon answers
  (kept off the wire unless the switcher wants to show a "reconnecting…" pip — decided in impl).

`SessionMeta` keeps its current shape on the wire; `tmux_label` is a server-internal join key
(Podium surfaces the human attach command from it, but it need not ride in `SessionMeta` unless
the UI wants to show it).

---

## 6. Lifecycle & flows

### 6.1 Spawn
1. `router.sessions.create/resume` → `SessionRegistry.spawn`: mint a **durable id**
   (`crypto.randomUUID()`), set
   `tmux_label = podium-<id>`, **`upsertSession`** (status `starting`).
2. server → daemon **`spawn`** (unchanged shape).
3. daemon: `tmux -L podium-<id> new-session -d -s main -- <agentLaunchCommand…>`, apply tmux
   config (§7), then a **node-pty attaches** `tmux -L podium-<id> attach`. Wire
   `onFrame→agentFrame`, `onTitle→title`, `onExit→agentExit` as today. Reply **`bind`**.
4. server marks `live`, `touch`es the row, broadcasts `sessionsChanged`.

### 6.2 Kill
daemon detaches the node-pty and runs `tmux -L podium-<id> kill-server`; server
`deleteSession(id)` (hard kill) and broadcasts. (A future hibernate sets `hibernated` instead of
deleting — see §6.5.)

### 6.3 Boot reconcile (the headline)
1. server starts → `SessionStore.loadSessions()` into `SessionRegistry`; previously-`live` (or
   mid-spawn `starting`) rows become `reconnecting`, so a server crash between `spawn` and
   `bind` still gets reconciled rather than orphaning a tmux server.
2. daemon connects (WS). For each `reconnecting` row, server → daemon **`reattach{sessionId,
   tmuxLabel,geometry}`**.
3. daemon: `tmux -L podium-<id> has-session`?
   - **yes** → node-pty attaches `tmux attach` → **`bind`** → server marks `live`. The agent was
     never killed, so the conversation is intact; tmux **repaints the current screen** on attach.
   - **no** → **`reattachFailed`** → server marks `exited` (recoverable via §6.4).
4. clients (already auto-reconnecting per `apps/web`) receive `sessionsChanged` and re-`attach`;
   the existing attach path repaints.

### 6.4 Re-resume an exited panel
For an `exited` row with a `conversation_id`/resume ref, the existing `sessions.resume` flow
re-spawns the agent with `--resume` (reusing the same durable id + `tmux_label`). This is the
"box rebooted, process is gone, but I can pick the conversation back up" path.

### 6.5 Hibernation-ready (future — NOT built here)
An idle policy would `kill-server` the agent but set `status='hibernated'` (keep the row +
resume ref). Waking = the §6.4 resume from `conversation_id`, reusing the id/label. No new
storage, no schema change.

---

## 7. tmux integration & input fidelity

The daemon spawns the agent **inside** a per-session tmux server and attaches a node-pty to a
tmux *client* (`attach`). This adds a hop (`node-pty → tmux → agent`), so the integration is
defined by the config that keeps that hop transparent.

**Title preservation (the worker-name feature, `9c514c1`).** tmux captures the agent's OSC
title into `pane_title`. To keep the existing `createTitleScanner` working **unmodified**, set
`set -g set-titles on` + `set -g set-titles-string '#{pane_title}'` so tmux **re-emits an OSC
title** on the attached client stream whenever the agent changes it. Fallback if that
misbehaves: a `pane-title-changed` hook → `run-shell` that pokes the daemon, or poll
`display-message -p '#{pane_title}'`.

**Input passthrough (transparency for user→agent keystrokes).** Per-session tmux config:
- `set -g prefix None` + `unbind-key -a` (or at least `unbind C-b`) — tmux intercepts **no**
  key; Podium drives tmux via the CLI, never a prefix.
- `set -sg escape-time 0` — **essential**; nonzero escape-time delays/breaks ESC-prefixed
  (Alt/Meta) sequences — the same root-cause family as the `macOptionIsMeta:false` fix
  (`54e16bf`).
- `set -g extended-keys on` + `set -g xterm-keys on` — correct modifier encoding (CSI-u /
  modifyOtherKeys) reaches the agent.
- `set -g allow-passthrough on` — agents may emit raw escape sequences without tmux filtering.
- `set -g status off`, mouse off — no status row stealing geometry, no mouse capture.
- `default-terminal "tmux-256color"` + RGB `terminal-overrides` — preserve truecolor (the
  reason `COLORTERM=truecolor` is set in `spawnAgent`).

**Geometry / redraw.** tmux owns the pane size; the existing one-row redraw nudge now passes
through tmux's resize handling. Validate it still forces a repaint; if needed, set
`window-size manual` / `aggressive-resize off` so the daemon's controller geometry is
authoritative (spectators letterbox, as today).

---

## 8. Error handling

- **DB missing/corrupt** → log + start empty (matches today's `RepoRegistry` resilience). WAL
  mode; single writer (server) ⇒ no contention.
- **tmux absent on PATH** → daemon detects at startup and **degrades** to today's ephemeral
  node-pty `spawnAgent` (no survival), emitting a diagnostic so the UI can note "sessions won't
  survive restart." Everything else works.
- **`reattach` to a dead/zombie tmux** → `has-session` fails → `reattachFailed` → `exited`.
- **Orphan tmux servers** (a `podium-<id>` server with no DB row, e.g. DB wiped) → left
  untouched and logged; reconcile only re-binds rows it knows. (Adoption is a future nicety.)
- **Spawn under tmux fails** → existing `spawnError` path surfaces it to the list as a status,
  not a silent hang.

---

## 9. Build phases (3 layers, each independently testable / shippable)

1. **SQLite store + durable ids + repos migration.** `SessionStore` (`node:sqlite`), fold
   `RepoRegistry` into it with `repos.json` import, switch session ids to durable, make
   `SessionRegistry` write-through, load on boot. *Behaviorally same as today, but the repo +
   panel lists now survive a process restart — sessions reload as re-resumable `exited` rows
   even before tmux exists.* Immediate value, no tmux dependency.
2. **tmux-backed `AgentSession` + daemon spawns under tmux + title preservation + no-tmux
   fallback.** Now live agents survive a restart and `tmux -L podium-<id> attach` works from a
   shell. The §7 config lands here.
3. **Boot reconcile protocol + flow.** `reattach`/`reattachFailed` messages, server boot-load →
   `reconnecting` → daemon `has-session` → re-bind survivors / mark dead; clients see live
   terminals after a backend restart. The headline capability.

---

## 10. Testing

Extends the existing tiers; assertions stay on structured state, not pixels.

- **Store (unit, vitest):** temp-file `node:sqlite` — repos CRUD, sessions CRUD, `migrate()`
  incl. `repos.json` import (and idempotency), `schema_version`.
- **Registry (unit):** write-through (every mutation persists), boot-load reconstructs the
  registry, reconcile state machine against a **fake daemon link** (`reattach`→`bind` ⇒ live;
  `reattach`→`reattachFailed` ⇒ exited).
- **agent-bridge tmux (unit + integration):** command-construction unit tests (label, config
  args, attach args — no real tmux); an integration test that spawns the existing
  `test/fixtures/fixture-tui.mjs` under a real tmux, `describe.skipIf(!hasTmux)`, asserting
  frames flow, title re-emits, `kill-server` cleans up, and `has-session` reflects liveness.
- **Boot-reconcile integration:** spawn a fixture under tmux → build a *new* `SessionRegistry`
  over the *same* DB (simulated restart) → reconcile → assert frames flow again to a fresh
  attach (proving the process survived and re-bound).
- **Protocol:** zod round-trips for `reattach`, `reattachFailed`, and the `hibernated` status.

### 10.1 Input-fidelity acceptance gate (REQUIRED at the end)
The most important user↔agent functionality is keystroke delivery; the tmux hop must not
degrade it. This is an explicit gate, not a nice-to-have:
1. The existing **terminal-client keyboard-fidelity tests** (happy-dom key→bytes) still pass —
   necessary but *upstream* of tmux, so not sufficient alone.
2. A new **agent-bridge parity test**: write known input byte sequences — plain ASCII, `Ctrl-C`
   (`0x03`), **Alt/Meta** (`ESC`+char), arrow/function keys, **bracketed paste**, multi-byte
   UTF-8 — through the **tmux-attached** PTY and assert the fixture agent (which captures stdin)
   receives them **byte-for-byte and promptly**, and that the result is **identical to the
   direct node-pty path**. Parity is the pass condition.
3. A **manual dogfood**: type into a real agent under tmux — Alt/Option (the non-US-Mac case),
   Ctrl combos, paste — and confirm nothing is swallowed or delayed.

---

## 11. Non-goals (this increment)

- The **hibernation policy** itself (auto-shutting-down idle agents) — only the substrate.
- **Scrollback history replay** above the current screen (a separate seq/ring-buffer concern).
- **RxDB / client-side persistence / SaaS sync tier** — this is the server-side interim store
  reserved before that work.
- **Multiple daemons / multi-machine**; **auth / multi-user**; **remote (non-localhost)**
  exposure — unchanged from today.
- A **transcript/history view**; backpressure / binary frames; the polished command-center grid.

---

## 12. Risks / open questions

- **tmux input transparency** — the load-bearing risk; mitigated by the §7 config and gated by
  §10.1. If `prefix None` / `escape-time 0` / `extended-keys` don't achieve byte-parity, the
  whole tmux choice is reconsidered before shipping Layer 2.
- **Title re-emit via `set-titles`** — assumed to surface the agent's title to the existing
  scanner. Verified in the Layer-2 tmux integration test; the `pane-title-changed` hook is the
  fallback.
- **`node:sqlite` experimental flag** — emits an `ExperimentalWarning` on Node 22; acceptable
  for an interim store, but `better-sqlite3` is the drop-in fallback if undesirable.
- **Durable-id migration** — switching ids from the in-memory counter touches `spawn`/`bind`
  routing; the existing single-flow must adopt durable ids in Layer 1.
- **Per-session tmux server count** — N tiny (~2–3 MB) servers; fine for realistic N, but worth
  watching if a future fan-out creates many sessions per machine.
- **Geometry through tmux** — the redraw nudge and spectator letterboxing must still behave;
  validated in Layer 2 (`window-size manual` if needed).
