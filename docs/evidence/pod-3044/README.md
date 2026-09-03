POD-3044 A1c real-instance evidence
===================================

Date: 2026-08-28 (Europe/Berlin)

This is a real-instance A/B of the shared server-family send path. Both runs
used an isolated instance, CONTRACT=1, STREAMING=1, Codex 0.149.1, an alive
send control, exact stamped-child attribution, SIGKILL, and the complete
PODIUM_A1C_OUTCOME_MS=120000 observation window.

PRE-FIX — FAIL
--------------
Pin:      cfb96fe179fbcc44d7421a058db69d6abb043327
Instance: p3044pre (:19878, hook :46878, relay :46879)
Session:  15c9be90-4ee6-4546-bb97-b8d37f893149
Driver:   codex-app-server (server family)
Control:  live send answered true
Child:    uuid=a02f1919-ac58-4c90-9dc0-cbf1660ab6f6, pid=1729882, SIGKILL sent,
          exact PID gone, death confirmed
Dead send: {"ok":true,"queued":true,"position":1,"disposition":"queued"}
Result:   accepted, then LOST through <=120s; no typed refusal

POST-FIX — PASS
---------------
Pin:      727e29103d380f4b19d632f27d794394f19e4a1e
Instance: p3044fix (:19868, hook :46868, relay :46869)
Session:  abb27b01-c7ad-4046-9cb4-8a26643af47c
Driver:   codex-app-server (server family)
Control:  live send answered true
Child:    uuid=51fa939a-6862-4ad8-8e35-79767c5c3f9e, pid=1713177, SIGKILL sent,
          exact PID gone, death confirmed
Dead send: {"ok":false,"reason":"dead-lettered: delivery-failed","disposition":"dead_letter"}
Result:   typed refusal before acceptance; no resume offer; A1c PASS

The detailed process and PINJSON record is in [a1c-ab.txt](a1c-ab.txt).

LIVE-SEND REGRESSION CONTROL
----------------------------
The positive control sent to the live session before killing its exact child
was answered true in both runs. This demonstrates that live sends still work
with the candidate change.

SCORER-CONTROL GATE
-------------------
Command: PODIUM_TEST_WORKERS=1 /home/mgw/.bun/bin/bun --conditions=@podium/source docs/evidence/pod-2777/scorer-controls.ts
Result:  SCORER CONTROLS PASS
  A1c accepted-then-lost -> FAIL
  A1c resume-only -> FAIL
  A9 rebound at 15s -> FAIL
  A9 rebound at 300s -> FAIL
  A9 original alive but unstamped at 15s -> FAIL
  A9 original alive but unstamped at 300s -> FAIL

VALIDATION GATE COUNTS
----------------------
The gate runs used PODIUM_TEST_WORKERS=1.
Lean gate: GREEN — 4 of 1042 collected unit files, 80 tests executed.
Typecheck: 25 successful / 25 total tasks; 21 cached / 25 total tasks.
Services shard: 97 passed / 104 files; 1839 passed / 1873 tests; 7 files and
34 tests failed in unrelated session machine-probing, handoff, upload,
attribution, stop, and oracle baseline areas. No changed message-path test
failed.

The fix was replayed cleanly as 1a4664665b0d808e8b6a2e348eedb4c39556e92c
on current coordinator tip 350da768eb5dcee92e77a72365e5f1b9c9769910,
which contains requested tip f76f698cecc8aeb5021803902579a17d7a0852dc. No main landing,
results.tsv edit, or ledger edit was performed. The exact server-family main
provider comparator remains unavailable; Claude PTY main is a documented
longstanding A1c failure, so regression classification is unresolved.
