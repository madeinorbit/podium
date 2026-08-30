# Parity release proof

This is the release contract for the shared web and Expo clients, native iOS, and packaged Tauri applications. It replaces separate native, desktop, accessibility, performance, and mobile-smoke programs with one evidence file per candidate.

The first native release is iPhone-only and requires iOS 16.4 or later. EAS Build produces the signed archive and EAS Submit sends the approved candidate to TestFlight. Internal TestFlight comes first, then external TestFlight, then App Store review. macOS is supported. Windows and Linux remain preview until their packaged acceptance rows pass on a release candidate.

The current-system rows are pinned as of 2026-08-30 to iOS 26.6.1 and macOS 26.6.2, the versions listed by [Apple security releases](https://support.apple.com/100100). Update both the constants in `scripts/parity-release-proof.ts` and this sentence when Apple ships a later stable version. The verifier rejects stale evidence after that update.

Browser emulation never counts as native proof. Chromium phone viewports, WebKit device presets, React Native Web, Expo web exports, and mocked native modules can prove browser compatibility or shared semantics only. They cannot approve UIKit behavior, Hermes, SecureStore, SQLite, app lifecycle, microphone access, speech, haptics, the iOS accessibility tree, signing, installation, or native performance.

Do not run an EAS build, start an EAS Simulator session, submit to TestFlight, publish a desktop package, push a release tag, or take another paid or external release action without coordinator approval. Read-only EAS account and availability checks are allowed when the coordinator asks for them.

## One evidence file

Run these commands from the repository root:

```sh
bun run release:proof -- check
bun run release:proof -- status
bun run release:proof -- template --out .tmp/parity-release-proof.json
bun run release:proof -- verify --evidence .tmp/parity-release-proof.json
```

`check` validates the checked-in contract, iOS release settings, EAS profiles, and baseline. `template` creates a candidate evidence file tied to the current commit. Replace each unavailable entry only after running the matching procedure below. A passed row needs an artifact path or durable run URL. `verify` fails on a missing, failed, unavailable, wrong-source, wrong-device, or wrong-commit row.

The checked-in baseline at `scripts/parity-release-proof-baseline.json` records what is currently unavailable. It is not release approval and must never be edited to make `verify` pass. Candidate evidence belongs in CI or issue artifacts, not in git.

Evidence sources have fixed meanings:

| Source | What it proves |
| --- | --- |
| `automated` | A named hermetic repository command completed on the candidate commit. |
| `simulator` | The compiled Expo iOS app ran on a named iPhone simulator and exact iOS runtime. |
| `physical-device` | A signed release or TestFlight build ran on the named iPhone and exact iOS version. |
| `packaged-desktop` | The actual DMG app, NSIS install, or AppImage ran on the named host OS. A browser or bare Tauri executable is not enough. |
| `unavailable` | The check could not run. Record why. This is honest baseline information and blocks release. |

## Shared client proof

Run `bun run test:cached` once for a candidate whose changes deliberately span the web and Expo clients. Attach the complete log or CI URL to `shared-client-contracts`. Shared package tests and semantic component assertions belong here.

The configured mobile browser lane owns `tests/e2e/browser/expo-mobile-*.browser.e2e.ts`. Run one browser suite only when a changed browser interaction requires it. These suites are compatibility evidence, never native iOS evidence. The issue-specific scripts under `apps/mobile/e2e` remain historical diagnostics and are not release gates.

## Native iOS build and simulator proof

`apps/mobile/app.json` declares iPhone-only support and iOS 16.4. The local Expo config plugin writes the same deployment target and device family into every generated Xcode build configuration. `apps/mobile/eas.json` has three profiles:

| Profile | Output | Use |
| --- | --- | --- |
| `simulator` | Unsigned simulator application | Static native smoke on an iPhone simulator. |
| `device` | Internally distributed signed device build | Direct named-device checks before TestFlight when registered devices are available. |
| `production` | Store-signed archive with an incremented build number | The TestFlight-first release candidate. |

The Expo project is not yet linked to an EAS project ID. The first coordinator-approved setup run uses `npx --yes eas-cli@latest init` from `apps/mobile`, confirms the account and owner, and commits the generated project ID before any build. Do not invent or borrow a project ID.

On a Mac, prefer a local simulator build because it does not consume EAS capacity:

```sh
cd apps/mobile
npx expo prebuild --clean --platform ios
npx expo run:ios --configuration Release --device "iPhone SE (3rd generation)"
```

Inspect the generated project before the smoke:

```sh
rg 'IPHONEOS_DEPLOYMENT_TARGET = 16.4|TARGETED_DEVICE_FAMILY = 1' ios
```

Use an iOS 16.4 runtime on an iPhone SE (3rd generation) simulator and iOS 26.6.1 on an iPhone 16 Pro simulator. Record the exact simulator model, runtime, candidate commit, screen recording or screenshots, and console log. The smoke covers cold launch, foreground resume, process termination, navigation, keyboard show and interactive dismissal, sheet and back gestures, camera and microphone permission states, SQLite persistence, SecureStore-backed profiles, offline replay, Dynamic Type, Reduce Motion, and the native accessibility tree.

This repository can use EAS Simulator from a non-Mac host, but it is paid and limited-access. After coordinator approval, first run the read-only availability check from `apps/mobile`:

```sh
npx --yes eas-cli@latest simulator:availability --json
```

If access is available, build with the `simulator` profile and follow the current EAS Simulator start, install, drive, and stop procedure. Name every session, stop it on every exit path, and clear `.env.eas-simulator`. Do not substitute an Expo web URL or a browser preview for the installed app.

## Physical iPhone matrix

Both rows are required. Record the real model identifier and exact iOS patch version in the evidence file. A different device needs a written reason and coordinator approval.

| Named device | Release role | Required checks |
| --- | --- | --- |
| iPhone SE, 2nd generation, iOS 16.4 | Minimum OS, compact display, older-device floor | Signed install, cold launch, persisted relaunch, background reclaim, software and hardware keyboard, smallest layout, 44 point targets, VoiceOver order and rotor, disabled haptics fallback, and the clear unsupported speech state. |
| iPhone 16 Pro, iOS 26.6.1 | Current system chrome and ProMotion class | TestFlight install, Dynamic Island safe areas, microphone and on-device speech, Bluetooth interruption, haptic timing, VoiceOver touch exploration, Wi-Fi and cellular handoff, notification entry from background and terminated states, and updater build identity. |

Use the `device` profile only after coordinator approval when direct internal distribution is needed:

```sh
cd apps/mobile
npx --yes eas-cli@latest build --platform ios --profile device
```

For a release candidate, approval covers two separate external actions. Build first, inspect the result, then submit that exact build to TestFlight:

```sh
cd apps/mobile
npx --yes eas-cli@latest build --platform ios --profile production
npx --yes eas-cli@latest submit --platform ios --profile production --id <approved-build-id>
```

Do not use an automatic build-and-submit command for the first release. TestFlight installation on both named devices is the signing and install proof. App Store production remains blocked until internal TestFlight passes, external TestFlight feedback is resolved, and the coordinator approves submission.

POD-1767 owns native performance measurement. Import its candidate-matched release-build evidence into `ios-native-performance-floor` for the iPhone SE on iOS 16.4 and `ios-native-performance-promotion` for the iPhone 16 Pro on iOS 26.6.1. Do not rerun browser timing, simulator timing, or a second native benchmark and call it equivalent. The imported evidence must cover launch, first transcript paint, scroll frame pacing, foreground resume, and memory on both named devices.

## Packaged desktop matrix

Build and signing infrastructure remains in `.github/workflows/desktop-release.yml`, `apps/desktop/scripts`, and `docs/desktop-releases.md`. Do not publish or dispatch it without coordinator approval. Repository Rust, browser, or bare-executable tests can support a row but cannot replace the packaged application.

Use an isolated state directory, agent home, XDG directories where applicable, instance name, display, and network namespace. Never inherit the live Podium relay or state. Follow `docs/agents/driving-podium.md` for Linux isolation and native interaction driving.

| Package and named host | Status contract | Packaged acceptance |
| --- | --- | --- |
| `Podium_<version>_aarch64.dmg` on MacBook Pro (14-inch, M4 Pro, 2024), macOS 26.6.2 | Supported | Download through a browser, mount, drag to Applications, verify Gatekeeper and stapling, launch the installed app, check native title bar and menus, file open and save, external link dispatch, cold and warm deep-link activation, clipboard, notification, keyboard traversal, VoiceOver, idle memory, startup time, signed update replacement, and restart into the promoted version. |
| `Podium_<version>_x64.dmg` on MacBook Pro (16-inch, 2019, Intel), macOS 26.6.2 | Supported | Repeat the complete signed, notarized, installed application check, including cold and warm deep-link activation, on Intel. An Apple Silicon result or artifact inspection alone cannot satisfy this row. |
| `Podium_<version>_x64-setup.exe` on Dell XPS 13 9340, Windows 11 24H2 | Preview until passed | Fresh install and uninstall, verified Authenticode publisher and SmartScreen behavior, WebView2 launch, native menus and dialogs, external link dispatch, cold and warm deep-link activation, clipboard, notification, ConPTY terminal, keyboard traversal, Narrator, idle memory, startup time, signed updater replacement, and restart into the promoted version. |
| `Podium_<version>_amd64.AppImage` on ThinkPad T14 Gen 4 AMD, Ubuntu 24.04.3 LTS under isolated X11 | Preview until passed | Download and verify the real AppImage, execute it under isolated X11, verify native dialogs and opener, cold and warm deep-link activation, clipboard, notification, PTY, keyboard traversal, Orca, idle memory, startup time, byte-for-byte updater replacement, and restart into the promoted version. Do not set `APPIMAGE` while running a bare executable. |

Each desktop row records the exact host and OS above, package filename and SHA-256 digest, candidate commit, install result, launch-to-ready time, idle resident memory after five minutes, interaction log, accessibility notes, updater before and after versions, and screenshots or recording. A passed row also records `packageTrust.mechanism`, the verified signer or provenance in `packageTrust.identity`, and `packageTrust.verified: true`. macOS requires Developer ID, Gatekeeper, or notarization verification; Windows requires Authenticode; Linux requires signed or attestable AppImage provenance. Unknown, unsigned, or unverified identities are rejected. Its `desktopBoundaryResults` must separately mark `notification`, `deepLinkCold`, and `deepLinkWarm` as `passed`; a prose note or unrelated artifact cannot substitute. The verifier rejects a package name that does not match the row, any digest that is not 64 hexadecimal characters, any package whose trust check is missing or failed, and any missing or failed desktop boundary. Until native protocol registration and both activation paths exist in the candidate, the deep-link results stay unavailable and the row cannot pass. The first accepted measurements become the desktop baseline. Later candidates compare like-for-like hardware and may tighten a limit only from measured data.

After coordinator approval, start each packaged run by recording the artifact digest and checking the platform signature. These commands do not replace the interaction checklist:

```sh
# macOS, after downloading the DMG through a browser
shasum -a 256 Podium_<version>_<arch>.dmg
xcrun stapler validate Podium_<version>_<arch>.dmg
hdiutil attach Podium_<version>_<arch>.dmg
spctl --assess --type exec -vvv /Volumes/Podium/Podium.app

# Linux
sha256sum Podium_<version>_amd64.AppImage
chmod +x Podium_<version>_amd64.AppImage
# Launch it with the isolated env, Xvfb display, and network namespace from driving-podium.md.
```

On Windows, use PowerShell and replace the temporary install path with the path created by the approved installer:

```powershell
Get-FileHash .\Podium_<version>_x64-setup.exe -Algorithm SHA256
Start-Process .\Podium_<version>_x64-setup.exe -ArgumentList '/S' -Wait
Start-Process "$env:LOCALAPPDATA\Podium\Podium.exe"
```

macOS support requires both Apple signing and the Tauri updater signature. Windows and Linux remain preview even if they build successfully. Their status changes only after their complete packaged rows pass; a compile, browser smoke, or unsigned local executable does not change support status.

## Release decision

`bun run release:proof -- verify --evidence <file>` is the final evidence completeness check, not permission to release. Attach the verified evidence file and its cited logs, recordings, screenshots, CI runs, build pages, and package digests to the release issue. The coordinator still approves every paid build, store submission, tag push, and publication.
