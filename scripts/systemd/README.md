# Podium systemd units

These files are generated copies of the renderer in `apps/cli/src/cli-systemd.ts`. The development
profile runs the installed bundle and points its publisher at the checkout; it does not execute the
server or parent from TypeScript source. Render it after the one-time initial bundle install:

```sh
bun --conditions=@podium/source scripts/render-systemd.ts --profile dev
cp scripts/systemd/podium.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now podium.service
systemctl --user status podium | grep -iE 'active|watchdog'
```

Topology: **one** user unit, `podium.service`. It runs the thin parent
(`podium parent --takeover`), which spawns the server and daemon as OS
children and hosts the janitor as a server worker. Type=notify + WatchdogSec
covers a wedged parent; Restart=always is the crash-and-boot net. Interactive
CPU/IO tiers stay on this unit; batch work still runs in transient scopes.

Existing 3-unit (or 8-definition) installs converge here on every boot: leftover
units stay armed until the parent reports healthy, then they are stopped,
disabled, and removed. Re-running reconciliation is a no-op.

HTTPS (the primary URL) is served by **`tailscale serve`**, which terminates TLS
on **:55555** and proxies straight to the installed server on **:18787** —
tailnet-internal (not Funnel), with auto-renewing certs:

```sh
tailscale serve --bg --https=55555 http://127.0.0.1:18787
tailscale serve status   # expect: https://<host>:55555 -> http://127.0.0.1:18787
```

For hot-reload UI work **beside** this live path (source Vite, updater off), see
[`docs/iteration-mode.md`](../../docs/iteration-mode.md) (`bun run iterate`).

The dev profile defaults to this host’s `/home/user/src/other/podium` checkout. Its service starts
`~/.local/bin/podium`, while `PODIUM_DEV_SOURCE_ROOT` names that checkout solely as build input.
Production units contain no publisher source root. The first source-to-installed cutover is a
one-time supervised migration. Follow the tested
[source-to-installed development cutover](../../docs/agents/source-to-installed-cutover.md);
after that, every accepted dev release uses the ordinary verified swap, handover, health gate, and
rollback. Pass `--output` and render with a named instance when the host runs a separate instance.
