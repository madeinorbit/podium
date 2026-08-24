# POD-2293 — Stream agent replies in the chat view

**Status:** spec for operator review (phase 1; no implementation in this issue's session).
**Baseline:** epic tip `35790f0ca` on `issue/1761-agent-runtime`. Every file/line cite below is at that commit.
**Problem:** assistant replies appear in the chat view only when the item is complete. All three headless drivers already receive token-level incremental output at the protocol level and already emit contract-level delta events — but those deltas are dropped one hop above the driver and never reach the web plane.

---

## 0. Summary of the existing machinery and the actual gap

The contract already models streaming:

- `TranscriptItemDelta` is a union of `{ kind: 'complete'; item: TranscriptItem }` and `{ kind: 'delta'; itemId: string; textDelta: string }` (`packages/agent-runtime/src/events.ts:95-97`), carried as the `t: 'item'` arm of `RuntimeEventBody` (`events.ts:62-76`) under the causal envelope (`events.ts:28-41`: `at`, `provenance`, `cursor`, `observerGeneration`, `turnEpoch`).
- Fine-grained watching is a first-class capability: `WatchLevel = 'coarse' | 'fine'` (`events.ts:105`), `handle.watch(level)` (`packages/agent-runtime/src/driver.ts:73-76`), declared per driver in `ObservationCapability.watchLevels` (`packages/agent-runtime/src/capabilities.ts:77-82`). opencode, codex, and grok-acp all declare `['coarse','fine']`; terminal declares `['coarse']` only, with the explicit rationale that a PTY produces bytes, not tokens (`drivers/terminal/capabilities.ts:114-118`).
- All three headless drivers already emit `{kind:'delta'}` when `session.watchers.fine > 0` (details in §1).

The gap is exactly two places downstream:

1. **Nobody acquires a fine watch.** The only `watch('fine')` caller in the repo is a test (`terminal-driver.test.ts:1448`).
2. **The daemon translators drop deltas.** `apps/daemon/src/runtime/opencode-driver.ts:141-155` forwards only `kind === 'complete'` items as `transcriptDelta` ("the durable transcript path has never carried partial items"); codex-driver and grok-driver do the same.

So this feature is not "add streaming to the drivers" — it is: acquire fine watch, carry the delta across daemon→server→client on a new live-only plane, and render it. The design below keeps the durable transcript path untouched.

---

## 1. Protocol inventory per driver (at `35790f0ca`)

### 1.1 opencode-server (SSE)

- Transport: `GET /event` SSE with hand-rolled reconnect + high-water mark (`packages/agent-runtime/src/drivers/opencode/client.ts:251-263`, `drivers/opencode/sse.ts`).
- Relevant arms (`drivers/opencode/protocol.ts:239-295`): `message.part.updated` `{sessionID, part, time?}` and `message.part.delta` `{sessionID, messageID, partID, field, delta?}`. The delta arm carries **no timestamp**; `eventTimeMs()` falls back to SSE arrival time (`protocol.ts:381-411`).
- Ingest (`drivers/opencode/runtime.ts:369-448`): `message.part.updated` re-emits the whole part as `{kind:'complete'}` items on **every** update (so opencode already streams "growing complete items"); `message.part.delta` (`runtime.ts:392-419`) is gated on `session.watchers.fine > 0`, filters `field !== 'text'` and empty deltas, and emits `{kind:'delta', itemId: event.properties.partID, textDelta}`.
- Ordering: no provider ordinal; driver-local `seq` in the cursor (`runtime.ts:327-338`), journal high-water mark persisted per emit (`runtime.ts:342-356`).
- **Identity hazard:** `deltaItemIdOf` (`drivers/opencode/map.ts:76-93`) documents that the join key between a delta and its complete item must be the stamped **cursor** (opencode item ids mutate as text grows), yet the runtime emits the raw `partID` as `itemId` (`runtime.ts:406`). The complete item's identity is the stamped cursor `(timeUpdated, partId, sub)` from `packages/transcript/src/source.ts:70-100`. A consumer cannot join deltas to items by `itemId` for opencode today. §2.3 resolves this.
- Turn boundaries: busy edge on `session.status` opens (`runtime.ts:414-432`); `session.idle`/`session.error` → `closeTurn` (`runtime.ts:648-710`) with the absorbing fence `if (turnEpoch <= fencedTurnEpoch) return` (`runtime.ts:657-658`).

### 1.2 codex-app-server (streaming JSON-RPC)

- Consumed notifications (`drivers/codex/protocol.ts:389-400`) include `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta` (`{threadId, turnId?, itemId, delta}`, `protocol.ts:360-368`).
- Server-side suppression: the handshake opts out of `DELTA_NOTIFICATIONS` (`protocol.ts`) — but **only of the fragment kinds the driver has no ingest arm for** (`item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`, `item/plan/delta`), and at every level. `item/agentMessage/delta` is never muted, and the fine level is a per-viewer refcount checked in `ingest` like opencode's and grok's.

  **This is a correction to what this section originally said, and POD-2745 is why.** The handshake used to mute `item/agentMessage/delta` at coarse, which made upgrading to fine a RECONNECT: single-flight, refused while busy or with asks outstanding, respawn plus `thread/resume`, and deliberately never downgraded. A reconnect abandons an in-flight turn and any outstanding approval, so the refusal was correct — and its consequence was that the turn a viewer opened the chat DURING never streamed. A session started with an `initialPrompt` is busy from its first moment, so that was the first turn of every session and the only one most people watch closely; the feature read as not working rather than as having an edge case. Muting at the server was always the second of two gates (the first being `watchers.fine`, checked before a fragment costs a `seq`, an emit or a journal write), so dropping it cost only local pipe bytes on an unwatched session and deleted the whole upgrade path. Measured after the change, on a live instance: a viewer joining 8.5s into a running turn saw the reply grow through 50 distinct sizes, 52 → 2959 characters; the same drive on the pre-change driver recorded 0 previews in 444 samples.
- Ingest: `item/agentMessage/delta` (`runtime.ts:476-503`) gated on fine watchers, emits `{kind:'delta', itemId, textDelta}` where `itemId` **is** the stable `msg_…` id that the later `item/completed` carries (`runtime.ts:492-497`) — direct reconciliation works. Only `item/completed` becomes `{kind:'complete'}` (`runtime.ts:453-473`).
- Ordering: driver-local `seq` only (`runtime.ts:363-375`). Turn close is deduped by `fencedTurnIds: Set` (`runtime.ts:289`, `705-706`).

### 1.3 grok-acp (ACP `session/update` over stdio JSON-RPC)

- Frames: `session/update` / `_x.ai/session/update` with `params._meta.eventId` and `agentTimestampMs` (`drivers/grok-acp/protocol.ts:109-125`). `grokAcpEventOrdinal` extracts the trailing integer of `eventId` as a **monotonic provider ordinal** (`protocol.ts:166-172`); frames with no derivable ordinal are dropped entirely (`drivers/grok-acp/runtime.ts:441`).
- Ingest (`runtime.ts:327-425`): `agent_message_chunk` accumulates into `session.assistantBuffer`; when fine watchers exist it also emits `{kind:'delta', itemId: buffer.id, textDelta}` (`runtime.ts:365-380`) where `buffer.id = grok-assistant-<eventId of first chunk>` — the same id the eventual flushed `{kind:'complete'}` item carries (`flushAssistant`, `runtime.ts:285-297`). Identity is already consistent.
- Cursor is the only one with a real provider ordinal: `components: {event: providerEventSeq, seq}` (`runtime.ts:185-189`).
- Turn boundaries: driver opens the turn on `startPrompt` (`runtime.ts:743-782`); close is the `session/prompt` RPC resolution in `finishPrompt` (`runtime.ts:692-741`), fenced on `openTurnEpoch` (`runtime.ts:698`). `watch()` is a pure refcount — grok streams on the wire regardless; the driver filters in user space (`runtime.ts:1060-1068`).

### 1.4 Cross-driver facts the design must respect

- No driver coalesces deltas: each fragment is `seq += 1` + log push + wake wakers + **journal write** (opencode `runtime.ts:301-324`, codex `runtime.ts:338-361`, grok `runtime.ts:203-227`). Per-token journal writes are a real cost once fine watch is on (§8, OQ-3).
- The per-session in-memory event logs are bounded (`OPENCODE_EVENT_LOG_LIMIT = 512` etc.); a delta burst can evict coarse events from the reconnect-replay window (§8, OQ-4).
- Fencing/absorb differs per driver (opencode persisted `fencedTurnEpoch`; codex in-memory `fencedTurnIds`; grok `openTurnEpoch` compare) but is uniform at the contract level: a closed turn epoch never reopens or re-emits terminals (conformance suite `packages/agent-runtime/src/testing/conformance/suite.ts:742-808`).

---

## 2. Normalization point: the RuntimeEvent shape

### 2.1 Keep `TranscriptItemDelta` as-is — deltas, not snapshots, at the contract layer

The event shape already exists (`events.ts:95-97`) and all three drivers emit it. **Proposal: do not add a new RuntimeEvent variant.** The contract-level unit of streaming remains `{kind:'delta', itemId, textDelta}` under the causal envelope, with these semantics made explicit in the doc comment:

- **Deltas are live-only and lossy by design.** They are never journaled as transcript content, never replayed on `'bootstrap'`, and a consumer must render correctly having missed any prefix of them (the reconciliation rule in §2.3 makes this safe).
- **Ordering** is the envelope's per-session `cursor.components.seq` — already strictly monotonic per driver session and already what `handle.events(after)` resumes on. No new ordinal is needed; grok's provider `event` ordinal stays an internal detail.
- **Turn attribution** is `turnEpoch` on the envelope. A delta whose `turnEpoch` is ≤ the consumer's last-seen fenced epoch is stale and must be discarded — the consumer-side mirror of the drivers' absorbing fence (POD-2129 semantics: "once a turn epoch is closed it does not reopen", `events.ts:39-40`).

### 2.2 Turn-boundary reconciliation rule

For consumers (daemon translator, server, web):

1. Accumulate `textDelta` per `itemId` into a *partial item* keyed `(turnEpoch, itemId)`.
2. On `{kind:'complete'}` for a joinable id (§2.3): **replace** the accumulation with the authoritative item text. The complete item always wins; accumulated text is only ever a preview.
3. On `{t:'turn', ev:'completed'|'failed'}` for that epoch, or on any receipt/terminal that fences the epoch: drop all partial state for the epoch. The durable `transcriptDelta` path delivers the final items independently, so nothing is lost — the partial was purely cosmetic.
4. Never resurrect a partial for a fenced epoch (absorb).

This rule means correctness never depends on delta delivery — matching the existing invariant that the durable transcript path has never carried partials (`apps/daemon/src/runtime/opencode-driver.ts:141-155`).

### 2.3 Fix the opencode delta identity (required pre-work)

codex and grok deltas already share identity with their complete items; opencode's do not (§1.1). **Proposal:** make opencode's runtime emit `itemId` values that join to the complete items it emits, using the already-written-but-unused `deltaItemIdOf` (`drivers/opencode/map.ts:76-93`) — i.e., the delta's `itemId` becomes the same stamped identity the corresponding `{kind:'complete'}` item carries, with `sub` handling multi-item parts. This is a driver-internal change; the contract shape is untouched. Add a conformance property for it (§7).

Fallback if the cursor join proves awkward: consumers key partials by `(turnEpoch, itemId)` and treat opencode's growing `message.part.updated` → `{kind:'complete'}` re-emissions as the reconciliation signal (they arrive per-update anyway), tolerating the id mismatch by replacing the *newest* partial in the epoch. This works but is heuristic; the identity fix is strongly preferred.

### 2.4 Wire mirror

`packages/protocol/src/messages/runtime.ts:845-852` already mirrors `TranscriptItemDelta` in zod, including the `delta` arm — no protocol schema change needed at the runtime-event layer.

---

## 3. Transport: daemon → server → client

### 3.1 Existing planes (apps/server/src/modules/sessions/)

- **Durable chat items:** `transcriptDelta` frames, daemon (`apps/daemon/src/session-observers.ts:1044-1060`, `1181-1191`) → `daemon-mux.ts:122` → `daemon-projection.ts:131-167` → `terminal.ts:270-290` `applyDelta` fan-out to `transcriptSubscribers` (`terminal.ts:289`, no coalescing) → `socket-hub.ts:1049-1080` → `useTranscriptWindow.ts:352`.
- **Runtime events:** `RuntimeEventMessage` (`packages/protocol/src/messages/runtime.ts:1145-1151`) → `daemon-lifecycle.ts:730-741` → `runtime-gateway.ts:251-276`, which keeps only a bounded diagnostic tail plus an `onEvent` listener fan-out. It does not reach clients.
- **Headless streaming (the template):** `HeadlessActivityEvent` (`partial-text`, `status`, `turn-start`, `turn-end`; `packages/protocol/src/messages/headless.ts:22-38`) broadcast to all clients, rendered by the chat overlay (`use-headless-turn.ts:101-140`, `TranscriptFeed.tsx:488-508`). Live-only, nothing replayed.

### 3.2 Proposal: a `turnPreview` snapshot plane (not raw delta forwarding)

Do **not** forward per-token RuntimeEvents to browsers. Instead the **daemon** becomes the accumulator (it is the first hop that owns per-session state and the reconciliation rule of §2.2), and emits a coalesced snapshot frame:

```
type TurnPreviewFrame = {
  type: 'turnPreview'
  sessionId: string
  turnEpoch: number
  seq: number                    // envelope cursor seq of the last folded event
  items: Array<{ itemId: string; text: string }>   // full accumulated text per streaming item, in arrival order
  done?: boolean                 // terminal frame: clear all preview state for this epoch
}
```

- **Snapshot, not delta, on the wire.** Each frame carries the full accumulated preview text. This makes the plane self-healing: a dropped or reordered frame costs nothing (apply-if-newer by `(turnEpoch, seq)`), reattach needs no replay protocol, and multi-client fan-out needs no per-client cursor. Text volume per turn is bounded (a reply preview, not a terminal); at the proposed cadence the retransmission overhead is negligible and can later be optimized to prefix-deltas without changing consumers.
- **Coalescing policy:** daemon-side timer, ~10 frames/sec max per session (100 ms), leading-edge (first delta after quiet flushes immediately so streaming feels instant) then trailing coalesce. Emit a final `done: true` frame on turn fence (turn completed/failed, or the complete item covering every previewed item).
- **Server behavior:** stateless-ish relay via the sessions module — route in `daemon-frame-routing.ts` → hold the latest frame per session (single slot, newest-wins; this *is* the backpressure policy — under any slowness intermediate snapshots are simply skipped) → push to the same `transcriptSubscribers` set that already receives `transcriptDelta` (`terminal.ts:97`), so subscription lifecycle, authz (`assertMayReadSession` path), and detach cleanup (`terminal.ts:301,324`) are inherited rather than re-implemented. Unlike the headless plane's broadcast-to-all, this stays subscriber-scoped.
- **Reattach/resume:** on client subscribe, replay the single retained latest frame (if its epoch is unfenced); nothing else. On daemon reattach or session rebind, drop retained frames. Fenced-epoch frames are discarded on arrival.
- **Fine-watch lifecycle:** the daemon acquires `watch('fine')` for a session **while at least one client transcript subscription exists** for it, plumbed as a subscriber-count signal server→daemon (a small control frame alongside `transcriptSubscribe`/`transcriptUnsubscribe`, `client-control.ts:183-190`). Release with a debounce (~30 s) to avoid flapping. *(This bullet originally accepted "streaming simply begins on the next turn" as the cost of codex's upgrade-is-a-reconnect constraint. The operator rejected that: the turn it skipped was the first turn of every session. POD-2745 removed the constraint instead — the level is now live the moment `watch()` resolves, on every driver, so there is no deferral left to accept.)*

### 3.3 Why not extend `transcriptDelta`

Folding partials into `transcriptDelta` would violate the plane's core invariant (durable, complete items only, merged by cursor into the authoritative window — `chat.ts:114 mergeByCursor`), force cursor semantics onto ephemeral text, and risk partials leaking into the offline replica cache seeded at `useTranscriptWindow.ts:328-336`. A separate ephemeral plane keeps the blast radius at zero for everything that exists.

---

## 4. Chat-view rendering (apps/web)

### 4.1 Rendering the partial turn

Generalize the existing headless overlay rather than inventing a new surface:

- New hook `useTurnPreview(sessionId)` mirroring `use-headless-turn.ts:101-140`: subscribes to `turnPreview` frames via the hub, holds `{turnEpoch, items[]}`, applies newest-wins by `(turnEpoch, seq)`.
- `TranscriptFeed` renders the preview as a trailing pseudo-row in the position the assistant block will occupy, reusing `StreamingMarkdown` exactly as the headless overlay does (`TranscriptFeed.tsx:488-508`). Preview rows are visually marked in-progress (the `TranscriptTail` working treatment moves onto/below the row; `trailingRunIsLive` deferral at `TranscriptTail.tsx:90-99` extends to cover a live preview row).
- **Clearing:** the preview clears when (a) a `done: true` frame arrives, (b) the real assistant item lands via `transcriptDelta` and the merged window now contains an assistant item for that epoch (same "transcript grew" heuristic the headless overlay uses, `use-headless-turn.ts:143-149`), or (c) the session's `agentState` leaves working with no frame for >N seconds (staleness guard). Whichever comes first; the durable item always replaces, never appends after, the preview.
- Do **not** route preview text through the transcript worker pipeline (`transcript-compute.worker.ts`) — it re-renders at 10 Hz; `StreamingMarkdown` on the main thread is the proven pattern.
- Scroll: preview growth participates in the existing jump-to-bottom/pinning logic like the headless overlay does today; no new scroll behavior.

### 4.2 Error / interrupt states

- **Turn failed / interrupted:** on `done: true` (or tail mode `error`/`interrupted`, `TranscriptTail.tsx:53`), if no durable assistant item supersedes the preview within the staleness window, fade the preview out rather than snapping — the durable transcript is the record; a failed turn's partial text disappears with the tail showing the failure state. (Alternative — keep the orphaned partial greyed with an "interrupted" chip — recorded as OQ-5.)
- **Reconnect/offline:** on socket loss, drop preview state immediately (it is live-only); the offline path (`useTranscriptWindow.ts:355-374`) is unaffected.
- **Interrupt affordance:** unchanged — interrupts flow through the existing paths; the preview just reflects the outcome.

---

## 5. Degraded / PTY sessions — out of scope, no regression

- The terminal driver declares `watchLevels: ['coarse']` (`drivers/terminal/capabilities.ts:114-118`); the daemon must gate fine-watch acquisition and `turnPreview` emission on the capability declaration, so PTY/degraded sessions produce no frames and take no new code paths.
- The chat view's liveness for those sessions stays the `TranscriptTail` spinner driven by `agentState` on the metadata plane (`packages/client-core/src/viewmodels/slices/chat.ts:637-648`). `useTurnPreview` renders nothing when no frames arrive — zero behavioral delta.
- Conformance keeps asserting terminal's coarse-only declaration (`drivers/terminal/terminal.test.ts:77`).

---

## 6. Staged delivery — recommendation

**Stage A (recommended first ship): the `turnPreview` snapshot plane at ~10 Hz, as specified in §3.2/§4.** This is *not* the "cheap periodic snapshot of turn-in-progress" strawman (polling `snapshot()` on a timer) — that alternative would poll per session regardless of activity, add driver-API load, and still need all the same rendering work. The snapshot-*frame* design already gives per-token-driven updates with delta-level latency at snapshot-level robustness.

**Stage B (optional, later): prefix-delta frames** (`{turnEpoch, itemId, offset, append}` with snapshot fallback on gap) if profiling shows snapshot retransmission cost matters for very long replies. Consumers built for Stage A need only an "apply append at offset, else request/await next snapshot" branch. Likely never needed.

Ordered slices for the implementer:

1. opencode delta identity fix + conformance property (§2.3, §7) — independently landable.
2. Daemon: fine-watch lifecycle + accumulator + `turnPreview` emission (capability-gated), behind a feature flag.
3. Protocol + server relay (latest-frame slot, subscriber-scoped fan-out, replay-on-subscribe).
4. Web: `useTurnPreview` + feed preview row + clear/error handling.
5. Flag default-on after soak.

---

## 7. Test strategy per layer

**Conformance corpus (packages/agent-runtime/src/testing/conformance/)** — the corpus currently asserts nothing about `kind:'delta'`/fine watch; add a property group, exercised via `describeDriverConformance` against all three headless drivers' fake servers (`drivers/*/test-support/`) and the fake driver:

- fine watch on → assistant output yields ≥1 `{kind:'delta'}` before the `{kind:'complete'}`; coarse → zero deltas.
- **delta/complete identity join:** every delta's `itemId` joins to a complete item emitted in the same turn epoch (this is the property the opencode fix makes true; permitted-failures entry until fixed, per the `permitted-failures.ts` pattern).
- concatenated `textDelta`s form a substring/prefix-consistent view of the complete item's text (exact-prefix where the driver guarantees it; codex/grok fixtures say exact).
- deltas carry the open `turnEpoch`; no delta is emitted for a fenced epoch (extends the absorb group at `suite.ts:742-808`).
- watch refcount: release → emission stops (grok/opencode); codex upgrade-while-busy is refused then succeeds when idle (extend `codex/runtime.test.ts:312-320`).
- Fixture additions: codex `__fixtures__` turn with `item/agentMessage/delta` sequences; grok `live-frames.jsonl` chunk runs; opencode part-delta bursts including a `field !== 'text'` frame and an empty delta (both must be dropped).

**Daemon (apps/daemon):** unit-test the accumulator against scripted RuntimeEvent sequences — coalescing cadence (fake timers: leading edge, ≤1 frame/100 ms, trailing flush), reconciliation (complete replaces accumulation), fence discard, `done` emission, capability gating (terminal session → no acquisition, no frames), watch acquire/release debounce.

**Server (apps/server):** module test that a `turnPreview` frame from the daemon reaches only transcript subscribers of that session, latest-frame slot replays on subscribe, fenced/stale frames are dropped, and slot is cleared on detach/reattach. Assert the `transcriptDelta` path is byte-identical with the feature off and on (no-regression guard for §5).

**Web (apps/web):** component tests for `useTurnPreview` (newest-wins ordering, clear-on-done, clear-on-durable-item, staleness guard) and `TranscriptFeed` preview row (spinner deferral, replacement-not-duplication when the real item merges — the duplication case is the one users would notice). Reuse the headless-overlay test patterns.

**End-to-end:** one integration test per driver family against the fake servers driving daemon→server→client, asserting a browser-visible preview grows and is replaced by the durable item with no duplicate row.

---

## 8. Open questions (each with a recommendation)

- **OQ-1 — Delta vs snapshot on the wire.** Decided above as snapshot frames (§3.2/§6); recorded here because the brief asked for the delta option explicitly. *Recommendation: snapshot frames (Stage A); prefix-deltas only if profiling demands (Stage B).*
- **OQ-2 — Fine-watch lifecycle: subscriber-driven vs always-fine.** *Settled, and the framing was the thing that needed fixing (POD-2745).* The question conflated two costs that turn out to be separable: the WIRE (does the fragment reach the driver?) and the EMISSION (does the driver spend a `seq`, an emit and a journal write on it, and forward it to the daemon?). Subscriber-driven is right for the second and always the answer — that is what "fine must not stay on with nobody watching" means, and it is enforced by the `watchers.fine` guard in every driver's ingest. It was wrong for the first on codex, because expressing it through `optOutNotificationMethods` pinned the level to the connection and made the upgrade a reconnect. So: **always-on wire, subscriber-driven emission, on all three drivers.** The residual waste on an unwatched codex session is local IPC between two processes on one host — about 200 bytes of JSON-RPC envelope per fragment, and reasoning fragments, which are the bulk of what codex emits, stay muted at every level because nothing parses them.
- **OQ-3 — Per-token journal writes.** Every delta currently triggers `persist(session)` in all three drivers (§1.4). Under fine watch this multiplies journal I/O by token count. *Recommendation: skip the journal write for pure delta emissions (the journal stores a seq high-water mark, not content; a crash losing delta seqs only widens the reconnect re-bootstrap, which is already the documented fallback — opencode `runtime.ts:172-175`). Do this in the same change that turns fine watch on; verify with the conformance cursor-monotonicity group (`suite.ts:852-924`).*
- **OQ-4 — Delta pressure on the bounded event logs.** A delta burst can evict coarse events from the 512-entry reconnect window, forcing consumer re-bootstraps. *Recommendation: exclude `kind:'delta'` events from the retained log (they are live-only by definition; iterators still receive them when connected). Cheap, and preserves the coarse replay window exactly.*
- **OQ-5 — Orphaned partial on failure/interrupt.** Fade out (§4.2) vs keep greyed with an "interrupted" chip. *Recommendation: fade out for v1 — the durable transcript is the record and a kept partial invites confusion about whether the agent "said" it; revisit if users report losing context on interrupts.*
- **OQ-6 — Reasoning/plan deltas.** Codex opts out of `item/reasoning/*` and `item/plan/delta` and has no parse arms for them (§1.2). *Recommendation: out of scope; assistant `textDelta` only. The frame shape (per-item map) leaves room to add typed preview items later.*
- **OQ-7 — Which clients see previews.** Subscriber-scoped (§3.2) vs the headless plane's broadcast-to-all. *Recommendation: subscriber-scoped — it inherits authz and lifecycle from the transcript subscription and avoids streaming reply text to clients that never opened the session.*
