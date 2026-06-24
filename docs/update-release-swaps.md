# Podium auto-update: release-time swaps

The auto-update machinery (headless tarball + desktop AppImage) ships with **dev/placeholder**
keys and a placeholder feed host so the whole chain round-trips locally. Before cutting a real
public release, an operator must perform exactly **three swaps**. None of them are in the repo by
default — they are the operator's secrets / infra.

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
  `PODIUM_UPDATE_PUBKEY` (`scripts/podium-update-pubkey.ts`) **before** extracting/swapping. A bad/
  missing signature → no swap, `exitCode=1`.

**Release steps:**
1. Generate a production keypair:
   `bun -e 'const{generateKeyPairSync}=require("node:crypto");const{privateKey,publicKey}=generateKeyPairSync("ed25519");console.log("PRIV",privateKey.export({type:"pkcs8",format:"der"}).toString("base64"));console.log("PUB",publicKey.export({type:"spki",format:"der"}).toString("base64"))'`
2. Keep `PRIV` in the operator's secret store; set it as `PODIUM_UPDATE_SIGNING_KEY` in the build/CI
   env (never commit it).
3. Replace the `PODIUM_UPDATE_PUBKEY` constant in `scripts/podium-update-pubkey.ts` with `PUB` and
   commit it. The pubkey and the build-env private key must stay in lockstep.

## Swap 2 — desktop minisign key (Tauri)

The desktop AppImage path already verifies its `.sig` (minisign) against the `pubkey` in
`apps/desktop/src-tauri/tauri.conf.json`. This is a **separate** keypair from Swap 1 and is already
wired — at release, generate a real Tauri minisign key (`tauri signer generate`), sign the AppImage
with it (Tauri build env `TAURI_SIGNING_PRIVATE_KEY` / `…_PASSWORD`), and replace the placeholder
`updater.pubkey` in `tauri.conf.json`.

## Swap 3 — feed host

Both feeds are pluggable and ship with placeholder/localhost defaults:

- **Headless:** `podium update` reads the feed base from env `PODIUM_UPDATE_FEED`, else config
  `updateFeed` (`packages/core/src/config.ts`), else `http://127.0.0.1:8789` (dev). The manifest URL
  is `<feed>/update/<target>/x86_64/<current>`.
- **Desktop:** `updater.endpoints` in `tauri.conf.json`
  (`https://releases.podium.app/update/{{target}}/{{arch}}/{{current_version}}` placeholder).

At release, point both at the real release host (which serves the Tauri-shaped manifest
`{ version, platforms: { "linux-x86_64": { url, signature } } }` plus the artifacts + `.sig`).

## Summary

| # | Swap | Where |
|---|------|-------|
| 1 | Headless Ed25519 key | env `PODIUM_UPDATE_SIGNING_KEY` (build) + `scripts/podium-update-pubkey.ts` (commit) |
| 2 | Desktop minisign key | Tauri signing env + `tauri.conf.json` `updater.pubkey` |
| 3 | Feed host | `PODIUM_UPDATE_FEED` / config `updateFeed` + `tauri.conf.json` `updater.endpoints` |
| — | Version bump | `package.json` `"version"` (single source; flows to both) |
