# PDM-356 delivery receipt — the golden that still pinned a deleted field

**Deliverable.** `packages/protocol/src/wire-golden.test.ts` goes from **5 failing names to 0**,
111/111, exit 0 — green for the first time since before the fork point, which itself carried 3
reds. Five golden files regenerated; every one of the 68 differences accounted for mechanically,
with **zero unexplained**.

## SHAs, resolved here — not quoted from any brief

The brief quotes OSS head `6ab163999`. It had moved twice by the time I started. Everything below
names the ref and what it resolved to when it was used.

| ref | resolved |
|---|---|
| OSS epic `origin/issue/pdm-107-multi-user` (my base, re-resolved at the end and unchanged) | `4d5ba336c785ac122a48322174501c64e07f9a2b` |
| OSS work branch `issue/pdm-356-wire-golden`, the regeneration | `353a319ce3a2a73a347abe5d7c03318b153454ff` |
| OSS fork point, computed as `merge-base origin/issue/pdm-107-multi-user origin/main` | `89574f1c86a138a1242753397cb0635f385ed0f3` |
| cloud branch `issue/356-bug-wire-golden-stale-after-a2` | `fd1a7ca675e4d63ede4a8faac117605b5301ca7b` |
| cloud epic `origin/issue/107-multi-user-architecture`, at session start | `fd1a7ca675e4d63ede4a8faac117605b5301ca7b` |
| cloud epic, re-fetched mid-session | `e738111bf2399ba7f7a6bd66dfb17e182b0dbf8a` |

**Placement, both directions, never one boolean.**

- Cloud branch: `merge-base --is-ancestor HEAD origin/issue/107-multi-user-architecture` -> **YES**,
  on the epic line; `rev-list --count HEAD..epic` -> **1 behind**. Being behind is healthy. The
  reflog settles where it came from: `Created from issue/107-multi-user-architecture`, one entry,
  no reset under me.
- OSS branch: `--is-ancestor HEAD origin/issue/pdm-107-multi-user` -> **NO**, and that is the
  correct answer for unlanded work: **0 behind, 1 ahead**. The commit is mine and is not yet on the
  epic. Reporting only the boolean here would read as "broken".

**PDM-351's fix is in my base.** `a3f83db8c` is an ancestor of `4d5ba336c` (checked, not assumed).
That ordering is load-bearing — see §6.

## 1. The act this issue had to argue before performing

For each family: **is the golden stale (the code is right, the file is old), or did the code
regress (the file is right)?** Written down per family before anything was regenerated.

**The golden is stale in all five, and the code is right in all five.** The evidence is not "the
test passes afterwards" — that is circular. It is that every producing change is a deliberate,
argued, documented one, and the golden was last written *before* them:

- `68e8d23e0` (A2, PDM-128, *"One canonical owner per task; retire the second assignee field"*)
  retired the independently mutable `assignee` slot and put `assignmentRevision`/`inputRevision`
  on the aggregate. The source carries the argument in full (`aggregates/issue.ts:93`,
  `fields/issue.ts:135-158`, ADR 9 Am1 D3). PDM-351 established that `golden/model.json` was last
  regenerated at `569c6a283` on 2026-09-11 — **the day before** A2.
- `aafde95f1` (*"Member email sign-in and profile"*) added `LoginEmail`.
- `loop.inclusive` is an additive bucket array on `entities/loop.ts:151`, present at the fork point.

No family's diff says the code lost something it should still have. Nothing here is a golden
regenerated to match whatever the code now emits; the field-level account in §3 is what separates
the two, and it is the deliverable.

## 2. Failing NAME sets, measured, not inherited

`packages/protocol/src/wire-golden.test.ts` alone, own `bun install` per tree, JSON reporter,
through the admission wrapper. Two worktrees: `issue-pdm-356-wire-golden` (head) and
`pdm356-baseline-forkpoint` (detached at `89574f1c8`).

**Fork point `89574f1c8` — 3 of 111**
```
golden wire fixtures host  matches the committed golden file
golden wire fixtures model matches the committed golden file
golden wire fixtures perf  matches the committed golden file
```

**Head `4d5ba336c`, before — 5 of 111**
```
golden wire fixtures feed  matches the committed golden file    <- NEW
golden wire fixtures host  matches the committed golden file
golden wire fixtures model matches the committed golden file
golden wire fixtures perf  matches the committed golden file
golden wire fixtures sync  matches the committed golden file    <- NEW
```

**Head, after — 0 of 111, exit 0.**

`model parses every sample` is absent from every set above because PDM-351 landed in my base. The
6-name set in the brief was measured before that.

**No test was renamed, added or deleted.** The full 111-name sets are byte-identical across all
three runs — asserted as a set comparison, not inferred from the counts being equal, because a
name diff cannot tell a rename from a deletion plus an addition.

## 3. THE HARD ONE, OPENED — the row-level split inside a name red at both ends

`model matches the committed golden file` is red at both trees, so every name diff says
"inherited". Here is what is actually inside it, at each tree.

I regenerated in **both** worktrees and diffed the two diffs. At the fork point the regeneration
touches exactly 3 files and the `model` part is **10 changed lines, 100% `loop.inclusive`**. At
head it is **445 changed lines**, and those same 10 are a strict subset (checked line by line: 0
fork lines missing from the head diff). So:

| | fork `89574f1c8` | head `4d5ba336c` |
|---|---|---|
| `model` changed lines | 10 | 445 |
| attributable to `loop.inclusive` (pre-fork) | 10 | 10 |
| attributable to A2 and `aafde95f1` | 0 | **435** |

**`host` and `perf` are different — they are wholly inherited.** Their head diffs are
**byte-identical** to their fork diffs (10 and 5 changed lines). They carry zero A2 content. That
is a measured claim about cause, not a guess from presence at both trees.

**And the laundered part is larger than the correction says.** PDM-139's appended correction has
`model` "now also carrying A2's assignee -> assignmentRevision/inputRevision rows". Those rows are
there — 8 cases — but they are 40 of the 435 lines. The rest is that **`model` was short 13 whole
schemas, 29 cases**, that A2 and `aafde95f1` put on the export surface and nobody added:

```
AccountRevisionRef  ConfigurationRevisionRef  ConfigurationScopeField  IssueAccountability
LoginEmail*         MemberDirectoryEntry      OwnerAsAssigneeField     ParticipationRoleField
RevisionRef         TaskParticipants          TaskParticipation        TaskRevisionRef
IssueUserState (modified, not new)                       * LoginEmail is aafde95f1, not A2
```

Attribution is per symbol, by `git log -S <symbol> 89574f1c8..HEAD -- packages/model/src`, not by
reading the commit message.

**`covers every zod schema the protocol package exports` was green throughout** — the whole time
the committed golden was missing 13 schemas. It is not a false green, but the name promises more
than it does: it compares the live corpus against the live registry, both rebuilt in-process, so a
schema missing from the **committed** file is structurally invisible to it. Only the byte-pin sees
that, and the byte-pin was already red. The test's own comment acknowledges one direction of this;
this is the other.

## 4. Every difference, accounted for — 68 of them, 0 unexplained

Not a line diff. The committed and regenerated corpora were parsed and compared **case by case**,
keyed on `(schema, variant)`, and every field-level difference classified against a closed list of
explanations. Anything falling outside the list is printed as a finding.

```
ACCOUNTED-FOR DIFFERENCES
    3  feed:  A2: assignee -> assignmentRevision/inputRevision
   20  sync:  A2: assignee -> assignmentRevision/inputRevision
    8  model: A2: assignee -> assignmentRevision/inputRevision
    1  model: A2: IssueTriage loses assignee and gains nothing
    2  model: A2: IssueUserState gains startedAt + assignmentDismissedAt
   29  model: new case (schema absent from the committed golden)
    2  model: pre-fork: loop `inclusive` bucket array added
    2  host:  pre-fork: loop `inclusive` bucket array added
    1  perf:  pre-fork: loop `inclusive` bucket array added

UNEXPLAINED DIFFERENCES: 0
```

Two of those classes needed the source read before they could be called expected, rather than
waved through as part of "the A2 reshape":

- **`IssueTriage / full` loses `assignee` and gains nothing.** Correct, and the asymmetry is the
  point: `assignmentRevision`/`inputRevision` live on `IssueAccountability`, which
  `IssueAggregate` and `IssueProjection` extend and `IssueTriage` does not
  (`fields/issue.ts:277-286`). A2 deleted the slot from triage; the replacement was never triage's.
- **`IssueUserState` gains `startedAt` and `assignmentDismissedAt`** (`user-state/issue-state.ts`).
  Not part of the reshape at all — two new per-user markers under ADR 9 Am1 D3, both
  `z.string().nullable()`, so `minimal` records `null` and `full` a string, which is exactly what
  the diff shows. Zero cases removed anywhere.

**`encoded` moved with its fields and for no other reason.** For all **39** modified cases both
`encoded` strings were decoded and structurally diffed, and the key-level change in the bytes was
required to equal the key-level change in `wire`. 39 matched, **0 moved for another reason**. A
moved `encoded` under an unchanged `wire` is the accident the suite's header exists to catch; it
did not happen here, and that is checked rather than eyeballed.

**Corpus-wide invariants after regeneration** (2453 cases across 34 families, up from 2424):
zero carry a `parseError`; zero carry a non-empty `parseChanged`; exactly **one** has no `wire`
key at all.

## 5. The absorption decision, made explicitly

`host`, `perf` and 10 lines of `model` predate the fork. **This commit absorbs them, deliberately.**

- Regeneration cannot be selective: `update-wire-fixtures.ts` rewrites every family from one
  corpus. Leaving them red would mean hand-reverting three files after generating them.
- The reason a golden must not be refreshed quietly is that nobody reads the diff. Those 15 lines
  have now been read, split from A2's, attributed to an additive field on `entities/loop.ts:151`,
  and shown to be byte-identical at both trees. The objection does not survive that.
- Hand-reverting would leave a file red whose redness is fully explained — noise that hides the
  next real finding, which is the mechanism that produced this issue.

**And absorbing did not erase the evidence — it converted it into a live pin.** Break 2 below is
the proof: those rows now fail by name if `loop.inclusive` goes away.

## 6. Proof by deliberate break — one rule, several doors

The addendum's question is the right one here: the golden's value is not that it matches today,
it is that it binds. So the breaks are on the **shared shapes**, not on the fixture files.

**Break 1 — `IssueAccountability.inputRevision` removed** (`fields/issue.ts`). One field, one
shared object, three families extend it:

```
golden wire fixtures feed  matches the committed golden file    FAILED
golden wire fixtures model matches the committed golden file    FAILED
golden wire fixtures sync  matches the committed golden file    FAILED          exit 1
```

For the right reason, by name: the default reporter's diff carries **64 lines** naming
`inputRevision`, all of the form `- "inputRevision": <n>,` — the golden expecting a field the
corpus no longer produces. Restored, tree clean, re-run 111/111 exit 0.

**Break 2 — `inclusive` removed from the loop entity** (`entities/loop.ts:151`). The field this
commit absorbed:

```
golden wire fixtures host  matches the committed golden file    FAILED
golden wire fixtures model matches the committed golden file    FAILED
golden wire fixtures perf  matches the committed golden file    FAILED          exit 1
```

Exactly the three families that carried the pre-fork rows, and no others. Restored, tree clean.

The two breaks partition the five families along the same line as §3's split: {feed, sync, model}
is A2's, {host, perf, model} is the fork's, `model` is in both — which is what made it the hard
one, now demonstrated rather than asserted.

**ORDER MATTERED, and this is the part worth keeping.** Run before `a3f83db8c`, this exact command
would have written the first `parseError` in the corpus into `model.json` and pinned PDM-351's
harness defect as expected output — catalogue shape 1, one command away, on the file this issue
was told to regenerate. With the fix in the base, `OwnerAsAssigneeField/minimal` lands as a case
with **no `wire` key and `encoded: ""`** — absence written down as absence. It is the only such
case in 2453, and this commit is where PDM-351's fix first becomes committed evidence rather than
a property of a test run.

## 7. Commands and exit codes

All test runs through the admission wrapper; no direct vitest. Run from
`/home/mgw/src/other/podium/.worktrees/issue-pdm-356-wire-golden`, and
`…/pdm356-baseline-forkpoint` for the baseline, each with its own `bun install`.

```
bun scripts/validation-admission.ts focused --label <l> -- \
  bun --bun node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts <files>

  wire-golden.test.ts @ fork point 89574f1c8        exit 1   3 failing names / 111
  wire-golden.test.ts @ head, before                exit 1   5 failing names / 111
  wire-golden.test.ts @ head, after                 exit 0   0 failing names / 111
  wire-golden + build.test + sync.composition       exit 0   128 tests, 0 failing
  break 1 (inputRevision removed)                   exit 1   3 names: feed, model, sync
  break 2 (loop.inclusive removed)                  exit 1   3 names: host, model, perf
  after both restores, tree clean                   exit 0   0 failing names / 111

bun run fixtures:wire:update           (both trees)  exit 0   34 families; 2416 cases at fork, 2453 at head
bun run --filter @podium/protocol typecheck          exit 0
bunx biome check <the 5 changed golden files>        exit 0   "Checked 5 files. No fixes applied."
bun scripts/check-lane-coverage.ts --census          exit 0   packages/protocol:default = 60 files
bun scripts/check-lane-coverage.ts --base HEAD~1 --head HEAD --lane packages/protocol:default
                                                     exit 0   0 changed TEST files (only .json fixtures changed)
```

**Lane coverage and the census of the resource's readers.** No test file changed, so the lane
instrument has nothing to place. The question that matters is instead *who reads the thing I
changed*, censused over the whole repo rather than from the one obvious caller:

- the **committed** golden files have exactly **one** importer — `wire-golden.test.ts:30`, via the
  generated `golden/index.ts`;
- the **live** corpus (`buildCorpus`) has four — `wire-golden.test.ts`, `__fixtures__/build.test.ts`,
  `messages/sync.composition.test.ts`, and `scripts/update-wire-fixtures.ts` (not a test).

`sync.composition.test.ts` is the one a census-by-obvious-caller would miss: it does not import the
golden at all, it rebuilds the corpus. **All three test files were run together and are green**
(128 tests, exit 0). The owning lane is `packages/protocol:default`; its other 57 files do not
touch this resource by any route.

**NOT RUN, and why.**

- **The full `packages/protocol:default` lane (60 files).** `podium lock acquire test:heavy --ttl 15m
  --wait --timeout 10m` sat at position 3, then 2, and **timed out without a grant**; I am not in
  the queue. Not retried: the census above shows the other 57 files do not read this resource by
  any route, and every file that does is green. Reported as not run rather than claimed.
- **Root `bun run typecheck`.** Three concurrent tsgo at ~3.4GB on a 23GB shared box. The one
  package that could be affected — `resolveJsonModule` is on and the golden is statically imported —
  is green on its own.
- **The `apps/server` shard manifest.** No file added or removed anywhere, and nothing under
  `apps/server` touched. Five `.json` files modified in place; `golden/index.ts` is unchanged,
  which is itself the check that no family entered or left.

## 8. Hazards met, and one I nearly reported as a defect

- **A probe's LOCATION decides its answer, and mine lied first.** `import.meta.resolve('@podium/model')`
  from the worktree **root** returns `/home/mgw/src/other/podium/packages/model` — the **main
  checkout, at the fork point** — and reports `OwnerAsAssigneeField: false`. I was one step from
  filing "the documented regeneration workflow is broken in a worktree". It is not. `bunfig.toml`
  sets `linker = "isolated"`, `hoist = false`, so the workspace links are **per package**:
  `packages/protocol/node_modules/@podium/model -> ../../../model`, worktree-local. Re-probed from
  `packages/protocol/src/__fixtures__/`, where the real import sits, it resolves inside the
  worktree and the field is there. The generated corpus is A2's. The fix to the memory rule is not
  "bare bun scripts walk up" but "put the probe where the real import is".
- **`podium lock acquire` exits 0 after timing out** — reproduced again here, in the background.
  Worse, my own guard was wrong: I grepped the output for `acquired|granted` and it printed HELD,
  because the word *acquired* appears in the **status line describing somebody else's hold**
  (`expires in 17m48s (acquired …)`). Grep the grant, anchored — or read the sentence
  "left the queue — nothing will be granted to you now", which was right there.
- **The JSON reporter truncates the assertion message** to `expected { family: 'feed', …(2) } to
  deeply equal {…}`, so break 1's *reason* needed a second run with the default reporter. Name sets
  came from the JSON; reasons from the text.
- **`check-lane-coverage.ts` with no arguments exits 2 with a usage line**, not a census. It needs
  `--census`, or `--base/--head/--lane`.
- **My tree was one commit behind the correction I was told to read.** PDM-139's appended
  correction is on cloud `e738111bf`, which landed after my branch point; `git show <epic>:<path>`
  read it without moving the worktree under a running lane.

## 9. A CORRECTION TO THE BRIEF: `IssueWire` did not lose `assignee`

The brief's opening sentence is *"A2 (OSS 68e8d23e0, PDM-128) reshaped IssueWire — `assignee`
removed, `assignmentRevision` and `inputRevision` added"*. **All three clauses are wrong about
`IssueWire`**, and I only found it because I grepped my own landed file expecting zero `"assignee"`
in `feed.json` and got three.

`entities/issue.ts:212` — `assignee: OwnerAsAssigneeField`. The key is still there, deliberately,
and is now the wire projection of `Ownership.owner`. The comment above it is unambiguous:

> The KEY is unchanged and no client moved, because the key was never the problem — the second
> column was. […] `owner` is deliberately NOT also a wire key. Shipping both would put the fork
> back on the wire the week after taking it out of the database.

What A2 removed was `IssueTriage.shape.assignee`, the *independently mutable* slot with its own
`issues.assignee` column. `assignmentRevision`/`inputRevision` live on `IssueAccountability`, which
`IssueAggregate` and `IssueProjection` extend — and which `IssueWire` does **not**.

The golden says the same thing, once it is read at the right grain. `FeedChange` is a
discriminated union on `entity`, and the two arms went opposite ways:

```
FeedChange full/arm1   entity 'issue'             IssueWire        UNCHANGED, still carries assignee
FeedChange full/arm2   entity 'issueProjection'   IssueProjection  assignee -> assignmentRevision/inputRevision
```

So the `assignee` surviving in three `feed.json` cases is arm1's, it is correct, and a reader
working from the brief would have "completed the refresh" by removing it — putting a second
representation of ownership back on the wire, which is the exact thing A2 exists to prevent.

For completeness, **every** `assignee` wire key left in the whole 2453-case corpus, checked
structurally rather than by grep: `IssueWire` and `IssueWireEntity` (both `OwnerAsAssigneeField`,
the deliberate projection) and `IssueSearchFilter` (`UserIdField.optional()` — a **query filter**,
not a payload; filtering by owner is not a second copy of the owner). No site declined to change.

This is also why `OwnerAsAssigneeField` is on the export surface at all, and therefore why PDM-351
had a root-optional schema to trip over. The two issues are the same field seen from two ends.

## 10. Findings

**One, and it is a note rather than an issue: `covers every zod schema the protocol package
exports` cannot see a schema missing from the committed golden** (§3). Thirteen were missing and it
stayed green. I am not filing it separately: the byte-pin does cover it, the test's comment already
names one direction of the limitation, and the honest repair — comparing the corpus against
`GOLDEN`'s key set — is a change to a suite that is now green and that PDM-139 is reviewing. It
belongs in that review, and this paragraph is the hand-off.

**Otherwise: none.** Zero unexplained differences across 68, zero new reds, zero renames.

**A correction owed to PDM-107.** The appended correction describes `model` as "now also carrying
A2's `assignee` -> `assignmentRevision`/`inputRevision` rows". Accurate but an undercount: those
are 40 of the 435 A2-era lines. The larger part is 29 cases for 13 schemas never added to the
golden at all, one of which (`LoginEmail`) is not A2's but `aafde95f1`'s — a **fourth** unrefreshed
change riding inside the same name.
