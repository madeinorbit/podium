# SessionBinding: identity taxonomy on two axes

Status: **in review — revision 2** (addresses the 6 blockers of the 2026-07-30 review)
Gate: **autonomous reviewer approval** recorded in §14. Human sign-off gates are
suspended for this fan-out; this doc must not block on a signature nobody will give.
Issue: POD-414 (5.1a) · Epic: POD-323 (5.1 SessionBinding) · Programme: POD-279 Phase 5
Date: 2026-07-30

**This doc gates POD-415 (binding store), POD-416 (binding state machine), POD-417 (crash
recovery / concurrent reattach / e2e), POD-644 (adopt across handoff) and POD-737 (fold
the shipped Codex receipts spool).** No implementation code lands under POD-414.

**Authoritative inputs.** `docs/multi-user-readiness.md` (human decision 2026-07-29:
multi-user within one tenant, private by default); ADR 9
(`docs/adr/0009-identity-ownership-sharing.md`, POD-1070); the ADR 3 amendment
(POD-1073); the ADR 1 amendment (POD-1071). Where this doc appears to differ, **they
win**. Already-approved contracts that are **ratified here, not reopened**:
`docs/reattachment-design.md` (2026-07-18) and `docs/spec/conversation-registry.md`
(2026-07-02). The current-state inventory in §3.4 and §10 is sourced from POD-364's
`docs/rearch-field-schema-inventory.md` (commit `1475c062`, **merged into
`issue/279-integration`** 2026-07-30).

---

## 1. Decision in one paragraph

Session identity in Podium is **two axes that must never be collapsed into one record**.
Axis 1 is the identity of *the work*: an immutable Podium `SessionId` minted by the
server, a Podium `ConversationId` spanning native transcript segments, an **attempt
identity** minted by the daemon for each PTY or headless run, and **native-artifact
observations** — evidence records with ids, observed-at times and confidence, retained
with history, keyed by the `SessionId`, and **never identity**. Axis 2 is the identity of
*the actor*: the **principal**, which per ADR 9 D1 is `(user, device, capability)`. A
binding does not store a principal; it stores a **delegation reference** —
`(actor, onBehalfOf, grantedScope, parent)` — from which the capability half of a
principal is **resolved live at every apply**. **`SessionBinding` is one record carrying
both axes**, because ADR 9 D5/A5 decides the agent's delegation is born and retired with
its binding rather than in a parallel identity system, which is also what makes
delegation survive cross-machine handoff for free. Every native id, path, rollout,
thread, cwd and worktree is an observation about a binding; none may replace, merge, hide
or redirect a live Podium session, and none may mint or alter a delegation.

---

## 2. Why two axes, stated before anything else

| | Axis 1 — identity of the work | Axis 2 — identity of the actor |
|---|---|---|
| Answers | *Which conversation is this, and which run of it am I looking at?* | *Who is doing it, for whom, with what rights?* |
| Failure when wrong | Two panes cross-wired onto one native thread; blank transcript; a settled turn re-firing notifications; an orphaned live process | An unattended agent keeps rights its human no longer holds; handoff becomes privilege escalation |
| Evaluated | At observation time, against a durable checkpoint | **At every apply**, live, against current rights (ADR 3 D8) |
| Source of truth | Server (`SessionId`, `ConversationId`, generation), daemon (attempt), harness (native ids, as evidence) | The **authenticated transport** principal only (ADR 3 D7) |
| Stored in | `SessionBinding` §8, Axis-1 fields | `SessionBinding` §8, `delegation` field — a **reference**, never a capability |

They share a record and a lifecycle. No field of one is ever derived from the other.

---

## 3. Axis 1 — identity of the work

### 3.1 The four levels, kept strictly apart

| Level | Identifies | Minted by | Mutable? | Lifetime |
|---|---|---|---|---|
| **SessionId** | One Podium session — the pane, the row, the thing a human points at | **Server** | Never | Spawn → deletion; survives reattach, resume, hibernate, worktree move, **and cross-machine handoff** |
| **ConversationId** | One logical agent conversation spanning N native segments (`conv_<uuid>`) | **Server** | Never | Minted on first observed native conversation; gains segments on roll/resume/handoff |
| **Attempt identity** | One PTY or headless *run* on one machine | **Daemon** | Never (a new run gets a new id) | Process start → process exit; **resets on handoff** |
| **Native-artifact observation** | Nothing. It is *evidence about* the above | **Harness** (Podium only records it) | Append-with-history | Retained; superseded, never overwritten |

**W1 — `SessionId` is the only pane identity.** Every generic surface (tabs, sidebar, home
board, work items, issue counts, notifications, attribution) keys on `SessionId` and
nothing else. Already shipped doctrine: `packages/domain/src/session-identity.ts`
(`51b136fe`, [spec:SP-fccf]) keeps any resume-ref group touching a live row visible *in
full*, precisely so native metadata cannot make a live row participate in native-id
identity.

**W2 — `ConversationId` sits above native artifacts; lineage is observed, not guessed.**
`docs/spec/conversation-registry.md` §3.1 is ratified: `conversation_identities` holds
identity, `conversation_segments` holds evidence keyed `(machine_id, native_id)` with
`linked_by ∈ {live-roll, resume-origin, discovery}`. Lineage comes from what the server
observed **on a live session** (old ref → new ref on the same `SessionId`), never from
fingerprint heuristics. A resume that rolls into a new file is a **new segment, not a new
conversation**.

**W3 — Attempt identity and observation generation are two fences with two owners.**

- **Attempt id** (daemon-minted) names *which run this is*: this abduco session, this PTY,
  this headless invocation. Answers "is the output I am reading from the process I
  started?"
- **Observation generation** (server-minted, monotonic, `reattachment-design.md`
  §"Race-free bootstrap-to-live handoff" step 1) names *which observer lease may submit
  evidence*. Answers "may this frame change accepted state?"

A daemon restart over a surviving process = **new generation, same attempt**. A process
restart = **new attempt and new generation**. Merging them would either let a stale daemon
socket speak for a live process, or force a spurious process-identity change on every
reconnect. The generation contract is unchanged by this doc; **attempt id is the field
POD-415 adds**.

**W4 — Native-artifact observations are evidence with history, never identity.**
Normative rules, generalizing [spec:SP-fccf]:

1. Observations are **keyed by the immutable `SessionId`**, never the reverse. A native id
   is never a primary key of a session.
2. **No observation may replace, merge, hide or redirect a live Podium session** — not the
   native thread id, rollout path, transcript path, cwd or worktree.
3. Observations are **retained with history**: a superseding observation appends and
   points back; it never erases. History is what makes a conflict diagnosable.
4. Each carries **confidence**: `exact` (a native hook for this exact session, a launch
   marker, or proven process→artifact ownership) or `heuristic` (discovery by cwd, time
   window, path shape). §4 decides what each may do.
5. **Absence is a state, not a licence to guess.** `unbound` is expected and legitimate.

`apps/daemon/src/binding-store.ts` is the implementation of observation-with-history
durability, including retain-until-server-ack delivery state on each observation.

### 3.2 Minting responsibilities

**W5.** Exactly one party mints each level:

| Minted | By | Rule |
|---|---|---|
| `SessionId` | **Server** | Sole Authority (ADR 1 D1). A daemon receiving an unknown `SessionId` does not create it; the server refuses a client-supplied id that already exists (`relay.ts`: "never clobbers a live session"). |
| `ConversationId` | **Server** | At the registry seam where lineage is observed (`sessions/service.ts`, `sessionResumeRef`). |
| Observation generation | **Server** | Incremented and durably stored **before** `spawn`/`reattach` is sent; carried on the control message. |
| Attempt id | **Daemon** | The daemon owns the process and must be able to mint one while disconnected. |
| Native ids | **Harness** | Podium never allocates or derives one. |

**W6 — The server never invents an alias.** It may *record* an alias reported by the
machine that owns the session, *arbitrate* between two (§4), and *refuse* one. It may not
synthesize a native id, derive one from a path, or promote heuristic to exact. The shipped
guard is ratified: a daemon may bind only sessions owned by its authenticated machine, and
an ack is never sent to a foreign instance.

### 3.3 Server ↔ host synchronization direction

**W7 — Two directions.** **Upward (host → server) is evidence**: observations, cursors,
attempt starts/exits, resolved paths. Never authority — submitted under a generation,
accepted or rejected by the server's durable gate. **Downward (server → host) is
authority**: the binding, the generation, the delegation, the ref to pin, the attempt to
reattach, the adopt instruction. Binding updates ride the **control plane**.

**W8 — Binding traffic is host↔server control traffic, not the agent command relay.**
ADR 5 D7 and ADR 7 D2 already decide this, re-derived in [spec:SP-fccf] and
[spec:SP-a43e]: the relay bakes session identity into its URL path, so multiplexing
resume-ref and `sessionResumeRefAck` over it re-homes identity and breaks
`PODIUM_NO_RELAY` hermetic tests. POD-415 must not "save a port".

**W9 — Retain-until-server-ack, at-least-once, idempotent apply.** The host retains an
unacked observation across its own crash and replays it; the server persists idempotently
and only then acks; only the ack removes the host copy. An ack **names the exact value**
acknowledged, so a newer observation that arrived while an older ack was in flight
**stays pending**. `BindingStore.acknowledgePendingReceipt` enforces the exact-value
and owner match before clearing delivery state.

**W10 — Acks are gated on confidence; retention is not.** Only an `exact` observation is
**acknowledged**, because an ack promises the server's durable state now names that value.
A `heuristic` observation is **never acked and never current-value authority** — but it
**is durably retained as history** on the server side (§4.3 O5). "Not authority" and "not
retained" are different claims; revision 1 conflated them.

### 3.4 Crosswalk: today's identity-bearing facts → their disposition

The taxonomy above is four levels; the codebase has **28 named session representations**
(POD-364, `1475c062`). A taxonomy that is clean because it omits the messy cases is worse
than none, so this section names every one and its disposition. **Disposition vocabulary:**
**binding** (moves into `SessionBinding` as an Axis-1 or Axis-2 field) · **observation**
(becomes a retained `NativeObservation`, never a current value) · **elsewhere** (a real
fact that belongs to another aggregate — the Session R1, the conversation registry, the
checkpoint) · **derived** (computed, never stored twice) · **drop** (a drifted duplicate
POD-365 deletes) · **not-identity** (explicitly classified so nobody promotes it later).

#### 3.4.1 Identity-bearing facts

| Fact | Key(s) today | Current writer | Canonical destination | Disposition |
|---|---|---|---|---|
| Stable Podium session identity | `sessionId` (18 reps) / `id` (`sessions` DDL, `SessionRow`) | server at spawn | `SessionBinding.sessionId`, `SessionId` brand | **binding** — the one key; the `id`/`sessionId` spelling split is POD-365's to unify |
| Which harness runs inside | `agentKind` (17) / `agent` (`CloudAgentSourceSession`) | server at spawn, immutable | `SessionBinding.agentKind` | **binding** (see §3.4.4 for the full 6-member union); `agent` spelling → **drop** |
| Native resume ref | `resume: ResumeRef` (10) · `resumeKind`+`resumeValue` (DDL, `SessionRow`) · `resumeRef: string` (`CloudAgentSourceSession`) · `resume: {value}` (`LakeReadSession`) | daemon (`sessionResumeRef`) | `NativeObservation{channel:'resume-ref'}` + a derived current value | **observation** — this is the single most important row: today the ref is a *current scalar in four encodings*; it becomes **one retained history with a derived head**. Encodings 3 and 4 → **drop** |
| Ref confidence / ack request | `confidence`, `ackRequested` on the frame | daemon | `NativeObservation.confidence`; ack stays a frame concern | **observation** (confidence) + frame-only (ack) |
| Stable conversation identity | `conversationPodiumId` (`SessionDurableState`, `SessionMeta`) | derived (lookup in `conversation_identities`) | `SessionBinding.conversationId` | **binding**, sourced from the registry — the registry stays the system of record for *segments* |
| Which machine it runs on | `machineId` (10) / `machine` (`SessionStatusResult`, `StatusWire`) / `sourceMachineId` (`HandoffManifest`) | server on adoption | `SessionBinding.claimantMachineId`; `sourceMachineId` stays export provenance | **binding** + **not-identity** (`sourceMachineId` is provenance, H5) |
| Machine display label | `machineName` | derived (join on `machines`) | — | **derived** |
| The daemon's own identity | `DaemonIdentity.machineId` in `~/.podium/daemon.json` (`apps/daemon/src/identity.ts`) | daemon, minted once | unchanged — it is the **join key**, not a session fact | **elsewhere**; the binding *references* it as `claimantMachineId` and never re-mints it |
| Live working directory | `cwd` (14) | daemon (`sessionCwd`, hook-observed) | `NativeObservation{channel:'cwd'}` | **observation** — momentary placement evidence, **never lookup identity** (§11 C2) |
| Attempt / run identity | **does not exist today** | — | `SessionBinding.attemptId` | **binding, new** — this is the gap that makes "is this the process I started?" unanswerable |
| Observer lease | observation generation (`reattachment-design.md`) | server | `SessionBinding.observationGeneration` | **binding** (the fence lives with the binding; the *checkpoint* does not — §11 C4) |
| Native subagent ids | `NativeSubagent{id,type}`, `nativeSubagentCount`, `awaitingSubagents` inside `AgentRuntimeState` | daemon, **hook channel only** | stays in the runtime state | **elsewhere** + **not-identity** — a child `agent_id` is not a `SessionId` and never becomes one (§11 C3) |
| Permanent birth nice-name inputs | `refIssueId`, `refLetter`, `refDraft` (5 reps each) | server, allocated once | the Session R1 aggregate | **elsewhere** — immutable, but a *naming* fact, not a binding fact. `refLetter` allocation is an existence-leak surface (POD-364 §10) |
| Human-facing session ref | `displayRef` (4) | derived (repo prefix + ref fields) | — | **derived** |
| How the session came to exist | `origin: SessionOrigin` vs `originKind`+`conversationId` (DDL, `SessionRow`) | server at spawn | the Session R1 aggregate | **elsewhere**; the `conversationId` column here is a *native* id and must not be confused with `ConversationId` — POD-415 renames it |
| WHO created it | `spawnedBy: string` (5) — freeform `'user'\|'superagent:<id>'\|'issue:<id>'\|'session:<id>'` | server at spawn | `SessionBinding.delegation` | **binding (Axis 2)** — POD-364 calls this "the worst attribution site": untyped, unbranded, actor-half only. The delegation reference replaces it |
| Live attach state | `controllerId`, `clientCount`, `epoch` (`SessionMeta` only) | server (connection layer) | stays live-only, ADR 7 stream plane | **elsewhere** + **not-identity** — `controllerId` is a **connection id, not a person**; identity on it is Phase 5's separate deliverable |
| Attached issue | `issueId` (9) | operator / agent | the Session R1 aggregate | **elsewhere**; the binding reads it to resolve default scope (P6), never owns it |
| Headless (no PTY) | `headless` (4) + `HeadlessFields` | server at spawn | `SessionBinding` | **binding** — it changes the attempt contract (§6.4) |

#### 3.4.2 The 28 session representations

Rows are POD-364 §2's numbering. "Identity carried" is what each holds of Axis 1/2.

| # | Representation | Path | Identity carried | Disposition |
|---|---|---|---|---|
| 1 | `sessions` (drizzle) | `apps/server/src/migrations/schema.ts:21` | `id`, `resume_kind`, `resume_value`, `origin_kind`, `conversation_id`, `machine_id` | **elsewhere** (R3 physical DDL, legitimate); resume columns → **observation** (§10) |
| 2 | `SessionRow` | `apps/server/src/store/types.ts:101` | mirror of #1 | **elsewhere**; must become the composed mirror, not a hand-restatement |
| 3 | `Session` (class) | `sessions/session.ts` | `sessionId`, `controllerId`, live resume | **elsewhere** (R2, PTY + controller ownership) |
| 4 | `SessionInit` | same file | third hand-copy of the row field list | **drop** (drifted duplicate) |
| 5 | `SessionDurableState` | same file | `conversationPodiumId`, `resume`, `observedModel/Effort`, `titleLocked` | **elsewhere**; its identity fields source §3.4.1 |
| 6 | `SessionMeta` | `packages/protocol/src/messages/runtime-state.ts:329` | `sessionId`, `resume`, `conversationPodiumId`, `resumable`, `controllerId` | **elsewhere** (R4 wire); gains no binding fields — the binding is not a wire shape |
| 7 | `AgentRuntimeState` | same file:50 | `nativeSubagents[]` | **elsewhere** + **not-identity** |
| 8 | `HandoffManifest` | `packages/protocol/src/messages/handoff.ts:5` | `sessionId`, `resume`, `sourceMachineId`, `exportedAt`, `repoId` | **binding-adjacent** (R6): carries `sessionId` **verbatim** (H1); `resume` is re-observed on arrival (H3); the rest is provenance |
| 9 | `HandoffExportRequestMessage` | same file:44 | 9-key session subset | frame stays; subset **hand-restated** → composes from the binding |
| 10 | `SpawnMessage` | `packages/protocol/src/messages/terminal.ts` | the spawn tuple | frame stays; **must carry the delegation and the generation** (§6.1) |
| 11 | `HostSessionView` | `modules/hosts/service.ts` | `sessionId` | **elsewhere** (R5 hibernate scan) |
| 12 | `SessionNoticeInfo` | `modules/notify/service.ts` | `sessionId` | **elsewhere** (R5) |
| 13 | `RpcSessionView` | `modules/machines/rpc.ts` | `sessionId` | **elsewhere** (structural port) |
| 14 | `ResumableSession` + `HeadlessFields` | `packages/domain/src/session-identity.ts` | `sessionId`, `resume`, `headless` | **elsewhere** — the dedupe predicate; **W1's shipped guarantee lives here and does not move** |
| 15 | `HandoffSession` | `packages/domain/src/machine-selection.ts` | `machineId` | **elsewhere** (target pick); gates on `use` (P10) |
| 16 | `ConciergeSessionInfo` | `modules/superagent/concierge.ts` | `sessionId` | **elsewhere** |
| 17 | `BtwSessionInfo` | `modules/superagent/btw.ts` | strict subset of #16 | **drop** |
| 18 | `FocusSessionInfo` | `modules/superagent/global.ts` | extends #16 | **elsewhere** (the one good composition example) |
| 19 | `AnswerTargetSession` | `modules/superagent/answer-delivery.ts` | none | **not-identity** |
| 20 | `CloudAgentSourceSession` | `apps/server/src/cloud-runtime.ts` | `resumeRef: string`, `agent` | **drop** — renames two identity facts; a third `resume` encoding |
| 21 | `LakeReadSession` | `modules/conversations/service.ts` | `resume: {value}` | **elsewhere**, but the narrowed `resume` shape → **drop** (fourth encoding) |
| 22 | `IssueTreeSession` | `modules/issues/service/types.ts` | `sessionId` | **elsewhere** (R4) |
| 23 | `ShowSession` (CLI) | `packages/issue-client/src/commands.ts` | `sessionId` | **drop** (hand-copy of #22) |
| 24 | `SessionStatusResult` | `modules/sessions/read-toolkit.ts` | `sessionId`, `machine` | **elsewhere** (R4 tier-1) |
| 25 | `StatusWire` (CLI) | `apps/cli/src/session-cli.ts` | key-for-key copy of #24 | **drop** |
| 26 | `RefSessionLike` | `apps/web/src/lib/ref-miniview.ts` | `sessionId` | **elsewhere** (documented subset) |
| 27 | `SessionCardModel` | `packages/client-core/src/viewmodels/session-card.ts` | `sessionId`, `title` | **not-identity** (presentation) |
| 28 | `SessionAutoArchiveObservation` | `packages/protocol/src/maintenance.ts` | `sessionId` | **elsewhere** (steward payload) |
| — | `EngineState.sessions` | `packages/client-core/src/engine/engine.ts:165` | composes `SessionMeta[]` | **elsewhere**; note this file is **grep-invisible (NUL bytes)** — verify by reading |
| — | replica collection `sessions` | `packages/protocol/src/messages/sync.ts:53` | transports `SessionMeta` verbatim | **elsewhere** |

**Read of the crosswalk.** Of 28 representations, **exactly one new record** (the binding)
gains identity ownership; 6 are dropped as drifted duplicates; the rest keep their roles
and *source* their identity fields from the binding instead of restating them. The resume
ref is the fact that changes shape most: four current encodings of a mutable scalar
collapse into one retained history with a derived head.

#### 3.4.3 Explicitly not identity

Named so nobody promotes them later: `cwd` and every path (placement evidence, §11 C2);
`title`, `name`, `label`, `durableLabel` (naming — `nameSource` carries its attribution);
`controllerId`, `clientCount`, `epoch` (connection-level, not personal);
`sourceMachineId`, `exportedAt` (export provenance, H5); native subagent `agent_id`
(hook-channel child identity, parent-mediated, §11 C3); `refLetter` / `displayRef`
(naming, and a leak surface); `workflowRunId` / `workflowStepId` /
`executionProfileId` (opaque coordinator pass-through — substrate never interprets them
and must never bind on them).

#### 3.4.4 The full `AgentKind` union, and what each binds

Revision 1's provider union listed three kinds; `AgentKind` has **six**
(`packages/protocol/src/messages/terminal.ts:15`). Binding behaviour is specified here
rather than left to POD-415:

| `AgentKind` | Native artifact | `ResumeRef.kind` | Binding behaviour |
|---|---|---|---|
| `claude-code` | `~/.claude/projects/<slug(cwd)>/<native>.jsonl` | `claude-session` | Hook-first. `exact` from the hook's `session_id`. Transcript located by the §W2 locator, **never** re-derived from current cwd (§11 C2). Late creation is normal (§14 row 3). |
| `codex` | `~/.codex/sessions/**/rollout-*.jsonl` + state DB | `codex-thread` | Two channels (hook + rollout) sharing one binding. `exact` from native hook, launch marker, or process ownership. Lazy file creation; nearest-after-floor, never newest (W12). Reference implementation of the spool (§12). |
| `grok` | session dir + `updates.jsonl` | `grok-session` | Single file channel; `exact` from the session dir id. Rotation follows the same proven-succession rule as Codex. |
| `opencode` | provider session | `opencode-session` | Binds on the native session id when the adapter reports one; otherwise **stays `unbound`** — no path-shape discovery. |
| `cursor` | provider chat | `cursor-chat` | As `opencode`: bind on a reported id, else `unbound`. |
| `shell` | **none** | *(none)* | **Never binds a native artifact.** A shell session has a `SessionId`, an attempt id and a delegation, and its `observations` list is permanently empty. Its activity is `busy`/`shellCommandRunning` (derived, POD-364 §5.2), never a turn epoch. POD-415 must not model `shell` as "a harness whose binding failed". |

`ResumeRef.kind` is `z.string()`, not an enum — deliberately open so a new harness does
not require a protocol change. **A kind the server does not recognize is retained as an
observation and never promoted to `exact`** (fail closed, S2).

---

## 4. Concurrent-reattach arbitration and conflict semantics

### 4.1 Artifact-level conflicts — both cardinalities

Revision 1 decided only one direction and then cited it for the other; row 9 of the review
list was the wrong cardinality. **Both are decided here.**

**W11 — Direction A: one native id claimed by two `SessionId`s** (the cross-wiring
family).

| Situation | Outcome |
|---|---|
| Heuristic claim, no established binding | Recorded as heuristic evidence; may inform display. Never acked, never current-value authority. |
| Heuristic claim, established binding elsewhere | **Ignored and logged.** A timing-only observer never overwrites an established binding. |
| Exact claim, no conflict | Bound, persisted, acked. |
| Exact claim vs heuristic bindings elsewhere | Exact wins; stale siblings' refs cleared so one-thread-one-pane heals in place; broadcast. |
| **Exact vs exact, different live sessions** | **Visible fail.** Both bindings enter `conflicted`; neither pane is hidden, merged or redirected; both observations and their history are surfaced. No silent tie-break. |

Rationale for the last row: a tie-break means choosing which of a human's two live agents
to disconnect, and a wrong automatic answer is worse than a legible error.

**W11.1 — Direction B: two different exact native ids claimed for one
`(SessionId, channel)`** (the process-ownership-fallback family — a native hook and a
Linux process→rollout binding naming different threads for one session).

| Situation | Outcome |
|---|---|
| Two exact claims, **same value** | Idempotent. Re-ack, no state change (delivery is at-least-once). |
| Two exact claims, **different values, ordered** — the later strictly supersedes the earlier on the same channel with a proven succession (a `/new` thread, a resume roll, a rotation the adapter proved) | **Succession, not conflict.** The new observation appends with `supersedes` set; the derived head advances; W2 links a new conversation segment. |
| Two exact claims, **different values, unordered** — no proven succession (hook says X, process ownership says Y) | **Visible fail.** The binding enters `conflicted`, the **head stops advancing** (the last agreed value remains the head), both observations are retained, and **no ack is sent for either**. |

The unordered case must not be resolved by source precedence ("hooks beat process
ownership"). Both are `exact` by construction — the binding store records process
ownership and native-hook evidence through the same pending-ack observation path — so a precedence rule would be an invented
authority ranking, which is exactly the W6 prohibition.

**W12 — Never "newest".** Selecting the newest artifact *is* the cross-wiring bug. Codex
creates its rollout **lazily** (often at the first prompt, minutes after boot), so several
sessions' rollouts can sit past a reattach floor at once; a sibling spawned later boots
later, so the candidate **nearest after this session's own floor** is its own. Where a
launch marker exists it is exact evidence and therefore **mandatory** — an unmarked
candidate is not eligible when the daemon supplied a Podium session id, and a new unmarked
launch **waits for its native hook rather than guessing a sibling**
(`resolvePinnedCodexRollout` returns `undefined`; the poller retries).

### 4.2 Session-level: one claimant machine, one lease, one live process

**W13.** A session has at most one **claimant machine**, at most one **valid observation
generation**, and at most one **live attempt**.

1. Reattach is a **server** decision. The server increments the generation, durably stores
   it, then sends `reattach`. Older-generation frames are inert on arrival.
2. The claimant machine is a **field of the binding**, not an inference from who spoke
   last. A frame whose machine is not the claimant is dropped — already shipped for
   `sessionCwd`, where a handoff reuses the same `SessionId` on the target and a frame
   queued by the old daemon must never restamp the target row.
3. Two principals racing is authorization first (P11), then this fence.

**W14 — Losing a reattach race must dispose of the losing process.** A generation fence
alone makes the loser's *frames* inert; it does not stop the loser's *process*, and an
orphaned live process is a failure this repo has actually suffered. The contract:

- The daemon **must not start a PTY or headless process before the server has accepted its
  reattach** (§6.2 step 4). Acceptance is what authorizes the attempt, so the common race
  produces no second process at all.
- If a second attempt exists anyway (daemon crash-restart, a mixed-version daemon, an
  abduco session that outlived its server acceptance), the server's rejection carries
  `disposition: 'terminate-attempt'` naming the rejected `attemptId`, and the daemon
  **terminates that attempt** — not the session, not the durable host of the winning
  attempt.
- Termination is **by attempt id**, never by session id or by scanning process names.
  A bare `abduco` sweep once killed 93 unrelated masters on this machine.

  > **Test obligation (POD-417), stated as survivors and not only as victims.** A test named
  > "terminates the losing attempt" passes if the daemon killed *everything*, which is the
  > failure this clause exists to prevent — so asserting the victim died proves nothing about
  > narrowness. The assertion set must be: the **losing attempt is gone**, the **winning
  > attempt is still alive and still serving frames**, and **an unrelated third session's
  > durable host on the same machine is untouched**. The third one is the assertion that
  > actually distinguishes a narrow kill from a sweep; without it the test is named for a
  > property it does not check. Mutate the disposal call to take the session id instead of
  > the attempt id — the test must go red.
- If the daemon cannot prove which attempt is which, it terminates **nothing** and reports
  `conflicted`. Failing closed here means a duplicate pane; failing open means killing a
  human's live work.

**W15 — What each caller is told.** Reattach is request/response, and both callers get an
answer:

| Caller | Response |
|---|---|
| Winner | `reattachAccepted { sessionId, attemptId, observationGeneration }` |
| Loser, same principal (double-click, retry) | `reattachRedundant { sessionId, attemptId }` — **not an error**; the caller is attached to the winning attempt and its UI converges |
| Loser, different principal | `reattachDenied { reason: 'not-claimant', currentClaimant }` where `currentClaimant` is included **only if the caller may `see` that machine** (P10.2) |
| Caller lacking `use` on the machine | `reattachDenied { reason: 'machine-use-denied' }` — distinct from unreachable |
| Caller lacking rights on the session | `reattachDenied { reason: 'not-found' }` — **identical to a nonexistent session id** (ADR 9 D7's consistent-error rule) |

`reattachRedundant` exists so the overwhelmingly common race — one human, two clicks — is
not surfaced as a failure.

### 4.3 Observation ordering, current value, and history

**O1 — Every observation has an id.** `observationId` is server-minted, unique per
binding, and monotonically ordered within `(sessionId, channel)`. Revision 1's
`supersedes` pointed at a field that did not exist; it now points at an
`observationId`.

**O2 — Ordering is by `observationId`, not by time.** `observedAt` is harness/host time
and is evidence, never an ordering key — the same rule `reattachment-design.md` invariant 4
states for provider event time. `recordedAt` is server time and is diagnostic.

**O3 — The current value of a channel is derived, never stored twice.** The **head** of a
channel is the highest-`observationId` `exact` observation with no successor, provided the
channel is not `conflicted`. There is no separate "current" column to drift from the
history. `SessionMeta.resume` and the `sessions.resume_kind`/`resume_value` columns become
**projections of the head** (§10).

**O4 — Uniqueness.** `(sessionId, channel, observationId)` is unique. The same
`(sessionId, channel, value, confidence, source)` arriving twice is **idempotent** — it
appends no row and re-acks — which is what makes at-least-once replay safe.

**O5 — Conflict and resolution append; they never clear history.** Entering `conflicted`
appends a marker; resolving it appends the resolution and the winning observation. Nothing
is deleted. Revision 1 said an exact claim "clears" stale siblings' refs — precisely: it
**advances those siblings' heads to null by appending a retraction**, so the sibling's
history still shows what it once believed and why it stopped believing it. A cleared ref
that leaves no trace is how the original cross-wiring became undiagnosable.

**O6 — Heuristic observations are retained.** They never become the head (O3) and are
never acked (W10), but they are durable server-side history. They are the evidence a human
reads when asking "why did it bind to that?"

---

## 5. Axis 2 — identity of the actor

### 5.1 Vocabulary: principal vs delegation reference

**P0 (correction, and the most important clause of this section).** The normative
**principal is `(user, device, capability)`** — ADR 9 D1, ADR 3 Amendment 1 D14. A
`client_session` is a **device that resolves to a user**, never a person. Revision 1 called
`(agentIdentity, onBehalfOf, scope)` "the principal"; that tuple is quoted verbatim from
ADR 9 D1's agent-delegated row and D5/A1, but it is **not a principal** — it is the
**delegation reference** from which a principal's capability half is resolved. Downstream
issues copy whichever vocabulary this doc uses, so the naming is fixed here.

**P0.1 — Apply-time resolution, explicitly.** At every apply, for an agent-originated
command:

| Principal part | Resolved from |
|---|---|
| **user** | `delegation.onBehalfOf` — the root human of the chain, unchanged since spawn |
| **device** | The **authenticated transport**: the daemon's machine identity for a relayed agent command, the client session for a human command. Never the binding, never the payload |
| **capability** | **Server-minted, live**: `grantedScope` intersected over the whole chain (P3), intersected with the root human's **current** rights, and further intersected with the target's own visibility/owner/grant test |
| **actor** (attribution, not authorization) | `delegation.actor` — which agent did it (P8) |

**Payload identity is inert** (ADR 3 D7). No part of a principal is ever read from a
command payload, and a forged `onBehalfOf` in a payload changes nothing.

### 5.2 SessionBinding is the delegation's lifecycle

**P1 (normative).** The agent's delegation is **born with its `SessionBinding` and retired
with it**. There is no parallel agent-identity registry, no second alias history, no second
revocation path (ADR 9 D5/A5). Consequence: **retiring a binding retires the delegation** —
there is no reaper to write.

**P2 — The delegation reference.**

| Field | Meaning |
|---|---|
| `actor` | The agent identity — this session as an actor. `Capability.actorSessionId` is the existing seam. |
| `onBehalfOf` | Exactly one `UserId`. A **reference**, never a copy of rights. |
| `grantedScope` | What this agent was spawned for. Narrow by default (P6). |
| `parent` | The delegating agent's binding, or null when a human spawned it directly. |

**P3 — Chain rules.** Exactly **one human at the root**. A sub-agent delegates **from its
parent agent**, never directly from the root human. Scope narrows **monotonically** and
never widens. Effective rights are the **intersection over the whole chain**, intersected
with the root human's current rights, at every apply.

**P4 — A reference, never a rights snapshot.**

> *Rationale, recorded because it will be re-litigated.* A snapshot leaves unattended
> agents running with rights the human no longer holds, with **no cleanup trigger** — in a
> system where agents run for hours unsupervised, the failure is silent and the agent keeps
> working. Live resolution makes revoking a human **transitively disable their agents**,
> with no reaper to write and none to forget. The cost is resolving a chain instead of
> reading a stored capability, on a path (ADR 3 D8) that already re-authorizes every apply
> including outbox replay. This is the case D8 was over-engineered for under single-user,
> arriving.

**P5 — Minted at spawn, carried, ended.** Minted **at spawn from the authenticated
transport principal** and never from payload. **Carried unchanged** through reattach,
hook re-pin, headless allocation, worktree move, resume, and **handoff adopt**. **Ended**
when the binding retires. No Axis-1 event — no hook, no observation, no native id, no
adopt import, no daemon reconnect — ever mints or alters a delegation.

**P6 — Narrow default scope.** Default `grantedScope` is what the agent was spawned for:
its session, its issue, that issue's subtree — **not** everything its human can see
(ADR 9 D5/A2). Widening is explicit via the shipped `overrideScope` / `--outside-scope`
→ `confirm-required` path (ADR 3 D2). `IssueScope.subtree` is already reserved and already
enforced by `authorize()`.

**P7 — Superagent and system.** The superagent is **not a fifth principal kind**: it is a
delegation whose `grantedScope` is everything its human can see — spawned *for a person*
rather than *for a task*, so ceiling and scope coincide (ADR 9 D8/S1). Broad scope is a
**value** of `grantedScope`, never an absent or wildcard default. Scheduled automations are
delegated the same way (S6). **System automations are not delegated at all** (S5): the
steward, expiry jobs and boot reconcile have no human, write only as `system`, and must
never be given an `onBehalfOf`.

**P8 — Attribution is a pair.** Every write records **actor** and **on-behalf-of**, both
from the transport principal (ADR 9 D5/A3). Collapsing them destroys shipped distinctions:
human-set `name` outranks agent-set (`nameSource`, [spec:SP-eb60]) and
`humanQuestionAskedBy` is server-authoritative so "person or agent?" stays answerable.
`Capability.actorSessionId` is the actor seam; **the on-behalf-of half is new**. This
replaces the freeform `spawnedBy` string (§3.4.1).

**P9 — Ownership of output.** For entities an agent creates: `owner = onBehalfOf`,
`actor = the agent` (ADR 9 D5/A4).

### 5.3 Where owner, visibility and grants live

**P9.1.** They live on the **Session aggregate**, per the ADR 1 amendment (POD-1071) and
ADR 9 D2 — **not on the binding**, and the binding does not duplicate them. Per ADR 1
Am1 §3, every session row is visibility class **`personal`** (POD-364 §2). The binding
**reads** them at apply time (P11) through the Session; storing a second copy would be a
cached authorization decision, which is the exact defect P4 forbids on the delegation side.

The binding does carry the two fields the Session cannot supply: `delegation` (which
`SessionBinding` owns per A5) and `claimantMachineId` (which is Axis 1). Ownership of the
session row itself is `owner = onBehalfOf` at spawn, by P9.

### 5.4 Machine access

**P10.** Spawn, reattach and **adopt** all require **`use` on the target machine**. The
`see` / `use` / `manage` verbs, machine ownership and the per-machine grant list come from
**POD-1079** (machine ownership + grants, Phase 4) and ADR 9 D6 — **not here**. Three
consequences for bindings:

1. A binding cannot be created, reattached or adopted on a machine whose `use` the acting
   principal lacks. Denial is a first-class outcome (W15).
2. **A denial is distinct from unreachable** (M5) — "denied" and "offline" otherwise
   produce the same empty list and the same support ticket. The distinction holds **inside
   the principal's `see` set only**; a machine the principal cannot `see` is *absent*, and
   any reference to it fails identically to a nonexistent machine id (ADR 3 Amendment 1
   D18.5 owns that boundary).
3. **`use` is a code-execution boundary, not a privacy one** (M2): running with the machine
   owner's SSH keys, `git`/`gh` identity, dotfiles, cloud CLI sessions and whatever private
   repositories are checked out there. It is a high-trust act and must read as one.

**P11 — Two users racing reattach on a shared machine.** `use` on the machine is
**necessary and not sufficient**. Reattach is an operation on the *session*, so it also
requires passing that session's own test in ADR 9 D2's order — visibility, then owner, then
grants, then role — read from the Session aggregate (P9.1). A colleague with `use` but no
grant on the session is denied **at the session**, with `not-found` (W15). When both
principals pass, §4.2's fence decides, W14 disposes of the loser's attempt, and **the
session's `onBehalfOf` does not change**: reattaching someone else's session does not make
it yours.

### 5.5 Cross-machine consequence

**P12.** On handoff the `SessionId` **and the delegation are both stable**; the attempt
identity resets; and **the importing principal does NOT become the session's human.**

Stated as its own clause because the alternative is a live vulnerability: **re-minting the
delegation on import would turn handoff into a privilege-escalation path** — export a
session, import it as yourself, and its agent runs with your rights instead of the original
human's. POD-644 carries `onBehalfOf` verbatim and mints nothing on Axis 2. The importing
principal must still hold `use` on the target (P10) and rights on the session (P11); what
it does not acquire is the delegation.

### 5.6 Not multi-tenancy

**P13.** ADR 1 D5 stands: **`InstanceId` is a deployment partition**; multi-user lives
*inside* one instance. The binding store **must not** add `instance_id` columns; the
SP-15aa instance runtime namespace (`c28463a6`) **must not** be repartitioned by user.
**Ownership is a field, not a path.**

---

## 6. Transition contracts

POD-416 implements these; the shape is fixed here. Every transition states: pre-state,
authorization, minting, atomic fence, durable writes, emissions, success, failure,
idempotency key. **All are idempotent under retry** — the key is stated per transition and
a repeat with the same key returns the original outcome rather than re-executing.

**T0 — Common rules.** (a) Authorization is resolved live (P0.1) at the *start* of every
transition and re-resolved at every subsequent apply; a transition that spans a revocation
fails at the next apply, not silently. (b) Every durable write is server-first: the server
commits before the host is told to act, so a crash leaves the server ahead of the host and
the host converges by replay (§9). (c) No transition mints a delegation except **spawn**.

### 6.1 Spawn

| | |
|---|---|
| **Pre-state** | No binding for this `SessionId` |
| **Authorization** | Principal resolved from transport (P0.1); requires `use` on the target machine (P10); `grantedScope` must be **⊆ the parent's** when a parent is named (P3) — a widening request is **refused here, at mint time**, not narrowed silently and not caught later at apply |
| **Mints** | Server: `SessionId`, `observationGeneration = 1`, the **delegation** (P5). Daemon: `attemptId`, after acceptance |
| **Fence** | Server refuses a `SessionId` that already exists |
| **Durable writes** | Server: binding `{state:'unbound', claimantMachineId, observationGeneration:1, delegation}`, before `spawn` is sent |
| **Emits** | `SpawnMessage` carrying the generation and the delegation (§3.4.2 row 10) |
| **Success** | `state: 'unbound'`, attempt live. **Not `bound`** — no native artifact exists yet (§11 C1/C4) |
| **Failure** | Spawn failure retires the binding; a scope-widening request returns `scope-widening-denied` and mints nothing |
| **Idempotency key** | The client-supplied `SessionId` |

### 6.2 Reattach

| | |
|---|---|
| **Pre-state** | Binding exists; `state ∈ {unbound, bound, conflicted}` |
| **Authorization** | `use` on the machine (P10) **and** the session's own test (P11) |
| **Mints** | Server: a new `observationGeneration`. Daemon: a new `attemptId` **only if** no live attempt survives |
| **Fence** | Compare-and-set on `observationGeneration`; the winner is the transition that advances it |
| **Durable writes** | Server: new generation, **committed before** `reattach` is sent |
| **Emits** | `reattach` carrying the generation; responses per W15 |
| **Success** | Winner attached; **the daemon starts no process until acceptance** (W14) |
| **Failure** | Loser: `reattachRedundant` (same principal) or `reattachDenied` (different); a surviving losing attempt is disposed of **by attempt id** (W14) |
| **Idempotency key** | `(sessionId, requested generation)` |

Reattach **restores an accepted checkpoint as bootstrap** and emits no live transition
(§11 C4).

### 6.3 Hook re-pin

| | |
|---|---|
| **Pre-state** | Any non-retired state |
| **Authorization** | The reporting machine must be the **claimant** (W6/W13.2). No principal check — a hook is host↔server evidence, not a command |
| **Mints** | Server: an `observationId` |
| **Fence** | Confidence + cardinality rules (W11, W11.1) |
| **Durable writes** | Append the observation; advance the head if the rules allow; on unordered exact-vs-exact, set `conflicted` and **stop advancing the head** |
| **Emits** | `sessionResumeRefAck` **only** for an `exact`, non-conflicted outcome (W10); a conversation-segment link on succession (W2) |
| **Success** | `state: 'bound'`, head advanced |
| **Failure** | `state: 'conflicted'`, both observations retained, **no ack** — so the host keeps replaying and the conflict cannot be lost by a crash |
| **Idempotency key** | `(sessionId, channel, value, source)` — a repeat re-acks and appends nothing (O4) |

**Never mints or alters a delegation** (P5).

### 6.4 Headless first-turn allocation

| | |
|---|---|
| **Pre-state** | `state: 'unbound'`, `headless: true` |
| **Authorization** | Inherited from spawn; unchanged |
| **Mints** | Daemon: `attemptId` per run. The harness allocates the native id at the first turn |
| **Fence** | As hook re-pin |
| **Durable writes** | As hook re-pin |
| **Special rule** | A headless run's **stdin is closed immediately** (§11 C1), so the attempt's exit status is a real signal — attempt exit is durable evidence, unlike a PTY where exit and hibernation are distinguishable only by policy |
| **Success** | `bound` on the first native id |
| **Failure** | Attempt exits before allocating one: the binding stays `unbound`, the attempt is recorded as exited, **and nothing is guessed** |
| **Idempotency key** | `(sessionId, attemptId)` |

A headless session shares its resume ref with its terminal twin by design; W1's
live-group-stays-visible rule is what keeps that from collapsing either row.

### 6.5 Crash / restart

Covered in full in §9. The transition contract: **no minting, no emission, converge by
replay**; a restart is never a new attempt unless the process is actually gone.

### 6.6 Retire

| | |
|---|---|
| **Pre-state** | Any |
| **Authorization** | Session-level rights (P11) |
| **Mints** | Nothing |
| **Durable writes** | `state: 'retired'`, `retiredAt`; **the delegation ends with it** (P1); observation history is **kept**, not deleted |
| **Emits** | Retirement; any live attempt is disposed of by attempt id (W14) |
| **Idempotency key** | `sessionId` |

### 6.7 Adopt — claim, commit, abort

The three-phase transition that makes H6 representable. Revision 1 asserted
claim-then-commit with no schema for the intermediate state; `transfer` (§8) is that
schema.

| Phase | Pre-state | Effect |
|---|---|---|
| **claim** | `transfer == null` | Server writes `transfer {transferId, phase:'claimed', fromMachineId, toMachineId, claimedAt}`. **`claimantMachineId` does not move.** The source remains the claimant and remains runnable |
| **commit** | `phase == 'claimed'`, target import succeeded | Atomically: `claimantMachineId = toMachineId`, `attemptId = null`, `observationGeneration++`, native observations on the source machine **superseded by re-observation** (H3), `transfer.phase = 'committed'`. **`sessionId`, `conversationId` and `delegation` are untouched** (P12) |
| **abort** | `phase == 'claimed'`, import failed or timed out | `transfer.phase = 'aborted'`; the source is still the claimant and still runnable. Nothing was lost because nothing moved |

- **Authorization:** `use` on **both** machines (P10) plus session rights (P11). The
  importing principal does **not** become `onBehalfOf` (P12).
- **Crash between claim and commit:** on restart the server finds `phase: 'claimed'` and
  applies the recovery rule — **if the target has not reported a successful import, abort**
  (§9 R5). Fail closed toward the source, which is the machine that still has the work.
- **Two claimants are impossible by construction:** the claimant moves only at commit,
  which is a single atomic write. If two are ever observed, the outcome is `conflicted` and
  a refusal to run both (W14's fail-closed clause).
- **Idempotency key:** `transferId`.

---

## 7. Cross-machine handoff (POD-498, landed `2b0bc5d4` + `d73e9121`)

**H1 — `SessionId` is stable across machines**, carried **verbatim** in the
`HandoffManifest` and **reused on import**.

**H2 — Attempt identity resets on the target.** The source process is gone; a new run is a
new attempt with a new generation. Source cursors are **not comparable** to the target's
until the adapter proves a segment succession (`reattachment-design.md` invariant 5).

**H3 — Native artifacts are RE-OBSERVED on arrival, never carried as identity.**

- The **Claude jsonl** is re-derived at the target project slug — `claudeProjectSlug` of the
  **new cwd** (`apps/daemon/src/handoff-package.ts`) — because Claude buckets transcripts by
  the cwd the conversation was *created* under. The manifest's `transcriptFilename` /
  `transcriptRelativeDir` are payload and evidence, not a path to trust.
- The **Codex rollout** is re-pinned via `resolvePinnedCodexRollout`, which **returns
  `undefined` until the file exists**, so a just-imported session waits rather than latching
  onto a sibling.
- The re-observed native id appends as a **new segment on the same `ConversationId`** (W2).
  `conversation_segments` is keyed `(machine_id, native_id)`, so the target gets its own
  segment row and the conversation identity is unchanged.

**H4 — Worktrees are reused-and-hard-synced or recreated.** A round trip returns to a
machine where the old worktree still exists: the importer **reuses it and hard-syncs**
(`reset --hard` + `clean -fd`) to the package state, and **never unwinds a reused worktree
on failure** — only ones it created (`d73e9121`). Import must not reset a checkout another
resumable session owns; `occupiedWorktreePaths` exists for exactly that, optional only for
mixed-version daemons. `worktreeRelativePath` / `cwdSubpath` place the agent; the daemon
reports the resolved `worktreeRoot` back rather than letting the server re-derive it.

**H4.1 — The bundle base is an intersection, and an empty one fails at export.**
`bundleBase` is not the target's wish list: the exporter intersects target-proposed bases
with shas the **source** actually has (`sourceKnownShas`) and **throws before staging** when
empty — a target's freshly-fetched `origin/main` aborted `bundle create` with `bad object`
until `d73e9121`. A branch whose tip sits exactly on a shared base is dropped from the
bundle by git, so import derives the tip from the manifest and creates the branch
explicitly, fetching through a temp incoming ref so a branch checked out in the abandoned
source worktree cannot block the fetch.

**H5 — `sourceMachineId` and `exportedAt` are provenance.** Never identity, never
authorization input, never a reason to accept a frame (W13.2).

**H6 — Single-claimant across the transfer.** See §6.7: the claimant moves only at the
atomic commit, and `transfer.phase` makes the intermediate state durable and recoverable.

---

## 8. The record

One record, both axes, explicitly separated. Field *shapes* are ADR 4 Amendment 1 D9 and
the model package; this is the semantic definition POD-415 implements.

```ts
interface SessionBindingV1 {
  schemaVersion: 1

  // ---- Axis 1: identity of the work -------------------------------------
  sessionId: SessionId                  // server-minted, immutable, stable across machines
  conversationId: ConversationId | null // server-minted; null until a conversation is observed
  agentKind: AgentKind                  // all six members; see §3.4.4

  claimantMachineId: MachineId          // exactly one; moves only at an adopt commit (§6.7)
  attemptId: AttemptId | null           // daemon-minted; null when no run is live
  observationGeneration: number         // server-minted, monotonic; the observer lease fence

  /** Evidence with history. Never identity, never a key. Head is DERIVED (O3). */
  observations: NativeObservation[]

  /** Durable intermediate state of an in-flight handoff. Null when none. (§6.7) */
  transfer: {
    transferId: string
    phase: 'claimed' | 'committed' | 'aborted'
    fromMachineId: MachineId
    toMachineId: MachineId
    claimedAt: string
    settledAt: string | null
  } | null

  // ---- Axis 2: identity of the actor ------------------------------------
  /** A delegation REFERENCE, not a principal and not a capability (P0, P4).
   *  null = a `system` principal (P7/S5) — never "unknown", never unconstrained. */
  delegation: {
    actor: AgentIdentity
    onBehalfOf: UserId
    grantedScope: Scope
    parentBindingId: SessionId | null
  } | null

  // owner / visibility / grants are NOT here — they live on the Session
  // aggregate per ADR 1 Am1 and ADR 9 D2, and are read at apply time (P9.1).

  // ---- Lifecycle --------------------------------------------------------
  state: 'unbound' | 'bound' | 'conflicted' | 'retired'
  createdAt: string
  retiredAt: string | null
}

interface NativeObservation {
  observationId: string                 // server-minted; ORDERING KEY within (sessionId, channel)
  channel: 'resume-ref' | 'transcript-path' | 'rollout-path' | 'process-ownership' | 'cwd'
  value: string | null                  // null = a retraction (O5)
  confidence: 'exact' | 'heuristic'
  source: 'native-hook' | 'launch-marker' | 'process' | 'discovery' | 'handoff-import'
  observedAt: string                    // harness/host time — EVIDENCE, never an ordering key (O2)
  recordedAt: string                    // server time — diagnostic
  supersedes: string | null             // a prior observationId on the same channel
}
```

Decisions embedded above, not commentary:

- **`state: 'conflicted'` is a real state**, reachable from both cardinalities (W11, W11.1),
  because visible-fail is the policy.
- **`state: 'unbound'` is normal** — a just-spawned Codex or Claude session is legitimately
  unbound. Absence never justifies a guess.
- **`delegation: null` means `system`**, not "unknown" and never "unconstrained".
- **No `instance_id`** (P13). **No owner/visibility/grants** (P9.1). **No current-value
  resume column** — the head is derived (O3).

### 8.1 Schema version

**S1.** `schemaVersion` is the binding store's own version, **independent of the server
database's migration journal**. The server-side `schema_version` concept is retired (the
drizzle journal replaced it) and the daemon-side store has no journal at all; versioning
them together would couple a daemon file format to a migration lineage that does not
describe it.

**S2 — Fail closed on a newer version.** A reader encountering an unknown `schemaVersion`
**refuses the record and reports it**. It does not best-effort parse and it does not delete.
An unparseable binding must never degrade into an `unbound` session that a guess can fill
in.

> **Test obligation (POD-415).** An untested fail-closed path is a fail-open path, and
> "it threw" is not the claim. S2 makes three separate promises and each needs its own
> assertion: the read **refuses** (and refuses *for the version reason* — assert the
> reason, or a missing-file error passes the test); the record is **still on disk
> afterwards**, byte-identical; and the session does **not** appear as `unbound`, because
> degrading to `unbound` is exactly the state a later guess is allowed to fill in. Mutate
> the version check to fall through to the v1 parser — all three must red.

**S3 — Unknown fields are preserved.** A daemon older than the server must round-trip
fields it does not understand rather than dropping them on rewrite: there is no migration
runner to repair the loss.

---

## 9. Crash recovery

Required by POD-323 Step 1 ("daemon restart re-derives bindings from durable hosts plus
observations") and omitted from revision 1.

**R1 — The server is the durable authority; the host is a replay buffer.** After any crash
the server's binding is the truth. The host holds only unacked evidence, which it replays
(W9). No recovery path re-derives a binding from the filesystem alone.

**R2 — Daemon restart, process alive.** The daemon enumerates its **durable hosts** (abduco
sessions), matches each to a session, and reports what it finds. Rules: the surviving
process keeps its **attempt id** (W3) — a restart is not a new run; the server issues a
**new generation**; the daemon's current state is sent as a **bootstrap snapshot, not a
transition** (§11 C4). A durable host it cannot match to a session is reported as
**orphaned and left running** — never killed (W14) and never adopted into an arbitrary
binding.

**R3 — Daemon restart, process gone.** `attemptId = null`; the binding keeps its
`conversationId`, its observation history and its delegation. The session is resumable, not
retired. Nothing about Axis 2 changes.

**R4 — Server restart.** Bindings load from durable storage. Each connecting daemon gets a
**new generation**. Because the checkpoint is durable, a daemon's re-sent bootstrap at an
equal cursor is a no-op (`reattachment-design.md`). Unacked host receipts replay and apply
idempotently (O4).

**R5 — Crash during a transfer.** `transfer.phase == 'claimed'` on restart: **if the target
has not reported a successful import, abort** (§6.7) — fail closed toward the source, which
still has the work. `phase == 'committed'` is complete by definition; the claimant already
moved atomically.

**R6 — Crash during receipt acknowledgement.** Acknowledgement is a serialized atomic
rewrite of that session's binding file. A stale ack clears only observations whose
`pendingServerAck` exactly matches its native kind and value, so a newer native id
observed while an older ack was in flight stays pending. Legacy `.ack` claims are
accepted only by the one-shot v3 migration and are removed after durable import.

**R7 — Recovery never guesses.** Any recovery path that cannot prove a binding leaves it
`unbound` or `conflicted` and surfaces it. POD-417's SIGKILL-plus-restart test asserts
**both** that every live session rebinds correctly *and* that no session rebinds to a
sibling's artifact — the second assertion is the one that catches the historical bug.

---

## 10. Migration from today's scattered state

Required by POD-323 Step 1; POD-415 implements from this table. **Disposition** as in §3.4.

| Source (today) | Path | Destination | Disposition |
|---|---|---|---|
| `sessions.resume_kind`, `resume_value` | `apps/server/src/migrations/schema.ts` | `NativeObservation{channel:'resume-ref'}` seeded as one `exact`/`source:'discovery'` row per session; the columns become a **projection of the head** (O3) | **backfill + keep as projection** |
| `sessions.conversation_id`, `origin_kind` | same | Session R1 aggregate; the column is a **native** id and is renamed to avoid collision with `ConversationId` | **elsewhere + rename** |
| `sessions.machine_id` | same | `SessionBinding.claimantMachineId` | **backfill** |
| `SessionDurableState.resume`, `.conversationPodiumId` | `sessions/session.ts` | read through the binding | **derive** (stop storing) |
| `SessionMeta.resume`, `.resumable`, `.conversationPodiumId` | `protocol/messages/runtime-state.ts` | wire projection of the head; `resumable` already derived | **derive** |
| `conversation_identities`, `conversation_segments` | `apps/server/src/store/conversations.ts` | **unchanged** — the registry stays the system of record for segments; the binding holds only `conversationId` | **keep, do not migrate** |
| Observation leases / durable checkpoint | `docs/reattachment-design.md` (POD-1015) | **unchanged and adjacent** — the checkpoint is not the binding (§11 C4); the binding holds the generation, the checkpoint holds cursors and turn state | **keep, do not merge** |
| `session-observers.ts` in-memory maps | `apps/daemon/src/session-observers.ts` | rebuilt from the binding on attach; no persistence added | **drop (rebuild)** |
| `~/.podium/daemon.json` (`DaemonIdentity`) | `apps/daemon/src/identity.ts` | **unchanged** — the machine join key; the binding references it | **keep, do not migrate** |
| Codex receipts + `.ack` claims | historical `runtime/codex-identity-receipts` directory | `SessionBinding.observations[].pendingServerAck`; directory removed after durable import | **folded — POD-737** |
| `HandoffManifest` | `packages/protocol/src/messages/handoff.ts` | unchanged on the wire; `sessionId` reused verbatim (H1), `resume` re-observed (H3) | **keep** |
| `spawnedBy: string` | 5 reps | `SessionBinding.delegation` | **replace** (P8) |

**Backfill.** One pass at first boot after POD-415 lands: for each session row, create a
binding with `claimantMachineId` from `machine_id`, `conversationId` from
`conversationPodiumId`, and — where `resume_value` is non-empty — a single seeded
observation with `confidence: 'exact'`, `source: 'discovery'`, `observedAt` = the row's
`lastActiveAt`. **Seeded observations are marked as backfill** so a later real hook is
distinguishable from the seed in history.

**Conflict handling during backfill.** Two sessions sharing one `resume_value` (the
historical cross-wiring, already present in old rows) backfill to **`conflicted`**, not to
an arbitrary winner. The operator sees the pre-existing damage instead of the migration
silently choosing.

**Cutover.** Dual-read, single-write, in this order: (1) POD-415 lands the store and
backfill; the binding is written on every change but **reads still come from the old
columns**. (2) A conformance run asserts the two agree for every live session — and must
assert a **non-zero session count** first, because "they agree for every session" is
trivially true of an empty set, and must compare **null against null explicitly** rather
than skipping rows where either side is absent, since an unbound session on both sides is
the agreement most likely to be vacuous. (3) Reads
switch to the binding; the old columns become projections written from the head. (4) The
old columns stop being authoritative — **the point of no return, and it is one commit**.
Restart at any stage is idempotent because the backfill is keyed by `sessionId` and seeded
observations are idempotent under O4.

**Ownership split.** The **server** owns the durable binding. The **host** owns only
unacked evidence and its own attempt state. No third copy is authoritative.

---

## 11. Operational constraints, as normative rules

Four constraints, each a past incident in this repo, stated as rules rather than left as
references.

**C1 — Codex `exec`/headless stdin is closed immediately, and that is a correctness
requirement.** `codex exec` appends stdin to the prompt, so the daemon closes stdin at
spawn (`packages/agent-bridge/src/harness/adapters/codex.ts`; `child.stdin?.end()` in
`headless-drivers.ts`). The binding consequence: **a headless attempt's exit status is
trustworthy evidence** and §6.4 depends on it. POD-415 must not introduce a binding
handshake that requires writing to a headless child's stdin — there is nothing to write
to, and re-opening it would break EOF-based status detection.

**C2 — `cwd` is momentary placement evidence and never lookup identity.** The daemon
follows the shell, and resume may target a different worktree entirely
(`HandoffExportRequestMessage.cwd`: *"momentary, and it drifts"*). The rule: **no artifact
is ever located by re-deriving a path from the current cwd.** Claude buckets transcripts by
the cwd the conversation was *created* under, so re-derivation from the current cwd is the
moved-worktree blank-transcript bug; the locator's order is exact path → recorded segment
evidence → bucket sweep by native id (`conversation-registry.md` §3.3). `cwd` is a
`NativeObservation` channel (§3.4.1) precisely so it can be recorded without ever being
promoted to a key.

**C3 — Native subagent identity exists only on the hook channel; child identity is
parent-mediated and fails closed.** Claude's `SubagentStart`/`Stop` payloads carry
`agent_id`, `agent_type`, the **parent's** `session_id`, `transcript_path`, `cwd` and
`prompt_id` (`packages/agent-bridge/src/agent-state/claude-code.ts`), and some versions
supply no `agent_id` at all — the reducer then keeps an **anonymous count**. Rules:
(a) a child `agent_id` is **not** a `SessionId` and never becomes one; (b) a child's
delegation is **derived from its parent's binding** (P3), never minted from a hook payload
(P5); (c) **missing or mismatched child identity fails closed** — the child is counted, not
identified, and no binding is created for it. A subagent artifact may never write the
parent's `transcript-path` channel: a main transcript is always `<native_id>.jsonl`, and a
`subagents/` path under any other name is not legitimate parent evidence — the shipped
per-boot heal (`repairSubagentSegmentPaths`) nulls exactly those rows.

**C4 — Reattach restores an accepted checkpoint as bootstrap and must not synthesize a live
transition.** `reattachment-design.md` is authoritative: history may establish the current
snapshot but may **never impersonate a live edge**; a bootstrap snapshot may restore display
state and provider recency but emits no `session.phase`, no notification, no parent nudge,
no auto-continue and no hibernation mutation. The binding consequence: **binding a native
artifact is not evidence of activity.** Establishing or re-pinning a binding must not seed
`working`, must not seed a guessed agent state, and must not open a turn epoch — only a
provider-confirmed causal prompt does that. **The checkpoint is adjacent to the binding, not
part of it**: the binding owns *which conversation and which lease*; the checkpoint owns
*which cursor, which turn epoch, which terminal fence*. §10 keeps them separate stores for
this reason — merging them would make every binding write look like a state transition.

---

## 12. Store-tooling constraints (the constraint, not the verdict)

**The tooling choice belongs to POD-415 and the POD-359 ADR refresh.** The facts that
choice must be made with:

- The **daemon has no migration runner and no general store.** State is JSON files
  (`identity.ts` → `daemon.json`) plus in-memory observers. The only daemon SQLite is the
  worker-owned `discovery.db` **cache** — not a system of record.
- The **server-side `schema_version` concept is retired** (drizzle journal).
- The binding store is therefore **new persistence**, and per S1 its version is its own.

**S4 — Receipt fold outcome.** POD-737 folded the shipped spool into the v3 binding
store while preserving these constraints:

| Shipped property | Why a generalization must keep it |
|---|---|
| **One binding file per Podium `SessionId`** | Two sessions' receipts never contend; a partial write cannot lose another session's binding. |
| Legacy payload key `session_id` = the **native** id | The v3 migrator accepts in-flight files written by an older shell hook. |
| **Ack-gated deletion**, ack naming the exact value | Deleting on send loses a binding across a crash; deleting on a stale ack loses the *newer* binding silently (W9). |
| Atomic per-session binding rewrite | Recording and acknowledgement serialize per session and replace the binding file atomically. |
| At-least-once replay, idempotent server apply | The only durability contract that survives an unacked crash without a distributed transaction. |

Adding channels beyond `codex-thread` is **additive**. Introducing a relational schema, a
shared journal file, or send-time deletion is a rewrite of a working, load-bearing
component and should be rejected on that ground alone.

---

## 13. What this doc deliberately does not decide

- The binding store's **persistence technology** (POD-415, POD-359 refresh). §12 gives the
  constraints.
- The **`see`/`use`/`manage`** definitions, machine ownership, per-machine grants
  (POD-1079 / ADR 9 D6).
- The **`UserId` brand, `User` aggregate, per-user client sessions** (POD-1075, Phase 1).
- **Per-feature sharing behaviour** — deferred by the 2026-07-29 decision, class by class.
- **Field shapes** for the ownership/delegation group (ADR 4 Am1 D9); **matrix rows**
  (ADR 1 amendment, POD-1071).
- The **adopt command surface and UX** (POD-644). §6.7 constrains it; it does not design it.
- **Identity on `controllerId`** — Phase 5's separate shared-terminals deliverable
  (readiness §5). §3.4.3 only forbids treating it as a person today.
- **Whether `reparent` should confirm** when it widens a working agent's subtree scope
  (readiness §3.1.5 case 2). It is permission-affecting and does not read as one; surfacing
  it is the minimum, and the call is not this doc's.

---

## 14. Review checklist — the gate

Each row names the failure mode, the clause answering it, and what to attack.

### 14.1 Historical failure modes

| # | Failure mode | Answered by | Attack |
|---|---|---|---|
| 1 | **Reattach collapse onto the newest rollout** | W12, W11 | Three sessions spawned inside one lazy-file window; one marked, two not. Does any unmarked one bind? |
| 2 | **Subagent `pathHint` clobber** | C3, W4.1/W4.3, O5 | Under §8's key, can a subagent observation reach the parent's `transcript-path` channel at all? If yes the schema is wrong. |
| 3 | **Late transcript creation** | W4.5, `unbound` as a normal state (§6.1 success row), C1 | Any path in POD-415's plan where "no artifact yet" produces a value instead of `unbound`? |
| 4 | **Cross-wiring** | W11 row 5, W1, W12 | Two exact claims on one native id: neither pane hidden, merged or redirected; conflict visible. |

### 14.2 Handoff

| # | Failure mode | Answered by | Attack |
|---|---|---|---|
| 5 | Round-trip to a machine with a stale worktree | H4 | Export A→B→A with A's worktree moved on. Which side loses work? Is a *reused* worktree ever unwound on failure? |
| 6 | Empty bundle-base intersection (`d73e9121`) | H4.1 | Propose bases the source lacks — does export throw before staging? Branch tip exactly on a shared base — does the branch survive import? |
| 7 | Crash mid-transfer leaving two claimants | §6.7, R5, W14 | Kill the server between claim and commit; kill the source after claim. Two runnable sessions? Does recovery abort toward the source? |

### 14.3 SP-fccf

| # | Failure mode | Answered by | Attack |
|---|---|---|---|
| 8 | Unacked-receipt crash recovery | W9, R6, S4 | Crash after `rename` to `.ack`, deliver a newer hook, restart. Is the newer native id still pending? |
| 9 | **Process-ownership fallback binding conflicts** | **W11.1** (two exact values for one `(sessionId, channel)` — the correct cardinality; revision 1 cited W11, which is the opposite direction) | Make hook and process fallback name *different* native ids for one session with no proven succession. Does the head stop advancing? Is either acked? Is it visible? |

### 14.4 Multi-user

| # | Failure mode | Answered by | Attack |
|---|---|---|---|
| 10 | A human revoked while their agent is live | P4, P0.1 | Revoke mid-turn with queued outbox writes. Do they apply? Does the session say *why* it stopped, rather than going quietly idle? |
| 11 | A sub-agent spawn widening its parent's scope | P3, §6.1 authorization row | Refused **at mint time**, not silently narrowed and not caught only at apply. |
| 12 | Adoption onto a machine without `use` | P10, W15 | Is the error a denial, an "offline", or an empty list? A machine you cannot `see` must fail like a nonexistent id. |
| 13 | Two users racing reattach on a shared machine | P11, W13, W14, W15 | Both hold `use`, one holds a session grant; then both. One lease, correct response per caller, `onBehalfOf` unchanged, and disposal checked **by survivor, not only by victim** — winner still serving, an unrelated third session on that machine untouched (W14's test obligation). |

### 14.5 Structural

- [ ] Two axes, no field of one derived from the other (§2, §8).
- [ ] `SessionBinding` named as the delegation's lifecycle per ADR 9 D5/A5 (P1).
- [ ] Delegation is a **reference**, no cached capability (P2, P4); the **principal** is
      `(user, device, capability)` and is resolved, not stored (P0, P0.1).
- [ ] Owner/visibility/grants sourced from the Session aggregate, not duplicated (P9.1).
- [ ] Every current session representation crosswalked with a disposition (§3.4); all six
      `AgentKind`s specified (§3.4.4).
- [ ] Every asserted state is representable in §8 — `transfer` for claim/commit/abort,
      `observationId` for `supersedes`, `conflicted` for both cardinalities.
- [ ] Migration table with backfill, conflict handling and cutover (§10).
- [ ] Crash recovery covers daemon/server/transfer/receipt (§9).
- [ ] The four operational constraints are normative rules (§11).
- [ ] Cites readiness, POD-1070 and POD-1073 rather than restating them.
- [ ] No `instance_id`; SP-15aa namespace not repartitioned (P13).
- [ ] Nothing in §8/§12 forces a retrofit of the shipped spool (S4).

**Approval record.** _Pending reviewer._ Record reviewer, session and date here on approval;
that record unblocks POD-415, POD-416, POD-417, POD-644 and POD-737.

---

## 15. References

- `docs/multi-user-readiness.md` — §3.1.1, §3.1.3 A1–A5, §3.1.4 M1/M2/M5, §3.1.5,
  §3.1.6 S1/S5/S6, §2 (ADR 1 D5)
- ADR 9 (POD-1070) — D1 principal taxonomy, D2 owner/visibility/grants, D3 visibility
  classes, D5 agent delegation, D6 machines as owned compute, D7 cross-boundary writes
- ADR 3 + Amendment 1 (POD-1073) — D2 resource/action policy, D7 principal from
  authenticated transport only, D8 apply-time re-authorization, **D14 principal shape**,
  D18.5 the see/denied boundary
- ADR 1 + Amendment 1 (POD-1071) — D1 Authority arbitrates, D5 `InstanceId` is a deployment
  partition, the ownership matrix
- ADR 4 + Amendment 1 — D4 `HandoffManifest` is R6, D7 normalization law, D9 identity field
  shapes
- ADR 5 D7 / ADR 7 D2 — host↔server control traffic is **not** the agent command relay
- `docs/reattachment-design.md` (2026-07-18) — durable checkpoint, observation generation,
  race-free bootstrap-to-live handoff, the one side-effect gate
- `docs/spec/conversation-registry.md` (2026-07-02) — `ConversationId`, segments, the
  identity discipline, the transcript locator
- POD-364 `docs/rearch-field-schema-inventory.md` (`1475c062`, merged) — the 28
  session representations and the field→meaning map behind §3.4 and §10
- [spec:SP-fccf] Codex session identity · [spec:SP-15aa] instance runtime namespace
  (`c28463a6`) · [spec:SP-3f7a] portable session package · [spec:SP-eb60] naming doctrine
- Code: `packages/domain/src/session-identity.ts` (`51b136fe`) ·
  `apps/daemon/src/binding-store.ts` · `apps/daemon/src/identity.ts` ·
  `apps/server/src/modules/sessions/service.ts` (`sessionResumeRef`) ·
  `apps/server/src/store/conversations.ts` (`repairSubagentSegmentPaths`) ·
  `packages/agent-bridge/src/agent-state/codex.ts` (`resolvePinnedCodexRollout`, candidate
  selection) · `packages/agent-bridge/src/agent-state/claude-code.ts` (subagent hook
  payload) · `packages/agent-bridge/src/harness/adapters/codex.ts` (stdin close) ·
  `packages/protocol/src/messages/handoff.ts` · `packages/protocol/src/messages/terminal.ts`
  (`AgentKind`, `ResumeRef`) · `apps/daemon/src/handoff-package.ts` (`claudeProjectSlug`,
  `sourceKnownShas`) · `packages/domain/src/issue-authz.ts` (`OPERATOR`, being replaced)
- Issues: POD-323 (epic), POD-415, POD-416, POD-417, POD-644, POD-737, POD-498 (`2b0bc5d4`,
  `d73e9121`), POD-364, POD-365, POD-1070, POD-1071, POD-1073, POD-1075, POD-1079, POD-359
