# Podium auto-update: release-time keys

The auto-update machinery uses separate signing systems for the headless tarball and desktop
AppImage. Before cutting a real public release, an operator must verify that the CI private keys
match the committed public keys. Private keys are operator secrets and must never be committed.
GitHub Releases is the production feed [spec:SP-7f2c].

## The version is single-sourced

Root `package.json` `"version"` is the **one source of truth**:

- `scripts/build-bun.ts` reads it → writes `dist-bun/headless/VERSION` **and** bakes it into the
  compiled `podium-server` via `bun build --compile --define 'process.env.PODIUM_APP_VERSION="<v>"'`
  (env `PODIUM_APP_VERSION` overrides for one-off builds). The server's `GET /version` then reports
  the real version instead of `dev`.
- `apps/desktop/scripts/stage-sidecar.ts` copies the same version into
  `apps/desktop/src-tauri/tauri.conf.json` before the Tauri build, so desktop + headless agree.

**To release a new version: bump `package.json` `"version"` only.** Everything else follows.

## Swap 1 — headless signing key (Ed25519)

The headless tarball is signed/verified with a **raw Ed25519** keypair (Node/Bun `crypto`), separate
from the desktop minisign key.

- Build signs `podium-headless-<v>.tar.gz` → `…​.tar.gz.sig` using
  `PODIUM_UPDATE_SIGNING_KEY` (base64 pkcs8/DER private key) if set, else the gitignored dev key
  `scripts/.podium-update-dev.key`.
- `podium update` verifies the manifest's `signature` over the downloaded bytes against
  `PODIUM_UPDATE_PUBKEY` (`apps/cli/src/podium-update-pubkey.ts`) **before** extracting/swapping. A bad/
  missing signature → no swap, `exitCode=1`.

**Release steps:**
1. Generate a production keypair:
   `bun -e 'const{generateKeyPairSync}=require("node:crypto");const{privateKey,publicKey}=generateKeyPairSync("ed25519");console.log("PRIV",privateKey.export({type:"pkcs8",format:"der"}).toString("base64"));console.log("PUB",publicKey.export({type:"spki",format:"der"}).toString("base64"))'`
2. Keep `PRIV` in the operator's secret store; set it as `PODIUM_UPDATE_SIGNING_KEY` in the build/CI
   env (never commit it).
3. Replace the `PODIUM_UPDATE_PUBKEY` constant in `apps/cli/src/podium-update-pubkey.ts` with `PUB` and
   commit it. The pubkey and the build-env private key must stay in lockstep.

## Swap 2 — desktop minisign key (Tauri)

The desktop AppImage path already verifies its `.sig` (minisign) against the `pubkey` in
`apps/desktop/src-tauri/tauri.conf.json`. This is a **separate** keypair from Swap 1 and is already
wired — at release, generate a real Tauri minisign key (`tauri signer generate`), sign the AppImage
with it (Tauri build env `TAURI_SIGNING_PRIVATE_KEY` / `…_PASSWORD`), and replace the placeholder
`updater.pubkey` in `tauri.conf.json`.

## Release feeds

Production feeds are GitHub Releases:

- **Headless:** `podium update` selects the stable GitHub release or rolling `edge` release from
  `updateChannel`; its explicit environment/config feed overrides remain available for tests.
- **Desktop:** release builds select the stable or edge static `latest.json` from the same
  persisted `updateChannel`. Debug builds do not check production feeds.

Desktop artifacts are cut only through the manual workflow documented in
[Desktop releases](desktop-releases.md).

## Update manifest levers

The release manifest adds structured update metadata without changing the manual version-bump workflow.

### `critical`

Pass `--critical` when the release contains a change that must be installed before the user continues.

### `minRequired`

Pass `--min-required '<json>'` explicitly to set minimum versions for the surfaces that need a retirement floor.

The object may contain `desktop`, `web`, and `mobile` floors; `mobile` may set `ios` and `android` independently.

For a mobile/store platform, raise its floor only after the replacement is confirmed live in that store. Raising it earlier can strand users whose replacement has not shipped, and a store release cannot be rolled back.

Never derive `minRequired` from the version being cut. If it is not passed, it is absent from the manifest.

### Digests and notes

Artifact digests are computed automatically from the prepared bytes for each platform; operators do not provide them and they never gate compatibility.

Release notes come from the matching version section in root `CHANGELOG.md`; the `[Unreleased]` section is never shipped.

If the version has no changelog section, or its section is empty, the manifest omits `notes`; the dialog correctly omits "What's new".

## Summary

| # | Swap | Where |
|---|------|-------|
| 1 | Headless Ed25519 key | env `PODIUM_UPDATE_SIGNING_KEY` (build) + `apps/cli/src/podium-update-pubkey.ts` (commit) |
| 2 | Desktop minisign key | Tauri signing env + `tauri.conf.json` `updater.pubkey` |
| — | Version bump | `package.json` `"version"` (single source; flows to both) |
