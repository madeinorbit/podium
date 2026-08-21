# Darwin cross-compile spike evidence (POD-2501)

Decisive for updater-convergence spec §8b: can one Linux job build a macOS headless
payload that actually runs on a Mac?

## Verdict: **GO**

A darwin-arm64 headless payload built entirely on Linux — Bun
`--target=bun-darwin-arm64`, a `zig cc` cross-compiled abduco, an `rcodesign` ad-hoc
signature with Bun's JIT entitlements — **was executed on an Apple Silicon macOS 15
runner and passed**. No Mac is needed to build Darwin headless payloads.

That first run did not cover darwin-x64 or real end-user Mac hardware (a CI VM is
not a laptop). POD-2520 later closed the x64 CI question; real hardware remains open.

---

## The macOS run

| | |
|---|---|
| GitHub Actions run | `32433063958`, job `verify-macos` |
| Runner | `blacksmith-6vcpu-macos-15` — a GitHub-hosted Apple Silicon VM |
| Host | `Darwin 24.6.0 … xnu-11417.140.69.708.3~1/RELEASE_ARM64_VMAPPLE arm64` |
| Payload | cross-built on `ubuntu-latest` in the same run, downloaded as an artifact |
| Transcript | [`2026-08-21-mac-verify-round2.log`](./2026-08-21-mac-verify-round2.log) (round 1: [`…-round1.log`](./2026-08-21-mac-verify-round1.log)) |

What it showed:

- `headless/podium-cli --version` → `podium spike-darwin+0.1.1-edge.1`
- `all-in-one` booted server + janitor + daemon against a throwaway
  `PODIUM_STATE_DIR` — so `bun:sqlite` works in a cross-built binary
- the embedded abduco materialized to `state/bin/abduco` and ran
- an abduco session was created and survived the all-in-one being killed
- `codesign -dv` on the Mac reported `flags=0x2(adhoc)`, `Identifier=podium`

**Provenance note.** These transcripts were committed in `44a4f0c1a`, deleted in
`fbe133c09`, and restored here. The deletion followed a (mistaken) standing
instruction that no Mac was available; what was actually unavailable was the fleet
laptop. The reviewer re-fetched the live job log from GitHub and confirmed it matches
these files. Deleting passing evidence understates the record just as badly as
overstating it does.

---

## POD-2520 execution closure and remaining questions

Actions run `32513654765` executed both Linux-cross-built payloads on their native
macOS 15 CI architectures. Darwin arm64 and x64 both ran `--version`, booted
`all-in-one`, materialized abduco, and kept a direct abduco session alive across the
all-in-one process being killed. Apple's `codesign --verify --strict --verbose=4`
accepted both rcodesign-produced seals. Quarantine did not block either signed binary
on these CI VMs. A genuinely signature-stripped arm64 binary also ran, proving that
the Apple Silicon VM does not enforce the arm64 signature requirement; it does not
prove that signing is optional on real hardware.

Committed platform transcripts:

- Apple Silicon macOS 15:
  [`2026-08-21-macos15-apple-silicon-execution.log`](./2026-08-21-macos15-apple-silicon-execution.log)
- Intel macOS 15:
  [`2026-08-21-macos15-intel-execution.log`](./2026-08-21-macos15-intel-execution.log)

1. **Real user hardware.** Gatekeeper with quarantine and AMFI signature enforcement
   remain unproven on a normal Mac; CI VM behavior cannot clear either boundary.
2. **Discovery-worker entrypoint** — compiled in as a second entrypoint, never
   executed.
3. **daemon → abduco → agent session.** The verifier drives abduco directly, so
   materialization is proven and the session path through the daemon is not.
4. **The spike `headless/` is not the production layout** — no `systemd/`, no
   NOTICE/LICENSE, stub `web`/`mobile` `index.html`. The Mac boot logged "Served web
   bundle has no valid build stamp" for that reason. POD-2504 must not read this
   spike as having exercised the full bundle.

---

## What `rcodesign` actually contributes: entitlements, not the signature

`bun build --compile --target=bun-darwin-*` **already emits an ad-hoc signed
Mach-O.** Measured on the Linux box (Bun 1.3.14), the raw compile output reports:

```
flags: CodeSignatureFlags(ADHOC | LINKER_SIGNED)
identifier: a.out
```

After `rcodesign sign`:

```
flags: CodeSignatureFlags(ADHOC)
identifier: podium
entitlements_plist: allow-jit, allow-unsigned-executable-memory,
                    disable-executable-page-protection,
                    allow-dyld-environment-variables, disable-library-validation
```

Two consequences:

- The spike's `podium.unsigned` was never unsigned, so the round-1/round-2 reading
  "unsigned ran anyway → AMFI anomaly" was a misdiagnosis. Nothing in those runs says
  anything about AMFI.
- If the release job ever drops `rcodesign`, what breaks is **JIT**, not code
  signing. That is what POD-2504 needs to carry forward.

A genuine unsigned probe therefore has to remove the signature deliberately:
`scripts/spike/macho-strip-signature.py` drops `LC_CODE_SIGNATURE`, shrinks
`__LINKEDIT`, and truncates. The Mac verifier ships that binary as
`podium-cli.nosig`. Run `32513654765` proved the probe was genuinely unsigned and
that it ran on the arm64 CI VM. The honest conclusion is that this VM cannot
establish AMFI enforcement; refusal remains a real-hardware question.

---

## Linux-side assertions

```sh
scripts/spike/linux-assert-darwin-spike.sh [spike-dir-or-tarball] [darwin-arm64|darwin-x64]
```

Every check extracts the shipped, updater-shaped tarball and interrogates
`headless/podium-cli` **from that extraction**. Nothing inspects a loose sibling
binary, and a missing input is a FAIL, never a skip. It asserts:

1. archive root is `headless/` with `podium-cli`, `podium`, `VERSION` and nothing
   else (the `update-install.ts` contract)
2. the shipped binary is Mach-O for the expected arch
3. it contains **no** 64-bit Linux ELF header
4. it contains the darwin prebuilt abduco **verbatim** (byte search), exactly one
   abduco copy, and not the other platform's abduco
5. it is ad-hoc signed, is **not** still Bun's `LINKER_SIGNED` output, and carries
   identifier `podium` — i.e. rcodesign really ran
6. its entitlements plist contains all five JIT keys (content, not slot presence)
7. `rcodesign verify` reports no code digest mismatch — the signature seals the
   shipped bytes

### Proof that those assertions can fail

An earlier version of this script printed `ALL PASSED` with a 50 KB hello-world
binary in the tarball, and printed `ALL PASSED` again when its embedded-abduco input
was deleted. It checked a loose sibling binary and a build scratch file, not the
artifact. So the asserter now ships with negative controls:

```sh
scripts/spike/prove-assert-can-fail.sh
```

Ten tampered inputs, each required to exit non-zero **for the expected reason**:
hello-world Mach-O, Linux ELF, a real build with the Linux abduco embedded, a
stripped signature, one flipped sealed byte, an empty entitlements plist, Bun's raw
linker-signed output, a deleted prebuilt input, the old loose-extras tarball layout,
and a nonexistent path. The transcript is on POD-2501.

---

## How the Linux bytes were produced

Host tools: Bun 1.3.14, zig 0.16.0, rcodesign 0.29.0.

```sh
# 1. prebuilt abduco (darwin-arm64 + darwin-x64)
scripts/spike/build-prebuilt-abduco.sh
#    zig cc -target aarch64-macos-none … -Iscripts/prebuilt/abduco/cross -Wl,-headerpad,0x8000
#    rcodesign sign scripts/prebuilt/abduco/darwin-arm64/abduco
#    (stub scripts/prebuilt/abduco/cross/util.h supplies forkpty decls; zig's Darwin
#     headers omit them, the symbols live in libSystem. -headerpad is signing room.)

# 2. cross-compile + sign, one run, no hand steps
bun --conditions=@podium/source scripts/spike/build-bun-darwin.ts --target=bun-darwin-arm64
#    rcodesign sign --binary-identifier podium \
#      --entitlements-xml-file scripts/spike/bun-jit.entitlements.plist <mach-o>

# 3. package the updater-shaped tarball + the Mac bundle
PLATFORM=darwin-arm64 scripts/spike/package-mac-execution-bundle.sh

# 4. assert, and prove the assertions can fail
scripts/spike/linux-assert-darwin-spike.sh
scripts/spike/prove-assert-can-fail.sh
```

Everything under `dist-bun-spike/` is gitignored build output. The prebuilt abduco
binaries are gitignored too — rebuild them with the script above.

---

## Re-running the macOS proof

`.github/workflows/darwin-mac-execution-proof.yml` (`workflow_dispatch`) builds on
`ubuntu-latest`, asserts, runs the negative controls, then executes the payload on
`blacksmith-6vcpu-macos-15` and `macos-15-intel`. It is deliberately **not** a
per-release gate — §8b's whole point is that no Mac sits in the build loop — but the
proof can be repeated after a Bun bump, an abduco rebuild, or a signing change.

---

## Follow-ups

1. **POD-2520 complete for CI** — arm64 + x64 execution, Apple strict verifier,
   quarantine-present observation, and the genuinely stripped probe are recorded in
   run `32513654765`; real-hardware enforcement remains POD-2569.
2. Land the spike adaptations into release `build-bun.ts` / the release matrix
   (POD-2504) — carrying the entitlements finding above.
3. Gatekeeper/AMFI behaviour on real user hardware, if the shipping story needs it.
