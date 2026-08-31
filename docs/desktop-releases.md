# Desktop releases

Podium desktop shells understand three update channels:

- **stable** reads `releases/latest/download/latest.json`.
- **edge** reads `releases/download/edge/latest.json`.
- **dev** reads the attached source server’s `/updates/feed/dev/latest.json`. That manifest
  references the current edge shell by GitHub asset URL; a dev release never builds or signs a
  shell of its own.

**Channel authority: the attached server first, the shell's own config only as a fallback.**
When the page drives an update it passes the channel explicitly and that choice wins
(`resolve_update_channel` takes it as its argument). The shell's own `updateChannel` — read
from `$PODIUM_STATE_DIR/config.json`, falling back to `~/.podium/config.json` and then to the
channel stamped into the installed build — is what a shell resolves with when nobody supplied one: no server attached, or the
native fallback path below. One channel, resolved in one place, rather than the page and the
shell each having an opinion.

If no page claims the update within the ownership grace window, the shell shows a native
dialog and installs from that resolved channel itself, so a shell whose webview cannot load
is still updatable. It is a real dialog, not a log line. `PODIUM_UPDATE_TEST_AUTOCONFIRM=1`
skips the confirmation and exists only for the verification script — never set it on a real
install.

Debug builds made by `tauri dev` do not contact any update feed or show the updater
prompt. A released shell on the dev channel does: the page persists both `updateChannel: "dev"`
and its server-specific `updateFeedEndpoint` into `config.json`, so the page-driven and native
fallback paths check the same manifest.

## Releasing is one tag push

Pushing a version tag publishes the headless release target to the named channel. It also
publishes a desktop bundle only when the shell-input hash changed; otherwise it carries the
standing shell manifest forward:

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

Both workflows start from the same tag push. The desktop workflow validates the shell-input hash
first and skips all platform builders when the standing shell already has that hash. When it does
mint, it waits for the release the headless half creates rather than discarding a notarized build
over a few seconds of ordering.

## Version and signing prerequisites

A shell’s version is the version baked into that shell artifact and reported by the native
bridge. It is never derived from the headless target. Consequently a dev machine normally reports
an edge shell version next to a newer dev headless version; that divergence is expected. Tauri
installs only when `latest.json` names a shell version newer than the installed one.

The desktop workflow hashes the shell inputs (`apps/desktop/src-tauri` plus
`apps/desktop/scripts/stage-sidecar.ts`, which defines the staged-resource layout). It mints a new
shell only when that hash differs from the standing channel shell. A headless-only release carries
forward the standing `latest.json` and `desktop-shell-input.sha256`, so its shell version and URLs
stay unchanged.

GitHub Actions must contain `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The private key must match `plugins.updater.pubkey` in
`apps/desktop/src-tauri/tauri.conf.json`; changing the key strands existing installations.

### Windows installer

The Windows x86_64 leg runs on `windows-latest` and builds an NSIS `-setup.exe`. The same
installer is the Tauri updater payload, with its detached `.sig` included in `latest.json` under
`windows-x86_64`. The regular Windows smoke compiles the Tauri executable without making an
installer, launches it against a real local Podium server, and fails if native setup or the
WebView2 window cannot stay alive.

The Tauri updater signature verifies Podium updates, but it is not a Windows Authenticode
signature. Until an Authenticode certificate is provisioned, Windows may show a publisher or
SmartScreen warning for a freshly downloaded installer.

### macOS Developer ID signing and notarization

macOS builds (Apple Silicon and Intel) are signed with a Developer ID Application certificate, hardened, notarized
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

Set the multi-line ones **from the file**, never by pasting into an interactive prompt — `gh secret
set` reads a single line from a terminal, so a pasted PEM silently stores only its header:

```bash
gh secret set APPLE_API_KEY_CONTENT < AuthKey_KEYID.p8
openssl base64 -A -in cert.p12 | gh secret set APPLE_CERTIFICATE
```

Two pieces of the macOS build are easy to get wrong when changing it:

- **The bundled `podium` sidecar is signed separately**, by `apps/desktop/scripts/stage-sidecar.ts`,
  before `tauri build` seals the app. Tauri does not sign inside `resources/`, and Apple rejects a
  bundle containing any unsigned Mach-O. That is also why the release workflow imports the
  certificate into a keychain itself instead of passing `APPLE_CERTIFICATE` to Tauri — Tauri's own
  import happens after staging.
- **The sidecar needs JIT entitlements** (`entitlements.sidecar.plist`). It is a `bun --compile`
  binary embedding JavaScriptCore; under the hardened runtime without those entitlements it dies at
  startup. The app shell deliberately gets the narrower `entitlements.plist`.
- **The DMG is notarized separately**, by `apps/desktop/scripts/notarize-dmg.sh`. Tauri notarizes
  and staples the `.app` and then builds the DMG *around* it, leaving the disk image itself
  unnotarized — and the DMG is what a browser downloads and what carries the quarantine flag, so
  without this step users still get "Apple cannot check it for malicious software" on first
  double-click even though the app inside is notarized.

### What the entitlements are for

The plists themselves carry no comments, and must not: `codesign` parses entitlements with
`AMFIUnserializeXML`, a restricted reader that rejects XML comments outright with `syntax error
near line N` and fails the build. So the explanation lives here.

| Entitlement | Where | Why |
| --- | --- | --- |
| `com.apple.security.cs.allow-jit` | both | WebKit's JS engine in the shell; JavaScriptCore in the Bun sidecar. Hardened runtime forbids writable-executable memory without it. |
| `com.apple.security.cs.allow-unsigned-executable-memory` | sidecar only | Bun's compiled binary needs it to start. It is a real weakening of the runtime, so the shell does not get it. |

`com.apple.security.cs.disable-library-validation` is deliberately absent. It is the next knob if
the sidecar ever fails to start with a code-signing error after loading a native module, but it
lets any unsigned dylib load into the process, so do not add it speculatively.

The Developer ID certificate expires five years after issue. Expiry breaks *new* signing only;
already-notarized releases keep working. Renew before it lapses — the certificate cap is 5 per team.

Both macOS architectures are built natively on GitHub-hosted runners: Apple Silicon on `macos-15`
and Intel on `macos-15-intel` (cross-compiling would leave the Bun sidecar and abduco on the wrong
architecture).

## Cut a release

Write what changed under `## [Unreleased]` in `CHANGELOG.md`, merge to `main`, then:

```bash
bun run release:cut 0.3.0-edge.1   # edge
bun run release:cut 0.3.0          # stable
```

That one command bumps `package.json`, promotes the `Unreleased` section to a heading for the new
version, commits, tags `v<version>`, and pushes the branch and the tag. The tag push is what starts
the release, and it goes last — so a failed branch push never leaves CI building a commit that
never landed.

Useful flags: `--dry-run` prints the version transition and the notes it would ship, changing
nothing; `--no-push` commits and tags locally so you can inspect before pushing.

It refuses, before creating anything, a version that is not greater than the current one, a version
that is neither `X.Y.Z` nor `X.Y.Z-edge.N`, a dirty tree, a branch out of sync with its remote, and
a tag that already exists.

Both workflows then run from that tag. If the shell hash changed, the desktop half builds Linux
x86_64, Windows x86_64, macOS Apple Silicon, and macOS Intel in parallel. Only after all succeed does it
regenerate and validate `latest.json`, upload the signed shell assets (the AppImage, Windows NSIS
installer, macOS DMGs, updater files, signatures, and manifest), and publish the new input hash. If the
hash did not change, those jobs are skipped and the headless publisher re-uploads the standing
manifest reference instead.

`latest.json` carries `bridgeVersion`, and a headless manifest may raise
`minRequired.desktopBridge` (or `minRequired.desktop` for a shell-version floor). The resolver and
page enforce those explicit floors; headless and shell versions otherwise do not have to match.

## Edge asset retention

The rolling edge release prunes desktop assets only after the replacement manifest is uploaded.
The pruning input is the set of asset URLs referenced by the current manifests, including updater
archives, their detached-signature companions, and installer download URLs. It does not compare
asset filenames with the headless version. Therefore a standing shell remains downloadable across
any number of headless-only edge releases, while unreferenced older shell assets are removed.

## Doing it by hand

`release:cut` is a convenience, not a gate — the workflows respond to the tag alone. The equivalent
long form, if you need to deviate:

```bash
# edit package.json version, move the CHANGELOG Unreleased section under a version heading
git commit -am "Release 0.3.0"
git tag -a v0.3.0 -m "Release 0.3.0" && git push origin main && git push origin v0.3.0
```

## Release notes

Notes come from `CHANGELOG.md`, not from a workflow input: the release scripts read the section
whose heading matches the version being published (`extractRelease`). Writing them in the same
commit that names the version is what lets a tag push carry them with no Actions UI involved, and
it is why the headless and desktop halves of one release always quote the same text.

So the note-writing step is just editing `CHANGELOG.md` under `## [Unreleased]` before you cut.
`release:cut` warns when that section is empty, since a release that silently ships no notes is
usually a mistake rather than an intention.

The desktop workflow keeps a `release_notes` dispatch input, which overrides the changelog for the
occasional re-promotion that needs different wording without rewriting history.

**There is currently no way to force a required update.** The shell reads a boolean `critical`
field from the manifest and deliberately ignores prose, so that reflowing a changelog cannot change
whether an update is forced (`updater.rs`, `the_prose_marker_no_longer_forces_anything`) — and
`scripts/desktop-release.ts` never writes that field. A `CRITICAL:` prefix in the notes is ordinary
text. Forcing an update needs a `--critical` flag on the release script and an input to carry it.

## Fix a release after `main` has moved on

A tag does not have to be on `main` — the workflows build whatever commit the tag points at. So a
fix for a shipped version goes out from a branch off that version's tag, carrying only the fix and
none of main's unrelated work:

```bash
git checkout -b hotfix/0.3.1 v0.3.0        # branch from the RELEASED tag, not from main
git cherry-pick <fix-commit>               # the fix alone
# note it under ## [Unreleased] in CHANGELOG.md on this branch
bun run release:cut 0.3.1                  # bumps, commits, tags, pushes this branch + tag
```

Then merge or cherry-pick the fix back into `main`, or the next release from `main` silently
reverts it — the single most common way a hotfix gets lost.

Two things to know:

- **The version must still increase.** Updaters compare versions, so a patch on top of `0.3.0`
  ships as `0.3.1`. There is no way to replace a published version in place; re-publishing the same
  number reaches nobody.
- **Edge is a rolling pointer.** A hotfix cut from an older edge tag becomes *the* edge build, so
  make sure the fix branch really is newer than what edge users already have.

For an edge hotfix the same shape applies with an edge version (`0.3.0-edge.5` off `v0.3.0-edge.4`).

## Existing-install bridge

Desktop versions released before channel-aware endpoints always query stable. A stable bridge
release is still required before those installations can discover edge. Dev additionally requires
a shell that understands `updateChannel: "dev"` and `updateFeedEndpoint`; the attached page writes
both before checking. Once that bridge shell is installed, each newly minted edge shell is offered
through the dev server’s copied `latest.json` and exercises the real signed swap.

## Release verification

CI proves the macOS bundle is notarized before publishing. The remaining manual check is Gatekeeper
on a machine that did not build it — download the published DMG through a browser (so it carries
the quarantine attribute a `gh release download` does not) and open it. No warning, no Privacy &
Security approval step. `spctl --assess --type exec -vvv /Applications/Podium.app` should say
`source=Notarized Developer ID`.

For a real release, verify from an older signed AppImage, NSIS install, or macOS app whose embedded
public key matches the release signing key:

1. launch with an isolated `PODIUM_STATE_DIR` containing the intended `updateChannel`;
2. observe the real update prompt;
3. accept it and confirm the AppImage changes on disk;
4. confirm the promoted version after restart.

Repository tests validate routing, debug suppression, workflow triggers, and manifest contents,
but they do not replace this signed end-to-end release check.
