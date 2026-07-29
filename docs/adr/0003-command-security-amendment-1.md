# ADR 3 — Amendment 1: user, agent, machine and system principals

- **Status:** Proposed (human gate: POD-359)
- **Date:** 2026-07-29
- **Deciders:** architecture rewrite ADR pack (POD-359); human decisions of 2026-07-28/29
  recorded in `docs/multi-user-readiness.md`; human sign-off before Phase 1
- **Issue:** POD-1073 (leaf of POD-359; owns `docs/adr/0003-command-security.md` and this file)
- **Consumers:** Phase 1 POD-288 / POD-304 (matrix annotations) / POD-351 (first contract);
  Phase 2 POD-306 family (outbox states, apply path); Phase 3 POD-311 (contract framework),
  POD-315 (principal / re-auth / scope matrix suite), POD-316 (offline + dead-letter UX),
  POD-352 (secrets split, POD-418–421), POD-290 (policy = ownership/grants); Phase 5 POD-323
  (`SessionBinding` as the delegation lifecycle), POD-644 (handoff placement)
- **Related ADRs:** ADR 1 (ownership matrix; **D5 InstanceId — unaffected, see §1**; D6 secret
  classification), ADR 1 Amendment (owner/visibility columns, per-user state, `op-stream`),
  ADR 2 (feed identity, receipt retention, `expectedRevision` token) and its amendment (scoped
  feed, watermarks, rescope/evict), ADR 4 (representation) and **ADR 4 Amendment 1 D9**
  (`UserId` brand, ownership field group, attribution as two branded fields), ADR 5 (peer auth
  strategies), ADR 7 (plane inventory; external chat adapter sits **outside** the three peer
  planes), **ADR 9** (identity, ownership and sharing — principal taxonomy, delegation,
  machine verbs, superagent/system classes)
- **Specs:** [spec:SP-3fe2] command contract; [spec:SP-b85a] relay command channel;
  [spec:SP-edbb] approval broker; [spec:SP-15aa] instance isolation; [spec:SP-eb60] curated
  name vs live title; [spec:SP-5d81] Telegram bridge / setup ceremony
- **Base tip verified:** `2ddfec21` (issue/279-integration), 2026-07-29
- **File discipline:** this amendment owns **only** this file plus a single "Amended by" line in
  `docs/adr/0003-command-security.md`. No index edits (POD-359 owns `docs/adr/README.md`), no
  ledger edits, no edits to ADR 1 / 2 / 7 / 9.

---

## 1. Context

`docs/multi-user-readiness.md` records the human decisions of 2026-07-29. ADR 3 is the ADR those
decisions make **more** right, not less: readiness §2 names D7 (payload identity is inert) as *the
precondition for any multi-user authz* and D8 (apply-time re-authorization) as the mechanism the
central multi-user risk was already designed for. Neither is re-opened here. What is missing is
that D7's principal is still single-operator shaped, and D7's own table already writes
*"operator / **future user principal**"* for the tRPC row — an anticipated but undecided seam.
This amendment decides it.

**Multi-user is not multi-tenancy.** Multi-user in one tenant lives **inside** one Authority.
**ADR 1 D5 is unaffected**: `InstanceId` remains a deployment partition, not a row-level
discriminator, and D2's instance-isolation clause ([spec:SP-15aa]) keeps exactly its current
meaning — an authz hard wall between deployments, not a tenant column. Nothing in this amendment
authorises an `instance_id` column on any table, envelope, outbox entry or capability. An
implementer who reads "multi-user" and reaches for tenant columns has misread this document.

**What is true today**, verified on tip `2ddfec21`:

- **There is one principal, and it is unconstrained.** `packages/domain/src/issue-authz.ts`
  declares `export const OPERATOR: Capability = { role: 'admin', scope: { kind: 'all' } }`,
  documented as *"the **operator** — the cookie-authed human on /trpc, plus the trusted in-process
  MCP — is unconstrained"*.
- **`Capability` has an actor half and no person half.** `interface Capability { role; scope;
  actorSessionId? }` — `actorSessionId` is documented as *"the session behind this call, when the
  caller is an agent (relay path). Undefined for the operator/web."* There is no `UserId` and no
  on-behalf-of field anywhere in the type.
- **Reads are scope-free by construction.** `authorize()` returns `'allow'` for every `read` before
  any scope test (`if (action === 'read') return 'allow'`), and `checkIssueAccess`
  (`apps/server/src/issue-authz.ts`) returns early for `scope.kind === 'all'`. Under one operator
  this is correct; under private-by-default it is the single largest behavioural change in this
  amendment (D19).
- **An unknown target already falls through to the role gate.** `checkIssueAccess` returns without
  a scope decision when `!targetId || !issues.get(targetId)`. The consistent-error rule of D20
  therefore lands on an existing branch rather than needing a new one.
- **The narrow agent scope A2 asks for is already minted.**
  `apps/server/src/modules/sessions/service.ts` `capabilityForSession(sessionId)` returns
  `{ role: 'worker', scope: { kind: 'subtree', rootId: issueId }, actorSessionId: sessionId }` —
  spawned-for scope, already enforced by `authorize()`. What is missing is the delegator, not the
  scope.
- **A client session is a device, not a person.** `client_sessions`
  (`apps/server/src/migrations/schema.ts`) is `token_hash` / `created_at` / `expires_at` — no user
  column. `packages/runtime/src/auth-store.ts` is documented as a *"single-user client-access
  password"*: one password per instance, no accounts.
- **Attribution is already stamped from the capability, never from input.** `apps/server/src/relay.ts`
  carries the comment *"stamped server-side via the capability (actorSessionId), never from input"*.
  D7.3's rule is live; it simply has one half of the pair.
- **The mail rules readiness §3.1.5 ratifies are in the code with their reasoning written down.**
  In `apps/server/src/modules/issues/registry.ts`: `mailSend` is `action: 'write'` with **no**
  `target`, commented *"DELIBERATELY NOT scope-gated … addressing ANOTHER issue is the whole point
  of it — cross-issue sends must not require --outside-scope. Treated like `create` … so the role
  gate still applies"*; `mailInbox` marks unread only when `capability.scope.kind === 'subtree'`
  **and** the scope root resolves to that issue; `mailClaim` is `scope: 'issue'` with an in-handler
  `checkIssueAccess`. Event subscriptions are commented as following the same pattern.
- **Machines have no owner and no grant list.** The `machines` table is `id`, `name`, `hostname`,
  `token_hash`, `created_at`, `last_seen_at`, `inventory_json`. Access is gated by instance
  authentication alone, and `ensureLocalMachine` seeds `LOCAL_MACHINE_ID` for the all-in-one case
  (readiness §3.1.4 M4).
- **The Telegram edge has one chat id and one implied identity.**
  `packages/runtime/src/settings.ts` declares `telegramBotToken` and `telegramChatId` as sibling
  `z.string().default('')` under `notifications`; `apps/server/src/modules/messaging/telegram.ts`
  long-polls with `const wantChatId = this.config.chatId.trim()` and drops every update where
  `msg.chatId !== wantChatId`. Inbound authentication is "you are the configured chat", which
  resolves to the operator by default.
- **A claim-code ceremony already exists — it just binds a chat to the *instance*.**
  `apps/server/src/modules/settings/service.ts` `startTelegramSetup` / `pollTelegramSetup` mint a
  short code, poll `getUpdates` for it, and write the matched `chatId` into settings
  ([spec:SP-5d81]); `apps/server/src/hub/pairing.ts` `PairingManager` is the single-use,
  short-TTL code precedent. D22 gives that ceremony a user on the other end.
- **Superagent state carries no owner.** `superagent_threads` / `superagent_messages` have no user
  or owner column (readiness §3.1.6 S2).

Everything preserved by construction: D1's contract fields, D3's default-closed exposure rule, D4's
three delivery classes, D5 redaction, D6 optimistic reducer, D9's outbox states and invariants,
**D10 as sole owner of the retry/age numbers**, D11's inequality-and-lint rule, D12's ordering
partitions, D13's `expectedRevision` acceptance. No number owned by another ADR is restated here.

---

## 2. Decisions

Numbering continues ADR 3's sequence (D1–D13 are the base document's). Existing decisions keep
their numbers; each decision below states which base decision it extends.

### D14 — Principal is `(user, device, capability)`; D7's table names a person, an agent, a superagent, a system class and Telegram

**Extends D7.**

**Decision.**

1. The transport-derived principal becomes a triple: **`user`** (the person, `UserId` per ADR 4
   Amendment 1 D9.1 — that brand's shape is ADR 4's, not restated here), **`device`** (the
   authenticated client session / daemon / binding the call arrived on), and **`capability`**
   (today's role + scope, extended by D18/D19). A `client_session` remains a device; it gains a
   user reference, and a user may hold many.
2. D7's principal table is replaced by the following. Every row names a user where one exists, and
   the **principal source column remains the sole authority for identity** — payload never
   contributes to any cell.

| Transport / ingress | Principal class | User | Actor | Principal source |
|---|---|---|---|---|
| `trpc` | **human user** | the account behind the client session | same user | Cookie / client session (`auth-route` / `auth-store`) → account lookup → capability minted server-side |
| `cli`, `mcp` — operator channel | **human user** | as the channel it rides | same user | In-process binding or the local operator's client session; never client-supplied |
| `relay` | **agent-delegated** | `onBehalfOf` resolved from the **delegation reference**, never from a payload string | the agent session (`actorSessionId`) | Daemon-authenticated agent session id baked into the relay path; capability minted server-side from the delegation record (D16) |
| `relay` (sub-agent) | **agent-delegated (chained)** | the one human at the root of the chain | the sub-agent session | Same, resolved over the whole chain; never widening (D16.3) |
| superagent / scheduled automation | **agent-delegated (broad scope)** | its creating human | the automation identity | Server-side record created at the moment a human created the thread or schedule (ADR 9 D8 S1/S6) |
| system (steward, expiry jobs, boot reconcile, derived-field maintenance) | **system** | **none, and never assigned one** | the named system job | In-process construction only; not reachable from any transport (D21) |
| `peer` | **machine** | none (a machine is not a person) | the paired machine | Peer auth strategy module (ADR 5) — machine token / pairing, not payload |
| **Telegram (external chat ingress, [spec:SP-5d81])** | **human user, via binding** | the user bound to that chat id | that user's superagent | Claim-code **binding record** (D22). Unbound chat ⇒ **no principal**, request refused |

3. **The agent row carries a delegation reference, not a string.** The relay principal names a
   durable delegation record (`agentIdentity`, `onBehalfOf: UserId`, granted `scope`, lifecycle);
   the wire carries only the reference that the server itself minted. D7.1 is therefore
   **strengthened, not weakened**: an envelope field naming a user, an agent, or a delegation is
   informational/audit only, and a forged value must be inert. POD-315's existing test obligation
   ("a mismatched `origin.actor` cannot escalate or rebind `Capability`") extends verbatim to
   `onBehalfOf` and to the delegation reference.
4. **Telegram is a named ingress in this table and is *not* a D3 exposure tag.** No command is
   served on the Telegram edge. The binding resolves an inbound message to a user principal; that
   principal's superagent then issues ordinary commands over the ordinary surfaces. This keeps
   ADR 7's classification (external chat adapters sit outside the three peer planes) and D3 rule 3
   (no smuggling host/edge frames through command exposure) intact.

**Rationale.** The seam D7 anticipated has to be closed before Phase 1 because Phase 1's thesis is
that `packages/model` is the one authoritative definition of every field (readiness §3.2); landing
Phase 1 with a single-operator vocabulary bakes the wrong model into the one place the rewrite
promises never to redo. Naming the classes in D7's own table — rather than in a separate identity
document — is what keeps the "identity comes only from the authenticated transport" rule total: a
class that has no row has no principal source, and therefore no principal.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Keep `OPERATOR` as the tRPC principal and add users later | `OPERATOR` is `admin` + `scope: 'all'` and `checkIssueAccess` short-circuits on `scope.kind === 'all'`. Every ownership check would be dead code on the one transport humans actually use, so nothing would be tested until the flip. |
| Carry `onBehalfOf` as a field on `MutationEnvelope.origin` | That is exactly the free-string identity D7.1 declares inert. A payload-supplied delegator is an impersonation primitive: any agent could mail, close or spawn as anyone. The delegation must be a server-minted record the transport resolves. |
| One `principal` opaque string per transport, parsed per handler | Reproduces the `PROC_ACTION` string-map failure [spec:SP-3fe2] / POD-248 fixed once already: a rename silently resets authz. Structured principal, resolved at context construction, is the shipped lesson. |
| Give Telegram a D3 exposure tag so commands can be invoked from chat | Contradicts ADR 7 (external chat is outside the peer planes) and D3 rule 3. It would also make an unauthenticated inbound webhook a command surface — the precise shape D3 exists to forbid. |
| Give the system class a service user so everything has a user | Readiness §3.1.6 S5 rejects it directly: a system job with a human identity can act *as* that person and widen their visibility. See D21. |

### D15 — Roles are a floor on **which commands**; ownership and grants decide **which rows**

**Extends D2.**

**Decision.**

1. Instance roles are at minimum **`admin`** and **`member`** — **the role set itself is ADR 9
   D1.4's**, cited not re-decided (readiness §3.2). The existing
   `IssueRole` (`viewer` | `worker` | `admin`) is a *capability* role inside a scope and is
   unchanged; the instance role is a separate, coarser axis that decides what a capability may be
   minted with.
2. **Composition rule (normative).** A command apply requires **both**:
   - the principal's role permits the contract's `action` at all — the *role floor*; and
   - the principal's scope, ownership and grants permit the specific target row — the *row gate*
     (D19).
   Neither substitutes for the other. An `admin` role does not confer read of a private row it has
   no grant on; an owner's grant does not let a `member` run an `admin`-only command.
3. **Secrets management is admin-grade.** ADR 1 D6's secret classification is unchanged; this ADR
   adds that any contract whose policy names the `secret` resource kind requires the `admin`
   instance role in addition to D4's `online-sensitive` delivery class. Rationale is
   readiness §3.2: secret management stops being self-service the moment there is more than one
   human.
4. Role assignment and invite flow are themselves commands under the same rules; changing a role is
   `manage` on a `global`-scope contract, and is admin-grade.

**Rationale.** Collapsing the two axes is the classic failure in both directions. Role-only means
an `admin` reads every private row by definition, which destroys the private default the product
decided on. Ownership-only means any member can invoke administrative commands as long as they own
the row — including unpairing a machine or rotating a token they happen to own. Stating the
conjunction here, once, is what stops each feature re-deciding it.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| A single role lattice with ownership expressed as a role (`owner` as a role) | Ownership is per-row and mutable by sharing; a role is per-principal and mutable by administration. Fusing them means every share/unshare is a role edit, and role edits are admin-grade — so sharing your own issue would require an admin. |
| `admin` implies read-all | Directly contradicts private-by-default (readiness header + §3.1.1). Admin-grade powers are *administrative* (roles, secrets, deployment substrate), not clairvoyance. Where an admin genuinely needs a row, that is a grant, and it is visible as one. |
| Defer roles to Phase 3 with the sharing UX | The role is an input to capability minting, which is Phase 1 model shape. Deferring means Phase 1 mints one capability shape and Phase 3 re-mints it — the second migration this programme exists to avoid. |
| Reuse `IssueRole` as the instance role | `IssueRole` is scoped to a capability over issues (`viewer`/`worker`/`admin`) and is minted per agent session. Instance role governs machines, secrets, settings and invites too. One name, two lifetimes = drift. |

### D16 — Apply-time re-authorization **resolves a delegation chain**; it does not read a stored capability

**Extends D8. This is a change of what D8 resolves, not a new mechanism.**

**Decision.**

1. D8 step 1 ("resolve the **current** principal") is amended to read: resolve the current
   principal **by resolving the delegation chain**. For an agent principal, effective rights are
   **the agent's own scope intersected with its delegating human's *current* rights**, evaluated at
   **every** apply — including every outbox drain replay. A capability frozen at spawn is never an
   input to an allow decision.
2. **Sub-agents chain by the same rule.** A sub-agent delegates from its parent agent, never
   widening; the chain has exactly **one** human, at the root; the intersection is evaluated over
   the **whole** chain. A link whose delegator has lost rights collapses the whole chain below it.
3. **The delegator's ceiling is not the delegate's default.** An agent's default scope is what it
   was spawned for — its session, its issue, that issue's subtree — not everything its human can
   see (ADR 9 D5 A2). Widening is explicit and uses the existing `overrideScope` /
   `--outside-scope` path with `confirm-required` (D2), not a wider mint.
4. **Offline entries are unaffected in shape and explicitly covered by D9.** An outbox entry drained
   after its delegator lost rights re-authorizes, fails, and becomes **`rejected`** → `dead-letter`
   with a reason code — D9 invariants 1 and 2, unchanged. It is **never** silently dropped, and no
   new outbox state is introduced for it. The reason code must distinguish *your rights changed*
   from *your input was invalid*, because the recovery actions differ (D9 invariant 3: retry after
   a rights fix vs edit).
5. **Cost is nil, and that is the point.** D8 already re-authorizes on every apply; the delegation
   resolution replaces a lookup with a lookup. Readiness §3.1.3 A1 states it plainly: this is the
   case D8 was over-engineered for under a single operator, arriving.

**Rationale.** A snapshot capability means revoking a person leaves their unattended agents running
with rights the human no longer holds — a privilege leak with **no cleanup trigger**, in a system
where agents run for hours without supervision. Live resolution makes "revoke the human"
transitively disable their agents **with no reaper to write, and therefore none to forget**. The
codebase already mints agent capabilities per call (`capabilityForSession` is a function of current
session and issue state, not a stored blob), so live resolution is the smaller change, not the
larger one.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Snapshot the capability at spawn and re-check only the snapshot | The privilege leak above. Concretely: un-share a colleague, and their long-running agent keeps writing to your issues until someone notices — and the outbox path would replay those writes on reconnect, which is the exact hazard D8 exists for. |
| Snapshot plus a revocation reaper that kills affected agent sessions | A reaper is a second mechanism that must enumerate every affected agent, run reliably, and win a race against in-flight applies. Correctness by enumeration; live intersection is correctness by construction. Readiness §3.1.3 A1 names the reaper as the thing not to write. |
| Let a sub-agent hold rights its parent lacks (delegated by the human directly) | Then the chain has two humans' worth of authority and revoking the parent does not stop the child. One human at the root is what makes the intersection well-defined. |
| Silently drop outbox entries whose delegator lost rights ("they're not allowed anyway") | Violates D9 invariant 1 (no silent poison-drop, POD-279 finding 8). The user authored that work; losing access is not a licence to delete it without telling them. Dead-letter with a rights reason is the designed path. |
| Re-authorize only when the entry is older than some threshold | Rights can change in a second. Any threshold is a window in which revoked rights still apply; D8 chose "every apply" for this reason. |

### D17 — Attribution is a pair: **actor** and **on-behalf-of**, both stamped from the transport

**Extends D7.3.**

**Decision.**

1. Every write records **actor** (which agent, machine or human performed it) **and**
   **on-behalf-of** (which human it was performed for). Both are stamped from the transport
   principal (D7/D14). Neither is ever read from payload. The field *shapes* — two differently
   branded fields, on R1, not on the provenance envelope — are ADR 4 Amendment 1 D9.3/D9.4; this
   ADR owns the **stamping obligation** and the prohibition on collapsing them.
2. For a human on `trpc`, actor and on-behalf-of are the same user; the pair is still recorded as a
   pair, so consumers never branch on shape.
3. **Entities an agent creates are owned by its `onBehalfOf` human, with the agent as actor**
   (ADR 9 D5 A4). Otherwise the private sidebar — the product goal that motivated the private
   default — would not show work your own agent did for you, and retiring an agent session would
   orphan its issues.
4. `Capability.actorSessionId` is the existing seam for the actor half and is retained; the
   on-behalf-of half is new and is populated by the delegation resolution of D16.
5. System writes set actor = the named system job and on-behalf-of = **none** (D21). "None" is a
   distinct, representable value; it is never defaulted to an operator or to the row's owner.

**Rationale.** Collapsing the pair loses distinctions the product already depends on and already
tests for: human-set `name` outranks agent-set (`nameSource`, [spec:SP-eb60]), and
`humanQuestionAskedBy` is server-authoritative precisely so *"did a person or an agent ask this?"*
stays answerable. Under multi-user a third question arrives — *"which person is this on behalf
of?"* — and a single field cannot answer all three. Stamping both from the transport is not extra
work: `apps/server/src/relay.ts` already stamps the actor half from the capability and says so in a
comment; the amendment adds a second value to the same code path.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| One `actor` field holding either a user or an agent | Every consumer must then parse the id to know which it got, and the human-vs-agent test (`humanQuestionAskedBy`, `nameSource`) becomes a string-prefix inspection. Prefix-typed ids are the drift class branded ids exist to end. |
| Derive on-behalf-of at read time from the agent's current delegation | Delegations change and agents are retired; a historical write would then re-attribute itself to whoever the agent belongs to *now*, or to nobody. Attribution is a durable fact of the write. |
| Attribute agent work to the agent, with owner = the agent | Retiring an agent session orphans its issues, and the delegating human's own sidebar hides work done for them. Readiness §3.1.3 A4 decides the other way. |
| Attribute agent work to the human only (drop the actor) | Destroys the human-vs-agent distinction in the direction that matters most — a human's name edit would be indistinguishable from an agent's, which [spec:SP-eb60] exists to prevent. |

### D18 — `machine` scope gains **see / use / manage** with an owner and a per-machine grant list

**Extends D2 (resource scopes) and D4 (delivery classes). Verb semantics are ADR 9 D6's;
this decision maps them onto ADR 3's policy vocabulary.**

**Decision.**

1. The `machine` resource scope kind (already declared in D2) is evaluated against a **machine
   owner plus a per-machine grant list**, not against the instance role alone. The three product
   verbs map onto D2's action vocabulary as follows:

| Verb (ADR 9 D6) | D2 action | Gates | Default holder |
|---|---|---|---|
| **see** | `read` on `machine` | Existence, health/liveness, "your session ran there" attribution | Owner + `admin` role (fleet management) |
| **use** | `write` on `machine`, with a **`use` grant** required in addition to the role floor | Spawn, reattach, PTY attach, harness exec, file read/write, take a worktree | **Owner only, until explicitly granted** |
| **manage** | `manage` on `machine` | Rename, unpair, rotate pairing token, remove from fleet | Owner + `admin` role |

2. **`use` is a code-execution boundary, not a privacy boundary**, and the model must not make it
   look like ordinary object visibility. Granting `use` means arbitrary execution on someone's
   hardware with **their** local environment — SSH keys, `gh`/git identity, dotfiles, cloud CLI
   sessions, private checkouts.
3. **Delivery class, decided explicitly against D4.** A contract whose policy requires the `use`
   verb is **`online-only`** (hard rule, same shape as D4 rule 1 for `secret` ⇒ `online-sensitive`)
   and therefore must not list `outbox` in `exposure` (D4 rule 3). D4's `online-only` examples
   already name spawn/kill/attach/resize/harness exec/file ops, so this ratifies the existing
   classification and makes it derivable from policy rather than chosen per contract. `manage`
   verbs that touch pairing material (rotate token, unpair) are `online-sensitive` via D4 rule 1,
   because that material is `secret` under ADR 1 D6. `see`-only reads may be offline-eligible.
4. **Placement and handoff fail closed.** Spawn/placement surfaces must not offer machines the
   principal lacks `use` on; session handoff (POD-323 / POD-644) to such a machine is **denied, not
   silently retargeted**.
5. **Unauthorized is distinguishable from unreachable — inside the `see` set only.** For a machine
   the principal can `see`, the error vocabulary must separate *denied* from *offline*, because
   both otherwise present as an empty list and the user cannot tell a permissions problem from an
   outage. For a machine the principal cannot `see`, the machine is **absent**, and any reference to
   it fails identically to a nonexistent machine id — the same consistent-error rule as D20. This
   **refines** ADR 9 D6 M5 (which states the distinction unconditionally) rather than contradicting
   it: the distinction is drawn only where existence is already disclosed by `see`, which is the
   set M5's empty-list problem actually describes.
6. **The all-in-one case fails closed.** Where the server runs on someone's Mac, the `local` daemon
   *is* that machine (`LOCAL_MACHINE_ID`, `ensureLocalMachine`). Its owner is whoever set the
   instance up; it is not ambient team compute, and authenticating to the server does not confer
   `use` on it. A newly paired machine is private to its pairer (ADR 9 D6 M3).
7. **Agents inherit this with no extra mechanism.** By D16, an agent's rights are its human's
   current rights intersected with its scope, so an agent can only spawn on machines its human may
   `use`, and a sub-agent cannot reach past its parent.

**Rationale.** D2 already carries the vocabulary (`read`/`write`/`manage`, `machine` as a scope
kind); what is missing in the code is an owner and a grant list — the `machines` table has neither.
Expressing machine access as grants on the same principal model, rather than as a separate fleet
ACL, is what makes point 7 free: a second ACL system would need its own delegation semantics, and
unattended agents are exactly where a second system diverges unnoticed.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| One visibility bit per machine ("shared" / "private") | Fuses `see` with `use`. Fleet health and "your session ran there" attribution need `see` for admins; execution on a personal laptop must stay owner-only. One bit forces either an execution leak or a broken fleet view. |
| Gate machine verbs by instance role alone (admins may use everything) | This is today's behaviour generalised, and it fails M4 directly: on an all-in-one install every authenticated admin inherits execute on the host machine. The human direction was explicit that a personal Mac must not be team compute. |
| A separate fleet ACL table outside the command policy | Duplicates delegation, revocation and apply-time re-auth for one resource kind. Agents would then need a second inheritance rule, and D16's intersection would not cover it — the exact divergence that makes unattended processes dangerous. |
| Let `use` commands be offline-eligible when the daemon is reachable later | A queued execution command is a rights snapshot with a delayed fuse: it would run after a grant was revoked, on someone else's hardware. D4 already forbids queueing live-daemon ops; this makes the reason a policy consequence rather than a per-contract judgement call. |
| Report "no machines available" uniformly for denied and offline | Indistinguishable failure modes produce support tickets and, worse, silent retargeting. Where existence is already disclosed by `see`, hiding the reason protects nothing. |

### D19 — Owner and grant scopes **extend** the closed scope set; reads stop being scope-free

**Extends D2 (resource scope kinds) and the `IssueScope` closed set.**

**Decision.**

1. `IssueScope`'s closed set (`all` | `none` | `subtree`) is **extended**, not forked, with
   **owner** and **grant** scopes for personal entities. The same `authorize()` decision function
   and the same `checkIssueAccess` throw-shape serve them; no parallel check is introduced. The
   existing `overrideScope` / `--outside-scope` → `confirm-required` path (D2) keeps its meaning for
   deliberate widening, and remains disallowed where `manage` forbids override.
2. **`read` is no longer unconditionally allowed.** `authorize()`'s current
   `if (action === 'read') return 'allow'` is correct only while everyone may read everything; under
   private-by-default, reads are gated by owner/grant scope like writes. This is called out as a
   behavioural change because it is the one place where extending the closed set is not additive —
   POD-315's matrix suite must cover read denial explicitly, on all four transports.
3. **Visibility classes are ADR 9's, and default-closed.** Which classes are personal, per-user,
   owned compute, deployment substrate or secret is **ADR 9 D3**, as is the rule (**ADR 9 D4**) that
   an unclassified class is **personal/private**. That rule is **deliberately the same shape** as
   D3's default-closed exposure rule — cited, not duplicated: a forgotten declaration must fail
   toward privacy, exactly as a missing `exposure` fails toward unreachable.
4. **`reparent` becomes a permission-affecting operation**, because a `subtree` scope is a moving
   set: reparenting an issue under an epic widens a working agent's visibility with nobody having
   decided it. Whether that requires a D2 confirmation rule (and whether the confirmation is
   conditional on crossing an owner boundary) is **OPEN** — recorded in §3, not answered here. What
   is decided: the effect is real, it must be surfaced, and if the answer is "confirm", it is an
   ordinary D2 confirmation shape and needs no new mechanism.
5. Partition keys (D12) are unchanged: ownership is a policy dimension, not an ordering dimension.

**Rationale.** The closed set with a reserved `subtree` shape that `authorize()` already enforces is
the pack's best example of a seam left open on purpose; using it is strictly cheaper than a second
evaluator, and a second evaluator is how a system ends up with two answers to "may I read this".
Naming the read change explicitly matters because it is invisible in the diff: `authorize()` gets
one line shorter and one branch wider, and every read path in the product changes behaviour.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| A separate ownership check alongside `authorize()` | Two evaluators, two orders of evaluation, two override stories. `checkIssueAccess` exists (POD-25) precisely because duplicated checks drift; adding a parallel one re-creates the defect it fixed. |
| Keep reads scope-free and filter results at the projection layer | Filtering after authorization means the authority computed a forbidden row and then hoped every projection dropped it. It also moves an authz decision into representation, which ADR 4 does not own, and it is the per-client filtering ADR 2's amendment specifically constrains. |
| Model grants as a role per user per entity | Roles are per-principal floors (D15). Per-row roles multiply the role space by the entity space and make revocation a role sweep. A grant edge is the smaller object. |
| Decide `reparent` now (require confirmation when crossing an owner boundary) | Readiness §3.1.5 leaves it open on purpose: it is a product-behaviour call about a tracker operation people use constantly, and the wrong answer adds a confirmation to a routine action. Recorded as open with an owner. |

### D20 — Cross-boundary writes: ratify the shipped mail rules, bound by the **human ceiling**, with a **consistent-error** rule

**Extends D2 and D7; ratifies existing behaviour. Policy source: ADR 9 D7.**

**Decision.**

1. The three shipped mail authz shapes are **kept exactly as they are**: `mailSend` is a role-gated
   `write` with **no** scope target (cross-issue addressing is the point, and must not require
   `--outside-scope`); `mailInbox` consumes unread only for a `subtree` capability rooted at that
   issue; `mailClaim` is subtree-gated through the shared `checkIssueAccess`. Dependency/graph edges
   already carry a scope target and route through `overrideScope` → `confirm-required`; event
   subscriptions already follow the `mailSend` pattern with own-row and source-within-subtree checks
   in the handler. **None of these needs new mechanism.**
2. **Multi-user adds exactly two clauses.**
   - **Human ceiling.** The unscoped send is bounded by the **delegating human's** current
     visibility, not by the agent's scope. An agent may mail any issue **its human can see**,
     including outside its own subtree; it may not mail an issue that human cannot see. In the
     single-user case this is behaviour-preserving by construction (one human, everything visible).
   - **Consistent error.** Addressing an entity that is invisible to the principal must fail
     **identically** to addressing a nonexistent id — same code, same message, same timing class.
     Divergent errors turn any send path into an existence oracle.
3. The consistent-error rule is **general**, not mail-specific: it applies to every command whose
   target id is supplied by the caller. `checkIssueAccess` already returns without a scope decision
   when the target does not resolve, so the invisible case joins an existing branch rather than
   creating a new one.
4. Redaction (D5) governs what a *denied* error may say; this rule governs what it may *distinguish*.
   They compose: safe structured codes that do not encode existence.

**Rationale.** The code already encodes the right primitive with its reasoning in a comment —
send-without-read is genuinely what a tracker mailbox needs — and readiness §3.1.5 confirms the
human observation that agent mail already inherits from the issue which inherits from the user.
Ratifying it protects it: an implementer reading "private by default" would otherwise scope-gate
`mailSend`, and cross-issue coordination (the product's main agent-to-agent path) would silently
start requiring `--outside-scope`.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Scope-gate `mailSend` to the agent's subtree under multi-user | Breaks the coordination path the comment exists to protect, and would make every cross-issue send a `confirm-required` prompt. The privacy concern is injection into a colleague's private workspace, which the human ceiling addresses without touching the primitive. |
| Bound the send by the agent's own scope instead of its human's | An agent could not mail its sibling issue, which is today's normal behaviour and would regress with no privacy gain — the human can already see both. |
| Distinguish "no such issue" from "not allowed" for clearer errors | Turns the send path into an existence oracle: an attacker enumerates ids and learns which private issues exist. Readiness §3.1.2 names existence leakage as its own policy class; this site is decided, the general policy is not. |
| Solve the oracle with rate limiting instead | Rate limiting raises the cost of enumeration; it does not remove the signal, and it fails the offline/outbox replay path where timing is meaningless. |

### D21 — System principals are **not delegated**; scheduled automations **are**

**Extends D7/D14; ADR 9 D8 S5/S6 own the class definitions.**

**Decision.**

1. **Normative rule.** System principals (steward, expiry jobs, boot reconcile, derived-field
   maintenance) **may read across owners, but every write is attributed as `system` (D17.5) and
   lands in the scope of whatever it acted on. They never widen anyone's visibility and never act
   *as* a person.**
2. A system principal is constructed in-process only; it has no transport row in D14's table beyond
   its own, and therefore cannot be reached, impersonated or borrowed from any transport. It has no
   `onBehalfOf` and must not be assigned one.
3. "Lands in the scope of whatever it acted on" means: a system write never changes a row's owner,
   visibility class, or grants as a side effect. A system principal that needs to change ownership
   is running a command a human must authorize.
4. **Scheduled automations are the opposite case and are delegated** like the superagent: they have
   a creator, so they run **as that person with that person's current rights** (ADR 9 D8 S6). They
   inherit D16's live evaluation for free — revoke someone's access and their scheduled agents stop,
   with no reaper.
5. The superagent is a broad-scope delegation (scope = everything its human can see), which is a
   deliberate exception to D16.3's narrow default: an agent spawned *for a task* differs from one
   spawned *for a person* (ADR 9 D8 S1).

**Rationale.** Readiness §3.1.6 S5 settles the "instance-wide agent" worry by splitting it: the
things that genuinely need instance-wide reach are system jobs, and system jobs do not need — and
must not have — a human identity. Writing the read/write asymmetry as a single normative sentence is
what makes it testable: the steward may look at everything, and every mark it leaves says `system`.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Give system jobs a service account with `admin` role | A service account is impersonable and inheritable: anything that can borrow it acts as a super-user with a plausible-looking identity in the audit trail. It also re-opens "who does the steward act for?", which S5 closes. |
| Attribute system writes to the row's owner | Makes the product lie: the owner appears to have closed their own issue. `humanQuestionAskedBy`-class questions become unanswerable, which is the distinction D17 preserves. |
| Forbid system principals from reading across owners | Breaks the steward, expiry sweeps and derived-field maintenance on day one, and would push them into per-owner impersonation — strictly worse. Read-across with attributed, scope-local writes is the narrower power. |
| Treat scheduled automations as system jobs (no human) | They have a creator and act on that creator's data with that creator's reach; without delegation, revoking the creator leaves their cron agents running — the exact leak D16 exists to close. |

### D22 — Telegram is an authentication surface: a claim-code **binding**, failing closed

**Extends D7/D14; ADR 9 D8 S4 owns the settings classification.**

**Decision.**

1. An inbound Telegram message must resolve to a **user** before anything acts on it. Resolution is
   by a durable **binding record** `(chatId → UserId)` established by a **claim-code ceremony**: the
   code is issued in the authenticated web UI and presented to the bot, mirroring machine pairing
   ([spec:SP-5d81] adapter; `PairingManager`'s single-use, short-TTL codes are the precedent).
2. **Unknown chats fail closed.** An inbound message from a chat with no binding yields **no
   principal** and is refused. It must **never** fall back to an operator identity, and the refusal
   must not disclose whether the instance exists in any richer form than an unbound chat already
   knows.
3. The bound user's **superagent** is the actor; the bound user is the on-behalf-of (D17). All
   effects flow through ordinary commands with that principal's rights, resolved live per D16 — so
   revoking the human stops their Telegram edge with no separate revocation path.
4. **Settings split.** `notifications.telegramBotToken` stays `secret-value`, server-only,
   admin-managed (ADR 1 D6; admin-grade per D15.3). `telegramChatId` is routing configuration
   already classified as preference-not-secret, and becomes **per-user** state rather than one
   instance singleton.
5. Telegram remains **outside** D3's exposure tags (D14.4): the binding produces a principal, not a
   command transport.

**Rationale.** The single-operator design made the inbound direction "whoever holds the bot is the
operator" — verifiably so: the adapter drops every update whose `chatId` differs from the one
configured value. With several people, that is an impersonation surface, and D7's rule (principal
from authenticated transport only) admits exactly one fix: a real binding ceremony. The work is
small and easy to skip precisely because the feature already "works" single-user. Notably the
ceremony **already exists** — `startTelegramSetup` / `pollTelegramSetup` mint and redeem a code
today; what it lacks is a user on the other end and a per-user binding table instead of a settings
singleton.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Keep the single `telegramChatId` and treat that chat as the operator | Impersonation by construction: anyone in that chat acts as the operator, and under multi-user "the operator" is no longer a well-defined person. Directly violates D7. |
| Map Telegram user ids to Podium users by name/email matching | Unverified identity assertion from an external system — the payload-identity failure D7.1 forbids, wearing a different hat. Nothing proves the Telegram account belongs to the person whose name it matches. |
| Fall back to the instance owner for unbound chats "so nothing breaks" | Fail-open. The whole point of the ceremony is that an unbound chat has no identity; defaulting one silently re-creates the impersonation surface the ceremony removes. |
| Make Telegram a D3 exposure tag so commands are directly invocable | Contradicts ADR 7's placement of external chat outside the peer planes and D3 rule 3; it would also make an external webhook a first-class command surface with its own authz path. |
| Defer the binding until sharing UX lands | The edge is live today. The moment a second account exists, the existing chat acts as a person who did not authorise it. This is Phase 1/3 work, not Phase 6 work. |

---

## 3. Deliberately open — recorded, not answered

These are open in `docs/multi-user-readiness.md` and are **not** decided here. Each is listed with
the ADR 3 question it will owe an answer to.

> **Numbering is the pack's canonical open list — ADR 9 §3** (POD-359 reconciliation, 2026-07-29).
> O1–O5 below carry the same meaning in every document. **O6** (phase ordering of the one
> subscription primitive, ADR 7 Amendment 1 D13) raises no ADR 3 question and is therefore absent
> here, not closed.

| # | Open question | The ADR 3 question it raises | Who decides | When |
|---|---|---|---|---|
| **O1** | Which existence facts leak — counts, machine session lists, "this worktree is in use", lock holders, issue ref-letter allocation (readiness §3.1.2) | Whether each such read is a `read` on the entity (and therefore denied), or a deployment-substrate read. D20's consistent-error rule already fixes the *command target* case; the aggregate/listing cases are unsettled | Feature owner per surface, against ADR 9's visibility classes | Phase 3 policy (POD-290) |
| **O2** | Cross-boundary graph edge display: hide the edge, or show an opaque reference (readiness §3.1.2) | If opaque references ship, whether the redacted form is a D5 redaction projection of a denied read — i.e. a *deliberate, bounded* existence disclosure carved out of D20 | Human + feature owner (it is a policy call: the opaque form leaks existence) | Phase 3 policy (POD-290), before any issue-graph wire change |
| **O3** | Is `reparent` a permission-affecting operation requiring confirmation, and only when it crosses an owner boundary (readiness §3.1.5 case 2) | Whether `reparent`'s contract declares a D2 confirmation rule (`confirm` / `broker`), and whether the condition is expressible in a target extractor | Human, on the tracker's behaviour | Phase 3 (POD-290); surfaced in UI at latest. **D19.4 records the effect as real regardless** |
| **O4** | Per-class owner/grant inheritance on create — child inherits the parent's owner and grants, or the actor's (readiness §3.1.2, §3.1.3 A4) | Whether inheritance is contract behaviour (declared per command) or an ownership-field-group annotation. A4 fixes only the agent case (owner = `onBehalfOf` human) | ADR 1 amendment (matrix annotation) + per-class feature owner | Declared per class as classes land; annotation shape at Phase 1 (POD-304) |
| **O5** | Local credentials on a machine with `use` granted are not separable from the host; server-injected material (managed `accounts` credentials, API quota) is, and plausibly bills the delegating human (readiness §3.1.4, "Unresolved") | Whether any contract distinguishes host-local from server-injected credential use, or whether this stays product copy — readiness leans to copy, not model | Human + product; feature owner for `accounts` | Phase 3 at the earliest; **must not** be modelled speculatively |

ADR 3 must not pre-empt any of these. O1, O2 and O5 change *policy*; O3 and O4 could change a
*contract declaration*, in both cases within shapes D19 and D2 already provide.

---

## 4. Security properties — additions to ADR 3's normative checklist

ADR 3's numbered properties 1–8 are **unchanged and unrenumbered**. This amendment appends:

9. **Principal names a person where one exists** — every transport row in D14's table resolves to a
   user, an explicitly user-less class (`machine`, `system`), or **no principal at all**. There is
   no default identity.
10. **Delegation is a reference, never a payload string** — a forged `onBehalfOf`, delegation
    reference or user id is inert, on every transport (POD-315 AC, extended).
11. **Rights are resolved live over the whole delegation chain at every apply** — no capability
    snapshot is ever an input to an allow decision; revoking a human transitively stops their
    agents and sub-agents.
12. **Role and ownership are conjunctive** — a role never confers a row, and a grant never confers a
    command.
13. **Attribution is a pair** — actor and on-behalf-of are both stamped from the transport, and
    neither is inferable from the other.
14. **`use` on a machine is a code-execution grant** — owner-only until granted, never
    offline-eligible, fail-closed in placement and handoff.
15. **Invisible fails like nonexistent** — no command's error vocabulary distinguishes a hidden
    entity from a missing one; where existence *is* disclosed (a machine the principal can `see`),
    denied and unreachable must be distinguishable.
16. **System principals are user-less** — they read across owners, attribute every write as
    `system`, never widen visibility, and cannot be reached from any transport.
17. **Unbound external ingress has no identity** — an unbound Telegram chat yields no principal and
    is refused, never an operator fallback.

---

## 5. Consequences

### Positive

- The one decision ADR 3 deferred ("future user principal") closes at the only moment it costs a
  type definition rather than a protocol migration.
- D8's over-engineering pays off exactly as designed: the central multi-user risk (rights revoked
  while a collaborator is offline with queued writes) needs a **resolution change**, not a new
  mechanism, and Phase 2's conformance suite can prove it rather than build it.
- Revocation needs no reaper: one intersection, evaluated at apply, transitively stops agents,
  sub-agents, superagents and scheduled automations.
- Machine access, agent delegation and Telegram identity all land on one principal model, so
  unattended processes inherit the compute boundary with no second ACL to diverge.
- The shipped mail primitive is protected by being written down, rather than "tightened" by a
  well-meaning implementer reading the private default.

### Cost

- POD-315's matrix suite grows a dimension: four transports × principal classes × owner/grant
  outcomes, **including read denial**, which today is unrepresentable.
- Every contract with a `machine` policy must declare its verb, and the `use` ⇒ `online-only`
  derivation must be lint-enforced alongside D4's existing rules.
- Capability minting moves from a constant (`OPERATOR`) and a per-session function to a resolution
  over user, device, delegation chain and grants — more work per apply, on the hot path.
- Phase 1 must land `UserId`, accounts and per-user `client_sessions` before Phase 3's sharing UX
  exists, i.e. identity ships ahead of the product surface that uses it.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| An implementer reads "multi-user" as "multi-tenant" and adds `instance_id` columns or a tenant dimension to D2's instance-isolation clause | Stated in §1: ADR 1 D5 is unaffected, multi-user lives inside one instance. POD-304's annotation review rejects tenant columns. |
| Read denial is skipped because `authorize()`'s read short-circuit is invisible in review | D19.2 names the exact line; property 9 and the compliance checklist require read-denial coverage on all four transports. |
| Delegation resolution becomes a per-apply N-query walk and shows up as latency | Chain depth is bounded by spawn depth and the result is a pure function of (chain, grants, revision); cache keyed on ADR 2 D3's revision token, invalidated by grant changes. Correctness stays live-resolved — the cache may never outlive a revocation. |
| Someone "fixes" `mailSend` by scope-gating it | D20.1 ratifies it explicitly with the shipped comment quoted; a scope target on `mailSend` is a compliance-checklist failure. |
| Denied and nonexistent diverge accidentally as new commands land | The rule is general (D20.3) and lands on an existing `checkIssueAccess` branch; POD-315 must include an oracle test per target-taking command family. |
| ADR 9's decision numbers drift from the ones cited here | Cross-references are by decision *role* as well as number (e.g. "ADR 9 D6 — machine verbs"), and were checked against the landed `docs/adr/0009-identity-ownership-sharing.md` (D1 taxonomy, D3 classes, D4 default-closed, D5 delegation, D6 machine verbs, D7 cross-boundary, D8 superagent/system). POD-359 re-checks at pack reconciliation. |

---

## 6. Compliance checklist

Additive to ADR 3's security-properties checklist and acceptance list. In compliance when:

- [ ] Every principal is constructed as `(user, device, capability)`; no code path mints a
      capability without resolving a user or an explicitly user-less class.
- [ ] `OPERATOR` as an unconstrained ambient principal no longer exists on any live transport.
- [ ] A delegation is a server-minted record; tests prove a forged `onBehalfOf` / delegation
      reference / user id cannot escalate or rebind (POD-315 AC, extended from `origin.actor`).
- [ ] Apply-time re-authorization resolves the chain live; no stored "allow" bit, no capability
      snapshot, sub-agent chains covered, exactly one human at the root.
- [ ] An outbox entry drained after its delegator lost rights becomes `rejected` → `dead-letter`
      with a rights-specific reason code — never silently dropped (D9 invariants 1–3).
- [ ] Every write records actor **and** on-behalf-of, both from the transport; agent-created
      entities are owned by the `onBehalfOf` human.
- [ ] Role and ownership are evaluated conjunctively; a test proves `admin` alone does not read a
      private row, and an owner alone does not run an admin-grade command.
- [ ] `machine` contracts declare a verb; every `use` contract is `online-only` and lists no
      `outbox` exposure; placement and handoff deny rather than retarget.
- [ ] Owner and grant scopes are members of the existing closed scope set, evaluated by the same
      `authorize()` / `checkIssueAccess` path; reads are scope-gated, with denial covered on
      `trpc`, `cli`, `mcp` and `relay`.
- [ ] `mailSend` still carries no scope target; the human ceiling is enforced; addressing an
      invisible id fails identically to a nonexistent id.
- [ ] System principals have no `onBehalfOf`, are unreachable from every transport, and never modify
      owner/visibility/grants as a side effect; scheduled automations run delegated.
- [ ] An unbound Telegram chat yields no principal; `telegramBotToken` is admin-managed
      `secret-value`; `telegramChatId` is per-user.
- [ ] No `instance_id` (or equivalent tenant discriminator) appears on any capability, envelope,
      outbox entry or grant row.

---

## 7. Self-verification record

Checked on integration tip `2ddfec21`, 2026-07-29.

| Claim | Where verified |
|---|---|
| The only human principal today is unconstrained | `packages/domain/src/issue-authz.ts` — `export const OPERATOR: Capability = { role: 'admin', scope: { kind: 'all' } }` (line 47) and the file header comment "the **operator** … is unconstrained" |
| `Capability` has an actor half and no person half | `packages/domain/src/issue-authz.ts` — `interface Capability { role; scope; actorSessionId? }` (line 37); `actorSessionId` documented as "the session behind this call, when the caller is an agent (relay path)" |
| Reads are scope-free today | `packages/domain/src/issue-authz.ts` — `authorize()`: `if (action === 'read') return 'allow'` before any scope test |
| An `all`-scope capability short-circuits the row gate; an unknown target falls through to the role gate | `apps/server/src/issue-authz.ts` — `checkIssueAccess`: `if (caller.capability.scope.kind === 'all') return` and `if (!targetId || !issues.get(targetId)) return` (lines 51–53) |
| `subtree` is a reserved, already-enforced scope shape with an override path | `packages/domain/src/issue-authz.ts` — `IssueScope` union + `authorize()` subtree branch; `apps/server/src/issue-authz.ts` — `PRECONDITION_FAILED` "re-run with --outside-scope"; `apps/cli/src/agent-cli.ts` — `--outside-scope` flag (lines 81, 155) |
| The narrow spawned-for agent scope is already minted, without a user | `apps/server/src/modules/sessions/service.ts` — `capabilityForSession()` returns `{ role: 'worker', scope: { kind: 'subtree', rootId: issueId }, actorSessionId: sessionId }` (lines 1032–1042) |
| A client session is a device, not a person | `apps/server/src/migrations/schema.ts` — `clientSessions` = `token_hash`, `created_at`, `expires_at` (line 190); no user column |
| One password per instance, no accounts | `packages/runtime/src/auth-store.ts` — header "Single-user client-access password for the human UI channel"; `setPassword` / `verifyPassword` over a single hash file |
| Attribution is already stamped from the capability, never from input | `apps/server/src/relay.ts` — comment "stamped server-side via the capability (actorSessionId), never from input" (line 575) |
| `mailSend` is deliberately unscoped, role-gated | `apps/server/src/modules/issues/registry.ts` — `mailSend` def (line 1132) and the preceding comment "DELIBERATELY NOT scope-gated (no `target`) … cross-issue sends must not require --outside-scope … so the role gate still applies" (lines 1128–1131) |
| `mailInbox` marks unread only for a subtree scope rooted at that issue | `apps/server/src/modules/issues/registry.ts` — `mailInbox` (line 1149): `markRead = capability.scope.kind === 'subtree' && resolveRef(id) === capability.scope.rootId` |
| `mailClaim` is subtree-gated through the shared check | `apps/server/src/modules/issues/registry.ts` — `mailClaim` (line 1170), `scope: 'issue'`, in-handler `checkIssueAccess(...)` (line 1184) |
| Event subscriptions follow the `mailSend` pattern | `apps/server/src/modules/issues/registry.ts` — subscription block comment "like mailSend they are 'write' with no existing-issue target — the source-within-subtree / own-row checks live in the handlers" (lines 1195–1199) |
| Machines have no owner and no grant list | `apps/server/src/migrations/schema.ts` — `machines` = `id`, `name`, `hostname`, `token_hash`, `created_at`, `last_seen_at`, `inventory_json` (line 147) |
| The all-in-one host machine is seeded as `local` | `apps/server/src/modules/machines/service.ts` — `ensureLocalMachine(hostname = LOCAL_MACHINE_ID, …)` (line 346), importing `LOCAL_MACHINE_ID` from `../../local-machine`, which re-exports `readOrCreateDaemonSecret` from `@podium/runtime/local-machine` |
| Telegram inbound is "one chat id = one implied identity" | `apps/server/src/modules/messaging/telegram.ts` — `const wantChatId = this.config.chatId.trim()` (line 221); `if (msg.chatId !== wantChatId) continue` (lines 240, 252) |
| `telegramBotToken` and `telegramChatId` are sibling settings strings today | `packages/runtime/src/settings.ts` — `notifications.telegramBotToken` (line 272), `notifications.telegramChatId` (line 274), both `z.string().default('')` |
| A claim-code ceremony already exists, binding a chat to the **instance** | `apps/server/src/modules/settings/service.ts` — `startTelegramSetup` / `pollTelegramSetup` mint a code, poll `getUpdates`, write the matched `chatId` into settings ([spec:SP-5d81], lines 232–285) |
| `PairingManager` is the single-use, short-TTL code precedent | `apps/server/src/hub/pairing.ts` — `class PairingManager` with `mint()` / `redeem()`, 600s default TTL, single-use regardless of outcome (line 15) |
| Superagent state carries no owner | `apps/server/src/migrations/schema.ts` — `superagentMessages` (line 119), `superagentThreads` (line 130): no user or owner column |
| `CommandScope` / `CommandAction` are the leaf contract vocabulary this amendment extends | `packages/protocol/src/commands.ts` — `type CommandAction = 'read' \| 'write' \| 'manage'`; `type CommandScope = 'issue' \| 'repo' \| 'global'`; `CommandDef` fields |
| D7 already anticipated a user principal | `docs/adr/0003-command-security.md` §D3 transport table — `trpc` row reads "operator / future user principal" |
| D4 already classes spawn/attach/harness exec/file ops as `online-only` | `docs/adr/0003-command-security.md` §D4 delivery table |
| D9 invariants forbid silent drop and require reason codes | `docs/adr/0003-command-security.md` §D9 invariants 1–3 |
| ADR 1 D5 makes `InstanceId` a deployment partition | `docs/adr/0001-authority-ownership.md` §2 D5 |
| ADR 7 places external chat adapters outside the three peer planes, with no tRPC for the external edge | `docs/adr/0007-plane-inventory.md` lines 94 and 291 ([spec:SP-5d81]) |
| Human decisions encoded here | `docs/multi-user-readiness.md` — header block (private default), §3.1.1 (visibility sets, default-closed), §3.1.2 (open items), §3.1.3 A1–A5 (delegation), §3.1.4 M1–M6 (machine verbs), §3.1.5 (mail ratification, human ceiling, consistent error, reparent open), §3.1.6 S1–S6 (superagent, Telegram, system, scheduled), §3.2 (no identity today, minimum shape) |

---

## 8. Status / sign-off path

| Stage | Owner |
|---|---|
| Proposed | POD-1073, under POD-359 |
| Pack reconciliation + index (ADR 9 numbering, amendment listing) | POD-359 |
| Human approval | POD-359 human gate |
| Implemented | Phase 1 (POD-288 / POD-304); Phase 2 (POD-306 conformance: revoked-while-offline); Phase 3 (POD-311 / POD-315 / POD-316 / POD-290) |
