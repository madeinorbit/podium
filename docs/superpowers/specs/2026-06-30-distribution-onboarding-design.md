# Distribution & one-paste machine onboarding — design

- **Date:** 2026-06-30
- **Issue:** podium-4ny
- **Status:** Design (awaiting review)
- **Release repo:** `madeinorbit/podium`

## Goal

Make two things copy-paste operations:

1. **Stand up a new instance** — paste one `curl … | sh` line, then run `podium`, and get a
   real guided setup flow (including how to be reachable, encrypted, without owning a domain).
2. **Add a machine** — copy one line from an existing instance's UI, paste it on a fresh
   Ubuntu VPS, and the box joins as a daemon. The user never types a URL, a flag, or the words
   `daemon`/`server`/`--pair`.

Distribution rides **GitHub** (Releases + raw) — no domain, no hosting bill. Transport rides
**Tailscale** (Serve for private, Funnel for public) with a **Cloudflare quick tunnel** fallback.
Releases are built by **GitHub Actions on Blacksmith runners** across two channels, **`stable`**
and **`edge`**.

Two cross-cutting requirements drive the rest of the design:

- **Self-update must cover both delivery forms** — the **headless** terminal install
  (`podium-server` / `podium-daemon` / `podium` CLI, Ed25519-signed tarball) **and** the bundled
  **desktop** app (Tauri, minisign-signed bundle). Both pull from the same GitHub Releases.
- **The setup flow must be usable two ways** — a **web GUI** and an interactive **CLI** flow — over
  one shared, UI-agnostic **setup core**, so a headless VPS can be configured without a browser.

## Non-goals (deferred)

- **arm64 / macOS / Windows artifacts** — both headless and desktop are built for **`linux-x64`
  only** for now (matches the Ubuntu VPS target). The release matrix leaves those slots empty to
  fill when Mac/Windows lands.
- **Desktop `edge` channel** — desktop follows **`stable`** only initially; fast-channel dogfooding
  happens on the headless/terminal build. Desktop edge is deferred (Tauri endpoints are baked at
  build time, so per-user channel switching is extra machinery we don't need yet).
- A bespoke release host / apt repo / Homebrew tap / Docker image — GitHub Releases is the only
  channel in this spec. (Brew/apt/Docker are tracked as follow-ons, not built here.)
- Auto-installing or auto-running Tailscale/cloudflared. The setup flow is **guide + copy-paste**:
  it shows the exact command and accepts the resulting URL. No process orchestration.
- Changing the pairing/identity/routing protocol — that machinery (pair → token → hello, per-
  machine routing) already ships on `main` and is reused unchanged.

## Background (current state, reused as-is)

- `scripts/cli.ts` already implements the mode-driven `podium` launcher: subcommands
  `all-in-one|daemon|client|server`, flags `--server/--pair/--name`, `podium update`,
  `podium setup`/`--reconfigure`. With no config + no subcommand it runs all-in-one and prints a
  setup URL.
- `packages/core/src/config.ts` defines `PodiumConfig` (`mode`, `serverUrl`, `port`, `pairCode`,
  `updateFeed`), persisted to `$PODIUM_STATE_DIR/config.json` (default `~/.podium/config.json`).
- `scripts/build-bun.ts` produces a signed headless bundle: `dist-bun/headless/` (the `podium`,
  `podium-server`, `podium-daemon` binaries + web UI + `VERSION`) and
  `podium-headless-<version>.tar.gz` + `.tar.gz.sig` (raw **Ed25519**, key in
  `scripts/podium-update-pubkey.ts`).
- `scripts/podium-update.ts` self-updates: fetch a manifest from `<feed>/update/<os>/<arch>/<cur>`,
  verify the Ed25519 signature of the downloaded tarball, atomic-swap the install dir. Default feed
  is the placeholder `http://127.0.0.1:8789`. Manifest shape:
  `{ version, platforms: { "linux-x86_64": { url, signature } } }`.
- **Desktop (Tauri)** ships its *own* updater: `apps/desktop/src-tauri/tauri.conf.json`
  `plugins.updater` has a **minisign** `pubkey` (a *separate* keypair from the headless Ed25519 one)
  and `endpoints` (placeholder `https://releases.podium.app/update/{{target}}/{{arch}}/{{current_version}}`);
  `bundle.createUpdaterArtifacts: true`. Build env `TAURI_SIGNING_PRIVATE_KEY` / `…_PASSWORD` sign the
  bundle.
- **Version is single-sourced** from root `package.json` `"version"` → headless `VERSION` + the
  compiled server's `GET /version` + (via `apps/desktop/scripts/stage-sidecar.ts`) `tauri.conf.json`.
  Bump one field to release.
- Daemon identity (`apps/daemon/src/identity.ts`): stable `machineId` + `token` persisted to
  `~/.podium/daemon.json`; pairing via a UI-minted single-use code (~10 min TTL); per-`machineId`
  routing in the server relay.
- `docs/update-release-swaps.md` enumerates the three release swaps — headless Ed25519 pubkey, desktop
  minisign pubkey, feed/endpoints host. **This spec performs all three, pointing both feeds at GitHub.**

## User journeys

### A. New instance

```
curl -fsSL https://github.com/madeinorbit/podium/releases/latest/download/install.sh | sh
podium
```

`install.sh` downloads the signed bundle, verifies it, installs it, and prints
*"Installed. Run `podium` to start."* Running `podium` (no config) starts all-in-one and offers the
**setup flow** — the **web GUI** at the printed URL, or an interactive **`podium setup`** in the
terminal (same steps, no browser). The networking step makes the box reachable (Tailscale-first).

### B. Add a machine (the headline)

On an existing instance: **Settings → Machines → Add machine** shows exactly one line:

```
curl -fsSL https://github.com/madeinorbit/podium/releases/latest/download/install.sh | sh -s -- --join eyJ2IjoxLCJ…
```

On the VPS the user pastes it. `install.sh --join <TOKEN>` installs the bundle, decodes the token,
writes a daemon `config.json`, installs + enables a `--user` systemd unit, and starts it. The
machine appears **online** in the Machines panel. The token is the only thing copied; it hides the
server URL, pairing code, and mode.

## Architecture

```
GitHub Releases (madeinorbit/podium)
  ├─ install.sh                              (asset; raw.githubusercontent fallback)
  ├─ stable: release "latest" (tag vX.Y.Z)   headless .tar.gz(+Ed25519 .sig) · podium-update.json
  │                                          · desktop bundle(+minisign .sig) · latest.json
  └─ edge:   prerelease "edge" (rolling)      headless .tar.gz(+.sig) · podium-update.json
        ▲ built + signed by .github/workflows/release.yml on Blacksmith   (desktop = stable-only for now)
        │
   install.sh  ──install──▶  ~/.local/share/podium/  (bundle root, PODIUM_HOME)
        │                     ~/.local/bin/podium → bundle launcher
        │  --join TOKEN ─────▶ ~/.podium/config.json (daemon) + ~/.config/systemd/user/podium-daemon.service
        ▼
   podium  ──no config──▶ all-in-one + setup flow
        │                     setup CORE (UI-agnostic) ──▶ web GUI (apps/web)  AND  CLI (podium setup)
        │                     networking: Tailscale Funnel/Serve | CF tunnel | manual  ─▶ persists publicUrl
        │                     publicUrl ──▶ join tokens embed it
        ▼
   podium update ──channel──▶ GitHub per-channel manifest ──▶ verify Ed25519 ──▶ atomic swap
   desktop app   ──Tauri────▶ GitHub latest.json          ──▶ verify minisign ─▶ install
```

## Components

### C1 — Join token codec (`@podium/core`, new `join.ts`)

A self-describing, opaque-to-the-user blob.

```ts
export const JoinPayload = z.object({
  v: z.literal(1),
  serverUrl: z.string(),          // wss://… or ws://… the daemon dials (the instance publicUrl)
  pairCode: z.string(),           // single-use, server-minted
  name: z.string().optional(),    // optional display name for the new machine
})
export function encodeJoin(p: JoinPayload): string     // base64url(JSON), no padding
export function decodeJoin(token: string): JoinPayload // throws on malformed/invalid → caller errors cleanly
```

- **What it does:** round-trips daemon-join parameters as one string.
- **Boundary:** pure, no I/O. Used by the server (mint, in the Machines tRPC) and `install.sh`
  (decode, via the `podium join-config <TOKEN>` helper — see C3 rationale).
- **Versioned** (`v:1`) so the format can evolve without breaking old install scripts.

### C2 — Config schema extensions (`packages/core/src/config.ts`)

Add two optional fields (backward compatible — old configs still parse):

```ts
updateChannel: z.enum(['stable', 'edge']).optional(),  // default 'stable' when unset
publicUrl: z.string().optional(),                       // reachable URL captured at setup; what tokens embed
```

`publicUrl` is the instance's externally-reachable base (e.g. `https://box.tail1234.ts.net`).
`updateChannel` selects the release channel for `podium update` (headless only; desktop is stable).

### C3 — `install.sh` (new, repo root `install.sh`; published as a release asset)

POSIX `sh` (not bash). Responsibilities, in order:

1. **Detect** OS/arch → asset name. Today only `linux-x64` is supported; anything else exits with a
   clear "unsupported platform; build from source" message.
2. **Resolve channel** (`--channel edge` flag, default `stable`) → download base URL:
   - stable: `…/releases/latest/download/`
   - edge: `…/releases/download/edge/`
3. **Download** `podium-headless-linux-x64.tar.gz` + `.tar.gz.sig` (via `curl`, fall back to `wget`).
4. **Verify** the Ed25519 signature against the committed public key (the same key as
   `scripts/podium-update-pubkey.ts`, embedded as a constant in `install.sh`). Verification uses
   `openssl pkeyutl -verify` (Ed25519, OpenSSL ≥ 1.1.1 — standard on Ubuntu 20.04+).
   **Fail closed:** a bad/missing signature aborts before anything is written to `~/.local`.
5. **Install** the bundle to `~/.local/share/podium/` and symlink the launcher to
   `~/.local/bin/podium`. Atomic-ish: extract to a temp dir on the same filesystem, then rename.
6. **Plain mode:** print PATH guidance (if `~/.local/bin` isn't on PATH) and *"Run `podium`."*
7. **`--join <TOKEN>` mode:** after install, run `podium join-config <TOKEN>` (C4) to decode the token
   and write `~/.podium/config.json`. Then install + `systemctl --user enable --now` the daemon unit
   (C5). Print the machine name and "joined."

**Rationale for `podium join-config` instead of decoding in shell:** base64url + JSON + zod
validation belongs in TS, not hand-rolled `sh`. The script stays a thin installer; the binary it
just installed owns token parsing. One source of truth (C1), one validation path.

`--channel` and `--join` are the only flags. No `--server`, no `--pair` surfaced to users.

### C4 — `podium join-config <TOKEN>` (new subcommand in `scripts/cli.ts`)

Non-interactive: `decodeJoin(token)` → `saveConfig({ mode:'daemon', serverUrl, pairCode, name })`
→ print the resolved machine name. Exits non-zero with a one-line error on a malformed token.
Used only by `install.sh --join`; documented but not a hand-run command.

(`podium` then runs in daemon mode from that config — `cli.ts` already starts a daemon when
`config.mode==='daemon'` with a `serverUrl`, consuming `pairCode` once.)

### C5 — Daemon systemd unit (`scripts/systemd/podium-daemon-user.service.tmpl` + installer)

A **`--user`** unit, parameterized (no hardcoded `/home/user`, no `--conditions=@podium/source` —
this runs the **installed binary**, not git source):

```ini
[Unit]
Description=Podium agent daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
WatchdogSec=30
ExecStart=%h/.local/bin/podium daemon
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
```

- `%h` resolves the user home — no path baked in.
- `podium daemon` reads `~/.podium/config.json` for `serverUrl` (consumes `pairCode` on first
  connect, then relies on the persisted `~/.podium/daemon.json` token).
- `install.sh --join` drops this into `~/.config/systemd/user/`, runs
  `systemctl --user daemon-reload && systemctl --user enable --now podium-daemon`, and (best-effort)
  `loginctl enable-linger "$USER"` so the daemon survives logout — failure is non-fatal (no-systemd
  hosts get a printed manual fallback).
- A **`--system`** variant is documented in C9 but not the default (avoids requiring root).

### C6 — Headless self-update repointed to GitHub, channel-aware (`scripts/podium-update.ts`)

Keep the **manifest → verify Ed25519 → atomic dir-swap** flow; change only where the manifest comes
from. Instead of `<feed>/update/<os>/<arch>/<cur>`, resolve the channel to a **static per-channel
manifest asset** on GitHub (a static asset, not the GitHub API — avoids rate limits and matches the
desktop static-manifest model):

- stable → `https://github.com/madeinorbit/podium/releases/latest/download/podium-update.json`
- edge → `https://github.com/madeinorbit/podium/releases/download/edge/podium-update.json`

Channel from `config.updateChannel` (default `stable`), overridable by env `PODIUM_UPDATE_CHANNEL`.
The manifest keeps the existing `{ version, platforms: { "linux-x86_64": { url, signature } } }`
shape, so the parse/`isNewer` semver compare/verify/swap code is unchanged. `config.updateFeed` /
`PODIUM_UPDATE_FEED` is retained as an **override base** (mirror or test fixture); it just defaults to
GitHub now. The `127.0.0.1:8789` default is gone.

### C6b — Desktop self-update repointed to GitHub (`apps/desktop/src-tauri/tauri.conf.json` + workflow)

The Tauri updater is already wired; this performs its two release swaps against GitHub:

- **Repoint `updater.endpoints`** to a static GitHub manifest the workflow publishes:
  `https://github.com/madeinorbit/podium/releases/latest/download/latest.json` (Tauri's standard
  `latest.json` shape: `version`, `notes`, `pub_date`, `platforms{ "<target>": { signature, url } }`).
  Stable channel only for now (see non-goals). Tauri compares `version` to the running app and
  installs if newer, verifying the **minisign** signature against the committed `updater.pubkey`.
- **Swap `updater.pubkey`** from the placeholder to the production minisign public key; the private
  key lives in CI as `TAURI_SIGNING_PRIVATE_KEY` (+ `…_PASSWORD`).

The two updaters stay independent (different signing schemes — Ed25519 tarball vs minisign bundle)
but share one release, one version source, and one host (GitHub). No code unifies them; they just
both read static manifests off the same release.

### C7 — Release workflow (`.github/workflows/release.yml`, Blacksmith) + `scripts/release.ts`

```
runs-on: blacksmith-4vcpu-ubuntu-2204          # faster runners
cache:   useblacksmith/cache  (Bun store + prebuilt abduco + Rust/Tauri toolchain)
matrix:  [ { os: linux, arch: x64 } ]           # arm64/darwin/win slots left empty for later
secrets: PODIUM_UPDATE_SIGNING_KEY  (Ed25519, headless)
         TAURI_SIGNING_PRIVATE_KEY + TAURI_SIGNING_PRIVATE_KEY_PASSWORD  (minisign, desktop)
```

Per build it produces, for the target channel's release:

- **Headless:** `podium-headless-linux-x64.tar.gz` + `.sig` (Ed25519) **and** a generated
  `podium-update.json` manifest.
- **Desktop (stable only):** the Tauri Linux bundle (.AppImage/.deb) + its minisign `.sig` **and**
  the Tauri `latest.json` manifest (e.g. via `tauri-action` or `tauri build` + a manifest step).
- **`install.sh`** uploaded as a release asset (so `…/releases/latest/download/install.sh` resolves).
- A `VERSION` asset for the headless updater's semver compare.

Triggers:

- **push to `main`** → build + sign the **headless** artifacts, then **force-update** the rolling
  **`edge`** prerelease (delete+recreate its assets; `prerelease: true`). Tip of main on every merge.
  (Desktop is not rebuilt on edge.)
- **push tag `v*`** → build **headless + desktop**, publish a normal release marked **latest** =
  **`stable`** with auto-generated notes. Promotion = tagging a commit already proven on `edge`.

`scripts/release.ts` holds the build/sign/manifest/publish logic (callable locally for a manual
release and from the workflow) so CI is a thin wrapper, not the only way to cut a build. It also
performs the **version single-source** flow (reads root `package.json`).

### C8 — Setup flow: one core, two front-ends

#### C8a — Setup core (`packages/core/src/setup.ts`, UI-agnostic)

The step model + logic, no rendering:

```ts
type SetupStep = 'role' | 'networking' | 'done'
type NetworkOption = 'tailscale-funnel' | 'tailscale-serve' | 'cloudflare-tunnel' | 'manual'

// For a chosen option: the exact shell command to show, and a validator for the pasted URL.
networkOptionCommand(opt: NetworkOption, port: number): { command: string; hint: string }
validatePublicUrl(url: string): { ok: true; normalized: string } | { ok: false; error: string }
applySetup(input: { role; publicUrl }): PodiumConfig   // persists mode + publicUrl via saveConfig
```

Pure functions + types; both presenters call this. Single source of the commands shown and the URL
validation, so web and CLI never drift.

#### C8b — Web GUI (`apps/web` + `apps/server` tRPC `setup.*`)

Renders the steps; the networking step shows the command (copy button) and a paste-back field;
calls the core through a thin `setup` tRPC router. Replaces today's bare setup-URL stub.

#### C8c — CLI flow (`scripts/cli.ts` → `podium setup`)

Interactive `readline` prompts implementing the **same** steps over the same core — fully headless,
no browser. Prints the `tailscale funnel`/`serve` (or `cloudflared`) command, prompts *"paste the
resulting URL:"*, validates, saves. `podium` with no config on a TTY prints the web URL **and** the
hint *"…or run `podium setup` here in the terminal."*

#### Networking step content (Tailscale-first, guide + copy-paste)

| Option | Command shown | Paste back | Note |
|--------|---------------|-----------|------|
| **Funnel (public, recommended)** | `tailscale funnel <port>` (+ one-time enable steps) | `https://<host>.<tailnet>.ts.net` | real cert, phone-reachable anywhere, no domain; ports 443/8443/10000 only |
| **Serve (private)** | `tailscale serve <port>` | same `*.ts.net` | tailnet-only viewers |
| **Cloudflare quick tunnel** | `cloudflared tunnel --url http://localhost:<port>` | `https://<random>.trycloudflare.com` | URL rotates on restart; demo-grade |
| **Manual** | (your own reverse proxy) | any `https://…` | Caddy/nginx |

The captured URL is persisted as `config.publicUrl`. The **Machines tRPC** `pairingCode` flow returns
a ready-to-copy **join command** (`curl … | sh -s -- --join <encodeJoin({ serverUrl: wssFrom(publicUrl), pairCode, name })>`),
not just the bare code; the UI shows the whole line with a copy button.

### C9 — `docs/adding-a-machine.md`

End-to-end: install one-liner, Add-a-machine paste, the Tailscale networking options (private-vs-
public table + the daemon-over-tailnet note), the `--system` systemd variant, the `podium update`
channel switch, desktop auto-update behavior, and troubleshooting (no-systemd host, openssl missing,
`~/.local/bin` not on PATH, port not reachable on the tailnet interface).

## Data flow — add a machine (end to end)

1. Setup flow captured `publicUrl = https://box.tailnet.ts.net` on the main instance.
2. User clicks **Add machine** → server mints a single-use `pairCode`, returns
   `encodeJoin({ serverUrl: 'wss://box.tailnet.ts.net', pairCode, name })` wrapped in the full
   `curl … --join <TOKEN>` line.
3. User pastes it on the VPS. `install.sh` installs the signed bundle (verified), then
   `podium join-config <TOKEN>` writes daemon `config.json`; the unit is enabled + started.
4. `podium daemon` connects to `wss://box.tailnet.ts.net/daemon`, sends the `pair` frame, receives a
   token, persists `~/.podium/daemon.json`, reconnects with `hello`.
5. Machine shows **online**; new sessions can target it; repos must exist on that host.

## Networking design

- **Daemon ↔ server** rides the **tailnet** wherever possible (no public exposure needed).
- **Browser ↔ server** uses whatever `publicUrl` the setup flow captured (Funnel public, Serve
  private, CF tunnel, or manual proxy).
- Podium terminates **no TLS itself** — Serve/Funnel/cloudflared/Caddy own it. Deliberate boundary:
  the binary speaks plaintext ws/http on `:18787`; the tunnel provides the cert.
- **Funnel constraint** (ports 443/8443/10000, must be enabled in the tailnet ACL) is documented with
  the exact enable steps in C9.

## Security considerations

- **install.sh trust:** verifies the bundle's Ed25519 signature before installing; a tampered release
  asset (without the private key) is rejected. The script is served over HTTPS from GitHub; its
  embedded pubkey is the trust anchor (document the fingerprint so a cautious user can diff it).
- **Two signing systems, intentionally:** headless = raw Ed25519 (Bun/Node `crypto`); desktop =
  minisign (Tauri requirement). Separate keypairs, both private keys CI-only secrets, both pubkeys
  committed. Neither can forge the other's artifacts.
- **Pairing code:** unchanged — single-use, ~10 min TTL. A token pasted into the wrong box just fails
  to pair after expiry; codes aren't long-lived secrets.
- **Join token contents:** `serverUrl` + a short-lived `pairCode`. No durable secret — safe to show
  in the UI and copy through a phone. The durable `daemon.json` token never leaves the daemon host.
- **Self-update** (both forms) keeps fail-closed signature verification before install.

## Testing strategy

- **C1 join codec** — unit: round-trip, base64url correctness, rejects malformed/short/invalid-zod/
  version-mismatch tokens.
- **C2 config** — unit: new fields parse; old configs (no `updateChannel`/`publicUrl`) still load;
  `updateChannel` defaulting.
- **C3 install.sh** — `shellcheck` clean; a fixture harness (mirroring `verify-headless-update.sh`):
  serve a local fixture "release"; assert arch detect, **tamper → reject & nothing written**, plain
  install lays down the symlink, `--join` writes config + unit file. Runs on Ubuntu in CI.
- **C4 join-config** — integration: valid token writes the expected daemon config; bad token exits
  non-zero without writing.
- **C5 unit template** — assert the rendered unit has no hardcoded home, uses `%h`, `Type=notify`.
- **C6 headless update** — unit: channel → manifest URL resolution; reuse existing download/verify/
  swap tests with a fixture GitHub-shaped manifest; tamper rejection; semver compare.
- **C6b desktop update** — assert `tauri.conf.json` endpoints/pubkey are the GitHub/production values
  (a config test); a `latest.json` shape test from the manifest generator.
- **C7 release** — `scripts/release.ts` dry-run (build + sign + assert headless tarball/sig + manifest
  + desktop bundle/sig + `latest.json` locally); workflow YAML lint; first real publish exercised
  manually.
- **C8a setup core** — unit: each `NetworkOption`'s command string; `validatePublicUrl` (good/bad);
  `applySetup` persists `mode` + `publicUrl`.
- **C8b/c presenters** — server/config persistence test for `publicUrl`; the Machines tRPC returns a
  well-formed join command containing a decodable token; an e2e (Playwright) for the web paste-back
  step; a CLI test driving `podium setup` over a scripted stdin asserting the same persisted config.

## Build order (within the combined plan)

1. C1 join codec + C2 config (leaf, pure — unblocks everything).
2. C8a setup core (pure logic, no UI).
3. C4 `join-config` + C3 `install.sh` + C5 systemd unit (the paste path; testable against a fixture
   release without CI).
4. C6 headless self-update repoint; C6b desktop endpoints/pubkey repoint.
5. C7 release workflow on Blacksmith (publishes the assets the above consume for real).
6. C8b web GUI + C8c CLI setup + Machines join-command (depends on C1/C2/C8a).
7. C9 docs (last, reflecting what shipped).

## Open questions

- Channel naming `stable`/`edge` vs `stable`/`canary` — proceeding with **`stable`/`edge`** unless the
  reviewer prefers `canary`.
