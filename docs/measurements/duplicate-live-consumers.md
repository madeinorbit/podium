# Duplicate live message consumers

Audit for POD-5796 on `integrate/4286-pilot`, 2026-10-08.

| Consumer | Existing data path | Removal |
| --- | --- | --- |
| Web session lists, titles and phases | `client-graph` shared session models, worklist and navigation readers; `app/pool-navigation-provider.ts`, `app/command-launch-readers.ts` | No legacy list subscription remains in production views. |
| Web conversations | Synced conversation entities remain in the replica; conversation search uses `lib/useConversationSearch.ts` and its search RPC | No view subscribes to the hub's conversation list. Search stays on its existing server read path. |
| Web automation definitions/runs | `client-graph/automation-source.ts` borrows addressed rows from the runtime replica | No legacy list subscription remains in production views. |
| Phone | `client/mobile-pool.ts`, `client/use-session-context.ts` and shared screen readers | Session views read the same synced pool/replica; no consumer of these seven hub events. |
| Desktop shell | Bundled web client; shell owns window, native notifications and terminal plumbing | No separate reader of these seven server messages. |
| CLI | `session-cli.ts` session control reads and `operator-client.ts` command transport use RPC | No `SocketHub` list/event consumer; existing server reads remain authoritative. |
| Notification sounds | `ClientRuntime.start()` previously subscribed to `hub.on('sessions')` | One runtime-owned reaction now consumes addressed pool session phase changes. |
| Terminal browser test API | `terminal-client/session-mount.ts` exposes `__podium.sessions()` from the old hub getter | The web app injects an on-request reader of shared pool session models; the terminal hook forwards it without remounting. |
| Transport/protocol tests | Old list observers, dispatch cases, frame fixtures and relay broadcast assertions | Replace retired expectations with sync/phase assertions; remove fixtures for deleted server frames. |
| Daemon conversation discovery | Daemon sends `conversationsChanged` into the server conversation registry | Retain this ingress message and daemon classification. It is not a server-to-client list. |

The title broadcaster in `daemon-projection.ts` and three agent-state broadcast
sites in `daemon-lifecycle.ts` and `session-wiring.ts` are removed. Full session,
conversation and automation broadcasts were already retired on the pilot branch;
this change removes their remaining protocol and client arms too.
The wire-v1 adapter's four corresponding projection fields are also removed;
its unrelated projection fields remain. Production runtime startup supplies the
canonical sync feed.

The complete retired server-to-client carrier set is `sessionsChanged`,
`sessionViewDelta`, `sessionTitleChanged`, `sessionAgentStateChanged`,
`conversationsChanged`, `automationsChanged` and `automationRunsChanged`.
Protocol schemas, classification, quarantine mappings and golden fixtures no
longer admit these server frames. The daemon's conversation carrier remains
in `discovery.ts`, `daemon-mux.ts` and `daemon-frame-routing.ts`.

`MobxPool.apply()` compares the before and after rows only for addressed session
updates. Phase, idle reason and user-need changes supply the sound reaction;
title-only updates do not. First sight, replacement snapshots and reattachment
are silent. The service retains the existing cue policy, watched-session and
window-owner suppression, sound toggle, prewarm and throttle behavior. Runtime
start/stop owns its reaction, DOM listeners and pending timer. It keeps no
per-session condition map and does not scan a session collection.

`machinesList`, `approvalsList`, `hostMetricsList` and their live message handlers
are outside this removal and remain in place. Other hub projections are outside
this issue's scope. Terminal output, geometry, draft, transcript and attention
messages also remain live channels.

Removal verification covers protocol inventory, both golden fixture systems,
SocketHub dispatch and subscriptions, the legacy feed/binding adapter, notification
sounds, the browser terminal test reader, native runtime startup, daemon title
projection, session/conversation ledger publication and relay title/state handling.
The sound policy comparison uses the same fixtures as the retired list algorithm;
32- and 128-session cases assert that one phase update addresses exactly one row.

Candidate validation ran in `~/podium-test-5796` on flatblock with the copied
Bun 1.4.2 toolchain, `node` linked to that Bun, one test worker, and a 3 GiB RSS
stop guard. No full suite or browser interaction run was used.

| Required check | Result |
| --- | --- |
| Lean gate, after restoring the generated API declarations | Green: 154 checks in 4 of 1853 collected files (0.2%). |
| Separate full typecheck | 29 of 29 tasks successful; 23 cached. |
| Standalone interaction scan census | 2257 fingerprints, 2258 occurrences, zero ratchet errors. |
| Normal production web build | Green, including compression and bundle budget checks. |
| Structural census under `meter:flatblock` | Incomplete. Three full attempts captured identical 1× counters, then hit the 3 GiB RSS stop limit during 4× setup. A focused seven-reader capture also hit that limit. Landing remains pending. |

Focused notification/transport checks passed 116 tests. Session/conversation ledger
and daemon projection checks passed 61; relay title/state checks passed 8; broadcast
residue checks passed 2. Terminal test-reader and native runtime seams passed.
Deleting the new service's `done` cue temporarily made the comparison against the
retired policy fail on that exact missing cue; restored code passed the comparison.

Unrelated failures were reproduced on the pilot base and reported to POD-4286:
one protocol lenient-parse test still treats `machine` as an unknown entity kind,
five golden fixture checks drift on host/model or `driverFamily` samples, and five
pool projection observer-count assertions see an extra existing observer. Their
fixes are outside this removal. The new pool-based sound test also revealed a
missing client-core cache input; this change adds client-graph sources to those
typecheck and test keys, and the lean configuration check now passes.

Structural attempts used the standard command, a smaller Bun collection target,
and finally `--execArgv=--smol` on the actual worker. Recorded workers 2232920,
2245683, 2266098 and 2286611 were stopped at the RSS limit. The first survived
SIGTERM and was subsequently killed by its recorded PID; later guards use
SIGKILL. The worker-level attempt used `BUN_JSC_forceRAMSize=536870912` and still
exceeded 3 GiB. No complete 4× result or flat-or-better claim is available.
The operator was asked to authorize a 6 GiB ceiling for this census only. The
meter lease is released while that decision is pending; no landing has occurred.
