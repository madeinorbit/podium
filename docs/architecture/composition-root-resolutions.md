# Composition root cycle resolutions

POD-321 replaces constructor-order cycles with two explicit mechanisms. A notification that is semantically asynchronous is an EventBus reaction and must appear in the [reactions ledger](./reactions-ledger.md). A caller-visible cross-feature workflow is an L3 application orchestrator with an explicit principal and transaction boundary.

## Former cycles

| Former dependency cycle | Resolution | Boundary and invariants |
| --- | --- | --- |
| machine metadata → session projections → machine registry | `sessions.machine-derived-fields` and `sessions.machine-row-adoption` reactions | Machine rows commit first. System-attributed in-memory reactions recapture or retarget live session projections without changing ownership. Startup reloads the durable machine/session truth. |
| session feed publication → session cursor | `sessions.feed-cursor` reaction | The global ledger sequence is observed after publication. Cursor updates are monotonic and reconstructed from the durable authority cursor after restart. |
| session membership → issue projection → session publication | `issues.session-derived-projection` reaction | Session changes emit `session.listChanged`; the system publisher reconciles issue-derived rows through the ordered ledger. Startup reconciliation reads durable issue and session rows, preserving issue scope. |
| session events → conversation search index → transcript reads | `conversations.discovery-index` reaction | Derived indexing is durable and system-attributed. Each indexed row inherits the conversation owner/scope; restart resumes from the durable segment cursor. |
| issue attach → session attachment → issue cleanup/publication | `IssueAttachOrchestrator` at L3 | One SQLite transaction encloses issue/dependency creation, session attachment, abandoned-draft cleanup, and change rows. The authenticated transport principal is carried unchanged; system/operator substitution is rejected. |
| durable changes → publisher fan-out → feature projections | `publisher.ordered-fanout` reaction | The authority sequence is the global order and durable change rows are the idempotency key. Connection failure belongs to the feed-serving boundary and reconnect catches up from the durable cursor. |
| session/issue state → notification delivery | Registered notification, mail-nudge, Telegram, typing, and recap reactions | Routing is per owner. Telegram outbound resolves per-user routing; unknown inbound chats fail closed behind POD-1080. Typing and recap state are per-conversation-per-user and never replay another user's transcript. |
| automation schedule → delegated session run | `automations.scheduled-runs` durable reaction | Occurrence IDs deduplicate. Startup reconciliation resolves the stored delegation reference live and re-authorizes before apply, so revocation stops a queued run. |

## Principal rule

System reactions use actor `system` and write only in the scope of the entity they maintain. Delegated reactions persist a delegation reference, never a capability snapshot, and resolve current rights at every apply including replay. `InstanceId` remains an independent deployment partition and is not used as a user or ownership identity.

## Generated evidence

The [server composition import graph](./server-composition-graph.md) is generated from runtime imports and fails generation on a cycle. The reactions ledger is generated directly from the typed registry; adding a reaction without replay, idempotency, failure ownership, observability, scope, or principal declarations fails its totality test.
