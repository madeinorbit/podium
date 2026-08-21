# Darwin cross-compile spike evidence (POD-2501)

Decisive for updater-convergence spec §8b.

## Verdict: **GO**

A headless `podium-cli` cross-compiled on Linux (`bun-darwin-arm64` + prebuilt
abduco + `rcodesign` ad-hoc signature with Bun JIT entitlements) runs on Apple
Silicon: `--version` works, all-in-one boots (server + daemon + janitor),
embedded abduco materializes and runs, and an abduco session survives killing
the all-in-one process.

→ **No Mac is needed to build Darwin headless payloads.** Mac CI stays for
shell minting only.

Actions proof run: https://github.com/madeinorbit/podium/actions/runs/32433063958  
Mac log: `docs/internal/superpowers/spikes/2026-08-21-mac-verify-round2.log`

---

## Linux-side results

Host: Linux x86_64, Bun 1.3.14, zig 0.16.0, apple-codesign/rcodesign 0.29.0.
Also reproduced in CI `ubuntu-latest` via `.github/workflows/darwin-cross-compile-spike.yml`.

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
  (symbols exported from `libSystem`, confirmed in zig's `libSystem.tbd`).
- `-Wl,-headerpad,0x8000` required so rcodesign can write the code-signature
  load command (x64 failed without it: `insufficient room to write code signature load command`).

### 2. Bun cross-compile + embed

```sh
bun --conditions=@podium/source scripts/spike/build-bun-darwin.ts --target=bun-darwin-arm64
# also --target=bun-darwin-x64
```

- Copies prebuilt abduco → `dist-bun/abduco.bin` (path
  `scripts/embedded-abduco.ts` imports with `{ type: 'file' }`).
- `bun build --compile --target=bun-darwin-arm64` of
  `scripts/cli-compiled.ts` + discovery-worker entrypoint.
- Keeps `podium.unsigned` alongside for the signature probe.

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

Mac `codesign -dv` reports `Signature=adhoc`, `Identifier=podium`,
`flags=0x2(adhoc)`.

---

## Mac verification (blacksmith-6vcpu-macos-15)

### Round 2 (GO) — 2026-08-21T00:34:41Z

| Probe | Result |
|---|---|
| `file(1)` Mach-O arm64 | PASS |
| `codesign -dv` adhoc on podium + abduco | PASS |
| quarantine xattr plant + strip | PASS |
| signed `podium-cli --version` → `spike-darwin+0.1.1-edge.1` | PASS |
| `all-in-one` boot under `PODIUM_STATE_DIR` | PASS — server/janitor/daemon up on :18412 |
| embedded abduco → `$PODIUM_STATE_DIR/bin/abduco` + `-v` | PASS |
| standalone prebuilt `abduco -v` | PASS |
| `abduco -n … /bin/sleep 120`; list after killing all-in-one | PASS |
| unsigned `--version` refused | ANOMALY — succeeded on CI VM (AMFI lenient); keep signing |

Daemon log excerpt:

```
[podium] materialized embedded abduco -> …/state/bin/abduco
podium server up on http://localhost:18412
podium janitor up -> http://localhost:18412
podium daemon up → ws://localhost:18412
```

Failure modes probed:
- **bun:sqlite / FFI / discovery-worker:** exercised by all-in-one boot (server store + janitor + daemon).
- **arm64 signature:** ad-hoc accepted; unsigned-also-runs is a CI-VM anomaly, not a reason to drop signing (Bun JIT entitlements still required for real Gatekeeper paths).

### Round 1 (partial) — script bugs only

Signed `--version` + embedded abduco already passed; failed on `abduco -n … -- /bin/sleep` (abduco has no GNU `--`) and bare `daemon` without `serverUrl`. Fixed in round 2.

---

## Follow-ups (not blocking GO)

1. Land the spike adaptations into `scripts/build-bun.ts` / release matrix (separate issue).
2. Decide final home for `scripts/prebuilt/abduco/` (release-matrix issue).
3. Exercise darwin-x64 under Rosetta or on Intel if that row must ship day-one.
4. On a real user Mac (not CI VM), confirm unsigned refusal if we want that failure mode documented outside Actions.

## Spike scripts (branch artifacts; promote later)

- `scripts/spike/build-prebuilt-abduco.sh`
- `scripts/spike/build-bun-darwin.ts`
- `scripts/spike/bun-jit.entitlements.plist`
- `scripts/spike/mac-verify.sh`
- `.github/workflows/darwin-cross-compile-spike.yml` (dispatch / spike-branch only)
