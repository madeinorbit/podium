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

### F — Shared setup & deployment modes (the foundation under B)

Setup (choosing how this install runs) is **one shared layer** with multiple drivers —
the desktop window and the CLI are just two ways into the same step. Deployment **modes
are orthogonal to entry path**: e.g. all-in-one runs in the Tauri window *or* headless
on a box reached via the web client.

**Deployment modes** (what setup chooses):

| Mode | Local server | Local daemon | Typical use |
|---|---|---|---|
| `all-in-one` | ✓ | ✓ | desktop default; also headless `podium all` + remote web access |
| `daemon` | — | ✓ | contribute this machine's agents to a remote server |
| `client` | — | — | a UI pointing at a remote server (Tauri-as-remote-client; or browser) |
| `server` | ✓ | — | headless relay (VPS); daemons live elsewhere |

**Shared pieces:**
- **Config** — `~/.podium/config.json` (`{ mode, serverUrl?, pairing?, port? }`), the
  single source of truth both drivers read; mode decides which processes start.
- **Mode-driven launcher** — the `podium` CLI/launcher reads config + flags and starts
  the right processes (supersedes Phase 1's fixed `all`/`server`/`daemon` dispatch).
- **Setup web UI + setup API** — a screen in `apps/web` + a small backend route that
  writes the config. Built once, reused by every driver.
- **Backend discovery in the web client** — `apps/web/src/trpc.ts serverConfig` learns
  its backend from injected config (Tauri) / served config (headless), falling back to
  `window.location` for the plain same-origin browser case. (Subsumes the old "wrinkle 1".)

**Drivers:**
- **CLI** — `podium` with no config starts minimal and **prints the setup URL** to the
  shared web UI (open locally or from a phone); explicit flags / a pre-written config
  skip it for ops/headless (`podium all`, `podium daemon --server URL --pair CODE`, …).
- **Tauri** (Phase 3) shows the same setup UI **in-window on first run**, mode
  preselected to `all-in-one` ("This computer"), with a startup/settings control to
  switch to an external server.
- **Non-interactive** — flags or a committed `config.json` (automation, systemd, CI).

This phase is fully buildable + verifiable on a headless Linux host (web + CLI + config;
no Tauri): `podium` → setup URL → pick all-in-one → reach it from a browser; pick
`daemon` → it joins a remote relay.

### B — Tauri desktop shell (`apps/desktop`)

- Rust shell + OS webview. The compiled `podium-server` and `podium-daemon` are Tauri
  **sidecars** (named with the target triple per Tauri convention), supervised by the
  shell. The web build is a Tauri resource (bundled UI).
- **First-run:** drives the **shared setup UI** (Component F) in-window, mode preselected
  to `all-in-one`. Once a mode is chosen, bootstrap = choose a free local port (prefer
  18787) → read/generate `~/.podium/daemon.secret` → start the processes the mode calls
  for (server and/or daemon) → poll `/health` → show the window on the bundled UI,
  pointed at the backend from config (injected, per Component F).
- **Supervision:** restart crashed sidecars with backoff; clean shutdown on quit;
  single-instance guard. **abduco master lifecycle without systemd** (macOS has no
  `systemd --user` scope) needs a detached-process fallback (`setsid`/double-fork) so
  durable agents survive an app relaunch; Linux desktop keeps the systemd-scope path.
- **Tray/menu:** status, Open, Quit, "Connect to remote server…" (re-opens setup).
- **Mode switch:** the same setup UI — `all-in-one` ("This computer") vs an external
  server (`client`, or `daemon` contributing this machine). The embedded server still
  serves the bundled web folder to any external client (e.g. a phone) on this machine.
- **Verification here:** build a Linux AppImage and launch it under **Xvfb** (this host
  is headless) to confirm sidecars spawn, `/health` is ok, the window creates, and a
  phone can reach the server. Visual UI + macOS `.dmg`/`.app` are verified on a Mac/CI.
- **Outputs:** `.dmg`/`.app` (macOS arm64 + x64), AppImage + `.deb` (Linux).

### C — Multi-machine (DEFERRED to last; RE-IMPLEMENT, do not rebase)

**Decision (2026-06-21):** defer multi-machine to the final phase and **re-implement it
fresh on Bun `main`**, rather than rebasing the pre-Bun implementation branch
(`worktree-multi-machine-agents-impl`, `e897e60`). Evidence: a trial merge produced 12
conflicts in core files, and the substrate moved underneath the branch — `store.ts` now
goes through the SQLite shim (the branch used `node:sqlite` `DatabaseSync` directly),
`daemon.ts` grew ~600 LOC of new agent observers (Cursor/Opencode/Codex) + quota/upload
the branch never integrated with, and `relay.ts`'s `SessionRegistry` is rewritten on
both sides. The heavy files (`relay`, `daemon`, `store`, `wsServer`) would be rewritten
either way, so a clean re-implementation guided by the branch's design + code + tests is
lower-risk than fighting the rebase. The existing branch stays as the reference; its
design doc (`docs/superpowers/specs/2026-06-17-multi-machine-agents-design.md`) and plan
(`docs/superpowers/plans/2026-06-17-multi-machine-agents.md`) are the spec.

- Delivers (unchanged): `machineId` UUID routing, pairing-code auth, server-startup
  adoption of `__local__`→`local`, DB v4 migration, `apps/web/src/MachinesPanel.tsx` +
  Settings→Machines, machine-aware New-panel + badge. Makes "add a daemon somewhere"
  real and provides the in-app Machines UI.
- Re-implement Bun-native from day one (shim + PtyProcess), integrating with the 5
  current agent kinds; carry forward the same-host `daemon.secret` + startup adoption so
  single-box never regresses.
- Until this lands, the Tauri shell's "Connect to remote server" supports the
  single-server / single-daemon case (remote URL); multi-daemon fan-out arrives here.

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
  the version-aware client work in the multi-machine phase, when cross-version peers
  first actually exist).

## Distributed scenarios

1. **Out of the box (desktop).** Download `Podium.dmg`, open it. Tauri runs the shared
   setup (preselected `all-in-one`), starts the embedded server + daemon sidecars, shows
   the native window on bundled UI. Offline, zero config.
2. **Headless all-in-one + remote web.** Run `podium` on a box (no desktop app); open the
   printed setup URL, pick `all-in-one`; reach the served web UI from a browser/phone.
3. **Connect a phone/browser to a started machine.** Any running `podium-server` serves
   the web folder over HTTP; open the machine's URL on a phone.
4. **Move the server to a VPS.** Install the headless bundle (`podium server`) on a
   VPS; point a browser at it, or switch the desktop app to "Connect to remote server".
5. **Add a daemon on another machine.** Install the headless bundle on machine B
   (`podium daemon`), run pairing; it appears in Settings→Machines; its repos/agents
   become selectable (multi-machine phase).

## Phasing & verification

**Re-sequenced 2026-06-21:** multi-machine moved to last (re-implement, not rebase — see
Component C). Packaging proceeds first; multi-machine lands on top of finished packaging.

1. **Finish headless backend (A).** ✅ DONE — branch `feat/packaging-phase1` (parked,
   unmerged). Server serves web for external clients; `WIRE_VERSION` handshake (`/version`
   + `pv` upgrade guard + daemon `pv`); `dist-bun/headless/` bundle (binaries + web +
   `podium` launcher). Verified: bundle runs `podium all` standalone; external browser
   loads UI; `/version` reports `WIRE_VERSION`; upgrade guard rejects forced `pv` mismatch.
2. **Shared setup & deployment modes (F).** Fully verifiable on this headless Linux host
   (no Tauri). Config schema + mode-driven `podium` launcher + shared setup web UI/API +
   config-driven backend discovery in the web client.
   *Verify:* `podium` with no config prints a setup URL; the setup UI writes config;
   `all-in-one` is reachable from a browser; `daemon` mode joins a remote relay; flags/
   committed config skip the UI.
3. **Tauri desktop (B).** Wraps Phase 2; drives the same setup UI in-window (preselect
   `all-in-one`) + tray + supervision; macOS abduco-without-systemd fallback.
   *Verify:* an unsigned Linux AppImage launches under Xvfb, runs setup, bootstraps the
   mode's processes, shows a ready window, a phone reaches the server; macOS `.dmg` on a Mac.
4. **Distribution (D).** Cross-target CI matrix → installers + headless bundles.
   *Verify:* mac (arm64/x64) + linux (x64) artifacts build on native runners and run on
   clean machines.
5. **Auto-update (E).** Tauri updater + `podium update`.
   *Verify:* desktop updates from a newer manifest on restart (staging feed); headless
   self-updates.
6. **Multi-machine (C).** Re-implement fresh on Bun `main` (last).
   *Verify:* unit + e2e green; pair a second headless daemon to a server; `__local__`→
   `local` adoption holds; single-box unaffected.

Signing/notarization layers on once Apple credentials are supplied; it does not gate
phases 2–3.

## Risks & open questions

- **Cross-target abduco** — `bun build --compile --target` cross-compiles JS+runtime,
  but the embedded abduco is built with the host `cc`. Mitigation: native CI runners
  per OS (default), or zig-cc cross-compilation.
- **`Bun.Terminal` maturity** at scale (reattach, resize, many concurrent PTYs) — the
  behavioral suite passes; soak under real load during Phase 1/3.
- **Binary size** (~98 MB/binary; the desktop bundle ships two) — acceptable; revisit
  if it matters (shared-runtime options are limited with compile).
- **Multi-machine re-implementation fidelity** — re-implementing fresh (not rebasing)
  risks missing a subtlety the original branch solved; mitigate by using the branch's
  code + tests as a per-file reference during the (final) phase.
- **macOS signing/notarization** needs the user's Apple Developer ID; produce unsigned
  builds until provided.
- **Live-host caution:** implement in a **worktree**, not the live `main` checkout.
- **Windows** deferred; keep the PTY/abduco/packaging layout Windows-extensible.
