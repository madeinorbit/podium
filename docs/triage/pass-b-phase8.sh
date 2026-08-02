#!/usr/bin/env bash
# PASS B — create Phase 8 and re-home 19 cleanup issues
# Generated 2026-08-02 from docs/triage/2026-08-02-proposed-lane-triage.md
#
# RUN AS OPERATOR — proposed-lane lifecycle moves are operator-only
# (apps/server/src/modules/issues/registry.ts:57, spec SP-6144):
#
#     env -u PODIUM_ISSUE_RELAY bash pass-b-phase8.sh
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

# 1. Create the bucket as a child of POD-279. POD-772 "Architecture cleanup ledger"
#    already exists as a collector epic for exactly this; the alternative is to
#    reparent POD-772 under POD-279 and use it instead of a fresh issue.
echo "Create Phase 8 first, then paste its number below and re-run the rest."
PHASE8=${PHASE8:-}
if [ -z "$PHASE8" ]; then
  run podium issue create --title 'Phase 8 — Post-cutover cleanup' --parent-id POD-279 --type milestone \
    --description 'Rewrite-created debt that does not block a phase gate but must land before the epic closes: vocabulary completion, branded-id finishing, dead-code removal, workflow defects found during characterization.'
  echo; echo "Now: PHASE8=POD-<n> env -u PODIUM_ISSUE_RELAY bash pass-b-phase8.sh"; exit 0
fi

# POD-772 Architecture cleanup ledger — ALREADY an epic collector for exactly this. Reparent under #279 as the cleanup phase.
run podium issue promote POD-772
run podium issue reparent POD-772 --parent-id "$PHASE8"

# POD-820 Empty string is a second spelling of unassigned — ADR 4: empty string is a second spelling of unassigned. Data normalization, post-cutover.
run podium issue promote POD-820
run podium issue reparent POD-820 --parent-id "$PHASE8"

# POD-825 toWire default listSessions audit — toWire default listSessions audit. Merge with #1265.
run podium issue promote POD-825
run podium issue reparent POD-825 --parent-id "$PHASE8"

# POD-827 Hub-mirrored issues stay un-normalized — Moot while the hub stays deferred (#353). Close if federation stays deferred.
run podium issue promote POD-827
run podium issue reparent POD-827 --parent-id "$PHASE8"

# POD-1106 Forked workflows record no lineage — Forked workflows record no lineage. Land after #641 to avoid conflict.
run podium issue promote POD-1106
run podium issue reparent POD-1106 --parent-id "$PHASE8"

# POD-1107 Spawn tuple has five restatements that disagree — Spawn tuple restated 5x, two disagree. Correctness facet may deserve an earlier split.
run podium issue promote POD-1107
run podium issue reparent POD-1107 --parent-id "$PHASE8"

# POD-1108 Retry un-skips a skipped step — Retry un-skips a skipped step.
run podium issue promote POD-1108
run podium issue reparent POD-1108 --parent-id "$PHASE8"

# POD-1109 Workflow event log has no reader — Workflow event log has no reader.
run podium issue promote POD-1109
run podium issue reparent POD-1109 --parent-id "$PHASE8"

# POD-1110 Duplicate workflow name leaks a SQLite error — Duplicate workflow name leaks a raw SQLite error.
run podium issue promote POD-1110
run podium issue reparent POD-1110 --parent-id "$PHASE8"

# POD-1133 Shared spawnedBy constructor and parser — spawnedBy tag: 6 producers, 7 hand-rebuilds, 5 of them gate parenthood.
run podium issue promote POD-1133
run podium issue reparent POD-1133 --parent-id "$PHASE8"

# POD-1142 Handoff manifest format 2: attribution pair — Handoff manifest format 2 (attribution pair) — bundle format change.
run podium issue promote POD-1142
run podium issue reparent POD-1142 --parent-id "$PHASE8"

# POD-1145 Session registry map keyed by raw string — Session registry keyed by raw string. Branded-id completion.
run podium issue promote POD-1145
run podium issue reparent POD-1145 --parent-id "$PHASE8"

# POD-1171 Workspace fetch borrows the handoff sessionId param — Workspace fetch borrows the handoff sessionId param.
run podium issue promote POD-1171
run podium issue reparent POD-1171 --parent-id "$PHASE8"

# POD-1192 Branded ids across the client API mirror — Branded ids across the client API mirror (both halves must move together).
run podium issue promote POD-1192
run podium issue reparent POD-1192 --parent-id "$PHASE8"

# POD-1199 Brand drizzle columns and TS id members — Brand drizzle columns + hand-written TS id members.
run podium issue promote POD-1199
run podium issue reparent POD-1199 --parent-id "$PHASE8"

# POD-1202 Dead hub-provenance badges in the issue panel — Dead hub-provenance badges in the issue panel.
run podium issue promote POD-1202
run podium issue reparent POD-1202 --parent-id "$PHASE8"

# POD-1265 Session-free issue wire lookup — Session-free issue wire lookup. Merge with #825.
run podium issue promote POD-1265
run podium issue reparent POD-1265 --parent-id "$PHASE8"

# POD-1360 Legacy repo boot heals — Legacy repo-id/origin/prefix heals still run every boot; retire into bounded upgrade behavior.
run podium issue promote POD-1360
run podium issue reparent POD-1360 --parent-id "$PHASE8"

# POD-1361 Machine id contract branding — Machine-id fields still raw strings. Branded-id completion, no wire change.
run podium issue promote POD-1361
run podium issue reparent POD-1361 --parent-id "$PHASE8"

