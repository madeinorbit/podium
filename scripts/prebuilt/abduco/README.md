# Prebuilt abduco (POD-2501 spike)

Cross-compiled Darwin binaries for the headless bundle live here during the
spike. Final packaging home is decided in the release-matrix issue.

Rebuild (Linux host with `zig` + `rcodesign` on PATH):

```sh
scripts/spike/build-prebuilt-abduco.sh
```

Binaries under `darwin-arm64/` and `darwin-x64/` are gitignored — produce them
locally or in CI; do not commit Mach-O payloads.
