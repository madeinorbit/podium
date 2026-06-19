# Podium dev-host systemd units (podium-host)

The canonical copies of the user-level units that run Podium on the dev host.
Install with:

```sh
cp scripts/systemd/podium-*.{service,path} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now podium-server podium-daemon podium-web podium-redeploy.path
# verify the watchdog took: both should read "active (running)" with a Watchdog line
systemctl --user status podium-server podium-daemon | grep -iE 'active|watchdog'
```

Topology: `podium-web` (built PWA via `vite preview`) binds **:55556** (plain http) and
proxies `/trpc` + WebSockets to the **split backend** on :18787: `podium-server`
(coordinating relay + HTTP/tRPC + WebSockets) and `podium-daemon` (all per-agent PTY /
transcript / discovery / metrics work), which connects to the server over
`ws://localhost:18787/daemon` and reconnects with backoff. Splitting them is what stops
a misbehaving agent or a reattach storm from starving the relay loop. Both run from
source via `--conditions=@podium/source`. `podium-redeploy.path` watches `.git/logs/HEAD`
and restarts **all three** services when main moves.

Both backend units are `Type=notify` with `WatchdogSec=30`: they pet the systemd
watchdog from their event loop (`scripts/sd-notify.ts`), so a **wedged-but-alive**
process (the documented big-paste msg-loop wedge — `Restart=always` only fires on
EXIT) stops petting and systemd restarts it. The daemon especially needs this: it
exposes no HTTP `/health` surface, so the watchdog is the only thing that catches it.
If `systemctl --user status` ever shows a notify unit stuck `activating`, the
`systemd-notify READY=1` isn't landing — fall back to `Type=simple` (drop the
`Type`/`WatchdogSec`/`NotifyAccess` lines) until that's debugged; the sd-notify code
is a no-op without `NOTIFY_SOCKET`, so it's safe either way.

`podium-backend.service` is the legacy single-process unit (relay + daemon in one
`scripts/host.ts`), kept as a disabled fallback. Run EITHER the split pair OR the
combined backend — never both (they bind the same :18787).

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
