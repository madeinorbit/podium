# Installing Podium & adding machines

Podium runs as a coordinating **server** plus one or more per-machine **daemons**. The
daemon wraps the agent CLIs (`claude`, `codex`) over a PTY on the machine it runs on, and
dials the server over a WebSocket. One install can be both at once (`all-in-one`), or you
can run a lightweight daemon on a VPS that joins an existing server.

This guide covers installing a fresh instance, making it reachable without a domain, and
joining extra machines to it.

## Install a new instance

One line, no build toolchain — it downloads the prebuilt `linux-x64` headless bundle,
verifies its signature, and installs to `~/.local/share/podium` with a `podium` symlink in
`~/.local/bin`:

```bash
curl -fsSL https://github.com/madeinorbit/podium/releases/latest/download/install.sh | sh
```

When it finishes it prints `Done. Run: podium`. Then start it:

```bash
podium
```

With no config yet, `podium` immediately runs in `all-in-one` mode (server + daemon in one
process) on port **18787** and prints a setup URL. You have two ways to finish setup:

- **Web setup** — open the printed URL (`http://localhost:18787/`) in a browser and walk
  through the networking step in the UI.
- **Terminal setup** — run `podium setup` to do the same networking step interactively in
  the terminal (handy on a headless box with no browser). On a TTY this runs the prompt
  flow; otherwise it falls back to printing the web URL.

> The installed binary is `linux-x64` only for now. On other platforms, build from source
> (see `../CONTRIBUTING.md`).

## Make it reachable (no domain needed)

Setup asks how this instance should be reachable. All options give you an encrypted
`https://` URL without owning a domain. The web UI and `podium setup` offer the same four
choices; pick one, run the command it shows, then paste back the resulting URL.

| Option | Command | Reach | Notes |
|--------|---------|-------|-------|
| **Tailscale Funnel** (public, recommended) | `tailscale funnel 18787` | Anywhere on the internet | Real cert, no domain. Funnel uses ports **443 / 8443 / 10000** and must be **enabled in your tailnet ACL**. |
| **Tailscale Serve** (private) | `tailscale serve 18787` | Only devices on your tailnet | Tailnet-only; nothing is exposed publicly. |
| **Cloudflare quick tunnel** | `cloudflared tunnel --url http://localhost:18787` | Anywhere on the internet | Instant public URL, no account. **The URL changes on every restart** — demo-grade. |
| **Manual reverse proxy** | _(your own Caddy/nginx/etc.)_ | Wherever you proxy it | Paste the `https://` URL your proxy serves. |

Replace `18787` with your port if you changed it (`port` in `~/.podium/config.json`).

After you paste the URL, setup saves it as `publicUrl` in `~/.podium/config.json` and asks
you to restart `podium` to apply.

### Why the tunnel only needs to reach the server

The **daemon dials out to the server** over the tailnet (or your tunnel) — the connection is
daemon → server, not the other way around. So a VPS that runs only a daemon needs **outbound**
reachability to the server's URL; it never has to be publicly reachable itself. With
Tailscale, both machines are on the same tailnet and the daemon↔server traffic rides that
encrypted link directly, even when the public Funnel URL is only used by your browser.

## Add a machine to an existing server

Once the first instance has finished setup (it has a `publicUrl`), pairing a second machine
is a single copy-paste — you never type a URL, a `--server`, or a `--pair` flag by hand.

1. In the web UI go to **Settings → Machines → Add machine**. This mints a one-time pairing
   code and shows a ready-to-run command.
2. Copy the one line. It looks like:

   ```bash
   curl -fsSL https://github.com/madeinorbit/podium/releases/latest/download/install.sh | sh -s -- --join <TOKEN>
   ```

   The `<TOKEN>` embeds the server's URL plus the fresh pairing code, so one paste does
   everything.
3. Paste it on the new machine (e.g. your VPS over SSH).

The installer downloads the bundle, then in `--join` mode it:

- runs `podium join-config <TOKEN>` to write a `daemon`-mode config (`serverUrl` + `pairCode`)
  to `~/.podium/config.json`,
- installs a **systemd `--user`** unit at `~/.config/systemd/user/podium-daemon.service`,
- enables lingering and starts it (`systemctl --user enable --now podium-daemon`).

The new machine then shows up under **Settings → Machines**. The pairing code is single-use
and expires after ~10 minutes; click **New code** for a fresh one if it lapses.

> **"Finish setup to get a one-line join command."** If the Add-machine dialog shows only a
> pairing code and this message, the server hasn't completed its networking step yet — there's
> no `publicUrl` to embed. Finish setup on the server first.

> **Repos live per machine.** Each daemon wraps agents against its own filesystem, so a
> repository must already exist on the machine whose daemon will open sessions in it. Joining
> a machine pairs it; it does not copy your repos across hosts.

## Update channels

`podium update` self-updates the headless bundle in place (download → verify signature →
atomic swap → "restart podium to apply"). It follows the `updateChannel` in
`~/.podium/config.json`:

- **`stable`** (default) — tracks the `latest` GitHub release.
- **`edge`** — tracks the rolling `edge` prerelease.

Switch channels by setting `updateChannel` in `~/.podium/config.json`, or install the edge
channel directly:

```bash
curl -fsSL https://github.com/madeinorbit/podium/releases/latest/download/install.sh | sh -s -- --channel edge
```

(The `PODIUM_UPDATE_CHANNEL` env var overrides the config for a single `podium update` run.)

## Desktop app auto-update

The bundled **desktop** app (Tauri) uses the same persisted `updateChannel`: stable reads the
latest stable manifest and edge reads the rolling edge manifest. Release builds check and apply
updates on their own. Debug/`tauri dev` builds do not use the production updater. Desktop
artifacts are promoted explicitly rather than built on every push; see
[Desktop releases](desktop-releases.md).

## Running the daemon as a system service (`--system`)

The installer's `--join` flow uses a per-user systemd unit, which is the right default. If
you instead want a **system-wide** daemon (running as a dedicated `podium` user, started at
boot regardless of login), use the template at
[`../scripts/systemd/podium-daemon-system.service`](../scripts/systemd/podium-daemon-system.service):

```bash
sudo cp scripts/systemd/podium-daemon-system.service /etc/systemd/system/podium-daemon.service
sudo systemctl enable --now podium-daemon
```

It expects a `podium` binary on `PATH` (the unit's `ExecStart` is `/usr/local/bin/podium daemon`)
and a writable `PODIUM_STATE_DIR` (the template sets `/var/lib/podium`, owned by the `User=podium`).
Run `podium join-config <TOKEN>` as that user first so the daemon has its config.

## Troubleshooting

- **`podium: command not found` after install.** The binary symlinks into `~/.local/bin`,
  which may not be on your `PATH` (the installer prints `Note: add ~/.local/bin to your PATH`
  when this is the case). Add it: `export PATH="$HOME/.local/bin:$PATH"` (and persist it in
  your shell profile).
- **Install fails at signature verification / `openssl` missing.** The installer verifies the
  bundle's Ed25519 signature with `openssl pkeyutl`. If `openssl` isn't installed the verify
  step fails and nothing is written — install it (`apt install openssl`, `dnf install openssl`,
  etc.) and re-run.
- **No systemd on the box.** In `--join` mode the installer prints
  `No systemd here. Start the daemon with: podium daemon`. Run `podium daemon` directly (e.g.
  under your own supervisor, or in a `tmux`/`screen` session).
- **Daemon can't reach the server.** A daemon dials the server's URL over the tailnet. If the
  server's port isn't reachable on the tailnet interface, either bind the server to the tailnet
  address (or `0.0.0.0`), or put the server's `/daemon` WebSocket behind your reverse proxy so
  the daemon's `wss://…/daemon` URL resolves.
</content>
</invoke>
