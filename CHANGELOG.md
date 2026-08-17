# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

