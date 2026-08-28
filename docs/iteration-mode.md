# Iteration mode

Hot-reload the web UI on the VPS against the **live installed** server, without
touching the installed app, `apps/web/dist`, or the updater.

This is the sanctioned divergence from the update path (updater-convergence
spec §7). Server code still iterates through a normal **dev release** — not this
command.

## Start

On the VPS checkout that has the UI changes:

```sh
bun run iterate
```

Requirements:

- The installed server is up (`systemctl --user start podium` if needed).
- This checkout has its own `node_modules` (`bun install` here — do not rely on a
  sibling checkout's dependencies).

The command is **foreground only**. Ctrl-C tears it down (including any
temporary Tailscale HTTPS mount it created). It is never auto-started.

Ctrl-C (`SIGINT`), `SIGTERM`, a terminal hangup (`SIGHUP` — closing the ssh
session is the ordinary way this ends on a VPS) and Ctrl-`\` (`SIGQUIT`) all
tear down. Those four are handled one by one, and nothing general stands behind
them: an exit handler does not run on a signal. So `SIGKILL`, or any signal not
in that list, leaves the session's two pieces on the box — and the scope matters
as much as the mount, because a scoped process survives its parent, keeping the
port so the next start on it refuses:

```sh
tailscale serve --https=55565 off              # the HTTPS mount, its port only
systemctl --user stop podium-iterate-55566.scope   # the dev server itself
```

## What you get

| Piece | Default | Notes |
| --- | --- | --- |
| Vite (source UI + HMR) | `:55566` | Bound `0.0.0.0` for network access |
| Optional Tailscale HTTPS | `:55565` → `:55566` | Own port; **never** retargets live `:55555` |
| Proxy target | live `:18787` | `/trpc`, `/auth`, `/client`, `/daemon`, … |
| CPU fencing | `podium-iterate-<port>.scope` | Batch tier — cannot starve the live server |

Open `http://<tailscale-host-or-ip>:55566` (or the HTTPS URL the command prints).
The page chrome shows **ITERATION MODE** so the tab cannot be mistaken for the
installed UI. The installed app keeps serving its built dist at
`https://<host>:55555`.

## Flags and env

```text
--no-tls                  skip the temporary Tailscale HTTPS mount
--web-port=N              plain HTTP Vite port (default 55566)
--backend-port=N          live server to proxy to (default 18787)
--tls-port=N              temporary Tailscale HTTPS port (default 55565)
--allow-host=NAME         extra Host Vite will accept (Tailnet DNS is added automatically)
```

Env equivalents: `PODIUM_ITERATE_WEB_PORT`, `PODIUM_ITERATE_BACKEND_PORT`,
`PODIUM_ITERATE_TLS_PORT`, `PODIUM_ITERATE_TLS=0`, `PODIUM_ALLOWED_HOSTS`.

## The updater is off in this tab

"Updater fully off" (spec §7) is enforced in the page, not just by omission:

- **No update engine.** `UpdatesProvider` does not mount it, so nothing polls and
  the panel chunk is never even fetched. Without this, an iterate tab would show
  a *real* offer — pressing it starts a real rollout across the fleet, from a
  page that is not the installed app and whose own changes are not in the release
  being rolled out. The panel also opens itself on a new situation, so every
  branch that touches the wire schema would greet you with a modal.
- **No hard reload.** The wire guard normally reloads twice to shake off a stale
  cached shell. In iteration mode it never does: the fresh bundle is the same
  source, so a reload cannot resolve the mismatch, and spending the budget would
  end in the wrong diagnosis ("the served build is stale") about the wrong build.

The installed app keeps its updater exactly as it was — this changes one tab.

## When the banner says the server was built from a different commit

That is the honest, common case: the installed server is running an older commit
than the branch you are iterating on, so the two disagree about the wire schema.
Repositories and worktrees still sync; **issues and agent sessions may sit at
`queued`**, because those frames cannot decode.

Nothing about iterate mode can fix that, and it is not meant to — server-side
changes iterate through a dev release (spec §8c decision 3). The remedy is to
bring the installed server up to a build whose protocol matches your branch:
accept the update the live UI is already offering, then reload the iterate tab.
UI-only work on a branch whose protocol matches the live server never sees this.

## Guardrails

- The spawn plan is `bun run dev` and nothing else; `assertNoBuildArgs` refuses a
  plan containing `build` / `build:*` / `preview`. It is an **edit-time
  tripwire** — it cannot fire today, and that is the point: it stops this
  command from ever being changed into one that writes the served bundle.
- Fingerprints **this checkout's** `apps/web/dist` around the session (path,
  size, content hash — not timestamps, which Bun cannot resolve finely enough).
  A worktree usually has no `dist` at all, and the command then says so rather
  than reporting "untouched" about a directory it never read. Note what this does
  and does not cover: the dist the installed server actually serves lives in its
  own install, which iterate never has a handle on — the real assurance there is
  that the command runs a dev server and never a build.
- Refuses to start without a local `node_modules`, so Vite can never resolve out
  of a sibling checkout and hot-reload code you are not editing.
- Publishes no release, so the updater offer path is untouched.
- Debug Tauri shells still refuse updates (`DebugBuild`) — that refusal *is*
  iteration mode for the shell. Point a client/debug window at the iterate URL
  if you want a native frame around the HMR UI.

## Not this command

| Want | Use |
| --- | --- |
| Local all-in-one source backend + Vite | `bun run host` (own state, not the VPS live instance) |
| Ship server / headless changes | Dev release via the update path |
| Change the UI everyone already sees | Approved update that rebuilds and swaps `apps/web/dist` |
