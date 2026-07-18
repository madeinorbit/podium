# First-principles session reattachment

Status: proposal for human review; no implementation is authorized by this document
Issues: POD-997, POD-1015
Date: 2026-07-18

## Decision in one paragraph

Reattachment is state restoration, not event playback. Podium must durably store the last accepted provider binding, current turn snapshot, terminal fence, provider cursor, and observer-generation fence for each session. On spawn, resume, or daemon reattach, the provider adapter folds all history through a captured boundary into exactly one bootstrap snapshot; the observer starts strictly after that boundary. The server may use a newer bootstrap snapshot to restore current display state, but only a cursor-new, current-generation, causally valid **live transition** may advance live recency, emit `session.phase`, wake a parent, notify a human, arm auto-continue, or change hibernation candidacy. A settled turn is closed: late output from that turn is diagnostic data, not evidence of a new turn.

This is deliberately stronger than changing `size - 128 KiB` to EOF. EOF fixes the immediate Codex/Grok replay, but without a durable checkpoint, generation fence, and terminal turn fence the same class of false transition can return through duplicate hooks, rotation, delayed tool events, or a stale daemon connection.

## Scope and non-goals

This proposal defines the causal state contract shared by Claude Code, Codex, and Grok, while leaving provider semantics inside each adapter as required by [spec:SP-8b0e]. It covers interactive sessions, daemon/server restart, hibernation/resume, side-effect gating, migration, and verification.

It does not:

- implement the observer changes;
- make PTY output a provider run-state signal;
- infer provider-specific completion in the shared server;
- make a debounce or inactivity timer responsible for correctness;
- replace the explicit stop mechanism from POD-954/POD-985; or
- authorize POD-955 auto-reap before its separate safety policy is agreed.

## First principles and invariants

1. A provider's native transcript, update stream, and hooks are evidence about the provider. They are not themselves Podium transitions.
2. Podium's durable accepted checkpoint is authoritative for what state Podium has accepted, through which provider cursor, and which effects are eligible to occur.
3. History may establish the current snapshot but may never impersonate a live edge.
4. Provider event time describes when provider activity happened. It is never an ordering key and receipt time never substitutes for a missing provider timestamp.
5. A provider cursor is ordered within an exact provider binding. Cursors from different files, threads, or sessions are incomparable until the adapter proves a segment/binding succession.
6. Every observer lease is fenced by a server-issued monotonically increasing generation. A message from any older generation is inert even if it arrives late.
7. Turn state and process lifecycle are independent. `reconnecting` is transport restoration and never means `working`.
8. A terminal turn fence is absorbing for that epoch. Only a causal new-turn signal opens the next epoch.
9. Exactly-once effects are downstream of one durable acceptance gate, not independently deduplicated guesses in each consumer.
10. Unknown or ambiguous evidence fails closed: preserve the last accepted snapshot or restore `unknown`; never manufacture `working`, `done`, or a notification.

## The three authorities

Reattachment currently conflates three different kinds of truth. The new design keeps them explicit.

| Authority | Owns | Does not own |
|---|---|---|
| Provider evidence | Native session identity, prompt/turn/tool/terminal semantics, event timestamp, native file/sequence position | Podium lifecycle, observer lease, notification delivery |
| Podium observation checkpoint | Last accepted provider binding/cursor, current turn epoch and state, terminal fence, accepted transition identity | Whether the process/durable host still exists |
| Podium session lifecycle | `starting`, `live`, `reconnecting`, `hibernated`, `exited`; process and durable-host disposition | Provider turn inference |

The durable host remains the authority for process survival during reattach, as it is today. The durable observation checkpoint becomes the authority for state continuity. Provider history is consulted to reconcile that checkpoint, but replaying history cannot create a live transition.

## Durable authoritative checkpoint

Today `apps/server/src/modules/sessions/session.ts` keeps `agentState` in memory and `apps/server/src/modules/sessions/service.ts` persists recency and cumulative working time, but `apps/server/src/store/sessions.ts` does not restore the accepted `agentState`, provider cursor, turn epoch, or observer generation. That absence forces a fresh daemon tracker to rediscover state and makes old events look new.

Add a versioned durable checkpoint per Podium session. A separate checkpoint record is preferable to widening the public `sessions` row with provider-specific columns; the public `AgentRuntimeState` remains a projection.

```ts
interface SessionObservationCheckpointV1 {
  schemaVersion: 1
  podiumSessionId: string
  provider: 'claude-code' | 'codex' | 'grok'
  providerSessionId: string | null
  bindingVersion: number

  lifecycleObservationGeneration: number
  providerCursor: ProviderCursor | null
  bootstrapCursor: ProviderCursor | null
  lastAcceptedLiveCursor: ProviderCursor | null

  turnEpoch: number
  providerTurnId: string | null
  providerPromptId: string | null
  turnState: TurnSnapshot
  terminalFence: TerminalFence | null

  providerAt: string | null
  acceptedAt: string
  lastLiveReceiptAt: string | null
  lastTransitionId: string | null
}
```

`TurnSnapshot` contains the normalized phase, verdict/need/error, `since`, cumulative working time, and active native-subagent identities. `TerminalFence` contains the epoch, terminal provider cursor or native event identity, terminal verdict, and the transition ID that settled it. Cumulative working time must continue from the durable total; it must not use the current heuristic that detects a reset daemon counter after the fact.

The checkpoint is the minimal state needed to answer all of these after a complete server and daemon restart without replaying an edge:

- Which exact provider conversation belongs to this Podium row?
- What is the current turn state and its visible detail?
- Is the current epoch still open or terminally fenced?
- Through which provider evidence has Podium already reconciled?
- Which observer lease may submit new evidence?
- Has this exact terminal transition already been accepted?

### Provider-specific minimum

The common checkpoint is specialized by a structured `ProviderCursor`; it is a scalar only where the provider supplies one.

| Harness | Durable provider identity | Snapshot evidence | Minimal cursor/turn material |
|---|---|---|---|
| Claude Code | Exact `session_id`/resume value and transcript segment identity | Fold the exact located transcript through a captured record boundary; live state thereafter comes from hooks | Transcript file identity plus byte/record boundary; `prompt_id` when present; message/tool/agent native IDs used as hook dedupe keys; Podium epoch anchored to the accepted `UserPromptSubmit` when Claude supplies no ordered turn ID |
| Codex | Exact native thread ID bound to the stable Podium session ID [spec:SP-fccf] | Fold the exact rollout through a captured EOF; reconcile native hook evidence without treating the rollout suffix as live | Rollout file identity plus record-boundary byte offset; native turn ID when present, otherwise Podium epoch anchored to the accepted `user_message`/`task_started`; hook-event identity as a second cursor component because hooks and rollout are two channels |
| Grok | Exact session directory ID/resume value | Fold `updates.jsonl` through captured EOF; consult the matching chat history only to classify the terminal verdict | Updates file identity plus record-boundary byte offset; native turn/prompt ID when present, otherwise epoch anchored to the accepted user-prompt update; normalized native timestamp retained as evidence, never used as the cursor |

File identity is at least device/inode (or the platform equivalent), path hint, provider session ID, and segment identifier. Offset alone is unsafe after truncation, rotation, resume-to-new-segment, or path reuse. The cursor must name the last complete record; a torn final line is not included until completed.

For hook channels that lack a native total order, the adapter maintains a small durable dedupe set scoped to the open/current epoch using stable native identities (`prompt_id`, tool-use/call ID, agent ID, terminal ID) plus a canonical payload fingerprint as the last resort. Receipt order is not promoted into provider order. A hook without enough identity may update diagnostics but cannot cross a terminal fence.

## Observation envelope and provenance

Do not keep overloading `AgentStateEvent` and `AgentRuntimeState` for bootstrap, live transport, durable acceptance, and public projection. Introduce an internal causal envelope; public clients need only the normalized state plus selected diagnostics.

```ts
interface AgentObservation {
  podiumSessionId: string
  provider: 'claude-code' | 'codex' | 'grok'
  providerSessionId: string | null
  providerTurnId: string | null
  providerPromptId: string | null

  observerGeneration: number
  providerCursor: ProviderCursor | null
  providerAt: string | null
  receivedAt: string

  sourceEventKind: string
  provenance: 'bootstrap' | 'live' | 'replay'
  inputOrigin:
    | 'human'
    | 'controller'
    | 'steward'
    | 'mail'
    | 'auto_continue'
    | 'system'
    | 'provider'
    | 'unknown'

  turnEpoch: number
  priorPhase: AgentPhase
  nextPhase: AgentPhase
  transitionId: string
  state: AgentRuntimeState
}
```

Every accepted or rejected transition diagnostic carries all the fields above and, when rejected, one stable `rejectionReason`. The minimum reasons are:

- `stale_observer_generation`
- `provider_binding_mismatch`
- `cursor_not_after_checkpoint`
- `duplicate_transition`
- `bootstrap_has_no_live_effects`
- `replay_has_no_live_effects`
- `terminal_epoch_closed`
- `noncausal_epoch_open`
- `unproven_segment_rotation`
- `invalid_provider_timestamp`
- `legacy_unfenced_observation`

`transitionId` is deterministic from provider binding, turn epoch, causal source identity/cursor, and normalized transition—not receipt time or observer generation. Re-observing the same provider fact under generation 42 instead of 41 therefore produces the same transition identity and remains idempotent.

## Race-free bootstrap-to-live handoff

The boundary must be a protocol, not a scheduling assumption.

1. **Fence the lease.** Before sending `spawn`/`reattach`, the server increments and durably stores the session's observation generation. The control message carries it. Frames from prior generations are rejected at the server.
2. **Preserve lifecycle and turn state separately.** A lost daemon connection changes lifecycle to `reconnecting`; it does not clear or rewrite the durable turn checkpoint. UI and consumers see `reconnecting` plus the last-known turn snapshot, never a fallback of `live/unknown -> working`.
3. **Bind exact provider identity.** The adapter must establish the exact provider session before state folding. A heuristic fresh-spawn binding may remain provisional, but it cannot replace a conflicting exact binding or emit effects.
4. **Capture a boundary.** For a file source, open the file, capture its identity and complete-record EOF `C`, and fold only records at or before `C` from that same descriptor. For Claude's hook-first path, locate and fold the transcript to `C` while buffering concurrently received hooks.
5. **Emit one snapshot.** The fold returns one `AgentRuntimeSnapshot` and cursor `C`; it never calls the live-event callback per historical record.
6. **Accept or reject atomically.** The server compares generation, binding, and cursor with the durable checkpoint. The same/older snapshot is a replay no-op. A genuinely newer snapshot may replace the stored/current display snapshot and provider recency, but it emits no live phase event or downstream effect.
7. **Acknowledge the checkpoint.** Only after the server durably commits/acks the snapshot may the observer release buffered records/hooks after `C` to the live path.
8. **Start strictly after `C`.** The file tail begins at `C`, on the same file identity. Records appended during folding are read after the ack. Buffered hooks whose causal identity is already represented at/before `C` are discarded; the rest enter the live reducer once.

If the server restarts while the daemon survives, the server issues a new generation. The existing daemon tracker rebinds to that generation and sends its current state as a bootstrap snapshot, not as a transition. Because the checkpoint is durable, the equal cursor is a no-op. If the daemon restarts, it performs the full fold above. If both restart, the result is the same.

### Truncation, rotation, `/new`, and resume

A smaller size or changed inode is not permission to restart from byte zero through the live callback. The adapter must prove one of:

- the same provider session rotated to a successor segment;
- a provider-native `/new` created a new provider session binding; or
- an explicit Podium resume/wake launched the known provider conversation into a new segment.

It then bootstraps that segment to one snapshot and begins live after its boundary. Provider `SessionStart` establishes attachment/binding; it does not itself open a working epoch.

## Two state machines, not one overloaded status

### Session lifecycle

```text
STARTING -> LIVE <-> RECONNECTING
LIVE + stable terminal proof + policy validation -> HIBERNATED
HIBERNATED -- explicit input/resume --> STARTING -> LIVE
STARTING/LIVE/RECONNECTING -- unrecoverable process loss --> EXITED
```

- `reconnecting` freezes live effects and retains the last accepted turn snapshot.
- `hibernated` retains the provider resume identity, checkpoint, terminal fence, transcript, and worktree/branch semantics. It has no observer.
- `exited` means the process/durable host is gone. The last checkpoint may remain inspectable, but the composite public state is `gone`; it must not be cleared in a way that loses the final diagnosis.
- Only explicit input/resume may leave `hibernated`/`exited`. A daemon attach scan cannot wake either.

### Turn state and terminal epoch barrier

```text
UNKNOWN/READY
  -- causal prompt N ----------------------> WORKING(N)

WORKING(N)
  -- permission/question -----------------> NEEDS_USER(N)
  -- compaction start/end ----------------> COMPACTING(N)/WORKING(N)
  -- authoritative terminal, no children -> SETTLED(N, verdict)
  -- authoritative terminal, children ---> CLOSING(N, terminal fence)
  -- fatal provider error ----------------> ERRORED(N, terminal fence)

CLOSING(N)
  -- matching subagent stop bookkeeping --> CLOSING or SETTLED(N)
  -- tool/output/activity for N ----------> rejected

SETTLED/ERRORED(N)
  -- duplicate/late event for N ----------> rejected
  -- causal prompt N+1 -------------------> WORKING(N+1)
```

`needs_user` is not terminal: a permission answer or answer-tool continuation resumes the same open epoch. `CLOSING` is internal; the current public projection may remain `working` with `awaitingSubagents` until the final scoped subagent stops. Generic late activity cannot reopen it.

A causal new-turn signal is provider-owned:

- Claude Code: live `UserPromptSubmit` for the exact session, preferably with `prompt_id`;
- Codex: one logical prompt/task start for the exact thread, coalescing hook and rollout reports;
- Grok: live user-prompt/user-message update for the exact session.

PTY redraw, terminal output, polling, `SessionStart`, daemon bind, lifecycle reconnect, and receipt time are never new-turn signals. A Podium queue/send records the intended `inputOrigin`, but the epoch opens only when the provider confirms the prompt. This avoids marking a queued-but-not-consumed message as working.

Public state is a projection of both axes, not a fallback chain:

- live + open epoch -> `working`/`needs_user`;
- live + settled done -> `done` (today: `idle` + `idle.kind=done`);
- live + ready/no completed turn -> `idle`;
- live + terminal error -> `errored`;
- hibernated -> `hibernated`, retaining last turn detail;
- exited/unrecoverable -> `gone`, retaining last diagnosis;
- reconnecting -> explicit reconnecting lifecycle with last-known turn detail, never synthesized `working`.

## The one side-effect gate

The authoritative gate belongs in `apps/server/src/modules/sessions/service.ts` at the daemon message application seam, before today's unconditional `Session.setAgentState`, persistence, `autoContinue.onStateChange`, client transition broadcast, issue activity, and `session.stateChanged` bus emit.

The gate transaction does this in order:

1. validate current observer generation and exact provider binding;
2. compare the provider cursor/vector and transition ID with the durable checkpoint;
3. enforce the turn epoch and terminal fence;
4. atomically persist the advanced checkpoint and normalized current snapshot;
5. classify the result as `snapshot_applied`, `live_transition_accepted`, `live_refresh_accepted`, or rejected;
6. emit downstream transition effects only for `live_transition_accepted`.

The daemon in `apps/daemon/src/session-observers.ts` performs the same cursor/epoch checks early to avoid wire and reducer churn, but it is not the durable authority. The server gate remains mandatory because stale daemon sockets, crash retries, and mixed versions can bypass in-memory daemon state.

| Consumer/effect | Bootstrap newer than checkpoint | Replay/same cursor | Accepted live transition |
|---|---:|---:|---:|
| Stored/current display snapshot | Yes, once | No | Yes |
| `lastActiveAt` / provider recency | Only from newer provider cursor and provider time; never receipt time | No | Yes |
| Client snapshot refresh | Yes | No | Yes |
| Durable `session.phase` edge | No | No | Yes, phase change only |
| `session.stateChanged` effect bus | No | No | Yes |
| Steward completion/ack fallback | No | No | Accepted terminal transition only |
| Parent completion nudge | No | No | Accepted terminal transition only |
| Web/ntfy/Telegram notification | No | No | Accepted transition only |
| Auto-continue | No | No | Accepted live retryable error only |
| Hibernation candidate mutation | No direct mutation | No | Terminal proof may become eligible |

`apps/server/src/modules/notify/service.ts` should append `session.phase` from the accepted transition envelope rather than comparing two unproven snapshots. Its event payload must include `transitionId`, provider/turn identity, generation, cursor, source/receipt timestamps, provenance, input origin, and prior/next phase.

`apps/server/src/steward.ts` should require an accepted-live `transitionId` before grouping completion, ack fallback, subscription, or parent-nudge work. The notification fact identity should be anchored to the terminal transition/turn, not a newly allocated event row. Existing once-until-parent-ack policy can remain; the causal ID prevents the same terminal fact from being reborn after restart. Telegram and ntfy are downstream of this same gate, not independent classifiers.

Hibernation is derived policy, not an observation side effect. A bootstrap snapshot may restore a terminal checkpoint but must not reset or instantly satisfy the idle timer. POD-1019 should require a live observer generation, unchanged terminal cursor/turn, no newer input or queued work, quiet output epoch, exact resume binding, and the same candidate signature across two evaluations, followed by an immediate pre-stop revalidation.

## Harness-specific rules

### Claude Code first

Claude is hook-driven; its transcript tail is already display/bootstrap rather than the measured live edge emitter. Its priority tranche still closes the system's most damaging amplification path.

- Fold the exact transcript into one snapshot and transcript cursor. Do not emit each transcript record.
- Carry `session_id`, `prompt_id`, tool-use ID, `agent_id`, transcript cursor, and hook kind through translation instead of discarding them in `packages/agent-bridge/src/agent-state/claude-code.ts`.
- Coalesce duplicate hooks using native IDs. When `prompt_id` is unavailable, anchor one Podium epoch to the accepted `UserPromptSubmit` plus transcript cursor; never use observer generation or receipt time as the epoch.
- `Stop`/`StopFailure` installs the epoch's terminal fence. A later `PreToolUse`, `PostToolUse`, subagent event from another prompt, or duplicate stop cannot reopen it.
- A terminal with live native subagents enters `CLOSING`; only matching subagent-stop bookkeeping may complete it.
- Scheduled self-wake remains provider-owned evidence, but it should be represented as an explicit open/scheduled state, not as generic post-terminal `activity` that can bypass the fence.
- `apps/server/src/steward.ts` may wake the Claude supervisor only from a child's accepted live terminal transition. Bootstrap, reconnect, replay, or same-terminal reobservation cannot enqueue parent input.
- Every Podium-produced prompt records origin (`steward`, `mail`, `auto_continue`, or `system`) so a real Claude turn can be traced back to the exact causal input.

### Codex second

Codex has two observation channels: native hooks and the rollout file. They must share one provider binding, epoch, and terminal fence.

- `codexBootEvents` and rollout parsing fold the exact rollout through cursor `C` into one snapshot.
- `observeCodexState` starts its live file reader at `C`, never `max(0, size - 128 KiB)`. The old tail may still be read for transcript/title/bootstrap classification, but cannot reach `onStateEvents` as live.
- The stable Podium session ID remains the pane identity; exact hook/process binding supplies the native thread [spec:SP-fccf]. A heuristic binding cannot override an exact one or emit effects during conflict.
- Hook and rollout reports of the same prompt/terminal coalesce into one epoch/transition. Hooks remain the authority for permission waits; the rollout remains a fallback state source.
- `task_complete`, `turn_aborted`, and native `Stop` close the current epoch. A trailing token/tool/agent message at the same turn cannot reopen it.
- `/new` or a hook-reported new thread changes the provider binding/segment but does not imply working; the next causal prompt opens the epoch.

### Grok third

- Fold the exact `updates.jsonl` through cursor `C`; start the live reader at `C`, never at the old 128 KiB tail.
- Persist the exact Grok session ID and updates file identity/offset. `chat_history.jsonl` supplies verdict text, not run-state ordering.
- Accept native timestamps as ISO strings, numeric epoch seconds, or numeric epoch milliseconds. Normalize once, preserve the raw value in diagnostics, reject invalid values, and never fall back to receipt time for a historical record.
- Scope `observedWork` to the durable turn epoch. `available_commands_update` may synthesize completion only for live work observed in that same open epoch; it resets neither on observer construction nor from bootstrap history.
- Background task updates remain excluded from turn state. Native structured terminal errors settle the epoch as errored [spec:SP-8b0e].
- Rotation/new session follows the same proven-binding rule as Codex; path activity alone cannot select a sibling session.

## Compatibility and staged migration

This can land additively without requiring every process and row to change at once.

1. **Protocol/schema first.** Add the versioned checkpoint storage, observer-generation field on spawn/reattach, causal daemon messages, acknowledgements, and capability negotiation. Existing nullable rows load with no checkpoint.
2. **Server acceptance gate.** Support both old `agentState` and new causal messages. Legacy frames remain visible during the transition but are marked `legacy_unfenced`; they cannot overwrite a v1 checkpoint. Once a session has accepted v1 evidence, it never downgrades.
3. **First reconciliation.** A legacy session's first v1 attach folds history into one `bootstrap` snapshot. It may establish display state and source recency, but emits zero `session.phase`, notifications, nudges, retries, or hibernation actions. This is the fleet-storm cutover boundary.
4. **Provider tranches.** Land the shared foundation/POD-1015, then Claude barrier/nudge gating (POD-1018), Codex seed-once (POD-1016), and Grok seed-once/timestamp normalization (POD-1017), preserving the human priority order.
5. **Policy consumers.** Move two-pass hibernation/auto-reap proof to POD-1019 only after causal terminal checkpoints exist. Verify restart and Telegram behavior in POD-1020.
6. **Retire legacy effects.** After all supported daemons advertise causal-state v1, reject unfenced legacy frames for effects globally; keep read compatibility for old persisted rows.

During mixed deployment, an old daemon cannot provide the guarantee and should be visibly diagnosed as legacy rather than silently treated as causal. Availability may remain, but the UI/diagnostics must not claim rock-solid detection for an unfenced session.

### Stop and resume composition

- `podium session stop` and `podium issue stop` remain explicit lifecycle commands [spec:SP-9904]. They bypass semantic-done eligibility, cancel the observer lease, and retain the observation checkpoint with the resume identity and transcript.
- A hibernation/stop process exit must not erase the last terminal checkpoint. The public lifecycle changes to hibernated/exited while the final diagnosis remains inspectable.
- Resume creates a new observer generation and performs one bootstrap reconcile. Resume itself does not create a turn; the next provider-confirmed prompt does.
- POD-955 auto-reap consumes a stable causal checkpoint and POD-954's safe stop primitive. It must never be used to hide classifier churn. Dirty-work side-store policy remains POD-955's separate obligation.

## Gap semantics: accuracy over invented edges

If no causal observer was alive—for example both server and daemon were down while a user interacted directly with a surviving PTY—reattachment can prove the latest provider snapshot but generally cannot prove the exact real-time delivery order or which side effects already occurred. The default proposed rule is:

- reconcile all gap history into one newer bootstrap snapshot;
- restore current phase and provider-time recency;
- emit zero retroactive live edges, parent nudges, or external notifications.

This is intentionally conservative: it may omit a completion notification that happened wholly inside an observation gap, but it cannot create a false storm. If exactly-once notification across a complete observer outage is required, Podium needs a durable daemon/provider live-event outbox with acknowledgements; history inference must not be relabeled `live`. That is a product choice called out below, not something to smuggle into the cursor implementation.

## Verification strategy

The core assertion is testable at every layer:

> Frozen history produces one snapshot and zero live edges under any number of observer/server/daemon generations. One genuinely live turn produces exactly one working edge and one terminal edge for one epoch.

### Shared reducer/gate model tests

- Property-test arbitrary duplicates, reordering, delayed same-epoch activity, generation changes, and cursor regressions. Once epoch N is terminal, no event except a causal prompt for N+1 may produce working.
- Apply the same transition twice with different receipt times/generations; assert identical `transitionId`, one checkpoint mutation, one `session.phase`, and unchanged recency on replay.
- Send current, stale, and future generations concurrently; only the current fenced generation can advance.
- Send mismatched provider session/file identities and unproven rotations; assert fail-closed rejection.
- Assert same-phase live activity may advance its cursor/diagnostics without manufacturing another working phase edge.
- Assert bootstrap can restore a newer snapshot but never invokes the effect bus.

### Bootstrap/live boundary tests per harness

For Claude Code, Codex, and Grok independently:

1. Create immutable native history ending in done.
2. Start observation and assert exactly one bootstrap snapshot and zero live callbacks/phase rows.
3. Recreate the observer and daemon generation repeatedly with the file unchanged; assert zero extra phase rows, parent nudges, web pushes, ntfy/Telegram calls, auto-continue actions, and hibernation-timer changes.
4. Append/emit one real prompt, work/tool activity, and authoritative terminal; assert exactly one working edge and one terminal edge with the same provider binding and epoch.
5. Replay the same offsets/hooks; assert every consumer remains unchanged.
6. Deliver late tool/output for the closed epoch; assert `terminal_epoch_closed`. Deliver a causal new prompt; assert exactly one new epoch/working edge.

Harness-specific failures:

- **Claude:** duplicate HTTP hook delivery; `Stop` followed by late `PostToolUse`; terminal while subagent is live; old child terminal replay; one real child completion produces exactly one steward parent prompt; server restart produces none.
- **Codex:** file larger than 128 KiB; append while bootstrap fold is in progress; hook and rollout report the same prompt/stop; server-only restart, daemon-only restart, both restart; `/new` thread rebind; exact-vs-heuristic binding conflict; file truncation/rotation.
- **Grok:** large frozen updates tail; numeric seconds, numeric milliseconds, ISO string, and invalid timestamp; `available_commands_update` after bootstrap history; background task completion after terminal; structured error; sibling cwd session and rotation.

### Server side-effect tests

At the `apps/server/src/modules/sessions/service.ts` acceptance seam, spy on:

- checkpoint persistence and client snapshot publication;
- `autoContinue.onStateChange`;
- issue activity/attention callbacks;
- `session.stateChanged` bus emission;
- NotifyService `session.phase`, web, ntfy, and Telegram delivery;
- steward subscription, ack fallback, and session-parent queueing; and
- hibernation candidate state.

Bootstrap/replay rejection must be asserted at this seam, not inferred from notification dedup. Notification-fact dedup remains defense in depth, not the correctness boundary.

### Restart, lifecycle, and load acceptance

- Exercise server-only, daemon-only, and simultaneous restart at each point: before bootstrap ack, after snapshot ack, between working and terminal, and after terminal.
- Race a real append/hook with bootstrap boundary capture and prove it lands on exactly one side of `C`.
- Verify `reconnecting` changes lifecycle only and neither clears nor creates turn state.
- Verify stable terminal -> two identical hibernation candidate passes -> immediate revalidation -> hibernated; new input/output/cursor between passes cancels it.
- Verify explicit resume restores the terminal snapshot silently, then a real prompt opens exactly one new epoch.
- Run an attach storm over hundreds of frozen sessions and assert bounded parsing, zero live edges, no watchdog restart feedback, and no external notification.
- Because identity, lifecycle, ownership, and independent runtimes are affected, run `bun run test:multi-instance` exactly as required by `docs/multi-instance.md`; multiple clients on one server are not a substitute.
- Drive the real Podium UI for the lifecycle path: observe a done row remain stable across restart, hibernate it, resume it, submit one prompt, and observe one working/terminal sequence. Verify the persisted row and transcript on disk after each action.

## Concrete code map

The implementation should be organized around contracts, not provider patches:

- `packages/agent-bridge/src/agent-state/types.ts`: replace bare normalized events at the observation boundary with provider identity, cursor, turn/prompt identity, timestamps, provenance, and input-origin material.
- `packages/agent-bridge/src/agent-state/reducer.ts`: add turn epochs, closing/terminal fences, cursor-aware idempotency, and explicit rejected outcomes instead of unconditional `activity -> working`.
- `packages/agent-bridge/src/agent-state/claude-code.ts`: preserve Claude causal IDs, fold one transcript snapshot, and make Stop terminal for its prompt epoch.
- `packages/agent-bridge/src/agent-state/codex.ts`: split rollout bootstrap folding from post-cursor live tailing; unify hook/rollout identity and handle segment changes.
- `packages/agent-bridge/src/agent-state/grok.ts`: split update bootstrap from live tailing, scope observed work to the epoch, and normalize numeric timestamps.
- `packages/agent-bridge/src/harness/adapter.ts` and `packages/agent-bridge/src/harness/adapters/{claude-code,codex,grok}.ts`: change the observer contract from `onStateEvents` to one snapshot plus causal deltas and cursor acknowledgements.
- `packages/protocol/src/messages/runtime-state.ts` and daemon/control message schemas: add checkpoint/snapshot/transition envelopes, generation fencing, and ack messages additively.
- `apps/daemon/src/session-observers.ts`: own the bootstrap/live handoff, per-generation tracker, buffering, early cursor/epoch rejection, snapshot vs transition wire types, and current-state resend as bootstrap.
- `apps/daemon/src/control/session.ts`: carry the server-issued generation through spawn/reattach, preserve an existing tracker as a snapshot on server reconnect, and recreate an observer without history playback on daemon restart.
- `apps/server/src/modules/sessions/session.ts`: retain normalized state as a projection of the durable checkpoint; stop inferring daemon counter epochs from decreases.
- `apps/server/src/modules/sessions/service.ts` plus session storage/migration files: allocate generations, durably load/store checkpoints, atomically accept/reject observations, separate snapshot publication from transition effects, preserve checkpoints across hibernate/exit, and remove `unknown/live -> working` fallbacks.
- `apps/server/src/modules/notify/service.ts`: create `session.phase` and external attention only from accepted live transition envelopes.
- `apps/server/src/steward.ts`: require accepted terminal transition identity/provenance for completion grouping, ack fallback, subscriptions, and parent wakes; include input origin on injected prompts.
- `apps/server/src/modules/hosts/service.ts`: consume stable checkpoint proof with two-pass/revalidated eligibility rather than raw phase plus quiet time.

## Open decisions for human review

1. **Observation-gap effects.** Recommended: silently reconcile a complete observer gap to one snapshot and send no retroactive parent/Telegram notification. Alternative: require a durable daemon live-event outbox in POD-1015 so events observed before a crash can still be delivered exactly once. Provider history alone must never be treated as live.
2. **Reconnect presentation.** Recommended: show lifecycle `reconnecting` explicitly with last-known turn detail, and make automation treat it as non-live. Alternative: keep the last phase badge visually primary, but still forbid it from implying current work.
3. **Legacy terminal sessions and auto-reap.** Recommended: allow a v1 bootstrap-reconciled terminal checkpoint to become auto-reap eligible only after two unchanged live-generation validation passes and all POD-955 safety checks, while emitting no completion effects. Alternative: require a new live terminal transition, which leaves old finished fleet sessions ineligible indefinitely.
4. **Provider ID fallback.** Recommended: when a provider exposes no stable turn ID, use a Podium monotonic epoch anchored to the provider-confirmed prompt cursor/native IDs. Do not block the whole design on providers adding IDs, and do not use timestamps as identity.

No observer implementation should begin until these decisions and the causal checkpoint contract are approved.
