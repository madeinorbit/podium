# Pinned native updater recovery API

This is the Rust build subset of crates.io `tauri-plugin-updater` 2.10.1, archive
SHA-256 `806d9dac662c2e4594ff03c647a552f2c9bd544e7d0f683ec58f872f952ce4af`,
upstream commit `d6a3898001a4bcc659e045f9501498751b77dbe6` (`plugins/updater`).
Upstream MIT and Apache licenses are retained. Cargo manifest, runtime sources,
build script, JavaScript bridge, and permissions are copied from that archive;
only `src/updater.rs` has local code changes.

POD-3456 adds the Rust-only `Updater::update_from_release` constructor. The pinned
plugin otherwise creates `Update` only after a rolling feed returns a newer release;
its private verifier/installer fields prevent callers from reconstructing an already
approved target. The constructor shares the original field construction with `check`,
retaining configured signing key, transport, platform installer, and restart settings.
It parses the normal release metadata but deliberately does not call a feed or the
version comparator. No new JavaScript command or permission is exposed.

The caller must supply independently authorized immutable metadata and retain its
admission checks. `Update::download` still performs the original minisign verification;
installation code is unchanged. TLS initialization is shared with direct download so
recovery does not require an earlier check to select the crypto provider/Linux CA defaults.

Focused regressions check verifier and installer configuration preservation without
invoking discovery, plus actual HTTP Accept headers for both direct construction and
ordinary feed discovery/download (JSON for feeds, octet-stream for artifacts, and
caller-supplied Accept preserved). `scripts/native-machine-update.integration.ts` exercises the real
Linux shell, signed download, rejection, replacement, and supervisor recovery when
the rolling feed advertises the current/older version or answers HTTP 204/503.

When upgrading, compare `src/updater.rs` against the exact upstream archive and port
this small API change, or drop the vendor copy if upstream provides equivalent
construction. Do not replace the pinned crate without the native boundary proof.
