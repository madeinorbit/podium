# POD-643 — the handoff manifest in the vocabulary

**Phase 1 (POD-288), child of POD-302. Representation R6 (portable export), ADR 4 D4.**

Governing documents, in the order the fan-out protocol resolves forks: `docs/adr/` (ADR 4
representation policy, ADR 9 identity/ownership/sharing, ADR 1 + its Amendment 1), then
`docs/multi-user-readiness.md`. Where the brief and those documents differed, the documents won —
see [§5](#5-where-this-work-departs-from-its-brief).

---

## 1. What the issue was for

`HandoffManifest` landed at commit `2b0bc5d4`, *after* the 1.4 split froze, and so arrived as a
ninth hand-restated session projection with every id a raw `z.string()`. POD-302 exists to kill
exactly that drift class.

Two of the four original acceptance criteria were already satisfied by siblings before this issue
started, which is worth recording so the work is not double-counted:

| Criterion | State on arrival |
|---|---|
| Manifest lives in `packages/model`, not `@podium/protocol` | **Done** at POD-300 |
| Ids branded (`SessionId`, `RepoId`, `IssueId`) | **Done** at POD-361 |
| Ownership-matrix row for handoff/bundle | **Done** at POD-304 (four cells pre-decided; one question left for POD-643, answered in §3) |
| Composed from shared field schemas; documented; no rights snapshot | **This issue** |

## 2. What landed

**A POD-368-convention representation entry** (`packages/model/src/entities/handoff.ts`) — purpose,
why the semantics genuinely differ, and what it picks. Three reasons the manifest is not merely
"a session with a different field list":

1. It describes a session being **moved**, not one running. `headSha` / `snapshotSha` /
   `snapshotFlattened` / `bundleBase` are facts about a packaged git state at export time; they
   have no meaning on a live session and must not be added to one.
2. `format: 1` is a **file** version, versioned independently of the wire — an old bundle must still
   parse after the protocol has moved on, which is not a property any wire projection has or wants.
3. `agentKind` is deliberately **narrower** than the shared `AgentKind` (`claude-code` | `codex`),
   because only those two harnesses are exportable. Widening it would make the schema accept a
   bundle no importer can resume. POD-364 §6.4 asked for a decision here rather than an accident of
   copying; this is the decision.

**The no-capability-snapshot audit** (`packages/model/src/annotations/capability-snapshot.ts`) —
`findCapabilitySnapshotKeys` walks a schema at every depth, through `optional` / `nullable` /
`default` / `catch` / `readonly` / array / refinement wrappers, and returns key paths naming a
serialized authority decision. Exported from `@podium/model`: ADR 9 D5 A1 binds every
representation, not just this one, so POD-368's audit should run it rather than rebuild it.

Attribution (`owner`, `actor`, `onBehalfOf`) is deliberately **out** of the detector's scope. Those
are durable provenance that must survive export (ADR 9 D5 A3/A4); folding them in would make the
audit forbid the attribution the ownership matrix requires. Secrets are a separate obligation
(ADR 1 D6, plus the matrix `secret` cell), kept separate so a failure names one thing.

**`HandoffRefusalReason`** — the closed refusal union, threaded as an optional `refusal` onto
`HandoffExportResultMessage` and `HandoffImportResultMessage`. Vocabulary only; the enforcement
belongs to POD-1079 / POD-323 / POD-644 and was handed to each of them in writing.

**A locked key set.** `entities/handoff.test.ts` pins the manifest's keys in wire order. The golden
fixtures pin the encoding of a *value*, which an added optional field slips past unchanged; the lock
pins the vocabulary, so growing the manifest is a deliberate act.

## 3. The two normative rules a portable export is most likely to break

Both are written into the model docs *and* the matrix row, because both invite the opposite reading
at exactly the place they matter.

**No capability snapshot.** An agent's effective rights are its scope intersected with its human's
*current* rights, resolved live at every apply (ADR 9 D5 A1, ADR 3 D8). A bundle that moves between
machines is the single most tempting place to serialize "what this session was allowed to do" so the
target need not look it up. A snapshot leaves an unattended agent running with rights its human no
longer holds, with **no cleanup trigger** — nothing knows the copy exists. Nothing is lost by
refusing: per ADR 9 D5 A5 the agent principal's lifecycle *is* `SessionBinding`, which is why
delegation survives cross-machine handoff for free.

**`owner` is provenance, never an authorization input.** ADR 3 D7 is absolute — the principal comes
from the authenticated transport, never from payload — and a bundle *is* payload, arriving from
outside this trust domain. The manifest's owner records **who exported it**. An imported bundle
claiming an owner must not thereby confer ownership or visibility on the importing side; the import
path decides ownership from its own principal.

**Per-machine facts inherit machine scoping** (ADR 9 D3): transcript path, `worktreeName`,
`worktreeRelativePath`, `cwdSubpath`, `bundleBase` and the repo checkout are facts *about a machine*
and are not classified field by field. `sourceMachineId` is the exception in kind — a *reference to*
a machine rather than a fact about one.

**Visibility class: personal.** Private to owner, shareable, inheriting the packaged session's
scoping. Owner is the on-behalf-of human of whoever minted the bundle; actor is the minting agent or
session (ADR 9 D5 A4). No `instance_id`: ADR 1 D5 stands, this is multi-user and not multi-tenancy.

### Answer to POD-304's open question

POD-304 declared `inheritanceOnCreate: {parent, session-identity}` and asked whether ADR 9 O4's
multi-parent case applies. **It does not.** A bundle packages exactly one session — `format: 1`
carries a single `sessionId` — so there is no second parent to arbitrate between.

Recorded as a declaration with a named reopen trigger rather than as an open item: the question is
closed by construction today and reopens only if the vocabulary ever covers a multi-session bundle.
The trigger cannot fire silently, because the locked key set fails a test when a second session
reference appears, instead of letting it arrive as an additive optional field that quietly inherits
an owner from an ambiguous parent.

## 4. Unauthorized ≠ unreachable: why three arms, not two

ADR 9 D6 M5 asks for an unauthorized-vs-unreachable distinction, which reads like a two-member enum.
It cannot be two. Those two are distinguishable **only inside the principal's `see` set**, where
existence is already disclosed:

| Arm | Meaning | Correct user response |
|---|---|---|
| `unauthorized` | Target visible and reachable; principal lacks `use` | None — someone must grant |
| `unreachable` | Principal may use it; it is offline | Retry later |
| `unknown-target` | Outside the principal's `see` set **or** nonexistent — deliberately indistinguishable | Treat as a bad id |

Without the third arm the refusal becomes an **existence oracle** — the §3.1.2 existence-leak class
arriving at a concrete site. This is the same rule `mailSend` already follows (§3.1.5's
consistent-error rule: mailing an invisible issue must fail identically to mailing a nonexistent id).

And on a refusal, never **retarget**: silently choosing a machine the principal may use is precisely
the failure mode M5 exists to prevent.

## 5. Where this work departs from its brief

- **The brief says seven handoff frames; there are eight** — four request/result pairs (export,
  chunkRead, importChunk, import), matching ADR 4 D4's own count. Documented as eight.
- **The brief's first acceptance criterion is now MET — it was blocked, not skipped.** "Derived from
  the shared session field schemas, zero hand-restated session fields" depended on POD-365. Rather
  than fork its field groups to make this file *look* composed — the drift POD-302 exists to kill —
  the `Pick` set was recorded as a contract with the key list locked, and POD-365 was sent the
  consumer contract. The coordinator then merged POD-365 to integration (`e62e5f23`) and ruled that
  merging integration here was the resolution; the composition landed against real schemas in
  `41d5ab0d`. Recorded because the intermediate state is the interesting part: a criterion blocked on
  a contradictory instruction is not the same thing as one skipped, and two siblings resolved that
  contradiction opposite ways before the coordinator fixed it at the root.

### What composes, and the three tightenings

| Manifest field | Source |
|---|---|
| `sessionId` | `SessionIdentity.shape.sessionId` |
| `resume` | `SessionResume.shape.resume` — **unwrapped** |
| `repoId` | `IssueIdentity.shape.repoId` — **unwrapped** |
| `branch` | `IssueWorkspace.shape.branch` — **unwrapped** |
| `title` | `SessionNaming.shape.title` — re-`.optional()`ed |
| `issueId` | `SessionPlacement.shape.issueId` |
| `agentKind` | Declared narrower, deliberately |

A bare `Pick` would have been **wrong**. The manifest is not a subset of the session aggregate; it
is a subset with **stricter obligations**, because an export is a checkpoint. `resume`, `repoId` and
`branch` are optional or nullable in the shared groups precisely because a *live* session may lack
them — and a bundle that lacked them is unusable on arrival: no resume ref means the agent cannot be
resumed, no `repoId` means the import has no target, and `headSha`/`bundleBase` are relative to the
branch. Each therefore composes the shared schema and then `.unwrap()`s it, keeping the brand, the
meaning and the drift-following property while stating the stricter obligation once, where it is
true. `title` goes the other way: required on a live session, optional in a bundle.

Two corrections from POD-365 shaped this table: `repoId` lives on `IssueIdentity`, not
`IssueWorkspace`; and `worktreeName` / `worktreeRelativePath` / `cwdSubpath` are not `IssueWorkspace`
members at all — they are bundle-local path facts. POD-364 §6.4's sketch grouped by *where the work
happens*, which put two different questions in one row.

## 5a. Attribution needs a format bump — and the audit cannot grade this issue

Two findings that arrived from siblings after the first three commits, both recorded because each
would otherwise be discovered the expensive way.

### Attribution is not an additive field

POD-365 made the attribution pair **structurally unsplittable** at its three session sites: the
timestamp nests *inside* the object carrying the actor, so a half-filled value does not typecheck.
Right shape — but applying it here is not additive, and all three obvious moves are wrong:

| Move | Why it fails |
|---|---|
| Nest the existing `exportedAt` / `sourceMachineId` | This is a **file** format. Every bundle already on disk has them flat; re-nesting yields a reader that cannot open yesterday's export. |
| Add a nested pair *beside* flat `exportedAt` | The export timestamp then has two spellings in one schema — the drift POD-302 exists to kill, introduced by the issue that exists to kill it. |
| Nest the actor, leave the timestamp flat | Keeps one spelling but discards the property the nesting was built for: a half-filled attribution becomes representable again. |

**Resolution:** attribution arrives with **`format: 2`**. `format` is a file version, independent of
the wire — the same property that makes this representation genuinely different from a wire
projection — and a version field exists precisely to make a shape change readable. v2 carries the
nested unsplittable attribution whose timestamp *is* the export timestamp; v1 keeps parsing through a
discriminated union on `format`, upgraded in the read path, with a v1 fixture retained in the golden
corpus permanently as proof old bundles still open.

**This corrects an earlier claim.** I told the coordinator the remaining work was "mechanical". The
`Pick` swap is; attribution is not — it is a format revision touching the bundle reader (POD-644's
transfer path). The two must not be folded into one step.

`exportedAt` and `sourceMachineId` stay **device-level** facts per POD-364 §9 — which machine, when.
Neither names a principal, so neither is half of the attribution pair.

### `rearch-audit` cannot measure this issue's first criterion

POD-367 reported the audit's `ISSUE_SHAPES` sees 4 of its 17 representations, and POD-366 5 of 24. I
verified the session side against the script rather than taking it on trust, and the problem here is
sharper than undercounting:

- The `session-shapes` check greps `^export (interface|type|class) <name>` and its unit is *"a
  declaration of a session shape outside the canonical aggregate"*. `HandoffManifest` **is** in
  `SESSION_SHAPES`, and `export type HandoffManifest = z.infer<…>` matches.
- So the audit counts this representation as debt — but ADR 4 D4 says it is **retained by design**.
  Its declaration site is permanent. The count cannot reach zero without deleting a representation
  the ADR requires, and driving it to zero would be the wrong act.
- My criterion is about hand-restated **fields inside** the representation. The detector never looks
  at fields.

So "`rearch-audit` OK, baseline exact" is a true statement about the repository and **not** evidence
for this issue's first criterion. The honest measure is per-representation: the documented `Pick`
set, and the key-set lock that makes any drift a test failure. Reported to POD-368, which owns
audit-to-zero and now has all three tables.

## 6. Evidence

**Wire, proven in the order that makes the proof exist** — before regenerating anything: with
`refusal` added and no fixture touched, `messages/wire-golden` was 87/87 green with
`wire-golden.json` unmodified. **Zero encoded bytes changed.** Then regenerated and the diff read
rather than the suite colour:

| Corpus | Diff |
|---|---|
| `__fixtures__/golden/handoff.json` | The two `.full` variants gained a **trailing** `refusal` key. Every pre-existing key, value and order unchanged. |
| `__fixtures__/golden/model.json` | Two new `HandoffRefusalReason` entries. The `HandoffManifest` encoded line is **untouched**. |
| `messages/wire-golden.json` | Three new refusal fixtures; one line re-emitted with a trailing comma, value identical. |

`refusal` was **appended**, never spliced mid-shape — zod emits keys in shape order, so a field
placed at its "logical" position would change encoded bytes with an identical field set.

**Mutation tests** (mutate → run → revert as one unit; every revert verified clean):

| Mutant | Killed by |
|---|---|
| Manifest gains `effectiveRights: z.array(z.string())` | The capability audit, the key-set lock, and the round-trip — 3 failures |
| Containment refinement stops rejecting `..` | The model negative test **and** the golden suite's own refinement assertion — 2 failures |
| `unknown-target` dropped from the enum | The refusal test and the export-result test — 2 failures |
| A composed field replaced by a fresh `z.string()` (**E** — the real POD-302 drift class) | The reference-identity test **only** — 1 failure out of 185, golden corpora included |
| A frozen grant set under an innocent key, `ctx.allowedVerbs` (**C**) | The key-set lock. The name-matching audit does **not** fire — the two instruments fail on different mistakes |
| `sessionId: SessionIdField`, reaching past the group to the same brand (**D**) | **SURVIVED** — see below |

**Mutant D survived, and it is reported rather than hidden.** Importing the underlying brand
directly instead of reaching through POD-365's group is *observationally identical* — the group holds
that same instance — so reference equality cannot distinguish it. It is an equivalent composition
rather than a defect: it still follows the shared brand. It is nonetheless weaker, because it would
not follow if POD-365 re-typed the group's field. The consequence was a **test rename, not an added
test**: the original name claimed "composes … from the shared schema", which is more than the
assertion can see, so it now reads "takes every session and issue field as the shared schema
instance, never a restatement". Adding a second test would have left the old name still making the
false claim.

**Mutant E is the one that justifies the whole approach.** A fresh `z.string()` restatement is
byte-identical on the wire — branding is compile-time — so it passes all 177 golden cases and 184
tests in total. Exactly one thing sees it: the reference-identity assertion. The wire gate is
structurally blind to the drift class this issue exists to close.

**Mutant C** was run after POD-365 corrected a claim of mine — I had credited its inline checks with
catching the innocent-name case, when they were substring matchers with the same blind spot as mine,
so the two were corroborating rather than complementing. It built an exact key-set pin in response;
mutant C confirms the same split holds here, since the manifest's key-set lock reds while the
name-matching audit stays silent.

The refusal mutant exposed a real gap and it was closed: the golden corpus originally covered only two
of the three arms, so dropping `unknown-target` was invisible to it. The arm whose absence causes an
existence leak was the one an incomplete fixture set would have let through. A third fixture now
pins it, and the mutant reds the golden suite too.

### Every mutant re-verified against the false-green failure mode

A mutant that **fails to apply** is indistinguishable from one that survives: both print a green
suite, and the bias runs the wrong way — the most intricate code attracts the most fragile patterns,
so "no survivors" and "my mutants never ran" look identical exactly where proof matters most
(coordinator broadcast, found by POD-366).

All five mutants above were therefore re-run under three assertions taken **before** believing any
result: the pattern matched **exactly once** (not at-least-once — a pattern hitting a second field of
the same name also reads as a survivor), the file **hash changed**, and the mutant text was **grepped
back out** of the file. Each then ran, reverted, and the revert was verified with `git diff --quiet`
before the next mutant, so mutate/run/revert stayed one unit and no failure could strand the product
mutated.

The first pass had asserted only that the file changed. Adding exactly-once matching changed no
result — every kill and the one survivor held — but the earlier evidence could not have distinguished
a pattern miss, and that is the point.

| Mutant | Applied? | Outcome |
|---|---|---|
| A — rights snapshot under an authority-*named* key | ✅ ×1, hash changed, text present | Killed: capability audit + key lock + round-trip |
| B — containment refinement stops rejecting `..` | ✅ | Killed: model negative test + golden refinement assertion |
| C — rights snapshot under an *innocent* key | ✅ | Killed by the key lock **only**; the name-matcher stays silent |
| D — reach past the group to the same brand | ✅ | **SURVIVED** (genuine, not a pattern miss) |
| E — composed field → fresh `z.string()` | ✅ | Killed by exactly one test out of 185 |

Note that C's claim — "the name-matching audit does not fire" — is **self-proving in the same run**:
the key-set lock reddening is what demonstrates the mutation applied, so the name-matcher's silence
cannot be a false green. A survivor-shaped claim next to a kill in the same run is the cheapest way to
make it verifiable.

**Lanes** (targeted; a full run needs the `test-lane` lease and this box has been swap-thrashed):

- `packages/model` + `packages/protocol`: `bunx tsgo --noEmit` inside each package, **uncached**,
  exit 0 both. A turbo-cached typecheck is not evidence (ADR 8 D3 M4).
- Both golden suites green; `annotations` 40/40; the new tests 16/16.
- `bun scripts/check-boundaries.ts` — 0 new (58 allowlisted, pre-existing).
- `bun scripts/rearch-audit.ts` — OK, 21 items / 261 sites, **baseline exact**.
- `bun scripts/check-no-nul-bytes.ts` — ok.

## 6a. The manifest's producer has no compile-time obligation to the schema at all

Prompted by POD-1138 (a type annotation defeated by conditional spreads) and POD-366's narrowing of
it to *optional* keys. Checked against the manifest's own producer, and the exposure here is **wider**
than the case those describe.

`apps/daemon/src/handoff-package.ts:361` builds the manifest as `HandoffManifest.parse({ … })` — an
object literal passed to a runtime parse. `parse` takes `unknown`, so there is no annotation and no
`satisfies`: **nothing** constrains that literal at compile time. Five of the keys arrive through
conditional spreads (`transcriptRelativeDir`, `worktreeRelativePath`, `cwdSubpath`, `title`,
`issueId`).

Probed rather than assumed, with the probe deleted afterwards:

| Form | `'title' in parsed` | On the JSON wire |
|---|---|---|
| `...(cond ? { title } : {})` | omitted | absent |
| `title: x \|\| undefined` | **present**, value `undefined` | absent |
| `title: ''` | present | `"title":""` |

Two consequences:

1. **A mistyped optional key is silently dropped.** `cwdSubPath` instead of `cwdSubpath` produces no
   type error, no runtime error (zod strips unknown keys rather than rejecting), and a bundle that
   simply lacks the subpath — so the imported agent lands at the worktree root instead of the
   directory it was working in. A silent behavioural regression with no failing gate anywhere.

   The compile-time half was **proved, not assumed**, with a three-case `tsgo` probe that proves
   itself because one case must go red:

   | Case | Result |
   |---|---|
   | Direct excess key under an **annotation** (`const a: M = {…, bogus: 1}`) | **`TS2353` error** — the checker is running |
   | Direct excess key inside **`.parse({…})`** | no error |
   | Mistyped optional key inside **`.parse({…})`** | no error |

   So this is a **strictly worse rung** than the conditional-spread exposure: the coordinator's
   narrowed rule establishes that directly-written keys *are* excess-checked under an annotation, and
   that only an optional key supplied inside a conditional spread escapes. Passing the literal to
   `.parse()` removes the annotation entirely, so **nothing** is checked — not even the direct keys
   that clause would otherwise catch.
2. **The safe rewrite is wire-safe only under a condition I first stated too broadly.**
   POD-366 corrected this and the correction matters, because the loose version would have shipped a
   silent wire change in its own mapper. The discriminator is *which* nullish form the rewrite uses:

   | Rewrite | `title` when the value is `""` | On the wire |
   |---|---|---|
   | `...(x ? { title: x } : {})` (the retired idiom) | key omitted | absent |
   | `title: x \|\| undefined` | `undefined` | **absent** — falsy-drop preserved |
   | `title: x ?? undefined` | `""` | **`"title":""`** — a new key crosses the wire |

   `undefined` is wire-invisible, but `""`, `false` and `0` survive `JSON.stringify`. The retired
   idiom drops **falsy**, not undefined — so `||` preserves its behaviour while `??` (or a
   drop-undefined helper) does not. **The triage question is therefore two parts, not one:** (a) can
   this value be falsy-but-defined — `""`, `false`, `0`? If yes, a `??`-style rewrite is a wire change
   regardless of what reads key presence. (b) Only if no, ask whether anything downstream reads
   `k in obj` rather than the JSON.

   **This applies to this schema, not only to POD-366's** — but only as a *wire* change, and I
   initially overstated its consequence. `title` and `cwdSubpath` are plain optional strings that can
   legitimately be `""`, so a `??`-style rewrite would put a new key on the wire.
   `worktreeRelativePath` is exempt: its `.min(1)` rejects `""` outright rather than shipping it.

   **Correction, traced rather than assumed.** I claimed in three places that `cwdSubpath: ""` versus
   absent "may route a resumed agent differently". It does not. `landingCwd`
   (`apps/daemon/src/handoff-package.ts:64`) splits the subpath, filters empty and dot segments, and
   returns the worktree root when nothing survives — so `""` and absent are *identical* in behaviour.
   `transcriptRelativeDir` is the same: its reader coerces with `relativeDir ?? ''` and then
   sanitises. Both readers are defensive, so the falsy-but-defined case is a wire change with **no
   behavioural consequence** in today's code.

   That narrows the `.min(1)` recommendation rather than supporting it here. Where a reader already
   normalises `""` to absent, adding `.min(1)` would convert a harmless value into a **hard parse
   failure** — a net loss for a file format, which must stay readable. So the rule is not "constrain
   every optional string with a non-empty invariant", it is: **constrain it where `""` is both
   meaningless *and* not already normalised by the reader.** On this schema that set is currently
   empty, which is why nothing was changed.

   The genuinely user-visible defect is the *other* one, and it is unaffected by any of this: a
   mistyped key is stripped, so `cwdSubpath` goes **absent** — and absent is exactly what sends the
   agent to the worktree root instead of its subdirectory.

The general rule worth extracting, in POD-366's formulation: **a schema `.parse()` on a literal you
just built validates the data against the schema but never validates that you wrote the keys the
schema wants** — and a strip-unknown parser turns a typo into silent data loss. `satisfies` on the
literal *before* the parse is the fix, because that is the only step which checks the keys you wrote.
This is a distinct and worse rung than POD-1138's original case: there, an annotation fails to check
through a spread; here there is no annotation at all.

Not fixed here: `apps/daemon` is POD-644's transfer path, which was explicitly scoped out of this
diff. Reported to POD-1138 with the site and this evidence. Making the schema `.strict()` would be
the wrong fix — a file format needs forward compatibility, and a newer bundle read by an older
reader must not be rejected for carrying a key that reader has not heard of.

## 7. Handed forward in writing

| To | What |
|---|---|
| **POD-1079**, **POD-323**, **POD-644** | The unauthorized-vs-unreachable requirement, the three-arm rationale, and `HandoffRefusalReason` to implement against. Plus: resolve rights from the transport principal, never from the bundle; never retarget on refusal. |
| **POD-365** | The consumer contract — the exact `Pick` set, the `agentKind` narrowing that must stay expressible, `ResumeRef` is already the shared one, `Attribution` must be one schema carrying the pair, and *do not* define a serializable effective-capability shape anywhere in the shared set. |
| **POD-368** | The representation entry to grade, the reusable detector, and an explicit note that the "zero hand-restated fields" criterion is **not** met yet — grade the literal criterion. |
| **POD-304** | The O4 answer above. |
| **POD-364** / **POD-366** | The `agentKind` decision; corrections to two stale premises (the manifest already imports the shared `ResumeRef`, and its ids were branded at POD-361). |
