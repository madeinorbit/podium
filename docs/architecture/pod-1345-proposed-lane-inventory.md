# POD-279 Proposed-lane inventory (103 issues)

Companion to `pod-1345-tree-audit.md` §4. Generated 2026-08-02 from `podium issue deps 279`.
Every row is an issue in the **Proposed** lane that was discovered from inside the POD-279 tree.
Agents can neither work, close, nor reparent these — an operator must triage them.

`from` names the epic issue whose agent filed it.

| Issue | From | Title |
|---|---|---|
| POD-353 | 279/related | Deferred: hub/node federation — design + product work (post-rewrite) |
| POD-428 | 279/discovered-from | Issue CLI: create/update support dedicated acceptance criteria |
| POD-745 | 296/discovered-from | Telemetry subpath browser-safety gap |
| POD-755 | 296/discovered-from | Bug: import regex swallows the next import |
| POD-764 | 297/discovered-from | Bug: upstream-e2e flaky under load |
| POD-770 | 748/discovered-from | Bug: change retention spec says 14d, ships 3d |
| POD-772 | 279/related,308/related | Architecture cleanup ledger |
| POD-1067 | 279/discovered-from | Multi-user ownership and sharing |
| POD-1102 | 861/discovered-from | Recorded deletion debt from main |
| POD-1103 | 861/discovered-from | Bug: boundaries gate red on integration |
| POD-1104 | 364/discovered-from | Bug: NUL byte in client engine source (already fixed) |
| POD-1106 | 730/discovered-from | Forked workflows record no lineage |
| POD-1107 | 360/discovered-from | Spawn tuple has five restatements that disagree |
| POD-1108 | 730/discovered-from | Retry un-skips a skipped step |
| POD-1109 | 730/discovered-from | Workflow event log has no reader |
| POD-1110 | 730/discovered-from | Duplicate workflow name leaks a SQLite error |
| POD-1111 | 369/discovered-from | Bug: full disk silently truncates writes |
| POD-1112 | 1105/discovered-from | Dev machine disk exhaustion |
| POD-1114 | 733/discovered-from | Pairing durability across server data loss |
| POD-1120 | 369/discovered-from | Bug: scripts/ has no typecheck gate |
| POD-1121 | 396/discovered-from | Bug: bun-lane spawn fake missing durableLabelFor |
| POD-1123 | 397/discovered-from | Machine-keyed model catalog |
| POD-1124 | 300/discovered-from | Model L0 leans on Node globals |
| POD-1125 | 388/discovered-from | Pair code can rebind an existing machine |
| POD-1126 | 1105/discovered-from | Keyboard-fidelity hook timeout |
| POD-1127 | 300/discovered-from | Workflow wires: entity or RPC read model |
| POD-1128 | 379/discovered-from | Relay allowlist blocks the session seance |
| POD-1130 | 370/discovered-from | Outbox conformance fake fidelity |
| POD-1131 | 304/discovered-from | Bug: harness model dependency undeclared |
| POD-1132 | 303/discovered-from | Bug: install-sh probe reads shell banner |
| POD-1133 | 361/discovered-from | Shared spawnedBy constructor and parser |
| POD-1134 | 361/discovered-from | Routing keys concatenate unescaped parts |
| POD-1136 | 367/discovered-from | Auto-archive precondition reads per-user state |
| POD-1137 | 366/discovered-from | Session-shapes audit detector is name-listed |
| POD-1138 | 367/discovered-from | Optional keys in conditional spreads escape excess checks |
| POD-1139 | 367/discovered-from | Redeploy drops queued mail delivery triggers |
| POD-1140 | 369/discovered-from | Ladder loops wedge the test runner |
| POD-1142 | 643/discovered-from | Handoff manifest format 2: attribution pair |
| POD-1144 | 362/discovered-from | Issue blockedBy holds branch names |
| POD-1145 | 362/discovered-from | Session registry map keyed by raw string |
| POD-1147 | 1141/discovered-from | Issue storage row from shared fields |
| POD-1148 | 368/discovered-from | Two attribution pairs, one vocabulary |
| POD-1156 | 1153/discovered-from | One shape for stamped attribution |
| POD-1160 | 380/discovered-from | Per-user detector cannot see fixed shape |
| POD-1161 | 373/discovered-from | Aborted bootstrap install drops buffered frames |
| POD-1163 | 373/discovered-from | Refused commit wedges the replica permanently |
| POD-1164 | 362/discovered-from | Capability.actorSessionId id-space conflict |
| POD-1165 | 1162/discovered-from | Per-user detector blind to composed PerUserKey |
| POD-1166 | 1162/discovered-from | No guardrail on instance_id DDL columns |
| POD-1171 | 362/discovered-from | Workspace fetch borrows the handoff sessionId param |
| POD-1172 | 351/discovered-from | Sole-human identity fork |
| POD-1173 | 382/discovered-from | Stale agent-bridge imports in e2e harness |
| POD-1175 | 389/discovered-from | RPC replies unbound from answering machine |
| POD-1177 | 279/discovered-from | Bug: installer PATH test breaks on sudo banner |
| POD-1183 | 362/discovered-from | Bug: wsServer auth test flakes under load |
| POD-1191 | 306/discovered-from | Entity revision column and assignment |
| POD-1192 | 363/discovered-from | Branded ids across the client API mirror |
| POD-1193 | 640/discovered-from | Wake path machine-use gate |
| POD-1195 | 374/discovered-from | Web bundle reach for sync adapters |
| POD-1196 | 1077/discovered-from | One vocabulary for principal and scoped change |
| POD-1198 | 301/discovered-from | Scripts directory typechecked by nothing |
| POD-1199 | 301/discovered-from | Brand drizzle columns and TS id members |
| POD-1202 | 309/discovered-from | Dead hub-provenance badges in the issue panel |
| POD-1204 | 420/discovered-from | Bug: stale experimental settings e2e locator |
| POD-1205 | 420/discovered-from | Bug: grok catalog e2e expects absent model |
| POD-1207 | 314/discovered-from | Perf registry ownership-matrix row |
| POD-1208 | 1203/discovered-from | Publication worker speaks the old wire |
| POD-1209 | 1080/discovered-from | Superagent acts as the bound user |
| POD-1219 | 279/discovered-from | scripts/ excluded from every typecheck lane |
| POD-1221 | 315/discovered-from | Command audits dark in CI |
| POD-1222 | 1212/discovered-from | Audit scripts sit outside the typecheck gate |
| POD-1225 | 376/discovered-from | Bug: keyboard-fidelity suite skips itself under load |
| POD-1230 | 736/discovered-from | Perf traces without a principal |
| POD-1231 | 1220/discovered-from | Bug: kernel replica outbox loses writes silently |
| POD-1232 | 1223/discovered-from | Client write path on the kernel Outbox |
| POD-1233 | 1227/discovered-from | Bug: harness segfaults mid browser run |
| POD-1234 | 1227/discovered-from | Bug: relay browser suite cannot load |
| POD-1235 | 1227/discovered-from | Retracted: secrets checks were a harness artifact |
| POD-1237 | 378/discovered-from | Bug: shell banner breaks install PATH check |
| POD-1238 | 378/discovered-from | Bug: RepoScanFlow machine test flakes under load |
| POD-1240 | 1227/discovered-from | Bug: experimental settings spec drives a dead Save button |
| POD-1242 | 1227/discovered-from | Bug: eight browser specs click a renamed nav button |
| POD-1244 | 1223/discovered-from | Bug: second tab does not converge on the kernel replica |
| POD-1245 | 378/discovered-from,1220/blocked-by | TanStack adapter and dependency removal |
| POD-1247 | 1246/discovered-from | Issue mutations on the arbitration engine |
| POD-1249 | 310/discovered-from | Bug: seam presence checks read comments |
| POD-1250 | 1246/discovered-from | Conflict class required on every contract |
| POD-1284 | 324/discovered-from | Bug: ambiguous Geometry export |
| POD-1290 | 1287/discovered-from | Bug: browser lane mobile bundle |
| POD-1297 | 1292/discovered-from | Audit timeout under load |
| POD-1298 | 417/discovered-from | Bug: Restart mirror after close |
| POD-1302 | 1295/discovered-from | Relay suite stale import |
| POD-1304 | 1294/discovered-from | VMI test host provisioning |
| POD-1306 | 738/discovered-from | Bug: Bun unit-runner segfault |
| POD-1307 | 1294/discovered-from | Durable-session reap timeout |
| POD-1308 | 1283/discovered-from | Normalized-wire load timeouts |
| POD-1311 | 399/discovered-from | Claude brevity smoke |
| POD-1314 | 320/discovered-from | Issue exposure audit mismatch |
| POD-1321 | 323/discovered-from | Bug: lifecycle boundary allowlist |
| POD-1322 | 323/discovered-from | Bug: steward cursor spy recursion |
| POD-1323 | 323/discovered-from | Bug: normalized wire timeout |
| POD-1327 | 321/discovered-from | Steward cursor spy recursion |
| POD-1344 | 1315/discovered-from | Caller identity through the git-workflow plane |

## Not in the list above

Three more Proposed issues are stranded with no dependency edge at all, so they do not appear
in `podium issue deps 279` output and no sweep will find them:

- **POD-1266** Feed identity one-row constraint — duplicate of POD-1292 (shipped)
- **POD-1267** Remove the dead feed table — duplicate of POD-1293 (shipped)
- **POD-1243** Bug: load test flakes under fan-out — same class as POD-1294 (shipped)
