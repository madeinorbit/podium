# ADR 1 — Amendment 1: ownership, visibility and the per-user state family

- **Status:** Proposed (human gate: POD-359)
- **Date:** 2026-07-29
- **Deciders:** architecture rewrite ADR pack (POD-359); human decisions of 2026-07-28/29
  recorded in `docs/multi-user-readiness.md`; human sign-off before Phase 1
- **Issue:** POD-1071 (leaf of POD-359; owns this file and the "Amended by" line in ADR 1)
- **Consumers:** POD-304 (matrix annotations + totality test), POD-305 (Authority write
  funnel), POD-306 (Replica / Outbox), POD-301 (branded ids — `UserId`), POD-316
  (reject/rebase UX), POD-288 (Phase 1), POD-289 (Phase 2 kernel), POD-290 (Phase 3
  policy), POD-323 (SessionBinding / delegation lifecycle), POD-645 (instance vs machine
  identity), POD-352 / POD-418–420 (secrets vs preferences)
- **Related ADRs:** ADR 2 (feed identity, revision, scoping, tombstone retention), ADR 3
  (principal from transport, apply-time re-authorization, resource/action policy,
  `expectedRevision`), ADR 4 + its Amendment 1 (representation shapes for owner /
  attribution / per-user state), ADR 7 (planes; presence), ADR 9 (identity, ownership and
  sharing — owns the taxonomy this amendment consumes)
- **Specs:** [spec:SP-15aa] multi-instance isolation; [spec:SP-0371] hub/node federation
  deferred; [spec:SP-eb60] curated name vs live title; [spec:SP-85d1] advisory locks
- **Base tip verified:** `2ddfec21` (issue/279-integration), 2026-07-29
- **File discipline:** this amendment owns **only** this file plus a single "Amended by"
  line in `docs/adr/0001-authority-ownership.md`. No index edits, no ledger edits, no
  edits to ADR 2 / 3 / 7 / 9.

---

## 1. Context

`docs/multi-user-readiness.md` records the human decision of 2026-07-29: **build the
visibility machinery in Phase 2 and default to private** (header block and §3.1 — "C's
mechanism, B's default"), with per-feature sharing behaviour decided class by class. It
also records four subsequent human directions that reach ADR 1 directly: agents are
delegated principals (§3.1.3), machines are owned compute with three verbs (§3.1.4), the
superagent is per-user while system automations are not delegated at all (§3.1.6), and the
collaborative-text carve-out (§4).

**Multi-user is not multi-tenancy.** Multi-user in one tenant lives **inside** one
Authority. **ADR 1 D5 is unaffected** — see D14 below. Nothing in this amendment
authorises an `instance_id` column on any table, wire projection, or per-user state row.
An implementer who reads "multi-user" and reaches for tenant columns has misread this
document.

### 1.1 What is true today (verified on tip `2ddfec21`)

- **There is no person in the model.** `packages/protocol/src/ids.ts` declares
  `MachineId`, `SessionId`, `IssueId`, `RepoId`, `ConversationId`, `MutationId`,
  `ThreadId` — and **no `UserId`**. `packages/runtime/src/auth-store.ts` holds one
  password per instance (`setPassword` / `verifyPassword`, no accounts).
  `apps/server/src/migrations/schema.ts` `client_sessions` is
  `(token_hash, created_at, expires_at)` — **no user column**; a client session is a
  device, not a person. `packages/domain/src/issue-authz.ts` declares
  `OPERATOR: Capability = { role: 'admin', scope: { kind: 'all' } }` — "the human
  operator … unconstrained".
- **Therefore ADR 1's matrix has no owner.** Its "Permitted writers" column carries role
  *classes* (`operator`, `agent-session`, `daemon`, `system`) and nothing else. There is
  no owner column, no visibility column, and no grant concept anywhere in the pack.
- **Per-user state is modelled as instance-wide singletons.** `pins` is keyed
  `(kind, id)`; `tab_order` is keyed by `worktree`; `session_drafts` and `snoozes` are
  keyed by `session_id`; `read_at` is a plain column on `sessions` (line 45),
  `issue_messages` (line 332) and `issues` (line 389). Each is *one row for the whole
  instance* — today's shape asserts that exactly one person exists.
- **`workState` is not a viewer opinion.** `packages/protocol/src/messages/runtime-state.ts`
  line 64: `WorkState = z.enum(['planning','implementing','testing','done','icebox'])`.
  Those are statements about the work, not about who is looking at it. `sessions.archived`
  is an `integer` default `0` sitting alongside `deleted_at` / `deletion_source` on the
  same shared row.
- **Machines carry no owner and no grants.** `machines` is
  `(id, name, hostname, token_hash, created_at, last_seen_at, inventory_json)`. `repos` is
  keyed `(machine_id, path)` — a per-machine fact with no scoping of its own. The
  all-in-one case is real: `packages/runtime/src/local-machine.ts` line 13 declares
  `LOCAL_MACHINE_ID = 'local'`, so the machine hosting the server is a fleet member like
  any other, reachable by anyone who can authenticate.
- **Terminal control already exists, without identity.** `apps/server/src/modules/sessions/session.ts`
  line 344: the first attacher takes control (`if (this.controllerId === null) this.controllerId = client.id`),
  transferred by `requestControl(clientId)` (line 553) and broadcast as `controllerChanged`.
  `controllerId` is a **connection id**, not a person — which is exactly why D12's PTY note
  below is a Phase-5 identity job and not a merge problem.
- **Preferences are one instance-wide blob.** `packages/runtime/src/settings.ts`
  `PodiumSettings` (line 234) holds `notifications.telegramChatId: z.string().default('')`
  (line 274) next to instance-level settings and secrets, with no per-person dimension.

Each of these is a shape ADR 1 ratified as correct **for a single-operator product**, and
in at least one place ADR 1 says so in its own rationale (D2). The pack is unsigned; that
is what makes this amendment a doc change rather than a migration.

### 1.2 Scope

This amendment decides **who owns a row, who may see it, and what conflict rule applies
once more than one person can write.** It does **not** decide identity mechanics (ADR 9),
feed scoping or watermarks (ADR 2's amendment), principal derivation or policy vocabulary
(ADR 3), field/projection shapes (ADR 4 Amendment 1), or presence and rooms (ADR 7). It
consumes their vocabulary and never restates their values.

**Division of labour with ADR 9** (checked against `docs/adr/0009-identity-ownership-sharing.md`
as landed): ADR 9 D2 decides what `owner` / `visibility` / `grants` **mean** and the order in
which they are evaluated; ADR 9 D3 owns the five visibility classes; ADR 9 D4 owns the
default-closed rule; ADR 9 D5 owns delegation and the attribution pair; ADR 9 D6 owns the
machine verb set. ADR 9 D2 rule 1 and D4 enforcement point 1 both assign the **matrix column
set and the per-aggregate values** to this amendment. No ADR 9 content is restated here.

---

## 2. Decisions

Numbering continues ADR 1's sequence (D1–D7 are the base document's). Every amended base
decision keeps its original number and is named explicitly.

### Decision D8 — Owner, visibility class and grants are normative matrix columns (amends D4)

**Decision.** D4's column set grows from eight to eleven. Every replicated aggregate /
field group carries, in addition to D4's existing eight:

| New column | Meaning |
|---|---|
| **Owner** | The `UserId` that owns the row — or the **declared reason** the class has no owner (`substrate`, `secret`, `derived`, or `inherits <parent class>`). "Blank" is not a value; see D9. |
| **Visibility class** | Exactly one of `personal` / `per-user-state` / `owned-compute` / `deployment-substrate` / `secret`, per ADR 9 D3. |
| **Grants** | Whether the class participates in the grants edge table and with which verbs: personal classes take `read` / `write`; machines and per-machine facts take `see` / `use` / `manage` (ADR 9 D6); per-user state takes **none** (non-grantable by construction); substrate and secrets take none, and their `manage` is admin-grade (D15). |

Three consequential rules:

1. **These are columns, not annotations.** The complete filled-in column set for every
   existing matrix row is §3 of this amendment; it is normative and is read as part of
   ADR 1's matrix.
2. **"Permitted writers" keeps its role classes and gains three orthogonal annotations.**
   `operator` / `agent-session` / `daemon` / `system` still answer *what kind of writer*;
   **owner**, **actor** and **on-behalf-of** answer *which person is accountable*, and are
   recorded per ADR 9 D5 A3. Actor and on-behalf-of are two values, never collapsed into
   one (ADR 4 Amendment 1 D9.3 owns the field shape); both are stamped from the transport
   principal per ADR 3 D7, never from payload.
3. **Owner is durable entity truth, not envelope provenance.** It survives bootstrap,
   export and re-replication. The split is ADR 4's (Amendment 1 D9.4); ADR 1 only rules
   that the matrix column exists and is filled.

**Rationale.** Readiness §3.2 is explicit that this is "an ADR 1 amendment, not an
annotation": ADR 1's matrix is the single place the pack answers "who may change this?",
and under multi-user "who may *see* this?" is the same question asked of the same rows. A
class whose visibility lives anywhere else is a class whose visibility drifts — the exact
failure mode POD-304's totality test exists to prevent for conflict rules. Putting the
answers in different documents also breaks the property that makes the matrix usable: one
row, one complete answer.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Keep visibility entirely in ADR 9 and leave ADR 1's matrix unchanged | Splits one row's answer across two documents, so the totality test can only check half of it. A new entity class would pass ADR 1's review with no visibility class at all — which is the default-open failure readiness §3.1.1 rule 1 forbids. |
| One `visibility: boolean` (private/shared) instead of a five-value class | Collapses distinctions with different mechanisms behind them: per-user state is never shared *at all*, substrate is tenant-visible by design, secrets never replicate, and machines need three verbs (D13). A boolean would force `use` on a machine and `read` on an issue to be the same toggle — readiness §3.1.4 M2 is explicit that they must not look the same. |
| Owner as a free-text attribution string, like today's `deletion_source` | Unbranded person references are the drift this rewrite deletes (ADR 4 Amendment 1 D9.1). An authorization input typed as `string` is also un-auditable: nothing distinguishes a user id from a session id from a typo. |
| Annotate only the classes that are obviously personal, and revisit the rest later | "Later" is after the POD-308 wire cutover, and an unannotated class defaults to *whatever the implementer assumed*. D9 exists precisely because the safe default must be mechanical. |
| Fold owner into the existing "Home authority" column | Home is *which role commits truth* (server, daemon→server); owner is *which person the row belongs to*. Both are needed and neither implies the other — the server homes every personal row. |

### Decision D9 — The matrix is where default-closed is enforced, and the ratchet is one-way

**Decision.** The default-closed **rule** is ADR 9 D4's: an entity class with no declared
visibility class is `personal` and private to its owner, never tenant-visible, never
substrate; forgetting to classify must fail toward privacy (readiness §3.1.1 rule 1). ADR 1
decides where that rule is **enforced**, which ADR 9 D4 enforcement point 1 assigns here:

1. **The declaration is a column of this matrix**, not a per-feature convention — D8.
2. **The matrix carries the totality test**, of the same shape as POD-304's existing
   per-field annotation obligation (readiness §3.1.1 rule 2): a durable class that reaches
   the write funnel without a declared visibility class and either an owner or a declared
   no-owner reason is a **test failure**, not a warning. This is the enforcement seam ADR 1
   D4 already relies on; it gains three columns to check, not a second mechanism.
3. **The classification ratchet is one-way.** Per-feature policy (deliberately deferred —
   readiness §3.1.1) may move a class *toward* privacy without an amendment. Moving a
   class toward broader visibility — anything into `deployment-substrate`, or widening a
   grant verb set — requires an **ADR 1 amendment**, the same discipline D3 already
   applies to the field-LWW closed set. This is ADR 1's mechanism for ADR 9 D4's
   "widening is always explicit".

**Rationale.** ADR 9 D4 argues why the default must fail closed; ADR 1's question is
different — *where does the obligation live so that it is mechanically checkable?* The
answer has to be the matrix, because the matrix is already the thing a new durable class
cannot avoid (POD-304's per-field annotation obligation, enforced at POD-305's write
funnel). A visibility declaration that lives anywhere else is a declaration a class can be
merged without, at which point the semantic default is doing all the work — and a semantic
default is only a backstop.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Keep the rule in ADR 9 with no ADR 1 enforcement column | Leaves the default as a sentence in a document. ADR 9 D4 point 2 is explicit that the semantic default is a backstop for what slips past the test, not a substitute for it — so something has to run the test, and the matrix is the only totality mechanism the pack has. |
| Warn on unclassified classes instead of failing | A warning in a repo with dozens of durable server tables is a warning nobody reads. POD-304's obligation is a test for the same reason. |
| Require classification only for classes that are actually replicated | Replication status changes; a class that is local today and replicated next quarter would carry no classification into its first wire projection. The column is cheap; the retrofit is not. |
| Let per-feature policy widen visibility freely, since membership is deferred | Deferral was granted for *membership decisions made deliberately*, not for drift. The one-way ratchet keeps the deferral honest: privacy is free, exposure is reviewed. |
| Make the ratchet a review convention rather than an amendment requirement | D3's closed field-LWW set is the precedent and the reason: an un-amendable list is the only kind that does not grow. A widening that is worth doing is worth one paragraph. |

### Decision D10 — The per-user state family, and the shrinking of D3's field-LWW inventory (amends D3)

**Decision.** A new durable family: **per-user state**, keyed `(userId, entityId)`, one row
per person per entity, visibility class `per-user-state`, grants **none**, conflict rule
**`single-writer`** — because with the user in the key there is exactly one writer per row.
Per readiness §3.3. The *shape* of the family (an R1 aggregate composed from one shared key
fragment, never a field on the shared entity's wire projection) is ADR 4 Amendment 1 D10;
ADR 1 owns only ownership, visibility and conflict.

Two properties make the family safe and are normative here:

- Per-user rows are **never grantable**. There is no "share my read state" verb; sharing an
  entity shares the entity, never anybody's per-user rows.
- Per-user rows are **not the entity's** rows. Deleting or transferring a shared entity does
  not transfer per-user rows; they follow the *user*, and cascade on user deletion.

**The D3 closed field-LWW inventory is amended as follows.** D3's opt-in / defined-clock /
closed-set discipline is unchanged; the inventory shrinks because most of its members stop
being contended, not because the rule relaxed.

| ADR 1 inventory row | Amended disposition | Why |
|---|---|---|
| Session `readAt` | → **per-user state** (`single-writer`) | Read state is a fact about a reader. Verified today as a singleton column on `sessions`, `issues`, `issue_messages`. |
| Session `snoozedUntil` (`snoozes`) | → **per-user state** (`single-writer`) | "Stop bothering *me* until Tuesday" is not a property of the session. |
| Pins | → **per-user state** (`single-writer`) | Verified singleton PK `(kind, id)` today; the sidebar is "my tasks" (readiness header). |
| Tab order blob | → **per-user state** (`single-writer`) | Verified singleton PK `worktree` today; layout is per person by definition. |
| Preference keys — **personal** (roles/session defaults, sidebar, autoContinue, `telegramChatId`, ntfy topic, …) | → **per-user state** (`single-writer`) | Readiness §3.1.6 S4 moves `telegramChatId` to per-user explicitly; the rest follow the same reasoning. |
| Preference keys — **instance/deployment** (feature flags, instance-level settings) | **REMAINS `field-LWW`** — the only surviving member | Genuinely shared, genuinely independent per key, admin-written, low semantic risk: D3's four conditions still all hold. |
| Session `archived` | → **`exp-rev`** (shared session fact) — **removed from field-LWW** | See below. |
| Session `workState` | → **`exp-rev`** (shared session fact) — **removed from field-LWW** | See below. |
| Session composer draft body + `draftUpdatedAt` | → target class **`op-stream`** (D12), **reserved not built**; interim rule below | Readiness §3.3 and §4: this is the one row where the documented decision becomes a data-loss bug. |

**`archived` and `workState` are shared session facts, decided not implied.** `WorkState`'s
values are `planning | implementing | testing | done | icebox` (verified) — statements about
the work, identical for every viewer; a session that is `done` is not `done` only for me.
`archived` sits on the shared `sessions` row beside `deleted_at` / `deletion_source` and
means "this session is retired", a disposition of the work. Both therefore stay on the
shared entity and take the D2 default, `exp-rev`. If a per-viewer "hide this from **my**
sidebar" affordance is wanted for a session shared *with* someone, that is a new per-user
state row and needs no ADR change — but it is a distinct concept from `archived`, and this
amendment does not create it.

**The composer draft's interim rule, stated so nobody ships the bug.** Until `op-stream`
exists, the draft body keeps `field-LWW` — but it is now recorded as a **named interim
defect with an expiry condition**, not a justified carve-out: whole-body LWW between two
concurrent authors silently discards one author's text. Therefore **before session sharing
ships (Phase 3, POD-290), the draft must either move to `op-stream` or be gated to a single
writer** using the control model that already exists (`controllerId` / `requestControl`,
verified). Which of the two is the per-feature call that readiness leaves open for sessions;
shipping *neither* is out of compliance.

**Rationale.** This is the rare amendment that makes the pack smaller. Keying by user turns
a conflict-resolution problem into an absence-of-conflict problem: each person writes their
own row, `single-writer` applies, and the LWW carve-out — the thing D3's rejected
alternatives call "inevitably spreads; un-auditable" — shrinks to one admin-scoped member.
Readiness §3.3 is equally explicit about the deadline: this is a simplification *only if it
happens in Phase 1*; landing these as singletons costs a table migration plus a wire change
plus a replica migration each, five times over.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Keep everything in the field-LWW set and add a user dimension later | Five migrations after the POD-308 cutover instead of one schema definition before it, each touching storage, wire and replica. This is the specific failure POD-279 exists to end. |
| Move the composer draft to per-user state too (one draft per person per session) | Mechanically simplest and wrong: readiness §3.3 and §4 both classify the draft as *shared-surface* state — a co-authored message being composed for one session, not five private scratchpads. Making it per-user would quietly delete the collaboration feature rather than defer it. |
| Make `archived` / `workState` per-user view state | `WorkState`'s enum values are lifecycle claims about the work (verified), and `archived` lives next to the delete columns. Per-user lifecycle would mean a session that is `done` for its owner and `implementing` for a collaborator — two truths about one thing, which is exactly what D1 forbids. |
| Keep field-LWW for the draft indefinitely and accept the loss | Silent overwrite of a user's typing is not an acceptable steady state, and "documented" does not make it acceptable. The expiry condition converts a latent bug into a gate on the feature that would trigger it. |
| Drop `field-LWW` entirely now that only one member remains | The remaining member is real (independent instance preference keys, concurrent admins) and D3's conditions genuinely hold for it. Removing the class would push it to `exp-rev`, which surfaces conflicts on preference toggles — worse UX for no invariant gained. |

### Decision D11 — D2's rationale is void; the decision survives on invariant grounds (amends D2)

**Decision.** ADR 1 D2's **decision** — exactly one home authority, mutating commands carry
an expected revision, mismatch rejects or applies a documented command-specific rule, no
silent whole-aggregate LWW — is **unchanged and re-ratified**.

D2's **rationale** is amended. The clause *"Low multi-writer contention (single-operator
product)"* is **void** (readiness §3.3) and is replaced by:

> **Invariant-heavy graphs (issue deps, parent, stage machines) break under blind LWW, and
> break harder with more writers.** Expected-revision is the only default that surfaces a
> concurrent structured edit to the person who made it instead of resolving it silently.
> The rule was never load-bearing on contention being *rare*; contention being rare only
> made the cost of surfacing it cheap.

**Consequence to record explicitly: POD-316 changes priority, not design.** Reject-and-rebase
UX moves from a rare edge case to a **routine path** — with N writers on a shared issue,
"your edit was rejected, here is what changed" is normal product behaviour, not an error
screen. POD-316 must be sized and reviewed as a normal-path feature. Its design is
unaffected; `expectedRevision` on the command envelope stays exactly as ADR 3 D13 and ADR 2
D3 define it (their values, not restated here).

**Rationale.** The pack's rule is that a decision survives on stated grounds. A rationale
known to be false is how a correct decision gets overturned by the first reviewer who
notices — and a reviewer who notices *this* one would reasonably conclude that LWW should
become the default now that contention is high, which is the opposite of the right answer.
Stating the surviving ground also makes the D3 relationship legible: LWW gets *less*
defensible as writers multiply, not more.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Leave the rationale and treat it as approximately true | It is not approximately true — "single-operator product" is precisely the premise the 2026-07-29 decision retires. Leaving it invites exactly the wrong inference. |
| Revisit the decision itself and adopt per-field LWW now that contention is real | Backwards. Higher contention over invariant-bearing fields (issue graph, stage machine) is a stronger argument for rejection, not a weaker one; blind merge produces states no command could have produced. D2's own rejected-alternatives table already answers this and is unaffected. |
| Replace exp-rev with operational transform / CRDT everywhere | Confuses two problems. Structured entities with cross-field invariants are not documents; D12 carves out documents *specifically* so the general rule does not have to bend. |
| Record the POD-316 change as a comment on POD-316 rather than in the ADR | The ADR is where the sizing assumption ("acceptable for single-operator", ADR 1 Consequences) is written down. Correcting it anywhere else leaves the wrong assumption in the governing document. |

### Decision D12 — `op-stream` reserved as a sixth conflict class; D1's CRDT rejection carved out (amends D1, D3)

**Decision, three parts.**

**1. D1's CRDT rejection stands, with its scope stated.** ADR 1 D1's rejected-alternatives
row — a CRDT backbone for **metadata** — is **correct and unchanged**: daemon observations
are server/daemon-authoritative observation, not collaborative text, and merging "session 12
is busy" is meaningless. The row is amended only to state its scope: it rejects CRDTs **as a
metadata backbone**, and is **not** a ruling on collaborative text.

**2. A sixth conflict class is reserved.** The conflict vocabulary becomes `exp-rev`,
`field-LWW`, `single-writer`, `append`, `cmd`, **`op-stream`**:

> **`op-stream` — collaborative text is a per-document ordered op stream sequenced by the
> Authority.** Ops are commands; the Authority assigns order and appends them to the feed;
> the Replica applies them in order. **The Replica still never arbitrates** — it applies an
> ordering someone else decided. This is D1's rule applied, not an exception to it.

The class is **RESERVED, NOT BUILT**, and its permitted membership is a **small, named
set**: the session composer draft body, and issue description / notes. Adding a member
requires an ADR 1 amendment, exactly as D3 requires for `field-LWW`. No CRDT library is
required on day one — an authority-sequenced op log converges for a shared document — and
nothing here forecloses swapping in a real CRDT if offline concurrent editing is ever
wanted.

**3. A binding constraint on whoever builds it.** ADR 2 D5's retention-safety proof depends
on the bootstrap snapshot being **positive state**. For a document, the truth is the
**materialized document**, so the proof holds **only if ops compact into a materialized
document snapshot**. A document entity that carries its materialized value plus a bounded
recent-op tail keeps ADR 2 D5 intact. Anything else — a document reconstructed by replaying
an unbounded op log — requires the log-compaction ADR that ADR 2 D5 already parks, and must
not be built without it.

**Also recorded: concurrent PTY input is not a text-merge problem.** Two people typing into
one terminal is a **control** problem, already modelled by `Session.controllerId` +
`requestControl` (verified: first attacher takes control, `session.ts:344`; transfer at
`session.ts:553`). The right product answer is explicit control handoff **with identity**
(Phase 5 — `controllerId` is a connection id today, not a person), not character merging.
`op-stream` does not apply to PTY input and must not be cited for it.

**Rationale.** Readiness §4 finds that nothing in the pack *closes* the realtime-collaboration
path, but that one clause **reads** as if it does. A rejection stated at the scope "no CRDTs"
will be cited by a future implementer to block co-editing a description field — a different
problem with a different answer. Reserving the class now costs one vocabulary entry and
settles the question in the document that owns conflict rules; discovering it later means
re-opening D1 under delivery pressure. Reserving it *with* the ADR 2 D5 constraint attached
is the part that matters most: the naive implementation (pure op log, head-pruned) silently
breaks a retention proof in a different ADR, and that interaction is invisible from inside
either document alone.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Adopt a CRDT (Yjs/Automerge) for the named text fields now | Solves a problem nobody has yet — offline concurrent editing — at the cost of a library, a second convergence model, and a persistence format inside the entity. Authority-sequenced ops converge for the online case, which is the case that exists, and leave the CRDT swap available. |
| Say nothing and let the future co-editing feature decide | That is the status quo, and readiness §4 explains why it fails: D1's sentence is already there, and it will be cited. Silence resolves to "blocked by D1". |
| Broaden `op-stream` to any user-authored text field | Turns a carve-out into the default and undermines D2 for issue titles, comments and names — fields with invariants, provenance rules ([spec:SP-eb60] name-vs-title) and append semantics that work today. A small named set is auditable; "text fields" is not. |
| Model collaborative text as `field-LWW` with a shorter window | Whole-body LWW is the data-loss bug; a shorter window makes it less frequent and no less silent. |
| Apply `op-stream` to PTY input for shared terminals | Terminal input is not a document: order is not the only constraint, and interleaving two people's keystrokes produces commands neither typed. Control transfer already exists and is the correct model. |
| Build ops now and defer materialization/compaction | Directly breaks ADR 2 D5's contiguity/positive-state proof, which is a correctness property of the whole sync kernel — not a document-feature detail. Part 3 exists to make this non-optional. |

### Decision D13 — Machines are owned compute, not tenant-visible infrastructure (amends matrix §1)

**Decision.** Per readiness §3.1.4 (which explicitly corrects an earlier draft that placed
machines under tenant-visible infrastructure):

1. **Machines carry an owner and a per-machine grant list**, visibility class
   `owned-compute`, grant verbs **`see` / `use` / `manage`** — the verb taxonomy is ADR 9 D6.
   The instance-wide role gate (ADR 3 D2's `read`/`write`/`manage` over a `machine` resource
   scope) remains the *role* half; ownership and grants are the half that does not exist
   today.
2. **`use` defaults to owner-only**, and is a code-execution boundary rather than a privacy
   boundary — the argument is ADR 9 D6 M2's and is not restated here. The consequence ADR 1
   owns: `use` is **not** the same annotation as a personal class's `read`/`write` grant, and
   a matrix row must never conflate them.
3. **A newly paired machine is private to its pairer** (M3): pairing runs from that person's
   machine with their join code, so they are the owner. This is D9's default-closed rule
   applied, not an exception to it.
4. **The all-in-one host is owned, not ambient** (M4). Verified: `LOCAL_MACHINE_ID = 'local'`
   (`packages/runtime/src/local-machine.ts:13`) makes the server's host a fleet member, so
   without an owner anyone who can authenticate inherits execute on it. It is owned by
   whoever set the instance up.
5. **Per-machine facts inherit the machine's scoping and carry no owner of their own**:
   `repos` / `repo_prefixes` (verified keyed `(machine_id, path)`), worktrees, harness and
   model inventory (`machines.inventory_json`), host metrics. They declare
   `owner: inherits Machine`.
6. **Machine *existence* for admins is `deployment-substrate`** (readiness §3.1.1 table):
   fleet management needs to know a machine exists. Existence is the only part that is
   substrate; everything else on the row is owned.
7. **Placement and handoff fail closed** (M5): a principal without `use` must not be offered
   the machine, and handoff (POD-323 / POD-644) to it is **denied, not silently retargeted**.
   ADR 1 owns only the ownership fact; the denial-vs-unreachable distinction is a command
   and UX obligation on ADR 3's policy and the handoff feature.

**Rationale.** ADR 9 D6 M2 supplies the argument for why `use` is a different kind of
boundary; ADR 1's job is to make that difference *representable on a row*, because the
matrix is where an implementer looks up "what may this principal do with this?". A row that
carried one visibility bit would answer that question wrongly for every machine in the
fleet — and would do so silently, since the wrong answer looks exactly like the right one
for a personal issue. The inheritance rule (item 5) is the other half: it keeps the
tenant-visible floor small by removing the temptation to classify a long tail of
per-machine tables individually, which is the point at which someone classifies one of them
as substrate to make a listing work.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Machines are tenant-visible infrastructure (the earlier draft) | Explicitly corrected by human direction 2026-07-29: "a personal mac shouldn't be accessible for everyone in the team to run agents." A machine is paired *to* the instance but owned *by* a person. |
| One visibility bit for machines | Collapses `see` and `use`. Fleet health needs `see`; `use` is remote code execution. One bit forces either a fleet you cannot monitor or a fleet anyone can execute on. |
| A separate fleet ACL outside the ownership model | Agents would then need a second inheritance rule, and delegation chains (readiness §3.1.3) would have to be re-derived against it. M6's "for free" property depends on one principal model. |
| Give per-machine facts (repos, inventory, metrics) their own owners | Multiplies classification work and creates incoherent states — a repo visible to someone with no `see` on its machine. Inheritance keeps the tenant-visible floor deliberately small (readiness §3.1.1). |
| Treat the all-in-one host as ambient team compute since it runs the server | Fails closed is the rule; this is the case where failing open grants execute on the operator's laptop to every authenticated user. |

### Decision D14 — D5 is **unaffected**: multi-user is not multi-tenancy

**Decision.** ADR 1 **D5 stands exactly as written.** `InstanceId` remains a branded model
identity and the **deployment partition** of an entire Authority. Multi-user in one tenant
lives **inside** one instance.

D5.3's clause — *"Explicit columns are reserved only if a future shared multi-tenant store
is adopted"* — is **NOT triggered** by the multi-user requirement (readiness §2, final
bullet). Normatively:

> **No `instance_id` (or equivalent tenant discriminator) column may be added to any
> aggregate, per-user state row, grant edge, wire projection or replica store as a
> consequence of multi-user.** Isolation between instances remains by separate state DB.
> Owner and visibility partition *people within one instance*; they are not a tenant
> dimension and must not be implemented as one.

**Rationale.** "Multi-user" and "multi-tenant" are one word apart and produce completely
different schemas. This amendment adds an owner dimension to nearly every row, which is
exactly the moment an implementer pattern-matches to SaaS tenancy and adds a second
discriminator that is constant in every row — the alternative D5 already rejected, arriving
by a new route. Restating the unchanged decision here is cheaper than the migration that
removes the columns.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Say nothing, since D5 is unchanged | Silence is what allows the misreading. Readiness §2 flags it specifically: "worth restating so nobody confuses multi-user with multi-tenant and starts adding `instance_id` columns." |
| Add `instance_id` now "since we are touching every table anyway" | Every row would carry one constant under per-DB isolation — D5's own rejected-alternatives row, unchanged. Sharing a store across instances is a different decision that would need its own ADR and its own authorization story. |
| Model users as tenants (one user = one instance) | Defeats the requirement: sharing between people inside one workspace is the feature. It would also multiply daemons, ports, systemd units and state roots per person ([spec:SP-15aa]). |

### Decision D15 — D6 unchanged; secrets management is admin-grade

**Decision.** ADR 1 **D6 is unchanged**: `secret-value` material is server- or machine-local
only, wire/read projections expose at most presence + fingerprint, and the Outbox **must
not** enqueue secret writes. Preferences remain `preference` / `public` and may be
offline-eligible.

One clause is added (readiness §3.2): **once more than one human exists, managing
`secret-value` material is an admin-grade action.** Provider API keys, `integrations.linearApiKey`,
`notifications.telegramBotToken`, pairing token preimages and managed credential blobs are
`owner: none (secret)`, visibility class `secret`, grants **none** — their `manage` verb is
gated on the instance admin role (ADR 3 D2's role vocabulary; ADR 9 owns the role set), not
on ownership and not on grants.

Two boundary notes that follow from other decisions and are recorded so they are not
rediscovered:

- **`notifications.telegramChatId` is not a secret and moves to per-user state** (D10;
  readiness §3.1.6 S4). Verified today as a single `z.string().default('')` in
  `PodiumSettings` — one chat id for one implied identity. ADR 1's §6 note ("chat id is
  routing config, not a bearer secret of the same class") is unchanged and now has a home.
- **A per-user superagent makes the inbound Telegram edge an authentication surface**
  (readiness §3.1.6 S4). ADR 3 D7 (principal from authenticated transport only) already
  governs it; ADR 1 records only that unknown chats must fail closed and must never resolve
  to an operator identity. The binding ceremony is ADR 3 / ADR 9 territory.

**Rationale.** D6 was written for a single trust domain of *values* with one human. The
never-replicate / never-queue rule is orthogonal to how many humans there are and needs no
change. What changes is *who may rotate the key*: with several people, "any authenticated
principal may replace the org's Anthropic key" is a privilege escalation with a billing
blast radius, and secret rotation is the classic admin action.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Give secrets an owner and let owners grant access | Multiplies the secret surface D6 exists to minimise, and the material is not personal — it is the instance's. Ownership would also imply transfer semantics for credentials, which is a bad thing to have to define. |
| Leave secret management on the ordinary write path | Under private-by-default, any authenticated member could rotate provider keys and silently break or re-bill every agent in the instance. Admin-grade is the smallest change that closes it. |
| Classify `telegramChatId` as a secret to be safe | It is routing config, already classified as `preference` by ADR 1 §6; treating it as secret would make it unreplicable and break the per-user notification routing readiness §3.1.6 S3 depends on. The real risk is authentication of inbound messages, which is a different fix. |

---

## 3. Amended matrix — the three new columns, filled in for every row

Normative. Read as part of ADR 1's Matrix section; ADR 1's existing eight columns for each
row are unchanged and are not restated here. Visibility classes are ADR 9 D3's; grant verbs
are ADR 9 D6's. `inherits X` means the row carries no owner of its own and resolves to X's.

Per D9.3, per-feature policy may move any row *toward* privacy without an amendment;
widening requires one.

### §1 Identity & deployment scope

| Row | Owner | Visibility class | Grants |
|---|---|---|---|
| **InstanceId** (partition) | none — `substrate` (deployment partition, D14) | `deployment-substrate` | none; selection is a deploy-time act |
| **Machine** (`machines`) | pairer (D13.3); instance installer for `local` (D13.4) | `owned-compute`; **existence** only is `deployment-substrate` for admins (D13.6) | `see` / `use` / `manage` |
| **Pairing token / client session token** | none — `secret` | `secret` | none; `manage` admin-grade (D15) |
| **Daemon local identity file** | inherits Machine | `owned-compute` (local file; not replicated) | inherits Machine |

### §2 Sessions

| Row | Owner | Visibility class | Grants |
|---|---|---|---|
| **Session identity** | delegating human (`on-behalf-of` of the spawning principal — readiness §3.1.3 A4) | `personal` | `read` / `write` |
| **Session placement** (`cwd`, `machineId`, `issueId`, agentKind, …) | inherits Session | `personal` | inherits Session; **placement is additionally gated by the target machine's `use`** (D13.7) |
| **User-authored labels** (`name`/`nameSource`, `title`, `archived`, `workState`) | inherits Session | `personal` | inherits Session |
| **Session `readAt`** (moved out of the labels group by D10) | the reading user | `per-user-state` | none |
| **Snooze** (`snoozes` / `snoozedUntil`) | the snoozing user | `per-user-state` | none |
| **Composer draft** (`session_drafts`) | inherits Session | `personal` | inherits Session; conflict class per D10 / D12 |
| **Queued agent messages** (`queued_messages`) | inherits Session | `personal` | inherits Session |
| **Daemon-observed runtime** (status, epoch, geometry, agentState, …) | inherits Session | `personal` | inherits Session (observation about a personal entity, produced on owned compute) |
| **Live-only / ephemeral** — PTY handles, controller set, in-flight handoff overlay | inherits Session | `personal` (live; ADR 7 plane) | inherits Session |
| **Live-only / ephemeral** — host metrics | inherits Machine | `owned-compute` | `see` |
| **Provenance envelope** (`viaHub`, `upstreamStale`, `pendingSync`) | none — `derived` (per-delivery fact) | inherits the entity it envelopes | none |

### §3 Issues & tracker

| Row | Owner | Visibility class | Grants |
|---|---|---|---|
| **Issue core** | creating principal's `on-behalf-of` human | `personal` | `read` / `write` |
| **Needs-human group** | inherits Issue | `personal` | inherits Issue; routing is per-user (readiness §3.1.6 S3) |
| **Issue graph** (parent, deps, labels, blocked_by, superseded_by, duplicate_of) | inherits the **edge's owning issue** | `personal` | inherits Issue. **Cross-boundary edge display is open — O2** |
| **Issue comments** | commenting principal's `on-behalf-of` human; visibility inherits Issue | `personal` | inherits Issue |
| **Issue messages** (tracker mail, `issue_messages`) | inherits Issue | `personal` | inherits Issue for read. **Send is deliberately not gated by the reader's grants** — the send-without-read primitive and its two multi-user clauses are **ADR 9 D7**, not restated here |
| **Issue message `readAt`** (moved by D10) | the reading user | `per-user-state` | none |
| **Artifacts** | inherits its Session or Issue | `personal` | inherits parent |

### §4 Conversations & transcripts

| Row | Owner | Visibility class | Grants |
|---|---|---|---|
| **Conversation registry** | inherits the Session that produced it (**inheritance across multi-session conversations is open — O4**) | `personal` | inherits Session |
| **Segments / native evidence** | inherits Conversation | `personal` (bytes on the bulk plane, ADR 7) | inherits Conversation |
| **Blobs** (content-addressed) | none — `derived` (identity is the hash; one blob may back several owners) | inherits **every** referencing entity; a blob is readable only via a reference the principal may see | none. **Cross-owner dedup is an existence-leak surface — O1** |

### §5 Repos, pins, tabs

| Row | Owner | Visibility class | Grants |
|---|---|---|---|
| **Repo / prefix** (`repos`, `repo_prefixes`) | inherits Machine (D13.5) | `owned-compute` | inherits Machine (`see` to list, `use` to work in) |
| **Pins** | the pinning user | `per-user-state` | none |
| **Tab order** | the user whose layout it is | `per-user-state` | none |

### §6 Settings, secrets, accounts

| Row | Owner | Visibility class | Grants |
|---|---|---|---|
| **Preferences — personal keys** (session defaults, sidebar, autoContinue, `telegramChatId`, ntfy topic, …) | the user | `per-user-state` | none |
| **Preferences — instance keys** (deployment-level settings) | none — `substrate` | `deployment-substrate` | none; write is admin-grade |
| **Server-owned secrets** (`apiKeys.*`, `linearApiKey`, `telegramBotToken`) | none — `secret` | `secret` | none; `manage` admin-grade (D15) |
| **Managed credentials / accounts** (`accounts`) | none — `secret` at rest | `secret` | none; `manage` admin-grade. Injection at spawn is bounded by the spawning principal's rights |
| **Operator `config.features`** (feature flags) | none — `substrate` | `deployment-substrate` | none; deploy-time |

### §7 Coordination: locks, approvals, automations, workflows

| Row | Owner | Visibility class | Grants |
|---|---|---|---|
| **Advisory locks** (`locks`, `lock_waiters`) | none — `substrate` (coordination names every principal must resolve identically — readiness §3.1.1) | `deployment-substrate` | none. **Whether lock *holder* identity is visible is an existence question — O1** |
| **Approval requests** | the human the request is routed to (the requesting agent's `on-behalf-of`) | `personal` | inherits the subject entity |
| **Automations / runs** | creating user; runs as that user with that user's **current** rights (readiness §3.1.6 S6) | `personal` | `read` / `write` |
| **Workflows / revisions / bindings / runs / steps / events / execution_profiles** | creating user | `personal` | `read` / `write`; run advance additionally gated by target machine `use` |

### §8 Messaging bus & superagent

| Row | Owner | Visibility class | Grants |
|---|---|---|---|
| **Messages** (`messages` substrate) | sender's `on-behalf-of` human | `personal` | visibility to the addressed party follows the addressing rule; per-feature refinement is deferred |
| **Messaging issue topics** | inherits Issue | `personal` | inherits Issue |
| **Superagent threads / messages / queued inputs / pending turns** | the superagent's human (readiness §3.1.6 S1/S2) | `personal` | `read` / `write`; not shared by default |

### §9 Handoff / portable export

| Row | Owner | Visibility class | Grants |
|---|---|---|---|
| **Handoff bundle / HandoffManifest** | inherits the exported Session | `personal` | inherits Session; **accept is denied (not retargeted) without `use` on the target machine** (D13.7). Manifest carries owner + attribution and, per D6, no secrets |

### §10 Sync infrastructure (not product entities)

| Row | Owner | Visibility class | Grants |
|---|---|---|---|
| **Change log** (`changes`) | none — `substrate` | `deployment-substrate` at rest; **delivery is per-principal scoped** (ADR 2's amendment owns scoping, watermarks and rescope) | none |
| **Applied mutations** | none — `substrate` | `deployment-substrate`; never replicated to the general replica | none |
| **Client outbox** | the authenticated principal on that device | `per-user-state` (device-local; never replicated) | none; must not hold `secret-value` (D6) |
| **Replica cursor / collections** | the authenticated principal on that device | `per-user-state` (device-local cache of that principal's slice) | none |
| **`upstream_outbox`** (legacy, retired with POD-309) | n/a | n/a | n/a |

### §11 Classes the multi-user amendments themselves introduce (added at POD-359 reconciliation, 2026-07-29)

D9's totality test applies to **every** durable class, including the ones this round of
amendments creates. Sections 1–10 cover ADR 1's existing matrix rows; the classes below did not
exist when it was written, and leaving them unclassified would fail D9 on the pack's own new
aggregates. Every cell here follows mechanically from a decision that already exists — no new
policy is decided in this section. Where a cell is a genuine policy call it says so and routes
to the canonical open item rather than guessing.

| Row | Owner | Visibility class | Grants |
|---|---|---|---|
| **User / account aggregate** (ADR 9 D1.2: identity, display name, lifecycle) | the user themselves | `personal` for the profile. **Whether the member directory — the bare existence of an account — is `deployment-substrate` so that people can be named as grantees, is a policy call: O1.** Sharing needs *some* way to name a grantee; which facts that discloses is not decided here | none; account lifecycle (invite, disable, remove) is admin-grade (D15) |
| **Account credential material** (ADR 9 D1.2) | none — `secret` | `secret` (ADR 1 D6 unchanged) | none; `manage` admin-grade (D15) |
| **Per-user `client_session`** (ADR 9 D1.3: a device that resolves to a user) | the authenticated user | `per-user-state` | none. Token material is `secret` (§1 above) |
| **Grant edge** (ADR 9 D2: `(entityRef, granteeUserId, verb)`) | the **granter** — a grant may never exceed its granter's own rights (ADR 9 D2 rule 4), so the granter is the accountable party | inherits the entity it grants on, **and is visible to the grantee** (a grantee who cannot see the grant cannot see that they have access) | none — a grant is not itself grantable. It is a durable change with a global `seq`, which is what ADR 2 Amendment 1 D14.3 anchors visibility events on |
| **Delegation record** (ADR 3 Amendment 1 D14.3: `agentIdentity`, `onBehalfOf`, scope, lifecycle) | the delegating human (ADR 9 D5 A1) | `personal` | none. Its lifecycle **is** `SessionBinding` (ADR 9 D5 A5, POD-323); it is server-minted and never wire-supplied |
| **Telegram chat binding** (ADR 3 Amendment 1 D22.1: `chatId → UserId`) | the bound user | `per-user-state`, keyed `(userId, chatId)` — this is where D10's move of `telegramChatId` lands | none. The bot token stays `secret` (D15) |
| **Per-user state family** (generic; D10) | the user in the key | `per-user-state` | **none, by construction** — see D10 |

The one contested cell is the member directory, and it is contested for the reason O1 exists:
naming a grantee requires disclosing that the grantee exists. It is marked, not resolved.

**Systems principals.** Rows written by `system` (steward, expiry, boot reconcile, derived
fields) keep the owner of whatever they acted on. Per readiness §3.1.6 S5, system principals
may read across owners, but every write is attributed `system`, lands in the scope of the
entity it acted on, **never widens anyone's visibility, and never acts *as* a person.**

---

## 4. Deliberately open — recorded, not answered

These are open in `docs/multi-user-readiness.md` and are **not** decided here. Answering any
of them inside this amendment would pre-empt a deferred per-feature or human call.

> **Numbering is the pack's canonical open list — ADR 9 §3** (POD-359 reconciliation, 2026-07-29).
> **O5** (host-local credentials under a `use` grant — readiness §3.1.4 "Unresolved") and **O6**
> (phase ordering of the one subscription primitive, ADR 7 Amendment 1 D13) raise no ownership or
> conflict-rule question and are therefore absent below, not closed. O1 acquires one further site
> in this amendment: the member-directory cell of §3 §11.

| # | Open question | What ADR 1 will owe once it is answered | Who decides | When |
|---|---|---|---|---|
| **O1** | **Which existence facts leak** — counts, machine session lists, "this worktree is in use", lock holders, issue ref-letter allocation, cross-owner blob dedup (readiness §3.1.2) | Whether an existence-bearing row is `deployment-substrate` or must be suppressed from a scoped slice; today's matrix marks the sites (§3 blobs, §7 locks) without resolving them | Feature owner per surface, against ADR 9's visibility classes | Phase 3 policy (POD-290). The consistent-error rule for one site is already fixed (readiness §3.1.5) |
| **O2** | **Cross-boundary graph edge display** — hide the edge, or show an opaque reference (readiness §3.1.2) | Whether the issue-graph row needs a distinct visibility annotation for the edge vs its endpoints | Human + feature owner; it is a policy call because the opaque form leaks existence | Phase 3 policy (POD-290), before any issue-graph wire change |
| **O3** | **Is `reparent` a permission-affecting operation**, given that subtree scope is dynamic (readiness §3.1.5 case 2) | Nothing new in ADR 1 unless the answer is "confirmation required", which makes it an ADR 3 D2 confirmation shape, not an ownership change | Human, on the tracker's behaviour | Phase 3 (POD-290); surfaced in the UI at the latest |
| **O4** | **Per-class owner / grant inheritance on create** — does a child inherit the parent's owner and grants, or the actor's (readiness §3.1.2, §3.1.3 A4) | §3's `inherits X` cells encode the *expectation* that the parent wins; the *declaration* per class, and the multi-parent cases (a conversation spanning sessions), are the open part | ADR 1 matrix annotation per class + the per-class feature owner | Declared per class as classes land; annotation shape at Phase 1 (POD-304) |

§3's `inherits X` cells are deliberately written as inheritance *expectations* consistent
with readiness §3.1.3 A4, not as a resolution of O4: a class may still declare that the
actor wins, and must do so explicitly.

---

## 5. Consequences

### Positive

- One row of the matrix answers "who may change this, and who may see it" — the property
  that made ADR 1 usable, preserved under multi-user instead of split across documents.
- **The pack gets smaller.** D3's field-LWW closed set drops from six groups to one
  (instance preference keys) plus one named interim (the draft), because keying by user
  removes the contention rather than resolving it.
- Forgetting is safe: an unclassified class is private (D9), which turns the deferred
  per-feature membership decision from a risk into a backlog item.
- The realtime-collaboration path is explicitly open (D12) without building anything, and
  the one interaction that would silently break the sync kernel (ADR 2 D5) is attached to
  the reservation rather than discovered during implementation.
- Machine access lands on the same principal model as everything else, so delegated agents
  inherit the compute boundary with no additional mechanism (readiness §3.1.4 M6).

### Negative / cost

- Phase 1 grows: `UserId`, a `User` aggregate, per-user `client_sessions`, and the per-user
  state family — before Phase 2's scoped feed can mean anything.
- Every existing matrix row now needs three more annotations, and POD-304's totality test
  needs three more checks.
- POD-316 (reject/rebase UX) is re-sized from an edge case to a normal-path feature (D11).
- Five singleton tables (`pins`, `tab_order`, `session_drafts`, `snoozes`, plus the three
  `read_at` columns) change key shape. Cheap in Phase 1; a wire + replica migration after
  POD-308.
- The composer draft carries a **named, dated** defect until either `op-stream` lands or the
  draft is gated single-writer — and that becomes a gate on session sharing.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| An implementer reads "multi-user" as "multi-tenant" and adds `instance_id` columns | D14 states the prohibition normatively; the compliance checklist below tests for it; ADR 1 D5's rejected-alternatives table is unchanged and already answers it. |
| A new entity class ships with no visibility class and defaults open | D9: unclassified **is** private, and the totality test fails the class rather than warning. Widening requires an amendment (one-way ratchet). |
| Per-user state gets a `user_id` in storage but stays a singleton on the wire | ADR 4 Amendment 1 D10.1 forbids reader-dependent fields on a shared projection; golden fixtures (POD-360) surface a leftover singleton as a diff. |
| `op-stream` is built as a pure op log and quietly breaks ADR 2 D5's retention proof | D12 part 3 makes materialization a precondition, not a later optimization, and points at the log-compaction ADR that ADR 2 already parks. |
| `op-stream` is cited for PTY input, or broadened to "text fields" | D12 names the closed member set and states that PTY input is a control problem with an existing mechanism; adding a member requires an amendment. |
| `use` on a machine is presented as an ordinary sharing checkbox | D13.2 records it as a code-execution boundary (readiness §3.1.4 M2); the product-copy obligation is stated in readiness and belongs to the feature, not the model. |
| Deleting a user orphans or leaks their rows | Per-user rows follow the user and cascade (D10); owned entities need a transfer story — this is ADR 9's lifecycle territory and is flagged, not decided, here. |
| Agents keep rights after their human is revoked | Not this ADR's mechanism: readiness §3.1.3 A1 resolves delegation live at every apply, which ADR 3 D8 already performs. D8's owner annotations are inputs to that resolution, not a second cache. |

---

## 6. Compliance checklist

Additive to ADR 1's checklist. In compliance when:

- [ ] Every durable class declares **owner** (or a declared no-owner reason), **visibility
      class**, and **grants** — and the totality test fails the build when one is missing.
- [ ] An unclassified class resolves to `personal`/private; no code path treats "no
      classification" as tenant-visible.
- [ ] Widening a class's visibility, or its grant verb set, arrives as an ADR 1 amendment,
      not as a code change.
- [ ] Per-user state is keyed `(userId, entityId)`, conflict `single-writer`, and is
      **non-grantable**; no per-user value rides a shared entity's wire projection.
- [ ] The field-LWW closed set contains only instance-scope preference keys (plus the
      composer draft's dated interim), and every remaining member still satisfies D3's four
      conditions.
- [ ] Session sharing does not ship while the composer draft is still whole-body `field-LWW`
      with more than one permitted writer.
- [ ] `op-stream` has no members beyond composer draft body and issue description/notes; any
      implementation compacts into a materialized document snapshot (ADR 2 D5).
- [ ] Machines carry an owner; `use` defaults to owner-only; spawn/handoff to a machine
      without `use` is **denied**, not retargeted; the `local` machine is owned.
- [ ] Attribution is recorded as the pair (actor, on-behalf-of), both from the transport
      principal (ADR 3 D7), never from payload.
- [ ] No `instance_id` (or equivalent tenant discriminator) column exists on any aggregate,
      per-user state row, grant edge, projection or replica store.
- [ ] `secret-value` management is admin-grade; `telegramChatId` is per-user state and not
      classified as a secret.

**Out of compliance** when a class ships without a visibility class, when per-user state is
stored as an instance-wide singleton, when a machine is reachable for execution by a
principal without `use`, when collaborative text is merged anywhere but an
Authority-sequenced op stream, or when multi-user is implemented as tenancy.

---

## 7. Self-verification record

Checked on integration tip `2ddfec21`, 2026-07-29. Every factual claim above traces to a
row here.

| Claim | Where verified |
|---|---|
| No `UserId` brand exists | `packages/protocol/src/ids.ts` — declares `MachineId`, `SessionId`, `IssueId`, `RepoId`, `ConversationId`, `MutationId`, `ThreadId`; no `UserId` |
| One password per instance, no accounts | `packages/runtime/src/auth-store.ts` — `setPassword` (L93), `verifyPassword` (L126) |
| `client_sessions` has no user column | `apps/server/src/migrations/schema.ts` L190 — `(token_hash, created_at, expires_at)` |
| `OPERATOR` is unconstrained admin/all | `packages/domain/src/issue-authz.ts` — `OPERATOR: Capability = { role: 'admin', scope: { kind: 'all' } }` (L47); `Capability.actorSessionId` at L37ff |
| ADR 1's matrix has role classes only, no owner column | `docs/adr/0001-authority-ownership.md` D4 "Permitted writers" and the Matrix section |
| `pins` is keyed `(kind, id)` | `apps/server/src/migrations/schema.ts` L85–91 (`pins_pk`) |
| `tab_order` is keyed by `worktree` | same file L93 |
| `session_drafts` / `snoozes` are keyed by `session_id` | same file L168, L174 |
| `read_at` is a singleton column on three tables | same file — `sessions` L45, `issue_messages` L332, `issues` L389 |
| `WorkState` is a lifecycle enum, not a viewer opinion | `packages/protocol/src/messages/runtime-state.ts` L64 — `['planning','implementing','testing','done','icebox']` |
| `sessions.archived` sits beside the delete columns on the shared row | `apps/server/src/migrations/schema.ts` L36 (`archived`), L45–48 (`read_at`, `deleted_at`, `deleted_by_issue_id`, `deletion_source`) |
| `machines` carries no owner and no grants | same file L147 — `(id, name, hostname, token_hash, created_at, last_seen_at, inventory_json)` |
| `repos` is a per-machine fact keyed `(machine_id, path)` | same file L157–166 (`repos_pk`) |
| The all-in-one host is a fleet member named `local` | `packages/runtime/src/local-machine.ts` L13 — `export const LOCAL_MACHINE_ID = 'local'` |
| Superagent tables exist and carry no owner | `apps/server/src/migrations/schema.ts` — `superagent_messages` L119, `superagent_threads` L130, `superagent_queued_inputs` L446, `superagent_pending_turns` L456 |
| First attacher takes control; `controllerId` is a connection id | `apps/server/src/modules/sessions/session.ts` L344 — `if (this.controllerId === null) this.controllerId = client.id` |
| Control transfers via `requestControl(clientId)` | same file L553; dispatched at `apps/server/src/modules/sessions/service.ts` L2569–2570 |
| `controllerId` is nullable and broadcast on the wire | `packages/protocol/src/messages/runtime-state.ts` L88; `packages/protocol/src/messages/terminal.ts` L193 (`requestControl`), L241/L260 (`attached` / `controllerChanged`) |
| `telegramChatId` is a single instance-wide string today | `packages/runtime/src/settings.ts` — `PodiumSettings` L234, `notifications.telegramChatId: z.string().default('')` L274 |
| ADR 2 D5's safety proof rests on the snapshot being *positive state*, and parks log compaction beyond head-pruning | `docs/adr/0002-sync-protocol.md` D5 (L376ff), points 1–3 and the "needs its own ADR" clause |
| ADR 2 D5 also warns that soft-delete and tombstone look identical from a distance | same section, final paragraph |
| ADR 3 owns principal-from-transport, apply-time re-auth, `expectedRevision` | `docs/adr/0003-command-security.md` D7 (L248), D8 (L273), D13 (L425) |
| ADR 2 owns feed identity, revision, unscoped-feed-needs-watermarks | `docs/adr/0002-sync-protocol.md` D1 (L112), D2 (L201), D3 (L242) |
| ADR 4 Amendment 1 owns the shapes this amendment references (branded `UserId`, ownership field group, attribution pair, per-user keyed aggregate) | `docs/adr/0004-representation-policy-amendment-1.md` D9, D10 |
| ADR 9 owns the taxonomy consumed here, and assigns the matrix column set + per-aggregate values to this amendment | `docs/adr/0009-identity-ownership-sharing.md` — D2 (L174, rule 1 names POD-1071), D3 five visibility classes (L223), D4 default-closed + totality test (L274, enforcement point 1 names POD-1071), D5 A3 attribution pair (L310ff), D6 `see`/`use`/`manage` (L377) |
| ADR 9 D3 rule 4 defers the *conflict-rule* consequence of per-user state to this amendment, and its *shape* to ADR 4 Amendment 1 D10 | `docs/adr/0009-identity-ownership-sharing.md` D3 binding rule 4 |
| ADR 9 D2 rule 5 assigns the feed expression of visibility change (watermarks / rescope / `evict`) to ADR 2's amendment, not here | `docs/adr/0009-identity-ownership-sharing.md` D2 rule 5 |
| Human decision: C's mechanism with B's default; private by default; per-feature policy deferred | `docs/multi-user-readiness.md` header block, §3.1 |
| Machines are owned compute with `see`/`use`/`manage`; earlier tenant-visible draft explicitly corrected | `docs/multi-user-readiness.md` §3.1.1 correction note, §3.1.4 M1–M6 |
| Agent output is owned by the delegating human; attribution is a pair | `docs/multi-user-readiness.md` §3.1.3 A3, A4 |
| Superagent is per-user; system automations are not delegated | `docs/multi-user-readiness.md` §3.1.6 S1–S6 |
| Half the LWW inventory is per-person state; the carve-out shrinks toward empty | `docs/multi-user-readiness.md` §3.3 |
| D2's "low multi-writer contention (single-operator product)" rationale is void; POD-316 becomes routine | `docs/multi-user-readiness.md` §3.3, final paragraph |
| The CRDT carve-out, `op-stream`, the ADR 2 D5 compaction constraint and the PTY-is-control note | `docs/multi-user-readiness.md` §4 and its items 1–2 |
| ADR 1 D5 is unaffected; multi-user is not multi-tenancy | `docs/multi-user-readiness.md` §2 final bullet; `docs/adr/0001-authority-ownership.md` D5.3 |
| Open items O1–O4 are recorded as deliberately open upstream | `docs/multi-user-readiness.md` §3.1.2 (existence leaks, cross-boundary edges, inheritance on create) and §3.1.5 case 2 (reparent) |
| **Drift observed, not corrected here:** ADR 1's entity-inventory note records **48** server tables (verified 2026-07-17); `rg -c 'sqliteTable\(' apps/server/src/migrations/schema.ts` now returns **49** | ADR 1's inventory note owns that number, so it was reported to POD-359 rather than restated or edited here. **Resolved 2026-07-29 at reconciliation:** POD-359 re-verified 49 and dated the note in ADR 1 itself; the grouping this amendment's §3 depends on is unaffected |

---

## 8. Status / sign-off path

| Stage | Owner |
|---|---|
| Proposed | POD-1071 (this document) |
| Pack reconciliation + index | POD-359 |
| Human approval | POD-359 human gate |
| Implemented annotations (three new columns + totality test) | POD-304 |
| Enforced at write seam | POD-305 |
| Per-user state family + `UserId` brand | Phase 1 (POD-288 / POD-301 family) |
| Scoped delivery of the annotated rows | Phase 2 (POD-289), ADR 2's amendment |
| Ownership / grant policy and share commands | Phase 3 (POD-290) |
| `op-stream` | Reserved; unscheduled. Requires the ADR 2 D5 materialization constraint |

Until human sign-off of the ADR pack, Phase 1–2 must not treat alternate ownership,
visibility or conflict strategies as authorized.
