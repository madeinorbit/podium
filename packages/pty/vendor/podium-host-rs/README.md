# podium-host (Rust)

A Rust implementation of [`../podium-host/host.c`](../podium-host/host.c), the durable
process host behind every podium session (SPEC-6, POD-3190 artifact #31). Podium is
moving its host to Rust; until that switch, **the C host is the shipped one**: nothing
in the default build, `host-bin.ts`'s managed build or the release references this
crate. Select it with the existing override: set `PODIUM_HOST_BIN` to the built binary
in the daemon's environment (`packages/pty/src/host-bin.ts`; an override that does not
answer `version` as a podium-host fails resolution loudly and never falls back).

Same command line, same wire protocol, same exit codes as host.c, apart from the
differences below. Background, measurements and both security reviews: the comparison
doc and the reviews attached to POD-4791, POD-4842 and POD-4843.

## Differences from host.c

Deliberate, each for a reason; everything else matches host.c byte for byte.

**Protocol**

- **ERR 5 "input queue full".** The input queue toward a child that is not reading is
  capped at 1 MiB (plus 64 bytes per queued write, so empty WRITEs are bounded too). A
  WRITE past the cap is refused with ERR 5 and the connection keeps working. host.c
  queues without limit.
- **An ERR that refuses a WRITE names it.** After the message it carries the write's
  `u32` id (for ERR 1 not-the-writer, ERR 4 child-exited and ERR 5). A client that
  reads only up to the message is unaffected. host.c sends no id.
- **A client whose queue would pass ring size + 1 MiB is dropped before the copy.**
  Checked per request, so a burst of pipelined REPLAYs cannot copy a ring each first.
- **SIGNAL with a number that has no name** (0, real-time signals) does nothing; host.c
  forwards any number. No caller sends one.

**Process and socket**

- The child starts in `--cwd` by the directory fd opened at startup (host.c does the
  same; an earlier version of this port did not).
- Every fd inherited above 2 is marked close-on-exec before the host opens its own, so
  nothing the launcher leaked reaches the child. host.c lets them through.
- The socket is removed at exit only while its device and inode still match the one
  this host bound, and by an absolute path. host.c unlinks the path string, after
  `chdir("/")`, so it can delete a newer host's socket or miss a relative one.
- The startup probe of an existing socket is a nonblocking connect: a listener with a
  full accept queue counts as "already running" (exit 3) instead of hanging `create`.
- Startup steps host.c ignores (nonblocking fds, signal handlers, the socket's chmod,
  `/dev/null`) fail `create` with a message. The pty is opened before the SIGCHLD
  handler is installed.

**Internal**

- The ring stores the bytes it keeps from a read larger than the ring at their own
  sequence numbers (host.c misplaces them; reachable only with `--ring-bytes` under
  64 KiB) and is not resident until output reaches it.
- Poll timeouts are a `Timespec`, not whole milliseconds; the listen backlog is std's,
  not 16; a failed ring allocation aborts; a signal cannot cut short the final drain of
  the child's output; the signal handler preserves `errno`; each client's send queue
  drops its already-sent prefix once it is large.

The client side already copes with all of this: `packages/pty/src/host.ts` has
`HostErr.INPUT_FULL`, rejects exactly the write an ERR names (falling back to the
oldest request when there is no id, as for the C host), and logs refused input once.

## Layout and `unsafe`

`proto.rs` (frames, typed requests, parser), `ring.rs` (output ring), `args.rs`
(command line), `host.rs` (state and poll loop), `main.rs` (bind, spawn, daemonize).
The child is spawned with `std::process::Command`; the POSIX calls std does not cover
go through [rustix](https://docs.rs/rustix)'s safe wrappers. All `unsafe` is in
`sys.rs`: six blocks on Linux, seven on macOS, each something no wrapper makes safe.

| where | why it cannot be safe |
|---|---|
| `fork()` for daemonizing | sound only because the process never starts a thread |
| installing the signal handlers | the handler must be async-signal-safe |
| the handler's `write(2)` and `errno` save/restore (`errno_location`, an `unsafe fn` per platform) | raw fd and errno access inside a signal handler |
| marking inherited fds close-on-exec | `fcntl` on fds the process does not own as `OwnedFd` |
| the `pre_exec` hook (`fchdir`, `setsid`, `TIOCSCTTY`) | runs between fork and exec |
| macOS only: `LOCAL_PEERCRED` | rustix does not wrap it; std's `peer_cred` is unstable |

## Build and test

Toolchain pins live in this directory's `mise.toml` (not the repository's, so CI does
not install Rust): Rust 1.98.1 and cargo-zigbuild, linking through the repository's
pinned zig.

```sh
cd packages/pty/vendor/podium-host-rs
mise trust && mise install
cargo test --release     # unit tests, plus tests/security.rs (Linux: drives the binary)
cargo zigbuild --release --target x86_64-unknown-linux-musl   # static, like host-cross.ts
# also: aarch64-unknown-linux-musl, x86_64-apple-darwin, aarch64-apple-darwin
```

`tests/security.rs` has one test per fixed security finding (REPLAY flood, input queue,
removing a replaced socket, removing its own socket, a relative socket, inherited fds,
a full backlog, `--cwd`); each fails on the code before its fix, and each ends the
hosts and children it started. The repository's TypeScript host suites run against
this binary through `PODIUM_HOST_BIN` (see POD-4791 for the suites that delete that
variable and need a stand-in `cc`).

Darwin outputs still need `rcodesign sign --binary-identifier podium-host` (zig signs
arm64 ad hoc and leaves x86_64 unsigned); `.cargo/config.toml` reserves the header room
for it.
