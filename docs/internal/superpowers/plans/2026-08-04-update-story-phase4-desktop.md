# Update story, Phase 4: the desktop shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the in-app dialog drive the desktop's own update, replace the `CRITICAL:` prose marker with a structured flag, and keep the native dialog as a fallback for the case where the webview is the broken thing.

**Architecture:** Three Tauri commands on the existing frozen `window.__PODIUM_DESKTOP__` bridge: check, install, and claim-ownership. The page claims update ownership on mount; if no claim arrives within a grace window, the shell presents the native dialog itself, because a shell that depends on its page to update itself cannot recover from a broken page. Every decision is a pure Rust function with `#[cfg(test)]` coverage, since there is no local cargo and full builds are verified in CI only.

**Tech Stack:** Rust, Tauri 2, `tauri-plugin-updater` 2.10, TypeScript.

**Spec:** `docs/internal/superpowers/specs/2026-08-04-coherent-update-story-design.md`, §7.4 and §12.4. Gap items 14 and 16.

**Depends on:** Phase 3 (POD-1697) for the dialog that will drive these commands. **Do not start until it has landed on main.**

## Global Constraints

- **There is no local cargo on this machine.** `cargo --version` is not found. Write Rust so its logic is testable in `#[cfg(test)]` units, and state plainly in the handoff that the full build is CI-verified. Do not claim you compiled it.
- **The shell must never depend on the page in order to update itself.** This is the whole reason the native dialog survives. Any design where a broken bundle means no update path is wrong.
- **The bridge is frozen and feature-detected in both directions.** The page must tolerate a shell without the new commands, and the shell must tolerate a page that never calls them. In remote mode the page is served by the *remote server*, which may be older than the shell.
- **Policy is structured, never prose.** `Update.raw_json` (verified present on `tauri-plugin-updater` 2.10.1, `updater.rs:624`) carries the manifest verbatim. Read `critical` from it. The `CRITICAL:` string prefix goes.
- **Debug builds never check production feeds.** `production_auto_update_enabled` stays exactly as it is. Development is not a third release channel.
- `PODIUM_UPDATE_AUTOCONFIRM=1` remains test-only and must keep working; the headless e2e depends on it.
- Run `bun run typecheck` and trust a cache hit.

---

## File Structure

**Modified:**
- `apps/desktop/src-tauri/src/updater.rs` — structured `critical`, the ownership-claim decision, the commands.
- `apps/desktop/src-tauri/src/main.rs:107-137` — `native_desktop_hook` gains the three bridge members; `invoke_handler` registers the commands.
- `apps/desktop/src-tauri/capabilities/` — permissions for the new commands.
- `apps/web/src/lib/nativeDesktop.ts` — the bridge type gains the optional members.
- `apps/web/src/features/updates/use-update-state.ts` — wires the bridge into the dialog's actions.

---

## Task 1: Structured `critical` replaces the prose marker

**Files:**
- Modify: `apps/desktop/src-tauri/src/updater.rs`

**The problem being fixed:** `is_critical(body)` decides whether an update is forced by checking whether the release notes *start with the string* `CRITICAL:`. That couples a policy decision to prose a human writes, so an editor reflowing a changelog can silently turn a forced update into an optional one, or the reverse.

- [ ] **Step 1: Write the failing test**

In the `#[cfg(test)] mod tests` block in `updater.rs`:

```rust
#[test]
fn critical_is_read_from_the_structured_field() {
    let json = serde_json::json!({ "version": "0.4.2", "critical": true });
    assert!(is_critical_update(&json, Some("ordinary notes")));
}

#[test]
fn absent_critical_field_means_not_critical() {
    let json = serde_json::json!({ "version": "0.4.2" });
    assert!(!is_critical_update(&json, Some("notes")));
}

#[test]
fn explicit_false_means_not_critical() {
    let json = serde_json::json!({ "version": "0.4.2", "critical": false });
    assert!(!is_critical_update(&json, None));
}

#[test]
fn the_prose_marker_no_longer_forces_anything() {
    // Policy must not be parseable out of a changelog. An editor reflowing prose
    // must not be able to change whether an update is forced.
    let json = serde_json::json!({ "version": "0.4.2" });
    assert!(!is_critical_update(&json, Some("CRITICAL: security fix")));
}

#[test]
fn a_non_boolean_critical_is_not_critical() {
    // Fail toward NOT forcing: a malformed manifest must not produce a
    // non-dismissible dialog the user cannot escape.
    let json = serde_json::json!({ "version": "0.4.2", "critical": "yes" });
    assert!(!is_critical_update(&json, None));
}
```

- [ ] **Step 2: Note that you cannot run this locally**

There is no cargo on this machine. Record in the commit body that Rust tests are CI-verified. Do not claim a local green.

- [ ] **Step 3: Write the implementation**

```rust
/// Whether this release is FORCED, read from the manifest's structured field.
///
/// Deliberately not parsed out of the release notes. Policy that lives in prose
/// can be changed by anyone reflowing a changelog, in either direction, silently.
/// `raw_json` carries the manifest verbatim, so the flag the release process set
/// is the flag we read.
///
/// Fails toward NOT critical: a malformed or absent field must never produce a
/// non-dismissible dialog the user has no way out of.
pub fn is_critical_update(raw: &serde_json::Value, _body: Option<&str>) -> bool {
    raw.get("critical").and_then(serde_json::Value::as_bool).unwrap_or(false)
}
```

Delete `is_critical` and its prose tests, and update `check_and_prompt_update` to call `is_critical_update(&update.raw_json, update.body.as_deref())`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/updater.rs
git commit -m "fix(desktop): structured critical flag, not a prose marker (POD-1670)

Rust tests are CI-verified; there is no local cargo on this machine."
```

---

## Task 2: The ownership-claim decision

**Files:**
- Modify: `apps/desktop/src-tauri/src/updater.rs`

**Interfaces:**
- Produces: `pub fn should_show_native_dialog(claimed: bool, elapsed_ms: u64, grace_ms: u64) -> bool`
- Produces: `pub const OWNERSHIP_GRACE_MS: u64 = 8_000`

**Why this exists:** the in-app dialog is the primary surface, but the webview can be the broken thing. If the bundle fails to load, or a remote server is unreachable, an in-app dialog cannot render and there would then be no update path at all. Worse, in remote mode the shell loads the *remote server's* web bundle, so the update UI is served by the very server the user may be trying to update. The shell therefore needs its own way out.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn a_claiming_page_owns_the_dialog() {
    assert!(!should_show_native_dialog(true, 100_000, OWNERSHIP_GRACE_MS));
}

#[test]
fn an_unclaimed_shell_falls_back_after_the_grace_window() {
    // The bundle failed to load, or the page is too old to know about the bridge.
    // Without this, a broken webview means no update path at all.
    assert!(should_show_native_dialog(false, OWNERSHIP_GRACE_MS + 1, OWNERSHIP_GRACE_MS));
}

#[test]
fn the_shell_waits_out_the_grace_window_before_stepping_in() {
    // A slow page must not race the native dialog and show two prompts.
    assert!(!should_show_native_dialog(false, 10, OWNERSHIP_GRACE_MS));
}

#[test]
fn a_late_claim_still_wins_at_the_boundary() {
    assert!(!should_show_native_dialog(true, OWNERSHIP_GRACE_MS, OWNERSHIP_GRACE_MS));
}

#[test]
fn the_grace_window_is_generous_enough_for_a_remote_bundle() {
    // Remote mode fetches the page from another host. Too short a window shows a
    // native dialog over a page that was about to render its own.
    assert!(OWNERSHIP_GRACE_MS >= 5_000);
}
```

- [ ] **Step 2: Implement**

```rust
/// How long the shell waits for its page to say "I own updates" before showing
/// the native dialog itself. Generous on purpose: in remote mode the page is
/// fetched from another host, and a short window would race a page that was about
/// to render its own dialog, showing the user two prompts for one fact.
pub const OWNERSHIP_GRACE_MS: u64 = 8_000;

/// The shell steps in only when nobody claimed the job and the grace window has
/// passed. A page that claimed ownership keeps it forever: the shell never
/// second-guesses a live page.
pub fn should_show_native_dialog(claimed: bool, elapsed_ms: u64, grace_ms: u64) -> bool {
    !claimed && elapsed_ms > grace_ms
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/updater.rs
git commit -m "feat(desktop): ownership-claim decision for the native dialog fallback (POD-1670)"
```

---

## Task 3: The three commands and the bridge

**Files:**
- Modify: `apps/desktop/src-tauri/src/updater.rs`, `main.rs`, `capabilities/`

**Interfaces:**
- Produces three `#[tauri::command]`s:
  - `claim_update_ownership() -> Result<(), String>` — sets the shared claimed flag.
  - `check_update(channel) -> Result<Option<UpdateInfo>, String>` where `UpdateInfo = { current_version, version, critical, notes }`.
  - `install_update() -> Result<(), String>` — downloads, installs, restarts.
- Produces on the bridge: `claimUpdateOwnership`, `checkUpdate`, `installUpdate`.

- [ ] **Step 1: Extend `native_desktop_hook`**

Add the three members to the frozen object built in `main.rs:107-137`, following the existing `enableHosting` pattern exactly (`window.__TAURI_INTERNALS__.invoke('<command>', {...})`). Unlike `enableHosting`, these are present in **every** launch mode: a client-mode shell still updates itself.

- [ ] **Step 2: Register them in `invoke_handler`**

`tauri::generate_handler![enable_hosting, claim_update_ownership, check_update, install_update]`.

- [ ] **Step 3: Grant the capability**

Add the three commands to the desktop capability set. Get this wrong and the invoke fails at runtime with a permission error that unit tests will not catch. Check both the local-mode and remote-mode capability patterns; `remote_capability_pattern` derives the remote origin, and these commands must be granted there too or a remote-mode shell can never update.

- [ ] **Step 4: Rewire `check_and_prompt_update` as the fallback**

It no longer runs unconditionally at launch. It runs when `should_show_native_dialog` says so, after the grace window, and it keeps `production_auto_update_enabled` and the `PODIUM_UPDATE_AUTOCONFIRM` test hook exactly as they are.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri
git commit -m "feat(desktop): update commands on the bridge, native dialog demoted to fallback (POD-1670)"
```

---

## Task 4: The web side wires the bridge in

**Files:**
- Modify: `apps/web/src/lib/nativeDesktop.ts`, `apps/web/src/features/updates/use-update-state.ts`
- Test: `apps/web/src/lib/nativeDesktop.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { nativeDesktopBridge } from './nativeDesktop'

describe('nativeDesktopBridge update members', () => {
  it('exposes the update commands when the shell provides them', () => {
    ;(globalThis as Record<string, unknown>).__PODIUM_DESKTOP__ = {
      platform: 'linux',
      minimize: async () => {},
      toggleMaximize: async () => {},
      close: async () => {},
      checkUpdate: async () => null,
      installUpdate: async () => {},
      claimUpdateOwnership: async () => {},
    }
    expect(nativeDesktopBridge()?.installUpdate).toBeTypeOf('function')
  })

  it('tolerates an OLDER shell that has none of them', () => {
    // In remote mode the page comes from the remote server and may be newer than
    // the shell running it. Absent commands must be absent, never a throw.
    ;(globalThis as Record<string, unknown>).__PODIUM_DESKTOP__ = {
      platform: 'linux',
      minimize: async () => {},
      toggleMaximize: async () => {},
      close: async () => {},
    }
    const b = nativeDesktopBridge()
    expect(b).toBeDefined()
    expect(b?.installUpdate).toBeUndefined()
  })

  it('is undefined in a plain browser', () => {
    ;(globalThis as Record<string, unknown>).__PODIUM_DESKTOP__ = undefined
    expect(nativeDesktopBridge()).toBeUndefined()
  })
})
```

- [ ] **Step 2: Implement**

Add the three optional members to `NativeDesktopBridge`. In `use-update-state.ts`, call `claimUpdateOwnership()` on mount (guarded by optional chaining) and pass `installUpdate` through as the dialog's `installApp` action only when it exists, so Phase 3's "no backend, no button" test keeps passing.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): drive the desktop update from the in-app dialog (POD-1670)"
```

---

## Verification for the whole phase

- [ ] `bun run typecheck`, `bun run test:web` pass.
- [ ] Rust unit tests pass **in CI**. Say so in the handoff; do not claim a local cargo run, because there is no local cargo.
- [ ] **In a real desktop build:** the in-app dialog appears and its Update button installs and restarts the shell.
- [ ] **The fallback actually fires:** point the shell at a deliberately broken bundle so the page never claims ownership, and confirm the native dialog appears after the grace window. A fallback that has never been observed firing is not a fallback.
- [ ] **Remote mode:** confirm the capability grant covers the remote origin, so a remote-mode shell can invoke the commands at all.
- [ ] The headless e2e using `PODIUM_UPDATE_AUTOCONFIRM=1` still passes.

---

## Out of scope, on purpose

- The mobile store blocking screen. Phase 6 and the future native build own it.
- Any change to what the manifest contains. Phase 6 makes the release process emit `critical`; this phase only reads it. Until then the field is simply absent, which correctly means not critical.
