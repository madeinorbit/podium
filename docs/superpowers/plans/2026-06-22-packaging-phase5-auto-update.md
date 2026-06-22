# Packaging Phase 5 — Auto-Update (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Dispatch subagents on **opus** (see [[dispatch-opus-by-default]]).

**Goal:** The desktop app checks a pluggable release feed on launch and, if a newer signed version exists, prompts the user and self-updates + relaunches; and a headless `podium update` does the equivalent for the headless bundle — both verified end-to-end (v0.1.0 → v0.1.1) against a local static feed.

**Architecture:** Desktop uses `tauri-plugin-updater` + `tauri-plugin-dialog`, driven from Rust in the shell (so `apps/web`, shared with the browser, gains no Tauri-only deps): on launch, check the feed → if update, ask → `download_and_install` → `restart`. Headless adds a `podium update` CLI path that fetches the same-format manifest, compares versions, downloads + atomically swaps the headless bundle, and re-execs. A dev signing keypair (committed pubkey, secret private key) signs artifacts; verification serves v0.1.1 from a local HTTP feed and confirms the running v0.1.0 upgrades.

**Tech Stack:** Tauri v2 (`tauri-plugin-updater`, `tauri-plugin-dialog`, `tauri-plugin-process`), Bun, the compiled `podium` (Phase 2/3). Builds on branch `feat/packaging-phase3`.

## Global Constraints

- **Base branch is `feat/packaging-phase3`** (`7aa3792`) — Phase 5 extends the desktop shell + the `podium` CLI.
- **Toolchain:** cargo 1.96 (`~/.cargo/bin` — prefix cargo/tauri/bun with `PATH="$HOME/.cargo/bin:$PATH"`), webkit2gtk-4.1 + gtk3 + soup3 + rsvg + appindicator + xvfb installed. Slow Tauri builds → run backgrounded + poll, never foreground (10-min cap).
- **Desktop update UX = prompt-then-restart:** check on launch; if an update exists, a dialog asks "Update available — restart to apply?"; only on confirm download + relaunch. No silent restarts.
- **Drive the desktop update from Rust** (`tauri-plugin-updater`/`-dialog`/`-process`) — do NOT add Tauri-only JS deps to `apps/web` (it's the shared browser UI too).
- **Signing:** generate a DEV keypair (`tauri signer generate`); commit the **pubkey** in `tauri.conf.json`; do NOT commit the private key (gitignore it; pass via `TAURI_SIGNING_PRIVATE_KEY` at build). Document swapping in the production key.
- **Release feed is pluggable:** the updater endpoint + the `podium update` feed base read from config/env (default a localhost URL for verification); production host (R2/GitHub) chosen later. Manifest schema = Tauri's `{ version, notes, pub_date, platforms: { "<target>-<arch>": { signature, url } } }`.
- **Verification is two real builds + a local feed + an Xvfb update run** (build is the gate). Linux AppImage only; macOS update is verified on a Mac.
- **Live-host isolation:** all smokes use `PODIUM_STATE_DIR=$(mktemp -d)`, ephemeral ports, and a local feed on a non-standard port; never touch live `:18787`/`~/.podium`; clean up by specific path.
- **Work in a git worktree off `feat/packaging-phase3`.** Commit per task.

### Deferred
- Production feed host + the production signing key (yours) → wired at release.
- macOS `.dmg`/`.app.tar.gz` update + notarization → on a Mac.
- Cross-distro AppImage portability (`patchelf`) → Phase 4 / distributable cut.

### Known integration risk (flag for implementers)
Tauri's AppImage updater replaces the file at `$APPIMAGE`. Under `--appimage-extract-and-run` (used for headless Xvfb when FUSE is absent) `$APPIMAGE` semantics differ. The e2e implementer must set/realize the update target correctly (e.g. run the real AppImage with FUSE if available, or set `APPIMAGE` to the on-disk file). The gate is "running v0.1.0 ends up v0.1.1"; iterate the mechanism to achieve it, and if AppImage self-replacement proves infeasible headlessly, verify the updater's check+download+signature-verify stages programmatically and document the install-step limitation honestly.

---

### Task 1: Desktop updater — plugins, config, dev signing key, prompt-then-restart (Rust)

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml` (add updater/dialog/process plugins)
- Modify: `apps/desktop/src-tauri/tauri.conf.json` (createUpdaterArtifacts + plugins.updater pubkey/endpoints)
- Modify: `apps/desktop/src-tauri/capabilities/default.json` (updater/dialog/process perms)
- Modify: `apps/desktop/src-tauri/src/main.rs` (check-on-launch → ask → install → restart)
- Create: `apps/desktop/src-tauri/src/updater.rs` (the update-check flow, isolated)
- Modify: `apps/desktop/.gitignore` (ignore the dev private key if placed in-tree)

**Interfaces:**
- Produces: a `check_and_prompt_update(app: &tauri::AppHandle)` flow (in `updater.rs`) invoked from `setup`. Pure helper `feed_endpoint(base: &str) -> String` builds the templated endpoint; unit-tested.

- [ ] **Step 1: Generate the dev signing key (not committed)**

```bash
cd apps/desktop
PATH="$HOME/.cargo/bin:$PATH" bunx tauri signer generate -w ./.tauri-dev-signing.key --password "" 2>&1 | tail -20
```
This prints the **public key** (and writes the private key to `./.tauri-dev-signing.key`). Copy the printed public key for Step 3. Add `.tauri-dev-signing.key` and `.tauri-dev-signing.key.pub` to `apps/desktop/.gitignore`. (For builds, export `TAURI_SIGNING_PRIVATE_KEY="$(cat apps/desktop/.tauri-dev-signing.key)"` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""`.)

- [ ] **Step 2: Add the plugin deps**

In `apps/desktop/src-tauri/Cargo.toml` `[dependencies]`:

```toml
tauri-plugin-updater = "2"
tauri-plugin-dialog = "2"
tauri-plugin-process = "2"
```

- [ ] **Step 3: Configure the updater + artifacts**

In `apps/desktop/src-tauri/tauri.conf.json`, set `bundle.createUpdaterArtifacts: true` and add a `plugins.updater` block (paste the pubkey from Step 1):

```json
  "bundle": {
    "active": true,
    "targets": ["appimage", "deb"],
    "resources": ["resources/web", "resources/podium"],
    "icon": ["icons/icon.png"],
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "pubkey": "PASTE_DEV_PUBLIC_KEY_FROM_STEP_1",
      "endpoints": ["http://127.0.0.1:8788/update/{{target}}/{{arch}}/{{current_version}}"]
    }
  }
```

> The endpoint default points at the local verification feed (Task 2). Production overrides it (a real host) at release; the value is intentionally pluggable. `{{target}}`/`{{arch}}`/`{{current_version}}` are filled by the updater.

- [ ] **Step 4: Permissions**

In `apps/desktop/src-tauri/capabilities/default.json`, add to `permissions`:

```json
    "updater:default",
    "dialog:default",
    "process:default",
    "process:allow-restart"
```

- [ ] **Step 5: Write the failing unit test for the endpoint helper**

Create `apps/desktop/src-tauri/src/updater.rs`:

```rust
use tauri::AppHandle;

/// Build the templated updater endpoint from a pluggable base URL.
pub fn feed_endpoint(base: &str) -> String {
    format!("{}/update/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}", base.trim_end_matches('/'))
}

/// On launch: check the feed; if a newer signed version exists, ask the user, then
/// download+install and restart. Errors are logged, never fatal (no network = no-op).
pub async fn check_and_prompt_update(app: AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    use tauri_plugin_updater::UpdaterExt;

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => { eprintln!("[podium-desktop] updater unavailable: {e}"); return; }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let msg = format!("Update available ({} → {}). Restart to apply?", update.current_version, update.version);
            let confirmed = app
                .dialog()
                .message(msg)
                .title("Podium update")
                .buttons(MessageDialogButtons::OkCancel)
                .blocking_show();
            if confirmed {
                if let Err(e) = update.download_and_install(|_chunk, _total| {}, || {}).await {
                    eprintln!("[podium-desktop] update install failed: {e}");
                    return;
                }
                app.restart();
            }
        }
        Ok(None) => { /* up to date */ }
        Err(e) => eprintln!("[podium-desktop] update check failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn feed_endpoint_templates_the_base() {
        assert_eq!(
            feed_endpoint("http://h:8788/"),
            "http://h:8788/update/{{target}}/{{arch}}/{{current_version}}"
        );
    }
}
```

- [ ] **Step 6: Run the unit test (RED → GREEN)**

Run: `cd apps/desktop/src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test --lib feed_endpoint 2>&1 | tail -15`
Expected: after adding `mod updater;` to `main.rs`/`lib.rs` (Step 7) the test passes; before, it fails to compile (module missing).

- [ ] **Step 7: Wire plugins + the check into `main.rs`/`lib.rs`**

Add `mod updater;` to `lib.rs` (so `cargo test --lib` sees it) and `main.rs`. Register the plugins on the builder and kick the check from `setup` (non-blocking):

```rust
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
```
and inside `setup`, after the window/bootstrap is arranged:

```rust
            let updater_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                crate::updater::check_and_prompt_update(updater_handle).await;
            });
```

- [ ] **Step 8: Build (backgrounded) to confirm it compiles + produces updater artifacts**

```bash
cd apps/desktop
export TAURI_SIGNING_PRIVATE_KEY="$(cat .tauri-dev-signing.key)"; export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
PATH="$HOME/.cargo/bin:$PATH" bun run build   # run_in_background + poll
```
Expected (after build): `src-tauri/target/release/bundle/appimage/*.AppImage` AND a signature `*.AppImage.sig` (createUpdaterArtifacts). Confirm both exist. Fix compile/API drift against the compiler.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/capabilities/default.json apps/desktop/src-tauri/src/updater.rs apps/desktop/src-tauri/src/main.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/.gitignore
git commit -m "feat(desktop): tauri updater + dialog prompt-then-restart, dev signing key, updater artifacts"
```

---

### Task 2: Desktop update end-to-end verification (v0.1.0 → v0.1.1 via a local feed)

**Files:**
- Create: `apps/desktop/scripts/serve-update-feed.ts` (a tiny static HTTP feed serving a manifest + artifact)
- Create: `apps/desktop/scripts/verify-update.sh` (the orchestration: two builds → feed → Xvfb run → assert upgraded)

**Interfaces:**
- Consumes: Task 1's updater config + dev key.
- Produces: a reproducible script proving an installed v0.1.0 upgrades to v0.1.1.

- [ ] **Step 1: Write the feed server**

Create `apps/desktop/scripts/serve-update-feed.ts`:

```ts
/**
 * Minimal static update feed for verification. Serves Tauri's update manifest at
 * /update/:target/:arch/:current and the artifact + sig from a directory. Run:
 *   bun scripts/serve-update-feed.ts <artifactsDir> <version> [port]
 */
import { serve } from 'bun'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, version, portArg] = process.argv.slice(2)
const port = Number(portArg ?? 8788)
const appImage = readFileSync(join(dir, `Podium_${version}_amd64.AppImage`))
const sig = readFileSync(join(dir, `Podium_${version}_amd64.AppImage.sig`), 'utf8').trim()

serve({
  port,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/update/')) {
      // Tauri appends /<target>/<arch>/<current_version>; respond with the manifest.
      return Response.json({
        version,
        notes: 'verification build',
        pub_date: '2026-06-22T00:00:00Z',
        platforms: {
          'linux-x86_64': { signature: sig, url: `http://127.0.0.1:${port}/artifact` },
        },
      })
    }
    if (url.pathname === '/artifact') {
      return new Response(appImage, { headers: { 'content-type': 'application/octet-stream' } })
    }
    return new Response('not found', { status: 404 })
  },
})
console.log(`update feed for v${version} on :${port}`)
```

- [ ] **Step 2: Write the verification orchestration**

Create `apps/desktop/scripts/verify-update.sh`:

```bash
#!/usr/bin/env bash
# Build v0.1.0 and v0.1.1, serve v0.1.1, run v0.1.0 under Xvfb, assert it upgrades.
set -euo pipefail
cd "$(dirname "$0")/.."   # apps/desktop
export PATH="$HOME/.cargo/bin:$PATH"
export TAURI_SIGNING_PRIVATE_KEY="$(cat .tauri-dev-signing.key)"; export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

build() { # $1 = version
  bun pm version --no-git-tag-version "$1" >/dev/null 2>&1 || true
  # set version in tauri.conf.json
  node -e "const f='src-tauri/tauri.conf.json',j=require('./'+f);j.version='$1';require('fs').writeFileSync(f,JSON.stringify(j,null,2))"
  bun run build >/tmp/build-$1.log 2>&1
  mkdir -p "dist-verify/$1"
  cp src-tauri/target/release/bundle/appimage/Podium_$1_amd64.AppImage* "dist-verify/$1/"
}

build 0.1.0
build 0.1.1
bun scripts/serve-update-feed.ts "dist-verify/0.1.1" 0.1.1 8788 &
FEED=$!; trap 'kill $FEED 2>/dev/null' EXIT
sleep 1

SMOKE_STATE=$(mktemp -d)
APP010="dist-verify/0.1.0/Podium_0.1.0_amd64.AppImage"; chmod +x "$APP010"
# Run v0.1.0; updater checks :8788, finds 0.1.1. (Prompt auto-confirm: for headless verify,
# temporarily make check_and_prompt_update auto-confirm when PODIUM_UPDATE_AUTOCONFIRM=1.)
PODIUM_UPDATE_AUTOCONFIRM=1 PODIUM_STATE_DIR="$SMOKE_STATE" \
  timeout 60 xvfb-run -a "$APP010" 2>&1 | tee /tmp/update-run.log || true
sleep 5
# After install+restart, the on-disk AppImage should now report 0.1.1.
"$APP010" --version 2>/dev/null | tee /tmp/post-version.log || true
grep -q "0.1.1" /tmp/post-version.log && echo "UPGRADE VERIFIED ✓" || echo "UPGRADE NOT verified — inspect /tmp/update-run.log"
rm -rf "$SMOKE_STATE"
```

> Add a `PODIUM_UPDATE_AUTOCONFIRM=1` branch to `check_and_prompt_update` (Task 1) that skips the dialog and proceeds (only when the env is set) — so the e2e is non-interactive. Document it as test-only. NOTE: `--version` on a Tauri app isn't built in; instead assert the upgrade by checking the updater logged "update installed" / the replaced AppImage's embedded version, or have the app write its version to `$PODIUM_STATE_DIR/running-version` on boot and read that. Use whichever reliably distinguishes 0.1.0 from 0.1.1; the gate is a demonstrable version change.

- [ ] **Step 3: Run the verification (backgrounded; it does two full builds — slow)**

```bash
chmod +x apps/desktop/scripts/verify-update.sh
apps/desktop/scripts/verify-update.sh   # run_in_background + poll; ~15-30 min (two release builds)
```
Expected: `UPGRADE VERIFIED ✓`. If the AppImage self-replacement can't run headlessly (the documented `$APPIMAGE` risk), instead assert the check+download+signature-verify succeeded (the updater logs the new version + a verified signature) and record the install-step limitation honestly in the report.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/scripts/serve-update-feed.ts apps/desktop/scripts/verify-update.sh apps/desktop/src-tauri/src/updater.rs
# (.tauri-dev-signing.key + dist-verify/ are gitignored)
git commit -m "test(desktop): e2e update verification (v0.1.0→v0.1.1 via local signed feed)"
```

---

### Task 3: Headless `podium update`

**Files:**
- Modify: `scripts/cli.ts` (add the `update` subcommand)
- Create: `scripts/podium-update.ts` (fetch manifest → compare → download → swap → restart)
- Modify: `scripts/build-bun.ts` (write a `VERSION` file + the headless update artifact: a tarball of `dist-bun/headless/`)
- Create (test): `scripts/podium-update.test.ts` (pure version-compare + manifest-parse)

**Interfaces:**
- Consumes: `loadConfig` (Phase 2) for the feed base (`config` gains an optional `updateFeed`, or env `PODIUM_UPDATE_FEED`).
- Produces: `podium update` — compares the bundle's `VERSION` to the feed manifest; if newer, downloads the headless tarball, swaps the install dir atomically, re-execs. Pure `isNewer(a, b): boolean` + `parseManifest(json): { version, url }` unit-tested.

- [ ] **Step 1: Write the failing unit test**

Create `scripts/podium-update.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isNewer, parseManifest } from './podium-update'

describe('podium update helpers', () => {
  it('isNewer compares semver-ish versions', () => {
    expect(isNewer('0.1.1', '0.1.0')).toBe(true)
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(isNewer('0.2.0', '0.10.0')).toBe(false)
  })
  it('parseManifest extracts version + linux url', () => {
    const m = parseManifest(JSON.stringify({
      version: '0.1.1',
      platforms: { 'linux-x86_64': { url: 'http://h/a.tar.gz', signature: 'x' } },
    }))
    expect(m).toEqual({ version: '0.1.1', url: 'http://h/a.tar.gz' })
  })
})
```

- [ ] **Step 2: Run it (RED)**

Run: `bun run test -- scripts/podium-update.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `podium-update.ts`**

Create `scripts/podium-update.ts`:

```ts
/**
 * `podium update`: compare the installed bundle VERSION to the feed manifest; if newer,
 * download the headless tarball, swap the install dir, and re-exec. The install dir is the
 * dir containing this binary (resolved from process.execPath).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export function isNewer(candidate: string, current: string): boolean {
  const pa = candidate.split('.').map(Number)
  const pb = current.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const a = pa[i] ?? 0
    const b = pb[i] ?? 0
    if (a !== b) return a > b
  }
  return false
}

export function parseManifest(json: string): { version: string; url: string } {
  const m = JSON.parse(json) as { version: string; platforms: Record<string, { url: string }> }
  const url = m.platforms['linux-x86_64']?.url
  if (!url) throw new Error('manifest has no linux-x86_64 artifact')
  return { version: m.version, url }
}

function installDir(): string {
  // The headless launcher (dist-bun/headless/podium) sets PODIUM_HOME to its own dir.
  return process.env.PODIUM_HOME ?? dirname(process.execPath)
}

function currentVersion(dir: string): string {
  const f = join(dir, 'VERSION')
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : 'dev'
}

export async function runUpdate(feedBase: string): Promise<void> {
  const dir = installDir()
  const cur = currentVersion(dir)
  const target = process.env.PODIUM_UPDATE_TARGET ?? 'linux-x86_64'
  const manifestUrl = `${feedBase.replace(/\/$/, '')}/update/${target}/x86_64/${cur}`
  const res = await fetch(manifestUrl)
  if (!res.ok) {
    console.error(`[podium update] feed returned ${res.status}`)
    return
  }
  const { version, url } = parseManifest(await res.text())
  if (!isNewer(version, cur)) {
    console.log(`[podium update] already up to date (${cur})`)
    return
  }
  console.log(`[podium update] updating ${cur} → ${version}`)
  const tmp = mkdtempSync(join(tmpdir(), 'podium-update-'))
  const tarball = join(tmp, 'bundle.tar.gz')
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer())
  await Bun.write(tarball, buf)
  // Extract into a sibling, then atomically swap.
  const staged = join(tmp, 'staged')
  execFileSync('mkdir', ['-p', staged])
  execFileSync('tar', ['-xzf', tarball, '-C', staged])
  const backup = `${dir}.old`
  rmSync(backup, { recursive: true, force: true })
  renameSync(dir, backup)
  renameSync(join(staged, 'headless'), dir)
  rmSync(backup, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
  console.log(`[podium update] updated to ${version}; restart podium to apply`)
}
```

- [ ] **Step 4: Run the unit test (GREEN)**

Run: `bun run test -- scripts/podium-update.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire `update` into the CLI + emit VERSION + tarball at build**

In `scripts/cli.ts` `main()`, before the mode dispatch, handle the subcommand:

```ts
  if (argv[0] === 'update') {
    const { runUpdate } = await import('./podium-update')
    await runUpdate(process.env.PODIUM_UPDATE_FEED ?? loadConfig().updateFeed ?? 'http://127.0.0.1:8789')
    return
  }
```

Add `updateFeed: z.string().optional()` to `PodiumConfig` (packages/core/src/config.ts). In `scripts/build-bun.ts` headless staging: write `dist-bun/headless/VERSION` (the version from root `package.json` or `PODIUM_APP_VERSION`), and produce a tarball `dist-bun/podium-headless-<version>.tar.gz` of the `headless/` dir (so the feed can serve it). Have the launcher shim export `PODIUM_HOME="$DIR"` so `installDir()` resolves correctly.

- [ ] **Step 6: Verify headless update e2e (local feed)**

```bash
# Build, stage two versions, serve v2, run `podium update` from v1, assert swapped.
PATH="$HOME/.cargo/bin:$PATH" bun run package:headless   # backgrounded+poll
# (orchestration mirrors verify-update.sh: stage 0.1.0 + 0.1.1 headless tarballs, serve
#  0.1.1 manifest+tarball on :8789, run `dist-bun/headless/podium update` from a 0.1.0 copy,
#  then check the copy's VERSION is now 0.1.1.)
```
Write `scripts/verify-headless-update.sh` doing exactly that; expected: the v0.1.0 install's `VERSION` becomes `0.1.1` after `podium update`. Commit the script.

- [ ] **Step 7: Commit**

```bash
git add scripts/podium-update.ts scripts/podium-update.test.ts scripts/cli.ts scripts/build-bun.ts packages/core/src/config.ts scripts/verify-headless-update.sh
git commit -m "feat(cli): headless 'podium update' — fetch manifest, swap bundle (+ e2e verify)"
```

---

## Self-Review

**Spec coverage (Component E + Phase 5 decisions):**
- Desktop Tauri updater, prompt-then-restart, Rust-driven (no apps/web Tauri deps) → Task 1. ✓
- Dev signing key (committed pubkey, secret private key), updater artifacts → Task 1. ✓
- Pluggable feed endpoint (config/env default localhost) → Tasks 1 + 3. ✓
- Desktop e2e v0.1.0→v0.1.1 via local signed feed → Task 2. ✓
- Headless `podium update` (fetch manifest → swap → restart) + e2e → Task 3. ✓
- Manifest schema = Tauri's `{version,notes,pub_date,platforms}` → Tasks 2 + 3. ✓
- Deferred (production key/host, macOS, patchelf) — documented.

**Placeholder scan:** The two "PASTE_…" tokens are real generated values the implementer fills in Step 1/3 (not vague TODOs); the AppImage-self-replace + version-assert notes are concrete fallbacks for a known-fiddly integration, with the gate stated.

**Type/name consistency:** `feed_endpoint`/`check_and_prompt_update` (Task 1); `isNewer`/`parseManifest`/`runUpdate` (Task 3) used identically in tests + CLI; manifest shape (`{version, platforms["linux-x86_64"].url/signature}`) matches between the feed server (Task 2), `parseManifest` (Task 3), and Tauri's expected format.

## What Phase 5 delivers

Both update paths, verified against a local signed feed: the desktop app prompts + self-updates v0.1.0→v0.1.1 (Tauri updater, Rust-driven), and `podium update` swaps the headless bundle. The feed URL + signing key are pluggable/dev for now; production swaps in the real host + key. This completes the auto-update component; only Phase 4 (cross-platform installer CI, needs a Mac) and Phase 6 (multi-machine re-implement) remain.
