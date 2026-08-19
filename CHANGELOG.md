# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-edge.11] - 2026-08-19

### Fixed

- Published headless binaries now identify themselves as installed even when detached persistence
  does not export `PODIUM_HOME`, so the new coordinator restart handoff is actually enabled.

## [0.1.0-edge.10] - 2026-08-19

### Fixed

- Detached and systemd headless installations now restart their daemon, server, and janitor into
  the downloaded release instead of leaving an updated binary on disk with the machine stuck at
  `Restarting…`.
- Settings now shows the native desktop bundle's full release version, including its edge suffix,
  so a successful desktop update no longer looks like the unchanged base version `0.1.0` or gets
  offered again.

## [0.1.0-edge.9] - 2026-08-19

### Fixed

- The native desktop can now host sessions on this device without its supervised daemon exiting
  immediately and being restarted in a loop.
- Fresh edge desktop installs now keep the bundled server, VPS onboarding commands, and joined
  machines on the edge update channel from first launch.

## [0.1.0-edge.8] - 2026-08-19

### Fixed

- Podium now detects Claude Code logins stored in the macOS Keychain and can transfer that
  native login to another owned Mac through the existing guarded credential-propagation flow.

## [0.1.0-edge.7] - 2026-08-19

## [0.1.0-edge.6] - 2026-08-18

## [0.1.0-edge.5] - 2026-08-18

## [0.1.0-edge.4] - 2026-08-18

### Fixed

- Setting up a new VPS could show an install command for the `stable` channel, which has
  no release published, so pasting it into the VPS downloaded nothing. The command now
  appears only once Podium knows which release train to install from, and says so when
  that is not the channel this Podium updates on.
- Updating from the downloaded disk image failed with a generic "could not install"
  message. Podium now recognises that it is running from its disk image and says so
  before downloading anything: move it to Applications and open it from there.
- The desktop app could try to install from the `stable` channel even when `edge` was
  selected, then report that nothing is published on stable. The channel is never
  guessed now — if it is not yet known, the install waits rather than substituting one.
- A new version could be offered a few minutes before its macOS build finished
  publishing, so the update dialog and Settings showed different version numbers and
  the install could not succeed. A version is now offered only once every file it
  names is actually downloadable.
- Reloading the page while an update was running briefly offered to start the update
  that was already in progress.
- Updating no longer surfaces a raw `JSON` error. The server restart an update
  performs is part of the expected process: interrupted reads are retried once the
  server answers again, and writes are never retried.
- The update dialog no longer offers an update the server would refuse, and a page
  running an older build is offered a reload instead.
- The yellow bar the server stamped into the page is gone — it covered the interface
  and pointed at a button that did not exist. The in-app banner covers the same
  ground, and a new message appears only if the app genuinely fails to start.
- The desktop app now remembers which channel its build came from, so an `edge`
  build no longer checks `stable`.
- Desktop update failures now say what actually went wrong — nothing published on
  this channel, unreachable network, or a genuine download failure — instead of
  reporting every one of them as a failed download.
- Settings shows the version of each component only when they differ.

## [0.1.0-edge.3] - 2026-08-18

### Fixed

- The native macOS app now discovers Codex, Claude, OpenCode, and other supported harnesses
  installed by Homebrew or configured by the user's login shell, even when the app is launched
  outside a terminal.

## [0.1.0-edge.2] - 2026-08-17

## [0.1.0-edge.1] - 2026-08-17

### Added

- Initial public prerelease.

### Fixed

- Desktop (local all-in-one): the app failed at launch with "Podium could not
  open its private replica — The string did not match the expected pattern."
  The replica boot gate fetched `/auth/status` relative to the page, which in
  the desktop webview is answered by the bundled UI instead of the server; it
  now asks the server directly, and a non-JSON answer fails closed with a
  clear message.
