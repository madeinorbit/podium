# Desktop shell update integration — Implementation Plan

**Epic:** POD-2087 · **Spec:** `2026-08-14-update-operations-design.md` §4, §5, §9.4
**Protocol:** `2026-08-14-updater-worker-protocol.md`
**Blocked by:** Update operation choreography; Update operation panel.

**Goal:** The shell becomes a first-class surface of the operation: install progress and
errors reach the panel, the all-in-one flow is the operation's awaited step end to end,
channel authority is single-sourced, and the native fallback becomes a real minimal
dialog instead of dead code.

**Owns:** `apps/desktop/src-tauri/src/updater.rs`, `main.rs` (bridge + events),
`apps/web/src/lib/nativeDesktop.ts`, the panel's desktop action wiring (small,
coordinated edits in `apps/web/src/features/updates/` — rebase carefully, the panel issue
owns those files; keep your diff surgical). Rust logic must be pure-function tested
(`#[cfg(test)]`) — there is no local cargo; full builds verify in CI.

## Context

- `install_update` discards both progress callbacks (`updater.rs:196,229`) and its
  errors vanish page-side (now caught by the panel, but with no detail from Rust).
- Channel disagreement: `check_update` uses the page-supplied (server-resolved) channel;
  `install_update`'s fallback re-checks with the shell's own config (`updater.rs:185`).
- Native fallback is inert: `check_and_prompt_update` no-ops unless
  `PODIUM_UPDATE_AUTOCONFIRM=1` (`updater.rs:206-214`); `tauri_plugin_dialog` is already
  registered (`main.rs:375`). Ownership grace machinery works (`OWNERSHIP_GRACE_MS = 8 s`).
- All-in-one: the choreography issue already creates the operation in `waiting` with
  `awaiting: desktop-install`; the embedded server adopts after restart (§3.4, §5). This
  issue wires the page/shell halves.
- No Tauri events exist today (`grep .emit(` is empty) — progress needs a channel from
  Rust to the page.

## Tasks

- [ ] **Progress events** — during `download_and_install`, emit a window event
  `podium://update-progress` `{ phase: 'downloading'|'installing', received, total?,
  percent? }`, throttled by the same report-decision rule as the daemon (pure fn, unit
  tested in Rust). Bridge: `nativeDesktop.ts` exposes `onUpdateProgress(cb)` subscribing
  via the injected init script (shell `eval`s a page hook `__PODIUM_UPDATE_PROGRESS__`
  like the existing menu hooks — keep the frozen-bridge discipline: page tolerates a
  shell without it). Panel renders it as the step's percent.
- [ ] **Error detail** — `install_update` returns structured error strings
  (`{ code, message }` serialized) instead of bare `Err(String)`; the panel maps them
  into the failed rendering. Every early-return in `install_update`/`check_update`
  becomes a typed code (`debug-build`, `no-pending-update`, `download-failed`,
  `signature-invalid`, `restart-failed`).
- [ ] **Channel authority** — `install_update` takes the channel as an argument (same
  source as `check_update`: the page, which asked the server); the shell-config re-check
  path remains only for the native fallback (a shell with no page). Unit-test the
  precedence.
- [ ] **All-in-one flow** — page side: when the active operation awaits
  `desktop-install` and the surface is `desktop-all-in-one`, the panel's primary is
  **Restart Podium** → `installUpdate()`. After the shell restarts, the new embedded
  server adopts the operation; the reloaded page fetches it and renders `done` (or the
  remaining machine steps). Drive this end to end with the Linux verifier
  (`apps/desktop/scripts/verify-update.sh` + `serve-update-feed.ts`) and record the
  sequence in your issue state.
- [ ] **Native fallback, minimal and real** — when the page never claims ownership
  within the grace window: show an actual dialog (tauri_plugin_dialog confirm) —
  "Podium {v} is available — install and restart?" → install with a native progress
  window title update → restart. Delete the `PODIUM_UPDATE_AUTOCONFIRM` interactive
  bypass (keep an env override usable by `verify-update.sh` for headless CI, renamed to
  make its test-only nature explicit). Pure-fn tests for the decision (`claimed`,
  `elapsed`, `grace`) already exist — extend for the dialog-outcome path.
- [ ] **Supervised honesty** — the shell's embedded daemon is excluded from waves
  (daemon-hardening issue); verify the desktop machine row renders as "managed by
  Podium Desktop" in the drive, and that a fleet update against a desktop-attached
  server leaves the sidecar untouched.

## Testing

Rust `#[cfg(test)]` for: throttle rule, error codes, channel precedence, fallback
decision. Web: panel wiring tests (progress event → percent; error code → failed view).
Gates: typecheck, focused tests, `bun run test`; CI builds the shell. Linux end-to-end
via `verify-update.sh` (both arms: good artifact installs; broken artifact fails closed
with the old build launchable). macOS production-signed proof is release-time
(`docs/agents/updater-acceptance.md` §5) — record it as an open verification item in
your issue close note, do not claim it.

## Acceptance

- A desktop update shows live percent in the panel; a failed install shows a typed,
  human-first error.
- All-in-one: one click → restart → the same operation id renders `done` after relaunch
  (verified in the Linux drive).
- An unclaimed shell (webview stub page) presents the native dialog within ~9 s.
