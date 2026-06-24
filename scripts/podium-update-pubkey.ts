/**
 * Public key for verifying the HEADLESS self-update tarball's Ed25519 signature.
 *
 * This is the base64 (SPKI/DER) Ed25519 public key whose matching private key signs
 * `podium-headless-<v>.tar.gz` at build time (build-bun.ts) and which `podium update`
 * (podium-update.ts) verifies the downloaded bytes against BEFORE swapping the install.
 *
 * DEV KEY — the committed value below is the throwaway development key whose private
 * half lives in scripts/.podium-update-dev.key (gitignored). It lets the local feed +
 * `podium update` round-trip end to end in development.
 *
 * ⚠️ RELEASE SWAP: before shipping to a real (non-localhost) feed, generate a production
 * Ed25519 keypair, keep the private key in the operator's secret store (passed to the
 * build via env PODIUM_UPDATE_SIGNING_KEY), and REPLACE the constant below with the
 * matching production public key. This is the headless analogue of the Tauri minisign
 * `pubkey` in apps/desktop/src-tauri/tauri.conf.json (which stays separate + untouched).
 */
export const PODIUM_UPDATE_PUBKEY =
  'MCowBQYDK2VwAyEA2jxohkpxHU7sQQjCjWqeuHomf9TlC3lwmS5lmN3ICYM='
