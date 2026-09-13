# PDM-351 delivery receipt — owner absence at the root of the wire

**Deliverable.** `parses every sample` is green. The golden files were not touched, the schema
was not touched, and nothing was regenerated. The decision that licensed the change is
`PDM-351-owner-absent-at-the-root.md`, written before either file was opened.

## SHAs, resolved here — not quoted from any brief

Both epic refs moved DURING this session. Everything below names the ref and the SHA it
resolved to at the moment it was used.

| ref | resolved |
|---|---|
| OSS epic `origin/issue/pdm-107-multi-user`, at first measurement | `6ab16399971aaf76713f33e4e2043bb383947911` |
| OSS epic `origin/issue/pdm-107-multi-user`, at final measurement | `21338195f4f5560ec02dcc9ef56dc603785e4e5f` |
| OSS work branch `issue/pdm-351-golden-owner-optional` | rebased onto `21338195f`, one commit ahead of it |

(That branch's tip SHA is deliberately not quoted here: this file is inside that commit, so any
SHA written in it is invalidated by the amend that writes it. The tip is in the PDM-107 hand-off
mail and in `git log`.)

| OSS fork point (baseline) | `89574f1c86a138a1242753397cb0635f385ed0f3` |
| cloud issue branch `issue/351-golden-wire-sample-no-longer-parses` | `2cdc6ead7d93fb5ee3c5bc06eea6c105ae260a2d` |
| cloud epic `origin/issue/107-multi-user-architecture`, now | `e3ea18f6992b91753bf09a8294a3d5444c5acbbd` |
| SHA the PDM-139 attribution measured | `12182a644`, an ancestor of `6ab163999` |

**The cloud branch was reset under this session and I initially read it wrong.** The
session-start snapshot showed it at `be0e9ea` with no `docs/plans/multi-user-epic` in the tree,
so the first draft of this receipt said it had been cut from `main` and committed nothing
cloud-side. The coordinator's reset to the epic landed in the worktree during the session; its
reflog shows `be0e9ea (Created from main)` then `2cdc6ea (reset: moving to
origin/issue/107-multi-user-architecture)`. The branch is on the epic line — `merge-base
--is-ancestor HEAD origin/issue/107-multi-user-architecture` is true, 8 commits behind — and the
cloud receipt is committed on it after all.

(The verification command in the coordinator's mail, `merge-base --is-ancestor
origin/issue/107-multi-user-architecture HEAD`, now answers NO, because the epic has moved 8
commits ahead of the branch it reset to. The direction that answers the question is the reverse
one. Nothing is wrong with the branch.)

No measurement was affected: every test run was in an OSS worktree, never in the cloud one.

The OSS pin moved too, from `6ab163999` to `21338195f`. That range touches
`packages/model/src/authz/issue-authz.ts`, which IS on the model barrel — so rather than argue
from the diff that the corpus is unchanged, the work was rebased onto `21338195f` and **re-run
there**. Identical outcome: gate 5/5 green, `model parses every sample` green, the same five reds.
Both measurements are in §5.

The three commits between the PDM-139 measurement SHA and `6ab163999` (`5a6920d92`, `f41be79cd`,
`6ab163999`) touch `ops/`, `.github/`, `scripts/` and two integration tests only — no
`packages/protocol`, no `packages/model`, no golden file. That matters for §4.

## 1. The answer

**Neither the sample nor the schema.** The harness.

`OwnerAsAssigneeField = Ownership.shape.owner.optional()` is a `ZodOptional`: it admits
`undefined` and refuses `null`, deliberately. An owner may never be `null` on the wire — absence
means "this payload predates A2's projection", never "unassigned", and there is no unassigned
state to encode. Widening to `.nullish()` would rebuild at the wire the second representation of
"no owner" that A2 deleted from storage.

And no stale sample exists. `parses every sample` asserts over `buildCorpus()`, generated fresh
in-process; only its sibling reads the golden. `golden/model.json` holds **708 cases, none of them
`OwnerAsAssigneeField`, and zero `parseError`** — it was last regenerated at `569c6a283`
(2026-09-11), the day *before* `68e8d23e0` (2026-09-12) introduced the field. Regenerating would
not have refreshed anything; it would have written the first `parseError` into a golden file and
pinned the defect as expected output.

The defect is `build.ts:64`, `JSON.parse(JSON.stringify(sampled ?? null))`. At the root there is no
enclosing object to omit a key from, so `?? null` wrote "the peer sends nothing" down as "the peer
sends `null`". `OwnerAsAssigneeField` is the **only** schema optional at its root anywhere on the
covered surface; `sampler.ts` still carried the comment "which no message type is", true when
written and made false by A2.

## 2. The change

Three files, none of them a golden and none of them a schema.

- `packages/protocol/src/__fixtures__/build.ts` — absence stays absent. `JSON.stringify` drops an
  `undefined` property, so the golden would record such a case with no `wire` line, which is what
  "no document is sent" looks like; `toEqual` reads the two as equal. `encoded` is `''` because
  there are no bytes.
- `packages/protocol/src/__fixtures__/sampler.ts` — comment only; the "no message type is" claim
  corrected to say why the `undefined` must not be coalesced.
- `packages/protocol/src/__fixtures__/build.test.ts` — **new**, 5 tests. Deliberately NOT added to
  `wire-golden.test.ts`: that file carries five inherited reds on this branch, and a green
  assertion inside a red file is indistinguishable at a glance from the defect it guards. This
  file is wholly green on its own (exit 0).

The probe schema in the gate is `z.string().optional()`, built in the test file rather than
imported. `OwnerAsAssigneeField` is asserted through the whole-corpus test while it is on the
export surface, but a guard whose only subject is one export vanishes the day that export is
renamed, and the harness bug would come back unwatched.

## 3. Proof by deliberate break

Defect restored (`?? null` and the unconditional `encode`), both files run, then restored.
Failures are **by name and for the right reason** — the message is the one in the brief:

| test | with defect | with fix |
|---|---|---|
| `wire fixture harness > … > parses, rather than recording an invented null` | **failed** — `expected '<root>: Expected string, received null' to be undefined` | passed |
| `wire fixture harness > … > records absence as absence and not as null` | **failed** — `expected null not to be null` | passed |
| `wire fixture harness > … > pins no bytes for a case that puts nothing on the wire` | **failed** | passed |
| `wire fixture harness > has no case anywhere in the corpus whose wire is a coerced null` | **failed** — 1 case | passed |
| `wire fixture harness > … > still samples the present value in the full variant` | passed | passed |
| `golden wire fixtures > model > parses every sample` | **failed** — `+ [ "OwnerAsAssigneeField/minimal: <root>: Expected string, received null" ]` | passed |

The last row of the harness gate is *supposed* to be insensitive to this defect: it guards against
a different wrong fix (dropping root-optional schemas entirely, which would satisfy every other
assertion above). Said here rather than left for a reviewer to wonder about.

One assertion was **strengthened after** the first break cycle showed it green under the defect:
`pins no bytes` asserted only `encoded === ''`, and `buildCase`'s failure branch also sets
`encoded: ''`, so it passed vacuously. It now pins `parseError` undefined alongside, and fails
under the defect. The first break cycle is what found that; a passing test could not have.

No test was renamed or deleted. `build.test.ts` adds five names; every other name in this file is
unchanged.

## 4. Failing NAME sets — and two regressions the brief did not know about

`packages/protocol/src/wire-golden.test.ts` alone, own `bun install` per tree, JSON reporter.

**Fork point `89574f1c8` — 3 names**
```
golden wire fixtures host matches the committed golden file
golden wire fixtures model matches the committed golden file
golden wire fixtures perf matches the committed golden file
```

**Head `6ab163999`, before my change — 6 names**
```
golden wire fixtures feed matches the committed golden file      <- NEW
golden wire fixtures host matches the committed golden file
golden wire fixtures model matches the committed golden file
golden wire fixtures model parses every sample                   <- NEW, THIS ISSUE
golden wire fixtures perf matches the committed golden file
golden wire fixtures sync matches the committed golden file      <- NEW
```

**Head, after my change — 5 names** (identical to the above, minus `model parses every sample`)

**Which of them is this finding: `golden wire fixtures > model > parses every sample`.** It is the
only `parses every sample` in any set, and the only one this issue touches.

**The brief's "three inherited neighbours" is wrong, and not by drift.** It is five neighbours, and
only three of them — `host`, `model`, `perf` — are inherited. `feed` and `sync` are green at the
fork point and red at head. They were red when PDM-139 measured too: nothing in `12182a644..6ab163999`
touches protocol, model or any golden. The attribution recorded "6 failed, but the failing NAME set
is 4 because the lane retries" — the six were six distinct names, not four plus two retries, and
that assumption laundered two regressions.

**A third is laundered differently.** `model matches the committed golden file` is red at the fork
point over a `loop.inclusive` addition. At head its diff *also* carries A2's `assignee` →
`assignmentRevision`/`inputRevision` rows. A failing-name diff cannot see a diff growing inside a
name that was already failing, so A2's staleness in `model` is invisible to the method that found
`feed` and `sync`.

All three are **filed as PDM-356** (`Bug: wire golden stale after A2`) under PDM-139, with the
regeneration instruction and the warning that the `loop.inclusive`/`host`/`perf` reds predate the
fork and must be decided separately. Not fixed here: regenerating the golden is the act PDM-139
said had to be argued rather than done quietly, and arguing it is that issue's job, not this one's.

## 5. Commands and exit codes

Every test run via the admission wrapper; no direct vitest, no `test:heavy` lease needed (single
file). Run from `/home/mgw/src/other/podium/.worktrees/issue-pdm-351-golden-owner-optional`
(and `…/pdm-351-baseline-forkpoint` for the baseline), each with its own `bun install`.

```
bun scripts/validation-admission.ts focused --label <l> -- \
  bun --bun node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts <files>

  wire-golden.test.ts @ head, before fix                 exit 1   6 failing names
  wire-golden.test.ts @ fork point                       exit 1   3 failing names
  build.test.ts @ head, after fix                        exit 0   5 passed
  build.test.ts + wire-golden.test.ts, after fix         exit 1   116 tests, 5 failed (all inherited/PDM-356)
  the same two files, REBASED onto OSS 21338195f         exit 1   116 tests, 5 failed - identical names;
                                                                  gate 5/5 green, parses-every-sample green
  build.test.ts + wire-golden.test.ts, defect restored   exit 1   9 failed
  build.test.ts, defect restored                         exit 1   4 of 5 failed

bun run --filter @podium/protocol typecheck              exit 0
bunx biome check <the three changed files>               exit 0   "Checked 3 files. No fixes applied."
bun scripts/check-lane-coverage.ts --census              exit 0
```

**Lane coverage.** The census places the new file in a lane that exists:
`packages/protocol:default  packages/protocol/src/__fixtures__/build.test.ts`. It is not in
`apps/server`, so no shard manifest needs regenerating.

**Not run, and why.** No root `bun run typecheck` (three concurrent tsgo at ~3.4GB each on a 23GB
box shared with live agents; the one package that could be affected is green). No full
`@podium/protocol` lane and no other package lane — the change is confined to test-support code
under `__fixtures__/`, whose only consumers are `wire-golden.test.ts`, the new `build.test.ts`, and
`scripts/update-wire-fixtures.ts`, which is not a test and was deliberately not invoked.

## 6. Hazards met on the way

- **A git worktree under `/home/mgw/src/other/podium/` gets a partial `bun install`** — 16 entries,
  159 packages — and bun then walks *up* to the main checkout's `node_modules` for the rest. A bare
  `bun probe.ts` in the worktree resolved `@podium/model` to `/home/mgw/src/other/podium/packages/model`,
  the **fork-point** source, and failed with "Export named 'OwnerAsAssigneeField' not found". Vitest
  is not affected: `sharedVitestConfig.resolve.alias` is built from `import.meta.url`, so it anchors
  on the worktree. Every measurement above is vitest's. The bare probe was discarded, not trusted —
  had it been trusted it would have "proved" the field does not exist.
- **`bun … | tail`/`| grep` dropped output** on the census twice before a redirect to a file showed
  the line that was there all along.
- **The JSON reporter replaces the default one**, so `--reporter=json --outputFile=…` leaves the
  text log a single line. Name sets came from the JSON; the golden diffs needed a second run with
  `--reporter=default`.
