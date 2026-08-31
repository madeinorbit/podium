# Dev updater shell release

## 2026-08-31T07:44:39Z — isolated release seam

- Theory: A release investigation must not reuse the historical evidence branch or move `dev/mw` while other sessions are integrating it.
- Action: Created `issue/3153-dev-updater-shell-release` from local `dev/mw` at `f8e38a1413ea0591f6fddae31493226ab6d30320`, re-homed the session, and ran `bun run setup:worktree` (`bun install --frozen-lockfile`).
- Result: The isolated worktree is complete. Local `dev/mw` is five commits ahead of remote `origin/dev/mw` (`3f7a3dff37be22a7c94ff952115217d286869dbf`), so CI must build a separately pushed immutable issue candidate rather than silently building the older remote branch.
- Next check: Establish why edge.2 lacked the transition updater and inspect the standing dev release before any dispatch.

## 2026-08-31T07:49:00Z — edge.2 provenance and standing dev release

- Theory: `v0.1.1-edge.2` may have been cut from a branch that did not contain the updater epic despite nearby commit timestamps.
- Action: Compared tag `v0.1.1-edge.2` (`383708b20b8efe06f942b0376d85ae5b921bf28c`) with parent supervision `f326c8b8454d0758536d7aa71f850f3ea9b35ac3` and macOS payload relocation `78b3075d75b54e391f15a779b44145e752d62174`; inspected workflow run `32474837233`, current workflow history, standing `dev` release, its `latest.json`, and source ancestry.
- Result: The tag and parent commit are mutually non-ancestor. Parent support was merged only into the updater epic branch; macOS relocation was authored after the tag. Edge.2 was therefore a real signed shell release, but not a cut of the updater integration tree. A later dev workflow run `33157131983` published bridge-1/external-payload artifacts from `4dfc21c1746886cd3743d465efa0ceb8076d10b4`, still stamped `0.1.1-edge.2`.
- Interpretation: The standing dev DMG is newer source under an old version identity. It can be installed manually, but an installed shell cannot observe another artifact at the identical updater version as newer.
- Next check: Compare the standing dev shell with current parent ownership and audit stable migration gates.

## 2026-08-31T07:53:00Z — release-blocking current-tree regressions

- Theory: A fresh dispatch from current `dev/mw` may still be unsuitable if reviewed supervision was lost during later integration or if dev releases remain version-identical.
- Action: Inspected the actual current Rust tree, commit `1762f1ff0b007cbabe46c7f38d57b970c2ab4fd3`, merge `11b07f2587e83c1c9a2652457851a5befc77879a`, the dev version comparator, desktop workflow, and release tests.
- Result: Merge `11b07f258` reintroduced `replacement_daemon_command`: current daemon mode and all-in-one-to-daemon transfer again launch `podium daemon` directly even though the reviewed parent fix remains in ancestry. The dev workflow also republishes every shell with root package version `0.1.1-edge.2`; its standing manifest confirms this. Publishing before repair would notarize the wrong supervision topology and produce another same-version artifact.
- Interpretation: These are exact source-level defects, not runtime hypotheses. Both must be corrected before the requested CI cut is meaningful.
- Next check: Restore single-parent launch and give each built dev shell a monotonic, source-identifiable version.

## 2026-08-31T07:57:32Z — candidate repair prepared

- Theory: Reinstating the reviewed parent boundary and threading one generated dev version through shell, seed, and manifest creates a testable bootstrap shell without altering stable/edge version ownership.
- Action: Reapplied the focused Rust/bootstrap portion of `1762f1ff0`; added `desktopBuildVersion`, deriving `<core>-dev.<workflow-run>+<sha7>` only for dev; wired that version through CI validation, `PODIUM_DESKTOP_VERSION`, `PODIUM_APP_VERSION`, Tauri staging, and manifest preparation; added focused release/workflow tests. Ran non-publishing derivation preflight `bun scripts/desktop-release.ts --print-version --channel dev --run-number 42 --sha f8e38a1413ea0591f6fddae31493226ab6d30320`, which returned `0.1.1-dev.42+f8e38a1`.
- Result: Every backend-bearing shell branch now launches only `podium parent --takeover`; the parent derives server/daemon children from persisted config. Dev builds receive an increasing updater-visible version while stable and edge retain package/tag versions.
- Stable implication: A clean published `0.1.0` stable install uses the same updater public key and `releases/latest/download/latest.json` endpoint as current. A `v0.1.1` tag whose package/changelog are `0.1.1` automatically triggers both workflows; because v0.1.0 has no shell-input hash and the desktop inputs changed, CI builds a complete signed/notarized 0.1.1 app. The stable candidate workflow reconstructs the paired manifests and runs the real published-v0.1.0 bridge proof before headless publication. The old shell then replaces the whole app; first new backend-bearing launch seeds Application Support and starts the parent. Do not publish a headless-only 0.1.1 or bypass a failed desktop workflow.
- Next check: Run the end-of-task gates once, commit and push the immutable issue candidate, dispatch the dev desktop workflow, then verify all platform jobs, notarization proof, release target SHA, version, signatures, and assets before handoff.

## 2026-08-31T09:21:00Z — dev shell published

- Theory: Release-specific gates plus CI signing/notarization are the useful go/no-go boundary; unrelated repository-wide failures do not discriminate this desktop candidate.
- Action: `bun test scripts/desktop-release.test.ts scripts/desktop-release-workflow.test.ts` passed 41/41; after staging the generated payload, `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml every_backend_the_desktop_starts` passed both parent-supervision tests. The broad `bun run test:full` was stopped after 10m47s once unrelated existing server/mobile/model/harness failures were established. Committed candidate `5331ef32e`, then dev-only Windows-optional publication policy `1fd2d5b7a83ca6df169b69f0fbfba23026c11b1c` after repeated GitHub Windows `ENOENT ... failed to link package (copyfile)` failures.
- Result: Workflow run `33374590952` completed successfully. Linux, macOS arm64, and macOS x86_64 built; both Mac jobs imported Developer ID credentials, built the signed app, notarized/stapled the DMG, and verified signing/notarization. The publish job atomically replaced the standing `dev` assets. Windows remains required for edge/stable and was ignored only for dev.
- Evidence: `refs/tags/dev` resolves to `1fd2d5b7a83ca6df169b69f0fbfba23026c11b1c`; published manifest `https://github.com/madeinorbit/podium/releases/download/dev/latest.json` reports `0.1.1-dev.44+1fd2d5b`, bridgeVersion 1, signed Linux plus both Mac updater entries. DMGs: `https://github.com/madeinorbit/podium/releases/download/dev/Podium_0.1.1-dev.44%2B1fd2d5b_aarch64.dmg` and `https://github.com/madeinorbit/podium/releases/download/dev/Podium_0.1.1-dev.44%2B1fd2d5b_x64.dmg`.
- Interpretation: This is now a real newer shell identity, unlike edge.2 and the previous same-version dev artifact. Existing `0.1.1-edge.2` cannot discover the dev feed automatically and needs this DMG installed once; subsequent dev shells can compare monotonic dev versions and update normally.
- Next check: Install the matching DMG on the affected Mac, select the dev channel, then run the one payload update and inspect post-restart parent/daemon logs if recovery still fails. Stable 0.1.0 users remain untouched until a deliberate complete `v0.1.1` stable tag release.

## 2026-08-31T09:45:41Z — affected Mac payload update converged

- Theory: A successful daemon-only native boundary requires the shell to survive at its own version while the external payload advances, the parent restarts the configured daemon, and the machine reconnects reporting the new payload version.
- Action: Classified the human-observed affected-Mac result without another run: server/interface/phone remained `dev.30 (f8e38a1)`; installed desktop shell reported `dev.42 (5331ef3)`; after accepting the update, `Michaels-MacBook-Pro.local` returned online reporting payload `dev.31`.
- Result: The daemon-only payload update converged across operation, payload replacement, supervisor recovery, daemon startup/handshake, and fleet version reporting while correctly leaving the Tauri shell version unchanged.
- Evidence: Human report in the POD-3153 session at 2026-08-31T09:45Z. The interface simultaneously showed `Offline cache · dev.30`, so server/UI reachability was not proven by this observation.
- Interpretation: Call the native daemon-only update path a success. The shell/payload version difference is intentional. The offline-cache status is a separate server/UI boundary, and a newer Flatblock report is a separate fleet/version-reporting observation unless logs show it received this operation.
- Next check: Preserve this as the successful daemon-only proof. If all-in-one recovery matters, inspect the Mac parent/server logs for the same timestamp and test only that topology; classify the Flatblock report separately from updater payload recovery.
