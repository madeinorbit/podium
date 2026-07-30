# POD-367 — issue representations re-derived: ledger

**Base:** `d3dd1a47` (branched off `issue/365-1-4b-…`, per the coordinator's fan-out arrangement).
**Scope:** the 17 issue-shaped representations counted in `docs/rearch-field-schema-inventory.md` §3.
This ledger records what was re-derived, what was deliberately left alone, and which decisions were
handed forward still open. It does not re-derive POD-364's inventory.

---

## 1. Status per representation

| # | Representation | Status | Note |
|---|---|---|---|
| 1 | `issues` (drizzle DDL) | untouched | Physical DDL — legitimate R3 by inventory verdict |
| 2 | `IssueRow` | **not done** | Needs the one `toStorage`/`fromStorage` pair; the aggregate's renames and wrapper make a straight `Pick` a store-wide change (§4) |
| 3 | `IssueWire` | **BLOCKED — architectural** | A circular import blocks it; proven, measured, and filed as POD-1141 (§4a) |
| 4 | `IssuePatch` | already compliant | The reference pattern §6 generalizes; unchanged |
| 5 | `CreateIssueInput` | **composed** | `Pick<IssueRow,…>` + a `CreatableRowFields<K>` mapped type |
| 6 | `IssueTreeNode` | **not done** | Retirement of the CLI copy needs a shared home; embed stays until POD-308 |
| 7 | `TreeNode` (CLI) | **not done** | Retiring it needs #6 in a package the CLI may import |
| 8 | `ShowWire` (CLI) | **not done** | As #7 |
| 9 | `OrphanIssue` | **composed** | Picks from `IssueWireCore` via `IssueRefHead` |
| 10 | `IssueGraphNode` | **composed** | Picks from `IssueWireCore`; both edge answers kept open (§3.1) |
| 11 | `HandoffIssue` | **composed** | Cleared by POD-643 and POD-365; existing predicate tests kept intact, not re-derived |
| 12 | `RefIssueLike` | **composed** | The largest client restatement; 11 fixture sites needed branded ids |
| 13 | `FocusIssueInfo` | **composed** | `stage` tightens from `string` to `IssueStage` |
| 14 | `IssueInfo` (workflows) | **composed, verdict corrected** | Not a duplicate of #13 — §2 |
| 15 | `StartableIssueLike` | **composed** | Mapped type; the `\| null` union is the port working, not drift |
| 16 | `IssueAutoArchiveObservation` | **deliberately not composed** | Composing would loosen a validation gate — §2 |
| 17 | `GitProbeTarget` | **composed** | Every member is a machine fact; visibility inherited |

Also landed: `EpicStatus` and `LintFinding` composed from the same identity head (read-model
aggregates, not counted in the 17).

**9 composed, 1 correctly left alone with reasons, 1 blocked architecturally (POD-1141),
4 not done, 2 legitimately untouched.**

---

## 1a. The audit criterion cannot be measured by the audit

Acceptance criterion 1 reads "Zero hand-restated issue field definitions (**audit**)". **The named
instrument cannot measure it, so this criterion is reported as individually evidenced per
representation (§1) and NOT as an audit result.**

Measured, not assumed — `scripts/rearch-audit.ts:391` defines `ISSUE_SHAPES` as a hardcoded array of
seven names, grepped for `^export (interface|type|class) <name>`. `bun scripts/rearch-audit.ts
--sites` reports **8 counted sites** for `issue-shapes`:

| Counted site | Is it one of the 17? |
|---|---|
| `apps/server/src/store/types.ts:197` `IssueRow` | yes — #2 |
| `packages/model/src/entities/issue.ts:418` `IssueWire` | yes — #3 |
| `packages/model/src/entities/issue.ts:516` `OrphanIssue` | yes — #9 |
| `packages/model/src/predicates/machine-selection.ts:74` `HandoffIssue` | yes — #11 |
| `apps/web/src/features/issues/issue-hierarchy.ts:78` `IssueRow` | **no** — inventory §3 excludes it explicitly ("redeclares nothing") |
| `apps/web/src/features/issues/issue-page-model.ts:32` `IssuePageModel` | **no** |
| `packages/client-core/src/viewmodels/derive.ts:872` `IssueNavView` | **no** |
| `packages/model/src/entities/issue.ts:152` `IssueSessionSummary` | **no** — a field GROUP, excluded by inventory §3 |

So the detector sees **4 of the 17**, and **half of what it counts is not a counted representation**.

The consequence for this issue specifically: of the eight representations composed here, only
`OrphanIssue` is visible to the detector at all — and it stays counted, because the composition
changed `export const OrphanIssue = z.object({…})` into a pick while `export type OrphanIssue =
z.infer<…>` is what the regex matches. The audit therefore printed the identical
`deletion audit OK — 21 items, 261 sites remaining (baseline exact)` line before and after this work.
The sharpest single case: `RefIssueLike` went from a hand-written 22-key interface to a `Pick` — the
largest client-side restatement in the repo, retired — and the detector never saw it, because
`RefIssueLike` is not one of the seven names.

**`ISSUE_SHAPES` was deliberately NOT extended to 17 names.** A longer literal list reproduces the
defect one generation later, and it would let this criterion be zeroed by renaming identifiers rather
than by removing restatements. POD-368 owns the redefinition; POD-366 has proposed deriving the set
from POD-364's predicate (entity-shaped, ≥2 top-level entity-concept keys, exactly one ADR 4 R1–R6
role) and reporting **per site** rather than as a total — the total is what hid it. Credit to POD-366,
which found the class on the session side (5 of 24 covered); the issue-side numbers above were
measured here.

---

## 2. Two places this work does NOT follow the inventory

The inventory survived three review rounds and was executed from, not re-litigated. Two verdicts did
not survive contact with the code, and both are recorded rather than quietly diverged from.

**#14 `IssueInfo` (workflows) is not a drifted duplicate of #13 `FocusIssueInfo`.** §6.4 says it
deletes in favour of it. `FocusIssueInfo` is `{seq,title,stage,repoPath}` for a superagent prompt
line; `IssueInfo` is a worktree-placement check and the only member any caller reads is
`worktreePath`. They share `repoPath` and nothing else. Collapsing them would force a port to carry
members it never reads and lose the one it does, against ADR 4's rule that narrow R5 ports stay
distinct. Both are now `Pick`s and neither is deleted. `IssueInfo`'s `id`/`repoId`/`repoPath` had no
reader at any call site — typecheck is what established that, not a grep — and are gone with the
relay literal that supplied them.

**#16 `IssueAutoArchiveObservation` must stay restated.** Its field names coincide with the
aggregate's; its schemas do not. `.min(1).max(256)` are input bounds on an untrusted steward
payload, and `archived: z.literal(false)` / `deletedAt: z.null()` are preconditions the observation
asserts about the state it saw. Composing them from `IssueWire` would turn a gate that refuses a
wrong-state payload into one that accepts it. An audit number is not worth loosening a validation
gate.

**And the exemption is now enforced, not merely declared.** The schema had **zero test coverage**, so
"these divergences are load-bearing" was prose that nothing defended — a tidying composition would
have passed every lane. Two things changed: the reason is recorded *on the schema*, naming the
divergence class (**a validation gate over untrusted input**), because an unexplained exemption is
indistinguishable from someone silencing a detector; and five tests make the gate refuse what it
exists to refuse, each mutating exactly one field of an otherwise-valid payload with the valid
payload asserted first as the counterfactual. A representation audit that counts this shape must
count it as **declared-legitimate with its reason**, not as debt — "not yet composed" and "composing
would be wrong" have opposite correct actions. `SessionAutoArchiveObservation` in the same file is
POD-366's twin of this, untouched here.

---

## 3. The multi-user obligations, answered

### 3.1 Cross-boundary graph edges — both answers expressible, neither chosen

Acceptance criterion: the graph projections must express BOTH the hide-the-edge and the
opaque-reference answers *without a second projection function*, and hand the decision to POD-290
undecided. `docs/multi-user-readiness.md` §3.1.2 leaves it open.

**Met, and proven by test rather than asserted in prose** (`entities/issue-projections.test.ts`):

- **hide-the-edge needs no shape at all.** `IssueGraph` parses with a node and its edges omitted, and
  every member of `IssueGraphNode` is required — so a suppressed node cannot be half-emitted with
  some fields blanked.
- **opaque-reference is `IssueGraphNode.pick({ id: true })`** — a *narrowing of the same projection*,
  not a second one.

What keeps the second answer available is that `IssueRefHead` is **identity-only** and content
(`title`, `stage`, `priority`) is added by mask. Folding any content member into the head would make
an opaque node unemittable without leaking content; the test pins that the pick yields `id` alone and
carries no `title`, and the schema comment says not to fold. **The decision itself is NOT made here.**

### 3.1a What the composition does NOT guarantee

The claim POD-302/POD-364 rest on is that composing a representation from a shared field schema means
*adding a field to the model propagates, or fails compilation*. **At conditional-spread producers that
claim is false, and this ledger does not make it.**

Verified on this base, not inferred: in `crud.ts update()`,
`patch = { ...patch, ...(!('defaultModel' in patch) ? { defaultModel: 'auto' } : {}), … }` assigns to
an `IssuePatch`-typed variable, and renaming the inner key to `defaultModelTYPO` leaves
`--filter @podium/server typecheck` at **exit 0**. **Appending `satisfies IssuePatch` to the outer
literal does not close it either** — tested; the typo still compiles.

**The precise rule — narrower than this ledger's first revision claimed, and than the fleet broadcast
that quoted it.** POD-366 re-checked a mapper of the same shape *expecting* a survivor and got a kill;
its five-case probe was reproduced here independently (three cases red, so the probe proves itself):

| Case | Result |
|---|---|
| `const a: T = { req, bogus: 1 }` | **TS2353** |
| `const b: T = { req, ...(cond ? { bogus: 1 } : {}) }` | no error |
| `const c: T = { ...(cond ? { req } : {}) }` | **TS2322** |
| `const d: T = { req, bogus: 1, ...(cond ? { opt } : {}) }` | **TS2353** |
| `const e = { req, ...(cond ? { bogus: 1 } : {}) } satisfies T` | no error |

So: directly-written keys **are** excess-checked even with a spread in the same literal (d); a key
supplied **inside** a conditional spread escapes (b) and `satisfies` does not rescue it (e); a
**required** key supplied only via a spread **is** caught (c).

**And a fourth clause, which says what the composition DOES buy at these sites.** POD-362 reported that
branding still propagates through a conditional spread. Probed here — and the first probe was wrong in a
way worth recording: using a *required* branded key conflated this with clause (c), since a required key
via a conditional spread is unassignable regardless of its type. Re-probed with an **optional** key so
clause (c) cannot fire:

| Case (optional key, inside a conditional spread) | Result |
|---|---|
| branded key, raw `string` value | **TS2322** |
| plain key, wrong primitive type | **TS2322** |
| unknown (excess) key | no error |

So it is **not** a fact about branding — it is the general fact, of which branding is one instance:
**through a conditional spread the TYPE of every KNOWN key is still checked; only key-set MEMBERSHIP
escapes.** That makes the precise statement of what composition buys at a conditional-spread producer:
it propagates every field's *type* (brands included — which is why composing `RefIssueLike` caught
eleven fixture sites), and it does **not** catch a *stale or misspelled optional* key. The exposure is
key presence, not type correctness. **The exposure is specifically an
OPTIONAL key inside a conditional spread** — which is exactly how a producer keeps emitting a field the
model has renamed or dropped. "The annotation constrains nothing" was my overstatement, generalised
from one observation; case (d) disproves it. The narrow rule is also the more useful one, because it
gives the sweep a triage criterion instead of licensing a rewrite of literals that were already safe.

So `CreateIssueInput` and `IssuePatch` are correctly composed, and their *types* now have one home —
but the propagation guarantee stops at those producers. Filed as **POD-1138** (a repo-wide producer
sweep, not a site) rather than grown into this diff. Credit to POD-366, which found the class by
mutation after a mutant it expected to kill survived; the `satisfies`-does-not-rescue-the-spread half
was verified here.

### 3.2 Entity-in-entity nesting

`IssueWire.sessions: SessionMeta[]` **survives on this branch, deliberately and not by omission.**
The coordinator's instruction is explicit: it is deleted at POD-308, and it is to remain a plain
cross-module reference in the meantime — nothing spreads it, reaches into it, or derives from it, so
its removal will not touch a call site. This branch preserves that property and does not harden the
embed.

The reason it must go is recorded as what it is, and it is **not a perf note**: with one operator the
embed is O(world) per change; with N users each holding a different slice it is O(world × N), and —
the part that makes it a correctness matter — **an embedded child carries a visibility class of its
own, so a nested session the reader may not see cannot be filtered out of the parent projection
without either lying about the parent or leaking the child.** De-nesting is therefore a
**prerequisite for scoped feeds (POD-1077)**, not an optimisation.

Two further embeds are in the issue set: `IssueTreeNode.sessions: IssueTreeSession[]` and
`ShowWire.sessions: ShowSession[]`. §6.4 says `IssueTreeNode` should carry `sessionIds` instead.
**Settled with POD-366: all three embeds go at POD-308, for one shared reason.**

The deciding argument is POD-366's and it is stronger than the perf one: **de-nesting
`IssueTreeNode.sessions` has no receiver.** `podium issue tree` and `issue show` get a single tree
payload over one tRPC round trip through `@podium/issue-client`, and the CLI holds **no session
collection** to resolve ids against — so `sessionIds: SessionId[]` would render as bare ids and the
labels and phases the CLI prints today would vanish. Recovering them needs a second round trip the
CLI does not make. The web client is the only consumer that *does* hold a session collection, and it
is not the consumer that breaks. This is the same class as §6.4's own note marking
`sessionSummary`/`childCount`/`childDoneCount` as D7.4 **materialized-entity** candidates "once the
feed is scoped: a rollup over rows a scoped client may not hold cannot be a replica-side join."

**Therefore the acceptance criterion "no entity-in-entity nesting survives in the issue
representations" is NOT MET by POD-367, and is reported as not met** — three declared deferrals, one
shared reason (a scoped-feed prerequisite, not a perf note), one named owner (**POD-308**). It is not
reported as two-thirds met: the `IssueWire` embed is preserved on explicit instruction and the other
two are blocked on the same prerequisite, and presenting that as partial completion would mislead.
Declared here and mailed to POD-368 so a later pass does not silently "fix" it.

### 3.3 Owner, visibility, and create-time inheritance

Every representation in this set is in the **PERSONAL** visibility class (ADR 9 D3) — issues, their
comments, and their tracker mail alike. The `owner` member itself composes POD-365's `Ownership`
group and lands with the aggregate re-derivation, which is blocked (§4).

**Create-time owner/grant inheritance is OPEN and stays open.** Does a comment or a child issue
inherit its parent's owner and grants, or the actor's? §3.1.2 leaves this deliberately open and
declares it per class; inheriting the parent is almost certainly right, because otherwise sharing an
issue does not share its work. **This issue does not answer it, and nothing in the representations
precludes either answer**: ownership is a flat member on the aggregate with no positional encoding
and no inherited-from marker, so a per-class policy can resolve it either way at create time without
a shape change. Handed to POD-290.

### 3.4 Attribution

`humanQuestionAskedBy` retains its server-authoritative, agent-vs-human-distinguishing property, and
the characterization work **hardened** it rather than merely preserving it. Pinning the optimistic
switch surfaced that its `setNeedsHuman` arm stamps `humanQuestionAskedAt` unconditionally while
carrying `humanQuestionAskedBy` only when the input happens to supply a string — a value that answers
*when* a question was asked while answering nothing about *who*, which is exactly the split ADR 9 D5
A3 forbids. POD-365 responded by nesting the tuple as one optional-as-a-whole `asked` object, so the
timestamp cannot exist outside the object carrying its actor. The offending arm becomes a compile
error at the POD-311 cutover instead of a silent gap.

**The finding generalised to three sites, and the two it did not start with are the worse ones.** Both
are cases of *a field that looks like attribution and answers a different question* — the same
category error as collapsing the pair, which is why a field name is not evidence of attribution:

- `SessionTombstone.deleted` — session deletion had **no actor at all**. `deletion_source` is a
  code-**path** label, not a person, so "we record `deletion_source`, therefore deletion is
  attributed" was false.
- `SessionNaming.namedBy` — `nameSource` is a **role class** (`'user' | 'agent'`), not a person, even
  though [spec:SP-eb60]'s rule that a human-set name outranks an agent-set one depends on it.

All three now nest the timestamp inside the object carrying the actor, so a half-filled value does not
typecheck. Those two are session-side and belong to POD-366/POD-365; recorded here because the class
was found on this surface.

### 3.5 Per-user state

`readAt`, `unread`, `tuckedAt`, `deferUntil` and `pinned` are still singletons on this branch because
POD-1076 has not landed its `(userId, entityId)` family. **No bridge singleton was added and none was
blessed** — they are inherited, not introduced. POD-365 has already removed `pinned` from
`IssueTriage` on that ground.

One consequence found here and filed rather than fixed — **POD-1136**: the steward's auto-archive
precondition *reads* `readAt`. "Archive it because it was read" has to answer "read by whom?" once
read-state is per-user, or one person opening an issue archives it out of everyone else's sidebar.
That is a policy call (all grantees / the owner / drop the precondition), not part of POD-1076's
mechanical re-key.

### 3.6 Tracker mail is not an existence oracle — with one field to constrain

The mail representations were audited against the consistent-error rule (ADR 9 D7: addressing an
invisible issue must fail *identically* to addressing a nonexistent id).

**No member distinguishes the two cases by construction.** `IssueMessageRow` carries
`id`/`issueId`/`fromAuthor`/`body`/`createdAt`/`status`/`claimedBy`/`readAt`/`claimedAt` — nothing
that reports visibility or existence. `mailSend`'s input is `{ id, body }`. `disposition` is a
**closed** enum (`SendDisposition`), and a closed enum cannot leak more than its members.

**One field is the concrete leak vector and should be constrained when POD-290 enforces the rule:**
`MessageSendResult.reason?: string` is **free-form text**. A free-text reason is where "no such
issue" and "you cannot see that issue" diverge into two different strings while the enum stays
identical. Also worth noting for whoever implements it: today, when the target is gone there is no
legacy mirror row and the handler *synthesizes* one, so the two paths are already structurally
distinct inside the handler even though the returned shape is the same. Enforcement is the command
layer's, not this issue's — recorded so it lands somewhere.

### 3.7 Parent and reparent are permission-affecting

Recorded here because the field definitions have no other home yet. A subtree scope is a **moving
set**: reparenting an issue under a different epic widens or narrows a working agent's visibility with
nobody having decided it (§3.1.5, case 2). `parentId` is therefore not an ordinary triage field —
**writing it changes who can see the subtree.** Whether that warrants a confirmation when the move
crosses an owner boundary is OPEN and belongs to POD-290. Note that the write side needs no new
mechanism: dependency and graph edges already carry a scope target and already route through
`overrideScope` → confirm-required (ADR 3 D2).

### 3.8 Issue description and notes: the op-stream class is reserved, nothing built

§4 of the readiness doc reserves `op-stream` for collaborative text, and issue description/notes are
in its small named set. This issue's obligation was narrow: do not bake a whole-body
last-writer-wins assumption into those field definitions, and do not shape them so that a document
carrying a **materialized value plus a bounded recent-op tail** becomes a breaking change later —
that shape is what keeps ADR 2 D5's head-pruning safety proof intact, because D5 depends on the
bootstrap snapshot being *positive state*, and for a document the truth is the materialized document.

POD-365 landed the shape as `IssueDocuments` — `{ value, revision?, ops? }`, `value` required so the
read position stays compatible with the string it replaces. That neither implements op-streams nor
annotates conflict classes (POD-304 owns the annotation), and it does not preclude the tail.

**One constraint was flagged back to POD-365 and has been adopted** (`ce014033`): `ops` is now
**`opsTail`**, with the bound stated in the field comment. The rename is not cosmetic — `ops` reads as
*the history*, and a document rebuilt by replaying an unbounded history is exactly the head-pruning
hazard D5 note 1 warns about, because D5's safety proof needs the bootstrap snapshot to be **positive
state**. Anything other than materialized-value-plus-bounded-tail needs the log-compaction ADR that
ADR 2 already parks, and now whoever builds op-streams inherits that constraint from the field rather
than from an ADR two documents away. POD-365 re-proved wire additivity against the pre-POD-365 corpus
*before* regenerating: removed 0, changed 0, added 123, with only the four shape-carrying schemas
moving.

On the write position, no change is wanted: `value` being required keeps the *read* position
shape-compatible, and every *write* site learns the wrapper at the `IssueWire` re-derivation — which
is the right place for it to land, since the alternative is a plain `z.string()` that has to change
shape later, exactly what §8 asks POD-365 not to leave behind.

### 3.9 Existence leaks

Contributed, and **already present** in POD-364's list — verified rather than assumed: issue
ref-letter allocation is **L-6** (`issue_ref_letters`, `refLetter`, `repo_draft_seq`, `refDraft`,
`seq`) and issue counts are **L-2** (`IssueCount`'s per-assignee histogram, `IssueStats`). Nothing to
add; the policy is POD-290's and is not decided here. The `reason` free-text finding in §3.6 sharpens
**L-11** from "this path is an oracle" to "this field is the vector".

### 3.10 Not multi-tenancy

No `instance_id`, no instance partition, nothing reserved for one. ADR 1 D5 stands: multi-user lives
*inside* one instance.

---

## 4a. `IssueWire` is blocked by a circular import — proven, measured, and filed

The one representation named first in the acceptance criterion is the one that cannot be composed
yet, and the reason is architectural rather than sequencing. **Filed as POD-1141** (sub-issue of this
one) with the measurements below so none of it is redone.

**The cycle, proven not inferred.** `packages/model/src/fields/issue.ts` imports `IssueColor`,
`IssueGitState`, `IssuePanel`, `IssueSessionSummary`, `IssueStage` and `IssueType` **from**
`entities/issue.ts` (and re-exports them). So `entities/issue.ts` cannot import the field groups to
compose `IssueWireCore` from them. Because these are zod schema **values** evaluated at module load,
it fails at runtime rather than at lint: substituting one key (`id: IssueIdentity.shape.id`) and
running the model tests gives

    TypeError: undefined is not an object (evaluating 'IssueStage.optional')

— `fields/issue.ts` sees `IssueStage` as `undefined` when `entities/issue.ts` is entered first. The
probe was reverted; it reproduces in one line.

**Measured before stopping, so POD-1141 starts from data.** Comparing each wire key's zod `_def` JSON
against the field groups' members: **44 of `IssueWire`'s 78 keys are type-IDENTICAL** to a group
member and are therefore byte-safe substitutions once the cycle is gone. The **34 that differ fall
into named classes**, not arbitrary drift: the renames POD-365 deliberately kept off the wire
(`blockedBy`/`blockedByNotes`, `origin`/`intentOrigin`, `draft`/`isDraftVessel`), the `IssueDocuments`
wrapper (`description`/`notes` are objects in the aggregate, strings on the wire), the flattened
needs-human tuple (four independent optionals on the wire, one optional-as-a-whole `asked` object in
the group), per-user state absent from the aggregate by construction, derived rollups and edge arrays
whose optionality differs, the deprecated `comments` array, the `sessions` embed, flat provenance, and
`createdAt`.

**A trap that an automated pass walks straight into, recorded because it nearly caught this one.**
Type identity is **necessary but not sufficient**. `IssueGitState.updatedAt` is the *last-probe*
timestamp and `IssueGitState.branch` is *the branch the checkout is actually on* — both are
type-identical to `IssueWire.updatedAt` (entity mtime) and `IssueWire.branch` (the issue's branch),
and both are **different facts**. Substituting them would typecheck, would leave the encoded bytes
identical, and would be **wrong**, with no test able to see it. The mechanical comparison tells you
which substitutions are byte-*safe*; it never tells you which are *correct*. Ownership must be
asserted per key by hand — which is how `updatedAt` was excluded here and `branch` was pointed at
`IssueWorkspace` rather than `IssueGitState`.

---

## 4. What is blocked, and why it is not worked around

Six representations (#2, #3, #6, #7, #8, and the `Ownership`/`Attribution` members of all of them)
are `Pick`s from the thirteen shared field groups POD-365 owns. POD-365 has landed them — as
`69d1cfc6` **on its own branch**.

They are not consumed here because the coordinator's instruction is explicit: *do not rebase onto or
merge POD-365; I own integration and will land POD-365, then you.* POD-365 had said "pull it", which
briefly looked like a conflicting instruction — **it has since withdrawn that** as a statement about
symbol *visibility* rather than a merge instruction, agreeing the coordinator wins. So there is no
tie to break: this is not a deadlock, it is **waiting for a merge the coordinator already intends to
perform in this order**, which is a materially different thing for a reader of this ledger.

The Picks are still not written speculatively. POD-365's exported names are final and will not move,
so churn is no longer the risk — but writing them here would hand a reviewer code that **neither
author can compile in their own tree**, which is precisely the failure the fan-out's verification rule
exists to prevent. They typecheck the moment the branches meet, and that moment is the coordinator's
to choose. (A ruling request remains queued in case it wants to rule for all three implementers, since
POD-366 resolved the same question the other way and has already consumed POD-365.)

The three CLI retirements (#7, #8, and #6's session member) carry a second, independent blocker worth
stating because it is easy to mistake for laziness: `packages/issue-client` and `apps/cli` cannot
import from `apps/server`, which is *why* those copies were hand-written. Deleting a duplicate and
importing the original therefore requires the single definition to sit in a package both sides may
depend on. POD-366 proposed `packages/model/src/projections/`; this session counter-proposed keeping
a projection beside the entity it projects (`entities/<entity>.ts`), since `entities/issue.ts` already
holds three projections deliberately and two homes for one entity is the shape this programme is
deleting. One convention matters more than which one — if POD-366 prefers `projections/`, this
session matches it.

---

## 5. Files shared with sibling sessions

Four files contain both the session and the issue representation sets. Boundaries agreed with POD-366
for three of them (`apps/server/src/store/types.ts`,
`apps/server/src/modules/issues/service/types.ts`, `packages/issue-client/src/commands.ts`) — each
session touches only its own interfaces and neither reorders the file. The fourth,
`packages/model/src/predicates/machine-selection.ts`, holds `HandoffIssue` (#11, this set) beside the
session handoff predicates and had been declared by nobody; it is mailed and left unedited. `relay.ts`
and `router.ts` contain both session- and issue-shaped inline literals (D-16) and are flagged as a
conflict surface; only the one issue-shaped literal that fed the workflows port was touched.

---

## 6. Verification

Lanes actually run, uncached, on this branch:

| Lane | Result |
|---|---|
| `bun run --filter @podium/model typecheck` | exit 0 |
| `bun run --filter @podium/protocol typecheck` | exit 0 |
| `bun run --filter @podium/server typecheck` | exit 0 |
| `bun run --filter @podium/web typecheck` | exit 0 |
| `bun scripts/check-boundaries.ts` | boundaries OK — 58 allowlisted, **0 new** |
| `bun scripts/rearch-audit.ts` | deletion audit OK — 21 items, 261 sites, **baseline exact** |
| `bun scripts/check-no-nul-bytes.ts` | ok |
| `wire-golden.test.ts` | 87 passed |
| `entities/issue-projections.test.ts` | 9 passed (new) |
| `upstream-forwarder.optimistic-patch.characterization.test.ts` | 24 passed (new) |
| issues + workflows + superagent + git-state modules | 59 / 97 / 8 / 27 passed |
| web unit lane (full) | 173 files, 1361 passed, **1 failed** — see below |

**The one web failure is a load flake, and it is reported as a flake rather than as green.**
`IssuePage.agent-start.test.tsx` times out at 5000ms inside a menu interaction. It passes **3/3 in
isolation** with this branch's change present, and this branch's only change in that directory is
type-only with no runtime effect. An earlier full-lane run under concurrent load showed 4 files / 6
tests failing; the same lane run alone showed 1 — the difference was the load, not the code.

**Instrument check.** The four composed read projections ride tRPC results, not frames, and grep
confirmed **no** golden fixture covers them — so before this branch, nothing was measuring their key
order at all, and a green suite would have meant only that. Key orders were captured from the
schemas *before* the composition and pinned afterwards; they are identical.

**Which source tree the instruments actually read** — established, not assumed, after POD-366
reported a full lane whose stack traces resolved into a *sibling* worktree. `vitest.config.ts`
aliases `@podium/*` via `new URL('./packages/…', import.meta.url)`, i.e. relative to the config file,
so a lane launched from this worktree root reads this worktree. The conclusive evidence is not the
config but the mutants: each one edited a file **in this worktree** and changed the result of a test
run **here**; had the lane been reading another tree, every mutant would have been a false survivor.
Same for typecheck — `--filter @podium/web` reported eleven branded-id errors that exist only because
of this branch's `ref-miniview.ts` edit. Note `node_modules/@podium` does not exist here at all, which
is why a raw `bunx tsgo -p packages/sync/tsconfig.json` fails to resolve `@podium/model` while the
aliased vitest and `turbo --filter` lanes work; an instrument resolving through `node_modules` is the
one to distrust. The web lane log was checked for NUL bytes **by reading bytes in python, not with
grep** (0 NULs, 1527 bytes, zero references to a sibling worktree) — grep being the tool that would
lie about it.

**A lossy capture is the same failure as a NUL byte.** The first full web lane ran backgrounded into a
capture that retained only its last 12 lines, so grepping for the failing test names returned nothing
— not "no match" but "the match was discarded". Re-run into a log this session controlled.

**Prove the instrument can say YES before you believe it saying NO.** Three rules in this ledger turned
out to be one rule: a red control beside every green assertion; a counterfactual in the fixture; and —
the case that caught a test written *in this session* — a bound needs its **accepted** side asserted at
the boundary, because "it refuses bad input" is satisfied by a parser that refuses everything. The
auto-archive bound test asserted only the refused side, and the valid fixture did not rescue it: its
`issueId` is 5 characters, so a bound wrongly tightened to `.max(6)` would have passed every case in the
file. Now 256 and 64 exactly are asserted to PASS, and mutating `.max(256)`→`.max(6)` reds it (1 site,
hash `0e1c6c7b`→`3ea308f7`). Generalised with POD-366.

**The exactly-once assertion earned its keep immediately.** Attempting that mutant with the obvious
pattern `issueId: z.string().min(1).max(256)` matched **twice** — both auto-archive observations carry
an `issueId` — and the helper refused to run. Had it proceeded it would have mutated both schemas; had
the assertion been *at-least-once*, the run would have gone green with **no mutation applied at all**
and read as a survivor. That is the broadcast's false-green, reproduced live rather than taken on
faith.

**A red control beside every green assertion.** Three separate instrument failures in this run share
one shape — a never-applied mutant reading as a survivor, a `grep` silenced by NUL bytes, and a
five-case type probe whose green cases could equally mean "the check is absent" or "I mis-set up every
case". In all three the instrument was **silent and the silence was read as a result**. The cheap
general defence is a red control: the five-case spread probe is trustworthy *because three of its cases
red*, and the single-case `crud.ts` test that preceded it was not. Related, and the reason the spread
finding got corrected at all: **a mutation result that contradicts your stated expectation is a finding
about your model of the system even when the suite behaves.** POD-366 expected a survivor, got a kill,
and reported the kill instead of banking it.

**Mutation protocol, and why the survivor-shaped result was re-checked.** A mutant that FAILS TO APPLY
is indistinguishable from a mutant that survives — both print a green suite, and the bias is toward the
most intricate code, whose coverage you most wanted to prove (POD-366's finding, broadcast by the
coordinator). Every mutant here used exact-string replacement asserting the text changed, and the two
results that could be ambiguous were re-run under the full three-assertion protocol: **pattern matched
exactly once** (not at-least-once — a pattern hitting a different field of the same name also reads as
a survivor), **file hash changed**, and **the mutant text grepped back out of the file after writing**.
Reverts verified with `git diff --quiet`.

Re-checked that way: the survivor-shaped compound auto-archive mutant (applied at 1 site, hash
`0e1c6c7b`→`8d5dcba1`, text confirmed present → 3 tests red) and the most load-bearing single claim,
the `clearNeedsHuman` characterization mutant (1 site, `fe71f94f`→`b0b2028b`, text confirmed → exactly
its own test red). A kill is self-proving — something went red, so the mutant applied; only
survivor-shaped results are ambiguous, which is why those are the ones re-verified.

**Mutation evidence.** Eleven mutants, all killed, product file reverted clean after each (one at a
time, and after committing — an early revert-to-HEAD during this work discarded uncommitted edits,
which is the reason the order is commit-then-mutate):

| Mutant | Killed by |
|---|---|
| drop the `color: null → undefined` rewrite | `rewrites color:null … KEEPS the key present` |
| `defer`'s `deferred` always true | `defer mirrors deferUntil …` |
| `clearNeedsHuman` also clears `humanQuestion` | `clearNeedsHuman … leaves the question tuple STANDING` |
| add an `undefer` arm to the switch | the classification test **and** the marker-only list |
| reorder `IssueGraphNode`'s pick mask | `IssueGraphNode` key-order pin |
| restate `IssueRefHead` as `z.object({id: z.string(), seq: z.number(), …})` | `rejects a non-integer seq …` |
| fold `title` into the opaque-reference pick | `opaque-reference is a NARROWING …` |
| `archived: z.literal(false)` → `z.boolean()` | `refuses an ALREADY-ARCHIVED issue …` (only) |
| `deletedAt: z.null()` → `z.string().nullable()` | `refuses a DELETED issue …` (only) |
| `IssueGraph` gains an edge/node referential-integrity refinement | `an edge may name an id absent from nodes …` |
| `IssueGraphNode` wrapped in a refinement (loses `.pick`/`.extend`) | the projection-narrowing test (module-level `TypeError` — a coarse kill: it breaks the file rather than the assertion, recorded as such) |

No survivors — but one **apparent** survivor is worth recording, because the lesson generalises.

A first, COMPOUND mutant composed *both* auto-archive preconditions away at once. It killed three
tests and the `archived` one appeared to survive. It had not: the same mutant also broke `deletedAt`,
so the archived fixture still failed to parse and the assertion `success === false` stayed true **for
the wrong reason**. Per-constraint mutants tell the truth — `archived`-only kills exactly the
`archived` test and nothing else; `deletedAt`-only kills exactly the `deletedAt` test.

**A compound mutant can mask a per-constraint kill and read as a survivor — and symmetrically, it can
read as a kill when a different constraint did the work.** Mutate one constraint at a time, and when a
mutant seems to survive, check whether a neighbouring constraint absorbed it before drawing any
conclusion about the test.
