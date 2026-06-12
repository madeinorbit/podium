# Podium dev-host systemd units (podium-host)

The canonical copies of the user-level units that run Podium on the dev host.
Install with:

```sh
cp scripts/systemd/podium-*.{service,path} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now podium-backend podium-web podium-redeploy.path
```

Topology: `podium-web` (Vite dev server, the single public origin on :55555)
proxies `/trpc` + WebSockets to `podium-backend` (relay + daemon on :18787,
running from source via `--conditions=@podium/source`). `podium-redeploy.path`
watches `.git/logs/HEAD` and restarts **both** services when main moves.

Why the web restart is part of redeploy: a long-lived Vite dev server's module
graph goes stale across git-driven rewrites (observed twice: stale
`@podium/protocol` schemas silently dropping new message types, and a stale
`SocketHub` throwing `hub.onAttention is not a function` at boot). HMR is for
editor-paced edits, not merges.

The unit files hard-code `/home/user` paths — adjust when installing elsewhere.
