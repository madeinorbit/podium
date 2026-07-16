# Desktop releases

Podium has two production desktop update channels:

- **stable** reads `releases/latest/download/latest.json`.
- **edge** reads `releases/download/edge/latest.json`.

The desktop shell reads `updateChannel` from `$PODIUM_STATE_DIR/config.json`, falling back to
`~/.podium/config.json` and then to `stable`. Debug builds made by `tauri dev` do not contact
either production feed or show the updater prompt. Development is not a release channel.

Desktop builds are explicit promotions. Pushing `main` continues to refresh only the headless
assets in the rolling `edge` release; it does not build Tauri. Pushing a `v*` tag creates only
the stable headless release. The manually dispatched **desktop release** workflow adds the
signed AppImage, detached signature, and `latest.json` to one of those existing releases.

## Version and signing prerequisites

The root `package.json` version is the source of truth for the desktop and bundled headless
app. It must be greater than the version installed by the clients being updated. Use ordinary
SemVer for stable (`0.2.0`) and an ordered prerelease for edge (`0.3.0-edge.1`, then
`0.3.0-edge.2`). Re-publishing the same version does not trigger Tauri's updater.

GitHub Actions must contain `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The private key must match `plugins.updater.pubkey` in
`apps/desktop/src-tauri/tauri.conf.json`; changing the key strands existing installations.

## Cut an edge desktop release

1. Set the intended edge SemVer in the root `package.json`, merge it to `main`, and wait for the
   normal headless edge workflow to finish.
2. In GitHub Actions, open **desktop release**, choose **Run workflow** on `main`, and select
   `channel=edge`. Leave `release_tag` empty. Add optional `release_notes`; begin the notes with
   `CRITICAL:` only when clients must receive the existing non-dismissible required-update
   prompt.
3. The workflow builds the signed AppImage once, deterministically regenerates and validates
   `latest.json` against the `.sig` contents and the rolling `edge` URL, then uploads those three
   desktop assets without replacing the headless assets.

Later pushes to `main` refresh the headless edge files in place and preserve this promoted
desktop version until another explicit desktop edge promotion.

## Cut a stable desktop release

1. Set the stable SemVer in the root `package.json`, merge it, create the matching tag
   (`v0.2.0` for version `0.2.0`), and push the tag.
2. Wait for the tag-triggered headless workflow to create the stable GitHub release.
3. Dispatch **desktop release** with `channel=stable` and `release_tag=v0.2.0`. The workflow
   checks out that immutable tag and refuses a missing or mismatched tag before the desktop
   build. Optional `release_notes` are embedded in the updater manifest; a leading `CRITICAL:`
   keeps the established required-update behavior.

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

For a real release, verify from an older signed AppImage whose embedded public key matches the
release signing key:

1. launch with an isolated `PODIUM_STATE_DIR` containing the intended `updateChannel`;
2. observe the real update prompt;
3. accept it and confirm the AppImage changes on disk;
4. confirm the promoted version after restart.

Repository tests validate routing, debug suppression, workflow triggers, and manifest contents,
but they do not replace this signed end-to-end release check.
