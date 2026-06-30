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

## Non-goals (deferred)

- arm64 / macOS binaries — `linux-x64` only for now (matches the Ubuntu VPS target). The release
  matrix leaves empty slots to fill when desktop/Mac lands.
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
  `podium-headless-<version>.tar.gz` + `.tar.gz.sig` (Ed25519, key in
  `scripts/podium-update-pubkey.ts`).
- `scripts/podium-update.ts` self-updates: fetch a manifest from `<feed>/update/<os>/<arch>/<cur>`,
  verify the Ed25519 signature of the downloaded tarball, atomic-swap the install dir. Default feed
  is the placeholder `http://127.0.0.1:8789`.
- Daemon identity (`apps/daemon/src/identity.ts`): stable `machineId` + `token` persisted to
  `~/.podium/daemon.json`; pairing via a UI-minted single-use code (~10 min TTL); per-`machineId`
  routing in the server relay.

## User journeys

### A. New instance

```
curl -fsSL https://github.com/madeinorbit/podium/releases/latest/download/install.sh | sh
podium
```

`install.sh` downloads the signed bundle, verifies it, installs it, and prints
*"Installed. Run `podium` to start."* Running `podium` (no config) starts all-in-one and opens the
**setup flow**, whose networking step makes the box reachable (Tailscale-first).

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
  ├─ install.sh                              (asset; also raw.githubusercontent fallback)
  ├─ stable: release "latest", tag vX.Y.Z    podium-headless-linux-x64.tar.gz(+.sig)
  └─ edge:   prerelease tag "edge" (rolling)  podium-headless-linux-x64.tar.gz(+.sig)
        ▲ built + signed by .github/workflows/release.yml on Blacksmith
        │
   install.sh  ──install──▶  ~/.local/share/podium/  (bundle root, PODIUM_HOME)
        │                     ~/.local/bin/podium → bundle launcher
        │  --join TOKEN ─────▶ ~/.podium/config.json (daemon) + ~/.config/systemd/user/podium-daemon.service
        ▼
   podium  ──no config──▶ all-in-one + setup flow (networking: Tailscale Serve/Funnel | CF tunnel | manual)
        │                     persists publicUrl ──▶ join tokens embed it
   podium update ──channel──▶ GitHub Releases API (semver compare) ──▶ verify sig ──▶ atomic swap
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
  (decode, via a tiny `podium join-config <TOKEN>` helper — see C3 rationale).
- **Versioned** (`v:1`) so the format can evolve without breaking old install scripts.

### C2 — Config schema extensions (`packages/core/src/config.ts`)

Add two optional fields (backward compatible — old configs still parse):

```ts
updateChannel: z.enum(['stable', 'edge']).optional(),  // default 'stable' when unset
publicUrl: z.string().optional(),                       // reachable URL captured at setup; what tokens embed
```

`publicUrl` is the instance's externally-reachable base (e.g. `https://box.tail1234.ts.net`).
`updateChannel` selects the release channel for `podium update`.

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
   `openssl pkeyutl -verify` (Ed25519, available in OpenSSL ≥ 1.1.1 — standard on Ubuntu 20.04+).
   **Fail closed:** a bad/missing signature aborts before anything is written to `~/.local`.
5. **Install** the bundle to `~/.local/share/podium/` and symlink the launcher to
   `~/.local/bin/podium`. Atomic-ish: extract to a temp dir on the same filesystem, then rename.
6. **Plain mode:** print PATH guidance (if `~/.local/bin` isn't on PATH) and *"Run `podium`."*
7. **`--join <TOKEN>` mode:** after install, run `podium join-config <TOKEN>` (a new non-interactive
   CLI subcommand, C4) which decodes the token and writes `~/.podium/config.json`. Then install +
   `systemctl --user enable --now` the daemon unit (C5). Print the machine name and "joined."

**Rationale for `podium join-config` instead of decoding in shell:** base64url + JSON + zod
validation belongs in TS, not hand-rolled `sh`. The script stays a thin installer; the binary it
just installed owns token parsing. Keeps one source of truth (C1) and one validation path.

`--channel` and `--join` are the only flags. No `--server`, no `--pair` surfaced to users.

### C4 — `podium join-config <TOKEN>` (new subcommand in `scripts/cli.ts`)

Non-interactive: `decodeJoin(token)` → `saveConfig({ mode:'daemon', serverUrl, pairCode, name })`
→ print the resolved machine name. Exits non-zero with a one-line error on a malformed token.
Used only by `install.sh --join`; documented but not something users invoke by hand.

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

- `%h` (systemd specifier) resolves the user home — no path baked in.
- `podium daemon` reads `~/.podium/config.json` for `serverUrl` (and consumes `pairCode` on first
  connect, then relies on the persisted `~/.podium/daemon.json` token).
- `install.sh --join` drops this file into `~/.config/systemd/user/`, runs
  `systemctl --user daemon-reload && systemctl --user enable --now podium-daemon`, and (best-effort)
  `loginctl enable-linger "$USER"` so the daemon survives logout — noted in docs; failure is
  non-fatal (e.g. no-systemd hosts get a printed manual fallback).
- A **`--system`** variant is documented in C8 but not the default (avoids requiring root).

### C6 — Self-update repointed to GitHub Releases, channel-aware (`scripts/podium-update.ts`)

Replace the `<feed>/update/<os>/<arch>/<cur>` manifest contract with a GitHub-native resolver:

- Channel from `config.updateChannel` (default `stable`), overridable by env `PODIUM_UPDATE_CHANNEL`.
- Resolve the channel's release via the GitHub API:
  - stable → `GET /repos/madeinorbit/podium/releases/latest`
  - edge → `GET /repos/madeinorbit/podium/releases/tags/edge`
- Read `tag_name` (stable) / a `VERSION` asset or release body stamp (edge) for the **semver compare**
  against the local `VERSION` (existing `isNewer`). Pick the `…linux-x64.tar.gz` + `.sig` asset URLs.
- Reuse the **existing** download → Ed25519 verify → atomic dir-swap path untouched.
- `config.updateFeed`/`PODIUM_UPDATE_FEED` is retained as an **override base** (points the resolver at
  a self-hosted mirror or a test fixture server) but defaults to the GitHub API. This keeps
  `verify-headless-update.sh`'s local-fixture test strategy working.

The `127.0.0.1:8789` default is gone; install + update both live on GitHub.

### C7 — Release workflow (`.github/workflows/release.yml`, Blacksmith runners)

```
runs-on: blacksmith-4vcpu-ubuntu-2204         # faster runners
cache:   useblacksmith/cache  (Bun store + prebuilt abduco)
matrix:  [ { os: linux, arch: x64 } ]          # arm64/darwin slots left empty for later
secrets: PODIUM_UPDATE_SIGNING_KEY             # existing Ed25519 private key
```

Triggers and outputs:

- **push to `main`** → build + sign `podium-headless-linux-x64.tar.gz(+.sig)`, then **force-update**
  the rolling **`edge`** prerelease (delete+recreate its assets; `prerelease: true`). This is the
  fast channel — tip of main on every merge.
- **push tag `v*`** → same build, publish a normal release marked **latest** = **`stable`**, with
  auto-generated notes. Promotion = tagging a commit that's already proven on `edge`.
- Both upload `install.sh` as a release asset (so the `…/releases/latest/download/install.sh` URL
  resolves) and emit a `VERSION` asset for the updater's semver compare.

`scripts/release.ts` holds the build/sign/publish logic (callable locally for a manual release and
from the workflow) so CI is a thin wrapper, not the only way to cut a build.

### C8 — First-run setup flow (`apps/web` + `apps/server` + `scripts/cli.ts`)

Turns the existing setup-URL stub into a guided flow. Steps:

1. **Role** — "This is my main instance" (default) vs. "Join an existing instance" (the latter just
   shows the C3 join command to run on *this* box and links to docs; the common path is the paste,
   not this screen).
2. **Networking (Tailscale-first, guide + copy-paste).** Present three options:
   - **Tailscale Funnel (public, recommended)** — show
     `tailscale funnel 18787` (and the one-time enable steps); a field to paste the resulting
     `https://<host>.<tailnet>.ts.net` URL back. Explain: real cert, reachable from your phone
     anywhere, no domain.
   - **Tailscale Serve (private)** — `tailscale serve 18787`; same paste-back. Reachable only from
     your tailnet. Best when every viewer is already on it.
   - **Cloudflare quick tunnel (no Tailscale)** — `cloudflared tunnel --url http://localhost:18787`;
     paste the `https://<random>.trycloudflare.com`. Warn: URL rotates on restart; demo-grade.
   - **Manual** — paste any reverse-proxied `https://…` URL.
   Persist the captured URL as `config.publicUrl` (C2). Validate it's a well-formed http(s) URL.
3. **Done** — server reachable; the Machines panel can now mint join commands whose token embeds
   `publicUrl` (rewritten to `wss://…` for the daemon).

The **Machines tRPC** `pairingCode` flow is extended to return a ready-to-copy **join command string**
(`curl … | sh -s -- --join <encodeJoin({serverUrl: wssFrom(publicUrl), pairCode, name})>`), not just
the bare code. The UI shows the whole line with a copy button.

### C9 — `docs/adding-a-machine.md`

End-to-end: install one-liner, the Add-a-machine paste, the Tailscale networking options (with the
private-vs-public table and the daemon-over-tailnet note), the `--system` systemd variant, the
`podium update` channel switch, and a troubleshooting section (no-systemd host, openssl missing,
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

- **Daemon ↔ server** rides the **tailnet** wherever possible (no public exposure needed) — the
  `serverUrl` in a join token is typically the tailnet/Funnel URL of the server.
- **Browser ↔ server** uses whatever `publicUrl` the setup flow captured (Funnel public, Serve
  private, CF tunnel, or manual proxy).
- Podium continues to terminate **no TLS itself** — Serve/Funnel/cloudflared/Caddy own it. This is a
  deliberate boundary: the binary speaks plaintext ws/http on `:18787`; the tunnel provides the cert.
- **Funnel constraint** noted in docs: only ports 443/8443/10000 are funnelable and it must be enabled
  in the tailnet ACL; the flow links the exact steps.

## Security considerations

- **install.sh trust:** the script verifies the bundle's Ed25519 signature before installing, so a
  compromised release asset (without the private key) is rejected. The script itself is served over
  HTTPS from GitHub; its embedded pubkey is the trust anchor. Document the pubkey fingerprint so a
  cautious user can diff it.
- **Pairing code:** unchanged — single-use, ~10 min TTL, redeemed for a per-machine token. A token in
  a `--join` line that's pasted into the wrong box just fails to pair after expiry; codes are not
  long-lived secrets.
- **Join token contents:** `serverUrl` + a short-lived `pairCode`. No durable secret — safe to show in
  the UI and copy through a phone. The durable `daemon.json` token never leaves the daemon host.
- **Self-update** keeps fail-closed signature verification and atomic swap with rollback (existing).

## Testing strategy

- **C1 join codec** — unit: round-trip, base64url correctness, rejects malformed/short/invalid-zod
  tokens, version mismatch handling.
- **C2 config** — unit: new fields parse; old configs (no `updateChannel`/`publicUrl`) still load;
  `updateChannel` defaulting.
- **C3 install.sh** — `shellcheck` clean; a fixture harness (mirroring `verify-headless-update.sh`):
  serve a local fixture "release" over `file://`/localhost, assert: arch detect, **tamper → reject &
  nothing written**, plain install lays down the symlink, `--join` writes config + unit file. Run on
  Ubuntu in CI.
- **C4 join-config** — unit/integration: valid token writes the expected daemon config; bad token
  exits non-zero without writing.
- **C5 unit template** — assert the rendered unit has no hardcoded home, uses `%h`, `Type=notify`.
- **C6 self-update** — unit: channel → API URL resolution; semver compare; reuse existing
  download/verify/swap tests with a fixture GitHub-shaped response; tamper rejection.
- **C7 release workflow** — `scripts/release.ts` dry-run (build + sign + assert assets/sig locally);
  the workflow YAML is lint-checked; full publish exercised manually on first cut.
- **C8 setup flow** — server/config persistence tests for `publicUrl`; the Machines tRPC returns a
  well-formed join command containing a decodable token; an e2e (Playwright) for the networking
  paste-back step persisting `publicUrl`.

## Build order (within the combined plan)

1. C1 join codec + C2 config (leaf, pure, unblocks everything).
2. C4 `join-config` + C3 `install.sh` + C5 systemd unit (the paste path; testable against a fixture
   release without CI).
3. C6 self-update repoint (channel-aware).
4. C7 release workflow on Blacksmith (publishes the assets the above consume for real).
5. C8 setup flow + Machines join-command (the new-instance UX; depends on C1/C2).
6. C9 docs (last, reflecting what shipped).

## Open questions

- Channel naming `stable`/`edge` vs `stable`/`canary` — proceeding with **`stable`/`edge`** unless the
  reviewer prefers the `canary` vocabulary.
