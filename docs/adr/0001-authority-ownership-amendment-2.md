# ADR 1 — Amendment 2: instance identity, and the four axes it must never be confused with

- **Status:** Proposed. POD-359 closed 2026-07-30 with the pack's **human sign-off gate
  suspended** for the autonomous POD-279 fan-out
  (`docs/agents/rewrite-fanout-protocol.md` §1), the coordinator recording sign-off in its
  place — see `docs/adr/README.md`. This amendment was authored *after* that sweep and is
  therefore **not** covered by its tracker reconciliation; it inherits the same suspended
  gate and needs the same human confirmation whenever the pack next gets one.
- **Date:** 2026-07-30
- **Deciders:** architecture rewrite ADR pack (POD-359); the human decisions of 2026-07-28/29
  recorded in `docs/multi-user-readiness.md`; human sign-off before Phase 1
- **Issue:** POD-733 (4.9a Instance identity decision record), leaf of POD-645 (4.9 Instance
  vs machine identity model)
- **Consumers:** POD-734 (4.9b Fleet instance threading — implements directly from this
  file), POD-301 (branded ids), POD-304 (matrix annotations + totality test), POD-321
  (declarative composition root), POD-318 (4.2 fleet service / placeholder retirement),
  POD-1079 (4.11 machine ownership and grants), POD-1070 (ADR 9), POD-1071 (ADR 1
  Amendment 1)
- **Amends:** ADR 1 **D5** (instance identity) — by *constraint and composition*, not by
  reversal: **no clause of D5 is overturned.** Continues ADR 1's decision sequence at
  **D16**; Amendment 1 owns D8–D15.
- **Related ADRs:** ADR 1 Amendment 1 (owner / visibility / grants columns; D13 machines as
  owned compute; D14 not-multi-tenancy), ADR 9 (principal taxonomy, five visibility
  classes, default-closed totality test, machine verbs), ADR 2 + its Amendment 1 (feed
  identity; the per-principal scoped feed and watermarks), ADR 3 + its Amendment 1
  (principal from transport; policy vocabulary), ADR 5 (peer roles and role-specific auth),
  ADR 8 (package placement for brands vs runtime bootstrap)
- **Specs:** [spec:SP-15aa] multi-instance runtime isolation (the spec this amendment is
  cross-referenced from); [spec:SP-0371] hub/node federation deferred
- **Base tip verified:** `201dd989` (`issue/279-integration`), 2026-07-30
- **File discipline:** this amendment owns **only** this file plus a single "Amended by"
  line in `docs/adr/0001-authority-ownership.md`. No index edits, no ledger edits, no edits
  to ADR 2 / 3 / 5 / 8 / 9 or to Amendment 1.

---

## 0. Read this first, or read nothing

Three sentences, because everything below is a footnote to them.

> **1. Multi-user is not multi-tenancy.** Podium is becoming multi-user **inside one
> instance**. `InstanceId` is a **deployment partition** — it separates whole Podium
> universes from each other. `UserId`, visibility and grants are an **ownership
> partition** — they separate *people* inside one universe. They are different axes at
> different layers and neither is a substitute, an implementation, or an optimisation of
> the other.
>
> **2. ADR 1 D5 is unaffected, and this amendment does not soften that.** D5.3 reserves
> explicit instance columns "only if a future shared multi-tenant store is adopted". That
> clause is **not triggered** — not by multi-user, not by owner columns, not by grants, and
> not by anything in this file. Amendment 1 D14 already says so normatively; **D18 below
> re-states it as this file's own conclusion** so that a reader who arrives here first
> cannot leave with the opposite impression.
>
> **3. This document is the one place in the pack that legitimately discusses an explicit
> `instance_id` column, and it decides AGAINST one.** Nothing here is licence to add such a
> column, or a per-instance discriminator by another name, anywhere. If you are citing this
> amendment to justify one, you are citing the document that forbids it — see D18's fence
> and the compliance checklist in §5.

The failure mode this file exists to prevent is named explicitly in
`docs/multi-user-readiness.md` §2: *"worth restating so nobody confuses multi-user with
multi-tenant and starts adding `instance_id` columns."* The reason it needs a whole
amendment rather than a sentence is that POD-645's questions **sound** like tenancy
questions ("does the machine row carry an InstanceId?"), and answering them without
drawing the axis map first is how the wrong answer gets a citation.

---

## 1. Context

### 1.1 What POD-733 was asked to decide

Instance identity ([spec:SP-15aa], `packages/runtime/src/instance.ts`) landed **after** the
rewrite plan froze. ADR 1 D5 placed it. POD-645's drift audit then asked four residual
questions, and POD-733 is the record that answers them:

| # | Question | Answered by |
|---|---|---|
| 1 | Does `InstanceId` join the branded-id taxonomy and the model vocabulary, or stay a runtime-only concern? | **D17** (D5.1 stands; the brand gains a *placement constraint*) |
| 2 | Do fleet / machine records carry an explicit `InstanceId` column, or stay implicitly scoped by the per-instance state DB? | **D18** (implicit; composed with owner + grants in §3) |
| 3 | Ownership-matrix treatment: who mints it; never replicated across instances by definition | **D16** (+ **D16.1** equality, **D16.2** as-built vs target) + **D19** |
| 4 | How does instance identity appear — or explicitly not appear — on the wire? | **D20** |
| — | Cross-instance sharing / federation | **D21** (out, stated twice, because the word "sharing" now collides) |

### 1.2 What changed under the questions since POD-645 was written

Two things, and both change the *shape* of the answers rather than their direction:

1. **The taxonomy now has a person in it.** When POD-645 was filed, `packages/protocol/src/ids.ts`
   declared `MachineId`, `SessionId`, `IssueId`, `RepoId`, `ConversationId`, `MutationId`,
   `ThreadId` and no user. POD-1075 lands `UserId` and the `User`/account aggregate in
   Phase 1; ADR 9 D1 carries the principal taxonomy (human / agent-delegated / machine /
   system, with superagent as a broad-scope delegation rather than a fifth kind); ADR 1
   Amendment 1 D8 makes owner / visibility class / grants **normative matrix columns**.
   Question 1 therefore has to be answered against a taxonomy with **two identity axes** in
   it — which is exactly the condition under which the two get conflated.
2. **The machine row is gaining an owner and a grant list.** ADR 1 Amendment 1 D13 and ADR 9
   D6 make machines **owned compute** with `see` / `use` / `manage`; POD-318 lands the owner
   column with the pairing principal (readiness §3.1.4 M3 requires pairing to record who
   paired the machine, with a one-time migration assigning existing machines to the first
   admin); POD-1079 lands the grant list and the verb checks. So question 2 lands on a table
   that will carry an owner and grants — which is the condition under which per-instance
   scoping gets *implemented as* ownership, or vice versa.

Note for anyone reasoning from an older draft: readiness §3.1.1's earlier classification of
machines as tenant-visible infrastructure was **explicitly corrected on 2026-07-29** by human
direction. Do not reason from it. Machines are owned compute; only their **existence**, for
admins, is deployment substrate (Amendment 1 D13.6).

### 1.3 What is true in the code today (verified on tip `201dd989`)

Every fact below was read out of the tree, not inferred. They are the ground the decisions
stand on, and several of them are load-bearing for D19 and D20.

**Instance identity is a process-configuration fact.**

- `packages/runtime/src/instance.ts`: `DEFAULT_INSTANCE_ID = 'default'` (L13),
  `INSTANCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/` (L14), `resolveInstanceId()` reads
  `PODIUM_INSTANCE` (L29), `selectInstance()` strips a global `--instance` from argv.
- It derives, deterministically, from that one string: the state root
  (`instanceStateDir`, L80 — `~/.podium` for `default`, else the XDG state tree), the
  install root, the CLI name (`instanceCommandName`, L105), systemd unit names
  (`instanceServiceName`, L112 — `podium-<id>-<role>.service`), durable PTY/scope labels
  (`durableSessionLabel`, L127) and an fnv1a-derived port triplet
  (`defaultInstancePorts`, L156).
- The state dir is **claimed**, not registered: `ensureInstanceStateIdentity` (L212) writes
  `instance.json` mode `0600`, and `assertInstanceStateIdentity` (L193) makes a
  wrong-instance state dir a hard failure.
- `server.ts` (L149–150) and `daemon.ts` (L361–363) both `resolveInstanceId()` and
  `ensureInstanceStateIdentity()` **before** service construction.

**Instance identity has zero protocol presence.** `rg instanceId packages/protocol/src`
returns **nothing**. No wire message, no envelope, no handshake frame, no id brand mentions
it. This is not an accident to be tidied up; D20 ratifies it.

**Machine identity is minted by the daemon and stored by the server, once, on each side.**

- `apps/daemon/src/identity.ts` L35: `data.machineId = randomUUID()`, persisted immediately
  at `<stateDir()>/daemon.json` mode `0600`. Its own doc comment states the contract: the
  id "is the join key a server uses to recognize a returning daemon, so it must outlive both
  token rotations **and the server's own database**."
- `stateDir()` (`packages/runtime/src/config.ts` L162) is `instanceStateDir()`. So
  `daemon.json` — and therefore the machine's identity — **lives inside the instance's state
  root**. One host running two instances' daemons has two `daemon.json` files and therefore
  **two MachineIds for one physical machine**, by design.
- `machines` (`apps/server/src/migrations/schema.ts` L189) is
  `(id, name, hostname, token_hash, created_at, last_seen_at, inventory_json)` — **no
  owner, no pairer, no grant list, and no instance column.**
- `repos` (L199) is keyed `(machine_id, path)` with `machine_id` defaulting to the
  `'__local__'` placeholder — a per-machine fact with no scoping of its own.
- `LOCAL_MACHINE_ID = 'local'` (`packages/runtime/src/local-machine.ts` L13) is the
  constant id of the host the server runs on; `LOCAL_PLACEHOLDER = '__local__'` (L19) is the
  pre-adoption placeholder POD-318 retires.

**`repo_id` is derived from content, not from any partition.** `apps/server/src/repo-id.ts`:
`normalizeOriginUrl` (L21) canonicalises a git origin, and `deriveRepoId` (L64) returns
`repo_${sha1_16(normalized)}` when an origin normalizes (L70), falling back to
`repo_${sha1_16('path:' + machineId + ':' + path)}` (L71). **Two different instances that
know the same repository compute the same `repo_id`.** This matters more than it looks —
see D19's second rule.

**The pairing relation is recorded on exactly one side, and named by neither.**

- `authenticateDaemon` (`apps/server/src/modules/machines/service.ts` L155ff): a `pair`
  frame redeems a one-time code, mints a token, and `upsertMachine`s with `sha256(token)`;
  a `hello` frame is accepted iff `getMachineByToken(frame.machineId, frame.token)` (L176).
- `getMachineByToken` (`apps/server/src/store/machines.ts` L80) reads `token_hash` **for
  that id** and fails closed when the row is absent — `if (!row) return false`.
- On failure: `{ ok: false, reason: 'unknown machine — re-pair' }` (service.ts L184).
- The handshake frames (`packages/protocol/src/messages/daemon-handshake.ts`) are
  `pair{code, machineId, hostname, name?}` and `hello{machineId, token, hostname}`. Neither
  carries an instance id, and neither reply does.
- Daemon side (`apps/daemon/src/daemon.ts` L929–943): on `helloRejected`, if the operator
  supplied a fresh `--pair-code` the daemon drops the stale token and re-pairs **once**;
  otherwise it calls `stopNoReconnect` (L943) and stays down. Its own comment names the
  cause: *"revoked, OR (common right after an all-in-one → daemon switch) a token minted by
  a **DIFFERENT server**."*

### 1.4 The known bug this record has to be able to prevent

Compose the five facts above and the bug falls out mechanically:

> A remote daemon holds a `machineId` and a token that are, by design, meant to outlive the
> server's database. The server holds the **only** durable record of the pairing — one
> `machines` row, containing the only copy of the token hash. Lose that row (a re-created
> state DB, a restore from before pairing, a `deleteMachine` unpair, a server started
> against a **different instance's** state dir, or an all-in-one host promoted to a split
> deployment) and `getMachineByToken` returns `false` because `!row`. The daemon receives
> `helloRejected: 'unknown machine — re-pair'`, has no pair code, calls `stopNoReconnect`,
> and **never reconnects**. Recovery requires a human to mint a fresh code in the server UI
> and restart the daemon with it — which is precisely what a headless remote machine has no
> one available to do.

**And the one automatic fallback that exists cannot save this case.** `PairingManager`
(`apps/server/src/hub/pairing.ts`) holds codes **in memory only** — its own comment says
"single-use/in-memory … Lost on restart by design" — and `redeem` deletes the entry
**regardless of outcome**, so a code is spent even when it is rejected as expired. Compose
that with the trigger list: losing the `machines` row essentially always involves a server
restart, and a restart wipes every outstanding code. So the daemon's one-shot
`--pair-code` fallback (daemon.ts L933–941) is unavailable exactly when it is needed, and a
retry with the same code fails a second time for a different reason. Recovery therefore
**cannot** be specified as "the operator supplies a pair code"; the distinguishing fact has to
live at a durability tier that survives both the restart and the database — which is what
D19.4's pairing root is.

Two things about this bug matter for the decisions below, and they pull in **opposite**
directions:

1. **It is an identity-axis bug.** The daemon cannot distinguish "my machine was
   deliberately unpaired" from "I am talking to a different instance than the one that
   paired me" from "the server lost its database", because the only thing it is told is a
   string, and the handshake names no partition. Three different situations with three
   different correct responses arrive as one indistinguishable rejection. A record that left
   instance, machine and pairing blurred together would not have surfaced that — which is
   why D19 states the pairing relation's true key explicitly.
2. **It is NOT fixed by putting `InstanceId` on the wire, and D20 refuses to pretend
   otherwise.** Adding an instance id to the `hello` frame would let the *message* be more
   descriptive, and would change nothing about the failure: the row is gone, so
   authentication fails identically whatever else the frame says. The durability of the
   pairing relation is a **machine-axis** obligation with a named owner (D19.4). Reaching
   for the deployment axis to fix a machine-axis defect is the exact conflation this file
   forbids — and it is how a "diagnostic" wire field becomes a load-bearing one two phases
   later.

---

## 2. Decisions

Numbering continues ADR 1's sequence. **D16–D21.** Amendment 1 owns D8–D15; base decisions
D1–D7 keep their numbers and meanings.

### Decision D16 — Four axes, one table. Nothing in the fleet model may straddle two

**Decision.** Podium has exactly **four** identity-or-scoping axes below the level of a
product entity. They are declared here once, in full, and every fleet or machine field must
be assignable to exactly one of them:

| | **Instance** | **Machine** | **Process role** | **User** |
|---|---|---|---|---|
| **What it is** | A deployment partition: one whole Podium universe (one Authority, one state DB, one port triplet, one service set) | A host that can execute work — "owned compute" (ADR 9 D6) | The kind of process (`server` / `daemon` / `janitor` / `update`) within one instance | A person with an account (ADR 9 D1) |
| **Type** | `InstanceId` brand (D5.1), **configuration-only** (D17) | `MachineId` brand | `InstanceServiceRole` union — **not an id** | `UserId` brand (POD-1075) |
| **Who mints it** | **Not minted — selected.** A human supplies it at deploy time via `PODIUM_INSTANCE` or `--instance`; when neither is set, `resolveInstanceId` **supplies `default` automatically**, so the label on an unconfigured deployment is a fallback, not anyone's deliberate act. No process ever mints a *new* id; the first process to claim a state root merely **records** the selected one (`ensureInstanceStateIdentity` → `instance.json`) | **The daemon**, once, `randomUUID()` in `daemon.json` (identity.ts L35) — **in the target scheme.** Today the local machine is the documented exception: the **server** provisions `machines.id = 'local'` at startup with a server-minted secret (`ensureLocalMachine`, service.ts L409; server.ts L226). POD-318 deletes that exception — see D16.2 | Nobody — it is a compile-time constant of the entry point, surfaced in unit and command names | **The server**, at account creation / invite (ADR 9 D1.2) |
| **Scoped by** | Nothing above it. It **is** the outermost scope — but see D16.1: the *carrier* of the partition is the resolved **state root**, and the id is a label on that root, not a global name for it | Its instance — because its identity file lives in that instance's state root, and its row lives in that instance's DB | Its instance | Its instance |
| **What equality means** | **Nothing, by itself.** See **D16.1** — equality of instance-id strings is *not* evidence that two processes belong to one deployment, and no code path treats it as such | "The same daemon identity file", hence the same host **as far as this instance's fleet is concerned** — **not** "the same physical hardware": one host paired to two instances is two MachineIds, correctly. Authoritative only inside the instance whose DB holds the row (D16.1) | "The same **role class**" — and nothing more. **Role carries NO identity uniqueness at any scope** — not per deployment, not per host (D16.3). N live daemon processes in one deployment is normal; two on one host are possible. A role never identifies a process | "The same person" — **within one instance only.** Server-minted, so equal `UserId` values in two instances are unrelated strings (D21.3) |
| **Never** | Replicated, synced, wire-borne, or a column (D18, D19, D20) | A stand-in for a person (ADR 9 D1's rejected alternatives), nor for a partition | An id, an owner, or a security principal | A partition. `UserId` never separates deployments |
| **If conflated with the others** | See the failure table below | | | |

**The conflation failure table** — each cell is a real, nameable breakage, not a style
concern:

| Conflation | What breaks |
|---|---|
| **Instance ≡ User** ("multi-user means multi-tenant") | An `instance_id` column lands on every table carrying one constant value; the owner dimension is then implemented twice, incompatibly; and the actual product requirement — sharing *between people in one workspace* — becomes unexpressible, because each person is their own universe with their own ports, units, state root and daemons ([spec:SP-15aa]). D18's fence exists for this cell alone. |
| **Instance ≡ Machine** (or instance encoded into `MachineId`) | Overturned already by D5's rejected alternatives, and the code shows why: two instances on one host legitimately hold two MachineIds for that host, and SP-15aa's isolation suite pins machine UUIDs per state root. Encoding the partition into the join key makes "is this the same host?" and "is this the same deployment?" one unanswerable question. |
| **Machine ≡ Process role** | The all-in-one case (readiness §3.1.4 M4). The server is a *role*; `LOCAL_MACHINE_ID = 'local'` is a *machine*. Treat the host as "the server's own box" rather than as somebody's owned compute and every authenticated user inherits execute on the operator's laptop. Amendment 1 D13.4 fails this closed. |
| **Machine ≡ User** ("the machine acts as its owner") | A daemon token becomes a credential for a person's whole account. ADR 9 D1 rejects it explicitly: the machine principal reports observations and carries **already-authorised** work; it never originates writes as a person. |
| **Instance ≡ Process role** | `instanceServiceName(role, id)` composes two independent coordinates into one unit name. Collapse them and `podium-a-daemon` vs `podium-b-daemon` stops being derivable, which is how one instance's `systemctl restart` stops another instance's daemon — the isolation SP-15aa's acceptance proof exists to refuse. |
| **User ≡ Process role** | The `OPERATOR` constant, which is exactly the artefact ADR 9 D1.5 retires: "someone authenticated" becoming `{role: 'admin', scope: 'all'}` is a role standing in for a person, and it makes ownership unenforceable and attribution a lie. |

#### D16.1 — Equality is CONTEXTUAL. Never treat an id string as proof of co-membership

**Normative, and aimed squarely at POD-734.** The runtime establishes **no global identity
relation** for any of the four axes. Each axis's equality is decidable only inside a stated
context, and outside that context equal strings mean nothing at all.

**What the code actually enforces for `InstanceId`** (`packages/runtime/src/instance.ts`,
verified):

| Situation | Enforced behaviour |
|---|---|
| Same state root, marker id ≠ selected id | **Hard fail.** `assertInstanceStateIdentity` throws — "instance 'x' cannot use `<dir>`: it belongs to instance 'y'" |
| **Same selected id, two different state roots** | **Both accepted.** There is no registry, no uniqueness index, and nothing that could observe the second root. `instanceStateDir` returns `PODIUM_STATE_DIR` **verbatim whenever it is set**, so the id → root mapping is not injective and is not even a function of the id |
| Unmarked, non-empty root, named instance | Refused unless `PODIUM_ADOPT_STATE=1` (`ensureInstanceStateIdentity`) |
| Unmarked root, `default` | Marked in place, for backward compatibility |
| Two hosts both resolving `default` | **Ordinary and expected.** Every unconfigured deployment is called `default` |

So the *only* relation the runtime enforces is **"this state root belongs to this instance
label"** — a check between one selected label and one directory. It follows that:

1. **The partition's carrier is the resolved state root, not the label.** Two processes belong
   to the same deployment iff they resolve to the **same state root** (hence the same DB, the
   same derived ports, the same unit names). The label is an *attribute of a root*, not a name
   that identifies one.
2. **Across hosts, the label carries nothing whatsoever.** A server on host A and a daemon on
   host B are both very likely to be instance `default`, and they share no state root at all.
   What makes them one deployment is that **the daemon is paired to that server's endpoint** —
   the association is the pairing relation plus the endpoint it dialled, and D19.4's pairing
   root is what makes it verifiable. Equal labels across hosts are a coincidence of defaults.
3. **Therefore: POD-734 must never compare instance-id strings to decide that two processes,
   two rows, or two files belong to one deployment.** The decidable predicates are: *within a
   host*, same resolved state root; *across hosts*, the pairing relation. A raw string
   comparison is not a substitute for either, and code that uses one is asserting a global
   identity the runtime does not provide.

**Uniqueness scope, and what an equality check is ENTITLED to conclude.** The compact form,
for the moment an implementer is about to write `a.id === b.id`:

| Id | Unique within | An equality check may conclude | It may NOT conclude |
|---|---|---|---|
| `InstanceId` | **Nothing.** Not unique in any scope the runtime can observe — it is a *label on a state root*, and `default` is the label of every unconfigured deployment on earth | Only that two things carry the same label | That they share a deployment, a database, a port triplet, a fleet, or anything else. Use the resolved **state root** (same host) or the **pairing relation** (across hosts) |
| `MachineId` | One instance's `machines` table | The same daemon identity file, hence the same host **within that instance** | Anything across instances — and today the constant `'local'` is byte-equal in *every* instance while naming different hardware |
| `UserId` | One instance's `User` aggregate | The same person **within that instance** | Anything across instances (D21.3: no identity portability) |
| `InstanceServiceRole` | **Not unique anywhere as an identity** — no scope, including a host. The intended *managed* topology is one server and one daemon per `(host, instance)`: a systemd cardinality, plus a real port-bind constraint on the **server** only (D16.3) | The same role **class** | That two processes are the same process, or that only one may exist — in the deployment or on a host. And note `MachineId` does **not** rescue this: it identifies the *logical enrollment*, not a process (D16.3 rule 2) |

**And symmetrically, for the other two id axes** — stated here because the same mistake is
available on each:

- **`MachineId`** is authoritative **only inside the instance whose DB holds the row.** In the
  target scheme it is a `randomUUID()`, so accidental collision is negligible — but negligible
  collision is not the same as cross-instance meaning, and today the local machine makes the
  point concretely: `LOCAL_MACHINE_ID` is the literal constant `'local'`, so **every** instance
  has a machine whose id is byte-equal to every other instance's, describing different
  hardware. Cross-instance `MachineId` equality is therefore not merely unproven, it is
  currently *guaranteed to be misleading* for one row in every deployment.
- **`UserId`** is server-minted inside one instance (ADR 9 D1.2). Equality means the same
  person **within that instance**. Across instances it is an unrelated string, which is
  exactly D21.3's no-identity-portability clause seen from the equality side.

**Rationale.** The original draft of this decision asserted that equal instance ids resolving
to different state dirs is "an error, not a merge, and `assertInstanceStateIdentity` hard-fails".
That is **false**: the assertion runs in the opposite direction — it protects a *root* from the
wrong *label*, not a label from being reused across roots — and with `PODIUM_STATE_DIR` set
there is no relation between label and root at all. Left standing, it would have licensed
POD-734 to treat `instanceId === instanceId` as a co-membership test, which would silently
pass for every pair of unconfigured deployments in existence, all of which are called
`default`. Correcting it is the difference between threading a value and inventing an
authority.

#### D16.2 — As-built exceptions are transitional. `local` and `__local__` are invalid MachineIds and must die before branding reaches them

**Decision.** The axis table above states the **target** scheme. Two as-built exceptions exist
today, are transitional, and must not be read as the model:

| | As-built today (tip `201dd989`) | Target, after POD-318 |
|---|---|---|
| **Local machine id** | The **server** provisions it: `ensureLocalMachine` upserts `id: LOCAL_MACHINE_ID = 'local'` with a **server**-minted secret (service.ts L409–419), called at boot (server.ts L226). The bundled local daemon then presents that constant. The daemon does **not** mint it | The local daemon **auto-pairs over the loopback bootstrap secret exactly like a remote one**, minting its own `randomUUID()` in `daemon.json`. **One** identity scheme, no special case |
| **Pre-adoption rows** | `LOCAL_PLACEHOLDER = '__local__'` is the `machine_id` default on `repos` (schema L200) and the value on rows created before a real machine adopts them; `adoptPlaceholderRows` re-homes them at boot | Gone. A one-shot migration re-homes existing rows and the boot heals (`retargetPlaceholderSessions`, `adoptPlaceholderRows`, `backfillRepoIds`, `healLocalOrigins`) are **deleted**; a fresh install never mints a placeholder |

Three normative rules follow:

1. **`'local'` and `'__local__'` are INVALID `MachineId` values.** They are sentinels — one a
   server-side stand-in for "the host I am running on", the other for "no machine yet". Neither
   names a daemon identity, and neither may survive into the target model.
2. **ORDERING CONSTRAINT, and it is the sharp one.** `MachineId` is declared as
   `z.string().min(1).brand<'MachineId'>()` — it validates **length, not shape** — so
   `MachineId.parse('local')` **succeeds today** and yields a perfectly well-typed
   `MachineId`. Branding a sentinel does not flag it; it *launders* it, after which no type,
   test, or reviewer can distinguish the sentinel from a real machine identity, and the
   migration that was supposed to delete it has lost its handle. Therefore:

   > **POD-318's migration must retire `local` and `__local__` BEFORE `MachineId` branding is
   > applied at any site that can hold either value.** POD-360's characterization inventory is
   > where those sites are enumerated, and each such site must be marked in that inventory as
   > *blocked on POD-318* rather than as an ordinary schema flip for POD-301/POD-361–363. If
   > branding must land first for an unrelated reason, the sentinel sites are carved out and
   > left as raw strings until the migration lands — a narrower, visible debt, rather than a
   > well-typed lie.

   This is not a hypothetical reachability argument: `'__local__'` is a **column DEFAULT in
   three tables** — `sessions.machine_id` (schema L43), `conversations.machine_id` (L154) and
   `repos.machine_id` (L200). The database *manufactures* the sentinel for any insert that
   omits the column, so branding those sites freezes it into the type system from three
   directions at once, and POD-360's inventory reached the same conclusion independently. This
   amendment states the constraint normatively so that **POD-361 and POD-318 cannot each assume
   the other handled it** — the failure mode of two streams both believing an ordering
   dependency is someone else's.

3. **This amendment's own tables are marked accordingly.** §3.2 lists both sentinels under a
   *transitional* heading with their retirement owner, and does **not** classify them as
   ordinary machine identities.

**Rationale.** Blocker: the earlier draft said flatly that the daemon mints `machines.id`, and
§3.3 normatively described first boot as auto-pairing "as `LOCAL_MACHINE_ID`" — i.e. it wrote
the transitional exception into the target model, in the one document POD-318 and POD-734 will
implement from, and simultaneously classified `__local__` as a machine identity. Combined with
a brand that accepts any non-empty string, that is a direct path to `'local'` becoming a
permanent well-typed `MachineId` in a scheme whose whole point was to delete it. Separating
as-built from target, and attaching the ordering constraint to POD-360's inventory where the
sites are actually listed, is what makes the retirement enforceable rather than aspirational.

#### D16.3 — Role multiplicity is per HOST, not per deployment. N daemons is the normal case

**Decision.** The process-role axis carries no uniqueness constraint at the deployment level:

**What a deployment is, precisely** — because D16.1 already settled it and the first draft of
this sub-decision contradicted it:

> A deployment is **one Authority**: one server process, its one database, its one feed, and
> its one endpoint. A machine is **a member of that deployment iff it is paired to that
> endpoint** — the pairing relation is the membership fact (D19.4's enrollment ledger is where
> it is durably recorded). Hosts are **not** joined by sharing a state root: the server host
> has its own state root, and **every paired daemon host has its own local state root** with
> its own `instance.json` and `daemon.json`. A multi-host deployment therefore spans **several
> state roots**, one per host, and that is its normal shape.

Two corollaries, stated because the draft got both backwards:

- **A paired remote daemon with its own local state root is NOT another deployment.** It is a
  member of the deployment whose server it is paired to. Only the *server's* state root holds
  the Authority's DB, feed and enrollment ledger.
- **Two hosts both labelled `default` may be one deployment or two, and the label never says
  which.** Server-plus-its-paired-daemon is the one-deployment case; two unrelated servers is
  the two-deployment case. This is D16.1's rule applied — the label proves nothing in *either*
  direction, so the draft's "two hosts labelled `default` are two deployments" over-claimed
  just as badly as the error it was correcting.

**Managed topology versus what is actually enforced.** These are different statements and the
draft conflated them:

| | Claim | Status |
|---|---|---|
| **Intended managed topology** | Per `(host, instance)`: one `server` unit and one `daemon` unit, named `podium-<id>-<role>.service` (`instanceServiceName`) | **A supervision arrangement.** systemd will not run two copies of one unit, which is what makes the topology intended and predictable — but it is a property of the *service manager*, not of identity, and a process started by hand is outside it |
| **Server port triplet** (`defaultInstancePorts` → server / hook / agentRelay) | A second **server** for one instance on one host fails at bind | **Really enforced, for the server only.** Verified: the **daemon binds no listening port** — it dials out, and its per-instance runtime isolation is `ABDUCO_SOCKET_DIR` / `TMUX_TMPDIR` under the state root (`applyInstanceRuntimeEnv`). The triplet constrains nothing about daemons |
| **State-root claim** (`ensureInstanceStateIdentity`) | "Only one process may claim a root" | **FALSE — it is not a mutex.** It refuses a *mismatched* marker and otherwise returns the existing one, so any number of processes with the same instance label share a root happily. Its `wx` create races only over *writing* the marker, not over holding it |
| **Two live daemon processes for one instance on one host** | — | **Nothing in the runtime prevents it.** It is outside the managed topology and would contend over the durable-session sockets, but it is not refused by an identity check, and no code should assume it cannot happen |

| Scope | Constraint |
|---|---|
| **One deployment, across hosts** | **No constraint on daemons.** A normal multi-machine deployment runs **one daemon per paired machine**, all live, all members of that one deployment. The product's ordinary shape, not a degenerate case |
| **One deployment, the Authority** | Exactly one `server` is the Authority (ADR 1 D1). This follows from the Authority **being** one server endpoint / DB / feed that daemons pair *to* — **not** from role-name uniqueness, and **not** from every process sharing one state root |

Therefore, normatively:

1. **Role equality establishes the role class and nothing else.** It is not an identity test, and
   two live daemons of the same role are not in conflict — they are the fleet.
2. **`MachineId` + the pairing relation identify the LOGICAL MACHINE ENROLLMENT — the daemon
   *installation* — not a process, and not a connection.** This taxonomy contains **no durable
   process identity at all**, and none should be invented here. Two concurrent processes reading
   the same `daemon.json` present the *same* `MachineId` and the *same* pairing relation, so
   neither value can tell them apart. A particular **live process or connection** is therefore
   identified only by a **process-local or connection handle**, which is runtime state with no
   durable identity and no place on this axis map.

   *This is already how the code behaves, and reading it the other way would misread working
   code.* `MachinesService` keeps `daemons: Map<machineId, Send<ControlMessage>>`, and `attach`
   is a plain `set` — a second connection presenting the same `MachineId` **silently replaces**
   the first. `detach(machineId, send)` then guards with
   `if (this.daemons.get(machineId) !== send) return false`, whose own comment says the closing
   socket "is already superseded". That guard exists precisely because two connections for one
   enrollment are possible, and the discriminator it uses is the **`send` handle** — a
   connection handle — not the `MachineId`. So the registry is correctly read as
   *enrollment → its current connection*, never as *machine → its process*.
3. **POD-734 must not manufacture a process identity from either axis.** Threading
   `(instanceId, role)` into unit names, state paths, ports and durable labels is correct and is
   host-local by construction. Two distinct bugs are forbidden:
   - **From the role axis:** any check that rejects a second live daemon *in the deployment* — a
     registry keyed by role, a "the daemon" singleton, a uniqueness assertion on
     `(instanceId, role)` — breaks every multi-machine install.
   - **From the machine axis:** treating a `MachineId`-keyed live-process registry as proof of
     *one process per paired machine*. Keying by `MachineId` is fine and is what the code does;
     concluding that the entry therefore identifies a unique OS process is not. Anything that
     must survive a reconnect, distinguish two concurrent connections, or be torn down per
     process needs a connection handle, exactly as `detach`'s supersession check already does.

**Rationale.** The first draft said two live processes of one role in an instance are "a
conflict (port bind, state claim)". The parenthetical was the giveaway: port bind and state
claim are **host-local** mechanisms, so the conflict they produce is host-local, and the
sentence silently promoted a host-scoped constraint to a deployment-scoped one. Podium's whole
fleet model is N daemons per deployment; a record that says otherwise, in the document POD-734
implements role threading from, is an invitation to write the singleton that breaks
multi-machine.

The second draft then over-corrected in a way that contradicted D16.1: it re-derived the unique
Authority from "a deployment *being* one state root", which is only true of a single-host
install, and concluded that two hosts labelled `default` are two deployments — which would
classify a perfectly normal paired remote daemon, with its own local state root, as a separate
deployment. Both errors have the same root cause: reaching for a *local* mechanism (a port, a
directory, a marker file) to express a *distributed* fact. The Authority is one endpoint and one
feed; membership in it is the pairing relation; and everything host-local — ports, roots, unit
names, socket dirs — is supervision and isolation, not identity. Naming which claims are
actually enforced, and which are merely the managed arrangement, is what stops the next reader
from turning a systemd convention into an invariant.

**Rationale (D16 overall).** POD-645's four questions are each locally answerable and jointly misleading:
answer them one at a time and you get four defensible sentences that still permit an
implementer to believe instance scoping and user ownership are the same mechanism seen from
different angles. The axis table is the smallest artefact that makes that belief
contradictory rather than merely discouraged. It is stated as a *matrix* on purpose — the
mint/scope/equality/breakage columns are the four questions an implementer actually asks at
the moment they are about to add a column, and every one of them has a different answer per
axis.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Three axes (fold process role into machine) | The all-in-one case needs them separate: one machine hosts a server and a daemon, and it is the *machine* that is owned while the *roles* are what get supervised and named. Folding them is the third row of the failure table. |
| Two axes (deployment and ownership), leaving machine and role as details | Machines carry the `use` verb, which ADR 9 D6 M2 makes a **code-execution** boundary distinct in kind from privacy. An axis map that cannot show where code-execution authority lives cannot be used to check a fleet change. |
| Say it in prose instead of a table | The audience is an implementer mid-change with a column in hand. Prose about orthogonality is what the pack already had; the table is what makes a wrong answer visibly wrong. |

---

### Decision D17 — `InstanceId` stays a brand (D5.1 unchanged), and is a **configuration** type: never a field on an entity, projection, or payload

**Decision.** D5.1 stands: `InstanceId` **is** a branded model identity, validated by the
landed pattern, placed with the other brands in `packages/model` (ADR 8 / POD-301 family),
with process-bootstrap helpers staying in `@podium/runtime` and depending on or re-exporting
the brand. It does **not** revert to an untyped runtime string.

This amendment adds the constraint that keeps that answer from being misread, now that the
same brand file will also declare `UserId`:

1. **`InstanceId` is a *configuration* brand. `UserId` is an *entity* brand.** They live in
   the same file and belong to different categories. `UserId` names a row in the `User`
   aggregate, is a foreign key, appears in `owner`, in grant edges, in attribution pairs, and
   on the wire. `InstanceId` names **no row anywhere** and has no aggregate.
2. **Permitted positions for the brand — exhaustive.** Parameters and return types of
   process-bootstrap and derivation functions (`resolveInstanceId`, `selectInstance`,
   `instanceStateDir`, `instanceInstallDir`, `instanceCommandName`, `instanceServiceName`,
   `instanceUpdateTimerName`, `durableSessionLabel`, `defaultInstancePorts`,
   `instanceIdentityPath`, `readInstanceStateIdentity`, `assertInstanceStateIdentity`,
   `ensureInstanceStateIdentity`); the `InstanceStateIdentity` marker record persisted to
   `instance.json`; composition-root and service-construction signatures (POD-321,
   POD-734); and config/env parsing.
3. **Forbidden positions — also exhaustive, and this is the operative half.** The brand may
   **not** appear as: a column on any durable table; a field on any wire projection,
   envelope, or protocol message; a field in any replica store or client-local row; a
   member of any command payload or its `expectedRevision` neighbourhood; a key or key
   component of any per-user state row or grant edge; a member of any composite key helper
   in `ids.ts`.
4. **Therefore `InstanceId` enters the model *vocabulary* and not the model *matrix* as an
   ownable thing.** It keeps exactly one matrix row — ADR 1 §1's `InstanceId (partition)`
   row, whose owner/visibility/grants cells Amendment 1 §3 already fills in as
   `none — substrate` / `deployment-substrate` / `none; selection is a deploy-time act`.
   **That row is unchanged by this amendment** and D19 explains why it is the right
   classification rather than merely the inherited one.
5. **POD-301's obligation is bounded accordingly.** POD-301 flips `z.string()` id fields to
   brands. There is no `instanceId` **field** to flip — the audit will find none in
   `packages/protocol`, and finding none is the **pass** condition, not a gap. POD-301's
   work on `InstanceId` is limited to *declaring* the brand alongside the entity brands and
   adopting it at the runtime call sites in item 2.

**Rationale.** "Is it a brand?" and "does it appear in the data model?" read as the same
question and are not. A brand is a compile-time nominal type; declaring one costs nothing
and buys the thing D5's rationale wanted — `InstanceId` cannot silently flow into a
`MachineId` parameter, which is the second row of D16's failure table caught by the type
checker instead of by an incident. But a brand sitting in the same file as `UserId`,
`SessionId` and `MachineId` **looks** like a peer of theirs, and the natural next move for
an implementer adopting brands across the schema is to look for the field it annotates. The
answer has to be written down as an exhaustive permitted/forbidden pair, because "runtime-only
concern" (D5's rejected alternative) and "field on a row" (D18's rejected alternative) are
both wrong, and the correct position sits between two documented errors.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Revert to a runtime-only untyped string (no brand) | D5's own rejected alternative, unchanged: brandless strings re-create the dual-definition problem ADR 4 kills for every other id, and leave the taxonomy question permanently open. It would also make D16's instance↔machine confusion invisible to the compiler. |
| Full peer of `UserId` / `MachineId`: brand **and** an `Instance` aggregate with a row | D5's second rejected alternative. Instances do not sync to each other, so a replicated `Instance` entity would invent a product surface that does not exist — and the moment it has a row, something will foreign-key to it. |
| Declare the brand in `@podium/runtime` only, keeping it out of `packages/model` | Splits the brand family across two packages for one member, and ADR 8 places brands in `model`. It would also imply the type is a runtime detail, re-opening the question D5.1 closed. |
| State the constraint as guidance ("prefer not to persist it") | The whole cost of this amendment is paid to stop one specific edit. Guidance does not survive a schema migration under delivery pressure; an exhaustive forbidden list is checkable, and §5 checks it. |

---

### Decision D18 — No `instance_id` column: isolation is by separate state DB. D5.3 is unchanged, and this file is not licence to widen it

**Decision.** D5.3 stands **exactly as written**: no `instance_id` column is required on
`machines` or any other fleet row while isolation is by **separate state DB** (implicit
scope). This amendment confirms it as its own conclusion, having composed it against the
owner and grant columns that are now arriving, and fences it:

> **THE FENCE.** No `instance_id` column — nor any per-instance discriminator under another
> name (`tenant_id`, `deployment_id`, `partition_id`, `workspace_id`, or an instance id
> concatenated into a composite key or a branded id) — may be added to any durable table,
> wire projection, replica store, command payload, per-user state row, or grant edge. This
> holds whether the motivation is multi-user, ownership, grants, sharing, "we are touching
> every table anyway", diagnostics, or symmetry with `MachineId`. **D5.3's reserved-columns
> clause is triggered only by a decision to adopt a genuinely shared multi-tenant store, and
> no such decision exists.** Making one would require its own ADR, its own authorization
> story, and its own migration plan; it is not reachable by amendment to this one, and it is
> certainly not reachable by citing this one.

**Why the answer survives the arrival of owner and grants — the composed row.** POD-318
lands `machines.owner` (the pairing principal; existing rows migrated to the first admin per
readiness §3.1.4 M3), and POD-1079 lands the per-machine grant list. The row an implementer
will actually be editing is therefore this:

| Column | Axis (D16) | Present today | Who writes it | What it scopes |
|---|---|---|---|---|
| `id` | **Machine** | yes (`machines.id`, schema L189) | daemon mints (identity.ts L35), server registers | The fleet join key |
| `name`, `hostname` | Machine | yes | daemon reports; operator renames (`manage`) | Nothing — display |
| `token_hash` | Machine (secret) | yes | server, at pair | Authentication of the machine principal |
| `last_seen_at`, `inventory_json` | Machine | yes | daemon observation | Nothing — liveness / capability |
| **`owner`** (`UserId`) | **User** | **no — POD-318** | server, from the **pairing principal** | Who may `use` it by default; who admins default to alongside |
| **grant edges** `(machineRef, granteeUserId, verb)` | **User** | **no — POD-1079** | server, from the granter (never exceeding the granter's rights) | Which other people hold `see` / `use` / `manage` |
| ~~`instance_id`~~ | — | **no, and never** | — | **Nothing it could scope.** Every row in this table is already in exactly one instance's DB; the column would hold one constant |

Three rules make the composition safe, and they are the operative content of this decision:

1. **Per-instance scoping is a property of the *store*; ownership is a property of the
   *row*.** The instance is *which database file you opened*. The owner is *a column in it*.
   These are different mechanisms at different layers, and the decision that follows is:
   **neither may be implemented as the other.** Specifically — an `owner` value must never
   encode, default to, or be derived from an instance id; and per-instance isolation must
   never be enforced by an ownership or grant check. An authorization bug and a deployment
   isolation bug have different blast radii, different tests, and different people
   responsible; a scheme in which one is expressed as the other has neither test.
2. **A missing owner is a privacy failure; a missing partition is impossible.** Under ADR 9
   D4 / Amendment 1 D9, an unclassified or unowned entity class fails **closed** toward
   privacy, and the totality test makes that a build failure. There is no corresponding
   failure mode for the instance axis, because a row cannot fail to be in the DB it is in.
   That asymmetry is the reason one axis needs a column and the other must not have one.
3. **Isolation is enforced where it already is: at the state-dir claim.**
   `ensureInstanceStateIdentity` / `assertInstanceStateIdentity` make a wrong-instance state
   dir a hard failure before any service is constructed (server.ts L149–150, daemon.ts
   L361–363). That is a **pre-service, fail-closed** check on the deployment axis. A
   `WHERE instance_id = ?` predicate would be a post-hoc, fail-open check on the ownership
   axis's machinery, in a database that by construction contains no other instance's rows —
   strictly worse, and easy to forget on one query out of hundreds.

**Rationale.** D5.3 already decided this; the value added here is that it has now been
decided *against the actual composed row*, at the moment the table is being opened for owner
and grants, by the issue that owns the question. That is the difference between a decision an
implementer can rely on and a decision they will reasonably suspect predates their situation.
The fence is in the decision text rather than a footnote because the citation risk runs in
one specific direction: this is the only document in the pack that legitimately discusses an
explicit instance column, so it is the only document that could be quoted out of context to
authorise one.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Add `instance_id` now, "since POD-318 and POD-1079 are touching the table anyway" | Every row would carry one constant under per-DB isolation — D5's own rejected alternative, arriving by a new route. Cheap to add, permanent to remove: once written it becomes a join key, then a wire field, then a protocol commitment. |
| Add it "for diagnostics" / to make cross-instance mistakes visible in the DB | Diagnostics belong in logs and error messages, which D19.4 requires and which cost no schema. A column added for diagnostics is indistinguishable, at the next migration, from a column added for scoping. |
| Add it only to `machines` (not other tables) as the one place two instances can collide on hardware | The collision is *desired* behaviour: one host paired to two instances legitimately holds two MachineIds (D16). A column would suggest the two rows describe one thing that should be reconciled — the exact join D5's rationale warns about. |
| Enforce per-instance isolation via the ownership/grant machinery (one synthetic "instance owner" principal) | Rule 1's prohibition, stated as a scheme. It makes a deployment-isolation failure look like an authorization miss, and it would put a code-execution boundary (`use`) and a deployment boundary behind one check with one bug budget. |
| Drop the brand and the row entirely, since there is no column | D17 and D19 answer this: the brand prevents a type-level conflation, and the matrix row is what satisfies the totality test. "No column" is not "no vocabulary". |

---

### Decision D19 — Instance identity is deployment substrate, minted by a human, and never replicated across instances by definition

**Decision.**

1. **Visibility class: `deployment-substrate`** (ADR 9 D3), owner `none — substrate`,
   grants `none`; its `manage` — selecting, creating, or retiring an instance — is not a
   product action at all but a **deploy-time act** performed with shell access, and is
   therefore admin-grade *a fortiori*. Amendment 1 §3 §1 already records these cells; this
   decision supplies the reasoning and confirms the classification satisfies ADR 9 D4's
   default-closed totality test (the class is **declared**, so the default never fires).
   - **Why substrate and not `owned-compute`,** the neighbouring class and the tempting
     answer: `owned-compute` exists because a *machine* has an owner and because `use` is a
     code-execution boundary that must be grantable per verb (ADR 9 D6 M1/M2). An instance
     has neither property. There is no verb to grant — you do not "use an instance", you
     *are inside one*; every action in the product already happens within exactly one
     instance, so a grant would have no operative meaning. And there is no owner it could
     take: the instance is the container in which owners exist, so making it owned would
     require a `UserId` from outside the partition that defines who users are. Instance
     settings, feature flags and advisory locks are already substrate for the same reason
     (readiness §3.1.1) — they are properties of the deployment, not of a person. Instance
     identity is the deployment.
   - **Machines, by contrast, stay `owned-compute`** (Amendment 1 D13, ADR 9 D6), with only
     their **existence** substrate for admins. The two classifications sit on opposite sides
     of the readiness §3.1.1 table on purpose, and the pair is the shortest proof that the
     two axes are not the same thing: the container is substrate, the compute inside it is
     owned.
2. **Minted by a human at deploy time; never by a process, never on the wire, never by
   inference.** The value comes from `PODIUM_INSTANCE`, `--instance`, or the `default`
   fallback. `ensureInstanceStateIdentity` **records** a claim; it does not mint an identity.
   No API, command, or protocol message creates an instance. The corollary for POD-734: the
   composition root **threads** the resolved id; it must not resolve, re-resolve, default, or
   invent one below the entry point.
3. **Never replicated across instances — by definition, not by policy.** An instance is the
   boundary of one Authority's feed. ADR 2's feed identity is `(feedId, epoch, seq)` within
   one Authority; there is no inter-Authority feed, no cross-instance cursor, and nothing to
   replicate *to*. Note carefully that this is **not** a consequence of ids being
   instance-unique — several are not. `repo_id` has **two forms and two different equality
   rules**, and only the first is global: when an origin URL normalizes it is
   `repo_<sha1_16(normalized origin)>` (repo-id.ts L70), so two instances that know the same
   repository compute the **same** `repo_id`; when no origin normalizes it falls back to
   `repo_<sha1_16("path:"+machineId+":"+path)>` (L71), which is **machine-scoped** and
   upgradable, and must not be cited as evidence of anything global. Separately,
   `LOCAL_MACHINE_ID` is the literal constant `'local'` in every instance. **Equal ids across
   instances therefore do exist, and mean nothing** — see D16.1 for the general rule. The
   prohibition on
   cross-instance joins does not rest on id uniqueness and must not be implemented as a
   uniqueness check: it rests on the state-dir claim and on there being no transport between
   instances (D20, D21).
4. **The pairing relation's true key is `(instance, machine)`, held on one side, and its
   durability is a MACHINE-axis obligation.** Recorded normatively because §1.4's bug is the
   consequence of leaving it unstated:
   - The relation "this machine may authenticate to this Authority" is a fact about a
     *pair*. Its instance coordinate is implicit in **which DB the row is in**, and its
     machine coordinate is `machines.id`. That is correct and D18 keeps it.
   - But the relation is **durably recorded on the server side only** — the daemon holds a
     token whose only verifier is `machines.token_hash`, and `getMachineByToken` fails closed
     when the row is absent (machines.ts L80). The daemon's own identity file, by contrast,
     is documented as needing to outlive "the server's own database" (identity.ts). Those two
     contracts are inconsistent: one side is built to survive the other's data loss, and the
     other side holds the only copy of what makes survival possible.
   - **THE OBSERVABLE CONTRACT IS DECIDED HERE**, not deferred to POD-1114. Three situations
     currently arrive as one indistinguishable `helloRejected`, and the contract fixes what
     each must do:

     | Situation | Required outcome |
     |---|---|
     | **Accidental loss of the `machines` row** (re-created DB, restore from before pairing, split-deployment promotion) | The previously paired daemon **MUST recover unattended** — no human on the remote host, no fresh pair code, and it **keeps its existing `MachineId`**, which `daemon.json`'s contract already promises outlives the server's database |
     | **Intentional revoke** (`deleteMachine` / unpair / token rotation by a `manage`-holder) | **Stays denied, permanently.** Recovery requires a deliberate new pairing act, and must never be reachable by the automatic path above |
     | **A daemon dialling a different instance** | **Stays denied**, and is *not* discoverable by the daemon: refused with an error byte-identical to any other refusal |

   - **The two durable facts that make those three distinguishable.** Naming the current
     instance id and state dir in a log **cannot** separate the first two — the server observes
     the same absent row either way, so the distinguishing fact does not exist yet and must be
     created. Both facts below are **machine-axis**, and neither is an instance discriminator,
     so D18's fence is untouched:

     Both live in **one durable store at the state-root tier** — beside `instance.json`,
     mode `0600`, **outside the server database** — hereafter the **enrollment ledger**. That
     they share a durability domain is not incidental; it is the correctness condition, and
     D19.4a below is where the first draft was wrong.

     1. **An APPEND-ONLY REVOCATION LEDGER, at the state-root tier.** Intentional revoke
        appends `(MachineId, serial-at-revoke, revoking principal, time)` — the principal
        supplied by ADR 3 D7 from the transport, never payload. Entries are **never pruned**
        while the pairing root they refer to exists.
     2. **An instance-scoped PAIRING ROOT, at the same tier.** A secret under which an issued
        machine token is verifiable **without** the per-row hash, plus a **monotonic enrollment
        serial** minted on every pair and every token rotation and recoverable from the token.

     **The verdict algorithm** for a `hello` whose `machines` row is absent, in order:

     | Step | Test | Verdict |
     |---|---|---|
     | 1 | Token does not verify under this instance's pairing root | **Deny** — foreign instance, forged, or stale beyond root rotation. Error identical to every other refusal |
     | 2 | Revocation ledger holds an entry for this `MachineId` with `serial >= the token's serial` | **Deny, permanently** — deliberately revoked |
     | 3 | Otherwise | **Re-enrol** — recreate the row per D19.4b, preserving the `MachineId` |

     Step 2 compares serials rather than merely testing for presence, so a machine that was
     revoked and later **deliberately re-paired** — minting a higher serial — is not denied by
     its own history. Presence alone would make revocation permanent against the operator's
     later intent.

   - **D19.4a — THE REVOCATION FACT MUST SURVIVE THE FAILURE THE CONTRACT RECOVERS FROM.**
     Normative, and the correction of a hole in the first draft:

     > **The revocation ledger survives database recreation and database rollback**, at the
     > same durability tier as the pairing root. Where the ledger and the database disagree
     > about enrollment, revocation **or owner**, **the ledger wins** (D19.4d rule 4). The
     > ledger is append-only and is **not** restored, rewound, or reconciled backwards when the
     > database is.

     *Why this is load-bearing.* If revocation is recorded only as a fact that "outlives the
     `machines` row" — a DB-resident tombstone — then this sequence defeats the contract
     entirely: a `manage`-holder revokes a daemon; the database is later recreated or restored
     from a backup predating the revoke; the tombstone vanishes with it; the **pairing root at
     the state root is untouched**, so the old token still verifies; step 2 finds no entry; and
     the permanently-revoked daemon takes the automatic re-enrol path. The outcome the contract
     requires — revoke stays denied, permanently, and is never reachable by the automatic
     path — would be violated by exactly the event the contract exists to survive. Two facts
     that must be compared can never sit in different durability domains, and the *stronger*
     of the two must not be the one that grants access.

     An equivalent monotonic store is acceptable in place of a file at that tier — anything
     whose defining property is that it cannot be rolled back below the pairing root's
     lifetime. What is **not** acceptable is any store that is backed up, snapshotted, or
     restored *together with* the server database.

   - **D19.4b — CONSTRAINT (mechanism belongs to POD-1114 / POD-318): the recovered row must
     not be ambient.** A pairing-root-verifiable token proves machine **enrolment only** — it
     proves nothing about ownership — while the composed target row (D18) carries `owner` and
     grants. This record does **not** design the recovery; it fixes the safety properties the
     recovery must preserve, because they are the ones that would be lost if left unstated:

     > **SAFETY PROPERTY.** Recovered owned compute may **never** become ambient, ownerless,
     > or reassigned to an arbitrary admin — and recovery may never **widen** anyone's access.

     Binding consequences of that property, and only these:

     1. **`MachineId` is preserved** from the token. That is the contract's core promise.
     2. **The owner must survive at the ledger's durability tier**, not only in the database —
        it is the only surviving source after the failure this contract recovers from. Recovery
        restores that recorded owner; it never re-derives one, and never infers it from who
        happens to be connected.
     3. **Grants are dropped, never restored.** Restoring a stale grant set could re-grant the
        `use` verb — a **code-execution** boundary (ADR 9 D6 M2) — to someone whose access was
        removed in the lost database. That is privilege widening performed by a recovery path,
        and ADR 9 D4's default-closed rule forbids it. They are re-granted explicitly.
     4. **An unresolvable recorded owner means QUARANTINE**, not assignment: admins hold `see`,
        **nobody** holds `use`, until an admin assigns an owner. It is **not** auto-assigned to
        the first admin — POD-318's first-admin migration covers machines that *never had* a
        recorded owner, and reusing it after a database restore would hand somebody's personal
        Mac to whoever is admin now. Ownerless means usable by nobody (Amendment 1 D13.4), which
        is what makes quarantine the safe landing state rather than a failure.
     5. **Ownership transfer must reach the durable tier** — see D19.4d for the property that
        governs it.

     **Mechanism is explicitly handed off**: the ledger's owner-record shape, reconciliation
     points, and the transfer path belong to **POD-1114** (recovery) and **POD-318** (the owner
     column and the pairing principal). Both briefs carry these constraints so they travel with
     the work.

   - **D19.4d — CONSTRAINT (mechanism belongs to POD-318 / POD-1114): a crash between the two
     writes may not leave a stale owner effective.** The enrollment ledger is a file at the
     state-root tier and `machines.owner` is a row in SQLite; **no transaction spans them**. An
     earlier draft of this amendment required them to be written "in the same operation", which
     is unimplementable and therefore left open exactly the window it claimed to close. Replaced
     by a safety property and four normative rules — the ordering and precedence, not a
     protocol:

     > **SAFETY PROPERTY.** A crash between the ledger write and the database write may
     > **never** leave the previous owner effective.

     1. **The ledger append is the authoritative owner transition** — the commit point. An owner
        change is effective once the append is durable, whether or not the row was written.
     2. **`machines.owner` is a projection**, reconciled from the ledger **before any `use` /
        `manage` authorization decision** that reads it. An authorization check is never served
        from a stale projection.
     3. **The database update may never precede a successful ledger commit.** Ledger first.
     4. **D19.4a's ledger-wins precedence covers `owner`**, not only enrollment and revocation.
        The narrower scoping left owner as the single field where a rolled-back database could
        out-rank the durable store.

     **Required regression test — crash between the writes:** append an owner transition, kill
     the process before the row update, restart, and assert the **new** owner holds `use` /
     `manage` and the **old** owner holds neither, with no manual repair. A happy-path transfer
     test does not discharge this.

     **Mechanism is explicitly handed off**: commit-point implementation, retry and idempotency
     semantics, and reconciliation scheduling belong to **POD-318** (which owns the transfer
     path) and **POD-1114** (which owns the ledger). The same commit-point property governs
     **revocation** — the append is the revocation, any DB-side tombstone is a projection of it —
     which is what makes D19.4a's rollback guarantee hold end-to-end rather than only at read
     time.

   - **D19.4c — The pairing root is NORMATIVE, not a suggested implementation.** Recorded
     because it was explicitly asked and explicitly answered at review (2026-07-30): the
     contract requires **a verifiable fact held outside the database**, and leaving the choice
     of that fact open would recreate exactly the vagueness this decision was written to
     remove — an implementer would be back to deciding what "durable enough" means, which is
     the half of the original defect that made the bug possible.
     So D19.4's mechanism is binding, with the two completions that make it sound: the
     revocation ledger must share the pairing root's **failure domain** (D19.4a), and the
     recovered ownership state must be **decided rather than reconstructed opportunistically**
     (D19.4b). A mechanism that verifies enrolment outside the DB but records revocation inside
     it is not a partial implementation of this decision — it is the hole D19.4a closes.
     What POD-1114 retains latitude over: file format and layout, the serial's encoding, the
     verification primitive (MAC versus signature), rotation policy for the root, and how the
     ledger is compacted **above** the pairing root's lifetime. What it does not: the tier,
     the append-only and never-rolled-back properties, ledger-wins precedence, serial-based
     revocation comparison, drop-grants, and quarantine-on-unresolvable-owner.

   - **Honest boundary.** The contract covers loss of the **database**. If the whole state
     root is lost, the pairing root is lost with it and a real re-pair is genuinely required;
     that is the limit of what any server-side fact can promise, and it is not a gap to be
     closed later by weakening rule 1.
   - **Diagnostics follow from the decision rather than substituting for it.** Once the two
     facts exist, a refused handshake and a refused state root must log **which of the three
     verdicts was reached** — re-enrolled, revoked, or unverifiable — alongside the instance id
     and state root the check ran against. That is now a statement of fact rather than, as the
     earlier draft had it, an operator being asked to infer a distinction the server had no
     basis for. The **client-facing** rejection reason still does not carry the verdict: it
     must not become an existence or deployment oracle.
   - **Scope.** Implementation is **POD-1114**, whose brief is constrained to exactly this
     contract and these two facts — it is no longer an open design menu, and "keep recovery
     manual" has been struck from it. It remains **out of scope for POD-734**, which threads
     instance identity and must not grow a pairing feature. Whoever implements it may **not**
     substitute an instance coordinate on the wire (D20) or a column on the table (D18).

**Rationale.** Questions 3 and 4 of POD-645 ("who mints it, never replicated") look like
bookkeeping and are the two places the axis map earns its keep. "Never replicated" needed a
reason that survives the discovery that `repo_id` and `'local'` collide across instances —
otherwise the first person to notice that will read it as a bug and reach for
instance-qualified ids, which is D16's second failure row with good intentions. And "who
mints it" needed to be answered as *a human, out of band* so that POD-734 threads a value
rather than deriving one, and so that the pairing bug is correctly attributed to the machine
axis instead of being "fixed" on the deployment axis.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Classify instance identity as `owned-compute` (the instance has an owner: whoever set it up) | The person who set up the instance owns the **host machine** (Amendment 1 D13.4) and holds the **admin account role** (ADR 9 D1.4) — two existing mechanisms that already carry everything this classification would be reaching for. An owner on the partition itself would need a `UserId` minted inside the partition it defines, and would imply transfer semantics for a deployment. |
| Leave it unclassified, since it is "not really an entity" | ADR 9 D4's totality test makes an unclassified class a build failure, and the default-closed backstop would make it `personal` — a deployment partition privately owned by one person is a nonsense state that would then have to be un-decided. |
| Make cross-instance isolation an id-uniqueness property (instance-qualify every id) | Directly contradicted by the code: `repo_id` is content-derived and `LOCAL_MACHINE_ID` is a constant, so ids already collide across instances harmlessly. Qualifying them would be a schema-wide change to defend a boundary that is already enforced pre-service, and would smuggle the instance coordinate into every key — D18's fence, evaded via `ids.ts`. |
| Fix §1.4's bug here, in this amendment | It is a real defect with a real fix, and it is not an ADR-1 ownership question. Absorbing it would grow POD-733's diff into a pairing feature and let a decision record be judged on an implementation. What this record owes the bug is the axis assignment, the prohibition on fixing it on the wrong axis, and the diagnostics clause — all present in D19.4. |
| Put the instance id in the `helloRejected` reason so the daemon can tell "wrong instance" from "unpaired" | That is protocol presence with an authorization-adjacent payload, arriving as a string in an error. It also hands an unauthenticated caller a deployment fact. The operator-facing need is real and is met server-side by D19.4's logging clause. |

---

### Decision D20 — Zero protocol presence, and it stays zero. Identity arriving on the wire is the OTHER axis

**Decision.**

1. **Verified and ratified: instance identity has no protocol presence.**
   `rg instanceId packages/protocol/src` returns nothing on tip `201dd989`. No message,
   envelope, handshake frame, or brand reference. **This is the target state, not a gap.**
2. **It must stay zero.** No protocol message, envelope field, handshake frame, control
   frame, bootstrap header, or command payload may carry an instance id — not for
   authorization, not for routing, not for diagnostics, not for version negotiation, and not
   "reserved for later". The reason is structural rather than stylistic: **there is no
   transport between instances**, so any recipient of such a field is already inside the
   instance that sent it, and the field can only ever be a constant that some future code
   will nonetheless branch on. (Instance identity does of course determine *where* a socket
   points, via `defaultInstancePorts` and the state dir — the endpoint is per-instance. That
   is configuration selecting a transport, not identity travelling on one.)
3. **The wire IS gaining an identity dimension, and it is the other axis.** ADR 2
   Amendment 1 makes the feed **per-principal**: D12 overturns D2's unscoped clause, D13
   adds covered-range watermarks so contiguity holds over a filtered view, D14 adds `evict`
   and `rescope` for visibility changes that move no revision, D15 makes bootstrap
   per-principal — implemented at POD-1077. Read the two facts together carefully:

   | | Instance | Principal (user / delegation) |
   |---|---|---|
   | **Layer** | Deployment: which Authority, which DB, which port | Authorization: which slice of one Authority's feed you may see |
   | **On the wire** | **Absent, permanently** (this decision) | **Present, by design** — the feed is scoped per principal, and grants/evictions are wire events |
   | **What varies** | Nothing within a connection — you are inside one instance | Per connection, and *during* a connection as grants change |
   | **Effect on `seq`** | None. There is one feed per Authority | None either: **global `seq` stays global**; only *visibility* is per-principal (ADR 2 Amd 1 D12/D13) |

   The invited mistake is the inference "identity is appearing on the wire, so instance
   identity should follow it there". It does not follow, and the table above is why: the
   scoped feed exists because **one** Authority must serve **many** principals different
   slices of **one** feed. There is no analogous problem for instances, because an instance
   never serves another instance anything.
4. **Consequence for POD-734.** Threading instance identity through the fleet service and the
   declarative composition root (POD-321) is **process-internal wiring**: constructor
   parameters, config, derived paths, unit names, durable labels. If threading appears to
   require a protocol change, that is a signal the wrong axis is being threaded — stop and
   re-read D16.

**Rationale.** The brief's framing is exactly right and worth preserving as the decision's
shape: "no protocol presence" was true, is easy to keep true, and is about to sit next to a
protocol change that puts *a different kind of identity* on the wire in the same programme,
in the same phase, reviewed by the same people. Stating only "instance identity is not on the
wire" would leave that adjacency to be resolved by whoever notices it. Stating both, in one
table, at the same altitude, makes the asymmetry the load-bearing fact.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Add an instance id to the daemon handshake so a daemon can detect it is talking to the wrong instance | See D19.4 and §1.4: it would not have prevented the known bug (the row is gone either way), and it converts a configuration fact into a protocol commitment — after which removing it is a wire migration. The operator's real need is diagnosable server-side. |
| Add it to the wire-version / bootstrap header "for observability" | ADR 2 owns wire-version negotiation and it is about *protocol* compatibility, not deployment. An observability field on a negotiated header is the field most likely to be branched on later, and no client can be in the wrong instance: the endpoint it dialled *is* the instance. |
| Reserve the field now so a future federation does not need a wire migration | [spec:SP-0371] defers federation and D21 puts cross-instance work out of scope. A reserved field with no reader rots: it is either untested and wrong when needed, or quietly adopted for something else. ADR 1 D7's federation seam is deliberately about origin/causation provenance, not about naming instances. |
| Allow it on the wire but forbid *authorizing* on it | The distinction does not survive contact: a field that is present and describes the deployment will be read, then trusted, then relied on. ADR 3 D7's "payload identity is inert" is precisely the lesson — an identity-shaped field that must not be trusted is a field that should not be sent. |

---

### Decision D21 — Cross-instance federation, cross-instance sharing, and cross-instance identity portability are all OUT

**Decision.** Out of scope, and **stated twice on purpose** — once for each meaning the words
now carry:

1. **No cross-instance federation of any kind.** No cross-instance read, mutate, route,
   join, feed, cursor, presence room, lock namespace, or entity reference. [spec:SP-15aa]
   requires proof that one instance cannot read, mutate, stop, update, or route commands into
   another unless sharing is *explicitly configured*, and no such configuration is specified,
   built, or planned. Hub/node product federation is deferred under [spec:SP-0371] /
   POD-353. ADR 1 D7 keeps a **provenance seam** (origin / causation on changes and commands)
   and that seam is explicitly **not** a federation feature: it exists so a future hop could
   attribute writers without rewriting matrix columns.
2. **No cross-instance *sharing* — and this sentence is not the previous one.** Multi-user
   introduces a product feature **called sharing**: granting another **user**, inside **one**
   instance, `read`/`write` on a personal entity or `see`/`use`/`manage` on a machine (ADR 9
   D2/D6). That feature is entirely intra-instance. **No grant, share, visibility class,
   `evict`, `rescope`, watermark, or per-user state row crosses an instance boundary, and no
   sharing UI, command, or policy may offer a cross-instance option.** SP-15aa scoped
   cross-instance sharing out when "sharing" meant something else in this codebase; the
   scoping-out is unchanged, and now has to be said in the new vocabulary too, because a
   reader who meets the word only in its product sense would otherwise find SP-15aa's
   exclusion irrelevant to them.
3. **No cross-instance identity portability.** A `UserId` is minted by one server (ADR 9
   D1.2) and means nothing to another instance. Accounts, credentials, client sessions,
   grants and delegation records do not transfer, federate, single-sign-on, or resolve across
   instances. Likewise a `MachineId` from one instance's `daemon.json` names nothing in
   another instance's fleet, even for the same physical host, and even when the two compute
   equal derived ids (D19.3 — `repo_id` collides across instances harmlessly and must not be
   read as evidence of a shared namespace).
4. **The one thing that legitimately crosses a boundary, and does not contradict this.**
   Handoff (ADR 1 §9, POD-643) is an **export-only** bundle between a source and a target
   *server*, not continuous multi-home sync — and under Amendment 1 D13.7 accept is
   **denied, not retargeted**, without `use` on the target machine. Nothing in D21 authorises
   using handoff as a federation channel between instances.

**Rationale.** One word acquired two meanings inside one programme. SP-15aa's authors wrote
"cross-instance sharing is out of scope" about a system with no users, where "sharing" could
only mean two deployments touching each other's data. A reader in 2026-08 meets "sharing"
first as the multi-user product feature, and can read SP-15aa's exclusion as being about
something historical that no longer applies. Saying it separately in both vocabularies costs
a paragraph; discovering the collision by shipping a cross-instance grant UI does not.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Rely on SP-15aa's existing exclusion | It predates the product meaning of the word. An exclusion whose key term has been redefined underneath it is not a working exclusion. |
| Leave a "future federation" hook in the ownership model (an instance-qualified grant, say) | That hook is an `instance_id` on the grant edge — D18's fence, and the highest-consequence place to breach it, since the grant edge is what authorization reads. |
| Allow cross-instance *read-only* sharing as a cheap first step | It requires a transport between instances (D20), a cross-instance cursor and watermark (ADR 2 has neither), and a principal that resolves in a foreign instance (D21.3 forbids). "Cheap" is not the reason it is refused; unspecified is. |

---

## 3. The axis map applied: every fleet and machine field, assigned

Normative, and the artefact POD-734 and POD-318 should check their diffs against. Columns as
in ADR 1's matrix, restricted to the **axis** question this amendment owns. `(D16)` names the
axis; nothing may carry two.

### 3.1 Instance-level facts

| Fact | Axis | Where it lives | Notes |
|---|---|---|---|
| Selected instance id | Instance | `PODIUM_INSTANCE` / `--instance` / `default` | Human-minted at deploy time (D19.2) |
| `instance.json` marker (`{version, instanceId}`) | Instance | state dir, `0600` | Claim, not identity mint. Wrong marker ⇒ hard fail |
| State root, install root, CLI name, unit names, update timer, durable PTY labels, port triplet | Instance × **Process role** | derived, in-process | Composed from two axes; `instanceServiceName(role, id)` is the composition site |
| Instance settings, feature flags, advisory locks | Instance (substrate) | server DB, unqualified | `deployment-substrate` (ADR 9 D3); already classified — not this amendment's rows |

### 3.2 Machine and fleet rows

| Field | Axis | Present today | Owner per D18 table |
|---|---|---|---|
| `machines.id` | **Machine** | yes | daemon mints; server registers |
| `machines.name` / `hostname` | Machine | yes | daemon reports; `manage` renames |
| `machines.token_hash` | Machine (secret class; ADR 1 D6 / D15) | yes | server, at pair |
| `machines.last_seen_at`, `inventory_json` | Machine | yes | daemon observation |
| `machines.owner` | **User** | no — POD-318 | pairing principal (M3) |
| machine grant edges (`see`/`use`/`manage`) | **User** | no — POD-1079 | granter, bounded by granter's rights |
| `repos.machine_id`, `repos.path`, `repo_prefixes` | Machine (inherits the machine's scoping; Amendment 1 D13.5) | yes | per-machine facts; **no owner of their own** |
| `repos.repo_id` — **origin-backed** form | **Neither** — content-derived: `repo_<sha1_16(normalizeOriginUrl(origin))>` (repo-id.ts L70) | yes | Equality means **the same normalized origin URL**. Stable across checkouts, across machines, and across instances by design (D19.3) |
| `repos.repo_id` — **path-fallback** form | **Machine** — `repo_<sha1_16("path:"+machineId+":"+path)>` (repo-id.ts L71), used when no origin normalizes | yes | Equality means **the same `(machineId, path)` coordinate** and nothing wider. Provisional: `isPathFallbackRepoId` detects it and `updateRepoOrigin` **upgrades** it to the origin-backed form once an origin is learned |

**Which consumer is entitled to which `repo_id` equality notion.** The two forms are the same
column and must not be read with the same rule:

| Consumer | Entitled to | Because |
|---|---|---|
| "Is this the same repository, wherever it is checked out?" — cross-machine repo grouping, prefix allocation, multi-machine history | **Origin-backed equality only.** Must first establish the id is not a path fallback (`isPathFallbackRepoId`) and treat a fallback as *unknown*, never as *distinct-and-final* | This is precisely what hashing a normalized origin is for: stability across checkouts and machines |
| "Is this the same working copy on this machine?" — worktree and path-scoped operations | **Either form**, but only ever with the machine coordinate carried alongside | A path means nothing without the host it is on |
| Anything asserting a **global** repo identity from a fallback id | **Nothing.** This is the false rule the split exists to prevent | The fallback deliberately encodes `machineId`, so two machines with the same checkout path produce two different ids for one repository, and one machine's two paths produce two ids as intended |
| ~~`machines.instance_id`~~ | — | **no, and never** | D18's fence |
| daemon `daemon.json` (`machineId`, `token`) | Machine, **stored inside** the instance state root | yes | Two instances on one host ⇒ two MachineIds, correctly (D16) |
| `daemon.secret` (local same-host daemon) | Machine (credential-local) | yes | Per state dir, therefore per instance — a *location* consequence, not a column |
| **enrollment ledger** — pairing root, enrollment serials, recorded owner, revocation entries (D19.4, D19.4a, D19.4b) | Machine (secret + machine facts). **State-root tier, `0600`, OUTSIDE the server DB**, append-only, never rolled back with the DB | **no — POD-1114** | Per state root, therefore per instance. Makes "wrong instance" decidable with zero protocol presence, and is the only tier at which revocation can outlive a DB rollback (D19.4a) |
| `machines.owner` after re-enrolment | **User** — restored from the ledger, never re-derived | no — POD-318 records it; POD-1114 restores it | Quarantined (`see` for admins, `use` for nobody) if the recorded `UserId` no longer resolves — **never** auto-assigned to the first admin (D19.4b) |
| machine grants after re-enrolment | **User** | — | **Always dropped, never restored** — a recovery path must not widen privilege (D19.4b) |

**Transitional sentinels — NOT machine identities.** Listed separately because D16.2 makes
them invalid `MachineId` values, and because `MachineId` validates length rather than shape, so
branding one would launder it into a well-typed id:

| Sentinel | What it actually is | Retirement |
|---|---|---|
| `LOCAL_MACHINE_ID = 'local'` | A **server-side stand-in** for "the host I run on", server-provisioned with a server-minted secret (`ensureLocalMachine`). Byte-equal in every instance, describing different hardware. The host it stands for is **owned**, not ambient (Amendment 1 D13.4) | POD-318 — replaced by a daemon-minted UUID via loopback auto-pair. **Must be gone before `MachineId` branding reaches its sites** (D16.2 rule 2; sites enumerated by POD-360) |
| `LOCAL_PLACEHOLDER = '__local__'` | "No machine yet" — the `machine_id` default on `repos` (schema L200) for rows created pre-adoption | POD-318 — one-shot migration re-homes rows; `adoptPlaceholderRows` and the sibling heals are deleted. Same branding-order constraint. Must not collide with the `instance.json` first-boot claim (POD-645 acceptance) |

**Reading the table:** the instance coordinate appears **nowhere** as a field, and everywhere
as a **location** — which state dir, which DB file, which port. That is the whole decision,
in one column.

### 3.3 First boot composes three claims (POD-645 M4; verification is POD-734's)

Three things happen at first boot on the same host, on three different axes, and POD-645's
acceptance requires they compose:

Three things happen at first boot on the same host, on three different axes. **The sequence
below is the TARGET (post-POD-318), not the as-built path** — per D16.2, today's local machine
is server-provisioned as the constant `'local'`, and that is the exception POD-318 deletes.
Writing the as-built path here as normative is exactly the error D16.2 exists to prevent.

| Order | Claim | Axis | Target site |
|---|---|---|---|
| 1 | Instance claims its state root | Instance | `ensureInstanceStateIdentity` (server.ts L149–150, daemon.ts L361–363) — **before** service construction. Also the tier at which D19.4's pairing root is established |
| 2 | The local daemon **mints its own `MachineId`** — `randomUUID()` in `daemon.json` — and **auto-pairs over the loopback bootstrap secret exactly like a remote daemon** | Machine | POD-318's unified scheme (`readOrCreateDaemonSecret` supplies the loopback secret; `ensureLocalMachine` and `adoptPlaceholderRows` are **deleted**). **No `'local'`, no `'__local__'`** |
| 3 | That machine is assigned an **owner** — the principal that set the instance up | User | POD-318, from the pairing principal per ADR 3 D7 (transport, never payload); pre-existing machines migrated to the first admin |

This amendment's contribution is the ordering constraint and the axis assignment, not the
implementation:

- **Step 1 must precede both others** — it decides which DB the machine row and the owner land
  in, and which state root holds the pairing root.
- **Step 2 must produce a daemon-minted UUID**, not a sentinel. A first boot that still writes
  `'local'` has not satisfied this sequence, and per D16.2 rule 2 that value must not reach a
  `MachineId`-branded site.
- **Step 3 must fail closed** — a machine with no resolvable owner is usable by **nobody**, not
  by everybody (Amendment 1 D13.4, ADR 9 D6 M4; POD-318 carries the test that a second,
  non-owning member account cannot spawn on the auto-paired local machine).

Implementation and proof are POD-734's and POD-318's; nothing here authorises step 1 to learn
about steps 2–3, or the reverse.

---

## 4. Deliberately open — recorded, not answered

ADR 9 §3 is the pack's canonical open list (O1–O6). This amendment raises **no new open
policy question**; an omitted row is silence, not closure. Two items are recorded as
*implementation* work this decision deliberately does not do:

| Item | Status |
|---|---|
| Pairing durability / unattended re-pair recovery (§1.4's bug) | **POD-1114**, `discovered-from` POD-733. The **observable contract (D19.4), the durability domain (D19.4a), the reconstructed row including ownership and grants (D19.4b), and the binding status of the mechanism itself (D19.4c) are all DECIDED** — POD-1114 implements them and chooses none of them. Machine-axis; not fixable by a wire field (D20) or a column (D18); not in POD-734's scope |
| Logging the **verdict** (re-enrolled / revoked / unverifiable) plus the instance id and state root on a refused handshake or refused state root | Required by D19.4, and possible only once its two durable facts exist — so it lands with POD-1114 rather than before it. No wire, no protocol change |

---

## 5. Compliance checklist

**In compliance** when:

- [ ] `InstanceId` is declared as a brand with the other brands (D5.1, D17.1) and appears
      **only** in D17.2's permitted positions.
- [ ] No `instance_id` — or any renamed per-instance discriminator, including one
      concatenated into a composite key or a branded id — exists on any durable table, wire
      projection, replica store, command payload, per-user state row, or grant edge (D18).
- [ ] `rg instanceId packages/protocol/src` returns **nothing** (D20.1). This is a
      standing invariant, not a one-time observation.
- [ ] No `owner` value is derived from, defaulted from, or encodes an instance id; no
      per-instance isolation is enforced by an ownership or grant check (D18 rule 1).
- [ ] Instance identity is resolved **once**, at the entry point, and threaded — never
      re-resolved, defaulted, or invented below it (D19.2, D20.4).
- [ ] **No instance-id string comparison is used as proof that two processes, rows or files
      belong to one deployment** (D16.1). Within a host the predicate is same resolved state
      root; across hosts it is the pairing relation.
- [ ] `'local'` and `'__local__'` never reach a `MachineId`-branded site: POD-318's migration
      retires them **before** POD-301/POD-361–363 brand those sites, or the sites are carved
      out as raw strings until it does (D16.2 rule 2; inventoried by POD-360).
- [ ] First boot mints a **daemon-minted UUID** for the local machine — not a sentinel — and
      assigns an owner that fails closed (§3.3 target sequence).
- [ ] Revoke and accidental row loss are **distinguishable from durable facts**, not inferred:
      an append-only revocation ledger and an instance-scoped pairing root, **in one store at
      the state-root tier, outside the server DB** (D19.4). A previously paired daemon recovers
      unattended from row loss; revoke and wrong-instance stay denied.
- [ ] The revocation ledger **survives database recreation and rollback**, is never restored
      backwards with the DB, and wins over the DB on disagreement (D19.4a). Proven by the
      pair → revoke → destroy/roll back the DB → reconnect with the old token → **deny**
      sequence, not by inspection.
- [ ] Re-enrolment restores `owner` from the ledger, **drops all grants**, and **quarantines**
      (admins `see`, nobody `use`) when the recorded owner no longer resolves — never
      ownerless-and-ambient, never auto-assigned to an arbitrary admin (D19.4b).
- [ ] Ownership transitions satisfy D19.4d: the ledger append is the authoritative transition,
      `machines.owner` is a projection reconciled before any `use`/`manage` decision, the DB
      write never precedes a durable append, and ledger-wins covers **owner** as well as
      enrollment and revocation.
- [ ] A **crash-between-writes** regression test asserts the new owner holds `use`/`manage` and
      the old owner holds neither, with no manual repair (D19.4d rule 7).
- [ ] No code treats two live processes of one role as a conflict at any scope, and no registry,
      singleton or uniqueness assertion is keyed on `(instanceId, role)` — role carries no
      identity uniqueness (D16.3).
- [ ] Nothing treats `MachineId` as a **process** identity: a `MachineId`-keyed live registry is
      read as *enrollment → current connection*, and anything distinguishing two concurrent
      connections uses a connection handle, as `detach`'s supersession check already does
      (D16.3 rule 2).
- [ ] `repo_id` equality is never asserted globally for the **path-fallback** form — that form
      means `(machineId, path)` and is upgradable (§3.2, D19.3).
- [ ] The `InstanceId (partition)` matrix row declares `deployment-substrate` with owner
      `none — substrate` and no grants, satisfying ADR 9 D4's totality test (D19.1).
- [ ] Machines remain `owned-compute` with `see`/`use`/`manage`; the composed machine row
      carries `owner` and grants and **no** instance column (D18, §3.2).
- [ ] No feature, command, UI affordance, or policy offers cross-instance federation,
      sharing, or identity portability (D21).

**Out of compliance** when an `instance_id` column or equivalent is added anywhere as a
consequence of multi-user; when an instance id appears in any protocol message; when instance
scoping is implemented as ownership or ownership as instance scoping; when `InstanceId` and
`MachineId` are made derivable from one another; or when this amendment is cited as authority
for any of the above.

---

## 6. Self-verification record

Every claim below was read on tip `201dd989` (`issue/279-integration`), 2026-07-30.

| Claim | Verification |
|---|---|
| `DEFAULT_INSTANCE_ID`, `INSTANCE_ID_PATTERN`, `resolveInstanceId`, `selectInstance` | `packages/runtime/src/instance.ts` L13, L14, L29, L45 |
| Derived state/install roots, CLI name, unit names, durable labels, fnv1a port triplet | same file: L80, L93, L105, L112, L121, L127, L156 |
| `instance.json` claim + wrong-instance hard fail | same file: `readInstanceStateIdentity` L174, `assertInstanceStateIdentity` L193, `ensureInstanceStateIdentity` L212 |
| Both entry points resolve + claim before service construction | `apps/server/src/server.ts` L149–150; `apps/daemon/src/daemon.ts` L361–363 |
| **Zero protocol presence** | `rg instanceId packages/protocol/src` → no matches |
| Daemon mints `machineId` once; contract to outlive the server's DB | `apps/daemon/src/identity.ts` L35 and its doc comment |
| `stateDir()` **is** `instanceStateDir()` — so `daemon.json` is per-instance | `packages/runtime/src/config.ts` L162–164 |
| `machines` columns (no owner, no pairer, no grants, no instance column) | `apps/server/src/migrations/schema.ts` L189–197 |
| `repos` keyed `(machine_id, path)`, `machine_id` default `'__local__'` | same file L199–208 |
| `LOCAL_MACHINE_ID = 'local'`, `LOCAL_PLACEHOLDER = '__local__'`, `readOrCreateDaemonSecret` | `packages/runtime/src/local-machine.ts` L13, L19, L45 |
| `repo_id` has **two** forms: origin-backed (global) and `(machineId, path)` fallback (machine-scoped, upgradable) | `apps/server/src/repo-id.ts` `normalizeOriginUrl` L21, `deriveRepoId` L64, origin branch L70, fallback branch L71, `isPathFallbackRepoId` L77 |
| `assertInstanceStateIdentity` rejects only a marker whose value differs from the SELECTED id — same id in two different roots is accepted, and there is no registry | `packages/runtime/src/instance.ts` L193–204 |
| `instanceStateDir` returns `PODIUM_STATE_DIR` verbatim when set, so id → state root is not injective | same file L80–89 |
| `resolveInstanceId` supplies `default` automatically when `PODIUM_INSTANCE` is unset | same file L29–31 |
| A named instance refuses a non-empty unmarked root unless `PODIUM_ADOPT_STATE=1`; `default` is marked in place | `ensureInstanceStateIdentity` L212–246 |
| The **server** provisions the local machine as the constant `'local'` with a server-minted secret — the daemon does not mint it | `apps/server/src/modules/machines/service.ts` `ensureLocalMachine` L409–419; called at `apps/server/src/server.ts` L226 |
| `MachineId` validates length, not shape — so `MachineId.parse('local')` succeeds | `packages/protocol/src/ids.ts` (`z.string().min(1).brand<'MachineId'>()`) |
| POD-318 deletes `local` / `__local__` and the bridging boot heals, and lands the owner at first-boot auto-pair | `podium issue show 318` (scope items 1 and M3/M4) |
| POD-360 is the characterization step that inventories every entity-id site before branding | `podium issue show 360` |
| `'__local__'` is a column DEFAULT in **three** tables | `apps/server/src/migrations/schema.ts` L43 (`sessions`), L154 (`conversations`), L200 (`repos`) |
| Pairing codes are in-memory, single-use, deleted on redeem **regardless of outcome**, and lost on restart | `apps/server/src/hub/pairing.ts` — class comment, `redeem` (delete-before-expiry-check), `ttlMs` 60 min |
| The daemon's one-shot pair fallback depends on an operator-supplied `--pair-code` | `apps/daemon/src/daemon.ts` L933–941 |
| Handshake frames carry `machineId`/`token`/`hostname` and **no** instance id | `packages/protocol/src/messages/daemon-handshake.ts` L4–16 |
| `hello` accepted iff `getMachineByToken`; `'unknown machine — re-pair'` on failure | `apps/server/src/modules/machines/service.ts` L176, L184 |
| `getMachineByToken` fails closed on a missing row (`if (!row) return false`) | `apps/server/src/store/machines.ts` L80–88 |
| Daemon stops permanently on `helloRejected` without a pair code; comment names "a token minted by a DIFFERENT server" | `apps/daemon/src/daemon.ts` L929–943 |
| ADR 1 D5's five clauses and its rejected alternatives | `docs/adr/0001-authority-ownership.md` D5 (L176ff) |
| Amendment 1 D13 (machines owned compute), D14 (not multi-tenancy), §3 §1 matrix cells | `docs/adr/0001-authority-ownership-amendment-1.md` L358, L411, L497–500 |
| ADR 9 D1 principal taxonomy + `UserId` brand + `OPERATOR` retirement; D3 five classes; D4 default-closed totality test; D6 machine verbs | `docs/adr/0009-identity-ownership-sharing.md` L126, L227, L278, L381 |
| ADR 2 Amendment 1: per-principal feed (D12), watermarks (D13), `evict`/`rescope` (D14), scoped bootstrap (D15) | `docs/adr/0002-sync-protocol-amendment-1.md` L138, L193, L298, L407 |
| D5 unaffected / not multi-tenancy / no `instance_id` | `docs/multi-user-readiness.md` §2 final bullet (L86–89) |
| Machines corrected out of tenant-visible infrastructure on 2026-07-29 | `docs/multi-user-readiness.md` §3.1.1 L152–163, §3.1.4 |
| Pairing must record who paired the machine; existing machines migrated to first admin | `docs/multi-user-readiness.md` §3.1.4 M3 |
| SP-15aa text (isolation proof; sharing only if explicitly configured) | `podium spec show SP-15aa` |
| Multi-instance isolation suite exists | `scripts/multi-instance-runtime.integration.bun.test.ts` |

---

## 7. Status and sign-off

| Stage | Owner |
|---|---|
| Proposed | POD-733 (this document) |
| Pack reconciliation + index | POD-359 — **closed 2026-07-30**, and its 103-issue tracker sweep predates this file. The index row and the `docs/adr/README.md` amendment count were added by POD-733; anything else this amendment implies for the tracker is unswept |
| Human approval | Suspended for the autonomous run (see Status above); coordinator sign-off recorded in `docs/adr/README.md` |
| Brand declaration + adoption at runtime call sites | POD-301 (bounded by D17.5) |
| Matrix annotations + totality test | POD-304 |
| Instance threading (fleet service + composition root) | POD-734, POD-321 |
| Machine owner + pairing principal; placeholder retirement | POD-318 |
| Machine grants + verb checks | POD-1079 |

No phase may treat an alternative instance-scoping strategy as authorized. Further amendment
requires an ADR update; POD-359 having closed, the tracker-reconciliation obligation passes to
whoever amends next, and D18's fence stands independently of the sign-off state — it is a
prohibition, not a provisional recommendation awaiting ratification.
