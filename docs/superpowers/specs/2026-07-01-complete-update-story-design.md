# Complete update story — v-handshake, forced updates, daemon self-heal — design

- **Date:** 2026-07-01
- **Issue:** podium-ium
- **Status:** Design (awaiting review)

## Goal

Close the version-compatibility / forced-update gaps found in the release-readiness audit, so a
`WIRE_VERSION` bump (or any breaking protocol change) can't silently break peers, and so a
critical fix can be *forced* to reach clients when we choose. Also rename the wire param `pv` → `v`
(product-name-agnostic — the product may be renamed away from "podium").

## Audit recap (what's broken today)

- **web ↔ server: no compat check.** The web WS omits the version param, so the server's `426`
  gate (`wsServer.ts:254`) structurally can't fire for it, and the web never reads `/version`.
  Because the web ships as a **PWA behind a service-worker cache**, a stale client is the *default*
  after a deploy → on a `WIRE_VERSION` bump every cached client connects "fine" then silently
  degrades on dropped frames. **HIGH risk.**
- **Nothing is forced anywhere.** Tauri update is a dismissible OkCancel; `podium update` is manual
  (no timer/boot hook); no server-side minimum-supported-version. **MEDIUM.**
- **Mismatched daemon loops forever** (`daemon.ts` reconnects on `426`, never gives up / self-updates).
  A `WIRE_VERSION` bump disconnects the whole remote fleet until each box is updated by hand. **MEDIUM.**
- **shell↔backend is a bare TCP-accept check; `appVersion` is `'dev'` unless baked.** **LOW.**

## Scoping insight (from the desktop web-loading analysis)

The desktop is **safe-by-construction**: local mode ships bundled web + bundled backend together
(matched); remote mode loads the *remote relay's own* web same-origin (matched). So web↔backend
skew only afflicts **plain browser tabs / phones** (PWA-cached) and **daemons**. Fix #1 therefore
targets the browser web client; the desktop webview inherits it but isn't the exposed surface.

## Non-goals

- No inline-web-update / split shell-vs-content updating for the desktop (analysis showed it's not
  worth the version-skew + read-only-bundle complexity).
- No change to the two-updater split (headless Ed25519 + desktop minisign) or the web-loading modes.
- macOS/Windows/arm64 desktop builds (tracked separately).

## Design

### Version contract

`WIRE_VERSION` (int, currently `1`, `packages/protocol/src/version.ts`) stays the single wire
contract. Add a **`MIN_SUPPORTED_VERSION`** (int, ≤ `WIRE_VERSION`) — the oldest wire version the
server still accepts. Compat becomes: a peer with `v < MIN_SUPPORTED_VERSION` is *force-updated*;
`MIN_SUPPORTED_VERSION ≤ v < WIRE_VERSION` is tolerated (soft); `v > WIRE_VERSION` is rejected.
For now `MIN_SUPPORTED_VERSION = WIRE_VERSION = 1` (exact-match behavior preserved) — the mechanism
is what we're adding; you raise `MIN_SUPPORTED_VERSION` per breaking release to *force*.

### Rename `pv` → `v`

- `apps/daemon/src/daemon.ts:1771` connect URL `?pv=` → `?v=`; log at `:1841` `pv=` → `v=`.
- `apps/server/src/wsServer.ts:259-260` read `v` (accept `pv` as a deprecated alias for one release
  so an in-flight old daemon still parses — optional, low cost).
- Any protocol constant/comment referencing `pv`.

### Component 1 — web ↔ server v-handshake + hard-reload (`apps/web`, `apps/server`)

- **Web sends `?v=${WIRE_VERSION}`** on the `/client` WS (`apps/web/src/trpc.ts:47,65`).
- **Boot + reconnect version check:** on app boot and on every WS (re)connect, fetch `/version` and
  compare `wireVersion`. On mismatch (or on a `426` close from the server), do a **hard reload**:
  a new `packages/…`/`apps/web` helper `forceReload()` that unregisters all service workers,
  `caches.delete()`s all caches, then `location.reload()` — so the stale PWA shell is evicted and
  the fresh client loads. Guard against reload loops (only reload if the *served* version actually
  differs from the running bundle's baked `WIRE_VERSION`).
- **Server** exposes `wireVersion` + `minSupportedVersion` on `/version` (already returns
  `wireVersion`; add `minSupportedVersion`).

### Component 2 — server `minSupportedVersion` + version-gated forcing (`apps/server`, `packages/protocol`)

- The `wsServer` gate (`:254-262`) uses `MIN_SUPPORTED_VERSION`: `v < MIN` → `426` (force);
  `MIN ≤ v ≤ WIRE` → allow. A peer with no `v` is still allowed (back-compat), BUT the web now
  always sends `v`, and daemons always send `v`, so the only no-`v` peers are truly ancient.
- `/version` publishes `minSupportedVersion` so clients can self-assess and force-reload/update
  without needing to fail a connection first (proactive).
- "Force if we want" = raise `MIN_SUPPORTED_VERSION` in a release; older peers are then forced.

### Component 3 — daemon self-heal + auto-update (`apps/daemon`, `scripts/systemd`)

- **Self-heal on `426`:** on a protocol-mismatch reject, the daemon runs `podium update` (headless
  self-update, honoring the configured channel) and exits; the systemd unit (`Restart=always`)
  restarts it into the new binary. Stop the infinite same-version reconnect loop: after N
  consecutive `426`s, attempt update; if update yields no newer version, back off to a long
  interval + emit a clear "manual update required" log instead of hot-looping.
- **Scheduled auto-update (opt-in):** a `podium-update.timer` + `podium-update.service`
  (`scripts/systemd/`) that runs `podium update` on a cadence (default: daily) and restarts the
  daemon/server if a new version was installed. Documented; installed by `install.sh --join`
  optionally (a `--auto-update` flag) — default on for daemons, since remote fleets need it.

### Component 3b — headless auto-update timer (`scripts/systemd`)

The same `podium-update.timer` covers server + daemon on the source-run dev host is N/A (dev runs
from source), but for *installed* deployments the timer is the routine-update path (currently
manual-only). Ship the unit; `install.sh` wires it for `--join` daemons.

### Component 4 — bake `appVersion` + shell↔backend check (`scripts/build-bun.ts`, `apps/desktop`)

- **Verify** `build-bun.ts` bakes `PODIUM_APP_VERSION` from root `package.json` into the compiled
  `podium-server` (audit says it does via `--define`); add a test asserting a release build's
  `/version.appVersion` is the real version, not `'dev'`. Expose `appVersion` in the update UX.
- **Desktop shell ↔ backend (Rust, `apps/desktop/src-tauri/src`):** after `wait_for_port`, the shell
  reads the spawned backend's `/version`; if `wireVersion` is outside `[min, WIRE]` of what the
  shell was built against, log + surface (LOW; single-artifact makes this rare). **Force path:** the
  Tauri updater honors a `minSupportedVersion`/critical flag from the manifest → non-dismissible
  update dialog (or auto-install) when the running shell is below it; otherwise keep the optional
  prompt. (Verification of Rust changes is CI-only — no local cargo; flagged in the plan.)

## Behavior matrix (after)

| Peer below `MIN_SUPPORTED_VERSION` | Behavior |
|---|---|
| browser web client | boot/reconnect `/version` check or `426` → **hard reload** (SW+cache evicted) → fresh client |
| daemon | `426` → `podium update` + exit → systemd restarts into new binary; timer also updates routinely |
| desktop shell | manifest `minSupportedVersion` → **non-dismissible** Tauri update |
| server/daemon (installed) | `podium-update.timer` routine self-update |

## Testing strategy

- **protocol:** `MIN_SUPPORTED_VERSION` ≤ `WIRE_VERSION`; the `v < MIN` / `MIN ≤ v ≤ WIRE` / `v > WIRE`
  classification (pure fn); rename doesn't change semantics.
- **server:** `wsServer` gate — `426` for `v < MIN` and `v > WIRE`, allow for in-range, allow for
  absent `v`; `/version` returns `{wireVersion, minSupportedVersion, appVersion}`.
- **web:** `forceReload()` unregisters SW + clears caches + reloads (mock SW/caches/location);
  boot/reconnect check triggers reload only on a real mismatch (no reload loop when matched);
  `/client` URL carries `?v=`. Vitest + happy-dom.
- **daemon:** on simulated `426`, triggers update+exit (not infinite loop); back-off/give-up after N.
- **build:** a release build's `/version.appVersion` is the real version (integration; or unit over
  the `--define` wiring).
- **systemd:** `systemd-analyze verify` the timer + service.
- **desktop (Rust):** unit-test the version-classification + manifest-critical parsing where
  feasible; full build verified in CI (no local cargo).

## Build order

1. protocol: `MIN_SUPPORTED_VERSION` + classification fn + `pv→v` rename (leaf).
2. server: gate uses classification; `/version` publishes `minSupportedVersion`.
3. web: send `?v=`; `forceReload()`; boot/reconnect version check.
4. daemon: self-heal on `426` (update+exit, bounded loop).
5. systemd: `podium-update.timer`/`.service`; `install.sh --join` wires it (+ `--auto-update`).
6. build: assert `appVersion` bake; expose in `/version`.
7. desktop (Rust): shell reads backend `/version`; manifest `minSupportedVersion` → non-dismissible.
   (CI-verified.)

## Open decisions (defaults chosen; flag to change)

- **Forcing model:** version-gated via `MIN_SUPPORTED_VERSION` (not always-force). ✅ default.
- **Daemon auto-update:** scheduled timer (daily) + self-heal on mismatch, timer default-on for
  `--join` daemons. ✅ default.
- **`pv` alias:** accept `pv` as a deprecated alias for one release for in-flight old daemons. ✅ default.
