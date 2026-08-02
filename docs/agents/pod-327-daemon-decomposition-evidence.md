# POD-327 daemon decomposition evidence

Status recorded 2026-08-02. The implementation is complete; Phase-5 exit remains open for a
contention-free acceptance measurement and the required paired-VPS soak.

## Result

- `apps/daemon/src/daemon.ts` is a 74-line composition root (down from 833 lines).
- `connection-state.ts` owns the three credential choices, shared protocol dialer, lifecycle,
  authorization terminal state, reconnect backoff, connectivity reporting, and pre-auth host
  diagnostic retention.
- Connection state is one ephemeral process-to-server transport lifecycle; `SessionBinding` is
  durable identity and launch entitlement for many sessions. Transport retry or denial has no
  binding transition API and cannot mutate a binding.
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
- The authorization-state mutant (`auth-failed` → `blocked`) made the exact connection suite fail
  1 of 6 tests with `blocked` versus `unauthorized`; after restoration, 1 file / 6 tests passed.
- The configured integration lane passed 40/40 files: 287 tests passed and 6 skipped. Its separate
  acceptance test now reaches the performance property after explicit ownership/auth updates;
  two measurements under host load average 58–63 on 8 CPUs exceeded the unchanged 25 ms p95
  threshold (35.84 ms and 33.23 ms), so neither is recorded as a valid green measurement.
- `bun run typecheck`: all 25 workspace packages passed.
- `bun run test:multi-instance`: the independent-runtime test passed 1/1 with 41 assertions,
  managed-account spawn passed 3/3, and the install-shell lane reported `ALL OK`.
- `bun run audit:rearch`: passed at the checked-in baseline (31 items, 142 sites).
- `bun run audit:machine-grants`: passed.
- The composition graph is acyclic/current at 177 modules, construction order is current, and the
  reactions ledger is current at 25 reactions.
- The Codex guard suite passed 10 tests and skipped 1 in one file; the installed binary reported
  `codex-cli 0.146.0` and took the real-binary arm.
- `bun scripts/render-systemd.ts --check`: passed.
- Changed issue-local source files pass scoped Biome checks.

## Open Phase-5 gates

- The integration oracle is green. The separate load acceptance still needs one low-contention
  run at its unchanged thresholds; a host-starved timing sample is not promoted to green.
- `bun run lint:boundaries` still reports the unrelated POD-1321 daemon-lifecycle import and dead
  allowlist entry. POD-1321 received issue mail with the current output.
- The 48-hour unattended paired-VPS soak has not run. The authoritative steps and pass criteria
  are in the POD-327 section of `docs/rearchitecture-v3.md`. POD-327, POD-426, and POD-292 must
  remain open until the gate evidence is attached and accepted.
