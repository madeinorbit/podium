# SessionBinding: identity taxonomy on two axes

Status: **proposed — awaiting human approval** (this doc's approval is the gate)
Issue: POD-414 (5.1a) · Epic: POD-323 (5.1 SessionBinding) · Programme: POD-279 Phase 5
Date: 2026-07-30 · Verified against the worktree tip of `issue/414-…`

**This doc is the gate for POD-415 (binding store), POD-416, POD-417, POD-644 (adopt
transition) and POD-737 (fold the shipped Codex spool into the general observation
store).** No implementation code lands under POD-414; the deliverable is this document
and the review record in §10.

**Authoritative inputs.** `docs/multi-user-readiness.md` (human decision 2026-07-29:
multi-user within one tenant, private by default) and ADR 9
(`docs/adr/0009-identity-ownership-sharing.md`, POD-1070) plus the ADR 3 amendment
(POD-1073). Where this doc appears to differ from those, **they win** — this doc
consumes their vocabulary and does not define a competing one. The reattachment causal
contract (`docs/reattachment-design.md`, approved 2026-07-18) and the conversation
registry (`docs/spec/conversation-registry.md`, approved 2026-07-02) are already
approved and are **ratified here, not reopened**.

---

## 1. Decision in one paragraph

Session identity in Podium is **two axes that must never be collapsed into one record**.
Axis 1 is the identity of *the work*: an immutable Podium `SessionId` minted by the
server, a Podium `ConversationId` that spans native transcript segments, an
**attempt identity** minted by the daemon for each PTY or headless run, and
**native-artifact observations** — evidence records with observed-at times and
confidence, retained with history, keyed by the SessionId, and **never identity**. Axis
2 is the identity of *the actor*: the principal, which for an agent is the triple
`(agentIdentity, onBehalfOf: UserId, scope)` with a parent link up a delegation chain
rooted in exactly one human. **`SessionBinding` is one record carrying both axes**,
because ADR 9 D5/A5 decides that the agent principal is born and retired with its
binding rather than in a parallel identity system — which is also what makes delegation
survive cross-machine handoff for free. Every native id, path, rollout, thread, cwd and
worktree is an observation about a binding; none of them may replace, merge, hide or
redirect a live Podium session, and none of them may re-mint a principal.

---

## 2. Why two axes, stated before anything else

The whole downstream subtree will collapse these two if the doc does not force them
apart, because they meet in one row and one lifecycle. They are different questions:

| | Axis 1 — identity of the work | Axis 2 — identity of the actor |
|---|---|---|
| Answers | *Which conversation is this, and which run of it am I looking at?* | *Who is doing it, for whom, and with what rights?* |
| Failure mode when wrong | Two panes cross-wired onto one native thread; a transcript loads blank; a settled turn re-fires notifications | An unattended agent keeps rights its human no longer holds; handoff becomes a privilege-escalation path |
| Evaluated | At observation time, against a durable checkpoint | **At every apply**, live, against current rights (ADR 3 D8) |
| Source of truth | Server (`SessionId`, `ConversationId`), daemon (attempt), harness (native ids, as evidence) | The **authenticated transport** principal only (ADR 3 D7) |
| Carried by | `SessionBinding` §7 | `SessionBinding` §7, same record, distinct fields |

They share a lifecycle and a record. They do not share fields, and no field of one is
ever derived from the other.

---

## 3. Axis 1 — identity of the work

### 3.1 The four levels, kept strictly apart

| Level | What it identifies | Minted by | Mutable? | Lifetime |
|---|---|---|---|---|
| **SessionId** | One Podium session — the pane, the row, the thing a human points at | **Server** | Never | Created at spawn; survives reattach, resume, hibernate, worktree move, **and cross-machine handoff**; retired only when the session is deleted |
| **ConversationId** | One logical agent conversation, spanning N native transcript segments (`conv_<uuid>`) | **Server** | Never | Minted on first observation of a native conversation; gains segments on roll/resume/handoff |
| **Attempt identity** | One PTY or headless *run* of that session on one machine | **Daemon** | Never (a new run gets a new id) | Born when the process starts; dies with the process; **resets on handoff** |
| **Native-artifact observation** | Nothing. It is *evidence about* one of the above | **Harness** (Podium only records it) | The record is append-with-history; the observed value is whatever the harness wrote | Retained; superseded, never overwritten in place |

**W1 — SessionId is the only pane identity.** Every generic surface (tabs, sidebar, home
board, work items, issue counts, notifications, attribution) keys on `SessionId` and on
nothing else. This is already shipped doctrine: `packages/domain/src/session-identity.ts`
(`51b136fe`, [spec:SP-fccf]) keeps any resume-ref group that touches a live row visible
*in full*, precisely so that using native metadata to hide even a parked sibling cannot
make a live row participate in native-id identity.

**W2 — ConversationId is above native artifacts, and lineage is observed, not guessed.**
`docs/spec/conversation-registry.md` §3.1 is ratified: `conversation_identities` holds
the identity, `conversation_segments` holds the evidence keyed
`(machine_id, native_id)` with a `linked_by` provenance of `live-roll`,
`resume-origin` or `discovery`. Lineage is established from what the server *observed on
a live session* (old ref → new ref on the same `SessionId`), never from fingerprint
heuristics; cold-scan matching stays deferred because mis-merging is the failure to
avoid. A resume that rolls into a new file is a **new segment, not a new conversation**.

**W3 — Attempt identity is distinct from the observation generation, and both exist.**
These are two fences with two owners and they must not be merged:

- **Attempt id** (daemon-minted) names *which run of the process this is*: this abduco
  session, this PTY, this headless invocation. It answers "is the thing I am reading the
  output of the same process I started?"
- **Observation generation** (server-minted, monotonic, per `docs/reattachment-design.md`
  §"Race-free bootstrap-to-live handoff" step 1) names *which observer lease may submit
  evidence*. It answers "is this frame allowed to change accepted state?"

A daemon restart with a surviving process yields a **new generation, same attempt**. A
process restart yields **a new attempt, and a new generation**. Collapsing them would
either let a stale daemon socket speak for a live process or force a spurious process
identity change on every reconnect. The generation contract in `reattachment-design.md`
is unchanged by this doc; attempt id is the additional field POD-415 persists.

**W4 — Native-artifact observations are evidence records with history, never identity.**
An observation is `(sessionId, channel, observedValue, confidence, observedAt, source)`.
Normative rules, generalizing [spec:SP-fccf]:

1. Observations are **keyed by the immutable Podium `SessionId`**, never the reverse. A
   native id is never a primary key of a session.
2. **No observation may replace, merge, hide or redirect a live Podium session.** Not the
   native thread id, not the rollout path, not the transcript path, not the cwd, not the
   worktree.
3. Observations are **retained with history**. A superseding observation appends; it does
   not erase its predecessor. History is what makes a conflict diagnosable instead of
   merely surprising.
4. Each observation carries **confidence**: `exact` (a native hook for this exact
   session, a launch marker, or a proven process→artifact ownership) or `heuristic`
   (discovery by cwd, time window, or path shape). §5 decides what each may do.
5. **Absence is a state, not a licence to guess.** `unbound` is a legitimate, expected
   value — see the late-transcript-creation mode in §10.

`apps/daemon/src/codex-identity-receipts.ts` is the **reference implementation** of
observation-with-history durability: one file per stable Podium session id, an
at-least-once replay, ack-gated deletion, and atomic `.ack` claim files that recover a
crash between claim and delete. §8 states what a generalized store may and may not
change about it.

### 3.2 Minting responsibilities

**W5.** Exactly one party mints each level, and no other party may invent one:

| Minted | By | Rule |
|---|---|---|
| `SessionId` | **Server** | The server is the sole Authority (ADR 1 D1). A daemon that receives an unknown `SessionId` does not create it; the server refuses a client-supplied id that already exists (`relay.ts` — "never clobbers a live session"). |
| `ConversationId` | **Server** | Minted at the registry seam where lineage is observed (`apps/server/src/modules/sessions/service.ts`, `sessionResumeRef`). |
| Observation generation | **Server** | Incremented and durably stored **before** `spawn`/`reattach` is sent; carried on the control message. |
| Attempt id | **Daemon** | The daemon owns the process. It is the only party that knows a run started, and it must be able to mint one while disconnected from the server. |
| Native ids | **Harness** | Podium never allocates one and never derives one. Claude allocates its `session_id` and its jsonl; Codex allocates its thread id and rollout; Grok its session dir. |

**W6 — The server never invents an alias.** This is the single most load-bearing clause
of Axis 1. The server may *record* an alias reported by a machine that owns the session,
may *arbitrate* between two reported aliases (§5), and may *refuse* one. It may not
synthesize a native id, derive one from a path, or promote a heuristic to exact. The
existing guard is already correct and is ratified: a daemon may bind only sessions owned
by its authenticated machine, and an acknowledgement is never sent to a foreign
instance.

### 3.3 Server ↔ host synchronization direction

**W7 — Two directions, two kinds of content, one plane family.**

- **Upward (host → server): evidence.** Native id observations, cursors, attempt starts
  and exits, resolved paths, host metrics. Upward traffic is *never* authority: it is
  submitted under an observation generation and accepted or rejected by the server's
  durable gate (`reattachment-design.md` §"The one side-effect gate").
- **Downward (server → host): authority.** The binding, the observation generation, the
  delegation record, the resume ref to pin, the attempt to reattach, the adopt
  instruction. Binding updates ride the **control plane**.

**W8 — Binding traffic is host↔server control traffic, not the agent command relay.**
ADR 5 D7 and ADR 7 D2 already decide this, independently re-derived in [spec:SP-fccf]
and [spec:SP-a43e]: the relay bakes session identity into its URL path, so multiplexing
resume-ref and `sessionResumeRefAck` over it would re-home identity and break
`PODIUM_NO_RELAY` hermetic tests. POD-415 must not "save a port".

**W9 — Retain-until-server-ack durability, at-least-once, idempotent apply.** The host
retains an unacked observation across its own crash and replays it; the server persists
idempotently and only then acks; only the ack removes the host's copy. An ack names the
exact value being acknowledged, so a newer observation that arrived while an older ack
was in flight **stays pending** rather than being silently dropped. This is the shipped
`CodexIdentityReceipts.acknowledge` contract, generalized.

**W10 — Acks are gated on confidence.** Only an `exact` observation is acknowledged,
because an ack is a promise that the server's durable state now names that value. A
heuristic observation may inform display and may be retained as history; it is never
acked and never durable authority.

---

## 4. Concurrent-reattach arbitration policy

Two things can race: two observers claiming the same *native artifact*, and two
principals claiming the same *session*. Both resolve to the same rule shape — **exactly
one claimant, and a conflict fails visibly** — but the arbitrators differ.

### 4.1 Artifact-level: one native thread belongs to one interactive Podium session

**W11 — Precedence: exact beats heuristic; exact-vs-exact refuses.**

| Situation | Outcome |
|---|---|
| Heuristic claim, no established binding | Recorded as heuristic evidence. May inform display. Never acked, never durable. |
| Heuristic claim, established binding on another session | **Ignored, and logged.** A timing-only observer never overwrites an established binding. |
| Exact claim, no conflict | Bound, persisted, acked. |
| Exact claim, conflicting bindings on other sessions | Exact wins; the stale siblings' refs are **cleared** so the one-thread-one-pane invariant heals in place; the change is broadcast. |
| **Two exact claims on the same native id from different live sessions** | **Visible fail.** Neither pane is hidden, merged or redirected; the conflict is surfaced with both observations and their history. No silent tie-break. |

The shipped `sessionResumeRef` handler already implements the first four rows; the fifth
is the generalization POD-415 owes. **Visible-fail-on-conflict is deliberate**: a
tie-break here means picking which of a human's two live agents to disconnect, and a
wrong automatic answer is worse than a legible error.

**W12 — Never "newest".** Selecting the newest artifact is the cross-wiring bug, not a
heuristic. Codex creates its rollout **lazily** (often at the first prompt, minutes after
boot), so several sessions' rollouts can sit past a reattach floor at once; the sibling
spawned *later* boots later, so the candidate **nearest after this session's own floor**
is its own, and newest-first cross-wires panes. Where a launch marker exists it is exact
evidence and therefore **mandatory** — an unmarked candidate is not eligible when the
daemon supplied a Podium session id, and a new unmarked launch **waits for its native
hook rather than guessing a sibling** (`resolvePinnedCodexRollout` returns `undefined`
and the poller retries).

### 4.2 Session-level: one claimant machine, one observer lease

**W13.** A session has at most one **claimant machine** and at most one **valid
observation generation** at a time.

1. Reattach is a server decision. The server increments the generation, durably stores
   it, and sends it with `reattach`. Frames from an older generation are inert on
   arrival — the loser of a race does not corrupt state, it is simply ignored.
2. The claimant machine is a field of the binding, not an inference from who spoke last.
   A frame whose machine is not the claimant is dropped (already shipped for
   `sessionCwd`: a handoff reuses the same `SessionId` on the target, and a frame queued
   by the old daemon must never restamp the target row).
3. **Two principals racing reattach on a shared machine** is authorization, not
   arbitration — see P11.

---

## 5. Axis 2 — identity of the actor (the principal)

This section states in normative terms what ADR 9 D5 decides and what readiness §3.1.3
A1–A5 directs. It **consumes** the vocabulary of POD-1073 (ADR 3 amendment) and POD-1070
(ADR 9); the `UserId` brand, the `User` aggregate and per-user client sessions land in
Phase 1 at POD-1075. Today `packages/domain/src/issue-authz.ts` defines
`OPERATOR = { role: 'admin', scope: { kind: 'all' } }` — that is the single-operator
vocabulary being replaced, and this doc does not extend it.

### 5.1 SessionBinding *is* the agent principal's lifecycle

**P1 (normative).** The agent principal is **born with its `SessionBinding` and retired
with it**. There is no parallel agent-identity registry, no second alias history, and no
second revocation path. ADR 9 D5/A5 chose this so that (a) delegation survives
cross-machine handoff for free, since the binding is what handoff carries, and (b)
Phase 5's binding work — which is already solving one-to-many alias history and crash
recovery — absorbs delegation instead of duplicating it.

Consequence: **retiring a binding retires the delegation.** There is no reaper to write.

### 5.2 The delegation record

**P2.** A binding carries a delegation record with exactly these parts:

| Field | Meaning |
|---|---|
| `actor` | The agent identity — this session, as a principal. `Capability.actorSessionId` is the existing seam. |
| `onBehalfOf` | Exactly one `UserId`. The human this agent acts for. |
| `grantedScope` | What this agent was spawned for. Default narrow (P6). |
| `parent` | The binding of the delegating agent, or null when a human spawned this session directly. |

**P3 — Chain rules.** Exactly **one human sits at the root** of a chain. A sub-agent
delegates **from its parent agent**, never directly from the root human. Scope is
**monotonically narrowing**: a sub-agent may narrow and may never widen. Effective rights
are the **intersection over the whole chain**, intersected with the root human's
*current* rights, evaluated at every apply.

**P4 — The record is a REFERENCE, never a rights snapshot.** `grantedScope` is a scope,
not a capability; `onBehalfOf` is a pointer to a user, not a copy of that user's rights.
Effective rights are resolved at **every apply**, including outbox replay, per ADR 3 D8.

> *Rationale, recorded because it will be re-litigated.* A snapshot leaves unattended
> agents running with rights the human no longer holds, and has **no cleanup trigger** —
> in a system where agents run for hours without supervision, the failure is silent and
> the agent keeps working. Live resolution makes revoking a human **transitively disable
> their agents**, with no reaper to write and none to forget. The cost is resolving a
> chain instead of reading a stored capability, on a path (D8) that already re-authorizes
> every apply. This is the case D8 was over-engineered for under single-user, arriving.

**P5 — Where the delegation is minted, and where it is not.**

- **Minted:** at **spawn**, from the **authenticated transport principal** (ADR 3 D7),
  and never from payload. Forged payload identity stays inert.
- **Carried unchanged** through: reattach, hook re-pin, headless allocation, worktree
  move, resume from hibernation, and **handoff adopt**.
- **Ended:** when the binding retires.

No other event mints a delegation. In particular a hook, an observation, a native id, an
adopt import, or a daemon reconnect **never** mints or alters one — they are Axis 1
events and Axis 1 events have no authority over Axis 2.

**P6 — Default scope is narrow.** The default `grantedScope` is *what the agent was
spawned for*: its session, its issue, that issue's subtree — **not** everything its human
can see (ADR 9 D5/A2). Widening is explicit and travels the already-shipped
`overrideScope` / `--outside-scope` → `confirm-required` path (ADR 3 D2).
`IssueScope.subtree` is already reserved and already enforced by `authorize()`.

**P7 — The superagent is the justified broad-scope exception.** Per ADR 9 D8/S1 and
readiness §3.1.6 S1, the superagent is *not a fifth principal kind*: it is an agent
delegation whose scope is **everything its human can see** — spawned *for a person*
rather than *for a task*, so ceiling and scope coincide. The representation must be able
to carry that scope **without making it the default**: broad scope is a value of
`grantedScope`, never an absent or wildcard default. Scheduled automations are delegated
the same way (S6) and inherit live evaluation for free. **System automations are not
delegated at all** (S5): the steward, expiry jobs and boot reconcile have no human behind
them, write only as `system`, and must never be given an `onBehalfOf`.

**P8 — Attribution is a pair.** Every write records **actor** *and* **on-behalf-of**,
both stamped from the transport principal, never from payload (ADR 9 D5/A3). Collapsing
them destroys distinctions the product already ships: human-set `name` outranks agent-set
(`nameSource`, [spec:SP-eb60]) and `humanQuestionAskedBy` is server-authoritative
precisely so "did a person or an agent ask this?" stays answerable.
`Capability.actorSessionId` is the existing seam for the actor half; **the on-behalf-of
half is new**.

**P9 — Ownership of output.** For entities an agent creates: `owner = onBehalfOf`,
`actor = the agent` (ADR 9 D5/A4). Otherwise the personal sidebar — the product goal that
motivated private-by-default — would not show work your own agent did for you, and
retiring an agent session would orphan its issues.

### 5.3 Machine access

**P10.** Spawn, reattach and **adopt** all require **`use` on the target machine**. The
`see` / `use` / `manage` verbs, the machine owner, and the per-machine grant list are
defined by **POD-1079 (machine ownership + grants, Phase 4 per
`docs/rearchitecture-v3.md`)** and ADR 9 D6 — **not here**. This doc states
only the three consequences for bindings:

1. A binding cannot be created, reattached or adopted on a machine whose `use` the
   acting principal lacks. Denial is a first-class outcome.
2. **A denial is distinct from unreachable** (M5). "Denied" and "offline" otherwise
   produce the same empty list and the same support ticket. The distinction holds
   **inside the principal's `see` set only** — a machine the principal cannot `see` is
   *absent*, and any reference to it fails identically to a nonexistent machine id
   (ADR 3 Amendment 1 D18.5 owns that boundary; read it with M5).
3. Note for the reader, because it will be under-read: **`use` is a code-execution
   boundary, not a privacy one** (M2). It means running with the machine owner's SSH
   keys, `git`/`gh` identity, dotfiles, cloud CLI sessions and whatever private
   repositories are checked out there. Granting it is a high-trust act and must read as
   one, not as a checkbox.

**P11 — Two users racing reattach on a shared machine.** `use` on the machine is
necessary and **not sufficient**. Reattaching a session is an operation on that
*session*, so it additionally requires the principal to pass the session's own
visibility/owner/grant test (ADR 9 D2's ordering: visibility, then owner, then grants,
then role). A colleague with `use` on the machine but no grant on the session is denied
**at the session**, not at the machine. When both principals do pass, §4.2's
generation fence decides — one lease, the loser's frames inert — and **the session's
`onBehalfOf` does not change**: reattaching someone else's session does not make it
yours.

### 5.4 Cross-machine consequence, stated explicitly

**P12.** On handoff, the `SessionId` **and the delegation are both stable**; the attempt
identity resets; and **the importing principal does NOT become the session's human**.

This is stated as its own numbered clause because the alternative is a live
vulnerability: **re-minting the delegation on import would turn handoff into a
privilege-escalation path** — export a session, import it as yourself, and its agent now
runs with your rights instead of the original human's. The adopt transition (POD-644)
therefore carries `onBehalfOf` verbatim and mints nothing on Axis 2.

### 5.5 Not multi-tenancy

**P13.** ADR 1 D5 stands: **`InstanceId` is a deployment partition**. Multi-user lives
*inside* one instance. Therefore:

- The binding store **must not** propose `instance_id` columns.
- The SP-15aa instance runtime namespace (`c28463a6`) **must not** be repartitioned by
  user. Runtime paths stay instance-scoped.
- **Ownership is a field, not a path.**

---

## 6. Cross-machine handoff (POD-498, landed `2b0bc5d4` + `d73e9121`)

**H1 — `SessionId` is stable across machines**, carried **verbatim** in the
`HandoffManifest` and **reused on import**. The manifest already carries `sessionId` at
`packages/protocol/src/messages/handoff.ts`.

**H2 — Attempt identity resets on the target.** The source process is gone; a new run is
a new attempt, and the server issues a new observation generation. Cursors from the
source attempt are **not comparable** to the target's until the adapter proves a segment
succession (`reattachment-design.md` invariant 5).

**H3 — Native artifacts are RE-OBSERVED on arrival and never carried as identity.**

- The **Claude jsonl** is re-derived at the target project slug — `claudeProjectSlug` of
  the **new cwd** in `apps/daemon/src/handoff-package.ts` — because Claude buckets
  transcripts by the cwd the conversation was *created* under. The manifest carries
  `transcriptFilename` / `transcriptRelativeDir` as *payload and evidence*, not as a
  path to trust.
- The **Codex rollout** is re-pinned via `resolvePinnedCodexRollout`, which resolves a
  known thread id to its own file and **returns `undefined` until the file exists** so a
  just-imported session waits rather than latching onto a sibling.
- The re-observed native id links as a **new segment on the same `ConversationId`**
  (W2). `conversation_segments` is keyed `(machine_id, native_id)`, so the target gets
  its own segment row and the conversation identity is unchanged.

**H4 — Worktrees are reused-and-hard-synced or recreated.** A round trip returns to a
machine where the old worktree still exists: the importer **reuses it and hard-syncs**
(`reset --hard` + `clean -fd`) to the package state, and never unwinds a *reused*
worktree on failure — only ones it created (`d73e9121`). Import must not reset a checkout
another resumable session still owns; `occupiedWorktreePaths` on
`HandoffImportRequestMessage` exists for exactly that, and is optional only for
mixed-version daemons. `worktreeRelativePath` and `cwdSubpath` place the resumed agent;
the daemon reports the resolved `worktreeRoot` back rather than letting the server
re-derive it by stripping the subpath.

**H4.1 — The bundle base is an intersection, and an empty one fails at export.**
`bundleBase` is not the target's wish list: the exporter intersects the target-proposed
bases with the shas the **source** repo actually has (`sourceKnownShas`) and **throws
before staging** when the intersection is empty — a target's freshly-fetched
`origin/main` aborted `bundle create` with `bad object` until this was fixed
(`d73e9121`). A branch whose tip sits exactly on a shared base is dropped from the bundle
by git, so import derives the tip from the manifest and creates the branch explicitly,
fetching through a temp incoming ref so a branch checked out in the abandoned source
worktree cannot block the fetch.

**H5 — `sourceMachineId` and `exportedAt` are provenance.** They record where a bundle
came from and when. They are **never** identity, never authorization input, and never a
reason to accept a frame (see §4.2 clause 2).

**H6 — Single-claimant across the transfer.** The binding names exactly one claimant
machine. Adopt is a transition on the server-side binding — *claim*, then *commit* —
and **until commit the source remains the claimant**. Two claimants must be impossible by
construction; if two are ever observed, the outcome is a visible fail and a refusal to
run both, never a silent pick.

---

## 7. `SessionBinding`: the record

One record, both axes, explicitly separated. Field shapes are owned by ADR 4
Amendment 1 D9 and the model package (POD-288/POD-301 family); this is the semantic
definition POD-415 implements.

```ts
interface SessionBindingV1 {
  schemaVersion: 1

  // ---- Axis 1: identity of the work -------------------------------------
  sessionId: SessionId                  // server-minted, immutable, stable across machines
  conversationId: ConversationId | null // server-minted; null until a conversation is observed
  provider: 'claude-code' | 'codex' | 'grok'

  claimantMachineId: MachineId          // exactly one; changes only at an adopt commit
  attemptId: AttemptId | null           // daemon-minted; null when no run is live
  observationGeneration: number         // server-minted, monotonic; the observer lease fence

  /** Evidence with history. Never identity. Never a key. */
  observations: NativeObservation[]

  // ---- Axis 2: identity of the actor ------------------------------------
  delegation: {
    actor: AgentIdentity
    onBehalfOf: UserId                  // a REFERENCE. Never a rights snapshot (P4).
    grantedScope: Scope                 // narrow by default (P6); broad only for a superagent (P7)
    parentBindingId: SessionId | null    // the delegation chain (P3)
  } | null                              // null for a `system` principal (P7/S5)

  // ---- Lifecycle --------------------------------------------------------
  state: 'unbound' | 'bound' | 'conflicted' | 'retired'
  createdAt: string
  retiredAt: string | null
}

interface NativeObservation {
  channel: 'resume-ref' | 'transcript-path' | 'rollout-path' | 'process-ownership' | 'cwd'
  value: string
  confidence: 'exact' | 'heuristic'
  source: 'native-hook' | 'launch-marker' | 'process' | 'discovery' | 'handoff-import'
  observedAt: string                    // when the harness/host observed it
  recordedAt: string                    // when the server durably accepted it
  supersedes: string | null             // prior observation id on the same channel
}
```

Notes that are decisions, not commentary:

- **`state: 'conflicted'` is a real state**, not an error path. §4.1's exact-vs-exact
  case must be representable and visible, because visible-fail is the policy.
- **`state: 'unbound'` is normal.** A just-spawned Codex or Claude session is legitimately
  unbound until its native artifact exists. Absence never justifies a guess.
- **`delegation: null` means `system`** (P7/S5) — it does not mean "unknown" and never
  means "unconstrained".
- **No `instance_id`** (P13).

### 7.1 Schema version

**S1.** `schemaVersion` is the binding store's own version, **independent of the server
database's migration journal.** The server-side `schema_version` concept is retired — the
drizzle journal replaced it — and the daemon-side store is new persistence with no
journal at all. Versioning them together would couple a daemon file format to a server
migration lineage that does not describe it.

**S2 — Fail closed on a newer version.** A reader that encounters a `schemaVersion` it
does not know **refuses the record and reports it**; it does not best-effort parse and it
does not delete. An unparseable binding must never become an unbound session that a
guess can then fill in. (Memory of this project's own trap: a gate that cannot parse its
input must be *tested* to refuse it, not assumed to.)

**S3 — Unknown fields are preserved.** A daemon older than the server must round-trip
fields it does not understand rather than dropping them on rewrite, because there is no
migration runner to repair the loss.

---

## 8. Store-tooling constraints (the constraint, not the verdict)

**The tooling choice belongs to POD-415 and the POD-359 ADR refresh.** This doc records
what is true today so that choice is made with the facts:

- The **daemon has no migration runner and no general store.** State is JSON files
  (`identity.ts` writing `daemon.json`) plus in-memory observers. The only daemon SQLite
  is the **worker-owned `discovery.db` cache**, which is a cache and not a system of
  record.
- The **server-side `schema_version` concept is retired** (drizzle journal).
- Therefore the binding store is **new persistence**, and per S1 its version is its own.

**S4 — Do not force a retrofit of the shipped spool.** `codex-identity-receipts.ts` is
live, durable, crash-tested, and is the reference implementation this doc generalizes.
POD-737 folds it into the general observation store. Any abstraction that changes the
following would be a **retrofit, and is flagged here as a design constraint on
POD-415**:

| Shipped property | Why a generalization must keep it |
|---|---|
| **One file per Podium `SessionId`** (`<sessionId>.json`) | A single shared file or a table makes two sessions' receipts contend, and makes a partial write lose an unrelated session's binding. Per-session files are why crash recovery is a rename and a link. |
| Payload key `session_id` = the **native** id | Renaming it breaks in-flight receipts written by the shell hook of an older daemon. The hook is not upgraded atomically with the daemon. |
| **Ack-gated deletion**, ack naming the exact value | Deleting on send loses a binding across a crash; deleting on a stale ack loses the *newer* binding silently (§W9). |
| Atomic `.ack` **claim** files + `link()` restore | `link()` is create-if-absent, so restoring a claim can never overwrite a newer receipt — which `rename()` could. A store that replaces this with read-modify-write reintroduces the lost-update. |
| At-least-once replay, idempotent server apply | The only durability contract that survives an unacked crash without a distributed transaction. |

A generalization that keeps these five and adds channels beyond `codex-thread` is
additive. One that introduces a relational schema, a shared journal file, or
send-time deletion is a rewrite of a working, load-bearing component and should be
rejected on that ground alone.

---

## 9. What this doc deliberately does not decide

Recorded so it is not rediscovered mid-implementation, and so nobody reads silence as a
decision:

- The **binding store's persistence technology** (POD-415, POD-359 refresh). §8 gives
  the constraints.
- The **`see` / `use` / `manage`** verb definitions, machine ownership and the
  per-machine grant list (POD-1079 / ADR 9 D6).
- The **`UserId` brand, `User` aggregate and per-user client sessions** (POD-1075,
  Phase 1).
- **Per-feature sharing behaviour** — deliberately deferred by the 2026-07-29 human
  decision, decided class by class.
- **Field shapes** for the ownership/delegation group (ADR 4 Amendment 1 D9) and matrix
  rows (ADR 1 amendment, POD-1071).
- The **adopt transition's** command surface and UX (POD-644). §6 constrains it; it does
  not design it.
- **Whether `reparent` should confirm** when it widens a working agent's subtree scope
  (readiness §3.1.5 case 2). It is a permission-affecting operation and does not read as
  one; surfacing it is the minimum, and the call is not this doc's.

---

## 10. Review checklist — the approval gate

**Acceptance requires a human walking this list and recording an approval.** Each row
names the failure mode, the clause that answers it, and what the reviewer should try to
break.

### 10.1 Historical failure modes (POD-414 AC)

| # | Failure mode | Answered by | What to attack |
|---|---|---|---|
| 1 | **Reattach collapse onto the newest rollout** — two panes bound to one native thread because discovery took the newest artifact | W12 (never "newest"; nearest-after-floor; marker mandatory when a session id is supplied; wait rather than guess), W11 (heuristic never overrides exact) | Three sessions spawned within one lazy-file window; one has a marker, two do not. Does any unmarked one bind? |
| 2 | **Subagent `pathHint` clobber** — a subagent transcript summarized under its parent's native id overwrote the parent's segment path, so reattach boot-seeded from the wrong file | W4.1 (observations keyed by `SessionId`, per channel), W4.3 (append, never overwrite in place). A main transcript is always `<native_id>.jsonl`; a `subagents/` path under any other name is **never legitimate evidence** for the parent — the shipped per-boot heal (`repairSubagentSegmentPaths`) nulls exactly those rows | Can a subagent observation reach the parent's `transcript-path` channel at all under §7's key? If yes, the schema is wrong. |
| 3 | **Late transcript creation** — the artifact does not exist at spawn, so a binder that must produce a value guesses a sibling | W4.5 + `state: 'unbound'` as a normal state; `resolvePinnedCodexRollout` returns `undefined` and retries | Is there any code path in POD-415's plan where "no artifact yet" produces a value instead of `unbound`? |
| 4 | **Cross-wiring** — a pane's chat view wired onto a sibling's (or a guardian's) transcript | W11 row 5 (exact-vs-exact = visible fail), W1 (`SessionId` is the only pane identity), W12 | Two exact claims on one native id. Confirm neither pane is hidden, merged or redirected, and that the conflict is *visible*. |

### 10.2 Handoff failure modes

| # | Failure mode | Answered by | What to attack |
|---|---|---|---|
| 5 | **Round-trip to a machine with a stale worktree** | H4 (reuse-and-hard-sync; never unwind a reused worktree on failure; `occupiedWorktreePaths` must not reset a checkout another resumable session owns) | Export A→B→A where A's worktree moved on in the meantime. Which side loses work? |
| 6 | **Empty bundle-base intersection** (the `d73e9121` bug class) | H4.1 — the base set is the intersection of target-proposed and **source-known** shas, and an empty intersection **throws at export, before staging** | Propose bases the source does not have. Does export fail loudly, or stage a bundle that cannot apply? Then: branch tip exactly on a shared base — does the branch survive import? |
| 7 | **Crash mid-transfer leaving two claimants** | H6 (claim-then-commit; source stays claimant until commit; two claimants ⇒ visible fail, never a silent pick), §4.2 clause 2 (a non-claimant's frames are dropped) | Kill the server between claim and commit. Kill the source daemon after claim. Does either produce two runnable sessions? |

### 10.3 SP-fccf failure modes

| # | Failure mode | Answered by | What to attack |
|---|---|---|---|
| 8 | **Unacked-receipt crash recovery** — daemon dies between the atomic claim and the compare/delete | W9 + S4 (claim files restored via `link()`, which cannot overwrite a newer receipt; a stale ack restores rather than deletes) | Crash after `rename` to `.ack`, then deliver a newer hook, then restart. Is the newer native id still pending? |
| 9 | **Process-ownership fallback binding conflicts** — a Linux process→rollout binding recorded through the same acked spool as the hook | W4.4 + W11 (both are `exact`; therefore two exact claims on one native id is the §4.1 row-5 visible fail, not a precedence question) | Make the hook and the process fallback name *different* native ids for one session. Is the result visible, or does last-writer win? |

### 10.4 Multi-user failure modes

| # | Failure mode | Answered by | What to attack |
|---|---|---|---|
| 10 | **A human revoked while their agent session is live** | P4 (live intersection at every apply, incl. outbox replay) — revocation does **not** retire the binding; it **empties** the effective rights. The session must surface as blocked-on-authorization, not silently idle | Revoke mid-turn with queued outbox writes. Do the queued writes apply? Does the UI say *why* the agent stopped? |
| 11 | **A sub-agent spawn attempting to widen its parent's scope** | P3 (monotone narrowing; intersection over the whole chain), P5 (minted at spawn from the transport principal, never from payload) | Spawn a child requesting a wider scope. It must be refused **at mint time**, not silently narrowed and not caught only at apply. |
| 12 | **Adoption onto a machine without `use` granted** | P10 (adopt requires `use`; denial is distinct from unreachable, inside the `see` set only) | Adopt onto a teammate's laptop. Is the error a denial, an "offline", or an empty list? A machine you cannot `see` must fail like a nonexistent id. |
| 13 | **Two different users racing reattach on a shared machine** | P11 (`use` necessary, not sufficient — the session's own visibility/owner/grant test applies; then §4.2's one-lease fence), P12 (`onBehalfOf` does not change) | Both hold `use`; only one holds a grant on the session. Then both hold grants. Confirm one lease, inert loser, unchanged `onBehalfOf`. |

### 10.5 Structural criteria

- [ ] The doc presents **two axes**, and no field of one is derived from the other (§2, §7).
- [ ] **`SessionBinding` is named as the agent principal's lifecycle** per ADR 9 D5/A5 /
      readiness §3.1.3 A5 (P1).
- [ ] The delegation record is specified as a **reference with no cached capability**
      (P2, P4).
- [ ] The doc **cites** `docs/multi-user-readiness.md`, POD-1070 and POD-1073 rather than
      restating or contradicting them (§1, §5).
- [ ] No `instance_id` column is proposed; the SP-15aa runtime namespace is not
      repartitioned by user (P13).
- [ ] Nothing in §7/§8 forces a retrofit of the shipped Codex spool (S4).

**Approval record.** _Pending._ On approval, record the date and the reviewer here; that
record is what unblocks POD-415, POD-416, POD-417, POD-644 and POD-737.

---

## 11. References

- `docs/multi-user-readiness.md` — §3.1.1, §3.1.3 A1–A5, §3.1.4 M1/M2/M5, §3.1.5,
  §3.1.6 S1/S5/S6, §2 (ADR 1 D5: multi-user is not multi-tenancy)
- ADR 9 `docs/adr/0009-identity-ownership-sharing.md` (POD-1070) — D1 principal
  taxonomy, D2 owner/visibility/grants, D3 visibility classes, D5 agent delegation,
  D6 machines as owned compute
- ADR 3 `docs/adr/0003-command-security.md` + Amendment 1 (POD-1073) — D2 resource/action
  policy, D7 principal from authenticated transport only, D8 apply-time
  re-authorization, D18.5 the see/denied boundary
- ADR 1 — D1 Authority arbitrates, D5 `InstanceId` is a deployment partition
- ADR 4 + Amendment 1 — D4 `HandoffManifest` is R6, D7 normalization law, D9 identity
  field shapes
- ADR 5 D7 / ADR 7 D2 — host↔server control traffic is **not** the agent command relay
- `docs/reattachment-design.md` (approved 2026-07-18) — durable checkpoint, observation
  generation, race-free bootstrap-to-live handoff, the one side-effect gate
- `docs/spec/conversation-registry.md` (approved 2026-07-02) — `ConversationId`,
  segments, identity discipline
- [spec:SP-fccf] Codex session identity · [spec:SP-15aa] instance runtime namespace
  (`c28463a6`) · [spec:SP-3f7a] portable session package · [spec:SP-eb60] naming doctrine
- Code: `packages/domain/src/session-identity.ts` (`51b136fe`),
  `apps/daemon/src/codex-identity-receipts.ts`,
  `apps/server/src/modules/sessions/service.ts` (`sessionResumeRef`),
  `apps/server/src/store/conversations.ts` (`repairSubagentSegmentPaths`),
  `packages/agent-bridge/src/agent-state/codex.ts` (`resolvePinnedCodexRollout`,
  rollout candidate selection), `packages/protocol/src/messages/handoff.ts`,
  `apps/daemon/src/handoff-package.ts` (`claudeProjectSlug`),
  `packages/domain/src/issue-authz.ts` (`OPERATOR`, being replaced)
- Issues: POD-323 (epic), POD-415, POD-416, POD-417, POD-644, POD-737, POD-498 (landed
  `2b0bc5d4`, `d73e9121`), POD-1070, POD-1073, POD-1075, POD-1079, POD-359
