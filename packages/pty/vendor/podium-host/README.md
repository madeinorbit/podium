# podium-host (Rust)

The durable process host behind every podium session on Linux and macOS (SPEC-6,
POD-3190 artifact #31), and since POD-4986 the only one Podium spawns. Building it
needs no C compiler. `packages/pty/src/host-bin.ts` resolves the binary for every new
spawn:

1. `PODIUM_HOST_BIN`, when set. It must answer `version` as a podium-host at feature
   level 2, or resolution fails loudly and never falls back.
2. A release's `podium-host`, shipped beside `podium-cli` (cross-built by
   `scripts/rust-host-cross.ts`; customer machines never run cargo).
3. In a source checkout, this crate built with cargo on the daemon's first use, cached
   by source hash under `~/.cache/podium/podium-host-src/<hash>/podium-host`
   (`$PODIUM_RUST_HOST_BUILD_DIR` moves it), so every worktree shares one build.

Otherwise the daemon refuses every spawn with a diagnostic; there is no fallback host.

It began as a port of the C host, `host.c`, which was the shipped host until POD-4986
removed it from the tree (it lived in this same directory, `packages/pty/vendor/podium-host/`,
before this crate took its place; the source is in git history).
It keeps host.c's command line, wire protocol and exit codes, apart from the differences
below. A C host an older daemon started is still adopted until its session exits: both
speak the one protocol in `packages/pty/src/host.ts`, and only new spawns choose a
binary. Background, measurements and both security reviews: the comparison doc and the
reviews attached to POD-4791, POD-4842 and POD-4843.

## Differences from the retired C host (host.c)

Deliberate, each for a reason; everything else matches host.c byte for byte.

**Protocol**

- **The screen (`version` says `features=2`; host.c stays at 1).** With the `screen`
  cargo feature, on by default, a host with a pty keeps the terminal's screen in an
  emulator (alacritty_terminal) fed from every read, with `--screen-scrollback N`
  lines of history (default 1000). WELCOME gains a trailing features byte, bit 0 =
  screen; a `--no-pty` host keeps no screen and sends 0. See **Pictures** below.
- **ERR 5 "input queue full".** The input queue toward a child that is not reading is
  capped at 16 MiB (plus 64 bytes per queued write, so empty WRITEs are bounded too): up
  to 16 MiB in flight toward a slow reader still lands, and a child that has stopped
  reading is bounded. A WRITE past the cap is refused with ERR 5 and its input is
  dropped (a deliberate policy; host.c queues without limit). The connection keeps
  working.
- **An ERR that refuses a WRITE names it.** After the message it carries the write's
  `u32` id (for ERR 1 not-the-writer, ERR 4 child-exited and ERR 5). host.c sends no
  id. An older client still parses the frame (it reads only up to the message) but
  routes the ERR to its oldest pending request, which is wrong for ERR 5: **the Rust
  host needs the `host.ts` from `78f80726d` or later.**
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

## Pictures (POD-4909)

A picture is an ANSI redraw of the whole terminal state (scrollback and screen with
attributes, the alternate screen, saved cursor, scrolling region, modes, pen, title,
synchronized output), followed by any unfinished escape sequence the emulator is
holding. Written to a fresh terminal of its size, it leaves that terminal where the
child's output up to its `seq` left the real one.

- **`PICTURE` (`0x0B`, empty)** opts the connection in and is answered with a `reset`
  picture. A host without a screen answers it as any unknown frame (ERR bad frame,
  then close); `host.ts` never sends it to one.
- **`PICTURE` out (`0x8D`)**: `u64 seq`, `u8 reason` (0 `reset`, 1 `cut`), `u16 cols`,
  `u16 rows`, the bytes. It sits in the connection's output stream exactly at `seq`:
  the DATA before it ends there and the DATA after it starts there.
- **When:** a `reset` answers a request and follows every resize that changed the
  pty's size (to every opted-in connection). A `cut` bounds what a late viewer must
  replay: one clock per host takes one when the output since the last cut reaches
  max(64 KiB, the last picture's size) and 250 ms have passed, waking for the 250 ms
  if no more output comes. One serialisation serves every connection that gets it.
- **Bounds:** a picture is at most 1 MiB (scrollback lines are dropped from the top;
  a visible screen larger than that is sent whole) and does not count against the
  connection's queue limit. A connection has at most one picture in flight and one
  more owed (a reset outranks a cut); one the ring outran before the connection read
  up to it is replaced by a fresh reset.
- **Cost** (release musl, measured on POD-4909): +92 KB executable, +0.4 MB idle, up
  to +4.7 MB with 1000 lines of scrollback at 160 columns; 0.01–0.02 % of a core at
  real Claude output rates; a Claude picture is 4–15 KB.
- **vte 0.15.0** drops the byte after a UTF-8 character it was handed in part; the
  feed never hands it one (`screen.rs`, with a test).

The client side already copes with all of this: `packages/pty/src/host.ts` has
`HostErr.INPUT_FULL`, rejects exactly the write an ERR names (falling back to the
oldest request when there is no id, as an adopted C host sends), and logs refused
input once.

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

Toolchain pins live in this directory's `mise.toml` and `rust-toolchain.toml`: Rust
1.98.1 and cargo-zigbuild, linking through the repository's pinned zig. They stay out of
the repository's `mise.toml`, which pins podium-tunnel's older Rust; the release workflow
installs this crate's toolchain from here, and a dev daemon's first-use build runs
`rustup run <channel> cargo build --release --locked` with the channel from
`rust-toolchain.toml` (plain `cargo` when rustup is missing).

```sh
cd packages/pty/vendor/podium-host
mise trust && mise install
cargo test --release     # unit tests, plus tests/security.rs (Linux: drives the binary)
cargo zigbuild --release --target x86_64-unknown-linux-musl   # static, as rust-host-cross.ts builds it
# also: aarch64-unknown-linux-musl, x86_64-apple-darwin, aarch64-apple-darwin
```

`tests/security.rs` has one test per fixed security finding (REPLAY flood, input queue,
removing a replaced socket, removing its own socket, a relative socket, inherited fds,
a full backlog, `--cwd`); each fails on the code before its fix, and each ends the
hosts and children it started. The repository's TypeScript host suites run against
this binary through the same resolution as the daemon (the cached source build, or
`PODIUM_HOST_BIN`).

Darwin outputs need `rcodesign sign --binary-identifier podium-host` (zig signs
arm64 ad hoc and leaves x86_64 unsigned); `scripts/rust-host-cross.ts` does this for the
release, and `.cargo/config.toml` reserves the header room for it.

## Windows

The native MSVC host uses ConPTY for interactive children and overlapped named
pipes for SPEC-6 clients and child I/O. Its pipe rejects remote clients and has
a protected DACL for the current user; discovery markers receive the same DACL.
The launcher detaches and breaks away from the daemon's job before reporting
success. The host owns a separate kill-on-close job for the child tree.

Screen models, pictures and automatic cuts use the same VT emulator and clock
on all platforms. ConPTY resizes update the emulator only after successful
ResizePseudoConsole; same-size requests do nothing. Windows hard redraw asks
for an exact picture rather than sending Ctrl-L, which clears the console's
retained output. There is no resize nudge to race with a newer requested size.

Legacy C-host and abduco adoption is POSIX-only: neither predecessor ever ran
on Windows. Windows daemon restart adoption uses inventory markers, verifies
the named pipe with SPEC-6 STATUS, then reattaches to the existing host and child.
POSIX process-group signals and child-originated TIOCSWINSZ remain POSIX-only;
Windows Ctrl-C is console input and termination targets the child job.

Native acceptance: `cargo test --locked` in this crate and, from the repository
root, `bun run test:file -- packages/pty/test/host-windows.bun.test.ts`.

Windows clients use `podium-host connect --socket <pipe>` as a native stdio
bridge. It opens the exact protocol handle with identification-only SQOS,
checks the named-pipe server process's token user against the caller's SID,
and only then forwards bytes. Discovery and adoption use the same bridge;
a stale marker or squatted global pipe name cannot establish trust.
Bare commands search PATH without implicitly searching the session directory.
Only a first-instance bind collision reports exit 3; other startup failures
report exit 1. Unsupported POSIX signals are ignored with a protocol diagnostic.
ConPTY SIGINT writes Ctrl-C; a pipes-only child has no console, so its documented
interrupt equivalent terminates its owned job with status 130. SIGTERM/SIGKILL
terminate the job with status 143/137 respectively.
