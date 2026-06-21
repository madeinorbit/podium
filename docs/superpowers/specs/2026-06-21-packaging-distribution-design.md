# Packaging & Distribution — Design

- **Date:** 2026-06-21
- **Status:** Approved (brainstorm) → ready for implementation plan
- **Spec:** this document. Implementation plan to follow via writing-plans.

## Goal

Offer Podium as **one download per operating system**. On first launch the download
gives the user a **server + daemon + native client, all in one**, running on their
desktop and ready out of the box with zero configuration.

The exact same artifacts must also run **headless and distributed from day one**:
the user can later move the server onto another box, and/or add daemons on other
machines, and manage all of it from an in-app **Machines** UI. A person who does
**not** want the desktop app can instead point a browser at a running server and use
the **web version**.

Ship an **auto-update** mechanism for both the desktop app and headless deployments.

### First-run scope (this effort)

- Target **macOS + Linux**. Windows is deferred (PTY/abduco story is riskiest).
- Produce **working local installers** (`.dmg`/`.app`, AppImage/`.deb`). Code-signing
  and notarization are *wired* but require the user's Apple Developer credentials to
  produce signed/notarized output; unsigned local builds work meanwhile.
- The **full multi-machine** capability lands as part of this work (rebase the
  existing `58399ee` branch).
- The update mechanism is built against a **pluggable release-feed URL**; the concrete
  host (Cloudflare R2 vs GitHub Releases) is chosen later and does not block phases 1–4.
- CI build matrix and website download wiring are a **follow-up**, not blockers.

### Non-goals

- Windows packaging (deferred; structure must leave room for it).
- Cloud sandbox orchestration (separate growth-path item).
- Choosing/standing up the production release-feed host and website (follow-up).
- Mobile native app (`apps/mobile`); the browser/PWA path covers mobile for now.

## Background: current topology & hard constraints

(Confirmed by exploration on 2026-06-21, `main` @ `9eb1111`.)

- **Three processes today.**
  - `apps/server` (`@podium/server`) — Hono + tRPC + WebSocket relay. Entry
    `apps/server/src/server.ts` `startServer()`, run via `scripts/server.ts`. Binds
    `:18787` (`PODIUM_PORT`). Endpoints: `/health`, `/trpc`, `/client` (browser WS),
    `/daemon` (daemon WS), `/files`, `/hooks`.
  - `apps/daemon` (`@podium/daemon`) — per-machine agent host. Entry
    `apps/daemon/src/daemon.ts` `startDaemon()`, run via `scripts/daemon.ts`.
    Connects **out** to the server's `/daemon` WS (server-initiated flow reversal) with
    exponential-backoff reconnect. Owns all PTY work, transcript tailing, conversation
    discovery, host metrics, file uploads.
  - `apps/web` (`@podium/web`) — React PWA (Vite + vite-plugin-pwa). Built to
    `apps/web/dist`. Today served by `vite preview`.
  - `scripts/host.ts` already runs server **and** daemon in one process (dev combined
    mode) — the seed of the single-box experience.

- **Runtime constraint: real Node ≥22, not Bun.** `node-pty` is a hard native
  dependency: `packages/agent-bridge/src/session.ts`, `abduco.ts`, and `tmux.ts` all
  attach the PTY *through* `node-pty` (`spawn`). abduco/tmux are only the durable
  *master* behind that node-pty client. → The backend must ship a **prebuilt
  `node-pty` `.node`** per (os, arch). Bun is used for package management / web build,
  not as the backend runtime.

- **abduco** is vendored C (`packages/agent-bridge/vendor/abduco/`), compiled
  on-demand to `~/.podium/bin/abduco` via the system C compiler
  (`packages/agent-bridge/src/abduco-bin.ts`). Resolution order:
  `$PODIUM_ABDUCO` → `abduco` on PATH → `~/.podium/bin/abduco` → compile from vendor.
  → Packaging ships a **prebuilt abduco** per (os, arch) and sets `PODIUM_ABDUCO`;
  the on-demand compile remains as a fallback.

- **Server does not serve the web UI today** (no `serveStatic` in `apps/server/src`).
  Production currently depends on `vite preview`.

- **State** lives under `$PODIUM_STATE_DIR` or `~/.podium`: `podium.db` (sessions,
  conversations, pins, snoozes, settings — `apps/server/src/store.ts`),
  `discovery.db`, `hooks/`, `uploads/`, `bin/abduco`, `daemon.secret`.

- **Distributed/multi-daemon routing is not on `main`** but exists on branch
  `58399ee` (`worktree-multi-machine-agents`), +4931/−362 across 54 files: `machineId`
  UUID routing, pairing-code auth, server-startup adoption of `__local__`→`local`,
  DB v4 migration, `apps/web/src/MachinesPanel.tsx`, Settings→Machines, machine-aware
  New-panel + badge, protocol changes in `packages/protocol/src/messages.ts`. Branched
  from `6dcfdcf`, which is ~6 hardening commits behind current `main` → needs a rebase
  (expect conflicts in `protocol/messages.ts` and `daemon.ts`).

## Core model: one set of artifacts, three roles

Everything is built from the **same bundled backend**. There are three *roles*, not
three codebases:

| Role | What it is | Frontend source | Runs where |
|---|---|---|---|
| `podium-server` | relay + API + **serves the web UI over HTTP** | serves `apps/web/dist` | anywhere (laptop, VPS, container) |
| `podium-daemon` | PTY/agent host (node-pty + abduco) | — (no UI) | any dev machine |
| `podium-desktop` | **Tauri** shell; embeds & supervises a *local* server **and** daemon, shows the UI in a native window | **bundled** assets (`tauri://`) | the user's desktop |

The desktop app's embedded server/daemon **are literally the headless artifacts**.
Therefore:

- "Move the server elsewhere" = run the same `podium-server` on a box; point the
  desktop (or a browser) at it.
- "Add a daemon elsewhere" = run the same `podium-daemon` on another machine; pair it.

One codepath, both modes — that is how "distributed from day one" falls out for free.

### How each surface gets the frontend

- **Desktop app** loads the React build from **bundled assets** via Tauri's internal
  protocol — no HTTP server needed for the UI, works offline, instant, and the UI is
  version-locked to the app shell. Even in "connect to remote server" mode the desktop
  keeps its **bundled** UI and only aims its **API** calls at the remote backend.
- **Browser / no-install path** ("just point at the server") is served the React build
  by **`podium-server` over HTTP**. Same `apps/web/dist` artifact, shipped two ways.

There is no benefit to routing the desktop's own frontend through its embedded HTTP
server; bundling avoids a startup port race, works offline, and prevents UI/shell
version skew. The server-serves-web path exists specifically for the browser audience.

## Components

### A — Make the backend shippable

1. **Bundle the entrypoints.** Bundle `scripts/server.ts`, `scripts/daemon.ts`, and
   `scripts/host.ts` to single ESM files via esbuild/tsup (already a dev dep),
   resolving the `@podium/source` condition so cross-package TS source is pulled in.
   Keep **`node-pty` external** (native; shipped as a prebuilt sidecar artifact).
2. **Ship a pinned Node ≥22 runtime** inside each package so the user installs nothing.
3. **Ship prebuilt natives**: `node-pty` `.node` for {mac-arm64, mac-x64, linux-x64,
   linux-arm64}; a prebuilt `abduco` per (os, arch) with `PODIUM_ABDUCO` pointed at it.
   (Verify node-pty prebuilds exist for linux-arm64 and mac-arm64; otherwise build them
   in CI.)
4. **Server serves the web build.** Add Hono static serving of `apps/web/dist` with an
   SPA fallback, **carefully preserving the route denylist** so backend routes
   (`/trpc`, `/files`, `/hooks`, `/daemon`, `/client`, `/health`, plus any asset
   routes) are not swallowed by the `index.html` fallback. (See the markdown-preview
   gotcha: new backend routes must be excluded from the SPA fallback.) Removes the
   production dependency on `vite preview`.
5. **`podium` CLI** — the headless interface. Subcommands:
   - `podium all` — combined server+daemon (host.ts) for a single box.
   - `podium server` — relay + web only.
   - `podium daemon` — agent host; flags for remote server URL + pairing.
   - `podium pair <code>` — pair this daemon to a server.
   - `podium update` — self-update (Component E).

### B — Tauri desktop shell (`apps/desktop`)

- Rust shell + OS webview. The bundled `podium-server` and `podium-daemon` are Tauri
  **sidecars** (or shell-spawned child processes), supervised by the shell.
- **First-run bootstrap:** choose a free local port (prefer 18787, fall back) → read or
  generate `~/.podium/daemon.secret` → start server → poll `/health` until ready →
  start daemon pointed at `127.0.0.1:PORT` with the secret and `machineId='local'` →
  load the bundled UI in the window, configured to talk to `127.0.0.1:PORT`.
- **Supervision:** restart crashed children with backoff; clean shutdown on quit
  (abduco masters must survive per existing cgroup-scope behavior); single-instance
  guard.
- **Tray / menu item:** status (running/connecting/error), Open, Quit, and
  "Connect to remote server…".
- **Mode switch:**
  - *This computer* (default) — embedded server + daemon.
  - *Connect to remote server* — enter URL + pairing; the shell then runs **only a
    local daemon** paired to the remote (so this machine contributes its agents), or
    acts as a **pure client** (no local daemon) if the user only wants to view/control
    remote machines. Bundled UI throughout.
- **Packaging outputs:** `.dmg`/`.app` (macOS, arm64 + x64), AppImage + `.deb` (Linux).

### C — Land multi-machine (branch `58399ee`)

- Rebase `worktree-multi-machine-agents` onto current `main`; resolve conflicts
  (expected in `packages/protocol/src/messages.ts` and `apps/daemon/src/daemon.ts`
  from the robustness-hardening commits).
- Delivers: `machineId` UUID join key + per-machine registry/routing; pairing-code
  auth; server-startup adoption of `__local__`→`local` (data cannot vanish even if no
  daemon registers); DB v4 migration; `MachinesPanel.tsx` + Settings→Machines;
  machine-aware New-panel dropdown; machine badge.
- This is what makes "add a daemon somewhere" real and provides the in-app Machines UI.
- Carry forward the hardening lessons from the prior rollback: the persistent same-host
  shared secret (`daemon.secret`) and startup adoption must both remain intact so the
  single-box mode never regresses.

### D — Distribution pipeline

- `bun run package:mac` / `package:linux` scripts that: build web → bundle backend →
  fetch/assemble Node + prebuilt node-pty + prebuilt abduco + web `dist` into the Tauri
  sidecar layout → invoke the Tauri bundler → emit installers.
- A separate headless artifact (tarball / container image) carrying the same bundled
  server/daemon for VPS + remote-daemon installs.
- CI matrix (mac-arm64, mac-x64, linux-x64; linux-arm64 if feasible) and website
  download links are a **follow-up**; the deliverable here is reproducible **local**
  installer builds.

### E — Updates & versioning

- **Desktop app:** Tauri's built-in updater. Checks an update manifest, downloads the
  signed new bundle (shell + bundled frontend + bundled server/daemon sidecars),
  installs on restart. Requires a Tauri **update-signing key** (distinct from OS
  code-signing) and a hosted **update feed**.
- **Headless server/daemon:** `podium update` self-update — fetch the new bundle from
  the same feed, swap it, restart the service (systemd/launchd). Container/package
  installs track release tags.
- **Release feed is pluggable:** a configurable base URL + manifest format implemented
  now; concrete host (Cloudflare R2 or GitHub Releases) chosen later.
- **Cross-version safety — protocol-version handshake:** because server, daemon, and
  clients can run different versions across machines, add a protocol/schema version to
  the connection handshake (server↔daemon and client↔server). On mismatch, surface an
  "update needed" banner in the UI rather than failing silently. **This lands in
  Phase 1** (cheap, and Phase 2's distributed mode needs it).

## Distributed scenarios (concrete walkthroughs)

1. **Out of the box (single box).** User downloads `Podium.dmg`, opens it. Tauri starts
   embedded server + daemon, opens the native window. Works offline, zero config.
2. **Move the server to a VPS.** User installs the headless bundle on a VPS
   (`podium server`), opens the firewall/TLS, and either (a) points a browser at it
   (web version) or (b) switches the desktop app to "Connect to remote server". The
   local daemon can stay (contributing this machine's agents) or be turned off.
3. **Add a daemon on another machine.** User installs the headless bundle on machine B
   (`podium daemon`), runs `podium pair <code>` (code generated by the server / Machines
   UI). Machine B appears in Settings→Machines; its repos/agents become selectable in
   the New-panel dropdown.
4. **Pure web user.** Someone who never installs the desktop app just opens the
   server's URL in a browser/phone and uses the served PWA.

## Phasing & verification

Each phase is independently verifiable; distributed mode is proven **before** the GUI.

1. **Backend shippable (A) + protocol-version handshake (E partial).**
   *Verify:* bundled `podium all` starts server+daemon with no repo checkout / no tsx;
   the server serves the web UI to a browser; node-pty + abduco resolve from shipped
   prebuilts; an agent spawns and streams. Handshake rejects/ warns on a forced
   version mismatch.
2. **Multi-machine (C).**
   *Verify:* rebased branch is green (typecheck + unit + e2e `multi-machine.e2e`,
   `split-local.e2e`); pair a second headless daemon to a server; its agents are
   controllable; `__local__`→`local` adoption holds; single-box mode unaffected.
3. **Tauri desktop (B).**
   *Verify:* an unsigned local `.app`/AppImage launches, bootstraps embedded
   server+daemon, opens the window ready-to-use; tray works; "Connect to remote server"
   switches modes; quit leaves abduco masters alive.
4. **Distribution (D).**
   *Verify:* `package:mac` and `package:linux` produce installers on a clean machine;
   the headless tarball/image runs `podium server`/`daemon`.
5. **Auto-update (E full).**
   *Verify:* desktop app detects a newer manifest, downloads, and updates on restart
   (against a local/staging feed); `podium update` self-updates a headless install.

Signing/notarization is layered on once the user supplies Apple credentials; it does
not gate phases 1–3.

## Risks & open questions

- **macOS signing/notarization** needs the user's Apple Developer ID + secrets. Wire
  the pipeline; produce unsigned builds until creds are provided.
- **node-pty prebuild coverage** for linux-arm64 / mac-arm64 — verify upstream
  prebuilds exist; build in CI otherwise.
- **Rebasing `58399ee`** over the hardening commits (conflicts in `messages.ts`,
  `daemon.ts`).
- **Node runtime embedding strategy** — pin a single Node ≥22; decide bundle vs Node
  SEA. Default: ship a pinned Node binary + bundled JS (most robust with native
  addons); revisit SEA later.
- **Windows** deferred; keep the abduco/PTY abstraction and packaging layout
  Windows-extensible.
- **Live-host caution:** implementation happens in a **worktree**, not the live `main`
  checkout (the live backend runs from main's working tree).

## Out of scope

- Windows installers; cloud sandbox orchestration; production feed-host + website;
  native mobile app.
