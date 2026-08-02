#!/usr/bin/env bash
# PASS C — re-home 98 rewrite issues under their POD-279 bucket
# Generated 2026-08-02 from docs/triage/2026-08-02-proposed-lane-triage.md
#
# RUN AS OPERATOR — proposed-lane lifecycle moves are operator-only
# (apps/server/src/modules/issues/registry.ts:57, spec SP-6144):
#
#     env -u PODIUM_ISSUE_RELAY bash pass-c-rehome-p1.sh
#
# Every line is independent. Delete any you disagree with. Nothing is deleted:
# 'duplicate' closes with reason=duplicate + a duplicateOf link; 'close' is reversible.
#
# NOTE ON ORDER: 'promote' (proposed -> backlog) must precede 'reparent'. Reparenting
# alone leaves stage=proposed, and isInProposedSubtree (service/crud.ts:854) treats an
# issue with ANY proposed ancestor as inert — so a proposed child of a live phase would
# still never appear in 'podium issue ready'.
set -u
run() { echo "+ $*"; "$@" || echo "  !! FAILED: $*"; }


# ======== #1349 lanes  (44) ========
# POD-452 Replace fixed sleeps and repeated process setup in PTY integration tests — Fixed sleeps + repeated process setup in PTY integration tests.
run podium issue promote POD-452
run podium issue reparent POD-452 --parent-id POD-1349

# POD-453 Repair skipped and brittle low-signal tests — Skipped/brittle low-signal tests.
run podium issue promote POD-453
run podium issue reparent POD-453 --parent-id POD-1349

# POD-563 Hermetic browser E2E — Hermetic browser E2E — the root of most browser-lane pain.
run podium issue promote POD-563
run podium issue reparent POD-563 --parent-id POD-1349

# POD-631 Browser harness Bun runtime — Browser harness must run under Bun.
run podium issue promote POD-631
run podium issue reparent POD-631 --parent-id POD-1349

# POD-668 Bug: transcript tailer timing — CANONICAL tailer timing flake.
run podium issue promote POD-668
run podium issue reparent POD-668 --parent-id POD-1349

# POD-670 Ephemeral daemon relay tests — Integration lane collides with the live daemon relay port.
run podium issue promote POD-670
run podium issue reparent POD-670 --parent-id POD-1349

# POD-764 Bug: upstream-e2e flaky under load — upstream-e2e load flake.
run podium issue promote POD-764
run podium issue reparent POD-764 --parent-id POD-1349

# POD-914 Bug: coordinator forwarding coverage — CANONICAL of the upstream-issues forwarded-coverage cluster.
run podium issue promote POD-914
run podium issue reparent POD-914 --parent-id POD-1349

# POD-961 Bug: managed spawn fixture — CANONICAL managed-account-spawn fixture drift.
run podium issue promote POD-961
run podium issue reparent POD-961 --parent-id POD-1349

# POD-1003 Hibernation default assertion — store.test hibernation default assertion red on main.
run podium issue promote POD-1003
run podium issue reparent POD-1003 --parent-id POD-1349

# POD-1027 Bug: Web store mocks stale — Web store mocks miss normalized replica hooks.
run podium issue promote POD-1027
run podium issue reparent POD-1027 --parent-id POD-1349

# POD-1039 Bug: mobile tools assertion — Mobile shell structure test expects a removed AppToolsRow.
run podium issue promote POD-1039
run podium issue reparent POD-1039 --parent-id POD-1349

# POD-1048 Bug: outbox wake timing — CANONICAL of the 9-issue outbox-wake-timing cluster (richest brief).
run podium issue promote POD-1048
run podium issue reparent POD-1048 --parent-id POD-1349

# POD-1054 Bug: Nested checkout collection — CANONICAL: nested review worktrees collected by test/lint lanes.
run podium issue promote POD-1054
run podium issue reparent POD-1054 --parent-id POD-1349

# POD-1101 Bug: Transcript index teardown — Transcript index teardown closes the DB mid-callback.
run podium issue promote POD-1101
run podium issue reparent POD-1101 --parent-id POD-1349

# POD-1121 Bug: bun-lane spawn fake missing durableLabelFor — Bun-lane spawn fake missing durableLabelFor.
run podium issue promote POD-1121
run podium issue reparent POD-1121 --parent-id POD-1349

# POD-1126 Keyboard-fidelity hook timeout — CANONICAL keyboard-fidelity setup-hook timeout (silently skips 13 cases).
run podium issue promote POD-1126
run podium issue reparent POD-1126 --parent-id POD-1349

# POD-1132 Bug: install-sh probe reads shell banner — CANONICAL install-sh shell-banner probe.
run podium issue promote POD-1132
run podium issue reparent POD-1132 --parent-id POD-1349

# POD-1140 Ladder loops wedge the test runner — Replica ladder loops wedge the runner — a hang instead of a failure.
run podium issue promote POD-1140
run podium issue reparent POD-1140 --parent-id POD-1349

# POD-1152 Expo launcher assertion drift — Expo launcher brittle text assertion.
run podium issue promote POD-1152
run podium issue reparent POD-1152 --parent-id POD-1349

# POD-1155 Harness teardown database noise — Harness teardown DB noise. Same family as #1101/#1298.
run podium issue promote POD-1155
run podium issue reparent POD-1155 --parent-id POD-1349

# POD-1173 Stale agent-bridge imports in e2e harness — Stale agent-bridge imports in the e2e harness; 3 more files will break the same way.
run podium issue promote POD-1173
run podium issue reparent POD-1173 --parent-id POD-1349

# POD-1176 Bug: PTY smoke race — Real-PTY composer smoke race. Same family as #1157.
run podium issue promote POD-1176
run podium issue reparent POD-1176 --parent-id POD-1349

# POD-1183 Bug: wsServer auth test flakes under load — wsServer auth test fixed-wait flake.
run podium issue promote POD-1183
run podium issue reparent POD-1183 --parent-id POD-1349

# POD-1201 Bug: connectivity state flakes — Daemon connectivity-state starvation flake.
run podium issue promote POD-1201
run podium issue reparent POD-1201 --parent-id POD-1349

# POD-1204 Bug: stale experimental settings e2e locator — Experimental-settings e2e locator matches 11 elements.
run podium issue promote POD-1204
run podium issue reparent POD-1204 --parent-id POD-1349

# POD-1205 Bug: grok catalog e2e expects absent model — Grok catalog e2e expects a model this host does not probe.
run podium issue promote POD-1205
run podium issue reparent POD-1205 --parent-id POD-1349

# POD-1206 Bug: janitor recovery test fails — Janitor recovery test fails every run, including pre-merge.
run podium issue promote POD-1206
run podium issue reparent POD-1206 --parent-id POD-1349

# POD-1233 Bug: harness segfaults mid browser run — Harness segfaults mid browser run; everything after reports a connection error.
run podium issue promote POD-1233
run podium issue reparent POD-1233 --parent-id POD-1349

# POD-1234 Bug: relay browser suite cannot load — CANONICAL: a browser spec cannot load because a helper imports a deleted module.
run podium issue promote POD-1234
run podium issue reparent POD-1234 --parent-id POD-1349

# POD-1235 Retracted: secrets checks were a harness artifact — Title says retracted, but the residual is real: the secrets guarantee is unverified.
run podium issue promote POD-1235
run podium issue reparent POD-1235 --parent-id POD-1349

# POD-1238 Bug: RepoScanFlow machine test flakes under load — RepoScanFlow machine test load flake.
run podium issue promote POD-1238
run podium issue reparent POD-1238 --parent-id POD-1349

# POD-1240 Bug: experimental settings spec drives a dead Save button — Experimental-settings spec clicks a Save button the app no longer has.
run podium issue promote POD-1240
run podium issue reparent POD-1240 --parent-id POD-1349

# POD-1242 Bug: eight browser specs click a renamed nav button — Eight browser specs still click the pre-rename Issues nav. Spotted 2 weeks ago; nothing ran them.
run podium issue promote POD-1242
run podium issue reparent POD-1242 --parent-id POD-1349

# POD-1243 Bug: load test flakes under fan-out — Wall-clock load test flakes under fan-out.
run podium issue promote POD-1243
run podium issue reparent POD-1243 --parent-id POD-1349

# POD-1297 Audit timeout under load — Architecture-audit CLI times out under contention.
run podium issue promote POD-1297
run podium issue reparent POD-1297 --parent-id POD-1349

# POD-1298 Bug: Restart mirror after close — Restart leaves the transcript mirror on a closed DB. Family of #1101/#1155.
run podium issue promote POD-1298
run podium issue reparent POD-1298 --parent-id POD-1349

# POD-1299 Bug: worktree mobile build bypass — CANONICAL: browser E2E builds the mobile bundle from main, not the worktree. Tests stale code.
run podium issue promote POD-1299
run podium issue reparent POD-1299 --parent-id POD-1349

# POD-1301 Bug: normalized-wire test timeout — CANONICAL normalized-wire timeout under load.
run podium issue promote POD-1301
run podium issue reparent POD-1301 --parent-id POD-1349

# POD-1304 VMI test host provisioning — VMI test host needs a reproducible toolchain.
run podium issue promote POD-1304
run podium issue reparent POD-1304 --parent-id POD-1349

# POD-1306 Bug: Bun unit-runner segfault — Bun 1.3.14 unit-runner segfault — no reliable repo-wide result.
run podium issue promote POD-1306
run podium issue reparent POD-1306 --parent-id POD-1349

# POD-1307 Durable-session reap timeout — Durable-session reap test deadline under starvation.
run podium issue promote POD-1307
run podium issue reparent POD-1307 --parent-id POD-1349

# POD-1311 Claude brevity smoke — CANONICAL: real-Claude brevity smoke rejects a compliant answer.
run podium issue promote POD-1311
run podium issue reparent POD-1311 --parent-id POD-1349

# POD-1363 Bug: rearch-audit baseline test times out under lane load — rearch-audit baseline test times out under lane load AND plants a marker in the SHARED baseline file, restored in a finally — a killed lane leaves it in the tree. Probe against a temp copy.
run podium issue promote POD-1363
run podium issue reparent POD-1363 --parent-id POD-1349


# ======== #1348 gates  (17) ========
# POD-457 Fix issue authorization action-classification regression — CANONICAL of the issue-authz manage/write classification cluster.
run podium issue promote POD-457
run podium issue reparent POD-457 --parent-id POD-1348

# POD-700 Bug: settings imports experimental feature — settings -> experimental feature-boundary violation (distinct from #928).
run podium issue promote POD-700
run podium issue reparent POD-700 --parent-id POD-1348

# POD-755 Bug: import regex swallows the next import — IMPORT_RE swallows the next import — the manifest gate inherits the miss.
run podium issue promote POD-755
run podium issue reparent POD-755 --parent-id POD-1348

# POD-849 Bug: apps/web/test excluded from typecheck — apps/web/test excluded from typecheck. Same family as #1122.
run podium issue promote POD-849
run podium issue reparent POD-849 --parent-id POD-1348

# POD-928 Settings machines boundary violation — CANONICAL settings -> machines boundary violation.
run podium issue promote POD-928
run podium issue reparent POD-928 --parent-id POD-1348

# POD-1124 Model L0 leans on Node globals — packages/model L0 purity claim is unenforced — its tsconfig pulls Node globals.
run podium issue promote POD-1124
run podium issue reparent POD-1124 --parent-id POD-1348

# POD-1137 Session-shapes audit detector is name-listed — The session-shapes audit is name-listed — it makes a Phase-1 acceptance criterion vacuous.
run podium issue promote POD-1137
run podium issue reparent POD-1137 --parent-id POD-1348

# POD-1138 Optional keys in conditional spreads escape excess checks — Optional keys in conditional spreads escape excess-property checks.
run podium issue promote POD-1138
run podium issue reparent POD-1138 --parent-id POD-1348

# POD-1160 Per-user detector cannot see fixed shape — Per-user detector cannot tell the fix from the defect.
run podium issue promote POD-1160
run podium issue reparent POD-1160 --parent-id POD-1348

# POD-1165 Per-user detector blind to composed PerUserKey — Per-user audit blind to a composed PerUserKey — the fix reads as 4 new violations.
run podium issue promote POD-1165
run podium issue reparent POD-1165 --parent-id POD-1348

# POD-1166 No guardrail on instance_id DDL columns — No guardrail on instance_id DDL columns; the representation equivalent IS caught.
run podium issue promote POD-1166
run podium issue reparent POD-1166 --parent-id POD-1348

# POD-1180 Deletion ratchet blind to router extractions — Deletion ratchet counts one file, so extraction reads as progress. THE RATCHET LIES.
run podium issue promote POD-1180
run podium issue reparent POD-1180 --parent-id POD-1348

# POD-1207 Perf registry ownership-matrix row — Perf registry has no ownership-matrix row to grade its hand-declared class against.
run podium issue promote POD-1207
run podium issue reparent POD-1207 --parent-id POD-1348

# POD-1221 Command audits dark in CI — Nine command-audit scripts wired into package.json and never run by CI.
run podium issue promote POD-1221
run podium issue reparent POD-1221 --parent-id POD-1348

# POD-1249 Bug: seam presence checks read comments — Federation-seam audit is satisfied by a code COMMENT — it cannot detect the removal it exists for.
run podium issue promote POD-1249
run podium issue reparent POD-1249 --parent-id POD-1348

# POD-1314 Issue exposure audit mismatch — Issue command source audit disagrees with the contract and the runtime surface.
run podium issue promote POD-1314
run podium issue reparent POD-1314 --parent-id POD-1348

# POD-1321 Bug: lifecycle boundary allowlist — Boundary allowlist entry left on a deleted source path.
run podium issue promote POD-1321
run podium issue reparent POD-1321 --parent-id POD-1348


# ======== #289 Phase 2  (8) ========
# POD-785 Bug: outbox localStorage quota exceeded — Client outbox localStorage quota. Same defect family as #1231; merge.
run podium issue promote POD-785
run podium issue reparent POD-785 --parent-id POD-289

# POD-806 podium db restore verb — ADR 2 D1 requires restore to re-mint the epoch; mechanism shipped, CLI dispatch missing.
run podium issue promote POD-806
run podium issue reparent POD-806 --parent-id POD-289

# POD-1161 Aborted bootstrap install drops buffered frames — Aborted bootstrap install drops buffered frames.
run podium issue promote POD-1161
run podium issue reparent POD-1161 --parent-id POD-289

# POD-1163 Refused commit wedges the replica permanently — Refused commit wedges the replica permanently. Verify whether already fixed.
run podium issue promote POD-1163
run podium issue reparent POD-1163 --parent-id POD-289

# POD-1191 Entity revision column and assignment — THE LAST UNBUILT PIECE of the sync conflict story — no code assigns the revision it arbitrates on.
run podium issue promote POD-1191
run podium issue reparent POD-1191 --parent-id POD-289

# POD-1231 Bug: kernel replica outbox loses writes silently — CRITICAL: kernel replica outbox in a localStorage JSON blob, silently discards failed writes. ADR forbids both.
run podium issue promote POD-1231
run podium issue reparent POD-1231 --parent-id POD-289

# POD-1232 Client write path on the kernel Outbox — Clients still queue through the OLD outbox, not the kernel Outbox.
run podium issue promote POD-1232
run podium issue reparent POD-1232 --parent-id POD-289

# POD-1244 Bug: second tab does not converge on the kernel replica — Second tab never converges on the kernel replica. REGRESSION vs the old read path.
run podium issue promote POD-1244
run podium issue reparent POD-1244 --parent-id POD-289


# ======== #291 Phase 4  (5) ========
# POD-1123 Machine-keyed model catalog — Model catalog cached instance-wide, not per machine. Multi-user prerequisite.
run podium issue promote POD-1123
run podium issue reparent POD-1123 --parent-id POD-291

# POD-1134 Routing keys concatenate unescaped parts — Plane routing keys concatenate unescaped parts; second loose entity-ref type.
run podium issue promote POD-1134
run podium issue reparent POD-1134 --parent-id POD-291

# POD-1143 Agent identity conflated with session id — Agent identity in a session-named field. Same family as #1164.
run podium issue promote POD-1143
run podium issue reparent POD-1143 --parent-id POD-291

# POD-1164 Capability.actorSessionId id-space conflict — Capability.actorSessionId id-space conflict.
run podium issue promote POD-1164
run podium issue reparent POD-1164 --parent-id POD-291

# POD-1175 RPC replies unbound from answering machine — RPC replies matched by id alone — a reply from one machine can settle another machine request.
run podium issue promote POD-1175
run podium issue reparent POD-1175 --parent-id POD-291


# ======== #1347 catch-up  (2) ========
# POD-1144 Issue blockedBy holds branch names — blockedBy typed as issue ids, column holds branch names.
run podium issue promote POD-1144
run podium issue reparent POD-1144 --parent-id POD-1347

# POD-1247 Issue mutations on the arbitration engine — Issue mutations onto the shared arbitration engine (two mechanisms today).
run podium issue promote POD-1247
run podium issue reparent POD-1247 --parent-id POD-1347


# ======== #288 Phase 1  (2) ========
# POD-1148 Two attribution pairs, one vocabulary — Two attribution pairs, one vocabulary. Needs one naming decision.
run podium issue promote POD-1148
run podium issue reparent POD-1148 --parent-id POD-288

# POD-1156 One shape for stamped attribution — One shape for stamped attribution — the fix for #1148.
run podium issue promote POD-1156
run podium issue reparent POD-1156 --parent-id POD-288


# ======== #290 Phase 3 (#315)  (2) ========
# POD-1179 sessions.ask lost its machine-use gate — sessions.ask lost its machine-use gate when the duplicate contract was deleted.
run podium issue promote POD-1179
run podium issue reparent POD-1179 --parent-id POD-290

# POD-1193 Wake path machine-use gate — Wake path declares machine use but nothing enforces it at delivery.
run podium issue promote POD-1193
run podium issue reparent POD-1193 --parent-id POD-290


# ======== #290 Phase 3  (2) ========
# POD-1230 Perf traces without a principal — Perf traces cannot name a principal; the ring leaks across principals once a second exists.
run podium issue promote POD-1230
run podium issue reparent POD-1230 --parent-id POD-290

# POD-1250 Conflict class required on every contract — Make the conflict class mandatory on every command contract.
run podium issue promote POD-1250
run podium issue reparent POD-1250 --parent-id POD-290


# ======== #294 Phase 7 (#335)  (1) ========
# POD-745 Telemetry subpath browser-safety gap — Generalise rule 8a from @podium/runtime to every neutral-tagged workspace.
run podium issue promote POD-745
run podium issue reparent POD-745 --parent-id POD-294


# ======== #294 Phase 7 (#336 docs)  (1) ========
# POD-770 Bug: change retention spec says 14d, ships 3d — Retention spec says 14d, ships 3d. ADR 2 decided code is right; doc correction.
run podium issue promote POD-770
run podium issue reparent POD-770 --parent-id POD-294


# ======== #294 Phase 7  (1) ========
# POD-1102 Recorded deletion debt from main — 19 new deletion-debt instances baselined; each phase still owes its category.
run podium issue promote POD-1102
run podium issue reparent POD-1102 --parent-id POD-294


# ======== #291 Phase 4 (#645/#1079)  (1) ========
# POD-1114 Pairing durability across server data loss — Server data loss permanently orphans a remote daemon. Identity-model defect.
run podium issue promote POD-1114
run podium issue reparent POD-1114 --parent-id POD-291


# ======== #291 Phase 4 (#1079)  (1) ========
# POD-1125 Pair code can rebind an existing machine — SECURITY: a pair code can rebind an existing machine.
run podium issue promote POD-1125
run podium issue reparent POD-1125 --parent-id POD-291


# ======== #288 Phase 1 (decision)  (1) ========
# POD-1127 Workflow wires: entity or RPC read model — Are workflows replicated? The answer decides where their wire types live.
run podium issue promote POD-1127
run podium issue reparent POD-1127 --parent-id POD-288


# ======== #289 Phase 2 (#373)  (1) ========
# POD-1130 Outbox conformance fake fidelity — Outbox conformance fakes carry the residual risk; 5 of 5 defects were in the fakes.
run podium issue promote POD-1130
run podium issue reparent POD-1130 --parent-id POD-289


# ======== #292 Phase 5 (#397)  (1) ========
# POD-1131 Bug: harness model dependency undeclared — packages/harness imports model without declaring it.
run podium issue promote POD-1131
run podium issue reparent POD-1131 --parent-id POD-292


# ======== #288 Phase 1 (#1141)  (1) ========
# POD-1147 Issue storage row from shared fields — Issue storage row still hand-written — Phase 1 audit-zero depends on it.
run podium issue promote POD-1147
run podium issue reparent POD-1147 --parent-id POD-288


# ======== #291 Phase 4 (#1075)  (1) ========
# POD-1172 Sole-human identity fork — Two constants name the single pre-accounts human and disagree. Blocks ownership checks.
run podium issue promote POD-1172
run podium issue reparent POD-1172 --parent-id POD-291


# ======== #289 Phase 2 (#374)  (1) ========
# POD-1195 Web bundle reach for sync adapters — The web bundle cannot reach the IndexedDB adapter — manifest classes it server-only.
run podium issue promote POD-1195
run podium issue reparent POD-1195 --parent-id POD-289


# ======== #289 Phase 2 (#1077)  (1) ========
# POD-1196 One vocabulary for principal and scoped change — Two vocabularies for principal/scoped change across planes and sync.
run podium issue promote POD-1196
run podium issue reparent POD-1196 --parent-id POD-289


# ======== #289 Phase 2 (#308)  (1) ========
# POD-1208 Publication worker speaks the old wire — Publication worker still speaks the pre-cutover wire. Mixed dialects on one connection.
run podium issue promote POD-1208
run podium issue reparent POD-1208 --parent-id POD-289


# ======== #290 Phase 3 (#1080)  (1) ========
# POD-1209 Superagent acts as the bound user — Superagent acts without knowing whose behalf. Multi-user prerequisite.
run podium issue promote POD-1209
run podium issue reparent POD-1209 --parent-id POD-290


# ======== #289 Phase 2 (#378)  (1) ========
# POD-1245 TanStack adapter and dependency removal — TanStack removal itself; blocked by #1220.
run podium issue promote POD-1245
run podium issue reparent POD-1245 --parent-id POD-289


# ======== #292 Phase 5 (#324)  (1) ========
# POD-1284 Bug: ambiguous Geometry export — Ambiguous Geometry export breaks repo typecheck. Verify — may already be fixed.
run podium issue promote POD-1284
run podium issue reparent POD-1284 --parent-id POD-292


# ======== #291 Phase 4 (#1315)  (1) ========
# POD-1344 Caller identity through the git-workflow plane — git-workflow plane comments cannot name the human who ran the action.
run podium issue promote POD-1344
run podium issue reparent POD-1344 --parent-id POD-291

