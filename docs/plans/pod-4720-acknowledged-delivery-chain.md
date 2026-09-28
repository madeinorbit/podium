# POD-4720 — Acknowledged message delivery chain

Status: investigation + proposal, 2026-09-28. Read on `dev/mw` at `0e6fa968c`.
Scope of this document: the deterministic part of the chain (app/CLI → server → daemon, and
status back). The daemon → agent-terminal step (typing, proof of acceptance) is only touched
where the deterministic chain needs a hook into it.

"Confirmed" = read in code (and for the key claims re-read by the coordinator).
"Likely" = inferred from code, not reproduced.

## 1. How a message travels today

1. **App.** Composer submit → `ConversationController.submit` mints `msg_<uuid>`
   (`apps/web/src/features/chat/use-chat-send.ts:286`, mobile `SessionConversation.tsx:241`) and
   shows an optimistic bubble.
2. **App → server.** Live session: one `sessions.sendText` call with `mutationId = msg id`
   (`use-chat-send.ts:181-238`). Parked session (and mobile offline): the durable kernel outbox
   (`store.resumeAndSend` → `rt.outbox.enqueue`).
3. **Server.** `dispatchSessionCommand` wraps the handler in `mutations.once(mutationId)`
   (`apps/server/src/modules/sessions/command-plane.ts:876-891`) → `mail.send` →
   `MessageDeliveryService.send` inserts a `messages` row with `id = correlationId ?? msg_<uuid>`
   (`apps/server/src/modules/messages/service.ts:890`). Then `injectAndMark` → `inbox.queueText`
   copies it into `queued_messages` with `id = input.mutationId ?? randomUUID()` — the messages
   path passes no mutationId, so **a new random id** (`apps/server/src/modules/sessions/inbox.ts:943`).
4. **Server → daemon.** `forwardContractRows` sends `runtimeDurableSendRequest{rowId = turnId =
   queue row id, deliveryRecovery}` and waits 12 s (`inbox.ts:1092-1197`,
   `apps/server/src/modules/machines/rpc.ts:111, 886-891`).
5. **Daemon.** `withDeliveryQueue` keeps the row in memory until the agent is idle+ready, then the
   terminal driver pastes, sends CR, and waits for a hook or transcript-echo proof
   (`packages/harness/src/driver/delivery-queue.ts`, `.../families/terminal/injection.ts:378-493`).
6. **Back.** `settle()` emits a runtime event `{t:'delivery', rowId, outcome}` through the daemon's
   fsynced runtime-event outbox (`delivery-queue.ts:76-82`, `apps/daemon/src/runtime-event-outbox.ts`).
   The server's runtime-event gate admits or rejects it, then `deliveryOutcome` settles the ledger
   (`inbox.ts:1227-1263`). The app is never told by id: it polls the ledger every 1–5 s and clears
   the bubble when **the same text** appears in the transcript
   (`packages/client-core/src/conversation/projection.ts:108-128`, `controller.ts:523-558, 634-650`).

## 2. Facts per requirement

| Requirement for a reliable chain | Today | Evidence |
|---|---|---|
| Sender keeps the message until the next hop confirms | Only parked/offline sends use the durable outbox. A live-session send is one call held in memory; reload loses it; no automatic retry. | confirmed: `use-chat-send.ts:264-303`, `controller.ts:473-502` |
| A retry reuses the same id | Controller retry does, but web shows no button for it; the web dead-letter "Retry" calls `send(text)` → new id → new message. | confirmed: `use-chat-surface.ts:784`, `controller.ts:270-277` |
| Server recognises a repeat atomically | Dedupe is a separate `applied_mutations` record written **after** the handler resolves; a rejected handler records nothing. `messages` insert has no on-conflict clause. | confirmed: `packages/sync/src/mutation-ledger.ts:115-163`, `apps/server/src/store/messages.ts:224-265` |
| — consequence | A crash/throw after the insert but before the record → every retry re-runs and hits the duplicate primary key → fails forever. | likely |
| One id end to end | The id changes at `queued_messages` (random). The daemon never sees the app's id. Dedupe between the two tables is by `source_message_id` via check-then-insert, no unique index. | confirmed: `inbox.ts:921-943`; race likely |
| Next hop recognises a repeat, durably | Daemon dedupe is two in-memory maps. Direct sends (no rowId) have none. | confirmed: `delivery-queue.ts:66-68, 212` |
| Restart does not lose or retype | After a daemon restart, the server re-forwards with `deliveryRecovery=true` and the new daemon settles every such row `failed` without typing — including rows that were only waiting and never typed. | confirmed: `inbox.ts:1149`, `delivery-queue.ts:122-128` |
| "Arrived" travels back on its own channel, by id | The delivery outcome rides the runtime-event stream and passes the same cursor/turn-epoch gate as agent activity; it is not exempt from `duplicate`, `unproven-segment-rotation`, `turn-epoch-regressed`, `turn-epoch-jump`. The daemon retires a rejected event as handled. The server row stays queued and is re-forwarded on the next bind. This is the POD-4360 restart-replay mechanism. | confirmed: `apps/server/src/modules/sessions/runtime-event-gate.ts:520-587`, `apps/daemon/src/runtime/handlers.ts:118-120` |
| App state = server state for that id | Bubble ↔ ledger row by id, but bubble ↔ transcript by exact trimmed text. No timeout removes a bubble; the 30 s timer only flips `sending→sent`; mobile renders `sent` as "sending…". | confirmed: `projection.ts:67-128`, `controller.ts:623-632`, mobile `TranscriptList.tsx:625-633` |
| "Delivered" only after delivery | Operator interrupt / attachment sends take the direct path; `ReceiptSender` answers `{ok:true}` at once and the ledger is marked `delivered` before any receipt. A later `queued`/`unverified`/abandonment cannot undo it (POD-2875 shape). | confirmed: `apps/server/src/modules/sessions/receipt-send.ts:333-336`, `service.ts:1318-1336` |
| Uncertain ⇒ tell the user, never guess | After a 12 s RPC timeout the server writes the text back into the session draft and raises "send it again" while the original may still be delivered. | confirmed: `inbox.ts:1175-1177, 1210-1222` |
| Retract only wins before typing; answer comes back | The server marks the ledger `cancelled` first, then asks the daemon; the daemon's refusal is ignored. A message that was typed anyway stays `cancelled`. | confirmed: `apps/server/src/modules/messages/mailbox.ts:368-381`, `inbox.ts:1012-1015`, `service.ts:612-616` |
| No server holds | Still holds on a composer/prompt-line draft (all urgencies, released by idle edge or 5-min sweep), on a stored non-retryable `errored` phase, on native-view lease. | confirmed: `service.ts:1179-1192, 1587-1591`, `inbox.ts:404-421, 1116-1120` |
| Bounded retries | Server re-forwards unconfirmed rows on every bind and every 60 s, no attempt/age cap; control frames for an absent daemon are buffered without limit and flushed on reattach. App outbox retries up to 14 days. Daemon re-sends its whole unacked outbox every 500 ms with no backoff. | confirmed: `inbox.ts:81, 1056-1075`, `apps/server/src/modules/machines/service.ts:859-893`, `packages/sync/src/outbox/limits.ts:43,114-131`, `apps/daemon/src/connection-state.ts:425-464` |
| Agent-sent messages on the same chain | Same `messages` → `queued_messages` pipeline, but the CLI sends no id (`mail send`, `issue mail send`, `session send`, `agent spawn`). A relay timeout (30 s / 120 s) and a rerun = a second message or a second child session. The sender gets `queued` and must poll `mail status`. | confirmed: `apps/cli/src/mail-cli.ts:278-285`, `apps/cli/src/session-cli.ts:417-420`, `apps/daemon/src/agent-relay.ts:18,55-62` |
| Automatic notices are exactly-once | Steward sends `sendTextWhenReady` un-awaited before claiming its fact; crash in between → repeated notice; failed send with claim written → lost notice. | confirmed code shape: `apps/server/src/steward.ts:323, 994-995`; outcome likely |

Churn: commits for 38 distinct issues touched send/delivery/queue/outbox on `dev/mw` since
2026-09-01, each fixing one symptom.

## 3. Symptom → cause

- **Message shows twice.** Bubble matched to the agent's transcript by text; any difference
  (whitespace, wrapping, attachments, transcript window reset) leaves both. Also: a row
  dead-lettered after it was typed renders a red "not delivered" bubble next to the transcript turn,
  and its Retry sends a new id.
- **Stuck "sending".** Text mismatch (mobile shows every unmatched turn as "sending…"); the server
  draft hold; a delivery outcome rejected by the runtime-event gate; a held direct send lost in a
  daemon crash (no abandonment report); likely the duplicate-key retry loop.
- **Sent multiple times.** 12 s timeout → draft restored + "send it again" while the original is
  still on its way; web Retry with a new id; CLI rerun after a relay timeout; direct sends re-sent
  under the at-least-once contract with no daemon dedupe.
- **Pending messages pile up; retract unreliable.** Unconfirmed rows are written back into the draft
  (which then holds later sends); retract says cancelled without the daemon agreeing; one
  unconfirmed row blocks the daemon's single-file queue for up to 30 min while the agent works.
- **Storm after restart.** Every bind re-forwards every unconfirmed row; the 60 s sweep keeps
  adding frames to an unbounded buffer while the daemon is away; the app outbox drains everything
  on reconnect; the daemon replays its unacked outbox every 500 ms. Retyping is prevented only by
  the daemon's in-memory maps; a daemon restart instead turns the whole backlog into "failed".

## 4. Proposal — one id, stored at every hop, acknowledged back by id

Two facts fix the shape:

1. Over a network a sender cannot tell "message lost" from "answer lost". The only correct scheme
   is: the sender repeats until it gets an answer, and the receiver recognises repeats by id
   (at-least-once sending + idempotent receipt = exactly-once effect).
2. Typing into a terminal cannot be undone or queried. So the daemon records "about to type" on
   disk before typing; after a crash that is the single, named uncertain case.

Rules:

1. **One id, minted by the sender before the first attempt, used everywhere.** App, CLI and
   system senders (notices use a deterministic id from their fact key). The server row, the
   daemon record and the agent's transcript entry all carry it. No hop mints a new one.
2. **Every hop: store, then answer "stored".** Receiving = insert-if-absent keyed by the id, and
   the answer is sent only after the write is durable. A repeat returns the same answer. The
   sender repeats (with backoff) until it has the answer; nothing else retries.
   - App: every send goes through the on-disk outbox (live or parked — one path).
   - Server: the `messages` row **is** the duplicate check (insert-or-return-existing in one
     transaction). No separate applied-mutations record for sends, no second table with its own id.
   - Daemon: a small on-disk journal (the daemon already has fsynced outboxes to build it from).
3. **Status only moves forward, per id.** `sent → stored on server → stored on machine → typing →
   typed → seen in agent's transcript`, or `cancelled` / `failed(reason)`. An older or repeated
   report changes nothing — replays and restarts are harmless by construction.
4. **Status travels back on its own path, by id.** Daemon → server: a status report `{id, status,
   reason}` through the existing on-disk outbox, resent until acknowledged, applied by the
   forward-only rule and **not** passed through the activity stream's turn-order gate. Server →
   app: the normal live sync. The app shows exactly that status. The bubble is removed when the
   transcript entry carrying the id arrives (the daemon attaches the id when it pairs the typed text
   with the hook/echo it already uses as proof). No text matching, no timers.
5. **Only the daemon decides when to type, and it never types the same id twice.** After a daemon
   restart it reads its journal: `stored` → type normally; `typing` (crashed mid-type) → look for it
   in the transcript, else show "not confirmed — resend?" (the only human decision); `typed` →
   re-report. Cancel is a request by id that wins only if it reaches the daemon before `typing`;
   the result (`cancelled` or "already typed") comes back as status.

What this removes: the send path's `applied_mutations` use, the random `queued_messages` id (and
likely the second table), the daemon's in-memory `rows/finished` maps and the
`deliveryRecovery ⇒ failed` rule, delivery outcomes inside the runtime-event gate, the 60 s sweep
and the unbounded offline buffer (replaced by "resend unconfirmed on reconnect, with backoff"),
the 12 s timeout's draft restore, server holds (draft, errored, native view), the separate
no-id direct-send path, and the app's text matching and 30 s timers.

### Suggested order (each step ships on its own)

1. One id end to end: `queued_messages`/daemon use the message id; CLI and steward mint ids and
   retry with them.
2. Server: insert-or-return-existing for sends; drop the post-hoc dedupe record there.
3. Daemon: on-disk delivery journal with `stored/typing/typed`; restart recovery per rule 5.
4. Status report frame by id, outside the runtime-event gate; forward-only status on the server.
5. App: all sends through the outbox; bubble = server status by id; retry reuses the id.
6. Delete: server holds, 60 s sweep, unbounded buffer, draft restore, direct-send path.

Later (non-deterministic, harness-specific): how `typed → seen in transcript` is proven per
harness.

## 5. Building blocks — what exists, what to introduce (added 2026-09-28)

### 5.1 Sync system (app ↔ server)

| Need | Today | Evidence |
|---|---|---|
| Id minted by the client | Yes: `msg_<uuid>`, `iss_<uuid>`, session UUID. Server checks are thin: session ids must be a UUID; issues/sessions are refused if the id exists; a message id is any string ≤128 chars, no format or sender check; dedupe is keyed on the id alone. | `packages/model/src/ids/brands.ts:148-191`, `packages/commands/src/sessions/command-plane.ts:69,194`, `apps/server/src/modules/issues/service/crud.ts:935` |
| Durable send, resend with growing pauses, wait for the answer | Yes: the sync outbox (IndexedDB web, SQLite mobile), declared state table, 1 s→60 s backoff, 14-day age, FIFO per partition, dead-letter + user retry/discard. **Live chat deliberately bypasses it** ("must fail fast rather than silently queue"); only `resumeAndSend` uses it. Per-command shorter max age is supported. | `packages/sync/src/outbox/*`, `packages/client-core/src/engine/wiring.ts:43-47`, `packages/commands/src/sessions/command-plane.ts:327-340`, `packages/sync/src/outbox/limits.ts:143-155` |
| Server recognises a repeat atomically | No: receipt recorded after the effect in its own write. A server transaction seam exists (`Ledger.commit`, `deps.transact`) but the receipt is not inside it. | `packages/sync/src/mutation-ledger.ts:129-137`, `packages/sync/src/ledger.ts:58` |
| Status pushed to clients by id | No: 13 synced kinds, none is a message; chat polls `messages.ledger`. Adding a kind ≈ 4 wiring sites + a visibility rule (precedent `pendingInteraction`). | `packages/protocol/src/messages/sync.ts:233-247`, `apps/web/src/features/chat/use-chat-send.ts:291` |

### 5.2 State machines

No generic mechanism. ≈45–60 status vocabularies, ≈25 with real transitions, 4–5 with a declared
table, each in a different shape (outbox `states.ts`, replica `transition-table.ts`, server-transfer
`journal.ts`, ship orders `packages/model/src/shipping.ts:439`). Everything else is per-method SQL
guards that return `false` quietly. `messages.status` moves backwards (`retractOptimisticDelivery`,
`apps/server/src/store/messages.ts:765`) and hides a sub-state in `injected_at`. Closest to the
target: ship orders — shared table in `packages/model` + a guarded UPDATE that throws unless exactly
one row moved (`apps/server/src/store/shipping.ts:885-929`).

### 5.3 Daemon storage and the link

- ≈9 hand-written persistence mechanisms, no shared helper (directory fsync copy-pasted 7×): two
  fsynced outboxes, binding store (atomic rename, **no fsync**, `binding-store.ts:901-906`), engine
  journals (bare `writeFileSync`, errors swallowed, `session/journal.ts:52-62`), shipping journal,
  server-transfer staging, `machine.json`, `pending-update.json`, `daemon-health.json`; plus one
  SQLite cache (`discovery.db`, WAL). `@podium/runtime/sqlite` is available to the daemon.
- Memory-only and unique to the daemon: delivery queue rows/outcomes, held sends, the terminal
  injection queue ("did I type it?"). Agent processes survive a daemon restart (podium-host);
  transcripts are on disk; the server re-drives reattach.
- Link: no link-level sequence, ack or resume. 4+ per-feature ack schemes (`runtimeEventAck`,
  `runtimeQueueDrainAbandonedAck`, `sessionResumeRefAck`, `agentObservationAck`, `headlessTurnAck`).
  Daemon→server frames sent while disconnected are dropped unless they belong to one of the two
  outboxes; server→daemon frames go to an unbounded in-memory queue lost on server restart. A request
  that times out while the machine is offline still runs when it reconnects
  (`apps/server/src/modules/daemon-request.ts:151-165`, `machines/service.ts:889-892`).

### 5.4 The three building blocks to introduce

1. **Durable outbox + idempotent receiver, one mechanism for every link.** Sender: record on disk,
   send, resend with growing pauses until the receiver acknowledges the id. Receiver: apply if the id
   is new, in the same transaction as the effect, then acknowledge. App↔server already has it (sync
   outbox up; change feed down) — bring messages into it. Server↔daemon: start from the same outbox
   kernel (storage- and transport-agnostic) with a SQLite store on both sides; it needs a machine
   sender identity. Live-only traffic (terminal output, typing state) stays outside. Replaces the
   per-feature acks, `pendingByMachine`, RPCs for state-changing commands, and the resend sweeps.
2. **Declared state machine.** `packages/model`: a table of allowed moves shared by server, daemon
   and apps. Store helper: one guarded UPDATE that moves only from an allowed previous state and
   reports applied / already there / refused. Test helper: walk the table, prove every missing move
   is refused. Extracted from ship orders; first user is message delivery; others convert when touched.
3. **One local database per process that must remember.** `daemon.db` (SQLite via
   `@podium/runtime/sqlite`, WAL, `synchronous=FULL`, migrations) holding the link's outbox/inbox
   tables and daemon-only facts. It keeps only what nobody can tell the daemon after a restart: side
   effects it performed that cannot be repeated (about to type / typed, per message id), reports not
   yet acknowledged, and facts only it observed (which transcript entry is which message, bindings).
   Everything else is re-read from the machine or re-sent by the server. The hand-written file stores
   fold in when touched; `machine.json`/`pending-update.json` (read before the daemon starts),
   `discovery.db` (worker-owned cache) and server-transfer staging stay separate.

## 6. Second round (2026-09-28): ids, what belongs in sync, practice elsewhere

### 6.1 Client ids — the gap is the whole sync write path, not only messages

- No generic id check in the outbox, the command dispatch or the receipt ledger; only per-command
  zod schemas. `sessions.create.sessionId` is `uuid()`; issue ids, `issues.create.startSessionId`
  and message ids are bare strings (`packages/model/src/ids/brands.ts:112-188`,
  `packages/commands/src/issues/contracts.ts:264-265`).
- Duplicates differ per entity: issues refused (plain Error, echoes the id; revision pin backstop),
  sessions refused only against the in-memory map while the DB write is an upsert, messages hit a
  raw primary-key error.
- Receipts are keyed on `mutationId` alone across all principals; `dispatchSessionCommand` runs
  authorization inside the handler that a receipt hit skips (`command-plane.ts:546, 880-885`) →
  POD-4735. Unchecked `startSessionId` reaches `durableSessionLabel` and the abduco socket path
  (`workflow.ts:564`, `packages/runtime/src/instance.ts:252-270`) → POD-4736.
- Attribution cannot be spoofed through payloads (principal comes from the transport); exception:
  `issues.addComment.author` display name is free text.

### 6.2 Carrier per kind of chat data (planes already exist: `packages/protocol/src/planes/plane.ts`)

| Data | Owner | Nature | Carrier | Today |
|---|---|---|---|---|
| Send | device until the server stores it | one-off request, exactly-once effect | command with a client id (outbox only if offline queueing is wanted) | command, id not atomic |
| Message record + delivery status | server (stored/cancelled), daemon (typed/seen) | small, few status changes, same on every device | **synced record** (control.entity) | **none — polled** (`use-chat-send.ts:291`) |
| Transcript | agent's own files (not ours, rewritable) | large, append-only | bulk: read by cursor, live tail, cached recent window | bulk (`TranscriptItem` "not a replicated entity", `packages/model/src/entities/transcript.ts:99-102`; ADR 0002:429-437, ADR 0007) |
| Live turn output | agent, now | throwaway, replaced by the transcript item | stream.live | `turnPreview` (web only) |
| Agent state, agent questions | daemon observation | small current value | synced record | `session`, `pendingInteraction` |

Reconciliation by id only: send↔record share the client id; record↔transcript via the transcript
item id the daemon records when it confirms delivery (it already pairs them for proof); live
output↔transcript via `streamItemIdOf` (exists). Synced working set: undelivered + recently
finished records; history is the transcript.

Send, step 1 (Matrix `PUT …/send/{txnId}` shape): one request with the client id; server stores
once and answers the original result on repeat; seconds of automatic retry with the same id, then
"not sent — retry" (same id). Offline queueing later = the same request held in the outbox.

### 6.3 Comparable systems (web research; sources in the session report)

Category: control plane with node agents over an agent-initiated, intermittent link. Closest:
AWS IoT Jobs/Commands, Azure IoT Hub, GitHub Actions / Buildkite runners, Nomad; Kubernetes minus
the one-shot side effect. Consensus: per-agent set of durable work records re-listed on every
reconnect then followed (not commands pushed down a pipe; not collapsed into one desired value);
irreversible effects at most once via a durable "started" note on the executor before acting,
crash ⇒ explicit `unknown`; status written by the agent, forward-only, versioned; server timeout
⇒ `unknown`, not `failed`; subscribe → full list → ignore older versions; never treat absence as
cancel without a freshness check (Nomad #18267).

Revision of §5.4 block 1 for server→daemon: the daemon follows "undelivered messages for sessions on
this machine" through the sync feed's list-and-follow (filtered per machine, cursor = transport
ack); status returns as idempotent, forward-only updates through a small outbox. Sync does not
supply the daemon's "started/typed" note, the intermediate statuses, or the freshness guard.

### 6.4 State machines — practice

Persisted lifecycles are formalized lightly: allowed-values CHECK, a shared table of allowed moves,
every change a conditional UPDATE from an allowed previous status (0 rows = refused), absorbing
terminal statuses, explicit `unknown`. XState for UI flows, not as DB authority (its persisted
snapshots are fragile across machine changes). Observations (idle, working, connected) stay
readings, not lifecycle statuses (Kubernetes API conventions).

### 6.5 Daemon disk writes

≈35 features. Needs-to-survive: runtime-event outbox, queue-drain outbox, binding store, engine
journals, shipping journal, pending-update, machine.json, server-transfer. Settings/identity:
config.json, instance files, pid/health. Agent wiring: Claude per-session hook settings, Codex/Grok
hook files, per-session instructions, browser shims, temp MCP config, credential install. Transfers
and files: handoff packages, workspace peeks, uploads/attachments, user git/file operations.
Other: sockets, managed host/abduco binaries, discovery.db (only SQLite), logs, perf, self-update.
No shared atomic-write helper (≈12 hand-rolled tmp+rename writers, directory fsync copied 9×,
5 lock idioms). Defects filed as POD-4740 (outbox torn tail, config.json in place, binding store
without fsync).
