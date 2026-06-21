# Packaging & Distribution — Design

- **Date:** 2026-06-21
- **Status:** Revised after discovering the Bun migration already landed on `main`
  (`7ca3926`). Supersedes the first draft, which assumed a Node/tsx runtime and an
  esbuild bundle. Ready for an updated implementation plan.
- **Spec:** this document. Implementation plan: `docs/superpowers/plans/`.

## Goal

Offer Podium as **one download per operating system**. On first launch the download
gives the user a **server + daemon + native desktop client, all in one**, running on
their machine and ready out of the box with zero configuration.

The exact same artifacts must also run **headless and distributed from day one**: the
user can later move the server onto another box, and/or add daemons on other machines,
and manage all of it from an in-app **Machines** UI. Someone who does *not* run the
desktop app can connect an external client — a browser, a phone, or another desktop
app — to a machine that is already running.

Ship an **auto-update** mechanism for both the desktop app and headless deployments.

### "Single download" ≠ "single binary"

A single download is **one installer/bundle per OS**, not one executable file:

- **macOS:** a `.dmg` containing `Podium.app`. A `.app` is a *bundle* — one Finder
  icon, but internally a directory tree (`Contents/MacOS`, `Contents/Resources`,
  `Contents/Frameworks`). It holds the Tauri shell **plus** the `podium-server` and
  `podium-daemon` sidecar binaries **plus** the web assets as resources.
- **Linux:** an **AppImage** (a single file that mounts an internal directory tree at
  run time) and/or a **`.deb`** (installs a tree). Either is one download containing
  multiple sub-binaries.

So we use Tauri's **sidecar** model: the shell ships the two compiled Bun binaries and
supervises them. There is no need to fuse them into one executable, and no need to
embed the web build inside a binary.

### Scope of this effort

- Target **macOS + Linux**. Windows deferred (PTY/abduco story riskiest).
- Produce **working local installers** (`.dmg`/`.app`, AppImage/`.deb`). Code-signing
  and notarization are *wired* but need the user's Apple Developer credentials; unsigned
  local builds work meanwhile.
- **Full multi-machine** lands as part of this work (rebase the existing
  `worktree-multi-machine-agents` branch, head `bbc3485`).
- Auto-update is built against a **pluggable release-feed URL**; the concrete host
  (Cloudflare R2 vs GitHub Releases) is chosen later and does not block earlier phases.
- CI build matrix and website download wiring are a **follow-up**, not a blocker.

### Non-goals

- Windows packaging; cloud sandbox orchestration; production feed host + website;
  native mobile app (the browser/PWA path covers mobile).

## Background: what already exists (Bun migration, on `main`)

Confirmed 2026-06-21 at `main` `7ca3926`. The runtime moved from Node/tsx to **Bun**,
and `bun build --compile` is the chosen release mechanism. Already done:

- **Compiled single-file binaries** — `scripts/build-bun.ts` emits
  `dist-bun/podium-server` (entry `scripts/server.ts`) and `dist-bun/podium-daemon`
  (entry `scripts/daemon-compiled.ts`), ~98 MB each, standalone (no Bun/Node install).
  Current platform only — no `--target` cross-compile yet.
- **Embedded abduco** — `scripts/build-bun.ts` prebuilds the vendored abduco to
  `dist-bun/abduco.bin`; `scripts/embedded-abduco.ts` imports it
  `with { type: 'file' }` and, on first daemon start, materializes it to
  `~/.podium/bin/abduco` so `resolveAbducoBin()` finds it. **No C compiler needed on
  the user's machine.** The non-compiled source path keeps the cc-build fallback in
  `packages/agent-bridge/src/abduco-bin.ts`.
- **Runtime-neutral PTY** — `packages/agent-bridge/src/pty/` has a `PtyProcess`/
  `PtyBackend` interface (`types.ts`), a `node-pty` adapter, and a `Bun.Terminal`
  adapter, auto-selected (`PODIUM_PTY_BACKEND` overrides). `node-pty` is **no longer a
  hard dependency** — that was the entire reason Node used to be mandatory. Behavioral
  suite green on both backends.
- **Runtime-neutral SQLite** — `packages/core/src/sqlite/` shim dispatches `bun:sqlite`
  vs `node:sqlite`; `apps/server/src/store.ts` and discovery DBs consume it. Cross-
  runtime DB compatibility (WAL, FTS5) verified (`docs/bun-migration-readiness.md`).
- **Live backend runs under Bun from source** via the systemd units in
  `scripts/systemd/` (`bun --conditions=@podium/source scripts/{server,daemon}.ts`).

Already-existing reference docs to honor: `docs/bun-migration-readiness.md`,
`docs/superpowers/specs/2026-06-21-pty-backend-abstraction-design.md`.

### What is still missing for the goal

- Server does **not** serve the web UI yet (no static-file route in
  `apps/server/src`).
- No **wire protocol-version handshake** between client/server/daemon, and no
  `/version` route. (Note: `apps/server/src/mcp-route.ts` has a `PROTOCOL_VERSION`
  constant for the *MCP* spec date — unrelated; the wire version must use a distinct
  name, e.g. `WIRE_VERSION`.)
- No **cross-target** builds; embedded abduco is per-platform.
- No **Tauri shell** (`apps/desktop` absent), no **multi-machine** on `main` (branch
  `bbc3485` unmerged), no **auto-update**.

## Core model: roles are compiled binaries inside a bundle

The Bun migration gives us per-role compiled binaries. Distribution wraps them:

| Role | Artifact | Frontend source | Runs where |
|---|---|---|---|
| `podium-server` | compiled Bun binary | serves `web/` resource (external clients only) | anywhere (laptop, VPS) |
| `podium-daemon` | compiled Bun binary (abduco embedded) | — | any dev machine |
| `podium-desktop` | **Tauri** bundle embedding both sidecars + web resources | **Tauri-bundled** assets (`tauri://`) | the user's desktop |

The desktop bundle's sidecars **are** the headless binaries. So "move the server
elsewhere" = run `podium-server` on a box; "add a daemon elsewhere" = run
`podium-daemon` on another machine and pair it. One artifact set, both modes.

### How the web UI is delivered

- **Desktop window** loads the React build from **Tauri-bundled** assets via
  `tauri://` — *not* through the embedded webserver. Offline, instant, version-locked
  to the shell. Even when the desktop is pointed at a remote server, it keeps its
  bundled UI and only aims its **API** calls at the remote backend.
- **External clients** (a browser, a phone, another desktop app) connecting to a
  machine someone already started are served the React build by that machine's
  **`podium-server` over HTTP**. The web assets ship as a **resource folder** inside
  every bundle (`PODIUM_WEB_DIR`); the same folder backs both the Tauri window and the
  HTTP path. No web build is embedded into a binary.
- Version skew (a desktop's bundled UI vs a different-version remote server) is handled
  by the **wire protocol-version handshake** — on mismatch, surface "update needed".

## Components

### A — Finish the headless backend (mostly done)

Already done (above): compiled `podium-server` + `podium-daemon`, embedded abduco,
`Bun.Terminal` PTY, SQLite shim. **Remaining:**

1. **Server serves the web UI** for external clients: add a static-file route to the
   Hono app serving `PODIUM_WEB_DIR` (default `apps/web/dist`) with an SPA fallback
   that never shadows backend routes (`/trpc`, `/health`, `/version`, `/files`,
   `/client`, `/daemon`, `/hooks`, `/mcp`). Returns a no-op when no build is present.
2. **Wire protocol-version handshake**: a `WIRE_VERSION` constant in `@podium/protocol`;
   a `GET /version` route (`{ wireVersion, appVersion }`); reject an incompatible
   `?pv=` on the `/daemon` and `/client` WebSocket upgrades with HTTP 426; the daemon
   sends its `pv` and logs an update-needed message on rejection.
3. **Headless packaging layout**: extend `scripts/build-bun.ts` (or a new
   `scripts/package-headless.ts`) to assemble `dist-bun/headless/` = `podium-server` +
   `podium-daemon` + `web/` (a copy of `apps/web/dist`) + a small POSIX `podium`
   launcher script dispatching `server`/`daemon`/`all`, with `PODIUM_WEB_DIR` wired.
   This folder (tar/zip) is the headless "one download".

### B — Tauri desktop shell (`apps/desktop`)

- Rust shell + OS webview. The compiled `podium-server` and `podium-daemon` are Tauri
  **sidecars** (named with the target triple per Tauri convention), supervised by the
  shell. The web build is a Tauri resource (bundled UI).
- **First-run bootstrap:** choose a free local port (prefer 18787, fall back) → read or
  generate `~/.podium/daemon.secret` → start `podium-server` → poll `/health` → start
  `podium-daemon` (`machineId='local'`) → show the window on the bundled UI, pointed at
  `127.0.0.1:PORT`.
- **Supervision:** restart crashed sidecars with backoff; clean shutdown on quit
  (abduco masters survive in their own scopes); single-instance guard.
- **Tray/menu:** status, Open, Quit, "Connect to remote server…".
- **Mode switch:** *This computer* (embedded sidecars) vs *Connect to remote server*
  (URL + pairing; then run only a local daemon paired to the remote, or be a pure
  client). The embedded server still serves the bundled web folder to any external
  client (e.g. the user's phone) that connects to this machine.
- **Outputs:** `.dmg`/`.app` (macOS arm64 + x64), AppImage + `.deb` (Linux).

### C — Land multi-machine (branch `bbc3485`)

- Rebase `worktree-multi-machine-agents` onto current `main`; resolve conflicts
  (expected in `packages/protocol/src/messages.ts` and `apps/daemon/src/daemon.ts` —
  more than before, since the branch predates the Bun migration).
- Delivers: `machineId` UUID routing, pairing-code auth, server-startup adoption of
  `__local__`→`local`, DB v4 migration, `apps/web/src/MachinesPanel.tsx` +
  Settings→Machines, machine-aware New-panel + badge. This makes "add a daemon
  somewhere" real and provides the in-app Machines UI.
- Carry forward the prior hardening: the persistent same-host `daemon.secret` and the
  startup adoption must remain so single-box never regresses.

### D — Distribution pipeline

- **Cross-target builds:** `bun build --compile --target=bun-{darwin-arm64,darwin-x64,
  linux-x64,linux-arm64}`. The embedded abduco is platform-specific, so each target's
  abduco must be built for that platform — cleanest is a **CI matrix on native runners**
  (macOS runner builds macOS, Linux runner builds Linux), each prebuilding its own
  abduco. (zig-cc cross-compilation is a fallback if native runners are unavailable.)
- **Bundle assembly:** per OS, package the Tauri shell + sidecars + web resources into
  `.dmg`/`.app` and AppImage/`.deb`; assemble the headless tar/zip from Component A.3.
- CI wiring + website download links are a **follow-up**; the deliverable here is
  reproducible local installer + headless builds.

### E — Updates & versioning

- **Desktop app:** Tauri's built-in updater — checks an update manifest, downloads the
  signed new bundle (shell + bundled UI + sidecars), installs on restart. Needs a Tauri
  update-signing key (distinct from OS code-signing) and a hosted feed.
- **Headless:** a `podium update` action (the launcher script / a daemon subcommand)
  that fetches the new headless bundle from the same feed and swaps the binaries +
  web folder, then restarts the service (systemd/launchd). Container/package installs
  track release tags.
- **Release feed is pluggable** (configurable base URL + manifest format) now; host
  (Cloudflare R2 or GitHub Releases) chosen later.
- **Wire protocol-version handshake** (Component A.2) is the cross-version safety net;
  the client surfaces an "update needed" banner on mismatch (the banner UI lands with
  Phase 2's version-aware client work).

## Distributed scenarios

1. **Out of the box (single box).** Download `Podium.dmg`, open it. Tauri starts the
   embedded server + daemon sidecars, shows the native window on bundled UI. Offline,
   zero config.
2. **Connect a phone/browser to a started machine.** The embedded `podium-server`
   serves the web folder over HTTP; the user opens the machine's URL on their phone.
3. **Move the server to a VPS.** Install the headless bundle (`podium server`) on a
   VPS; point a browser at it, or switch the desktop app to "Connect to remote server".
4. **Add a daemon on another machine.** Install the headless bundle on machine B
   (`podium daemon`), run pairing; it appears in Settings→Machines; its repos/agents
   become selectable.

## Phasing & verification

1. **Finish headless backend (A).** Server serves web for external clients; wire
   version handshake; headless packaging layout.
   *Verify:* the `dist-bun/headless/` bundle runs `podium all` with nothing installed;
   an external browser loads the UI from the server; an agent spawns/streams under
   `Bun.Terminal`; `/version` reports `WIRE_VERSION`; the upgrade guard rejects a forced
   `pv` mismatch.
2. **Multi-machine (C).** Rebase + land the branch.
   *Verify:* rebased branch green (typecheck + unit + e2e); pair a second headless
   daemon to a server; `__local__`→`local` adoption holds; single-box unaffected.
3. **Tauri desktop (B).** The all-in-one native app + remote mode.
   *Verify:* an unsigned local `.app`/AppImage launches, bootstraps the sidecars, shows
   a ready window; tray works; remote-connect switches modes; a phone can reach the
   embedded server; quit leaves abduco masters alive.
4. **Distribution (D).** Cross-target CI matrix → installers + headless bundles.
   *Verify:* mac (arm64/x64) + linux (x64) artifacts build on native runners and run on
   clean machines.
5. **Auto-update (E).** Tauri updater + `podium update`.
   *Verify:* desktop updates from a newer manifest on restart (staging feed); headless
   self-updates.

Signing/notarization layers on once Apple credentials are supplied; it does not gate
phases 1–3.

## Risks & open questions

- **Cross-target abduco** — `bun build --compile --target` cross-compiles JS+runtime,
  but the embedded abduco is built with the host `cc`. Mitigation: native CI runners
  per OS (default), or zig-cc cross-compilation.
- **`Bun.Terminal` maturity** at scale (reattach, resize, many concurrent PTYs) — the
  behavioral suite passes; soak under real load during Phase 1/3.
- **Binary size** (~98 MB/binary; the desktop bundle ships two) — acceptable; revisit
  if it matters (shared-runtime options are limited with compile).
- **Rebasing `bbc3485`** over the Bun migration (more conflicts than the pre-Bun
  estimate).
- **macOS signing/notarization** needs the user's Apple Developer ID; produce unsigned
  builds until provided.
- **Live-host caution:** implement in a **worktree**, not the live `main` checkout.
- **Windows** deferred; keep the PTY/abduco/packaging layout Windows-extensible.
