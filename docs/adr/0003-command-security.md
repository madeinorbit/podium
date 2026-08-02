# ADR 3 — Command security & lifecycle

- **Status:** Proposed (human gate: POD-359)
- **Date:** 2026-07-17
- **Deciders:** architecture rewrite ADR pack (POD-359); human sign-off before Phase 1
- **Issue:** POD-749 (leaf of POD-359 item 3; supersedes the six-ADR scope of POD-354 for this topic)
- **Consumers:** Phase 1 walking skeleton POD-351; Phase 2 Outbox POD-306 / POD-369–373 / POD-372; Phase 3 command framework POD-311, security POD-315, offline/outbox UX POD-316, secrets split POD-352 (and children POD-418–421)
- **Related ADRs:** ADR 1 (authority/ownership matrix — conflict rules & secret classification), ADR 2 (sync protocol — mutation identity, feed/receipt horizons, heal-keeps-outbox, `expectedRevision` token), ADR 4 (representation — optimistic overlay is not a representation role), ADR 5 (peer topology — role-specific auth strategies), ADR 6 (replica storage — outbox durability bounds; shared transactional store with cursor/overlay), ADR 7 (plane inventory — command as control-plane request/reply class), ADR 8 (package topology — `packages/commands` placement)

---

## Context

Podium already has a **command registry** for issues and locks
(`apps/server/src/modules/issues/registry.ts`,
`apps/server/src/modules/lock/registry.ts`) derived from a leaf contract type
`CommandDef` in `packages/protocol/src/commands.ts` ([spec:SP-3fe2]). Four
surfaces share handlers today: HTTP tRPC, daemon agent relay
([spec:SP-b85a]), in-process MCP, and CLI (presentation over the same table).
A generic `MutationEnvelope` / `MutationResult` lives in
`packages/protocol/src/messages/mutations.ts` but nothing on the wire sends it
yet. The client outbox (`packages/client-core/src/outbox.ts`,
`docs/spec/outbox-write-path.md`) is a durable FIFO with stable `mutationId`s
and a partial state model (`queued` plus post-resolution `awaiting-truth`).
Authority-side idempotency uses `applied_mutations`, pruned by
`APPLIED_MUTATIONS_MAX_AGE_MS` in `apps/server/src/modules/sessions/service.ts`
(currently `30 * 24 * 60 * 60 * 1000` — **feed-side number owned by ADR 2**, not
restated as a free constant here).

That substrate is incomplete relative to the 2026-07-13 adversarial review
(POD-279 disposition **findings 7 and 8**):

| Gap | Today | Risk |
|---|---|---|
| Transport exposure | Registration implies exposure on every derived surface | Sensitive or unfinished commands leak onto CLI/MCP/relay by default |
| Offline class | Implicit (some store methods outboxed; command-plane WS frames classified separately in `message-class.ts`) | Spawn/kill-class ops can be mis-queued; secret-bearing settings can be persisted client-side (POD-352) |
| Principal | `Capability` is threaded correctly on relay/tRPC *in the issues path*, but `MutationEnvelope.origin.actor` exists as a free string | Payload-forged principals become possible if handlers trust the envelope |
| Apply-time re-auth | Authz runs at first accept; offline replay reuses the same path without a stated re-check contract | Rights revoked while offline still apply on reconnect |
| Outbox lifecycle | Poison = silent drop + toast; no dead-letter recovery | User-authored work vanishes (finding 8: worst gap) |
| Ordering | Global FIFO (client) / per-session FIFO (queued_messages) | Head-of-line blocking across unrelated aggregates |
| Dedupe vs retention | 30-day receipt prune; client may be offline longer | Replay after prune can double-apply; or long-offline work is lost without a user path |

This ADR is the binding decision for command **contracts**, **security**, and
**outbox lifecycle**. Phase 3 implements the framework; Phase 2 implements the
kernel Outbox states; POD-351 ships the first real contract + optimistic
reducer port (`session.rename`) against these shapes.

---

## Decision

**Every write (and every derived read that shares the registry) is a versioned
command contract. Security is declared on the contract; identity comes only
from the authenticated transport; offline delivery has a full lifecycle that
never silently discards user-authored work.**

### Ownership cut with ADR 2 (one number, one owner)

Cross-ADR settlement with POD-748 (ADR 2), so neither ADR re-litigates values:

| Concern | Owner | Where |
|---|---|---|
| Outbox states, max entry age, skew margin, inequality **lint** | **ADR 3** | D9–D11 |
| Change retention (feed) | **ADR 2** | ADR 2 D5 — currently 20k rows / 3 days, whichever deletes more |
| Receipt retention (`applied_mutations`) | **ADR 2** | ADR 2 D11 — currently `APPLIED_MUTATIONS_MAX_AGE_MS` |
| **Why** outbox age must stay under receipt retention | **ADR 2** | ADR 2 D11 — past the horizon a replay is a **fresh** command (e.g. double-type into a live PTY on `sessions.sendText`); the shipped "idempotent-ish" shrug in `docs/spec/outbox-write-path.md` is not a property |
| Heal / re-bootstrap keeps the outbox | **ADR 2** D7, upholding **ADR 3** D9 | discard cache, re-bootstrap, **keep outbox** |
| `expectedRevision` **token** (what a revision is, who assigns it) | **ADR 2** D3 | authority-assigned per-entity monotonic integer |
| `expectedRevision` on the **command contract / envelope** | **ADR 3** | D1 / D13 — field name accepted as ADR 2 named it |

Neither ADR restates the other's numbers; both **reference**. Lint that enforces
the age inequality **imports** the receipt constant (D11) — it does not hard-code
`30d`.

### D1 — Contract fields (L1 only)

A command contract is pure data + pure functions. **Handlers do not live at L1**
(finding 1): they register in L3 feature modules and join at the composition
root (POD-311). The stranded `CommandDef` + `MutationEnvelope` /
`MutationResult` types fold into one contract framework (home package decided
by ADR 8; working name `packages/commands`).

Every contract **must** declare:

| Field | Meaning |
|---|---|
| `name` | Stable dotted wire name (`issues.close`, `sessions.rename`). |
| `version` | Positive integer; starts at `1`. Bumped when input or output schema breaks compatibility for that command. Independent of wire/replica protocol version (ADR 2) and of the server drizzle journal ([spec:SP-4428]). |
| `input` / `output` | Versioned schemas (zod or successor). Single validation source for every transport that exposes the command. |
| `policy` | Resource/action policy (D2). |
| `exposure` | Explicit opt-in set of transports (D3). **Default = empty = served nowhere.** |
| `delivery` | Offline / delivery class (D4). |
| `redaction` | Sensitive-field metadata for logs, errors, receipts, and UI dumps (D5). |
| `optimisticReducer?` | Optional pure reducer for replica overlay (D6). |

**Envelope precondition (ADR 1 / ADR 2 delegation):** mutating commands that
use expected-revision concurrency (which entities: ADR 1) carry
**`expectedRevision: integer`** on the submit envelope — the name and token
semantics are ADR 2 D3; this ADR places the field on the command/outbox
envelope and treats a stale value as an authority **`rejected`** outcome
surfaced through D9 (never a replica-side drop). See D13.

Optional presentation hints (`cli` positional/summary, docs strings) remain
non-security fields.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Co-locate handlers with contracts at L1 | Violates downward dependency; handlers need L3 services (finding 1). |
| Infer exposure from "has handler" | Blanket derivation is unsafe (finding 7). |
| Keep `CommandDef` in protocol forever as the full security surface | Protocol stays frames + ids; security metadata belongs with the contract framework (ADR 8). |

### D2 — Resource / action policy

Policy answers *what the caller may do*, given a transport-derived principal
(D7).

**Action vocabulary** (extends today's `IssueAction` / `CommandAction`):

- `read` — no durable mutation
- `write` — ordinary mutation
- `manage` — destructive / administrative (operator-grade or explicit grant)

**Resource scope kinds** (extends today's `CommandScope` `issue | repo | global`):

| Kind | Gates |
|---|---|
| `issue` | Existing issue; subtree capability (today's `authorize` + `target` extractor) |
| `repo` | Repo/worktree path capability |
| `session` | Bound session identity (agent self-ops; rename/title doctrine [spec:SP-eb60]) |
| `machine` | Paired machine / host control surface |
| `settings-domain` | Preference domain (client-safe; offline-eligible when delivery allows) |
| `secret` | Server-owned secret material (POD-352) — forces online-only (D4) |
| `global` | Role gate only (no per-target scope) |
| *(omit)* | Additive / self-addressed create-style ops — role-gated only |

**Confirmation:** destructive or out-of-scope writes declare a confirmation
rule (`none` | `confirm` | `broker` per [spec:SP-edbb] approval broker). The
existing `--outside-scope` / `overrideScope` escape remains: scope miss without
override → `confirm-required` (or hard deny for `manage` where override is
disallowed). Brokered management ops are still commands; the broker is the
confirmation executor, not a second registry.

**Instance isolation** ([spec:SP-15aa]): a principal authenticated to instance
A cannot authorize commands that mutate instance B's stores, processes, or
routing unless sharing is **explicitly** configured. Instance boundary is an
authz hard wall, not a payload field.

### D3 — Transport exposure (default-closed, opt-in)

A command is served only on transports listed in `exposure`. Recognized
transport tags:

| Tag | Surface |
|---|---|
| `trpc` | Cookie-authenticated HTTP tRPC (operator / future user principal) |
| `cli` | `podium` CLI (via relay or local in-process) |
| `mcp` | In-process MCP tools |
| `relay` | Daemon agent relay command channel ([spec:SP-b85a]) |
| `outbox` | Client Outbox may enqueue this command (requires offline-eligible delivery) |
| `peer` | Peer-framed control (daemon↔server role modules per ADR 5) when a command is intentionally peer-callable |

**Rules:**

1. Empty / missing `exposure` ⇒ **no transport** serves the command (compile-
   and test-enforced totality on the registry).
2. `outbox` without an offline-eligible `delivery` class is a contract lint
   error.
3. Host↔server traffic that is **not** the agent command channel stays off
   `relay` (principle restated by [spec:SP-b85a], [spec:SP-fccf],
   [spec:SP-a43e] — ADR 7 classifies the frames; this ADR forbids smuggling
   them through agent command exposure).
4. Deriving tRPC/CLI/MCP/relay routers walks contracts filtered by exposure —
   no hand-written mutation procedures outside the registry (Phase 3 audit).

**Rejected:** "register once, expose everywhere" (today's effective posture).

### D4 — Delivery / offline class

Orthogonal to ADR 7's **message** sync class
(`durable | live | command | bulk` in
`packages/protocol/src/messages/message-class.ts`). Message class answers how
a **frame** fans out or recovers; delivery class answers whether a **command
envelope** may enter the Outbox.

| Class | Enqueue offline? | Apply-time re-auth (D8)? | Examples |
|---|---|---|---|
| `offline-eligible` | Yes (if `outbox` exposed) | Always | Entity edits, session rename, preference writes, snooze |
| `online-only` | Never; UI disables offline | N/A (live path only) | Spawn/kill/attach, resize, harness exec, file ops needing a live daemon |
| `online-sensitive` | Never; requires fresh authenticated online path | N/A (+ step-up auth when product requires) | Secret writes (POD-352), credential rotation |

**Rules:**

1. `secret` resource policy ⇒ `online-sensitive` (hard).
2. Secrets **never** appear in replica rows, outbox payloads, or optimistic
   overlays (POD-352 scrub migration).
3. `online-only` / `online-sensitive` must not list `outbox` in exposure.
4. Server-held queues for unreachable **agents** (`queued_messages` /
   `queueText`) are a **delivery mechanism for already-authorized online
   commands**, not a client Outbox offline class. They keep their own FIFO and
   do not bypass D7/D8.

**Rejected:** single global "everything offline" queue; inferring offline
eligibility from message-class `command` alone (too coarse — preference edits
are not command-plane WS frames).

### D5 — Redaction

Contracts declare which input/output paths are sensitive:

- **Never** written to: client replica, outbox durable storage, optimistic
  overlay, audit/event logs, error messages returned to other principals,
  telemetry.
- **Receipts** (`applied_mutations.result`): store a redacted projection or a
  non-sensitive success token when the full result would embed secrets;
  unredacted results are allowed only for non-sensitive commands.
- Error paths: structured codes + safe messages; no echo of secret fields.

Redaction is metadata on the contract, enforced by shared logging/receipt
helpers — not ad-hoc `delete obj.token` at call sites.

### D6 — Optional optimistic reducer

```
type OptimisticReducer = (args: {
  input: Input
  local: Aggregate | undefined  // current replica materialization
  now: string                   // authority clock is NOT used; informational only
}) => OverlayPatch | null
```

- Pure; no I/O; no principal checks (authz already decided enqueue-side and
  will re-run at apply — D8).
- **Absence is valid:** reducer-less commands show pending/outbox state without
  guessing field effects (POD-372).
- Overlay is **not** a representation role (ADR 4): it is `f(replica, pending
  commands)` over contract reducers.
- Authority remains the only arbitrator (ADR 1); optimistic state is always
  subordinate and discarded on definitive rejection.
- Walking skeleton POD-351 establishes the reducer **port**; POD-372 consumes
  it; POD-311 populates reducers broadly. `session.rename` must model
  accept vs reject-with-reason (human-vs-agent name doctrine [spec:SP-eb60]).

**Rejected:** generic field-LWW optimistic merge; deriving optimistic effects
from ownership-matrix annotations alone.

### D7 — Principal from authenticated transport only

The handler context exposes a **transport-derived principal** only:

| Transport | Principal source |
|---|---|
| `trpc` | Cookie / client session (`auth-route` / `auth-store`) → operator capability today (`OPERATOR` in `packages/domain/src/issue-authz.ts`) |
| `relay` | Daemon-authenticated agent session id baked into the relay path + capability minted server-side (`actorSessionId`, role, scope) |
| `mcp` | In-process MCP binding capability (never client-supplied) |
| `cli` | Same as the channel it rides (relay agent vs local operator) |
| `peer` | Peer auth strategy module (ADR 5) — machine token / pairing, not payload |

**Hard rules:**

1. `MutationEnvelope.origin.actor` (and any future payload identity fields) are
   **informational / audit only**. Forged values are inert: tests must prove a
   mismatched `origin.actor` cannot escalate or rebind `Capability`
   (POD-315 AC).
2. Handlers receive `Principal` / `Capability` from context construction — not
   from parsing `input`.
3. Attribution fields written into aggregates (e.g. `humanQuestionAskedBy`,
   close/unblock actor session) are **stamped from the transport principal**,
   matching today's relay comment: *stamped server-side via the capability
   (`actorSessionId`), never from input* (`apps/server/src/relay.ts`).

### D8 — Apply-time re-authorization

When the Authority applies a command — including every Outbox drain replay:

1. Resolve the **current** principal for the submitting connection / stored
   capability binding (not the principal snapshot from enqueue time alone when
   a live session can re-bind; offline-stored entries carry the **capability
   fingerprint + subject ids needed to re-evaluate**, never a precomputed
   "allow" bit).
2. Run the contract `policy` against current rights and current resource graph
   (issue may have moved, agent may have been unbound, operator password may
   have rotated).
3. Outcomes:
   - **allow** → run handler inside the authority transaction (ADR 2:
     entity + change log + receipt).
   - **forbidden** / rights revoked → `rejected` (definitive); Outbox moves to
     dead-letter recovery (D9); optimistic overlay discarded.
   - **confirm-required** without a durable user confirmation on the envelope
     → `rejected` with reason `confirmation-required` (do not silently apply
     out-of-scope offline writes).

**Rejected:** authorize only at enqueue; trust outbox contents as pre-authorized
through arbitrary offline duration (finding 7).

### D9 — Outbox states

Normative lifecycle for client (and kernel) Outbox entries. Terminal states are
bold.

| State | Meaning |
|---|---|
| `queued` | Durably enqueued locally; not yet in flight |
| `sending` | Drain attempt in flight to Authority |
| `accepted` | Authority accepted the envelope for processing (optional hop when accept ≠ apply; may collapse into `applied` if the hop is atomic) |
| `applied` | Authority applied; receipt recorded; overlay may linger until covering truth (today's `awaiting-truth` is a sub-stage of `applied`, not a separate security state) |
| **`rejected`** | Definitive authority refusal (validation, policy, conflict). Not retried as-is |
| **`expired`** | Exceeded age limit (D10) before successful apply |
| **`dead-letter`** | Parked for user recovery after rejection, expiry, or non-retryable failure |
| **`cancelled`** | User discarded the entry |

**Invariants:**

1. No transition to "gone" without user action or successful `applied` retirement
   after covering truth. **Silent poison-drop is forbidden** (finding 8).
2. `rejected` / `expired` always enter `dead-letter` (or an equivalent recovery
   surface) with reason codes the UI can render.
3. Recovery actions: **retry** (only after user edit or rights fix — new
   attempt may keep or mint mutationId per D11), **edit** (revise input → new
   attempt), **discard** → `cancelled`.
4. Network / unreachable-authority failures stay in `queued` (or return to
   `queued` from `sending`); they are not `rejected`.
5. **Replica heal / re-bootstrap never drops the outbox** (ADR 2 D7): discard
   the cache, re-bootstrap, **keep the outbox**. An epoch/feed bump does not
   invalidate queued commands (a command targets an entity, not a feed
   position). A stale `expectedRevision` is an authority rejection **surfaced**
   through this state machine, never a replica-side drop. The sole case where
   user work is lost is a **genuinely unreadable** outbox store — and that loss
   must be loud. (Invisible if either ADR is read alone: ADR 6 co-locates
   entities+cursor+overlay+outbox in one transactional store, so "clear the
   store" would otherwise eat unsent writes.)

Maps onto today's `MutationResult` kinds: `applied` / `rejected` / `queued`
(transport). Expand storage to carry the full state enum; `awaiting-truth`
remains an overlay retention flag under `applied`.

### D10 — Retry and age limits (ADR 3 owns these numbers)

| Knob | Decision |
|---|---|
| Transient (network) retry | Unlimited attempts until age limit; exponential backoff with cap (implementation default: start 1s, factor 2, cap 60s). No global attempt ceiling that converts user work into silent failure. |
| Definitive rejection | Zero automatic retries; dead-letter immediately. |
| Validation poison | Dead-letter (same as rejection); never wedge the partition. |
| **Default max entry age** | **14 days** from `queuedAt` (`OUTBOX_MAX_AGE_MS`). **Sole owner: this ADR** (ADR 2 defers; do not restate 7d or any other value there). |
| **Skew margin** | `SKEW_MARGIN_MS ≥ 2 days` — clock skew + drain delay buffer in the inequality (D11). |
| Per-command override | May **shorten** age (e.g. lock acquire). May **lengthen** only in the same change that raises **receipt** retention (ADR 2's number) so the inequality still holds. |
| Age exceeded | `queued`/`sending` → `expired` → `dead-letter` with reason `max-age`. |

### D11 — Dedupe horizon vs receipt retention (constraint + outbox side)

Authority receipts live in `applied_mutations` (and successors). **Receipt
retention is owned by ADR 2** — currently the live constant:

```text
// apps/server/src/modules/sessions/service.ts
const APPLIED_MUTATIONS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
```

This ADR does **not** restate "30 days" as an independent decision. It
**consumes** that constant.

**Decisions (outbox side + lint shape):**

1. **Client outbox max age is 14 days** (D10), with `SKEW_MARGIN_MS ≥ 2d`.
2. **Inequality (correctness rule — reason owned by ADR 2 D11):**
   ```text
   OUTBOX_MAX_AGE_MS + SKEW_MARGIN_MS < RECEIPT_RETENTION_MS
   ```
   An entry that outlives its receipt replays as a **fresh** command past the
   dedupe horizon (not "idempotent-ish": `sessions.sendText` double-types into
   a live PTY). Expiry at the replica is how we refuse that send.
3. **Lint / unit invariant must import the receipt constant**, not hard-code
   `30d`:
   - Prefer exporting `APPLIED_MUTATIONS_MAX_AGE_MS` (or a renamed
     `RECEIPT_RETENTION_MS`) from the module that owns the prune, and
   - `import { APPLIED_MUTATIONS_MAX_AGE_MS as RECEIPT_RETENTION_MS } from '…'`
     in the outbox package's invariant test.
   - Hard-coding `30 * 24 * …` in the lint is a **comment that fails open** the
     day someone tunes the service constant (lesson from POD-770: change-
     retention **spec** promised 14d while **code** ships 3d). Deriving is a
     guard; copying is drift.
4. **Never re-mint `mutationId` while a receipt might still exist.** After
   `expired` / `cancelled`, a user re-issue **must** mint a new id.
5. **Long-offline clients** offline longer than outbox max age: entries expire
   into dead-letter recovery; the user re-authors. We do **not** keep client
   queues alive past the receipt horizon to "be nice."
6. If product later needs multi-month offline queues, **raise receipt retention
   first** (ADR 2 amendment) **then** outbox age (this ADR) in one coordinated
   change — never invert the inequality by touching only the outbox knob.
7. Replay of an id **inside** the receipt window returns the stored result
   without re-running (today's `withMutation` / `getAppliedMutation` semantics).
8. Replay of an id **after** prune is treated as a **new** apply if it ever
   reaches the Authority — therefore clients must not send aged ids (enforced
   by expiry). Domain-level "idempotent-ish" is not a security property.

**Rejected:**

| Alternative | Why |
|---|---|
| Unlimited offline outbox under fixed receipts | Double-apply after prune (ADR 2 D11 hazard) |
| ADR 2 also naming outbox max age (e.g. 7d) | Two owners → drift; settled: ADR 3 sole owner |
| Lint hard-codes `30d` beside a separate service constant | Silent failure when the constant moves (POD-770 class) |
| Re-mint id automatically on reconnect after long offline | Loses dedupe if the original applied and receipt still exists |

### D12 — Ordering partitions

Outbox drain is **FIFO within an ordering partition**, concurrent **across**
partitions.

- **Default partition key:** `(resourceKind, resourceId)` extracted by the
  contract's target extractor (same function policy uses). Examples:
  `issue:<id>`, `session:<id>`, `machine:<id>`, `settings:<domain>`.
- **Create / additive commands** without an existing id: partition by
  client-generated provisional id or a dedicated `create:<mutationId>`
  partition so creates never block unrelated aggregates.
- **Global head-of-line blocking is forbidden** as the steady-state design
  (today's single FIFO is the interim).
- Server `queued_messages` remains **per-session** FIFO (delivery to one agent
  PTY); that is a different queue with the same partition idea.

A blocked / dead-lettered entry blocks **only its partition** until recovery
or cancel.

### D13 — `expectedRevision` on the command envelope

ADR 1 requires mutating commands to carry an expected-revision precondition;
it delegated the **wire field name** jointly to ADR 2 / ADR 3.

**Accept ADR 2 D3's name and token:** `expectedRevision` (integer), matching
the authority-assigned per-entity monotonic `revision`. Not `expectedUpdatedAt`
(clock), not content etag (hash cost, no order).

**This ADR's half:**

1. The field lives on the command submit envelope / outbox entry (alongside
   `mutationId`, `command`, `input`) for every contract whose ownership-matrix
   row (ADR 1) uses expected-revision concurrency.
2. Contracts that use a command-specific rejection/rebase rule instead (ADR 1)
   omit or ignore it — declared per contract, not guessed.
3. Stale `expectedRevision` ⇒ Authority returns **`rejected`** (conflict /
   precondition failed) ⇒ D9 dead-letter recovery with a reason the UI can
   render. The replica **must not** drop the entry because the feed healed or
   the epoch bumped (ADR 2 D7 corollary).

### D14 — Host-local agent scope is accident prevention, not adversarial security (POD-1402)

**Decision: ACCEPT.** On a single-operator host, agent/operator scoping is an
ergonomic and accident-prevention boundary. It is **not** a security boundary
against a process that already runs as the operator's OS user with read/write
access to the instance state dir.

**What was observed (POD-1402).** A constrained agent session — refused
operator-only commands over the agent relay — can still:

```text
podium auth mint-session --ttl 2m --print-only
PODIUM_SESSION_TOKEN=$TOKEN env -u PODIUM_AGENT_RELAY podium issue promote …
```

and arrive at the Authority as the operator. The scope gate in issue authz is
bypassed, not defeated: the caller simply presents a different principal.

**Why this is not a new hole.** `podium auth mint-session` (POD-1376) mints a
`client_sessions` row from **write access to `$PODIUM_STATE_DIR/podium.db`**.
That access already lets a process forge the same row by hand (the pre-POD-1376
break-glass documented in `docs/agents/driving-podium.md`), read transcripts,
and touch every stored secret in the database. Minting lowers effort and
discoverability (one documented verb in `podium help`); it does not enlarge the
set of processes that could already act as the operator.

**What the agent/operator split *is* for:**

| Purpose | Holds? |
|---|---|
| Default-path accident prevention (delegate does not promote / reparent by typing the usual command) | Yes — relay-scoped CLI refuses operator-only ops |
| Honest product ergonomics (shell = operator, harness = constrained; POD-1375) | Yes — identity comes from how the session is wired, not from "being careful" |
| Containing an *adversarial* agent that shares the operator's OS user and state dir | **No** — and must not be sold as such |

**Rejected alternative: ENFORCE on mint-session.** Options considered and
rejected for single-operator Podium:

| Option | Why rejected |
|---|---|
| Refuse when `PODIUM_AGENT_RELAY` / `PODIUM_SESSION_RELAY` is set | Cheap for the accidental case; useless against intent — the agent can `env -u` the variable (exactly the POD-1402 repro). Also contradicts POD-1375's premise that an env var must not be what decides who you are: the same variable is equally non-load-bearing as a *denial* of mint. |
| Require the instance password | Real against a process that only has the scrypt hash in `auth.json`, but the same process can still INSERT a `client_sessions` row if it can write the DB — which is the mint's actual trust root. Raises effort again without a new boundary. Breaks the documented agent browser-driving path. |
| Interactive TTY confirm | Same class as env refuse: blocks casual misuse, not a capable agent; breaks non-interactive operator scripts. |

**Normative consequences:**

1. **Document the trust root where mint is described** — CLI help, runtime
   mint module, and agent-driving docs must state that local state-dir write
   access ≡ operator ownership today, and that agent scope does not survive a
   deliberate mint + direct `/trpc` call.
2. **Do not design features that assume an adversarial co-resident agent is
   contained** by relay scope, `issue-authz` subtree gates, or "agents cannot
   mint." Those gates are for the default path and for honest mistakes.
3. **Multi-user / multi-tenant (POD-1067 and successors) must reopen this.**
   When "can write the state dir" stops meaning "is the sole owner," mint must
   bind to an identity stronger than file mode (password step-up, OS keyring,
   per-user DB, process isolation, etc.). That redesign is **out of scope**
   for single-operator Podium and is a hard prerequisite of multi-user, not an
   optional hardening of mint-session.
4. **D7 still holds on the wire.** Once a call reaches a transport, principal
   comes only from that transport's credential. The host-local mint is how a
   co-resident process *obtains* an operator cookie; it does not let a remote
   peer forge one without the cookie or state-dir access.

**Binding code / docs (characterization at decision time):**

- Trust argument + **instrument** `HOST_LOCAL_MINT_TRUST`:
  `packages/runtime/src/session-mint.ts` (multi-user must flip
  `assumesSingleOperator` / `mintBoundToIdentity` together)
- Tripwire tests: `packages/runtime/src/session-mint.test.ts` (coherence +
  `client_sessions` column pin reading `apps/server` schema)
- Verb: `apps/cli/src/auth-cli.ts` (`podium auth mint-session`)
- Agent use of the same path: `docs/agents/driving-podium.md` (auth section)
- Decision record: `docs/decisions/1402-host-local-mint-trust.md`

---

## Security properties (normative checklist)

1. **Default-closed exposure** — unlisted transport ⇒ unreachable.
2. **Transport principal only** — payload identity fields cannot authorize.
3. **Apply-time re-auth** — offline time does not freeze rights.
4. **Secrets never queued or replicated** — `online-sensitive` + redaction +
   POD-352 model split.
5. **No silent discard** of user-authored outbox work.
6. **Receipt horizon dominates** client offline horizon.
7. **Instance isolation** — cross-instance command routing denied by default
   ([spec:SP-15aa]).
8. **Agent channel ≠ host control channel** — relay exposure is not a back door
   for host frames (ADR 7).
9. **Host-local agent scope is not adversarial containment** — co-resident
   processes that can write the instance state dir can mint operator credentials
   (D14 / POD-1402); do not build on a stronger model until multi-user isolation
   lands.

---

## Mapping to current code (characterization, not freezes)

| Concept | Today | Target under this ADR |
|---|---|---|
| Contract type | `CommandDef` (`input`, `action`, `scope?`, `cli?`) | Full field set D1 |
| Issue registry | 64 names in `ISSUE_COMMAND_NAMES`; handlers co-located | Contracts L1 / handlers L3 join |
| Lock registry | 6 names in `LOCK_COMMAND_NAMES` | Same framework |
| Envelope | `MutationEnvelope` + `MutationResult` (unused on wire) | Outbox + authority submit path |
| Authz | `authorize` + `Capability` + `IssueCaller` | Policy D2 + principal D7 + re-auth D8 |
| Client outbox | `queued` + `awaiting-truth`; poison drop | Full D9 state machine + dead-letter UX (POD-316) |
| Receipts | `APPLIED_MUTATIONS_MAX_AGE_MS` prune (30d today) | ADR 2 owns value; ADR 3 imports it into D11 lint; outbox max age 14d + ≥2d skew |
| Concurrency token | *(none on envelope today)* | `expectedRevision` integer (ADR 2 token; D13 on contract) |
| Message class | `durable/live/command/bulk` | Migrates to ADR 7 plane-class vocabulary (control/stream/bulk + command message-class); delivery class stays separate (D4) |

---

## Drift refresh clauses (POD-359 comments)

POD-359 agent comments (2026-07-16) bind the ADR pack. Explicit handling for
**this** ADR:

| Drift item | ADR 3 impact |
|---|---|
| (1) drizzle-kit decided ([spec:SP-4428]) | **None on semantics.** Command `version` ≠ drizzle journal ≠ wire protocol version (stated in D1). Receipts/outbox tables remain feature/sync persistence; migration tool is ADR 2 / ADR 6. |
| (2) Instance identity ([spec:SP-15aa]) | **Absorbed in D2 / property 7:** instance is an authz boundary for command application and routing. Brand vs runtime placement is ADR 1 / ADR 8; security rule does not wait on that packaging choice. |
| (3) Plane inventory growth (handoff, messaging, workflows, browser-open, `sessionResumeRefAck`) | **Orthogonal classification** lives in ADR 7. This ADR requires: (a) any new control-plane **command-class** RPC that mutates durable state eventually gains a contract if it is a product write; (b) host↔server families stay off `relay` exposure (D3.3). Messaging remains bus/webhook (no tRPC mutations) — no forced outbox class. |
| Build orchestration / tsgo / turbo / `@podium/source` | **None.** Package placement of contracts is ADR 8. |
| Turbo worktree symlink hazard | **None.** |

No POD-359 drift item overturns findings 7–8; they remain the core of this ADR.

---

## Implementation binding (who does what)

| Work | Issue | Obligation to this ADR |
|---|---|---|
| Port shapes for contract + reducer | POD-351 | First real `sessions.rename` contract; reducer port includes reject path |
| Kernel Outbox states + partitions + conformance | POD-306 family | D9–D12; long-offline test |
| Overlay from reducers | POD-372 | D6; no Phase-3 wait |
| L1 framework + fold protocol contracts | POD-311 | D1–D6 fields; default-closed tested |
| Principal / re-auth / scopes / matrix suite | POD-315 | D2, D7, D8; four-transport matrix |
| Offline classes + dead-letter UX | POD-316 | D4, D9 recovery runtime-verified |
| Secrets / preferences split | POD-352 | D4 `online-sensitive`, D5, never-queue |
| Receipt/outbox constants invariant | POD-306 / POD-315 | D10–D11 lint **imports** `APPLIED_MUTATIONS_MAX_AGE_MS` |
| `expectedRevision` on envelope | POD-311 / POD-305 | D13 + ADR 2 D3 |

---

## Consequences

**Positive**

- One security story for tRPC, CLI, MCP, relay, and offline apply.
- Offline authoring no longer implies frozen privilege or silent data loss.
- Outbox max age + imported receipt constant prevent replay past the dedupe
  horizon (double-apply / double-type).
- Phase 3 can audit "no hand-written mutations" and "every contract has
  policy + exposure + delivery + redaction".
- Host-local trust is stated (D14): agent scope is accident prevention; builders
  are not invited to treat co-resident agents as adversarially contained.

**Negative / cost**

- Every command needs explicit exposure and delivery classification (more
  registry boilerplate; mitigated by helpers and lint).
- Dead-letter UX is mandatory product surface (POD-316), not an optional
  toast.
- 14-day offline ceiling is stricter than "queue forever"; users offline
  longer must re-author (acceptable for local-topology product; amend D10–D11
  if multi-month offline becomes a goal).
- D14 means product and multi-user work must not rely on relay scope alone for
  isolation; real containment waits on process/identity boundaries (POD-1067+).

**Neutral couplings**

- Conflict/revision rules stay ADR 1; this ADR only supplies policy + lifecycle.
- Feed/cursor/bootstrap stay ADR 2; mutation identity fields align but are not
  redefined here.
- Plane taxonomy stays ADR 7.

---

## Acceptance (for human sign-off of this ADR)

Human gate remains on POD-359. This document is accepted when reviewers agree:

1. Contract field set (D1) is complete for Phase 3 scaffolding.
2. Default-closed exposure + transport principal + apply-time re-auth are
   non-negotiable.
3. Outbox state machine (D9) and **14d outbox max age + ≥2d skew** (D10) are the
   outbox numbers implementers will code; receipt retention stays ADR 2's, with
   the inequality lint **importing** the live constant (D11).
4. `expectedRevision` is the accepted envelope field name (D13).
5. Drift clauses above match the intended absorption (no silent skips).
6. Ownership cut with ADR 2 is recorded and not re-opened without both leaves.

Phase issues (POD-311/315/316/306/351/352) must reference **ADR 3** in their
descriptions when reconciled by POD-359.

---

## References

- POD-359 item 3; POD-749; POD-279 disposition findings 1, 7, 8
- POD-311, POD-315, POD-316, POD-306, POD-351, POD-352, POD-372
- POD-1375 (operator shell must not be agent-scoped); POD-1376 (host-local mint);
  POD-1402 (D14 — agent can mint; accept as accident prevention)
- `docs/rearchitecture-v3.md` §1 move 3 (command contracts)
- `docs/spec/outbox-write-path.md`
- `docs/agents/driving-podium.md` (agent mint path)
- `packages/protocol/src/commands.ts`, `messages/mutations.ts`, `messages/message-class.ts`
- `packages/domain/src/issue-authz.ts`
- `packages/runtime/src/session-mint.ts`, `apps/cli/src/auth-cli.ts`
- `packages/client-core/src/outbox.ts`
- `apps/server/src/modules/sessions/service.ts` (`APPLIED_MUTATIONS_MAX_AGE_MS`)
- Specs: [spec:SP-3fe2], [spec:SP-b85a], [spec:SP-edbb], [spec:SP-15aa],
  [spec:SP-eb60], [spec:SP-fccf], [spec:SP-a43e], [spec:SP-4428]
