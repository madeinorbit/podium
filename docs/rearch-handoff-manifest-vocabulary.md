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
- **The brief's first acceptance criterion is not met, deliberately.** "Derived from the shared
  session field schemas — zero hand-restated session fields" depends on POD-365. Forking its field
  groups to make this file *look* composed would be the drift POD-302 exists to kill, and the
  fan-out protocol forbids duplicating a predecessor's half. The `Pick` set is instead recorded as
  the file's contract, the key list is locked so it cannot drift while it waits, and POD-365 has the
  consumer contract in writing. The remaining change is mechanical.

  **Update — the target schemas now exist.** POD-365 landed its groups (`69d1cfc6`, `ce014033`) and
  answered all three interface questions: `agentKind`'s narrowing is expressible via
  `omit`/`extend`; `SessionResume` carries the same `ResumeRef` this file already imports, so no
  carve-out is needed and the "fourth encoding" was never real; and `Attribution` is one schema
  carrying `{actor: ActorRef, onBehalfOf: UserIdField.nullable()}` with no bespoke `createdBy`.
  Two corrections to the Pick set came out of it and are now recorded in the model entry: `repoId`
  lives on `IssueIdentity` rather than `IssueWorkspace`, and `worktreeName` /
  `worktreeRelativePath` / `cwdSubpath` are **not** `IssueWorkspace` members — they join the
  bundle-local path facts.

  What still blocks the code is a **merge ruling, not a dependency**: the coordinator instructed the
  three 1.4 siblings not to merge or rebase onto each other and reserved integration for itself,
  while POD-365 advises pulling. POD-365 has asked the coordinator to rule for all three; POD-367 is
  holding on the same tie. Reaching into a sibling's worktree is exactly what the one-owner rule
  forbids, so this waits on the ruling rather than routing around it.

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

The third mutant exposed a real gap and it was closed: the golden corpus originally covered only two
of the three arms, so dropping `unknown-target` was invisible to it. The arm whose absence causes an
existence leak was the one an incomplete fixture set would have let through. A third fixture now
pins it, and the mutant reds the golden suite too.

**Lanes** (targeted; a full run needs the `test-lane` lease and this box has been swap-thrashed):

- `packages/model` + `packages/protocol`: `bunx tsgo --noEmit` inside each package, **uncached**,
  exit 0 both. A turbo-cached typecheck is not evidence (ADR 8 D3 M4).
- Both golden suites green; `annotations` 40/40; the new tests 16/16.
- `bun scripts/check-boundaries.ts` — 0 new (58 allowlisted, pre-existing).
- `bun scripts/rearch-audit.ts` — OK, 21 items / 261 sites, **baseline exact**.
- `bun scripts/check-no-nul-bytes.ts` — ok.

## 7. Handed forward in writing

| To | What |
|---|---|
| **POD-1079**, **POD-323**, **POD-644** | The unauthorized-vs-unreachable requirement, the three-arm rationale, and `HandoffRefusalReason` to implement against. Plus: resolve rights from the transport principal, never from the bundle; never retarget on refusal. |
| **POD-365** | The consumer contract — the exact `Pick` set, the `agentKind` narrowing that must stay expressible, `ResumeRef` is already the shared one, `Attribution` must be one schema carrying the pair, and *do not* define a serializable effective-capability shape anywhere in the shared set. |
| **POD-368** | The representation entry to grade, the reusable detector, and an explicit note that the "zero hand-restated fields" criterion is **not** met yet — grade the literal criterion. |
| **POD-304** | The O4 answer above. |
| **POD-364** / **POD-366** | The `agentKind` decision; corrections to two stale premises (the manifest already imports the shared `ResumeRef`, and its ids were branded at POD-361). |
