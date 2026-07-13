/**
 * Public key for verifying the HEADLESS self-update tarball's Ed25519 signature.
 *
 * This is the base64 (SPKI/DER) Ed25519 public key whose matching private key signs
 * `podium-headless-<v>.tar.gz` at build time (build-bun.ts) and which `podium update`
 * (podium-update.ts) verifies the downloaded bytes against BEFORE swapping the install.
 *
 * PRODUCTION KEY — the committed value below is the production public key. Its matching
 * private half is the operator secret PODIUM_UPDATE_SIGNING_KEY (set in CI / the build
 * env), used to sign `podium-headless-<v>.tar.gz` at release time. Keep this value in
 * lockstep with install.sh's PUBKEY default (scripts/install-pubkey.test.ts enforces it).
 * The Tauri minisign `pubkey` in apps/desktop/src-tauri/tauri.conf.json is a separate key.
 */
export const PODIUM_UPDATE_PUBKEY = 'MCowBQYDK2VwAyEAG12/153QJI/SePyYeJQhBSbh1ZsFgkoMkwb823NiYOU='
