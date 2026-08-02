# POD-327 daemon decomposition evidence

Status recorded 2026-08-02. The implementation is complete; Phase-5 exit remains open for a
contention-free acceptance measurement and the required paired-VPS soak.

The implementation merge is `8b7e12aa14c21d2f3f5754f639d2669d141cce12`. The current pushed
tip is catch-up merge `8b4a3249895505b725963e231e29c7b2f381d0d7`, incorporating
integration through `29897756`. Generated architecture documents were regenerated from resolved
code rather than hand-merged.

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
  threshold (35.84 ms and 33.23 ms), so neither is recorded as a valid green measurement.
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

- A saturated full node run recorded 650 files: 642 passed, 5 failed, 3 skipped; 9,370 tests
  passed, 6 failed, and 33 skipped. Three timing-shaped files then passed 3/3 in isolation:
  terminal keyboard 13/13 each, mirror lag 1 passed / 14 skipped each, and the audit baseline-write
  case 1 passed / 73 skipped each. Integration fixed the three principal-probe failures and the
  merged file now passes 3/3. Integration also corrected the Grok inspection assertion to the
  installed CLI's normalized `pre_tool_use` event while retaining `PreToolUse` as the hook-file
  key; the merged hermetic suite passes 8/8. The full saturated lane has not been rerun, so it is
  not represented as green from these focused fixes.

- The isolated load acceptance remains a named open item. On a credible host, capture `uptime`,
  run `bun run test:acceptance`, and capture `uptime` again. This runs only
  `scripts/loop-split-load.integration.test.ts`, with one worker, no retries, and the unchanged
  25 ms p95 budget.
- The full oracle is a second named open item: capture `uptime`, run `bun run oracle`, then capture
  `uptime` again. Preserve each lane's Test Files / Tests census and require all five lanes green;
  exit 0 alone is not evidence. The 2026-08-02 attempted window remained saturated, rising from
  load 38–45 to 74.17 / 71.36 / 66.12 on 8 CPUs with 30–36 foreign workers, so no contended red or
  unrun gate is represented as green.
- `bun run lint:boundaries` still reports the unrelated POD-1321 daemon-lifecycle import and dead
  allowlist entry, with no POD-327 path in the output. POD-1321 received issue mail with the
  current output.
- The 48-hour unattended paired-VPS soak has not run. The authoritative steps and pass criteria
  are in the POD-327 section of `docs/rearchitecture-v3.md`; the ready-to-fill artifact is
  `docs/agents/pod-327-paired-vps-soak-evidence.md`. POD-327, POD-426, and POD-292 must remain open
  until completed gate evidence is attached and accepted.
