# Headless bundles: four platforms, one Linux box

*Spec: `docs/internal/superpowers/specs/2026-08-20-updater-convergence-spec.md` §8b.
Spike evidence: `docs/internal/superpowers/spikes/2026-08-21-darwin-cross-compile-spike.md`.*

Every headless bundle Podium ships — `linux-x86_64`, `linux-aarch64`,
`darwin-aarch64`, `darwin-x86_64` — is produced on one Linux machine. No Mac is
involved in building a payload. This note says how that works, what it depends
on, and how to regenerate the pieces.

## Why there used to be a matrix

`bun build --compile` has always been able to emit a foreign binary. The thing
that pinned each bundle to a runner of its own architecture was the **abduco
helper**: the compiled daemon embeds it (see `scripts/embedded-abduco.ts`,
because a compiled executable has no `abduco.c` on disk to compile at runtime),
and the helper was built by the host's own `cc`. So the release workflow ran
x64 on one runner and arm64 on another, and Darwin was not published at all.

Two tools remove that constraint:

| Tool | What it does | Where it is used |
|---|---|---|
| `zig cc` | cross-compiles `abduco.c` for every target from Linux | `scripts/abduco-cross.ts` |
| `rcodesign` | replaces Bun's linker signature with identifier `podium` + the five JIT entitlement keys | `scripts/build-bun.ts` |

## The abduco helper

`scripts/abduco-cross.ts` builds it, from
`packages/pty/vendor/abduco/abduco.c` — the same vendored source the native
build uses.

**Nothing is checked in.** The repository holds no binaries and this did not
become the first: a committed helper can drift from the source under review,
and no reviewer would ever notice. Instead the build is content-addressed on
the source hash:

```
dist-bun/abduco-cache/<platform>-<sha256(abduco.c)[0:16]>
```

Touch `abduco.c` and every platform's entry is invalidated at once. A CI cache
restored from another commit is therefore either exactly right or invisible;
there is no state in which a stale helper is served under a current name. CI
caches that directory keyed on `hashFiles('packages/pty/vendor/abduco/abduco.c')`,
so the compiles are paid for once.

Regenerate by hand (Linux, `zig` and `rcodesign` on PATH):

```sh
bun scripts/abduco-cross.ts                              # all four
bun scripts/abduco-cross.ts --platform darwin-aarch64 --force
```

Two details that are not obvious and will bite anyone who re-derives the flags:

- **zig's Darwin libc headers have no `<util.h>`.** `forkpty`/`openpty`/
  `login_tty` are exported from libSystem, so a declaration is enough to link.
  The script writes that shim into the cache's `include/` rather than
  committing it: it is a property of the toolchain we work around, not of
  Podium.
- **`-Wl,-headerpad,0x8000` is required for the x86_64 Darwin link.**
  `rcodesign` writes an `LC_CODE_SIGNATURE` load command into the Mach-O
  header; without reserved headroom there is nowhere to put it and signing
  fails.

**Linux helpers link musl, statically.** The native leg linked the runner's
glibc, which quietly made that glibc version the floor for every machine that
took the bundle. A static musl helper has no libc floor at all. It is the one
deliberate behavioural difference between the cross and native legs, and it is
what the arm64 A/B check exists to confirm (see below).

## The Darwin signature

`rcodesign` contributes the entitlements, not the signature. `bun build
--compile` already emits an ad-hoc signed Mach-O (`ADHOC | LINKER_SIGNED`,
identifier `a.out`, **no entitlements**). Apple Silicon refuses a genuinely
unsigned Mach-O, but dropping `rcodesign` does not produce one — it ships Bun's
linker signature, and what breaks is JIT at runtime, not code signing at build
time.

Bun embeds JavaScriptCore, which JITs, and macOS will not map writable-executable
pages without `com.apple.security.cs.allow-jit`. So the build *re-signs*:

```sh
rcodesign sign --binary-identifier podium \
  --entitlements-xml-file scripts/bun-jit.entitlements.plist <mach-o>
```

`scripts/assert-headless-bundle.sh` checks both discriminators (identifier
`podium`, and NOT `LINKER_SIGNED`) plus the five entitlement keys, precisely so
a silent regression to the linker signature — or a re-sign that dropped the
keys — reads as a failure rather than as a pass. Keep the entitlement list
minimal: every key is a hardened-runtime protection given up.

## Building

```sh
bun run package:headless                                      # this machine's platform
bun scripts/package-headless.ts --target=bun-darwin-arm64     # cross, from Linux
bun scripts/release.ts --prepare-cross              # all four, staged for publish
```

`--target` writes to `dist-bun/targets/<platform>/`, so all four survive one
run and can be inspected side by side. A plain host build still writes to
`dist-bun/` exactly as before.

**One target per invocation, and the builds are sequenced.** The compiled binary
embeds the helper through a static `with { type: 'file' }` import of the fixed
path `dist-bun/abduco.bin`; two targets building at once would race to leave the
wrong architecture's helper there. `prepareHeadlessCross` walks the platforms in
order for that reason, and builds the client apps once so all four bundles pack
byte-identical web assets.

## Checking what was built

Three scripts, deliberately separate:

| Script | Subject | Answers |
|---|---|---|
| `assert-headless-bundle.sh` | one tarball | is this really a bundle for the platform it claims? |
| `assert-release-platform-set.sh` | a release directory | is every platform there, summed, signed and named by the manifest? |
| `ab-headless-cross-vs-native.sh` | two tarballs, on target hardware | does the cross-built one BEHAVE like the native one? |
| `prove-headless-assertions-can-fail.sh` | the first script | can the gate say NO, and for the right reason? |
| `smoke-headless-bundle.sh` | one tarball, on matching hardware | does it actually RUN? |

Everything `assert-headless-bundle.sh` checks, it checks against bytes extracted
**from the tarball** — never a loose sibling in a build directory, because a
build tree can be right while the archive is wrong. Client continuity is checked
by the packaging entry point itself: the same process resolves its own Bun executable,
generates a random invocation nonce, and requires both completed client manifests to echo
that nonce before it brands the session in memory. It then packages, extracts the resulting
tarball, and compares the packaged entry set to that process-local value. Direct
`build-bun.ts` invocation refuses, caller-supplied build environments refuse, and no
expected digest is accepted from a flag, environment variable, sidecar, or the archive
itself. This catches
a stale or wrong directory being packaged, partial/corrupt copies, and bytes changed
between build and packaging; it does **not** prove the build itself is correct, because
a broken build can agree with its own captured identity. The tarball gate still verifies
both sites' exact-file manifests, refuses to run without `--source-commit <sha>`, and requires
either `--abduco <reference>` or an explicit `--no-abduco-identity`, so an
omitted input can never read as a green.

And a fourth script exists to check the checker:
`prove-headless-assertions-can-fail.sh` breaks a real bundle and
requires the gate to reject each mutation **for the right reason** — not merely to
exit non-zero, which a typo would also do. The release job runs it on every
release, because a gate that once could fail is not the same as one that still
can. It earned that place on its first run, which found that the entitlement
check had never been exercised by anything: signing an already-signed binary
preserves its entitlements, so the "empty entitlements" mutation had been
mutating nothing.

The cases: hello-world stub · Linux ELF as the Darwin payload · **the wrong
platform's helper actually embedded in the bundle** · wrong-platform reference
supplied · signature stripped · byte flipped inside the sealed region · empty
entitlements · raw Bun output never re-signed · reference helper deleted ·
archive root not `headless/` · `VERSION` removed · no `--abduco` and no waiver ·
`systemd/` removed · stub `web/index.html` · `NOTICE` missing.
Plus a positive control, without which a gate that rejected *everything* would
score a perfect set. The last three are the production-layout checks: a gate
that only required what the spike happened to emit would have accepted them.

Two properties of that harness are load-bearing and were both learned the hard
way:

- **The pattern is matched against the FAILURE LINE alone**, never the whole
  transcript. The gate prints the platform it expects, and what a signature
  failure would *mean* on that platform, on every run — so patterns like
  `signature` or `digest` were being satisfied by output that is always there,
  quietly collapsing two right-reason checks into "exited non-zero".
- **The wrong-helper case mutates the BUNDLE, not the reference.** It originally
  swapped the reference helper, so the gate rejected its own input and the one
  check the matrix collapse most threatens — does this bundle carry the right
  platform's helper? — was never exercised per release at all.

Every file operation in the harness is checked, and each mutated tree is deleted
as soon as it is packed. A bundle tree is ~250 MB; keeping one per case put ~3 GB
in `TMPDIR`, and on a full disk the copies began to fail silently. Unchecked, that
produced short tarballs and a *different* case failing on each run — a near-full
disk truncates writes rather than erroring, so it manufactures confusing evidence
instead of stopping.

### Executing what can be executed

`smoke-headless-bundle.sh` runs a bundle whose platform matches the machine: the
binary starts and agrees with the bundle's `VERSION`, the embedded helper
materializes and runs, and it hosts a detached session that outlives its starter.
The release job runs it on `linux-x86_64` **before** publishing. The published
smoke also runs that bundle, but only after publication — which is too late to
stop a bad one.

### What a signature failure MEANS is not the same on both Macs

A genuinely unsigned Mach-O (signature stripped) will not start on Apple
Silicon; Intel macOS will still execute it. That is a different defect from
dropping `rcodesign`: Bun already signed the binary, so the build still goes
green and the binary still starts — JIT then fails at runtime. Both stop a
release; they send you to different places. `assert-headless-bundle.sh` prints
which one it means before it checks, and the entitlement-key loop is the
build-time stand-in for the JIT failure.

## Prerequisites

| Where | Needs | How |
|---|---|---|
| CI release job | zig 0.16, rcodesign 0.29 | `mlugg/setup-zig`, `scripts/ci-install-rcodesign.sh` |
| CI published-smoke | zig, rcodesign | same (it opens Darwin bundles it cannot execute) |
| The dev host (ludovico) | zig, rcodesign | on PATH, or `PODIUM_ZIG` / `PODIUM_RCODESIGN` |

The dev host needs them because it takes the **same** build path: every dev
build passes `--target`, this host's own included. That is the point — the dev
feed is the continuous test of the release mechanism, and a path only production
takes is a path nothing tests until release day. `resolveZig`/`resolveRcodesign`
fall back to `~/.local/bin` and `~/.cargo/bin` before failing with the install
step named.

## The A/B, and when to delete it

`.github/workflows/release.yml` keeps a temporary `ab-native-arm64` job that
builds `linux-aarch64` the old way, and an `ab-check` job that compares the two
**on ARM hardware**: same version, same packed web build, same file set, both
binaries run and report the same version, both embedded helpers run and report
the same abduco banner, and the cross-built helper hosts a detached session that
outlives its starter.

It gates `publish`, because for the one release this control exists a
cross-built bundle that misbehaves on its own architecture must not ship. The
native leg uploads under its own artifact name — it stages the same asset name
as the cross build, and `loadPreparedHeadless` refuses two descriptors claiming
one platform.

**Delete both jobs after the first release that ships both legs**, along with
`--prepare-arch` in `scripts/release.ts` and
`scripts/ab-headless-cross-vs-native.sh`. That removal is tracked as **POD-2529**,
with the exact list and the removal condition — a temporary control with no
removal ticket becomes permanent by accident, and this one costs an extra ARM
runner on every release.

## What is still not proven here

That a Darwin bundle EXECUTES on a Mac. The POD-2501 spike proved it once, on
`blacksmith-6vcpu-macos-15` (Actions run 32433063958). Per release, CI checks
the Darwin artifacts exist, are summed, verify under the release key, and carry
the right architecture, helper, signature and entitlements — but it does not run
them. Mac execution is a manual step until CI has a Mac verifier (POD-2520).
