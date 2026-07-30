# Deletion audit — the anti-intermediate-state ratchet

The v3 rewrite is defined as much by what **disappears** as by what gets built. A
rewrite that only adds the new thing and leaves the old one standing is the worst
of both worlds: two mechanisms, two mental models, and a migration that is
"nearly done" forever.

This audit makes that failure mode a build failure. It encodes the proposal's §6
"what disappears" inventory as executable checks, counts what still exists, and
refuses to let the numbers go up.

- **Script**: [`scripts/rearch-audit.ts`](../scripts/rearch-audit.ts) (rules), [`scripts/rearch-audit.test.ts`](../scripts/rearch-audit.test.ts) (tests)
- **Baseline**: [`scripts/rearch-audit-baseline.json`](../scripts/rearch-audit-baseline.json) — committed counts
- **CI**: its own blocking step in the `lint` job (POD-297)

## Running it

```bash
bun run audit:rearch                     # the ratchet — what CI runs
bun run audit:rearch --sites             # every counted file:line
bun run audit:rearch --json              # machine-readable
bun run audit:rearch --update-baseline   # record the current counts
bun run audit:rearch --phase POD-309     # phase-close gate
```

## The ratchet

CI compares live counts against the committed baseline:

| Result | Exit | Meaning |
| --- | --- | --- |
| count **>** baseline | 1 | **Regression.** New code was routed through a mechanism the rewrite is deleting. Use the replacement seam. |
| count **<** baseline | 1 | **Unrecorded win.** Run `--update-baseline` and commit the file. |
| count **=** baseline | 0 | Pass. |

### Why a decrease also fails — a deliberate deviation from POD-297's AC

POD-297's acceptance criterion reads *"a PR may only keep counts equal or lower;
increase fails the build"*, which taken literally says a decrease should pass.
**It fails instead, on purpose** (approved on POD-279 — recorded here so the exit
gate does not flag it as a defect).

The rationale is convergence. A decrease that is not written to the baseline
leaves the baseline still authorising the old, higher count — so a later PR can
give the ground back with CI green, and *"must reach zero"* never converges. The
count policy is unchanged: lowering a count is always allowed. What fails is a
**stale artifact**, and the fix is one mechanical command. The baseline diff then
doubles as the per-phase before/after evidence the migration ledger (POD-298 §8)
records. This mirrors `bun run migration:manifest --check`: you may add
migrations, but the committed manifest must be exact.

The audit is a **blocking** CI step of its own, not part of `bun run lint` — the
lint step is `continue-on-error` while the biome backlog burns down, so a ratchet
folded into it would report green no matter what.

## The phase-close rule

> **A phase issue may not be closed while any of its mapped items count > 0.**

Every item names the phase issue that owns deleting it. Before closing a phase:

```bash
bun run audit:rearch --phase POD-309
```

Exit 0 means every item mapped to that phase is at zero and the phase is clear to
close. Exit 1 lists what is still standing, with file:line sites. Exit 2 means the
argument named no known phase — a typo fails closed rather than reporting "clear".

This is what makes the audit a *scheduler* rather than a report: a phase cannot
declare victory while its deletions are outstanding, so the intermediate state
cannot become permanent by attrition.

Grep audits are necessary, never sufficient (POD-298): a zero here means the
named shapes are gone, not that the phase's design intent was met. The exit gates
still own that judgment.

## What a count means

Each check declares its own `unit`, deliberately. Some items are a **fan-out**
whose size *is* the debt — `publishComputed` call sites, `mods()` reach-throughs
in `router.ts`. Others are **binary**: a type exists or it does not. A count of 1
on a binary item is not weaker evidence than 119 on a fan-out; both must reach 0.

Two items count **redundancy** rather than raw sites, because the thing that
disappears is a duplicate, not the capability:

- `send-turn-duplicate`: N procedures forwarding to `superagent.sendTurn` ⇒ N−1
  counted. One of them is the real entry point and stays.
- `state-dir-defs`: already 0 — a **regression guard** that keeps the second
  definition from coming back.

## Counting rules

- **Comments are stripped** before matching. A doc comment mentioning a deleted
  symbol must not pin its count above zero, and comment churn must not move a
  count. This is not a marginal correction: a third of the raw `publishComputed`
  hits are prose, and two thirds of the `__local__` ones (23 of 35).
- **String literals are kept**: `'__local__'` is itself a literal.
- **Tests are excluded.** They legitimately construct doubles of the shapes being
  retired.
- **Migrations and generated files are frozen.** A past migration is immutable
  history; no phase can delete a placeholder out of one.
- **Package barrels are not shims.** `packages/*/src/**/index.ts` re-exports a
  deliberate public API. Only *app-level* all-re-export files are tombstones.

## A detector that stops matching is not a deletion

This is the audit's own worst failure mode, and it is worth stating plainly
because the ratchet actively converts it into permanent damage: **a count that
falls because a regex broke looks exactly like a count that fell because someone
deleted the debt.** The script then prints *"counts went DOWN — nice, lock the
win in"*, the baseline records a deletion that never happened, and the phase can
close over live code.

So detectors must not key on things that move for unrelated reasons:

- **Not on formatting.** Anchors that need a construct on one line break when
  biome (lineWidth 100) wraps it — and the count silently drops. `reexport-shims`
  matches statements, not lines, for this reason.
- **Not on a helper's name when the debt is the underlying reach-through.**
  `mods(ctx)` is only sugar for `ctx.registry.modules`, so `router-triple-access`
  matches both; otherwise a codemod inlining the helper would "delete" 100+ sites
  while changing nothing.
- **Zero must be provable, not inferred.** Where a zero count could only mean the
  detector broke, say so: `send-turn-duplicate` throws if its anchor matches
  nothing rather than reporting 0.

`scripts/rearch-audit.test.ts` asserts every check still binds to a real anchor
in the live tree, which catches total drift. It cannot catch partial
under-counting — that is what the rules above are for.

## Baseline reconciliations

A baseline bump is the one edit that can retire this guardrail, so every bump is
recorded here with the sites that caused it. **Rebaselining without a row in this
table is the defect.** The rule the rows apply:

- **Relocated debt** (a rename, a reflow, an added argument on an existing call)
  is not new debt. It is the same site spelled differently; rebaseline, no issue.
- **Genuinely new debt** — a call site, placeholder or table that did not exist —
  is recorded *and* filed, so the phase that owns the deletion inherits it
  instead of it riding along invisibly inside a larger number.

### 2026-07-30 — main's 57 commits, reconciled onto `issue/279-integration` (POD-861)

The baseline was last exact at the pre-rebase POD-297 tree (246 sites). The
rewrite branch was then rebased onto main and the audit commits landed on top
without a re-count, so five counters had been standing red. Method: the audit was
re-run against that reference tree and diffed **site by site** against the current
one, which is what separates the two categories below — a net count alone cannot.

| Item | Was → now | Verdict |
| --- | --- | --- |
| `router-triple-access` | 123 → 134 | **11 new, 6 relocated.** The 6 are existing procedures whose text changed around an unchanged `mods(ctx)` reach-through (`withMutation` gained `async`, `messages.send` destructures `disposition`, `syncChangesSince` takes `publicationAuthority`, `mintPairingCode`/`scanRepos` reflowed). The 11 are new procedures: `prepareSessionTarget`, `stopSession`, three `perf.*`, `rpc.browseDirs`, two `messageGate.dispatch`, three machine-scoped `rpc.repoOp` (`statusProbe`/`logPanel`/`diffFile`). **Recorded, not fixed in place** — the replacement seam is POD-314's, and hand-converting 11 sites ahead of it would invent that seam twice. |
| `reexport-shims` | 19 → 24 | **5 new, 1 relocated.** Relocated: `apps/web/src/lib/motion/index.ts` grew 5 → 7 re-exports; same tombstone, different text. New: `apps/janitor/src/index.ts`, `apps/web/src/features/superagent/derive-tray.ts`, `.../terminal/ArrowSwipeKey.tsx`, `apps/web/src/lib/voice.ts`, `packages/terminal-client/src/prompt-extract.ts`. |
| `publish-computed-fanout` | 12 → 13 | **1 new**: a third `funnel.publishComputed(spec.snapshot)` in `apps/server/src/modules/issues/service/core.ts`. Nothing was removed, so this is fan-out growth, not a move. |
| `local-placeholders` | 12 → 13 | **1 new**: `machine: spawned.machine ?? row.machineId ?? '__local__'` in `apps/server/src/modules/issues/service/workflow.ts` — the machine picker's fallback. Resolving it to a real machine id is POD-318's job, not a drive-by here. |
| `capability-tables` | 4 → 5 | **1 new**: `PROVIDER_LABEL: Record<HarnessAgent, string>` in `apps/server/src/modules/superagent/harness-error.ts` — a sixth hand-maintained per-harness table. |
| `web-storage-keys` | 13 → 12 | **A win, but not a pure one.** Two keys went (`podium.rightPanel.last`, `podium.homeMode`), one arrived (`podium.chat.stickyPrompts`). Net −1 is recorded; the new key is inside the recorded number and POD-329 still owns it. |

The 19 new sites are filed as POD-1102, `discovered-from` POD-861, mapped to the
phase issues that delete them (POD-314, POD-333, POD-308, POD-318, POD-325).

### 2026-07-30 — POD-368 redefines the two vocabulary items and adds four (closing POD-302)

`session-shapes` and `issue-shapes` were `^export (interface|type|class) X` over
hardcoded lists of **nine and seven names**. POD-367 measured what that could
see: **4 of 17** issue representations, with `packages/model`'s own canonical
declarations counted as debt and `RefIssueLike` — the largest client-side
restatement in the repo, retired from a 22-key interface to a `Pick` — invisible,
because its name was not on the list. The audit printed the identical line before
and after that work.

**The lists were deliberately not extended**, and that judgement is carried
forward: a longer literal list reproduces the defect one generation later and
leaves the criterion **zeroable by renaming an identifier**. The redefined
detectors key on the entity **vocabulary**, read at runtime out of
`packages/model`'s field groups, so a rename changes nothing. `scripts/
representation-audit.ts` carries them; `scripts/representation-audit.test.ts`
proves each one fires on a planted restatement, stays silent on the composed form,
survives reformatting, and **still fires after the symbol is renamed**.

| Item | Was → now | Verdict |
| --- | --- | --- |
| `session-shapes` | 9 → **0** | **Redefined, not deleted.** New unit: *a declaration restating ≥3 session vocabulary keys that is neither registered in `packages/model`'s retained-representation registry nor excluded with a reason.* Zero means every restatement is accounted for. The old 9 counted four of model's own canonical declarations as debt. |
| `issue-shapes` | 8 → **0** | Same redefinition. The old 8 included two shapes the inventory explicitly excludes and one field group. |
| `representation-registry-rot` | new, **0** | The other direction of the loop: a registry entry whose site is missing or no longer declares the symbol. Without it the registry can rot into a list of retired names while everything else reports green. |
| `per-user-singletons` | new, **8** | **Mapped to POD-1076, not POD-302.** `SessionDurableState.readAt`/`snoozedUntil`, `SessionRow.readAt`, `IssueRow.readAt`/`tuckedAt`/`pinned`, and `readAt` on both auto-archive observations. All **inherited** — 1.4 added none and blessed none (POD-367 §3.5) — and each is later a table migration PLUS a wire change PLUS a replica migration. A ratchet, deliberately not laundered into POD-302's zero. |
| `capability-snapshots` | new, **0** | Regression guard for ADR 9 D5 A1. `owner`/`actor`/`onBehalfOf` are deliberately not matched: attribution must survive export, and forbidding it would forbid what the matrix requires. |
| `instance-partitions` | new, **0** | Regression guard for ADR 1 D5 as fenced by Amendment 2. Multi-user is not multi-tenancy. |

**One item was RE-PHASED, and it is recorded here because re-phasing an item is
the other way to retire a guardrail.** `change-row-typings` (7 sites) moves from
**POD-302 to POD-308**. Its whole subject is `packages/protocol/src/messages/
sync.ts`: the strict/lenient/unknown triple exists so a replica can tolerate an
entity kind it does not know (ADR 2 D9), which is sync-envelope shape and not
session or issue vocabulary. POD-364's inventory §12 scopes sync infrastructure
out of 1.4 by name, and ADR 1's matrix files `change-log` / `applied-mutations`
under `sync-infrastructure` as deployment substrate. The duality collapses when
one canonical change-row shape lands at the wire cutover — POD-308's, the same
issue that owns nesting the provenance carrier. **This is what makes POD-302's
gate pass, so it is the deviation most worth a reviewer's attention.**

Two limits of the redefined detectors, stated because a zero that is read wrongly
is worse than a red:

1. **A composed representation is invisible to them, by construction.**
   `Pick<IssueWire, …>` leaves no key list to count. They enumerate
   RESTATEMENTS; they can never enumerate REPRESENTATIONS. Reading a falling
   count as "more is composed" is valid; reading a zero as "these are all the
   representations there are" is not. The registry is the enumeration, and it is
   deliberately not derived from these detectors.
2. **`GENERIC_KEYS` is a judgement call**, so its membership is pinned by a test.
   Adding a key makes the detector blinder; removing one makes it noisier. Either
   is a decision, and the pin makes it a visible one.

**An observation, not fixed here:** `change-row-typings`'s own anchor is an
unanchored name alternation, so `MetadataChangeOp` — an op enum, not a change-row
typing — is counted as one of its 7. The count is therefore an over-count by at
least one. Left alone deliberately: the item now belongs to POD-308, and silently
lowering someone else's count while re-phasing it would be two changes wearing one
justification.

## Adding or changing a check

1. Add an `AuditCheck` to `CHECKS` in `scripts/rearch-audit.ts` with its `phase`
   and `unit`. Make the `unit` describe exactly what the detector counts — if the
   prose is broader than the regex, the gap is a false zero waiting to happen.
2. Add a test pinning the shape it must match **and one it must not**, plus one
   that the count survives reformatting.
3. `bun run audit:rearch --update-baseline` and commit the baseline.

The counts here were re-derived at the baseline commit, not carried over from the
proposal's prose — several had drifted (a second `IssueRow`, `HandoffManifest` as
a new session shape). Re-count; do not trust a number in a description.
