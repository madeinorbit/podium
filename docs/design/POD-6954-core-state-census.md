# Core state census for POD-6954

POD-7287 · documentation census · 2026-11-23 · source baseline
`2a252e85a5dc37bee3a0d1f6e9e6f3f8003d62ac` on the issue branch, based on
`integrate/6951-cloud-hosting`. Product code was read, not changed.

The conversion boundary is **durable decisions in Core transactions, live decisions in the
room, and local handles only on the process holding a connection**. Replacing every map with
a query would put Postgres in the terminal input/output loop. Reusing the service graph as a
cache would preserve the single-process correctness problem. Neither is the proposed split.

The largest correctness dependencies are the session mutation baselines, delivery/drain
ownership and receipts, machine enrollment/availability fencing, pairing and sign-in
challenges/throttles, and worker/operation single-flight state. Their replacements must exist
before deleting the graph. The terminal picture/control/presence world has a different owner:
the room. Static registrations, compiled SQL, immutable configuration and task-local context
are not another database of workspace facts.

## Authority and scope

The source of truth is the `docs/design/POD-6954-server-runtime-design.md` artifact on
POD-6954, especially §§0, 2, 4.2–4.4, 4.7, 4.13 and 7. Its second-review additions override
its earlier text. The gap analysis is POD-6954's `runtime-phase-gap-analysis.md` artifact.
All source locations below are **re-verified at the baseline above**, not copied from the
design's older `7b0c48a61b`. Paths in the ledger are relative to `apps/server/src`.

Two scope qualifications matter:

- Design §4.3 permits a bounded HTTP wait of a few seconds on an operation result **without
  holding a transaction**. This overrides the brief's absolute no-wait sentence; it does not
  permit a long machine RPC or an in-memory continuation as the only record of accepted work.
- Design §4.10 is on hold. POD-7290's amendment explicitly excludes `readTranscript`,
  `transcriptMirrorRead`, `usageRequest` and handoff chunk frames. Their existing narrow path
  remains until POD-7329 is settled and POD-7333 removes it. POD-7290 does **not** wait for a
  chat-copy schema. A `delete` verdict for these rows is the eventual destination, not
  authorization to remove the held path now. Self-hosted install/move/endpoint/probe requests
  retain their explicit in-process exception; legacy daemon update notice/grant frames retain
  the permanent bootstrap exception in §4.3. Session-scoped file reads remain Core
  operations until the daemon enforces the transcript-derived path check (§4.6 addition).

POD-7289 has already removed the global notice binding and write-builder claim flag, scoped
TableWrites to SessionStore, and removed worker workspace fallbacks. They are **absent** here,
not newly proposed removals. Its remaining `trustedNetworks` closure is present at
`relay.ts:934` and assigned to POD-7484. The settings repository still has its own committed
snapshot (`store/settings.ts:149`); removing the former registry snapshot did not remove that.

The census covers executable server TypeScript under `apps/server/src`, including store,
identity composition, gateways, factories, migrations with retained work, and diagnostics.
Test/spec/type-test files, `test-support/` and `store/spike/` are not request-serving code.
Immutable schema/route catalogs and declarations do not become mutable row copies merely
because their JavaScript representation is an object. State implemented in another package is
recorded at its server allocation/holding boundary (for example SubscriptionRegistry, the
identity throttle, SQL pools and the legacy lake), rather than silently omitted.

## Discovery and counting

The broad declaration grep was:

```sh
rg -n --glob '*.ts' --glob '!*.test.ts' --glob '!*.spec.ts' \
  --glob '!*.type-test.ts' --glob '!**/test-support/**' --glob '!**/spike/**' \
  '(new (Map|Set|WeakMap|WeakSet|AsyncLocalStorage)\b|^[[:space:]]*(export )?(let|var)\b|^[[:space:]]*(private|public|protected|readonly|static)\b)' \
  apps/server/src
```

It returned **6,172 matching physical lines**. This is a candidate count, not a field count:
comments, methods, local collections and multiline declarations make grep alone unsuitable
for the acceptance count. `rg --files` with the same file globs found **813 files**. A static
TypeScript syntax traversal of those files enumerated **1,536 class property declarations**
(including constructor parameter properties) and **3,479 module lexical declarations**
(including top-level blocks). Assignment/mutator sites and captured factory bindings were
then reviewed. No product code was executed for this scan.

The ledger deliberately includes **every one of the 1,536 class fields**, not just those a
heuristic recognizes as mutable. Required owners therefore have no field-type exceptions:
SessionRegistry, SessionRepository, SessionResidency, SessionLifecycle and
SessionLifecycleController, SessionInbox, SessionTerminal, MachinesService,
DaemonRequestBroker, PairingManager, SettingsRepository, and every class in `gateway/`.
Constants, request-local helper fields and immutable capability aliases are labeled as such;
their `delete` means no retained mutable workspace field is needed, not removal of a required
query definition or behavior. The unused capability wrapper can disappear with the graph;
immutable SQL/schema/command definitions can be shared as code. The contents of a request or
transaction memo still die with that request/transaction even if its definition is reusable.

Counting unit: **one declaration row, once**, not one allocated instance, member of a map,
byte buffer chunk, or recursive property of every payload. A map's nested values and their
nested maps/sets are included in its holding description; separately declared connection
record fields are also listed. Aliases are identified as aliases and are not claimed to be
additional copies of their pointee's facts. These counts are therefore not directly
comparable to the design's historical “183 Map and Set fields across modules”.

| Declaration coverage | Count |
| --- | ---: |
| Class fields (including constructor properties) | 1,536 |
| Mutable module/global holders | 62 |
| Captured factory slots | 120 |
| Connection record fields and identity throttle boundary | 22 |
| **Total ledger rows** | **1,740** |

| Verdict | Fields / binding rows |
| --- | ---: |
| derived | 144 |
| room | 111 |
| job | 208 |
| operation | 31 |
| socket | 209 |
| cache | 0 |
| delete | 1,037 |
| **Total** | **1,740** |

The 62 mutable module/global holders include mutable class-instance globals and the worker's
module-level block. Pure module-initialization catalogs (`schemas`, `collectionRules`,
`SQLITE_TABLES`, protocol/SQL keyword sets, migration/index manifests, empty sentinel maps)
are immutable after initialization, not cross-request mutable state. The broad scan also
found `oracle-support.ts`'s test registry and an assignment to a shadowed local `targetId`;
these are test-only and a false lexical-name match respectively, not production globals.
Symbols, not just identifier spelling, were used to trace the 182 module/factory bindings in
the ledger. Every mutable module binding in the production scope has a verdict below,
including scalar counters, async-context storage and the nested client/daemon/machine warning timestamps in gateway/ws-send.ts:160. A separate symbol pass over nested object/element assignments found 83 mutator sites; its only excluded runtime writes are the oracle test registry.

The full ledger is intentionally conservative. Its counts include coverage-only constants,
capabilities and request-local class fields as well as data-bearing state; it is an audit of
**declarations and destinations**, not a measured heap size. There are **zero approved cache
verdicts**: existing informal row caches become reads, live working sets go to the room,
compiled-code memos become immutable code, and diagnostic/asset caches can be deleted. If a
measurement later justifies a Core read cache, it needs `(workspaceId, record key, committed
version)`, a bound, and after-commit key invalidation for every writer on both engines. A
local TableWrites callback, a TTL, or the last value this process wrote is not that contract.

## Reading the ledger

Each row has source location, holder/content, writer, reader, exactly one verdict and the
replacement/loss implication. Writer and reader names are source methods or factory callbacks;
`callback@N` is the callback starting on source line N. A constructor/initializer writes the
initial value; a method may both read and mutate it. Public fields also have external
consumers: these are named explicitly for the main session and composition roots. A
constructor property containing a store/ports object is a capability alias, not evidence that
its rows may be retained between requests.

- **derived** means use the named query below in the request/fact transaction. “New” means
  the table/column/query does not exist at this baseline; it is required work, not a claim
  that current rows can already reconstruct the value. Authorization and claims need guarded
  writes as well as reads.
- **room** is disposable live state, with no database access. Loss forces reconnect,
  resubscription and terminal repair; it must never re-run an accepted durable command.
- **job** means the row owns due time, claim, attempt and recovery. A promise/boolean is not
  the lease. Jobs do slow work outside the workspace transaction and commit briefly.
- **operation** means stable machine command acceptance/result identity. Direct person reads
  leave the general broker for the room; server-needed asks remain operations. An optional
  bounded result wait has a row to re-read on another process.
- **socket** retains a connection/IPC handle, cursor/scope, bounded transport queue or local
  database-connection machinery. Disconnect/dispose invalidates it. It does not decide durable
  online status, dispatch custody or authorization from an unversioned stored-fact snapshot.
- **cache** has the explicit workspace/version invalidation contract above; none is approved.
- **delete** removes between-request retention, source-side coalescing, obsolete graph
  plumbing, diagnostic state or an unneeded mutable memo. Transaction-local drafts and
  immutable definitions are allowed; accepted work must already have its durable destination.

For current correctness, treat the `derived`, `job` and `operation` rows as **red flags**:
losing the local object or serving the next call on another process changes a decision,
continuation, duplicate suppression, deadline, or answer today. `room` and `socket` rows have
live/connection-local correctness (especially byte ordering and keyboard ownership), not
restart-safe entity truth. `delete` rows say whether the field is wiring, a harmless hint,
a source coalescer, or held legacy history; the latter must not be dropped before its
replacement is approved. These distinctions are part of each destination description.

## Derived query and index catalog

Queries are workspace-bound through `StoreDatabase.workspace(id)` unless explicitly install
or identity scope. Existing schema evidence is in `migrations/schema.ts` and its Postgres twin
`migrations/pg/schema.ts`. “Exists” means the key/index is declared in both schemas; this
static census did not run EXPLAIN, benchmark, migration, store test or lean gate.

| Query key used by ledger | Request replacement and current entry point | Index at baseline / missing work |
| --- | --- | --- |
| Q-session | `SessionsRepository.getSession` / `getSessions` (`store/sessions.ts:1886,1946`); select named sessions with `workspace_id` and id. Mutations re-read inside their transaction. Machine/issue lists use the matching scoped repository query. | Exists: `sessions_pk(workspace_id,id)` (`schema.ts:415`), `idx_sessions_machine`, `idx_sessions_issue`, `idx_sessions_status`, `idx_sessions_lifecycle_pending`. No boot-wide `loadSessions()` as a substitute for a point read. |
| Q-session-control | **New** `sessionControlOf(sessionId)` for title-fallback lock and reconciliation outcome/revision when not derivable from saved facts. Preserve exact naming and error behavior. | **Missing** persistence for `titleLocked` and controller `outcomes`; proposed `(workspace_id,session_id)` PK, optionally columns on sessions under its existing PK. `cmd` is a live reading, not a missing session column to invent. `incomingWorkingMsTotal` is replaced by producer facts, not called an existing column. |
| Q-draft | `SessionsRepository.draftDocOf` / `draftTimesOf` (`store/sessions.ts:2909,2856`), once on draft checkpoint/read, not on every edit. | Exists: `session_drafts_pk(workspace_id,session_id)` (`schema.ts:1382`). Room revisions are transient; device/daemon owns lasting checkpoint upload. |
| Q-offer | `SessionsRepository.offersOf([id])` (`store/sessions.ts:2736`) and offer status read/write in the command transaction. | Exists: `offers_pk(workspace_id,session_id)` (`schema.ts:1418`). |
| Q-conversation | `ConversationRegistryRepository.podiumId` / `podiumIds` (`store/conversations/registry.ts:421,738`), plus a bounded segment-availability existence query. | Exists: conversation-segment key `(workspace_id,machine_id,native_id)` and `conversation_segments_podium(workspace_id,podium_id,seq_in_conv)` (`schema.ts:1711,1707`). No assumed approved chat-copy table; availability from the existing registry is distinct from a live transcript buffer. |
| Q-settings | `SettingsRepository.getSettings` (`store/settings.ts:375`, prepared `workspaceValue`) and `getSettingsFor` (`:437`) with the person's preferences. Includes `trustedNetworks` on credential admission/use, not per terminal byte. | Exists: `workspace_meta_pk(workspace_id,key)` (`schema.ts:635`); preferences key is `(workspace_id,user_id,key)`. Local `committed` replacement after setSettings does not invalidate a peer process. |
| Q-catalog | `SettingsRepository.getModelCatalog(machineId)` (`store/settings.ts:601`), current versioned machine-specific JSON; empty/stale schedules a probe job and returns stored status. | Exists: `workspace_meta_pk`; shape version is `MODEL_CATALOG_VERSION=4` (`model-catalog.ts:11`). Job claim/due key is new background infrastructure. No mutable SWR object shared with callers. |
| Q-machines | `MachinesRepository.getMachine` / `getMachines` (`store/machines.ts:943,950`), including revocation/enrollment generation and persisted inventory/build. Count is a scoped count query, not cached `listMachines().length`. | Exists: `machines_pk(workspace_id,id)` (`schema.ts:1240`), component/enrollment facts currently carried by the row/ledger. Proposed count uses workspace prefix of the PK. Must compare current credential generation atomically with the enrollment write. |
| Q-machine-facts | **New** `machineRuntimeFactsOf(machineId)` for harness descriptors and any Core-required readiness/capability facts; producer reports before Core work asks. | **Missing** durable harness descriptors: `persistInventory` only saves inventory JSON (`modules/machines/service.ts:2259–2281`). Add to persisted machine facts under existing machine PK or new `(workspace_id,machine_id)` PK; generation/expiry required for readiness. Live readiness stays in the room. |
| Q-lease | **New** `machineLeaseOf(machineId)`, fenced generation and expiry compared with DB time, outside feed locking. | **Missing** machine-lease table/index at this baseline. Required `(workspace_id,machine_id)` PK; expiry sweep also needs `(expires_at,workspace_id,machine_id)`. A random availability epoch and a connected-daemon map cannot substitute. Owned by POD-7300. |
| Q-binding | Existing `ObservationCheckpointsRepository.get` (`store/observation-checkpoints.ts`) / binding reports, plus **new** persisted current driver/capability affiliation when needed for operation admission. | Existing observation/session keys lead with `(workspace_id,session_id)`. Current `driverId`/`hasBoundDriver` are explicitly transient (`session.ts:665–702`); no existing query proves current liveness. New fact must bind to current machine lease/binding generation; never trust old `boundDriverId` as online proof. |
| Q-message | `MessagesRepository`'s row/delivery-status reads for the known queue/message ids; **new** durable idempotent result/failure receipt where the current Sets have no receipt. | Exists: `queued_messages_pk(workspace_id,id)`, `queued_messages_session(workspace_id,session_id,queue_order)` (`schema.ts:1666–1667`). Add unique `(workspace_id,operation_id,result_id)` or equivalent receipt identity before removing `settledQueueRowIds` / failure suppression. |
| Q-events | `EventsRepository.listKindSubjectSinceWithPrior` / bounded subject tail (`store/events.ts:1493`); fact-keyed history writer, never a full event-table scan. | Exists: `idx_podium_events_kind_subject_ts` and `idx_podium_events_kind_subject_id` (`schema.ts:1834,1844`). Concurrency fold's durable checkpoint/due work must be explicit. |
| Q-repos | Existing prepared `registryRows`, `registryPrefixes`, point repo/prefix queries in `store/repos.ts:80–140`; select only requested repo/machine/scope, join prefixes in request. | Exists: `repos_pk(workspace_id,machine_id,path)` and `repo_prefixes_pk(workspace_id,repo_id)` (`schema.ts:1264,783`). A point lookup by repo id must use a matching declared index/query; do not call a warmed whole registry a cache contract. |
| Q-grants | Workspace grant queries in `store/grants.ts` and scoped feed/version read for revalidation; never use a process-only visibility revision as cross-process rights proof. | Exists: composite grants PK and `idx_grants_grantee(workspace_id,grantee)` (`schema.ts:1518–1523`), feed identity key. If callers require a separate rights revision, persist it; no such cross-process counter is provided by `visibilityRevisionValue`. |
| Q-pairing | **New** `pairingGrantByDigest` + atomic `consumePairingGrant`, including expiry, installation/workspace audience, issuer and purpose; Telegram setup uses its own purpose. | **Missing** durable challenge table. Proposed `(workspace_id,purpose,token_digest)` PK/unique key, expiry index `(expires_at,workspace_id)`; installation enrollment challenges must retain their install audience. Store digests, not replayable plaintext codes. |
| Q-rate | **New** guarded `admitRateBucket(scope,kind,subject,window)` and failure-lockout query/update, shared by all Core processes; identity engine must use the same store seam. | **Missing** shared rate-bucket table. Proposed unique `(scope_id,kind,subject_digest,window_start)` and expiry index; identity/install scopes cannot be mislabeled as a caller-selected workspace. Preserve PairingFailureThrottle's lockout expiry/no-live-lockout-eviction behavior. |
| Q-signin | Existing `SignInCarryOverRepository` reads for carry-over; **new** short-lived OAuth/native-login attempt/requirement/result reads by owner and attempt id where memory is currently the only home. | Existing carried-sign-in PK `(workspace_id,old_token_hash)` and expiry/member indexes (`schema.ts:1571–1574`). OAuth state/PKCE/outcome persistence is **missing**; add `(workspace_id,attempt_id)` PK and owner/expiry access. Encrypt secret challenge material; consume callback once. |
| Q-mcp | **New** scoped MCP credential resolve/revoke by token digest, thread, workspace and expiry, or a signed credential with durable revocation; read at HTTP admission. | **Missing** replacement for `server.ts:1993`'s per-boot bearer and superagent reverse-token maps. Proposed `(workspace_id,token_digest)` unique key plus thread/expiry indexes. Existing agent/member credentials can be reused only if their audience and thread scope match. |
| Q-assistant | `SuperagentRepository` thread/turn state plus a **new** atomic turn-dispatch receipt keyed by turn id if not represented by the operation. | Exists: `superagent_threads_pk`, `idx_superagent_threads_running` and `idx_superagent_messages_thread` (`schema.ts:1107,1168–1175`). A turn id must have one durable dispatch acceptance; a process Set is not that receipt. |
| Q-update | `UpdateRecoveryStore.read()` (`modules/updates/recovery-store.ts:94`) / prepared `checkpoint` in `store/update-recovery.ts`, plus the operation result. This is **install-global**, not a per-workspace snapshot. | Exists: `meta(key)` PK (`schema.ts:615`), checkpoint key `updates.execution.v1`. Some `checks`, intermediate terminal buffers and next-target scheduling are not in RecoverySnapshot; persist them as jobs/results before removing buffers. |
| Q-shipping | `ShippingRepository.getOrder`, `getAttempt`, `latestAttemptForOrder`, active claims and durable evidence (`store/shipping.ts:2517,2900,2948,2379`). Claim/renew/revoke compares durable generation in one transaction. | Exists: workspace-leading shipping order/attempt/active-claim/evidence PKs and order/attempt indexes. Green-prefix/session resource correlations may need additional durable evidence fields/keys; no process `versions` map is a fencing mechanism. |
| Q-git | `IssueGitStatesRepository.get` / `getMany` (`store/issue-git-states.ts:114,103`) and machine-reported commit/path facts; **new** per-session delta correlation if not in the saved projection. | Exists: `issue_git_states(workspace_id,issue_id)` PK. Session commit/touched-path deltas and parent-tip notification baseline are not automatically reconstructible from that one row; persist them or derive a fresh Git operation result with a stable commit cursor. |
| Q-upload | `ArtifactUploadsRepository`/`PendingUploadsRepository` scoped status and atomic claim/append guarded update. | Exists: `artifact_uploads_pk(workspace_id,issue_id,upload_id)` and `pending_uploads_pk(workspace_id,id)` (`schema.ts:4553,4586`). Concurrent claim must be a guarded row transition, not `chatUploadLocks`/`chatUploadClaims`. |
| Q-dock | `UserDockShellRepository` slot read/create in one transaction. | Exists: composite dock-shell PK `(workspace_id,user_id,worktree_key)` (`schema.ts:4431`); use its uniqueness for concurrent creation. |
| Q-telegram | `TelegramBindingsRepository.listForUser` (`store/telegram-bindings.ts:181`) and messaging topic/thread lookup; worker persists inbound offset and reply correlation. | Exists: `telegram_chat_bindings_pk(workspace_id,chat_id)` (`schema.ts:1610`) and scoped messaging-topic keys. **Missing where memory-only**: provider offset, awaited reply, last inbound/thread correlation and dispatch acceptance; add unique provider event/reply keys under the leased poll job. |
| Q-vault | `ServerSecretsRepository`/vault-key row read, unwrap with installation key provider, guarded create-if-absent; request/fact scope only. | Exists: `workspace_secrets_pk(workspace_id,key)` (`schema.ts:687`), `vault_key_pk(workspace_id,id)` (`:4769`), credentials PK. No unwrapped plaintext key cache is approved by this census. |
| Q-notify | Existing notification facts plus **new** provider edit/replacement key when only `lastTelegramKeys` currently remembers it. | Existing notification fact keys are workspace-scoped. Add unique `(workspace_id,member_id,provider,notification_key)` with result/status if the external message id is not already stored. |
| Q-mobile | **New** install-wide mobile-version observation summary read/update, including last checkpoint and coverage gaps. | **Missing** DB summary; currently a local file plus `history`/`healthy` fields. Install `meta(key)` exists, or use explicit version-summary key/table. Connected clients stay socket-local; no one process's count proves fleet-wide quiet coverage. POD-6974 owns the file-home decision. |
| Q-build | **New** `buildManifestById(artifactId)` for a hosted recovery read; recover descriptor from an install-scoped signed manifest. | **Missing** hosted manifest row/query/index: proposed `(installation_id,artifact_id)` unique key, plus digest key if queried. Current self-hosted build-record files/direct probe are the explicit install exception; do not call them an existing DB lookup. |
| Q-effect | `EffectsRepository` point read by effect id plus structured operation result for errors/outcomes. | Exists: workspace/effect composite PK and pending/state indexes in `schema.ts:4160–4237`. Error detail currently held only in a Map must be saved with the failed result. |
| Q-mutation | `SyncRepository.getAppliedMutation` plus receipt write under the same workspace transaction as command application (`MutationLedger.apply`). | Exists: `applied_mutations_pk(workspace_id,mutation_id)` in the sync schema. **Current gap:** `MutationLedger.inFlight` joins only within one instance, and its prior-receipt lookup precedes `unit(run)`. Move the read/admit/body/receipt under the same database serialization or guarded claim; the existing receipt alone is not a cross-process claim. |

A “new” query above is a prerequisite to the associated row's deletion, not an optional future
optimization. Engine work must use the portable store definitions and both migration chains;
future store tests exercise SQLite and Postgres. Point predicates lead with workspace id;
fleet expiry/due scans need their own declared time-leading index and cross-workspace
allowlist entry. No new per-terminal-frame table/query is proposed.

## Hot paths and read-rate budget

**No traffic measurements or tests were run for this documentation task.** These are explicit
engineering estimates, not observations of the live installation. The design's appendix B
measures transcript storage, not PTY frame rate, and cannot justify a database lookup budget.
Let `F = output bytes/second ÷ bytes/frame`, `K = input frames/second`, `W = attached viewers`.
For comparison, assume 100 KiB/s with 4 KiB frames (`F=25`) and a burst of 1 MiB/s with 1 KiB
frames (`F=1,024`), `W=3`, and typing `K=5–12` (burst 50). Numbers scale linearly; a binary
frame can batch many bytes/keystrokes, so bytes must not be mistaken for database operations.

| Fields/holding path that would put a replacement read on the hot path | Reader/writer evidence | Estimated naive database reads | Destination / required budget |
| --- | --- | --- | --- |
| `relay.liveSessions`, `SessionLifecycle.sessions`, `SessionResidency.leases/loading`, `SessionRepository` resident/baseline lookup, `Session.machineId/status` when routing terminal frames | `gateway/daemon-mux.ts` output route → session terminal; lifecycle frame routing and residency; repository live listeners | At least `F` session lookups: 25–1,024/s per emitting session, before extra baseline/repair lookups | Core reads once per durable fact batch/request; raw PTY output bypasses Core and all those maps. **0 DB reads per raw frame**. |
| `SessionTerminal.geometry/epoch/nextSeq/lastForwarded`, `outputAtMs_/outputCount_/activityCount_/activityDirty_` and listener fields; `PictureCache.current/chunks/end/readers` | `SessionTerminal.acceptOutput/acceptPicture/outputItem/sendOutput`, picture append/read | Several lookups/updates per frame: each replaced field alone would add `F`; a naive per-viewer snapshot could add `W×F=75–3,072/s` | All live accounting/picture/byte offsets in room. Producer coalesces lasting activity; **0 DB reads per frame**. Daemon absolute byte offset + binding generation detects gaps after restart. |
| `SessionTerminal.clients/clientAttributions/owed/dropHandlers/pictures/exited/nudgeTimer`, terminal `init` transport; `ClientConn` transport, `viewports/attached/caps/viewVisible/viewModes` | output fan-out, owed replay, drop/nudge handlers and active native-renderer selection | `W×F=75–3,072/s` if attachment/permission/viewer membership were fetched for each recipient/frame | Room grant scopes/connection handles; replace scopes on refresh/revocation and clear on disconnect. **0 DB reads per fan-out recipient/frame**. Snapshot repair is bounded/rate-limited, not one unbounded request per watched session after room restart. |
| `SessionTerminal.controllerId/controllerIdentity/lastInputAttribution`, `inputAtMs_/userInputAtMs_/inputCount_`, `shellBusy_/shellCommandRunning/shellBusyTimer`; input `geometry/clients` | `handleInputBytes`, `recordInputActivity`, `requestControl/reconcile`; inbox controller-input dispatch | Each substituted field would add `K=5–12/s`, burst 50; multi-field/controller checks multiply it | Keyboard lease and viewport arbitration in room, daemon checks signed control scope and binding generation. **0 DB reads per input frame/keystroke**. |
| `MachinesService.daemons`, `revokedMachines`, `daemonCaps`, credential generation/link transport; session driver/binding selection | `MachinesService.toPtyInput` / `toMachine`, `SessionInbox.sendInput`, client mux binary input route | A revocation/target lookup naively moved to DB is `K` per typist and could become `F` on output | Durable commands read current rows/lease once; room input uses expiring grant+revocation push and daemon generation fence. Core must never consult its machine map for room input. |
| `SessionStateService.draftDocs/draftEdits`, staged times/write timers, `Session.draftUpdatedAt`, `ClientConn.focused` | `draftEdit/setSessionDraft` sequencing and native composer injection | 5–12 reads/s per typing device if each edit loads the draft; a scrape producer can add its own edit stream | Room sequences live revisions. Device/daemon checkpoints on pause/blur/send; row read only for checkpoint/init. No Core debounce timer and **0 DB reads per draft edit**. |
| `PresenceRouting.lastUpdateAt/pressureDrops/router`, TopicRouting `states/resendStreak/router`, live-topic held/latest maps; `TurnPreviewAccumulator.sessions`, `SessionTerminal.turnPreview`, runtime live/context fields | presence/topic `publish/sendUpdate`, fine agent events → preview/context reading | Presence/metrics estimated 1–10 events/s/source; fine preview/runtime events may approach `F`. A query per value scales with subscribers and output | Room derives and coalesces live readings, scope checks from grant. **0 DB reads per live update**. Durable phase/title/model/context facts are separate source-coalesced commits. |
| `OrderedClientSend.queue/ready/sequences/stalled`, byte/frame counters, shared budget, socket listeners/NativeGatewaySocket; ClientMux `sessionWork` | queue admission/prepare/pump/write/drain; client attach/input scheduling | Terminal transport path executes at least `F + K` and often `W×F + K` admissions; no meaningful SQL replacement for a socket buffer | Keep connection-local bounded transport. On gap force replay/snapshot/reconnect; **0 DB reads per send/drain**. |
| `SessionRepository.dirtyActivitySessions/pendingVolatileSessions`, SessionLifecycle `activityFlushTimer`, SessionDaemonProjection metadata queues, `SessionActivityPublication.inFlight` | activity listener on raw output/input, current ~12-second flush (`lifecycle.ts:317` and constructor); publish-due rows already durable | Naive activity read/write per event is `F+K`; 100 busy sessions at `F=25` would create ~2,500 output reads/s. Existing 12s coalescing means ~8.3 session row updates/s for 100, which a producer fact can batch into one commit/interval | Delete Core coalescers; source batches facts across sessions. Due activity publication is a job. Database rate follows fact batches/interval, **not PTY frames**. |

Terminal history arrays (`transcript`, `runtimeTranscript`, `transcriptAliases`) are touched
by parsed-item deltas, not every raw PTY frame. Their update rate is harness-dependent and can
approach fine-event frequency in a tool-heavy turn. They are explicitly held legacy paths;
this census does not justify moving history queries into the room or approving §4.10. Feed
serving and wake-up fields are per **durable log batch**, not per PTY frame: one log read per
workspace/wake-up then scope in memory per socket. Both SQLite and Postgres keep that
separation, even when all roles share one self-hosted process.

## Proposed POD-7290 split

These are proposed implementation tasks, **not new claims or started sessions**. The
coordinator files them after accepting this census. Each is at most 1–3 working days; estimates
assume its named infrastructure already exists. Existing sibling issues own operations,
leases, jobs, grants and room implementation; these tasks consume those ports and remove
state, rather than rebuild those projects inside POD-7290. Do not activate a task while its
prerequisites are unresolved.

Order is top-to-bottom, with the explicit dependencies in the second column. Add adapters
before changing callers, convert one command/read family as a whole transaction, and remove
an adapter only after its last caller moves. There is one durable writer/claim authority at
every step; never dual-run old and new dispatchers for the same kind/workspace. Old/new
comparison can compare read results without installing a second mutable mirror.

| Order / title / size | Prerequisites and census destination | Files touched (new names are proposals) | Why the tree remains green after this task |
| --- | --- | --- | --- |
| 1. Bound request services · 2d | Accepted census; POD-7309 request/socket binding and POD-7483 principals. Establish common context for all later cuts. | **New** `composition/request-services.ts`, `modules/request-context.ts`; `router.ts`, `trpc.ts`, `relay.ts`, `modules/sync-write/entry.ts`, composition boot probes. | Introduce request/fact/job context over trusted workspace store with a legacy adapter for unmoved callers. Existing entry points still compile and behave; no second workspace owner or new dispatch path. |
| 2. Snapshot-free store handles · 2–3d | 1; Q-session/settings/repos/grants, POD-7484. | `store.ts`, `store/settings.ts`, `store/repos.ts`, `store/grants.ts`, `store/sessions.ts`, `store/written-columns.ts`, `store/table-writes.ts`; focused store/workspace tests. | Repository handles become cheap request-scoped wrappers; shared compiled definitions stay shared. Remove settings/registry row snapshots and disable single-writer hints; reads and writes both use current rows. Preserve public store APIs for unmoved service callers. No process workspace-handle cache in hosted composition. |
| 3. Shared challenge state · 2d | 1–2; binding/identity owner confirms installation versus workspace audience. Q-pairing/Q-signin. | `hub/pairing.ts`, `mobile-pairing-route.ts`, `modules/settings/service.ts`, **new** `store/auth-challenges.ts`; both schema twins/migration chains and relevant store tests. | Mint/read/consume switch atomically to rows behind existing interfaces. Codes created on process A redeem once on B. Keep TTL, issuer/audience, callback ownership and consume-on-failure behavior; no plaintext code table. Native-login operation execution remains owned by POD-7302. |
| 4. Shared abuse counters · 1–2d | 3; Q-rate. | `hub/pairing.ts`, `mobile-pairing-route.ts`, `locate-proof-route.ts`, `identity/server-identity.ts`, **new** `store/auth-rate-buckets.ts`; identity package storage adapter seam, both schemas/migrations, two-process auth tests. | Replace throttles behind admission seam one endpoint at a time. Preserve existing limits and lockout expiry across processes; no per-process bypass multiplier. Keep install/account rate scopes explicit. |
| 5. Durable machine readers · 2d | 1–2; POD-7300 lease, POD-7305 proactive machine facts, operation transport. Q-machines/Q-machine-facts/Q-lease/Q-binding. | `modules/machines/service.ts`, `modules/machines/enrollment.ts`, `modules/machines/records.ts`, `store/machines.ts`, `gateway/daemon-link-kind.ts`, `gateway/daemon-socket.ts`; machine fact/lease tests. | New durable readers and transaction/generation guards replace online/revocation/inventory decisions. Socket maps still perform local transport lookup only. Persist descriptors before removing their map; dependent jobs replace inventory waiters. |
| 6. Session row reads · 2d | 1–2 and 5; session facts POD-7338; Q-session/draft/offer/conversation. | `modules/sessions/records.ts`, `session-record.ts`, `view.ts`, `read-toolkit.ts`, `repository.ts`, `session.ts`; `modules/issues/command-ctx.ts`; focused session read tests. | Convert pure queries first to records keyed by requested ids, preserving projection answers. Resident object adapter remains only for unmoved mutations/live callers. No boot hydration to answer a query and no transcript storage change. |
| 7. Session mutation transactions · 2–3d | 6; POD-7307 coalescing and session fact idempotency. Q-session-control gap resolved. | `modules/sessions/repository.ts`, `session.ts`, `session-record.ts`, `session-meta-ops.ts`, `naming.ts`, `daemon-projection.ts`, `store/sessions.ts`, `modules/funnel.ts`; both schemas/migrations if control state is added; rollback/nested-transaction tests. | Persist each mutation from current rows in one transaction, then retire captured/staged baselines, write tails and rollback repair for that family. Preserve outermost-commit publication and read-your-writes. Title lock/outcome state is persisted or proven derived first; no temporary stale mirror. |
| 8. Lifecycle job services · 2d | 7; POD-7301 lifecycle operations, POD-7338 facts, jobs infrastructure. | `modules/sessions/lifecycle-controller.ts`, `lifecycle.ts`, `session-revival.ts`, `session-start.ts`, `session-teardown.ts`, `daemon-lifecycle.ts`, `session-kill.ts`; lifecycle/operation tests. | Reconciliation gets desired state/revision from rows and dispatches through operations under job custody. Replace chains/again/outcomes and pending resurrection claims; one desired revision is reconciled once per lease, with idempotent retries. |
| 9. Inbox receipt services · 2–3d | 7–8; POD-7344 prompt/answer operations and POD-7307 source coalescing. | `modules/sessions/inbox.ts`, `session-launch-effect.ts`, `session-interrupt-effect.ts`, `modules/messages/queued-apply.ts`, `store/messages.ts`, relevant result/receipt repository and both schemas if needed; delivery tests. | Move one admission/receipt family at a time. Queue rows, operation acceptance and result idempotency commit together; remove forwarded/settled/failure Sets only after durable duplicate proof exists. No process drain can type twice after a crash. |
| 10. Credential request services · 2d | 3,5,7–9; POD-7302 command conversion and jobs. | `modules/credentials/native-login.ts`, `sign-in.ts`, `health.ts`, `placements.ts`, `vault.ts`, `chatgpt-plan/{authorize,keeper,session-renewal,service}.ts`, `modules/sessions/switch-credential.ts`; credential/store tests. | Use challenge/credential/operation rows per request; run renewals/restarts as jobs. Keep secrets encrypted, callback state scoped and consumption atomic. Remove pending maps after each command/result has its persisted home; no machine wait within a transaction. |
| 11. Issue and upload services · 2d | 5–9; POD-7303 repo/file operations and shared jobs. | `modules/issues/service/{core,crud,workflow,integration,assistant}.ts`, `modules/checkouts/service.ts`, `modules/shells/service.ts`, `store/issue-git-states.ts`; upload/Git/claim tests. | Atomic upload claims, durable Git correlation and job keys replace Promise locks/refresh hints one caller family at a time. Existing operation ports and wire contracts remain; all writes use current rows. |
| 12. Shipping custody services · 2d | 11; POD-7304 shipping/approval/update operations. | `modules/shipping/{service,lease-projection,queue}.ts`, `modules/approvals/service.ts`, `relay.ts` shipping resource callbacks; custody/lease/approval tests. | Durable attempt generation and saved validation evidence replace lease projections, approval clocks and resource holder hints. Dispatch stays under one guarded claim; no old/new runner can both send a grant. |
| 13. Message and notification services · 2d | 8–12; POD-7293/7295 jobs, POD-7296 Telegram lease, POD-7342 attention job. | `modules/messages/{service,scheduler,brakes}.ts`, `modules/messaging/{service,telegram,session-attachment}.ts`, `modules/notify/service.ts`, `modules/issue-session-lifecycle.ts`, `steward.ts`; messaging/notification tests. | Poll offset, reply correlation, delivery wakes and notification dedupe live in job/result rows. Remove per-registry timers only when their job registration is active. Presence suppression reads the short HTTP-renewed member lease, not a local window map. |
| 14. Assistant HTTP services · 2d | 3,7–13; POD-7345 assistant operations, POD-7306 agent HTTP, Q-mcp/Q-assistant. | `modules/superagent/service.ts`, `issue-mcp.ts`, `mcp-route.ts`, `server.ts`, credential resolver/receipt store (both schemas if added); assistant/MCP admission tests. | Preserve tools while moving thread credential resolution and turn dispatch acceptance to rows. Scope credentials at admission; remove per-boot/global reverse-token authority. Backend turns continue by job/operation id after another process receives the callback. |
| 15. Live graph detachment · 2d | 5–14; POD-7314–7319 device/daemon room links, grants, live policies and direct asks. | `modules/sessions/{terminal,picture-cache,turn-preview,live-topics,session-state/service,client-control,session-client-plane}.ts`, `modules/hosts/`, `gateway/{client-mux,daemon-mux,topic-routing,presence-routing,client-registry}.ts`, `relay.ts`. | Connect existing room ports and remove Core pointers to live state after each caller uses its durable counterpart. No implementation of the room is smuggled into this task. Raw terminal input/output no longer visits Core or the store; the remaining legacy transcript adapter carries only the held families. |
| 16. Background graph detachment · 2d | 7–15; POD-7293/7294/7295/7296 jobs/effect recovery; POD-7288 log-tail delivery. | `relay.ts` hydrate/dispose, `modules/effects/runner.ts`, `modules/operations/engine.ts`, `modules/updates/{service,operation,target-refresh}.ts`, `modules/connect/publisher.ts`, `modules/events/retention.ts`, `modules/files/file-jobs.ts`, `modules/quota-history/`, `auto-continue.ts`. | Already-converted job kinds construct handlers per claim; remove graph timer registration and process “live run means owned” checks. Every hydration step below is either a read or an idempotent registered job. Legacy install update/move exception stays explicit, not a hidden workspace host. |
| 17. Hosted boot without registry · 2d | 2–16; POD-7332 roles and POD-7288 completed. | `server.ts`, `relay.ts` removal or compatibility reduction, `composition/`, `router.ts`, `store.ts`, `sync/routes.ts`, `gateway/ws-server.ts`; boot-wiring and multi-instance tests. | Hosted composition opens database/identity/role infrastructure, **no workspace or SessionRegistry at boot**. Each HTTP/fact/job callback binds its own request store; each socket keeps workspace id/cursor/scope only. Self-hosted assembles the same roles with SQLite and optional host daemon. Held RPC adapter is narrow and connection/request scoped; it must not force rebuilding a full registry. |
| 18. Boundary and census closure · 1–2d | 17; POD-7331 harness available. | **New** stateless-core guard/two-process tests under `apps/server/src`, boot-wiring probes, `scripts/server-test-shards.ts` if a new test file is added; this census status column/update. | Prove process A can stop after commit and B serves the next request/result without warm-up; verify no hosted boot workspace, no hidden graph allocation and zero raw terminal-frame SQL. Run each changed store test on both engines, appropriate multi-instance lane, and required lean/basic wiring per lane guide. Mark each ledger row carried out or explicitly held under the amendment. This is future implementation validation, not a test run for the present doc. |

Tasks 11 and 12 are separate caller cuts around the existing operation/claim port. Task 16
consumes already-converted job handlers; moving the handlers themselves remains in the job
issues named above. These bounds keep POD-7290 from duplicating sibling work.

### Hydration exit checklist for task 16

`SessionRegistry.hydrate` (`relay.ts:821–885`) currently sequences workspace work. Its
replacement must account for each call, not just remove the function name:

| Current call / source | Destination / green transition |
| --- | --- |
| `modules.sessions.loadFromStore()` (`relay.ts:826`) | Delete resident materialization; Q-session on demand. Its nested `repository.ts:1233` reads running/headless rows, checkpoints, offers, draft times and runtime turn state: those become request/fact reads. Restore retryable errored checkpoints by idempotent continuation jobs, not replay-driven side effects. Birth-ref data migration (`:1287`) becomes a receipt-backed migration job; orphan queued-row cleanup (`:1298`) becomes a sweep job. Live transcript replay remains held under POD-7333. |
| `machines.storeRecordChannel()` (`relay.ts:832`) | Read already-stored channel facts; any normalization/catch-up is a receipt-keyed job, not required first-request hydration. |
| `superagentDefaults.seed()` (`relay.ts:833`) | Idempotent job at workspace/member provisioning and inventory fact, unique seed key. |
| `syncTurnRunningWithPendingTurns()` (`relay.ts:836`) | Lease-aware assistant recovery job over indexed pending turns; cannot clear another process's running turn merely because it is not in a local Set. |
| `issues.recoverLegacyMembership()` (`relay.ts:842`) | Receipt-backed migration/recovery job for eligible rows; no hosted boot scan. |
| `issueSessionLifecycle.startClosedIssueSweep()` (`relay.ts:844`) | Shared closed-issue stop/sweep job, no per-registry interval. |
| `messages.reconcileQueued()` (`relay.ts:852`) | Durable queue recovery job; daemon result/bind facts re-schedule affected targets. |
| `store.sync.raiseEmptyHead()` (`relay.ts:862`) | Workspace provisioning/first-write invariant; no boot-owned reconstruction of a feed. |
| `effectsRunner.start()` (`relay.ts:866`) | Process worker starts once; per-workspace due effects are lease-owned jobs (POD-7294), no “not in my live map = crashed”. |
| `runtimeGateway.replayBoardProjection()` (`relay.ts:870`) | Cursor/checkpoint job; advance only in the transaction that commits projected facts. |
| `shipping.reconcile()` (`relay.ts:872`) | Durable custody/generation recovery job, no registry startup dependency. |
| `credentialHealth.checkExpiry()` (`relay.ts:874`) | Expiry job with due time and idempotent credential transition. |


### Green-tree and ownership rules

Before task 1 starts, the coordinator should replace POD-7290's brief with the accepted split
and create the task tree, attaching dependencies to tasks, not grouping phases. Rows for room,
operations, leases and job infrastructure have existing epic owners; send them the relevant
ledger ids and consume their ports rather than silently duplicate their work. POD-7289 is
already landed; POD-7484 remains the synchronous daemon-link settings cut. POD-6974 owns
remaining install file homes, and POD-7329/POD-7333 own the held transcript path.

At every intermediate commit: keep old public call signatures through an adapter when
needed, build new request context first, migrate a whole write/claim transaction, then delete
the old field for that family. A feature switch is not permission to keep two authorities.
Do not use a workspace placement/ownership lease, affinity or a reconstructed registry cache
to pass the new tests. Socket/grouping maps may be keyed by workspace only to serve local
connections and tail cursors; dropping all entries and reconnecting must recover from the log.
Durable machine/job lease writes stay outside the feed lock; workspace fact/mutation commits
remain short. No request makes a blocking machine call under a database transaction.

No merge, push, landing or issue close is part of this deliverable. No product test, benchmark
or lean gate was run: **documentation-only amendment**. Validation for this census was source
inspection, symbol/declaration accounting, source-anchor checking, ledger-count reconciliation
and Markdown/diff review. Future tasks require their own behavior tests and engine/lane checks.

## Field ledger

### relay.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0028 `relay.ts:684` **SessionRegistry.mobileVersions** | `MobileClientVersions` | constructor/callback, dispose | SessionRegistry consumers | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0029 `relay.ts:686` **SessionRegistry.topics** | `TopicRouting` | constructor/callback | SessionRegistry consumers | wiring/code only | **room** | live topic/reading producer alias; room/daemon live link, not Core settings/services |
| S0030 `relay.ts:688` **SessionRegistry.daemonLinks** | `DaemonLinks` | constructor/callback | constructor/callback, daemonLinkKind, condition, targetLinkKind | wiring/code only | **socket** | gateway socket-holder alias; per-connection routes construct request/fact context, never retain a workspace service graph |
| S0031 `relay.ts:690` **SessionRegistry.recoveryOnly** | `boolean` | constructor/callback | hydrate | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0032 `relay.ts:692` **SessionRegistry.capabilities** | `ServerCapabilities` | constructor/callback | constructor/callback | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0033 `relay.ts:694` **SessionRegistry.memberCredentials** | `MemberCredentials \| undefined` | constructor/callback | SessionRegistry consumers | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0034 `relay.ts:696` **SessionRegistry.bus** | `EventBus` | constructor/initializer | constructor/callback, onCrash, publish, onPublished, requestTelegram, onIssueCreated, onIssueWorktreeMoved | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0035 `relay.ts:698` **SessionRegistry.modules** | `RegistryModules` | constructor/callback | hydrate, constructor/callback, modules, pathExists, scanRepos, machineNames, afterSuccessfulReply, readUsage, dispose | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0036 `relay.ts:704` **SessionRegistry.repoDiscovery** | `MachineRepoDiscovery` | constructor/callback | constructor/callback | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0037 `relay.ts:711` **SessionRegistry.gateway** | `DaemonMux` | constructor/callback | SessionRegistry consumers | wiring/code only | **socket** | gateway socket-holder alias; per-connection routes construct request/fact context, never retain a workspace service graph |
| S0038 `relay.ts:721` **SessionRegistry.clientGateway** | `ClientMux` | constructor/callback | constructor/callback | wiring/code only | **socket** | gateway socket-holder alias; per-connection routes construct request/fact context, never retain a workspace service graph |
| S0039 `relay.ts:723` **SessionRegistry.issues** | `IssueService` | constructor/callback | SessionRegistry consumers | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0040 `relay.ts:725` **SessionRegistry.shipping** | `ShippingService` | constructor/callback, dispose | constructor/callback | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0041 `relay.ts:728` **SessionRegistry.issueCommands** | `IssueCommandDispatcher` | constructor/callback | SessionRegistry consumers | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0042 `relay.ts:731` **SessionRegistry.steward** | `StewardService` | constructor/callback, dispose | runStewardTick | work/claim/retry | **job** | background/boot/scheduled work handle; unique job key, guarded lease, due time and idempotent handler replace per-registry lifetime |
| S0043 `relay.ts:733` **SessionRegistry.eventRetention** | `EventLogRetention` | constructor/callback, dispose | SessionRegistry consumers | work/claim/retry | **job** | background/boot/scheduled work handle; unique job key, guarded lease, due time and idempotent handler replace per-registry lifetime |
| S0044 `relay.ts:741` **SessionRegistry.quotaSampler** | `QuotaSampler` | constructor/callback, dispose | constructor/callback, sample | work/claim/retry | **job** | background/boot/scheduled work handle; unique job key, guarded lease, due time and idempotent handler replace per-registry lifetime |
| S0045 `relay.ts:743` **SessionRegistry.accountQuota** | `AccountQuotaTopic` | constructor/callback, dispose | constructor/callback | wiring/code only | **room** | live topic/reading producer alias; room/daemon live link, not Core settings/services |
| S0046 `relay.ts:744` **SessionRegistry.accountUsage** | `AccountUsageTopic` | constructor/callback, dispose | constructor/callback | no independent truth | **delete** | account.usage live topic removed in favour of durable turn-fact usage buckets; held usageRequest conversion stays in POD-7333 |
| S0047 `relay.ts:747` **SessionRegistry.quotaBackfill** | `QuotaBackfill` | constructor/callback, dispose | constructor/callback | work/claim/retry | **job** | background/boot/scheduled work handle; unique job key, guarded lease, due time and idempotent handler replace per-registry lifetime |
| S0048 `relay.ts:749` **SessionRegistry.syncDelta** | `SyncDeltaPorts` | constructor/callback | writeReceiptNow | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0049 `relay.ts:750` **SessionRegistry.ledger** | `Ledger` | constructor/callback | changeLedger, writeReceiptNow | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0050 `relay.ts:753` **SessionRegistry.writes** | `WriteContexts` | constructor/callback | constructor/callback, deliverMenuText | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0051 `relay.ts:755` **SessionRegistry.machineRecordsDeps** | `() => MachineRecordsDeps & { reach: NonNullable<MachineRecordsDeps['reach']> }` | constructor/callback | constructor/callback | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0052 `relay.ts:759` **SessionRegistry.checkouts** | `CheckoutsService` | constructor/callback | constructor/callback | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0053 `relay.ts:764` **SessionRegistry.superagentDefaults** | `SuperagentDefaultSeeder` | constructor/callback | hydrate | work/claim/retry | **job** | background/boot/scheduled work handle; unique job key, guarded lease, due time and idempotent handler replace per-registry lifetime |
| S0054 `relay.ts:766` **SessionRegistry.messageSweep** | `ReturnType<typeof setInterval>` | constructor/callback, dispose | constructor/callback | work/claim/retry | **job** | background/boot/scheduled work handle; unique job key, guarded lease, due time and idempotent handler replace per-registry lifetime |
| S0055 `relay.ts:768` **SessionRegistry.concertmasterDelivered** | `DeliveredMessageWatch` | constructor/callback, dispose | SessionRegistry consumers | work/claim/retry | **job** | background/boot/scheduled work handle; unique job key, guarded lease, due time and idempotent handler replace per-registry lifetime |
| S0056 `relay.ts:770` **SessionRegistry.credentialExpirySweep** | `ReturnType<typeof setInterval>` | constructor/callback, dispose | constructor/callback | work/claim/retry | **job** | background/boot/scheduled work handle; unique job key, guarded lease, due time and idempotent handler replace per-registry lifetime |
| S0057 `relay.ts:774` **SessionRegistry.queuedInputSweep** | `ReturnType<typeof setInterval>` | constructor/callback, dispose | constructor/callback | work/claim/retry | **job** | background/boot/scheduled work handle; unique job key, guarded lease, due time and idempotent handler replace per-registry lifetime |
| S0058 `relay.ts:776` **SessionRegistry.pendingUploadSweep** | `ReturnType<typeof setInterval>` | constructor/callback, dispose | constructor/callback | work/claim/retry | **job** | background/boot/scheduled work handle; unique job key, guarded lease, due time and idempotent handler replace per-registry lifetime |
| S0059 `relay.ts:778` **SessionRegistry.issueAutoArchive** | `IssueAutoArchive` | constructor/callback, dispose | SessionRegistry consumers | work/claim/retry | **job** | background/boot/scheduled work handle; unique job key, guarded lease, due time and idempotent handler replace per-registry lifetime |
| S0060 `relay.ts:780` **SessionRegistry.issueGitWatch** | `IssueGitWatch` | constructor/callback, dispose | constructor/callback | work/claim/retry | **job** | background/boot/scheduled work handle; unique job key, guarded lease, due time and idempotent handler replace per-registry lifetime |
| S0061 `relay.ts:781` **SessionRegistry.effectsRunner** | `EffectsRunner` | constructor/callback | hydrate, constructor/callback, dispose | work/claim/retry | **job** | background/boot/scheduled work handle; unique job key, guarded lease, due time and idempotent handler replace per-registry lifetime |
| S0062 `relay.ts:783` **SessionRegistry.automationScheduler** | `AutomationScheduler` | constructor/callback, dispose | SessionRegistry consumers | work/claim/retry | **job** | background/boot/scheduled work handle; unique job key, guarded lease, due time and idempotent handler replace per-registry lifetime |
| S0063 `relay.ts:784` **SessionRegistry.store** | `SessionStore` | constructor/callback | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0064 `relay.ts:785` **SessionRegistry.now** | `() => number` | constructor/callback | constructor/callback, now, writeIdentity, record, retireNotificationFact, audit, createEffectInUnit | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0065 `relay.ts:786` **SessionRegistry.localDaemonPortableState** | `LocalPortableStateControl \| undefined` | attachLocalDaemonPortableState | daemon | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0066 `relay.ts:789` **SessionRegistry.adoptedSuperagent** | `SuperagentService \| undefined` | adoptSuperagent, dispose | SessionRegistry consumers | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0067 `relay.ts:790` **SessionRegistry.unsubscribeAccessChanges** | `(() => void) \| undefined` | constructor/callback | dispose | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0068 `relay.ts:792` **SessionRegistry.configChangedBridge** | `() => void` | constructor/callback | dispose | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0069 `relay.ts:794` **SessionRegistry.stopping** | `boolean` | dispose | startBackground, constructor/callback | wiring/code only | **delete** | per-workspace composition/callback alias; remove retained registry and construct needed service from request/job context; pointee is listed separately |
| S0070 `relay.ts:795` **SessionRegistry.backgroundTasks** | `Set<Promise<void>>` | constructor/callback, startBackground | dispose | work/claim/retry | **job** | background/boot/scheduled work handle; unique job key, guarded lease, due time and idempotent handler replace per-registry lifetime |

### modules/sessions/repository.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0933 `modules/sessions/repository.ts:147` **SessionRepository.sessionsGeneration_** | `number` | publishSessionProjection, captureVolatileEntries | sessionsGeneration | request/tx context | **delete** | process-owned session baseline, write tail, rollback repair or capture batching; use transaction-local drafts and database serialisation; no retained state |
| S0934 `modules/sessions/repository.ts:148` **SessionRepository.sessionProjectionListeners** | `Set<(event: SessionProjectionEvent) => void>` | onSessionProjection, constructor/callback | publishSessionProjection | request/tx context | **delete** | process-owned session baseline, write tail, rollback repair or capture batching; use transaction-local drafts and database serialisation; no retained state |
| S0935 `modules/sessions/repository.ts:149` **SessionRepository.volatileSessionMutationVersion** | `number` | markVolatileSessionDirty | persistDraftsUnlocked | request/tx context | **delete** | process-owned session baseline, write tail, rollback repair or capture batching; use transaction-local drafts and database serialisation; no retained state |
| S0936 `modules/sessions/repository.ts:150` **SessionRepository.pendingVolatileSessions** | `Map<SessionId, PendingVolatileState>` | markVolatileSessionDirty, captureVolatileEntries, constructor/callback, forget | repairRolledBack, hasPendingVolatile, markVolatileSessionDirty, drainVolatileCaptureSlice, captureVolatileEntries, flushVolatileSessionCaptures, constructor/callback, settled, forget | buffered value/order | **delete** | process-owned session baseline, write tail, rollback repair or capture batching; use transaction-local drafts and database serialisation; no retained state |
| S0937 `modules/sessions/repository.ts:158` **SessionRepository.sessionWriteTail** | `Map<SessionId, Promise<void>>` | enqueueSessionsWrite, constructor/callback | constructor/callback, settled | write/rollback order | **delete** | process-owned session baseline, write tail, rollback repair or capture batching; use transaction-local drafts and database serialisation; no retained state |
| S0938 `modules/sessions/repository.ts:159` **SessionRepository.sessionWriteScope** | `AsyncLocalStorage<ReadonlySet<SessionId>>` | constructor/callback | enqueueSessionsWrite | write/rollback order | **delete** | process-owned session baseline, write tail, rollback repair or capture batching; use transaction-local drafts and database serialisation; no retained state |
| S0939 `modules/sessions/repository.ts:161` **SessionRepository.draftOrigins** | `WeakMap<SessionDurableState, SessionDurableState>` | draft | resolvePersistedDraft | write/rollback order | **delete** | process-owned session baseline, write tail, rollback repair or capture batching; use transaction-local drafts and database serialisation; no retained state |
| S0940 `modules/sessions/repository.ts:191` **SessionRepository.capturedSessionStates** | `Map<SessionId, SessionDurableState>` | constructor/callback, forget | durableBaselineFor | answer/decision | **derived** | last committed durable session snapshots; Q-session (same transaction reads its own writes) |
| S0941 `modules/sessions/repository.ts:236` **SessionRepository.stagedSessionStates** | `StagedOverlay<SessionId, SessionDurableState>` | constructor/callback, commitDurableBaseline, forget | durableBaselineFor, settled, forget | write/rollback order | **delete** | process-owned session baseline, write tail, rollback repair or capture batching; use transaction-local drafts and database serialisation; no retained state |
| S0942 `modules/sessions/repository.ts:258` **SessionRepository.unreplayedTranscripts** | `Set<SessionId>` | constructor/callback, materializeStoredSessions, forget | ensureTranscript | no independent truth | **delete** | resident transcript replay bookkeeping; removal deferred to POD-7333/POD-7329, outside POD-7290 amendment |
| S0943 `modules/sessions/repository.ts:259` **SessionRepository.replayingTranscripts** | `Map<SessionId, Promise<void>>` | constructor/callback, ensureTranscript | ensureTranscript, replayingTranscript | no independent truth | **delete** | resident transcript replay bookkeeping; removal deferred to POD-7333/POD-7329, outside POD-7290 amendment |
| S0944 `modules/sessions/repository.ts:260` **SessionRepository.liveInstalls** | `Map< SessionId, { registration: ReturnType<BaselineFoldPort['onCommit']> fields: readonly (keyof SessionDurableState)[] }[] >` | repairRolledBack, constructor/callback, trackLiveInstall, forget | repairRolledBack, constructor/callback, trackLiveInstall | write/rollback order | **delete** | process-owned session baseline, write tail, rollback repair or capture batching; use transaction-local drafts and database serialisation; no retained state |
| S0945 `modules/sessions/repository.ts:268` **SessionRepository.flushingActivity** | `boolean` | flushActivity | flushActivity | request/tx context | **delete** | process-owned session baseline, write tail, rollback repair or capture batching; use transaction-local drafts and database serialisation; no retained state |
| S0946 `modules/sessions/repository.ts:269` **SessionRepository.activityMutationVersion** | `number` | constructor/callback | SessionRepository consumers | request/tx context | **delete** | process-owned session baseline, write tail, rollback repair or capture batching; use transaction-local drafts and database serialisation; no retained state |
| S0947 `modules/sessions/repository.ts:270` **SessionRepository.dirtyActivitySessions** | `Map<SessionId, number>` | constructor/callback, registerSession, flushActivity, evictResident | flushActivity, settled | buffered value/order | **delete** | process-owned session baseline, write tail, rollback repair or capture batching; use transaction-local drafts and database serialisation; no retained state |
| S0948 `modules/sessions/repository.ts:271` **SessionRepository.volatileSessionCaptureTimer** | `ReturnType<typeof setTimeout> \| null` | scheduleVolatileSessionCapture, constructor/callback, clearVolatileSessionCaptureTimer | scheduleVolatileSessionCapture, clearVolatileSessionCaptureTimer | request/tx context | **delete** | process-owned session baseline, write tail, rollback repair or capture batching; use transaction-local drafts and database serialisation; no retained state |
| S0949 `modules/sessions/repository.ts:272` **SessionRepository.VOLATILE_CAPTURE_RETRY_MS** | `number` | constructor/initializer | SessionRepository consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0950 `modules/sessions/repository.ts:273` **SessionRepository.VOLATILE_SLICE_MAX_ITEMS** | `number` | constructor/initializer | SessionRepository consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0951 `modules/sessions/repository.ts:274` **SessionRepository.VOLATILE_SLICE_MAX_CPU_MS** | `number` | constructor/initializer | SessionRepository consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0952 `modules/sessions/repository.ts:276` **SessionRepository.ports** | `SessionRepositoryPorts` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable policy/capability or callback; no row data; reconstruct with request/job context when graph is removed |
| S0953 `modules/sessions/repository.ts:381` **SessionRepository.toMachine** | `callback` | constructor/initializer | toDaemon | wiring/code only | **delete** | immutable policy/capability or callback; no row data; reconstruct with request/job context when graph is removed |
| S0954 `modules/sessions/repository.ts:383` **SessionRepository.broadcastSessions** | `callback` | constructor/initializer | constructor/callback | wiring/code only | **delete** | immutable policy/capability or callback; no row data; reconstruct with request/job context when graph is removed |
| S0955 `modules/sessions/repository.ts:384` **SessionRepository.now** | `callback` | constructor/initializer | markVolatileSessionDirty, captureVolatileEntries | wiring/code only | **delete** | immutable policy/capability or callback; no row data; reconstruct with request/job context when graph is removed |

### modules/sessions/residency.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0833 `modules/sessions/residency.ts:68` **SessionResidency.leases** | `Map<SessionId, number>` | acquire, acquireMany, hold, drop | acquire, acquireMany, hold, leased, drop | no independent truth | **delete** | residency/pin/loading/eviction machinery disappears when reads materialize request-local records |
| S0834 `modules/sessions/residency.ts:69` **SessionResidency.loading** | `Map<SessionId, Promise<Session \| undefined>>` | acquireMany, constructor/callback, ensure | constructor/callback, ensure, residentBecause | no independent truth | **delete** | residency/pin/loading/eviction machinery disappears when reads materialize request-local records |
| S0835 `modules/sessions/residency.ts:70` **SessionResidency.sweepTimer** | `ReturnType<typeof setInterval> \| null` | constructor/callback, dispose | constructor/callback, dispose | no independent truth | **delete** | residency/pin/loading/eviction machinery disappears when reads materialize request-local records |
| S0836 `modules/sessions/residency.ts:72` **SessionResidency.ports** | `SessionResidencyPorts` | constructor/initializer | evictsParked, constructor/callback, acquireMany, hold, ensure, load, loadMany, tryEvict, sweep, residentBecause | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/lifecycle.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0713 `modules/sessions/lifecycle.ts:151` **SessionLifecycle.sessions** | `Map<SessionId, Session>` | constructor/initializer | facts, constructor/callback, releaseShellTab, onSessionDaemonFrame | wiring/code only | **derived** | resident Session map alias; Q-session (data); terminal/controller state moves through the separate room rows |
| S0714 `modules/sessions/lifecycle.ts:153` **SessionLifecycle.clients** | `ClientRegistry` | constructor/initializer | broadcastToClients | wiring/code only | **socket** | gateway connection registry alias; socket lifetime only |
| S0715 `modules/sessions/lifecycle.ts:155` **SessionLifecycle.terminalProof** | `SessionTerminalProof` | constructor/initializer | hasValidTerminalProof, terminalProofMissing, terminalProofStatuses, terminalProofStatus | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0716 `modules/sessions/lifecycle.ts:157` **SessionLifecycle.machineReconciler** | `SessionMachineReconciler` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0717 `modules/sessions/lifecycle.ts:159` **SessionLifecycle.naming** | `SessionNaming` | constructor/initializer | constructor/callback | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0718 `modules/sessions/lifecycle.ts:161` **SessionLifecycle.launchConfig** | `SessionLaunchConfig` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0719 `modules/sessions/lifecycle.ts:163` **SessionLifecycle.sessionStart** | `SessionStart` | constructor/initializer | createSession, spawn | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0720 `modules/sessions/lifecycle.ts:165` **SessionLifecycle.sessionTeardown** | `SessionTeardown` | constructor/initializer | parkArchivedSession, retireArchivedSurvivor, constructor/callback, stopIssue, parkStaleSession, parkShellSession | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0721 `modules/sessions/lifecycle.ts:166` **SessionLifecycle.sessionKill** | `SessionKill` | constructor/initializer | releaseShellTab, removeSessionRuntime, constructor/callback, emitSessionExited | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0722 `modules/sessions/lifecycle.ts:167` **SessionLifecycle.sessionClientPlane** | `SessionClientPlane` | constructor/initializer | onMachineAttached, onMachineDetached, rebindHeadless, reestablishHeadless, onClientAttached, onRoomJoined, onClientReclaim, onClientDetached, onOpenUrl, onSessionClientFrame, onSessionClientInput | wiring/code only | **room** | live session/client/draft policy alias; room owns it, with no database access |
| S0723 `modules/sessions/lifecycle.ts:168` **SessionLifecycle.sessionAuthz** | `SessionAuthz` | constructor/initializer | authorizeQueuedInputAtApply, primeOwnerMemo, sessionOwner, mayReachSession, machineUseForClient, authorizeClientDrive, capabilityForSession, inboxPrincipalForCapability | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0724 `modules/sessions/lifecycle.ts:169` **SessionLifecycle.sessionMetaOps** | `SessionMetaOps` | constructor/initializer | prepareInboxSend, constructor/callback, continueSession, prepareIssueSessionDelete, prepareIssueSessionRestore, transcriptFor | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0725 `modules/sessions/lifecycle.ts:171` **SessionLifecycle.sessionRevival** | `SessionRevival` | constructor/initializer | resumeSession, explicitWakeSelection, findLiveByResume, constructor/callback, resurrectSession | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0726 `modules/sessions/lifecycle.ts:172` **SessionLifecycle.store** | `SessionStore` | constructor/initializer | launchCredential, sessionRowExists, desiredStateOf, releaseShellTab, worktreeForSession, exitedWithNothingQueued | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0727 `modules/sessions/lifecycle.ts:173` **SessionLifecycle.now** | `() => number` | constructor/initializer | releaseShellTab | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0728 `modules/sessions/lifecycle.ts:174` **SessionLifecycle.bus** | `EventBus` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0729 `modules/sessions/lifecycle.ts:175` **SessionLifecycle.machines** | `MachinesService` | constructor/initializer | toMachine, toPtyInput, machineUseGate | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0730 `modules/sessions/lifecycle.ts:176` **SessionLifecycle.toMachine** | `callback` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0731 `modules/sessions/lifecycle.ts:178` **SessionLifecycle.rpc** | `DaemonRpcService` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0732 `modules/sessions/lifecycle.ts:179` **SessionLifecycle.toPtyInput** | `callback` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0733 `modules/sessions/lifecycle.ts:181` **SessionLifecycle.headless** | `HeadlessService` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0734 `modules/sessions/lifecycle.ts:183` **SessionLifecycle.state** | `SessionStateService` | constructor/initializer | pushPriorities, sessionStateEnvelope, rearmUnread, releaseShellTab | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0735 `modules/sessions/lifecycle.ts:185` **SessionLifecycle.autoContinue** | `AutoContinueController` | dispose | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0736 `modules/sessions/lifecycle.ts:187` **SessionLifecycle.inbox** | `SessionInbox` | dispose | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0737 `modules/sessions/lifecycle.ts:188` **SessionLifecycle.sendText** | `SessionInbox['sendText']` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0738 `modules/sessions/lifecycle.ts:189` **SessionLifecycle.interruptText** | `SessionInbox['interruptText']` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0739 `modules/sessions/lifecycle.ts:190` **SessionLifecycle.interruptTurn** | `SessionInbox['interruptTurn']` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0740 `modules/sessions/lifecycle.ts:191` **SessionLifecycle.configureSession** | `SessionInbox['configureSession']` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0741 `modules/sessions/lifecycle.ts:192` **SessionLifecycle.queueText** | `SessionInbox['queueText']` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0742 `modules/sessions/lifecycle.ts:193` **SessionLifecycle.retractQueuedMessage** | `SessionInbox['retract']` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0743 `modules/sessions/lifecycle.ts:194` **SessionLifecycle.hasQueuedMessage** | `SessionInbox['hasQueuedMessage']` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0744 `modules/sessions/lifecycle.ts:195` **SessionLifecycle.queuedMessagePosition** | `SessionInbox['queuedMessagePosition']` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0745 `modules/sessions/lifecycle.ts:196` **SessionLifecycle.resumeAndSend** | `SessionInbox['resumeAndSend']` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0746 `modules/sessions/lifecycle.ts:197` **SessionLifecycle.answerAskUserQuestion** | `(input: { /** Whose write the answer's admission is (POD-6602). */ writer: SessionWriter interactionId?: string sessionId: SessionId choices?: AnswerChoice[] skip?: boolean prin…` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0747 `modules/sessions/lifecycle.ts:206` **SessionLifecycle.setSessionDraft** | `( input: { sessionId: SessionId; text: string }, fromClientId?: string, ) => void` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **room** | live session/client/draft policy alias; room owns it, with no database access |
| S0748 `modules/sessions/lifecycle.ts:210` **SessionLifecycle.draftRevision** | `SessionStateService['draftRevision']` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **room** | live session/client/draft policy alias; room owns it, with no database access |
| S0749 `modules/sessions/lifecycle.ts:215` **SessionLifecycle.funnel** | `WriteFunnel` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0750 `modules/sessions/lifecycle.ts:216` **SessionLifecycle.clientControl** | `SessionClientControl` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **room** | live session/client/draft policy alias; room owns it, with no database access |
| S0751 `modules/sessions/lifecycle.ts:217` **SessionLifecycle.daemonProjection** | `SessionDaemonProjection` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0752 `modules/sessions/lifecycle.ts:223` **SessionLifecycle.runtimeEventGate** | `RuntimeEventGate` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0753 `modules/sessions/lifecycle.ts:224` **SessionLifecycle.runtimeGateway** | `SessionRuntimeGateway` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0754 `modules/sessions/lifecycle.ts:228` **SessionLifecycle.turnPreviews** | `TurnPreviewAccumulator` | dispose | SessionLifecycle consumers | wiring/code only | **room** | live session/client/draft policy alias; room owns it, with no database access |
| S0755 `modules/sessions/lifecycle.ts:232` **SessionLifecycle.receiptSender** | `ReceiptSender` | constructor/initializer | constructor/callback | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0756 `modules/sessions/lifecycle.ts:247` **SessionLifecycle.receiptSend** | `callback` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0757 `modules/sessions/lifecycle.ts:269` **SessionLifecycle.interactionAnswer** | `NonNullable<import('./inbox').SessionInboxDeps['contractAnswer']>` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0758 `modules/sessions/lifecycle.ts:270` **SessionLifecycle.pendingQuestion** | `( sessionId: SessionId, ) => Promise<import('@podium/protocol').PendingInteractionWire \| null>` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0759 `modules/sessions/lifecycle.ts:273` **SessionLifecycle.interactionAsk** | `(msg: { sessionId: SessionId; interaction: PendingInteraction }) => void` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0760 `modules/sessions/lifecycle.ts:286` **SessionLifecycle.interactionTurn** | `(msg: { sessionId: SessionId; ev: TurnEvent; at: string }) => Promise<void>` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0761 `modules/sessions/lifecycle.ts:295` **SessionLifecycle.interactionResolved** | `(msg: { sessionId: SessionId; ev: InteractionEvent }) => Promise<void>` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0762 `modules/sessions/lifecycle.ts:296` **SessionLifecycle.daemonLifecycle** | `SessionDaemonLifecycle` | constructor/initializer | onSessionDaemonFrame, onSessionDaemonOutput | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0763 `modules/sessions/lifecycle.ts:297` **SessionLifecycle.workspace** | `SessionWorkspace` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0764 `modules/sessions/lifecycle.ts:298` **SessionLifecycle.view** | `SessionView` | constructor/initializer | listSessions, listSessionsForIssue, sessionById, sessionsById, sessionSpawnedBy | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0765 `modules/sessions/lifecycle.ts:299` **SessionLifecycle.repository** | `SessionRepository` | constructor/initializer | sessionsGeneration, onSessionProjection, persist, registerSession, flushActivity, loadFromStore | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0766 `modules/sessions/lifecycle.ts:301` **SessionLifecycle.records** | `SessionRecords` | constructor/initializer | facts, inboxPrincipalForSession, readSessionIssueId | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0767 `modules/sessions/lifecycle.ts:303` **SessionLifecycle.residency** | `SessionResidency` | dispose | leased, onSessionDaemonFrame | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0768 `modules/sessions/lifecycle.ts:304` **SessionLifecycle.broadcasts** | `SessionBroadcastCoordinator` | constructor/initializer | broadcastSessions, flushBroadcasts | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0769 `modules/sessions/lifecycle.ts:306` **SessionLifecycle.liveTopics** | `SessionLiveTopics` | constructor/initializer | broadcastSessions | wiring/code only | **room** | live session/client/draft policy alias; room owns it, with no database access |
| S0770 `modules/sessions/lifecycle.ts:307` **SessionLifecycle.browserOpen** | `BrowserOpenGateway` | dispose | SessionLifecycle consumers | wiring/code only | **room** | live session/client/draft policy alias; room owns it, with no database access |
| S0771 `modules/sessions/lifecycle.ts:308` **SessionLifecycle.bindingReceipts** | `SessionBindingReceipts` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0772 `modules/sessions/lifecycle.ts:310` **SessionLifecycle.concurrencyHistory** | `AgentConcurrencyHistory` | dispose | agentConcurrencyHistory | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0773 `modules/sessions/lifecycle.ts:311` **SessionLifecycle.contextReads** | `import('./context-reads').SessionContextReads` | dispose | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0774 `modules/sessions/lifecycle.ts:313` **SessionLifecycle.activityHistory** | `SessionActivityHistory` | dispose | sessionActivityHistory | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0775 `modules/sessions/lifecycle.ts:314` **SessionLifecycle.activityPublication** | `SessionActivityPublication` | constructor/initializer | flushActivity | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0776 `modules/sessions/lifecycle.ts:317` **SessionLifecycle.activityFlushTimer** | `ReturnType<typeof setInterval> \| undefined` | constructor/callback, dispose | SessionLifecycle consumers | no independent truth | **delete** | 12-second server activity coalescer; daemon coalesces and reports batch facts at source |
| S0777 `modules/sessions/lifecycle.ts:326` **SessionLifecycle.deps** | `SessionLifecycleDeps` | constructor/initializer | serverWriter, sessionStateEnvelope, issueForCwd, releaseShellTab | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0778 `modules/sessions/lifecycle.ts:551` **SessionLifecycle.factsReader** | `SessionFactsReader \| undefined` | facts | facts | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0779 `modules/sessions/lifecycle.ts:704` **SessionLifecycle.sessionStateRegistry** | `SessionStateRegistry \| undefined` | sessionStateEnvelope | sessionStateEnvelope | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0780 `modules/sessions/lifecycle.ts:716` **SessionLifecycle.mutations** | `MutationLedgerPort` | constructor/initializer | sessionStateEnvelope | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |
| S0781 `modules/sessions/lifecycle.ts:1017` **SessionLifecycle.machineUseGate** | `(caller: HandoffCaller) => Promise<AssertMachineUse>` | constructor/initializer | SessionLifecycle consumers | wiring/code only | **delete** | service/callback alias in resident session graph; request/job context replaces graph; pointee state is listed separately |

### modules/sessions/lifecycle-controller.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0966 `modules/sessions/lifecycle-controller.ts:154` **SessionLifecycleController.chains** | `Map<SessionId, Promise<ReconcileResult>>` | constructor/callback, start | reconcile, constructor/callback | work/claim/retry | **job** | desired-session reconciliation work; job keyed by session and desired revision, re-scheduled by observed facts |
| S0967 `modules/sessions/lifecycle-controller.ts:155` **SessionLifecycleController.again** | `Map<SessionId, ReconcileHint>` | reconcile, constructor/callback | reconcile, constructor/callback | work/claim/retry | **job** | desired-session reconciliation work; job keyed by session and desired revision, re-scheduled by observed facts |
| S0968 `modules/sessions/lifecycle-controller.ts:156` **SessionLifecycleController.outcomes** | `Map<SessionId, { revision: number; outcome: LifecycleOutcome }>` | pass | outcomeFor | answer/decision | **derived** | last outcome by desired revision; Q-session-control (new outcome persistence required) |
| S0969 `modules/sessions/lifecycle-controller.ts:158` **SessionLifecycleController.ports** | `LifecycleControllerPorts` | constructor/initializer | reconcileMachine, pass, act | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/inbox.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0956 `modules/sessions/inbox.ts:675` **SessionInbox.activeDrains** | `Set<SessionId>` | invalidateDrain, dispose, forwardShellRows | isDraining, holdsWork, forwardShellRows, isCurrent | work/claim/retry | **job** | queue drain ownership/generation; guarded job lease per session, dispatch operations in a short transaction |
| S0957 `modules/sessions/inbox.ts:677` **SessionInbox.sweepingQueuedInputs** | `boolean` | sweepQueuedInputs | sweepQueuedInputs | work/claim/retry | **job** | queue drain ownership/generation; guarded job lease per session, dispatch operations in a short transaction |
| S0958 `modules/sessions/inbox.ts:679` **SessionInbox.drainGenerations** | `Map<SessionId, number>` | invalidateDrain, forwardShellRows | invalidateDrain, forwardShellRows, isCurrent | work/claim/retry | **job** | queue drain ownership/generation; guarded job lease per session, dispatch operations in a short transaction |
| S0959 `modules/sessions/inbox.ts:681` **SessionInbox.reportedPromptFailures** | `Set<string>` | settleDelivered, reportContractUnconfirmed, reportShellBlocked | reportContractUnconfirmed, reportShellBlocked | answer/decision | **derived** | delivery/failure duplicate suppression; Q-message; unique result/failure identity must commit with status |
| S0960 `modules/sessions/inbox.ts:683` **SessionInbox.disposed** | `boolean` | dispose | current, drain, isCurrent | no independent truth | **delete** | repository/service lifecycle wiring; request/job context replaces long-lived instance |
| S0961 `modules/sessions/inbox.ts:685` **SessionInbox.deps** | `SessionInboxDeps` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | no independent truth | **delete** | repository/service lifecycle wiring; request/job context replaces long-lived instance |
| S0962 `modules/sessions/inbox.ts:1401` **SessionInbox.forwardedRows** | `Map< SessionId, { session: Session; machineId: string; ids: Set<string> } >` | dispose, markSessionBound, forwardContractRows, run | withdrawn, run, current, settleDelivered, settleDeliveryOutcome | acceptance/result | **operation** | queued prompt/interrupt/delivery request tracking; use stable operation ids and idempotent result facts, not local delivery memory |
| S0963 `modules/sessions/inbox.ts:1405` **SessionInbox.forwarding** | `Map<SessionId, Promise<void>>` | markSessionBound, forwardContractRows | holdsWork, forwardContractRows | acceptance/result | **operation** | queued prompt/interrupt/delivery request tracking; use stable operation ids and idempotent result facts, not local delivery memory |
| S0964 `modules/sessions/inbox.ts:1728` **SessionInbox.settlingDeliveries** | `Map<string, Promise<void>>` | deliveryOutcome | deliveryOutcome | acceptance/result | **operation** | queued prompt/interrupt/delivery request tracking; use stable operation ids and idempotent result facts, not local delivery memory |
| S0965 `modules/sessions/inbox.ts:1740` **SessionInbox.settledQueueRowIds** | `Set<string>` | settleDeliveryOutcome | settleDeliveryOutcome | answer/decision | **derived** | delivery/failure duplicate suppression; Q-message; unique result/failure identity must commit with status |

### modules/sessions/terminal.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0782 `modules/sessions/terminal.ts:264` **SessionTerminal.geometry** | `Geometry` | constructor/callback, applyDaemonGeometry | attachClient, detachClient, revokeController, requestControl, applyDaemonGeometry, serveOwed | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0783 `modules/sessions/terminal.ts:265` **SessionTerminal.epoch** | `number` | requestControl | attachClient, outputItem, sendOutput | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0784 `modules/sessions/terminal.ts:276` **SessionTerminal.lastForwarded** | `Geometry \| undefined` | reconcile, bind | reconcile | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0785 `modules/sessions/terminal.ts:282` **SessionTerminal.requestsGated** | `number` | state | state | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0786 `modules/sessions/terminal.ts:284` **SessionTerminal.controllerId** | `string \| null` | reassignController, setAgentController, setController, clearController | attachClient, reassignController, detachClient, handleInputBytes, revokeController, state, reconcile, requestControl, redrawRequest | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0787 `modules/sessions/terminal.ts:289` **SessionTerminal.controllerIdentity** | `PresenceIdentity \| null` | reassignController, setAgentController, setController, clearController | attachClient, detachClient, revokeController, requestControl | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0788 `modules/sessions/terminal.ts:294` **SessionTerminal.lastInputAttribution** | `Attribution \| null` | handleInputBytes, noteInputAttribution, setAgentController | SessionTerminal consumers | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0789 `modules/sessions/terminal.ts:296` **SessionTerminal.outputAtMs_** | `number` | constructor/callback, acceptOutput | lastOutputAtMs | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0790 `modules/sessions/terminal.ts:297` **SessionTerminal.inputAtMs_** | `number` | constructor/callback, recordInputActivity | constructor/callback, lastInputAtMs | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0791 `modules/sessions/terminal.ts:298` **SessionTerminal.userInputAtMs_** | `number` | constructor/callback, recordInputActivity | lastUserInputAtMs | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0792 `modules/sessions/terminal.ts:299` **SessionTerminal.resumedAtMs_** | `number` | constructor/callback, recordResumeActivity | lastResumedAtMs | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0793 `modules/sessions/terminal.ts:300` **SessionTerminal.inputCount_** | `number` | constructor/callback, recordInputActivity | inputCount | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0794 `modules/sessions/terminal.ts:301` **SessionTerminal.outputCount_** | `number` | constructor/callback, acceptOutput | outputCount, attachClient | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0795 `modules/sessions/terminal.ts:302` **SessionTerminal.activityCount_** | `number` | constructor/callback, recordResumeActivity, recordInputActivity, recordObservationActivity | activityCount | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0796 `modules/sessions/terminal.ts:303` **SessionTerminal.activityDirty_** | `boolean` | clearActivityDirty, markActivityDirty | activityDirty, setActivityDirtyListener | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0797 `modules/sessions/terminal.ts:304` **SessionTerminal.activityDirtyListener** | `(() => void) \| undefined` | setActivityDirtyListener | markActivityDirty | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0798 `modules/sessions/terminal.ts:308` **SessionTerminal.liveListener** | `(() => void) \| undefined` | setLiveListener | liveChanged | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0799 `modules/sessions/terminal.ts:309` **SessionTerminal.shellBusy_** | `boolean` | stopOutput, markShellBusy, constructor/callback | busy, markShellBusy | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0800 `modules/sessions/terminal.ts:310` **SessionTerminal.shellBusyTimer** | `ReturnType<typeof setTimeout> \| undefined` | stopOutput, markShellBusy | stopOutput, markShellBusy | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0801 `modules/sessions/terminal.ts:311` **SessionTerminal.shellCommandRunning** | `boolean` | handleInputBytes, stopOutput, constructor/callback | acceptOutput | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0802 `modules/sessions/terminal.ts:312` **SessionTerminal.nextSeq** | `number` | acceptOutput, acceptPicture | SessionTerminal consumers | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0803 `modules/sessions/terminal.ts:330` **SessionTerminal.watchLevelSent** | `'coarse' \| 'fine'` | reconcileWatchLevel, resetWatchLevel | reconcileWatchLevel | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0804 `modules/sessions/terminal.ts:331` **SessionTerminal.clients** | `Map<string, ClientConn>` | attachClient, detachClient, detachAll | clientCount, reassignController, detachClient, detachAll, handleViewportRequest, handleResize, reconcile, activeNativeRenderers, requestControl, redrawRequest, acceptOutput, oweAll, markOwed, serveOwed, broadcast | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0805 `modules/sessions/terminal.ts:332` **SessionTerminal.clientAttributions** | `WeakMap<ClientConn, ReturnType<typeof perfPrincipal>>` | clientAttribution | clientAttribution | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0806 `modules/sessions/terminal.ts:333` **SessionTerminal.transcript** | `TranscriptItem[]` | applyDelta | subscribeTranscript, transcriptItems, applyDelta | held history merge | **delete** | history/replay buffers, not disposable room authority; keep existing path until POD-7329/POD-7333 approves replacement |
| S0807 `modules/sessions/terminal.ts:336` **SessionTerminal.runtimeTranscript** | `TranscriptItem[]` | applyRuntimeDelta | runtimeTranscriptItems, applyRuntimeDelta, applyDelta | held history merge | **delete** | history/replay buffers, not disposable room authority; keep existing path until POD-7329/POD-7333 approves replacement |
| S0808 `modules/sessions/terminal.ts:337` **SessionTerminal.transcriptAvailable** | `boolean` | applyDelta, setTranscriptAvailable | applyDelta | held history merge | **delete** | history/replay buffers, not disposable room authority; keep existing path until POD-7329/POD-7333 approves replacement |
| S0809 `modules/sessions/terminal.ts:338` **SessionTerminal.transcriptSubscribers** | `Map<string, ClientConn>` | subscribeTranscript, unsubscribeTranscript, detachClient, detachAll | reconcileWatchLevel, applyTurnPreview, applyDelta | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0810 `modules/sessions/terminal.ts:349` **SessionTerminal.turnPreview** | `TurnPreviewMessage \| undefined` | applyTurnPreview, detachAll | subscribeTranscript | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0811 `modules/sessions/terminal.ts:357` **SessionTerminal.pictures** | `boolean \| undefined` | setPictures, linkDetached | hasBoundPty, markOwed, serveOwed, dropHandler, nudgeStale | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0812 `modules/sessions/terminal.ts:359` **SessionTerminal.exited** | `boolean` | stopOutput, bind | hasBoundPty, linkDetached, nudgeStale | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0813 `modules/sessions/terminal.ts:360` **SessionTerminal.pictureCache** | `PictureCache` | constructor/callback | acceptOutput, setPictures, acceptPicture, linkDetached, serveOwed, serve, finish, next, cancel, nudgeStale | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0814 `modules/sessions/terminal.ts:361` **SessionTerminal.owed** | `Map<string, OwedViewer>` | markOwed, release, serveOwed, finish | detachAll, acceptOutput, setPictures, markOwed, release, serveOwed, finish, nudgeStale | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0815 `modules/sessions/terminal.ts:362` **SessionTerminal.dropHandlers** | `WeakMap<ClientConn, () => void>` | dropHandler | dropHandler | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0816 `modules/sessions/terminal.ts:363` **SessionTerminal.nudgeTimer** | `ReturnType<typeof setTimeout> \| undefined` | armNudge, constructor/callback, stopNudge | armNudge, stopNudge | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0817 `modules/sessions/terminal.ts:365` **SessionTerminal.init** | `SessionTerminalInit` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/session.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0848 `modules/sessions/session.ts:267` **Session.sessionId** | `SessionId` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | onExit, markSpawnError, toRow; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0849 `modules/sessions/session.ts:269` **Session.ownerUserId** | `UserId` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | toRow; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0850 `modules/sessions/session.ts:270` **Session.agentKind** | `AgentKind` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | toRow; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0851 `modules/sessions/session.ts:274` **Session.cwd** | `string` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0852 `modules/sessions/session.ts:275` **Session.origin** | `SessionOrigin` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | toRow; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0853 `modules/sessions/session.ts:276` **Session.createdAt** | `string` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | toRow; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0854 `modules/sessions/session.ts:277` **Session.durableLabel** | `string` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | toRow; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0855 `modules/sessions/session.ts:279` **Session.spawnedBy** | `string \| undefined` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | toRow; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0856 `modules/sessions/session.ts:282` **Session.delegation** | `import('@podium/model').SessionDelegation \| undefined` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | toRow; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0857 `modules/sessions/session.ts:283` **Session.createdBy** | `Attribution \| undefined` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | toRow; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0858 `modules/sessions/session.ts:285` **Session.model** | `string \| undefined` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | toRow; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0859 `modules/sessions/session.ts:286` **Session.effort** | `string \| undefined` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | toRow; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0860 `modules/sessions/session.ts:287` **Session.accountId** | `AccountId \| undefined` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | toRow; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0861 `modules/sessions/session.ts:290` **Session.credentialId** | `CredentialId \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0862 `modules/sessions/session.ts:292` **Session.loginHarness** | `HarnessAgent \| undefined` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | toRow; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0863 `modules/sessions/session.ts:294` **Session.workflowRunId** | `string \| undefined` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | toRow; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0864 `modules/sessions/session.ts:295` **Session.workflowStepId** | `string \| undefined` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | toRow; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0865 `modules/sessions/session.ts:296` **Session.agentProfileId** | `string \| undefined` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | toRow; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0866 `modules/sessions/session.ts:298` **Session.headless** | `boolean` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | toRow; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0867 `modules/sessions/session.ts:301` **Session.issueId** | `IssueId \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0868 `modules/sessions/session.ts:304` **Session.refIssueId** | `IssueId \| null` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0869 `modules/sessions/session.ts:306` **Session.refLetter** | `string \| null` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0870 `modules/sessions/session.ts:308` **Session.refDraft** | `number \| null` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0871 `modules/sessions/session.ts:312` **Session.machineId** | `MachineId` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0872 `modules/sessions/session.ts:329` **Session.resumeRef** | `ResumeRef \| undefined` | resume, constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | resume; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0873 `modules/sessions/session.ts:360` **Session.conversationBinding** | `ConversationBinding \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0874 `modules/sessions/session.ts:361` **Session.lastActiveAt** | `string` | onActivity, constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0875 `modules/sessions/session.ts:362` **Session.title** | `string` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0876 `modules/sessions/session.ts:366` **Session.titleLocked** | `boolean` | adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | prompt-title fallback suppression; Q-session-control (currently live-only, add durable field or prove derivation before removal) |
| S0877 `modules/sessions/session.ts:368` **Session.name** | `inferred value/definition` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0878 `modules/sessions/session.ts:372` **Session.nameSource** | `'user' \| 'agent' \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0879 `modules/sessions/session.ts:373` **Session.archived** | `boolean` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0880 `modules/sessions/session.ts:375` **Session.concertmaster** | `boolean` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0881 `modules/sessions/session.ts:377` **Session.onUnreadRearm** | `(() => void) \| undefined` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | onExit, markSpawnError; session-record projections, lifecycle/inbox callers | request/tx context | **delete** | callbacks into resident mutation/rollback machinery; use request/fact transaction and after-commit log tail |
| S0882 `modules/sessions/session.ts:379` **Session.stoppedAt** | `string \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | recordOomKill, captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0883 `modules/sessions/session.ts:380` **Session.stopReason** | `'self' \| 'parent' \| 'forced' \| 'exited' \| 'oom' \| undefined` | constructor/callback, recordOomKill, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | recordOomKill, captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0884 `modules/sessions/session.ts:405` **Session.oomKilledAt** | `string \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0885 `modules/sessions/session.ts:406` **Session.workState** | `WorkState \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0886 `modules/sessions/session.ts:407` **Session.lifecycle** | `SessionLifecycleRow` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0887 `modules/sessions/session.ts:408` **Session.cmd** | `inferred value/definition` | adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | live correctness | **room** | live context/terminal/command reading; Core receives durable facts separately and never reads this room state |
| S0888 `modules/sessions/session.ts:409` **Session.status** | `'starting' \| 'live' \| 'hibernated' \| 'exited'` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | recordOomKill, markAwaitingRebind, captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0889 `modules/sessions/session.ts:410` **Session.exitCode** | `number \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0890 `modules/sessions/session.ts:412` **Session.spawnFailure** | `string \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0891 `modules/sessions/session.ts:413` **Session.agentState** | `AgentRuntimeState \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0892 `modules/sessions/session.ts:419` **Session.workingMsTotal** | `number \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0893 `modules/sessions/session.ts:420` **Session.incomingWorkingMsTotal** | `number \| undefined` | adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | buffered value/order | **delete** | process-local cumulative counter baseline; producer emits generation-keyed totals/turn facts with idempotent receipt rather than Core accumulator |
| S0894 `modules/sessions/session.ts:423` **Session.agentColor** | `string \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0895 `modules/sessions/session.ts:428` **Session.observedModel** | `string \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0896 `modules/sessions/session.ts:431` **Session.observedEffort** | `string \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0897 `modules/sessions/session.ts:434` **Session.observedMode** | `string \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0898 `modules/sessions/session.ts:438` **Session.launchPosture** | `LaunchPostureReport \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0899 `modules/sessions/session.ts:442` **Session.requestedModel** | `string \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0900 `modules/sessions/session.ts:443` **Session.requestedEffort** | `string \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0901 `modules/sessions/session.ts:447` **Session.effectiveAuth** | `EffectiveAuth \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0902 `modules/sessions/session.ts:449` **Session.credentialMismatch** | `CredentialMismatch \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0903 `modules/sessions/session.ts:456` **Session.contextObservation** | `ContextObservation \| undefined` | setContextObservation, markContextOffline; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | beginContextBootstrap, contextUsagePercent, setContextObservation, markContextOffline, setContextUsagePercent; session-record projections, lifecycle/inbox callers | live correctness | **room** | live context/terminal/command reading; Core receives durable facts separately and never reads this room state |
| S0904 `modules/sessions/session.ts:457` **Session.legacyContextUsagePercent** | `number \| undefined` | setContextObservation, setContextUsagePercent; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | contextUsagePercent, setContextUsagePercent; session-record projections, lifecycle/inbox callers | live correctness | **room** | live context/terminal/command reading; Core receives durable facts separately and never reads this room state |
| S0905 `modules/sessions/session.ts:459` **Session.contextAuthority** | `{ epoch: number verified: boolean pending: boolean scope?: { bindingVersion: number; observerGeneration: number } /** Unsupported descriptors carry no revision; retain only thei…` | beginContextBootstrap, confirmContextBootstrap, markContextOffline; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | contextAuthorityNeedsRefresh, beginContextBootstrap, confirmContextBootstrap, finishContextBootstrap, contextBootstrapPending, contextAdmissionMatches, setContextObservation, markContextOffline; session-record projections, lifecycle/inbox callers | live correctness | **room** | live context/terminal/command reading; Core receives durable facts separately and never reads this room state |
| S0906 `modules/sessions/session.ts:654` **Session.handoffTargetMachineId** | `MachineId \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0907 `modules/sessions/session.ts:658` **Session.conversationPodiumId** | `ConversationId \| undefined` | adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | conversation identity/availability; Q-conversation; transcript decision held, no invented chat-copy schema |
| S0908 `modules/sessions/session.ts:663` **Session.draftUpdatedAt** | `string \| undefined` | adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | saved composer edit time; Q-draft |
| S0909 `modules/sessions/session.ts:686` **Session.hasBoundDriver** | `boolean` | constructor/initializer; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | Session consumers; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | binding capabilities used for durable dispatch; Q-binding (new report persisted/fenced by machine lease generation; no inference of liveness from a historical bind) |
| S0910 `modules/sessions/session.ts:698` **Session.awaitingRebind** | `boolean` | constructor/callback, markLive, markAwaitingRebind; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | Session consumers; session-record projections, lifecycle/inbox callers | work/claim/retry | **job** | machine reconnect/session reconcile intent; row-backed reconciliation job, keyed by desired revision |
| S0911 `modules/sessions/session.ts:702` **Session.driverId** | `string \| undefined` | markSpawnError; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | Session consumers; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | binding capabilities used for durable dispatch; Q-binding (new report persisted/fenced by machine lease generation; no inference of liveness from a historical bind) |
| S0912 `modules/sessions/session.ts:713` **Session.selectedDriverId** | `string \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState, reattachDriverRequest, lifecycleDriverRequest; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0913 `modules/sessions/session.ts:716` **Session.requestedDriverId** | `string \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState, reattachDriverRequest, lifecycleDriverRequest; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0914 `modules/sessions/session.ts:723` **Session.boundDriverId** | `string \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0915 `modules/sessions/session.ts:725` **Session.boundDriverCapabilities** | `SessionDriverCapabilities \| undefined` | constructor/callback, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | session durable identity/state; Q-session; read once per request/fact transaction, never once per terminal frame |
| S0916 `modules/sessions/session.ts:741` **Session.configureFields** | `readonly string[] \| undefined` | markSpawnError; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | Session consumers; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | binding capabilities used for durable dispatch; Q-binding (new report persisted/fenced by machine lease generation; no inference of liveness from a historical bind) |
| S0917 `modules/sessions/session.ts:742` **Session.attachKinds** | `readonly ('engine' \| 'client')[] \| undefined` | markSpawnError; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | Session consumers; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | binding capabilities used for durable dispatch; Q-binding (new report persisted/fenced by machine lease generation; no inference of liveness from a historical bind) |
| S0918 `modules/sessions/session.ts:747` **Session.offer** | `SessionOffer \| undefined` | adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | agent action offer and artifacts; Q-offer |
| S0919 `modules/sessions/session.ts:749` **Session.transcriptAvailable** | `boolean` | onTranscriptAvailable, adoptDurableFields; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | captureDurableState; session-record projections, lifecycle/inbox callers | answer/decision | **derived** | conversation identity/availability; Q-conversation; transcript decision held, no invented chat-copy schema |
| S0920 `modules/sessions/session.ts:750` **Session.terminal** | `SessionTerminal` | constructor/callback; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | markResumed, onExit, markSpawnError, markLive, adoptDurableFields, toRow; session-record projections, lifecycle/inbox callers | live correctness | **room** | live context/terminal/command reading; Core receives durable facts separately and never reads this room state |
| S0921 `modules/sessions/session.ts:1137` **Session.NO_COLOR** | `Set` | constructor/initializer; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | Session consumers; session-record projections, lifecycle/inbox callers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0922 `modules/sessions/session.ts:1444` **Session.durableRepair** | `(() => void) \| undefined` | setDurableRepair; command/fact draft writers in session-meta-ops, daemon-lifecycle and daemon-projection | freshenDurable; session-record projections, lifecycle/inbox callers | request/tx context | **delete** | callbacks into resident mutation/rollback machinery; use request/fact transaction and after-commit log tail |

### modules/machines/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1429 `modules/machines/service.ts:451` **MachineHomeUnavailableError.machineId** | `MachineId` | constructor/initializer | MachineHomeUnavailableError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1430 `modules/machines/service.ts:452` **MachineHomeUnavailableError.machineName** | `string` | constructor/initializer | MachineHomeUnavailableError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1431 `modules/machines/service.ts:453` **MachineHomeUnavailableError.reason** | `'offline' \| 'home-unreported'` | constructor/initializer | MachineHomeUnavailableError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1432 `modules/machines/service.ts:467` **MachinesService.spaceRequests** | `UpdateSpaceRequests` | dispose | checkUpdateSpace, recordUpdateSpaceResult | acceptance/result | **operation** | offline control deliveries and update-space requests; operation kind declares now/queued and deadline; preserve legacy update exception |
| S1433 `modules/machines/service.ts:490` **MachinesService.availabilityEpoch** | `inferred value/definition` | constructor/initializer | observedAvailability | answer/decision | **derived** | process-local availability epoch cannot fence another Core process; Q-lease generation (new) |
| S1434 `modules/machines/service.ts:491` **MachinesService.availabilityWrites** | `Promise<void>` | recordAvailability | recordAvailability | request/tx context | **delete** | process-only serialisation/deduplication hint; DB transaction and stable report id/source coalescing replace it |
| S1435 `modules/machines/service.ts:559` **MachinesService.daemons** | `Map<string, DaemonControlPeer>` | retireIncarnation, attach, detach | instance methods/callbacks (field-specific accesses in this source) | connection/order only | **socket** | connected daemon/supervisor sends, handshake capabilities, credential-close registrations; delete on detach/incarnation change; update notice/grant path remains exempt |
| S1436 `modules/machines/service.ts:563` **MachinesService.daemonCaps** | `Map<string, ReadonlySet<string>>` | retireIncarnation, attach, detach | daemonSupports | connection/order only | **socket** | connected daemon/supervisor sends, handshake capabilities, credential-close registrations; delete on detach/incarnation change; update notice/grant path remains exempt |
| S1437 `modules/machines/service.ts:565` **MachinesService.supervisors** | `Map< string, { send: Send<MachineSupervisorControlMessage> build: PeerBuild caps: string[] /** This attachment's incarnation — the half of the fence attach reads. */ generation:…` | retireIncarnation, attachSupervisor, detachSupervisor | instance methods/callbacks (field-specific accesses in this source) | connection/order only | **socket** | connected daemon/supervisor sends, handshake capabilities, credential-close registrations; delete on detach/incarnation change; update notice/grant path remains exempt |
| S1438 `modules/machines/service.ts:576` **MachinesService.updateParticipants** | `Map< string, Send<Extract<ControlMessage, { type: 'updateGrant' }>> >` | retireIncarnation, attachUpdateParticipant, detachUpdateParticipant | attachUpdateParticipant, detachUpdateParticipant, isMachineOnline, toMachine | connection/order only | **socket** | connected daemon/supervisor sends, handshake capabilities, credential-close registrations; delete on detach/incarnation change; update notice/grant path remains exempt |
| S1439 `modules/machines/service.ts:581` **MachinesService.daemonReadiness** | `Map<string, DaemonReadiness>` | retireIncarnation, attach, detach, recordDaemonReadiness | capabilityFacts, condition, recordDaemonReadiness | live correctness | **room** | daemon live readiness/connectivity/grace reading; durable admission uses Q-lease, last-seen transitions are stored facts |
| S1440 `modules/machines/service.ts:582` **MachinesService.inventoryPending** | `Set<string>` | retireIncarnation, attach, detach, persistInventory | waitForInventory, machineHome, capabilityFacts | work/claim/retry | **job** | follow-up waiting for inventory/fence release; retain unacked fact at producer, persist dependent job instead of waiting request |
| S1441 `modules/machines/service.ts:583` **MachinesService.inventoryWaiters** | `Map<string, Set<() => void>>` | constructor/callback, settleInventoryWaiters | constructor/callback, settleInventoryWaiters | work/claim/retry | **job** | follow-up waiting for inventory/fence release; retain unacked fact at producer, persist dependent job instead of waiting request |
| S1442 `modules/machines/service.ts:585` **MachinesService.legacyBuilds** | `Map<string, { build: PeerBuild; caps: string[] }>` | retireIncarnation, recordLegacyBuild | detachSupervisor | connection/order only | **socket** | connected daemon/supervisor sends, handshake capabilities, credential-close registrations; delete on detach/incarnation change; update notice/grant path remains exempt |
| S1443 `modules/machines/service.ts:586` **MachinesService.presenceGraceUntil** | `Map<string, number>` | clearPresenceGrace, beginPresenceGrace, constructor/callback | isMachineOnline | live correctness | **room** | daemon live readiness/connectivity/grace reading; durable admission uses Q-lease, last-seen transitions are stored facts |
| S1444 `modules/machines/service.ts:587` **MachinesService.presenceGraceTimers** | `Map<string, ReturnType<typeof setTimeout>>` | clearPresenceGrace, constructor/callback, beginPresenceGrace | clearPresenceGrace | live correctness | **room** | daemon live readiness/connectivity/grace reading; durable admission uses Q-lease, last-seen transitions are stored facts |
| S1445 `modules/machines/service.ts:597` **MachinesService.pendingByMachine** | `Map<string, PendingDaemonDelivery[]>` | retireIncarnation, fenceQueued, flushQueued, toMachine, toPtyInput | attach, fenceQueued, flushQueued, toMachine, toPtyInput | acceptance/result | **operation** | offline control deliveries and update-space requests; operation kind declares now/queued and deadline; preserve legacy update exception |
| S1446 `modules/machines/service.ts:605` **MachinesService.deferredInventoryByMachine** | `Map< MachineId, { json: string; descriptors: HarnessDescriptorWire[] } >` | recordInventory, resumeAfterTransferFence | resumeAfterTransferFence | work/claim/retry | **job** | follow-up waiting for inventory/fence release; retain unacked fact at producer, persist dependent job instead of waiting request |
| S1447 `modules/machines/service.ts:615` **MachinesService.harnessDescriptorsByMachine** | `Map<MachineId, HarnessDescriptorWire[]>` | retireIncarnation, persistInventory | harnessDescriptorsFor | answer/decision | **derived** | reported harness descriptors; Q-machine-facts (not currently persisted by setMachineInventory; add fact field) |
| S1448 `modules/machines/service.ts:617` **MachinesService.lastInventoryJsonByMachine** | `Map<MachineId, string>` | retireIncarnation, persistInventory | persistInventory | request/tx context | **delete** | process-only serialisation/deduplication hint; DB transaction and stable report id/source coalescing replace it |
| S1449 `modules/machines/service.ts:624` **MachinesService.revokedMachines** | `Set<MachineId>` | applyMachineWrite | checkUpdateSpace, registerCredentialConnection, applyMachineWrite, attach, attachSupervisor, toMachine, toPtyInput | answer/decision | **derived** | revocation and enrollment credential generation used to fence dispatch; Q-machines; durable write must notify socket holders |
| S1450 `modules/machines/service.ts:625` **MachinesService.credentialEpochs** | `Map<MachineId, number>` | applyMachineWrite | credentialFence, constructor/callback, applyMachineWrite | answer/decision | **derived** | revocation and enrollment credential generation used to fence dispatch; Q-machines; durable write must notify socket holders |
| S1451 `modules/machines/service.ts:626` **MachinesService.credentialConnections** | `Map<MachineId, Set<() => void>>` | registerCredentialConnection, constructor/callback, retireIncarnation | registerCredentialConnection, retireIncarnation | connection/order only | **socket** | connected daemon/supervisor sends, handshake capabilities, credential-close registrations; delete on detach/incarnation change; update notice/grant path remains exempt |
| S1452 `modules/machines/service.ts:669` **MachinesService.enrollmentHost** | `EnrollmentHost` | constructor/callback | mintClientRegistrationCode, mintReplacementPairingCode, authenticateDaemon, transferOwnership, transferMachineOwnership, supersedeMachine, adoptMachine, effectiveOwner, revokeMachine | no independent truth | **delete** | long-lived service wiring; build request operation publisher, room input transport or enrollment port at boundary |
| S1453 `modules/machines/service.ts:671` **MachinesService.unsubscribeMachineWrites** | `() => void` | constructor/callback | dispose | connection/order only | **socket** | connected daemon/supervisor sends, handshake capabilities, credential-close registrations; delete on detach/incarnation change; update notice/grant path remains exempt |
| S1454 `modules/machines/service.ts:673` **MachinesService.deps** | `MachinesDeps` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | no independent truth | **delete** | long-lived service wiring; build request operation publisher, room input transport or enrollment port at boundary |
| S1455 `modules/machines/service.ts:1176` **MachinesService.toMachine** | `callback` | constructor/initializer | waitForInventory | no independent truth | **delete** | long-lived service wiring; build request operation publisher, room input transport or enrollment port at boundary |
| S1456 `modules/machines/service.ts:1272` **MachinesService.toPtyInput** | `callback` | constructor/initializer | MachinesService consumers | no independent truth | **delete** | long-lived service wiring; build request operation publisher, room input transport or enrollment port at boundary |
| S1457 `modules/machines/service.ts:2098` **MachinesService.presence** | `Map< MachineId, { lastSeenAt: string; presenceSource: MachinePresenceSource \| null } >` | notePresence | notePresence, condition | live correctness | **room** | daemon live readiness/connectivity/grace reading; durable admission uses Q-lease, last-seen transitions are stored facts |

### modules/daemon-request.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0677 `modules/daemon-request.ts:137` **DaemonRequestBroker.nextRequestNum** | `number` | nextRequestId | DaemonRequestBroker consumers | wiring/code only | **delete** | broker capability/request-number lifecycle; remove general Core correlator; use operation ids |
| S0678 `modules/daemon-request.ts:138` **DaemonRequestBroker.pending** | `Map<string, PendingDaemonRequest>` | cleanup, constructor/callback, settle | inFlight, settle | acceptance/result | **operation** | mixed Core machine requests; durable/server-needed subset becomes operations, person reads leave broker for room, held transcript subset waits for POD-7333; self-hosted-only direct path stays scoped |
| S0679 `modules/daemon-request.ts:140` **DaemonRequestBroker.deps** | `DaemonRequestBrokerDeps` | constructor/initializer | request, constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### hub/pairing.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0588 `hub/pairing.ts:23` **PairingManager.codes** | `Map<string, { expiresAtMs: number; grant: PairingGrant }>` | mint, redeem | mint, peek, redeem | answer/decision | **derived** | single-use code -> expiry and grant; Q-pairing; new durable atomic consume/expiry required |
| S0589 `hub/pairing.ts:24` **PairingManager.randomCode** | `() => string` | constructor/callback | mint | wiring/code only | **delete** | immutable code generator/TTL/install scope; request composition inputs, not a grant store |
| S0590 `hub/pairing.ts:25` **PairingManager.ttlMs** | `number` | constructor/callback | mint | wiring/code only | **delete** | immutable code generator/TTL/install scope; request composition inputs, not a grant store |
| S0591 `hub/pairing.ts:26` **PairingManager.installationId** | `string` | constructor/callback | mint | wiring/code only | **delete** | immutable code generator/TTL/install scope; request composition inputs, not a grant store |
| S0592 `hub/pairing.ts:27` **PairingManager.minted** | `Map<string, { start: number; count: number }>` | mint | mint | answer/decision | **derived** | mint/redemption abuse counters; Q-rate; process sharding must not multiply limits |
| S0593 `hub/pairing.ts:28` **PairingManager.attempts** | `object` | constructor/initializer | redeem | answer/decision | **derived** | mint/redemption abuse counters; Q-rate; process sharding must not multiply limits |

### store/settings.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0476 `store/settings.ts:149` **SettingsRepository.committed** | `inferred value/definition` | initializeSnapshot, constructor/callback | layeredSettings | answer/decision | **derived** | settings snapshot used by layeredSettings/resolve/telemetry; Q-settings; current local post-commit replacement misses other writers |
| S0477 `store/settings.ts:150` **SettingsRepository.instanceFeedCapture** | `InstancePreferencesFeedCapture \| undefined` | setInstanceFeedCapture, constructor/callback | constructor/callback, inSettingsCommit | wiring/code only | **delete** | capture/repository/query/transaction capability; build from bound request store, not a settings snapshot |
| S0478 `store/settings.ts:263` **SettingsRepository.userPreferences** | `UserPreferencesRepository` | constructor/callback, writeSettingsFor | resolveSettingsFor, preferenceRecordFor, allPreferenceRecordsForBootReconcile, preferenceFor | wiring/code only | **delete** | capture/repository/query/transaction capability; build from bound request store, not a settings snapshot |
| S0479 `store/settings.ts:264` **SettingsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | capture/repository/query/transaction capability; build from bound request store, not a settings snapshot |
| S0480 `store/settings.ts:265` **SettingsRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | updateDeployment, ensureTelemetryIdentity, legacyMutationReceiptCutoff, setSettings | wiring/code only | **delete** | capture/repository/query/transaction capability; build from bound request store, not a settings snapshot |
| S0481 `store/settings.ts:453` **SettingsRepository.settingsOfOperation** | `callback` | settingsWritten, constructor/callback | getSettingsFor | request/tx context | **delete** | operation-scoped settings memo; no answers survive request/transaction; definition may be immutable code |

### gateway/browser-open.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0495 `gateway/browser-open.ts:40` **BrowserOpenGateway.pending** | `Map<string, SessionOpenUrlMessage>` | dispose, onOpenUrl, clear | replayPending, onOpenUrl, onOpenUrlResult, submitCallback, dismiss, expire | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0496 `gateway/browser-open.ts:41` **BrowserOpenGateway.resolvers** | `Map<string, Attribution>` | dispose, submitCallback, clear | onOpenUrlResult | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0497 `gateway/browser-open.ts:42` **BrowserOpenGateway.expiryTimers** | `Map<string, ReturnType<typeof setTimeout>>` | dispose, onOpenUrl, clear | dispose, clear | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0498 `gateway/browser-open.ts:44` **BrowserOpenGateway.deps** | `BrowserOpenGatewayDeps` | constructor/initializer | replayPending, onOpenUrl, onOpenUrlResult, submitCallback, dismiss, expire, clientMaySeeSession, recipients, constructor/callback, clientInSessionRoom, deliverResult | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### gateway/client-mux.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0569 `gateway/client-mux.ts:218` **ClientMux.attachedAtByPeer** | `Map<string, number>` | attachClient, detachClient | detachClient, routeClientFrame, reclaim | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0570 `gateway/client-mux.ts:220` **ClientMux.deps** | `ClientMuxDeps` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0571 `gateway/client-mux.ts:362` **ClientMux.sessionWork** | `WeakMap<ClientConn, Promise<void>>` | enqueueSessionWork, constructor/callback | enqueueSessionWork, constructor/callback | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |

### gateway/client-registry.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0491 `gateway/client-registry.ts:157` **ClientRegistry.conns** | `Map<string, ClientConn>` | add, delete | get, values, size, deliverStream, broadcast | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0492 `gateway/client-registry.ts:158` **ClientRegistry.nextClientNum** | `number` | nextId | ClientRegistry consumers | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0493 `gateway/client-registry.ts:191` **ClientRegistry.accountEventRoute** | `(conn: ClientConn, msg: AccountEventPayload) => boolean` | routeAccountEvents | deliverAccountEvent | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |

### gateway/daemon-link-kind.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0529 `gateway/daemon-link-kind.ts:136` **DaemonLinks.links** | `Map<MachineId, { link: DaemonLink; owner: object }>` | connected, disconnected | disconnected, daemonLinkKind, settingsChanged | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0530 `gateway/daemon-link-kind.ts:137` **DaemonLinks.lastKind** | `Map<MachineId, DaemonLinkKind>` | connected, disconnected, settingsChanged | settingsChanged | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0531 `gateway/daemon-link-kind.ts:139` **DaemonLinks.deps** | `DaemonLinksDeps` | constructor/initializer | kindOf, settingsChanged | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |

### gateway/daemon-mux.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0494 `gateway/daemon-mux.ts:300` **DaemonMux.deps** | `DaemonMuxDeps` | constructor/initializer | attachDaemon, detachDaemon, routeDaemonOutput, constructor/callback | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |

### gateway/feed-serving.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0572 `gateway/feed-serving.ts:145` **FeedServing.publisher** | `FeedPublisher` | constructor/callback | serveResume, publishOnce, bumpEpoch | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0573 `gateway/feed-serving.ts:146` **FeedServing.edge** | `WireFeedEdge` | constructor/callback | attach, serveResume, renegotiate, detach, versions, support, expiredAdapters, flush | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0574 `gateway/feed-serving.ts:147` **FeedServing.peers** | `Map<string, FeedPeer>` | attach, renegotiate, detach | abandoned, constructor/callback, flush | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0575 `gateway/feed-serving.ts:148` **FeedServing.connections** | `Map<string, FeedConnection>` | serveResume, renegotiate, detach | attach, renegotiate, detach, connectionCount, flush | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0576 `gateway/feed-serving.ts:162` **FeedServing.admissions** | `Map<string, Promise<void>>` | constructor/callback, defer, detach | defer, constructor/callback | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0577 `gateway/feed-serving.ts:172` **FeedServing.inFlight** | `Set<Promise<void>>` | constructor/callback, defer | admissionSettled | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0578 `gateway/feed-serving.ts:174` **FeedServing.servedVersion** | `Map<string, number>` | serveResume, detach | renegotiate | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0579 `gateway/feed-serving.ts:175` **FeedServing.feedKeyByPeer** | `Map<string, RoutingKey>` | retainPrincipal, releasePrincipal | retainPrincipal, releasePrincipal | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0580 `gateway/feed-serving.ts:176` **FeedServing.authoritySubscriptionByKey** | `Map<RoutingKey, () => void>` | retainPrincipal, releasePrincipal | releasePrincipal | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0581 `gateway/feed-serving.ts:177` **FeedServing.pendingByPrincipal** | `Map< string, { principal: Principal; deliveries: ScopedDelivery[] } >` | queue, flushPending | queue, flushPending | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0582 `gateway/feed-serving.ts:181` **FeedServing.cancelScheduledFlush** | `(() => void) \| undefined` | queue, flushPending | queue, flushPending | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0583 `gateway/feed-serving.ts:182` **FeedServing.pendingFlush** | `Promise<void>` | flushPending | flushPending | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0584 `gateway/feed-serving.ts:184` **FeedServing.publishTail** | `Promise<void>` | publishInOrder | publishInOrder | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0585 `gateway/feed-serving.ts:186` **FeedServing.owed** | `Map<string, OwedPublication>` | publishOwedThen, owe | publishOwedThen, owe | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0586 `gateway/feed-serving.ts:188` **FeedServing.deps** | `FeedServingDeps` | constructor/initializer | constructor/callback, canResume, serveResume, retainPrincipal, releasePrincipal, queue, publishOnce, bumpEpoch, identity, retentionFloor | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |

### gateway/mobile-client-versions.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0484 `gateway/mobile-client-versions.ts:82` **MobileClientVersions.history** | `MobileVersionHistory` | constructor/callback | connected, disconnected, checkpoint | answer/decision | **derived** | version observation/quiet-coverage state; Q-mobile (new durable summary replaces local file) |
| S0485 `gateway/mobile-client-versions.ts:83` **MobileClientVersions.clients** | `Map<string, string>` | connected, disconnected | connected, disconnected, checkpoint | connection/order only | **socket** | currently connected client -> app-version associations; clear on disconnect; no eligibility proof in connection map |
| S0486 `gateway/mobile-client-versions.ts:84` **MobileClientVersions.timer** | `ReturnType<typeof setInterval>` | constructor/callback, close | constructor/callback | work/claim/retry | **job** | periodic version observation checkpoint; install job, not one per registry |
| S0487 `gateway/mobile-client-versions.ts:85` **MobileClientVersions.persistedAt** | `number` | constructor/callback, checkpoint | checkpoint | answer/decision | **derived** | version observation/quiet-coverage state; Q-mobile (new durable summary replaces local file) |
| S0488 `gateway/mobile-client-versions.ts:86` **MobileClientVersions.healthy** | `boolean` | checkpoint | checkpoint | answer/decision | **derived** | version observation/quiet-coverage state; Q-mobile (new durable summary replaces local file) |
| S0489 `gateway/mobile-client-versions.ts:89` **MobileClientVersions.path** | `string` | constructor/initializer | checkpoint | no independent truth | **delete** | file location/clock injection; no hosted machine-local authority |
| S0490 `gateway/mobile-client-versions.ts:90` **MobileClientVersions.now** | `inferred value/definition` | constructor/initializer | connected, disconnected, checkpoint | no independent truth | **delete** | file location/clock injection; no hosted machine-local authority |

### gateway/ordered-client-send.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0532 `gateway/ordered-client-send.ts:56` **OrderedSendBudget.bytes** | `number` | reserve, release | reserve | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0533 `gateway/ordered-client-send.ts:57` **OrderedSendBudget.listeners** | `Set<() => void>` | onRelease, constructor/callback | release | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0534 `gateway/ordered-client-send.ts:58` **OrderedSendBudget.maxBytes** | `number` | constructor/initializer | reserve | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0535 `gateway/ordered-client-send.ts:94` **SequenceBinary.bytes** | `Uint8Array` | constructor/initializer | SequenceBinary consumers | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0536 `gateway/ordered-client-send.ts:191` **OrderedClientSend.queue** | `Item[]` | constructor/callback, enqueue, prepare, dispose | binary, pump, prepare, reliablePending | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0537 `gateway/ordered-client-send.ts:193` **OrderedClientSend.ready** | `Frame[]` | stage, drop, dispose | binary, pump, canPrepare, write, reliablePending | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0538 `gateway/ordered-client-send.ts:194` **OrderedClientSend.sequences** | `Set<Sequence>` | settle, constructor/callback | dispose | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0539 `gateway/ordered-client-send.ts:195` **OrderedClientSend.opts** | `Required<Omit<OrderedSendOptions, 'timers'>> & { timers: OrderedSendTimers }` | constructor/callback | enqueue, hasTurnBudget, canPrepare, onDrain, progress, armProgressTimer | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0540 `gateway/ordered-client-send.ts:198` **OrderedClientSend.queuedBytes** | `number` | charge, release | stats, admitLossy, enqueue, charge | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0541 `gateway/ordered-client-send.ts:199` **OrderedClientSend.queuedFrames** | `number` | charge, release | stats, enqueue | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0542 `gateway/ordered-client-send.ts:200` **OrderedClientSend.readyBytes** | `number` | stage, drop, dispose | stats, pump, canPrepare | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0543 `gateway/ordered-client-send.ts:202` **OrderedClientSend.stalled** | `Frame \| undefined` | prepare, dispose | prepare, reliablePending, dispose | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0544 `gateway/ordered-client-send.ts:203` **OrderedClientSend.budgetWait** | `(() => void) \| undefined` | reserveSequenceFrame, constructor/callback, dispose | canPrepare, reserveSequenceFrame, constructor/callback, armProgressTimer, dispose | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0545 `gateway/ordered-client-send.ts:204` **OrderedClientSend.drainOff** | `(() => void) \| undefined` | constructor/callback, dispose | dispose | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0546 `gateway/ordered-client-send.ts:205` **OrderedClientSend.progressTimer** | `unknown` | progress, armProgressTimer, constructor/callback | progress, armProgressTimer | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0547 `gateway/ordered-client-send.ts:206` **OrderedClientSend.yieldScheduled** | `boolean` | hasTurnBudget, constructor/callback | hasTurnBudget | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0548 `gateway/ordered-client-send.ts:207` **OrderedClientSend.drainScheduled** | `boolean` | onDrain, constructor/callback | onDrain | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0549 `gateway/ordered-client-send.ts:208` **OrderedClientSend.turnBytes** | `number` | constructor/callback, reserveSequenceFrame, write | hasTurnBudget | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0550 `gateway/ordered-client-send.ts:209` **OrderedClientSend.paused** | `boolean` | pause, constructor/callback | stats, admitLossy, write, pause, constructor/callback, armProgressTimer | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0551 `gateway/ordered-client-send.ts:210` **OrderedClientSend.pumping** | `boolean` | pump | pump | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0552 `gateway/ordered-client-send.ts:211` **OrderedClientSend.rerun** | `boolean` | pump | pump | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0553 `gateway/ordered-client-send.ts:212` **OrderedClientSend.stopped** | `boolean` | dispose | stats, sendSequence, admitLossy, enqueue, pump, constructor/callback, canPrepare, write, onDrain, fail, dispose | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0554 `gateway/ordered-client-send.ts:213` **OrderedClientSend.failure** | `SendFailureReason \| undefined` | fail | stats, sendSequence, dispose | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0555 `gateway/ordered-client-send.ts:214` **OrderedClientSend.label** | `string \| undefined` | describe | stats, prepare, write | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0556 `gateway/ordered-client-send.ts:215` **OrderedClientSend.sentFrames** | `number` | write | stats, pump | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0557 `gateway/ordered-client-send.ts:216` **OrderedClientSend.sentBytes** | `number` | write | stats | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0558 `gateway/ordered-client-send.ts:217` **OrderedClientSend.pauses** | `number` | pause | stats | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0559 `gateway/ordered-client-send.ts:218` **OrderedClientSend.peakSocketBufferedBytes** | `number` | write, onDrain | stats, write, onDrain | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0560 `gateway/ordered-client-send.ts:219` **OrderedClientSend.peakQueuedBytes** | `number` | charge | stats, charge | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0561 `gateway/ordered-client-send.ts:222` **OrderedClientSend.ws** | `SendSocket` | constructor/initializer | stats, binary, sequenceBinary, admitLossy, enqueue, write, onDrain, constructor/callback, fail | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0562 `gateway/ordered-client-send.ts:223` **OrderedClientSend.limits** | `{ sendBufferLimitBytes: number; lossySendBufferLimitBytes: number }` | constructor/initializer | admitLossy, enqueue, write, constructor/callback | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0563 `gateway/ordered-client-send.ts:224` **OrderedClientSend.budget** | `inferred value/definition` | constructor/initializer | stats, enqueue, release, reserveSequenceFrame | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0564 `gateway/ordered-client-send.ts:262` **OrderedClientSend.send** | `PlaneSink['send']` | constructor/initializer | OrderedClientSend consumers | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0565 `gateway/ordered-client-send.ts:272` **OrderedClientSend.sendLossy** | `PlaneSink['sendLossy']` | constructor/initializer | OrderedClientSend consumers | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0566 `gateway/ordered-client-send.ts:279` **OrderedClientSend.sendBinary** | `PlaneSink['sendBinary']` | constructor/initializer | OrderedClientSend consumers | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0567 `gateway/ordered-client-send.ts:282` **OrderedClientSend.sendBinaryLossy** | `PlaneSink['sendBinaryLossy']` | constructor/initializer | OrderedClientSend consumers | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0568 `gateway/ordered-client-send.ts:290` **OrderedClientSend.sendSequence** | `NonNullable<PlaneSink['sendSequence']>` | constructor/initializer | OrderedClientSend consumers | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |

### gateway/presence-routing.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0502 `gateway/presence-routing.ts:60` **PresenceRouting.router** | `PlaneRouter<PresenceRoomServerMessage>` | constructor/callback | constructor/callback, flushNow | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0503 `gateway/presence-routing.ts:61` **PresenceRouting.port** | `StreamPlanePort` | constructor/callback | route, setVisible, disconnect, occupancy, join, ensureLeft, isWatchedBy, revalidateSubscribers, flushNow | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0504 `gateway/presence-routing.ts:62` **PresenceRouting.now** | `() => number` | constructor/callback | admitUpdate | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0505 `gateway/presence-routing.ts:63` **PresenceRouting.lastUpdateAt** | `Map<string, number>` | disconnect, admitUpdate | disconnect, admitUpdate | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0506 `gateway/presence-routing.ts:64` **PresenceRouting.pressureDrops** | `Map<string, number>` | disconnect, flushNow | disconnect, flushNow | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0507 `gateway/presence-routing.ts:65` **PresenceRouting.flushScheduled** | `boolean` | flushNow, scheduleFlush | scheduleFlush | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0508 `gateway/presence-routing.ts:66` **PresenceRouting.joiningVisibility** | `VisibilityResolver \| undefined` | join | canSee, join | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0509 `gateway/presence-routing.ts:68` **PresenceRouting.deps** | `PresenceRoutingDeps` | constructor/initializer | join, constructor/callback, revalidateSubscribers, flushNow | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### gateway/topic-routing.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0519 `gateway/topic-routing.ts:144` **TopicRouting.router** | `PlaneRouter<QueuedTopicFrame>` | constructor/callback | disconnect, sendUpdate, flushNow | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0520 `gateway/topic-routing.ts:145` **TopicRouting.now** | `() => number` | constructor/callback | publish, sendUpdate | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0521 `gateway/topic-routing.ts:146` **TopicRouting.timers** | `TopicTimers` | constructor/callback | publish, settleIfEmpty, scheduleResend | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0522 `gateway/topic-routing.ts:147` **TopicRouting.epochBase** | `string` | constructor/callback | add | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0523 `gateway/topic-routing.ts:148` **TopicRouting.generation** | `number` | add | add | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0524 `gateway/topic-routing.ts:149` **TopicRouting.states** | `Map<RoutingKey, KeyState>` | add, settleIfEmpty | isHeld, publish, add, settleIfEmpty, sendSnapshot, stillHeld, releasePending, deliverValue | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0525 `gateway/topic-routing.ts:151` **TopicRouting.resendStreak** | `Map<string, number>` | disconnect, remove, deliverValue, overflowed, constructor/callback | disconnect, deliverValue, constructor/callback | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0526 `gateway/topic-routing.ts:152` **TopicRouting.resendTimer** | `unknown` | scheduleResend, constructor/callback | scheduleResend | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0527 `gateway/topic-routing.ts:153` **TopicRouting.flushScheduled** | `boolean` | flushNow, scheduleFlush | scheduleFlush | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0528 `gateway/topic-routing.ts:155` **TopicRouting.deps** | `TopicRoutingDeps` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### gateway/wire-feed-edge.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0510 `gateway/wire-feed-edge.ts:59` **IdentityWireAdapter.version** | `inferred value/definition` | constructor/initializer | IdentityWireAdapter consumers | wiring/code only | **delete** | immutable protocol adapter constant; share as code, no retained workspace state |
| S0511 `gateway/wire-feed-edge.ts:60` **IdentityWireAdapter.name** | `inferred value/definition` | constructor/initializer | IdentityWireAdapter consumers | wiring/code only | **delete** | immutable protocol adapter constant; share as code, no retained workspace state |
| S0512 `gateway/wire-feed-edge.ts:63` **IdentityWireAdapter.expiry** | `inferred value/definition` | constructor/initializer | IdentityWireAdapter consumers | wiring/code only | **delete** | immutable protocol adapter constant; share as code, no retained workspace state |
| S0513 `gateway/wire-feed-edge.ts:66` **IdentityWireAdapter.expressesEvict** | `boolean` | constructor/initializer | IdentityWireAdapter consumers | wiring/code only | **delete** | immutable protocol adapter constant; share as code, no retained workspace state |
| S0514 `gateway/wire-feed-edge.ts:97` **WireFeedEdge.registry** | `WireVersionAdapterRegistry<FeedFrame, ServerMessage>` | constructor/callback | constructor/callback, register, attach, publishTo, publishSequenceTo, expiredAdapters | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0515 `gateway/wire-feed-edge.ts:98` **WireFeedEdge.telemetry** | `PeerVersionTelemetry` | constructor/initializer | attach, detach, versions | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0516 `gateway/wire-feed-edge.ts:99` **WireFeedEdge.peers** | `Map<string, EdgePeer>` | attach, detach | publish | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0517 `gateway/wire-feed-edge.ts:111` **WireFeedEdge.evictCapable** | `Map<number, boolean>` | register | expressesEvict | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0518 `gateway/wire-feed-edge.ts:113` **WireFeedEdge.deps** | `WireFeedEdgeDeps` | constructor/initializer | attach | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |

### gateway/ws-server.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0499 `gateway/ws-server.ts:264` **NativeGatewaySocket.listeners** | `Map<SocketEvent, SocketListener[]>` | on | constructor/callback, on, emit | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0500 `gateway/ws-server.ts:266` **NativeGatewaySocket.ended** | `boolean` | end | emit | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0501 `gateway/ws-server.ts:268` **NativeGatewaySocket.native** | `NativeServerWebSocket<SocketData>` | end | readyState, bufferedAmount, send, sendBinary, ping, terminate | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |

### application/issue-attach-orchestrator.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0160 `application/issue-attach-orchestrator.ts:23` **IssueAttachOrchestrator.ports** | `IssueAttachOrchestratorPorts` | constructor/initializer | execute, constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### auto-continue.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0147 `auto-continue.ts:30` **AutoContinueController.loops** | `Map< SessionId, { attempt: number; timer: ReturnType<typeof setTimeout> \| undefined } >` | onSessionRestored, arm, stop | onSessionRestored, onSessionLive, isActive, arm, tick, stop, stopAll | work/claim/retry | **job** | automatic continuation attempts and retry timers; durable job keyed by session/turn, retry policy reads the row |
| S0148 `auto-continue.ts:35` **AutoContinueController.deps** | `AutoContinueDeps` | constructor/initializer | onStateChange, tick | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### composition/lifecycle-port.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0164 `composition/lifecycle-port.ts:5` **LifecyclePort.installed** | `T \| undefined` | install | install, read | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0165 `composition/lifecycle-port.ts:7` **LifecyclePort.name** | `string` | constructor/initializer | install, read | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0166 `composition/lifecycle-port.ts:14` **LifecyclePort.read** | `callback` | constructor/initializer | LifecyclePort consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### identity/member-credentials.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0167 `identity/member-credentials.ts:19` **MemberHasNoAccount.memberId** | `UserId` | constructor/initializer | MemberHasNoAccount consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### issue-mcp.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0155 `issue-mcp.ts:48` **IssueToolProvider.client** | `IssueTrpc \| undefined` | setClient | callMcpTool | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0156 `issue-mcp.ts:49` **IssueToolProvider.clientForThread** | `\| ((threadId: ThreadId) => Promise<IssueTrpc> \| IssueTrpc) \| undefined` | setClientResolver | callMcpTool | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0157 `issue-mcp.ts:90` **CompositeMcpProvider.providers** | `McpToolProvider[]` | constructor/initializer | mcpToolSpecs, callMcpTool | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### log-rate.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0015 `log-rate.ts:13` **LogRate.windowStartedAt** | `inferred value/definition` | take | take | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0016 `log-rate.ts:14` **LogRate.written** | `number` | take | take | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0017 `log-rate.ts:15` **LogRate.suppressed** | `number` | take | take | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0018 `log-rate.ts:18` **LogRate.windowMs** | `number` | constructor/initializer | take | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0019 `log-rate.ts:19` **LogRate.burst** | `number` | constructor/initializer | take | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0020 `log-rate.ts:20` **LogRate.now** | `() => number` | constructor/initializer | take | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### migrations/lake-parts-conversion.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0634 `migrations/lake-parts-conversion.ts:118` **LakeConversionNoSpace.name** | `inferred value/definition` | constructor/initializer | LakeConversionNoSpace consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0635 `migrations/lake-parts-conversion.ts:120` **LakeConversionNoSpace.neededBytes** | `number` | constructor/initializer | LakeConversionNoSpace consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0636 `migrations/lake-parts-conversion.ts:121` **LakeConversionNoSpace.freeBytes** | `number` | constructor/initializer | LakeConversionNoSpace consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0637 `migrations/lake-parts-conversion.ts:122` **LakeConversionNoSpace.sourcePath** | `string` | constructor/initializer | LakeConversionNoSpace consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0638 `migrations/lake-parts-conversion.ts:133` **LakeConversionMismatch.name** | `inferred value/definition` | constructor/initializer | LakeConversionMismatch consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0639 `migrations/lake-parts-conversion.ts:135` **LakeConversionMismatch.sourcePath** | `string` | constructor/initializer | LakeConversionMismatch consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0640 `migrations/lake-parts-conversion.ts:136` **LakeConversionMismatch.key** | `BlobKey` | constructor/initializer | LakeConversionMismatch consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0641 `migrations/lake-parts-conversion.ts:167` **ConvertingLake.pending** | `Map<string, Promise<number \| undefined>>` | constructor/callback, convert | convert, settled | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0642 `migrations/lake-parts-conversion.ts:168` **ConvertingLake.tail** | `Promise<void>` | convert | convert | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0643 `migrations/lake-parts-conversion.ts:169` **ConvertingLake.completed** | `boolean` | run | legacy | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0644 `migrations/lake-parts-conversion.ts:170` **ConvertingLake.root** | `string` | constructor/callback | legacy | wiring/code only | **delete** | self-hosted conversion location/writer capability; immutable job inputs, not conversion progress |
| S0645 `migrations/lake-parts-conversion.ts:171` **ConvertingLake.runWriter** | `<T>(writer: () => Promise<T>) => Promise<T>` | constructor/callback | constructor/callback | wiring/code only | **delete** | self-hosted conversion location/writer capability; immutable job inputs, not conversion progress |
| S0646 `migrations/lake-parts-conversion.ts:173` **ConvertingLake.options** | `LakePartsConversionOptions` | constructor/initializer | legacy, constructor/callback, openWriter, clear, run | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### migrations/pg/index.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0632 `migrations/pg/index.ts:87` **PgMigrationRefusal.reason** | `PgMigrationRefusalReason` | constructor/initializer | PgMigrationRefusal consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0633 `migrations/pg/index.ts:88` **PgMigrationRefusal.migrations** | `readonly string[]` | constructor/initializer | PgMigrationRefusal consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### migrations/snapshot-verifier.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0624 `migrations/snapshot-verifier.ts:250` **SnapshotVerifier.inFlight** | `Promise<SnapshotVerification> \| undefined` | verify | verify, queueBackgroundVerification, close | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0625 `migrations/snapshot-verifier.ts:251` **SnapshotVerifier.backgroundQueued** | `boolean` | queueBackgroundVerification, constructor/callback | queueBackgroundVerification | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0626 `migrations/snapshot-verifier.ts:252` **SnapshotVerifier.closed** | `boolean` | close | verifiedFallbackPath, discoverAndQueue, verifiedFallbackRecord, verify, queueBackgroundVerification, constructor/callback | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0627 `migrations/snapshot-verifier.ts:253` **SnapshotVerifier.closing** | `Promise<void> \| undefined` | close | close | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0628 `migrations/snapshot-verifier.ts:254` **SnapshotVerifier.children** | `Set<Promise<void>>` | onChildLifetime, constructor/callback | close | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0629 `migrations/snapshot-verifier.ts:256` **SnapshotVerifier.lifetime** | `AbortController` | close | runOnce | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0630 `migrations/snapshot-verifier.ts:259` **SnapshotVerifier.dbPath** | `string` | constructor/initializer | records, recordsIncludingLegacy, discoverAndQueue, publish | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0631 `migrations/snapshot-verifier.ts:260` **SnapshotVerifier.deps** | `SnapshotVerifierDeps` | constructor/initializer | now, discoverAndQueue, publish, runOnce, constructor/callback, deferBackground | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### mobile-pairing-route.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0161 `mobile-pairing-route.ts:26` **PairingFailureThrottle.buckets** | `Map<string, FailureBucket>` | retryAfter, fail, clear, maybeSweep, makeRoom | size, retryAfter, fail, maybeSweep, makeRoom | answer/decision | **derived** | pairing failure lockout buckets/counters; Q-rate; preserve no-early-eviction rule across processes |
| S0162 `mobile-pairing-route.ts:27` **PairingFailureThrottle.operations** | `number` | maybeSweep | maybeSweep | answer/decision | **derived** | pairing failure lockout buckets/counters; Q-rate; preserve no-early-eviction rule across processes |
| S0163 `mobile-pairing-route.ts:30` **PairingFailureThrottle.opts** | `{ maxFailures: number lockoutMs: number retentionMs: number maxEntries: number }` | constructor/initializer | fail | wiring/code only | **delete** | immutable throttle policy; trusted install configuration |

### model-catalog.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0001 `model-catalog.ts:56` **ModelCatalog.snapshots** | `Map<string, ModelCatalogSnapshot>` | ensure, constructor/callback, probeInto | ensure, probeInto | answer/decision | **derived** | per-machine model-list snapshot/hydration; Q-catalog; refresh is a separate leased probe job, no mutable SWR object returned across requests |
| S0002 `model-catalog.ts:57` **ModelCatalog.inflight** | `Map<string, Promise<void>>` | constructor/callback, refreshInBackground, refresh | refreshInBackground, refresh | work/claim/retry | **job** | model probe in flight; durable job, result fact persists Q-catalog before waking dependent work |
| S0003 `model-catalog.ts:58` **ModelCatalog.hydrated** | `Set<string>` | constructor/callback, refresh | constructor/callback | answer/decision | **derived** | per-machine model-list snapshot/hydration; Q-catalog; refresh is a separate leased probe job, no mutable SWR object returned across requests |
| S0004 `model-catalog.ts:65` **ModelCatalog.probe** | `ModelProbe` | constructor/initializer | probeInto | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0005 `model-catalog.ts:66` **ModelCatalog.opts** | `{ ttlMs?: number now?: () => number /** Persist across restarts: load seeds one machine's cache at first read * (→ instant, non-cold first open after a redeploy); save write…` | constructor/initializer | now, isStale, constructor/callback, probeInto | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### model-validation.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0024 `model-validation.ts:193` **ModelValidationError.problem** | `ModelValidationProblem` | constructor/initializer | ModelValidationError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### modules/agent-profiles/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0675 `modules/agent-profiles/service.ts:88` **AgentProfileService.deps** | `AgentProfileDeps` | constructor/initializer | list, find, export, record, createRecord, write, editRecord, removeRecord, launch, constructor/callback, instructionsFor, require, refuseWhileUsed, requirePerson, machineIdFor, machineNames | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/approvals/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1390 `modules/approvals/service.ts:200` **ApprovalService.lastPolledAt** | `Map<string, number>` | getFromAgent | notify | work/claim/retry | **job** | approval poll/stall timestamps; store dispatch generation and due time in operation/job, do not reset patience independently on each Core process |
| S1391 `modules/approvals/service.ts:204` **ApprovalService.WAITER_LIVE_MS** | `number` | constructor/initializer | ApprovalService consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1392 `modules/approvals/service.ts:220` **ApprovalService.stallClock** | `Map<string, number>` | recover, onExecResult | recover | work/claim/retry | **job** | approval poll/stall timestamps; store dispatch generation and due time in operation/job, do not reset patience independently on each Core process |
| S1393 `modules/approvals/service.ts:222` **ApprovalService.deps** | `ApprovalServiceDeps` | constructor/initializer | toWire, notify, log, personOf, request, write, get, decidersFor, mayRun, decide, run, recover, daemonReachable, onExecResult, settleAsBroker, constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/automations/scheduler.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0597 `modules/automations/scheduler.ts:24` **AutomationScheduler.bootTimer** | `ReturnType<typeof setTimeout> \| undefined` | start, dispose | start, dispose | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0598 `modules/automations/scheduler.ts:25` **AutomationScheduler.timer** | `ReturnType<typeof setInterval> \| undefined` | constructor/callback, dispose | constructor/callback, dispose | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0599 `modules/automations/scheduler.ts:27` **AutomationScheduler.ticking** | `boolean` | tick | tick | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0600 `modules/automations/scheduler.ts:29` **AutomationScheduler.automations** | `Pick<AutomationsService, 'tick'>` | constructor/initializer | tick | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/automations/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0594 `modules/automations/service.ts:133` **AutomationRefusal.kind** | `'invalid' \| 'not-found'` | constructor/initializer | AutomationRefusal consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0595 `modules/automations/service.ts:148` **AutomationSpawnError.sessionId** | `SessionId \| null` | constructor/initializer | AutomationSpawnError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0596 `modules/automations/service.ts:155` **AutomationsService.deps** | `AutomationsDeps` | constructor/initializer | now, list, listForUser, runs, runsForUser, ownerOf, isOwnSession, write, update, remove, tick, schedulables, apply, applyObservedOccurrence, spawn | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/bus.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1172 `modules/bus.ts:255` **EventBus.listeners** | `Map<EventName, Set<Listener<EventName>>>` | on, removeAll | on, off, emit, emitSettled, emitDurable, listenerCount | local follow-up/order | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |

### modules/checkouts/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1027 `modules/checkouts/service.ts:200` **CheckoutsService.running** | `Map<MachineId, Promise<GitDiscoveryDiagnosticWire[]>>` | constructor/callback, start | rescan, constructor/callback | acceptance/result | **operation** | in-flight machine command, credential/login, discovery or handoff chain; stable operation/result rows replace local promises/maps |
| S1028 `modules/checkouts/service.ts:201` **CheckoutsService.trailing** | `Map<MachineId, Promise<GitDiscoveryDiagnosticWire[]>>` | constructor/callback, rescan | rescan | acceptance/result | **operation** | in-flight machine command, credential/login, discovery or handoff chain; stable operation/result rows replace local promises/maps |
| S1029 `modules/checkouts/service.ts:203` **CheckoutsService.deps** | `CheckoutsDeps` | constructor/initializer | registeredOn, scanOnce, recordOrigins, constructor/callback, reconcile, write, allRows | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/closed-issue-refusals.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1427 `modules/closed-issue-refusals.ts:53` **ClosedIssueRefusals.refused** | `Map<string, Refusal>` | retain, succeeded, refusedWith | beginPass, constructor/callback, retain, refusedWith, size | work/claim/retry | **job** | closed-issue stop/retry/refusal work; idempotent job by issue/session/revision |
| S1428 `modules/closed-issue-refusals.ts:54` **ClosedIssueRefusals.pass** | `number` | beginPass | beginPass, refusedWith | work/claim/retry | **job** | closed-issue stop/retry/refusal work; idempotent job by issue/session/revision |

### modules/cloud/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0622 `modules/cloud/service.ts:75` **CloudService.provider** | `CloudRuntimeProvider` | constructor/callback | capabilities, getRuntime, createCloudMachine, createCloudAgent, stopRuntime, wakeRuntime, moveSession | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0623 `modules/cloud/service.ts:77` **CloudService.deps** | `CloudServiceDeps` | constructor/initializer | moveSession, inferCloudRepoForSession | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/concertmaster/delivered.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1032 `modules/concertmaster/delivered.ts:39` **DeliveredMessageWatch.unsubscribe** | `() => void` | constructor/callback | dispose | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1033 `modules/concertmaster/delivered.ts:40` **DeliveredMessageWatch.running** | `Set<Promise<void>>` | onCommitted, constructor/callback | settled | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1034 `modules/concertmaster/delivered.ts:42` **DeliveredMessageWatch.deps** | `DeliveredMessageWatchDeps` | constructor/initializer | record | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/concertmaster/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1030 `modules/concertmaster/service.ts:61` **ConcertmasterRefusal.kind** | `'invalid' \| 'unauthorized' \| 'target-not-found' \| 'conflict'` | constructor/initializer | ConcertmasterRefusal consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1031 `modules/concertmaster/service.ts:196` **ConcertmasterService.deps** | `ConcertmasterDeps` | constructor/initializer | enabled, isConcertmaster, at, requireConcertmaster, requireAsk, say, ask, update, settleByAgent, list, assign, respond, recordDelivered, conversation | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/connect/publisher.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1237 `modules/connect/publisher.ts:60` **ConnectPublisher.#state** | `PublisherState` | start, stop, #run, #fail | state, start, stop, publicUrlChanged, #run | work/claim/retry | **job** | install Connect registration/publication/backoff; one leased install job; serialize due work outside the feed |
| S1238 `modules/connect/publisher.ts:61` **ConnectPublisher.#registered** | `boolean` | #run | #run | work/claim/retry | **job** | install Connect registration/publication/backoff; one leased install job; serialize due work outside the feed |
| S1239 `modules/connect/publisher.ts:62` **ConnectPublisher.#timer** | `unknown` | #disarm, #arm | #disarm | work/claim/retry | **job** | install Connect registration/publication/backoff; one leased install job; serialize due work outside the feed |
| S1240 `modules/connect/publisher.ts:63` **ConnectPublisher.#backoffMs** | `inferred value/definition` | #run, #fail | #fail | work/claim/retry | **job** | install Connect registration/publication/backoff; one leased install job; serialize due work outside the feed |
| S1241 `modules/connect/publisher.ts:64` **ConnectPublisher.#publishedUrl** | `string \| undefined` | #run | #run, #fail | work/claim/retry | **job** | install Connect registration/publication/backoff; one leased install job; serialize due work outside the feed |
| S1242 `modules/connect/publisher.ts:65` **ConnectPublisher.#publishedAt** | `number` | #run | #run | work/claim/retry | **job** | install Connect registration/publication/backoff; one leased install job; serialize due work outside the feed |
| S1243 `modules/connect/publisher.ts:66` **ConnectPublisher.#inFlight** | `Promise<void> \| undefined` | #tick, constructor/callback | publicUrlChanged, settled, #tick | work/claim/retry | **job** | install Connect registration/publication/backoff; one leased install job; serialize due work outside the feed |
| S1244 `modules/connect/publisher.ts:68` **ConnectPublisher.#rerun** | `boolean` | publicUrlChanged, constructor/callback | constructor/callback | work/claim/retry | **job** | install Connect registration/publication/backoff; one leased install job; serialize due work outside the feed |
| S1245 `modules/connect/publisher.ts:69` **ConnectPublisher.#republish** | `boolean` | republish, #run | #run | work/claim/retry | **job** | install Connect registration/publication/backoff; one leased install job; serialize due work outside the feed |
| S1246 `modules/connect/publisher.ts:70` **ConnectPublisher.#deps** | `PublisherDeps` | constructor/callback | stableLink, diagnostics, check, #run, #fail | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1247 `modules/connect/publisher.ts:71` **ConnectPublisher.#setTimer** | `(fn: () => void, ms: number) => unknown` | constructor/callback | #arm | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1248 `modules/connect/publisher.ts:72` **ConnectPublisher.#clearTimer** | `(handle: unknown) => void` | constructor/callback | #disarm | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1249 `modules/connect/publisher.ts:73` **ConnectPublisher.#now** | `() => number` | constructor/callback | #run | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |

### modules/cost/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1470 `modules/cost/service.ts:104` **CostService.transcriptPresence** | `Map< string, { recorded: Promise<boolean> expiresAt: number } >` | recordedTranscriptPaths | recordedTranscriptPaths | no independent truth | **delete** | 15-second machine/path filesystem-presence memo (not a database fact); existing held usageRequest behavior stays until POD-7333; new usage reads turn facts |
| S1471 `modules/cost/service.ts:113` **CostService.store** | `SessionStore` | constructor/initializer | prepareHarvest, record, resolveOwners, preferredSessionsByResumeValue, task, taskComparison, tasks, recordedTranscriptPaths | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1472 `modules/cost/service.ts:114` **CostService.rpc** | `Pick< DaemonRpcService, 'canCheckTranscriptPaths' \| 'missingTranscriptPaths' >` | constructor/initializer | recordedTranscriptPaths | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/credentials/chatgpt-plan/authorize.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1218 `modules/credentials/chatgpt-plan/authorize.ts:91` **SignInRefused.name** | `inferred value/definition` | constructor/initializer | SignInRefused consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1219 `modules/credentials/chatgpt-plan/authorize.ts:153` **ChatgptSignIn.attempts** | `Map<string, Attempt>` | start, discard, prune | discard, status, complete, prune | answer/decision | **derived** | OAuth state/nonce/PKCE/outcome per owner; Q-signin (new encrypted short-lived challenge state) |
| S1220 `modules/credentials/chatgpt-plan/authorize.ts:154` **ChatgptSignIn.fetchImpl** | `FetchLike` | constructor/callback | finish | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1221 `modules/credentials/chatgpt-plan/authorize.ts:155` **ChatgptSignIn.now** | `() => number` | constructor/callback | start, status, complete, finish, prune | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1222 `modules/credentials/chatgpt-plan/authorize.ts:157` **ChatgptSignIn.deps** | `ChatgptSignInDeps` | constructor/initializer | start, finish, replaceSecret, returningOf | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/credentials/chatgpt-plan/keeper.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1230 `modules/credentials/chatgpt-plan/keeper.ts:77` **RenewalUnavailable.name** | `inferred value/definition` | constructor/initializer | RenewalUnavailable consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1231 `modules/credentials/chatgpt-plan/keeper.ts:81` **ChatgptPlanKeeper.inflight** | `Map<CredentialId, Promise<IssuedToken>>` | constructor/callback, renewFor | renewFor | work/claim/retry | **job** | credential deferred action/token refresh or renewal deadline; leased job plus durable result/credential row; never store plaintext tokens in job payloads |
| S1232 `modules/credentials/chatgpt-plan/keeper.ts:82` **ChatgptPlanKeeper.fetchImpl** | `FetchLike` | constructor/callback | revoke, refreshWithRetry | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1233 `modules/credentials/chatgpt-plan/keeper.ts:83` **ChatgptPlanKeeper.now** | `() => number` | constructor/callback | issue, renewUnderLock, refreshWithRetry | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1234 `modules/credentials/chatgpt-plan/keeper.ts:84` **ChatgptPlanKeeper.sleep** | `(ms: number) => Promise<void>` | constructor/callback | refreshWithRetry | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1235 `modules/credentials/chatgpt-plan/keeper.ts:85` **ChatgptPlanKeeper.retryDelays** | `readonly number[]` | constructor/callback | refreshWithRetry | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1236 `modules/credentials/chatgpt-plan/keeper.ts:87` **ChatgptPlanKeeper.deps** | `ChatgptPlanKeeperDeps` | constructor/initializer | renewUnderLock, markRejected, read | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/credentials/chatgpt-plan/openai.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1225 `modules/credentials/chatgpt-plan/openai.ts:95` **OpenAiTokenError.name** | `inferred value/definition` | constructor/initializer | OpenAiTokenError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1226 `modules/credentials/chatgpt-plan/openai.ts:97` **OpenAiTokenError.status** | `number` | constructor/initializer | OpenAiTokenError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1227 `modules/credentials/chatgpt-plan/openai.ts:99` **OpenAiTokenError.code** | `string \| undefined` | constructor/initializer | OpenAiTokenError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1228 `modules/credentials/chatgpt-plan/openai.ts:101` **OpenAiTokenError.error** | `string \| undefined` | constructor/initializer | OpenAiTokenError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1229 `modules/credentials/chatgpt-plan/openai.ts:249` **IdTokenError.name** | `inferred value/definition` | constructor/initializer | IdTokenError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### modules/credentials/chatgpt-plan/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1212 `modules/credentials/chatgpt-plan/service.ts:42` **LoopbackUnavailable.name** | `inferred value/definition` | constructor/initializer | LoopbackUnavailable consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1213 `modules/credentials/chatgpt-plan/service.ts:52` **ChatgptPlanService.listeners** | `Map<string, { machineId: MachineId; listenerId: string }>` | start, relayed, closeListener | closeListener | acceptance/result | **operation** | in-flight machine command, credential/login, discovery or handoff chain; stable operation/result rows replace local promises/maps |
| S1214 `modules/credentials/chatgpt-plan/service.ts:55` **ChatgptPlanService.signIn** | `ChatgptSignIn` | constructor/initializer | start, completePasted, status, relayed | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1215 `modules/credentials/chatgpt-plan/service.ts:56` **ChatgptPlanService.keeper** | `ChatgptPlanKeeper` | constructor/initializer | ChatgptPlanService consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1216 `modules/credentials/chatgpt-plan/service.ts:57` **ChatgptPlanService.loopback** | `ChatgptLoopbackPort` | constructor/initializer | start, closeListener | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1217 `modules/credentials/chatgpt-plan/service.ts:58` **ChatgptPlanService.random** | `() => number` | constructor/initializer | start | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/credentials/chatgpt-plan/session-renewal.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1223 `modules/credentials/chatgpt-plan/session-renewal.ts:46` **PlanSessionRenewal.deadlines** | `Map<SessionId, { at: number; cancel: () => void }>` | forget, dispose, schedule | delivered, deadlineOf, forget, dispose, schedule, constructor/callback | work/claim/retry | **job** | credential deferred action/token refresh or renewal deadline; leased job plus durable result/credential row; never store plaintext tokens in job payloads |
| S1224 `modules/credentials/chatgpt-plan/session-renewal.ts:48` **PlanSessionRenewal.deps** | `PlanSessionRenewalDeps` | constructor/initializer | delivered, schedule, constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/credentials/credential-ref.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1250 `modules/credentials/credential-ref.ts:33` **CredentialRefError.name** | `inferred value/definition` | constructor/initializer | CredentialRefError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1251 `modules/credentials/credential-ref.ts:37` **CredentialRefError.refusal** | `AccessRefusal` | constructor/initializer | CredentialRefError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### modules/credentials/health.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1194 `modules/credentials/health.ts:325` **CredentialHealth.store** | `HealthStore` | constructor/callback | markVerified, noteFailure, markAttention, checkExpiry, afterRenew, removeEverywhere, removeMemberCredentials, afterShare, onTurnBoundary | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1195 `modules/credentials/health.ts:326` **CredentialHealth.fetchImpl** | `FetchLike` | constructor/callback | verify | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1196 `modules/credentials/health.ts:327` **CredentialHealth.now** | `() => number` | constructor/callback | verify, markVerified, noteFailure, checkExpiry | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1197 `modules/credentials/health.ts:328` **CredentialHealth.notices** | `CredentialNoticePort` | constructor/callback | safeEmit, safeResolve | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1198 `modules/credentials/health.ts:329` **CredentialHealth.sessions** | `CredentialSessionPort` | constructor/callback | afterRenew, removeEverywhere, flagAndStop, actIfBetweenTurns, run | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1199 `modules/credentials/health.ts:330` **CredentialHealth.placements** | `Pick<Placements, 'removePlacement'> \| undefined` | constructor/callback | removeEverywhere | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1200 `modules/credentials/health.ts:332` **CredentialHealth.pending** | `Map<SessionId, PendingAction>` | afterRenew, restartAtTurnBoundary, flagAndStop, actIfBetweenTurns, run | afterRenew, onTurnBoundary, restartAtTurnBoundary, waitingFor, actIfBetweenTurns | work/claim/retry | **job** | credential deferred action/token refresh or renewal deadline; leased job plus durable result/credential row; never store plaintext tokens in job payloads |

### modules/credentials/native-login.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1179 `modules/credentials/native-login.ts:36` **NativeLoginService.required** | `Set<string>` | markRequired, onInventory | constructor/callback | answer/decision | **derived** | sessions requiring native login; Q-signin (durable requirement/operation status, not a process Set) |
| S1180 `modules/credentials/native-login.ts:38` **NativeLoginService.attempts** | `Map< string, NativeLoginAttempt & { readonly harness: HarnessAgent } >` | startInScope, onExit, onInventory | attempt, onExit, onInventory | acceptance/result | **operation** | in-flight machine command, credential/login, discovery or handoff chain; stable operation/result rows replace local promises/maps |
| S1181 `modules/credentials/native-login.ts:42` **NativeLoginService.bySession** | `Map<string, string>` | startInScope, onExit | onExit | acceptance/result | **operation** | in-flight machine command, credential/login, discovery or handoff chain; stable operation/result rows replace local promises/maps |
| S1182 `modules/credentials/native-login.ts:45` **NativeLoginService.deps** | `{ machines: MachinesService sessions: SessionLifecycle bus: EventBus /** Refusal reason for using a machine, with the owner resolved once * (rule 18) and grant checks bound to s…` | constructor/initializer | startInScope, constructor/callback, onExit, onInventory | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/credentials/placements.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1192 `modules/credentials/placements.ts:45` **Placements.transport** | `PlacementTransport \| undefined` | constructor/callback | tryRemove | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1193 `modules/credentials/placements.ts:47` **Placements.deps** | `PlacementsDeps` | constructor/initializer | removePlacement, retryPendingOn, tryRemove | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/credentials/sign-in.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1183 `modules/credentials/sign-in.ts:79` **SignInRefused.name** | `inferred value/definition` | constructor/initializer | SignInRefused consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1184 `modules/credentials/sign-in.ts:82` **SignInRefused.refusal** | `AccessRefusal` | constructor/initializer | SignInRefused consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1185 `modules/credentials/sign-in.ts:83` **SignInRefused.code** | `'not-found' \| 'refused'` | constructor/initializer | SignInRefused consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1186 `modules/credentials/sign-in.ts:155` **IdentitySerial.tails** | `Map<string, Promise<unknown>>` | run | run | acceptance/result | **operation** | in-flight machine command, credential/login, discovery or handoff chain; stable operation/result rows replace local promises/maps |
| S1187 `modules/credentials/sign-in.ts:302` **HomeSignInService.serial** | `IdentitySerial` | constructor/initializer | succeed | acceptance/result | **operation** | in-flight machine command, credential/login, discovery or handoff chain; stable operation/result rows replace local promises/maps |
| S1188 `modules/credentials/sign-in.ts:303` **HomeSignInService.attempts** | `Map<CredentialId, Attempt>` | start, constructor/callback | isWaitingFor, start, status, cancel, onInventory, onExit, constructor/callback, dispose | acceptance/result | **operation** | in-flight machine command, credential/login, discovery or handoff chain; stable operation/result rows replace local promises/maps |
| S1189 `modules/credentials/sign-in.ts:304` **HomeSignInService.bySession** | `Map<SessionId, CredentialId>` | start, onExit, succeed, fail | onExit | acceptance/result | **operation** | in-flight machine command, credential/login, discovery or handoff chain; stable operation/result rows replace local promises/maps |
| S1190 `modules/credentials/sign-in.ts:305` **HomeSignInService.now** | `() => number` | constructor/callback | succeed | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1191 `modules/credentials/sign-in.ts:307` **HomeSignInService.deps** | `HomeSignInDeps` | constructor/initializer | start, constructor/callback, onExit, succeed, closeTerminal, removeHome | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/credentials/vault.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1201 `modules/credentials/vault.ts:72` **SecretUnavailableError.credentialId** | `CredentialId` | constructor/initializer | SecretUnavailableError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1202 `modules/credentials/vault.ts:73` **SecretUnavailableError.reason** | `'not-found' \| 'revoked' \| 'no-secret' \| 'needs-attention'` | constructor/initializer | SecretUnavailableError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1203 `modules/credentials/vault.ts:101` **Vault.dataKey** | `Buffer \| null` | load, adopt, reset | state, canOpen, ensureDataKey, seal, open, exportDataKey | answer/decision | **derived** | unwrapped key/key metadata/provider problem or create-in-flight state; Q-vault; no plaintext shared object as correctness authority |
| S1204 `modules/credentials/vault.ts:102` **Vault.dataKeyId** | `string \| null` | load, adopt | canOpen, seal, open | answer/decision | **derived** | unwrapped key/key metadata/provider problem or create-in-flight state; Q-vault; no plaintext shared object as correctness authority |
| S1205 `modules/credentials/vault.ts:103` **Vault.stored** | `StoredVaultKey \| null` | load, constructor/callback | load, state, status, constructor/callback | answer/decision | **derived** | unwrapped key/key metadata/provider problem or create-in-flight state; Q-vault; no plaintext shared object as correctness authority |
| S1206 `modules/credentials/vault.ts:104` **Vault.provider** | `KeyProvider \| null` | load | load, constructor/callback | answer/decision | **derived** | unwrapped key/key metadata/provider problem or create-in-flight state; Q-vault; no plaintext shared object as correctness authority |
| S1207 `modules/credentials/vault.ts:105` **Vault.problem** | `string \| null` | load | status, refusal | answer/decision | **derived** | unwrapped key/key metadata/provider problem or create-in-flight state; Q-vault; no plaintext shared object as correctness authority |
| S1208 `modules/credentials/vault.ts:106` **Vault.creating** | `Promise<void> \| null` | ensureDataKey, constructor/callback | ensureDataKey | answer/decision | **derived** | key-creation exclusion; Q-vault atomic insert-if-absent, with encrypted key material |
| S1209 `modules/credentials/vault.ts:109` **Vault.keyPath** | `string` | constructor/initializer | lockedProblem, status, refusal | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1210 `modules/credentials/vault.ts:110` **Vault.providerFactory** | `() => Promise<KeyProvider>` | constructor/initializer | load | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1211 `modules/credentials/vault.ts:111` **Vault.store** | `VaultKeyStore` | constructor/initializer | load, constructor/callback, reset | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/effects/registry.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1527 `modules/effects/registry.ts:139` **EffectExecutorRegistry.executors** | `Map<string, EffectExecutor>` | register | register, get, kinds | wiring/code only | **delete** | immutable command/kind/provider/executor registration; freeze code registry; handlers take explicit request/job context |

### modules/effects/runner.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1528 `modules/effects/runner.ts:106` **EffectsRunner.live** | `Map<string, LiveRun>` | dispatch, recover | stop, onCommitted, poke, sweepOnce, dispatch, recover | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1529 `modules/effects/runner.ts:108` **EffectsRunner.work** | `Set<Promise<void>>` | track, constructor/callback | idle | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1530 `modules/effects/runner.ts:109` **EffectsRunner.stopTimer** | `(() => void) \| undefined` | start, stop | stop | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1531 `modules/effects/runner.ts:110` **EffectsRunner.unsubscribe** | `(() => void) \| undefined` | start, stop | start, stop | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1532 `modules/effects/runner.ts:111` **EffectsRunner.sweeping** | `Promise<void> \| undefined` | sweep | idle, sweep | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1533 `modules/effects/runner.ts:112` **EffectsRunner.stopped** | `boolean` | stop | onCommitted, poke, sweep, drainOffFeed, dispatch, recover | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1534 `modules/effects/runner.ts:114` **EffectsRunner.deps** | `EffectsRunnerDeps` | constructor/initializer | start, poke, sweepOnce, drainOffFeed, dispatch, recover, runExecutor, settle, constructor/callback, sweepWrite | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/events/retention.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0650 `modules/events/retention.ts:30` **EventLogRetention.bootTimer** | `ReturnType<typeof setTimeout> \| undefined` | start, dispose | start, dispose | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0651 `modules/events/retention.ts:31` **EventLogRetention.timer** | `ReturnType<typeof setInterval> \| undefined` | constructor/callback, dispose | constructor/callback, dispose | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0652 `modules/events/retention.ts:32` **EventLogRetention.shutdown** | `AbortController` | dispose | drainPruneRequests, runPruneJob | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0653 `modules/events/retention.ts:33` **EventLogRetention.pruneFlight** | `Promise<{ deleted: number; metrics: TimeBudgetedJobMetrics }> \| undefined` | pruneNow, clear | pruneNow, clear | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0654 `modules/events/retention.ts:34` **EventLogRetention.pruneRerunRequested** | `boolean` | dispose, pruneNow, drainPruneRequests | drainPruneRequests | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0655 `modules/events/retention.ts:37` **EventLogRetention.events** | `Pick<EventsRepository, 'planEventPrune' \| 'pruneEventBatch'>` | constructor/initializer | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0656 `modules/events/retention.ts:38` **EventLogRetention.options** | `EventLogRetentionOptions` | constructor/initializer | runPruneJob | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/files/orphan-audit.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1377 `modules/files/orphan-audit.ts:198` **OrphanAudit.now** | `() => number` | constructor/callback | run | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1378 `modules/files/orphan-audit.ts:199` **OrphanAudit.minAgeMs** | `number` | constructor/callback | run | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1379 `modules/files/orphan-audit.ts:200` **OrphanAudit.partBytes** | `number` | constructor/callback | auditLake | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1380 `modules/files/orphan-audit.ts:201` **OrphanAudit.dryRun** | `boolean` | constructor/callback | run, settle | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1381 `modules/files/orphan-audit.ts:202` **OrphanAudit.overrideCeiling** | `ReadonlySet<AuditedRoot>` | constructor/callback | settle | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1382 `modules/files/orphan-audit.ts:204` **OrphanAudit.planned** | `BlobKey[]` | plan, orphan | plan | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1383 `modules/files/orphan-audit.ts:208` **OrphanAudit.files** | `BlobStore` | settle | auditArtifacts, auditPendingUploads, auditLake | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1384 `modules/files/orphan-audit.ts:209` **OrphanAudit.workspaceId** | `WorkspaceId` | constructor/initializer | run, settle | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1385 `modules/files/orphan-audit.ts:210` **OrphanAudit.records** | `OrphanAuditRecords` | constructor/initializer | run, pendingRows, stagedUploads, flush | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### modules/files/path-search.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1386 `modules/files/path-search.ts:158` **PathIndex.entries** | `Map<string, { paths: readonly string[]; expiresAt: number }>` | paths | paths | live correctness | **room** | machine file-path browse/search working set; room direct ask, invalidated by TTL/source change/disconnect, never used for Core file authorization |
| S1387 `modules/files/path-search.ts:161` **PathIndex.ttlMs** | `number` | constructor/initializer | paths | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1388 `modules/files/path-search.ts:162` **PathIndex.failureTtlMs** | `number` | constructor/initializer | paths | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1389 `modules/files/path-search.ts:163` **PathIndex.now** | `() => number` | constructor/initializer | paths | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/funnel.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1288 `modules/funnel.ts:65` **WriteFunnel.deps** | `WriteFunnelDeps` | constructor/initializer | run, cursor, visibilityGrade, queue, flushDeltas | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1289 `modules/funnel.ts:134` **WriteFunnel.pending** | `ScopedDelivery[]` | queue, flushDeltas | flushDeltas | local follow-up/order | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S1290 `modules/funnel.ts:135` **WriteFunnel.cancelScheduledFlush** | `(() => void) \| undefined` | queue, flushDeltas | queue, flushDeltas | local follow-up/order | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S1291 `modules/funnel.ts:136` **WriteFunnel.publicationTail** | `Promise<void>` | flushDeltas | flushDeltas | local follow-up/order | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |

### modules/hosts/metrics-demand.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1310 `modules/hosts/metrics-demand.ts:26` **HibernationMetricsDemand.generation** | `number` | connected, reevaluate | connected, reevaluate | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S1311 `modules/hosts/metrics-demand.ts:28` **HibernationMetricsDemand.deps** | `MetricsDemandDeps` | constructor/initializer | connected, disconnected, reevaluate | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/hosts/processes-topic.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1307 `modules/hosts/processes-topic.ts:15` **MachineProcessesTopic.readers** | `MachineProcessReaders \| undefined` | installReaders | installReaders, requireReaders | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S1308 `modules/hosts/processes-topic.ts:27` **MachineProcessesTopic.held** | `Map< string, { value?: TopicPayload<'machine.processes'> reading: boolean preparing?: boolean next?: HostMemoryBreakdown } >` | start, unavailable, stop | snapshot, constructor/callback, unavailable, refresh, receive | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S1309 `modules/hosts/processes-topic.ts:37` **MachineProcessesTopic.deps** | `{ supports: (id: MachineId) => boolean send: (id: MachineId, frame: TopicWatchMessage) => void publish: (id: string, value: TopicPayload<'machine.processes'> \| undefined) => voi…` | constructor/initializer | constructor/callback, unavailable, refresh, stop | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/hosts/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1296 `modules/hosts/service.ts:216` **HostsService.latestHostMetrics** | `Map<string, HostMetricsWire>` | constructor/callback, install | resumeAfterTransferFence, latestFor, hostMetricsMessage, snapshotFor | live correctness | **room** | live machine pressure, watched-terminal reclaim or hibernation policy state; only room reads live metrics/watchers; accepted durable transitions go through Core operations |
| S1297 `modules/hosts/service.ts:229` **HostsService.latestLoopMinutes** | `Map<MachineId, LoopMinuteWire>` | constructor/callback, recordLoopMinute | recordLoopMinute, loopMinutes | live correctness | **room** | live machine pressure, watched-terminal reclaim or hibernation policy state; only room reads live metrics/watchers; accepted durable transitions go through Core operations |
| S1298 `modules/hosts/service.ts:231` **HostsService.deferredPressureMachines** | `Set<MachineId>` | onHostMetrics, resumeAfterTransferFence | resumeAfterTransferFence | live correctness | **room** | live machine pressure, watched-terminal reclaim or hibernation policy state; only room reads live metrics/watchers; accepted durable transitions go through Core operations |
| S1299 `modules/hosts/service.ts:236` **HostsService.lastAutoHibernateMsByMachine** | `Map<string, number>` | maybeAutoHibernate | maybeAutoHibernate | live correctness | **room** | live machine pressure, watched-terminal reclaim or hibernation policy state; only room reads live metrics/watchers; accepted durable transitions go through Core operations |
| S1300 `modules/hosts/service.ts:237` **HostsService.countHibernateBudgetByMachine** | `Map<string, CountHibernateBudget>` | countBudgetFor | countBudgetFor | live correctness | **room** | live machine pressure, watched-terminal reclaim or hibernation policy state; only room reads live metrics/watchers; accepted durable transitions go through Core operations |
| S1301 `modules/hosts/service.ts:238` **HostsService.lastCapUnmetByMachine** | `Map<string, string>` | maybeAutoHibernate, applyCountPressure, reportCapUnmet | reportCapUnmet | diagnostics only | **delete** | diagnostic suppression, no action authority |
| S1302 `modules/hosts/service.ts:243` **HostsService.attachTuiParkOrdered** | `Set<SessionId>` | applyAttachTuiPressure | applyAttachTuiPressure | live correctness | **room** | live machine pressure, watched-terminal reclaim or hibernation policy state; only room reads live metrics/watchers; accepted durable transitions go through Core operations |
| S1303 `modules/hosts/service.ts:245` **HostsService.lastUnobservedCountByMachine** | `Map<string, number>` | maybeAutoHibernate, reportUnobservedCounted | reportUnobservedCounted | live correctness | **room** | live machine pressure, watched-terminal reclaim or hibernation policy state; only room reads live metrics/watchers; accepted durable transitions go through Core operations |
| S1304 `modules/hosts/service.ts:246` **HostsService.missingProofLogged** | `Set<string>` | eligibleCandidates | eligibleCandidates | diagnostics only | **delete** | diagnostic suppression, no action authority |
| S1305 `modules/hosts/service.ts:248` **HostsService.reclaimDiskEstimateByMachine** | `Map<string, ReclaimDiskEstimateCacheEntry>` | reclaimDiskEstimate | reclaimDiskEstimate, constructor/callback | live correctness | **room** | live machine pressure, watched-terminal reclaim or hibernation policy state; only room reads live metrics/watchers; accepted durable transitions go through Core operations |
| S1306 `modules/hosts/service.ts:250` **HostsService.deps** | `HostsDeps` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/inference/complete.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1535 `modules/inference/complete.ts:137` **InferenceNotConfigured.name** | `inferred value/definition` | constructor/initializer | InferenceNotConfigured consumers | no independent truth | **delete** | request error name constant; no between-request state |

### modules/instance/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1038 `modules/instance/service.ts:231` **InstanceService.deps** | `InstanceDeps` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/interactions/feed.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1286 `modules/interactions/feed.ts:72` **InteractionFeedPublisher.deps** | `InteractionFeedDeps` | constructor/initializer | capture | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1287 `modules/interactions/feed.ts:81` **InteractionFeedPublisher.capture** | `InteractionFeedCapture` | constructor/initializer | InteractionFeedPublisher consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/interactions/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1283 `modules/interactions/service.ts:273` **InteractionService.deps** | `InteractionServiceDeps` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1284 `modules/interactions/service.ts:313` **InteractionService.policyDeliveryInFlight** | `Map<string, InteractionRow>` | overtakePolicyDeliveries, onInteractionResolved, applyDefaultAnswer | overtakePolicyDeliveries | acceptance/result | **operation** | interaction answer/policy delivery exclusion; durable operation+receipt keyed by interaction id |
| S1285 `modules/interactions/service.ts:499` **InteractionService.sessionChain** | `Map<SessionId, Promise<void>>` | chain, constructor/callback | chain, constructor/callback | acceptance/result | **operation** | interaction answer/policy delivery exclusion; durable operation+receipt keyed by interaction id |

### modules/issue-session-lifecycle.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1173 `modules/issue-session-lifecycle.ts:34` **IssueSessionLifecycle.closedIssueStops** | `Map<string, Promise<void>>` | stopClosedIssueNow, constructor/callback | stopClosedIssueNow, constructor/callback | work/claim/retry | **job** | closed-issue stop/retry/refusal work; idempotent job by issue/session/revision |
| S1174 `modules/issue-session-lifecycle.ts:36` **IssueSessionLifecycle.closedIssueRefusals** | `ClosedIssueRefusals` | constructor/initializer | constructor/callback, sweepClosedIssues | work/claim/retry | **job** | closed-issue stop/retry/refusal work; idempotent job by issue/session/revision |
| S1175 `modules/issue-session-lifecycle.ts:37` **IssueSessionLifecycle.closedIssueSweepTimer** | `ReturnType<typeof setInterval> \| undefined` | constructor/callback, dispose | startClosedIssueSweep, constructor/callback, dispose | work/claim/retry | **job** | closed-issue stop/retry/refusal work; idempotent job by issue/session/revision |
| S1176 `modules/issue-session-lifecycle.ts:39` **IssueSessionLifecycle.sweepingClosedIssues** | `boolean` | sweepClosedIssues | sweepClosedIssues | work/claim/retry | **job** | closed-issue stop/retry/refusal work; idempotent job by issue/session/revision |
| S1177 `modules/issue-session-lifecycle.ts:41` **IssueSessionLifecycle.disposed** | `boolean` | dispose | constructor/callback | work/claim/retry | **job** | closed-issue stop/retry/refusal work; idempotent job by issue/session/revision |
| S1178 `modules/issue-session-lifecycle.ts:44` **IssueSessionLifecycle.deps** | `{ issues: IssueService sessions: SessionLifecycle ledger: Pick<LedgerWriter, 'commit'> /** The issue revision arbitration, applied to a command's own writer. */ arbitrate: (writ…` | constructor/initializer | draftForStart, discardUnlaunchedDraft, recordParticipation, sessionWorkflow, rehome, resumeSession, resurrectSession, stopSession, stopIssue, stopClosedIssueNow, constructor/callback, closedIssueSweepCandidates, handoffSession, deleteIssue, restoreIssue | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/issues/access-index.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1055 `modules/issues/access-index.ts:15` **DurableIssueAccessIndex.issues** | `IssuesRepository` | constructor/initializer | has, ancestorIds, getMeta, isIssueWorktree, soleOwnerForCwd, issueForCwd, issuesForCwds | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1056 `modules/issues/access-index.ts:16` **DurableIssueAccessIndex.grants** | `GrantsRepository` | constructor/initializer | DurableIssueAccessIndex consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1057 `modules/issues/access-index.ts:17` **DurableIssueAccessIndex.repos** | `ReposRepository` | constructor/initializer | roots | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/issues/artifact-store.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1046 `modules/issues/artifact-store.ts:194` **UploadIncomplete.name** | `inferred value/definition` | constructor/initializer | UploadIncomplete consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1047 `modules/issues/artifact-store.ts:316` **IssueArtifactStore.files** | `BlobStore` | constructor/callback, adopt, deletePrefix | putChunk, assertSameChunk, composeMember, upload, adopt, relinquish, pullFile, readStream, keysUnder | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1048 `modules/issues/artifact-store.ts:317` **IssueArtifactStore.uploads** | `ArtifactUploadState` | constructor/callback, publishStaged, discardUpload | transfer, beginUpload, acceptChunk, publishUpload, sweepUploads, removeIssue | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1049 `modules/issues/artifact-store.ts:318` **IssueArtifactStore.rpc** | `ArtifactRpc` | constructor/callback | snapshot, walkDir, pullFile | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1050 `modules/issues/artifact-store.ts:319` **IssueArtifactStore.now** | `() => number` | constructor/callback | beginUpload, sweepUploads | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/issues/authority-arbitration.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1052 `modules/issues/authority-arbitration.ts:37` **IssueAuthorityArbitration.scope** | `AsyncLocalStorage<IssueArbitrationScope>` | run | run, commit | request/tx context | **delete** | one-command arbitration async scope; keep context within transaction/request only |
| S1053 `modules/issues/authority-arbitration.ts:39` **IssueAuthorityArbitration.ledger** | `{ commit<T>(op: LedgerCommitOp<T>): Promise<LedgerCommitResult<T>> }` | constructor/callback | IssueAuthorityArbitration consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1054 `modules/issues/authority-arbitration.ts:43` **IssueAuthorityArbitration.source** | `Omit<LedgerWriter, 'scope'>` | constructor/initializer | commit | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/issues/auto-archive.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1108 `modules/issues/auto-archive.ts:20` **IssueAutoArchive.bootTimer** | `ReturnType<typeof setTimeout> \| undefined` | start, dispose | start, dispose | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1109 `modules/issues/auto-archive.ts:21` **IssueAutoArchive.timer** | `ReturnType<typeof setInterval> \| undefined` | constructor/callback, dispose | constructor/callback, dispose | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1110 `modules/issues/auto-archive.ts:23` **IssueAutoArchive.sweeping** | `boolean` | sweep | sweep | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1111 `modules/issues/auto-archive.ts:25` **IssueAutoArchive.attention** | `Pick<IssueService['attention'], 'sweepAutoArchive'>` | constructor/initializer | sweep | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/issues/command-ctx.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1039 `modules/issues/command-ctx.ts:366` **IssueCommandCtx.deps** | `IssueCommandDeps` | constructor/initializer | writer, crud, hierarchy, commentsMail, attention, gitWorkflow, reports, shipping, access, deleteIssue, restoreIssue, withMutation, assertSourceInSubtree | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1040 `modules/issues/command-ctx.ts:367` **IssueCommandCtx.caller** | `IssueCaller` | constructor/initializer | writer, requirePrincipal, markerUser, readerUser, mailIdentity, messageSender, capabilitySender, spawnProvenance, mailOwnIssue, shipIssue, deriveSubscriber, assertSourceInSubtree | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1041 `modules/issues/command-ctx.ts:368` **IssueCommandCtx.name** | `string` | constructor/initializer | writer, withMutation | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/issues/conflict.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1112 `modules/issues/conflict.ts:26` **IssueRevisionConflict.detail** | `IssueRevisionConflictDetail` | constructor/initializer | IssueRevisionConflict consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/issues/dispatcher.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1051 `modules/issues/dispatcher.ts:80` **IssueCommandDispatcher.deps** | `IssueCommandDeps` | constructor/initializer | withoutDedup, withoutEffects, forEffectRun, run, execute, currentRevision, context, visibleResult, dispatch, parentSessionOf, constructor/callback, throughEntry | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/issues/git-watch.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1113 `modules/issues/git-watch.ts:27` **IssueGitWatch.bootTimer** | `ReturnType<typeof setTimeout> \| undefined` | start, dispose | start, dispose | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1114 `modules/issues/git-watch.ts:28` **IssueGitWatch.timer** | `ReturnType<typeof setInterval> \| undefined` | constructor/callback, dispose | constructor/callback, dispose | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1115 `modules/issues/git-watch.ts:29` **IssueGitWatch.sweeping** | `boolean` | sweep | sweep | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1116 `modules/issues/git-watch.ts:31` **IssueGitWatch.gitWorkflow** | `Pick<IssueService['gitWorkflow'], 'sweepParentBranchMovement'>` | constructor/initializer | sweep | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/issues/pending-uploads.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1043 `modules/issues/pending-uploads.ts:92` **PendingUploadStore.files** | `BlobStore` | constructor/callback, put, discard, sweep | put, bytes | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1044 `modules/issues/pending-uploads.ts:93` **PendingUploadStore.records** | `PendingUploadRecords` | constructor/callback, sweep | put, meta, markClaimed, claimedBy, markUnclaimed, discard, sweep | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1045 `modules/issues/pending-uploads.ts:94` **PendingUploadStore.now** | `() => number` | constructor/callback | put, sweep | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/issues/relay-gate.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1042 `modules/issues/relay-gate.ts:258` **AgentRelayGate.deps** | `AgentRelayGateDeps` | constructor/initializer | reply, run | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/issues/service/assistant.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1058 `modules/issues/service/assistant.ts:37` **IssueAssistantDigestModule.assistantTimers** | `Map<string, ReturnType<typeof setTimeout>>` | onSessionActivity, constructor/callback | onSessionActivity | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1059 `modules/issues/service/assistant.ts:39` **IssueAssistantDigestModule.store** | `IssueStore` | constructor/initializer | onSessionActivity, refreshAssistant, constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1060 `modules/issues/service/assistant.ts:49` **IssueAssistantDigestModule.lastAssistantError** | `string \| undefined` | refreshAssistant | backgroundLastError | answer/decision | **derived** | last assistant failure detail; Q-effect (persist structured result if absent) |

### modules/issues/service/attention.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1092 `modules/issues/service/attention.ts:48` **IssueAttentionModule.store** | `IssueStore` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1093 `modules/issues/service/attention.ts:49` **IssueAttentionModule.crud** | `() => Pick< IssueCrudModule, \| 'create' \| 'update' \| 'purgeEmptyDraft' \| 'panelChatUploadRelease' \| 'defer' \| 'undefer' \| 'setNeedsHuman' \| 'clearNeedsHuman' \| 'markIssueRead' \|…` | constructor/initializer | defer, undefer, setNeedsHuman, clearNeedsHuman, markIssueRead, markIssueUnread, setIssueTucked, attachSession, deleteIfEmptyDraft, discardUnlaunchedDraft, createDraftFor, archive | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1094 `modules/issues/service/attention.ts:63` **IssueAttentionModule.hierarchy** | `() => { addDep( writer: IssueWriter, fromRef: string, toRef: string, type?: string, ): Promise<IssueProjection> }` | constructor/initializer | attachSession | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1095 `modules/issues/service/attention.ts:71` **IssueAttentionModule.reports** | `() => Pick<IssueReportsModule, 'niceRef'>` | constructor/initializer | attachSession, assertReplacementCoordination | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1096 `modules/issues/service/attention.ts:72` **IssueAttentionModule.gitWorkflow** | `() => IssueAttentionWorktreePort` | constructor/initializer | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/issues/service/core.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1061 `modules/issues/service/core.ts:87` **IssueStore.deps** | `IssueDeps` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1062 `modules/issues/service/core.ts:386` **IssueStore.draftOrigins** | `WeakMap<IssueRow, number \| null>` | draftOf, registerNewDraft, repinDraft | draftPin | request/tx context | **delete** | one-command issue draft provenance/worktree origin WeakMaps; request/transaction only |
| S1063 `modules/issues/service/core.ts:389` **IssueStore.draftWorktrees** | `WeakMap<IssueRow, string \| null>` | draftOf, registerNewDraft, repinDraft | worktreeBefore | request/tx context | **delete** | one-command issue draft provenance/worktree origin WeakMaps; request/transaction only |
| S1064 `modules/issues/service/core.ts:1106` **IssueStore.slug** | `inferred value/definition` | constructor/initializer | IssueStore consumers | wiring/code only | **delete** | pure branch slug function alias |

### modules/issues/service/crud.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1073 `modules/issues/service/crud.ts:239` **IssueCrudModule.store** | `IssueStore` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1074 `modules/issues/service/crud.ts:240` **IssueCrudModule.hierarchy** | `() => IssueCrudHierarchyPort` | constructor/initializer | create, update | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1075 `modules/issues/service/crud.ts:241` **IssueCrudModule.attention** | `() => IssueCrudAttentionPort` | constructor/initializer | update | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1076 `modules/issues/service/crud.ts:242` **IssueCrudModule.gitWorkflow** | `() => IssueCrudGitWorkflowPort` | constructor/initializer | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1077 `modules/issues/service/crud.ts:243` **IssueCrudModule.onIssueClosed** | `IssueDeps['onIssueClosed']` | constructor/initializer | update | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1078 `modules/issues/service/crud.ts:847` **IssueCrudModule.chatUploadLocks** | `Map<string, Promise<void>>` | underChatUploadLock | underChatUploadLock, chatUploadBytes | answer/decision | **derived** | upload claim/append exclusion; Q-upload with guarded row transition, not Promise locks |
| S1079 `modules/issues/service/crud.ts:866` **IssueCrudModule.chatUploadClaims** | `Map<string, Promise<void>>` | constructor/callback, panelChatUploadClaim | panelChatUploadClaim | answer/decision | **derived** | upload claim/append exclusion; Q-upload with guarded row transition, not Promise locks |

### modules/issues/service/hierarchy.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1065 `modules/issues/service/hierarchy.ts:11` **IssueHierarchyModule.store** | `IssueStore` | constructor/initializer | dependencyPath, containmentPath, addDep, constructor/callback, removeDep, setParentForUpdate, reparent, ancestorIds, inProposedSubtree, supersede, duplicate | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1066 `modules/issues/service/hierarchy.ts:12` **IssueHierarchyModule.crud** | `() => Pick<IssueCrudModule, 'update'>` | constructor/initializer | supersede, duplicate | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/issues/service/index.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1085 `modules/issues/service/index.ts:202` **IssueServiceRoot.crud** | `IssueCrudModule` | constructor/callback | IssueServiceRoot consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1086 `modules/issues/service/index.ts:203` **IssueServiceRoot.hierarchy** | `IssueHierarchyModule` | constructor/callback | IssueServiceRoot consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1087 `modules/issues/service/index.ts:204` **IssueServiceRoot.commentsMail** | `IssueCommentsMailModule` | constructor/callback | IssueServiceRoot consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1088 `modules/issues/service/index.ts:205` **IssueServiceRoot.attention** | `IssueAttentionModule` | constructor/callback | IssueServiceRoot consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1089 `modules/issues/service/index.ts:206` **IssueServiceRoot.gitWorkflow** | `IssueGitWorkflowModule` | constructor/callback | IssueServiceRoot consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1090 `modules/issues/service/index.ts:207` **IssueServiceRoot.reports** | `IssueReportsModule` | constructor/callback | recoverLegacyMembership | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/issues/service/integration.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1080 `modules/issues/service/integration.ts:45` **IssueEpicIntegrationModule.integratingEpics** | `Set<string>` | integrate | integrate | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1081 `modules/issues/service/integration.ts:48` **IssueEpicIntegrationModule.store** | `IssueStore` | constructor/initializer | integrate, refuse, integrateRun, constructor/callback, descendantsOf, topoOrderChildren | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1082 `modules/issues/service/integration.ts:49` **IssueEpicIntegrationModule.commentsMail** | `() => Pick<IssueCommentsMailModule, 'addComment'>` | constructor/initializer | integrateRun | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1083 `modules/issues/service/integration.ts:50` **IssueEpicIntegrationModule.attention** | `() => Pick<IssueAttentionModule, 'setNeedsHuman'>` | constructor/initializer | integrateRun | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1084 `modules/issues/service/integration.ts:51` **IssueEpicIntegrationModule.integrationReceipts** | `RootIntegrationReceiptStore` | constructor/initializer | integrateRun | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/issues/service/mail.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1071 `modules/issues/service/mail.ts:40` **IssueCommentsMailModule.store** | `IssueStore` | constructor/initializer | addComment, constructor/callback, changeComment, authorOf, mailInbox, write, mailClaim, mailPending, mailMessage | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1072 `modules/issues/service/mail.ts:41` **IssueCommentsMailModule.reports** | `() => Pick<IssueReportsModule, 'comments' \| 'get' \| 'niceRef'>` | constructor/initializer | comments, constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/issues/service/not-found.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1091 `modules/issues/service/not-found.ts:47` **IssueNotFound.ref** | `string` | constructor/initializer | IssueNotFound consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/issues/service/reads.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1067 `modules/issues/service/reads.ts:256` **IssueReportsModule.store** | `IssueStore` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1068 `modules/issues/service/reads.ts:257` **IssueReportsModule.visibilityPolicy** | `Readonly<IssueReportVisibilityPolicy>` | constructor/initializer | IssueReportsModule consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/issues/service/workflow.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1097 `modules/issues/service/workflow.ts:187` **IssueGitWorkflowModule.assistant** | `IssueAssistantDigestModule` | constructor/callback | onSessionActivity, refreshAssistant, backgroundLastError | work/claim/retry | **job** | worktree start/refresh single-flight and scheduling; job rows plus machine operations; no process lock |
| S1098 `modules/issues/service/workflow.ts:189` **IssueGitWorkflowModule.worktreeGc** | `IssueWorktreeGcModule` | constructor/callback | releaseWorktreeIfIdle, listReclaimableWorktrees, releaseReclaimableWorktrees, tryWorktreeGcObserved | work/claim/retry | **job** | worktree start/refresh single-flight and scheduling; job rows plus machine operations; no process lock |
| S1099 `modules/issues/service/workflow.ts:191` **IssueGitWorkflowModule.integration** | `IssueEpicIntegrationModule` | constructor/callback | integrate | work/claim/retry | **job** | worktree start/refresh single-flight and scheduling; job rows plus machine operations; no process lock |
| S1100 `modules/issues/service/workflow.ts:194` **IssueGitWorkflowModule.store** | `IssueStore` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1101 `modules/issues/service/workflow.ts:195` **IssueGitWorkflowModule.crud** | `() => Pick< IssueCrudModule, 'update' \| 'create' \| 'close' \| 'defer' \| 'agentProfileIdFor' \| 'switchesHarness' >` | constructor/initializer | rehome, startOnce, createAndMaybeStart, finishLanding, onSessionAttention | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1102 `modules/issues/service/workflow.ts:199` **IssueGitWorkflowModule.commentsMail** | `() => Pick<IssueCommentsMailModule, 'addComment'>` | constructor/initializer | freeWorktreeKeepBranch, ensureWorktree, cleanup | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1103 `modules/issues/service/workflow.ts:416` **IssueGitWorkflowModule.startsInFlight** | `Map<string, Promise<IssueStartResult>>` | start | start | work/claim/retry | **job** | worktree start/refresh single-flight and scheduling; job rows plus machine operations; no process lock |
| S1104 `modules/issues/service/workflow.ts:2206` **IssueGitWorkflowModule.gitRefreshes** | `Map< string, { promise: Promise<void>; rerun: boolean; fallbackCwd?: string } >` | constructor/callback, refreshGitState | refreshGitState, constructor/callback | work/claim/retry | **job** | worktree start/refresh single-flight and scheduling; job rows plus machine operations; no process lock |
| S1105 `modules/issues/service/workflow.ts:2210` **IssueGitWorkflowModule.gitCommitsBySession** | `Map<string, string[]>` | captureSessionGitActivity, onSessionRemovedOrArchived | captureSessionGitActivity, gitAttributionFor | answer/decision | **derived** | session commit/path and parent-tip copies; Q-git (persist missing per-session delta keys before deleting hints) |
| S1106 `modules/issues/service/workflow.ts:2211` **IssueGitWorkflowModule.gitTouchedBySession** | `Map<string, Set<string>>` | captureSessionGitActivity, onSessionRemovedOrArchived | captureSessionGitActivity, gitAttributionFor | answer/decision | **derived** | session commit/path and parent-tip copies; Q-git (persist missing per-session delta keys before deleting hints) |
| S1107 `modules/issues/service/workflow.ts:2216` **IssueGitWorkflowModule.parentTips** | `Map<string, string>` | sweepParentBranchMovement, constructor/callback | sweepParentBranchMovement, constructor/callback | answer/decision | **derived** | session commit/path and parent-tip copies; Q-git (persist missing per-session delta keys before deleting hints) |

### modules/issues/service/worktree-gc.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1069 `modules/issues/service/worktree-gc.ts:30` **IssueWorktreeGcModule.store** | `IssueStore` | constructor/initializer | releaseWorktreeIfIdle, isCandidate, listReclaimableWorktrees, constructor/callback, tryObserved, refuseRelease | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1070 `modules/issues/service/worktree-gc.ts:31` **IssueWorktreeGcModule.freeWorktreeKeepBranch** | `FreeWorktree` | constructor/initializer | releaseWorktreeIfIdle | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/layout/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1536 `modules/layout/service.ts:32` **LayoutService.deps** | `LayoutServiceDeps` | constructor/initializer | getSnapshot, write, set, clear, panelModeDiff | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/lock/registry.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1149 `modules/lock/registry.ts:92` **LockCommandCtx.deps** | `LockCommandDeps` | constructor/initializer | locks, callerIdentity | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1150 `modules/lock/registry.ts:93` **LockCommandCtx.caller** | `IssueCaller` | constructor/initializer | callerIdentity | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1151 `modules/lock/registry.ts:243` **LockCommandDispatcher.deps** | `LockCommandDeps` | constructor/initializer | run | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/lock/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1148 `modules/lock/service.ts:119` **LockService.deps** | `LockServiceDeps` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/logs/fleet-director.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1525 `modules/logs/fleet-director.ts:99` **FleetLogLevelDirector.fleet** | `DaemonConnectionsPort` | constructor/initializer | setLevel | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1526 `modules/logs/fleet-director.ts:100` **FleetLogLevelDirector.drops** | `FleetDropCounts` | constructor/initializer | setLevel | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/logs/fleet-store.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1523 `modules/logs/fleet-store.ts:227` **FleetLogStore.writer** | `QueuedRecordWriter` | constructor/callback, close | append, pendingWrites, serverDroppedFor | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S1524 `modules/logs/fleet-store.ts:231` **FleetLogStore.daemonDropped** | `Map<string, number>` | append | append, droppedFor | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |

### modules/logs/level-director.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1510 `modules/logs/level-director.ts:104` **ClientLogLevelDirector.clients** | `ClientConnectionsPort` | constructor/initializer | setLevel | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/logs/queued-writer.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1511 `modules/logs/queued-writer.ts:103` **QueuedRecordWriter.dir** | `string` | constructor/callback | sinkFor | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S1512 `modules/logs/queued-writer.ts:104` **QueuedRecordWriter.kind** | `string` | constructor/callback | sinkFor | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S1513 `modules/logs/queued-writer.ts:105` **QueuedRecordWriter.maxFiles** | `number` | constructor/callback | assign | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S1514 `modules/logs/queued-writer.ts:106` **QueuedRecordWriter.maxPending** | `number` | constructor/callback | enqueue | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S1515 `modules/logs/queued-writer.ts:107` **QueuedRecordWriter.writeSlice** | `number` | constructor/callback | drainSlice | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S1516 `modules/logs/queued-writer.ts:108` **QueuedRecordWriter.makeSink** | `(path: string) => FileSink` | constructor/callback | sinkFor | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S1517 `modules/logs/queued-writer.ts:109` **QueuedRecordWriter.sinks** | `Map<string, FileSink>` | close, sinkFor | close, sinkFor | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S1518 `modules/logs/queued-writer.ts:119` **QueuedRecordWriter.assigned** | `Map<string, string>` | assign | assign | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S1519 `modules/logs/queued-writer.ts:124` **QueuedRecordWriter.dropped** | `Map<string, number>` | enqueue | enqueue, droppedFor | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S1520 `modules/logs/queued-writer.ts:125` **QueuedRecordWriter.pending** | `PendingWrite[]` | enqueue, drainSlice | enqueue, pendingWrites, close, schedule | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S1521 `modules/logs/queued-writer.ts:126` **QueuedRecordWriter.scheduled** | `ReturnType<typeof setImmediate> \| undefined` | close, schedule, constructor/callback | close, schedule | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S1522 `modules/logs/queued-writer.ts:127` **QueuedRecordWriter.stopped** | `boolean` | close | closed, enqueue, schedule | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |

### modules/logs/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1507 `modules/logs/service.ts:177` **LogIngestService.crashStore** | `CrashStore` | constructor/callback | crash | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1508 `modules/logs/service.ts:178` **LogIngestService.onCrash** | `LogIngestDeps['onCrash']` | constructor/callback | crash | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1509 `modules/logs/service.ts:184` **LogIngestService.writer** | `QueuedRecordWriter` | constructor/callback, close | forward, serverDroppedFor | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/machines/condition-topic.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1458 `modules/machines/condition-topic.ts:26` **MachineConditionTopic.since** | `Map<MachineId, string>` | changed | snapshot | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S1459 `modules/machines/condition-topic.ts:28` **MachineConditionTopic.deps** | `MachineConditionTopicDeps` | constructor/initializer | snapshot, changed | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1460 `modules/machines/condition-topic.ts:30` **MachineConditionTopic.online** | `Map<MachineId, boolean>` | changed | changed | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |

### modules/machines/login-propagation.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1461 `modules/machines/login-propagation.ts:128` **LoginPropagationService.attempts** | `Map<string, AttemptState>` | propagate | propagate | acceptance/result | **operation** | in-flight machine command, credential/login, discovery or handoff chain; stable operation/result rows replace local promises/maps |
| S1462 `modules/machines/login-propagation.ts:129` **LoginPropagationService.now** | `() => number` | constructor/callback | propagate, record, run | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1463 `modules/machines/login-propagation.ts:131` **LoginPropagationService.deps** | `LoginPropagationDeps` | constructor/initializer | propagate, stillTicked, record, recordPlacement, run, constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/machines/refused-send.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1465 `modules/machines/refused-send.ts:12` **RefusedSendError.name** | `inferred value/definition` | constructor/initializer | RefusedSendError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### modules/machines/rpc.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1466 `modules/machines/rpc.ts:557` **DaemonRpcService.broker** | `DaemonRequestPort` | constructor/callback | nextRequestId, request, contextRead, settleDaemonReply | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1467 `modules/machines/rpc.ts:558` **DaemonRpcService.serverTransferDigests** | `Map<string, string>` | serverTransferPrepare, serverTransferValidate, serverTransferPromote, serverTransferAcknowledge | serverTransferChunk, serverTransferAbort | acceptance/result | **operation** | machine transfer digest or OAuth listener callback correlation; durable operation/result; self-hosted transfer keeps direct in-process exception |
| S1468 `modules/machines/rpc.ts:560` **DaemonRpcService.loopbacks** | `Map< string, { machineId: MachineId; onCallback: (callback: Payload<OauthLoopbackCallbackMessage>) => void } >` | constructor/callback, oauthLoopbackListen, oauthLoopbackCancel, onLoopbackCallback | onLoopbackCallback | acceptance/result | **operation** | machine transfer digest or OAuth listener callback correlation; durable operation/result; self-hosted transfer keeps direct in-process exception |
| S1469 `modules/machines/rpc.ts:565` **DaemonRpcService.deps** | `DaemonRpcDeps` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/machines/update-space-requests.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1464 `modules/machines/update-space-requests.ts:15` **UpdateSpaceRequests.pending** | `Map< string, { machineId: string send: Send fingerprint: string finish: (result: UpdateSpaceEstimate) => void } >` | finish, constructor/callback | request, receive, close | acceptance/result | **operation** | in-flight machine command, credential/login, discovery or handoff chain; stable operation/result rows replace local promises/maps |

### modules/maintenance/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1257 `modules/maintenance/service.ts:92` **MaintenanceService.now** | `() => number` | constructor/callback | constructor/callback, apply, gateCommand, applyMaintenanceCommandsPrune, recordPrune | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1258 `modules/maintenance/service.ts:93` **MaintenanceService.leaseTtlMs** | `number` | constructor/callback | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1259 `modules/maintenance/service.ts:94` **MaintenanceService.issues** | `MaintenanceServiceOptions['issues']` | constructor/callback | applyIssueAutoArchive, applyWorktreeGc | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1260 `modules/maintenance/service.ts:95` **MaintenanceService.sessions** | `MaintenanceServiceOptions['sessions']` | constructor/callback | applySessionAutoArchive | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1261 `modules/maintenance/service.ts:96` **MaintenanceService.automations** | `MaintenanceServiceOptions['automations']` | constructor/callback | applyAutomationFire | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1262 `modules/maintenance/service.ts:97` **MaintenanceService.messages** | `MaintenanceServiceOptions['messages']` | constructor/callback | applyMessageExpiry | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1263 `modules/maintenance/service.ts:98` **MaintenanceService.worktreeGcPolicy** | `NonNullable<MaintenanceServiceOptions['worktreeGcPolicy']>` | constructor/callback | handshake | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1264 `modules/maintenance/service.ts:99` **MaintenanceService.liveSessionIds** | `NonNullable<MaintenanceServiceOptions['liveSessionIds']>` | constructor/callback | applyQueuedMessagesExpiry, applyAutomationFire | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1265 `modules/maintenance/service.ts:100` **MaintenanceService.stewardTick** | `MaintenanceServiceOptions['stewardTick']` | constructor/callback | applyStewardPoll | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1266 `modules/maintenance/service.ts:101` **MaintenanceService.connectScan** | `MaintenanceServiceOptions['connectScan']` | constructor/callback | applyConnectScan | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1267 `modules/maintenance/service.ts:102` **MaintenanceService.localMachineId** | `string \| undefined` | constructor/callback | applyConnectScan | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1268 `modules/maintenance/service.ts:105` **MaintenanceService.store** | `SessionStore` | constructor/initializer | constructor/callback, gateCommand, applyMessageExpiry, applyEventLogPrune, applyChangeLogPrune, applyMaintenanceCommandsPrune, applyAppliedMutationsPrune, applyQueuedMessagesExpiry, applyIssueAutoArchive, applyConnectScan, recordPrune, write, appendExpiredEvent | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1269 `modules/maintenance/service.ts:106` **MaintenanceService.funnel** | `Pick<WriteFunnel, 'run'>` | write | MaintenanceService consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/memory/lake.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1487 `modules/memory/lake.ts:103` **TranscriptLake.mirror** | `MirrorService` | constructor/callback, dispose | mirroring, pauseMirroring, resumeMirroring, triggerSweep, readWindow, readIndexItems | no independent truth | **delete** | legacy lake handles/read promises; no new retirement design while POD-7329 is held; POD-7333 owns deletion |
| S1488 `modules/memory/lake.ts:104` **TranscriptLake.lake** | `PartedLake` | constructor/callback | readWindow, readIndexItems | no independent truth | **delete** | legacy lake handles/read promises; no new retirement design while POD-7329 is held; POD-7333 owns deletion |
| S1489 `modules/memory/lake.ts:105` **TranscriptLake.indexer** | `TranscriptIndexer` | constructor/callback, dispose | triggerSweep | no independent truth | **delete** | legacy lake handles/read promises; no new retirement design while POD-7329 is held; POD-7333 owns deletion |
| S1490 `modules/memory/lake.ts:107` **TranscriptLake.outstandingReads** | `Set<(result: MirrorReadReply) => void>` | dispose, settle, constructor/callback | dispose, pendingReads | no independent truth | **delete** | legacy lake handles/read promises; no new retirement design while POD-7329 is held; POD-7333 owns deletion |
| S1491 `modules/memory/lake.ts:108` **TranscriptLake.stopped** | `boolean` | dispose | dispose, pauseMirroring, resumeMirroring, triggerSweep, read | no independent truth | **delete** | legacy lake handles/read promises; no new retirement design while POD-7329 is held; POD-7333 owns deletion |
| S1492 `modules/memory/lake.ts:111` **TranscriptLake.deps** | `TranscriptLakeDeps` | constructor/initializer | pathHint, hasPredecessors, liveCursor, readWindow, readIndexItems, constructor/callback, requestRead, onMirrorResult | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/memory/search.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1485 `modules/memory/search.ts:59` **MemorySearchService.store** | `SessionStore` | constructor/initializer | searchConversations, searchInScope | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1486 `modules/memory/search.ts:60` **MemorySearchService.visibility** | `MemoryVisibilityPolicy` | constructor/initializer | searchConversations, searchInScope | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/memory/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1473 `modules/memory/service.ts:59` **MemoryService.latestDiagnostics** | `ConversationDiagnosticWire[]` | onDiscovery | diagnostics, broadcastDiagnostics | live correctness | **room** | live machine conversation diagnostics; bounded room topic, no durable decisions |
| S1474 `modules/memory/service.ts:60` **MemoryService.lastDiagnosticsBroadcast** | `inferred value/definition` | broadcastDiagnostics | broadcastDiagnostics | diagnostics only | **delete** | duplicate diagnostic broadcast serialization; no truth |
| S1475 `modules/memory/service.ts:61` **MemoryService.visibility** | `MemoryVisibilityPolicy` | constructor/callback | constructor/callback, setConversationMeta, conversationPodiumId, canReadSession | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1476 `modules/memory/service.ts:62` **MemoryService.searcher** | `MemorySearchService` | constructor/callback | searchConversations, search | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1477 `modules/memory/service.ts:63` **MemoryService.lake** | `TranscriptLake` | constructor/callback, dispose | transcriptPathHint, triggerLakeSweep, pauseMirroringForTransfer, resumeMirroringAfterTransfer, pendingLakeReads, readTranscriptFromLake, transcriptHasPredecessors, onTranscriptMirrorResult | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1478 `modules/memory/service.ts:68` **MemoryService.deps** | `MemoryServiceDeps` | constructor/initializer | allConversations, indexConversations, write, broadcastDiagnostics, setConversationMeta, ensureConversationIdentity, linkConversationSegment, conversationPodiumId | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1479 `modules/memory/service.ts:351` **MemoryReaderView.memory** | `MemoryService` | constructor/initializer | searchConversations, search | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1480 `modules/memory/service.ts:352` **MemoryReaderView.reader** | `MemoryReader` | constructor/initializer | searchConversations, search | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1481 `modules/memory/service.ts:373` **MemoryCommandView.service** | `MemoryService` | constructor/initializer | setConversationMeta | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1482 `modules/memory/service.ts:375` **MemoryCommandView.writer** | `ConversationCommandWriter` | constructor/initializer | setConversationMeta | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/memory/transcript-indexer.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1493 `modules/memory/transcript-indexer.ts:53` **TranscriptIndexer.CHUNK_DELAY_MS** | `number` | constructor/initializer | TranscriptIndexer consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1494 `modules/memory/transcript-indexer.ts:57` **TranscriptIndexer.PASS_BUDGET_BYTES** | `number` | constructor/initializer | TranscriptIndexer consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1495 `modules/memory/transcript-indexer.ts:59` **TranscriptIndexer.WINDOW_BYTES** | `number` | constructor/initializer | TranscriptIndexer consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1496 `modules/memory/transcript-indexer.ts:63` **TranscriptIndexer.running** | `Map<string, { rerun: boolean }>` | onBytes, backfill, run | onBytes, backfill, settled, run | work/claim/retry | **job** | legacy transcript indexing/backfill queue and cursor work; durable leased jobs; chat-copy design remains held |
| S1497 `modules/memory/transcript-indexer.ts:65` **TranscriptIndexer.backfilling** | `Set<string>` | backfillMachine, backfill | backfillMachine, settled | work/claim/retry | **job** | legacy transcript indexing/backfill queue and cursor work; durable leased jobs; chat-copy design remains held |
| S1498 `modules/memory/transcript-indexer.ts:72` **TranscriptIndexer.lastBackfillGap** | `Map<string, string>` | onTruncate, onIncarnation, backfill | constructor/callback | diagnostics only | **delete** | diagnostic gap-message suppression |
| S1499 `modules/memory/transcript-indexer.ts:79` **TranscriptIndexer.stopped** | `boolean` | dispose | onBytes, backfillMachine, backfill, run, indexWindow | work/claim/retry | **job** | legacy transcript indexing/backfill queue and cursor work; durable leased jobs; chat-copy design remains held |
| S1500 `modules/memory/transcript-indexer.ts:81` **TranscriptIndexer.chunkDelayMs** | `number` | constructor/callback | backfill, run | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1501 `modules/memory/transcript-indexer.ts:82` **TranscriptIndexer.passBudgetBytes** | `number` | constructor/callback | backfill | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1502 `modules/memory/transcript-indexer.ts:83` **TranscriptIndexer.windowBytes** | `number` | constructor/callback | indexWindow | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1503 `modules/memory/transcript-indexer.ts:86` **TranscriptIndexer.deps** | `{ mirror: TranscriptMirrorRepository index: TranscriptIndexRepository /** * Stamped items for the mirrored byte range [from, to) of this segment * (this issue): the Store's ra…` | constructor/initializer | onTruncate, onIncarnation, backfillMachine, backfill, run, indexWindow | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/memory/visibility.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1483 `modules/memory/visibility.ts:121` **MemoryVisibilityPolicy.store** | `SessionStore` | constructor/initializer | forRequest, primeNativeConversations, sessionById, issueById, mayReadNativeConversation, siblingSegments | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1484 `modules/memory/visibility.ts:122` **MemoryVisibilityPolicy.request** | `VisibilityRequest` | constructor/initializer | primeNativeConversations, sessionById, issueById, mayReadNativeConversation, constructor/callback, siblingSegments | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/message-feed/feed.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1504 `modules/message-feed/feed.ts:199` **MessageFeedPublisher.deps** | `MessageFeedDeps` | constructor/initializer | capture, writeSessions | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1505 `modules/message-feed/feed.ts:208` **MessageFeedPublisher.capture** | `MessageFeedCapture` | constructor/initializer | MessageFeedPublisher consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1506 `modules/message-feed/feed.ts:213` **MessageFeedPublisher.writeSessions** | `SessionMessageWindowWrite` | constructor/initializer | MessageFeedPublisher consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/messages/brakes.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1372 `modules/messages/brakes.ts:54` **DeliveryBrakes.lastWakeAt** | `Map<string, number>` | isWakeHot, primeWakeCooldowns, recordWake | isWakeHot, constructor/callback, primeWakeCooldowns, scheduleWakeRetry | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1373 `modules/messages/brakes.ts:56` **DeliveryBrakes.wakeCooldownTimers** | `Map< string, { deadline: number timer: ReturnType<typeof setTimeout> targets: Map<string, DeliveryTarget> } >` | constructor/callback, scheduleWakeRetry, dispose | scheduleWakeRetry, constructor/callback, dispose | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1374 `modules/messages/brakes.ts:66` **DeliveryBrakes.spawnCount** | `Map<string, { day: string; count: number }>` | spawnCountFor, chargeSpawn, takeSpawnBudget | spawnCountFor | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1375 `modules/messages/brakes.ts:68` **DeliveryBrakes.deps** | `DeliveryBrakeDeps` | constructor/initializer | nowMs, isWakeHot, primeWakeCooldowns, constructor/callback, recordWake, spawnCountFor, takeSpawnBudget | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/messages/gate.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1325 `modules/messages/gate.ts:278` **MessageGate.access** | `MailAccess` | constructor/callback | visibleMailIds, handlerContext, dispatchInScope | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1326 `modules/messages/gate.ts:279` **MessageGate.principalForCapability** | `( capability: Capability, ) => CommandPrincipal \| Promise<CommandPrincipal>` | constructor/callback | constructor/callback, principalOf | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1327 `modules/messages/gate.ts:282` **MessageGate.policyFor** | `( principal: CommandPrincipal, ) => \| { ceiling: HumanCeiling; machines: MachineAccess } \| Promise<{ ceiling: HumanCeiling; machines: MachineAccess }>` | constructor/callback | constructor/callback, visibleMailIds, handlerContext, dispatchInScope | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1328 `modules/messages/gate.ts:289` **MessageGate.deps** | `MessageGateDeps` | constructor/initializer | dispatch, visibleMailIds, constructor/callback, retireParentNudge, handlerContext, recordSpawnRefusal, parentSessionOf, dispatchInScope | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/messages/handlers/context.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1356 `modules/messages/handlers/context.ts:281` **MailAccess.deps** | `MessageGateDeps` | constructor/initializer | resolveRecipient, resolveIssueRef, issueExists, assertSessionTargetAccess, ownsAnEnd, mayReplyAs, wire | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1357 `modules/messages/handlers/context.ts:283` **MailAccess.ceiling** | `HumanCeiling` | constructor/initializer | resolveRecipient, resolveIssueAddress | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1358 `modules/messages/handlers/context.ts:285` **MailAccess.machines** | `MachineAccess` | constructor/initializer | placement | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/messages/handlers/spawn-agent.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1354 `modules/messages/handlers/spawn-agent.ts:41` **SpawnBudgetExhausted.issueId** | `string` | constructor/initializer | event | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1355 `modules/messages/handlers/spawn-agent.ts:42` **SpawnBudgetExhausted.callerSession** | `string \| null` | constructor/initializer | event | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/messages/mailbox.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1324 `modules/messages/mailbox.ts:105` **MessageMailbox.deps** | `MessageMailboxDeps` | constructor/initializer | replyTarget, resolveIssueIdSafe, sendReply, deliveredUnacked, settleNotifiable, pendingReminders, constructor/callback, systemAckFallback, message, ledger, awaitAck, readInbox, dismiss, requestRetract, finishRetract, retireNotificationFact | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/messages/queued-apply.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1329 `modules/messages/queued-apply.ts:24` **QueuedMessageApply.deps** | `{ messages: MessageDeliveryDeps['messages'] /** What a machine reports about its messages is the server's own write * (messages.daemon, POD-6602). */ writer: MessageWriter aut…` | constructor/initializer | authorize, applied, held, named, constructor/callback, harnessIds, injected, unconfirmed, reject | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/messages/refusal.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1376 `modules/messages/refusal.ts:17` **MailRefusal.kind** | `SyncSubmitRefusal['kind']` | constructor/initializer | MailRefusal consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### modules/messages/render.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1371 `modules/messages/render.ts:180` **MessageRenderer.deps** | `MessageRenderDeps` | constructor/initializer | receiverIsShell, find, crossMachineNote, fromLabel, toLabel | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/messages/scheduler.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1360 `modules/messages/scheduler.ts:100` **DeliveryScheduler.pendingDeliveryTargets** | `Map<string, DeliveryTargetWork>` | add, flushQueuedTargets, dispose | add, flushQueuedTargets, deliveryStats | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1361 `modules/messages/scheduler.ts:101` **DeliveryScheduler.deliveryTriggerTimer** | `ReturnType<typeof setTimeout> \| null` | scheduleDeliveryFlush, constructor/callback, flushDeliveryTriggers, dispose | scheduleDeliveryFlush, flushDeliveryTriggers, dispose | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1362 `modules/messages/scheduler.ts:102` **DeliveryScheduler.deliveryFlushTail** | `Promise<void>` | flushDeliveryTriggers | flushDeliveryTriggers | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1363 `modules/messages/scheduler.ts:103` **DeliveryScheduler.reconcileTimer** | `ReturnType<typeof setTimeout> \| null` | runReconcilePage, dispose | runReconcilePage, dispose | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1364 `modules/messages/scheduler.ts:104` **DeliveryScheduler.retryBackstopTimer** | `ReturnType<typeof setTimeout> \| null` | runRetryBackstopPage, dispose | runRetryBackstopPage, dispose | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1365 `modules/messages/scheduler.ts:105` **DeliveryScheduler.retryBackstopCursor** | `MessagePageCursor \| null` | sweep, runRetryBackstopPage | deliveryStats | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1366 `modules/messages/scheduler.ts:106` **DeliveryScheduler.retryPassStartedAt** | `number \| null` | sweep, runRetryBackstopPage, dispose | sweep, deliveryStats | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1367 `modules/messages/scheduler.ts:107` **DeliveryScheduler.retryPagesProcessed** | `number` | runRetryBackstopPage | deliveryStats | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1368 `modules/messages/scheduler.ts:108` **DeliveryScheduler.coalescedTriggerCount** | `number` | add | deliveryStats | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1369 `modules/messages/scheduler.ts:109` **DeliveryScheduler.triggerFailures** | `number` | recordTriggerFailure | deliveryStats | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1370 `modules/messages/scheduler.ts:111` **DeliveryScheduler.deps** | `DeliverySchedulerDeps` | constructor/initializer | runner, flushQueuedTargets, queueIsEmpty, runReconcilePage, sweep, runRetryBackstopPage | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/messages/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1312 `modules/messages/service.ts:189` **PassIssueMembers.lists** | `Map<string, Promise<SessionMeta[]>>` | of, constructor/callback, forget | of | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1313 `modules/messages/service.ts:678` **MessageDeliveryService.turnHop** | `Map<string, number>` | onSessionIdle, markDispatched, markTyped, markDelivered | sendUnder | work/claim/retry | **job** | message routing/delivery wake/follow-up state; key durable jobs by target/message; commit idempotent results |
| S1314 `modules/messages/service.ts:681` **MessageDeliveryService.attentionEmitted** | `Set<string>` | needsAttention | needsAttention | work/claim/retry | **job** | message routing/delivery wake/follow-up state; key durable jobs by target/message; commit idempotent results |
| S1315 `modules/messages/service.ts:685` **MessageDeliveryService.sending** | `Map<string, Promise<unknown>>` | send | send | work/claim/retry | **job** | message routing/delivery wake/follow-up state; key durable jobs by target/message; commit idempotent results |
| S1316 `modules/messages/service.ts:694` **MessageDeliveryService.followUps** | `Map<string, Promise<unknown>>` | rememberFollowUp, followUpOf | rememberFollowUp, followUpOf | work/claim/retry | **job** | message routing/delivery wake/follow-up state; key durable jobs by target/message; commit idempotent results |
| S1317 `modules/messages/service.ts:696` **MessageDeliveryService.notificationArbiter** | `NotificationArbiter` | constructor/callback | constructor/callback | work/claim/retry | **job** | message routing/delivery wake/follow-up state; key durable jobs by target/message; commit idempotent results |
| S1318 `modules/messages/service.ts:700` **MessageDeliveryService.render** | `MessageRenderer` | constructor/callback | fromLabel, renderFor, injectAndMark, onQueuedInputApplied, onQueuedInputProvenLate, onQueuedInputDisprovenLate | work/claim/retry | **job** | message routing/delivery wake/follow-up state; key durable jobs by target/message; commit idempotent results |
| S1319 `modules/messages/service.ts:704` **MessageDeliveryService.brakes** | `DeliveryBrakes` | constructor/callback, dispose | wakeKeysOf, sendUnder, trySpawn, prepareQueuedAttempt, scheduleQueuedWakeRetries, takeSpawnBudget, scheduleWakeRetry, recordWake | work/claim/retry | **job** | message routing/delivery wake/follow-up state; key durable jobs by target/message; commit idempotent results |
| S1320 `modules/messages/service.ts:708` **MessageDeliveryService.scheduler** | `DeliveryScheduler` | constructor/callback, dispose | reconcileQueued, flushDeliveryTriggers, sweep, deliveryStats, queueDeliveryTarget, prepareQueuedAttemptSafely | work/claim/retry | **job** | message routing/delivery wake/follow-up state; key durable jobs by target/message; commit idempotent results |
| S1321 `modules/messages/service.ts:711` **MessageDeliveryService.foldersToResolve** | `Set<string>` | onSessionEligibilityChanged, dispose, issuesOfQueuedFolders | issuesOfQueuedFolders | work/claim/retry | **job** | message routing/delivery wake/follow-up state; key durable jobs by target/message; commit idempotent results |
| S1322 `modules/messages/service.ts:714` **MessageDeliveryService.mailbox** | `MessageMailbox` | constructor/callback | cancelStoredRetraction, replyTarget, sendReply, deliveredUnacked, settleNotifiable, pendingReminders, systemAckFallback, message, ledger, awaitAck, inbox, readInbox, dismiss, cancel, constructor/callback | work/claim/retry | **job** | message routing/delivery wake/follow-up state; key durable jobs by target/message; commit idempotent results |
| S1323 `modules/messages/service.ts:716` **MessageDeliveryService.deps** | `MessageDeliveryDeps` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/messaging/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1394 `modules/messaging/service.ts:207` **MessagingService.adapter** | `ChannelAdapter \| undefined` | applyConfiguration, stop | answerCallback, acquire, applyConfiguration, stop, sendUserNotice, sendNotice, acquireTyping, constructor/callback, startAmbientTyping, handleCallback, openIssueTopic, reply | work/claim/retry | **job** | Telegram polling, inbound/awaited/reply queue and relay work; leased poll job plus provider offset and dedupe rows |
| S1395 `modules/messaging/service.ts:208` **MessagingService.adapterKey** | `inferred value/definition` | applyConfiguration, stop | applyConfiguration, sendNotice | work/claim/retry | **job** | Telegram polling, inbound/awaited/reply queue and relay work; leased poll job plus provider offset and dedupe rows |
| S1396 `modules/messaging/service.ts:210` **MessagingService.lastInboundRefByChat** | `Map<string, ConversationRef>` | stop, onInbound | noticeThreadRef | work/claim/retry | **job** | Telegram polling, inbound/awaited/reply queue and relay work; leased poll job plus provider offset and dedupe rows |
| S1397 `modules/messaging/service.ts:212` **MessagingService.queues** | `Map<string, QueuedInbound[]>` | handleChatMessage, handleSlash | handleChatMessage, pump, onTurnEnded | work/claim/retry | **job** | Telegram polling, inbound/awaited/reply queue and relay work; leased poll job plus provider offset and dedupe rows |
| S1398 `modules/messaging/service.ts:214` **MessagingService.awaiting** | `Map<string, AwaitedReply>` | constructor/callback, onTurnEnded | pump, onTurnEnded | work/claim/retry | **job** | Telegram polling, inbound/awaited/reply queue and relay work; leased poll job plus provider offset and dedupe rows |
| S1399 `modules/messaging/service.ts:217` **MessagingService.dispatching** | `Set<string>` | pump, constructor/callback | pump | work/claim/retry | **job** | Telegram polling, inbound/awaited/reply queue and relay work; leased poll job plus provider offset and dedupe rows |
| S1400 `modules/messaging/service.ts:219` **MessagingService.topicThreadByRef** | `Map<string, ThreadId>` | applyConfiguration, resolveThreadId, persistTopicBinding | isBoundIssueTopic, resolveThreadId | answer/decision | **derived** | Telegram chat/member/thread routing; Q-telegram (thread correlation needs durable key if absent) |
| S1401 `modules/messaging/service.ts:221` **MessagingService.topicRefByIssue** | `Map<string, string>` | applyConfiguration, resolveThreadId, persistTopicBinding | noticeThreadRef, openIssueTopic | answer/decision | **derived** | Telegram chat/member/thread routing; Q-telegram (thread correlation needs durable key if absent) |
| S1402 `modules/messaging/service.ts:223` **MessagingService.configuredBindings** | `readonly TelegramChatBinding[]` | applyConfiguration | constructor/callback | answer/decision | **derived** | Telegram chat/member/thread routing; Q-telegram (thread correlation needs durable key if absent) |
| S1403 `modules/messaging/service.ts:226` **MessagingService.configuredChatIdByUser** | `Map<UserId, string>` | applyConfiguration | startAmbientTyping | answer/decision | **derived** | Telegram chat/member/thread routing; Q-telegram (thread correlation needs durable key if absent) |
| S1404 `modules/messaging/service.ts:227` **MessagingService.configureTail** | `Promise<void>` | configure | configure | work/claim/retry | **job** | Telegram polling, inbound/awaited/reply queue and relay work; leased poll job plus provider offset and dedupe rows |
| S1405 `modules/messaging/service.ts:229` **MessagingService.typingLeases** | `Map<string, TypingLease>` | acquireTyping, releaseTyping, clearAllTyping | acquireTyping, releaseTyping, clearAllTyping, stopAmbientTyping | no independent truth | **delete** | ephemeral provider typing hints; source/provider worker may recompute; no delivery or authorization decision may depend on them |
| S1406 `modules/messaging/service.ts:231` **MessagingService.ambientTypingBySession** | `Map<string, string>` | clearAllTyping, startAmbientTyping, stopAmbientTyping | startAmbientTyping, stopAmbientTyping | no independent truth | **delete** | ephemeral provider typing hints; source/provider worker may recompute; no delivery or authorization decision may depend on them |
| S1407 `modules/messaging/service.ts:236` **MessagingService.lastActivityByThreadRef** | `Map<string, number>` | touchTopicActivity | shouldPostInactivityRecap | no independent truth | **delete** | ephemeral provider typing hints; source/provider worker may recompute; no delivery or authorization decision may depend on them |
| S1408 `modules/messaging/service.ts:238` **MessagingService.attachments** | `SessionAttachments \| undefined` | constructor/callback | onInbound | work/claim/retry | **job** | Telegram polling, inbound/awaited/reply queue and relay work; leased poll job plus provider offset and dedupe rows |
| S1409 `modules/messaging/service.ts:240` **MessagingService.deps** | `MessagingDeps` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/messaging/session-attachment.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1418 `modules/messaging/session-attachment.ts:190` **SessionAttachments.relayTails** | `Map<SessionId, Promise<void>>` | relay | relay | work/claim/retry | **job** | Telegram polling, inbound/awaited/reply queue and relay work; leased poll job plus provider offset and dedupe rows |
| S1419 `modules/messaging/session-attachment.ts:192` **SessionAttachments.deps** | `SessionAttachmentDeps` | constructor/initializer | attachmentFor, handleSlash, handleCallback, handleChat, sendRefusal, attach, detach, status, wake, listSessions, readTail, onStateChanged, onExited, relayNow | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/messaging/telegram.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1410 `modules/messaging/telegram.ts:164` **TelegramChannel.channel** | `inferred value/definition` | constructor/initializer | pollLoop | work/claim/retry | **job** | Telegram polling, inbound/awaited/reply queue and relay work; leased poll job plus provider offset and dedupe rows |
| S1411 `modules/messaging/telegram.ts:165` **TelegramChannel.stopped** | `boolean` | start, stop | start, pollLoop | work/claim/retry | **job** | Telegram polling, inbound/awaited/reply queue and relay work; leased poll job plus provider offset and dedupe rows |
| S1412 `modules/messaging/telegram.ts:166` **TelegramChannel.offset** | `number \| undefined` | pollLoop | pollLoop | work/claim/retry | **job** | Telegram polling, inbound/awaited/reply queue and relay work; leased poll job plus provider offset and dedupe rows |
| S1413 `modules/messaging/telegram.ts:167` **TelegramChannel.loop** | `Promise<void> \| undefined` | start | TelegramChannel consumers | work/claim/retry | **job** | Telegram polling, inbound/awaited/reply queue and relay work; leased poll job plus provider offset and dedupe rows |
| S1414 `modules/messaging/telegram.ts:168` **TelegramChannel.abort** | `AbortController \| undefined` | start, stop | pollLoop | work/claim/retry | **job** | Telegram polling, inbound/awaited/reply queue and relay work; leased poll job plus provider offset and dedupe rows |
| S1415 `modules/messaging/telegram.ts:171` **TelegramChannel.config** | `TelegramConfig` | constructor/initializer | api, accepts | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1416 `modules/messaging/telegram.ts:174` **TelegramChannel.paused** | `() => boolean` | constructor/initializer | pollLoop | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1417 `modules/messaging/telegram.ts:176` **TelegramChannel.acceptChat** | `(chatId: string) => boolean \| Promise<boolean>` | constructor/initializer | accepts | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/notices/emit.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1292 `modules/notices/emit.ts:88` **NoticeService.now** | `() => string` | constructor/callback | emitNotice, resolveNotices, markRead, markAllRead | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1293 `modules/notices/emit.ts:89` **NoticeService.mintId** | `() => string` | constructor/callback | emitNotice | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1294 `modules/notices/emit.ts:91` **NoticeService.deps** | `NoticeServiceDeps` | pushIfWanted | emitNotice, resolveNotices, list, unreadCount, markRead, markAllRead, cap, pushIfWanted | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/notices/mentions.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1295 `modules/notices/mentions.ts:35` **CommentMentions.deps** | `CommentMentionsDeps` | constructor/initializer | find, raise, resolve | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/notify/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1145 `modules/notify/service.ts:135` **NotifyService.lastTelegramKeys** | `Map<string, string>` | notifyAttentionForNewExternalTargets | notifyAttentionForNewExternalTargets | answer/decision | **derived** | notification replacement/deduplication key; Q-notify (persist provider key for edit/retry) |
| S1146 `modules/notify/service.ts:138` **NotifyService.deps** | `NotifyDeps` | constructor/initializer | constructor/callback, sendTelegram, telegramEnabled, notifyAttentionForNewExternalTargets, notifyExternal, notifyAttention, notifyNotice | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1147 `modules/notify/service.ts:139` **NotifyService.pushers** | `NotificationPushers` | constructor/initializer | sendTelegram, notifyAttentionForNewExternalTargets, notifyExternal, notifyNotice | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/operations/cleanup-janitor.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0659 `modules/operations/cleanup-janitor.ts:7` **OperationCleanupJanitor.running** | `boolean` | start, stop | start, tick | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0660 `modules/operations/cleanup-janitor.ts:8` **OperationCleanupJanitor.timer** | `OperationTimerHandle \| undefined` | stop, tick, constructor/callback | stop | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0661 `modules/operations/cleanup-janitor.ts:11` **OperationCleanupJanitor.deps** | `{ engine: OperationEngine clock: OperationClock contextFor: (row: OperationRow) => unknown \| Promise<unknown> intervalMs?: number }` | constructor/initializer | stop, tick | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/operations/engine.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0662 `modules/operations/engine.ts:190` **OperationEngine.deps** | `OperationEngineDeps` | constructor/callback | instance methods/callbacks (field-specific accesses in this source) | no independent truth | **delete** | operation handler capabilities; reconstruct per job/step from rows, never retain a workspace graph |
| S0663 `modules/operations/engine.ts:192` **OperationEngine.timers** | `Map<string, OperationTimerHandle>` | stop, armWaitingGrace, armDeadline, disarm | stop, disarm | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0664 `modules/operations/engine.ts:194` **OperationEngine.chains** | `Map<string, Promise<void>>` | enqueueResult | whenSettled, enqueueResult | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0665 `modules/operations/engine.ts:200` **OperationEngine.contexts** | `Map<string, unknown>` | start, adoptRow, completeHandoff, finishReclaimed, finish | constructor/callback | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0666 `modules/operations/engine.ts:206` **OperationEngine.budgetTimers** | `Map<OperationTimerHandle, string>` | stop, constructor/callback, disarmBudgets | stop, disarmBudgets | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0667 `modules/operations/engine.ts:208` **OperationEngine.handoffs** | `Map<string, HandoffState>` | sealForHandoff, finishReclaimed | sealForHandoff, reclaimHandoff, isSealed, project, driveLocked, completeHandoff, finish, persist, onDeadline | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0668 `modules/operations/engine.ts:210` **OperationEngine.activeRunners** | `Map<string, symbol>` | stop, constructor/callback, invoke | sealForHandoff, reclaimHandoff, invoke | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0669 `modules/operations/engine.ts:211` **OperationEngine.runnerScope** | `AsyncLocalStorage<RunnerIdentity>` | invoke | sealForHandoff, reclaimHandoff | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0670 `modules/operations/engine.ts:213` **OperationEngine.cancelRuns** | `Map<string, Promise<CancelResult>>` | cancel, constructor/callback | cancel, constructor/callback | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0671 `modules/operations/engine.ts:215` **OperationEngine.deferredAdoptions** | `Set<string>` | adoptRow, constructor/callback | constructor/callback, isAdoptionDeferred | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0672 `modules/operations/engine.ts:217` **OperationEngine.stopped** | `boolean` | stop | sealForHandoff, enqueueResult, enqueue, driveLocked, containDriveFailure, onDeadline | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0673 `modules/operations/engine.ts:219` **OperationEngine.listeners** | `Set<OperationChangeListener>` | onChanged, constructor/callback | announce | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |

### modules/operations/kinds.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0674 `modules/operations/kinds.ts:212` **OperationKindRegistry.defs** | `Map<string, AnyOperationKindDefinition>` | register | register, get, kinds, groups | wiring/code only | **delete** | immutable command/kind/provider/executor registration; freeze code registry; handlers take explicit request/job context |

### modules/operations/store.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0657 `modules/operations/store.ts:332` **OperationStore.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0658 `modules/operations/store.ts:333` **OperationStore.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | claimGroup, update | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/perf/registry.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1252 `modules/perf/registry.ts:138` **PerfRegistry.rpc** | `Map<string, OpStats>` | reset | record, snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S1253 `modules/perf/registry.ts:139` **PerfRegistry.phases** | `Map<string, OpStats>` | reset | record, snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S1254 `modules/perf/registry.ts:140` **PerfRegistry.clientSwitches** | `ClientSwitchTrace[]` | pushClientTrace, reset | pushClientTrace, snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S1255 `modules/perf/registry.ts:141` **PerfRegistry.partitions** | `Map<string, Partition>` | partition, reset | partition, snapshot, snapshotFor | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S1256 `modules/perf/registry.ts:142` **PerfRegistry.sinceAt** | `inferred value/definition` | reset | snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |

### modules/plain-command/registry.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0676 `modules/plain-command/registry.ts:110` **PlainCommandRegistry.commands** | `Map<string, PlainCommand>` | register | register, lookup, names, run | wiring/code only | **delete** | immutable command/kind/provider/executor registration; freeze code registry; handlers take explicit request/job context |

### modules/quota-history/backfill.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1137 `modules/quota-history/backfill.ts:99` **QuotaBackfill.timer** | `ReturnType<typeof setTimeout> \| undefined` | start, dispose | start, dispose | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1138 `modules/quota-history/backfill.ts:100` **QuotaBackfill.disposed** | `boolean` | dispose | runOnce | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1139 `modules/quota-history/backfill.ts:102` **QuotaBackfill.bootDelayMs** | `number` | constructor/callback | start | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1140 `modules/quota-history/backfill.ts:103` **QuotaBackfill.retentionMs** | `number` | constructor/callback | runOnce | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1141 `modules/quota-history/backfill.ts:104` **QuotaBackfill.now** | `() => number` | constructor/callback | runOnce | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1142 `modules/quota-history/backfill.ts:105` **QuotaBackfill.ownerOf** | `QuotaOwnerOf \| undefined` | constructor/callback | runOnce | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1143 `modules/quota-history/backfill.ts:108` **QuotaBackfill.history** | `QuotaHistoryRepository` | constructor/initializer | runOnce | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1144 `modules/quota-history/backfill.ts:109` **QuotaBackfill.readHistory** | `(sinceMs: number) => Promise<QuotaHistorySampleWire[]>` | constructor/initializer | runOnce | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/quota-history/quota-topic.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1117 `modules/quota-history/quota-topic.ts:46` **HeldAccountTopic.held** | `Set<UserId>` | start, stop, dispose | stop, holders, pass, constructor/callback | live correctness | **room** | held account quota subscribers/readings and sampling pass; daemon quota in room; account.usage branch is deleted, not kept as a room history scan |
| S1118 `modules/quota-history/quota-topic.ts:47` **HeldAccountTopic.latest** | `Map<UserId, { pass: number; value: V; json: string }>` | stop, dispose, pass | snapshot, pass | live correctness | **room** | held account quota subscribers/readings and sampling pass; daemon quota in room; account.usage branch is deleted, not kept as a room history scan |
| S1119 `modules/quota-history/quota-topic.ts:48` **HeldAccountTopic.timer** | `ReturnType<typeof setInterval> \| undefined` | start, stop, dispose | start, stop, dispose | live correctness | **room** | held account quota subscribers/readings and sampling pass; daemon quota in room; account.usage branch is deleted, not kept as a room history scan |
| S1120 `modules/quota-history/quota-topic.ts:50` **HeldAccountTopic.passes** | `number` | pass | HeldAccountTopic consumers | live correctness | **room** | held account quota subscribers/readings and sampling pass; daemon quota in room; account.usage branch is deleted, not kept as a room history scan |
| S1121 `modules/quota-history/quota-topic.ts:51` **HeldAccountTopic.disposed** | `boolean` | dispose | start, pass | live correctness | **room** | held account quota subscribers/readings and sampling pass; daemon quota in room; account.usage branch is deleted, not kept as a room history scan |
| S1122 `modules/quota-history/quota-topic.ts:54` **HeldAccountTopic.publish** | `(user: UserId, value: V) => void` | constructor/initializer | pass | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1123 `modules/quota-history/quota-topic.ts:55` **HeldAccountTopic.intervalMs** | `number` | constructor/initializer | start | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1124 `modules/quota-history/quota-topic.ts:142` **AccountQuotaTopic.deps** | `AccountQuotaTopicDeps` | constructor/initializer | read, constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1125 `modules/quota-history/quota-topic.ts:181` **AccountUsageTopic.deps** | `AccountUsageTopicDeps` | constructor/initializer | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/quota-history/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1126 `modules/quota-history/service.ts:114` **QuotaSampler.bootTimer** | `ReturnType<typeof setTimeout> \| undefined` | start, dispose | start, dispose | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1127 `modules/quota-history/service.ts:115` **QuotaSampler.timer** | `ReturnType<typeof setInterval> \| undefined` | constructor/callback, dispose | constructor/callback, dispose | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1128 `modules/quota-history/service.ts:116` **QuotaSampler.inFlight** | `Promise<MachineQuotaWire[] \| undefined> \| undefined` | constructor/callback, sampleNow | sampleNow, constructor/callback | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1129 `modules/quota-history/service.ts:117` **QuotaSampler.disposed** | `boolean` | dispose | runPass | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S1130 `modules/quota-history/service.ts:119` **QuotaSampler.intervalMs** | `number` | constructor/callback | constructor/callback, runPass | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1131 `modules/quota-history/service.ts:120` **QuotaSampler.retentionMs** | `number` | constructor/callback | pruneExpired | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1132 `modules/quota-history/service.ts:121` **QuotaSampler.bootDelayMs** | `number` | constructor/callback | start | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1133 `modules/quota-history/service.ts:122` **QuotaSampler.now** | `() => number` | constructor/callback | pruneExpired | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1134 `modules/quota-history/service.ts:123` **QuotaSampler.ownerOf** | `QuotaOwnerOf` | constructor/callback | runPass | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1135 `modules/quota-history/service.ts:126` **QuotaSampler.history** | `QuotaHistoryRepository` | constructor/initializer | runPass, pruneExpired | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1136 `modules/quota-history/service.ts:127` **QuotaSampler.readQuota** | `() => Promise<MachineQuotaWire[]>` | constructor/initializer | runPass | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/read-position/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0649 `modules/read-position/service.ts:26` **ReadPositionService.deps** | `ReadPositionServiceDeps` | constructor/initializer | write | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/server-transfer/journal.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0685 `modules/server-transfer/journal.ts:103` **TransferJournal.path** | `string` | constructor/callback | read, clearReviewedOutcome | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0686 `modules/server-transfer/journal.ts:106` **TransferJournal.dir** | `string` | constructor/initializer | begin, updateRecord, transition, abort, abortRefusedPromotion, commit, recordCleanup, commitUncertain, resolveCommitted, clearReviewedOutcome | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0687 `modules/server-transfer/journal.ts:107` **TransferJournal.now** | `() => Date` | constructor/initializer | begin, updateRecord, transition, abort, abortRefusedPromotion, commit, recordCleanup, commitUncertain, resolveCommitted | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/server-transfer/lock.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0688 `modules/server-transfer/lock.ts:26` **TransferLock.handle** | `Awaited<ReturnType<typeof open>> \| undefined` | acquire, release | acquire, release | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0689 `modules/server-transfer/lock.ts:29` **TransferLock.path** | `string` | constructor/initializer | acquire, release | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0690 `modules/server-transfer/lock.ts:30` **TransferLock.now** | `() => Date` | constructor/initializer | acquire | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/server-transfer/portable-fence.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0691 `modules/server-transfer/portable-fence.ts:8` **PortableStateFence.held** | `boolean` | acquire, release | assertWritable, acquire, writerFinished | no independent truth | **delete** | self-hosted install transfer fence/writer waiters; keep only inside direct in-process transfer scope, never hosted workspace ownership |
| S0692 `modules/server-transfer/portable-fence.ts:9` **PortableStateFence.activeWriters** | `number` | runWriter, runWriterSync, writerFinished | acquire, writerFinished | no independent truth | **delete** | self-hosted install transfer fence/writer waiters; keep only inside direct in-process transfer scope, never hosted workspace ownership |
| S0693 `modules/server-transfer/portable-fence.ts:10` **PortableStateFence.waiters** | `Set<() => void>` | constructor/callback, writerFinished | writerFinished | no independent truth | **delete** | self-hosted install transfer fence/writer waiters; keep only inside direct in-process transfer scope, never hosted workspace ownership |

### modules/server-transfer/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0680 `modules/server-transfer/service.ts:127` **ServerTransferError.code** | `TransferFailureCode` | constructor/initializer | ServerTransferError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0681 `modules/server-transfer/service.ts:304` **ServerTransferService.journal** | `TransferJournal` | constructor/callback, recover, transfer | status, recover, publicStatus, transfer, persistProgress, persistAcknowledgementCleanup, prepareEndpointHandoff, commitEndpointHandoff, finishRecoveredCommit | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0682 `modules/server-transfer/service.ts:305` **ServerTransferService.lock** | `TransferLock` | constructor/callback | transfer | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0683 `modules/server-transfer/service.ts:306` **ServerTransferService.uuid** | `() => string` | constructor/callback | mintTransferId, transfer | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0684 `modules/server-transfer/service.ts:308` **ServerTransferService.deps** | `ServerTransferDeps` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/activity-history.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0702 `modules/sessions/activity-history.ts:62` **SessionActivityHistory.lastRecorded** | `Map<SessionId, AgentPhase>` | record | record | answer/decision | **derived** | last recorded phase; Q-events (bounded kind/subject tail) |
| S0703 `modules/sessions/activity-history.ts:65` **SessionActivityHistory.recording** | `Map<SessionId, { phase: AgentPhase }>` | record | record | work/claim/retry | **job** | activity-history append in progress; fact-keyed idempotent history job |
| S0704 `modules/sessions/activity-history.ts:66` **SessionActivityHistory.unsubscribe** | `() => void` | constructor/callback | dispose | request/tx context | **delete** | in-process event subscription; fact transaction schedules jobs |
| S0705 `modules/sessions/activity-history.ts:69` **SessionActivityHistory.deps** | `{ events: Pick<EventsRepository, 'appendEventGrouped' \| 'listKindSubjectSinceWithPrior'> bus: EventBus now: () => number }` | constructor/initializer | record, history | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/activity-publication.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0710 `modules/sessions/activity-publication.ts:10` **SessionActivityPublication.inFlight** | `Promise<void> \| undefined` | flush, constructor/callback | flush | work/claim/retry | **job** | activity publication flush already reads pending rows; use one leased sweep job rather than a process single-flight promise |
| S0711 `modules/sessions/activity-publication.ts:13` **SessionActivityPublication.ports** | `{ store: Pick<SessionStore, 'sessions' \| 'transferFenceActive'> writer: SessionWriter now(): number }` | constructor/initializer | flushOnce, write | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/client-control.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1006 `modules/sessions/client-control.ts:91` **SessionClientControl.ports** | `SessionClientControlPorts` | constructor/initializer | onAttached, onDetached, onInputBytes, onFrame, handleFrame, constructor/callback, reclaim, authorizeAttach, mayRead, authorizeDrive | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/command-plane.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1024 `modules/sessions/command-plane.ts:310` **SessionCommandCtx.deps** | `SessionCommandDeps` | constructor/initializer | sessions, constructor/callback, assertMachineUse, target | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1025 `modules/sessions/command-plane.ts:311` **SessionCommandCtx.principal** | `CommandPrincipal` | constructor/initializer | constructor/callback, assertMachineUse, target | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1026 `modules/sessions/command-plane.ts:312` **SessionCommandCtx.overrideScope** | `boolean` | constructor/initializer | target | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/concurrency-history.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1017 `modules/sessions/concurrency-history.ts:136` **AgentConcurrencyHistory.held** | `{ rows: PodiumEventRecord[]; throughId: number } \| undefined` | windowRows | windowRows | answer/decision | **derived** | last concurrency event window/count; Q-events |
| S1018 `modules/sessions/concurrency-history.ts:137` **AgentConcurrencyHistory.lastRecordedCount** | `number \| undefined` | capture | capture | answer/decision | **derived** | last concurrency event window/count; Q-events |
| S1019 `modules/sessions/concurrency-history.ts:138` **AgentConcurrencyHistory.recording** | `{ count: number } \| undefined` | capture | capture | work/claim/retry | **job** | concurrency-history fold; idempotent fact/job bookkeeping |
| S1020 `modules/sessions/concurrency-history.ts:139` **AgentConcurrencyHistory.unsubscribe** | `() => void` | constructor/callback | dispose | no independent truth | **delete** | event subscription; explicit durable fact/job seam |
| S1021 `modules/sessions/concurrency-history.ts:142` **AgentConcurrencyHistory.deps** | `{ sessions: () => Iterable<Pick<Session, 'agentState' \| 'status' \| 'archived' \| 'lastActiveAt' \| 'awaitingRebind'>> events: Pick< EventsRepository, 'appendEventGrouped' \| 'listK…` | constructor/initializer | capture, history, windowRows, rowsAfter | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/context-reads.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1014 `modules/sessions/context-reads.ts:30` **SessionContextReads.flights** | `Map<string, Flight>` | read, constructor/callback, dispose | read, constructor/callback, dispose | acceptance/result | **operation** | pending context reads/cancellation; server asks become operations; human live asks leave Core for room |
| S1015 `modules/sessions/context-reads.ts:31` **SessionContextReads.disposed** | `boolean` | dispose | read, current | no independent truth | **delete** | request correlator lifecycle latch; current operation owns status/cancellation |
| S1016 `modules/sessions/context-reads.ts:33` **SessionContextReads.ports** | `{ session(id: SessionId): BoundContextSession \| undefined connected(id: MachineId): boolean supported(id: MachineId): boolean read( input: SessionContextReadInput, machineId: Ma…` | constructor/initializer | read, current, constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/daemon-lifecycle.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0979 `modules/sessions/daemon-lifecycle.ts:169` **SessionDaemonLifecycle.unfencedExitsAwaitingBind** | `Set<SessionId>` | handleAgentExit, handle | handleAgentExit | work/claim/retry | **job** | old unfenced exit awaiting bind classification; durable pending-fact/reconciliation key with binding generation |
| S0980 `modules/sessions/daemon-lifecycle.ts:171` **SessionDaemonLifecycle.ports** | `SessionDaemonLifecyclePorts` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0981 `modules/sessions/daemon-lifecycle.ts:197` **SessionDaemonLifecycle.persist** | `callback` | constructor/initializer | SessionDaemonLifecycle consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0982 `modules/sessions/daemon-lifecycle.ts:201` **SessionDaemonLifecycle.write** | `callback` | constructor/initializer | handleAgentExit, handle | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0983 `modules/sessions/daemon-lifecycle.ts:206` **SessionDaemonLifecycle.draft** | `callback` | constructor/initializer | handle | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0984 `modules/sessions/daemon-lifecycle.ts:207` **SessionDaemonLifecycle.persistDraft** | `callback` | constructor/initializer | handle | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0985 `modules/sessions/daemon-lifecycle.ts:212` **SessionDaemonLifecycle.broadcastSessions** | `callback` | constructor/initializer | handleAgentExit, handle | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0986 `modules/sessions/daemon-lifecycle.ts:213` **SessionDaemonLifecycle.emitSessionExited** | `callback` | constructor/initializer | handleAgentExit, handle | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0987 `modules/sessions/daemon-lifecycle.ts:218` **SessionDaemonLifecycle.toMachine** | `callback` | constructor/initializer | handle | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0988 `modules/sessions/daemon-lifecycle.ts:220` **SessionDaemonLifecycle.now** | `callback` | constructor/initializer | handle | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0989 `modules/sessions/daemon-lifecycle.ts:221` **SessionDaemonLifecycle.terminalCandidateFacts** | `callback` | constructor/initializer | handle | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0990 `modules/sessions/daemon-lifecycle.ts:228` **SessionDaemonLifecycle.broadcastToClients** | `callback` | constructor/initializer | SessionDaemonLifecycle consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0991 `modules/sessions/daemon-lifecycle.ts:230` **SessionDaemonLifecycle.clearOffer** | `callback` | constructor/initializer | handle | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/daemon-projection.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1003 `modules/sessions/daemon-projection.ts:73` **SessionDaemonProjection.metadataSeen** | `Map<SessionId, Map<string, SessionMetadataObservation>>` | constructor/callback | constructor/callback | no independent truth | **delete** | server-side activity/metadata coalescing or derived projection hint; coalesce at producer, append once, tail durable log |
| S1004 `modules/sessions/daemon-projection.ts:74` **SessionDaemonProjection.metadataQueue** | `Map<SessionId, Promise<void>>` | runtimeEvent | runtimeEvent | no independent truth | **delete** | server-side activity/metadata coalescing or derived projection hint; coalesce at producer, append once, tail durable log |
| S1005 `modules/sessions/daemon-projection.ts:76` **SessionDaemonProjection.ports** | `SessionDaemonProjectionPorts` | constructor/initializer | metadata, runtimeEvent, metadataSnapshot, promptTitle, handle | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/facts.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1012 `modules/sessions/facts.ts:222` **SessionFactsReader.sessions** | `ReadonlyMap<SessionId, Session>` | constructor/initializer | running | wiring/code only | **derived** | running session map alias; Q-session scoped status query, no resident Session objects required |
| S1013 `modules/sessions/facts.ts:223` **SessionFactsReader.records** | `SessionRecordReads` | constructor/initializer | required | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/handoff/admission.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0842 `modules/sessions/handoff/admission.ts:49` **HandoffAdmission.inFlight** | `Map<string, InFlight>` | constructor/callback, admit | admit, constructor/callback, isTransferring | acceptance/result | **operation** | in-flight machine command, credential/login, discovery or handoff chain; stable operation/result rows replace local promises/maps |
| S0843 `modules/sessions/handoff/admission.ts:51` **HandoffAdmission.ports** | `Pick<HandoffPorts, 'getSession'>` | constructor/initializer | admit | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/handoff/coordinator.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0838 `modules/sessions/handoff/coordinator.ts:103` **HandoffCoordinator.admission** | `HandoffAdmission` | constructor/callback | handoff, isTransferring | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0839 `modules/sessions/handoff/coordinator.ts:104` **HandoffCoordinator.preflight** | `HandoffPreflight` | constructor/callback | run | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0840 `modules/sessions/handoff/coordinator.ts:105` **HandoffCoordinator.transfer** | `HandoffTransfer` | constructor/callback | run | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0841 `modules/sessions/handoff/coordinator.ts:107` **HandoffCoordinator.ports** | `HandoffPorts` | constructor/initializer | run | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/handoff/preflight.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0846 `modules/sessions/handoff/preflight.ts:66` **HandoffPreflight.ports** | `HandoffPreflightPorts` | constructor/initializer | prepare, clearHandoffOverlay, constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/handoff/refusal.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0845 `modules/sessions/handoff/refusal.ts:56` **HandoffRefusalError.refusal** | `HandoffRefusalReason` | constructor/initializer | HandoffRefusalError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### modules/sessions/handoff/transfer.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0844 `modules/sessions/handoff/transfer.ts:82` **HandoffTransfer.ports** | `HandoffTransferPorts` | constructor/initializer | apply | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/instructions.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0993 `modules/sessions/instructions.ts:43` **SessionInstructionRegistry.providers** | `Map<string, SessionInstructionProvider>` | register | register, prepare | wiring/code only | **delete** | immutable command/kind/provider/executor registration; freeze code registry; handlers take explicit request/job context |

### modules/sessions/launch-config.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1009 `modules/sessions/launch-config.ts:56` **CredentialRefusal.name** | `inferred value/definition` | constructor/initializer | CredentialRefusal consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1010 `modules/sessions/launch-config.ts:59` **CredentialRefusal.refusal** | `AccessRefusal` | constructor/initializer | CredentialRefusal consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1011 `modules/sessions/launch-config.ts:91` **SessionLaunchConfig.ports** | `LaunchConfigPorts` | constructor/initializer | modelDefaults, selectCredential, legacyChoice, requiredDriver, access | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/live-topics.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0706 `modules/sessions/live-topics.ts:132` **SessionLiveTopics.held** | `Record<SessionLiveKind, Map<SessionId, Sent>>` | constructor/initializer | start, stop, changed, constructor/callback, recheckNow, remember, send | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0707 `modules/sessions/live-topics.ts:136` **SessionLiveTopics.recheckQueued** | `boolean` | recheck, recheckNow | recheck | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0708 `modules/sessions/live-topics.ts:138` **SessionLiveTopics.deps** | `SessionLiveTopicsDeps` | constructor/initializer | snapshot, constructor/callback, send | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/machine-reconciler.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0847 `modules/sessions/machine-reconciler.ts:130` **SessionMachineReconciler.ports** | `MachineReconcilerPorts` | constructor/initializer | onAttached, constructor/callback, candidates, withSession, reviveParkedButAlive, onDetached | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/naming.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1022 `modules/sessions/naming.ts:72` **SessionNaming.ports** | `SessionNamingPorts` | constructor/initializer | rename, setAgentName | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/picture-cache.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0970 `modules/sessions/picture-cache.ts:60` **PictureCache.current** | `CachedPicture \| undefined` | putPicture, drop, trim | picture, cap, appendData, drop, trim | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0971 `modules/sessions/picture-cache.ts:61` **PictureCache.chunks** | `TailChunk[]` | appendData, drop, trim | drop, read, trim | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0972 `modules/sessions/picture-cache.ts:63` **PictureCache.end** | `number` | appendData | appendData, putPicture, read, trim | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0973 `modules/sessions/picture-cache.ts:64` **PictureCache.readers** | `Set<TailReader>` | openReader, closeReader | appendData, trim | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0974 `modules/sessions/picture-cache.ts:66` **PictureCache.sessionId** | `string` | constructor/initializer | drop, trim | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/publication/broadcast.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0975 `modules/sessions/publication/broadcast.ts:34` **SessionBroadcastCoordinator.cooldown** | `ReturnType<typeof setTimeout> \| null` | broadcast, constructor/callback, flush | broadcast, flush | no independent truth | **delete** | server-side activity/metadata coalescing or derived projection hint; coalesce at producer, append once, tail durable log |
| S0976 `modules/sessions/publication/broadcast.ts:35` **SessionBroadcastCoordinator.pending** | `boolean` | broadcast, constructor/callback, runScheduled, flush | constructor/callback | no independent truth | **delete** | server-side activity/metadata coalescing or derived projection hint; coalesce at producer, append once, tail durable log |
| S0977 `modules/sessions/publication/broadcast.ts:36` **SessionBroadcastCoordinator.running** | `Promise<void> \| null` | run, capture | flush, capture | no independent truth | **delete** | server-side activity/metadata coalescing or derived projection hint; coalesce at producer, append once, tail durable log |
| S0978 `modules/sessions/publication/broadcast.ts:38` **SessionBroadcastCoordinator.ports** | `SessionBroadcastPorts` | constructor/initializer | broadcast, run | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/read-toolkit.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0832 `modules/sessions/read-toolkit.ts:128` **SessionReadToolkit.deps** | `SessionReadToolkitDeps` | constructor/initializer | subagentsOf, matchFacts, resolveVisible, resolveTarget, shownStatus, status, read, recap, logRead | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/receipt-send.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0992 `modules/sessions/receipt-send.ts:145` **ReceiptSender.ports** | `ReceiptSenderPorts` | constructor/initializer | onContract, send, attachmentsBelonging, enqueue, legacy | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/records.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0700 `modules/sessions/records.ts:100` **SessionRecords.ports** | `SessionRecordPorts` | constructor/initializer | read, ownershipOf, constructor/callback, page, issueMembers, issueMembersMany, birthRefCandidates, seatFacts, select, listOrder, residentOf, fromRows, conversationIds | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/runtime-event-gate.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0824 `modules/sessions/runtime-event-gate.ts:332` **RuntimeEventGate.ports** | `RuntimeEventGatePorts` | constructor/initializer | recordBatchUnlogged, constructor/callback, recordUnlogged, withSession, applyDelivery, recent, readBoardProjection, drainBoardProjection, saveBoardProjection | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0825 `modules/sessions/runtime-event-gate.ts:333` **RuntimeEventGate.readySessions** | `Set<SessionId>` | recordBatchUnlogged, recordUnlogged, constructor/callback, hydrateReady | ready | work/claim/retry | **job** | runtime projection/catch-up progress; checkpoint facts in transaction and persist due work; losing a process must not skip events |
| S0826 `modules/sessions/runtime-event-gate.ts:334` **RuntimeEventGate.projectionDrain** | `Promise<void> \| undefined` | replayBoardProjection, runBoardProjection | replayBoardProjection | work/claim/retry | **job** | runtime projection/catch-up progress; checkpoint facts in transaction and persist due work; losing a process must not skip events |
| S0827 `modules/sessions/runtime-event-gate.ts:335` **RuntimeEventGate.projectionRequested** | `boolean` | replayBoardProjection, runBoardProjection | runBoardProjection | work/claim/retry | **job** | runtime projection/catch-up progress; checkpoint facts in transaction and persist due work; losing a process must not skip events |
| S0828 `modules/sessions/runtime-event-gate.ts:337` **RuntimeEventGate.projection** | `ProjectionProgress \| undefined` | runBoardProjection | runBoardProjection | work/claim/retry | **job** | runtime projection/catch-up progress; checkpoint facts in transaction and persist due work; losing a process must not skip events |
| S0829 `modules/sessions/runtime-event-gate.ts:342` **RuntimeEventGate.rejections** | `Map<string, number>` | noteRejection | noteRejection | diagnostics only | **delete** | bounded diagnostic rejection counts; no durable authority |

### modules/sessions/runtime-gateway.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0694 `modules/sessions/runtime-gateway.ts:259` **SessionRuntimeGateway.listeners** | `Set< { each: RuntimeEventListener } \| { batch: RuntimeEventBatchListener } >` | onEvent, constructor/callback, onEvents | recordAndPublish | no independent truth | **delete** | in-memory runtime-event dispatch queue and budget; commit an idempotent fact batch before ack; follow-up work is a durable job |
| S0695 `modules/sessions/runtime-gateway.ts:263` **SessionRuntimeGateway.inbound** | `Map<SessionId, PendingRuntimeEvent[]>` | constructor/callback, drain | constructor/callback, drain | no independent truth | **delete** | in-memory runtime-event dispatch queue and budget; commit an idempotent fact batch before ack; follow-up work is a durable job |
| S0696 `modules/sessions/runtime-gateway.ts:264` **SessionRuntimeGateway.sliceItems** | `number` | constructor/callback, chargeIngress | sliceItemsCharged, chargeIngress | no independent truth | **delete** | in-memory runtime-event dispatch queue and budget; commit an idempotent fact batch before ack; follow-up work is a durable job |
| S0697 `modules/sessions/runtime-gateway.ts:265` **SessionRuntimeGateway.sliceStarted** | `number` | chargeIngress | sliceItemsCharged | no independent truth | **delete** | in-memory runtime-event dispatch queue and budget; commit an idempotent fact batch before ack; follow-up work is a durable job |
| S0698 `modules/sessions/runtime-gateway.ts:266` **SessionRuntimeGateway.sliceYield** | `Promise<void> \| undefined` | paceIngress, constructor/callback | paceIngress | no independent truth | **delete** | in-memory runtime-event dispatch queue and budget; commit an idempotent fact batch before ack; follow-up work is a durable job |
| S0699 `modules/sessions/runtime-gateway.ts:268` **SessionRuntimeGateway.ports** | `SessionRuntimeGatewayPorts` | constructor/initializer | send, stageAttachment, interrupt, cancelDelivery, answer, configure, lifecycle, drain, recordAndPublish, ready, replayBoardProjection, recentEvents | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/session-authz.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0998 `modules/sessions/session-authz.ts:67` **SessionAuthz.ports** | `SessionAuthzPorts` | constructor/initializer | authorizeQueuedInputAtApply, parentSessionOf, sessionById, machineUseForClient, authorizeClientDrive, capabilityForSession, constructor/callback, primeOwnerMemo, ownershipOf, storedOwnershipRecord | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/session-binding.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1007 `modules/sessions/session-binding.ts:40` **SessionBindingReceipts.projectedConfidence** | `WeakMap<Session, 'exact' \| 'heuristic'>` | observeResumeRef | observeResumeRef, constructor/callback | no independent truth | **delete** | server-side activity/metadata coalescing or derived projection hint; coalesce at producer, append once, tail durable log |
| S1008 `modules/sessions/session-binding.ts:42` **SessionBindingReceipts.deps** | `SessionBindingReceiptsDeps` | constructor/initializer | observeResumeRef | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/session-client-plane.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1001 `modules/sessions/session-client-plane.ts:44` **SessionClientPlane.ports** | `SessionClientPlanePorts` | constructor/initializer | onMachineAttached, onMachineDetached, reattachMessageFor, rebindHeadless, reestablishHeadless, toMachine, onClientAttached, onRoomJoined, onClientReclaim, onClientDetached, onOpenUrl, onSessionClientFrame, onSessionClientInput | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1002 `modules/sessions/session-client-plane.ts:187` **SessionClientPlane.toMachine** | `callback` | constructor/initializer | SessionClientPlane consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/session-kill.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1023 `modules/sessions/session-kill.ts:59` **SessionKill.ports** | `SessionKillPorts` | constructor/initializer | removeSessionRuntime, retireSessionProcess, prepareSessionRuntimeRemoval, constructor/callback, killSession, write, apply, emitSessionExited | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/session-meta-ops.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0818 `modules/sessions/session-meta-ops.ts:96` **SessionMetaOps.ports** | `SessionMetaOpsPorts` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0819 `modules/sessions/session-meta-ops.ts:465` **SessionMetaOps.sessionStateRegistry** | `SessionStateRegistry \| undefined` | constructor/initializer | SessionMetaOps consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0820 `modules/sessions/session-meta-ops.ts:507` **SessionMetaOps.mutations** | `MutationLedgerPort` | constructor/initializer | SessionMetaOps consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/session-revival.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0821 `modules/sessions/session-revival.ts:135` **SessionRevival.handoffCoordinator** | `HandoffCoordinator \| undefined` | handoffs | handoffs | wiring/code only | **delete** | handoff service capability alias; job/request-scoped operation chain |
| S0822 `modules/sessions/session-revival.ts:138` **SessionRevival.pendingResurrections** | `Map<SessionId, Promise<ResurrectionResult>>` | constructor/callback, resurrectResident | resurrecting, check, resurrectResident | acceptance/result | **operation** | in-flight machine command, credential/login, discovery or handoff chain; stable operation/result rows replace local promises/maps |
| S0823 `modules/sessions/session-revival.ts:139` **SessionRevival.ports** | `SessionRevivalPorts` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/session-start.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0709 `modules/sessions/session-start.ts:296` **SessionStart.ports** | `SessionStartPorts` | constructor/initializer | create, startTask, discardDraft, start, ownerSettings, spawn, toDaemon, sendInput, onActivity, constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/session-state/registry.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0931 `modules/sessions/session-state/registry.ts:347` **SessionStateRegistry.deps** | `SessionStateDeps` | constructor/initializer | run, constructor/callback, execute, authorizeOrDeny | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0932 `modules/sessions/session-state/registry.ts:348` **SessionStateRegistry.writer** | `SessionWriter` | constructor/initializer | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/session-state/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0923 `modules/sessions/session-state/service.ts:206` **SessionStateService.draftDocs** | `Map<SessionId, DraftDoc>` | loadFromStore, constructor/callback, docOf, evictSession, removeSession, commitVersionedEdit | docOf, replayDrafts, commitVersionedEdit, constructor/callback | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0924 `modules/sessions/session-state/service.ts:207` **SessionStateService.draftEdits** | `Map<SessionId, { tail: Promise<void>; cancelled: boolean }>` | loadFromStore, removeSession, applyVersionedEdit, constructor/callback | loadFromStore, holdsWork, removeSession, applyVersionedEdit, constructor/callback | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0925 `modules/sessions/session-state/service.ts:210` **SessionStateService.stagedDraftTimes** | `Map<SessionId, string>` | loadFromStore, stageDraftTimes, constructor/callback, installSession, evictSession, removeSession | installSession | buffered value/order | **delete** | Core checkpoint/debounce staging; room never writes DB; device/daemon checkpoints to Core on pause/blur/send |
| S0926 `modules/sessions/session-state/service.ts:211` **SessionStateService.draftDocWriteTimers** | `Map<SessionId, ReturnType<typeof setTimeout>>` | removeSession, persistDraftDoc, constructor/callback | holdsWork, removeSession, persistDraftDoc | buffered value/order | **delete** | Core checkpoint/debounce staging; room never writes DB; device/daemon checkpoints to Core on pause/blur/send |
| S0927 `modules/sessions/session-state/service.ts:213` **SessionStateService.lastPriority** | `Map<SessionId, string>` | removeSession, resetPriorities, pushPriorities | pushPriorities | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0928 `modules/sessions/session-state/service.ts:227` **SessionStateService.lastUnwatchedAt** | `Map<SessionId, number>` | removeSession, pushPriorities | lastUnwatchedAtMs | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0929 `modules/sessions/session-state/service.ts:235` **SessionStateService.lastHeldAt** | `Map<SessionId, number>` | removeSession, pushPriorities | lastHeldAtMs | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S0930 `modules/sessions/session-state/service.ts:237` **SessionStateService.ports** | `SessionStatePorts` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/session-teardown.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0712 `modules/sessions/session-teardown.ts:121` **SessionTeardown.ports** | `SessionTeardownPorts` | constructor/initializer | failUnresumableMessages, parkArchivedSession, constructor/callback, retireArchivedSurvivor, parkShellSession, parkStaleSession, tryAutoArchiveStoppedObserved, stopSession, worktreeForSession, issueForCwd, killStoppedSession, gracefulStopThenKill, finalizeDeferredStopKill, stopIssue, hibernateSession | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/switch-credential.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0994 `modules/sessions/switch-credential.ts:201` **CredentialSwitcher.moves** | `Map<SessionId, PendingSwitch>` | switchCredential, restartWithResume | waiting, restartWithResume | acceptance/result | **operation** | in-flight machine command, credential/login, discovery or handoff chain; stable operation/result rows replace local promises/maps |
| S0995 `modules/sessions/switch-credential.ts:203` **CredentialSwitcher.outcomes** | `Map<SessionId, SessionSwitchCredentialOutput>` | switchCredential, settle | switchCredential | acceptance/result | **operation** | in-flight machine command, credential/login, discovery or handoff chain; stable operation/result rows replace local promises/maps |
| S0996 `modules/sessions/switch-credential.ts:204` **CredentialSwitcher.awaited** | `Set<SessionId>` | switchCredential | settle | acceptance/result | **operation** | in-flight machine command, credential/login, discovery or handoff chain; stable operation/result rows replace local promises/maps |
| S0997 `modules/sessions/switch-credential.ts:206` **CredentialSwitcher.deps** | `CredentialSwitchDeps` | constructor/initializer | switchCredential, restartWithResume, finishSwitch, place, typeOf, settled, constructor/callback, handoff, event | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/terminal-proof.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0701 `modules/sessions/terminal-proof.ts:98` **SessionTerminalProof.ports** | `TerminalProofPorts` | constructor/initializer | fence, facts, factsFrom, proofStatus, proofStatuses, constructor/callback, statusFrom, proofMissing | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/turn-preview.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0999 `modules/sessions/turn-preview.ts:85` **TurnPreviewAccumulator.sessions** | `Map<SessionId, SessionPreview>` | forget, admit, fence | record, forget, dispose, admit, open, fence, constructor/callback | live correctness | **room** | live session/machine reading, subscription, viewport/control or draft state; reset on room restart and reconstruct from live peers/grants |
| S1000 `modules/sessions/turn-preview.ts:87` **TurnPreviewAccumulator.ports** | `TurnPreviewPorts` | constructor/initializer | intervalMs, setTimer, clearTimer, forget, fence, schedule, flush | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sessions/view.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0830 `modules/sessions/view.ts:63` **SessionView.ports** | `SessionViewPorts` | constructor/initializer | list, listInPages, listForIssue, byId, byIds, spawnedByOf, project, buildProjectionPass, principalForTrustedUser, defaultPrincipal, overlay, prepareRefAllocation, constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0831 `modules/sessions/view.ts:239` **SessionView.wire** | `inferred value/definition` | constructor/initializer | constructor/callback | wiring/code only | **delete** | pure projection function alias; no retained state |

### modules/sessions/workspace.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0837 `modules/sessions/workspace.ts:47` **SessionWorkspace.ports** | `SessionWorkspacePorts` | constructor/initializer | prepareTarget, resolveRepoOnMachine, ensureRefOnMachine, repoOnMachineByIdentity, findRepoOnMachine, ensureTargetRepo, register, fetch, constructor/callback, cleanPeeks, ensureSessionWorktree | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/settings/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1270 `modules/settings/service.ts:311` **SettingsService.telegramSetups** | `Map<string, PendingTelegramSetup>` | disconnectTelegram, startTelegramSetup, pollTelegramSetup | disconnectTelegram, hasPendingTelegramSetup, pollTelegramSetup | answer/decision | **derived** | short-lived Telegram setup challenges; Q-pairing setup kind; new row required |
| S1271 `modules/settings/service.ts:312` **SettingsService.telegramSetup** | `TelegramSetupClient` | constructor/callback | startTelegramSetup, pollTelegramSetup | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1272 `modules/settings/service.ts:313` **SettingsService.telegramBindings** | `TelegramBindingWriter` | constructor/callback | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1273 `modules/settings/service.ts:314` **SettingsService.generateTelegramSetupCode** | `() => string` | constructor/callback | startTelegramSetup | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1274 `modules/settings/service.ts:315` **SettingsService.now** | `() => number` | constructor/callback | constructor/callback, setSettingsFor, updatePreferences, setSecret, nowIso, startTelegramSetup | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1275 `modules/settings/service.ts:316` **SettingsService.fingerprintKey** | `() => Buffer \| Promise<Buffer>` | constructor/callback | setSecret, clearSecret, secretPresenceList | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1276 `modules/settings/service.ts:317` **SettingsService.audit** | `SettingsAuditPort` | constructor/callback | recordCommand | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1277 `modules/settings/service.ts:318` **SettingsService.preferenceWriter** | `PreferenceWriter \| undefined` | constructor/callback | updatePreferences, disconnectTelegram, writeTelegramRoute | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1278 `modules/settings/service.ts:322` **SettingsService.modelCatalog** | `ModelCatalog` | constructor/callback | getModelCatalog, refreshModelCatalog | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1279 `modules/settings/service.ts:325` **SettingsService.store** | `SettingsStore` | constructor/initializer | load, save, getSettings, getSettingsFor, setSettingsFor, updatePreferences, write, setSecret, clearSecret, writeTelegramRoute | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1280 `modules/settings/service.ts:326` **SettingsService.secrets** | `SecretStore` | setSecret, clearSecret | constructor/callback, secretPresenceList, telegramBotPresence, startTelegramSetup, pollTelegramSetup | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1281 `modules/settings/service.ts:327` **SettingsService.bus** | `EventBus` | constructor/initializer | constructor/callback, emitSettingsChanged, setSecret, clearSecret | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/settings/superagent-default.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1282 `modules/settings/superagent-default.ts:75` **SuperagentDefaultSeeder.deps** | `SuperagentDefaultSeederDeps` | constructor/initializer | seed | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/shells/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0647 `modules/shells/service.ts:94` **DockShellService.locks** | `Map<string, Promise<void>>` | withLock | withLock | answer/decision | **derived** | shell-slot creation serialization; Q-dock unique key with atomic claim |
| S0648 `modules/shells/service.ts:96` **DockShellService.deps** | `DockShellServiceDeps` | constructor/initializer | constructor/callback, nowIso | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/shipping/lease-projection.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1165 `modules/shipping/lease-projection.ts:74` **LeaseProjection.leases** | `StagedProjection<ReadonlyMap<string, Lease>>` | constructor/callback, set, delete | get, delete, renew | answer/decision | **derived** | shipping custody/version or validation proof; Q-shipping; compare durable generations in transaction, never process counters |
| S1166 `modules/shipping/lease-projection.ts:75` **LeaseProjection.versions** | `Map<string, number>` | bump | versionOf | answer/decision | **derived** | shipping custody/version or validation proof; Q-shipping; compare durable generations in transaction, never process counters |

### modules/shipping/policy.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1164 `modules/shipping/policy.ts:30` **CompatibilityShippingPolicyResolver.defaultTargetBranch** | `(issue: IssueReport) => string \| Promise<string>` | constructor/initializer | resolve | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/shipping/queue.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1171 `modules/shipping/queue.ts:426` **GreenPrefixCache.green** | `Map< string, { result: PrefixValidationResult; orderIds: ShipOrderId[] } >` | record, invalidateOrder | get, invalidateOrder | answer/decision | **derived** | shipping custody/version or validation proof; Q-shipping; compare durable generations in transaction, never process counters |

### modules/shipping/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1152 `modules/shipping/service.ts:122` **ShippingAdmissionError.code** | `ShippingAdmissionCode` | constructor/initializer | ShippingAdmissionError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1153 `modules/shipping/service.ts:124` **ShippingAdmissionError.rootIssueId** | `IssueId` | constructor/initializer | ShippingAdmissionError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1154 `modules/shipping/service.ts:426` **ShippingService.greenPrefixes** | `GreenPrefixCache` | constructor/initializer | isolateValidationFailure | answer/decision | **derived** | green prefix validation evidence; Q-shipping; extend durable evidence key with tree/base/profile fingerprints if missing |
| S1155 `modules/shipping/service.ts:427` **ShippingService.now** | `() => string` | constructor/callback | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable handler policy/dependency; pass through request/job context, not a persistent work or fact row |
| S1156 `modules/shipping/service.ts:428` **ShippingService.leases** | `LeaseProjection` | constructor/callback, runOrder, cancel, settleCancellation, runEffect, isolateValidationFailure, hold | heartbeat, constructor/callback, runOrder, claimDurableTrain, claimAttempt, runEffect | answer/decision | **derived** | current attempt custody; Q-shipping |
| S1157 `modules/shipping/service.ts:429` **ShippingService.activeResourceLeases** | `Set<ResourceLease>` | dispose, acquireResources, releaseResources | dispose | work/claim/retry | **job** | shipping admission/attempt runner state; durable claims/leases/jobs gate all dispatch |
| S1158 `modules/shipping/service.ts:430` **ShippingService.inFlight** | `Set<string>` | runOrder | constructor/callback | work/claim/retry | **job** | shipping admission/attempt runner state; durable claims/leases/jobs gate all dispatch |
| S1159 `modules/shipping/service.ts:431` **ShippingService.admissionTail** | `Promise<void>` | enqueue | enqueue | work/claim/retry | **job** | shipping admission/attempt runner state; durable claims/leases/jobs gate all dispatch |
| S1160 `modules/shipping/service.ts:432` **ShippingService.admissionsInFlight** | `number` | enqueue | runTick | work/claim/retry | **job** | shipping admission/attempt runner state; durable claims/leases/jobs gate all dispatch |
| S1161 `modules/shipping/service.ts:433` **ShippingService.timer** | `ReturnType<typeof setInterval> \| undefined` | start, dispose | start, dispose | work/claim/retry | **job** | shipping admission/attempt runner state; durable claims/leases/jobs gate all dispatch |
| S1162 `modules/shipping/service.ts:435` **ShippingService.ticking** | `boolean` | tick | tick | work/claim/retry | **job** | shipping admission/attempt runner state; durable claims/leases/jobs gate all dispatch |
| S1163 `modules/shipping/service.ts:437` **ShippingService.deps** | `ShippingServiceDeps` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/shipping/shipwright.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1167 `modules/shipping/shipwright.ts:222` **ShippingEvidenceRegistry.store** | `ShippingEvidenceStore` | constructor/initializer | materialize, resolve, read | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1168 `modules/shipping/shipwright.ts:223` **ShippingEvidenceRegistry.now** | `() => string` | constructor/initializer | materialize | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1169 `modules/shipping/shipwright.ts:544` **ShipwrightService.budget** | `ShipwrightBudget` | constructor/callback | consider, run, requiresInspection | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1170 `modules/shipping/shipwright.ts:546` **ShipwrightService.deps** | `ShipwrightDeps` | constructor/initializer | consider, acknowledge, run | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/superagent/headless.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0620 `modules/superagent/headless.ts:187` **HeadlessService.deps** | `HeadlessDeps` | constructor/initializer | createHeadlessSession, toDaemon, constructor/callback, spawnFrameFor, reestablishHeadless, headlessSession, setHeadlessResume, broadcastHeadlessActivity, superagentLoginRefusal, headlessTurn, headlessTurnAck, headlessInterrupt, headlessBind | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/superagent/refusal.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0621 `modules/superagent/refusal.ts:17` **SuperagentRefusal.kind** | `Extract<SyncSubmitRefusal['kind'], 'conflict' \| 'invalid' \| 'target-not-found'>` | constructor/initializer | SuperagentRefusal consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### modules/superagent/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0601 `modules/superagent/service.ts:280` **SuperagentService.turnInFlight** | `Set<string>` | holdTurn, releaseTurn | sendTurn, constructor/callback, pump, openInTerminal | work/claim/retry | **job** | assistant turn dispatch/prepare/reaper/fallback bookkeeping; durable turn/job claim and idempotent operation results |
| S0602 `modules/superagent/service.ts:283` **SuperagentService.dispatchedTurnIds** | `Set<string>` | dispatchPendingTurn, constructor/callback, finishPendingTurn | dispatchPendingTurn, runTurnReap | answer/decision | **derived** | already-dispatched turn ids; Q-assistant with durable dispatch receipt |
| S0603 `modules/superagent/service.ts:286` **SuperagentService.dispatchAttempts** | `Map<string, number>` | constructor/callback, finishPendingTurn | constructor/callback | work/claim/retry | **job** | assistant turn dispatch/prepare/reaper/fallback bookkeeping; durable turn/job claim and idempotent operation results |
| S0604 `modules/superagent/service.ts:288` **SuperagentService.interruptFallbacks** | `Map<string, ReturnType<typeof setTimeout>>` | dispose, finishPendingTurn, constructor/callback | dispose, finishPendingTurn, constructor/callback | work/claim/retry | **job** | assistant turn dispatch/prepare/reaper/fallback bookkeeping; durable turn/job claim and idempotent operation results |
| S0605 `modules/superagent/service.ts:289` **SuperagentService.reaper** | `ReturnType<typeof setInterval> \| undefined` | constructor/callback, dispose | constructor/callback, dispose | work/claim/retry | **job** | assistant turn dispatch/prepare/reaper/fallback bookkeeping; durable turn/job claim and idempotent operation results |
| S0606 `modules/superagent/service.ts:291` **SuperagentService.reaping** | `boolean` | reapStaleTurns, constructor/callback | reapStaleTurns | work/claim/retry | **job** | assistant turn dispatch/prepare/reaper/fallback bookkeeping; durable turn/job claim and idempotent operation results |
| S0607 `modules/superagent/service.ts:292` **SuperagentService.turnReap** | `Promise<void> \| undefined` | reapStaleTurns, constructor/callback | dispose, reapStaleTurns | work/claim/retry | **job** | assistant turn dispatch/prepare/reaper/fallback bookkeeping; durable turn/job claim and idempotent operation results |
| S0608 `modules/superagent/service.ts:293` **SuperagentService.disposed** | `boolean` | dispose | reapStaleTurns, finishPendingTurn | wiring/code only | **delete** | service lifecycle/configuration/tool capability; request/job inputs |
| S0609 `modules/superagent/service.ts:294` **SuperagentService.preparingInputs** | `Map< string, Promise<{ threadId: ThreadId; podiumSessionId: SessionId }> >` | constructor/callback, prepareQueuedInput | prepareQueuedInput | work/claim/retry | **job** | assistant turn dispatch/prepare/reaper/fallback bookkeeping; durable turn/job claim and idempotent operation results |
| S0610 `modules/superagent/service.ts:301` **SuperagentService.queuedHarness** | `Map<string, HarnessAgentKind>` | constructor/callback, runFirstQueuedTurn, failQueuedInput, prepareQueuedInputInner | prepareQueuedInputInner | work/claim/retry | **job** | assistant turn dispatch/prepare/reaper/fallback bookkeeping; durable turn/job claim and idempotent operation results |
| S0611 `modules/superagent/service.ts:304` **SuperagentService.mcpEndpoint** | `{ url: string; token: string; allToolNames?: string[] } \| undefined` | setMcpEndpoint | dispatchPendingTurn, harnessMcp | answer/decision | **derived** | MCP endpoint/scoped per-thread credentials; Q-mcp; no per-boot bearer or reverse-token table in Core |
| S0612 `modules/superagent/service.ts:308` **SuperagentService.mcpTokenToThread** | `Map<string, ThreadId>` | mcpThreadToken | threadForMcpToken | answer/decision | **derived** | MCP endpoint/scoped per-thread credentials; Q-mcp; no per-boot bearer or reverse-token table in Core |
| S0613 `modules/superagent/service.ts:309` **SuperagentService.mcpThreadToToken** | `Map<string, string>` | mcpThreadToken | mcpThreadToken | answer/decision | **derived** | MCP endpoint/scoped per-thread credentials; Q-mcp; no per-boot bearer or reverse-token table in Core |
| S0614 `modules/superagent/service.ts:314` **SuperagentService.issueTools** | `McpToolProvider \| undefined` | setIssueTools | tools | wiring/code only | **delete** | service lifecycle/configuration/tool capability; request/job inputs |
| S0615 `modules/superagent/service.ts:317` **SuperagentService.waitPollMs** | `number` | constructor/callback | tools | wiring/code only | **delete** | service lifecycle/configuration/tool capability; request/job inputs |
| S0616 `modules/superagent/service.ts:319` **SuperagentService.eventReadLimit** | `number` | constructor/callback | globalDigest, conciergeDigest, issueEventsSince | wiring/code only | **delete** | service lifecycle/configuration/tool capability; request/job inputs |
| S0617 `modules/superagent/service.ts:327` **SuperagentService.modules** | `RegistryModules` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0618 `modules/superagent/service.ts:328` **SuperagentService.repos** | `{ list(): Promise<string[]> }` | constructor/initializer | tools, conciergeTurn, globalDigest | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0619 `modules/superagent/service.ts:329` **SuperagentService.store** | `SessionStore` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sync-write/entry.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1036 `modules/sync-write/entry.ts:92` **SyncWriteRefused.refusal** | `SyncSubmitRefusal` | constructor/initializer | SyncWriteRefused consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1037 `modules/sync-write/entry.ts:151` **SyncWriteEntry.deps** | `SyncWriteEntryDeps` | constructor/initializer | registry, submitDetailed, constructor/callback, contextFor | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/sync-write/registry.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1035 `modules/sync-write/registry.ts:169` **SyncWriteRegistry.commands** | `Map<string, SyncCommand>` | register | register, lookup, names | wiring/code only | **delete** | immutable command/kind/provider/executor registration; freeze code registry; handlers take explicit request/job context |

### modules/updates/dev-bundle.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1351 `modules/updates/dev-bundle.ts:488` **DevBundleUnavailableError.publicReason** | `string` | constructor/initializer | DevBundleUnavailableError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1352 `modules/updates/dev-bundle.ts:497` **DevBundleProposalMovedError.name** | `inferred value/definition` | constructor/initializer | DevBundleProposalMovedError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1353 `modules/updates/dev-bundle.ts:2093` **DevArtifactIntegrityError.name** | `inferred value/definition` | constructor/initializer | DevArtifactIntegrityError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### modules/updates/installed-restart.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1359 `modules/updates/installed-restart.ts:133` **SupervisorUpdateFailure.reasonCode** | `string \| undefined` | constructor/callback | SupervisorUpdateFailure consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/updates/reconciler.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1350 `modules/updates/reconciler.ts:17` **UpdateReconciler.deps** | `UpdateReconcilerDeps` | constructor/initializer | reportDrift | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/updates/recovery-store.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1348 `modules/updates/recovery-store.ts:90` **UpdateRecoveryStore.queries** | `UpdateRecoveryQueries` | constructor/initializer | read, write, constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1349 `modules/updates/recovery-store.ts:91` **UpdateRecoveryStore.records** | `MachineRecordWrites` | constructor/initializer | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/updates/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1330 `modules/updates/service.ts:342` **UpdatesService.targets** | `Map<UpdateChannel, UpdateTarget>` | constructor/callback, setTargetUnavailable, reapproveTarget, setTargetResolved | constructor/callback, target, setTargetResolved, isSameUpdate, publishNextTargets | answer/decision | **derived** | fleet/update recovery state; Q-update; current checkpoint is install-global, not a workspace cache |
| S1331 `modules/updates/service.ts:343` **UpdatesService.withdrawnTargets** | `Map< UpdateChannel, { target: UpdateTarget; reason: string; withdrawnAt: number } >` | constructor/callback, withdrawFailedTarget, reapproveTarget, setTargetResolved | constructor/callback, targetUnavailableReasonForChannel, withdrawnTarget, reapproveTarget, setTargetResolved | answer/decision | **derived** | fleet/update recovery state; Q-update; current checkpoint is install-global, not a workspace cache |
| S1332 `modules/updates/service.ts:347` **UpdatesService.unavailableReasons** | `Map<UpdateChannel, string>` | constructor/callback, setTargetUnavailable, reapproveTarget, setTarget, setTargetFromProducer, setTargetResolved, resolveIntoTarget | targetUnavailableReasonForChannel | work/claim/retry | **job** | refresh/convergence intermediate state currently not all in checkpoint; persist refresh/convergence job state/results before retiring buffers |
| S1333 `modules/updates/service.ts:348` **UpdatesService.rollouts** | `Map<UpdateChannel, ChannelRolloutState>` | constructor/callback, setTargetUnavailable, reapproveTarget, setTargetResolved, rollout | constructor/callback, withdrawAuthorization, rollout | answer/decision | **derived** | fleet/update recovery state; Q-update; current checkpoint is install-global, not a workspace cache |
| S1334 `modules/updates/service.ts:349` **UpdatesService.machineStates** | `Map<string, MachineConvergenceState>` | constructor/callback, setTargetUnavailable, setTargetResolved, onStatus, clearMachineVerdicts, abandonWait, reissueGrants, issueGrants | constructor/callback, setTargetUnavailable, setTargetResolved, operationActive, onStatus, clearMachineVerdicts, executionMatchesTarget, retireGrant, abandonWait, machineBootedAtTarget, machineCrossedRestartBoundary | answer/decision | **derived** | fleet/update recovery state; Q-update; current checkpoint is install-global, not a workspace cache |
| S1335 `modules/updates/service.ts:350` **UpdatesService.pendingGrants** | `Map<string, PendingGrant>` | constructor/callback, setTargetUnavailable, setTargetResolved, clearMachineVerdicts, retireGrant, reissueGrants, issueGrants | handleCoordinatorUpdate, coordinatorGrantActive, constructor/callback, setTargetUnavailable, setTargetResolved, operationActive, onStatus, executionMatchesTarget, retireGrant, abandonWait, reissueGrants, machineCrossedRestartBoundary, issueGrants | answer/decision | **derived** | fleet/update recovery state; Q-update; current checkpoint is install-global, not a workspace cache |
| S1336 `modules/updates/service.ts:353` **UpdatesService.retiredGrants** | `Map<string, PendingGrant>` | constructor/callback, retireGrant, clearRetiredGrants, issueGrants | constructor/callback, onStatus, executionMatchesTarget, clearRetiredGrants | answer/decision | **derived** | fleet/update recovery state; Q-update; current checkpoint is install-global, not a workspace cache |
| S1337 `modules/updates/service.ts:356` **UpdatesService.terminalStatusesBeforeTarget** | `Map< UpdateChannel, Map<string, UpdateStatusMessage> >` | replayTerminalStatuses, onStatus | replayTerminalStatuses, onStatus | work/claim/retry | **job** | refresh/convergence intermediate state currently not all in checkpoint; persist refresh/convergence job state/results before retiring buffers |
| S1338 `modules/updates/service.ts:362` **UpdatesService.terminalStatusesBeforeMachine** | `Map<string, UpdateStatusMessage>` | replayTerminalStatusesForKnownMachines, onStatus | replayTerminalStatusesForKnownMachines | work/claim/retry | **job** | refresh/convergence intermediate state currently not all in checkpoint; persist refresh/convergence job state/results before retiring buffers |
| S1339 `modules/updates/service.ts:365` **UpdatesService.coordinatorUpdates** | `Map< string, { active(): boolean \| Promise<boolean>; dispatch(grant: UpdateGrantMessage): void } \| undefined >` | reserveCoordinatorUpdate, handleCoordinatorUpdate | reserveCoordinatorUpdate, issueGrants | connection/order only | **socket** | per-connected coordinator update dispatch functions; self-hosted/bootstrap update exception only; durable grant status stays in Q-update |
| S1340 `modules/updates/service.ts:437` **UpdatesService.checks** | `Map<UpdateChannel, ChannelCheckRecord>` | recordCheck | checkNow, constructor/callback | work/claim/retry | **job** | refresh/convergence intermediate state currently not all in checkpoint; persist refresh/convergence job state/results before retiring buffers |
| S1341 `modules/updates/service.ts:439` **UpdatesService.incompleteFeeds** | `Set<UpdateChannel>` | resolveIntoTarget | refreshTargetForPolling | work/claim/retry | **job** | refresh/convergence intermediate state currently not all in checkpoint; persist refresh/convergence job state/results before retiring buffers |
| S1342 `modules/updates/service.ts:440` **UpdatesService.refreshesInFlight** | `Map<UpdateChannel, Promise<boolean>>` | constructor/callback, refreshTarget | refreshTarget, constructor/callback | work/claim/retry | **job** | per-channel refresh dedupe; leased refresh job |
| S1343 `modules/updates/service.ts:442` **UpdatesService.nextTargets** | `Map<UpdateChannel, UpdateTarget>` | setTargetUnavailable, setTargetResolved, publishNextTargets | nextTarget, publishNextTargets | work/claim/retry | **job** | refresh/convergence intermediate state currently not all in checkpoint; persist refresh/convergence job state/results before retiring buffers |
| S1344 `modules/updates/service.ts:453` **UpdatesService.waveHistory** | `Map<UpdateChannel, WaveRound[]>` | recordWaveRound | waveRounds, recordWaveRound | diagnostics only | **delete** | in-memory wave diagnostic history; operation step history is authoritative |
| S1345 `modules/updates/service.ts:455` **UpdatesService.lastGrantAuthority** | `number` | constructor/callback, issueGrants | constructor/callback, issueGrants | answer/decision | **derived** | fleet/update recovery state; Q-update; current checkpoint is install-global, not a workspace cache |
| S1346 `modules/updates/service.ts:456` **UpdatesService.persistenceFailure** | `unknown` | persistRecovery | assertPersistence, persistRecovery | request/tx context | **delete** | process-local fail-stop latch; fail current transaction and re-read durable recovery; no cached failure authority |
| S1347 `modules/updates/service.ts:458` **UpdatesService.deps** | `UpdatesDeps` | constructor/initializer | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/workflows/handlers/context.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1423 `modules/workflows/handlers/context.ts:94` **WorkflowRefusal.kind** | `'not-found' \| 'unauthorized' \| 'conflict' \| 'invalid'` | constructor/initializer | WorkflowRefusal consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S1424 `modules/workflows/handlers/context.ts:276` **WorkflowAccess.machinesFor** | `( principal: WorkflowPrincipal, ) => WorkflowMachineAccess \| Promise<WorkflowMachineAccess>` | constructor/callback | assertMayPlaceOn | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1425 `modules/workflows/handlers/context.ts:289` **WorkflowAccess.resolveOwnership** | `( entities: readonly WorkflowEntityRef[], ) => WorkflowOwnershipPort \| Promise<WorkflowOwnershipPort>` | constructor/callback | ownershipFor | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1426 `modules/workflows/handlers/context.ts:294` **WorkflowAccess.deps** | `WorkflowServiceDeps` | constructor/initializer | sessionFor, inScope, inWriteScope, assertWorkflowRead, assertWorkflowWrite, assertCreateScope, canSeeRun, visibleBindings, machineForSession | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### modules/workflows/service.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1420 `modules/workflows/service.ts:215` **WorkflowService.deps** | `WorkflowServiceDeps` | constructor/callback | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1421 `modules/workflows/service.ts:244` **WorkflowService.ledger** | `AdvanceIdempotencyPort \| undefined` | constructor/callback | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S1422 `modules/workflows/service.ts:278` **WorkflowService.access** | `WorkflowAccess` | constructor/callback | assertWorkflowRead, canReadWorkflow, list, get, bindings, agentProfileForStep, runs, visibleRunsOf, startRunNow, runFor, execute, assign, targetRefusal | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### plain-command-scope.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0071 `plain-command-scope.ts:41` **PlainCommandWroteSyncedData.command** | `string` | constructor/initializer | PlainCommandWroteSyncedData consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### repo-discovery.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0587 `repo-discovery.ts:148` **MachineRepoDiscovery.deps** | `RepoDiscoveryDeps` | constructor/initializer | healMovedRepos, scan | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### repo-registry.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0025 `repo-registry.ts:64` **RepoRegistry.sessionReg** | `SessionRegistry` | constructor/initializer | prepareAdd, addKnownOrigin, setPrefix, verifyDefaultParentBranch, storeDefaultParentBranch, commitRepoWrite, serverWriter, remove, checkoutsMoved, rescanUsable, constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0026 `repo-registry.ts:65` **RepoRegistry.store** | `SessionStore` | constructor/initializer | list, machinesForRoot, constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### server-mode.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0027 `server-mode.ts:129` **HostedModeRefusal.feature** | `HostOnlyFeature` | constructor/callback | HostedModeRefusal consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### server.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0158 `server.ts:249` **PortInUseError.code** | `inferred value/definition` | constructor/initializer | PortInUseError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0159 `server.ts:251` **PortInUseError.port** | `number` | constructor/initializer | PortInUseError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### steward.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0149 `steward.ts:496` **StewardService.COMMUNICATED_GRACE_MS** | `number` | constructor/initializer | StewardService consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0150 `steward.ts:498` **StewardService.timer** | `ReturnType<typeof setInterval> \| undefined` | start, dispose | start, dispose | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0151 `steward.ts:500` **StewardService.ticking** | `boolean` | tick | tick | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0152 `steward.ts:501` **StewardService.arbiter** | `NotificationArbiter` | constructor/callback | runTick, retireSessionSettledFacts, retireIssueReviewFacts, retireNeedsHumanFacts, deliverSubscription, handleUnblock, handleSessionParentNudge, handleParentNudge, handleAckFallback | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0153 `steward.ts:502` **StewardService.principal** | `SystemCommandPrincipal` | constructor/callback | handleUnblock, handleParentNudge | work/claim/retry | **job** | background/coalesced work and local single-flight/lease state; persist key, due time, attempt and lease; handler re-reads rows and is idempotent |
| S0154 `steward.ts:504` **StewardService.deps** | `StewardDeps` | constructor/initializer | now, alreadyCommunicated, start, resolveCursor, runTick, retireNeedsHumanFacts, dispatchSubscriptions, factsFor, deliverSubscription, subscriberNudgeTargets, handleUnblock, handleSessionParentNudge, handleParentNudge, handleAckFallback, handleNeedsHuman | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0074 `store.ts:312` **WorkspaceNotProvisionedError.workspaceId** | `WorkspaceId` | constructor/initializer | WorkspaceNotProvisionedError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0075 `store.ts:349` **StoreDatabase.queries** | `GlobalQueries` | constructor/callback | constructor/callback, provisionWorkspace | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0076 `store.ts:355` **StoreDatabase.hostMachine** | `HostMachine` | constructor/callback | StoreDatabase consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0077 `store.ts:356` **StoreDatabase.publicationIdleSubscriptions** | `Set<() => void>` | unsubscribe, onPublicationIdle | closeOnce | connection/order only | **socket** | database connection/listener lifecycle; local handle only, no workspace data ownership; close clears it |
| S0078 `store.ts:358` **StoreDatabase.workspaces** | `Map<WorkspaceId, Promise<SessionStore>>` | boot, workspace, constructor/callback | workspace, constructor/callback, closeOnce | request/tx context | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S0079 `store.ts:359` **StoreDatabase.closing** | `Promise<void> \| undefined` | close | close | connection/order only | **socket** | database connection/listener lifecycle; local handle only, no workspace data ownership; close clears it |
| S0080 `store.ts:368` **StoreDatabase.searchIndexEnabledValue** | `boolean` | boot | searchIndexEnabled, boot | wiring/code only | **delete** | install schema capability; validate at deploy/open and pass immutable engine capability |
| S0081 `store.ts:475` **StoreDatabase.location** | `string` | constructor/initializer | compactLegacyPlaintext, constructor/callback, scrubLegacySnapshotsOnce | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0082 `store.ts:478` **StoreDatabase.lifecycle** | `StoreLifecycle` | constructor/initializer | legacyIdentityStorage, boot, schemaVersionForTransfer, checkpointForTransfer, preflightUpdateBackup, latestDatabaseSnapshot, discoverDatabaseSnapshots, updateSigningKey, constructor/callback, attachChangeLog, retireImportedIdentityStorage, refreshPlannerStatistics, closeOnce | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0083 `store.ts:485` **StoreDatabase.vaultBoot** | `{ readonly vaultKeyPath: string readonly queryOnly: boolean readonly legacyPlaintext: LegacyPlaintextOptions }` | constructor/initializer | boot, constructor/callback, legacyJobRunner | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0084 `store.ts:515` **StoreDatabase.wakeUps** | `WakeUpHub` | constructor/callback, closeOnce | StoreDatabase consumers | connection/order only | **socket** | database connection/listener lifecycle; local handle only, no workspace data ownership; close clears it |
| S0085 `store.ts:523` **StoreDatabase.executor** | `RootStoreExecutor<QueryClient>` | constructor/callback, closeOnce | scrubLegacySnapshotsOnce, destroyLegacyPlaintext, beginTransferFence, endTransferFence, transactFor, effect, onPublicationIdle | connection/order only | **socket** | database connection/listener lifecycle; local handle only, no workspace data ownership; close clears it |
| S0086 `store.ts:530` **StoreDatabase.db** | `SqlDatabase` | constructor/callback | json, legacyScrubInputs, compactLegacyPlaintext, constructor/callback, destroyLegacyPlaintext | connection/order only | **socket** | database connection/listener lifecycle; local handle only, no workspace data ownership; close clears it |
| S0087 `store.ts:638` **StoreDatabase.legacyKnownValues** | `string[] \| undefined` | scrubLegacySnapshotsOnce, constructor/callback | scrubLegacySnapshotsOnce | work/claim/retry | **job** | install cleanup/planner-statistics work; leased install job/checkpoint, self-hosted where applicable |
| S0088 `store.ts:640` **StoreDatabase.legacyScrub** | `Promise<LegacySnapshotScrubReport> \| undefined` | scrubLegacySnapshots | scrubLegacySnapshots | work/claim/retry | **job** | install cleanup/planner-statistics work; leased install job/checkpoint, self-hosted where applicable |
| S0089 `store.ts:642` **StoreDatabase.legacyJobs** | `AbortController` | closeOnce | constructor/callback, scrubLegacySnapshotsOnce | work/claim/retry | **job** | install cleanup/planner-statistics work; leased install job/checkpoint, self-hosted where applicable |
| S0090 `store.ts:910` **StoreDatabase.transferFenceHeld** | `boolean` | constructor/callback | transferFenceActive, constructor/callback | no independent truth | **delete** | self-hosted SQLite transfer fence belongs to install composition; never used as hosted workspace ownership |
| S0091 `store.ts:936` **StoreDatabase.changeLogAttached** | `Promise<void> \| undefined` | attachChangeLog | attachChangeLog | no independent truth | **delete** | one-time install wiring promise; immutable composition after startup |
| S0092 `store.ts:984` **StoreDatabase.plannerStatisticsTimer** | `ReturnType<typeof setInterval> \| undefined` | startPlannerStatistics, closeOnce | startPlannerStatistics, closeOnce | work/claim/retry | **job** | install cleanup/planner-statistics work; leased install job/checkpoint, self-hosted where applicable |
| S0093 `store.ts:1062` **SessionStore.database** | `StoreDatabase` | constructor/callback, close | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0094 `store.ts:1064` **SessionStore.workspaceId** | `WorkspaceId` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0095 `store.ts:1066` **SessionStore.db** | `SqlDatabase` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0096 `store.ts:1068` **SessionStore.queries** | `LegacyWorkspaceQueries` | constructor/callback | constructor/callback, deleteVaultKeyAndSecrets, identityDatabase | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0097 `store.ts:1070` **SessionStore.context** | `StoreContext` | constructor/callback | transact | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0098 `store.ts:1071` **SessionStore.repos** | `ReposRepository` | constructor/callback | constructor/callback, refuseLegacyIdentities | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0099 `store.ts:1073` **SessionStore.checkouts** | `CheckoutsRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0100 `store.ts:1074` **SessionStore.sessions** | `SessionsRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0101 `store.ts:1076` **SessionStore.observationCheckpoints** | `ObservationCheckpointsRepository` | constructor/callback | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0102 `store.ts:1077` **SessionStore.issues** | `IssuesRepository` | constructor/callback | constructor/callback, backfillLegacyWorktreeMachines, refuseLegacyIdentities | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0103 `store.ts:1078` **SessionStore.conversations** | `ConversationsRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0104 `store.ts:1080` **SessionStore.sync** | `SyncRepository` | constructor/callback | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0105 `store.ts:1081` **SessionStore.identityUpgrade** | `IdentityUpgradeRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0106 `store.ts:1082` **SessionStore.superagent** | `SuperagentRepository` | constructor/callback | constructor/callback, seed | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0107 `store.ts:1083` **SessionStore.settings** | `SettingsRepository` | constructor/callback | refuseAndRepair | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0108 `store.ts:1087` **SessionStore.layout** | `UserLayoutRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0109 `store.ts:1091` **SessionStore.dockShells** | `UserDockShellRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0110 `store.ts:1094` **SessionStore.readPositions** | `UserReadPositionRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0111 `store.ts:1100` **SessionStore.secrets** | `ServerSecretsRepository` | constructor/callback | constructor/callback, openVault | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0112 `store.ts:1104` **SessionStore.settingsAudit** | `SettingsAuditRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0113 `store.ts:1106` **SessionStore.nativeLogins** | `NativeLoginsRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0114 `store.ts:1108` **SessionStore.credentials** | `CredentialsRepository` | constructor/callback | readVaultKey, insertVaultKeyIfAbsent, constructor/callback, importLegacyCredentials | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0115 `store.ts:1110` **SessionStore.vaultKeyCheck** | `VaultKeyCheck \| undefined` | openVault | constructor/callback | answer/decision | **derived** | workspace cryptographic material/health; Q-vault; unwrap per request or separately declare measured versioned cache, none approved here |
| S0116 `store.ts:1111` **SessionStore.openedVault** | `Vault \| undefined` | openVault | vault | answer/decision | **derived** | workspace cryptographic material/health; Q-vault; unwrap per request or separately declare measured versioned cache, none approved here |
| S0117 `store.ts:1113` **SessionStore.legacyPlaintextReport** | `LegacyPlaintextReport \| undefined` | constructor/initializer | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0118 `store.ts:1119` **SessionStore.machines** | `MachinesRepository` | constructor/callback | constructor/callback, refuseLegacyIdentities | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0119 `store.ts:1122` **SessionStore.grants** | `GrantsRepository` | constructor/callback | constructor/callback, importLegacyCredentials | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0120 `store.ts:1125` **SessionStore.users** | `UsersRepository` | constructor/callback | constructor/callback, importLegacyCredentials | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0121 `store.ts:1127` **SessionStore.signInCarryOver** | `SignInCarryOverRepository` | constructor/callback | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0122 `store.ts:1131` **SessionStore.telegramBindings** | `TelegramBindingsRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0123 `store.ts:1132` **SessionStore.events** | `EventsRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0124 `store.ts:1134` **SessionStore.notificationFacts** | `NotificationFactsRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0125 `store.ts:1136` **SessionStore.notices** | `NoticesRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0126 `store.ts:1138` **SessionStore.concertmaster** | `ConcertmasterRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0127 `store.ts:1141` **SessionStore.quotaHistory** | `QuotaHistoryRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0128 `store.ts:1144` **SessionStore.transcriptCosts** | `TranscriptCostsRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0129 `store.ts:1146` **SessionStore.messages** | `MessagesRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0130 `store.ts:1148` **SessionStore.readWatermarks** | `ReadWatermarksRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0131 `store.ts:1150` **SessionStore.interactions** | `InteractionsRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0132 `store.ts:1151` **SessionStore.workflows** | `WorkflowsRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0133 `store.ts:1152` **SessionStore.agentProfiles** | `AgentProfilesRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0134 `store.ts:1154` **SessionStore.locks** | `LocksRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0135 `store.ts:1156` **SessionStore.artifactUploads** | `ArtifactUploadsRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0136 `store.ts:1158` **SessionStore.pendingUploads** | `PendingUploadsRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0137 `store.ts:1165` **SessionStore.maintenance** | `MaintenanceRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0138 `store.ts:1172` **SessionStore.janitorReads** | `JanitorReadsRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0139 `store.ts:1174` **SessionStore.automations** | `AutomationsRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0140 `store.ts:1176` **SessionStore.effects** | `EffectsRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0141 `store.ts:1178` **SessionStore.shipping** | `ShippingRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0142 `store.ts:1180` **SessionStore.updateRecovery** | `UpdateRecoveryStore` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0143 `store.ts:1181` **SessionStore.operations** | `OperationStore` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0144 `store.ts:1183` **SessionStore.messagingTopics** | `MessagingTopicsRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0145 `store.ts:1185` **SessionStore.messagingSessionAttachments** | `MessagingSessionAttachmentsRepository` | constructor/callback | SessionStore consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0146 `store.ts:1461` **SessionStore.tableWrites** | `TableWrites` | constructor/initializer | constructor/callback | wiring/code only | **delete** | workspace-local invalidation announcer alias; no cross-process row truth; reads go to DB and log wake-ups replace durable publication callbacks |

### store/agent-profiles.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0384 `store/agent-profiles.ts:163` **AgentProfilesRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/append-only.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0446 `store/append-only.ts:537` **ShippingGuardError.name** | `inferred value/definition` | constructor/initializer | ShippingGuardError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0447 `store/append-only.ts:538` **ShippingGuardError.code** | `inferred value/definition` | constructor/initializer | ShippingGuardError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0448 `store/append-only.ts:539` **ShippingGuardError.errno** | `number` | constructor/initializer | ShippingGuardError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0449 `store/append-only.ts:540` **ShippingGuardError.byteOffset** | `number` | constructor/initializer | ShippingGuardError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### store/artifact-uploads.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0247 `store/artifact-uploads.ts:180` **ArtifactUploadsRepository.db** | `WorkspaceDb` | constructor/callback | begin, get, advance, delete, deleteIssue, page, createdBefore | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0248 `store/artifact-uploads.ts:181` **ArtifactUploadsRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | ArtifactUploadsRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/automations.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0253 `store/automations.ts:452` **AutomationsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0254 `store/automations.ts:453` **AutomationsRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | AutomationsRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/checkouts.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0461 `store/checkouts.ts:327` **CheckoutsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0462 `store/checkouts.ts:328` **CheckoutsRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | applyReach, apply | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/collections.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0425 `store/collections.ts:100` **CollectionsRepository.db** | `WorkspaceDb` | constructor/callback | run | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0426 `store/collections.ts:101` **CollectionsRepository.dialect** | `RuleSqlDialect` | constructor/callback | run, select, sorted, after, keyed, keyPage | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0427 `store/collections.ts:103` **CollectionsRepository.checked** | `Map<string, string>` | run | run | no independent truth | **delete** | schema/rule compatibility memo; immutable build-generation validation, no retained row answers |

### store/committed-rows.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0200 `store/committed-rows.ts:16` **CommittedRows.listeners** | `Set<(change: CommittedRowChange<Row>) => void>` | subscribe, constructor/callback | constructor/callback | local follow-up/order | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S0201 `store/committed-rows.ts:19` **CommittedRows.transact** | `TransactionRunner` | constructor/initializer | write | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0202 `store/committed-rows.ts:20` **CommittedRows.label** | `string` | constructor/initializer | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/concertmaster.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0465 `store/concertmaster.ts:319` **ConcertmasterRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0466 `store/concertmaster.ts:320` **ConcertmasterRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | write | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0467 `store/concertmaster.ts:321` **ConcertmasterRepository.feedCapture** | `ConcertmasterFeedCapture \| undefined` | setFeedCapture, constructor/callback | constructor/callback, write | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/conversations.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0450 `store/conversations.ts:12` **ConversationsRepository.index** | `ConversationIndexRepository` | constructor/callback | ensureFts | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0451 `store/conversations.ts:13` **ConversationsRepository.registry** | `ConversationRegistryRepository` | constructor/callback | ConversationsRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0452 `store/conversations.ts:14` **ConversationsRepository.mirror** | `TranscriptMirrorRepository` | constructor/callback | ConversationsRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0453 `store/conversations.ts:15` **ConversationsRepository.transcriptIndex** | `TranscriptIndexRepository` | constructor/callback | ensureFts | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/conversations/index.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0194 `store/conversations/index.ts:445` **ConversationIndexRepository.ftsAvailable** | `boolean` | enableFts, disableFts | searchCandidates | wiring/code only | **delete** | schema-availability flag; immutable migrate/open capability |
| S0195 `store/conversations/index.ts:446` **ConversationIndexRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0196 `store/conversations/index.ts:447` **ConversationIndexRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | ConversationIndexRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0197 `store/conversations/index.ts:449` **ConversationIndexRepository.pg** | `boolean` | constructor/callback | enableFts, disableFts, upsert, searchCandidates | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/conversations/mirror.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0198 `store/conversations/mirror.ts:321` **TranscriptMirrorRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0199 `store/conversations/mirror.ts:322` **TranscriptMirrorRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | rotateIncarnation | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/conversations/registry.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0186 `store/conversations/registry.ts:403` **ConversationRegistryRepository.sessionRecordWrite** | `<T>(write: () => Promise<T>) => Promise<T>` | constructor/initializer | ensure, ensureMany, linkSegment | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0187 `store/conversations/registry.ts:404` **ConversationRegistryRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0188 `store/conversations/registry.ts:405` **ConversationRegistryRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | ConversationRegistryRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/conversations/transcript-index.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0189 `store/conversations/transcript-index.ts:347` **TranscriptIndexRepository.available** | `boolean` | enableFts, disableFts | isAvailable, append, constructor/callback, rows, searchCandidates | wiring/code only | **delete** | schema-availability flag; immutable migrate/open capability, no workspace row snapshot |
| S0190 `store/conversations/transcript-index.ts:348` **TranscriptIndexRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0191 `store/conversations/transcript-index.ts:349` **TranscriptIndexRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | enableFts, append, resetMissingLake, drop | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0192 `store/conversations/transcript-index.ts:352` **TranscriptIndexRepository.ownsEveryRow** | `boolean` | constructor/callback | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0193 `store/conversations/transcript-index.ts:355` **TranscriptIndexRepository.pg** | `boolean` | constructor/callback | enableFts, constructor/callback, searchCandidates, deleteSegmentRows | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/credentials.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0454 `store/credentials.ts:797` **CredentialsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0455 `store/credentials.ts:798` **CredentialsRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | insertWithSecret, remove, putSecret, deleteVaultKeyAndSecrets | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0456 `store/credentials.ts:807` **CredentialsRepository.vault** | `() => VaultKeyCheck \| undefined` | constructor/initializer | latestSecret | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/effects.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0421 `store/effects.ts:752` **EffectsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0422 `store/effects.ts:753` **EffectsRepository.transact** | `TransactionRunner` | constructor/callback | write | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0423 `store/effects.ts:754` **EffectsRepository.feedCapture** | `EffectFeedCapture \| undefined` | setFeedCapture, constructor/callback | constructor/callback, write | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0424 `store/effects.ts:755` **EffectsRepository.listeners** | `Set<EffectsCommittedListener>` | onCommitted, constructor/callback | constructor/callback | request/tx context | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |

### store/events.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0223 `store/events.ts:1063` **EventsRepository.appendListener** | `EventAppendListener \| undefined` | onAppend | constructor/callback, announceEvent | request/tx context | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S0224 `store/events.ts:1064` **EventsRepository.logCommit** | `EventLogCommit \| undefined` | setLogCommit | appendEvent, pruneEventBatch | request/tx context | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S0225 `store/events.ts:1066` **EventsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0226 `store/events.ts:1067` **EventsRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | appendEvent, constructor/callback, appendEventOnce, pruneEventBatch, activateJanitorSteward | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0227 `store/events.ts:1070` **EventsRepository.pendingAppends** | `PendingAppend[]` | constructor/callback, drainGroupedAppends | drainGroupedAppends | request/tx context | **delete** | event append batching/tail; append fact in caller transaction before ack and schedule durable follow-ups |
| S0228 `store/events.ts:1072` **EventsRepository.appendDrain** | `Promise<void> \| undefined` | constructor/callback, drainGroupedAppends | settleGroupedAppends | request/tx context | **delete** | event append batching/tail; append fact in caller transaction before ack and schedule durable follow-ups |

### store/executor/errors.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0362 `store/executor/errors.ts:46` **StoreExecutorError.openedAt** | `string` | constructor/callback | StoreExecutorError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0363 `store/executor/errors.ts:48` **StoreExecutorError.nestedOpenedAt** | `string` | constructor/callback | StoreExecutorError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0364 `store/executor/errors.ts:88` **TransactionPoisonedError.cause** | `unknown` | constructor/initializer | TransactionPoisonedError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0365 `store/executor/errors.ts:121` **PostCommitError.committed** | `boolean` | constructor/initializer | PostCommitError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0366 `store/executor/errors.ts:123` **PostCommitError.mechanism** | `'commit-application' \| 'follow-up'` | constructor/initializer | PostCommitError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0367 `store/executor/errors.ts:125` **PostCommitError.cause** | `unknown` | constructor/initializer | PostCommitError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0368 `store/executor/errors.ts:144` **StoreUnhealthyError.committed** | `boolean` | constructor/callback | StoreUnhealthyError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0369 `store/executor/errors.ts:147` **StoreUnhealthyError.cause** | `unknown` | constructor/initializer | StoreUnhealthyError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### store/executor/intent-audit.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0344 `store/executor/intent-audit.ts:381` **IntentAudit.examined** | `number` | observe | totals | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0345 `store/executor/intent-audit.ts:382` **IntentAudit.derivedWrite** | `number` | observe | totals | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0346 `store/executor/intent-audit.ts:383` **IntentAudit.derivedRead** | `number` | observe | totals | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0347 `store/executor/intent-audit.ts:384` **IntentAudit.inconclusiveCount** | `number` | observe | totals | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0348 `store/executor/intent-audit.ts:385` **IntentAudit.gradedReadDeclarations** | `number` | observe | reach | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0349 `store/executor/intent-audit.ts:386` **IntentAudit.readDeclarationsOutsideTheExecutor** | `number` | observe | reach | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0350 `store/executor/intent-audit.ts:387` **IntentAudit.found** | `IntentFinding[]` | observe | findings, fatal | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0351 `store/executor/intent-audit.ts:395` **IntentAudit.probe** | `StatementProbe` | constructor/initializer | IntentAudit consumers | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |

### store/executor/pg-driver.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0360 `store/executor/pg-driver.ts:167` **PgPoolTimeoutError.timeoutMs** | `number` | constructor/initializer | PgPoolTimeoutError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0361 `store/executor/pg-driver.ts:175` **WorkspaceFeedRowMissingError.workspaceId** | `string` | constructor/initializer | WorkspaceFeedRowMissingError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### store/executor/pg-drizzle.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0316 `store/executor/pg-drizzle.ts:68` **StorePgPreparedQuery.client** | `QueryClient` | run | values, run | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0317 `store/executor/pg-drizzle.ts:69` **StorePgPreparedQuery.intent** | `StatementIntent` | constructor/initializer | values, run | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0318 `store/executor/pg-drizzle.ts:156` **StorePgSession.preparations** | `number` | prepareQuery | StorePgSession consumers | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0319 `store/executor/pg-drizzle.ts:159` **StorePgSession.queryClient** | `QueryClient` | constructor/initializer | prepareQuery | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0320 `store/executor/pg-drizzle.ts:194` **StorePgRaw.prepared** | `StorePgPreparedQuery` | constructor/initializer | execute, toSQL | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0321 `store/executor/pg-drizzle.ts:195` **StorePgRaw.method** | `RawMethod` | constructor/initializer | execute | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0322 `store/executor/pg-drizzle.ts:213` **StorePgDatabase.storeDialect** | `PgDialect` | constructor/initializer | raw | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0323 `store/executor/pg-drizzle.ts:214` **StorePgDatabase.storeSession** | `StorePgSession` | constructor/initializer | raw | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/executor/pg-types.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0334 `store/executor/pg-types.ts:66` **Int8RangeError.text** | `string` | constructor/initializer | Int8RangeError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0335 `store/executor/pg-types.ts:84` **TimestampFormatError.text** | `string` | constructor/initializer | TimestampFormatError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0336 `store/executor/pg-types.ts:126` **NonCanonicalTimestampError.value** | `unknown` | constructor/initializer | NonCanonicalTimestampError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### store/executor/post-commit.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0337 `store/executor/post-commit.ts:92` **PostCommitRegistry.commitApplications** | `RegisteredStep[]` | constructor/initializer | applyCommit, empty, mergeInto, discard, clear | request/tx context | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S0338 `store/executor/post-commit.ts:93` **PostCommitRegistry.followUps** | `RegisteredStep[]` | constructor/initializer | followUp, empty, mergeInto, discard, clear | request/tx context | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S0339 `store/executor/post-commit.ts:94` **PostCommitRegistry.effects** | `RegisteredStep[]` | constructor/initializer | effect, empty, mergeInto, discard, clear | request/tx context | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S0340 `store/executor/post-commit.ts:172` **PostCommitRunner.queue** | `PostCommitRegistry[]` | drain | drain | local follow-up/order | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S0341 `store/executor/post-commit.ts:173` **PostCommitRunner.draining** | `boolean` | drain | busy, drain | local follow-up/order | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S0342 `store/executor/post-commit.ts:174` **PostCommitRunner.inFlightEffects** | `Map<Promise<void>, string>` | dispatch, constructor/callback | effectsSettled, pendingEffectLabels | local follow-up/order | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S0343 `store/executor/post-commit.ts:176` **PostCommitRunner.options** | `PostCommitRunnerOptions` | constructor/initializer | drain, assertActive, constructor/callback, dispatch, report | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/executor/state-models.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0324 `store/executor/state-models.ts:34` **StaleRevisionError.expected** | `number` | constructor/initializer | StaleRevisionError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0325 `store/executor/state-models.ts:35` **StaleRevisionError.found** | `number` | constructor/initializer | StaleRevisionError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0326 `store/executor/state-models.ts:44` **StaleVersionError.expected** | `number` | constructor/initializer | StaleVersionError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0327 `store/executor/state-models.ts:45` **StaleVersionError.found** | `number` | constructor/initializer | StaleVersionError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0328 `store/executor/state-models.ts:62` **DraftRegistry.installed** | `Map<string, T>` | seed, update | snapshot, update | request/tx context | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S0329 `store/executor/state-models.ts:64` **DraftRegistry.persist** | `(id: string, next: T) => Promise<void>` | constructor/initializer | update | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0330 `store/executor/state-models.ts:98` **LeasedState.executor** | `StoreExecutor<unknown>` | constructor/initializer | read, update | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0331 `store/executor/state-models.ts:99` **LeasedState.value** | `T` | constructor/callback | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0332 `store/executor/state-models.ts:126` **VersionedMutex.tail** | `Promise<unknown>` | run | run | request/tx context | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S0333 `store/executor/state-models.ts:127` **VersionedMutex.current** | `number` | constructor/callback | version, constructor/callback | request/tx context | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |

### store/executor/statement-probe.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0352 `store/executor/statement-probe.ts:223` **StatementProbeHub.probes** | `StatementProbe[]` | attach, constructor/callback | active, constructor/callback, emit | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0353 `store/executor/statement-probe.ts:224` **StatementProbeHub.siteRequests** | `number` | attach, constructor/callback | captureIssueSites | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0354 `store/executor/statement-probe.ts:225` **StatementProbeHub.attributors** | `number` | attach, constructor/callback | attributing | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0355 `store/executor/statement-probe.ts:235` **StatementProbeHub.onProbeError** | `(error: unknown) => void` | constructor/initializer | emit, constructor/callback, emitRoundTrip | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0356 `store/executor/statement-probe.ts:310` **StatementProbeHub.tripProbes** | `RoundTripProbe[]` | attachRoundTrips, constructor/callback | countingRoundTrips, constructor/callback, emitRoundTrip | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0357 `store/executor/statement-probe.ts:487` **RoundTripLedger.state** | `TripState` | beforeBegin, beginFailed, beforeStatements, beforeEnd, beforeSavepoint, beforeClose | beforeStatements, batchFailed, beforeEnd, beforeSavepoint, beforeClose | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0358 `store/executor/statement-probe.ts:488` **RoundTripLedger.lane** | `Lane \| undefined` | beforeBegin, beginFailed, beforeEnd | trip | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0359 `store/executor/statement-probe.ts:490` **RoundTripLedger.hub** | `StatementProbeHub` | constructor/initializer | counting, trip | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/executor/sync-drizzle.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0272 `store/executor/sync-drizzle.ts:157` **StoreRemoteSession.readingSession** | `SQLiteRemoteSession<EmptyRelations>` | constructor/callback | prepareQuery | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0273 `store/executor/sync-drizzle.ts:158` **StoreRemoteSession.arrayReadingSession** | `SQLiteRemoteSession<EmptyRelations>` | constructor/callback | prepareQuery | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0274 `store/executor/sync-drizzle.ts:159` **StoreRemoteSession.arrayWritingSession** | `SQLiteRemoteSession<EmptyRelations>` | constructor/callback | prepareQuery | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0275 `store/executor/sync-drizzle.ts:160` **StoreRemoteSession.intents** | `WeakMap<object, StatementIntent>` | prepareQuery | constructor/callback | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0276 `store/executor/sync-drizzle.ts:161` **StoreRemoteSession.arrayQueries** | `WeakSet<object>` | prepareQuery | constructor/callback | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0277 `store/executor/sync-drizzle.ts:163` **StoreRemoteSession.preparations** | `number` | prepareQuery | StoreRemoteSession consumers | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0278 `store/executor/sync-drizzle.ts:166` **StoreRemoteSession.queryClient** | `QueryClient` | constructor/initializer | batch, constructor/callback | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |

### store/executor/workspace-write-metrics.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0279 `store/executor/workspace-write-metrics.ts:20` **Histogram.recent** | `Float64Array` | constructor/initializer | record, snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0280 `store/executor/workspace-write-metrics.ts:21` **Histogram.buckets** | `number[]` | constructor/callback | record, snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0281 `store/executor/workspace-write-metrics.ts:22` **Histogram.count** | `number` | record | record, snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0282 `store/executor/workspace-write-metrics.ts:23` **Histogram.total** | `number` | record | snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0283 `store/executor/workspace-write-metrics.ts:24` **Histogram.max** | `number` | record | record, snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0284 `store/executor/workspace-write-metrics.ts:26` **Histogram.bounds** | `readonly number[]` | constructor/initializer | record | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0285 `store/executor/workspace-write-metrics.ts:58` **WorkspaceStats.wait** | `Histogram` | constructor/initializer | snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0286 `store/executor/workspace-write-metrics.ts:59` **WorkspaceStats.writeWait** | `Histogram` | constructor/initializer | snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0287 `store/executor/workspace-write-metrics.ts:60` **WorkspaceStats.hold** | `Histogram` | constructor/initializer | snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0288 `store/executor/workspace-write-metrics.ts:61` **WorkspaceStats.queue** | `Histogram` | constructor/initializer | snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0289 `store/executor/workspace-write-metrics.ts:62` **WorkspaceStats.seconds** | `Float64Array` | constructor/initializer | commit, snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0290 `store/executor/workspace-write-metrics.ts:63` **WorkspaceStats.writes** | `Float64Array` | constructor/initializer | commit, snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0291 `store/executor/workspace-write-metrics.ts:64` **WorkspaceStats.committed** | `number` | commit | snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0292 `store/executor/workspace-write-metrics.ts:65` **WorkspaceStats.rolledBack** | `number` | constructor/initializer | snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0293 `store/executor/workspace-write-metrics.ts:66` **WorkspaceStats.acquisitionFailures** | `number` | constructor/initializer | snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0294 `store/executor/workspace-write-metrics.ts:67` **WorkspaceStats.failed** | `number` | constructor/initializer | snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0295 `store/executor/workspace-write-metrics.ts:68` **WorkspaceStats.uncalibratedWaits** | `number` | constructor/initializer | snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0296 `store/executor/workspace-write-metrics.ts:70` **WorkspaceStats.sinceMs** | `number` | constructor/initializer | snapshot | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0297 `store/executor/workspace-write-metrics.ts:131` **WorkspaceWriteMetrics.workspaces** | `Map<string, WorkspaceStats>` | touch | touch, snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0298 `store/executor/workspace-write-metrics.ts:132` **WorkspaceWriteMetrics.listeners** | `Set<(sample: WorkspaceWriteObservation) => void>` | probe, constructor/callback | record | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0299 `store/executor/workspace-write-metrics.ts:133` **WorkspaceWriteMetrics.evicted** | `number` | touch | snapshot | diagnostics only | **delete** | diagnostic samples/counters/suppression or local logging buffers; emit to observability sink; no authorization, durable work or entity decisions |
| S0300 `store/executor/workspace-write-metrics.ts:136` **WorkspaceWriteMetrics.capacity** | `inferred value/definition` | constructor/initializer | touch, snapshot | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0301 `store/executor/workspace-write-metrics.ts:137` **WorkspaceWriteMetrics.now** | `() => number` | constructor/initializer | record, recordQueue, snapshot | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0302 `store/executor/workspace-write-metrics.ts:224` **PlainRoundTripBaseline.recent** | `Float64Array` | constructor/initializer | record, estimate | diagnostics only | **delete** | diagnostic round-trip sample ring; no entity/dispatch authority |
| S0303 `store/executor/workspace-write-metrics.ts:225` **PlainRoundTripBaseline.count** | `number` | record | estimate | diagnostics only | **delete** | diagnostic round-trip sample ring; no entity/dispatch authority |
| S0304 `store/executor/workspace-write-metrics.ts:242` **WorkspaceWriteTiming.workspace** | `string \| undefined` | begin, end | pipeline, end | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0305 `store/executor/workspace-write-metrics.ts:243` **WorkspaceWriteTiming.startedAt** | `number` | begin | end | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0306 `store/executor/workspace-write-metrics.ts:244` **WorkspaceWriteTiming.acquiredAt** | `number \| undefined` | begin, acquired | end | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0307 `store/executor/workspace-write-metrics.ts:245` **WorkspaceWriteTiming.baselineMs** | `number \| undefined` | begin | end | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0308 `store/executor/workspace-write-metrics.ts:246` **WorkspaceWriteTiming.queueMs** | `number` | begin | end | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0309 `store/executor/workspace-write-metrics.ts:247` **WorkspaceWriteTiming.trips** | `number` | begin, pipeline | end | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0310 `store/executor/workspace-write-metrics.ts:248` **WorkspaceWriteTiming.statements** | `number` | begin, pipeline | end | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0311 `store/executor/workspace-write-metrics.ts:249` **WorkspaceWriteTiming.pipelineMs** | `number` | begin, pipeline | end | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0312 `store/executor/workspace-write-metrics.ts:250` **WorkspaceWriteTiming.statementMs** | `number` | begin, pipeline | end | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0313 `store/executor/workspace-write-metrics.ts:253` **WorkspaceWriteTiming.baseline** | `PlainRoundTripBaseline` | constructor/initializer | begin, pipeline | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0314 `store/executor/workspace-write-metrics.ts:254` **WorkspaceWriteTiming.metrics** | `inferred value/definition` | constructor/initializer | end | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0315 `store/executor/workspace-write-metrics.ts:255` **WorkspaceWriteTiming.now** | `() => number` | constructor/initializer | begin, acquired, end | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### store/grants.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0470 `store/grants.ts:294` **GrantsRepository.committed** | `CommittedRows<typeof grants.$inferSelect>` | constructor/callback | constructor/callback | request/tx context | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S0471 `store/grants.ts:304` **GrantsRepository.visibilityRevisionValue** | `number` | constructor/callback | visibilityRevision | answer/decision | **derived** | authorization invalidation counter; Q-grants; persist revision or key revalidation to durable feed version |
| S0472 `store/grants.ts:344` **GrantsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0473 `store/grants.ts:345` **GrantsRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | GrantsRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0474 `store/grants.ts:349` **GrantsRepository.machineRecordWrites** | `MachineRecordWrites` | constructor/initializer | upsert, remove, removeAllForGrantee, removeAllForResource | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0475 `store/grants.ts:543` **GrantsRepository.resourceGrants** | `callback` | constructor/callback | loadForResource, loadForResourcesOfKinds | wiring/code only | **delete** | immutable prepared-query or operation/read-scope definition; request-scoped memo answers only; keep shared compiled code, remove per-workspace wrapper field |

### store/identity-upgrade.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0238 `store/identity-upgrade.ts:49` **IdentityUpgradeRepository.queries** | `WorkspaceQueries` | constructor/initializer | passwordHashes, pendingLinks, retireSessions | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0239 `store/identity-upgrade.ts:50` **IdentityUpgradeRepository.options** | `{ readonly legacyStorage: boolean }` | constructor/initializer | passwordHashes, pendingLinks | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/interactions.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0370 `store/interactions.ts:430` **InteractionsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0371 `store/interactions.ts:431` **InteractionsRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | write | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0372 `store/interactions.ts:432` **InteractionsRepository.feedCapture** | `InteractionFeedCapture \| undefined` | setFeedCapture | write | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/issue-git-states.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0252 `store/issue-git-states.ts:98` **IssueGitStatesRepository.db** | `WorkspaceDb` | constructor/callback | getMany, set, pages | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/issue-panel.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0403 `store/issue-panel.ts:453` **IssuePanelRepository.db** | `WorkspaceDb` | constructor/callback | hasId, getMany, forIssues, next, save, remove, clearTodos, toggle, pages | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/issue-revision.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0244 `store/issue-revision.ts:29` **StaleIssueRevisionError.issueId** | `string` | constructor/initializer | StaleIssueRevisionError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0245 `store/issue-revision.ts:30` **StaleIssueRevisionError.expected** | `number \| null` | constructor/initializer | StaleIssueRevisionError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0246 `store/issue-revision.ts:31` **StaleIssueRevisionError.found** | `number \| null` | constructor/initializer | StaleIssueRevisionError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### store/issues.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0260 `store/issues.ts:1558` **IssuesRepository.panel** | `IssuePanelRepository` | constructor/callback | IssuesRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0261 `store/issues.ts:1559` **IssuesRepository.gitStates** | `IssueGitStatesRepository` | constructor/callback | IssuesRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0262 `store/issues.ts:1560` **IssuesRepository.committed** | `CommittedRows<typeof issues.$inferSelect>` | constructor/callback | constructor/callback, write | request/tx context | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S0263 `store/issues.ts:1561` **IssuesRepository.sessionRefWrite** | `(<T>(write: () => Promise<T>) => Promise<T>) \| undefined` | setSessionRefWrite | writeRows | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0264 `store/issues.ts:1599` **IssuesRepository.rowCacheSlot** | `callback` | constructor/initializer | invalidateRowCache, frameRows | wiring/code only | **delete** | immutable prepared-query or operation/read-scope definition; request-scoped memo answers only; keep shared compiled code, remove per-workspace wrapper field |
| S0265 `store/issues.ts:1608` **IssuesRepository.userStateLoader** | `callback` | rowsWritten, userStateWritten, constructor/callback | loadIssueUserState, loadIssueUserStates, loadIssueUserStatesOfPairs | wiring/code only | **delete** | immutable prepared-query or operation/read-scope definition; request-scoped memo answers only; keep shared compiled code, remove per-workspace wrapper field |
| S0266 `store/issues.ts:1638` **IssuesRepository.accessLoader** | `callback` | rowsWritten | loadIssueAccess | wiring/code only | **delete** | immutable prepared-query or operation/read-scope definition; request-scoped memo answers only; keep shared compiled code, remove per-workspace wrapper field |
| S0267 `store/issues.ts:1664` **IssuesRepository.rowLoader** | `callback` | rowsWritten | loadIssue, loadIssues | wiring/code only | **delete** | immutable prepared-query or operation/read-scope definition; request-scoped memo answers only; keep shared compiled code, remove per-workspace wrapper field |
| S0268 `store/issues.ts:1677` **IssuesRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0269 `store/issues.ts:1678` **IssuesRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | renumberCollidingIssueSeqs, assignRepoIdToIssuesUnder, allocateSessionLetter, backfillLegacyWorktreeMachineIds | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0270 `store/issues.ts:1692` **IssuesRepository.issueWrites** | `{ upsert?: (db: WorkspaceDb, shape: string) => IssueRowsWrite shippingStage?: (db: WorkspaceDb) => IssueRowsWrite remove?: (db: WorkspaceDb) => IssueRowsWrite seq?: (db: Workspa…` | constructor/initializer | upsertIssue, transitionShippingStage, deleteIssue, renumberCollidingIssueSeqs, assignRepoIdToIssuesUnder, constructor/callback | no independent truth | **delete** | lazy compiled SQL builders; share immutable definitions, not per-workspace row state |
| S0271 `store/issues.ts:1704` **IssuesRepository.resolveRepoIdForPath** | `( repoPath: string, machineId?: MachineId \| null, ) => string \| Promise<string>` | constructor/initializer | upsertIssue, listIssueRows, renumberCollidingIssueSeqs | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/janitor-reads.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0420 `store/janitor-reads.ts:646` **JanitorReadsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/locks.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0418 `store/locks.ts:300` **LocksRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0419 `store/locks.ts:301` **LocksRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | LocksRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/machine-record-context.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0255 `store/machine-record-context.ts:68` **MachineRecordContextRepository.db** | `StoreDb` | constructor/callback | constructor/callback, read | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0256 `store/machine-record-context.ts:70` **MachineRecordContextRepository.queries** | `WorkspaceQueries` | constructor/initializer | saveFleetChannel, setServerMoveAvailable | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0257 `store/machine-record-context.ts:71` **MachineRecordContextRepository.records** | `MachineRecordWrites` | constructor/initializer | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/machine-record-writes.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0385 `store/machine-record-writes.ts:17` **MachineRecordWrites.compare** | `CompareMachineRecords` | constructor/initializer | MachineRecordWrites consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/machines.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0386 `store/machines.ts:817` **MachinesRepository.recordContext** | `MachineRecordContextRepository` | constructor/callback | MachinesRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0387 `store/machines.ts:818` **MachinesRepository.committed** | `CommittedRows<typeof machines.$inferSelect>` | constructor/callback | constructor/callback, setAvailability, setPresenceSource, rotateCredential | request/tx context | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S0388 `store/machines.ts:820` **MachinesRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0389 `store/machines.ts:821` **MachinesRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | constructor/callback, replaceExecutionAssignment, transferServerAssignment | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0390 `store/machines.ts:825` **MachinesRepository.grantRepository** | `GrantsRepository` | constructor/initializer | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0391 `store/machines.ts:826` **MachinesRepository.machineRecordWrites** | `inferred value/definition` | constructor/initializer | constructor/callback, upsertMachine, recordHarnessVersion, setMachineInventory, setMachineBuild, setSupervisorPresence, setServiceAssignment, adoptLegacyHostCredential, setUpdateChannel, renameMachine, setMachineOwner, enrollMachine, supersedeMachine, revokeMachine, deleteMachine, touchMachine | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/maintenance.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0258 `store/maintenance.ts:120` **MaintenanceRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0259 `store/maintenance.ts:121` **MaintenanceRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | MaintenanceRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/messages.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0205 `store/messages.ts:1531` **MessagesRepository.committed** | `CommittedRows<MessageQueueFact>` | constructor/callback | constructor/callback | request/tx context | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S0206 `store/messages.ts:1538` **MessagesRepository.scope** | `WorkspaceDb` | constructor/callback | db, move | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0207 `store/messages.ts:1539` **MessagesRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | failWith | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0208 `store/messages.ts:1542` **MessagesRepository.feedCapture** | `MessageFeedCapture \| undefined` | setFeedCapture, constructor/callback | constructor/callback, write | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0209 `store/messages.ts:2104` **MessagesRepository.moveWrites** | `Map<string, (db: WorkspaceDb) => MoveWrite>` | write | write | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/messaging-session-attachments.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0236 `store/messaging-session-attachments.ts:152` **MessagingSessionAttachmentsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0237 `store/messaging-session-attachments.ts:153` **MessagingSessionAttachmentsRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | MessagingSessionAttachmentsRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/messaging-topics.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0240 `store/messaging-topics.ts:104` **MessagingTopicsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0241 `store/messaging-topics.ts:105` **MessagingTopicsRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | MessagingTopicsRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/native-logins.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0382 `store/native-logins.ts:165` **NativeLoginsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0383 `store/native-logins.ts:166` **NativeLoginsRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | NativeLoginsRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/notices.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0392 `store/notices.ts:284` **NoticesRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0393 `store/notices.ts:285` **NoticesRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | write, open | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0394 `store/notices.ts:286` **NoticesRepository.feedCapture** | `NoticeFeedCapture \| undefined` | setFeedCapture, constructor/callback | constructor/callback, write | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/notification-facts.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0377 `store/notification-facts.ts:160` **NotificationFactsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0378 `store/notification-facts.ts:161` **NotificationFactsRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | NotificationFactsRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0379 `store/notification-facts.ts:241` **NotificationArbiter.facts** | `NotificationFactsRepository` | constructor/initializer | claim, isClaimed, retire, retireFactKey, retireFactKeyPrefix, retireByIssue, retireExpired | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0380 `store/notification-facts.ts:242` **NotificationArbiter.now** | `() => string` | constructor/initializer | claim, isClaimed, retire, retireFactKey, retireFactKeyPrefix, retireExpired | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0381 `store/notification-facts.ts:243` **NotificationArbiter.defaultTtlMs** | `inferred value/definition` | constructor/initializer | claim | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/observation-checkpoints.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0468 `store/observation-checkpoints.ts:483` **ObservationCheckpointsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0469 `store/observation-checkpoints.ts:484` **ObservationCheckpointsRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | advanceGeneration, rebindExact, confirmTerminalCandidate, renewTerminalCandidate | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/pending-uploads.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0235 `store/pending-uploads.ts:220` **PendingUploadsRepository.db** | `WorkspaceDb` | constructor/callback | insert, get, claimedBy, claim, unclaim, deleteUnclaimed, delete, page, createdBefore | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/quota-history.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0395 `store/quota-history.ts:352` **QuotaHistoryRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0396 `store/quota-history.ts:353` **QuotaHistoryRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | record | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/read-watermarks.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0397 `store/read-watermarks.ts:57` **ReadWatermarksRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0398 `store/read-watermarks.ts:58` **ReadWatermarksRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | ReadWatermarksRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/repos.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0229 `store/repos.ts:239` **ReposRepository.sessionRecordWrite** | `<T>(write: () => Promise<T>) => Promise<T>` | constructor/initializer | addRepo, updateRepoOrigin, removeRepo | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0230 `store/repos.ts:286` **ReposRepository.cached** | `{ rows: RegistryRow[] prefixes: Map<string, string> baseBranches: Map<string, string> } \| null` | invalidateRegistry, registry | registry | answer/decision | **derived** | registry rows/prefix/base-branch copies; Q-repos; local TableWrites invalidation is insufficient across processes |
| S0231 `store/repos.ts:291` **ReposRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0232 `store/repos.ts:292` **ReposRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | nextDraftSeq | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0233 `store/repos.ts:308` **ReposRepository.repoWrites** | `{ insertPrefixIfAbsent?: RepoWrite upsertPrefix?: RepoWrite insertRepoIfAbsent?: RepoWrite renamePath?: RepoWrite deleteRow?: RepoWrite setOrigin?: RepoWrite rekeyPrefix?: RepoW…` | constructor/initializer | ensurePrefixForRepoId, setRepoPrefix, setRepoDefaultParentBranch, addRepoRows, updateRepoOriginRows, carryBaseBranch, removeRepoRows | no independent truth | **delete** | lazy compiled SQL builders; share immutable definitions, not per-workspace row state |
| S0234 `store/repos.ts:323` **ReposRepository.assignRepoIdToIssuesUnder** | `(repoId: RepoId, repoPath: string) => void` | constructor/initializer | updateRepoOriginRows | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/server-secrets.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0373 `store/server-secrets.ts:212` **ServerSecretsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0374 `store/server-secrets.ts:213` **ServerSecretsRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | fingerprintKey, identitySigningSecret | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0375 `store/server-secrets.ts:214` **ServerSecretsRepository.vault** | `Vault \| undefined` | useVault | openSealed, storedForm | wiring/code only | **derived** | workspace secret decryption capability; Q-vault |
| S0376 `store/server-secrets.ts:215` **ServerSecretsRepository.unopenedReported** | `Set<string>` | openSealed | openSealed | diagnostics only | **delete** | diagnostic suppression for unavailable secrets |

### store/sessions.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0436 `store/sessions.ts:1740` **SessionsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0437 `store/sessions.ts:1741` **SessionsRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | SessionsRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0438 `store/sessions.ts:1742` **SessionsRepository.messageWindowWrite** | `SessionMessageWindowWrite \| undefined` | setMessageWindowWrite, constructor/callback | constructor/callback, writeSessionRows | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0439 `store/sessions.ts:1743` **SessionsRepository.snoozeLapseCommit** | `ChangeLogCommit \| undefined` | setSnoozeLapseCommit | listSnoozes | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0440 `store/sessions.ts:1766` **SessionsRepository.purgeObservationCheckpoint** | `( sessionId: SessionId, ) => void \| Promise<void>` | constructor/initializer | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0441 `store/sessions.ts:1908` **SessionsRepository.sessionRows** | `callback` | rowsWritten, constructor/callback | loadSession | wiring/code only | **delete** | immutable prepared-query or operation/read-scope definition; request-scoped memo answers only; keep shared compiled code, remove per-workspace wrapper field |
| S0442 `store/sessions.ts:2237` **SessionsRepository.writtenColumns** | `WrittenColumns<IndexedColumns>` | constructor/callback | getSession, getSessions, constructor/callback, restoreDeletedForIssue, detachTombstonesFromIssue, detachDanglingIssueReferences | single-writer hint | **delete** | single-writer write-hint handle; keep full writes on all hosted paths, no cross-process hint |
| S0443 `store/sessions.ts:2246` **SessionsRepository.padsUpsertRows** | `boolean` | constructor/callback | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/settings-audit.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0249 `store/settings-audit.ts:228` **SettingsAuditRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0250 `store/settings-audit.ts:229` **SettingsAuditRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | SettingsAuditRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/shipping.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0242 `store/shipping.ts:2217` **ShippingRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0243 `store/shipping.ts:2218` **ShippingRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | instance methods/callbacks (field-specific accesses in this source) | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/sign-in-carry-over.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0482 `store/sign-in-carry-over.ts:263` **SignInCarryOverRepository.db** | `WorkspaceDb` | constructor/callback | matches, consume, record, sealedOf, forget, constructor/callback, countHonoured, periodEnd, writePeriodEndIfAbsent | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0483 `store/sign-in-carry-over.ts:264` **SignInCarryOverRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | transaction, endForToken, endForMember, endByLabel, deleteExpired, deleteEverything | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/superagent.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0399 `store/superagent.ts:468` **SuperagentRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0400 `store/superagent.ts:469` **SuperagentRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | writeThreads, promoteQueuedInput | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0401 `store/superagent.ts:470` **SuperagentRepository.threadFeedCapture** | `SuperagentThreadFeedCapture \| undefined` | setThreadFeedCapture, constructor/callback | constructor/callback, writeThreads | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0402 `store/superagent.ts:472` **SuperagentRepository.users** | `UsersRepository` | constructor/callback | seedGlobalThread | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/table-writes.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0251 `store/table-writes.ts:68` **TableWrites.listeners** | `Map<string, (() => void)[]>` | subscribe | subscribe, wrote | local follow-up/order | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |

### store/telegram-bindings.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0444 `store/telegram-bindings.ts:155` **TelegramBindingsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0445 `store/telegram-bindings.ts:156` **TelegramBindingsRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | TelegramBindingsRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/transcript-costs.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0463 `store/transcript-costs.ts:242` **TranscriptCostsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0464 `store/transcript-costs.ts:243` **TranscriptCostsRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | record | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/user-layout.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0457 `store/user-layout.ts:236` **UserLayoutRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0458 `store/user-layout.ts:237` **UserLayoutRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | setMany, clearMany | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0459 `store/user-layout.ts:420` **UserDockShellRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0460 `store/user-layout.ts:421` **UserDockShellRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | UserDockShellRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/user-preferences.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0415 `store/user-preferences.ts:174` **UserPreferencesRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0416 `store/user-preferences.ts:175` **UserPreferencesRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | UserPreferencesRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0417 `store/user-preferences.ts:181` **UserPreferencesRepository.written** | `() => void` | constructor/initializer | set, clear | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/user-read-position.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0221 `store/user-read-position.ts:139` **UserReadPositionRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0222 `store/user-read-position.ts:140` **UserReadPositionRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | advance | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/users.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0210 `store/users.ts:345` **UsersRepository.committed** | `CommittedRows<typeof users.$inferSelect>` | constructor/callback | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0211 `store/users.ts:347` **UsersRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0212 `store/users.ts:348` **UsersRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | applyMemberRow | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0213 `store/users.ts:352` **UsersRepository.machinesRepository** | `MachinesRepository` | constructor/initializer | writeMemberRow, constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0214 `store/users.ts:353` **UsersRepository.grantsRepository** | `GrantsRepository` | constructor/initializer | constructor/callback | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0215 `store/users.ts:355` **UsersRepository.oldSignIns** | `SignInCarryOverRepository` | constructor/initializer | constructor/callback, endOldSignIns | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0216 `store/users.ts:362` **UsersRepository.accessListeners** | `Set<MemberAccessListener>` | onAccessChange, constructor/callback | constructor/callback | request/tx context | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S0217 `store/users.ts:363` **UsersRepository.memberCreated** | `((userId: UserId) => Promise<void>) \| undefined` | setMemberCreated | constructor/callback | request/tx context | **delete** | request/transaction composition, callback delivery or local serialisation; durable effects become jobs and sync publication tails the committed log; no cross-request row copy |
| S0218 `store/users.ts:457` **UsersRepository.accounts** | `callback` | accountsInvalidated | get, earliestAdmin, list | wiring/code only | **delete** | immutable prepared-query or operation/read-scope definition; request-scoped memo answers only; keep shared compiled code, remove per-workspace wrapper field |
| S0219 `store/users.ts:536` **UsersRepository.earliestAdminOfOperation** | `callback` | accountsInvalidated | earliestAdmin | wiring/code only | **delete** | immutable prepared-query or operation/read-scope definition; request-scoped memo answers only; keep shared compiled code, remove per-workspace wrapper field |
| S0220 `store/users.ts:641` **UsersRepository.memberRows** | `MemberRows` | constructor/initializer | UsersRepository consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/workflows.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0203 `store/workflows.ts:881` **WorkflowsRepository.scope** | `WorkspaceDb` | constructor/callback | db | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0204 `store/workflows.ts:882` **WorkflowsRepository.createOrJoinTransaction** | `TransactionRunner` | constructor/callback | insertRevision, insertRun | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### store/workspace-wake-up.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0404 `store/workspace-wake-up.ts:109` **WakeUpHub.subscriptions** | `Map<WorkspaceId, Subscription>` | subscribe, constructor/callback, close | subscribe, constructor/callback, receive, pollOnce | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0405 `store/workspace-wake-up.ts:110` **WakeUpHub.pollIntervalMs** | `number` | constructor/callback | startPolling | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0406 `store/workspace-wake-up.ts:111` **WakeUpHub.pollTimer** | `ReturnType<typeof setInterval> \| undefined` | startPolling, stopPolling | startPolling, stopPolling | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0407 `store/workspace-wake-up.ts:112` **WakeUpHub.polling** | `Promise<void> \| undefined` | constructor/callback, poll | poll | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0408 `store/workspace-wake-up.ts:113` **WakeUpHub.pollAgain** | `boolean` | poll, constructor/callback | constructor/callback | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0409 `store/workspace-wake-up.ts:114` **WakeUpHub.listening** | `boolean` | startListening | startListening | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0410 `store/workspace-wake-up.ts:115` **WakeUpHub.closed** | `boolean` | close | subscribe, publish, constructor/callback, close, pollOnce, startPolling | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0411 `store/workspace-wake-up.ts:117` **WakeUpHub.pending** | `Set<WorkspaceId>` | publish, flush | settled, flush, constructor/callback | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0412 `store/workspace-wake-up.ts:118` **WakeUpHub.flushScheduled** | `boolean` | scheduleFlush, constructor/callback | settled, scheduleFlush | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0413 `store/workspace-wake-up.ts:119` **WakeUpHub.sending** | `Promise<void> \| undefined` | flush, constructor/callback | settled, scheduleFlush | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0414 `store/workspace-wake-up.ts:121` **WakeUpHub.options** | `WakeUpHubOptions` | constructor/initializer | transportKind, publish, close, pollOnce, startListening, flush | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |

### store/written-columns.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0428 `store/written-columns.ts:62` **WrittenColumns.committed** | `Map<string, V>` | forget, forgetAll, commit | get, commit | single-writer hint | **delete** | session upsert write hint; already disabled on Postgres, disable for any second writer; full upsert is the correctness fallback |
| S0429 `store/written-columns.ts:63` **WrittenColumns.staged** | `Map< string, { token: number; value: V; registration: CommitRegistration } >` | constructor/callback, wrote, forget, forgetAll | get, read, wrote, constructor/callback | single-writer hint | **delete** | session upsert write hint; already disabled on Postgres, disable for any second writer; full upsert is the correctness fallback |
| S0430 `store/written-columns.ts:67` **WrittenColumns.nextToken** | `number` | wrote | WrittenColumns consumers | single-writer hint | **delete** | session upsert write hint; already disabled on Postgres, disable for any second writer; full upsert is the correctness fallback |
| S0431 `store/written-columns.ts:68` **WrittenColumns.asideInFlight** | `number` | aside | get, read | single-writer hint | **delete** | session upsert write hint; already disabled on Postgres, disable for any second writer; full upsert is the correctness fallback |
| S0432 `store/written-columns.ts:70` **WrittenColumns.generation** | `number` | wrote, constructor/callback, aside, forget, forgetAll | mark, read | single-writer hint | **delete** | session upsert write hint; already disabled on Postgres, disable for any second writer; full upsert is the correctness fallback |
| S0433 `store/written-columns.ts:73` **WrittenColumns.label** | `string` | constructor/initializer | wrote | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0434 `store/written-columns.ts:74` **WrittenColumns.limit** | `number` | constructor/initializer | wrote, commit | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0435 `store/written-columns.ts:76` **WrittenColumns.enabled** | `boolean` | constructor/initializer | get, read, wrote | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### sync-worker/types.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0185 `sync-worker/types.ts:65` **SyncWorkerError.reason** | `SyncFailureReason` | constructor/initializer | SyncWorkerError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### sync-worker/worker-client.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0168 `sync-worker/worker-client.ts:41` **SyncWorkerClient.worker** | `Worker` | spawn, fail, close | constructor/callback, send, fail, start, close | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0169 `sync-worker/worker-client.ts:42` **SyncWorkerClient.closed** | `boolean` | close | state, spawn, fail, restart, start | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0170 `sync-worker/worker-client.ts:43` **SyncWorkerClient.ready** | `boolean` | constructor/callback, fail, close | state | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0171 `sync-worker/worker-client.ts:44` **SyncWorkerClient.jobs** | `Map<string, Pending>` | end, start | constructor/callback, activeJobCount, end, fail, pull, close | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0172 `sync-worker/worker-client.ts:45` **SyncWorkerClient.completions** | `Map< string, { resolve(result: BootstrapCompletion): void; metrics?: BootstrapMetrics } >` | complete, constructor/callback | constructor/callback, complete, fail, start, close | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0173 `sync-worker/worker-client.ts:49` **SyncWorkerClient.restartTimer** | `ReturnType<typeof setTimeout>` | restart, constructor/callback, close | restart | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0174 `sync-worker/worker-client.ts:50` **SyncWorkerClient.monitorTimer** | `ReturnType<typeof setInterval>` | constructor/callback, close | constructor/callback | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0175 `sync-worker/worker-client.ts:51` **SyncWorkerClient.lastMessage** | `inferred value/definition` | spawn, constructor/callback | constructor/callback | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0176 `sync-worker/worker-client.ts:52` **SyncWorkerClient.lastProgress** | `inferred value/definition` | spawn, constructor/callback | constructor/callback | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0177 `sync-worker/worker-client.ts:53` **SyncWorkerClient.workerProgress** | `number` | spawn, constructor/callback | constructor/callback | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0178 `sync-worker/worker-client.ts:54` **SyncWorkerClient.workerJobs** | `number` | spawn, constructor/callback | constructor/callback | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0179 `sync-worker/worker-client.ts:55` **SyncWorkerClient.spawnedAt** | `inferred value/definition` | spawn | restart | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0180 `sync-worker/worker-client.ts:56` **SyncWorkerClient.fastCrashes** | `number` | restart | restart | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0181 `sync-worker/worker-client.ts:57` **SyncWorkerClient.terminations** | `Set<Promise<unknown>>` | terminate, constructor/callback | close | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0182 `sync-worker/worker-client.ts:58` **SyncWorkerClient.exited** | `WeakSet<Worker>` | constructor/callback | terminate | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0183 `sync-worker/worker-client.ts:59` **SyncWorkerClient.closing** | `Promise<void>` | close | close | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |
| S0184 `sync-worker/worker-client.ts:61` **SyncWorkerClient.options** | `{ dbPath: string /** The effect kinds the server serves, read at each spawn: the worker * builds effect records and holds no executor (POD-6770). */ effectKinds?: () => readonly…` | constructor/initializer | spawn, constructor/callback | connection/order only | **socket** | connection/IPC/log-tail transport state; retain only while a local connection/subscription needs it; close/reconnect clears it; no row truth or dispatch ownership |

### sync/collection-fetch.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0010 `sync/collection-fetch.ts:207` **CollectionAnswer.whole** | `Set<string>` | fresh | fresh, emit, unsent, constructor/callback | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0011 `sync/collection-fetch.ts:208` **CollectionAnswer.stubbed** | `Set<string>` | emit | emit, unsent | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0012 `sync/collection-fetch.ts:210` **CollectionAnswer.walked** | `Set<string>` | comesWith | constructor/callback | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0013 `sync/collection-fetch.ts:212` **CollectionAnswer.marked** | `Set<string>` | comesWith | constructor/callback | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0014 `sync/collection-fetch.ts:214` **CollectionAnswer.ports** | `FetchPorts` | constructor/initializer | instance, args, built, constructor/callback, visible, visibleIds, prepared, page, stubs, comesWith | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### sync/record-source.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0006 `sync/record-source.ts:34` **ForeignCaptureError.name** | `inferred value/definition` | constructor/initializer | ForeignCaptureError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0007 `sync/record-source.ts:36` **ForeignCaptureError.kind** | `string` | constructor/initializer | ForeignCaptureError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0008 `sync/record-source.ts:37` **ForeignCaptureError.capturedWorkspaceId** | `string` | constructor/initializer | ForeignCaptureError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |
| S0009 `sync/record-source.ts:38` **ForeignCaptureError.transactionWorkspaceId** | `string \| undefined` | constructor/initializer | ForeignCaptureError consumers | wiring/code only | **delete** | coverage-only code constant or operation-local helper field; no between-request state to migrate |

### tunnel-health.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0072 `tunnel-health.ts:9` **TunnelHealthStore.latest** | `TunnelHealth \| null` | report | read | live correctness | **room** | current tunnel connectivity diagnostic; live reading, cleared on source disconnect |
| S0073 `tunnel-health.ts:10` **TunnelHealthStore.now** | `() => number` | constructor/initializer | report, read | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### write-contexts.ts

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S0021 `write-contexts.ts:217` **SystemWriteInsideCommand.origin** | `SystemWriteOrigin` | constructor/initializer | SystemWriteInsideCommand consumers | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0022 `write-contexts.ts:228` **WriteContexts.ledger** | `Ledger` | constructor/initializer | sync, system | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |
| S0023 `write-contexts.ts:229` **WriteContexts.mint** | `WriteScopeMint` | constructor/initializer | sync, system | wiring/code only | **delete** | immutable capability/configuration/callback alias; reconstruct at request/job/connection boundary; pointee data is censused separately |

### Mutable module bindings

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1545 `build-version.ts:5` **module.capturedSourceVersion** | `string \| undefined` | captureServerBuildVersion | captureServerBuildVersion, serverBuildVersion | no independent truth | **delete** | captured immutable build provenance; use immutable process build manifest, not workspace state |
| S1546 `build-version.ts:6` **module.capturedSourceDigest** | `string \| undefined` | captureServerBuildVersion | captureServerBuildVersion, serverBuildSourceDigest | no independent truth | **delete** | captured immutable build provenance; use immutable process build manifest, not workspace state |
| S1580 `gateway/daemon-socket.ts:85` **module.daemonConnectionSeq** | `number` | nextDaemonConnectionId | nextDaemonConnectionId | connection/order only | **socket** | per-process connection-id counter; namespace with process nonce/UUID before multiple socket holders; never an operation or fencing token |
| S1579 `gateway/ordered-client-send.ts:73` **module.sharedBudget** | `OrderedSendBudget` | factory initializer/captured callbacks | constructor | connection/order only | **socket** | aggregate local send budget; reservations released on drain/drop/dispose; fairness only, no workspace truth |
| S1578 `gateway/ws-send.ts:160` **module.lastFrameWarnAt** | `Record<'client' \| 'daemon' \| 'machine', number>` | warnDroppedFrame, warnDroppedSecretFrame | warnDroppedFrame, warnDroppedSecretFrame | diagnostics only | **delete** | diagnostic client/daemon/machine malformed-frame warning timestamps; no frame admission decision depends on suppression |
| S1596 `modules/files/queries.ts:27` **module.PATH_INDEX** | `PathIndex` | factory initializer/captured callbacks | callback@104 | wiring/code only | **room** | path-search working-set singleton alias; machine browse direct ask; scoped room/source, not Core authorization |
| S1598 `modules/machines/enrollment.ts:43` **module.transitions** | `WeakMap<EnrollmentHost, Map<MachineId, Promise<void>>>` | withMachineTransition | withMachineTransition | answer/decision | **derived** | machine enrollment transition Promise tails; Q-machines with transaction/generation guard, not process serialisation |
| S1588 `modules/perf/principal.ts:64` **module.digestCache** | `Map<string, string>` | perfPrincipal | perfPrincipal | diagnostics only | **delete** | diagnostic telemetry/probe/hash/log-suppression holder; resetting affects measurements/logging only, not entity or command decisions |
| S1587 `modules/perf/registry.ts:268` **module.perf** | `PerfRegistry` | factory initializer/captured callbacks | registered callbacks/returned port | diagnostics only | **delete** | diagnostic telemetry/probe/hash/log-suppression holder; resetting affects measurements/logging only, not entity or command decisions |
| S1583 `modules/plain-command/commands.ts:60` **module.composed** | `PlainCommandRegistry \| undefined` | plainCommands | plainCommands | no independent truth | **delete** | lazy composed static command registry; freeze definitions as code, handlers take request context |
| S1585 `modules/sessions/residency.ts:11` **module.materializedLog** | `LogRate` | factory initializer/captured callbacks | load, loadMany | diagnostics only | **delete** | diagnostic telemetry/probe/hash/log-suppression holder; resetting affects measurements/logging only, not entity or command decisions |
| S1586 `modules/sessions/session-authz.ts:41` **module.registryMissLog** | `LogRate` | factory initializer/captured callbacks | storedOwnershipRecord | diagnostics only | **delete** | diagnostic telemetry/probe/hash/log-suppression holder; resetting affects measurements/logging only, not entity or command decisions |
| S1584 `modules/sessions/terminal.ts:62` **module.transcriptAliases** | `WeakMap<TranscriptItem, TranscriptAliases>` | callback@144 | aliasesFor | wiring/code only | **delete** | transcript item id/cursor alias union WeakMap; current history merge path held for POD-7329/POD-7333 |
| S1589 `modules/updates/build-attempt.ts:13` **module.attempts** | `AsyncLocalStorage<BuildAttempt>` | run | currentAttempt, buildCleanup | request/tx context | **delete** | async request/transaction/build context container; its values end with the operation; keep no cross-request fact or memo answer |
| S1590 `modules/updates/build-scope.ts:187` **module.scopeProbe** | `boolean \| undefined` | canScopeDevBuild, resetDevBuildScopeProbe | canScopeDevBuild | wiring/code only | **delete** | self-hosted build capability probe memo; re-probe at build boundary, no workspace fact |
| S1591 `modules/updates/operation.ts:1638` **module.preparing** | `Map<string, Promise<unknown>>` | ensure, callback@1798, callback@1805, resetUpdateOperationState | ensure, until | work/claim/retry | **job** | update preparation/cancellation/first-preflight outcome across callbacks; persist in operation/job checkpoint, self-hosted coordinator transfer remains an install operation |
| S1592 `modules/updates/operation.ts:1639` **module.heldCoordinatorUpdates** | `Map<string, PreparedCoordinatorUpdate>` | runCoordinatorReplacement, resetUpdateOperationState | runCoordinatorReplacement, onCancel | work/claim/retry | **job** | update preparation/cancellation/first-preflight outcome across callbacks; persist in operation/job checkpoint, self-hosted coordinator transfer remains an install operation |
| S1593 `modules/updates/operation.ts:1640` **module.coordinatorRuns** | `WeakMap<UpdatesService, Map<string, Promise<StepOutcome>>>` | ensureCoordinatorReplacement, resetUpdateOperationState | ensureCoordinatorReplacement | work/claim/retry | **job** | update preparation/cancellation/first-preflight outcome across callbacks; persist in operation/job checkpoint, self-hosted coordinator transfer remains an install operation |
| S1594 `modules/updates/operation.ts:1641` **module.canceledCoordinatorUpdates** | `Set<string>` | onCancel, resetUpdateOperationState | active | work/claim/retry | **job** | update preparation/cancellation/first-preflight outcome across callbacks; persist in operation/job checkpoint, self-hosted coordinator transfer remains an install operation |
| S1595 `modules/updates/operation.ts:1663` **module.coordinatorPreflightFailures** | `Map<string, StepOutcome>` | preflightFailure, resetUpdateOperationState | ensure, runCoordinatorReplacement | work/claim/retry | **job** | update preparation/cancellation/first-preflight outcome across callbacks; persist in operation/job checkpoint, self-hosted coordinator transfer remains an install operation |
| S1597 `modules/workflows/records.ts:32` **module.operationScope** | `AsyncLocalStorage<true>` | write | committedWorkflowWrite | request/tx context | **delete** | async request/transaction/build context container; its values end with the operation; keep no cross-request fact or memo answer |
| S1547 `plain-command-scope.ts:37` **module.storage** | `AsyncLocalStorage<OpenPlainCommand>` | withPlainCommand | currentPlainCommand, asSystemWrite, asSyncCommand | request/tx context | **delete** | async request/transaction/build context container; its values end with the operation; keep no cross-request fact or memo answer |
| S1549 `response-compression.ts:14` **module.activeJobs** | `number` | compressHttpResponse | compressHttpResponse | connection/order only | **socket** | local compression concurrency admission count for active HTTP responses; released in finally; request/transport work only |
| S1540 `static-web.ts:41` **module.staleWindowStartedAt** | `number` | admitStaleAssetLog | admitStaleAssetLog | no independent truth | **delete** | asset compression/stamp cache or log limiter; build/static-file identity only, drop cache or replace with build artifacts; no workspace versioned cache is approved |
| S1541 `static-web.ts:42` **module.staleInWindow** | `number` | admitStaleAssetLog | admitStaleAssetLog | no independent truth | **delete** | asset compression/stamp cache or log limiter; build/static-file identity only, drop cache or replace with build artifacts; no workspace versioned cache is approved |
| S1542 `static-web.ts:43` **module.staleSuppressed** | `number` | admitStaleAssetLog | admitStaleAssetLog | no independent truth | **delete** | asset compression/stamp cache or log limiter; build/static-file identity only, drop cache or replace with build artifacts; no workspace versioned cache is approved |
| S1543 `static-web.ts:185` **module.compressedCache** | `Map<string, Buffer>` | cacheCompressed | cacheCompressed, serveFile | no independent truth | **delete** | asset compression/stamp cache or log limiter; build/static-file identity only, drop cache or replace with build artifacts; no workspace versioned cache is approved |
| S1544 `static-web.ts:186` **module.compressedCacheBytes** | `number` | cacheCompressed | cacheCompressed | no independent truth | **delete** | asset compression/stamp cache or log limiter; build/static-file identity only, drop cache or replace with build artifacts; no workspace versioned cache is approved |
| S1582 `store-database.ts:74` **module.installed** | `StoreDatabaseOpener \| undefined` | installStoreDatabaseOpener, resetStoreDatabaseOpener | openStoreDatabase, storeDatabaseOpenerInstalled | no independent truth | **delete** | process store-opener installer; move to explicit immutable composition dependency, no mutable workspace fallback |
| S1577 `store/commit-open.ts:12` **module.openCommit** | `AsyncLocalStorage<true>` | inChangeLogCommit | changeLogCommitOpen | request/tx context | **delete** | async request/transaction/build context container; its values end with the operation; keep no cross-request fact or memo answer |
| S1568 `store/executor/context.ts:193` **module.storage** | `AsyncLocalStorage<StoreScope>` | runInScope, runAtRoot | currentScope, currentStoreContext | request/tx context | **delete** | async request/transaction/build context container; its values end with the operation; keep no cross-request fact or memo answer |
| S1569 `store/executor/context.ts:227` **module.rootStatement** | `AsyncLocalStorage<Extract<StoreContext, { kind: 'workspace' }>>` | runRootStatementIn | rootStatementContext | request/tx context | **delete** | async request/transaction/build context container; its values end with the operation; keep no cross-request fact or memo answer |
| S1570 `store/executor/context.ts:296` **module.nextFrameId** | `number` | createFrame | registered callbacks/returned port | diagnostics only | **delete** | process diagnostic/compiled-code memo or async-context slot; contains no workspace row authority; remove cross-request retention, keep immutable definitions or request-local context |
| S1562 `store/executor/lane-intent-audit.ts:19` **module.laneAudit** | `IntentAudit` | factory initializer/captured callbacks | laneIntentAudit, attachLaneIntentAudit, callback@47 | diagnostics only | **delete** | diagnostic telemetry/probe/hash/log-suppression holder; resetting affects measurements/logging only, not entity or command decisions |
| S1563 `store/executor/lane-intent-audit.ts:27` **module.laneAuditHubs** | `WeakSet<StatementProbeHub>` | attachLaneIntentAudit | attachLaneIntentAudit | diagnostics only | **delete** | diagnostic telemetry/probe/hash/log-suppression holder; resetting affects measurements/logging only, not entity or command decisions |
| S1572 `store/executor/operation-scope.ts:69` **module.nextOperationId** | `number` | openOperation | registered callbacks/returned port | diagnostics only | **delete** | process diagnostic/compiled-code memo or async-context slot; contains no workspace row authority; remove cross-request retention, keep immutable definitions or request-local context |
| S1573 `store/executor/operation-scope.ts:70` **module.storage** | `AsyncLocalStorage<OpenOperation>` | withOperation | holdOperation, currentOperation, withOwnOperation | request/tx context | **delete** | async request/transaction/build context container; its values end with the operation; keep no cross-request fact or memo answer |
| S1574 `store/executor/operation-scope.ts:71` **module.observers** | `AsyncLocalStorage<(operation: OperationScope) => void>` | observeOperations | openOperation | request/tx context | **delete** | async request/transaction/build context container; its values end with the operation; keep no cross-request fact or memo answer |
| S1575 `store/executor/operation-scope.ts:72` **module.ending** | `WeakMap<OpenOperation, ReturnType<typeof setTimeout>>` | end | release | diagnostics only | **delete** | process diagnostic/compiled-code memo or async-context slot; contains no workspace row authority; remove cross-request retention, keep immutable definitions or request-local context |
| S1571 `store/executor/pg-driver.ts:204` **module.busyAtAcquisition** | `WeakSet<object>` | markBusy | classify | connection/order only | **socket** | connection-acquisition retry tagging WeakSet; DB connection error lifetime only |
| S1564 `store/executor/read-scope.ts:54` **module.nextScopeId** | `number` | createScope | registered callbacks/returned port | diagnostics only | **delete** | process diagnostic/compiled-code memo or async-context slot; contains no workspace row authority; remove cross-request retention, keep immutable definitions or request-local context |
| S1565 `store/executor/read-scope.ts:79` **module.storage** | `AsyncLocalStorage<ReadScope>` | withReadScope | currentReadScope, withReadScope, inExplicitReadScope | request/tx context | **delete** | async request/transaction/build context container; its values end with the operation; keep no cross-request fact or memo answer |
| S1566 `store/executor/statement-probe.ts:361` **module.hubsByConnection** | `WeakMap<object, StatementProbeHub>` | statementProbeHubFor | statementProbeHubFor | diagnostics only | **delete** | diagnostic telemetry/probe/hash/log-suppression holder; resetting affects measurements/logging only, not entity or command decisions |
| S1567 `store/executor/statement-probe.ts:362` **module.attributionInstalled** | `WeakSet<StatementProbeHub>` | installQueryAttributionProbe | installQueryAttributionProbe | diagnostics only | **delete** | diagnostic telemetry/probe/hash/log-suppression holder; resetting affects measurements/logging only, not entity or command decisions |
| S1558 `store/executor/sync-drizzle.ts:404` **module.transactionsOf** | `WeakMap<GlobalQueries, ExecutorTransaction>` | storeQueriesOver | workspaceQueries | request/tx context | **delete** | query-handle -> transaction/dialect association WeakMap; request/transaction capabilities, not durable rows |
| S1559 `store/executor/sync-drizzle.ts:407` **module.dialectsOf** | `WeakMap<GlobalQueries, StoreDialect>` | storeQueriesOver | workspaceQueries | request/tx context | **delete** | query-handle -> transaction/dialect association WeakMap; request/transaction capabilities, not durable rows |
| S1560 `store/executor/workspace-write-metrics.ts:213` **module.workspaceWriteMetrics** | `WorkspaceWriteMetrics` | factory initializer/captured callbacks | constructor | diagnostics only | **delete** | diagnostic telemetry/probe/hash/log-suppression holder; resetting affects measurements/logging only, not entity or command decisions |
| S1561 `store/executor/workspace-write-metrics.ts:217` **module.admission** | `AsyncLocalStorage<{ queueMs: number }>` | withWorkspaceWriteAdmission | begin | request/tx context | **delete** | async request/transaction/build context container; its values end with the operation; keep no cross-request fact or memo answer |
| S1576 `store/index-hints.ts:28` **module.built** | `WeakMap<Table, unknown>` | bareColumns | bareColumns | no independent truth | **delete** | compiled schema/capture/index metadata memo; source is immutable code; replace mutable memo by code-generation metadata or recomputation, no row cache |
| S1551 `sync-worker/sync-worker.ts:25` **module.port** | `inferred value/definition` | finish, callback@120 | send, module init | connection/order only | **socket** | worker MessagePort transfer queue/credit/heartbeat state; scoped to HTTP bootstrap streams; discard and retry on disconnect |
| S1552 `sync-worker/sync-worker.ts:35` **module.jobs** | `Map<string, Work>` | finish, callback@120 | finish, callback@117, callback@120 | connection/order only | **socket** | worker MessagePort transfer queue/credit/heartbeat state; scoped to HTTP bootstrap streams; discard and retry on disconnect |
| S1553 `sync-worker/sync-worker.ts:36` **module.queue** | `Work[]` | cancel, pump, callback@120 | cancel, pump, callback@120 | connection/order only | **socket** | worker MessagePort transfer queue/credit/heartbeat state; scoped to HTTP bootstrap streams; discard and retry on disconnect |
| S1554 `sync-worker/sync-worker.ts:37` **module.active** | `number` | finish, pump | pump, callback@120 | connection/order only | **socket** | worker MessagePort transfer queue/credit/heartbeat state; scoped to HTTP bootstrap streams; discard and retry on disconnect |
| S1555 `sync-worker/sync-worker.ts:38` **module.stopped** | `boolean` | callback@120 | finish, pump, callback@120 | connection/order only | **socket** | worker MessagePort transfer queue/credit/heartbeat state; scoped to HTTP bootstrap streams; discard and retry on disconnect |
| S1556 `sync-worker/sync-worker.ts:39` **module.progressVersion** | `number` | send | registered callbacks/returned port | connection/order only | **socket** | worker MessagePort transfer queue/credit/heartbeat state; scoped to HTTP bootstrap streams; discard and retry on disconnect |
| S1557 `sync-worker/sync-worker.ts:116` **module.heartbeat** | `callback` | callback@120 | registered callbacks/returned port | connection/order only | **socket** | worker MessagePort transfer queue/credit/heartbeat state; scoped to HTTP bootstrap streams; discard and retry on disconnect |
| S1537 `sync/capture-pg.ts:170` **module.tableCache** | `Map<string, CaptureTable>` | captureTable | captureTable | no independent truth | **delete** | compiled schema/capture/index metadata memo; source is immutable code; replace mutable memo by code-generation metadata or recomputation, no row cache |
| S1538 `sync/capture-pg.ts:207` **module.sourceCache** | `WeakMap<RecordSources, ReadonlyMap<string, readonly CaptureSource[]>>` | sourcesByTable | sourcesByTable | no independent truth | **delete** | compiled schema/capture/index metadata memo; source is immutable code; replace mutable memo by code-generation metadata or recomputation, no row cache |
| S1539 `sync/capture-pg.ts:229` **module.cascadeCache** | `WeakMap<RecordSources, readonly CaptureCascade[]>` | cascadesReachingSources | cascadesReachingSources | no independent truth | **delete** | compiled schema/capture/index metadata memo; source is immutable code; replace mutable memo by code-generation metadata or recomputation, no row cache |
| S1581 `trpc.ts:278` **module.lastSlowWarnAt** | `Map<string, number>` | callback@282 | callback@282 | diagnostics only | **delete** | diagnostic slow-procedure warning rate limiter; no authorization or delivery dependency |
| S1548 `web-bundle-stamp.ts:79` **module.cache** | `Map<string, CacheEntry>` | gradeWebBundle | gradeWebBundle | no independent truth | **delete** | asset compression/stamp cache or log limiter; build/static-file identity only, drop cache or replace with build artifacts; no workspace versioned cache is approved |
| S1550 `write-provenance.ts:34` **module.storage** | `AsyncLocalStorage<OpenProvenance>` | withWriteProvenance | currentWriteProvenance, outsideWriteProvenance | request/tx context | **delete** | async request/transaction/build context container; its values end with the operation; keep no cross-request fact or memo answer |

### Captured factory and composition slots

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1610 `client-relocation.ts:15` **clientRelocations.operations** | `Map<string, Map<string, { id: string; code: string }>>` | prepare, cancel, take | prepare, cancel, take | acceptance/result | **operation** | plaintext per-device transfer claims; self-hosted move operation context; persist encrypted short-lived delivery material or reissue after reconnect |
| S1652 `gateway/client-socket.ts:88` **wireClientSocket.failed** | `boolean` | callback@89 | callback@89 | connection/order only | **socket** | failed/terminated connection latch |
| S1653 `gateway/daemon-socket.ts:172` **wireDaemonSocket.unregisterCredential** | `(() => void) \| undefined` | receiveDaemonMessage | callback@500 | connection/order only | **socket** | daemon credential-registration disposer |
| S1654 `gateway/daemon-socket.ts:173` **wireDaemonSocket.principal** | `MachinePrincipal \| undefined` | receiveDaemonMessage | receiveDaemonMessage, callback@475, callback@500 | connection/order only | **socket** | verified daemon principal for this connection |
| S1655 `gateway/daemon-socket.ts:175` **wireDaemonSocket.acceptedCaps** | `Set<string>` | receiveDaemonMessage, callback@500 | receiveDaemonMessage, sendInput | connection/order only | **socket** | negotiated protocol caps of the connected daemon |
| S1656 `gateway/daemon-socket.ts:176` **wireDaemonSocket.send** | `((msg: ControlMessage) => void) \| undefined` | receiveDaemonMessage | sendInput, receiveDaemonMessage, callback@396, callback@500 | connection/order only | **socket** | daemon control send closure |
| S1657 `gateway/daemon-socket.ts:177` **wireDaemonSocket.failed** | `boolean` | failBinary, receiveDaemonMessage, callback@294, callback@475, callback@487 | failBinary, receiveDaemonMessage, callback@475, callback@487 | connection/order only | **socket** | failed daemon-connection latch |
| S1658 `gateway/daemon-socket.ts:178` **wireDaemonSocket.transport** | `DaemonControlTransport \| undefined` | receiveDaemonMessage | receiveDaemonMessage, callback@500 | connection/order only | **socket** | daemon transport/frame decoder |
| S1659 `gateway/daemon-socket.ts:202` **wireDaemonSocket.acceptor** | `HandshakeAcceptor \| undefined` | receiveDaemonMessage | receiveDaemonMessage | connection/order only | **socket** | handshake acceptor; no workspace service graph |
| S1660 `gateway/daemon-socket.ts:203` **wireDaemonSocket.pendingPreAuthFrames** | `number` | callback@475, callback@495 | callback@475 | connection/order only | **socket** | preauthentication frame count bound |
| S1661 `gateway/daemon-socket.ts:204` **wireDaemonSocket.preAuthSerial** | `inferred value/definition` | callback@475 | callback@475 | connection/order only | **socket** | serialized preauthentication frame tail |
| S1662 `gateway/daemon-socket.ts:516` **wireMachineSocket.unregisterCredential** | `(() => void) \| undefined` | receiveMachineMessage | callback@712 | connection/order only | **socket** | supervisor credential-registration disposer |
| S1663 `gateway/daemon-socket.ts:517` **wireMachineSocket.principal** | `MachinePrincipal \| undefined` | receiveMachineMessage | receiveMachineMessage, callback@680, callback@712 | connection/order only | **socket** | verified supervisor principal |
| S1664 `gateway/daemon-socket.ts:518` **wireMachineSocket.send** | `((message: MachineSupervisorControlMessage) => void) \| undefined` | receiveMachineMessage | receiveMachineMessage, callback@712 | connection/order only | **socket** | supervisor send closure; permanent legacy update exception |
| S1665 `gateway/daemon-socket.ts:525` **wireMachineSocket.resolved** | `HandshakeAcceptor \| undefined` | receiveMachineMessage | receiveMachineMessage | connection/order only | **socket** | supervisor handshake acceptor |
| S1666 `gateway/daemon-socket.ts:531` **wireMachineSocket.attached** | `Promise<void>` | receiveMachineMessage | receiveMachineMessage | connection/order only | **socket** | supervisor attachment promise |
| S1667 `gateway/daemon-socket.ts:546` **wireMachineSocket.failed** | `boolean` | receiveMachineMessage, callback@595, callback@680, callback@699 | receiveMachineMessage, callback@680, callback@699 | connection/order only | **socket** | failed supervisor-connection latch |
| S1668 `gateway/daemon-socket.ts:547` **wireMachineSocket.pendingPreAuthFrames** | `number` | callback@680, callback@707 | callback@680 | connection/order only | **socket** | supervisor preauthentication frame count |
| S1669 `gateway/daemon-socket.ts:548` **wireMachineSocket.preAuthSerial** | `inferred value/definition` | callback@680 | callback@680 | connection/order only | **socket** | supervisor preauthentication frame tail |
| S1646 `gateway/ws-server.ts:343` **attachWebSockets.clients** | `Set<NativeGatewaySocket>` | open, close | attachWebSockets, close | connection/order only | **socket** | open client sockets; delete on close |
| S1647 `gateway/ws-server.ts:344` **attachWebSockets.daemons** | `Set<NativeGatewaySocket>` | open, close | attachWebSockets, close | connection/order only | **socket** | open daemon/supervisor sockets; delete on close |
| S1648 `gateway/ws-server.ts:345` **attachWebSockets.aliveClients** | `WeakSet<HeartbeatSocket>` | open, pong | attachWebSockets | connection/order only | **socket** | client heartbeat liveness WeakSet; connection lifetime |
| S1649 `gateway/ws-server.ts:346` **attachWebSockets.aliveDaemons** | `WeakSet<HeartbeatSocket>` | open, pong | attachWebSockets | connection/order only | **socket** | daemon heartbeat liveness WeakSet; connection lifetime |
| S1650 `gateway/ws-server.ts:347` **attachWebSockets.principalValidity** | `Map< NativeGatewaySocket, { maintain: () => Promise<boolean> refreshedAt: number pending: boolean valid: boolean } >` | open, close | maintainClientPrincipals, callback@371, callback@377 | connection/order only | **socket** | per-socket credential revalidation state; refresh/close on rights change, expire by time |
| S1651 `gateway/ws-server.ts:356` **attachWebSockets.clientsByCredential** | `Map<string, Set<NativeGatewaySocket>>` | open, close, revokeClientCredential | open, close, revokeClientCredential | connection/order only | **socket** | credential -> connected clients index; delete on close/revocation |
| S1611 `identity/member-of-request.ts:228` **createMemberOfRequest.resolved** | `WeakMap<Request, Promise<MemberResolution>>` | memberOfRequest | memberOfRequest | no independent truth | **delete** | WeakMap of Request -> member-resolution promises; request-only memo, no cross-request answer |
| S1608 `locate-proof-route.ts:65` **registerLocateProofRoute.windows** | `Map<string, { startedAt: number; count: number }>` | overLimit | overLimit | answer/decision | **derived** | public locate request-rate windows; Q-rate (new shared bucket) |
| S1704 `modules/files/file-jobs.ts:29` **fileStorageJobs.running** | `Set<FileStorageJobName>` | run | run | work/claim/retry | **job** | currently running storage sweeps; shared job leases replace process-only exclusion |
| S1697 `modules/fleet/sync-write.ts:118` **registerFleetCommands.repoAdds** | `WeakMap<object, ReadonlyMap<string, PromiseSettledResult<PreparedRepoAdd>>>` | target | handle | no independent truth | **delete** | one-write preparation memo keyed by command object; request-local, no cross-request answer |
| S1718 `modules/machines/records.ts:258` **makeMachineRecordCompare.open** | `AsyncLocalStorage<{ open: boolean }>` | write | callback@259 | request/tx context | **delete** | machine-record write async scope; transaction-only context |
| S1696 `modules/server-transfer/rpc-adapter.ts:79` **serverTransferRpcAdapter.pathsByTransfer** | `Map<string, string[]>` | serverTransferPrepare, serverTransferAbort | serverTransferChunk | acceptance/result | **operation** | paths retained per self-hosted transfer; persist manifest in operation context |
| S1694 `modules/sessions/session-interrupt-effect.ts:107` **registerSessionInterruptEffect.requests** | `Map<string, InterruptOutcome>` | remember | remember, requested | acceptance/result | **operation** | interrupt request outcomes; operation status/result row |
| S1695 `modules/sessions/session-interrupt-effect.ts:108` **registerSessionInterruptEffect.waiters** | `Map<string, Set<(outcome: InterruptOutcome) => void>>` | remember, callback@121 | remember, callback@121 | acceptance/result | **operation** | interrupt wait callbacks; bounded wait on result row without transaction |
| S1693 `modules/sessions/session-launch-effect.ts:198` **registerSessionLaunchEffect.errors** | `Map<string, unknown>` | remember | remember, errorOf | answer/decision | **derived** | effect error answers currently remembered by id; Q-effect; persist structured failure detail if absent |
| S1706 `modules/sessions/session-wiring.ts:282` **wireSessionLifecycle.runtimeEventGate** | `RuntimeEventGate \| undefined` | wireSessionLifecycle | recordSessionGitActivity, wireSessionLifecycle | wiring/code only | **delete** | late-bound runtime-event gate alias in session graph; request/fact transaction ports |
| S1705 `modules/updates/dev-bundle.ts:2162` **createDevBundlePublisher.recoveredPublishedArtifacts** | `Map<string, DevBundleArtifact>` | publishedArtifact | publishedArtifact | answer/decision | **derived** | recovered published artifact descriptors; Q-build (self-hosted install records) |
| S1700 `modules/updates/target-refresh.ts:133` **startTargetRefresh.failures** | `Map<UpdateChannel, number>` | delayFor | delayFor | work/claim/retry | **job** | channel refresh retry failure counters; job attempts |
| S1701 `modules/updates/target-refresh.ts:134` **startTargetRefresh.due** | `Map<UpdateChannel, number>` | startTargetRefresh, tick | tick, armNext | work/claim/retry | **job** | next channel refresh times; job due time |
| S1702 `modules/updates/target-refresh.ts:157` **startTargetRefresh.cancel** | `(() => void) \| undefined` | arm, stop | stop | work/claim/retry | **job** | target-refresh timer disposer; due job replaces it |
| S1703 `modules/updates/target-refresh.ts:158` **startTargetRefresh.stopped** | `boolean` | stop | arm, tick | work/claim/retry | **job** | target-refresh stop flag; worker lifecycle |
| S1698 `modules/updates/update-effect.ts:65` **registerUpdateEffect.bound** | `UpdateStartPorts \| undefined` | bindPorts | portsFor | no independent truth | **delete** | late-bound operation start port; install callback, no authoritative state |
| S1699 `modules/updates/update-effect.ts:67` **registerUpdateEffect.handed** | `Map<string, UpdateStartPorts>` | prepare, handPorts, callback@112 | portsFor | work/claim/retry | **job** | operation-id -> handed update start ports; recover from operation/job rows |
| S1609 `origin-refusal.ts:25` **originRefusalReporter.said** | `Set<string>` | callback@26 | callback@26 | diagnostics only | **delete** | diagnostic once-per-origin set; use bounded external logging rather than authorization state |
| S1604 `relay.ts:934` **<callback>.trustedNetworks** | `inferred value/definition` | registry constructor; settings.changed listener | DaemonLinks.kindOf/settingsChanged and credential-send checks | answer/decision | **derived** | trusted-network settings captured by the daemon-link callback; Q-settings (POD-7484) |
| S1600 `relay.ts:974` **<callback>.mutations** | `MutationLedger` | registry constructs; MutationLedger.apply mutates inFlight | sync/session/issue command envelopes and MCP/relay callers | wiring/code only | **derived** | mutation-ledger capability; Q-mutation durable replay receipts, not a dedupe cache |
| S1605 `relay.ts:982` **<callback>.liveSessions** | `Map<SessionId, Session>` | SessionRepository.registerSession/forget; session wiring | SessionResidency, lifecycle, terminal and command paths | answer/decision | **derived** | resident session objects; Q-session; terminal members are separate room rows below |
| S1599 `relay.ts:1460` **<callback>.subscriptions** | `SubscriptionRegistry` | factory initializer/captured callbacks | registered callbacks/returned port | live correctness | **room** | subscription registry shared by feed/live planes today; split live rooms from socket feed scopes; no durable authority |
| S1602 `relay.ts:2355` **<callback>.closedIssueIdsSlot** | `callback` | factory initializer/captured callbacks | closedIssueIdsInScope | no independent truth | **delete** | closed-issue readScopeSlot definition; answers die with read scope |
| S1603 `relay.ts:2369` **<callback>.folderOwnersSlot** | `callback` | factory initializer/captured callbacks | folderOwnersInScope | no independent truth | **delete** | folder-owner readScopeSlot definition; answers die with read scope |
| S1601 `relay.ts:4343` **<callback>.shippingWorkerIncarnation** | `inferred value/definition` | factory initializer/captured callbacks | shippingLockKey, shippingLockCaller | no independent truth | **delete** | per-process shipping worker incarnation; never use it as durable lease fencing |
| S1606 `relay.ts:4344` **<callback>.shippingLocks** | `Map<string, Set<string>>` | shipping resource acquire/release callbacks | shipping resource holder/release callbacks | answer/decision | **derived** | shipping resource -> session ownership sets; Q-shipping |
| S1613 `server.ts:480` **registerVersionRoute.servedIdentity** | `string \| undefined` | noteServed | noteServed | no independent truth | **delete** | last served version identity used only to suppress repeated logging |
| S1614 `server.ts:784` **startServer.lakeConversionWork** | `Promise<unknown> \| undefined` | callback@2752 | drainStore | work/claim/retry | **job** | legacy lake conversion work handle; migration job receipt (self-hosted; transcript changes held) |
| S1615 `server.ts:800` **startServer.openedIdentity** | `ServerIdentity \| undefined` | startServer | serverIdentity | wiring/code only | **delete** | install identity capability; use install composition, never a workspace graph |
| S1616 `server.ts:854` **startServer.devChannelFeed** | `(() => ChannelFeed \| undefined) \| undefined` | startServer | devChannelFeed | no independent truth | **delete** | development channel reader closure; immutable install callback |
| S1617 `server.ts:966` **startServer.signInCarryOver** | `SignInCarryOver \| undefined` | startServer | callback@969, startServer, callback@2752 | answer/decision | **derived** | sign-in carry-over view; Q-signin |
| S1618 `server.ts:967` **startServer.stopIdentitySweep** | `callback` | startServer | close | work/claim/retry | **job** | identity-expiry interval disposer; shared expiry job |
| S1619 `server.ts:1004` **startServer.maintenanceToken** | `inferred value/definition` | rotateMaintenanceToken | rotateMaintenanceToken, authenticateToken, maintenanceToken | no independent truth | **delete** | per-boot maintenance bearer; delete localhost maintenance route in favour of jobs |
| S1620 `server.ts:1076` **startServer.telemetryMachineCount** | `inferred value/definition` | callback@1080 | machineCount | answer/decision | **derived** | machine count used by telemetry; Q-machines |
| S1621 `server.ts:1147` **startServer.boundPort** | `inferred value/definition` | listen | port, localArtifactOrigin, callback@2330 | connection/order only | **socket** | bound listener port; process listener lifetime |
| S1622 `server.ts:1164` **startServer.pendingCoordinatorVersion** | `string \| undefined` | onInstalled | pendingVersion | answer/decision | **derived** | pending coordinator version; Q-update |
| S1623 `server.ts:1479` **startServer.serverMoveDataPlaneDeferred** | `inferred value/definition` | settle | claimedPublicUrl, settle, readiness, callback@1650, callback@1655, fetch | work/claim/retry | **job** | deferred move promotion marker; derive due work from persisted journal on self-hosted |
| S1624 `server.ts:1500` **startServer.stopDeferredPromotionPoll** | `callback` | startServer | settle, failListen, close | work/claim/retry | **job** | deferred promotion timer disposer; self-hosted migration job |
| S1625 `server.ts:1502` **startServer.settling** | `boolean` | settle | settle | work/claim/retry | **job** | promotion poll running latch; use job lease |
| S1626 `server.ts:1543` **startServer.startDeferredSourceMovePoll** | `callback` | startServer | listen | work/claim/retry | **job** | source move poll starter; self-hosted job registration |
| S1627 `server.ts:1544` **startServer.stopDeferredSourceMovePoll** | `callback` | startServer | settle, failListen, close | work/claim/retry | **job** | source move poll disposer; self-hosted job lifecycle |
| S1628 `server.ts:1546` **startServer.poll** | `ReturnType<typeof setInterval> \| undefined` | callback@1580, callback@1588 | callback@1580, callback@1588 | work/claim/retry | **job** | source move poll interval handle; due job row |
| S1629 `server.ts:1547` **startServer.settling** | `boolean` | settle | settle | work/claim/retry | **job** | source move poll running latch; use job lease |
| S1630 `server.ts:1548` **startServer.stopped** | `boolean` | callback@1588 | settle, callback@1580 | work/claim/retry | **job** | source move poll stop flag; job cancellation state |
| S1631 `server.ts:1614` **startServer.requestPeerAddresses** | `WeakMap<Request, string>` | fetch | observedRequest, clientAddress, daemonLink | connection/order only | **socket** | native peer-address associations keyed by Request; request/socket lifetime only |
| S1632 `server.ts:1644` **startServer.targetsResolvedOnBoot** | `inferred value/definition` | callback@2752 | callback@1650 | work/claim/retry | **job** | update-target boot-resolution latch; idempotent target-refresh job |
| S1633 `server.ts:1693` **startServer.janitorHost** | `Awaited<ReturnType<typeof import('./janitor-host').startJanitorHost>> \| undefined` | callback@2330, callback@2944 | janitor, callback@2944 | work/claim/retry | **job** | per-process janitor host; replace with fleet job runner |
| S1634 `server.ts:1694` **startServer.syncWorker** | `SyncWorkerClient \| undefined` | callback@2330, callback@2944 | worker, syncWorker | connection/order only | **socket** | sync-worker IPC handle; HTTP transfer only, no entity authority |
| S1635 `server.ts:1695` **startServer.janitorHostClosing** | `boolean` | callback@2944 | callback@2330 | work/claim/retry | **job** | janitor shutdown latch; runner lifecycle, no per-workspace work ownership |
| S1636 `server.ts:1696` **startServer.janitorHostStarting** | `Promise<void> \| undefined` | listen | listen, callback@2944 | work/claim/retry | **job** | janitor startup promise; jobs need no host graph |
| S1637 `server.ts:1702` **startServer.allowedOrigins** | `ReadonlySet<string>` | factory initializer/captured callbacks | cors, originAllowed | no independent truth | **delete** | boot-resolved allowed-origin configuration; trusted routing/installation policy, not a mutable workspace copy |
| S1638 `server.ts:1847` **startServer.loopAccounting** | `LoopAccountingHandle \| undefined` | listen | createContext, onKeepClearCost, requestProfile, callback@2440, listen, callback@2752, callback@2959 | diagnostics only | **delete** | self-hosted loop-accounting diagnostic handle |
| S1639 `server.ts:1848` **startServer.dropLoopAccounting** | `(() => void) \| undefined` | listen, callback@2959 | callback@2959 | diagnostics only | **delete** | loop-accounting diagnostic disposer |
| S1640 `server.ts:1870` **startServer.revokeConnectedDeviceSignIn** | `(credentialId: string) => void` | listen | onDeviceSignInEnded, callback@2752 | connection/order only | **socket** | connected-device revocation callback; invalidate only affected socket subscriptions |
| S1612 `server.ts:1993` **startServer.mcpToken** | `inferred value/definition` | factory initializer/captured callbacks | startServer, listen | answer/decision | **derived** | per-boot MCP route bearer; Q-mcp (scoped revocable credential replaces random process token) |
| S1641 `server.ts:2210` **listen.settled** | `boolean` | failListen, listen | failListen | connection/order only | **socket** | server-start promise settlement latch; listener lifetime |
| S1642 `server.ts:2212` **listen.loopMinuteSink** | `LoopMinuteFileSink \| undefined` | listen, callback@2959 | registered callbacks/returned port | diagnostics only | **delete** | local loop-minute diagnostic file sink |
| S1643 `server.ts:2213` **listen.loopProfileCapture** | `LoopProfileCapture \| undefined` | listen | callback@2959 | diagnostics only | **delete** | local loop-profile diagnostic capture |
| S1644 `server.ts:2273` **listen.acceptingRequests** | `boolean` | closeWebSockets | fetch | connection/order only | **socket** | listener admission/drain flag; server lifetime |
| S1645 `server.ts:2274` **listen.server** | `Pick<NativeServer<never>, 'port' \| 'stop'>` | listen | listen, memberRecovery, callback@2752 | connection/order only | **socket** | native HTTP/WebSocket server handle |
| S1687 `store/executor/bun-driver.ts:73` **createBunSqliteDriver.readers** | `SqlDatabase[]` | openReader, callback@110, close | callback@110 | connection/order only | **socket** | detached SQLite reader connections; remove on connection close |
| S1689 `store/executor/bun-driver.ts:83` **createBunSqliteDriver.caches** | `Map<SqlDatabase, Map<string, SqlStatement>>` | cacheFor, callback@110, close | cacheFor | connection/order only | **socket** | SQLite connection -> compiled statement map; cleared on driver close, immutable SQL only |
| S1688 `store/executor/bun-driver.ts:91` **createBunSqliteDriver.closed** | `boolean` | close | open, openReader, close | connection/order only | **socket** | SQLite driver closed flag |
| S1670 `store/executor/executor.ts:410` **createStoreExecutor.reportedRefusals** | `WeakSet<StoreExecutorError>` | reportRefusal | reportRefusal | diagnostics only | **delete** | diagnostic refusal-report WeakSet; no result authority |
| S1671 `store/executor/executor.ts:446` **createStoreExecutor.runners** | `Set<PostCommitRunner>` | retire, newRunner | diagnostics, effectsSettled, settled, callback@1259 | work/claim/retry | **job** | post-commit runners whose durable follow-ups must become jobs |
| S1672 `store/executor/executor.ts:659` **createStoreExecutor.boundExecutors** | `WeakMap<TransactionFrame, StoreExecutor<TClient>>` | executorForFrame | executorForFrame | wiring/code only | **delete** | transaction-frame -> bound-executor WeakMap; transaction-local capability only |
| S1690 `store/executor/operation-loader.ts:113` **operationLoader.version** | `number` | invalidate | fresh, current, loadOne, loadMany, version, prime | request/tx context | **delete** | loader invalidation version; request/transaction memo only |
| S1691 `store/executor/operation-loader.ts:157` **operationLoader.spans** | `WeakMap<object, Memo>` | memoOn | memoOn | request/tx context | **delete** | span -> memo WeakMap; request/transaction scope only |
| S1692 `store/executor/operation-loader.ts:158` **operationLoader.written** | `WeakSet<TransactionUnit>` | invalidate | context | request/tx context | **delete** | write-unit invalidation WeakSet; request/transaction scope only |
| S1707 `store/executor/pg-driver.ts:331` **createSession.closed** | `boolean` | close | live, close | connection/order only | **socket** | pooled session closed flag |
| S1708 `store/executor/pg-driver.ts:332` **createSession.state** | `TransactionState` | takePendingBegin, begin, commit, rollback, close | takePendingBegin, execute, executeBatch, begin, commit, rollback, close | connection/order only | **socket** | transaction state for a reserved DB connection; reset on commit/rollback/release |
| S1709 `store/executor/pg-driver.ts:333` **createSession.nextBatchBoundary** | `number` | executeBatch | registered callbacks/returned port | connection/order only | **socket** | batch boundary id for connection protocol ordering |
| S1710 `store/executor/pg-driver.ts:607` **createPgStoreDriver.sql** | `callback` | factory initializer/captured callbacks | reserve, close | connection/order only | **socket** | Postgres connection pool; one per process; no workspace authority |
| S1711 `store/executor/pg-driver.ts:621` **createPgStoreDriver.closed** | `boolean` | close | reserve, close | connection/order only | **socket** | Postgres driver close flag |
| S1673 `store/executor/scheduler.ts:418` **createScheduler.pending** | `Waiter[]` | pump, callback@520 | pump, mayBypassQueue, settled | connection/order only | **socket** | process database admission queue of waiters; no cross-process workspace ownership |
| S1683 `store/executor/scheduler.ts:419` **createScheduler.idleListeners** | `Set<() => void>` | done, callback@751, onIdle, callback@761 | pump | connection/order only | **socket** | database scheduler idle listeners tied to process connections |
| S1684 `store/executor/scheduler.ts:421` **createScheduler.heldSlots** | `Set<string>` | take, give | canStart | connection/order only | **socket** | database scheduler occupied read-slot ids; connection admission only |
| S1674 `store/executor/scheduler.ts:422` **createScheduler.exclusiveSlotHeld** | `boolean` | take, give | canStart | connection/order only | **socket** | exclusive connection-slot occupancy flag |
| S1675 `store/executor/scheduler.ts:424` **createScheduler.pendingExclusive** | `number` | pump, admit | mayBypassQueue | connection/order only | **socket** | pending exclusive connection requests count |
| S1676 `store/executor/scheduler.ts:425` **createScheduler.readsInFlight** | `number` | take, give | canStart | connection/order only | **socket** | active DB read leases count |
| S1677 `store/executor/scheduler.ts:426` **createScheduler.inFlight** | `number` | take, give, detachedRead | canStart, pump, settled | connection/order only | **socket** | active connection leases count |
| S1678 `store/executor/scheduler.ts:427` **createScheduler.state** | `SchedulerState` | runLease, close, callback@777 | runLease, acquireAndRun, state, detachedRead | connection/order only | **socket** | database scheduler open/draining state |
| S1685 `store/executor/scheduler.ts:428` **createScheduler.drainers** | `Set<() => void>` | acquireAndRun, detachedRead | close | connection/order only | **socket** | database scheduler drain listeners; connection shutdown only |
| S1686 `store/executor/scheduler.ts:429` **createScheduler.shutdownScope** | `AsyncLocalStorage<{ active: boolean }>` | retain, callback@777 | runLease | request/tx context | **delete** | shutdown async context; no cross-request fact |
| S1679 `store/executor/scheduler.ts:430` **createScheduler.persistenceSettled** | `boolean` | close, callback@777 | pump, runLease | connection/order only | **socket** | local persistence drain settled flag |
| S1680 `store/executor/scheduler.ts:431` **createScheduler.nextLeaseId** | `number` | acquireAndRun | registered callbacks/returned port | connection/order only | **socket** | connection lease-id sequence; process diagnostic id only |
| S1681 `store/executor/scheduler.ts:432` **createScheduler.closing** | `Promise<void> \| undefined` | close | close | connection/order only | **socket** | driver close promise |
| S1682 `store/executor/scheduler.ts:433` **createScheduler.finishClose** | `(() => void) \| undefined` | callback@768, callback@769 | pump | connection/order only | **socket** | driver-close completion callback |
| S1712 `store/workspace-wake-up-pg.ts:76` **pgWakeUpTransport.closed** | `boolean` | close | listen, subscribe, scheduleRelisten, onclose, send, close | connection/order only | **socket** | wake-up driver close flag |
| S1713 `store/workspace-wake-up-pg.ts:77` **pgWakeUpTransport.listener** | `postgres.Sql \| undefined` | listen | listen, subscribe, close | connection/order only | **socket** | dedicated LISTEN connection |
| S1714 `store/workspace-wake-up-pg.ts:78` **pgWakeUpTransport.notifier** | `postgres.Sql \| undefined` | openNotifier | close | connection/order only | **socket** | post-commit batched notifier connection |
| S1715 `store/workspace-wake-up-pg.ts:79` **pgWakeUpTransport.reconnectTimer** | `ReturnType<typeof setTimeout> \| undefined` | scheduleRelisten, callback@113, close | scheduleRelisten, close | connection/order only | **socket** | listener reconnect timer |
| S1716 `store/workspace-wake-up-pg.ts:80` **pgWakeUpTransport.listening** | `Promise<void> \| undefined` | callback@113, listen | close | connection/order only | **socket** | listener subscribe promise |
| S1717 `store/workspace-wake-up-pg.ts:96` **listen.delay** | `inferred value/definition` | subscribe, scheduleRelisten | subscribe, scheduleRelisten | connection/order only | **socket** | reconnect backoff; reset on subscribe; polling repairs lost signals |
| S1607 `sync/routes.ts:77` **registerSyncRoutes.bootstraps** | `Map<string, { abort: AbortController; transferId: string }>` | callback@78, release | callback@78, release | connection/order only | **socket** | HTTP bootstrap abort handles and transfer ids; cleared on finish, abort or supersede |

### Connection and external-state object fields

| Id / source / field | Holds (type or shape) | Writers | Readers | Dependency today | Verdict | Destination / prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| S1719 `gateway/client-registry.ts:48` **ClientConn.id** | `string` | ClientMux attach/hello/frame handlers; detach clears connection | client/daemon mux transport and feed-serving edge | wiring/code only | **socket** | connection identity, negotiated capability or transport handle; cleared on close; scopes replaced on refresh |
| S1720 `gateway/client-registry.ts:54` **ClientConn.principal** | `ClientPrincipal` | ClientMux attach/hello/frame handlers; detach clears connection | client/daemon mux transport and feed-serving edge | wiring/code only | **socket** | connection identity, negotiated capability or transport handle; cleared on close; scopes replaced on refresh |
| S1721 `gateway/client-registry.ts:61` **ClientConn.workspaceId** | `WorkspaceId` | ClientMux attach/hello/frame handlers; detach clears connection | client/daemon mux transport and feed-serving edge | wiring/code only | **socket** | connection identity, negotiated capability or transport handle; cleared on close; scopes replaced on refresh |
| S1722 `gateway/client-registry.ts:63` **ClientConn.terminate** | `() => void` | ClientMux attach/hello/frame handlers; detach clears connection | client/daemon mux transport and feed-serving edge | wiring/code only | **socket** | connection identity, negotiated capability or transport handle; cleared on close; scopes replaced on refresh |
| S1723 `gateway/client-registry.ts:68` **ClientConn.endSignIn** | `(close: { code: number; reason: string }) => void` | ClientMux attach/hello/frame handlers; detach clears connection | client/daemon mux transport and feed-serving edge | wiring/code only | **socket** | connection identity, negotiated capability or transport handle; cleared on close; scopes replaced on refresh |
| S1724 `gateway/client-registry.ts:69` **ClientConn.send** | `Send<ServerMessage>` | ClientMux attach/hello/frame handlers; detach clears connection | client/daemon mux transport and feed-serving edge | wiring/code only | **socket** | connection identity, negotiated capability or transport handle; cleared on close; scopes replaced on refresh |
| S1725 `gateway/client-registry.ts:74` **ClientConn.sendStream** | `(message: ServerMessage, onDrop?: () => void) => boolean` | ClientMux attach/hello/frame handlers; detach clears connection | client/daemon mux transport and feed-serving edge | wiring/code only | **socket** | connection identity, negotiated capability or transport handle; cleared on close; scopes replaced on refresh |
| S1726 `gateway/client-registry.ts:76` **ClientConn.sendBinary** | `(bytes: Uint8Array) => void` | ClientMux attach/hello/frame handlers; detach clears connection | client/daemon mux transport and feed-serving edge | wiring/code only | **socket** | connection identity, negotiated capability or transport handle; cleared on close; scopes replaced on refresh |
| S1727 `gateway/client-registry.ts:78` **ClientConn.sendBinaryStream** | `(bytes: Uint8Array, onDrop?: () => void) => boolean` | ClientMux attach/hello/frame handlers; detach clears connection | client/daemon mux transport and feed-serving edge | wiring/code only | **socket** | connection identity, negotiated capability or transport handle; cleared on close; scopes replaced on refresh |
| S1728 `gateway/client-registry.ts:80` **ClientConn.sendSequence** | `(source: SendSequenceSource<ServerMessage>) => Promise<SendOutcome>` | ClientMux attach/hello/frame handlers; detach clears connection | client/daemon mux transport and feed-serving edge | wiring/code only | **socket** | connection identity, negotiated capability or transport handle; cleared on close; scopes replaced on refresh |
| S1729 `gateway/client-registry.ts:85` **ClientConn.viewports** | `Map<string, Geometry>` | ClientMux attach/hello/frame handlers; detach clears connection | terminal/presence/topic selection and SessionStateService | live correctness | **room** | viewer attachment/viewport/presence state; room grant scope, cleared on disconnect |
| S1730 `gateway/client-registry.ts:86` **ClientConn.attached** | `Set<SessionId>` | ClientMux attach/hello/frame handlers; detach clears connection | terminal/presence/topic selection and SessionStateService | live correctness | **room** | viewer attachment/viewport/presence state; room grant scope, cleared on disconnect |
| S1731 `gateway/client-registry.ts:90` **ClientConn.caps** | `Set<string>` | ClientMux attach/hello/frame handlers; detach clears connection | client/daemon mux transport and feed-serving edge | wiring/code only | **socket** | connection identity, negotiated capability or transport handle; cleared on close; scopes replaced on refresh |
| S1732 `gateway/client-registry.ts:99` **ClientConn.wireVersion** | `number` | ClientMux attach/hello/frame handlers; detach clears connection | client/daemon mux transport and feed-serving edge | wiring/code only | **socket** | connection identity, negotiated capability or transport handle; cleared on close; scopes replaced on refresh |
| S1733 `gateway/client-registry.ts:109` **ClientConn.entityServingRefused** | `boolean` | ClientMux attach/hello/frame handlers; detach clears connection | client/daemon mux transport and feed-serving edge | wiring/code only | **socket** | connection identity, negotiated capability or transport handle; cleared on close; scopes replaced on refresh |
| S1734 `gateway/client-registry.ts:113` **ClientConn.transcriptSubs** | `Set<SessionId>` | ClientMux attach/hello/frame handlers; detach clears connection | terminal/presence/topic selection and SessionStateService | live correctness | **room** | viewer attachment/viewport/presence state; room grant scope, cleared on disconnect |
| S1735 `gateway/client-registry.ts:115` **ClientConn.visible** | `boolean` | ClientMux attach/hello/frame handlers; detach clears connection | terminal/presence/topic selection and SessionStateService | live correctness | **room** | viewer attachment/viewport/presence state; room grant scope, cleared on disconnect |
| S1736 `gateway/client-registry.ts:117` **ClientConn.viewVisible** | `Set<SessionId>` | ClientMux attach/hello/frame handlers; detach clears connection | terminal/presence/topic selection and SessionStateService | live correctness | **room** | viewer attachment/viewport/presence state; room grant scope, cleared on disconnect |
| S1737 `gateway/client-registry.ts:119` **ClientConn.focused** | `SessionId \| null` | ClientMux attach/hello/frame handlers; detach clears connection | terminal/presence/topic selection and SessionStateService | live correctness | **room** | viewer attachment/viewport/presence state; room grant scope, cleared on disconnect |
| S1738 `gateway/client-registry.ts:134` **ClientConn.origin** | `ClientLogOrigin` | ClientMux attach/hello/frame handlers; detach clears connection | client/daemon mux transport and feed-serving edge | wiring/code only | **socket** | connection identity, negotiated capability or transport handle; cleared on close; scopes replaced on refresh |
| S1739 `gateway/client-registry.ts:139` **ClientConn.viewModes** | `Record<string, 'native' \| 'chat'>` | ClientMux attach/hello/frame handlers; detach clears connection | terminal/presence/topic selection and SessionStateService | live correctness | **room** | viewer attachment/viewport/presence state; room grant scope, cleared on disconnect |
| S1740 `identity/server-identity.ts:155` **createIdentityCore.rateLimit.storage** | `'memory'` | openServerIdentity constructs identity engine | identity sign-in admission/failure handling | answer/decision | **derived** | sign-in throttle allocated by external identity package; Q-rate, shared bucket instead of process storage |

## Acceptance evidence

1. Every declared field of the named classes and all production mutable module bindings is
   included with one verdict. The conservative class ledger also covers every other class
   property in the 813-file scan; lexical/factory/connection rows close the non-class gaps.
   The grep, raw declaration counts, counting unit and destination counts are stated above.
2. Every retained live item is explicitly `room` or `socket`. There is no “keep in memory”
   verdict and no undeclared Core cache; approved cache count is zero. Existing hints and
   snapshots have explicit deletion/read destinations and prerequisite facts.
3. The ordered POD-7290 tasks name files, prerequisite owners, sizes and the green-tree
   transition for each. Held transcript RPCs remain scoped to POD-7333 and do not block the
   rest of POD-7290.
4. The hot-path table names the frame/keystroke readers and fields, gives workload assumptions
   and estimated rates, and makes zero SQL per raw terminal frame/input edit the boundary.
   No live rate measurement is claimed or required by this doc-only amendment.
