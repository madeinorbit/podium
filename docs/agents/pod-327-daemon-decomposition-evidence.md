# POD-327 daemon decomposition evidence

Status recorded 2026-08-02. The implementation is complete; Phase-5 exit is still open because
the repository oracle is red and the required paired-VPS soak has not run.

## Result

- `apps/daemon/src/daemon.ts` is a 74-line composition root (down from 833 lines).
- `connection-state.ts` owns the three credential choices, shared protocol dialer, lifecycle,
  authorization terminal state, reconnect backoff, connectivity reporting, and pre-auth host
  diagnostic retention.
- `frame-guards.ts`, `instance-bootstrap.ts`, `reattach-gates.ts`, `durable-backend.ts`, and
  `host-runtime.ts` own the relocated seams. `self-update.ts` remains its own policy module and is
  extended for both handshake rejection and HTTP 426. POD-600's classifier remains in
  `loop-attribution.ts`.
- The frame guard documents and tests the benign one-malformed-frame-per-reattach case.
- Host control dispatch remains exhaustive, while the runtime context carries `SessionBinding`.

## Identity and authorization contract

- The daemon dialer and gateway acceptor use the shared protocol handshake for `daemonSecret`,
  `pairCode`, and `machineToken` credentials.
- Gateway credential strategies resolve the machine principal from authenticated transport.
  Payload identity is inert; the shared conformance tests cover a conflicting claimed identity.
- Pairing ownership remains attached to the server-minted pair code and is persisted when that
  credential is redeemed. The daemon does not carry or reconstruct a pairer from payload claims.
- The in-process daemon goes through the same daemon-secret acceptor. It gains no ambient local
  `use` authorization from a server-authenticated human.
- Authentication denial produces `unauthorized` without a retry timer. Transport loss produces
  `offline`/backoff and schedules reconnect.

## Codex guard

The daemon probes `codex --version` before editing Codex hook configuration. Versions 0.142–0.146
use the tested public hook contract. Unknown, unparsable, or unavailable versions leave both
`hooks.json` and `config.toml` byte-identical, emit a journal banner, and queue an authenticated
machine diagnostic. The server stamps the machine principal and routes a deterministic personal
issue-mail and external notice only to that machine's owner and admins. The installed real binary
smoke passed with `codex-cli 0.146.0`.

## Verification

- Focused daemon/protocol/router run: 10 files passed, 233 tests passed, 1 skipped.
- Full `bun run test`: unit 639 files (9,322 passed, 19 skipped), web 182 files / 1,456 tests,
  mobile 4 files / 34 tests, and Bun SQLite 14 tests passed.
- `bun run typecheck`: 22/22 packages passed.
- `bun run test:multi-instance`: passed using separate concurrent runtimes, including managed
  account spawn and install-shell lanes.
- `bun run audit:rearch`: passed at the checked-in baseline (31 items, 168 sites).
- `bun run audit:machine-grants`: passed.
- `bun run audit:composition`: passed after regenerating the composition graph and construction
  order for the new machine-diagnostic route.
- `bun scripts/render-systemd.ts --check`: passed.
- Changed issue-local source files pass scoped Biome checks.

## Open Phase-5 gates

- The oracle is red only in the integration lane. The failing pre-existing multi-user fixtures are
  tracked by proposed discovered issue `.#3` (Oracle integration fixture drift); this result is
  recorded as a quarantine, not described as green.
- `bun run lint:boundaries` still reports the unrelated POD-1321 daemon-lifecycle import and dead
  allowlist entry. POD-1321 received issue mail with the current output.
- The 48-hour unattended paired-VPS soak has not run. The authoritative steps and pass criteria
  are in the POD-327 section of `docs/rearchitecture-v3.md`. POD-327, POD-426, and POD-292 must
  remain open until the gate evidence is attached and accepted.
