# iOS releases (TestFlight)

`apps/mobile/ios` is **generated and gitignored**. Expo's Continuous Native Generation owns it:
`expo prebuild --clean` deletes the directory and writes it again from `apps/mobile/app.json` and
the plugins that config names. Nothing typed into Xcode, the Podfile, or `Info.plist` survives
that, and nothing typed there exists on anyone else's machine.

**So every native fact belongs in `app.json` or in `apps/mobile/plugins/`.** Concretely:

| Native fact | Where it lives |
| --- | --- |
| Build number (`CFBundleVersion`) | `expo.ios.buildNumber` — bump before each archive |
| Marketing version (`CFBundleShortVersionString`) | `expo.version` |
| Signing team (`DEVELOPMENT_TEAM`) | `expo.ios.appleTeamId` |
| Export-compliance answer | `expo.ios.infoPlist.ITSAppUsesNonExemptEncryption` — `false` keeps TestFlight from asking on every build |
| Dark-only UI | `expo.userInterfaceStyle` |
| Permission strings | `expo.ios.infoPlist.NS*UsageDescription` |
| ExpoSQLite's public `sqlite3.h` link | [`plugins/with-sqlite-header-link.js`](../apps/mobile/plugins/with-sqlite-header-link.js) |

`CURRENT_PROJECT_VERSION` and `MARKETING_VERSION` in the generated `project.pbxproj` stay at the
template's `1` and `1.0`. That is not a drift to fix: the generated `Info.plist` carries literal
values rather than `$(…)` references, so the build settings are unread.

The scheme is **`Podium`**. Builds 1–10 came off a project generated under the older target name
`PodiumMobile`; a command that still says `-scheme PodiumMobile` predates 2026-08-28.

## Cutting a build

```bash
cd apps/mobile
# 1. Bump expo.ios.buildNumber in app.json — App Store Connect rejects a repeat.
bunx expo prebuild -p ios          # --clean when the native dir is suspect; runs pod install
xcodebuild -workspace ios/Podium.xcworkspace -scheme Podium -configuration Release \
  -destination 'generic/platform=iOS' -archivePath /tmp/Podium.xcarchive archive
```

Check for `** ARCHIVE SUCCEEDED **` explicitly before exporting. `xcodebuild` prints plenty of
`error:` lines on the way to a successful archive, and a grep that also matches `FAILED` will wave
a broken archive through to the upload step — it did once.

```bash
xcodebuild -exportArchive -archivePath /tmp/Podium.xcarchive \
  -exportOptionsPlist release/ExportOptions.plist -exportPath /tmp/Podium-export \
  -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_RHZQR24LQR.p8 \
  -authenticationKeyID RHZQR24LQR \
  -authenticationKeyIssuerID a05c0a13-a1cc-46d5-b680-06c475657c6a
```

`ExportOptions.plist` names `method: app-store-connect` and `destination: upload`, so the export
*is* the upload — success looks like `Upload succeeded` followed by `** EXPORT SUCCEEDED **`. The
App Store Connect API key ID and issuer ID identify the account and are recorded above on purpose;
the `.p8` private key is the secret and lives only in `~/.appstoreconnect/private_keys`.

Processing on Apple's side takes a few minutes, after which the build appears for the internal
testing group. Testers are invited by Apple ID email in App Store Connect → TestFlight.

## When a clean build fails on ExpoSQLite

`cannot find 'exsqlite3_open' in scope`, on every symbol at once, means
`Pods/Headers/Public/ExpoSQLite/sqlite3.h` is missing — see the plugin's own comment for why the
podspec sometimes omits it. The plugin restores the link at `pod install`, but the failure can
outlive the fix, because clang caches the broken module *outside* DerivedData:

```bash
rm -rf ~/Library/Developer/Xcode/DerivedData/ModuleCache.noindex
```
