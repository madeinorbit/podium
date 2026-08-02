#!/usr/bin/env bash
# PASS A — close 63 duplicates / done / withdrawn / stale
# Generated 2026-08-02 from docs/triage/2026-08-02-proposed-lane-triage.md
#
# RUN AS OPERATOR — proposed-lane lifecycle moves are operator-only
# (apps/server/src/modules/issues/registry.ts:57, spec SP-6144):
#
#     env -u PODIUM_ISSUE_RELAY bash pass-a-close-duplicates.sh
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

# POD-229 Restart the 9 long-lived grok sessions to release ~1.05M inotify watches — One-off restart from 2026-07-09; long overtaken.
run podium issue close POD-229 --reason wontfix --note 'stale ops task'

# POD-465 Broken test on main: issue-authz registry action classification
run podium issue duplicate POD-465 POD-457

# POD-513 Runtime applier + store wiring — Empty drizzle-migration sub-task, superseded by the shipped drizzle-kit adoption.
run podium issue close POD-513 --reason wontfix --note 'stale'

# POD-514 Drizzle schema-as-code + baseline — Same.
run podium issue close POD-514 --reason wontfix --note 'stale'

# POD-515 Migration tests ported to drizzle — Same.
run podium issue close POD-515 --reason wontfix --note 'stale'

# POD-516 migration:new + CI drizzle-kit check — Same.
run podium issue close POD-516 --reason wontfix --note 'stale'

# POD-525 Bug: issueRegistry setLabels action mismatch
run podium issue duplicate POD-525 POD-457

# POD-578 Bug: issue registry classification pin drift
run podium issue duplicate POD-578 POD-457

# POD-675 Tiny-chunk tailer test failure
run podium issue duplicate POD-675 POD-668

# POD-690 Bug: main typecheck fails in abduco.test — abduco.test 4-arg typecheck error from 2026-07-16; almost certainly long fixed.
run podium issue close POD-690 --reason wontfix --note 'verify fixed'

# POD-717 Shared bundle-base helper after handoff refactors — Same title already tracked properly.
run podium issue duplicate POD-717 POD-718

# POD-800 podium auth mint-session for test agents
run podium issue duplicate POD-800 POD-801

# POD-802 Replica byte-identity skip never matches
run podium issue duplicate POD-802 POD-803

# POD-870 Blocking session send parity
run podium issue duplicate POD-870 POD-871

# POD-876 Bug: prime title assertion
run podium issue duplicate POD-876 POD-743

# POD-916 Bug: finished-child notices refire
run podium issue duplicate POD-916 POD-918

# POD-936 Upstream write coverage drift
run podium issue duplicate POD-936 POD-914

# POD-962 Managed spawn harness drift
run podium issue duplicate POD-962 POD-961

# POD-993 Bug: Stop forwarding coverage — Adds the issues.stop facet — fold the detail in before closing.
run podium issue duplicate POD-993 POD-914

# POD-994 Bug: Outbox wake assertions
run podium issue duplicate POD-994 POD-1048

# POD-1006 Bug: router coverage drift
run podium issue duplicate POD-1006 POD-914

# POD-1007 Bug: relay wake tests
run podium issue duplicate POD-1007 POD-1048

# POD-1008 Bug: web main tests — Also restates #1238 RepoScanFlow.
run podium issue duplicate POD-1008 POD-928

# POD-1014 probe: agent top-level lands proposed — Description literally reads "delete me".
run podium issue close POD-1014 --reason wontfix --note 'probe garbage'

# POD-1022 Bug: multi-instance spawn lane
run podium issue duplicate POD-1022 POD-961

# POD-1023 Bug: queued wake timing
run podium issue duplicate POD-1023 POD-1048

# POD-1024 Bug: managed spawn harness
run podium issue duplicate POD-1024 POD-961

# POD-1025 Bug: outbox wake tests
run podium issue duplicate POD-1025 POD-1048

# POD-1026 Bug: Outbox wake timing
run podium issue duplicate POD-1026 POD-1048

# POD-1037 Bug: outbox wake timing
run podium issue duplicate POD-1037 POD-1048

# POD-1038 Bug: feature boundary exception
run podium issue duplicate POD-1038 POD-928

# POD-1040 Outbox and spawn regressions
run podium issue duplicate POD-1040 POD-1048

# POD-1047 Bug: outbox wake timing
run podium issue duplicate POD-1047 POD-1048

# POD-1065 Bug: server status stale
run podium issue duplicate POD-1065 POD-1328

# POD-1083 Tests Exclude Review Worktrees
run podium issue duplicate POD-1083 POD-1054

# POD-1094 Review worktrees enter tests
run podium issue duplicate POD-1094 POD-1054

# POD-1097 Withdrawn: stale service worker theory
run podium issue close POD-1097 --reason wontfix --note 'withdrawn by its author'

# POD-1098 Review worktrees pollute test and lint lanes
run podium issue duplicate POD-1098 POD-1054

# POD-1100 Bug: sessions service imports agent-bridge
run podium issue duplicate POD-1100 POD-740

# POD-1103 Bug: boundaries gate red on integration
run podium issue duplicate POD-1103 POD-1105

# POD-1104 Bug: NUL byte in client engine source (already fixed) — Self-declared.
run podium issue close POD-1104 --reason wontfix --note 'already fixed by 3d31eee7'

# POD-1120 Bug: scripts/ has no typecheck gate
run podium issue duplicate POD-1120 POD-1122

# POD-1136 Auto-archive precondition reads per-user state
run podium issue duplicate POD-1136 POD-1229

# POD-1177 Bug: installer PATH test breaks on sudo banner
run podium issue duplicate POD-1177 POD-1132

# POD-1178 Daemon composer-sync PTY smoke is red
run podium issue duplicate POD-1178 POD-1157

# POD-1184 Daemon reconnect tests flake under load
run podium issue duplicate POD-1184 POD-1294

# POD-1194 Matrix coverage sweep: 14 unclassified classes
run podium issue duplicate POD-1194 POD-1211

# POD-1198 Scripts directory typechecked by nothing
run podium issue duplicate POD-1198 POD-1122

# POD-1219 scripts/ excluded from every typecheck lane — Self-declared duplicate.
run podium issue duplicate POD-1219 POD-1122

# POD-1222 Audit scripts sit outside the typecheck gate
run podium issue duplicate POD-1222 POD-1122

# POD-1225 Bug: keyboard-fidelity suite skips itself under load
run podium issue duplicate POD-1225 POD-1126

# POD-1237 Bug: shell banner breaks install PATH check
run podium issue duplicate POD-1237 POD-1132

# POD-1266 Feed identity one-row constraint
run podium issue duplicate POD-1266 POD-1292

# POD-1267 Remove the dead feed table
run podium issue duplicate POD-1267 POD-1293

# POD-1290 Bug: browser lane mobile bundle
run podium issue duplicate POD-1290 POD-1295

# POD-1300 Bug: worktree mobile build bypass
run podium issue duplicate POD-1300 POD-1299

# POD-1302 Relay suite stale import
run podium issue duplicate POD-1302 POD-1234

# POD-1308 Normalized-wire load timeouts
run podium issue duplicate POD-1308 POD-1301

# POD-1312 Claude brevity smoke
run podium issue duplicate POD-1312 POD-1311

# POD-1322 Bug: steward cursor spy recursion
run podium issue duplicate POD-1322 POD-1318

# POD-1323 Bug: normalized wire timeout
run podium issue duplicate POD-1323 POD-1301

# POD-1327 Steward cursor spy recursion
run podium issue duplicate POD-1327 POD-1318

# POD-1362 Daemon lifecycle boundary drift
run podium issue duplicate POD-1362 POD-1321

