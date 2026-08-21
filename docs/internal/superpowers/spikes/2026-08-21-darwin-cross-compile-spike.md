# Darwin cross-compile spike evidence (POD-2501)

Decisive for updater-convergence spec §8b. Built entirely on Linux (ludovico /
this worktree host). **Mac runtime GO/NO-GO is PENDING** until `mac-verify.sh`
is run on an Apple Silicon Mac.

## Linux-side results (DONE)

Host: Linux x86_64, Bun 1.3.14, zig 0.16.0, apple-codesign/rcodesign 0.29.0.

### 1. Prebuilt abduco (zig cc)

```sh
# scripts/spike/build-prebuilt-abduco.sh
zig cc -target aarch64-macos-none \
  -std=c99 -D_POSIX_C_SOURCE=200809L -D_XOPEN_SOURCE=700 -D_DARWIN_C_SOURCE \
  -DNDEBUG -DVERSION='"0.6-podium"' \
  -Iscripts/prebuilt/abduco/cross \
  -Wl,-headerpad,0x8000 \
  packages/pty/vendor/abduco/abduco.c \
  -o scripts/prebuilt/abduco/darwin-arm64/abduco
rcodesign sign scripts/prebuilt/abduco/darwin-arm64/abduco
# same for x86_64-macos-none → darwin-x64
```

Notes:
- zig's Darwin libc headers omit `<util.h>`; spike supplies
  `scripts/prebuilt/abduco/cross/util.h` declaring `forkpty`/`openpty`/`login_tty`
  (symbols are exported from `libSystem`, confirmed in zig's `libSystem.tbd`).
- `-Wl,-headerpad,0x8000` required so rcodesign can write the code-signature
  load command (x64 failed without it: `insufficient room to write code signature load command`).

`file(1)`:
- `darwin-arm64/abduco`: Mach-O 64-bit arm64 executable
- `darwin-x64/abduco`: Mach-O 64-bit x86_64 executable

### 2. Bun cross-compile + embed

```sh
bun --conditions=@podium/source scripts/spike/build-bun-darwin.ts --target=bun-darwin-arm64
# also --target=bun-darwin-x64
```

- Copies prebuilt abduco → `dist-bun/abduco.bin` (path
  `scripts/embedded-abduco.ts` imports with `{ type: 'file' }`).
- `bun build --compile --target=bun-darwin-arm64` (and x64) of
  `scripts/cli-compiled.ts` + discovery-worker entrypoint.
- Keeps `podium.unsigned` alongside for the arm64 signature-requirement probe.

### 3. Ad-hoc sign from Linux (exact invocations)

```sh
rcodesign sign \
  --binary-identifier podium \
  --entitlements-xml-file scripts/spike/bun-jit.entitlements.plist \
  dist-bun-spike/darwin-arm64/podium

rcodesign sign scripts/prebuilt/abduco/darwin-arm64/abduco
```

Entitlements (Bun JIT — from Bun docs "Code signing on macOS"):
`com.apple.security.cs.allow-jit`,
`allow-unsigned-executable-memory`,
`disable-executable-page-protection`,
`allow-dyld-environment-variables`,
`disable-library-validation`.

`rcodesign print-signature-info` on the arm64 binary reports
`CodeSignatureFlags(ADHOC)` and an Entitlements slot present.

### 4. Artifacts

| Artifact | Size (approx) |
|---|---|
| `dist-bun-spike/darwin-arm64/podium` (signed) | ~69 MB |
| `dist-bun-spike/darwin-arm64/podium.unsigned` | ~69 MB |
| `dist-bun-spike/darwin-arm64/abduco` | ~800 KB |
| `dist-bun-spike/darwin-arm64/podium-headless-spike-darwin-arm64.tar.gz` | ~75 MB |
| `dist-bun-spike/darwin-x64/podium-headless-spike-darwin-x64.tar.gz` | ~83 MB |

Tarball contents: `headless/` (podium-cli + launcher + VERSION + stub web/mobile),
`podium`, `podium.unsigned`, `abduco`, `mac-verify.sh`, entitlements plist.

## Mac verification (PENDING — blocks GO/NO-GO)

On an Apple Silicon Mac:

```sh
tar -xzf podium-headless-spike-darwin-arm64.tar.gz
cd <unpack-dir>
bash mac-verify.sh
# paste the log back onto POD-2501
```

Probes required by the issue brief:
1. unsigned binary fails on arm64; ad-hoc signed `--version` works
2. Gatekeeper/quarantine: plant `com.apple.quarantine`, strip, re-run
3. daemon boot under `PODIUM_STATE_DIR=/tmp/...` (materializes embedded abduco;
   bun:sqlite + discovery-worker exercised by daemon start)
4. abduco session created; survives "daemon restart" stand-in (session still listed)
5. darwin-x64: run under Rosetta or on Intel if available; else defer

## GO / NO-GO

| Status | Meaning |
|---|---|
| **PENDING Mac run** | Linux production path proven; runtime parity unproven |
| GO | Mac log shows --version + daemon + abduco survival + unsigned refusal |
| NO-GO | Escalate fallback (Mac CI leg per release; stale dev Mac payloads) to human before any dependent issue proceeds |

## Spike scripts (not landed into release path)

- `scripts/spike/build-prebuilt-abduco.sh`
- `scripts/spike/build-bun-darwin.ts`
- `scripts/spike/bun-jit.entitlements.plist`
- `scripts/spike/mac-verify.sh`
- `scripts/prebuilt/abduco/` (spike home; final location = release-matrix issue)
