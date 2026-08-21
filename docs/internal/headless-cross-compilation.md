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
| `rcodesign` | applies an ad-hoc Mach-O signature + entitlements from Linux | `scripts/build-bun.ts` |

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

Apple Silicon refuses to execute an unsigned Mach-O, so the signature is not a
formality — it is what makes the binary runnable.

`bun build --compile` already emits an ad-hoc signature for Darwin targets, but
it is `LINKER_SIGNED`, identifier `a.out`, and carries **no entitlements**. Bun
embeds JavaScriptCore, which JITs, and macOS will not map writable-executable
pages without `com.apple.security.cs.allow-jit`. So the build *re-signs*:

```sh
rcodesign sign --binary-identifier podium \
  --entitlements-xml-file scripts/bun-jit.entitlements.plist <mach-o>
```

`scripts/assert-headless-bundle.sh` checks both discriminators (identifier
`podium`, and NOT `LINKER_SIGNED`) precisely so a silent regression to the
linker signature reads as a failure rather than as a pass. Keep the entitlement
list minimal: every key is a hardened-runtime protection given up.

## Building

```sh
bun scripts/build-bun.ts                            # this machine's platform
bun scripts/build-bun.ts --target=bun-darwin-arm64  # cross, from Linux
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

Everything `assert-headless-bundle.sh` checks, it checks against bytes extracted
**from the tarball** — never a loose sibling in a build directory, because a
build tree can be right while the archive is wrong. It refuses to run without
either `--abduco <reference>` or an explicit `--no-abduco-identity`, so an
omitted input can never read as a green.

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
`scripts/ab-headless-cross-vs-native.sh`.

## What is still not proven here

That a Darwin bundle EXECUTES on a Mac. The POD-2501 spike proved it once, on
`blacksmith-6vcpu-macos-15` (Actions run 32433063958). Per release, CI checks
the Darwin artifacts exist, are summed, verify under the release key, and carry
the right architecture, helper, signature and entitlements — but it does not run
them. Mac execution is a manual step until CI has a Mac verifier (POD-2520).
