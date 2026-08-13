# Desktop releases

Podium has two production desktop update channels:

- **stable** reads `releases/latest/download/latest.json`.
- **edge** reads `releases/download/edge/latest.json`.

The desktop shell reads `updateChannel` from `$PODIUM_STATE_DIR/config.json`, falling back to
`~/.podium/config.json` and then to `stable`. Debug builds made by `tauri dev` do not contact
either production feed or show the updater prompt. Development is not a release channel.

## Releasing is one tag push

Pushing a version tag releases both halves — headless assets and the desktop bundles — to the
channel the tag names:

| Tag | Channel | Assets land in |
| --- | --- | --- |
| `v0.2.0` | stable | a new `v0.2.0` release |
| `v0.2.0-edge.1` | edge | the rolling `edge` release |

A prerelease tag that names no channel (`v0.2.0-rc1`) is refused rather than guessed at.

This is still an explicit promotion, not a per-push build [spec:SP-7f2c]: pushing `main` refreshes
nothing desktop-side, and only a deliberate tag releases. The **desktop release** workflow can also
still be dispatched by hand to re-promote a commit without minting a new tag.

The tag and the root `package.json` version must agree — the workflow checks and refuses a
mismatch, because the tag names the release while `package.json` names the version the updater
advertises, and a disagreement publishes a manifest nobody can install.

Both workflows start from the same tag push. The desktop half waits for the release the headless
half creates rather than failing on the ordering, so a notarized build is never discarded over a
few seconds of race.

## Version and signing prerequisites

The root `package.json` version is the source of truth for the desktop and bundled headless
app. It must be greater than the version installed by the clients being updated. Use ordinary
SemVer for stable (`0.2.0`) and an ordered prerelease for edge (`0.3.0-edge.1`, then
`0.3.0-edge.2`). Re-publishing the same version does not trigger Tauri's updater.

GitHub Actions must contain `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The private key must match `plugins.updater.pubkey` in
`apps/desktop/src-tauri/tauri.conf.json`; changing the key strands existing installations.

### macOS Developer ID signing and notarization

Apple Silicon builds are signed with a Developer ID Application certificate, hardened, notarized
by Apple, and stapled, so a downloaded DMG opens without a Gatekeeper warning. This is separate
from the Tauri updater key: Apple's signature is what macOS trusts, and the Tauri key is what the
updater trusts. A release needs both.

These GitHub Actions secrets drive it. A missing one does not fail loudly at Apple — it degrades to
a signed-but-un-notarized bundle — so the build runs `apps/desktop/scripts/verify-macos-signing.sh`
and refuses to publish unless the bundle is genuinely notarized.

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | password used when exporting that `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: NAME (TEAMID)`, exactly as `security find-identity -v -p codesigning` prints it |
| `APPLE_TEAM_ID` | the 10-character Apple Team ID |
| `APPLE_API_KEY` | App Store Connect API **Key ID** |
| `APPLE_API_ISSUER` | App Store Connect API **Issuer ID** |
| `APPLE_API_KEY_CONTENT` | the literal contents of `AuthKey_<KEYID>.p8` — PEM, including the `BEGIN`/`END PRIVATE KEY` lines |

Notarization uses an App Store Connect API key rather than an Apple ID and app-specific password:
no personal account is coupled to releases, and there is no password to rotate when someone leaves.

Two pieces of the macOS build are easy to get wrong when changing it:

- **The bundled `podium` sidecar is signed separately**, by `apps/desktop/scripts/stage-sidecar.ts`,
  before `tauri build` seals the app. Tauri does not sign inside `resources/`, and Apple rejects a
  bundle containing any unsigned Mach-O. That is also why the release workflow imports the
  certificate into a keychain itself instead of passing `APPLE_CERTIFICATE` to Tauri — Tauri's own
  import happens after staging.
- **The sidecar needs JIT entitlements** (`entitlements.sidecar.plist`). It is a `bun --compile`
  binary embedding JavaScriptCore; under the hardened runtime without those entitlements it dies at
  startup. The app shell deliberately gets the narrower `entitlements.plist`.

The Developer ID certificate expires five years after issue. Expiry breaks *new* signing only;
already-notarized releases keep working. Renew before it lapses — the certificate cap is 5 per team.

Only Apple Silicon macOS is built. Intel Macs have no macOS build on either channel.

## Cut an edge release

1. Set the edge SemVer in the root `package.json` (`0.3.0-edge.1`, then `0.3.0-edge.2`, …) and
   merge it to `main`.
2. Tag that commit and push the tag:
   ```bash
   git tag v0.3.0-edge.1 && git push origin v0.3.0-edge.1
   ```

Both workflows run. The desktop half builds Linux x86_64 and macOS Apple Silicon in parallel, and
only after both succeed does it deterministically regenerate and validate one `latest.json`
against both detached signatures and the rolling `edge` URLs. It uploads the AppImage, macOS DMG,
macOS updater archive, signatures, and manifest without replacing the headless assets.

Later pushes to `main` refresh the headless edge files in place and preserve this desktop version
until the next edge tag.

## Cut a stable release

1. Set the stable SemVer in the root `package.json` and merge it.
2. Tag and push:
   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

The workflow builds that immutable tag and refuses a tag that disagrees with `package.json`.

## Release notes and required updates

`release_notes` is a **dispatch-only** input, so a tag-driven release ships no updater notes. When
a release needs them — in particular the `CRITICAL:` prefix that triggers the non-dismissible
required-update prompt — dispatch **desktop release** by hand for that release instead of tagging,
selecting the channel and, for stable, the `release_tag`.

## Existing-install bridge

Desktop versions released before channel-aware endpoints always query stable. To move existing
edge-configured installations onto the edge feed:

1. Cut one stable bridge release containing the channel-aware updater.
2. Let clients install and restart into that version.
3. Cut a strictly newer edge desktop release.

After the bridge restart, clients whose config already says `updateChannel: "edge"` will query
the rolling edge manifest. There is no way for an older stable-only binary to discover that
manifest directly.

## Release verification

CI proves the macOS bundle is notarized before publishing. The remaining manual check is Gatekeeper
on a machine that did not build it — download the published DMG through a browser (so it carries
the quarantine attribute a `gh release download` does not) and open it. No warning, no Privacy &
Security approval step. `spctl --assess --type exec -vvv /Applications/Podium.app` should say
`source=Notarized Developer ID`.

For a real release, verify from an older signed AppImage or macOS app whose embedded public key
matches the release signing key:

1. launch with an isolated `PODIUM_STATE_DIR` containing the intended `updateChannel`;
2. observe the real update prompt;
3. accept it and confirm the AppImage changes on disk;
4. confirm the promoted version after restart.

Repository tests validate routing, debug suppression, workflow triggers, and manifest contents,
but they do not replace this signed end-to-end release check.
