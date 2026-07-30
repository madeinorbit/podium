# Visibility mutability inventory — handed from POD-304 to POD-1077

<!-- GENERATED FILE. Do not edit by hand.
     Source of truth: packages/model/src/annotations/matrix.ts (the ownership matrix).
     Regenerate:  bun scripts/visibility-mutability-inventory.ts
     Verify:      bun scripts/visibility-mutability-inventory.ts --check
     ADR 4 D7 forbids storing derived state twice, so this document is derived. -->

## Why this document exists

**Visibility changes are not entity changes.** Granting or revoking a share makes
entities appear or disappear for a principal **without that entity's `revision`
moving** (ADR 9 D2 rule 5, readiness §3.1 item 2). A feed that filters per client
cannot express that today, and ADR 2 is explicit that adding the filter without
watermarks is **a protocol break, not an optimization**: every suppressed row
becomes an invisible permanent gap that triggers an endless heal loop.

So POD-1077 must build **watermarks** plus a **rescope / `evict` signal distinct
from `remove`** — a removal from *your view*, not a deletion. `remove` cannot be
reused: the replica would render it as "deleted", and ADR 2 D5 already warns that
soft-delete and tombstone "look identical from a distance and are not". This is a
third member of that family.

**POD-304 builds none of that.** It records which classes have the property, per
class, because that set is the input to Phase 2's scoped-feed conformance suite.
The rows marked *mutable* below are exactly the classes whose appearance or
disappearance a scoped feed must be able to signal.

## What POD-1077 should read off this

1. **32 of 53 classes have mutable visibility.** This is the majority of
   the matrix, which is the quantitative form of "the machinery is load-bearing
   from day one, not inert" (readiness header decision).
2. **The `change-log` row is the one the whole inventory is for.** Its delivery
   is per-principal scoped while it is substrate at rest; that split is where
   watermarks live.
3. **The `grant-edge` row IS the visibility event.** It is a durable change with
   a global `seq`, which is the anchor a watermark advance and a rescope signal
   hang off — you do not need to invent an event, you need to interpret that one.
4. **Two classes change visibility through a verb that is not a share.** Machine
   grants (`see` / `use` / `manage`) and account-level acts
   (`account-role-change` / `account-disable`) both move a principal's visible
   set without any entity being shared. A conformance suite built only around
   `share` / `unshare` will miss both.
5. **Per-user state is never mutable, by construction** — non-grantable, so no
   verb can change who sees it. Those rows need no signal, which is a real
   saving: it is why keying by user is a simplification and not just a re-shape.
6. **Machine absence is not machine deletion.** A machine the principal cannot
   `see` is *absent*, and any reference to it must fail identically to a
   nonexistent machine id (ADR 9 D6 M5 / D7 clause 2). Revoking `see` therefore
   needs the evict path, not a `remove`.

## Mutable after create — Phase 2 must be able to signal these

| Row | Class | Visibility class | Verbs that change who can see it | Note |
|---|---|---|---|---|
| `machine` | Machine (fleet row / `machines`) | owned-compute | `grant-see` `grant-use` `grant-manage` `revoke` `transfer-owner` `pair` `unpair` | PHASE 2 MUST HANDLE: granting `see` makes a machine and every per-machine fact appear for a principal with no revision moving. Revoking `use` must not read as "machine deleted" — and per ADR 9 D6 M5 a machine outside the `see` set is ABSENT, so an evict/rescope signal (not `remove`) is the only correct expression. |
| `session-identity` | Session identity (`sessionId`, birth display ref / letters) | personal | `share` `unshare` `revoke` `transfer-owner` | PHASE 2 MUST HANDLE: the archetypal case. Sharing a session makes it and its whole subtree (placement, labels, draft, queued messages, observed runtime, artifacts, transcripts) appear for the grantee with NO revision moving. |
| `session-placement` | Session placement (`cwd`, `machineId`, `issueId`, `agentKind`, origin, headless, workflow pass-through ids) | personal | `share` `unshare` `revoke` `grant-use` | PHASE 2 MUST HANDLE: two independent axes. It appears/disappears with the session’s grants, AND a machine `use` revocation can make a placement unusable without the row changing. |
| `session-labels` | User-authored labels (`name`/`nameSource`, user `title`, `archived`, `workState`) | personal | `share` `unshare` `revoke` | PHASE 2 MUST HANDLE: follows the session. |
| `composer-draft` | Composer draft (`session_drafts` + `draftUpdatedAt`) | personal | `share` `unshare` `revoke` | PHASE 2 MUST HANDLE: follows the session — and it is the row where a second visible writer turns the interim defect into data loss. |
| `queued-agent-messages` | Queued agent messages (`queued_messages`) | personal | `share` `unshare` `revoke` | PHASE 2 MUST HANDLE: follows the session. |
| `daemon-observed-runtime` | Daemon-observed runtime (status, exitCode, epoch, geometry, resumable, transcriptAvailable, busy, agentState, agentColor, clientCount, activity timestamps) | personal | `share` `unshare` `revoke` | PHASE 2 MUST HANDLE: follows the session. |
| `session-live-ephemeral` | Live-only / ephemeral — PTY handles, controller set, in-flight handoff overlay | personal | `share` `unshare` `revoke` | PHASE 2 MUST HANDLE (as a ROOM, not a feed row): presence/attach membership is derived from live connections, so a revoke must evict an attached principal rather than wait for a revision. |
| `host-metrics` | Live-only / ephemeral — host metrics | owned-compute | `grant-see` `revoke` `transfer-owner` | PHASE 2 MUST HANDLE: appears/disappears with the machine’s `see` grant. |
| `provenance-envelope` | Provenance envelope (`viaHub`, `upstreamStale`, `pendingSync`) | personal | `share` `unshare` `revoke` | Follows whatever it envelopes; it never changes visibility on its own. |
| `issue-core` | Issue core (title, design, acceptance, type, priority, stage, assignee, due/defer, origin, audience, draft, panel, …) | personal | `share` `unshare` `revoke` `transfer-owner` `reparent` | PHASE 2 MUST HANDLE: `reparent` is in this list because subtree scope is a MOVING SET — reparenting under an epic widens a working agent’s visibility with nobody having decided it (O3). That is recorded, not resolved. |
| `issue-document-fields` | Issue document fields (`description`, `notes` / activity notes) | personal | `share` `unshare` `revoke` | PHASE 2 MUST HANDLE: follows the issue. |
| `needs-human-group` | Needs-human group (`needsHuman`, `humanQuestion`, options, `humanQuestionAskedBy`, `humanQuestionAskedAt`) | personal | `share` `unshare` `revoke` | PHASE 2 MUST HANDLE: follows the issue. |
| `issue-graph` | Issue graph (parent, deps, labels, blocked_by, superseded_by, duplicate_of) | personal | `share` `unshare` `revoke` `reparent` | PHASE 2 MUST HANDLE: an edge can become visible while its far endpoint stays invisible, which is the case a scoped feed must not render as a dangling row. |
| `issue-comments` | Issue comments | personal | `share` `unshare` `revoke` | PHASE 2 MUST HANDLE: follows the issue. |
| `issue-messages` | Issue messages (tracker mail, `issue_messages`) | personal | `share` `unshare` `revoke` | PHASE 2 MUST HANDLE: read visibility follows the issue. |
| `artifacts` | Artifacts (snapshotted files) | personal | `share` `unshare` `revoke` | PHASE 2 MUST HANDLE: follows its parent. |
| `conversation-registry` | Conversation registry | personal | `share` `unshare` `revoke` | PHASE 2 MUST HANDLE: follows the session. |
| `segments` | Segments / native evidence | personal | `share` `unshare` `revoke` | PHASE 2 MUST HANDLE: follows the conversation. |
| `blobs` | Blobs (content-addressed) | personal | `share` `unshare` `revoke` | PHASE 2 MUST HANDLE: reachability changes with every referencing entity’s grants, so a blob can become visible without any blob row changing. |
| `repo-prefix` | Repo / prefix (`repos`, `repo_prefixes`) | owned-compute | `grant-see` `grant-use` `revoke` `transfer-owner` | PHASE 2 MUST HANDLE: the whole per-machine fact set appears/disappears with one machine grant. |
| `approval-requests` | Approval requests | personal | `share` `unshare` `revoke` | PHASE 2 MUST HANDLE: follows its subject entity. |
| `automations-and-runs` | Automations / runs | personal | `share` `unshare` `revoke` `account-disable` | PHASE 2 MUST HANDLE: and note that disabling the creator’s ACCOUNT must stop the automation — live intersection, not a stored capability. |
| `workflows` | Workflows / revisions / bindings / runs / steps / events / execution_profiles | personal | `share` `unshare` `revoke` `grant-use` | PHASE 2 MUST HANDLE: two axes again — the definition’s grants, and machine `use` for run advance. |
| `messages-substrate` | Messages (`messages` substrate) | personal | `share` `unshare` `revoke` | PHASE 2 MUST HANDLE: addressing makes a row visible to a second principal at send time, which is a visibility change the addressee’s cursor never saw. |
| `messaging-issue-topics` | Messaging issue topics | personal | `share` `unshare` `revoke` | PHASE 2 MUST HANDLE: follows the issue. |
| `superagent-state` | Superagent threads / messages / queued inputs / pending turns | personal | `share` `unshare` `revoke` | PHASE 2 MUST HANDLE: private by default, shareable by explicit grant. |
| `handoff-bundle` | Handoff bundle / HandoffManifest (`sourceMachineId`, `exportedAt`) | personal | `share` `unshare` `revoke` `grant-use` | PHASE 2 MUST HANDLE: follows the session, plus target-machine `use`. |
| `change-log` | Change log (`changes`) | deployment-substrate | `share` `unshare` `grant-see` `revoke` | PHASE 2 MUST HANDLE — THIS IS THE ROW THE WHOLE INVENTORY IS FOR. Per-client filtering without watermarks is a PROTOCOL BREAK, not an optimization: every suppressed row is an invisible permanent gap that triggers an endless heal loop. A grant/revoke must therefore produce a watermark advance plus a rescope/`evict` signal DISTINCT from `remove` — a removal from YOUR VIEW, not a deletion. `remove` cannot be reused: the replica would render it as "deleted". |
| `user-account` | User / account aggregate (identity, display name, role, lifecycle) | personal | `account-role-change` `account-disable` | PHASE 2 MUST HANDLE: a role change or disable alters what that principal sees ACROSS THE INSTANCE with no entity revision moving — the widest-blast-radius visibility event there is. |
| `grant-edge` | Grant edge (`(entityRef, granteeUserId, verb)`) | personal | `share` `unshare` `revoke` | PHASE 2 MUST HANDLE: this row IS the visibility event. Its `seq` is the anchor a watermark advance and a rescope signal hang off. |
| `delegation-record` | Delegation record (`agentIdentity`, `onBehalfOf`, scope, lifecycle) | personal | `account-disable` `revoke` `reparent` | PHASE 2 MUST HANDLE: an agent’s visible set changes when its human’s does, and `reparent` moves a subtree scope under it (O3). |

## Not mutable after create — no signal needed

| Row | Class | Visibility class | Verbs that change who can see it | Note |
|---|---|---|---|---|
| `instance-id` | InstanceId (deployment partition) | deployment-substrate | — | Tenant-visible from creation and never narrows. |
| `pairing-token` | Pairing token / client session token | secret | — | Never visible to any replica, so there is nothing to change. |
| `daemon-identity-file` | Daemon local identity file | owned-compute | — | A local file; not replicated, so replica visibility never changes. |
| `session-read-at` | Session `readAt` (moved out of the labels group by Amendment 1 D10) | per-user-state | — | Non-grantable by construction, so no verb can change who sees it. The only lifecycle event is the owner’s account being removed. |
| `snooze` | Snooze (`snoozes` / `snoozedUntil`) | per-user-state | — | Non-grantable by construction, so no verb can change who sees it. The only lifecycle event is the owner’s account being removed. |
| `issue-message-read-at` | Issue message / issue `readAt` (moved by Amendment 1 D10) | per-user-state | — | Non-grantable by construction, so no verb can change who sees it. The only lifecycle event is the owner’s account being removed. |
| `pins` | Pins | per-user-state | — | Non-grantable by construction, so no verb can change who sees it. The only lifecycle event is the owner’s account being removed. |
| `tab-order` | Tab order / sidebar layout | per-user-state | — | Non-grantable by construction, so no verb can change who sees it. The only lifecycle event is the owner’s account being removed. |
| `preferences-personal-keys` | Preferences — PERSONAL keys (session defaults, sidebar, autoContinue, `telegramChatId`, ntfy topic, …) | per-user-state | — | Non-grantable by construction, so no verb can change who sees it. The only lifecycle event is the owner’s account being removed. |
| `preferences-instance-keys` | Preferences — INSTANCE / deployment keys (instance-level settings, feature flags) | deployment-substrate | — | Tenant-visible from creation. Note the RATCHET: moving a class INTO deployment-substrate, or widening a grant verb set, requires an ADR 1 amendment (D9.3) — privacy is free, exposure is reviewed. |
| `server-owned-secrets` | Server-owned secrets (`apiKeys.*`, `integrations.linearApiKey`, `notifications.telegramBotToken`) | secret | — | Never replicated, so replica visibility cannot change. What multi-user changes is WHO MAY ROTATE: management is ADMIN-GRADE once there is more than one human (D15) — "any authenticated principal may replace the org’s provider key" is a privilege escalation with a billing blast radius. |
| `managed-credentials` | Managed credentials / accounts (`accounts`) | secret | — | Values never replicate; `manage` is admin-grade. |
| `config-features` | Operator `config.features` (feature flags) | deployment-substrate | — | Tenant-visible from creation. |
| `advisory-locks` | Advisory locks (`locks`, `lock_waiters`) | deployment-substrate | — | Tenant-visible from creation — that is the point of a coordination name. |
| `applied-mutations` | Applied mutations | deployment-substrate | — | Never replicated to the general replica, so no principal’s view of it can change. Substrate at rest and invisible on the wire is the one combination with nothing for Phase 2 to signal. |
| `client-outbox` | Client outbox | per-user-state | — | Device-local and never replicated. |
| `replica-cursor` | Replica cursor / collections | per-user-state | — | NOT mutable, and the distinction matters: only its owner ever sees this row, so no verb changes WHO CAN SEE IT. What a grant changes is WHAT THE CURSOR POINTS AT — so this is where a rescope LANDS, not a class whose visibility moves. PHASE 2 (POD-1077) still touches it: a scoped bootstrap reads the principal’s slice at `(feedId, epoch, seq)`, and the shape of ADR 2 D6’s chunked bootstrap is unaffected. |
| `account-credential` | Account credential material | secret | — | Never replicated and excluded from every wire projection, so no principal’s view of it can change. What multi-user changes is WHO MAY RESET it — an admin-grade action (D15). |
| `per-user-client-session` | Per-user `client_session` (a device that resolves to a user) | per-user-state | — | Non-grantable by construction, so no verb can change who sees it. The only lifecycle event is the owner’s account being removed. |
| `telegram-chat-binding` | Telegram chat binding (`chatId → UserId`) | per-user-state | — | Non-grantable by construction, so no verb can change who sees it. The only lifecycle event is the owner’s account being removed. |
| `per-user-state-family` | Per-user state family (generic) | per-user-state | — | Non-grantable by construction, so no verb can change who sees it. The only lifecycle event is the owner’s account being removed. |

## What is deliberately NOT decided here

Which existence facts leak (O1), whether a cross-boundary graph edge is hidden or
shown as an opaque "blocked by something you cannot see" reference (O2), whether
`reparent` is a permission-affecting operation (O3), and the multi-parent case of
owner/grant inheritance on create (O4). Those are recorded on the matrix rows
that make them concrete and are answered by their owners, not here.
