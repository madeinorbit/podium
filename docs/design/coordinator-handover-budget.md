# Coordinator handover budget

Part B transition rule, POD-4245, 2026-09-18. This supplements the machine ownership
and upgrade design's transition table.

| Transition | Actor / precondition | Writes | Idempotency key | On failure |
| --- | --- | --- | --- | --- |
| Coordinator update handover | authorized update, predecessor owns the installed generation | existing snapshot, migration, import and adoption writes; no new ownership path | existing operation id and successor generation | successor must satisfy the same absolute 90 s deadline as the predecessor; no nested 60 s failure. After expiry use the existing migration-aware refusal/rollback policy, never readiness for an unhealthy successor. |

Health continues to mean the durable boot and target-resolution work completed. We do
not expose an early success while migrations or baseline recovery are incomplete. The
old server still releases the port before successor startup; this is a bounded-outage
contract, not overlapping database writers or port handoff.

The desktop local served document tolerates at least 120 s of failed one-second probes
before baked fallback (120 consecutive failures), with two successes to return. Startup
and explicit supervised-restart pause use the same 120 s allowance. The 30 s margin over
the parent's 90 s deadline covers reconnect/rollback scheduling. An update completing
in 50–65 s must retain its served document and never enter the baked skew/bootstrap path.
A permanently unavailable backend still falls back; a single successful probe clears the
failure streak. Probes can take time, so the count-based watchdog is a minimum allowance,
not an exact 120 s wall-clock deadline.

In the inspected tree the six-failure watchdog and 30 s pause were **local** only.
Remote-mode `remote_window_target` directly loads the configured HTTPS origin, and the
local watchdog stops when the document moves to a remote origin. There is no remote
six-failure fallback to raise here. The macOS incident's precise navigation trigger needs
its shell version/mode and native navigation logs; the reported remote fallback cannot
be attributed to this local watchdog from server logs alone. Existing installed clients
retain their old budgets until their shell updates. This rule protects upgraded shells;
it cannot retroactively change the running fleet's native timers.

## Boot evidence

The incident backup `podium.db.backup-vdrizzle-105-2026-09-18T08-39-19-732Z` is
1,064,419,328 bytes and contains 4,262 persisted sessions. The ~32 active sessions do not
bound boot recovery: all persisted session rows are restored. The copied baseline has
20,590 current sync rows and approximately 53 MB of JSON payload.

A full fenced rehearsal reached health at **40.465 s**, including **26.492 s** in the
previously silent recovery interval. SQL accounting identified **14.931 s** in:

```sql
SELECT seq, entity, entity_id, payload FROM change_latest ORDER BY seq ASC;
```

SQLite chose `SCAN change_latest USING INDEX change_latest_seq`: a full payload read in
sequence-index order. It is started by Authority baseline seeding and queues ahead of
session reads, so the wait formerly looked like session draft hydration. The repair reads
in table order and sorts the materialized rows numerically by sequence, preserving the
public ordering. A separately timed `ledger baseline read` now precedes session recovery.
The second repair takes a runtime-event subject census and avoids thousands of empty
per-session transcript queries; sessions with runtime events retain the existing bounded,
oldest-first transcript recovery.

The completed candidate under the repository-pinned Bun 1.4.2 on the same snapshot
reached health at **11.975 s** and measured:

| Stage | Stage duration | Process age at completion |
| --- | ---: | ---: |
| Store open | 1 ms | 927 ms |
| Backup | 2,966 ms | 3,904 ms |
| Migrations (includes backup) | 3,560 ms | 4,493 ms |
| Imports | 51 ms | 4,544 ms |
| Backfill/healing | 171 ms | 4,748 ms |
| World index | 49 ms | 4,824 ms |
| Ledger baseline read | 575 ms | 5,399 ms |
| Sessions recovery | 4,421 ms | 9,869 ms |
| Feeds/memory/automations | 162 ms | 10,031 ms |
| Issues catch-up | 1,487 ms | 11,518 ms |
| Queued-message recovery | 368 ms | 11,893 ms |
| Setup enrollment | 1 ms | 11,895 ms |
| Machines/update adoption (includes setup) | 29 ms | 11,922 ms |
| Listen | 1 ms | 11,941 ms |
| Health exposed | 12 ms | 11,975 ms |

These are observations, not a controlled speedup ratio or a guarantee: host load and
page-cache warmth varied. The stall monitor (`startLoopAccounting` in `server.ts`) is installed only after
`serveNative` returns. Its missing pre-listen warnings do not show that the loop was
awaiting rather than synchronously blocked; the Bun SQLite driver is synchronous.
The incident's exact 32 s cannot be allocated retrospectively
without stage logs. The reproduced slow step is sync-ledger baseline I/O ahead of session
recovery, not a 32 s issues catch-up. Both now have explicit info records with
`durationMs` (process age) and `stageDurationMs` (elapsed stage time).

## Rehearsal contract

`scripts/rehearse-upgrade.ts` writes `boot.log`, `boot-stages.json`, and `result.json`.
The copy runs migrations, imports, backfill/healing, world/baseline loading, sessions,
issues, queued messages, setup, adoption, target resolution and listen/health. The fences
sit at effects: no daemon or supervisor, API/session admission refused, session spawning
refused, background dispatch and external-path repair disabled, operation runners not
resumed, parent enrollment confirmation not sent, and external fetch rejected at the
transport. This intentionally cannot measure real network latency or parent IPC latency.

Measurements used a minimal private snapshot because the whole live state was 22 GB and
free space was 13 GB: the incident database, non-secret machine identity envelope, and a
newly generated rehearsal-only signing key. No live production key files were copied.
Historical archives, artifacts, binaries, and transcript files were excluded; therefore
filesystem-only imports with absent source files are exercised as no-ops. Production state
was never migrated or booted by the rehearsal. The initial slow-run measurement used ambient Bun 1.3.14. The final run above uses
repository-pinned Bun 1.4.2. Together with changing host load/cache warmth, that runtime
difference prevents attributing the entire observed improvement to the query rewrite.

## Validation

Native Rust gate green: 310 tests (140 library, 169 binary, one panic integration).
Lean gate green (four files, 129 tests). Focused parent and sync tests: 88 passed;
operation-engine tests: 85 passed; runtime-event recovery: 17 passed after updating its
fixture to explicitly enroll/assign the host and await daemon attachment.

The required independent-instance lane under Bun 1.4.2 ran 35 cases: 33 passed, two
failed. The stale named-root assertion expected an imported setting to remain in
config.json; it now checks SQLite, and the narrow rerun passed (one case, ten assertions).
The other failure is the existing current-daemon/old-server wire rejection, reported to
POD-4058. Real concurrent instances, migration-shaped identities and the full fenced
rehearsal passed. The aggregate lane is **not green**; its later managed-account/installer
steps were short-circuited by that failure. No broad wire-policy change belongs in this
boot fix. Native navigation evidence for the Mac incident is tracked as POD-4246.
