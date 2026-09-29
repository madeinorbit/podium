# podium-host (Rust port) — EXPERIMENT, not shipped

A Rust port of [`../podium-host/host.c`](../podium-host/host.c), written for POD-4791 to
compare size, memory, safety and build effort against the C host before choosing a
language for new native helpers. **The C host stays the shipped one**: nothing in the
default build, `host-bin.ts`'s managed build or the release references this crate.

Same command line and the same SPEC-6 wire protocol (POD-3190 artifact #31). One
deliberate difference: the ring places the bytes it keeps from a read larger than the
ring at their own sequence numbers (host.c misplaces them; reachable only with
`--ring-bytes` under 64 KiB). See the comparison doc attached to POD-4791.

Layout: `proto.rs` (frames, typed requests, parser), `ring.rs` (output ring), `args.rs`
(command line), `host.rs` (state and poll loop), `main.rs` (bind, spawn, daemonize) —
all safe Rust. The child is spawned with `std::process::Command`; the POSIX calls std does
not cover go through [rustix](https://docs.rs/rustix)'s safe wrappers. The only `unsafe`
is in `sys.rs`, five blocks, each one something no wrapper can make safe:

- `fork()` for daemonizing (sound because the process never starts a thread);
- installing the signal handler, and the handler's own `write(2)` to the self-pipe;
- the `pre_exec` hook that makes the child a session leader (and gives it the pty as its
  controlling terminal) between fork and exec;
- macOS only: `LOCAL_PEERCRED`, which rustix does not wrap and std's `peer_cred` has not
  stabilised.

## Build

Toolchain pins live in this directory's `mise.toml` (not the repository's, so CI does not
install Rust): Rust 1.98.1 and cargo-zigbuild, linking through the repository's pinned zig.

```sh
cd packages/pty/vendor/podium-host-rs
mise trust && mise install
cargo test --release                                   # parser, ring, command line
cargo zigbuild --release --target x86_64-unknown-linux-musl   # static, like host-cross.ts
# also: aarch64-unknown-linux-musl, x86_64-apple-darwin, aarch64-apple-darwin
```

Darwin outputs still need `rcodesign sign --binary-identifier podium-host` (zig signs
arm64 ad hoc and leaves x86_64 unsigned); `.cargo/config.toml` reserves the header room
for it.

## Use

Select it with the existing override (`packages/pty/src/host-bin.ts`), without changing
any default: set `PODIUM_HOST_BIN` to the built binary in the daemon's environment. An
override that does not answer `version` as a podium-host fails resolution loudly; it
never falls back.
