# POD-2245 — the operator test instance

> **STATUS: HANDED OVER (2026-08-17).** Both bugs this bring-up found are
> fixed on the tip and re-verified live here in one final pass at `62b2662a1`:
> isolation (all driver children in the instance home, real agent homes
> untouched) and teardown (stop/kill leave no process, scope, or journal).
> The instance was left running and CLEAN — no sessions, scopes, or journals.

**What this is.** A completely separate Podium instance running the new agent
runtime at epic tip `62b2662a1` (all four drivers + the POD-2086 fix wave +
the POD-2247 agent-home fix + the POD-2249 teardown fix),
left RUNNING so you can try the drivers by hand before anything merges. It is
POD-2086's isolation recipe re-cut at the current tip; that issue produced a
report, this one produces the instance.

**It cannot touch your live install.** Own state root, own SQLite, own ports,
own daemon, own vendored abduco, own socket dirs, own agent home with
credentials *copied* in. One isolation hole was found in the product while
building this (POD-2246 → POD-2247, fixed and re-verified; sharp edge 1).

---

## Where everything is

| | |
|---|---|
| Web UI / API | <http://127.0.0.1:19797> — password `operator` |
| Code under test | `/home/mgw/src/podium/.worktrees/pod-2245-operator` — DETACHED at `62b2662a1` (epic tip incl. the POD-2247 + POD-2249 fixes); agents landing on the epic branch cannot move it |
| State root | `/tmp/pod-op/state` (instance marker `instance.json: operator`) |
| Agent home | `/tmp/pod-op/state/agent-home` (copied credentials for all four harnesses) |
| Logs | `/tmp/pod-op/logs/server.log`, `/tmp/pod-op/logs/daemon.log` |
| Scratch repo for sessions | `/tmp/pod-op/repo` |
| Ports | 19797 (web/API), 46797 (hooks), 46798 (agent relay) |
| Bring-up / teardown / helpers | `docs/evidence/pod-2245/` — `op-up.sh`, `op-down.sh`, `op-env.sh`, `pd`, `st` |

The instance survives this chat. It does NOT survive a reboot (`/tmp`, and the
processes are detached, not systemd units — deliberate, so no `podium-operator-*`
units linger in your user manager). After a reboot: `bash docs/evidence/pod-2245/op-up.sh`.

## Driving it

**Web UI** — open <http://127.0.0.1:19797>, password `operator`.

**CLI** — `docs/evidence/pod-2245/pd <anything>` is this instance's own
`podium`, run from the pinned source with an env that cannot leak to your live
instance. Examples:

    docs/evidence/pod-2245/pd session read <id>
    docs/evidence/pod-2245/pd interactions list

**Spawn a session on a specific driver** — the per-spawn `runtimeContract`
field, unreachable in POD-2086 (F13), now works through the API and is carried
by `packages/client-core` (`spawn-agent.ts`). There is still no web-UI control
or `podium` CLI flag for it (F1 stands — `agent spawn` has no driver option),
so spawn by hand:

    curl -s -X POST http://127.0.0.1:19797/trpc/sessions.create \
      -b /tmp/pod-op/cookie-jar -H 'content-type: application/json' \
      -d '{"cwd":"/tmp/pod-op/repo","agentKind":"opencode","runtimeContract":"opencode-server"}'

| agentKind | runtimeContract | you get |
|---|---|---|
| `claude-code` | `true` | terminal driver on the contract path (`claude-pty`) |
| `claude-code` | *(omit)* | legacy path, no contract — the control group |
| `opencode` | `"opencode-server"` | `opencode serve` + HTTP/SSE |
| `codex` | `"codex-app-server"` | `codex app-server` |
| `grok` | `"grok-acp"` | `grok agent stdio` (ACP) |

A bogus driver id is refused loudly: the create returns a session that
immediately exits, and the server log says `spawn failed … unknown runtime
driver '<id>'` (verified here — in POD-2086 it silently produced a healthy
terminal session).

**Which driver actually drove a session** — no longer unknowable (F10 fixed,
POD-2119): `sessions.status` reports `driverId`. The `st` helper prints it:

    docs/evidence/pod-2245/st <session-id>
    # -> status=live phase=idle driverId=opencode-server

(`requestedDriverId` is also on the read surfaces; it is populated when a
driver preference was DEGRADED to something else, so `null` on a session that
got what it asked for is the good outcome, not a gap.)

## State at handoff

The final verification pass ran at `62b2662a1`: four sessions, one per driver,
each `driverId` confirmed (`claude-pty`, `opencode-server`, `codex-app-server`,
`grok-acp`), each answering a smoke turn with the transcript visible in
`sessions.read` — claude included. Teardown was then verified (stop parks with
the process gone; kill removes session, process, scope, journal) and the
sessions removed, so the instance is handed over EMPTY and running: spawn
fresh sessions as you like. Full command-by-command evidence:
`docs/evidence/pod-2245/isolation-verification.md`.

Verified isolation, on the running instance:

- Every driver child (abduco/claude, `opencode serve`, `codex app-server`,
  `grok agent stdio`) has `HOME=/tmp/pod-op/state/agent-home` — checked in
  `/proc/<pid>/environ`, not assumed.
- The live instance's `~/.podium` is held open only by the live server's pid;
  the operator instance's server/daemon never opened it.
- Terminal sessions' abduco masters live under `/tmp/pod-op/abduco` with
  instance-qualified labels (`podium-operator-<uuid>@flatblock`), invisible to
  your live `~/.abduco`.
- `bun install` on the pinned tip leaves the tree clean (F2 fixed), so the
  updater's source-identity check passes and the web UI shows no false
  "update failed" modal.

## What to expect from each driver (fix wave, verified live here)

- **opencode-server, codex-app-server, grok-acp**: turn delivered, answered,
  and — unlike POD-2086's F14 — **the conversation is visible in Podium's
  transcript**. All three ingested `user` + `assistant` items within seconds.
- **claude-pty (terminal)**: POD-2086's F6 window is still real on this build.
  A send issued shortly (~30 s) after spawn is acknowledged `delivered` and
  lost — `status: live` still precedes "composer actually accepts input".
  Give a fresh claude session a minute before the first send, or use the
  transcript to confirm the turn landed. Later sends behave.
- **opencode needs no `--version` shim** on an idle box (POD-2086 needed one
  under load ~95). The F3 fix (POD-2115) also means a timed-out probe is now
  `installed: null` + structured `probeError` rather than a false
  `installed: false`; not exercised here because nothing timed out.
- **codex**: the daemon logs `codex-version-unsupported` for `codex-cli
  0.147.0` and disables codex *hook automation*; the app-server driver itself
  works (turn round-tripped, `authMethod: chatgpt`).

## Sharp edges to keep in mind

1. **POD-2246 → POD-2247 (found during this bring-up): server drivers escaped
   the agent home — FIXED at `50a6e0dfd` and verified live here.** Driver
   children now receive the instance home explicitly (`ctx.homeDir`), proven
   with a decoy-HOME daemon (see the evidence doc). `op-up.sh` still starts
   the DAEMON under `HOME=/tmp/pod-op/state/agent-home`, no longer as a
   containment workaround but because DAEMON-side writes (grok hook installs
   at boot, opencode probe caches) follow the daemon's own `$HOME` and belong
   in the instance too. If you restart the daemon by hand, keep that HOME.
2. **`pd status` says everything is down.** It is not — the daemon was started
   detached via `nohup`, so it never registered in the run-registry that
   `status` reads (same non-finding as POD-2086). Trust `/health`, the logs,
   and `st`.
3. **Scope names for server drivers are not instance-qualified**
   (`podium-oc-<uuid>`, `podium-cx-…`, `podium-gk-…`) — `systemctl --user`
   listings mix this instance's scopes with the live instance's. A scope is
   this instance's only if its uuid is a session here (e.g. appears under
   `/tmp/pod-op/state/*-servers/`). Terminal scopes ARE qualified
   (`podium-operator-<uuid>`).
4. **The credential copies are live credentials.** Agents can refresh their
   copy inside the agent home (harmless), but treat `/tmp/pod-op` as
   credential-bearing: it is `0700`, keep it that way. `op-down.sh --purge`
   deletes it all.
5. **F5 still stands**: the daemon does not scrub `CLAUDE_CODE_*` from its own
   environment before spawning claude children. `op-up.sh` scrubs before
   starting the daemon; if you start the daemon by hand from inside a Claude
   Code session, do the same or claude sessions will report `idle` forever.
6. **POD-2248 → POD-2249 (found while ending the smoke sessions): ending a
   server-driver session leaked its driver process — FIXED at `62b2662a1` and
   verified live here.** `sessions.stop` now parks the session `hibernated`
   with the process and scope torn down; `sessions.kill` removes session,
   process, scope, and journal (also from a hibernated session). If you ever
   suspect a leftover anyway, `systemctl --user list-units 'podium-oc-*'
   'podium-cx-*' 'podium-gk-*'` — mind edge 3 about which scopes are this
   instance's.

## Lifecycle

    bash docs/evidence/pod-2245/op-up.sh        # bring up (idempotent-ish: never clobbers creds/repo)
    bash docs/evidence/pod-2245/op-down.sh      # stop server+daemon, keep state; lists leftovers
    bash docs/evidence/pod-2245/op-down.sh --purge   # and delete /tmp/pod-op entirely

Sessions survive a daemon kill (durable abduco masters; the restarted daemon
re-adopts). To move the instance to a newer epic tip:
`git -C /home/mgw/src/podium/.worktrees/pod-2245-operator fetch && git -C … checkout <sha>`,
`bun install`, then `op-down.sh` + `op-up.sh`.
