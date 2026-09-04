# Wave 6 Stage A checklist — `store/issues.ts` and `store/events.ts` (POD-3397)

Every site in the two files, answered against the execution method's §3 Stage A checklist, before
the conversion. Written against the code at `7d7def299`. Where an answer is a finding rather than a
task it says so and names the issue it was raised on.

Sizes: `issues.ts` 1,207 lines, 42 public methods, 15 tables touched
(`issues`, `issue_labels`, `issue_deps`, `issue_comments`, `issue_messages`,
`issue_message_user_state`, `issue_user_state`, `issue_ref_letters`).
`events.ts` 585 lines, 27 public methods, 6 tables
(`podium_events`, `runtime_event_checkpoints`, `runtime_event_projection_cursors`,
`steward_state`, `subscriptions`, `subscription_deliveries`).

---

## 0. The two findings that are not mine to fix

### F1 — three `issues` columns are `mode: 'boolean'` in the schema and read as `=== 1` in the mapper

`migrations/schema.ts` declares `archived`, `needs_human` and `draft` as
`integer({ mode: 'boolean' })`, and `subscriptions` declares `deliver_nudge`, `deliver_notify` and
`enabled` the same way. Today's readers do not go through drizzle, so they see the raw integer:

    archived: r.archived === 1          // issues.ts:411
    needsHuman: r.needs_human === 1     // issues.ts:393
    draft: r.draft === 1                // issues.ts:415
    enabled: Number(r.enabled) !== 0    // events.ts:51

Under the drizzle builder those columns come back as `true`/`false`. `true === 1` is `false`, so a
conversion that keeps the comparison reads **every issue as not archived, not draft and not needing
a human**, and every subscription as disabled — with no error anywhere.

WHY IT WOULD SURVIVE REVIEW AND THE SUITE. The wrong answer is the COMMON answer. Most issues are
not archived, not drafts and are not asking a question, so a test that seeds an ordinary issue and
reads it back is green either way; only a test that seeds the true case and asserts it fails. The
comparison also still typechecks under `unknown`.

This is not specific to wave 6. It is the shape of every `mode: 'boolean'` column in the schema
against every hand-written `=== 1` / `Number(x) !== 0` mapper line in the store, so it belongs in
the working rules rather than in six wave commits that each discover it. Raised with the
coordinator.

The wave-6 sites, so a rule can be applied to them: `issues.ts` 393, 411, 415 and the writes at
278, 286, 289; `events.ts` 48, 49, 51 and the writes at 528, 529, 531, 556.

### F2 — `INSERT OR IGNORE` is wider than `onConflictDoNothing()` — CORRECTED, and the three sites are equivalent

Three sites used `INSERT OR IGNORE`: `events.ts` `markDelivered` on
`subscription_deliveries`, and `issues.ts` `setIssueLabels` on `issue_labels` and `addIssueDep` on
`issue_deps`.

**WHAT I FIRST WROTE HERE WAS WRONG, and the error is worth keeping visible.** I claimed `OR IGNORE`
suppresses every constraint violation *including the foreign key* onto `issues(id)`, and that
`onConflictDoNothing()` would let that foreign key throw. That is not what SQLite does: the
ON CONFLICT algorithm does not apply to foreign keys at all, so **neither** form suppresses one. I
reasoned it from the documentation's phrase "every constraint" instead of measuring it, and the
coordinator's own measurement (spec rule 31) is what corrected it.

Measured here on the SHIPPED tables, `PRAGMA` against a migrated database rather than a read of
`schema.ts`:

    OR IGNORE + FOREIGN KEY violation   -> THREW: FOREIGN KEY constraint failed
    plain     + FOREIGN KEY violation   -> THREW: FOREIGN KEY constraint failed
    OR IGNORE + PRIMARY KEY conflict    -> suppressed
    OR IGNORE + NOT NULL violation      -> suppressed

**So the real test is rule 31's**: the two forms are equivalent at a site if and only if no `NOT NULL`
and no `CHECK` violation is reachable there. All three of my sites pass it, so all three are plain
conversions and carry no marker.

| Table | CHECK | Foreign keys | NOT NULL columns | Reachable NOT NULL violation |
| --- | --- | --- | --- | --- |
| `subscription_deliveries` | none | none | `subscription_id`, `event_id` | No — `steward.ts` passes a subscription id and an event id, both non-nullable |
| `issue_labels` | none | `issue_id -> issues(id)` CASCADE | `issue_id`, `label` | No — `issueId` is required and `setIssueLabels` filters `clean` to non-empty strings before inserting |
| `issue_deps` | none | `from_id`, `to_id` -> `issues(id)` CASCADE | `from_id`, `to_id`, `type` | No — both ids required; `type` has a parameter default AND a column default of `'blocks'`, so an omitted value takes the same value either way |

The `markDelivered` return value (`changes > 0`, the steward's exactly-once guard) therefore keeps
its exact meaning: the primary-key conflict is the only thing `OR IGNORE` was suppressing there.

ONE EDGE WORTH STATING, because it is a real difference between the forms and not this one: under
drizzle an `undefined` field is OMITTED from the INSERT rather than bound as NULL, so a column with
no default would take a NOT NULL violation where the raw form threw at bind time. That is the
mechanism the enumeration above rules out, column by column, rather than a hazard I am waving away.

`INSERT OR REPLACE` appears once, at `events.ts:480` on `steward_state`. That table is
`(key PRIMARY KEY, value NOT NULL)` and nothing else, so the checklist's "name every column"
requirement is satisfied by naming `value` alone; there is no third column for a replace to blank.

---

## 1. §2.7 constructs, and what replaces each

Neither file contains `PRAGMA`, `sqlite_master`, `ATTACH` or any introspection. What they do contain
that the builder cannot express directly, and the intended replacement:

| Site | Construct | Replacement |
| --- | --- | --- |
| `events.ts:168,169,214-217` | `json_extract(payload, '$.t')` etc. | `sql` fragment inside the builder query (rule 1 permits it) |
| `events.ts:165-171` | `SELECT payload FROM (SELECT … ORDER BY id DESC LIMIT ?) ORDER BY id ASC` | subquery via `db.$with` / a `sql` fragment; the double ordering is the point and must survive |
| `events.ts:249` | `ON CONFLICT … DO UPDATE … WHERE excluded.last_event_id > runtime_event_projection_cursors.last_event_id` | `.onConflictDoUpdate({ target, set, setWhere })` — **`setWhere`, not `where`**; `where` filters which rows conflict, `setWhere` guards the update, and the two are not interchangeable |
| `events.ts:408` | `SELECT MAX(id) AS m` | `max()` aggregate; keep the `?? 0` |
| `events.ts:438` | `ORDER BY id DESC LIMIT 1 OFFSET ?` | `.limit(1).offset(n)` |
| `events.ts:450-463` | `DELETE … WHERE id IN (SELECT … COALESCE((SELECT …), 0) …)` | subquery + `coalesce` fragment; the correlated read of the projection cursor is load-bearing |
| `events.ts:480` | `INSERT OR REPLACE` | `.onConflictDoUpdate` naming `value` (see F2) |
| `events.ts:580`, `issues.ts:839,879` | `INSERT OR IGNORE` | see F2 — **needs a rule before conversion** |
| `issues.ts:316` | `revision = COALESCE(revision, 0) + 1` | `sql` fragment referencing the column; a self-referencing update, not a bound value |
| `issues.ts:763` | `repo_path LIKE ? || '/%'` | `sql` fragment; the `|| '/%'` is the path-boundary match and mutation-checked by the golden test |
| `issues.ts:765` | `ORDER BY created_at ASC, rowid ASC` | `rowid` is not a schema column; `sql` fragment. The `rowid` tie-break is load-bearing on equal `created_at` |
| `issues.ts:988-989` | `body LIKE ? ESCAPE '\'` | drizzle's `like()` emits no `ESCAPE`; needs a `sql` fragment or the escape is silently lost (mutation-checked by the golden test) |
| `issues.ts:672` | `WHERE issue_id NOT IN (SELECT id FROM issues)` | `notInArray` with a subquery |
| `issues.ts:974` | `COUNT(*) … GROUP BY issue_id` | `count()` + `.groupBy()`; absent issues must stay ABSENT from the map, not appear as 0 |

## 2. JSON columns, and what the corrupt-blob oracle says for each

| Column | Schema | Today | Conversion |
| --- | --- | --- | --- |
| `podium_events.payload` | `text().default('{}')` | `rowToEvent` parses in a `try`/`catch` and yields `{}`; a wrong-SHAPE value passes straight through | Read as text and keep the same parse. Spec rule 4 names this column explicitly as a passthrough that must keep passing wrong shapes through — **`mode: 'json'` is refused here**, and so is tightening it |
| `issues.blocked_by` | `text().default('[]')` | `parseStringArray` quarantines to `[]` | Read as text; keep `parseStringArray` and its `log.warn` (rule 19 keeps the log where it is) |
| `issues.human_question_options` | `text()` | `parseStringArray`, then empty → `null` so a corrupt blob degrades to the free-form question rather than to empty chips | Unchanged, including the empty→null step, which is a decision and not a driver artefact |
| `runtime_event_checkpoints.cursor_json` | `text()` | `ProviderCursor.parse(JSON.parse(...))` inside a `try` returning `null` for the WHOLE checkpoint | Unchanged. The quarantine is at checkpoint granularity, not column granularity: a corrupt cursor makes the session look uncheckpointed, which is the safe direction |
| `subscriptions` | — | no JSON column | — |

`workflow_events.payload_json` is named in rule 4 and belongs to another wave; nothing here reads it.

## 3. Mapper lines that are decisions (stay) and lines that are driver artefacts (go)

**Stay — each is a decision with its comment (rule 6).**

- `requireUserId(userId)` at `issues.ts:1110, 1129, 1149, 1073, 1090` — fails closed on an empty
  user id. Named in rule 6 by example.
- `visibility` narrowed to a union with a `'personal'` fallback (`issues.ts:339-345`) — an unknown
  stored value degrades to the least-privileged setting rather than propagating.
- `isIssueColorSlot(r.color) ? r.color : null` (`issues.ts:391`).
- `revision: (r.revision as number | null) ?? 1` (`issues.ts:419`) — defence in depth against a
  hand-mangled database, and its comment says so.
- `?? 'auto'`, `?? 'human'`, `?? 'task'`, `?? 2`, `?? ''` defaults — these are not NULL-handling for
  an untyped driver, they are the stored-sentinel contract.
- The row-level structural quarantines at `issues.ts:629-636` (`listIssueRows`), `560` (`getIssues`)
  and `478` (`listIssueCwdRows`) — a NULL id in a TEXT PRIMARY KEY is legal in SQLite, and these
  keep it out of a boot hydration and a cwd decision. The `log.error` beside each stays (rule 19).
- `rowToEvent`'s empty-object payload default and `runtimeEventCheckpoint`'s `null` return
  (`events.ts:26-29, 112-124`).
- `Number(r.closed_turn_epoch)` guarded by an explicit `== null` check (`events.ts:119`) — without
  the guard `Number(null)` is 0, which reads as "turn 0 closed". Pinned by the golden test.

**Go — present only because the driver returns `unknown`.**

- Every `as string` / `as number` on a column the schema types (`title`, `repo_path`, `seq`,
  `created_at`, `updated_at`, the whole of `rowToSubscription` except its two union casts).
- `Number(r.id)`, `Number(row.observer_generation)`, `Number(row.turn_epoch)`,
  `Number(r.last_event_id)`, `Number(result.changes)` — the schema types these as `integer`.
- The `Record<string, unknown>` parameter types on `mapIssueRow`, `mapIssueMessage`, `rowToEvent`
  and `rowToSubscription`, and the `as Record<string, unknown>[]` on every `.all()`.
- `?? null` on a column the schema already declares nullable.

## 4. Brands: which flow from `$type`, and which casts survive with a reason

Flow from `$type` and lose their cast: `issues.id`, `owner_user_id`, `repo_id`, `machine_id`,
`parent_id`, `superseded_by`, `duplicate_of`, `coordinator_session_id`, `started_by_session`;
`issue_labels.issue_id`, `issue_deps.from_id`/`to_id`, `issue_comments.issue_id`,
`issue_messages.issue_id`, `issue_user_state.user_id`/`issue_id`,
`issue_message_user_state.user_id`, `issue_ref_letters.issue_id`,
`runtime_event_checkpoints.session_id`.

**Casts that must stay, because the schema does not carry the brand:**

- `issues.created_by_on_behalf_of` — mapped `as UserId | null` (`issues.ts:347`), schema column is
  plain `text('created_by_on_behalf_of')`.
- `issues.assignee` — mapped `as UserId | null` (`issues.ts:377`), schema column is plain `text()`.
- `issues.human_question_asked_by` — mapped `as SessionId | null` (`issues.ts:406`), plain `text()`.
- `podium_events.subject` read as a `SessionId` in `listRuntimeEventsAfter` (`events.ts:232`) — the
  column is a polymorphic subject and cannot be branded; the decode belongs to the runtime-log
  reader, which knows the kind it filtered on.
- `issue_comments.issue_id` re-entering through `asIssueId` in `searchIssueComments`
  (`issues.ts:996`) — a runtime check, not a cast, and it stays.

The first three are a schema question and `schema.ts` is the coordinator's during Stage A, so they
are recorded here as casts-with-a-reason rather than fixed. Adding `$type` to them would be a
one-line schema edit and would delete three casts; it is offered, not taken.

## 5. Spans: boundaries, nesting, read-decide-write, immediate mode

Three sites open their own transaction, and all three are read-decide-write:

- `events.ts:497 activateJanitorSteward` — reads the ownership key, decides, then writes the cursor
  and the watermark. The claim is the whole point: the two writes must not be separable by a crash.
- `issues.ts:804 allocateSessionLetter` — read-increment-return on `issue_ref_letters`; two
  concurrent allocations must not mint the same letter.
- `issues.ts:747 renumberCollidingIssueSeqs` — the update loop only; the read and the planning are
  deliberately OUTSIDE the transaction, which keeps the write window short and is why the plan is
  computed first. A conversion must not widen the span to cover the read.

**The one that has no span of its own and must not gain one:** `upsertIssue`'s revision
precondition (`issues.ts:172-181`) is a read-decide-write that borrows its caller's span. Its
comment states the property directly — it cannot fire while the store is synchronous, and it is
armed for when the awaits arrive. Wrapping it in its own transaction would make the precondition
check atomic with the write but NOT with the caller's other writes, which is a different and weaker
guarantee than the one `IssueRegistry.persistWith` relies on. Convert the two statements in place.

`transitionShippingStage` (`issues.ts:300`) is a compare-and-swap in ONE statement — the fence is
`WHERE id = ? AND stage = ? AND deleted_at IS NULL` plus `changes !== 1`. It must stay one
statement; splitting it into a read and a write would turn the CAS into a race.

No span in either file crosses repositories, and none nests. Immediate mode is the executor's, not
theirs.

## 6. Non-database calls inside spans (for the B-prep ledger — noted, not fixed)

| Site | Call | Class |
| --- | --- | --- |
| `events.ts:296` | `afterCommit(() => this.appendListener?.(…))` | already mechanism 3, and correctly so |
| `events.ts:310` | `this.appendListener(…)` in `announceEvent` | called by contract AFTER its transaction commits; deliberately unguarded so a wiring fault surfaces |
| `issues.ts:203` | `this.resolveRepoIdForPath(row.repoPath)` inside `upsertIssue` | a cross-aggregate call that reads the `repos` registry from inside the issue write path |
| `issues.ts:714` | the same resolver inside `renumberCollidingIssueSeqs`, in the planning phase | outside the span already |
| `issues.ts:565, 640; events.ts` | `log.error` / `log.warn` quarantine notices | STAY (rule 19 names `store/issues.ts` explicitly) |
| `issues.ts:91` | `invalidateRowCache()` before every `issues` write | not a side effect; see §9 |

## 7. Bound parameters that can arrive `undefined`

`upsertIssue` binds 63 parameters. 21 are written `row.x ?? null` and 20 are bound bare. The
coalesces are not decoration: `IssueRow` declares `brief`, `machineId`, `closedAt`, `landedAt`,
`landedSha`, `sortKey`, `color`, `humanQuestionAskedBy`, `humanQuestionAskedAt`, `panel`,
`deletedAt`, `coordinatorSessionId` and `startedBySession` as OPTIONAL, so a caller building a row
from a literal genuinely omits them, and bun:sqlite refuses an `undefined` binding. The bare ones
(`worktreePath`, `branch`, `assignee`, `parentId`, `design`, `acceptance`, `notes`, `dueAt`,
`deferUntil`, `closedReason`, `supersededBy`, `duplicateOf`, `estimateMin`, `linearId`,
`linearIdentifier`, `linearUrl`, `activityNotes`, `notesUpdatedAt`, `suggestedStage`,
`suggestedReason`, `dependencyNote`, `prUrl`, `humanQuestion`) are declared `T | null` and are
required, so the type is what keeps them defined.

Under the builder the risk INVERTS and is worth stating: drizzle omits an `undefined` field from
the INSERT column list entirely rather than binding NULL, so a field that today throws would
silently take the column DEFAULT. `.values({...})` must therefore keep every `?? null`, and the
bare ones should gain one rather than relying on a type at a boundary rows arrive at from JSON.
`markIssueMessagesRead`, `addIssueComment` (`actor ?? null`, `onBehalfOf ?? null`) and
`appendEvent` (`repoPath ?? null`, `payload ?? {}`) are the same shape and already coalesce.

## 8. Dynamic `IN` lists and the statement cache

Two sites build one SQL text per list length:

- `events.ts:336` — `kind IN (?, ?, …)` from `opts.kinds`. Unbounded: the text varies with the
  number of kinds a caller asks for. In practice the callers pass small fixed sets, so the distinct
  texts are few, but nothing enforces it.
- `issues.ts:556` — `id IN (…)` chunked at 500. The chunking bounds the LARGEST statement but not
  the NUMBER of distinct texts: a final chunk of 1…499 ids mints a text of that width, so the cache
  can hold up to 500 variants of this one query.

drizzle's `inArray` has exactly this property, so the conversion neither fixes nor worsens it. It is
recorded because it is what checklist question 8 asks, and because the 500-wide chunk is the shape
rule 9's batching work will meet.

## 9. Test setups that change

**None.** Neither repository is constructed directly anywhere: `new IssuesRepository` and
`new EventsRepository` appear only in `store.ts:289` and `store.ts:320`, which is the composition
root and is the coordinator's file. Every test reaches these repositories through `openTestStore`.

One probe seam exists and is not a construction: `EventsRepository.onAppend` installs the feed
listener, and the golden tests use it as the observation point for the two announcement paths.

**One enforcement test reads this file as SOURCE TEXT, and it has ALREADY been taught the builder
form.** `store-issues-row-cache-writers.test.ts` enforces invalidate-before-write on the row cache by
scanning `issues.ts` for statements that write the `issues` table and failing any enclosing method
that does not call `invalidateRowCache()` first.

I first read this as a hazard — a drizzle builder write is not a SQL string, so a text-only scan
would match nothing after the conversion and pass VACUOUSLY, which is worse than failing. It is not
a hazard, and the reason is worth recording because it is the answer to a question the other waves
will ask: the test carries TWO write forms, added for this epic (its header names POD-3221 step 5d).
A hand-written statement is found in the SQL text of a string or template literal; a builder write is
found as a call — `.insert(issues)` / `.update(issues)` / `.delete(issues)` — whose ARGUMENT resolves
to the schema's table object, so `import { issues as issuesTable }` and `schema.issues` both count
and `issueLabels` does not. Its own fixtures drive both arms.

So the conversion inherits a working check rather than silencing one, and there is nothing to raise.
`repos.ts` has the same guard for another wave
(`store-repos-registry-cache-writers.test.ts`), and the boundary lint family's
`cache-table-announcement` (`scripts/check-boundaries.ts`) is a third of the same shape.

TWO THINGS THE CONVERSION STILL OWES IT. The builder arm matches a write by the TABLE OBJECT, so
every `issues` write must go through `db.insert(issues)` and not through a `sql` fragment naming the
table in text — the text arm would still catch a template literal, but a fragment assembled from a
variable is invisible to both. And ordering is part of the invariant the test checks, not just
presence: `invalidateRowCache()` must precede the write, because a read taken between the write and
a later invalidation caches rows read inside an open transaction, and those survive a rollback for
the rest of the turn.

## 10. The uncovered methods

Answered, and landed first, as `7d7def299`:

- Never executed by any test: `IssuesRepository.purgeIssueUserState`,
  `EventsRepository.listKindSubjectSinceWithPrior`.
- Executed but never named by an assertion: `listIssueCwdRows`, `listIssueParentEdges`,
  `assignRepoIdToIssuesUnder`, `issuesMissingRepoId`, `listIssueLabelsByIssue`, `listAllIssueDeps`,
  `countIssueComments`, `countIssueCommentsByIssue`, `searchIssueComments`,
  `deleteIssueMessagesForIssue`; `saveRuntimeEventCheckpoint`, `listRuntimeEventsAfter`,
  `saveRuntimeEventProjectionCursor`, `announceEvent`, `activateJanitorSteward`.

45 tests over the two files, six mutations, each killed by the named test. One mutation survived the
first draft (the renumbering order) and one assertion was removed as unobservable; both are
recorded in that commit's message.

---

## What the brief asked me to check, and what I found

**The revision precondition (POD-3373) must not be weakened or widened.** It is two statements
inside `upsertIssue`: a `SELECT revision` and, on mismatch, a `StaleIssueRevisionError` thrown
before the write. Weakening = accepting a write it refuses today; the null case is the easy one to
lose, because `expectedRevision: null` means "this row must not exist yet" and reads like "no
precondition". Widening = refusing one it accepts today; the easy way in is wrapping the read in
its own transaction or comparing against the caller's `row.revision` instead of the stored value.
All four directions now have a named test.

**The issue row map is a `ReadonlyMap` with one `installRow` (POD-3366).** Checked, and it is not
in these two files: `getIssues` returns a plain `Map<string, IssueRow>` built locally per call and
handed to the caller, and the row CACHE is a `Map` inside a read-scope slot. The `ReadonlyMap` and
its single `installRow` live in the issue registry, above the store. Nothing in the conversion of
these two files can install into it, so the compile error POD-3366 arranged stays arranged. Stated
so a reviewer does not have to re-derive it.

**Two producers writing one kind (POD-3331).** The two paths are `appendEvent` with its default
`announce` and `appendEvent({ announce: false })` followed by `announceEvent(id)`. They are
deliberately distinct and must not be merged: the first announces through `afterCommit`, so inside
a span the announcement waits for the commit; the second is announced by its caller after a wider
transaction commits, and reads the row back from the log rather than re-using the caller's object.
`persistManyWith` depends on the second so a batch announces in the caller's order. Both paths now
have a named test, and a third pins that the listener is handed the STORED row.
## 11. Statement intent, declared per statement

86 statements: 58 in `issues.ts`, 28 in `events.ts`. Intent is READ for `SELECT` and WRITE for
`INSERT`/`UPDATE`/`DELETE`, declared at the client per spec rule 16, never inferred, and the default
where anything is unclear is `write`.

**No statement in either file carries a `RETURNING` clause today, so no site declares `writeAll` or
`writeGet`.** That is the useful half of the answer, and it has one exception waiting to be created:
`transitionShippingStage` (`issues.ts:300`) does an `UPDATE` and then a separate `getIssue` to return
the row, and the obvious drizzle spelling of that pair is `.returning()`. drizzle prepares an
`UPDATE ... RETURNING` with method `all`, so a conversion that takes the tempting shape produces a
WRITE the executor's lane selection would read as a READ — the exact defect POD-3316/POD-3318 found.
Either keep the two statements as they are, or use `writeAll`. It is the only site in wave 6 where
the question arises, and I am keeping the two statements.

Four rows read `deferred`: the statement is prepared into a local and executed in a loop below it
(`pruneOrphanRefLetters`, `renumberCollidingIssueSeqs`, `assignRepoIdToIssuesUnder`,
`setIssueLabels`, `markIssueMessagesRead`). The intent is the SQL verb either way; the loop is what
rule 9 will want batched.

### `store/issues.ts` — 58 statements, 33 read, 25 write

| Line | Method | SQL | Today | Intent | Client method |
| ---: | --- | --- | --- | --- | --- |
| 173 | `upsertIssue` | SELECT | `.get` | read | `get` |
| 184 | `upsertIssue` | INSERT | `.run` | write | `run` |
| 314 | `transitionShippingStage` | UPDATE | `.run` | write | `run` |
| 429 | `getIssue` | SELECT | `.get` | read | `get` |
| 464 | `listIssueCwdRows` | SELECT | `.all` | read | `all` |
| 506 | `closedIssueIds` | SELECT | `.all` | read | `all` |
| 556 | `getIssues` | SELECT | `.all` | read | `all` |
| 597 | `listIssueParentEdges` | SELECT | `.all` | read | `all` |
| 614 | `listIssueRows` | SELECT | `.all` | read | `all` |
| 620 | `listIssueRows` | SELECT | `.all` | read | `all` |
| 661 | `deleteIssue` | DELETE | `.run` | write | `run` |
| 663 | `deleteIssue` | DELETE | `.run` | write | `run` |
| 671 | `pruneOrphanRefLetters` | DELETE | `.deferred` | write | `run` |
| 683 | `nextIssueSeq` | SELECT | `.get` | read | `get` |
| 704 | `renumberCollidingIssueSeqs` | SELECT | `.all` | read | `all` |
| 746 | `renumberCollidingIssueSeqs` | UPDATE | `.deferred` | write | `run` |
| 761 | `assignRepoIdToIssuesUnder` | SELECT | `.all` | read | `all` |
| 770 | `assignRepoIdToIssuesUnder` | SELECT | `.get` | read | `get` |
| 773 | `assignRepoIdToIssuesUnder` | SELECT | `.deferred` | read | `all` |
| 775 | `assignRepoIdToIssuesUnder` | UPDATE | `.deferred` | write | `run` |
| 807 | `allocateSessionLetter` | SELECT | `.get` | read | `get` |
| 811 | `allocateSessionLetter` | INSERT | `.run` | write | `run` |
| 825 | `issuesMissingRepoId` | SELECT | `.get` | read | `get` |
| 837 | `setIssueLabels` | DELETE | `.run` | write | `run` |
| 838 | `setIssueLabels` | INSERT | `.deferred` | write | `run` |
| 847 | `getIssueLabels` | SELECT | `.all` | read | `all` |
| 856 | `listIssueLabelsByIssue` | SELECT | `.all` | read | `all` |
| 869 | `listAllLabels` | SELECT | `.all` | read | `all` |
| 879 | `addIssueDep` | INSERT | `.run` | write | `run` |
| 886 | `removeIssueDep` | DELETE | `.run` | write | `run` |
| 889 | `removeIssueDep` | DELETE | `.run` | write | `run` |
| 899 | `listIssueDeps` | SELECT | `.all` | read | `all` |
| 913 | `listAllIssueDeps` | SELECT | `.all` | read | `all` |
| 927 | `listDependents` | SELECT | `.all` | read | `all` |
| 938 | `addIssueComment` | INSERT | `.run` | write | `run` |
| 947 | `listIssueComments` | SELECT | `.all` | read | `all` |
| 963 | `countIssueComments` | SELECT | `.get` | read | `get` |
| 974 | `countIssueCommentsByIssue` | SELECT | `.all` | read | `all` |
| 992 | `searchIssueComments` | SELECT | `.all` | read | `all` |
| 993 | `searchIssueComments` | SELECT | `.all` | read | `all` |
| 1019 | `addIssueMessage` | INSERT | `.run` | write | `run` |
| 1028 | `getIssueMessage` | SELECT | `.get` | read | `get` |
| 1041 | `listIssueMessages` | SELECT | `.all` | read | `all` |
| 1046 | `listIssueMessages` | SELECT | `.all` | read | `all` |
| 1056 | `countUnreadIssueMessages` | SELECT | `.get` | read | `get` |
| 1074 | `markIssueMessagesRead` | UPDATE | `.deferred` | write | `run` |
| 1078 | `markIssueMessagesRead` | INSERT | `.deferred` | write | `run` |
| 1092 | `listIssueMessageReadAt` | SELECT | `.all` | read | `all` |
| 1112 | `listIssueUserState` | SELECT | `.all` | read | `all` |
| 1131 | `getIssueUserState` | SELECT | `.get` | read | `get` |
| 1163 | `setIssueUserState` | DELETE | `.run` | write | `run` |
| 1168 | `setIssueUserState` | INSERT | `.run` | write | `run` |
| 1182 | `purgeIssueUserState` | DELETE | `.run` | write | `run` |
| 1189 | `claimIssueMessage` | UPDATE | `.run` | write | `run` |
| 1198 | `deleteIssueMessagesForIssue` | DELETE | `.run` | write | `run` |
| 1202 | `deleteIssueChildRows` | DELETE | `.run` | write | `run` |
| 1203 | `deleteIssueChildRows` | DELETE | `.run` | write | `run` |
| 1204 | `deleteIssueChildRows` | DELETE | `.run` | write | `run` |

### `store/events.ts` — 28 statements, 19 read, 9 write

| Line | Method | SQL | Today | Intent | Client method |
| ---: | --- | --- | --- | --- | --- |
| 107 | `runtimeEventCheckpoint` | SELECT | `.get` | read | `get` |
| 129 | `saveRuntimeEventCheckpoint` | INSERT | `.run` | write | `run` |
| 144 | `listRuntimeEvents` | SELECT | `.all` | read | `all` |
| 164 | `listRuntimeTranscriptEvents` | SELECT | `.all` | read | `all` |
| 211 | `hasCausalTurnFailure` | SELECT | `.get` | read | `get` |
| 226 | `listRuntimeEventsAfter` | SELECT | `.all` | read | `all` |
| 241 | `runtimeEventProjectionCursor` | SELECT | `.get` | read | `get` |
| 248 | `saveRuntimeEventProjectionCursor` | INSERT | `.run` | write | `run` |
| 267 | `appendEvent` | INSERT | `.run` | write | `run` |
| 305 | `announceEvent` | SELECT | `.get` | read | `get` |
| 349 | `listEventsSince` | SELECT | `.all` | read | `all` |
| 363 | `listKindSinceWithPrior` | SELECT | `.get` | read | `get` |
| 371 | `listKindSinceWithPrior` | SELECT | `.all` | read | `all` |
| 388 | `listKindSubjectSinceWithPrior` | SELECT | `.get` | read | `get` |
| 396 | `listKindSubjectSinceWithPrior` | SELECT | `.all` | read | `all` |
| 408 | `maxEventId` | SELECT | `.get` | read | `get` |
| 438 | `planEventPrune` | SELECT | `.get` | read | `get` |
| 449 | `pruneEventBatch` | DELETE | `.run` | write | `run` |
| 472 | `getStewardState` | SELECT | `.get` | read | `get` |
| 480 | `setStewardState` | INSERT | `.run` | write | `run` |
| 501 | `activateJanitorSteward` | SELECT | `.get` | read | `get` |
| 515 | `addSubscription` | INSERT | `.run` | write | `run` |
| 537 | `removeSubscription` | DELETE | `.run` | write | `run` |
| 548 | `listSubscriptions` | SELECT | `.all` | read | `all` |
| 555 | `setSubscriptionEnabled` | UPDATE | `.run` | write | `run` |
| 561 | `getSubscription` | SELECT | `.get` | read | `get` |
| 569 | `listEnabledSubscriptions` | SELECT | `.all` | read | `all` |
| 579 | `markDelivered` | INSERT | `.run` | write | `run` |

