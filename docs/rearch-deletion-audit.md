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

### What an item that reaches ZERO owes (POD-309)

The anchor rule above bites hardest the moment an item is genuinely finished,
because from then on its count can only ever be zero — and "nothing found" is
also what a broken detector reports. `rearch-audit.test.ts`'s live-anchor
assertion would red forever, so a finished item has to be exempted, and the
exemption is where a real detector quietly turns into a decoration.

**The rule, set by `send-turn-duplicate` and followed by `upstream-sync-forwarder`:
an item may join `ZERO_BY_DESIGN` only if its `collect` THROWS when its anchor
stops matching.** Nothing looser. The exemption removes the only assertion that
was watching the detector, so the detector must watch itself.

`send-turn-duplicate` could anchor on surviving code — one procedure still
forwards to `sendTurn`, so zero matches means the anchor moved.
`upstream-sync-forwarder` (POD-309) has no surviving code at all: both classes
and both construction sites are gone. It therefore anchors on the two facts its
zero DEPENDS on, neither of which deletion can satisfy:

1. **its roots still resolve to files** — a package move or a layout change
   would otherwise read as "the forwarder is still deleted";
2. **its pattern still matches control strings it is supposed to match** — an
   edit that breaks the regex (an unescaped brace, a lost alternation) would
   otherwise report a serene zero forever.

The generalisation, for the next item to reach zero: ask what would have to be
true for this zero to be MEANINGFUL, and assert that. If the answer is "nothing
— the code is gone", the detector's own machinery (its roots, its pattern) is
what is left to check, and checking it is not ceremony: it is the difference
between an item that is done and an item nobody is measuring.

## Baseline reconciliations

A baseline bump is the one edit that can retire this guardrail, so every bump is
recorded here with the sites that caused it. **Rebaselining without a row in this
table is the defect.** The rule the rows apply:

- **Relocated debt** (a rename, a reflow, an added argument on an existing call)
  is not new debt. It is the same site spelled differently; rebaseline, no issue.
- **Genuinely new debt** — a call site, placeholder or table that did not exist —
  is recorded *and* filed, so the phase that owns the deletion inherits it
  instead of it riding along invisibly inside a larger number.

### 2026-07-31 — POD-324 deletes durable-host sync twins

| Item | Was → now | Verdict |
| --- | --- | --- |
| `durable-host-sync-async-twins` | 4 → 0 | **Four vanished.** `abducoHasSession`, `killAbducoSession`, `tmuxHasSession`, and `killTmuxServer` now each expose one Promise-returning operation; their `…Async` twins are deleted and every caller awaits the canonical name. The detector anchors its zero on the surviving durable-host source roots and a synthetic matcher control. |

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

### 2026-07-30 — POD-386 cuts the spec surface over: 2 vanished, 1 moved

| Item | Was → now | Verdict |
| --- | --- | --- |
| `router-triple-access` | 61 → 58 | **2 vanished, 1 relocated.** Three `mods(ctx).specs.<verb>(input)` reach-throughs left `router.ts` when `specs.create · save · remove` became derived. One came back as a single `mods(ctx).specs` in `apps/server/src/modules/specs/trpc.ts` — the derivation reaches the service once for all three — so the honest accounting is that **two** call sites are genuinely gone and one changed address. The detector scans `router.ts` only (POD-1180), so it reads the relocation as part of the win; it is written down here instead. |

**Why the detector was not extended to the new home.** It would have to be
extended to `modules/fleet/handlers.ts` and `modules/superagent/registry.ts` in
the same breath — POD-384 moved seven sites into the first — and re-scoping a
counter mid-phase raises the number, which the ratchet forbids and which would
bury three real deletions under a definitional change. The detector's scope is
POD-314's to widen at the cutover it owns; POD-1180 already records the blind
spot. What this issue owes is the site-by-site account above, not a redefinition.

**The whole-file instrument this issue did add** is a different measurement and
does not overlap: `scripts/audit-router-mutations.ts` censuses every top-level
`t.router(` literal in `router.ts` and ratchets the hand-written `.mutation(`
total (31 at this commit, down from 34). Unlike `router-triple-access` it names
every remaining key and its owning issue, so a decrease has to say WHICH key
vanished — the check that makes a shrinking number mean something.

### 2026-07-31 — POD-314 derives the tRPC router, and widens the detector POD-386 deferred

Two effects, deliberately in **two commits**, because they must be measurable
separately: the product reduction first, the detector widening second with no
product code in it.

**The product commits.** Twenty-three hand-written `.mutation(` left `router.ts`
across eleven families (approvals, conversations, perf, models, files, hosts,
accounts, cloud, setup, auth, telemetry), and ~30 reads moved into per-module
query tables beside them. `router.ts` went 1210 → 390 lines.

| Item | Was → now | Verdict |
| --- | --- | --- |
| `router-triple-access` | 54 → 6 | **Under the OLD scope.** Measured before the widening below so the two effects stay separable. |
| `machine-id-unbranded-fields` | 38 → 36 | **2 vanished** with the dead cloud input schemas deleted from `router.ts`. |
| `session-shapes` | 0 → 1 → 0 | **Fixed, not rebaselined.** `cloudSourceSessionInput` did not change; its ADDRESS did, from an inline `router.ts` procedure input the detector does not scan to a contract at L1 where it does. POD-1180's phenomenon pointing the other way — debt moving INTO view. Recorded as a `(file, symbol)` exclusion citing inventory §2.3/§6.5 rule 2 (a cloud-egress source address, the category the L1 transport frames already occupy), because "new debt" and "debt that became visible" must not look alike. |

**The widening commit** (`router-triple-access`, 6 → 20). No product code changed
in it. The code did not move; the **detector's scope** did, and the count rose
because debt became measurable — the POD-305 pattern (`isFrozenFile`, 7 → 18) and
POD-301's (25 items/186 sites → 28/237). "Never rebaseline upward" forbids
absorbing a **regression**; it has never meant a detector may not learn to see.

All three candidate boundaries, measured **by the instrument** (which strips
comments first — a raw grep reports one more for the middle figure):

| Scope | Sites |
| --- | --- |
| `router.ts` alone (the old scope) | 6 |
| `+ modules/**/trpc.ts` — **chosen** | 20 |
| all of `apps/server/src/modules` | 37 |

The middle boundary was chosen on what the item **means**, not on what it counts:
its subject is *a transport reaching past the seam*, so the honest scope is the
files that BUILD procedures. The widest measures something different — reach-
through by anything a transport *derives* — and folding it in would change the
referent while keeping the name, the same defect as a restatement passing a
golden fixture. Both numbers are recorded so the scope **not** picked is
reviewable rather than merely asserted.

**The 20 → 37 gap is itself a finding**, and it belongs to POD-1180's successor:
it says the derived arms reach past the seam *more* than the transports ever did,
which is the opposite of what the cutovers were meant to buy.

**Item zero was not reached, and the six that remain are named** rather than
rounded away: three settings-guard writes (POD-352's, which this issue must not
touch in either direction), the allowlisted `discovery.scan`, `machines.list`
(`visibleMachinesFor` is an authorization projection needing the capability the
derived state bundle withholds by design), and the mail dispatch. Each is
documented at its site.


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
| `instance-partitions` | new, **0** | Regression guard for ADR 1 D5 as fenced by Amendment 2. Multi-user is not multi-tenancy. **POD-1168 widened it to a second syntax form** — a column on a drizzle-declared physical table, which is a call expression and so was never enumerated as a key. Still 0: the widening added no site, it added the place a partition would actually be introduced. |

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

### `change-row-typings` REDEFINED at POD-305 — 7 → 18, and the code did not change

The observation directly above is now resolved, by the issue that owns the item's
subject. **This is a redefinition, not a re-baselining**, and it is recorded here
because the two look identical in a baseline diff: the count moved because the
DETECTOR's definition changed, in a commit that touched no product code. Same act,
same disclosure, as the earlier `isFrozenFile` narrowing that unfroze
`migrations/schema.ts` and raised its item 13 → 16.

**Old definition** — count exported NAMES in one file:

```
/^export (?:const|type) (?:MetadataChange|UnknownMetadataChange|SyncChangesSinceResult)/
```

**New definition** — count DECLARATIONS that write out the change-row field list
instead of composing `@podium/model`'s change vocabulary (`scripts/change-row-audit.ts`).

Two reasons, and the second is the one that mattered:

1. **The old one measured the wrong thing.** The POD-279 review's finding 2 is
   explicit that change data legitimately exists in distinct lifecycle phases — a
   staged spec at commit time, a stored row, a sequenced wire delta — and that the
   target is *hand-restated field lists, not the existence of lifecycle types*.
   Keyed on the NAMES of those types, the item could only be zeroed by deleting a
   type that has a reason to exist.
2. **The old one was blind to the debt it named.** `messages/sync.ts` restated
   `seq`/`entity`/`id`/`op`/`value` six times over and the `changesSince` snapshot
   arm twice, and the item reported the same 7 whether those restatements were
   present or composed away. The over-count noted above is corrected by the
   redefinition rather than left standing as a known-wrong number.

**The phase does not move.** It stays POD-308: the wire cutover is still what
collapses the strict/lenient duality for good. What changed is that the item now
measures restatement, so composing a field list registers as the deletion it is.

**Two spellings, both enumerated** — POD-1168's lesson applied before rather than
after. A restatement can be written in key position (an object literal, a
`z.object`, an `interface` body, a `type` alias, a drizzle `sqliteTable` column
map) or as string literals in a type operator (`Pick`/`Omit`/`Extract`, an
`as const` field-name array). `change-row-audit.test.ts` plants one of EVERY
spelling and requires each to fire, and carries verbatim pre-POD-305 protocol text
as its positive control.

**The judgement call, stated rather than buried: DECLARATION versus CONSTRUCTION.**
The first cut counted any block with an `op` key beside two other change keys and
reported **76** sites. Reading them showed nearly all were callers *building* a
spec — `{ entity: 'automation', id: automation.id, op: 'upsert', value: wire }` —
which is a USE of the shared type, and there are supposed to be many. A ratchet
that counts uses cannot be driven to zero and would punish the callers composition
exists to serve. So a block counts only when its `op` member is declared as a type
or schema, and `change-row-audit.test.ts` pins both sides of that line, including
the cast case (`op: row.op as 'upsert' | 'remove'` is a construction, despite
containing a union).

**The 18 the new definition sees**, all genuine second definitions of a change
row: five strict arms plus the lenient catch-all in `messages/sync.ts`,
`ScopedChange` in `planes/scoped-feed.ts`, the `changes` drizzle table, three
inline row shapes in `change-log.ts` and three more in `sync-repository.ts`,
`EntityChangeSpec` and `StagedRow` in `ledger.ts`, `ChangeEnvelope` in
`replica/types.ts`, and one test-plumbing `Row`. POD-305 composes the ones it
owns; the rest are POD-308's at the cutover.

### 2026-07-30 — POD-301 adds the three entity-id items (25 → 28 items, 186 → 273 sites)

**A ratchet EXTENSION, in a commit that touches no product code** — the same act
and the same disclosure as POD-305's `change-row-typings` redefinition below. The
counts rose because three kinds of debt that were always present became
*measured*, not because any debt was added.

POD-363's acceptance criterion said *"the raw-string-entity-id audit item reaches
ZERO repo-wide"*, and POD-301's fourth criterion says the same. **There was no
such item.** `scripts/rearch-audit-baseline.json` had no key, `scripts/rearch-audit.ts`
had no detector, and the number being reported as zero was the
`POD-361-EDGE-CAST` marker count — a different thing, which is genuinely zero.
POD-423 held the Phase 1 exit gate open for this and stated the rule these three
keys exist to satisfy:

> An audit item named in an acceptance criterion but absent from the baseline is
> not a passing check, it is an unmeasured claim.

| Key | Baseline | Phase | What one count is |
|---|---|---|---|
| `raw-string-entity-ids` | 47 | POD-301 | a zod field whose key names a branded entity id and whose schema is an unbranded string |
| `machine-id-unbranded-fields` | 38 | POD-318 | a machine-id zod field, in either spelling — bare `z.string()` or the `machineIdBlockedOnPOD318` marker |
| `unbranded-by-decision-ids` | 2 | POD-301 | an id field excused by an `UNBRANDED` doc comment |

Three decisions are recorded rather than left implicit:

1. **The vocabulary is derived, not listed.** POD-423 measured 66 sites with a
   grep over eight field names and said plainly that it could not see a ninth.
   `scripts/entity-id-audit.ts` reads the brand set out of `packages/model`'s own
   `<Brand>IdField` exports and matches any key that IS or ENDS IN `<brand>Id`,
   so `targetSessionId`, `lastSessionId`, `sourceMachineId` and
   `deletedByIssueId` are in scope without anyone naming them. Measured: **79**
   raw sites against the eight-name grep's 66. A detector built the other way
   inherits POD-1168's defect, where one syntax form of a concept was enumerated
   and another was invisible.
2. **`MachineId` is its own item, mapped to POD-318 — not to POD-301.** ADR 1
   Amendment 2 D16.2 is normative that the brand must not be adopted at any field
   until `local` / `__local__` are retired, because branding a sentinel launders
   it rather than flagging it. D16.2 asks for *"a narrower, visible debt"*, and a
   carve-out nobody counts is not visible — so the 38 sites are COUNTED, under
   the phase that deletes them, instead of being silently excluded from POD-301's
   number. POD-301 cannot close by laundering them; POD-318 cannot close while
   they remain.
3. **The excuse is counted too.** Without `unbranded-by-decision-ids`, the first
   item is zeroable by writing `UNBRANDED` above every field. With it, an excuse
   raises a committed number and the audit fails until the reason is recorded.
4. **The TENANT is a third spelling of the concept** (POD-1212). Decisions 1–3
   left a hole big enough to drive a command contract through: both spellings the
   detector knew read a NAME, and

   ```ts
   const byId = z.object({ id: z.string() })   // ten issue commands
   ```

   has neither — the key is `id`, the declaration is `byId`, and only the
   DIRECTORY says `Issue`. POD-1212 proved it by flipping a branded field back to
   a bare string in `packages/commands/src/issues/contracts.ts` and watching
   `audit:rearch` stay green. `brandOfPath` closes it by singularising path
   segments against the same derived vocabulary: **34** sites the previous
   detector scored as absent, 31 of them flipped. A declaration naming a
   DIFFERENT entity vetoes the directory, so `IssueComment.id` inside `issues/`
   is still not an `IssueId`.

   A structural rule for the polymorphic case — exclude a bare `id` whose object
   declares a `kind` sibling — was implemented and **reverted**: it silently
   excluded `startInput` and `addSessionInput` (`agentKind` is an attribute) and
   `actionInput` (`kind` is the verb), all three of whose ids are issue ids. What
   makes `pinSetInput` polymorphic is its enum's MEMBERS, which is not legible at
   the declaration. An exclusion that cannot tell those apart fails by quietly
   not looking, which is the defect this whole item exists to prevent — so the
   polymorphic site is answered by the ratcheted `UNBRANDED` marker instead.

**Limit, stated because a grep audit is never sufficient:** only zod field
positions are in a baseline key. The same scan also classifies drizzle columns
(68) and hand-written TS `sessionId: string` members (754) and prints them under
`bun scripts/entity-id-audit.ts --sites`, but branding a column is drizzle's
`$type<>()` and most TS members are `z.infer`-derived and follow the zod flip for
free. A zero here means "no zod schema declares a raw entity id", not "no raw
entity id exists".

### 2026-07-31 — POD-1203 drives `publish-computed-fanout` to zero: 13 vanished, 0 moved

| Item | Was → now | Verdict |
| --- | --- | --- |
| `publish-computed-fanout` | 13 → 0 | **13 vanished, 0 moved.** `publishComputed` and `fanOutSnapshot` are deleted, and grepping their destinations finds no code home: the serving path that replaced them (`apps/server/src/gateway/feed-serving.ts`) constructs no entity message of its own — a legacy client's full lists are folded out of the feed by the expiring v1 adapter, which is one of two sites `bun run audit:serving-path` allows. The identifier still appears in PROSE, in comments explaining the deletion; the detector strips comments, which is why the count is honest. |
| `change-row-typings` | 12 → 12 | **Unchanged, and it was briefly 14.** The first cut of `feed-serving.ts` restated a change row inline for its bootstrap mapping. Derived from the frame's own `changes` element type instead — a third definition of a change row is byte-identical on the wire and therefore invisible to every golden fixture, which is exactly what this item counts. |

**A ZEROED DETECTOR NOW CARRIES ITS OWN ANCHOR.** From zero, this detector's count
can only ever mean "nothing found" — which is what a BROKEN detector reports too.
It joins `ZERO_BY_DESIGN` on the terms `send-turn-duplicate` set and
`upstream-sync-forwarder` followed, and no looser: `collect` THROWS when its roots
match no files and when its pattern stops matching either of two control strings
copied from the diff that deleted them (a call site, and the composition-root
wiring). Each control is proven load-bearing on its own, because two controls that
can only fail together are one control wearing two names.

**The phase gate did not flip, and that was predicted in place.** `--phase POD-308`
still exits 1: the phase owns `legacy-wire-v1-adapter` (6, expiring at Phase 7) and
`change-row-typings` (12). `scripts/rearch-audit.test.ts` names POD-308 as its live
example and asserts BOTH directions; nothing there needed to change.

### `per-user-singletons` 2 → 0 at POD-1229 — the item is CLEARED, by deletion

The last two sites were `readAt` on `IssueAutoArchiveObservation` and
`SessionAutoArchiveObservation`. They were not residue of POD-1076's mechanical
re-key; they needed a policy call ("archive it because it was read" — read by
whom?), which is why the item was re-phased to POD-1229 rather than closed by
POD-1076 or laundered into POD-302.

**Cleared the way the other six were: by deleting the field, not by re-keying it
and not by touching the detector.** Both observations now carry `readerUserId`
and no timestamp, and the server refuses any proposal naming a principal other
than the viewer it archives for. The `readAt` on the wire bought only a
compare-and-swap that the freshness cutoff and the NaN guard already subsume.
Full reasoning and mutation evidence:
`docs/agents/pod-1229-auto-archive-reader-decision.md`.

**Read this zero with the item's limit.** `per-user-singletons` matches key NAMES
on declarations that clear `ENTITY_SHAPE_THRESHOLD`, so a shape can leave the
population by shedding unrelated keys — a zero that means "no longer inspected"
rather than "no longer carries per-user state". Checked explicitly here: re-adding
`readAt` to either observation makes the detector report that exact site again.
Both remain inspected; the zero is a deletion. The next zero on this item deserves
the same one-line check, and the caveat now sits next to the check itself.

## Registered transitional residue

Residue is code intentionally retained after its owning deletion slice reaches zero. It is
registered in `REGISTERED_RESIDUE` in `scripts/rearch-audit.ts` with exact production sites,
an owner, and an expiry; `rearch-audit.test.ts` pins every registered `needle` against live
production source, so a registered site that silently moves fails there rather than going
quietly stale. Registered residue is excluded from the slice count, while the forbidden
old-path detector remains at zero.

A COUNT and a REGISTER answer different questions, which is why both are here: a count says
how much is left, and a register says which of what is left is deliberate, whose it is, and
what event retires it. A residue whose count is legitimately non-zero is indistinguishable
from one nobody has looked at until somebody writes down which it is.

The Issues pilot retains one residue entry: the minimal `IssueWire` type, the session-free
legacy issue emit, and the membership-scan regression counter. It is deleted when the hub
speaks projections (POD-827), which is what blocks normalized-as-sole-feed on hub-node
installs.

Main's register lists a fourth site, the upstream hub-mirror consumer in
`packages/sync/src/upstream.ts`. It is **not** re-pointed here, because on this branch it is
already gone: `upstream-sync-forwarder` records both classes and both construction sites as
VANISHED with none moved (POD-309 landed). Main's other three needles name different files than
this tree does, and were re-pointed rather than copied — the register's test pins every
needle against live source, so a carried-over path fails loudly instead of ageing quietly.

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
