# Wave 5 — the shipping repository, answered against the Stage A checklist (POD-3396)

`apps/server/src/store/shipping.ts`, 2,688 lines, 77 statements, 19 transaction spans, 50 public
methods. This is the pre-conversion audit: every question the execution method's Stage A checklist
asks, answered for this file, before a line of it moves.

Everything below is DERIVED from the source, the schema and the compiler rather than read off by
eye, and each derivation was shown able to report the thing it claims is absent. Where a claim is
"none", the check that would have found one is named beside it.

## 0. The conversion is blocked, and this audit is not

The target a converted method calls does not exist on the branch: `executor.drizzle` is the
prototype `QueryClient`, whose five verbs are fully asynchronous, while a wave is told to keep its
methods synchronous. Filed as POD-3402, escalated to the coordinator. Nothing in this document
depends on how it is answered — these are properties of the file being converted, not of what it is
converted onto.

## 1. §2.7 constructs — nothing in this file belongs to the driver or the migrations

| Construct | Count | Consequence |
|---|---:|---|
| `PRAGMA`, `sqlite_master`, `ATTACH` | **0** | Nothing moves to the driver or the migrations. |
| `INSERT OR REPLACE` | **0** | The reviewer rule "an `OR REPLACE` conversion must name every column" does not apply to this file at all. |
| `INSERT OR IGNORE` | **0** | |
| `RETURNING` | **0** | See §3 — this is the finding that matters most for the intent lint. |
| `lastInsertRowid` | **0** | No rowid arithmetic to preserve. |
| `ON CONFLICT` | 2 | Both `ON CONFLICT(lane_key) DO UPDATE`, at :645 and :1536 — the lane-revision upsert. Targets reviewed: both name the same unique key and update the same two columns. |
| Dynamic `IN` list | 1 | `issueIdsForOrders`, chunked at 500 — see §6. |

## 2. JSON columns — already decided, and the schema already carries the decision

The corrupt-blob oracle (`store/json-column-corruption-oracle.test.ts`) pins 13 cases for this
file, and [0.12] has already applied them to `schema.ts`. So checklist item 2 needs no judgement
here; it needs the conversion to READ each column the way the schema already declares it.

**Keeps its quarantine — plain `text()` in the schema, so a builder read hands back the raw string
and the mapper's `jsonArray` / `jsonObject` keeps working unchanged:**

- `ship_orders.descendant_manifest` (plain order quarantines; a STACKED order throws through
  `ShipOrder.parse`'s binding refinement — the column's behaviour depends on the row, and both
  cases are pinned)
- `ship_orders.delivery_depends_on`
- `ship_orders.provider_ref`
- `ship_orders.current_integration_receipt` (same row-dependent pair)
- `ship_holds.evidence_refs`
- `ship_holds.actions` — **throws by accident**, and the conversion preserves the accident: the
  quarantine yields `[]` and `ShipHold.parse` then refuses an empty `actions`, so one corrupt hold
  makes every hold unreadable. Spec §6 rule 4 says preserve it; the fix is filed outside this epic.

**`mode: 'json'` in the schema, because the throw is intended:**

- `ship_orders.validation_profile`
- `ship_steps.input_fence`
- `ship_train_manifests.provider_ref`, `.validation_profile`
- `ship_train_members.delivery_depends_on`

`ship_train_manifests.canonical_json` is plain text on purpose: it is compared as bytes against a
digest, never parsed as a column.

## 3. Write intent — decidable by derivation here, with zero judgement calls

The wave brief's central hazard is that drizzle emits a `RETURNING` write through `all`, so a write
that returns rows must declare `writeAll` / `writeGet` and never `all` / `get`.

**That hazard does not arise in this file.** Derived over all 77 statements:

```
  1  DELETE .run()  -> run
 16  INSERT .run()  -> run
 12  UPDATE .run()  -> run
 35  SELECT .get()  -> get
 13  SELECT .all()  -> all
```

- statements the derivation could not classify: **0**
- writes that return rows: **0**
- reads issued as `run()`: **0**

So the intent declaration for wave 5 is mechanical: 29 writes are `run`, 48 reads split 35 `get` /
13 `all`, and nothing in the file needs `writeGet` or `writeAll`.

THE DERIVATION WAS PROVEN ABLE TO REPORT THE HAZARD, because an absence claim from a silent scanner
is worth nothing. Planting a single `UPDATE … RETURNING issue_id` in `issueIdForOrder` and re-running
it reports `WRITES THAT RETURN ROWS: 1` naming the line and the method; the file was restored and
diffed byte-identical against `git show HEAD:` afterwards. The scanner also reconciles: its
per-method counts sum to exactly the 77 `.prepare(` sites in the file, and the file contains no CTE
that could put a keyword ahead of the verb it reads.

## 4. Bound parameters that could be `undefined` — none, and the COMPILER is the proof

`SqlParam` is `string | number | bigint | boolean | null | Uint8Array`. It does not include
`undefined`, and `apps/server` typechecks clean, so no bound parameter in this file can be
`undefined` today. That is a stronger answer than a scan: a regex over optional model fields
over-reports badly here — it flags 22 sites, of which 15 are `DeliveryReceipt` fields that are
REQUIRED on that model and merely share a name with an optional field elsewhere.

Shown able to fail: dropping the `?? null` from `order.holdCode ?? null` (:639) produces
`TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'SqlParam'`.
Restored and diffed clean.

**THE HAZARD THIS MOVES TO, and it is a real one for whoever reviews the conversion.** The proof
above holds only while the binding surface refuses `undefined`. drizzle's builder does not:
`.values({ holdCode: undefined })` is legal TypeScript and means "use the column default", which is
silently NOT the same as `NULL`. The 13 sites this file currently defends with an explicit
`?? null` are exactly the sites where that difference would land, and they must survive the
conversion as explicit nulls rather than becoming omitted keys.

## 5. Mapper lines — which are decisions and stay (rule 6)

**Go** — they exist only because the driver returns `unknown`: 38 row casts, being 12 `as SqlRow`,
6 `as SqlRow[]` and 20 hand-typed shapes (`as { generation: number }` and friends). The `SqlRow`
alias itself goes with them.

**Stay** — each is a decision, with its reason:

- `jsonArray` / `jsonObject` — the quarantine the oracle pins. §2.
- `actorFromColumns(row.requestedByActorKind as ActorKind, String(row.requestedByActorId))` — the
  actor union, and the `String()` is load-bearing rather than cosmetic.
- `requestedBy.onBehalfOf: row.requestedByOnBehalfOf ?? null` — null is a value here, not absence.
- The `...(optionalString(x) ? { k: x } : {})` spreads — they choose ABSENT over `undefined`, which
  is a different thing to the zod schema and to `exactOptionalPropertyTypes`.
- `canonicalIntegrationReceipt`'s descendant sort — canonical ordering, compared against digests.
- **Every `ShipX.parse(...)` stays.** Rule 3 removes hand-typed selects, and a reader may take the
  parse for one of them; it is not. The parses carry refinements the corrupt-blob oracle asserts on
  — the stacked-order binding between `descendant_manifest` and `current_integration_receipt` is
  enforced there and nowhere else — so removing a parse would falsify a pinned case rather than
  tidy a cast.

## 6. The one dynamic `IN` list

`issueIdsForOrders` builds one placeholder per id and chunks at 500, which bounds the statement
cache to two distinct SQL texts for any realistic input. The conversion keeps the chunk. It had no
test of any kind before this issue; the golden test now straddles the boundary with 501 orders.

## 7. Spans, and the durability property this wave must not move

19 `transaction(this.db, …)` spans: `createOrder`, `createOrReturnActiveOrder`, `claimTrain`,
`releaseTrain`, `isolateTrainFailure`, `recordNativeStackEdge`, `claimAttempt`,
`assertEffectDispatchCustody`, `commitEffectResult`, `commitCancellationHold`, `commitCustodyHold`,
`cancelAttemptAndOrder`, `requestCancellation`, `raiseHold`, `resolveHold`, `recordEffectEnvelope`,
`completeCoveredOrder`, `completeVerifiedTrain`, `completeVerifiedOrder`.

Several nest by construction — `isolateTrainFailure` calls `appendStep`, `releaseTrain`,
`finishAttempt` and `raiseHold`, each of which opens its own span and therefore becomes a savepoint.
`transaction()` keys depth on the handle object, so the nesting is what makes the isolation atomic.

**POD-3366'S CLEAN CLASSIFICATION IS NOT AT RISK FROM THIS FILE, and here is why in terms rather
than as an assurance.** Its six commit sites are in `modules/shipping/service.ts`, not here; four
were called clean because their audit writes an events row inside the same transaction, so the row
rolls back with it. This repository never writes an events row and never calls the ledger — it is
called from inside those spans. The only way a conversion here could move that property is by
changing a transaction BOUNDARY, since the boundary is what decides whether the audit's row shares
the fate of the shipping write. So the constraint reduces to spec §6 rule 7 exactly: same spans,
same nesting, same `BEGIN IMMEDIATE` at depth 0 and savepoints below, none added and none removed.

## 8. Side effects inside spans — this file contributes nothing to B-prep

Checklist item 6 asks what inside a span is not the database. In this file: nothing.

- no `log.*`, no logger of any kind
- no `Date.now()`, no `new Date()`, no `Math.random()` — every timestamp arrives as a parameter
- no `fetch`, no `process.*`, no timers
- no `await` anywhere in the file
- no event publication, no mail, no cache mirror

The only non-SQL work is `createHash` (9 uses, pure) and zod parsing (pure). Consistent with the
three B-prep ledgers, none of which lists this file:
`pod-3258-timer-guard-ledger.md`, `pod-3259-mutable-state-ledger.md`, `pod-3260-span-effect-ledger.md`.

## 9. Coverage, and where the golden tests went

The census (POD-3244) gives this file 50 public methods: 3 never executed, 15 executed but never
named by a test, the rest directly tested. Golden tests were written FIRST, against the synchronous
code, for the three with nothing: `issueIdForOrder`, `issueIdsForOrders`, `isolateTrainFailure`
(`store/shipping-uncovered.test.ts`, 5 tests). Ten by-line mutations of `shipping.ts`, each verified
applied by diffing against `git show HEAD:`, all ten killed with isolating messages.

## 10. The order the conversion lands in

1. **The shared shapes and mappers, as their own commit** — `orderSelect`, `attemptSelect`,
   `stepSelect`, `holdSelect`, `receiptSelect` and `mapOrder`, `mapAttempt`, `mapStep`, `mapHold`,
   `mapReceipt`, `mapIntegrationReceipt`. Ten artefacts that 48 of the 77 statements read through,
   so a reviewer checks the mapping once instead of 54 times.
2. **The methods**, grouped by aggregate: orders, attempts, trains, steps, holds, receipts.


---

# The conversion, and where a reviewer should look (added after it landed)

Two reviewers, per the method. This section is the map.

## What the file is now

No `.prepare(`, no `@podium/runtime/sqlite` import, no `SqlDatabase`: the raw handle is gone,
which is the property `STAGE_A_UNCONVERTED`'s definition turns on. The constructor takes the
executor's synchronous drizzle instance and its synchronous span, and nothing else.

77 raw statements became 71 drizzle ones. The six are DEDUPLICATIONS OF SOURCE, never of
execution — each call site still issues exactly one statement, so no query count per request
moves:

| Collapsed | From | Into |
|---|---:|---|
| `COALESCE(MAX(generation), 0)` over `ship_holds` | 5 sites | `highestHoldGeneration` |
| the delivery-receipt insert | 2 sites | `insertDeliveryReceipt` |
| the lane-revision upsert | 2 sites | `bumpLaneRevision` |

The count reconciles: 31 `.get()`, 13 `.all()`, 27 `.run()` = 71.

## The four things worth a reviewer's attention

**1. Five columns are read as TEXT although the schema declares them `mode: 'json'`.** This is
the one place the conversion deliberately declines what rule 28 describes, and the reasoning is
in a block comment above the projection constants. Two independent reasons: the stored TEXT of
`ship_train_manifests.validation_profile` / `.provider_ref` and `ship_train_members.delivery_depends_on`
IS the train custody check — compared byte for byte against a re-serialised manifest, so a parsed
object makes every train fail — and a corrupt value under the json mode throws at the DRIVER,
before the method's fences and with drizzle's parse message rather than the model's, which the
corrupt-blob oracle pins. Both were observed, not predicted: the first reddened two golden tests,
the second reddened six oracle cases. Raised with the coordinator as a wave-wide question.

**2. Every `?? null` had to stay an explicit null.** An omitted key in a drizzle `set` is not
written, so `finishAttempt`'s five cleared columns would have kept their previous values.
Thirteen sites in this file are in that position, and the checklist's own question about
`undefined` parameters (§4 above) is what made them visible.

**3. The write side of a `mode: 'json'` column passes the OBJECT, not the string.** Passing an
already-stringified value would double-encode it. Byte-identity with the previous
`JSON.stringify(x)` was verified at drizzle's source — `SQLiteTextJson.mapToDriverValue` is
`JSON.stringify` — rather than inferred, because the custody check in (1) depends on it.

**4. `onConflictDoUpdate` is like-for-like only because the table has one uniqueness
constraint**, and rule 31 requires that established on the SHIPPED TABLE rather than read off
`schema.ts`, which is the map and not the territory. After the full migration chain:

```
DDL         CREATE TABLE `ship_lane_revisions` (`lane_key` text PRIMARY KEY,
            `revision` integer NOT NULL, `updated_at` text NOT NULL)
index_list  [{seq:0, name:"sqlite_autoindex_ship_lane_revisions_1", unique:1, origin:"pk"}]
fk_list     []
CHECKs      none
```

One entry, origin `pk`, on `lane_key`. So exactly one constraint can conflict and
`onConflictDoUpdate({ target: lane_key })` resolves the same one `ON CONFLICT(lane_key)` did; both
NOT NULL columns are supplied from non-nullable sources (the literal `1` and a `string` parameter).
Answered with evidence, so per rule 31 there is **no marker** — a marker is for a site you cannot
answer.

**5. One `sql` fragment needed a hand-written table qualifier**, and wave 6's note reached me about
an hour before I would have shipped the bug. drizzle emits an interpolated column UNQUALIFIED when
the enclosing query has a single FROM table, and inside a correlated subquery a bare name resolves
against the SUBQUERY's table first. Checked with `.toSQL()` rather than read off the builder:

```
two-table (activeTrainForOrder):  … WHERE c.train_id = "ship_train_manifests"."id"
one-table (completeVerifiedTrain): … WHERE c.train_id = "id"
```

The bare form is correct TODAY only because `ship_train_active_claims` happens to have no `id`
column. Proven fragile rather than assumed: give that table an `id` and the bare form counts **0**
where the qualified form counts **2** — no error, no log, a plausible number, and every train then
reads as unclaimed. Both sites now share one named fragment that qualifies the outer column by hand.

## What was deliberately NOT tidied

`transitionOrder` still carries both `state = ?` and `state NOT IN ('shipped','cancelled')`,
redundant against each other. The envelope scan still falls back to an empty-string attempt id
that matches no row. Narrowing a fence or short-circuiting a query during a conversion is a
behaviour change wearing a tidy-up's clothes.

## Three `sql` fragments inside builder queries

Rule 1 allows them anywhere; none is a whole raw statement and there is no `sql.raw`.
The step lifecycle-rank ordering (a decision, not a column); the correlated active-claim count,
twice, because drizzle has no builder form for a correlated subquery in a projection; and
`COALESCE(MAX(...), 0)` in the hold-generation helper.

## The negatives, each checked rather than assumed

- **Zero `mode: 'boolean'` columns** across all 14 shipping tables, so rule 28's boolean hazard —
  the one that reports every issue as not archived — cannot arise here and there is no true-case
  test to write.
- **Zero `INSERT OR REPLACE` and zero `INSERT OR IGNORE`**, so neither of the coordinator's
  rulings about them applies, and no line in this file carries a `// DECISION` marker.
- **Zero `RETURNING` writes**, so no site needs `writeGet`/`writeAll`.
- **No source-text scanner over this file stops matching** (rule 32). `scripts/check-boundaries.ts`
  is the only thing that reads it as text, and it now matches MORE, not less: the ledger's slack
  check fires precisely because the file is converted. No test reads it as source.
- **The statement probe still SEES this file's queries**, checked positively rather than reasoned,
  because zero is what a dead counter reports: a converted `listOrders` + `listHolds` observed
  through `probeLegacyStatements` emits two statements and the probe records both. The seam's own
  routing fix is what makes that true — before it, a converted repository would have been invisible
  to the query-count probes and to `scripts/measure-hot-paths.ts`.
- **Two mutants survived and both are classified**, because "2 of 4 killed" without the reasons
  reads as half-untested. Omitting an explicit `null` is an EQUIVALENT mutant here: all fifteen
  sites are nullable columns with no default, on an insert or on the single `finishAttempt` update,
  which is fenced on `finished_at IS NULL` over columns `createAttempt` never sets. Swapping the
  lane upsert for `onConflictDoNothing` is a COVERAGE GAP with a stated cause: the lane revision is
  a second fence behind `invalidateActiveLane`, which releases the affected trains explicitly, so
  no public path separates the two mechanisms.
- **`bun run audit:hidden-reads` is green**, "Shipping code — must be empty (0)".

## Rule 36: what the queries actually emit

Rule 36 says print, do not reason, for any `sql` fragment in a SELECT list. This file has seven such
fragments and printing all of them found something reading could not.

| Query | Fragment | Emitted |
|---|---|---|
| `getOrder`, `stepById`, `normalizedMembers` | the text re-projections, 1 table | bare `"validation_profile"` etc. — harmless, no inner FROM to capture the name |
| `trainManifestForAttempt` | the text re-projections, JOIN | fully qualified |
| `activeTrainForOrder` | `activeClaimCount`, JOIN | `c.train_id = "ship_train_manifests"."id"` |
| `completeVerifiedTrain` | `activeClaimCount`, **1 table** | `c.train_id = "ship_train_manifests"."id"` — the hand-written qualifier holding |
| `highestHoldGeneration` | `COALESCE(MAX(…), 0)`, 1 table | bare `"generation"` — harmless, no inner FROM |
| `hasNativeStackEdge` | the literal `1` | no column to strip |
| `latestStepForEffect` | the `CASE`, in ORDER BY | qualified — `buildSelection` never sees the ORDER BY |

**AND IT CAUGHT A WIDENING IN MY OWN WORK.** The two ad-hoc projections were spread from
`getTableColumns`, which was right for the five mapper shapes and wrong for these: each hand-written
mapper select named EXACTLY its table's columns (the 25/25, 16/16, 15/15, 11/11, 12/12 above), so
the whole table IS the old projection there. These two never did — the manifest authority read named
**19 of 25** columns and the member read **10 of 12**. Spreading them read six columns and two
columns the originals did not.

Nothing observable changed while they were wide: both readers build an explicit object from named
fields, so the extra columns were ignored, and no test could have caught it. But a conversion that
reads columns the original did not is not the literal conversion, and on the remote driver those are
bytes over a network. Both are now named column by column, and the emitted SQL is back to 19 and 10.

That is the second thing on this file that only printing found — the first being the bare identifier
— and neither was visible in the builder source.
