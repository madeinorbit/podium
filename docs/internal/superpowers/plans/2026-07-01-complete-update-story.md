# Complete Update Story — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Enforce one version contract at every peer boundary with a version-gated "force update" path — web hard-reloads, daemon self-updates, desktop shows a non-dismissible update — and rename the wire param `pv`→`v`.

**Architecture:** Server declares `WIRE_VERSION` + `MIN_SUPPORTED_VERSION`. Every WS peer sends `?v=`; the server `426`s peers outside `[min, wire]`. Web checks `/version` on boot/reconnect and hard-reloads (evicting the PWA SW cache) on mismatch. Daemon self-updates on `426` + a scheduled timer. Desktop honors a critical marker for a non-dismissible update.

**Tech Stack:** TypeScript ESM, zod, vitest, happy-dom; Rust/Tauri (desktop); systemd; Bun.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-01-complete-update-story-design.md` (issue **podium-ium**).
- `WIRE_VERSION` and `MIN_SUPPORTED_VERSION` are ints in `packages/protocol/src/version.ts`; both are `1` now (preserves today's exact-match behavior — the mechanism is what's new).
- Wire param is **`v`**; accept `pv` as a deprecated alias for one release.
- Web must NEVER import a Node-only `@podium/core` at runtime (unchanged rule).
- TS: ESM-only, vitest, Biome clean on changed lines (don't reformat pre-existing dirty lines).
- Rust: build/test with `~/.cargo/bin/cargo` (installed this session); desktop Tauri deps (webkit2gtk-4.1, libsoup-3.0) are present.
- Daemon scheduled auto-update is **default-on** for `install.sh --join` machines (opt-out flag).
- Commit after each green step; TDD (failing test → run → impl → run → commit).

---

### Task 1: protocol — MIN_SUPPORTED_VERSION + versionSupport() + pv→v rename

**Files:** Modify `packages/protocol/src/version.ts`; Test `packages/protocol/src/version.test.ts`.

**Interfaces produced:**
- `MIN_SUPPORTED_VERSION: number` (=1)
- `versionSupport(v: number, wire=WIRE_VERSION, min=MIN_SUPPORTED_VERSION): 'ok' | 'too-old' | 'too-new'`
- keep `WIRE_VERSION`, `isProtocolCompatible` (unchanged).

- [ ] **Step 1: failing test** (append)
```ts
import { MIN_SUPPORTED_VERSION, versionSupport, WIRE_VERSION } from './version'
it('MIN_SUPPORTED_VERSION is a positive int ≤ WIRE_VERSION', () => {
  expect(Number.isInteger(MIN_SUPPORTED_VERSION)).toBe(true)
  expect(MIN_SUPPORTED_VERSION).toBeGreaterThan(0)
  expect(MIN_SUPPORTED_VERSION).toBeLessThanOrEqual(WIRE_VERSION)
})
it('versionSupport classifies old/new/ok', () => {
  expect(versionSupport(1, 2, 1)).toBe('ok')      // in [1,2]
  expect(versionSupport(2, 2, 1)).toBe('ok')
  expect(versionSupport(0, 2, 1)).toBe('too-old')
  expect(versionSupport(3, 2, 1)).toBe('too-new')
  expect(versionSupport(Number.NaN, 2, 1)).toBe('too-old') // unparseable → treat as unsupported
})
```
- [ ] **Step 2: run → fail** `bun run vitest run packages/protocol/src/version.test.ts`
- [ ] **Step 3: implement**
```ts
/** Oldest wire version the server still accepts. Raise per breaking release to FORCE older peers. */
export const MIN_SUPPORTED_VERSION = 1

export function versionSupport(
  v: number,
  wire: number = WIRE_VERSION,
  min: number = MIN_SUPPORTED_VERSION,
): 'ok' | 'too-old' | 'too-new' {
  if (!Number.isInteger(v) || v < min) return 'too-old'
  if (v > wire) return 'too-new'
  return 'ok'
}
```
- [ ] **Step 4: run → pass**
- [ ] **Step 5: commit** `feat(protocol): MIN_SUPPORTED_VERSION + versionSupport() [podium-ium]`

---

### Task 2: server — gate uses versionSupport + /version publishes minSupportedVersion; pv→v

**Files:** Modify `apps/server/src/wsServer.ts` (~L254-262), `apps/server/src/server.ts` (/version ~L39-46); Test `apps/server/src/wsServer.test.ts` (or the nearest existing gate test) + a /version assertion.

**Interfaces consumed:** `versionSupport`, `MIN_SUPPORTED_VERSION`, `WIRE_VERSION`.

- [ ] **Step 1: failing test** — gate: `v=0` (too-old) → 426; `v=2` (too-new, with wire=1) → 426; `v=1` → allow; absent → allow; `pv=1` alias → allow. And `/version` returns `minSupportedVersion`.
```ts
// read the current gate test file first; mirror its harness. Assert (pseudo):
// classify('?v=0') -> 426 ; '?v=1' -> upgrade ; no v -> upgrade ; '?pv=1' -> upgrade
```
- [ ] **Step 2: run → fail**
- [ ] **Step 3: implement** — in `wsServer.ts`, replace the `has('pv') && !isProtocolCompatible(...)` gate:
```ts
const raw = url.searchParams.get('v') ?? url.searchParams.get('pv') // 'pv' = deprecated alias
if (raw !== null && versionSupport(Number(raw)) !== 'ok') {
  socket.write('HTTP/1.1 426 Upgrade Required\r\n\r\n')
  socket.destroy()
  return
}
```
In `server.ts` `/version`: add `minSupportedVersion: MIN_SUPPORTED_VERSION` to the JSON.
- [ ] **Step 4: run → pass** (server suite for the gate + version)
- [ ] **Step 5: commit** `feat(server): version gate via versionSupport + publish minSupportedVersion [podium-ium]`

---

### Task 3: daemon — send ?v=, self-heal on 426 (update+exit), bounded loop; pv→v

**Files:** Modify `apps/daemon/src/daemon.ts` (connect ~L1771, 426 handler ~L1838-1852); a new tiny helper `apps/daemon/src/self-update.ts` (testable); Test `apps/daemon/src/self-update.test.ts`.

**Design:** On a `426`/protocol-mismatch close, if running as an INSTALLED binary (`process.env.PODIUM_HOME` set OR `process.execPath` ends in `podium`), spawn `podium update` and `process.exit(0)` so systemd restarts into the new binary. In dev/source runs, log the mismatch and back off (no update). Track consecutive mismatches; after N=3 with no newer version, back off to a long interval + emit "manual update required" (stop hot-looping).

- [ ] **Step 1: failing test** for the pure decision helper:
```ts
// apps/daemon/src/self-update.test.ts
import { decideOnProtocolMismatch } from './self-update'
it('installed → update+exit', () => {
  expect(decideOnProtocolMismatch({ installed: true, consecutive: 1 })).toEqual({ action: 'self-update' })
})
it('source/dev → just backoff', () => {
  expect(decideOnProtocolMismatch({ installed: false, consecutive: 1 })).toEqual({ action: 'backoff' })
})
it('installed but repeated with no update available → give up loudly', () => {
  expect(decideOnProtocolMismatch({ installed: true, consecutive: 3, updatedAvailable: false }))
    .toEqual({ action: 'give-up' })
})
```
- [ ] **Step 2: run → fail**
- [ ] **Step 3: implement** `self-update.ts` (pure `decideOnProtocolMismatch(ctx)`), then wire `daemon.ts`: connect URL `?v=${WIRE_VERSION}`; on the `unexpected-response`/426 path, call the helper; `self-update` → `execFileSync(process.execPath-or-podium, ['update'])` then `process.exit(0)`; `give-up` → long backoff + one clear log; `backoff` → existing reconnect. Update the `pv=` log string to `v=`.
- [ ] **Step 4: run → pass**
- [ ] **Step 5: commit** `feat(daemon): send ?v=, self-heal on protocol 426 (update+exit) [podium-ium]`

---

### Task 4: web — send ?v=, /version check on boot+reconnect, hard-reload on mismatch

**Files:** Modify `apps/web/src/trpc.ts` (both `/client` URLs); Create `apps/web/src/version-guard.ts`; wire into boot (`SetupGate.tsx` or `main.tsx`) + the WS reconnect path; Test `apps/web/src/version-guard.test.ts`.

**Interfaces produced:**
- `forceReload(): Promise<void>` — unregister all SWs, `caches.delete` all, then `location.reload()`.
- `checkServerVersion(httpOrigin, opts?): Promise<'ok'|'reloaded'|'blocked'>` — fetch `/version`; if the running bundle's `WIRE_VERSION < server.minSupportedVersion` OR `server.wireVersion !== WIRE_VERSION`, `forceReload()`. Guard reload loops via a `sessionStorage` counter (max 2 → `'blocked'` + surface an error instead of looping).

- [ ] **Step 1: failing test** (happy-dom) — mock `navigator.serviceWorker.getRegistrations`, `caches`, `location.reload`, and `fetch('/version')`:
```ts
// matched version → 'ok', no reload; server.minSupportedVersion > bundled → forceReload called;
// third call in a session → 'blocked' (loop guard), no further reload.
```
- [ ] **Step 2: run → fail** `bunx vitest run --root apps/web version-guard`
- [ ] **Step 3: implement** `version-guard.ts` (WIRE_VERSION imported from `@podium/protocol`); `trpc.ts` append `?v=${WIRE_VERSION}` to `wsClientUrl` (both builders); call `checkServerVersion(httpOrigin)` at boot (in `SetupGate` before rendering the app) and on WS reconnect (wherever the client reconnects — reuse the store's WS open handler).
- [ ] **Step 4: run → pass** + `bun run --filter @podium/web build`
- [ ] **Step 5: commit** `feat(web): v-handshake + hard-reload on version mismatch [podium-ium]`

---

### Task 5: systemd auto-update + install.sh wiring (default-on for --join)

**Files:** Create `scripts/systemd/podium-update-user.service` + `podium-update-user.timer`; Modify `scripts/podium-update.ts` (exit 10 when it actually updated) + `scripts/podium-update.test.ts`; Modify `install.sh` (emit + enable the timer in `--join`, `--no-auto-update` to opt out); extend `scripts/install-sh.test.sh`.

- [ ] **Step 1: failing test** — `podium-update.ts`: on a successful swap, `process.exitCode === 10`; on "already current", `0`; on failure, `1`. (Extend existing tests / the fixture harness.)
- [ ] **Step 2: run → fail**
- [ ] **Step 3: implement** — `runUpdate`: set `process.exitCode = 10` after the successful swap log. Timer service runs `podium update; ec=$?; [ "$ec" = 10 ] && systemctl --user try-restart podium-daemon`. `.timer` = `OnCalendar=daily` + `Persistent=true`. `install.sh --join`: after enabling `podium-daemon`, unless `--no-auto-update`, drop + `systemctl --user enable --now podium-update.timer`.
- [ ] **Step 4: verify** — `systemd-analyze verify` the units; `shellcheck install.sh`; `scripts/install-sh.test.sh` still `ALL OK`; `bun run vitest run scripts/podium-update.test.ts`.
- [ ] **Step 5: commit** `feat(update): scheduled podium-update.timer + install.sh --join enables it [podium-ium]`

---

### Task 6: bake appVersion — verify + test

**Files:** Read `scripts/build-bun.ts` (the `--define PODIUM_APP_VERSION` wiring); Test `apps/server/src/version-route.test.ts` (new or fold into an existing server test).

- [ ] **Step 1: failing test** — with `PODIUM_APP_VERSION=9.9.9` in env, the `/version` handler returns `appVersion: '9.9.9'` (and `wireVersion`, `minSupportedVersion`). (Call the route/handler directly, per the server test harness.)
- [ ] **Step 2: run → fail** (route may not read env yet / test missing)
- [ ] **Step 3: implement/confirm** — `server.ts` `/version` already reads `process.env.PODIUM_APP_VERSION ?? 'dev'`; ensure the test passes. Confirm `build-bun.ts` bakes `--define 'process.env.PODIUM_APP_VERSION="<pkg.version>"'` for `podium-server` (assert the define string is built from `package.json` version in a small unit if extractable; else document).
- [ ] **Step 4: run → pass**
- [ ] **Step 5: commit** `test(server): /version reports baked appVersion [podium-ium]`

---

### Task 7: desktop (Rust) — shell reads backend /version; manifest critical → non-dismissible

**Files:** Modify `apps/desktop/src-tauri/src/updater.rs` (non-dismissible path), `apps/desktop/src-tauri/src/bootstrap.rs` or `main.rs` (post-`wait_for_port` `/version` read + log). Add Rust unit tests where feasible (`#[cfg(test)]`).

**Design:**
- **Non-dismissible update:** in `check_and_prompt_update`, if the available `update.body` (release notes) begins with a `CRITICAL:` marker (set by the release process for a forced release), show a message dialog with **Ok only** (no Cancel) and proceed to install regardless — vs. today's `OkCancel`. Keep the optional `OkCancel` for normal updates. Add a pure helper `fn is_critical(body: &str) -> bool { body.trim_start().starts_with("CRITICAL:") }` with a unit test.
- **Shell↔backend check (LOW, log-only):** after `wait_for_port` succeeds (local all-in-one), GET `http://127.0.0.1:<port>/version`, parse `wireVersion`; log it; if it can't be read, log a warning. No hard failure (single-artifact keeps them matched).

- [ ] **Step 1: failing Rust test** — `is_critical("CRITICAL: security fix")==true`, `is_critical("normal notes")==false`, leading-whitespace tolerant.
- [ ] **Step 2: run → fail** `~/.cargo/bin/cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml is_critical`
- [ ] **Step 3: implement** `is_critical` + branch the dialog (Ok-only vs OkCancel) on it; add the post-`wait_for_port` `/version` read + log (best-effort, `reqwest`/`ureq` or a raw TCP GET — reuse whatever HTTP the crate already has; if none, a minimal `std::net` GET or skip the body parse and just log reachability).
- [ ] **Step 4: run → pass** unit test; then `~/.cargo/bin/cargo build --release --manifest-path apps/desktop/src-tauri/Cargo.toml` compiles (cold ~5-10 min). If a full `bun run --cwd apps/desktop build` is feasible, run it to confirm the bundle builds.
- [ ] **Step 5: commit** `feat(desktop): non-dismissible critical update + backend /version check [podium-ium]`

---

## Final verification
- [ ] `bun run typecheck` clean; `bun run vitest run` (branch suites green); `bunx vitest run --root apps/web` green; `shellcheck install.sh`; `scripts/install-sh.test.sh` ALL OK; `bun run --filter @podium/web build` OK; `~/.cargo/bin/cargo test`/`build` for the desktop.
- [ ] Smoke: boot server from source, confirm `/version` returns `{wireVersion, minSupportedVersion, appVersion}`; a `?v=99` client WS gets 426; a `?v=1` connects.

## Coverage map
| Spec component | Task |
|---|---|
| rename pv→v | 1 (helper), 2 (server), 3 (daemon), 4 (web) |
| MIN_SUPPORTED_VERSION + classification | 1 |
| server gate + /version | 2 |
| daemon self-heal | 3 |
| web v-handshake + hard-reload | 4 |
| systemd auto-update + install wiring | 5 |
| appVersion bake | 6 |
| desktop non-dismissible + shell↔backend | 7 |
