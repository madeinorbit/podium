# POD-424 Phase-3 exit gate

**Gate run:** 2026-07-31
**Product candidate:** `8672477077d87e9e6797e12a792d9c24d1bf6055`
**Verdict:** **REFUSED — Phase 4 and Phase 6 remain blocked.**

The command-contract migration is substantially present, the source guardrails refuse
their hash-guarded production mutations, Telegram fails closed, and the secrets split is
complete. The multi-user policy layer assigned to Phase 3 is not live end to end:
production human transports still resolve to the ambient first admin, sharing has no
command surface or rescope emitter, several policy suites inject principals and ports
that production cannot mint, superagent and automation state remain instance-wide,
system jobs do not use the system-principal attribution path, and a real rejected browser
write parks durably without appearing in the recovery UI.

POD-1283 (Phase 3 policy completion) and POD-1287 (dead letters stay invisible) are the
blocking internal remediation issues.

## 1. Evidence convention and baseline

The issue branch started exactly on the product candidate. The gate's first documentation
commit subsequently became `issue/279-integration` HEAD; it changes no product source. No
landing lane or typecheck was re-derived when same-product evidence existed. The fresh
catch-up landing evidence attributed to POD-1246 and POD-1273 is:

- clean integration tree;
- forced typecheck: 23/23 workspaces, 0 cached, exit 0;
- unit lanes: node 9,138, web 1,456, mobile 34, Bun SQLite 14, exit 0;
- shadowing scan: 2,033 files clean, exit 0;
- architecture deletion baseline: 31 items / 197 sites, exact, exit 0.

The gate ran only source audits not covered by that landing record, real-tree
counterfactuals, environment checks, and process close-outs. Before trusting the inherited
typecheck, `rg` found no conflict marker in the product tree. The worktree had no local
dependency installation during the first pass, so that pass correctly refused to borrow
packages from another checkout. The coordinator then installed dependencies in this exact
worktree (2,704 packages, exit 0). The gate independently proved resolution identity with
`apps/server/src/issues.expected-revision.test.ts`: 141/141 passed, exit 0. That suite can
only pass against the expected-revision enforcement in this candidate, not `main`.

Installed-dependency measurements against this checkout are:

| Lane | Result |
|---|---|
| Worktree identity | 1 file, 141/141, exit 0. |
| Focused Phase-3 policy | 16 files, 300/300, exit 0. |
| Focused offline/outbox | 9 files, 205/205, exit 0. |
| Focused web recovery/attribution/legacy queue | 4 files, 29/29, exit 0. |
| Playwright import census for the new runtime case | 1 test in 1 file, exit 0. |
| Official Playwright desktop harness | 1 test, **1 failed**, exit 1: the real server rejected and parked the write, but the recovery chip never rendered (§4). |

Because this gate changed detector source, it also ran the required `bun run test` rather
than treating the inherited landing lane as coverage of the change. The node step stopped
the umbrella command with exit 1: 9,133 passed, 5 failed and 19 skipped across 622 files;
the later web/mobile/Bun steps therefore did not run. Three failures were explicit timeout
victims. Isolated reruns cleared both rearchitecture-audit timeouts and the normalized-wire
timeout (82 passed around one remaining failure), and the 180-second live-scale benchmark
passed 1/1 in 82.10 seconds. The daemon reconnect assertion remained red while its own
loop monitor reported scheduler starvation; that exact test is tracked by POD-1184. These
new measurements are recorded as measurements, not substituted for POD-1246/POD-1273's
same-candidate green landing run.

## 2. Closed-child evidence

Every pre-existing Phase-3 child is `done`; the phase tree was read directly rather than
inferred from the root tree. The important landing records are:

| Issue | Attributable evidence used by this gate |
|---|---|
| POD-311 (Command contracts) | Forced typecheck 23/23, 0 cached; 5,494 focused tests; boundary, deletion, surface and NUL audits green. |
| POD-312 (Session commands) | All four children closed; the session-surface audit's four planted fixtures fired; no hand-written session mutation remained. |
| POD-313 (Superagent/fleet/spec commands) | Thirteen gates green at landing; Phase-3 family deletion ratchet 194 → 179. This did not add superagent owners. |
| POD-314 (Derived router) | Nineteen gates green at landing, but it explicitly closed with six old-scope `router-triple-access` sites rather than zero. Current-tree re-measurement is red at 18 sites (§4). |
| POD-315 (Command security) | Authz matrix landed at `02b865b9`; forced typecheck 23/23; 399/400 focused cases (one recorded load flake); product mutations found a surviving invariant and added its assertion. Its own header says two humans are not production-representable and tRPC/MCP still mint `OPERATOR`. |
| POD-316 (Outbox recovery) | Landed at `9560957e`; the unauthorized classifier mutant turned 6/29 red. Its close record says four ACs cannot be met in this tree. This gate's real browser run now proves a further last-hop failure: durable parking occurs, but the recovery UI stays invisible. |
| POD-352 (Secrets/preferences) | Landed at `77ce11be`; seven-item exit audit at zero after POD-1213; classification mutations changed real outcomes. |
| POD-640 / POD-641 / POD-735 | Mail, workflows and automations derived-surface audits landed with planted fixtures and the family migrations closed. Their policy defaults are assessed below rather than inferred from the migration result. |
| POD-1080 (Telegram binding) | Landed at `dfd39e81`; owner fixture mutant failed 2/20; durable evidence is `docs/agents/pod-1080-gate-evidence.md`. |

All child sessions shown by `podium issue tree 290` are hibernated and the child issues
are closed. Child closure is therefore satisfied as a process fact; it is not evidence
that every child AC was met, because POD-315 and POD-316 explicitly recorded partials.

## 3. Real-tree counterfactual register

This register supersedes the fixture-only register merged in `d367f776`. The earlier
table was probe-level evidence and is not used for the gate verdict below.

The POD-423/POD-310 rule applies: a detector-local fixture is not gate evidence. Each row
below changed the named production file, asserted the changed source and SHA-256, ran the
instrument, and then restored the original hash before the next row. All tools returned to
green after restoration unless the clean tree is itself red and named as such.

| # | Production mutation | Original → mutant SHA-256 prefix | Instrument and refusal |
|---|---|---|---|
| M1 | Removed `rename.visibility` from `sessions/session-state-commands.ts` | `1900ea15` → `7fe25759` | `audit-session-commands` exit 1; exactly one `visibility-totality` at `rename`. |
| M2a | Removed `rename.exposure` from the same real contract | `1900ea15` → `3bd53adc` | **DETECTOR STAYED GREEN.** The script answered visibility while claiming total classification. |
| M2b | Repeated M2a after the small detector repair in this gate | same hashes | exit 1; exactly one `exposure-totality` at `rename`. The local probe now reports 6 checks, not the stale 5. |
| M3 | Widened `commandVisibility({})` fallback from `personal` to `deployment-substrate` | `1d7b5712` → `a9c0e40b` | Direct execution of the actual helper changed `{visibility:"personal"}` to `deployment-substrate`; assertion exit 1. |
| M4 | Widened `commandExposure({})` from `[]` to `['trpc']` | `1d7b5712` → `77910ec8` | Actual `isExposedOn({}, 'trpc')` became true; assertion exit 1. |
| M5 | Renamed the production `superagent-state` ownership-matrix row | `c66a8781` → `ee503f6f` | Durable-class audit exit 1 with exactly 4 missing-row findings, one for each superagent table. |
| M6 | Broke the sole derived `fleetAuthzFailure(...)` call | `8741cd1d` → `e503da67` | Machine-grants audit exit 1; exactly one `fleet-gate-derived` finding. |
| M7 | Replaced the shared Telegram entry's `resolveInboundUser(...)` call | `58a2d6be` → `fc21310c` | Telegram audit exit 1; exactly one `inbound-gated` finding. |
| M8 | Replaced the Telegram refusal with `boundUser ?? FIRST_ADMIN_USER_ID` and continued | `58a2d6be` → `fa0b43b7` | Telegram audit exit 1; exactly 2 findings: fallback identity and missing refusal. |
| M9 | Disconnected IndexedDB open from `scrubSecrets()` | `a393d5ed` → `297386f0` | Client-secrets audit exit 1; exactly one `scrub-wired` finding. |
| M10 | Added `discovery.scanAgain` as a hand-written `.mutation(` | `4809b0fd` → `cf639532` | Router audit exit 1; census 2 → 3 plus `derived-family-clean`. |
| M11 | Changed `setPin`'s first parameter from `userId` to `actorId` | `99525b04` → `22a568db` | Session audit exit 1; exactly one `per-user-keying` finding. |
| M12 | Added `instance_id` to the real `users` SQLite table | `d8fdf02c` → `e58e78d3` | Deletion audit exit 1; `instance-partitions` 0 → 1, naming `users.instance_id`. |

M2a is the campaign's real finding. It was small and self-contained, so this gate repaired
`scripts/audit-session-commands.ts` instead of filing separate work: every session
`CommandDef` must now declare `exposure`, the probe has an independent exposure arm, and
the negative control declares both facets. The check strips comments and string contents;
its probe leaves both comment and decision-string `exposure:` decoys in place. M2b proves
the repair against the same production mutation that escaped it.

Post-revert measurements:

| Instrument | Clean-tree result |
|---|---|
| Session surface | exit 0; 6 local controls fire; production visibility/exposure M1/M2 fire independently. |
| Router mutation census | exit 0 as an instrument, but reports **2** allowlisted hand-written mutations; AC requires 0. |
| Machine grants | exit 0 after M6 restoration. |
| Telegram binding | exit 0 after M7/M8 restoration. |
| Client secrets | exit 0; 5 paths, 2 scrub adapters, 1 named site, 0 POD-421 residuals. |
| Durable classes | exit 0; 89 stores declared or explained. |
| Repository deletion audit | exit 0; 31 items / 197 sites, exact baseline. |
| POD-314 phase-close audit | **exit 1**; `router-triple-access` = 18. |

The detector-local `--probe` modes were also run as controls, but are deliberately not
counted as evidence above. Required production subjects that do not exist cannot be made to
pass by inventing a fixture; items 3–7 and 9 are refused on that basis in §5.

## 4. Original Phase-3 scope

### Hand-written mutation procedures — FAIL

The current-tree source audits all ran. Family audits pass, but the repository-wide
census reports **2 hand-written `.mutation(` procedures** in `router.ts`, both named by
the allowlist:

- `settings.set` at `apps/server/src/router.ts:328`;
- `discovery.scan` at `apps/server/src/router.ts:398`.

M10 proves this is a live census rather than a blessed allowlist: a third procedure made
the count 3 and produced both the family and ratchet findings. The gate still fails because
the required clean count is zero, not because the detector is unproven.

The phase deletion audit is also not zero:

- `bun scripts/rearch-audit.ts --phase POD-313` → exit 0, one item at zero;
- `bun scripts/rearch-audit.ts --phase POD-314` → exit 1,
  `router-triple-access` = **18** surviving sites;
- `--phase POD-290` and `--phase POD-1076` → exit 2 because no items are mapped to
  those phase ids. The CLI failed closed correctly, but those ids cannot be cited as
  passing deletion audits.

### Four-transport authz matrix — FAIL as an end-to-end claim

`apps/server/src/authz-matrix.test.ts` is a valuable policy contract, and it is in the
9,138-test landing lane. Its own header states that tRPC/MCP still mint `OPERATOR` and
that two humans cannot be distinguished. For several axes it substitutes the
person-scoped capability the transports *will* supply. This proves the policy functions,
not the four production transports required by the gate.

### Offline classes and dead-letter UX — FAIL runtime bar

The focused mechanisms are green: 205/205 offline/outbox tests prove classification,
parking, persistence, partitioning and recovery; 29/29 web tests prove the component's
reason-code affordances and attribution handling. Those zeros did not survive the real
application.

The official Playwright desktop harness planted one durable `rename` envelope in
`podium.outbox.v1` with an intentionally missing `sessionId`, then booted the built web app
against the real harness server. The refusing arm demonstrably fired: the server logged
`sessions.rename` `BAD_REQUEST`, the browser received HTTP 400, and the production replica
wrote `podium.replica.outbox-dead-letter.v1` with the exact mutation id, `state:
"dead-letter"`, reason `invalid`, `parkedFrom: "rejected"`, and `attempts: 1`. Despite that
durable record, `[data-testid=outbox-recovery-chip]` remained absent for 30 seconds. A
second Playwright drive reloaded while the same record remained in localStorage; the chip
was still absent after boot. The configured spec therefore exits 1 at its first visible
recovery assertion. The work is kept but cannot be recovered or discarded: **FAIL**.

The browser lane initially stopped before Chromium because Metro did not treat `.wasm` as
an asset even though the exact `expo-sqlite` file was present. The gate added that single
asset extension to `apps/mobile/metro.config.js` (SHA-256 `1daa7410` → `2adda063`); the
mobile web prerequisite then bundled the WASM and exited 0. That infrastructure repair
made the official Playwright failure above observable. POD-1287 owns the product defect.

### Secrets split — PASS

The current source audits pass: settings surface exit 0; client secrets exit 0 with five
classified secret paths, both scrub adapters wired, and zero POD-421-owned residual
sites. `notifications.telegramBotToken` remains in the keyed server-only secret store;
personal routing is outside that store. M9 disconnects a real adapter's open-time scrub
and produces exactly one finding before hash restoration.

## 5. Multi-user acceptance items 1–13

| Item | Verdict | Evidence / refusal |
|---|---|---|
| 1. Visibility totality and private fallback | **PASS** | M1 removes a real declaration and gets exactly one finding; M5 renames the real matrix row and gets four store findings; M3 widens the actual runtime fallback and the direct assertion exits 1. All hashes restored. |
| 2. Exposure totality and served-nowhere fallback | **PASS after detector repair** | M2a first stayed green, exposing a real audit gap. This gate added the sibling source check; M2b then names the omitted declaration. M4 widens the actual fallback and makes `isExposedOn({}, 'trpc')` true, failing the assertion. |
| 3. Transport-stamped attribution pair | **FAIL** | Production HTTP installs `capability: OPERATOR` at `server.ts:406` and gives in-process MCP the same capability at `server.ts:505`; `resolvePrincipal` maps that to `FIRST_ADMIN_USER_ID`. The matrix substitutes person-scoped values that neither transport can mint. No four-transport persisted-write probe or forged-payload probe was executable, so neither is claimed. |
| 4. Share/unshare plus rescope | **FAIL** | Exact command-name search finds only `machines.revoke`, which unpairs a machine; it finds zero share/unshare/grant commands. Production `apps/server/src` has zero `.rescope(` calls. There is therefore no revoke writer to mutate or replica event to drive; the protocol mechanism cannot prove the missing policy command. |
| 5. Live delegation | **FAIL** | Production search finds `onBehalfOfFor` only on the `DelegationIndex` interface, with zero implementation passed at resolver call sites. Those sites supply only `parentSessionOf`; the human root therefore falls back to `FIRST_ADMIN_USER_ID`. A real mid-flight human-rights revocation has no constructible production subject and was not claimed. |
| 6. Machine verbs fail closed | **FAIL (mechanism partial)** | M6 breaks the real derived fleet gate and gets one finding. Production mail still calls bare `mailPolicy()`, installing `SINGLE_USER_MACHINE_ACCESS` (`mayUse: () => true`). With no second authenticated human, the required spawn/PTY/harness/file/worktree and local-daemon M4 probes have no production subject and were not claimed. |
| 7. Existence oracle | **FAIL (port partial)** | Injected child tests cover byte equality, but production `relay.ts:1205` calls bare `mailPolicy()`, which installs `SINGLE_USER_CEILING`; an invisible issue cannot be represented on the shipped path. The caller-visible/audit-visible pair was therefore not executable in production and is not claimed. |
| 8. Telegram resolves or refuses | **PASS for D22.1/D22.2** | M7 removes the real shared-entry resolver and gets one finding. M8 installs an actual first-admin fallback and continues; the audit gets exactly two findings. Both restore to hash `58a2d6be`. POD-1080 supplies the running-object landing evidence and claim-code ceremony. D22.3 remains POD-1209 and contributes to item 10's failure. |
| 9. System vs creator-attributed writes | **FAIL** | Production search finds exactly one `systemPrincipal(` occurrence: its definition, and zero callers. The real `automations` and `automation_runs` table blocks contain no owner, creator, actor or on-behalf-of column. No steward/expiry/boot or creator-current-rights probe exists to execute, so none is claimed. |
| 10. Superagent and per-user state | **FAIL** | The four superagent tables have no owner/user column and store reads are unscoped. M11 proves the per-user accessor detector by changing real `setPin(userId, …)` and getting exactly one finding; POD-1076/POD-1213's half holds, but the required superagent half is absent. |
| 11. Single-user parity | **PASS on attributable landing evidence** | POD-314/POD-315/POD-316 evidence plus POD-1246/POD-1273's same-candidate 9,138-test landing lane. The new local umbrella run is recorded separately in §1 and is not relabelled green; its one persistent isolated red is POD-1184's daemon timing test, not a parity assertion. |
| 12. Not multi-tenancy | **PASS** | M12 adds `instance_id` to the real `users` table; the audit moves `instance-partitions` 0 → 1 and names the column. After hash restoration it returns to the exact 31-item/197-site baseline. Existing runtime `instanceId` references remain ADR 1 D5 deployment identity, not a row-level tenant dimension. |
| 13. Open questions recorded | **PARTIAL / gate remains refused** | ADR 3 Amendment 1 and the readiness record retain the existence, graph-edge, reparent, inheritance, sharing-authority, and dead-letter disclosure questions. The Phase-3 ledger had not recorded the gate boundary or the child partials until this run; this report and the appended ledger entry now do. No permissive answer is inferred from a default. |

## 6. Process and scheduler close-out

- All pre-existing Phase-3 children are closed and their sessions are hibernated.
- The gate worktree was aligned to the current integration candidate and was clean before
  this evidence/doc delta.
- Dependency resolution is environment-neutral: dependencies live in this worktree, the
  expected-revision identity probe passed 141/141, and no other checkout or live `main`
  runtime was used. The real browser used the isolated repository harness.
- POD-1283 remains open for production policy completion. POD-1287 is the blocking child
  created from the real dead-letter runtime failure. This gate remains `in_progress`.
- Phase 4 and Phase 6 must remain blocked. POD-290 may not close.

## 7. Acceptance-criteria disposition

- [x] Every pre-existing Phase-3 child is closed and its attributable landing evidence is
  named; child partials are not relabelled as passes.
- [ ] Every item 1–9 production probe executed. Items 1, 2 and 8 have direct real-tree
  evidence; item 6's fleet mechanism has direct evidence. Items 3–5, 7 and 9 have no
  production subject capable of representing the required case, and item 6 cannot represent
  the freshly authenticated non-owner. This criterion is **not met**.
- [x] Items 10–13 were checked from child evidence and current source; M11 and M12 add
  direct counterfactual evidence for per-user keying and the no-multi-tenancy fence.
- [x] Environment-neutrality and process checks are complete. Worktree identity, focused
  Vitest, the build prerequisites and the isolated Playwright harness were measured locally;
  no other checkout or live-main runtime was borrowed.
- [x] Ledger and as-built are updated.
- [ ] Gate unblocks Phase 4/6 and POD-290. It does not: POD-1283 and POD-1287 block this issue.

## 8. Required rerun after POD-1283 and POD-1287

At a new candidate SHA, retain current landing evidence only when attributed to that same
SHA. Then rerun the source counterfactuals and exercise items 3–10 on production paths:
two authenticated users, all four transports, share/revoke with replica eviction, live
delegation revocation, all machine execution surfaces, invisible mail target, unbound
Telegram, actual system jobs, creator-rights automation, owned superagent state, and the
real browser dead-letter recovery flow, including visibility across reload and durable
discard. Both router mutation count and
`router-triple-access` must be zero.
