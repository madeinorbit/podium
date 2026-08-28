# POD-2501 — proof that the Linux assertion script can FAIL

Host: Linux 6.8.0-117-generic x86_64 | bun 1.3.14 | zig 0.16.0 | apple-codesign 0.29.0
Date: 2026-08-21T01:26:25Z

```
=== prove-assert-can-fail (POD-2501) ===
date:      2026-08-21T01:26:25Z
asserter:  /home/mgw/src/other/podium/.worktrees/issue-2501-darwin-cross-compile-spike/scripts/spike/linux-assert-darwin-spike.sh
good tarball: /home/mgw/src/other/podium/.worktrees/issue-2501-darwin-cross-compile-spike/dist-bun-spike/darwin-arm64/podium-headless-darwin-arm64.tar.gz
good sha256:  88546ba6c6c34eaf12734a8963a3ae87e20bed7fdba3e15001d4d9b6a0034140

--- baseline: the untampered shipped tarball must PASS ---
OK: baseline exit=0
  PASS lines: 11
  hello-world size: 89744 bytes (signed, identifier=podium, JIT entitlements)

──────────────────────────────────────────────────────────────────────
CASE 1: hello-world Mach-O swapped in as headless/podium-cli
  expected FAIL to mention: does NOT appear inside the shipped binary
  exit=1
  | === linux-assert-darwin-spike ===
  | tarball=/tmp/podium-prove-hey1QV/t.tar.gz
  | platform=darwin-arm64 (expect Mach-O arm64)
  | tarball sha256=0323874741c2aac28d425bb4800ce90897ab647b3e7e6159b25241367df216c5
  | PASS: tarball archive root is headless/ with podium-cli, podium, VERSION and nothing else
  | shipped binary sha256=f34c3a8f6acbfe2cb78a5f58dd8a8ec784d11abcde862666ecfe458d58d6ce8e
  | shipped VERSION=spike-darwin+0.1.1-edge.1
  | file headless/podium-cli: Mach-O 64-bit arm64 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL|NO_REEXPORTED_DYLIBS|PIE>
  | PASS: shipped headless/podium-cli is Mach-O arm64
  | PASS: prebuilt abduco input is Mach-O arm64
  | size=89744
  | prebuilt_len=817504
  | prebuilt_at=-1
  | elf_headers=0
  | abduco_banner=0
  | other_prebuilt_at=-1
  | PASS: shipped binary contains no Linux ELF header
  | FAIL: the darwin arm64 prebuilt abduco (817504 bytes) does NOT appear inside the shipped binary
  >>> OK: went red for the right reason

──────────────────────────────────────────────────────────────────────
CASE 2: Linux ELF swapped in as headless/podium-cli
  expected FAIL to mention: is not Mach-O
  exit=1
  | === linux-assert-darwin-spike ===
  | tarball=/tmp/podium-prove-hey1QV/t.tar.gz
  | platform=darwin-arm64 (expect Mach-O arm64)
  | tarball sha256=5b4bf9066c1e4244a66c44e9bed9a8a7cae798a2cf3890ab16f2405c156229e3
  | PASS: tarball archive root is headless/ with podium-cli, podium, VERSION and nothing else
  | shipped binary sha256=d759ef270dec45a9dbff0954d2a9092405da3ea18784b136b73e8fa5e4b8830c
  | shipped VERSION=spike-darwin+0.1.1-edge.1
  | file headless/podium-cli: ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, BuildID[sha1]=1799610512faa7b7f0769f311e8953cb6523e53c, for GNU/Linux 3.2.0, not stripped
  | FAIL: shipped podium-cli is not Mach-O (got: ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, BuildID[sha1]=1799610512faa7b7f0769f311e8953cb6523e53c, for GNU/Linux 3.2.0, not stripped)
  >>> OK: went red for the right reason

──────────────────────────────────────────────────────────────────────
CASE 3: build with the LINUX abduco embedded
  expected FAIL to mention: Linux ELF header
  exit=1
  | === linux-assert-darwin-spike ===
  | tarball=/home/mgw/src/other/podium/.worktrees/issue-2501-darwin-cross-compile-spike/dist-bun-spike/fixtures/linux-abduco-embedded.tar.gz
  | platform=darwin-arm64 (expect Mach-O arm64)
  | tarball sha256=4d5829f04efaa43c4507076d45c3ee7fde534ec20383d83751fd5ae2d899b9af
  | PASS: tarball archive root is headless/ with podium-cli, podium, VERSION and nothing else
  | shipped binary sha256=58d9a8c6bb5c29a52e0c46632b10cc1e456a4fa090d909595cbfcaeb9a7eaf12
  | shipped VERSION=spike-darwin+0.1.1-edge.1
  | file headless/podium-cli: Mach-O 64-bit arm64 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL|BINDS_TO_WEAK|PIE|HAS_TLV_DESCRIPTORS>
  | PASS: shipped headless/podium-cli is Mach-O arm64
  | PASS: prebuilt abduco input is Mach-O arm64
  | size=71543472
  | prebuilt_len=817504
  | prebuilt_at=-1
  | elf_headers=1
  | abduco_banner=0
  | other_prebuilt_at=-1
  | FAIL: shipped binary contains 1 Linux ELF header(s) — a linux binary was embedded
  >>> OK: went red for the right reason
  stripped LC_CODE_SIGNATURE: dataoff=71752368 datasize=567296 __LINKEDIT filesize 770736 -> 203440; 72319664 -> 71752368 bytes

──────────────────────────────────────────────────────────────────────
CASE 4: code signature stripped (genuinely unsigned)
  expected FAIL to mention: NO code signature
  exit=1
  | === linux-assert-darwin-spike ===
  | tarball=/tmp/podium-prove-hey1QV/t.tar.gz
  | platform=darwin-arm64 (expect Mach-O arm64)
  | tarball sha256=cc6c78d3a0b31d70239679a8a2d402bc038c7ee0a676e070023f84098a826458
  | PASS: tarball archive root is headless/ with podium-cli, podium, VERSION and nothing else
  | shipped binary sha256=067e5d1ab5ce4921b006de4ca2eb591063639cff2d542edd4c69ce3c1d99ac31
  | shipped VERSION=spike-darwin+0.1.1-edge.1
  | file headless/podium-cli: Mach-O 64-bit arm64 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL|BINDS_TO_WEAK|PIE|HAS_TLV_DESCRIPTORS>
  | PASS: shipped headless/podium-cli is Mach-O arm64
  | PASS: prebuilt abduco input is Mach-O arm64
  | size=71752368
  | prebuilt_len=817504
  | prebuilt_at=70723983
  | elf_headers=0
  | abduco_banner=1
  | other_prebuilt_at=-1
  | PASS: shipped binary contains no Linux ELF header
  | PASS: shipped binary contains the darwin arm64 prebuilt abduco verbatim at offset 70723983
  | PASS: shipped binary carries exactly one abduco copy (banner string count = 1)
  | PASS: the darwin-x64 abduco is absent from the shipped binary
  | FAIL: shipped binary has NO code signature at all
  >>> OK: went red for the right reason
  flipped one byte at offset 0x10000 (0x00 -> 0xff)

──────────────────────────────────────────────────────────────────────
CASE 5: one sealed byte flipped (signature no longer matches the bytes)
  expected FAIL to mention: digest mismatch
  exit=1
  | === linux-assert-darwin-spike ===
  | tarball=/tmp/podium-prove-hey1QV/t.tar.gz
  | platform=darwin-arm64 (expect Mach-O arm64)
  | tarball sha256=c6d2d679c7b270b3a40813a1a3007693af1e82fecf094f4eee9c797379136f2a
  | PASS: tarball archive root is headless/ with podium-cli, podium, VERSION and nothing else
  | shipped binary sha256=bdccba35b49cbea00d786acd000f0a99ad106650939d00e28df3afce3d4bb43e
  | shipped VERSION=spike-darwin+0.1.1-edge.1
  | file headless/podium-cli: Mach-O 64-bit arm64 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL|BINDS_TO_WEAK|PIE|HAS_TLV_DESCRIPTORS>
  | PASS: shipped headless/podium-cli is Mach-O arm64
  | PASS: prebuilt abduco input is Mach-O arm64
  | size=72319664
  | prebuilt_len=817504
  | prebuilt_at=70723983
  | elf_headers=0
  | abduco_banner=1
  | other_prebuilt_at=-1
  | PASS: shipped binary contains no Linux ELF header
  | PASS: shipped binary contains the darwin arm64 prebuilt abduco verbatim at offset 70723983
  | PASS: shipped binary carries exactly one abduco copy (banner string count = 1)
  | PASS: the darwin-x64 abduco is absent from the shipped binary
  | PASS: shipped binary has an ad-hoc code signature
  | PASS: shipped binary was re-signed by rcodesign (identifier=podium, not LINKER_SIGNED)
  | PASS: shipped binary carries the full Bun JIT entitlement set (5 keys)
  | FAIL: code digest mismatch — the signature does not seal the shipped bytes:
  | code digest mismatch for entry 16; recorded digest f485cc88e5d4165ee308ee4c7b92b564549563a57f1b34f5a1886c4e9f2a7371, actual 9d1e30e3749f4961745befe3ff18c026764a764e8cfc372fe626c86554480a90
  >>> OK: went red for the right reason

──────────────────────────────────────────────────────────────────────
CASE 6: re-signed with an EMPTY entitlements plist
  expected FAIL to mention: entitlements missing com.apple.security.cs.allow-jit
  exit=1
  | === linux-assert-darwin-spike ===
  | tarball=/tmp/podium-prove-hey1QV/t.tar.gz
  | platform=darwin-arm64 (expect Mach-O arm64)
  | tarball sha256=14c6d27b00f3cfc7555a87738314ab9f6f64bb4d526b40e53bc6d873865b60ad
  | PASS: tarball archive root is headless/ with podium-cli, podium, VERSION and nothing else
  | shipped binary sha256=9d9a60ccb5263a2ec1cd13ace82cab566c580d16ed80ac9fce68310696b5122f
  | shipped VERSION=spike-darwin+0.1.1-edge.1
  | file headless/podium-cli: Mach-O 64-bit arm64 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL|BINDS_TO_WEAK|PIE|HAS_TLV_DESCRIPTORS>
  | PASS: shipped headless/podium-cli is Mach-O arm64
  | PASS: prebuilt abduco input is Mach-O arm64
  | size=72318640
  | prebuilt_len=817504
  | prebuilt_at=70723983
  | elf_headers=0
  | abduco_banner=1
  | other_prebuilt_at=-1
  | PASS: shipped binary contains no Linux ELF header
  | PASS: shipped binary contains the darwin arm64 prebuilt abduco verbatim at offset 70723983
  | PASS: shipped binary carries exactly one abduco copy (banner string count = 1)
  | PASS: the darwin-x64 abduco is absent from the shipped binary
  | PASS: shipped binary has an ad-hoc code signature
  | PASS: shipped binary was re-signed by rcodesign (identifier=podium, not LINKER_SIGNED)
  | FAIL: shipped binary entitlements missing com.apple.security.cs.allow-jit
  >>> OK: went red for the right reason

──────────────────────────────────────────────────────────────────────
CASE 7: raw bun --compile output (ADHOC|LINKER_SIGNED, no rcodesign pass)
  expected FAIL to mention: LINKER_SIGNED
  exit=1
  | === linux-assert-darwin-spike ===
  | tarball=/tmp/podium-prove-hey1QV/t.tar.gz
  | platform=darwin-arm64 (expect Mach-O arm64)
  | tarball sha256=fe8a2a4b95f63c97e6d62c679a83168d568857d2baf7d61ec55debd8cff1a430
  | PASS: tarball archive root is headless/ with podium-cli, podium, VERSION and nothing else
  | shipped binary sha256=27d16b37599131aa1a4a4a3d730e67549cd50e88e5395754ee988e653da6eaeb
  | shipped VERSION=spike-darwin+0.1.1-edge.1
  | file headless/podium-cli: Mach-O 64-bit arm64 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL|BINDS_TO_WEAK|PIE|HAS_TLV_DESCRIPTORS>
  | PASS: shipped headless/podium-cli is Mach-O arm64
  | PASS: prebuilt abduco input is Mach-O arm64
  | size=72313058
  | prebuilt_len=817504
  | prebuilt_at=70723983
  | elf_headers=0
  | abduco_banner=1
  | other_prebuilt_at=-1
  | PASS: shipped binary contains no Linux ELF header
  | PASS: shipped binary contains the darwin arm64 prebuilt abduco verbatim at offset 70723983
  | PASS: shipped binary carries exactly one abduco copy (banner string count = 1)
  | PASS: the darwin-x64 abduco is absent from the shipped binary
  | PASS: shipped binary has an ad-hoc code signature
  | FAIL: shipped binary still carries Bun's LINKER_SIGNED signature — rcodesign did not re-sign it
  >>> OK: went red for the right reason

──────────────────────────────────────────────────────────────────────
CASE 8: prebuilt abduco input deleted (must fail, not silently skip)
  expected FAIL to mention: prebuilt abduco missing
  exit=1
  | === linux-assert-darwin-spike ===
  | tarball=/tmp/podium-prove-hey1QV/t.tar.gz
  | platform=darwin-arm64 (expect Mach-O arm64)
  | tarball sha256=88546ba6c6c34eaf12734a8963a3ae87e20bed7fdba3e15001d4d9b6a0034140
  | PASS: tarball archive root is headless/ with podium-cli, podium, VERSION and nothing else
  | shipped binary sha256=e117fba884384b34aa63fc7706dac915f5a93683d3c0b7eddf21d360e0b9da36
  | shipped VERSION=spike-darwin+0.1.1-edge.1
  | file headless/podium-cli: Mach-O 64-bit arm64 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL|BINDS_TO_WEAK|PIE|HAS_TLV_DESCRIPTORS>
  | PASS: shipped headless/podium-cli is Mach-O arm64
  | FAIL: prebuilt abduco missing: /home/mgw/src/other/podium/.worktrees/issue-2501-darwin-cross-compile-spike/scripts/prebuilt/abduco/darwin-arm64/abduco — rebuild with scripts/spike/build-prebuilt-abduco.sh (this is a FAIL, not a skip)
  >>> OK: went red for the right reason

──────────────────────────────────────────────────────────────────────
CASE 9: old spike tarball layout (extras outside headless/)
  expected FAIL to mention: entries outside headless/
  exit=1
  | === linux-assert-darwin-spike ===
  | tarball=/home/mgw/src/other/podium/.worktrees/issue-2501-darwin-cross-compile-spike/dist-bun-spike/darwin-arm64/podium-headless-spike-darwin-arm64.tar.gz
  | platform=darwin-arm64 (expect Mach-O arm64)
  | tarball sha256=b38e2ecb1c780f2ac0e47fb05e0f6a26a1d1258963a7de475f084b2ac47d3695
  | FAIL: tarball has entries outside headless/: abduco
  | podium
  | podium.unsigned
  >>> OK: went red for the right reason

──────────────────────────────────────────────────────────────────────
CASE 10: nonexistent tarball path
  expected FAIL to mention: no such tarball
  exit=1
  | FAIL: no such tarball or spike dir: /tmp/podium-prove-hey1QV/does-not-exist.tar.gz
  >>> OK: went red for the right reason

──────────────────────────────────────────────────────────────────────
=== SUMMARY: 10 negative controls, 0 harness failures ===
RESULT: every negative control went red for the right reason.
        The asserter's PASS on the shipped tarball is load-bearing.
harness exit=0
```
