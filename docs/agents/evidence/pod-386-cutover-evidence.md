# POD-386 — 3.3d cutover + router audit: evidence

Branch `issue/386-3-3d-cutover-router-audit-for-these-rout`, three commits off
`issue/279-integration`. No rebase, no merge from main or a sibling.

## What was actually left

The brief said to measure before planning. The measurement, from a whole-file
census of `apps/server/src/router.ts`:

| family | routers | hand-written `.mutation(` at base |
| --- | --- | --- |
| superagent (POD-383) | `superagent` | 0 — already derived |
| fleet (POD-384) | `machines`, `repos`, `discovery` | 1 (`discovery.scan`, documented non-member) |
| specs (POD-385) | `specs` | **3 — `create`, `save`, `remove`** |
| everything else | 19 routers | 30, owned by POD-314 / POD-352 |

So the cutover that remained was `specs` alone. POD-385's scope stopped at L1: it
declared the three contracts with `exposure: ['trpc','relay','cli']` and repointed
`specsInputs` at their schema instances, but nothing derived the tRPC arm — a
contract declaring a transport that no dispatcher read.

## Acceptance criteria

**"Delete legacy procedures for superagent/machines/repos/specs"** — the three
`specs` procedures are deleted and derived from `SPEC_CONTRACTS` by
`modules/specs/registry.ts` + `trpc.ts`. superagent/machines/repos had already
been deleted by POD-383/384; verified by the census, not assumed.

**"`.mutation(` audit clean for these routers"** — `bun run audit:spec` (new) and
`bun run audit:router-mutations` (new, repo-wide) both exit 0, alongside the five
pre-existing family audits.

**"settings guard test green"** — `apps/server/src/router.settings-guard.test.ts`,
9 tests, plus the `settings-guard` check in the census.

**"a DECREASE is required"** — deletion audit 25 items / 186 sites → 25 / **183**.
`router-triple-access` 61 → 58.

## Vanished vs moved — never a bare delta

`router-triple-access` 61 → 58 is **2 vanished, 1 relocated**. Three
`mods(ctx).specs.<verb>(input)` reach-throughs left `router.ts`; one came back as
a single `mods(ctx).specs` in `modules/specs/trpc.ts`, because the derivation
reaches the service once for all three. Grepped both homes:

```
router.ts, base (issue/279-integration):  61
router.ts, HEAD:                          58
modules/specs/*.ts:                        1   (trpc.ts:79)
```

The detector scans `router.ts` only (POD-1180). It was **not** extended: the same
extension would have to cover `modules/fleet/handlers.ts` (POD-384's seven sites)
in the same breath, which raises the number mid-phase — forbidden — and buries
three real deletions under a definitional change. Argued in
`docs/rearch-deletion-audit.md`; the seam belongs to POD-314.

The router-mutation census is a separate measurement and names every key, so its
own decrease (34 → 31) cannot be a relocation: `specs` went from 3 keys to 0 and
no other router gained one.

## Mutation evidence — one mutant per run, compile-checked

| # | mutant | applied? | compiles? | killed by |
| --- | --- | --- | --- | --- |
| 1 | delete `settings.telegramSetupStart` from `router.ts` | 1 match, hash changed, grep-back 0, only target dirty | n/a (deletion) | census `settings-guard` (exit 1) **and** `router.settings-guard.test.ts` (2 of 9 failed) |
| 2 | plant `specs.smuggled` `.mutation(` after the derived spread | 1 match, hash changed, grep-back 1 | **tsgo exit 0** | `audit:spec` `derived-surface` **and** census `derived-family-clean` + `ratchet` |
| 3 | drop `...specFamily` from the `specs` router | 1 match, hash changed, grep-back 0 | n/a | `audit:spec` `derived-surface-present` |
| 4 | restate `specsCreateInput` as an identical inline `z.object` | 1 match, hash changed, grep-back 1 | **tsgo exit 0** | `audit:spec` `one-schema-instance` **and** the `toBe` identity assertion — while `mutations-wire-golden.test.ts` **PASSED** (exit 0) |

Every mutant was reverted atomically in the same call and the file hash confirmed
back to its original value. Mutant 4 is POD-305 reproduced end to end: a
restatement is byte-identical on the wire and invisible to every golden fixture.

## The instruments can say YES

Both new gates run `--probe` before the gate, always, with or without the flag —
each check against a planted fixture containing what it hunts, and (where it could
over-fire) against a clean one it must stay quiet on.

```
$ bun run audit:spec
spec-surface audit: all 4 probes found their planted fixtures
spec-surface audit OK — the spec surface is derived and present, every contract
declares its class and its exposure, and one schema instance serves every transport

$ bun run audit:router-mutations
router mutation census: the parser and all 4 checks found their planted fixtures
router mutation census OK — 31 hand-written `.mutation(` in apps/server/src/router.ts,
all named, every derived family clean, settings untouched
```

The census's `--probe` also exercises the PARSER against the five shapes a naive
scanner gets wrong, because a parser bug was live in its first draft: an
indentation-anchored key reader named the last field of an inline `z.object({…})`
as the procedure, recording `conversations.setMeta` as `conversations.summary` and
firing the drift check on four untouched routers. The key is now chosen by nesting
depth, and that exact shape is in the probe fixture and the lane test.

## Typechecks — instrument probed

```
$ bun run typecheck --force
 Tasks:    23 successful, 23 total
Cached:    0 cached, 23 total          ← not a cache hit
  Time:    54.616s
EXIT=0
```

In-package (`apps/server`, `bunx tsgo --noEmit`), probed by injecting
`const deliberate: number = 'not a number'` into `modules/specs/trpc.ts`:

```
PROBED EXIT=1
src/modules/specs/trpc.ts(103,9): error TS2322: Type 'string' is not assignable to type 'number'.
CLEAN EXIT=0   (0 lines of output)
```

Reverted; `git status --porcelain` empty afterwards.

## Gates — all exit 0

```
[0] bun scripts/check-boundaries.ts
[0] bun scripts/check-no-nul-bytes.ts
[0] bun run audit:rearch
[0] bun run audit:issues
[0] bun run audit:sessions
[0] bun run audit:workflows
[0] bun run audit:superagent
[0] bun run audit:fleet
[0] bun run audit:mail
[0] bun run audit:spec              ← new
[0] bun run audit:router-mutations  ← new
```

No schema change, so `migration:check` / `migration:manifest` do not apply.

## Test lanes

```
$ bun run test:unit      EXIT=0   538 passed | 3 skipped (541 files) · 7720 passed | 19 skipped
$ bun run test:web       EXIT=0   173 passed (173 files) · 1362 passed
$ bun run test:bun:unit  EXIT=0   14 pass, 0 fail
```

The scripts lane is inside `test:unit` and is included above.

Targeted re-run at the final tree (7 files, 82 tests, exit 0):
`apps/server/src/modules/specs/`, `apps/server/src/router.settings-guard.test.ts`,
`scripts/audit-spec-commands.test.ts`, `scripts/audit-router-mutations.test.ts`,
`packages/commands/src/specs/`.

**One red, isolated and NOT mine:** `scripts/rearch-audit.test.ts` → "an output
flag cannot disable the gate" timed out at 20s in a targeted re-run. This is the
known load-flake the brief names (it `spawnSync`s the real binary). MEASURED, not
mechanistic: it **passed** in the full `test:unit` run above, and passed again
run alone (`-t "an output flag cannot disable the gate"` → 1 passed, exit 0).

## Decisions made at forks

**No `serverRole` gate on the spec family.** The fleet derivation picks its base
procedure from each contract's `serverRole` because three of its ten are hub-only.
No spec contract declares one. ADR 3 D3: a transport is served because a contract
NAMES it — deriving a gate from an undeclared field would invent the field. The
gate that actually decides a spec write is the repo-root allowlist inside
`SpecsService`, which every transport already runs and which this issue did not
move (asserted: the FORBIDDEN arm on an unregistered root, in
`spec-trpc.runtime.test.ts`).

**The settings guard fails in BOTH directions.** POD-313's title carves settings
out of this phase. A settings write disappearing is as much a failure as one
appearing, because a cutover that absorbed someone else's surface would read as
progress on every ratchet in the repo. No ratchet relief on a `guard: true` entry.

**The census is a new instrument rather than a seventh family audit.** "No
hand-written write in MY routers", said seven times, is still true of a
`router.ts` that grew a brand-new router full of them — no audit owns a router
nobody has claimed.

## Deliberately NOT done

- The twelve `pending` routers (`cloud`, `setup`, `auth`, `automations`,
  `approvals`, …) are recorded with their owning issue, not migrated. POD-314's.
- `settings` untouched by design. POD-352's.
- `router-triple-access`'s detector not re-scoped to the new handler homes.
  POD-314's, at the cutover that owns the seam; POD-1180 records the blind spot.
- The three spec READS (`list`, `get`, `search`) stay hand-written: no contract,
  because a `visibility` class describes what a command WRITES.
