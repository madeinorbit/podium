# Installing Podium on a new VPS (while the repo is still private)

This walks the **normal new-user install** — the prebuilt `linux-x64` headless bundle,
signature-verified, installed to `~/.local/share/podium` — with the one workaround needed
while `madeinorbit/podium` is a private repo.

## Why the stock one-liner doesn't work yet

The README's install line —

```bash
curl -fsSL https://github.com/madeinorbit/podium/releases/latest/download/install.sh | sh
```

— fails for two reasons right now:

1. **The repo is private.** Anonymous downloads of `github.com/.../releases/download/...`
   return **404**.
2. **There's no `latest`/stable release.** Only a rolling **`edge`** prerelease exists, so
   even `releases/latest/...` 404s regardless of auth.

And the obvious fix — set `GH_TOKEN` — **does not help by itself**: GitHub's
`github.com/OWNER/REPO/releases/download/...` browser URL ignores bearer tokens on private
repos (it still 404s). Only the **API asset endpoint** honors auth, which is what the `gh`
CLI uses.

So the workaround is: **fetch the release assets with `gh` (or copy them in), then run the
real `install.sh` against a local mirror** using its built-in `PODIUM_INSTALL_BASE` hook.
This keeps the genuine install path — Ed25519 signature verification, atomic install, the
`podium` symlink — completely intact; only the *source of the bytes* changes.

---

## Path A — recommended: copy assets in, run the real installer

Keeps **no GitHub credentials on the VPS**. You download three files on a machine that
already has repo access (e.g. your laptop), `scp` them over, then run the stock installer.

### 1. On a machine with repo access — grab the `edge` assets

```bash
mkdir -p podium-assets && cd podium-assets
gh release download edge --repo madeinorbit/podium --clobber \
  --pattern 'install.sh' \
  --pattern 'podium-headless-linux-x64.tar.gz' \
  --pattern 'podium-headless-linux-x64.tar.gz.sig'
```

(`gh` uses the GitHub API, so this works against the private repo. ~120 MB tarball.)

### 2. Copy them to the VPS

```bash
scp -r podium-assets user@your-vps:~/podium-assets
```

### 3. On the VPS — prerequisites, then install

```bash
sudo apt-get update && sudo apt-get install -y curl openssl        # verify + fetch tooling
cd ~/podium-assets
PODIUM_INSTALL_BASE="file://$HOME/podium-assets" sh install.sh --channel edge
```

`PODIUM_INSTALL_BASE` points the installer's fetch at your local files (curl reads `file://`
URLs). It still verifies the signature and does the atomic install to
`~/.local/share/podium` with a `podium` symlink in `~/.local/bin`. `--channel edge` records
that this box tracks the edge channel.

> If `~/.local/bin` isn't on your `PATH`, add it: `export PATH="$HOME/.local/bin:$PATH"`
> (and persist it in your shell profile).

---

## Path B — alternative: install `gh` on the VPS and pull directly

Simpler (one machine) but puts a GitHub token on the VPS.

```bash
sudo apt-get update && sudo apt-get install -y curl openssl gh
gh auth login                                   # account with read access to the repo

mkdir -p ~/podium-assets && cd ~/podium-assets
gh release download edge --repo madeinorbit/podium --clobber \
  --pattern 'install.sh' \
  --pattern 'podium-headless-linux-x64.tar.gz' \
  --pattern 'podium-headless-linux-x64.tar.gz.sig'

PODIUM_INSTALL_BASE="file://$HOME/podium-assets" sh install.sh --channel edge
```

---

## Finish setup — from here it's the normal flow

```bash
podium
```

With no config, `podium` runs **all-in-one** (server + daemon in one process) on port
**18787** and prints a setup URL. Finish the networking step either way:

- **Terminal (good for a headless VPS):** `podium setup`
- **Browser:** open the printed `http://localhost:18787/` (tunnel it, or SSH-forward:
  `ssh -L 18787:localhost:18787 user@your-vps`).

### Make it reachable (no domain needed)

Setup offers four ways to get an encrypted `https://` URL — pick one, run its command, paste
the URL back:

| Option | Command | Reach |
|--------|---------|-------|
| **Tailscale Funnel** (public, recommended) | `tailscale funnel 18787` | Anywhere; real cert, no domain. Enable Funnel in your tailnet ACL. |
| **Tailscale Serve** (private) | `tailscale serve 18787` | Tailnet devices only |
| **Cloudflare quick tunnel** | `cloudflared tunnel --url http://localhost:18787` | Anywhere; URL changes each restart (demo-grade) |
| **Manual reverse proxy** | your own Caddy/nginx | Wherever you proxy it |

Since it's a VPS with a public IP, the manual reverse-proxy option (Caddy/nginx terminating
TLS in front of `:18787`) is also natural if you have a domain.

### Before agents can actually run on this box

- Install the agent CLIs you'll use — **`claude`** and/or **`codex`** — on the VPS. The
  daemon wraps whatever is on `PATH`.
- **Repos live per machine.** A repository must already exist on the VPS for the daemon to
  open sessions in it; pairing/installing doesn't copy repos across hosts.

---

## Caveats while private

- **The current `edge` bundle crash-loops the discovery worker** in all-in-one
  (`discovery worker crashed: ModuleNotFound resolving "/$bunfs/root/discovery-worker.ts"`).
  Fixed on branch `issue/96-podium-on-new-vps` (the worker is now embedded as a compile
  entrypoint) — a **fresh build must be cut and re-published to `edge`** before the mirror
  install runs cleanly. Until then the box installs and serves setup, but agent discovery is
  degraded.
- **Auto-update won't work** on this box: `podium update` fetches from the same private
  browser URL that 404s. To update, re-pull the `edge` assets and re-run the mirror install
  (or `podium update` once the repo/release is public). The all-in-one server install does
  **not** register an auto-update timer, so nothing will silently break — updates are just
  manual for now.
- **When the repo goes public** (and a `latest` release is cut), the real one-liner works
  with zero workaround: `curl -fsSL .../releases/latest/download/install.sh | sh`.

---

## Adding more machines (later)

Once this server has a `publicUrl`, pairing a second machine (e.g. another VPS running only
a daemon) is a one-line copy-paste from **Settings → Machines → Add machine** — but that
command also hits the private release URL, so until public it needs the same mirror
workaround: copy the assets over and run `sh install.sh --join <TOKEN>
PODIUM_INSTALL_BASE=file://…`. See [`adding-a-machine.md`](./adding-a-machine.md) for the
full pairing model.
