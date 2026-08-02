# POD-327 daemon decomposition evidence

Status recorded 2026-08-02. The implementation is complete; Phase-5 exit remains open for a
fully green oracle and the required paired-VPS soak. The unchanged interaction budget now passes
on the current tip; repeated measurements showed that the earlier red was not a reproducible code
regression. A quiet-VPS oracle completed but exposed deterministic registry drift, an environment
prerequisite, and a 300-second benchmark timeout, so it is evidence of a real red rather than a
green exit lane.

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
  did not run.
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
