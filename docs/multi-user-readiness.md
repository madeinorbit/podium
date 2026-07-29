# Multi-user readiness of the v3 rewrite

**Assessment date:** 2026-07-28 · **Assessed against:** ADR pack 1–8 (all *Proposed*, unsigned at
POD-359) + `docs/rearchitecture-v3.md` at the integration head.

> ## HUMAN DECISION (2026-07-29)
>
> **Build the visibility machinery in Phase 2, and default to private.** Personal-by-default is a
> product goal in its own right — the sidebar is "my tasks", and that is what makes Podium usable
> for organising your own work, not only a permissions concession.
>
> Per-feature behaviour ("how does sharing actually work for issues / sessions / workflows") is
> **deliberately deferred** and decided feature by feature.
>
> This is §3.1 **option C's mechanism with option B's default**, and the distinction matters for
> Phase 2's bar: the machinery is **load-bearing from day one, not inert**. There is no grace period
> in which skip-placeholders and share/unshare events are unexercised — they carry the product's
> normal path at the POD-308 cutover. Conformance coverage for them is a gate condition, not a
> follow-up.
>
> **Consequence that cannot be deferred (see §3.1.1):** "everything private" cannot be taken
> literally — pairing, repos, and settings are shared infrastructure and would break. The
> *principle* is settled here (private default + a named tenant-visible infrastructure set); *which
> classes are in that set* is per-feature and stays deferred.

**New requirement being tested against the plan:**

1. **Basic multi-user, one tenant** — every object has an owner; sessions and other objects can
   be shared between people.
2. **Realtime collaboration** — several people streaming the same session, seeing each other's
   presence/cursors, eventually typing concurrently. The last part need not ship, but the
   architecture must not close the path.

---

## 1. Verdict

**The spine of the rewrite is right, and multi-user makes it more valuable, not less.**
Server-as-sole-Authority, one sync kernel with ordered revisions, command contracts with a
transport-derived principal and apply-time re-authorization, planes as port contracts, provenance
on the envelope, and the D7 normalization law are the same shape every serious multi-user product
converges on (Linear, Figma LiveGraph, Replicache/Zero). Route A stays correct: retrofitting
multi-user onto the five bespoke replication paths the rewrite is deleting would be strictly worse
than finishing the rewrite.

**But four decisions in the pack were justified *by* the single-operator assumption**, and that
justification is now void. Two of them are wire-shape decisions, which means they are cheap now and
expensive after the Phase-2 cutover (POD-308). The pack is unsigned; this is the cheapest moment in
the whole programme to fix them.

| # | Decision | Status under multi-user |
|---|---|---|
| 1 | ADR 2 D2 — feed is unscoped, every replica gets every change | **Must be revisited now.** Wire shape. |
| 2 | No user identity anywhere in the model (auth is one shared password → one `OPERATOR`) | **Must land in Phase 1.** Model shape. |
| 3 | ADR 1 D2/D3 — expected-revision default + closed field-LWW set | Decisions may survive; **rationale is void** and half the LWW inventory should become per-user state instead. |
| 4 | ADR 7 — no presence/room concept; `presence` is `{visible: boolean}` per connection | Additive, but must be designed with #1 (same subscription primitive). |

Nothing in the pack **closes** the realtime-collaboration path. One clause reads as if it does
(ADR 1 D1's rejection of a CRDT backbone) and needs an explicit carve-out so an implementer does
not cite it to block co-editing later — see §4.

---

## 2. What is already right, and gets *more* right

Worth stating plainly, because these were arguably over-engineered for one operator and now pay off:

- **ADR 3 D7 — principal from authenticated transport only.** Payload identity is inert. This is
  the precondition for any multi-user authz; it is already decided and already tested-for.
- **ADR 3 D8 — apply-time re-authorization on every outbox drain.** "Rights revoked while offline
  still apply on reconnect" was a thin risk with one user. With sharing it is the central risk
  (someone is un-shared while a collaborator is offline with queued writes). Already decided.
- **ADR 1 D1 — Authority arbitrates, Replica never does.** With N writers this stops being tidiness
  and becomes the only thing that makes convergence provable.
- **ADR 2 D3 — per-entity `revision`.** Needed for expected-revision; also the dependency key for
  D7.3 replica-side views, and the natural presence/ACL invalidation key.
- **ADR 2 D9 — slow replica demoted to resync.** More clients, more slow clients; the answer is
  already designed and already cheap because bootstrap is the most-tested path.
- **ADR 4 D7 — normalization law + derivation locality.** `IssueWire` embedding `SessionMeta[]` is
  O(world) per change with one user; with N users each holding a different slice it is O(world × N).
  Deleting entity-in-entity nesting is a prerequisite for scoped feeds, not merely a perf fix.
- **Session control model already exists.** `Session.controllerId` (first attacher takes control,
  `requestControl` transfers, `controllerChanged` broadcasts, `clientCount` published) is a working
  one-driver/N-watchers substrate. Shared terminals are the *cheapest* collaboration deliverable in
  the product and are ~80% built; what is missing is identity on it, not mechanism.
- **ADR 1 D5 — InstanceId is a deployment partition.** Multi-user in one tenant lives **inside** one
  instance. D5 stays correct as written; the "explicit columns reserved only if a future shared
  multi-tenant store is adopted" clause is *not* triggered by this requirement. Worth restating so
  nobody confuses multi-user with multi-tenant and starts adding `instance_id` columns.

---

## 3. The four things that must change

### 3.1 The feed is unscoped, and filtering it is a protocol break (ADR 2 D2)

ADR 2 D2 ratifies an unscoped firehose with an explicit rationale: *"Podium today is
single-tenant-shaped … so every client of an authority is entitled to the whole feed. Authorization
is therefore enforced at the authority boundary."* Owners + explicit sharing move the authorization
boundary **inside** the feed. The premise is gone.

ADR 2 also states, correctly, why this cannot be patched later with a `WHERE` clause:

> Per-client filtering is **incompatible with the contiguity contract** … Filter the stream per
> client and every suppressed row is an *invisible permanent gap* that triggers an endless heal
> loop. … if scoping is ever needed … it MUST arrive with **watermarks**. Adding a filter without a
> watermark is a protocol break, not an optimization.

So the trigger ADR 2 itself named ("the trigger is multi-tenancy or an entity kind a client must not
see") has fired. What this implies concretely:

1. **Watermarks land in Phase 2**, not "deferred". The authority tells a replica *"your cursor
   advanced to N"* for suppressed ranges so contiguity holds over a filtered view. Global `seq`
   stays global; only visibility is per-principal. This preserves D1's `(feedId, epoch, seq)` triple
   and D7's healing ladder unchanged.
2. **Visibility changes are not entity changes — and the feed cannot express them today.** Granting
   or revoking a share makes entities appear/disappear for a principal *without their `revision`
   moving*. This needs either (a) a per-principal `rescope` control frame that resolves to rung 2 of
   the D7 ladder (re-bootstrap, scoped), or (b) an explicit `evict` op distinct from `remove` — a
   removal from *your view*, not a deletion. `remove` cannot be reused: the replica would render it
   as "deleted", and D5 already warns that soft-delete and tombstone "look identical from a distance
   and are not". This is a third member of that family.
3. **Bootstrap becomes per-principal.** D6's chunked bootstrap is unaffected in shape; the authority
   just reads its scoped slice at `(feedId, epoch, seq)`.
4. **ADR 4 D7.3's rationale narrows but survives.** It rejects a server-side IVM engine because
   "the client already holds the world". Under scoping the client holds *its slice*; replica-side
   joins still work within the slice, and a join that would cross the boundary is a join the user is
   not allowed to see anyway. Keep D7.3; amend the sentence.

**There is a legitimate cheaper fork here, and it should be decided explicitly rather than drifted
into:**

| Option | What it means | Cost |
|---|---|---|
| **A — tenant is the read boundary** | Everyone in the tenant can *read* everything; ownership governs *writes*, attribution, and UI defaults. Feed stays unscoped exactly as D2 ratifies. | Near-zero protocol work. Ships inside the current plan. |
| **B — sharing is real** | Private by default; explicit grants; the feed carries only what you may see. | Watermarks + rescope semantics + scoped bootstrap in Phase 2, before POD-308. |
| **C — mechanism now, policy later** | Build the watermark + rescope machinery during Phase 2; choose the default and the per-class policy separately. | Between A and B; the machinery cost is paid, the policy cost is deferred. |

**DECIDED (2026-07-29): C's mechanism, B's default.** The machinery lands in Phase 2 and the default
is private. Per-feature sharing behaviour is decided later, per class.

The decision cannot be deferred past the Phase-2 wire cutover without paying for a second protocol
migration — and this programme exists because of half-finished migrations.

#### 3.1.1 "Everything private" has a hard floor: infrastructure is tenant-visible

Taken literally, a private-by-default rule breaks *some* of the product on day one: advisory locks
are coordination names everyone must resolve identically, and instance settings and feature flags
are properties of the deployment, not of a person. These are not "objects with an owner" — they are
substrate.

**Correction (2026-07-29, human direction): machines are NOT in that set.** An earlier draft of this
section put machines, repos and harness inventory under tenant-visible infrastructure, reasoning
that a machine is paired to the instance rather than to a person. That conflates two verbs that must
be separate — see §3.1.4. The corrected sets:

| Set | Default visibility | Examples (indicative — membership is per-feature and deferred) |
|---|---|---|
| **Personal** | Private to owner; shareable | Sessions, issues + comments + tracker mail, drafts, conversations, handoff bundles, artifacts |
| **Per-user state** | Never shared; one row per user (§3.3) | `readAt`, snooze, pins, tab order, sidebar/tab layout, personal preferences |
| **Owned compute** | Private to owner; grantable per verb (§3.1.4) | Machines, and everything that is a per-machine fact: repos/prefixes, worktrees, harness + model inventory, host metrics |
| **Deployment substrate** | Tenant-visible; `manage` is admin-grade | Advisory locks, instance settings, feature flags, machine *existence* for admins |
| **Secrets** | Server-only, never replicated (ADR 1 D6 unchanged) | API keys, pairing token preimages, managed credentials |

The tenant-visible floor is deliberately **small**. Everything that is a fact *about a machine*
inherits that machine's scoping rather than carrying its own.

The *principle* is decided; *membership* is the per-feature call that stays deferred. Two rules make
the deferral safe:

1. **Default-closed, like ADR 3 D3's exposure rule.** An entity class with no declared visibility
   class is **personal/private**, not tenant-visible. Forgetting to classify must fail toward
   privacy, never toward exposure.
2. **The set is declared on the ownership matrix (ADR 1), with a totality test** — same shape as
   POD-304's existing per-field annotation obligation. A new entity class cannot silently escape
   classification.

#### 3.1.2 Questions this default sharpens (deferred, but they will arrive together)

Not blocking, and explicitly per-feature — recorded so they are not rediscovered mid-implementation:

- **Cross-boundary graph edges.** An issue may be blocked by, parented to, or duplicated-with an
  issue you cannot see. Options: hide the edge, or show it as an opaque reference ("blocked by an
  issue you don't have access to"). The second is usually right — hiding the edge makes the
  tracker lie about why something is blocked — but it leaks *existence*, which is a policy call.
- **Existence leaks generally.** Counts, machine session lists, "this worktree is in use", lock
  holders, and issue ref-letter allocation all reveal that *something* exists. Decide per surface
  whether existence is private or only content is.
- **Agent identity / acting on behalf of.** Settled in principle 2026-07-29 — see §3.1.3. Lands with
  the user principal in Phase 1; the sharing UX stays deferred.
- **Inheritance on create.** A session spawned under an issue, a comment on an issue, an artifact on
  a session: does it inherit the parent's owner and grants, or the actor's? Inheriting the parent is
  almost certainly right (otherwise sharing an issue does not share its work), but it must be
  declared per class.

#### 3.1.3 Agents are principals, delegated from a human (human direction 2026-07-29)

**Direction:** *"Agents need to have their own identity and visibility. Probably initially inherited
from the creating user."* Adopted, with four refinements that change the implementation and one
reuse that avoids building a second identity system.

**A1 — Delegated, evaluated live; never a copied snapshot.** An agent principal is
`(agentIdentity, onBehalfOf: UserId, scope)`. Its effective rights are **its own scope intersected
with its human's *current* rights**, resolved at every apply — not a capability frozen at spawn.

*Why this and not a snapshot:* a snapshot means revoking a person leaves their unattended agents
running with rights the human no longer holds — a privilege leak with no cleanup trigger, in a
system where agents run for hours without supervision. Live resolution makes "revoke the human"
transitively disable their agents with no reaper to forget to write.

*Cost: none.* ADR 3 D8 already re-authorizes on every apply, including outbox replay. It only has to
resolve a delegation chain instead of reading a stored capability. This is the case D8 was
over-engineered for under single-user, arriving.

**A2 — The human is a ceiling, not the default grant.** An agent may never exceed its delegator, but
its default scope is **what it was spawned for** — its session, its issue, that issue's subtree —
not everything its human can see. Widening is explicit.

*Why:* least privilege matters more, not less, for unattended processes. This is also already the
shipped instinct: `OPERATOR` is `admin`/`all` while relayed agents carry a constrained `Capability`,
`IssueScope.subtree` is reserved and already enforced by `authorize()`, and `--outside-scope` /
`overrideScope` already models the deliberate widening step (ADR 3 D2 confirmation rules).

**A3 — Attribution is a pair, not a substitution.** Every write records **actor** (which agent) *and*
**on-behalf-of** (which human), both stamped from the transport principal per ADR 3 D7, never from
payload. Collapsing to one loses distinctions the product already depends on: human-set `name`
outranks agent-set (`nameSource`, [spec:SP-eb60]), and `humanQuestionAskedBy` is server-authoritative
precisely so "did a person or an agent ask this?" stays answerable. `Capability.actorSessionId` is
the existing seam for the actor half; the on-behalf-of half is new.

**A4 — Agent output is owned by the delegating human.** Owner of entities an agent creates = its
`onBehalfOf` human; actor = the agent. Otherwise the personal sidebar — the stated product goal of
the private default — would not show work your own agent did for you, and retiring an agent session
would orphan its issues. Consistent with the parent-inheritance rule above.

**A5 — Reuse `SessionBinding` as the identity lifecycle (POD-323, Phase 5).** The agent principal is
born and retired with its binding rather than in a parallel identity system. Delegation then
survives handoff between machines for free, and Phase 5's binding work absorbs it instead of
inventing a second lifecycle with its own aliases and history.

**Chaining.** Sub-agents delegate from their parent agent by the same rule — never widening, human at
the root of the chain. The chain has exactly one human, and the effective-rights intersection is
evaluated over the whole chain.

**Consequences for the pack:** ADR 3 D7's principal table gains an agent row with a delegation
reference (not a free string — D7's "payload identity is inert" rule holds); ADR 1's matrix "Permitted
writers" column keeps its role classes but gains owner/actor/on-behalf-of as distinct annotations;
ADR 9 carries the principal taxonomy (human / agent-delegated / machine / system).

#### 3.1.4 Machines are owned compute: separate `see` / `use` / `manage` (human direction 2026-07-29)

**Direction:** *"machines need to be able to be limited in access too. E.g. a personal mac shouldn't
be accessible for everyone in the team to run agents."* Adopted; it corrects §3.1.1's earlier
classification.

**M1 — Three verbs, not one visibility bit.**

| Verb | Grants | Default holder |
|---|---|---|
| **see** | The machine exists; health/liveness; "your session ran there" attribution | Owner + admins (fleet management) |
| **use** | Spawn, reattach, attach a PTY, execute harness commands, read/write files, take a worktree | **Owner only, until explicitly granted** |
| **manage** | Rename, unpair, rotate pairing token, remove from fleet | Owner + admins |

ADR 3 D2 already carries the vocabulary — actions `read` / `write` / `manage`, with `machine` as a
declared resource scope kind. What is missing is an **owner and a per-machine grant list**, rather
than the verb being gated by instance-wide role alone.

**M2 — `use` is a code-execution boundary, not a privacy boundary.** This is why it cannot be
folded into ordinary object visibility. Running an agent on someone's machine means arbitrary
execution on their hardware with **their** local environment: SSH keys, `gh`/git identity, dotfiles,
cloud CLI sessions, and whatever private repositories are checked out there. The blast radius is a
different kind from "can read my issue", and the model must not make them look like the same
toggle.

**Unresolved and worth surfacing in product copy rather than solving in the model:** even with `use`
granted, the *local* credentials remain the machine owner's — they are not separable from the host.
Server-injected material (managed `accounts` credentials, API quota) *is* separable, and should
plausibly bill the delegating human rather than the machine owner; that is a per-feature call. But
granting `use` is inherently a high-trust act and should read as one in the UI, not as a checkbox.

**M3 — A newly paired machine is private to its pairer.** Pairing runs from that person's laptop
with their join code, so they are the owner. Sharing is a deliberate later act. This is the
default-closed rule of §3.1.1 applied consistently, not an exception to it.

**M4 — The all-in-one case is the sharpest one.** When the server runs on someone's Mac, the `local`
daemon (`LOCAL_MACHINE_ID = 'local'`, `readOrCreateDaemonSecret`) *is* that Mac. Without M1, anyone
who can authenticate to the server inherits execute on the machine hosting it. That must fail
closed: the host machine is owned by whoever set the instance up, and is not ambient team compute.

**M5 — Placement and handoff fail closed.** Spawn UI must not offer machines the principal lacks
`use` on; session handoff (POD-323/POD-644) to such a machine is denied, not silently retargeted;
and an unreachable-vs-unauthorized distinction must be visible, since "denied" and "offline" produce
the same empty list otherwise.

**M6 — Agents inherit this for free.** Under §3.1.3 A1/A2 an agent's rights are its human's current
rights intersected with its scope, so an agent can only spawn on machines its human may use, and a
sub-agent cannot reach past its parent. The compute boundary therefore holds for unattended
processes with no additional mechanism — which is the main reason to express machine access as
grants on the same principal model rather than as a separate fleet ACL.

#### 3.1.5 Cross-boundary agent writes: mostly already answered (human observation 2026-07-29)

**Observation:** *"Agent mail follows exactly that permission, no? It inherits from the issue which
inherits from the user right now. So initially it can't even see other issues."* Correct — and the
codebase already implements the distinction this needs, deliberately and with the reasoning written
down. This retires the "cross-boundary agent mail" item previously parked here.

**Verified in `apps/server/src/modules/issues/registry.ts`:**

| Command | Authz shape today | Reading |
|---|---|---|
| `mailSend` | `action: 'write'`, **no `target`** — comment: *"DELIBERATELY NOT scope-gated … addressing ANOTHER issue is the whole point of it — cross-issue sends must not require `--outside-scope`. Treated like `create` … so the role gate still applies."* | **Send-without-read.** Already the right primitive. |
| `mailInbox` | `action: 'read'`; marks unread only when `scope.kind === 'subtree'` **and** the scope root *is* that issue | You consume only your own mailbox. |
| `mailClaim` | `action: 'write'`, `scope: 'issue'`, target resolved in-handler via the shared `checkIssueAccess` | Acting on a message is subtree-gated. |

**Decision:** the unscoped send is bounded by the **human ceiling, not the agent's scope**. An agent
may mail any issue **its delegating human can see**, including outside its own subtree; it may not
mail an issue that human cannot see. This preserves today's coordination behaviour exactly in the
single-user case (one human, everything visible) while preventing injection into a colleague's
private workspace.

**Consistent-error rule:** mailing an issue that is invisible to the principal must fail
*identically* to mailing a nonexistent id. Divergent errors turn the send path into an existence
oracle — the §3.1.2 existence-leak class, arriving at a concrete site.

**Also retired by the same reasoning:**

- **Dependency / graph edges** (`discovered-from` and friends) **do** carry a scope target, so they
  already route through `overrideScope` → `confirm-required` (ADR 3 D2). No new mechanism.
- **Event subscriptions** follow the `mailSend` pattern already — write, no target, own-row and
  source-within-subtree checks in the handler.

**Two cases A2's default does NOT describe — decide, don't discover:**

1. **Instance-wide agents.** ~~Open.~~ **Settled 2026-07-29 — see §3.1.6.**
2. **Subtree scope is dynamic.** Reparenting an issue under an epic widens the working agent's
   visibility with nobody having decided it. Probably acceptable — a subtree is by definition a
   moving set — but it makes **`reparent` a permission-affecting operation**, which is not how it
   currently reads to its users. At minimum it should be surfaced; at most it warrants a
   confirmation when the move crosses an owner boundary.

#### 3.1.6 The superagent is per-user; system automations are not delegated at all (human direction 2026-07-29)

**Direction:** *"Superagent is also per user."* Adopted. This settles §3.1.5's open case 1 and
splits the "instance-wide agent" bucket into two classes with different answers.

**S1 — The superagent is a broad-scope delegation.** It is "you, automated": principal delegated
from its human, with scope = **everything that human can see**, rather than §3.1.3 A2's narrow
issue-subtree default. Ceiling and scope coincide. A2's narrow default is for agents spawned *for a
task*; the superagent is spawned *for a person*, and the two justifiably differ.

**S2 — Superagent state joins the personal set.** `superagent_threads`, `superagent_messages`,
`superagent_queued_inputs`, `superagent_pending_turns` (verified in
`apps/server/src/migrations/schema.ts`) carry no owner today. Per-user means owner + private by
default: my threads never surface in your sidebar, the same property that motivated the private
default in the first place.

**S3 — Attention routing becomes per-user by construction.** Needs-human questions, approvals and
notifications reach *their* human. This is a consequence of S1/S2, not additional work — but it is
work that would otherwise have had to be built deliberately.

**S4 — Telegram splits along the line ADR 1 §6 already drew, and gains an authentication problem.**
`notifications.telegramBotToken` stays `secret-value`, server-only, admin-managed.
`telegramChatId` (today a single `z.string().default('')` in `PodiumSettings`) is routing config,
already classified as preference-not-secret — it moves to per-user.

The **non-obvious consequence**: per-user superagent makes the Telegram edge an **authentication
surface**. Today the inbound direction is effectively "whoever holds the bot is the operator" — one
chat id, one implied identity. With several people, an arriving message must resolve to a *user*
before anything acts on it. Per ADR 3 D7 (principal from authenticated transport only) that requires
a real binding ceremony — a claim code issued in the web UI and presented to the bot, the same shape
as machine pairing ([spec:SP-5d81] adapter; `PairingManager` is the precedent) — and **unknown chats
must fail closed**, never fall back to an operator identity. Small work; easy to skip because the
feature already "works" single-user.

**S5 — System automations are NOT delegated, and must not be.** The steward, expiry jobs, boot
reconcile and derived-field maintenance have no human behind them and should not be given one. ADR 1
already declares a `system` writer class for exactly this. The rule that makes it safe under
private-by-default:

> **System principals may read across owners, but every write is attributed as `system` and lands in
> the scope of whatever it acted on. They never widen anyone's visibility and never act *as* a
> person.**

This is what keeps §3.1.5's "instance-wide agent" worry from reopening: the things that genuinely
need instance-wide reach are system jobs, and system jobs do not need — and must not have — a human
identity.

**S6 — Scheduled automations are delegated like the superagent.** They have a creator, so they run
as that person with that person's current rights. They inherit §3.1.3 A1's live evaluation for free:
revoke someone's access and their cron agents stop, with no reaper to write and none to forget.

### 3.2 There is no user identity anywhere in the model

Verified in code, not inferred:

- `packages/runtime/src/auth-store.ts` — one password per instance (`setPassword` / `verifyPassword`),
  no accounts.
- `client_sessions` (`apps/server/src/migrations/schema.ts`) — `token_hash`, `created_at`,
  `expires_at`. **No user column.** A client session is a *device*, not a person.
- `packages/domain/src/issue-authz.ts` — `OPERATOR: Capability = { role: 'admin', scope: { kind: 'all' } }`,
  documented as "the cookie-authed human … is unconstrained".
- ADR 1's matrix "Permitted writers" column is role-*classes* (`operator`, `agent-session`,
  `daemon`, `system`). There is no `owner` column and no `UserId` brand anywhere in the pack.

Consequence: every attribution field in the system is currently device-level or role-level —
`humanQuestionAskedBy`, `deletion_source`, `nameSource: 'user'`, close/unblock actor. Under
multi-user these must name a person.

ADR 3 D7 already writes "operator / **future user principal**" for the tRPC row, so the seam is
anticipated but undecided. **This must be decided before Phase 1**, because Phase 1's entire thesis
is that `packages/model` is the one authoritative definition of every field. Landing Phase 1 with a
single-operator vocabulary bakes the wrong model into the one place the rewrite promises never to
have to redo.

Minimum shape:

- `UserId` brand in `packages/model` (POD-301 family), `User` aggregate, real accounts + per-user
  `client_sessions`, invite/role (`admin` | `member` at least — secrets management per ADR 1 D6 is
  an admin-grade action once there is more than one human).
- `owner` + `visibility` (+ a `grants` edge table) as **new normative columns on ADR 1's matrix**,
  applied per aggregate. This is an ADR 1 amendment, not an annotation.
- Principal becomes `(user, device, capability)`. ADR 3 D2's `IssueScope` already reserves a
  `subtree` shape and `authorize()` already enforces it — extend that closed set with owner/grant
  scopes rather than inventing a parallel check.

### 3.3 Half of the field-LWW inventory should become per-user state instead

ADR 1 D3's closed LWW set is: session `archived`/`workState`/`readAt`, `snoozedUntil`, composer
draft body, pins, tab order, preference keys. **Under multi-user, almost all of those are per-person
state, not shared state.** `readAt` is obviously mine. So are snooze, pins, tab order, and
preferences. Once they are keyed `(userId, entityId)` the conflict disappears entirely — each user
writes their own row, `single-writer` applies, and the LWW carve-out shrinks toward empty.

That is a *simplification*, but only if it happens in Phase 1. If Phase 1 lands these as singletons,
every one of them is a later table migration plus a wire change plus a replica migration.

The composer draft is the interesting exception: it is genuinely shared-surface state, and
"field-LWW whole draft body" means one co-author's text silently overwrites another's. That is the
first place multi-user turns a documented decision into a data-loss bug — see §4.

ADR 1 D2's rationale ("low multi-writer contention (single-operator product)") is void. The
*decision* — one home + expected-revision — probably still stands; but reject-and-rebase UX
(POD-316) moves from a rare edge case to a routine path, which changes its priority, not its design.

### 3.4 Presence and rooms have no home in the plane inventory

ADR 7's **stream** plane is exactly the right port for presence: ephemeral, lossy on disconnect,
blank offline, best-effort fan-out. The plane is right; the inventory is thin. Today
`presence` is `{ type: 'presence', visible: boolean }` per connection, and fan-out is either
per-session-attach (PTY frames) or global (entity deltas). Figma-style co-presence needs:

- identity-carrying presence (who, where, what selection/cursor),
- **rooms** — subscribe to presence for *this* session / issue / document,
- per-room fan-out at cursor rates (~30–60 Hz) that never touches the funnel or the oplog,
- presence as strictly derived from live connections (no durable rows, no tombstones).

The room/subscription primitive is the *same* primitive scoped feeds need in §3.1. Design them
together, implement at POD-387 (plane ports) / POD-317 (gateway). Adding rooms later to a gateway
built for two fan-out modes is the kind of retrofit this programme is trying to stop doing.

---

## 4. Does anything close the realtime-collaboration path?

**No — but one clause reads as if it does and must be carved out explicitly.**

ADR 1 D1 rejects "CRDT backbone (Yjs/Automerge) for metadata", and ADR 2 quotes the reasoning:
*"merging 'session 12 is busy' is meaningless — metadata is server/daemon-authoritative observation,
not collaborative text."* **That reasoning is correct and stays correct.** Daemon observations must
never be merged. But it is stated at a scope ("no CRDTs") that an implementer will later cite to
block co-editing a description field, which is a different problem with a different answer.

The carve-out that keeps the path open, and is compatible with everything else in the pack:

> **Collaborative text is a per-document ordered op stream, sequenced by the Authority.**
> Ops are commands; the Authority assigns order and appends them to the feed; the Replica applies
> them in order. The Replica still never arbitrates — it applies an ordering someone else decided.

This is a **new conflict class in ADR 1's vocabulary** (`op-stream`, alongside `exp-rev`,
`field-LWW`, `single-writer`, `append`, `cmd`) applied to a *small, named* set of fields
(composer draft, issue description/notes). It does not require a CRDT library on day one — an
authority-sequenced op log gives convergence for a shared document without one, and leaves room to
swap in a real CRDT if offline concurrent editing is ever wanted.

Two things to write down while deciding it:

1. **Op streams break ADR 2 D5's retention argument if they are naively head-pruned.** D5's safety
   proof depends on the bootstrap snapshot being *positive state* — "the replica gets the truth from
   a snapshot instead". For a document, "the truth" is the materialized document, so the same proof
   works **only if ops compact into a materialized document snapshot**. ADR 2 explicitly parks
   "log compaction beyond head-pruning … needs its own ADR". A document entity that carries its
   materialized value plus a bounded recent-op tail keeps D5 intact; anything else needs that ADR.
2. **Concurrent PTY input is not a text-merge problem.** Two people typing into one terminal is a
   *control* problem, and `controllerId` + `requestControl` already model it. The right product
   answer is explicit control handoff with identity, not character merging.

---

## 5. Recommendation

**Do not sign the ADR pack as-is.** It is a good pack; it is a good pack for a single-operator
product, and it says so in its own rationale in at least four places. Signing it and then
discovering multi-user in Phase 3 produces exactly the failure mode POD-279 exists to end.

Proposed sequence:

| When | Work |
|---|---|
| **Before POD-359 sign-off** | ~~Decide §3.1~~ **Decided 2026-07-29: C's mechanism, B's default** (see header + §3.1.1). Add **ADR 9 — identity, ownership and sharing**, carrying the visibility-class split and its default-closed totality test. Amend **ADR 1** (owner/visibility columns; per-user state family; `op-stream` conflict class + CRDT carve-out), **ADR 2** (scoped feed + watermarks + `evict`/rescope; un-defer per-client scoping), **ADR 3** (user principal + roles; secrets as admin-grade), **ADR 7** (presence/rooms on the stream plane). This is days of doc work against a programme measured in months. |
| **Phase 1 (POD-288)** | `UserId` brand; `User`/account aggregate; `owner`/`visibility`/`grants` on the matrix; per-user state family keyed `(userId, entityId)` absorbing readAt/snooze/pins/tab-order/preferences. |
| **Phase 2 (POD-289)** | Watermarked scoped feed + scoped bootstrap **in the kernel, before the POD-308 wire cutover**. Conformance suite gains: grant/revoke mid-session, scoped gap heal, and "revoked while offline with queued writes" (which D8 already handles — prove it). |
| **Phase 3 (POD-290)** | Policy = ownership/grants; share/unshare commands; per-user attribution stamped from the principal (D7 already forbids taking it from payload). |
| **Phase 4 (POD-291)** | Gateway rooms/subscriptions at POD-387/317 — one primitive serving both scoped feeds and presence fan-out. |
| **Phase 5** | Identity on `controllerId`; input attribution; take-control policy. **Shared terminals are shippable here and are the cheapest visible collaboration win.** |
| **Phase 6 (POD-293)** | Scoped replica-side views; presence/cursor UI. |
| **Deferred, unblocked** | Concurrent text editing. Reserved by the `op-stream` class; built when wanted. |

**Cost honesty.** This widens Phases 1–3 materially — a user/account subsystem, an authz dimension
on every aggregate, and a scoped-feed mechanism that Phase 2 currently does not plan to build. The
alternative is finishing the rewrite as specified and then doing a fourth pass that touches every
table, every wire projection, and every command policy. Given that this programme's own charter is
"no intermediate state left behind", folding it in is the cheaper of the two, and the ADR pack being
unsigned is what makes it cheap.

**What would a from-scratch "Figma-like multi-user" architecture look like?** Server-authoritative
ordered change feed, scoped per-principal subscriptions, ephemeral presence on a separate lossy
channel, commands with server-side authz and idempotency, and CRDT/OT confined to text. That is
this architecture plus scoping plus a text-op class. The plan is not wrong; three seams need
widening before they are welded shut.
