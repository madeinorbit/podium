# Daemon update hardening — Implementation Plan

**Epic:** POD-2087 · **Spec:** `2026-08-14-update-operations-design.md` §4, §10.3
**Protocol:** `2026-08-14-updater-worker-protocol.md`
**Blocked by:** nothing — land first. Replaces the retired top-level bugs POD-2088/2089/2090.

**Goal:** Three defects, one coherent daemon/CLI slice: (1) desktop-supervised daemons must
never be granted by convergence waves; (2) the pending-grant marker must be crash-safe;
(3) prerelease versions must compare correctly in unattached self-update.

**Owns:** `apps/daemon/src/build-report.ts`, `apps/daemon/src/pending-grant.ts`,
`apps/cli/src/podium-update.ts`, `apps/server/src/modules/updates/wave.ts` (filter only),
`packages/protocol` build-report schema (additive field), matching tests.

## Context

- A desktop-supervised daemon runs under `PODIUM_DESKTOP_SUPERVISED=1` (`apps/desktop/src-tauri/src/main.rs:32-45`).
  On macOS all-in-one it runs in place inside `Podium.app` and reports
  `installKind: 'installed'` with feed+bundle caps — a wave grant would let
  `swapHeadlessBundle` (`apps/daemon/src/update-install.ts:31-58`) rename directories
  inside the signed .app. On Linux the sidecar is copied to `~/.podium/bin/podium-sidecar`,
  so `deriveInstallKind` (`apps/daemon/src/build-report.ts:36-48`) misclassifies it as a
  source run with git caps. Nothing server-side excludes these machines from waves.
- `writePendingGrant` (`apps/daemon/src/pending-grant.ts:37`) is a bare `writeFileSync`
  called immediately before a deliberate process exit; a truncated file parses as `null`
  (`:32-34`) and boot reconciliation (`apps/daemon/src/host-runtime.ts:316-362`) silently
  skips — a failed update is reported as nothing.
- `isNewer` (`apps/cli/src/podium-update.ts:65-74`) does `Number()` per dot segment:
  `0.1.4-edge.4` → `NaN` in slot 3, and the comparison degrades. Repo versions ARE
  prereleases, so unattached edge installs may never self-update.

## Tasks

- [ ] **Supervised in the build report** — read `PODIUM_DESKTOP_SUPERVISED` in
  `build-report.ts`; report `supervised: true` (additive optional field on the build-report
  schema in `packages/protocol`; absent = false, per the frozen-contract law) and, when
  supervised, report `deliveryCaps: []` — belt and braces: even an old server that ignores
  the flag has nothing it can deliver. Unit tests for all three shapes (mac in-place, linux
  copied sidecar, plain installed).
- [ ] **Server-side exclusion** — `wave.ts`: `machineCanTakeDelivery` returns false for
  `supervised`; `planWave` never selects a supervised machine (including as canary). The
  fleet projection labels the machine so the UI can later say "managed by Podium Desktop"
  — expose `supervised` on the machine row (additive), no UI change here.
- [ ] **Atomic pending marker** — `pending-grant.ts`: write `pending-update.json.tmp` in
  the same directory, `renameSync` over the target, fsync the file before rename. Test:
  simulate a torn write (write garbage to the real path, then a good atomic write) and
  assert the read path never sees a half state; prove the old failure once by reverting to
  the direct write in-test.
- [ ] **Prerelease-safe compare** — replace `isNewer` with a correct semver comparison
  including prerelease ordering (numeric identifiers compare numerically, alphanumeric
  lexically, release > prerelease; no new dependency — ~30 lines). Table-driven tests:
  `0.1.4` vs `0.1.4-edge.4`, `0.1.4-edge.4` vs `0.1.4-edge.10`, equal versions, malformed
  input (fail closed: not newer). Keep the attached-daemon path untouched (it uses target
  equality, correctly).

## Testing

`bun run typecheck`; `bun run test:related -- apps/daemon/src/build-report.ts
apps/daemon/src/pending-grant.ts apps/cli/src/podium-update.ts
apps/server/src/modules/updates/wave.ts`; then `bun run test`. The signed-feed smoke
`bash scripts/verify-headless-update.sh` must still pass (it exercises `podium-update.ts`).

## Acceptance

- A supervised build report can never be selected by `planWave` (test proves the filter
  fires by flipping the flag).
- Torn-marker test red-then-green as described.
- `verify-headless-update.sh` both arms green.
