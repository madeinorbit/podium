# POD-327 daemon decomposition evidence

Status recorded 2026-08-02. The implementation is complete; Phase-5 exit remains open for the
proven interaction-latency regression, an interrupted oracle unit lane, and the required
paired-VPS soak.

The implementation merge is `8b7e12aa14c21d2f3f5754f639d2669d141cce12`. Catch-up merge
`197271ca` incorporates integration through `3336ae8b` and the POD-1350 oracle repairs at
`97d7b0aa`. Generated architecture documents were regenerated from resolved code rather than
hand-merged.

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
- The scar-tissue registry names the relocated frame, self-update, instance-boot ordering,
  loop-stall attribution, durable-backend fallback, reattach/boot-state, and Codex guard seams with
  their incident rationale and backing tests.
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
- The catch-up conflict deliberately keeps `registry.modules.machines.hostMachineId` in the
  real-socket fixtures. The machines module owns the canonical minted host identity;
  `sessionStore.hostMachineId` is the retired reader and was not reintroduced.

## Codex guard

The daemon probes `codex --version` before editing Codex hook configuration. Versions 0.142–0.146
use the tested public hook contract. Unknown, unparsable, or unavailable versions leave both
`hooks.json` and `config.toml` byte-identical, emit a journal banner, and queue an authenticated
machine diagnostic. The server stamps the machine principal and routes a deterministic personal
issue-mail and external notice only to that machine's owner and admins. The installed real binary
smoke passed with `codex-cli 0.146.0`.

## Verification

- On the current pushed tip, the consolidated daemon, Codex guard, and shared handshake suite
  passed 23/23 files: 184 tests passed and 1 skipped. The conflict-resolved real-socket
  wire-window integration passed 1/1 file and 1/1 test. The corrected hermetic Grok hook suite
  passed 1/1 file and 8/8 tests.
- Focused daemon/protocol/router run: 10 files passed, 233 tests passed, 1 skipped.
- The rebased handshake/authorization contract run passed 8/8 files and 111/111 tests across the
  daemon dialer, gateway acceptor, shared conformance/strategy suites, payload-inert identity, and
  local-host `use` refusal.
- The authorization-state mutant (`auth-failed` → `blocked`) made the exact connection suite fail
  1 of 6 tests with `blocked` versus `unauthorized`; after restoration, 1 file / 6 tests passed.
- The configured integration lane passed 40/40 files: 287 tests passed and 6 skipped. Its separate
  acceptance test now reaches the performance property after explicit ownership/auth updates;
  two measurements under host load average 58–63 on 8 CPUs exceeded the unchanged 25 ms p95
  threshold (35.84 ms and 33.23 ms), so neither was recorded as a valid green measurement. The
  requested lower-load run started at 23.16 / 27.54 / 35.16 and ended at
  19.68 / 26.24 / 34.49; it failed 1/1 file and 1/1 test at 36.4404 ms p95. Because load fell
  during that run, this is recorded as a real red against the unchanged 25 ms budget.
- The same interaction was run at the exact pre-decomposition parent `dcb06719` in an isolated
  worktree. Only today's mandatory fixture facts were backported: complete issue ownership,
  `instanceId`, authenticated client transport, and `WIRE_VERSION`; scale, 250-cycle interaction
  loop, shadow comparison, and thresholds remained unchanged. It passed 1/1 file and 1/1 test
  while load rose only from 26.80 / 32.73 / 42.21 to 27.39 / 32.34 / 41.78. The current failure at
  lower load is therefore a regression, not an historically unachievable budget.
- Post-merge `bun run typecheck`: 22/22 tasks passed across the 25-package workspace scope.
- `bun run test:multi-instance`: the independent-runtime test passed 1/1 with 41 assertions,
  managed-account spawn passed 3/3, and the install-shell lane reported `ALL OK`.
- POD-327 now has a real phase-close audit item. The phase JSON command,
  `bun scripts/rearch-audit.ts --phase POD-327 --json`, reports one item
  (`oversized-daemon-composition-root`) at count 0, no sites or declared residue, and
  `clearToClose: true`. A planted real mutation from 74 to 301 physical lines made
  the gate exit 1 at line 301; exact restoration returned it to 74 lines and green. The detector
  test passed 1/1 (73 unrelated cases skipped); the pre-catch-up full audit file passed 73/73.
- `bun run audit:machine-grants`: passed.
- On the current merge tip, the composition graph is acyclic/current at 179 modules, construction
  order is current, and the reactions ledger is current at 25 reactions; all three passed without
  `--write` after the generated documents were refreshed.
- The global deletion ratchet is baseline exact at 32 items and 142 sites. The phase-specific
  POD-327 item remains at zero with no undeclared sites or declared residue.
- The machine-grants planted-fixture probe and clean gate passed, and the systemd render matched.
- The Codex guard suite passed 10 tests and skipped 1 in one file; the installed binary reported
  `codex-cli 0.146.0` and took the real-binary arm.
- The production diff moves the existing `FIRST_ADMIN_USER_ID` legacy-binding migration input
  from `daemon.ts` to `host-runtime.ts`; it adds no production occurrence and never supplies a
  transport principal. New explicit uses are confined to authenticated/owned test fixtures.
- `bun scripts/render-systemd.ts --check`: passed.
- Changed issue-local source files pass scoped Biome checks.

## Open Phase-5 gates

- The unchanged 25 ms load acceptance is now a measured red, not an unmeasured gate: p95 was
  36.4404 ms while host load fell from 23.16 / 27.54 / 35.16 to 19.68 / 26.24 / 34.49 on 8 CPUs.
  The pre-decomposition control passed under greater load, proving a regression. The budget has
  not been relaxed. Diagnose and fix the cost, then rerun the exact command with pre/post load.
- POD-1350 and POD-1359 repaired the deterministic layout/machine oracle drift. The four exact
  files pass 4/4 and 128/128 tests. The repaired-tip oracle started at
  24.91 / 31.47 / 41.30, reached 103.44 / 69.03 / 53.57 mid-run, and ended at
  60.81 / 73.98 / 63.26. Its unit process was killed with exit 143 after 486 seconds, before a
  final Test Files/Tests census. It had emitted one timing-shaped rearchitecture-audit failure
  taking 45.459 seconds; this is interrupted/contended evidence, not a functional verdict.
- The repaired oracle's configured integration suite passed 40/40 files with 289 tests passed and
  6 skipped. Its chained acceptance failed 1/1 at 29.1407 ms under the severe-load portion and
  does not replace the valid quiet regression measurement. E2E passed 8/8 files and 31/31 tests.
  Multi-instance passed runtime 1/1 with 41 assertions, managed-account 1 file / 3 tests, and
  installer `ALL OK`. Typecheck passed 22/22 tasks. The oracle remains red until the unit lane
  completes with a census and the latency regression is fixed.
- `bun run lint:boundaries` still reports the unrelated POD-1321 daemon-lifecycle import and dead
  allowlist entry, with no POD-327 path in the output. POD-1321 received issue mail with the
  current output.
- The 48-hour unattended paired-VPS soak has not run. The authoritative steps and pass criteria
  are in the POD-327 section of `docs/rearchitecture-v3.md`; the ready-to-fill artifact is
  `docs/agents/pod-327-paired-vps-soak-evidence.md`. POD-327, POD-426, and POD-292 must remain open
  until completed gate evidence is attached and accepted.
