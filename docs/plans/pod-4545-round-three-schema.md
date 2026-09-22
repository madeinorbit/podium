# POD-4546 (L1a) — Round three: the declared model schema

Status: for review · 2026-09-22 · L1a of POD-4545 (integration branch
`integrate/4545-round-three`).

The declaration itself is `packages/worklist-proto/shared/src/schema.ts`. It is
plain data — no classes, no decorators, no behaviour. This document says what
each relation means, walks one concrete graph, and states the maintenance rules
the pool must implement. Both substrates (Ma2 MobX, Ha2 hand-rolled) build from
this one declaration; neither implements a pool here.

> Filename note: the brief names `pod-pod-4545-round-three-schema.md`. That
> repeats the prefix; this file follows the repo convention
> (`pod-4441-round-two-slice.md`, `pod-4286-prototype-methodology.md`).

## 1. Why a declaration at all

The round-two audit's finding, verbatim: "each round-two arm reinvented
relationship maintenance inside its own derivations, where most of its bugs and
lines went, instead of one metadata-driven pool layer"
(`docs/decisions/4441-round-two-audit.md` §7, "What we do wrong" (2)). The same
paragraph describes what Linear does instead: "one normalised object pool, one
instance per entity; relationships declared once as model metadata (a reference
id resolves to an instance and the pool maintains the inverse collection on
every insert, update and delete)".

So the comparison round three runs is only fair if both substrates maintain
relationships from the *same* declaration. Anything either arm hand-writes per
relation is a finding against that arm, not a difference in substrate.

Three consequences shape the file:

- **Fields cite a source, and the citation is checked.** `@podium/model` defines
  every entity as a zod object [ADR 4], so `Object.keys(schema.shape)` is the
  authoritative field list *at runtime*. `validateSources` resolves every
  declared field against it. A field that does not exist fails a test instead of
  surviving as a comment.
- **Relations are declared on both sides, and a collection has no key of its
  own.** `hasMany` is defined as the inverse of a `belongsTo`, a `prefix` or an
  outgoing `edge`. There is therefore exactly one maintenance path per edge, and
  a collection cannot drift from the reference that produces it.
- **Lazy is derived, not typed in.** See §5.

## 2. Entities

Four entities. The issue projection is a **component** of `issue`, not a fifth
entity: an issue is the wire row joined with its normalized projection row by
`id` (slice §1; `replica/contract.ts:92-110`). The wire wins when both are
present and the projection is the fallback, which is what the round-two feed
does (`shared/src/row-source.ts:330-341`) and what becomes the sole source once
the authority's flag is on.

| Entity | Key | Composed from | Why it exists |
|---|---|---|---|
| `issue` | `id` | `IssueWire` (`replica:issues`) + `IssueProjection` (`replica:issueProjections`) | The unit of work the worklist draws one row per. |
| `session` | `sessionId` | `SessionMeta` (`replica:sessions`) | An agent or shell at work; what makes an issue look alive. |
| `worktree` | `path` | `GitWorktreeWire` + the repo-root lane of `GitRepositoryWire` (`engine:repos`) | The containment root longest-prefix session ownership resolves against. Not rendered (slice §6). |
| `repo` | `id` | `RepoProjection` (`replica:repos`) + `GitRepositoryWire` joined `id ↔ repoId` | Supplies the group key, the label and the `displayRef` prefix once, instead of on every issue. |

`repo` is also a composite: the replicated row carries `(id, prefix)` and
nothing else, while the path — and so the group label — comes from the machine's
scan row.

### Two fields round two carried that this schema does not

- **`issue.unread`** is a rollup over the issue's sessions
  (`replica/issue-views.ts:391-410`), not a property of any issue row. Carrying a
  rollup as a field is how it goes stale; it belongs to the row view contract
  (L1b) as a derivation over the `sessions` relation. `session.unread` *is* a
  real `SessionMeta` field and stays.
- **`issue.prefix`** was the denormalized repo join. Round three reads
  `issue.repo.prefix`. That is what the `repo` entity is for, and it is the
  smallest concrete example of "views are functions of the graph".

Both absences are asserted in `schema.test.ts`, so neither can quietly come back.

### One name that was not available

`IssueWire.origin` is an existing field — `'human' | 'agent'`, who created the
issue (`model/src/entities/issue.ts:288`). The R4 relation is therefore named
**`discoveredFrom`**, with inverse `spinOffs`, not `origin`. The validator
forbids a relation name that shadows any property of the composed row, including
properties this schema does not declare as fields, because the pool holds the
whole row. That rule fires on `origin`; the test proves it.

## 3. The relations

Seven declared pairs. Four are the frozen slice's R1–R4; the other three replace
denormalized fields with graph edges.

**`issue.parent` / `issue.children` — the formal tree (R1).** A `belongsTo` over
`issue.parentId` matched against `issue.id`, with `children` as its inverse
collection. Membership is filtered: an archived or deleted issue contributes no
edge (`missionParentId`, `mission.ts:905-907`), so its children surface as roots
rather than vanishing — the same rule `buildIssueTree` follows. Roll-ups walk
this relation; the roll-up rules themselves are L1b's.

**`issue.sessions` / `session.issue` — explicit membership (R2).** A `belongsTo`
over `session.issueId`, with `sessions` as the inverse collection. Headless
sessions contribute no edge. Note what is *not* here: the precedence rule
"explicit membership first, then prefix containment" is a view rule composing two
relations, not a relation of its own. The graph maintains both; L1b applies the
precedence (§4.5 shows the composition).

**`session.worktree` / `worktree.sessions` — containment ownership (R3).** The
only relation that is not a key join, which is why its resolver is declared
explicitly rather than implied: `longestPrefixPath` normalizes one trailing slash
so `a` and `a/` name one root (`/` is kept — it is a real root and `''` is not),
matches a root when the probe equals it or lies strictly inside it, and takes the
**longest** match, reproducing the scan's tie-break
(`model/src/identity/worktree.ts:30-47`). A session whose cwd sits under a
checkout belongs to that checkout and never renders orphaned
(`session-ownership.ts:161-164`). Sibling paths that merely share a prefix
(`/repo-two` under root `/repo`) do not match; the test pins that.

**`issue.discoveredFrom` / `issue.spinOffs` — the provenance edge (R4).** An
`edge` over `issue.deps`, filtered to type `discovered-from`; `direction: 'out'`
names the spin-off's origin (`spinOffOriginId`, `mission.ts:479-483`) and
`direction: 'in'` is the inverse set of issues discovered from this one. The
authoritative rows are the first-class `issueDeps` edges
(`IssueDepProjection`, `replica/contract.ts:102-105`); `issue.deps` is the wire's
denormalization of them, and the feed guarantees an edge change arrives with its
owning issue's wire row (`row-source.ts:64-70`). The pool therefore reads **one**
source. The full continuation walk and `blocks` edges stay out of scope (slice
§6): R4 is the single edge, not the graph.

**`issue.worktree` / `worktree.issues`.** A `belongsTo` over
`issue.worktreePath` matched against `worktree.path`. This is the edge that makes
R3 usable from an issue: an issue reaches its prefix-owned sessions as
`issue.worktree.sessions`, with no scan.

**`issue.repo` / `repo.issues`.** A `belongsTo` over `issue.repoId`. It replaces
the denormalized `issue.prefix`: `displayRef` reads `issue.repo.prefix`, and a
prefix change moves every `POD-13` in the repo without rewriting an issue
(`replica/contract.ts:106-110`).

**`worktree.repo` / `repo.worktrees`.** A `belongsTo` over the `repoId` the feed
stamps onto each lane from the containing scan row (`row-source.ts:313-321`).
`GitRepositoryWire.worktrees` — the nested array those lanes come from — is
declared `notComposed`: the feed explodes it into `worktree` rows, and the repo
instance reaches them through the maintained relation, never as a raw array.
Leaving it on the instance would put exactly the array-scan shape back that the
epic removes.

## 4. What the pool must do

The rules below are what "the pool maintains the inverse collection on every
insert, update and delete" (audit §7) means concretely. They are the pool's
contract; Ma2 and Ha2 must each satisfy them from this declaration, and the L3
random-change correctness gate targets them.

### 4.1 Insert

Create one instance per entity key, composing its components by their join keys
(a second component arriving later merges into the same instance; lower
`precedence` wins a contested property). Then, for each declared relation of the
new instance:

- `belongsTo` — read the foreign key. If it is null, or the `where` filter
  rejects the row, attach nothing. Otherwise resolve the target and attach **both
  directions**: the reference on this instance, and this instance into the
  target's inverse collection. A target that is not resident yet leaves a
  dangling reference id, which resolves when the target arrives — an unresolved
  reference is never an error.
- `prefix` — resolve `longestPrefixPath(sourceField, roots)` over the target
  collection's keys, then attach both directions as above.
- `edge` (out) — for each entry in the edge list whose type matches, attach both
  directions.
- `hasMany` — nothing. A collection is only ever written from the other side.

Symmetrically, an insert must repair references *into* the new instance: any
dangling reference id equal to this key now resolves, and for a new `worktree`
the prefix relation must be re-run for the affected sessions (§4.3).

### 4.2 Update

Merge the changed properties onto the existing instance — one instance per
entity, always; never replace it, because references point at the object.

Then, **for each relation whose declared inputs changed, detach from the old and
attach to the new, in that order.** The inputs are declared, not inferred: a
`belongsTo`'s `foreignKey`, a `prefix`'s `sourceField`, an `edge`'s `edgeField`,
and — this is the one round two got wrong three times — every field named in the
relation's `where`. An issue becoming archived changes no foreign key but must
still drop its parent edge (R1), and both endpoints must be updated: clear the
reference on this instance and remove it from the old target's inverse
collection, then attach the new pair.

Detach-then-attach, not attach-then-detach: when the old and new target are the
same instance, the reverse order removes the edge it just made.

An update also re-evaluates residency when a field in the entity's
`cold.dependsOn` changed (for `issue`, that is `closedAt`) — see §5.

### 4.3 Delete

Evict carries no tombstone: a row arriving with `value: undefined` deletes the
instance and every collection holding it (slice §2). The pool walks the deleted
instance's declared relations and, for each:

- removes the instance from the inverse collection on the other side;
- nulls references *held by others* that point at it — the holder keeps the
  reference **id** and loses the resolved instance, so a re-insert re-resolves
  it and a child never disappears because its parent did;
- for a deleted `worktree`, re-resolves the prefix relation for every session in
  its `sessions` collection: a session's owner becomes the next-longest root, or
  null. The same re-resolve runs when a worktree is *added*, for sessions
  currently resolved to a shorter root or to nothing. This is the one relation
  where a change to the TARGET collection moves other rows' edges, and it is
  bounded by the affected lane's sessions, never by the corpus.

### 4.4 What the pool must not do

No maintenance path may scan a whole collection. Every rule above is O(edges of
the changed row), with the single bounded exception in §4.3. A "sensitivity set",
"input inventory" or any other hand-maintained list of which derivations depend
on which fields is the round-two pitfall (i) under a new name: the dependency
list is the declaration, or it is a bug waiting.

### 4.5 Worked example

Three issues and two sessions. `I1` is an open parent; `I2` is its open child,
checked out at `/repo/.worktrees/i2`; `I3` is a closed issue that was discovered
from `I1`. `S1` is attached to `I2` explicitly; `S2` has no `issueId` and is
running in `/repo/.worktrees/i2/packages/web`. One worktree lane `W = /repo`
(the repo root) and one `Wi2 = /repo/.worktrees/i2`; one repo `R` with prefix
`POD`.

```
rows in                                     graph after
────────────────────────────────────────    ───────────────────────────────────
issue  I1 {parentId: null, repoId: R}       R.issues      = {I1, I2, I3}
issue  I2 {parentId: I1, repoId: R,         I1.children   = {I2}
            worktreePath: /repo/.worktrees/i2}
issue  I3 {parentId: null, repoId: R,       I2.parent     = I1
            closedAt: …, deps: [            I1.spinOffs   = {I3}
              {id: I1, type: discovered-from}]}
                                            I3.discoveredFrom = I1
worktree W  {path: /repo, repoId: R}        R.worktrees   = {W, Wi2}
worktree Wi2{path: /repo/.worktrees/i2}     Wi2.issues    = {I2}
                                            I2.worktree   = Wi2
session S1 {issueId: I2, cwd: /repo}        I2.sessions   = {S1}
                                            S1.issue      = I2
                                            S1.worktree   = W      (longest root)
                                            W.sessions    = {S1}
session S2 {issueId: null,                  S2.worktree   = Wi2    (longest root)
            cwd: /repo/.worktrees/i2/packages/web}
                                            Wi2.sessions  = {S2}
```

Read it back. `I2`'s sessions for display are `I2.sessions ∪ {s ∈
I2.worktree.sessions : s.issueId == null}` = `{S1, S2}` — explicit first, then
containment, which is slice §2 R2/R3 expressed as a composition of two
maintained relations instead of a scan. Note that `S1.worktree` is `W`, not
`Wi2`: `S1`'s cwd is `/repo`, and explicit membership is what puts it on `I2`.
Note also that `S1` appears in `W.sessions` but is **not** an owned session of
any issue checked out at `/repo`, because it carries an `issueId` — the
precedence rule, applied at read time, is what excludes it. The graph holds both
facts; the view chooses.

Now three changes.

1. **`S2` gets `issueId: I2`.** Only `session.issue`'s foreign key changed.
   Detach nothing (it was null), attach `S2 → I2` and `I2.sessions += S2`.
   `S2.worktree` is untouched: its `cwd` did not move. `I2`'s displayed sessions
   are unchanged at `{S1, S2}` — now both by explicit membership. Work touched:
   two objects.
2. **`I2` is archived.** No foreign key moved, but `archived` is in
   `issue.parent`'s `where.fields`, so R1 re-evaluates: detach `I2` from
   `I1.children`, clear `I2.parent`. `I2.worktree` and `I2.repo` declare no such
   filter and stay. Round two's arms had to remember this by hand in three
   places; here it falls out of the declaration.
3. **`Wi2` is removed** (the worktree is deleted). Walk its relations:
   `Wi2.issues = {I2}` → clear `I2.worktree`, keeping the reference id
   `/repo/.worktrees/i2` so a re-add re-resolves. `Wi2.sessions = {S2}` →
   re-resolve `S2` against the remaining roots; `/repo` still contains it, so
   `S2.worktree` becomes `W` and `W.sessions += S2`. Work touched: one issue and
   one session, not the corpus.

### 4.6 The resume-twin collapse (added by Ma2, POD-4566)

The legacy runtime collapses session rows that point at the same agent
conversation before anything reads them: `dedupeSessionsByResume`
(`model/src/identity/session-identity.ts:45`), applied to every session list
(`client-core/src/engine/optimism.ts:876`). Rows sharing a resume ref collapse
to the most useful one — live > starting/reconnecting > hibernated > exited,
then the most recently active — EXCEPT that a group holding an active row is
kept in full; a headless row never takes part. The per-row feed cannot apply a
rule that reads a row's siblings, so the pool must (coordinator ruling on L3a,
POD-4553).

It is declared ONCE, as `session.collapse` in `schema.ts` (a `CollapseSpec`:
the fields it reads, the group key, the keep-all test, the rank and the
recency field, with the legacy source cited), and decided by one declared
resolver, `collapseLosers`, beside `longestPrefixPath`. Its meaning for the
graph: **a collapsed row contributes no edge to any of its entity's
relations** — to every reader it is not there, as it is not in the runtime's
list. Maintenance: when a row's collapse inputs change, the pool re-decides
the group it left and the group it joined (bounded by the group, never the
corpus) and re-links every row whose collapsed state flipped.

One deliberate difference: on an exact tie of rank AND recency the legacy keeps
the row earlier in the runtime's list, an order no pool has; the declared rule
keeps the lower session id. `schema.test.ts` holds `collapseLosers` to
`dedupeSessionsByResume` on hand-built groups (both directions), and the MobX
pool's `relations.test.ts` holds its maintained collapse to `dedupeSessions` on
every resume-twin group of the corpus (POD-4551).

`validateStructure` checks that every collapse field and the recency field are
declared fields of the entity, each with a negative control.

## 5. Residency: what "cold" means, and Rule L

Linear's bootstrap cost was construction — "making 80–100k objects observable at
bootstrap" — and its fixes were a partial bootstrap of the universal core, cold
collections staying on disk until touched, observability on first access, a batch
loader that deduplicates on-demand loads, and type-level marking of unhydrated
relations (audit §7). Podium's equivalent number is in the same paragraph: every
issue is instantiated at bootstrap, "including ~2,600 closed ones".

So the schema declares residency per entity:

- **`issue`** — cold when `closedAt != null`, with `dependsOn: ['closedAt']` so
  the pool knows which change re-evaluates it.
- **`session`** — cold *via* the `issue` relation. A session row cannot decide
  its own residency; it is cold exactly when its issue is closed. The declaration
  says `via`, not a predicate, because faking a predicate over a field the row
  does not have is how a wrong answer gets written down.
- **`worktree`, `repo`** — never cold. Tens of rows, not thousands.

**What cold means for each substrate.** For both: the row stays on disk
(IndexedDB) and no instance is constructed at bootstrap; the first read of a
reference to it triggers a load, batched with any other loads in the same turn.
The substrates differ only in what happens at that first touch. **MobX (Ma2):**
the instance is constructed and made observable on first access — that
construction is the cost Linear measured, so it must not happen for the ~2,600
closed issues at boot. **Hand-rolled (Ha2):** the instance is constructed and
registered with the dependency graph on first access; there is no observable to
build, so the comparable cost is index insertion. Either way the caller of a lazy
relation can be handed an unhydrated reference and must say so in its type.

**Rule L — a relation is lazy iff its target entity can be non-resident.** Lazy
is about *residency*, not about the cold predicate: a closed issue that has been
touched is resident, but its sessions need not be, so `issue.sessions` can still
require a load. The rule is conservative on purpose — a reference reached from a
resident instance may point anywhere, including into the cold set.

`expectedLazy` computes the flag and `validateStructure` recomputes **every**
declared flag from it, so a hand-edited `lazy` fails the test. That is the point:
per-relation laziness is exactly the kind of flag that drifts when it is typed in
by hand relation by relation. The flags that result:

| Lazy | Not lazy |
|---|---|
| `issue.parent`, `issue.children`, `issue.sessions`, `issue.discoveredFrom`, `issue.spinOffs`, `session.issue`, `worktree.sessions`, `worktree.issues`, `repo.issues` | `issue.worktree`, `issue.repo`, `session.worktree`, `worktree.repo`, `repo.worktrees` |

The flag is per relation and not per entity, which is what the `issue` row shows:
a resident issue reaches its (possibly cold) sessions lazily and its (never cold)
lane eagerly.

## 6. The validation gate

`packages/worklist-proto/shared/src/schema.test.ts`, 22 tests, all green.

`validateStructure` (no zod) checks: the key field is declared; every inverse
exists and points back; kinds are duals (`belongsTo`↔`hasMany`,
`prefix`↔`hasMany`, `edge(out)`↔`edge(in)`); every `foreignKey`, `targetKey`,
`sourceField`, `where.fields` and `cold.dependsOn` names a declared field; every
edge property is declared on the edge list; every `lazy` matches Rule L; no
single-valued edge is declared twice under two names; and each undirected edge
appears exactly twice, once per side.

`validateSources` (zod) resolves every field, every nested part and every
component join key against the real `@podium/model` shape, and checks that no
relation name shadows a property of the composed row.

Both return findings rather than throwing, and the test asserts the lists are
empty — but **every rule has a negative control** that mutates one corner of the
schema and asserts the specific finding. A validator that cannot be shown to fire
is not evidence (round-two pitfall (k): enforcement that warns instead of
throwing). The controls include the two mistakes this work actually made: a
relation named `origin`, and a prefix relation declared over a
`session.worktreePath` that does not exist.

That `replica:<kind>` arrivals name real `ReplicaRows` collections is proved at
typecheck time instead (`schema-sources.ts`), because `ReplicaRows` is an
interface and its keys exist only in the type system.

## 7. What this hands to the next issues

- **L1b (row view contract)** owns: visibility, ordering, grouping, roll-ups
  (`issue.unread` among them), the repo label derived from `repo.path`, and the
  explicit-before-prefix session precedence of §4.5.
- **L2 (per-row feed)** must materialise a `worktree` row for **every distinct
  live `issue.worktreePath`**, not only for paths the repo scan reported. Round
  two's prefix roots are the union of the scanned lane paths and the issues'
  worktree paths (`arms/tanstack/collections.ts:236-238`;
  `arms/hand/indexes.ts`). In a pool-and-graph the root set is the `worktree`
  collection, so without that materialisation R3 silently loses seats for any
  checkout the scan has not reported yet.
- **Ma2 / Ha2 (the pools)** implement §4 from `schema.ts` and nothing else. Any
  per-relation code in either arm is a finding against that arm.
- **L3 (random-change correctness gate)** targets §4: insert, foreign-key move,
  `where`-input move, delete, and the worktree add/remove re-resolve.

## 8. Open questions for the coordinator

1. **Archived and shell sessions.** Slice §2 says archived, headless and (by
   default) shell sessions are never members of R2/R3. The hand arm keeps
   archived sessions *in* the bucket and filters at read, so the unread rollup
   sees the same seats (`arms/hand/indexes.ts:26` indexes on `headless !== true`
   alone). The schema declares only the structural filter — `headless !== true`
   — and hands archived and shell to the read side (L1b). If the intent is that
   the graph itself should drop archived sessions, the `where` filters change and
   L1b's rollup needs another way to see those seats.
2. **The brief's two spellings.** `session.worktreePath` (there is none; the
   prefix relation runs off `session.cwd`, which is what all three round-two arms
   do) and the relation name `origin` (taken by `IssueWire.origin`). Both are
   repaired here and pinned by negative controls; flagged so the parent brief can
   be corrected for the substrate issues that read it next.
