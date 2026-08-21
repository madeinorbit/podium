# Darwin cross-compile spike evidence (POD-2501)

Decisive for updater-convergence spec §8b.

## Verdict: **LINUX-SIDE GO**

Cross-compiling darwin-arm64 headless on Linux works for everything Linux can
prove: Mach-O arm64 arch, darwin (not linux ELF) abduco embed, ad-hoc signature
with entitlements, updater `headless/` tarball layout.

**Mac execution proof is NOT YET OBTAINED** because the fleet Mac is offline.
Nothing in this document claims a macOS run. A follow-up under POD-2462 owns
running `verify-on-mac.sh` from the packaged Mac execution bundle.

If Mac execution later fails → escalate NO-GO / Mac-CI-per-release fallback
before dependents proceed. Linux-side GO alone does **not** greenlight shipping
Darwin payloads as known-good.

---

## Linux assertions (scripted, exit non-zero on failure)

```sh
scripts/spike/linux-assert-darwin-spike.sh [dist-bun-spike/darwin-arm64]
```

Checks:

1. `podium` and `abduco` are Mach-O arm64 (not ELF)
2. spike abduco matches `scripts/prebuilt/abduco/darwin-arm64/abduco`; host
   `abduco` if present is ELF (proves we did not ship the linux binary)
3. `dist-bun/abduco.bin` embed path is Mach-O arm64 when present
4. `rcodesign print-signature-info` shows `CodeSignatureFlags(ADHOC)`,
   identifier `podium`, Entitlements slot present; abduco also ADHOC
5. `headless/{podium-cli,podium,VERSION}` present; tarball archive root is
   `headless/` (updater `update-install.ts` contract)

---

## How the Linux bytes were produced

Host tools: Bun 1.3.14, zig 0.16.0, rcodesign 0.29.0.

### Prebuilt abduco

```sh
scripts/spike/build-prebuilt-abduco.sh
# zig cc -target aarch64-macos-none … -Iscripts/prebuilt/abduco/cross -Wl,-headerpad,0x8000
# rcodesign sign scripts/prebuilt/abduco/darwin-arm64/abduco
```

Stub `scripts/prebuilt/abduco/cross/util.h` supplies `forkpty` decls (zig Darwin
headers omit them; symbols live in libSystem).

### Bun compile + sign

```sh
bun --conditions=@podium/source scripts/spike/build-bun-darwin.ts --target=bun-darwin-arm64
# embeds dist-bun/abduco.bin; then:
# rcodesign sign --binary-identifier podium \
#   --entitlements-xml-file scripts/spike/bun-jit.entitlements.plist <mach-o>
```

### Mac execution bundle (for the follow-up — not run here)

```sh
scripts/spike/package-mac-execution-bundle.sh
# → dist-bun-spike/mac-execution-bundle.tar.gz
#    verify-on-mac.sh
#    podium-headless-darwin-arm64.tar.gz   # updater layout
#    README.md
```

On a Mac (when one is online): `tar -xzf … && cd mac-execution-bundle && bash verify-on-mac.sh`

---

## Follow-ups

1. Mac execution proof issue (child of POD-2462) — run the bundle verifier.
2. Land spike adaptations into release `build-bun.ts` / release-matrix (separate).
3. darwin-x64 Mac/Rosetta exercise if that row ships day-one.
