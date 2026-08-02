# POD-327 daemon decomposition evidence

Status recorded 2026-08-02. The implementation is complete; Phase-5 exit remains open for a
fully green oracle and the required paired-VPS soak. The unchanged interaction budget now passes
on the current tip; repeated measurements showed that the earlier red was not a reproducible code
regression. Quiet-VPS oracle runs completed the unit census. The latest integration rerun verifies
that the deterministic registry and authorization drift and the normalized-wire benchmark red are
repaired. Its raw full-command exit remains 1 solely for two timing-shaped rearchitecture-audit
cases that pass in the complete file standalone; every downstream stage is green when invoked
separately. The literal full command is therefore not exit-0 evidence, while no product red remains
in the completed census.

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
  while load rose only from 26.80 / 32.73 / 42.21 to 27.39 / 32.34 / 41.78. The then-current
  failure at lower load proved the budget was historically achievable, but did not by itself
  identify a causal code regression.
- Both decomposition boundaries pass the unchanged acceptance: original commit `a04fcdd2` passed
  1/1 file and 1/1 test while load rose from 36.94 / 41.69 / 51.74 to
  47.44 / 44.03 / 51.83; its rewritten current-lineage counterpart `bc4671d2` passed 1/1 and 1/1
  while load fell from 73.91 / 51.77 / 53.31 to 69.01 / 55.18 / 54.40. Midpoint `dceb882f`
  also passed 1/1 and 1/1 at 48.75 / 52.47 / 53.56 to 29.18 / 46.92 / 51.64. The decomposition is
  therefore cleared as the source of the earlier red.
- Repetition at the initially suspected layout edge `1136d789` produced p95 34.414 ms once, then
  passed, then measured p95 16.670 ms. Post-measurement diagnostics showed internal attach/detach
  p95 of 4.225 / 1.350 ms and broadcast p95 of 2.691 ms; the varying term was waiting for the
  asynchronous publication worker, not work introduced inside the daemon connection path.
- The current tip then measured p95 11.802 ms with attach/detach p95 of 2.625 / 0.995 ms,
  broadcast p95 of 1.350 ms, worker max job age 80.322 ms, and max slice 8.606 ms. An immediate
  exact run, with all diagnostic code removed and the 25 ms assertion unchanged, passed 1/1 file
  and 1/1 test while load rose from 12.78 / 24.48 / 38.40 to 16.42 / 23.57 / 37.41. The threshold
  has not been relaxed.
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

- The unchanged 25 ms load acceptance is green on the current tip: 1/1 file and 1/1 test passed
  while load rose from 12.78 / 24.48 / 38.40 to 16.42 / 23.57 / 37.41. The immediately preceding
  instrumented run measured p95 11.802 ms. Earlier reds at 36.4404 and 29.1407 ms are retained
  above as host-scheduling evidence; boundary repetition cleared the daemon decomposition and
  reproduced both pass and fail outcomes at the later layout edge. A controlled remote repeat is
  useful for characterizing variance, but the exact acceptance itself is no longer red.
- POD-1350 and POD-1359 repaired the deterministic layout/machine oracle drift. The four exact
  files pass 4/4 and 128/128 tests. The repaired-tip oracle started at
  24.91 / 31.47 / 41.30, reached 103.44 / 69.03 / 53.57 mid-run, and ended at
  60.81 / 73.98 / 63.26. Its unit process was killed with exit 143 after 486 seconds, before a
  final Test Files/Tests census. It had emitted one timing-shaped rearchitecture-audit failure
  taking 45.459 seconds; this is interrupted/contended evidence, not a functional verdict. The
  exact case then passed in isolation (1 file, 1 test passed, 73 skipped) while load fell from
  70.57 / 65.92 / 62.02 to 65.81 / 65.21 / 61.93.
- The repaired oracle's configured integration suite passed 40/40 files with 289 tests passed and
  6 skipped. Its chained acceptance failed 1/1 at 29.1407 ms under the severe-load portion and
  remains prior host-scheduling evidence rather than the current gate verdict. E2E passed 8/8
  files and 31/31 tests.
  Multi-instance passed runtime 1/1 with 41 assertions, managed-account 1 file / 3 tests, and
  installer `ALL OK`. Typecheck passed 22/22 tasks. The full oracle still requires an all-green
  unit command; the acceptance gate is now banked green.
- The replacement full unit census completed rather than being killed: 658 files total
  (653 passed, 2 failed, 3 skipped) and 9,445 tests total (9,410 passed, 2 failed, 33 skipped) in
  807.41 seconds. A competing full runner drove load to roughly 44. The reds were timing-shaped:
  one 10-second setup-hook timeout in `terminal-view.keyboard.test.ts` (13 cases skipped) and two
  `vi.waitFor` misses in `session-observers.test.ts`. The exact two files then passed in isolation:
  2/2 files and 41/41 tests in 12.20 seconds. No deterministic unit contract red remains, but the
  full command must still complete green before the oracle may be called green.
- A second full oracle ran on the paired VPS in an isolated worktree at exact integration commit
  `fc6f5bbb88cd2d827a5b153c42baf56049b5447a`. The exact command was
  `/home/till/.bun/bin/bun run test`; the transient user unit had `NRestarts=0`, started at load
  1.33 / 1.27 / 1.21, and exited 1 after 973.20 seconds at load 1.96 / 3.32 / 3.88. The unit census
  was 661 files total (654 passed, 4 failed, 3 skipped) and 9,497 tests total (9,470 passed,
  7 failed, 20 skipped). Because `test:unit` failed, the chained web, mobile, and Bun-only stages
  did not run. The complete log is preserved on the VPS at
  `/home/till/.podium/pod327-oracle/oracle-fc6f5bbb.log` with SHA-256
  `369add892bf2446e71eb3c113d834b8a8f3f6d7856823f6b008b2c1b7bbbb130`.
- The quiet-VPS reds were classified individually. `resolve-node-executable.test.ts` failed both
  tests because the VPS has no real Node 22 binary on `PATH`; this is the resolver's explicit
  environment prerequisite and can be supplied non-system-wide through `PODIUM_NODE_BIN`.
  `issues.normalized-wire.bench.test.ts` hit its unchanged 300,000 ms timeout and finished the file
  at 343.880 seconds on the quiet host, so it remains a timing-shaped but unresolved red. Three
  deterministic `rearch-audit.test.ts` assertions found that POD-1251 now exits 0 where the
  instrument expects 1 (plain and JSON output) and that `change-row-typings` matches zero sites.
  `oracle-authz.test.ts` observed `sessions.handoff` absent from relay dispatch instead of
  gate-refused; integration advanced during the run to `dfa58a4f`, whose POD-1386 delta directly
  repairs and classifies that case. The other reds are untouched by that delta and remain open.
- The requested quiet-VPS rerun used exact integration commit
  `809895679a1658e74e26f883f35bf1fa3b3fd170` in an isolated worktree. The exact full command was
  `/home/till/.bun/bin/bun run test`, with
  `PODIUM_NODE_BIN=/home/till/.podium/pod327-oracle/node-v22.22.2`; the staged Node binary's
  SHA-256 is `81925c0995b5c1427b5d538e6a90ca2fdc4daffb786b09af749beaf7369d4e90`.
  The transient user unit had `Restart=no` and `NRestarts=0`, ran from 16:07:43 to 16:24:44 CEST,
  and exited 1 after 1,019.86 seconds. Load was 0.74 / 0.43 / 0.84 before the run and
  0.75 / 2.94 / 3.86 immediately afterward.
- The rerun's unit census was 663 files total (657 passed, 3 failed, 3 skipped) and 9,524 tests
  total (9,500 passed, 4 failed, 20 skipped). Because `test:unit` failed, the chained web,
  mobile, and Bun-only stages did not run. The Node override made
  `resolve-node-executable.test.ts` pass 1 file / 2 tests. The prior deterministic
  rearchitecture and `sessions.handoff` contract failures no longer appear.
- `issues.normalized-wire.bench.test.ts` again hit its unchanged 300,000 ms timeout, finishing at
  336.773 seconds while the VPS remained quiet. This is the second quiet-host reproduction and
  remains the product red tracked by POD-1418; its timeout was not raised. The ordinary
  `issues.normalized-wire.test.ts` passed 1 file / 7 tests in 94.661 seconds.
- The full lane's two `rearch-audit.test.ts` failures were timing-shaped: the output-flag gate and
  baseline-write cases exceeded 40 and 20 seconds respectively. With the VPS Bun directory
  explicitly restored to the non-login shell's `PATH`, the entire file passed standalone:
  1 file / 75 tests in 147.54 seconds. The first standalone attempt without that `PATH` is invalid
  setup evidence because eight child-process cases could not resolve `bun`.
- Both POD-1414 order-sensitive files passed in separate standalone Vitest processes:
  `oracle-authz.test.ts` passed 1 file / 29 tests in 38.57 seconds, including the dispatched
  `sessions.handoff` arm, and `wsServer.client-auth.test.ts` passed 1 file / 7 tests in
  22.83 seconds. They also emitted no failure in the full lane.
- `codex-hooks.test.ts` failed its installed-real-binary smoke because this VPS has no `codex`
  executable on `PATH`. That is an explicit host prerequisite rather than permission to install
  or invoke a real agent; the already-authorized local real-binary smoke remains green with
  `codex-cli 0.146.0`. The full log is preserved on the VPS at
  `/home/till/.podium/pod327-oracle/oracle-80989567.log` with SHA-256
  `055fbbc35b19b91544e3568263350a4d7ad88a5740747d76e8a38d1e0d118754`. Standalone logs are
  preserved beside it with SHA-256 values `54e712ebec9c0570be7dd600037c339fea765a5198673a18bfa14f0da108bc08`
  (rearchitecture), `198454a0ca26263ce28567bfac0390b07da30c82bc465b4b04b3a368952351a6`
  (oracle authorization), and `319fa88501bdd3dce386400840c7ed4f6280d709a69284a0c6ef75316d0d62a8`
  (WebSocket client authorization).
- The final requested quiet-VPS rerun used exact integration commit
  `413d3f88ff51fadd72a54a064c1de0b273345657`, whose subject records the POD-1418
  normalized-wire bench repair. The exact command remained `/home/till/.bun/bin/bun run test`,
  with the same checksum-verified `PODIUM_NODE_BIN` override and an explicit Bun `PATH`. The
  bounded transient unit used `Restart=no`, had `NRestarts=0`, ran from 16:44:05 to 16:56:17 CEST,
  and returned raw exit code 1. Load was 1.34 / 1.05 / 1.88 before the run and
  2.44 / 6.29 / 5.40 immediately afterward.
- The final unit census was 663 files total (659 passed, 1 failed, 3 skipped) and 9,533 tests total
  (9,511 passed, 2 failed, 20 skipped) in 729.91 seconds. The only failed file was
  `rearch-audit.test.ts`: `gates a phase whose items are still alive, and clears one that reached
  zero` and `an output flag cannot disable the gate` each exceeded their 40-second full-lane
  timeout. The host one-minute load reached roughly 13 during the parallel unit lane. The complete
  file then passed standalone, exit 0: 1 file / 75 tests in 123.26 seconds; those two cases
  completed in 32.156 and 31.253 seconds respectively.
- POD-1418 is cleared in the measured candidate: `issues.normalized-wire.bench.test.ts` passed
  1 file / 1 test in 44.116 seconds under its reduced 60-second wedge. The ordinary
  normalized-wire suite also passed 1 file / 7 tests. `resolve-node-executable.test.ts` passed
  1 file / 2 tests through the explicit Node override. The VPS agent-CLI inventory was left
  untouched; `codex-hooks.test.ts` passed 10 tests and skipped the unavailable real-binary case.
- Both POD-1414 order-sensitive files passed in separate processes at this exact commit:
  `oracle-authz.test.ts` exited 0 with 1 file / 29 tests, including both the dispatched handoff and
  distinct gate-refused ending, and `wsServer.client-auth.test.ts` exited 0 with 1 file / 7 tests.
- Because the raw unit exit stopped the root command's `&&` chain, its exact downstream scripts
  were run separately rather than hidden: web exited 0 with 183 files / 1,460 tests; mobile exited
  0 with 4 files / 34 tests; Bun-only exited 0 with 1 file / 14 tests. Across all four executed
  stages this is 851 files total (847 passed, 1 failed, 3 skipped) and 11,041 tests total
  (11,019 passed, 2 failed, 20 skipped), with the two failed tests qualified by the green complete
  standalone audit file above.
- The final full log is preserved on the VPS at
  `/home/till/.podium/pod327-oracle/oracle-413d3f88.log` with SHA-256
  `f3850931225338192565b800b629c097551b322b9834d7bcd6fc3507e721957c`. Standalone SHA-256
  values are `305fe3d4b8d66d4b024e774c69942f65dfb4f0dcf4485c38fe694a276cb2093a`
  (rearchitecture), `daefacaa9ff864c00fc2d5d46e5d53a176e0ca6118ebc87c8c639c7bd1ee8282`
  (oracle authorization), and `0b9172c21e448d87cc922af0c2f522456807e036f43b5e64ba5328ef1347d654`
  (WebSocket client authorization). Downstream log SHA-256 values are
  `086fa1d0f6b0f8f27219da65887764d88f55fdd5d5318911cd053fdc8fdb38c8` (web),
  `c96e135c0ff13aded3018e8e2e8e124f171712ae70b58ce818fb557f25d07008` (mobile), and
  `69513c4f865a149b7c0764f0d514ef4be466140b4bceea448d2d1550708188bd` (Bun-only).
- Protocol-compatible soak evidence requires the control plane and daemon to be built from the
  same deployed lineage at or after integration merge `6e87329f`, which is the narrowest proven
  same-tree contract containing the POD-327 gateway/daemon handshake. There is no documented
  cross-version compatibility matrix, `WIRE_VERSION` remained 1 across the semantic contract
  change, and a protocol-only cherry-pick would create a new unproved lineage. The failed preflight
  against live main `f97ed4fc` therefore counts zero soak time; no replacement soak has started.
- `bun run lint:boundaries` still reports the unrelated POD-1321 daemon-lifecycle import and dead
  allowlist entry, with no POD-327 path in the output. POD-1321 received issue mail with the
  current output.
- The 48-hour unattended paired-VPS soak has not run. The authoritative steps and pass criteria
  are in the POD-327 section of `docs/rearchitecture-v3.md`; the ready-to-fill artifact is
  `docs/agents/pod-327-paired-vps-soak-evidence.md`. POD-327, POD-426, and POD-292 must remain open
  until completed gate evidence is attached and accepted.
