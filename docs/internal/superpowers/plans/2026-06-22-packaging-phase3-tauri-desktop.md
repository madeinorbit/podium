# Packaging Phase 3 — Tauri Desktop Shell (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `apps/desktop` Tauri v2 app that, on launch, spawns the compiled `podium` backend as a sidecar, waits for it, points its bundled web UI at it, and shows a native window — producing a Linux AppImage (verified headlessly under Xvfb) and the structure for macOS `.dmg` (built on a Mac).

**Architecture:** A thin Rust shell wraps the **single compiled `podium` binary** (from Phase 2, which already runs all-in-one + serves the setup UI + materializes abduco + has the crash-net/watchdog). The shell picks a free port, spawns `podium` as a Tauri sidecar with `PODIUM_PORT`/`PODIUM_WEB_DIR`, polls `/health`, injects `window.__PODIUM_SERVER__` (the Phase 2 web seam), and shows the bundled UI (which then drives the shared setup screen). A tray controls lifecycle.

**Tech Stack:** Tauri v2 (Rust + system webview), `tauri-plugin-shell` (sidecars), Bun (`@tauri-apps/cli`, prebuild staging), the compiled `podium` from Phase 2. Builds on branch `feat/packaging-phase2`.

## Global Constraints

- **Base branch is `feat/packaging-phase2`** (`ba3b39a`) — Phase 3 wraps the Phase 2 `podium` binary + setup UI + `__PODIUM_SERVER__` seam.
- **Toolchain prerequisite (host):** Rust ≥1.77 via `~/.cargo/bin` (cargo 1.96 installed) AND the system webview libs from the documented `apt` install (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`, `libxdo-dev`, `libssl-dev`, `build-essential`, `pkg-config`, `xvfb`). Without these, `cargo build`/`tauri build` cannot run.
- **This host builds the Linux AppImage only.** macOS `.dmg`/`.app` (with the mac-triple `podium` binary) is built on a Mac/CI — out of scope for verification here.
- **One sidecar:** the compiled `podium` (Phase 2). Do NOT spawn `podium-server`/`podium-daemon` separately — `podium` does all-in-one in-process with the hardening.
- **Desktop window uses the BUNDLED UI** (`frontendDist` = `apps/web/dist`, loaded via `tauri://`), NOT the served web. The shell injects the backend via `window.__PODIUM_SERVER__ = "ws://127.0.0.1:<port>"`. The sidecar's `PODIUM_WEB_DIR` (a bundled resource) serves the web only to EXTERNAL clients (a phone).
- **Verification is build + Xvfb launch smoke**, not unit TDD (Rust/Tauri integration). A pure Rust helper (free-port) gets a `#[test]`. The cargo build compiling + the Xvfb smoke passing ARE the gates. The implementer iterates the Rust against the compiler — a non-compiling shell is a failed task.
- **Bundle id** `app.podium.desktop`; product name `Podium`.
- **Updater is DEFERRED to Phase 5** — do NOT add `plugins.updater`/`createUpdaterArtifacts` here (a placeholder pubkey would break the build).
- **Work in a git worktree off `feat/packaging-phase2`**, not the live `main` checkout. Cargo/PATH: prefix with `PATH="$HOME/.cargo/bin:$PATH"`. Commit per task.
- **Live-host smoke isolation:** run the built app with `PODIUM_STATE_DIR=$(mktemp -d)` and let the shell pick an ephemeral port; never collide with the live `:18787`/`~/.podium`. Clean up the spawned `podium*` processes by specific path, never broad `pkill`.

### Deferred to later phases
- Auto-update (Tauri updater + signing) → **Phase 5**.
- macOS `.dmg` build + signing/notarization → on a Mac/CI (Phase 4 distribution).
- "Connect to remote server" full UX beyond the setup screen's `client`/`daemon` modes → polish later; Phase 2's setup UI already covers choosing a remote `serverUrl`.

---

### Task 1: Scaffold `apps/desktop` + sidecar/web staging + a window showing the bundled UI

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/build.rs`
- Create: `apps/desktop/src-tauri/tauri.conf.json`
- Create: `apps/desktop/src-tauri/capabilities/default.json`
- Create: `apps/desktop/src-tauri/src/main.rs` (minimal: open the bundled UI; no backend yet)
- Create: `apps/desktop/scripts/stage-sidecar.ts` (prebuild: compile `podium`, stage triple-named sidecar + web resource)
- Create: `apps/desktop/.gitignore` (`src-tauri/target/`, `src-tauri/binaries/`, `src-tauri/resources/`)
- Modify: root `package.json` (add `desktop:build` script)

**Interfaces:**
- Produces: a buildable Tauri app. `stage-sidecar.ts` puts `dist-bun/podium` at `src-tauri/binaries/podium-<host-triple>` and `apps/web/dist` at `src-tauri/resources/web`. Task 2 adds the sidecar spawn to `main.rs`.

- [ ] **Step 1: Create the staging prebuild script**

Create `apps/desktop/scripts/stage-sidecar.ts`:

```ts
/**
 * Tauri prebuild: produce the compiled `podium` backend + web bundle, then stage them
 * where tauri.conf.json expects — the sidecar named with the host target triple, and the
 * web build as a bundled resource (PODIUM_WEB_DIR for external clients).
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const desktopDir = fileURLToPath(new URL('..', import.meta.url)) // apps/desktop/
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url)) // repo root

// 1. Build the backend (compiled podium) + web (dist-bun/headless/web + dist-bun/podium).
execFileSync('bun', ['run', 'package:headless'], { cwd: repoRoot, stdio: 'inherit' })

// 2. Host target triple (e.g. x86_64-unknown-linux-gnu) from rustc.
const vv = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
const triple = vv.split('\n').find((l) => l.startsWith('host: '))?.slice(6).trim()
if (!triple) throw new Error('could not determine rustc host triple')

// 3. Stage the sidecar binary, triple-suffixed.
const binDir = `${desktopDir}src-tauri/binaries`
rmSync(binDir, { recursive: true, force: true })
mkdirSync(binDir, { recursive: true })
const podium = `${repoRoot}/dist-bun/podium`
if (!existsSync(podium)) throw new Error(`missing ${podium} — package:headless did not produce it`)
cpSync(podium, `${binDir}/podium-${triple}`)
chmodSync(`${binDir}/podium-${triple}`, 0o755)

// 4. Stage the web bundle as a resource (served to external clients via PODIUM_WEB_DIR).
const webSrc = `${repoRoot}/apps/web/dist`
const webDst = `${desktopDir}src-tauri/resources/web`
rmSync(webDst, { recursive: true, force: true })
mkdirSync(`${desktopDir}src-tauri/resources`, { recursive: true })
cpSync(webSrc, webDst, { recursive: true })

console.log(`[stage-sidecar] podium-${triple} + resources/web staged`)
```

- [ ] **Step 2: Create `apps/desktop/package.json`**

```json
{
  "name": "@podium/desktop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "stage": "bun scripts/stage-sidecar.ts",
    "build": "bun scripts/stage-sidecar.ts && tauri build",
    "dev": "bun scripts/stage-sidecar.ts && tauri dev"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2"
  }
}
```

In the root `package.json` `scripts`, add:

```json
    "desktop:build": "bun run --cwd apps/desktop build",
```

- [ ] **Step 3: Create the Rust crate manifest + build script**

`apps/desktop/src-tauri/Cargo.toml`:

```toml
[package]
name = "podium-desktop"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"

[profile.release]
panic = "abort"
codegen-units = 1
lto = true
strip = true
```

`apps/desktop/src-tauri/build.rs`:

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 4: Create `tauri.conf.json`**

`apps/desktop/src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Podium",
  "version": "0.1.0",
  "identifier": "app.podium.desktop",
  "build": {
    "frontendDist": "../../web/dist"
  },
  "app": {
    "windows": [],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": ["appimage", "deb"],
    "externalBin": ["binaries/podium"],
    "resources": ["resources/web"],
    "icon": ["icons/icon.png"]
  }
}
```

> Note: `windows: []` — the window is created programmatically in `main.rs` (Task 2) so the backend can be up first. For Task 1's minimal check, a window IS created in `main.rs` (below). Provide an `icons/icon.png` (copy any existing 512×512 PNG, e.g. from `apps/web` PWA assets, into `src-tauri/icons/icon.png`); `tauri build` requires at least one icon.

- [ ] **Step 5: Create the capabilities file**

`apps/desktop/src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Podium desktop default capabilities",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-create",
    "core:webview:allow-create-webview-window",
    {
      "identifier": "shell:allow-spawn",
      "allow": [{ "name": "binaries/podium", "sidecar": true }]
    }
  ]
}
```

- [ ] **Step 6: Create the minimal `main.rs` (window only, no backend yet)**

`apps/desktop/src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Podium")
                .inner_size(1200.0, 800.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Podium");
}
```

- [ ] **Step 7: Stage + build the AppImage**

```bash
cd apps/desktop
PATH="$HOME/.cargo/bin:$PATH" bun install
PATH="$HOME/.cargo/bin:$PATH" bun run build 2>&1 | tail -30
```
Expected: `stage-sidecar` stages `podium-<triple>` + `resources/web`; cargo compiles; an AppImage appears under `src-tauri/target/release/bundle/appimage/*.AppImage`. Confirm:

```bash
ls -1 apps/desktop/src-tauri/target/release/bundle/appimage/
```

> If cargo errors, fix `main.rs`/`Cargo.toml` against the compiler until it builds — a non-compiling shell is a failed task. If `tauri` CLI isn't found, invoke via `bunx tauri build`.

- [ ] **Step 8: Xvfb launch smoke (window opens)**

```bash
APPIMAGE=$(ls apps/desktop/src-tauri/target/release/bundle/appimage/*.AppImage | head -1)
PATH="$HOME/.cargo/bin:$PATH" timeout 20 xvfb-run -a "$APPIMAGE" --appimage-extract-and-run 2>&1 | tail -15 &
sleep 12
# The process should be alive (window created under Xvfb) and not have crashed.
pgrep -f "$(basename "$APPIMAGE")" >/dev/null && echo "DESKTOP WINDOW PROCESS ALIVE ✓" || echo "process not found"
pkill -f "$(basename "$APPIMAGE")" 2>/dev/null; pkill -f appimage 2>/dev/null || true
```
Expected: `DESKTOP WINDOW PROCESS ALIVE ✓` (the bundled UI loads in a window; it can't reach a backend yet — that's Task 2). No crash/panic in the output.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop root-relative package.json
git add apps/desktop
git -C "$(git rev-parse --show-toplevel)" add package.json
git commit -m "feat(desktop): scaffold Tauri v2 app + sidecar/web staging + bundled-UI window"
```

---

### Task 2: First-run bootstrap — spawn the `podium` sidecar, wait, inject backend

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs` (spawn sidecar, poll health, inject `__PODIUM_SERVER__`, build window after ready)
- Create: `apps/desktop/src-tauri/src/bootstrap.rs` (pure helpers + the spawn/wait logic)
- Modify: `apps/desktop/src-tauri/Cargo.toml` (no new deps — use std TCP for the readiness probe)

**Interfaces:**
- Consumes: the staged `podium` sidecar (Task 1).
- Produces: on launch, a running `podium` (env `PODIUM_PORT`=free port, `PODIUM_WEB_DIR`=resource web dir), and the window loads the bundled UI with `window.__PODIUM_SERVER__ = "ws://127.0.0.1:<port>"`. Pure `pick_free_port() -> u16` + `injection_script(port: u16) -> String` are unit-tested.

- [ ] **Step 1: Write the failing Rust unit test (pure helpers)**

Create `apps/desktop/src-tauri/src/bootstrap.rs`:

```rust
use std::net::TcpListener;

/// Bind an ephemeral loopback port and return it (best-effort; falls back to 18787).
pub fn pick_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(18787)
}

/// The script injected before page load so the bundled web UI talks to the local backend
/// (Phase 2 serverConfig reads window.__PODIUM_SERVER__ first).
pub fn injection_script(port: u16) -> String {
    format!("window.__PODIUM_SERVER__ = 'ws://127.0.0.1:{port}';")
}

/// Block until http://127.0.0.1:<port>/health accepts a TCP connection or the budget runs
/// out. Returns true if the port became reachable. (A TCP connect is enough — the server
/// only binds once it is serving.)
pub fn wait_for_port(port: u16, attempts: u32, delay_ms: u64) -> bool {
    use std::net::TcpStream;
    for _ in 0..attempts {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_free_port_is_nonzero() {
        assert!(pick_free_port() > 0);
    }

    #[test]
    fn injection_script_embeds_the_port() {
        let s = injection_script(18799);
        assert!(s.contains("ws://127.0.0.1:18799"));
        assert!(s.contains("__PODIUM_SERVER__"));
    }

    #[test]
    fn wait_for_port_times_out_on_a_closed_port() {
        // A port nothing is listening on returns false quickly.
        assert!(!wait_for_port(1, 2, 10));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails (module not wired)**

Run: `cd apps/desktop/src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test --lib 2>&1 | tail -20`
Expected: FAIL — `bootstrap` is not a module yet (or no lib target). If the crate has no lib target, add `mod bootstrap;` to `main.rs` (Step 4) first, then this compiles and the 3 tests run.

- [ ] **Step 3: Keep `bootstrap.rs` as written (it already contains the impl + tests).**

(The TDD RED here is the missing module wiring; GREEN is after `main.rs` declares `mod bootstrap;`.)

- [ ] **Step 4: Wire the bootstrap into `main.rs`**

Replace `apps/desktop/src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bootstrap;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::ShellExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let port = bootstrap::pick_free_port();

            // Resolve the bundled web resource dir for the sidecar to serve external clients.
            let web_dir = app
                .path()
                .resource_dir()
                .map(|d| d.join("resources").join("web"))
                .map(|d| d.to_string_lossy().to_string())
                .unwrap_or_default();

            // Spawn the compiled podium backend (all-in-one + setup UI + abduco materialize).
            let mut cmd = app
                .shell()
                .sidecar("podium")?
                .env("PODIUM_PORT", port.to_string());
            if !web_dir.is_empty() {
                cmd = cmd.env("PODIUM_WEB_DIR", web_dir);
            }
            let (mut rx, _child) = cmd.spawn()?;

            // Surface sidecar output to the shell's stdout for debugging.
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                            eprint!("[podium] {}", String::from_utf8_lossy(&b));
                        }
                        _ => {}
                    }
                }
            });

            // Once the backend is listening, show the window pointed at it.
            let handle = app.handle().clone();
            let init = bootstrap::injection_script(port);
            std::thread::spawn(move || {
                bootstrap::wait_for_port(port, 200, 150);
                let _ = handle.run_on_main_thread(move || {
                    let _ = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::default())
                        .title("Podium")
                        .inner_size(1200.0, 800.0)
                        .initialization_script(&init)
                        .build();
                });
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Podium");
}
```

> The window is built on the main thread after the port is reachable. `run_on_main_thread` moves a second `handle` — clone as needed to satisfy the borrow checker; adjust against the compiler.

- [ ] **Step 5: Run the unit tests (GREEN)**

Run: `cd apps/desktop/src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test --lib 2>&1 | tail -20`
Expected: 3 tests pass (`pick_free_port_is_nonzero`, `injection_script_embeds_the_port`, `wait_for_port_times_out_on_a_closed_port`).

- [ ] **Step 6: Rebuild + Xvfb end-to-end smoke (window + live backend)**

```bash
cd apps/desktop && PATH="$HOME/.cargo/bin:$PATH" bun run build 2>&1 | tail -20
APPIMAGE=$(ls src-tauri/target/release/bundle/appimage/*.AppImage | head -1)
SMOKE_STATE=$(mktemp -d)
PODIUM_STATE_DIR="$SMOKE_STATE" timeout 30 xvfb-run -a "$APPIMAGE" --appimage-extract-and-run 2>&1 | tee /tmp/podium-desktop-smoke.log | tail -20 &
sleep 18
# The sidecar should be up; find its port from the log and probe it.
PORT=$(grep -oE 'http://localhost:[0-9]+' /tmp/podium-desktop-smoke.log | head -1 | grep -oE '[0-9]+$')
echo "sidecar port: $PORT"
[ -n "$PORT" ] && curl -fsS "http://127.0.0.1:$PORT/health"; echo
[ -n "$PORT" ] && curl -fsS "http://127.0.0.1:$PORT/setup/config"; echo
pkill -f "$(basename "$APPIMAGE")" 2>/dev/null; pkill -f 'dist-bun\|podium-x86\|/tmp/.mount' 2>/dev/null || true
rm -rf "$SMOKE_STATE"
```
Expected: the log shows `podium server up on http://localhost:<port>`; `/health` → `ok`; `/setup/config` → `{"config":{},"needsSetup":true}`. This proves: AppImage launches under Xvfb, the shell spawned the `podium` sidecar, the backend is reachable, and an external client could load the served UI.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/bootstrap.rs apps/desktop/src-tauri/src/main.rs apps/desktop/src-tauri/Cargo.toml
git commit -m "feat(desktop): bootstrap — spawn podium sidecar, await /health, inject backend into bundled UI"
```

---

### Task 3: Tray, clean shutdown, single-instance + final end-to-end smoke

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs` (tray menu; terminate sidecar on exit; show/focus window)
- Modify: `apps/desktop/src-tauri/Cargo.toml` (enable `tauri` `tray-icon` feature)
- Modify: `apps/desktop/src-tauri/capabilities/default.json` (tray permissions if needed)

**Interfaces:**
- Consumes: Task 2 bootstrap.
- Produces: a tray icon with Open / Quit; quitting terminates the `podium` sidecar child; the app keeps the sidecar handle to kill on exit.

- [ ] **Step 1: Enable the tray feature**

In `apps/desktop/src-tauri/Cargo.toml`, change the `tauri` dependency to:

```toml
tauri = { version = "2", features = ["tray-icon"] }
```

- [ ] **Step 2: Add tray + shutdown to `main.rs`**

Keep the Task 2 `setup` body; capture the sidecar `child` (rename `_child` → `child`) and store it so it can be killed on exit, and add a tray. Add near the top of `main()` imports:

```rust
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
```

Inside `setup`, after spawning the sidecar, keep the child for shutdown and build a tray:

```rust
            // Keep the sidecar child so we can terminate it when the app quits.
            app.manage(std::sync::Mutex::new(Some(child)));

            let open = MenuItem::with_id(app, "open", "Open Podium", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
```

Add an exit handler that kills the sidecar. After `.setup(...)` and before `.run(...)`, chain:

```rust
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>>() {
                    if let Some(child) = state.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        })
```

> The exact `CommandChild` type path / `app.manage` generic must match the live `tauri-plugin-shell` API — adjust against the compiler. The intent: the `podium` sidecar is terminated when the app quits (abduco masters survive independently; on Linux they're in their own systemd scope, on macOS the daemon's detached-fallback handles it — see the spec's macOS abduco note, which `podium`/agent-bridge owns, not the shell).

- [ ] **Step 3: Build + run the unit tests (unchanged, still green)**

```bash
cd apps/desktop/src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test --lib 2>&1 | tail -10
```
Expected: the 3 bootstrap tests still pass.

- [ ] **Step 4: Rebuild + final Xvfb end-to-end smoke**

```bash
cd apps/desktop && PATH="$HOME/.cargo/bin:$PATH" bun run build 2>&1 | tail -20
APPIMAGE=$(ls src-tauri/target/release/bundle/appimage/*.AppImage | head -1)
SMOKE_STATE=$(mktemp -d)
PODIUM_STATE_DIR="$SMOKE_STATE" timeout 35 xvfb-run -a "$APPIMAGE" --appimage-extract-and-run 2>&1 | tee /tmp/podium-desktop-smoke2.log | tail -20 &
sleep 18
PORT=$(grep -oE 'http://localhost:[0-9]+' /tmp/podium-desktop-smoke2.log | head -1 | grep -oE '[0-9]+$')
echo "port=$PORT"
[ -n "$PORT" ] && curl -fsS "http://127.0.0.1:$PORT/health"; echo                  # ok
[ -n "$PORT" ] && curl -fsS -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/"  # 200 (served web for a phone)
# verify abduco materialized into the isolated state dir (single-download promise)
ls "$SMOKE_STATE/bin/abduco" >/dev/null 2>&1 && echo "abduco materialized ✓" || echo "abduco MISSING"
pkill -f "$(basename "$APPIMAGE")" 2>/dev/null; pkill -f '/tmp/.mount' 2>/dev/null || true
rm -rf "$SMOKE_STATE"
```
Expected: `/health`=ok; `/`=200; `abduco materialized ✓`. The full desktop path works headlessly: window + tray + sidecar + served UI + durable-session prerequisite.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/main.rs apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/capabilities/default.json
git commit -m "feat(desktop): tray (Open/Quit) + terminate sidecar on exit; final Xvfb e2e smoke"
```

---

## Self-Review

**Spec coverage (Component B):**
- Tauri shell + OS webview wrapping the compiled binary as a sidecar → Tasks 1–2. ✓
- First-run bootstrap (free port → spawn → wait `/health` → show window, backend from config/injection) → Task 2. ✓ (uses `__PODIUM_SERVER__`, the Phase 2 seam.)
- Bundled UI for the window; served web (resource) for external clients via `PODIUM_WEB_DIR` → Tasks 1–2. ✓
- Tray (status/Open/Quit) + terminate sidecar on quit → Task 3. ✓
- Outputs: AppImage + `.deb` (Linux) here; macOS `.dmg` on a Mac → Task 1 `bundle.targets`, verification scoped to Linux/Xvfb per Global Constraints. ✓
- Drives the shared setup UI in-window (preselect `all-in-one`) → falls out: the bundled UI's SetupGate (Phase 2) shows SetupView when `needsSetup`; `podium` no-config defaults to all-in-one. ✓
- macOS abduco-without-systemd fallback → noted as owned by `podium`/agent-bridge (not the shell); flagged for the Mac build, not implemented in this Linux-scoped phase.
- Updater → deferred to Phase 5 (explicitly excluded). ✓

**Placeholder scan:** No "TBD"/"add error handling". The Rust blocks are concrete; the explicit "adjust against the compiler" notes are real guidance for a from-scratch Rust crate where the build is the gate, not hand-waving — each names the exact API risk (handle clones, `CommandChild` path).

**Type/name consistency:** `pick_free_port()`, `injection_script(port)`, `wait_for_port(port, attempts, delay_ms)` defined in `bootstrap.rs` (Task 2) and used in `main.rs` identically. Sidecar name `podium` matches `externalBin: ["binaries/podium"]` (Task 1), the capability allow-list, and `stage-sidecar.ts`'s `podium-<triple>` output. `PODIUM_PORT`/`PODIUM_WEB_DIR`/`PODIUM_STATE_DIR` env names match Phase 1/2.

## What Phase 3 delivers

A `Podium.AppImage` (and `.deb`) that opens a native window, spawns the all-in-one `podium` backend, and shows the bundled UI driving the shared setup flow — verified headlessly under Xvfb (window alive, `/health` ok, served UI 200, abduco materialized). The macOS `.dmg` reuses the same crate + staging on a Mac. Phase 4 wires the cross-platform CI matrix; Phase 5 adds the Tauri updater.
