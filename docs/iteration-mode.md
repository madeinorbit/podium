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

- The installed server is up (`systemctl --user start podium-server` if needed).
- This checkout has its own `node_modules` (`bun install` here — do not rely on a
  sibling checkout's dependencies).

The command is **foreground only**. Ctrl-C tears it down (including any
temporary Tailscale HTTPS mount it created). It is never auto-started.

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

## Guardrails

- Never runs `vite build` / `preview` — argv is refused if it would.
- Fingerprints `apps/web/dist` around the session and reports if bytes changed.
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
