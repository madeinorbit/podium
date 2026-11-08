# ADR 7, Amendment 2: topics on the stream plane

| Field | Value |
|---|---|
| **Status** | Accepted 2026-11-08 (operator, POD-5620 design session) |
| **Builds on** | ADR 7 D1 (three planes), Amendment 1 D10–D14 (rooms; one subscription primitive; visibility gate; backpressure), ADR 12 D1 (homes: LiveStore, live streams, request answers), ADR 5 (handshake capabilities) |
| **Verified against** | dev/mw `ee67b1ec09` |

## 1. Context

ADR 7 Amendment 1 D13 decided that there is **one subscription primitive**: `SubscriptionRegistry` plus `PlaneRouter` in `packages/protocol/src/planes/routing.ts`, with durability as its only difference. Two consumers use it: the scoped sync feed (durable) and presence rooms (`StreamPlanePort`, live).

Every other live datum still uses a path of its own:

| Datum | Today | Problem |
|---|---|---|
| Transcript | `transcriptSubscribe{since}` / `transcriptUnsubscribe`. The server holds subscribers per session (`modules/sessions/terminal.ts` ~480) and replays from an **opaque cursor** string. | No gap detection, so the client re-reads the newest window 400 ms after activity and also probes on a live heartbeat (`conversation/transcript-log.ts` ~457–505). |
| Reply preview | `turnPreview`: a full snapshot, apply-if-newer on `(turnEpoch, seq)`. Daemon demand is `runtimeWatch fine|coarse`, re-sent after a daemon rebind (`resetWatchLevel`, `daemon-lifecycle.ts:455`). | The right design, built for one datum. |
| Headless activity | `headlessActivity` events | Its own frame. |
| Terminal | `attach{sinceSeq}` → `attached{epoch, resumed}` plus `outputFrame{seq, epoch}` (binary when negotiated); `controllerChanged`, `geometry`, `agentExit`, `terminalOutcome` | Its own lifecycle; residency through `HOLDING_FRAMES` (`client-control.ts:92`). |
| Draft | `draftEdit{baseRev, text}` / `sessionDraftChanged{text, rev}` (Draft Sync v2) | Its own frames. |
| Host metrics | the daemon samples every 5 s, always; the server broadcasts `hostMetricsChanged` to every client | Produced and sent with nobody watching. |
| Quota and usage | clients poll `quota.summary` / `usage.summary` every 60 s; each call fans out to the daemons (120 s memo) | Polling. |
| One-off events | `attentionEvent`, `sessionOpenUrl(Result)`, `serverRelocation`, `setLogLevel` | Undeclared. |

This amendment puts **every** live datum on the one primitive, as **topics**.

## 2. Decisions

### D17. A topic is a routing key on the stream plane, with a declared kind

A topic key is `(kind, id)`, encoded with the existing `entityRoutingKey` form `kind:id`. Presence rooms (D10) stay exactly as they are, on the same registry. Kinds come from a **closed set** declared once in `packages/protocol/src/planes/topics.ts` (`TOPIC_KINDS`). A new kind can only be added by editing that table, and a totality test checks that every kind has every declaration field and a conformance run (D25).

*Rejected:*
- **Free-form string keys:** they repeat the "inline recipient rule" problem D13 names (browser-open).
- **One registry per feature:** these are today's five wheels.
- **A fourth plane:** D1 and D10.1 already reject it; a topic is delivery scope, not a backpressure domain.

### D18. Every kind declares four things

| Field | Values | Meaning |
|---|---|---|
| `style` | `value`, `log`, `event` (rooms keep Amendment 1's `room`) | how updates combine (D19) |
| `producer` | `server` or `daemon` | who produces it. Both get the same start and stop on the first and last subscriber (D21). |
| `visibility` | a resolver name from the ADR 9 classes | checked on subscribe (D14 gate, default closed) and again whenever the subscriber's visibility changes (D24) |
| `rate` | a maximum send rate per key; updates in between are coalesced | enforced on the server, before the socket |

Deliberately NOT part of the declaration, because none of these is a property of the wire:
- **Whether a client stores a topic.** That is the consumer's choice: the conversation keeps the transcript in its device store (POD-5801).
- **Whether a topic is held for the whole session.** The runtime root simply subscribes to machine condition and quota for its lifetime.
- **Whether the server keeps a session loaded.** That follows from producer start and stop (D21).

### D19. Three styles, each with one recovery rule

| Style | Update | Snapshot on subscribe | Loss | Recovery |
|---|---|---|---|---|
| `value` | the whole current value. A "this changed, fetch again" notice is a value with an empty payload. | the current value, or `unknown` | fine; a newer value supersedes it | resubscribe and get the current value |
| `log` | ordered entries | the entries after the client's position, or a reset window | detected by a `seq` jump or an `epoch` change | resubscribe from the last good position; older than the server keeps means a reset window, plus a bulk read for history |
| `event` | a one-off notice to whoever is connected now | none | acceptable; anything lasting is also in synced data | none |

Presence rooms keep Amendment 1's membership semantics and frames. They already sit on the same registry, so they are the one existing special case, not a fourth style to build.

**Every snapshot and update carries a server-assigned position `(epoch, seq)`, in every style.** One rule for all, with no separate "version" field:
- `seq` increases by one for every update the server sends for that key.
- A value applies only if its position is newer than the one the client holds. For a log, position also detects gaps.
- `epoch` changes when the producer starts over: a server restart, or a transcript reset when the tailer switched files. A new epoch always arrives as a snapshot, so a client never compares positions across epochs.
- A log entry may restate an item that already exists, by its id (a tool call that completes). Clients apply entries by id, so "the latest version of item X" is simply a later entry.

This replaces the transcript's opaque cursor as the resume point; the cursor stays inside the item for the bulk read.

*Rejected:*
- **One style for everything:** a log treated as a value loses entries, and a value treated as a log grows without limit.
- **Client-assigned positions:** several devices would disagree.

### D20. Client contract

- `topics.subscribe(key, { from?: Position })` returns a handle, and is **reference-counted per key per runtime**. Two views on the same transcript share one subscription.
- The first message for a handle is always a `snapshot`. For a value, `unknown` is a valid snapshot.
- After the socket reconnects, the client resubscribes every key that still has a holder. A log resubscribes from its last good position.
- When the connection service declares the connection lost, every value goes to `{ state: 'unknown', last, since }`. That uses its existing health rule, not every brief socket blip, so a quick reconnect does not flicker the screen. The UI shows unknown, and may show "last seen" from `last`. This is ADR 12's "honest code shows unknown".
- **Topic frames never wait behind the sync feed.** They are applied on their own path, not on the feed's yielding task queue (`socket-hub.ts` `scheduleFeedTask`), and at most once per animation frame per consumer. Target: a topic frame reaches its MobX value within 50 ms p95 during a feed catch-up.
- **Terminal bytes never touch MobX:** the terminal consumer writes them straight to the terminal renderer.
- Consumers are the LiveStore, conversation objects and view models (services). They hold the state, and every view reads that one object. React components never call `topics.subscribe`.
- **Holes in a log:** a reset snapshot that does not join up with history the client already stores (POD-5801) leaves a hole. The consumer fills it with the bulk read, using the item cursors.

### D21. Server contract

- Topics live on the gateway's single `SubscriptionRegistry`. Subscribing runs the kind's visibility resolver (D14), registers the key, and replies with the snapshot. Unsubscribing, a connection close and a heartbeat reap all go through `dropSubscriber`, as rooms do.
- **One producer rule for both sides.** Every kind has a producer with `start(id)`, `snapshot(id)` and `stop(id)`. The registry calls `start` when a key's subscriber count goes from 0 to 1, and `stop` when it goes from 1 to 0. A server producer does this in process: for a session topic, start loads the session's live runtime (the relay, the output window, the transcript buffer; the POD-6160 "live plane") and stop lets it go. A daemon producer does it over the wire, below.
- **Daemon producers:** on the same zero-crossings, the server sends the owning daemon `topicWatch { key, on: true }` or `on: false`. This is a **desired state** (the `runtimeWatch` rule): duplicates are harmless, and the next change corrects a lost one.
- **Daemon reattach:** when a daemon rebinds, the server forgets what it told the old process and re-sends `topicWatch on` for every key of that machine that still has subscribers. This is the generic form of `resetWatchLevel`, and one rule covers every topic.
- The daemon publishes with `topicPublish { key, payload }`. The server assigns the position and fans out under the kind's rate and coalescing rule.
- **Limits:** one connection may hold at most 1,000 keys; beyond that the server refuses with `refused`. One subscription per key per connection.
- **Session residency** is just producer start and stop, so `HOLDING_FRAMES` goes. Commands that edit a session still hold it while they are handled, as today.

### D22. Daemon contract

One watch registry: `kind → { start(id) → stop }`, the same producer interface as the server's. Nothing samples or tails without demand.

On restart the registry is empty, and the server's re-demand (D21) refills it.

### D23. Wire frames

Client → server:
- `topicSubscribe { key, from? }`
- `topicUnsubscribe { key }`

Server → client:
- `topicSnapshot { key, position, payload, reset?, hasOlder? }`
- `topicUpdate { key, position, payload }`
- `topicEvent { key, payload }`
- `topicClosed { key, reason }`, where reason is `refused`, `gone`, `revoked`, `overflow`, `unsupported` or `shutdown`

Server → daemon: `topicWatch { key, on }`. Daemon → server: `topicPublish { key, payload }`.

**Terminal bytes:** a negotiated binary envelope `[frameType][keyIndex][epoch][seq][bytes]`, where `keyIndex` is a small per-connection number assigned in the snapshot. This keeps today's binary speed.

The **payload schema for each kind** is declared next to the kind in `TOPIC_KINDS`, and checked by codec golden fixtures like every other frame.

**Capability:** `topics.v1` in `hello.caps`. The server uses topics with a capable peer, and the old frames otherwise, until POD-6680 raises the floor.

Input and control **stay commands**: terminal input, resize, request control, viewport and redraw requests, `draftEdit`. They change things; they are not data to watch.

### D24. Visibility, revocation and backpressure

- **Subscribe** is gated by the kind's resolver. A refusal looks exactly like a missing key (D14).
- **Revocation:** a principal's visibility changes when a grant is removed or an issue moves out of scope. On the same trigger that rescopes that principal's sync feed (`feedRescope`), the server re-checks the principal's keys and sends `topicClosed{revoked}` for each one it may no longer see.
- **Backpressure** follows D11, per style:
  - `value` coalesces by key, so only the newest is queued;
  - `log` never drops silently: on overflow the key is closed with `overflow`, and the client resubscribes from its position;
  - `event` uses a bounded queue, and overflow drops the oldest;
  - the terminal keeps today's output-window rule (`DAEMON_PTY_OUTPUT_MAX_SOURCE_FRAMES`).
- Live traffic never delays control-plane frames, so the stream budget stays separate (Amendment 1 D11).

### D25. Conformance suite (one harness, every kind)

Each kind runs these cases, with a fake daemon where the kind has `producer: daemon`:
1. Subscribe gives a snapshot first, then updates in order.
2. Two subscriptions to one key from one runtime make one server subscription; the last release unsubscribes.
3. With no subscriber, the producer is stopped (a daemon kind receives `topicWatch off`) and nothing is published (counted over a sampling interval).
4. Disconnect then reconnect: values become `unknown` and then the current value; logs resume from their position with no loss and no duplicates.
5. A daemon restart with subscribers present re-sends `topicWatch on`, and updates resume.
6. A server restart: logs get `epoch` changed, then a reset snapshot with `hasOlder`.
7. A forced gap (one dropped log frame) is detected, and the client recovers by resubscribing.
8. Revoking visibility closes the key with `revoked`. A refused subscribe looks like a missing key.
9. Overflow: values coalesce; logs close with `overflow` and recover.
10. Rate: the server never sends faster than the declared rate.
11. Producer lifecycle: `start` runs once on the first subscriber and `stop` on the last, including across a reconnect storm, and a session producer releases the live runtime after `stop`.
12. Latency: during a simulated feed catch-up, topic frames reach the consumer within the D20 target.

### D26. The initial topic table

| Kind | Style | Producer | Rate | Today | Moves in |
|---|---|---|---|---|---|
| `machine.condition` | value `{online, since}` | server | on change, at most 1 per s | `machinesChanged` / health | POD-5800 |
| `machine.metrics` | value (CPU, memory, load, disk, loop) | daemon | 1 per 5 s | `hostMetricsChanged` broadcast | POD-5800 |
| `machine.processes` | value (memory breakdown, reclaimable) | daemon | 1 per 5 s | `hosts.memoryBreakdown` polled | POD-6645 |
| `account.quota` | value (quota, usage, "used up until") | server (its sampler runs while subscribed, plus the history timer) | on change, at most 1 per s | 60 s polls | POD-5798 |
| `checkout.changed` | value, version only (a "changed" notice) | daemon (file watcher on HEAD, the index and the working tree, with ignore rules) | 1 per s | polling or refetch | POD-6645 |
| `account.events` | event (attention, openUrl, openUrlResult, serverRelocation, setLogLevel) | server | — | one-off frames | POD-5800 (moved), POD-6680 (old frames removed) |
| `presence` | room (Amendment 1) | server | 30–60 Hz per member (D11) | rooms (exist) | naming aligned in POD-5800 |
| `session.transcript` | log of item versions | server (the session's transcript buffer) | coalesced per frame | `transcriptSubscribe` + 400 ms refresh + heartbeat probe | POD-6679 (last) |
| `session.preview` | value: the snapshot, apply-if-newer on `(turnEpoch, seq)`, plus `afterSeq` | daemon (start = today's fine watch) | about 30 Hz, server-coalesced | `turnPreview` + `runtimeWatch` | POD-6679 (last) |
| `session.activity` | event (headless turn events) | daemon | — | `headlessActivity` | POD-6679 (last) |
| `session.terminal` | log of output frames (binary envelope) | server (the session's output window, fed by the daemon) | today's output pacing | `attach`/`outputFrame` | POD-6679 (last) |
| `session.terminalState` | value `{controller, geometry, exit?}` | server | on change | `attached`, `controllerChanged`, `geometry`, `agentExit`, `terminalOutcome` | POD-6679 (last) |
| `session.draft` | value `{text, rev, origin, editedAt}` | server | at most 10 per s | `sessionDraftChanged` | POD-6679 (last) |

### D27. Transcript, preview, terminal and draft (designed now, moved last)

- **Transcript.**
  - Subscribing without a position gives a reset snapshot: the newest window of 200 items, plus `hasOlder`.
  - Subscribing with a position inside the server's buffer replays only what follows it.
  - Older history comes from the device store (POD-5801), then the bulk `transcriptRead`.
  - Item updates are later log entries carrying the same item id; the conversation's `byId` replaces that one entry, so only that row redraws.
  - The client has no timers: the 400 ms refresh and the live heartbeat probe are deleted, and gaps are found by position.
- **Preview against the transcript.** The two topics are not ordered against each other, so every preview snapshot carries `afterSeq`: the transcript position it extends, stamped by the server when it forwards the preview. The client draws the preview rows after the transcript entry at `afterSeq` and hides any preview item whose id is already in the transcript. `done` clears that epoch's preview. This replaces today's "send the preview after the replay" ordering, which only holds on one socket.
- **Demand.**
  - `session.preview` with subscribers is today's `runtimeWatch fine`; with none, it is `coarse`.
  - The durable transcript keeps flowing from the daemon to the server as today; its topic is server-produced from the server's buffer.
- **Terminal.**
  - `subscribe(session.terminal, from: {epoch, seq})` is today's `attach{sinceSeq}`. The snapshot's `reset` flag is today's `resumed: false`.
  - Controller and geometry are a separate value topic.
  - Input, resize and control requests stay commands.
  - The binary envelope keeps today's speed.
- **Draft.**
  - `session.draft` is a value topic with the server's revision.
  - Edits stay the `draftEdit{baseRev}` command, so a dirty local draft keeps winning on its own device (the draft ledger rule).
  - The checkpoint on the session record stays (Option A, 2026-11-08).
- **Daemon restart mid-turn:** re-demand (D21) restarts the fine watch. The transcript log continues in the same epoch, and the preview resumes on the next snapshot.
- **Server restart:** new epochs. Clients get reset snapshots, and the device store keeps their history.
- **Several tabs:** each runtime holds its own subscription; the registry dedupes the daemon demand.
- **Phone in the background:** the OS suspends the socket. On resume the client reconnects and resubscribes with its positions, so logs resume and values refresh.

### D28. What is not a topic

- **Request answers** stay requests: files, diffs, search, history pages, costs, setup.
- **Update status** stays on plain HTTP, outside sync and topics (POD-6683), because it must work while the socket or sync is down.
- **Synced records** stay on the feed.
- **Connection health** is the client's own observation; it is written into the LiveStore and is not a topic.

## 3. Migration

1. **Core, capability-gated (POD-5800):** `topics.ts`, the frames, registry use, daemon watch registry, re-demand, client handles and the conformance harness. First kinds: `machine.condition`, `machine.metrics`, `account.events` (moved onto `topicEvent`, with the old frames as fallback for peers without the capability), and `presence` (naming aligned).
2. `account.quota` (POD-5798).
3. `machine.processes` and `checkout.changed` (POD-6645).
4. After phases 1–3 have run in production and the operator calls them robust: `session.*` (POD-6679), with its own rollout. Each kind is switched by capability, and the old frames stay as the fallback until it is proven.
5. Floor raise and deletion of the old frames (POD-6680).

## 4. Consequences

**Gains:**
- One way to keep anything live.
- Nothing is produced without a viewer.
- Gaps are detected instead of polled for.
- Revocation closes live views.
- The chat stops refreshing on activity.

**Costs:**
- A new frame family and a binary envelope.
- Every daemon must advertise `topics.v1` before the old frames go.
- The transcript gains server-assigned positions.
- Every update carries a position.

**Risk:** the chat and terminal path is the core of the product. That is why it moves last, behind a capability, with the old frames as fallback until proven.

## 5. Open questions answered

| Question | Answer |
|---|---|
| Where the kind set lives | `packages/protocol/src/planes/topics.ts`, with a totality test |
| Log positions | server-assigned `(epoch, seq)` per key |
| Cost of app-lifetime topics | `machine.condition` × machines (a handful) + one `account.quota` + one `account.events`: small, and on change only |
| Phone in the background | reconnect, then resubscribe with positions |
| Several server instances later | keys are location-free strings; routing stays in one process for now |

## 6. Precedent

| System | Shape | What we take | What we leave |
|---|---|---|---|
| **Kubernetes watch** | list (snapshot) + watch from `resourceVersion`; a too-old version gets `410 Gone`, and the client relists | snapshot then changes; resume from a position; "too old" means a reset snapshot (D19) | — |
| **Centrifugo** | channels; history with **offset + epoch**; recovery on reconnect from the last offset; an epoch change means the history was lost | exactly our log position `(epoch, seq)` and the reconnect recovery | its server-side history store (our buffers already exist) |
| **Phoenix Channels** | topics `kind:id`, join with parameters, push, presence on the same socket; one multiplexed connection | topic keys, join = subscribe with a position, presence alongside | channel processes per topic (not our runtime) |
| **graphql-ws subscriptions** | subscribe / next / complete / error over one socket | one generic frame family with a lifecycle | a query language per subscription |
| **Ably / Pusher** | channels; "rewind" and connection-state recovery by serial; presence channels | the same recovery idea; presence as a room | — |
| **Firebase listeners** | listener gets the current snapshot, then changes; `.info/connected` tells the app it is offline | snapshot-first; values go "unknown" when disconnected (D20) | — |
| **Meteor DDP** | sub / ready / added / changed / removed; the server tracks subscriptions per connection | the per-connection subscription and its release on close | merging documents into a client cache: that is our sync feed's job, not topics' |
| **Kafka, Redis Streams, NATS JetStream** | ordered logs with offsets; consumers resume from an offset | offsets as the resume point | durable retention; our logs are bounded windows, and history comes from a request |

**Where we are deliberately simpler:**
- **No topic history store.** A log's window is whatever its producer already keeps (the transcript buffer, the terminal output window). Anything older comes from a request.
- **Three styles, not a schema system.**
- **Topics never carry synced records.** Lasting state stays on the sync feed (ADR 12), so there is never a second copy to reconcile, unlike DDP and Firebase, which use subscriptions for data too.
