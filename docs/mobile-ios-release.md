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

## Normalized issue release and adoption (POD-4972)

The candidate configured as **1.0.0 (13)** reads `issueProjection` plus `issueUserState`, `issueGitState`,
`repo` and `issueDep` through the shared issue view builder. The phone continues
storing `issue` during the release window. Keep the server's legacy issue emission
and mobile's legacy-storage switch unchanged until the adoption gate is satisfied.
The native hello/log version includes the marketing version and build number from
the archived `app.json`, for example `1.0.0+13`; mobile web continues reporting its
served page stamp. Build 13 is a candidate value, not evidence of a released build.

The code can integrate before sessions S5 (POD-5113). The later shared TestFlight
release is the operator's action and must contain both POD-4972 and POD-5113.
Before uploading, confirm the selected build number is unused in App Store Connect;
change `app.json` before prebuild, archive and validation if another number is needed.
Record the archived source SHA and evidence that it contains both steps, the upload
result, Apple's processed marketing version/build number, and its availability time.
Use that actual shared release's version and time for the adoption gate. An earlier
archive containing only one step does not start the seven-day window.

### Pending real-phone acceptance

Record the phone's name, model and iOS version, the installed TestFlight version/build,
and the result of each check. These checks remain pending until that phone runs the
shared release:

- Open the issue list, a mission and its issue detail. Check titles, references,
  hierarchy and description, then navigate between those screens.
- Check question text and answer options, agent-origin issues, draft-vessel behavior,
  repository references and awaiting-merge state. Check read, tucked and pinned
  markers in the issue list, Work and Inbox against the same account's state.
- Edit a test issue's title and check that it appears immediately and persists after
  reconnect. Reopen the screens offline after hydration and confirm their data survives.
- Retain the projection-only evidence from
  `apps/mobile/src/screens/normalized-issues.test.tsx`: all three screens render with
  `issues: []`; repo/git/personal joins and normalized spellings work; a projection
  can arrive before its related kinds, be evicted and readmitted; a refused edit
  rolls back its optimistic title. If replaying those fixtures on the phone, use an
  isolated QA cache and record which cases ran. The automated results do not count
  as a completed phone check.
- Connect the phone to the normally deployed reporter and check that the report's
  `versions[].appVersion` includes the installed marketing version **and build number**.
  Record current connections, connection counts and last-seen times. Reconnect once
  and verify the same build's connection count increases. Mail the named-phone
  results and version distribution to POD-4286.

The server writes a bounded version summary in its own state directory as
`mobile-client-versions.json`. It records mobile hello/disconnect events and
heartbeats connected sockets every minute. Unknown versions and unidentified
clients block the gate. Restart, an observation gap, or a persistence failure
starts a new seven-day coverage window; disconnected builds remain in the history.
The reporter is additive and requires the operator to deploy the integration
candidate through their normal release flow; do not restart a running server to
enable it.

After the shared TestFlight build containing both steps is available, run on the server host:

```bash
timeout 30s bun scripts/mobile-adoption-report.ts \
  --state-root <server-state-directory> \
  --release <shared-marketing-version+build> \
  --released-at <shared-TestFlight-availability-ISO>
```

The JSON reports `versions` (current connections, lifetime connection counts and
last-seen times), `connectedOlder`, `consecutiveQuietDays`, `eligibleAt` and
`step7Ready`. Exit 2 means the gate is still waiting; a missing or invalid evidence
file is an error, never a green gate. An updated mobile-web build can be included
with repeated `--supported-web-version <exact-served-stamp>` only after verifying
that stamp contains the normalized reader. Mail the distribution and timestamps
to POD-4286. POD-4973 may start only when `step7Ready` is true: no older or unknown
client connected for seven consecutive observed days after the release containing
both POD-4972 and POD-5113. Include that release's marketing version/build number
and availability timestamp in every handoff so the threshold is unambiguous.

Rollback: leave legacy server emission and mobile storage enabled, and cut a new
TestFlight archive from the previous mobile reader with a fresh build number. A
rollback archive does not contain this step and must never be declared supported
by the normalized-record adoption report. Reset the release threshold/time to a
subsequent archive that contains the fix before allowing step 7.
