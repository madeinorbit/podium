# Podium dev-host systemd units (podium-host)

The canonical copies of the user-level units that run Podium on the dev host.
Install with:

```sh
cp scripts/systemd/podium-*.{service,path} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now podium-backend podium-web podium-redeploy.path
```

Topology: `podium-web` (built PWA via `vite preview`) binds **:55556** (plain http) and
proxies `/trpc` + WebSockets to `podium-backend` (relay + daemon on :18787,
running from source via `--conditions=@podium/source`). `podium-redeploy.path`
watches `.git/logs/HEAD` and restarts **both** services when main moves.

HTTPS (the primary URL) is served by **`tailscale serve`**, which terminates TLS
on **:55555** and proxies to the Vite origin on :55556 — tailnet-internal (not
Funnel), with auto-renewing certs. The mobile clipboard/paste API needs a secure
context, which is why https is the primary origin; http://<host>:55556 stays as a
plain fallback. Set it up once (the config persists in tailscaled across reboots):

```sh
tailscale serve --bg --https=55555 http://127.0.0.1:55556
tailscale serve status   # expect: https://<host>:55555 -> http://127.0.0.1:55556
```

A separate public Funnel (e.g. another project on :443) is unaffected — this adds
a serve entry on its own port rather than touching existing mappings.

Why the web restart is part of redeploy: the web service `vite build`s the
content-hashed PWA bundle at start, so restarting it on a HEAD move is what
produces a new build (and the new build hash the in-app update prompt detects).
Note: the running app's service worker is the source of truth for installed
clients — they pick up the new build via the "New version — Reload" prompt.

The unit files hard-code `/home/user` paths — adjust when installing elsewhere.
