# ADR 9 — Identity, ownership and sharing

- **Status:** Proposed (human gate: POD-359)
- **Date:** 2026-07-29
- **Deciders:** architecture rewrite ADR pack (POD-359); human decisions of 2026-07-28/29
  recorded in `docs/multi-user-readiness.md`; human sign-off before Phase 1
- **Issue:** POD-1070 (leaf of POD-359; ninth ADR, added after the multi-user assessment)
- **Consumers:** POD-288 / POD-301 (`UserId` brand + model phase), POD-304 (matrix
  annotations + totality test), POD-305 (Authority write funnel), POD-311 / POD-315
  (command framework + principal/authz suite), POD-290 (policy: ownership, grants,
  share/unshare commands), POD-323 (SessionBinding as the delegation lifecycle),
  POD-352 / POD-418–421 (secrets are admin-grade once there is more than one human),
  POD-645 (instance vs machine identity), POD-387 / POD-317 (scoped subscription primitive)
- **Related ADRs:** ADR 1 (ownership matrix — carries the owner/visibility annotations;
  amendment POD-1071), ADR 2 (feed identity and scoping — amendment POD-1072), ADR 3
  (principal from transport, exposure, delivery, apply-time re-authorization — amendment
  POD-1073), ADR 4 + Amendment 1 (shared field schemas: `UserId` brand, ownership field
  group, attribution pair, per-user state shape), ADR 5 (peer roles and auth strategies),
  ADR 6 (replica storage), ADR 7 (planes — presence/rooms amendment POD-1074), ADR 8
  (package placement of the identity brands)
- **Specs:** [spec:SP-15aa] multi-instance isolation; [spec:SP-eb60] curated name vs live
  title (human-set outranks agent-set); [spec:SP-5d81] messaging-app superagent bridge;
  [spec:SP-edbb] approval broker; [spec:SP-3fe2] strangler rebuild / branded ids
- **Base tip verified:** `2ddfec21` (issue/279-integration), 2026-07-29
- **File discipline:** this ADR owns **only** `docs/adr/0009-identity-ownership-sharing.md`.
  It edits no other ADR and does not touch `docs/adr/README.md`; the pack index and the
  ADR 1/2/3/7 amendments are owned by POD-359 and by POD-1071–POD-1074 respectively. Every
  cross-ADR statement here is a **forward reference by ADR and decision number**, never a
  restatement of another ADR's content or numbers.
- **Reconciled by POD-359, 2026-07-29:** at pack reconciliation the integrator added the `see`-set
  boundary to D6/M5 (owner: ADR 3 Amendment 1 D18.5), named D7's enforcement sites, and extended
  §3 to **O5–O6** as the pack's canonical open list. No decision was changed; see the
  reconciliation record in [README.md](README.md).

---

## 1. Context

### 1.1 What changed

`docs/multi-user-readiness.md` records the human decisions of 2026-07-28/29. The product
requirement is **basic multi-user within one tenant**: every object has an owner, objects can
be shared between people, and the architecture must not close the path to realtime
collaboration. The §3.1 fork was decided as **"C's mechanism, B's default"** — build the
visibility machinery in Phase 2 and default to **private** — with per-feature sharing
behaviour deliberately deferred and decided class by class.

Four ADRs were justified *by* the single-operator assumption and are being amended
(POD-1071–POD-1074). None of them says **who a user is**. This ADR is that document: the
principal taxonomy, the meaning of owner / visibility / grants, the visibility classes and
their default-closed rule, how agents are delegated from humans, how machine access is
scoped, and how cross-boundary writes behave. The other ADRs place the fields, the wire
shapes and the enforcement points; they point **here** for what the words mean.

### 1.2 Not multi-tenancy — say it before an implementer guesses

**Multi-user in one tenant lives *inside* one Authority.** **ADR 1 D5 is unaffected by this
ADR.** `InstanceId` remains a **deployment partition** — two instances are two isolated
product universes ([spec:SP-15aa]) — and it is emphatically **not** a row-level
discriminator. Readiness §2 states this explicitly, and the clause in ADR 1 D5 reserving
explicit columns "only if a future shared multi-tenant store is adopted" is **not triggered**
by this requirement.

Nothing in this ADR authorises an `instance_id` column on any aggregate, wire projection,
per-user state row or grant edge. An implementer who reads "multi-user" and reaches for
tenant columns has misread this document. The dimension this ADR adds is **owner**, not
tenant.

### 1.3 What is true today (verified on tip `2ddfec21`, 2026-07-29)

There is no user identity anywhere in the system. Three facts, each read in the code:

1. **One shared password per instance.** `packages/runtime/src/auth-store.ts` stores a single
   `AuthFile = { passwordHash?: string }` and exposes `hasPassword` / `setPassword` /
   `clearPassword` / `verifyPassword` (and a one-shot `applyEnvPassword` seam). Its own header
   calls it the *"single-user client-access password for the human UI channel"*. There are no
   accounts, no per-person credentials, and nothing that distinguishes two humans who both
   know the password.
2. **A client session is a device, not a person.** `client_sessions`
   (`apps/server/src/migrations/schema.ts` L190) is `token_hash` (primary key), `created_at`,
   `expires_at`. **There is no user column** — and, repo-wide, `schema.ts` contains **zero**
   occurrences of `owner` or `visibility` on any of its tables.
3. **The authenticated human is unconstrained.** `packages/domain/src/issue-authz.ts` L47:
   `export const OPERATOR: Capability = { role: 'admin', scope: { kind: 'all' } }`, documented
   as *"the operator … is unconstrained"*. `Capability` is `{ role: IssueRole; scope:
   IssueScope; actorSessionId?: string }` with `IssueRole = 'viewer' | 'worker' | 'admin'` and
   `IssueScope = { kind: 'all' } | { kind: 'none' } | { kind: 'subtree'; rootId }`.

Three further facts shape the decisions below:

- **Reads are scope-free today.** `authorize()` (`packages/domain/src/issue-authz.ts` L66)
  short-circuits with `if (action === 'read') return 'allow'` before any scope test — so even
  a `subtree`-scoped agent may read every issue. Scope gates *mutations of an existing issue*
  only. Private-by-default is therefore a change to the **read** path, which does not exist
  yet, not a tightening of an existing one.
- **`Capability.actorSessionId` is the actor half, and only the actor half.**
  `humanQuestionAskedBy` holds the **asking session id** (used as the delivery address in
  `apps/server/src/modules/issues/registry.ts` L1032–1045 and stamped server-side in
  `service/crud.ts` L591). `SessionMeta.nameSource` is `z.enum(['user','agent'])`
  (`packages/protocol/src/messages/runtime-state.ts` L84) — a **role class**, not a person.
  Nothing anywhere records *which human* is behind a write.
- **There is no `UserId`.** `packages/protocol/src/ids.ts` brands `MachineId`, `SessionId`,
  `IssueId`, `RepoId`, `ConversationId`, `MutationId`; a repo-wide search for `UserId` returns
  nothing.

Consequence, and the reason this ADR is Phase-1 blocking: Phase 1's thesis is that the model
package is the one authoritative definition of every field. Landing Phase 1 with a
single-operator vocabulary bakes the wrong model into the one place the rewrite promises never
to have to redo (readiness §3.2).

### 1.4 What the pack already got right, and this ADR leans on

Recorded so these are not re-litigated: ADR 3 D7 (principal from authenticated transport only;
payload identity inert) is the precondition for any multi-user authz and is already decided.
ADR 3 D8 (apply-time re-authorization on every apply, including outbox replay) is what makes
**live** delegation resolution free — see D5/A1. ADR 3 D2's `--outside-scope` / `overrideScope`
→ `confirm-required` path already models deliberate widening
(`apps/server/src/issue-authz.ts` `checkIssueAccess`). ADR 1 already declares a `system` writer
class. This ADR adds an identity dimension to mechanisms that exist; it invents no second
authorization system.

---

## 2. Decisions

### Decision D1 — Principal taxonomy: four kinds, one derivation rule

**Decision.** A **principal** is the triple **`(user, device, capability)`**. It is derived
from the **authenticated transport only** (ADR 3 D7); no part of it may be read from a command
payload, and forged payload identity stays inert. There are exactly four principal kinds:

| Kind | Who it is | Authenticated by | May do |
|---|---|---|---|
| **human** | A person with an account (`UserId`), on a device (a client session) | Per-user credential on the client-session channel; the account's role decides admin-grade actions | Everything their account role and their owner/grant set allow. The **ceiling** for everything delegated from them |
| **agent-delegated** | A Podium agent session acting for exactly one human: `(agentIdentity, onBehalfOf: UserId, scope)` | Daemon-authenticated relay path; capability minted server-side, bound to the session (today's `Capability.actorSessionId` seam) | Its own scope **intersected with its human's current rights** (D5/A1) |
| **superagent** | *Not a fifth kind* — an agent delegation whose scope is broad: everything its human can see (D8/S1) | Same as agent-delegated | As its human, within that human's current rights |
| **machine** | A paired daemon reporting observations and executing on its host | Machine/pairing token per ADR 5's role auth (`machines.token_hash`; `PairingManager`) | Write its own observation stream; carry commands already authorized for a human or agent principal. **Never** a stand-in for a person |
| **system** | Server-internal jobs: steward, expiry, boot reconcile, derived-field maintenance | In-process; no external channel | Read across owners; write **only as `system`** (D8/S5). Never impersonates a person |

Identity model shape (semantics decided here; *field shape* is ADR 4 Amendment 1 D9, *package
placement* is ADR 8, *matrix rows* are ADR 1's amendment):

1. **`UserId` is a branded model identity**, in the same family as `SessionId` / `IssueId` /
   `MachineId`. A person is never a raw string.
2. **A `User` / account aggregate exists**: identity, display name, credential material
   (server-only, `secret-value` per ADR 1 D6), lifecycle (invite, disable, remove).
3. **Client sessions become per-user.** A client session is still a *device*; it now
   **resolves to a user**. The single-password authenticator is replaced, not supplemented —
   an instance-wide password that maps to no user cannot produce a principal under this ADR.
4. **Account roles: at least `admin` and `member`.** The account role is instance-level and is
   distinct from the per-command `Capability.role` vocabulary ADR 3 D2 owns; the account role
   is what makes an action *admin-grade* (secrets per ADR 1 D6, deployment-substrate `manage`
   per D3, machine `manage` per D6).
5. **`OPERATOR` — role `admin`, scope `all` — is the single-operator vocabulary this ADR
   replaces.** It survives only as a migration artefact: the first account of an upgraded
   instance. Code that constructs an unconstrained capability from "someone authenticated"
   is out of compliance once D1 lands.

**Rationale.** Every attribution and authorization decision in the system currently bottoms
out in "the authenticated human", singular, hard-coded as a constant. Naming four kinds with
one derivation rule is what lets every later decision be stated once: ceilings (D5), machine
verbs (D6), cross-boundary writes (D7) and system reach (D8) are all statements about *which
kind of principal* is acting. Making the superagent a *scope* of the agent kind rather than a
fifth kind is deliberate — it means the delegation rules in D5 apply to it unchanged.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Keep one shared password, add "profiles" chosen client-side | The choice would be payload identity, which ADR 3 D7 declares inert. Two people sharing one credential cannot be told apart by any server-side check, so ownership would be unenforceable and attribution would be a lie. |
| Agents as a *role* on the human principal rather than their own kind | Loses the actor/on-behalf-of pair (D5/A3) that the product already depends on: human-set `name` outranks agent-set ([spec:SP-eb60]), and "did a person or an agent ask this?" must stay answerable via `humanQuestionAskedBy`. |
| A separate identity system for agents (own accounts, own credentials) | A second identity lifecycle to keep in sync, with its own revocation path to forget. D5/A5 reuses `SessionBinding` (POD-323) instead, so delegation is born and retired with the binding. |
| Machine as a person-equivalent principal ("the machine may act as its owner") | A daemon token would become a credential for a human's whole account. The machine principal reports observations and executes already-authorized work; it must not be able to originate writes as a person. |
| Model users as a variant of `Capability` | `Capability` is an authorization *decision input*, and `OPERATOR` is a constant. Identity needs its own aggregate; ADR 4 Amendment 1 D9 rejects the same conflation from the representation side. |

---

### Decision D2 — Owner, visibility and grants are first-class and normative

**Decision.** Every **non-substrate** replicated aggregate carries three normative
annotations:

| Annotation | Meaning (decided here) |
|---|---|
| **`owner`** | Exactly one `UserId`. The owner is the principal whose personal surfaces the entity appears on by default, and the default holder of every grantable verb on it. Ownership is transferable by an explicit command; it is never implicit. |
| **`visibility`** | One of the five classes in D3. It answers *who may see this at all*, before any grant is consulted. |
| **`grants`** | An edge table `(entityRef, granteeUserId, verb)`. A grant **widens** what a grantee may do; it can never widen past the granter's own rights, and it never widens past the entity's visibility class rules. Revocation is immediate and takes effect at the next apply (ADR 3 D8). |

Rules that hold across all classes:

1. **These are annotations on ADR 1's matrix, not per-feature columns.** The matrix column set
   and the per-aggregate values are owned by the **ADR 1 amendment (POD-1071)**; the field
   *shape* — one shared ownership field group, composed, never re-declared per entity — is
   owned by **ADR 4 Amendment 1 D9**. ADR 9 owns only what the words mean and the rules below.
2. **Authorization is `visibility` first, then `owner`, then `grants`, then role.** A
   principal that fails the visibility test never reaches the grant test; this ordering is
   what makes "unclassified ⇒ private" (D4) safe.
3. **Sharing is an explicit act with its own commands** (`share` / `unshare`, Phase 3 /
   POD-290 policy), never a side effect of another operation.
4. **A grant is not a copy of rights.** It is evaluated live against the granter's current
   rights, for the same reason D5/A1 gives for delegation: a frozen grant survives the
   revocation of the person who issued it.
5. **Visibility changes are not entity changes.** Granting or revoking makes entities appear
   or disappear for a principal without the entity's revision moving. The feed mechanism that
   expresses this (watermarks, rescope, an `evict` distinct from `remove`) is **ADR 2's
   amendment (POD-1072)**; this ADR only states that a visibility change is a first-class
   event that the sync layer must be able to express.
6. **Ownership is orthogonal to home authority.** ADR 1 D1 is unchanged: the Authority is
   still the sole arbitrator, and `owner` is a fact *about a row*, not a second writer.

**Rationale.** The rewrite's charter is that ownership questions have exactly one answer in
exactly one place. Adding a person dimension feature-by-feature reproduces the defect the pack
exists to delete — except the drifting field would be a security-relevant one, and a forgotten
one would fail **open**.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Option A from readiness §3.1 — tenant is the read boundary; ownership governs writes and UI defaults only | Rejected by the human decision of 2026-07-29. Personal-by-default is a **product goal**: the sidebar is "my tasks". Option A also leaves the feed unscoped, which means the scoping machinery would arrive after the POD-308 wire cutover — a second protocol migration in a programme that exists because of half-finished migrations. |
| Owner as a nullable column added per feature when that feature needs sharing | Five keying conventions and five migrations; the first feature to forget it silently reintroduces the tenant-visible default. Fails open, which D4 forbids. |
| ACL lists per entity with arbitrary verb sets | Unbounded policy surface with no totality test. The verb sets here are closed and small (D3, D6), which is what makes conformance testing possible. |
| Groups / teams as a first-class grantee kind now | Deferred, not rejected: the grant edge names a `UserId` today. A group grantee is an additive change to the grantee column; building group management before a single share exists is speculative scope. |

---

### Decision D3 — Five visibility classes

**Decision.** Every entity class is declared as exactly one of these five (readiness §3.1.1):

| Class | Default visibility | Membership (indicative — per-class declaration is deferred) |
|---|---|---|
| **personal** | Private to owner; **shareable** by explicit grant | Sessions, issues + comments + tracker mail, drafts, conversations, handoff bundles, artifacts, superagent threads |
| **per-user state** | **Never shared**; one row per user, keyed `(userId, entityId)` | `readAt`, snooze, pins, tab order, sidebar/tab layout, personal preferences |
| **owned compute** | Private to owner; **grantable per verb** (D6) | Machines, and everything that is a per-machine fact: repos/prefixes, worktrees, harness + model inventory, host metrics |
| **deployment substrate** | **Tenant-visible**; `manage` is admin-grade | Advisory locks, instance settings, feature flags, machine **existence** for admins |
| **secrets** | Server-only, **never replicated** — ADR 1 D6 unchanged | API keys, pairing token preimages, managed credential blobs, client auth token preimages |

Binding rules:

1. **The tenant-visible floor is deliberately small.** "Everything private" taken literally
   breaks the product on day one — advisory locks are coordination names everyone must resolve
   identically, and instance settings and feature flags are properties of the deployment, not
   of a person. Those are **substrate**, not objects with an owner. The *principle* is settled
   here; *which classes are in the set* is per-feature and stays deferred.
2. **Machines are NOT substrate.** This corrects an earlier draft of readiness §3.1.1 by
   explicit human direction (2026-07-29). A machine is owned compute (D6); only its
   **existence**, for admins, is substrate.
3. **Facts about a machine inherit the machine's scoping.** Repos and prefixes, worktrees,
   harness and model inventory, and host metrics do not carry their own visibility — they are
   visible to whoever can `see` the machine. This is what keeps the tenant-visible floor small
   without annotating a long tail of per-machine tables.
4. **`per-user state` is never grantable.** Its rows are not shared, un-shared, or made visible
   by any grant; keying by `(userId, entityId)` makes the writes single-writer by construction.
   The *conflict-rule* consequence (this shrinks ADR 1 D3's field-LWW inventory toward empty)
   is **ADR 1's amendment**; the *shape* is **ADR 4 Amendment 1 D10**.
5. **`secrets` is unchanged by multi-user in its mechanics and changed in its governance.**
   Values still never replicate and never enter the outbox (ADR 1 D6, ADR 3 D4). What is new
   is that secret management becomes **admin-grade** once there is more than one human.

**Rationale.** Five classes, not a free-form policy language, because every class has a
different *kind* of consequence: personal is a privacy boundary, owned compute is a
code-execution boundary (D6/M2), per-user state is a conflict-avoidance shape, substrate is a
coordination requirement, and secrets is a replication prohibition. Collapsing any two of them
makes one of those consequences unstatable.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Two classes (private / shared) | Cannot express "everyone sees the lock name but only the owner may run code on that Mac", and cannot express per-user state at all — the readAt/pins/snooze family would land as either shared singletons (today's bug) or ad-hoc per-feature keys. |
| Put machines in the tenant-visible substrate set (the earlier draft) | Overturned by human direction 2026-07-29. It conflates `see` with `use`, and `use` means arbitrary code execution on someone's hardware with their credentials (D6/M2). |
| A generic per-entity visibility expression (predicate language) | Unauditable and untestable for totality; scoped-feed evaluation would have to run arbitrary predicates per principal on the fan-out path, which ADR 4 D7.2 forbids. |
| Declare visibility per *field* rather than per entity class | Multiplies the totality obligation by the field count and makes a scoped feed per-field, not per-row. Field-level exposure is already covered by ADR 3 D5 redaction and ADR 1's secret class. |

---

### Decision D4 — Default-closed, with a totality test

**Decision.** **An entity class with no declared visibility class is `personal` / private to
its owner.** It is never tenant-visible, never substrate, and never readable by a principal
that is not its owner. Forgetting to classify **must fail toward privacy**.

Enforcement:

1. **The declaration lands on ADR 1's amended matrix** (owned by POD-1071), as a normative
   column alongside home authority, writers and conflict rule.
2. **A totality test of the same shape as POD-304's existing per-field annotation obligation**
   makes an unclassified entity class a **build/test failure**, not a runtime default. The
   default-closed rule above is the *semantic* backstop for anything that slips past the test —
   not a substitute for it.
3. **This mirrors ADR 3 D3's default-closed exposure rule** (empty `exposure` ⇒ served
   nowhere), deliberately: the pack already has one default-closed totality mechanism that
   implementers have to satisfy, and this is the same discipline applied to visibility instead
   of transport.
4. **Widening is always explicit.** Nothing is promoted out of `personal` by inference,
   convenience, or "it was visible before the migration".

**Rationale.** Readiness §3.1.1 makes the deferral of *membership* safe only if the failure
mode of forgetting is privacy. A default that fails open is a privacy incident waiting for the
first new entity class; a default that fails closed is, at worst, a bug report that something
is not visible — recoverable, loud, and cheap.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Default tenant-visible ("it's one team, be permissive") | Every forgotten annotation becomes a leak, discovered by the person who should not have seen the row. Also contradicts the product goal: the sidebar is "my tasks", and an unclassified class defaulting to tenant-visible pollutes it. |
| No totality test; rely on review | The pack's own history says otherwise — POD-304 exists because implicit ownership knowledge scattered into store methods. A rule with no mechanical gate is a comment. |
| Runtime default only (no compile/test gate) | The failure would be silent and late. ADR 3 D3 already established that default-closed is worth a totality check at the registry; visibility deserves the same. |

---

### Decision D5 — Agent delegation: live intersection, human ceiling, attribution pair

**Decision** (readiness §3.1.3, A1–A5, adopted normatively).

**A1 — Delegated, evaluated live; never a copied snapshot.** An agent principal is
`(agentIdentity, onBehalfOf: UserId, scope)`. Its **effective rights are its own scope
intersected with its human's *current* rights**, resolved **at every apply** — not a capability
frozen at spawn.

> *Why not a snapshot:* a snapshot means revoking a person leaves their unattended agents
> running with rights the human no longer holds — a privilege leak with **no cleanup trigger**,
> in a system where agents run for hours without supervision. Live resolution makes "revoke the
> human" transitively disable their agents with **no reaper to write and none to forget**.
>
> *Cost: none.* ADR 3 D8 already re-authorizes on every apply, including outbox replay. It
> resolves a delegation chain instead of reading a stored capability. This is the case D8 was
> over-engineered for under single-user, arriving.

**A2 — The human is a ceiling, not the default grant.** An agent may never exceed its
delegator, but its **default scope is what it was spawned for** — its session, its issue, that
issue's subtree — not everything its human can see. Widening is **explicit** and goes through
the existing `--outside-scope` / `overrideScope` → `confirm-required` path (ADR 3 D2
confirmation rules); `IssueScope.subtree` is already reserved and already enforced by
`authorize()`.

**A3 — Attribution is a pair, not a substitution.** Every write records **actor** (which agent)
**and** **on-behalf-of** (which human). Both are stamped from the transport principal (ADR 3
D7), never from payload. Collapsing them loses distinctions the product already ships:
human-set `name` outranks agent-set (`nameSource`, [spec:SP-eb60]) and `humanQuestionAskedBy`
is server-authoritative precisely so "did a person or an agent ask this?" stays answerable.
`Capability.actorSessionId` is the existing seam for the actor half; **the on-behalf-of half is
new**. The field shapes are ADR 4 Amendment 1 D9.3.

**A4 — Agent output is owned by the delegating human.** For entities an agent creates:
`owner = onBehalfOf`, `actor = the agent`. Otherwise the personal sidebar — the stated product
goal of the private default — would not show work your own agent did for you, and retiring an
agent session would orphan its issues.

**A5 — The delegation lifecycle *is* `SessionBinding` (POD-323, Phase 5).** The agent principal
is born and retired with its binding rather than in a parallel identity system. Delegation then
survives handoff between machines for free, and Phase 5's binding work absorbs it instead of
inventing a second lifecycle with its own aliases and history.

**Chaining.** Sub-agents delegate **from their parent agent** by the same rule: never widening,
with **exactly one human at the root of the chain**. The effective-rights intersection is
evaluated over the **whole chain** at every apply — a sub-agent cannot reach past its parent,
and disabling the root human disables the entire tree in one step.

**Rationale.** Delegation is the only part of this ADR that governs *unattended* processes, so
it is the part where a stale authorization is most dangerous and least likely to be noticed.
Every clause above chooses the option with **no cleanup step** — live intersection instead of
snapshot expiry, binding lifecycle instead of a parallel identity table, human ownership
instead of agent ownership that would need re-homing on retirement.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Capability snapshot minted at spawn (a bearer capability) | Unattended agents outlive the decision that authorized them. Revoking a person would require finding and killing their agents — a reaper that will be written wrong or not at all. The failure is silent: the agent keeps working. |
| Agent inherits its human's full scope by default | Least privilege matters *more* for unattended processes, not less. It is also not today's instinct: relayed agents already carry a constrained `Capability` while `OPERATOR` is `admin`/`all`. |
| Attribution collapsed to a single "actor" id | Destroys the human-vs-agent distinction the product already depends on ([spec:SP-eb60] naming doctrine, `humanQuestionAskedBy`). A nullable second meaning on one field is exactly the drift the representation policy rejects. |
| Agent owns what it creates | Retiring an agent session orphans its issues, and your own agent's work would not appear on your sidebar — defeating the private-by-default product goal that motivated the whole decision. |
| A separate agent-identity registry with its own lifecycle | A second set of aliases, history and revocation paths to keep consistent with `SessionBinding`. POD-323 is already designing the hard part (one-to-many alias history, crash recovery); delegation rides it. |
| Sub-agents delegate directly from the root human | Would let a sub-agent exceed its parent, making the chain non-monotonic and the intersection meaningless. |

---

### Decision D6 — Machines are owned compute: `see` / `use` / `manage`

**Decision** (readiness §3.1.4, M1–M6, adopted normatively).

**M1 — Three verbs, not one visibility bit.**

| Verb | Grants | Default holder |
|---|---|---|
| **see** | The machine exists; health/liveness; "your session ran there" attribution | Owner + admins (fleet management) |
| **use** | Spawn, reattach, attach a PTY, execute harness commands, read/write files, take a worktree | **Owner only, until explicitly granted** |
| **manage** | Rename, unpair, rotate pairing token, remove from fleet | Owner + admins |

ADR 3 D2 already carries the vocabulary — actions `read` / `write` / `manage`, with `machine`
as a declared resource scope kind. What is missing is an **owner and a per-machine grant list**,
rather than the verb being gated by instance-wide role alone. Verified today: `machines`
(`apps/server/src/migrations/schema.ts` L147) is `id`, `name`, `hostname`, `token_hash`,
`created_at`, `last_seen_at`, `inventory_json` — **no owner, no pairer, no grant list**.

**M2 — `use` is a code-execution boundary, not a privacy boundary.** This is why it cannot be
folded into ordinary object visibility. Running an agent on someone's machine means **arbitrary
execution on their hardware with their local environment**: SSH keys, `gh`/git identity,
dotfiles, cloud CLI sessions, and whatever private repositories are checked out there. The
blast radius is a different *kind* from "can read my issue", and the model must not make them
look like the same toggle.

*Recorded honestly, not solved here:* even with `use` granted, the **local** credentials remain
the machine owner's — they are not separable from the host. Server-injected material (managed
`accounts` credentials, API quota) **is** separable, and should plausibly bill the delegating
human rather than the machine owner; that is a per-feature call. Granting `use` is inherently a
high-trust act and must read as one in the UI, not as a checkbox.

**M3 — A newly paired machine is private to its pairer.** Pairing runs from that person's
laptop with their join code, so **they are the owner**, and pairing must record who paired it.
Existing machines need a one-time ownership migration at the cutover. This is the D4
default-closed rule applied consistently, not an exception to it.

**M4 — The all-in-one case is the sharpest one.** When the server runs on someone's Mac, the
`local` daemon (`LOCAL_MACHINE_ID = 'local'` and `readOrCreateDaemonSecret` in
`packages/runtime/src/local-machine.ts`) **is** that Mac. Without M1, anyone who can
authenticate to the server inherits execute on the machine hosting it. That must **fail
closed**: the host machine is owned by whoever set the instance up, and is **not ambient team
compute**.

**M5 — Placement and handoff fail closed.** Spawn UI must not offer machines the principal
lacks `use` on; session handoff (POD-323 / POD-644) to such a machine is **denied, not silently
retargeted**; and **unreachable must be distinguishable from unauthorized**, since "denied" and
"offline" otherwise produce the same empty list and the same support ticket.

> *Boundary of the distinction (POD-359 reconciliation, 2026-07-29).* The distinction holds
> **inside the principal's `see` set only**, where existence is already disclosed and therefore
> nothing leaks. A machine the principal cannot `see` is **absent**, and any reference to it
> fails identically to a nonexistent machine id — D7 clause 2's consistent-error rule. **ADR 3
> Amendment 1 D18.5 owns that boundary** and states it as a refinement of this clause; read the
> two together. Without the boundary, M5 and D7 clause 2 would contradict each other.

**M6 — Agents inherit this for free.** Under D5/A1–A2 an agent's rights are its human's current
rights intersected with its scope, so an agent can only spawn on machines its human may `use`,
and a sub-agent cannot reach past its parent. The compute boundary therefore holds for
unattended processes **with no additional mechanism** — which is the main reason to express
machine access as grants on the same principal model rather than as a separate fleet ACL.

**Rationale.** The human direction was concrete: *"a personal mac shouldn't be accessible for
everyone in the team to run agents."* One visibility bit cannot express that, because the
useful default is "you can see that my Mac exists and that my session ran there" while
execution stays mine. Three verbs is the smallest vocabulary that says it.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Machines are tenant-visible infrastructure (the earlier §3.1.1 draft) | Conflates `see` with `use`. It makes every paired laptop ambient team compute, which is the exact scenario the human direction ruled out. |
| One `visibility` bit on the machine | Cannot express see-but-not-use, which is the common case (fleet health for admins, execution for the owner). Would force admins to choose between blind fleet management and universal execute. |
| A separate fleet ACL subsystem | Then M6 stops being free: agents would need their machine rights resolved through a second system, and the delegation chain would have to be re-implemented there. |
| Gate `use` by instance-wide role only (admin may use everything) | Makes "admin" mean "may execute code on every teammate's laptop with their SSH keys". Administration of the fleet and execution on a host are different powers. |
| Solve the local-credential problem in the model (e.g. per-user credential isolation on the host) | Not solvable at this layer: local credentials belong to the host OS account. Recording it as a product-copy obligation is honest; pretending the model fixes it would be worse than the gap. |

---

### Decision D7 — Cross-boundary writes: ratify what is already right; add two clauses

**Decision.** The shipped mail authorization shape is **correct and is ratified, not
redesigned** (readiness §3.1.5). Verified in `apps/server/src/modules/issues/registry.ts` on
tip `2ddfec21`:

| Command | Authz shape today | Reading |
|---|---|---|
| `mailSend` (L1128–1146) | `action: 'write'`, **no `target`**, with the comment *"DELIBERATELY NOT scope-gated … addressing ANOTHER issue is the whole point of it — cross-issue sends must not require --outside-scope. Treated like `create` … so the role gate still applies."* | **Send-without-read.** Already the right primitive |
| `mailInbox` (L1149–1163) | `action: 'read'`; marks unread only when `ctx.caller.capability.scope.kind === 'subtree'` **and** the resolved issue **is** the scope root | You consume only your **own** mailbox |
| `mailClaim` (L1170–1187) | `action: 'write'`, `scope: 'issue'`, target unresolvable from input, so the shared `checkIssueAccess` runs **in-handler** against the message's issue | Acting on a message is subtree-gated |

Multi-user adds **exactly two clauses**:

1. **The unscoped send is bounded by the human ceiling, not the agent's scope.** An agent may
   mail any issue **its delegating human can see**, including outside its own subtree; it may
   **not** mail an issue that human cannot see. This preserves today's coordination behaviour
   *exactly* in the single-user case (one human, everything visible) while preventing injection
   into a colleague's private workspace.
2. **Consistent-error rule.** Mailing an issue that is **invisible** to the principal must fail
   **identically** to mailing a **nonexistent** id — same code, same message, same timing
   class. Divergent errors turn the send path into an **existence oracle**. Today's
   `checkIssueAccess` (`apps/server/src/issue-authz.ts`) already has this instinct for the
   scope gate — `if (!targetId || !issues.get(targetId)) return` collapses "unknown target" and
   "no target" into the role gate alone — and the rule generalises it to visibility.

Two consequences that need **no new mechanism**, recorded so nobody builds one:

- **Dependency / graph edges** (`discovered-from` and friends) **do** carry a scope target, so
  they already route through `overrideScope` → `confirm-required` (ADR 3 D2). The
  cross-boundary case is the *display* question, which stays open (§3, O2).
- **Event subscriptions** already follow the `mailSend` pattern — `write` with no existing-issue
  target, with own-row and source-within-subtree checks in the handler (registry.ts L1195–1200
  comment). Unchanged.

**Where the two clauses are enforced (POD-359 reconciliation, 2026-07-29).** This ADR owns the
*policy*. Its expression in the command vocabulary — the contract-level obligation, the
generalisation of the consistent-error rule to every caller-supplied target id, and its
composition with ADR 3 D5 redaction — is **ADR 3 Amendment 1 D20**, which cites this decision as
its policy source. The same rule at the presence-room subscribe site is **ADR 7 Amendment 1
D14.3**. Neither restates the policy; neither may diverge from it.

**Rationale.** The codebase already implemented the send-without-read distinction deliberately,
with the reasoning written down at the call site. Multi-user does not invalidate it; it only
supplies the missing bound (the human ceiling) and closes the side channel that a
visibility-aware error message would open.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Scope-gate `mailSend` to the agent's subtree | Breaks the primitive: cross-issue coordination *is* what mail is for. Every legitimate send would need `--outside-scope`, training users to pass it reflexively — which destroys the confirmation signal ADR 3 D2 relies on. |
| Bound the send by the **agent's** scope rather than the human's | Would change today's single-user behaviour (one human, everything visible) for no privacy gain: the agent's human can already see the target. |
| Distinct errors for "not visible" vs "does not exist" (better UX) | Makes the send path an existence oracle: a probe loop enumerates a colleague's private issue ids. This is readiness §3.1.2's existence-leak class arriving at a concrete site, and it is the one instance of it that is already decided. |
| Deliver but silently drop invisible sends | Silent success is worse than a consistent error: the sender believes they coordinated. It also still leaks, via timing and via the absence of a reply. |

---

### Decision D8 — Superagent is per-user; system automations are not delegated at all

**Decision** (readiness §3.1.6, S1–S6, adopted normatively).

**S1 — The superagent is a broad-scope delegation.** It is "you, automated": a principal
delegated from its human, with scope = **everything that human can see**, rather than D5/A2's
narrow issue-subtree default. **Ceiling and scope coincide.** A2's narrow default is for agents
spawned *for a task*; the superagent is spawned *for a person*, and the two justifiably differ.
It is **not** a fifth principal kind (D1).

**S2 — Superagent state joins the `personal` set.** `superagent_threads`,
`superagent_messages`, `superagent_queued_inputs` and `superagent_pending_turns`
(`apps/server/src/migrations/schema.ts` L119/L130/L446/L456) carry **no owner today**. Per-user
means owner + private by default: **my threads never surface in your sidebar** — the same
property that motivated the private default in the first place.

**S3 — Attention routing becomes per-user by construction.** Needs-human questions, approvals
and notifications reach **their** human. This is a *consequence* of S1/S2, not additional
work — but it is work that would otherwise have had to be built deliberately.

**S4 — Telegram splits along the line ADR 1 §6 already drew, and gains an authentication
problem.** `notifications.telegramBotToken` stays `secret-value`, server-only, admin-managed.
`telegramChatId` — today a single `z.string().default('')` in `PodiumSettings`
(`packages/runtime/src/settings.ts` L274) — is **routing config**, already classified as
preference-not-secret, and **moves to per-user**.

The **non-obvious consequence, stated here because it is easy to skip**: per-user superagent
makes the Telegram edge an **authentication surface**. Today the inbound direction is
effectively *"whoever holds the bot is the operator"* — one chat id, one implied identity. With
several people, an arriving message must resolve to a **user** *before anything acts on it*.
Under ADR 3 D7 (principal from authenticated transport only) that requires a **real binding
ceremony**: a claim code issued in the web UI and presented to the bot, the same shape as
machine pairing ([spec:SP-5d81] adapter; `PairingManager` in `apps/server/src/hub/pairing.ts`
is the precedent). **Unknown chats must fail closed** — never fall back to an operator
identity. The work is small; the risk is that the feature already "works" single-user and the
gap is invisible until the second person arrives.

**S5 — System automations are NOT delegated, and must not be.** The steward, expiry jobs, boot
reconcile and derived-field maintenance have no human behind them and must not be given one.
ADR 1 already declares a `system` writer class for exactly this. The rule that makes it safe
under private-by-default:

> **System principals may read across owners, but every write is attributed as `system` and
> lands in the scope of whatever it acted on. They never widen anyone's visibility and never
> act *as* a person.**

This is what keeps the "instance-wide agent" worry from reopening: the things that genuinely
need instance-wide reach are **system jobs**, and system jobs do not need — and must not
have — a human identity.

**S6 — Scheduled automations are delegated like the superagent.** They have a creator, so they
run **as that person, with that person's current rights**. They inherit D5/A1's live evaluation
for free: revoke someone's access and their cron agents stop, with no reaper to write and none
to forget.

**Rationale.** "Instance-wide agent" was one bucket holding two things with opposite answers.
Splitting it by *whether there is a human behind it* resolves both: things with a person become
broad delegations that inherit revocation; things without a person become `system`, which is
read-wide and write-narrow and can never impersonate.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| One shared instance superagent | Its thread history is a mixed record of everyone's private work, and its notifications have no correct destination. S3's routing would have to be invented from scratch, badly. |
| Give system jobs a service *user* account | A service account is a person-shaped principal with no person behind it: it accumulates grants, it can be impersonated, and its writes look like someone's. `system` writes are attributable *as system*, which is what an audit actually needs. |
| Let system jobs write into any scope they choose | Would let a derived-field job widen visibility as a side effect. Landing in the scope of whatever it acted on keeps visibility monotone under system maintenance. |
| Keep `telegramChatId` instance-wide and route by content | Content-based routing is payload identity, inert under ADR 3 D7. It would also mean any person's message could act as any other person. |
| Fall back to the operator identity for unknown chats (today's behaviour, kept) | Turns knowledge of the bot handle into an unauthenticated write path against the whole instance. This is the one place where the single-user shortcut becomes a genuine vulnerability rather than a limitation. |
| Scheduled automations as `system` | They have a creator and act with that creator's reach; attributing them to `system` would hide who caused a write and would survive that person's revocation. |

---

## 3. Deliberately open — recorded, not answered

These are open in `docs/multi-user-readiness.md` and are **not** decided here. Inventing an
answer would pre-empt a human policy call or a per-feature decision.

> **This table is the pack's canonical open list (POD-359 reconciliation, 2026-07-29).** The five
> multi-user amendments (ADR 1, 2, 3, 4, 7) each record the subset that raises a question for
> them, **using these numbers**. A number means the same question in every document; a document
> that omits a row is asserting that the question raises nothing for it, never that it is closed.
> O1–O4 come from `docs/multi-user-readiness.md`; **O5** is recorded there too (§3.1.4,
> "Unresolved") and was surfaced as an open item by ADR 3 Amendment 1; **O6** is not a readiness
> question at all but a pack sequencing consequence surfaced by ADR 7 Amendment 1 D13, kept in
> this table so the pack has one place to look.

| # | Open question | Governing section | Who decides | When |
|---|---|---|---|---|
| **O1** | **Which existence facts leak.** Counts, machine session lists, "this worktree is in use", lock holders, issue ref-letter allocation all reveal that *something* exists. Decide **per surface** whether existence is private or only content is. | readiness §3.1.2 | Feature owner per surface, against D3's classes; human where a surface is contentious | Phase 3 policy (POD-290). The one instance already fixed is D7's consistent-error rule for mail |
| **O2** | **Cross-boundary graph edge display.** Hide the edge, or show it as an opaque reference ("blocked by an issue you don't have access to"). The second is usually right — hiding the edge makes the tracker **lie** about why something is blocked — but it leaks existence, so it is a policy call. | readiness §3.1.2 | Human + tracker feature owner | Phase 3 policy (POD-290), before any issue-graph wire change |
| **O3** | **`reparent` as a permission-affecting operation.** A subtree scope is by definition a moving set, so reparenting an issue under an epic **widens a working agent's visibility with nobody having decided it**. Probably acceptable; at minimum it must be surfaced, at most it warrants confirmation when the move crosses an owner boundary. It does not currently read that way to its users. | readiness §3.1.5 case 2 | Human, on the tracker's behaviour | Phase 3 (POD-290); surfaced in UI at the latest |
| **O4** | **Owner/grant inheritance on create, per class.** A session spawned under an issue, a comment on an issue, an artifact on a session: does it inherit the **parent's** owner and grants, or the **actor's**? Inheriting the parent is almost certainly right (otherwise sharing an issue does not share its work) — but it **must be declared per class**, not assumed. D5/A4 fixes only the agent case (owner = the delegating human). | readiness §3.1.2, §3.1.3 A4 | ADR 1 amendment for the annotation; per-class feature owner for the value | Annotation shape at Phase 1 (POD-304); values declared as classes land |
| **O5** | **Local credentials on a machine with `use` granted are not separable from the host** (D6/M2). Server-injected material (managed `accounts` credentials, API quota) **is** separable and should plausibly bill the delegating human rather than the machine owner. Readiness leans to solving this in **product copy, not in the model**; D6/M2 records the gap rather than closing it, and this row keeps it visible instead of buried in a decision body. **Must not be modelled speculatively.** | readiness §3.1.4 ("Unresolved and worth surfacing in product copy") | Human + product; feature owner for `accounts` | Phase 3 at the earliest |
| **O6** | **Phase ordering of the one subscription primitive.** The scoped feed (Phase 2, POD-1077, hard-gated before POD-308) consumes the routing/subscription mechanism whose owners ship in Phase 4 (POD-387 port interface, POD-317 gateway, POD-1078 rooms). Either POD-387's interface is pulled forward, or POD-1077 ships a routing path POD-317 later replaces — a second mechanism with extra steps. Not a design question; a scheduling one. | ADR 7 Amendment 1 D13 (surfaced there, not in readiness) | POD-359 (pack + phase plan) with POD-387 | **Before POD-1077 starts** |

Two further things are **deferred but unblocked**, and are named so they are not mistaken for
gaps in this ADR: **per-feature sharing behaviour** ("how does sharing actually work for issues
/ sessions / workflows") is deliberately decided feature by feature (readiness header
decision); and **group/team grantees** are an additive change to the grantee column of D2's
grant edge, not a change to any rule here.

---

## 4. Consequences

### Positive

- One answer to "who is this?" and "who may see this?", in one document, for implementers and
  audits — replacing a constant (`OPERATOR`) that answered both questions with "everyone".
- Private-by-default is a **product** win, not only a permissions concession: the sidebar
  becomes "my tasks", which is what makes Podium usable for organising your own work.
- Revocation is **transitive and mechanical**: disabling a human stops their agents, their
  superagent and their scheduled automations, with no reaper, because ADR 3 D8 already
  re-authorizes at every apply (D5/A1, D8/S6).
- The compute boundary (D6) holds for unattended processes with **no new mechanism** — agents
  inherit machine grants through the same intersection.
- The cross-boundary mail primitive is **preserved exactly** in the single-user case (D7); no
  existing coordination behaviour changes for a solo user.
- Default-closed + a totality test (D4) makes the per-feature deferral safe: forgetting to
  classify is a build failure, and if it ever slips through, it fails toward privacy.
- Attribution finally names a person, which is what the product's existing rules
  (human-outranks-agent naming, "did a person ask this?") were always implicitly about.

### Negative / cost

- **A user/account subsystem is new Phase-1 work**: `UserId`, the `User` aggregate, per-user
  client sessions, invite/role management, and a migration from one shared password to
  accounts. There is no version of this requirement that is cheap.
- **Every non-substrate aggregate gains an authz dimension**, and every entity class must be
  classified (D3/D4). The totality test makes this unavoidable by design.
- **Machines need an owner and a grant list**, plus a one-time ownership migration for already-
  paired machines (D6/M3), plus fail-closed handling in spawn/placement/handoff UI (M5).
- **Telegram inbound needs a binding ceremony** before it can be multi-user (D8/S4) — small
  work that is easy to skip because the feature already appears to work.
- **`use` is a high-trust act with a residual gap** the model does not close: local credentials
  on a host are not separable from that host (D6/M2). This must be carried in product copy.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Someone reads "multi-user" and adds `instance_id` columns | §1.2 and the D-list say ADR 1 D5 is unaffected; the added dimension is `owner`. Reviewers should reject `instance_id` on any aggregate under this ADR. |
| A new entity class ships unclassified and defaults tenant-visible | D4: default-closed *and* a totality test on ADR 1's matrix (POD-304 shape). Both, not either. |
| Delegation implemented as a spawn-time capability snapshot "for performance" | D5/A1 is normative and the cost argument is recorded: ADR 3 D8 already re-authorizes at apply, so live resolution is not new work. Conformance must include "revoke the human while their agent has queued writes". |
| `use` shipped as a checkbox next to "can read my issues" | D6/M2 names it a code-execution boundary; M5 requires fail-closed placement. UI review obligation, not only a model rule. |
| The all-in-one host becomes ambient team compute | D6/M4: the `local` machine has an owner like any other, set at instance setup. |
| Error messages re-introduce an existence oracle | D7 clause 2 is normative and testable: invisible and nonexistent must be indistinguishable. Worth a conformance case per surface as O1 is answered. |
| Grants frozen at issue time survive the granter's revocation | D2 rule 4: grants evaluate live, same reasoning as D5/A1. |
| Sharing UX is designed before the classes are declared | The classes (D3) and the default (D4) are settled; per-feature behaviour is deferred *deliberately* and must reference this ADR's classes rather than inventing parallel ones. |

---

## 5. Compliance checklist

**In compliance** when:

- [ ] No code path constructs an unconstrained capability from "someone authenticated";
      `OPERATOR` exists only as the migrated first account (D1.5).
- [ ] Every principal is derived from the authenticated transport; no payload field can name a
      user, an agent or an on-behalf-of (D1, ADR 3 D7).
- [ ] Every non-substrate aggregate declares `owner`, `visibility` and its grant rules on
      ADR 1's amended matrix (D2), and the totality test fails the build when one is missing
      (D4).
- [ ] Every entity class is one of the five visibility classes; unclassified resolves to
      `personal`/private, never tenant-visible (D3, D4).
- [ ] Per-user state is keyed `(userId, entityId)` and is never grantable (D3.4).
- [ ] Agent rights are computed as `scope ∩ human's current rights` **at apply time**, over the
      whole delegation chain; no stored "allow" bit (D5/A1).
- [ ] Every write carries the actor / on-behalf-of **pair**, both stamped server-side (D5/A3).
- [ ] Entities created by an agent are owned by its `onBehalfOf` human (D5/A4).
- [ ] Machine access is expressed as `see` / `use` / `manage` with an owner and a per-machine
      grant list; `use` defaults to owner-only, including for the `local` machine (D6).
- [ ] Spawn/placement/handoff deny rather than retarget, and distinguish unauthorized from
      unreachable **within the principal's `see` set**; outside it a machine is absent and fails
      like a nonexistent id (D6/M5 + ADR 3 Amendment 1 D18.5).
- [ ] `mailSend` stays un-scope-gated and is bounded by the human ceiling; invisible and
      nonexistent targets fail identically (D7).
- [ ] Superagent state carries an owner and is private by default; `telegramChatId` is
      per-user; inbound Telegram resolves to a user via a binding ceremony and fails closed for
      unknown chats (D8/S2, S4).
- [ ] System jobs write only as `system`, into the scope of what they acted on, and never widen
      visibility (D8/S5); scheduled automations run as their creator (D8/S6).
- [ ] Nothing in the implementation adds an `instance_id` column (§1.2; ADR 1 D5 unaffected).

**Out of compliance** when: an entity class ships without a visibility class; an agent runs on a
snapshot capability; a single instance-wide password or chat id maps to a principal; a machine
is executable by anyone who can authenticate; an error distinguishes "invisible" from
"nonexistent"; or a system job writes as a person.

---

## 6. Self-verification record

Every factual claim in §1 and in the decision bodies, checked against tip `2ddfec21`
(issue/279-integration), 2026-07-29:

| Claim | Verified at |
|---|---|
| One instance-wide password; no accounts | `packages/runtime/src/auth-store.ts` — `AuthFile = { passwordHash?: string }`, `hasPassword` / `setPassword` / `clearPassword` / `verifyPassword` / `applyEnvPassword`; header comment "single-user client-access password" |
| `client_sessions` has **no** user column | `apps/server/src/migrations/schema.ts` L190 `clientSessions` — `token_hash` (PK), `created_at`, `expires_at` |
| No `owner` / `visibility` column anywhere in the server schema | `grep -c 'owner\|visibility' apps/server/src/migrations/schema.ts` → `0` |
| `OPERATOR` is role `admin`, scope `all`, documented as unconstrained | `packages/domain/src/issue-authz.ts` L47 + module header |
| `Capability` = `{ role, scope, actorSessionId? }`; `IssueRole` = viewer/worker/admin; `IssueScope` = all/none/subtree | `packages/domain/src/issue-authz.ts` L15–L47 |
| `IssueScope.subtree` is reserved and already enforced by `authorize()` | `packages/domain/src/issue-authz.ts` L66–L81 (`cap.scope.kind === 'subtree'` branch) |
| Reads are scope-free today | `packages/domain/src/issue-authz.ts` — `if (action === 'read') return 'allow'` before any scope test |
| `--outside-scope` / `overrideScope` → `confirm-required`; unknown target falls back to role gate only | `apps/server/src/issue-authz.ts` `checkIssueAccess` — `PRECONDITION_FAILED … re-run with --outside-scope`; `if (!targetId \|\| !issues.get(targetId)) return` |
| `mailSend` is `write` with **no** `target`, deliberately not scope-gated | `apps/server/src/modules/issues/registry.ts` L1128–1146 (comment + `def`) |
| `mailInbox` is `action: 'read'`; marks read only for a subtree scope rooted at that issue | `apps/server/src/modules/issues/registry.ts` L1149–1163 |
| `mailClaim` is `write`, `scope: 'issue'`, gated in-handler by the shared `checkIssueAccess` | `apps/server/src/modules/issues/registry.ts` L1170–1187 |
| Event subscriptions follow the `mailSend` pattern (write, no target, in-handler checks) | `apps/server/src/modules/issues/registry.ts` L1195–1200 comment + `subscriptionAdd` |
| `machines` has no owner / pairer / grant list | `apps/server/src/migrations/schema.ts` L147 — `id`, `name`, `hostname`, `token_hash`, `created_at`, `last_seen_at`, `inventory_json` |
| Per-machine facts exist as separate tables keyed by machine | `apps/server/src/migrations/schema.ts` L157 `repos` — primary key `(machine_id, path)` |
| `LOCAL_MACHINE_ID = 'local'`; `readOrCreateDaemonSecret` | `packages/runtime/src/local-machine.ts` L13, L45 |
| `PairingManager` is the pairing-ceremony precedent | `apps/server/src/hub/pairing.ts` L15 |
| `telegramChatId` is a single instance-wide `z.string().default('')` | `packages/runtime/src/settings.ts` L274 |
| Superagent tables carry no owner | `apps/server/src/migrations/schema.ts` L119 `superagent_messages`, L130 `superagent_threads`, L446 `superagent_queued_inputs`, L456 `superagent_pending_turns` |
| `nameSource` is a role enum, not a person | `packages/protocol/src/messages/runtime-state.ts` L84 — `z.enum(['user','agent'])` |
| `humanQuestionAskedBy` is the asking **session** id (actor half only), stamped server-side | `apps/server/src/modules/issues/registry.ts` L1032–1045 (used as the delivery address); `apps/server/src/modules/issues/service/crud.ts` L591 (`meta?.askedBy ?? null`) |
| No `UserId` brand exists | `packages/protocol/src/ids.ts` — `MachineId`, `SessionId`, `IssueId`, `RepoId`, `ConversationId`, `MutationId`; repo-wide search for `UserId` returns nothing |
| Session control substrate exists (one driver, N watchers) | `packages/protocol/src/messages/runtime-state.ts` L88 `controllerId`, L91 `clientCount`; `packages/protocol/src/messages/terminal.ts` L193 `requestControl`, L241/L260 `controllerId` |
| Presence today is `{ visible: boolean }` per connection, with no identity | `packages/protocol/src/messages/terminal.ts` L208 `PresenceMessage` |
| ADR 1 D5 declares `InstanceId` a deployment partition with no required `instance_id` columns | `docs/adr/0001-authority-ownership.md` D5.2 / D5.3 |
| ADR 3 D7 (transport-only principal) and D8 (apply-time re-authorization) as relied on | `docs/adr/0003-command-security.md` D7, D8 |
| ADR 3 D3's default-closed exposure rule as the mirrored discipline | `docs/adr/0003-command-security.md` D3 rule 1 |
| Human decisions of 2026-07-28/29 and all section references | `docs/multi-user-readiness.md` header decision, §2, §3.1, §3.1.1–§3.1.6, §5 |
| Sibling amendment ownership (ADR 1/2/3/7) | `podium issue tree 359` → POD-1071, POD-1072, POD-1073, POD-1074 |
| `SessionBinding` lifecycle work is POD-323 (Phase 5) | `podium issue show 323` |
| [spec:SP-eb60] naming doctrine; [spec:SP-5d81] messaging bridge | `podium spec show SP-eb60`, `podium spec show SP-5d81` |

---

## 7. Status and sign-off path

| Stage | Owner |
|---|---|
| Proposed | POD-1070 (this document) |
| Pack reconciliation + index entry | POD-359 |
| Human approval | POD-359 human gate |
| Amendments that cite this vocabulary | POD-1071 (ADR 1), POD-1072 (ADR 2), POD-1073 (ADR 3), POD-1074 (ADR 7), and ADR 4 Amendment 1 (integrator-authored under POD-359, no leaf issue) |
| `UserId` brand + `User` aggregate + per-user client sessions | Phase 1 (POD-288 / POD-301 / POD-304) |
| Scoped feed + scoped bootstrap machinery | Phase 2 (POD-289), before the POD-308 wire cutover — mechanism owned by ADR 2's amendment |
| Ownership / grants policy, share/unshare commands, per-user attribution | Phase 3 (POD-290 / POD-311 / POD-315) |
| Delegation lifecycle on `SessionBinding` | Phase 5 (POD-323) |

Until human sign-off of the ADR pack, Phase 1–2 must not treat an alternative identity,
ownership or sharing model as authorized. Amendments after sign-off require an ADR update and
POD-359 tracker reconciliation.

---

## 8. References

- `docs/multi-user-readiness.md` — the authoritative record of the human decisions of
  2026-07-28/29 this ADR ratifies (header decision; §2; §3.1; §3.1.1–§3.1.6; §5)
- POD-359 (pack gate), POD-1070 (this ADR), POD-1071–POD-1074 (ADR 1/2/3/7 amendments)
- POD-288 / POD-289 / POD-290 / POD-291 / POD-293 (phases), POD-301 / POD-304 / POD-305 /
  POD-306, POD-308 (wire cutover), POD-311 / POD-315 / POD-316, POD-317 / POD-387,
  POD-323 / POD-644 (session binding, handoff), POD-352 / POD-418–421 (secrets), POD-645
- `docs/rearchitecture-v3.md` — migration ledger
- `packages/domain/src/issue-authz.ts`, `apps/server/src/issue-authz.ts`,
  `apps/server/src/modules/issues/registry.ts`
- `packages/runtime/src/auth-store.ts`, `packages/runtime/src/local-machine.ts`,
  `packages/runtime/src/settings.ts`, `apps/server/src/hub/pairing.ts`
- `apps/server/src/migrations/schema.ts`, `packages/protocol/src/ids.ts`,
  `packages/protocol/src/messages/runtime-state.ts`,
  `packages/protocol/src/messages/terminal.ts`
- Specs: [spec:SP-15aa], [spec:SP-eb60], [spec:SP-5d81], [spec:SP-edbb], [spec:SP-3fe2]
