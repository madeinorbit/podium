# Updater epic — merge-gate review

**Issue:** POD-2232 · **Epic:** POD-2087 · **Reviewed at:** `9a8b0e3c0` on
`issue/2232-merge-gate-review`, range `c42a0d1ae..9a8b0e3c0` — the fifteen commits that
landed after the closing review (POD-2214) stopped. **Written:** 2026-08-17.

Spec: `docs/internal/superpowers/specs/2026-08-14-update-operations-design.md`.
Protocol: `docs/internal/superpowers/plans/2026-08-14-updater-worker-protocol.md`.
Prior reviews read first, so nothing here re-finds what is known:
`2026-08-16-updater-wave-{one,two,three}-review.md`, `…-updater-final-review.md`,
`…-updater-closing-review.md`.

This is the last read before the branch is proposed to `main`. I implemented nothing; this
document is the only file I wrote. The `updater-integration` lock was not taken and nothing
was merged.

---

## The environment, first, because four workers in this epic were lied to by a gate

This worktree had **zero `node_modules`**. Left alone, every green below would have been
describing `main`'s packages, not this branch's — the POD-746 hazard the protocol names.

I hardlink-copied the **main checkout's** tree after confirming the `bun.lock` blobs are the
identical git object (`b7e5677cf6d18847e8fdca722c8992d438cf1697` on both), 20 s, plus the
per-workspace `node_modules` for the eighteen workspaces that have one. I deliberately did
**not** copy `packages/{agent-bridge,core,domain}` — main carries stale directories for three
packages that no longer exist in git, and mirroring them re-creates the exact resolve-into-main
hazard the copy exists to prevent (`cp -al` refused them, which is the correct outcome).

Resolution then proven, not assumed:

```
readlink -f node_modules/@podium/{protocol,runtime,server}
  → …/issue-2232-merge-gate-review/packages/protocol
  → …/issue-2232-merge-gate-review/packages/runtime
  → …/issue-2232-merge-gate-review/apps/server
```

and, because a typecheck that finishes in under a second invites exactly this suspicion,
`tsgo --noEmit --listFiles` in `apps/server` names **1662 files, 1662 of them inside this
worktree and 0 in `/home/mgw/src/other/podium/apps`.** The gate is reading the branch.

### What I ran

| Check | Command | Result |
| --- | --- | --- |
| **web typecheck — a real green, forced** | `turbo run typecheck --filter=@podium/web --concurrency=1 --force` | **16/16, cache bypass, 51.3 s** — every task executed |
| **server + protocol typecheck, forced** | `… --filter=@podium/server --filter=@podium/protocol --concurrency=1 --force` | **11/11, cache bypass, 0 cached** |
| daemon typecheck | `… --filter=@podium/daemon --concurrency=1` | **9/9**, `@podium/daemon` and `@podium/pty` cache misses (executed) |
| daemon + protocol update suites | `vitest run --project node apps/daemon/src/{convergence,grant-apply,frame-guards,payload-rejection}.test.ts packages/protocol/src/update/` | **139 passed / 8 files** |
| server updates + operations + approvals + router | `vitest run --project node apps/server/src/modules/{updates,approvals}/ apps/server/src/router.updates.test.ts` | **434 passed / 14 files** |
| ledger + migrations + release scripts | `vitest run --project node packages/runtime/src/migration-ledger.test.ts apps/server/src/migrations/ scripts/release{,-manifest}.test.ts` | **152 passed, 1 failed / 20 files** — `branded-ref.test.ts`, attributed below |
| web updates | `(cd apps/web && vitest run src/features/updates)` | **120 passed / 7 files** |
| `lint:architecture` | `bun scripts/check-boundaries.ts --manifest-only` | **exit 1, eight violations** |

`PODIUM_TEST_WORKERS=1` throughout. `free -g` showed 3 GB available and `df -h` 13 GB free;
per the protocol's revised rule a scoped typecheck above 2.5 GB needs no lane and I took none.
No build, no `cargo`, no server, no browser.

**The one red is not this epic's, and I attributed it by ancestry rather than by subject.**
`apps/server/src/migrations/branded-ref.test.ts:90` refuses a raw `.references(` in the drizzle
schema files. The offending lines are `schema.ts:1243,1297,1342,1346,1385,1414` — the shipping
tables. `git blame` puts line 1243 on `7fb15bc57` *"Add durable shipping model"*, and
`git merge-base --is-ancestor 7fb15bc57 main` succeeds. It is main's, it is red on main, and
the epic's own addition to that file (the `operations` table, `52ac29a88`) uses no
`.references(`. Note also that my first reading of the exit code was wrong for a boring
reason — `bun … | tail; echo $?` reports `tail`'s status; the real code is 1.

### Three live probes, because reading is not measuring

1. **The ledger read works against a live WAL database held open by a running server.**
   `readAppliedMigrations('/home/mgw/.podium/podium.db')` → 73 migrations, no throw. This was
   worth checking: a read-only open that failed here would route every convergence on every
   machine into the `schema-unreadable` refusal, and the gate would fail closed for the whole
   fleet.
2. **The composition root is wired to the right database.** `readAppliedMigrations()` with
   *no argument* — the form `host-runtime.ts:394` actually calls — resolves to
   `/home/mgw/.podium/podium.db` and returns the same 73. The daemon's `stateDir()` and the
   server store's `join(stateDir(), 'podium.db')` (`apps/server/src/store.ts:89`) are the same
   function, and `instance-bootstrap.ts:29-31` puts the resolved instance id into the env
   before anything reads it, so a `--instance` daemon cannot end up reading the default
   instance's ledger. This is the check the composition root usually fails and here it passes.
3. **The gate's direction logic, exercised against that real ledger.** Results in D1 below.

---

# Confirmed defects

Most severe first.

## D1 — The panel tells the operator two things the daemon deliberately refused to claim, and gives one next action that no version can satisfy

**`apps/web/src/features/updates/update-view.ts:325-334`** (one arm matching all three tokens)
against **`apps/daemon/src/convergence.ts:188-196`** (the `schema-unknown` sentence) and
**`packages/protocol/src/update/version-order.ts:115-118`** (`isProvablyNewer` fails closed on
`dev+<sha>`).

`describeUpdateFailure` collapses `schema-advanced`, `schema-unknown` and `schema-unreadable`
into a single sentence:

```ts
if (normalized && /schema[-_\s](advanced|unknown|unreadable)/i.test(normalized)) {
  message: `${subject} was asked to move to an older version that cannot open the data it
            already has.`,
  guidance: 'Pick a version at least as new as the one it is on — …'
```

That sentence is exactly right for `schema-advanced`, where the daemon named the migration the
target lacks. It is **false in both halves** for `schema-unknown`, which means the precise
opposite: *nothing here can tell*. The daemon's own text is careful about this — *"it is not a
version this machine can prove is newer than the `dev+03a2892` it runs … nothing here can tell
whether that build would start against it"* — and the panel discards the care.

**Failure scenario, on the shape this branch newly made reachable.** A coordinator running
from a source checkout reports `dev+<sha>` and owns a database. Until `af30cacff` that machine
was offered nothing on `stable` at all (the read model asked the dev authority); that commit is
what makes the published stable release a real offer to it. The operator clicks Update.
`isProvablyNewer('0.1.3', 'dev+03a2892')` is `false` — not because 0.1.3 is older, but because
`dev+<sha>` has no ordering at all — so the gate refuses `schema-unknown`. Measured against the
real 73-row ledger on this box:

```
currentVersion 'dev+03a2892', target 0.1.5 undeclared →
  cannot converge: schema-unknown …
currentVersion '0.1.4',       target 0.1.5 undeclared → ALLOWED
currentVersion '0.1.4',       target 0.1.3 undeclared → cannot converge: schema-unknown …
```

So a machine on a source build refuses **every** currently-published release, including ones
that are in fact newer, and the operator is shown "an older version" and told to *"pick a
version at least as new as the one it is on."* There is no such version: nothing published is
orderable against `dev+<sha>`, so every choice produces the same refusal. §7 asks a failure to
name itself and carry one next action that works; this one names the wrong thing and its action
is unachievable on the population that hits it.

The refusal itself is correct and I would not change it — failing closed on an unprovable move
is the whole point. What is wrong is a hundred and ten characters of copy. The fix is to split
the arm: keep the current sentence for `schema-advanced`, and give `schema-unknown` /
`schema-unreadable` their own — *"could not prove that version can open the data this machine
already has, so nothing was changed"*, with guidance that names the real remedy (update this
machine's build first, or restore a backup by hand) rather than an ordering the machine cannot
perform. The three tokens already arrive distinguishable; only the regex merges them.

## D2 — Two of the sweep's three exemptions can be entered permanently, and the offline one re-opens the exact hole the commit was written to close

**`apps/server/src/modules/approvals/service.ts:329-355`** (`sweepStalledExecutions`) with
**`:338`** (`stop`), **`:340-344`** (offline), **`:99-102`** (`stalled`), and
**`apps/server/src/store/approvals.ts:60-66`** (`listPending` is `status = 'pending'` only).

The brief asked whether any exemption can be entered permanently. Two can.

**(a) `stop` — permanent by construction, and bounded only by a schema property nobody wrote
down.** `if (row.op.kind === 'stop') continue` runs before the row is even added to `live`, and
`approve()` never sets a clock for it (`:258`). A `stop` whose daemon does not in fact die —
the exec fails, the spawn is refused, the binary is missing — leaves the row `executing`
forever. It is invisible (`listPending` is pending-only), it never notifies again, and no
deadline exists. The commit's justification is sound *today* for the skew case specifically,
and I verified why: `ApprovalOp`'s `stop` arm is `z.object({ kind: z.literal('stop') })`
(`packages/protocol/src/messages/approvals.ts:42`) — it carries no field that a widening could
add a value to, so an old daemon cannot fail to parse it. That safety is a property of the
schema, asserted nowhere near the exemption. The first `stop` variant that gains a target
re-opens D1-of-the-closing-review for that op kind alone, silently.

**(b) The offline exemption has no ceiling at all.** `if (hasDaemon && !hasDaemon(machineId))
{ this.stallClock.delete(row.id); continue }` deletes the clock on **every** sweep that finds
the machine away. A machine that never comes back leaves its row `executing` for the lifetime
of the server, and a machine that flaps around the 60 s sample (down at each sample, up in
between) resets its clock indefinitely.

**Failure scenario.** An agent runs `podium channel dev` targeting a laptop. The operator
approves. The laptop is closed for the week. The row moves `pending → executing`, so it leaves
the popup at the moment of approval; `notify` fires only on a transition, so the mail fallback
never fires; the agent's CLI gives up at ten minutes printing *"the request is still live … you
will be told the outcome"*; and the sweep — the only thing that would say otherwise — deletes
that row's clock once a minute forever. This is bit-for-bit the closing review's D1, entered
through the offline door instead of the old-daemon door, on a fix whose stated purpose is that
"an approval a machine cannot read must not wait forever."

The reasoning that justifies it ("parked, not lost — it still runs on the next attach") is
about the *frame*, and it is a claim I could not verify: I did not read `machines.toMachine`'s
queue, so whether a parked frame survives a server restart is the commit's word, not my
measurement. If it does not, the row waits for a frame that will never be sent, and when the
machine finally attaches it is failed after seven minutes with text blaming that machine's
podium version for a message it never received.

What it needs is an absolute ceiling on `executing` independent of reachability — fail at, say,
24 hours with *"this machine has not been reachable since <t>"*, which is a true sentence and a
different one from the seven-minute text — or, more cheaply, showing `executing` rows in the
operator's list so the state is at least visible while it waits.

## D3 — A late result cannot correct a stalled row across a server restart, and is dropped without a log

**`apps/server/src/modules/approvals/service.ts:289-300`** with **`:102`** (`stalled` is an
in-memory `Set`) and **`apps/server/src/store/approvals.ts:82-92`** (`transition` is a
conditional `UPDATE … WHERE status = ?`).

The second half of the brief's question: *can a late result re-open a row that was already
failed and reported?* **Within one process, yes, and it works.** `stalled.delete(id)` selects
`from = 'failed'`, the transition succeeds, the notify is prefixed *"reported LATE, after the
server had given up"*, and the log carries `late: true`. That is a good mechanism.

**Across a restart it cannot, and it fails silently.** `stalled` is deliberately in-memory (the
docblock argues the case for `stallClock`, and it is a good argument there — re-seeding costs
one extra deadline of patience in the conservative direction). But `stalled` is not a clock, it
is a *record of what this server already told a human*, and losing it is not conservative.
After a restart, a late `approvalExecResult` for a stalled row computes `from = 'executing'`,
`transition(id, 'executing', …)` matches no row because the status is `failed`, and
`onExecResult` **returns with no log, no notify and no counter**. The operator keeps *"no
result from <machine> after 7 minutes … The operation may or may not have run"* for an
operation that reported success, and nothing anywhere records that the correction arrived and
was discarded.

`this.stalled` is also never pruned. It is added at `:370` and removed only at `:293`, so a row
that stalls and is never answered — which is the ordinary case, since the sweep exists for rows
nobody will answer — leaves one string in the set for the lifetime of the process. Trivial in
bytes; worth fixing in the same edit as the above.

The repair is small: derive `from` from the row that was already read (`row.status`) rather
than from process memory, and log the drop when the transition refuses.

## D4 — `fd0124de2` claims set-identity with `main` that the branch does not have

**`fd0124de2`'s message** against a measurement here:
*"That takes the branch back to eight: exactly main's count, and **every violation left is one
main already had**."*

The first clause is true and I reproduced it: `bun scripts/check-boundaries.ts --manifest-only`
exits 1 with **eight** violations, and the `feature-single-home` rename of
`DEFAULT_HISTORY_LIMIT → DEFAULT_OPERATION_HISTORY_LIMIT` is a genuine fix of a genuine
addition.

The second clause is false, by one:

```
git grep -c localStorage main -- apps/web/src/features/updates/use-update-state.ts  → (none)
git grep -c localStorage HEAD -- apps/web/src/features/updates/use-update-state.ts  → 4
git grep -c localStorage main -- apps/web/src/features/git/DiffSheet.tsx            → 2
```

`ui-storage-ownership` on `use-update-state.ts` is in the eight and is **not** one main already
had. The count matches because the epic removed one violation main does have (POD-2206's
`manifest-platform` fix) while adding one main does not. Count-identity is a ratchet argument;
set-identity is what the sentence asserts, and a future reader auditing this lane against that
sentence will look for the epic's line, not find it named, and conclude it is inherited.

This matters only because of what the protocol's own opening section says about this lane: it
named the POD-2206 settings crash *by filename* and nobody heard it, because it was red for
four unrelated reasons. The epic is leaving it red for eight, one of which is its own. The rest
of `fd0124de2` is right and is the most valuable thing in it: the measurement that
`ui-storage-ownership` is **emitted into the manifest family but is not a `MANIFEST_RULE`**, so
`partitionAllowlist` routes an entry for it to the legacy half only and the entry excuses
nothing — which is precisely the trap the protocol warns a reviewer's advice would have created.
The fix is one sentence in a commit message that has already landed; carry the correction into
the epic's own record rather than the git history.

## D5 — The origin guard's docblock claims completeness for address literals that it does not have

**`packages/runtime/src/config.ts:640-646`** (the claim) against **`:672-681`**
(`isLocalIpv6`), measured.

The docblock says the guard is *"complete for address LITERALS — every way of writing loopback
or the unspecified address is caught, IPv4-mapped IPv6 included"*. Probed against the real
function:

```
REFUSE http://[::ffff:127.0.0.1]:18787  → host [::ffff:7f00:1]
REFUSE http://2130706433:18787          → host 127.0.0.1
REFUSE http://0x7f000001:18787          → host 127.0.0.1
REFUSE http://127.1:18787               → host 127.0.0.1
REFUSE http://0:18787                   → host 0.0.0.0
ACCEPT http://[::127.0.0.1]:18787       → host [::7f00:1]      ←
ACCEPT http://127.example.test:18787    → host 127.example.test  (correct — the fix)
```

The IPv4-**compatible** IPv6 form (`::a.b.c.d`, RFC 4291 §2.5.5.1, deprecated) normalises to
`[::7f00:1]`, does not match the `^::ffff:…` regex, and is accepted. The practical consequence
is near zero — an operator would have to type a deprecated address form by hand — and the rest
of this commit is excellent work: it fixes a real false negative (every mapped and integer form
of loopback), a real false positive (`127.example.test`), and it corrects a message that
promised reachability it never tested, with the `/etc/hosts` 127.0.1.1 measurement to explain
why a resolver would make it worse. The defect is that the docblock is now the thing a future
reader ratchets against, and it overclaims. Either extend `isLocalIpv6` by one branch
(`/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/` with the same `>> 8 === 0x7f` test) or narrow the
sentence to name the family it does not cover.

---

# The four questions, answered directly

## (1) Is the downgrade gate's direction logic sound for every path that reaches it?

**Yes for the argument as stated, with one enforcement gap and one path where it is bypassed by
design.** Taking the paths one at a time.

**The formal argument.** *The server running now opened this database, so what it has applied
is within what the current build defines; releases are expand-only, so a newer build defines at
least what the current one does; therefore a newer build defines everything applied.* Both
links are load-bearing and only one of them is instrumented.

**Link 1 holds and I verified the mechanism.** `runDrizzleMigrations`
(`apps/server/src/migrations/index.ts:180-188`) **throws before touching the schema** when the
ledger holds a name the build does not define, aliases included. So a running server really is
proof that its build defines every applied migration. The gate's `currentVersion` is the
*daemon's* `build.appVersion`, not the server's, which is the seam where this could break — but
it breaks only if the daemon is **older** than the server, and I could not construct that. The
installed all-in-one resolves into separate units off one install dir, so a swap moves the
daemon ahead of the server, never behind (superset direction, still safe); the server's own
`source-redeploy` path exists only on source installs, where the version is `dev+<sha>` and the
gate fails closed on everything undeclared anyway.

**Link 2 — expand-only — is a policy with no instrument.** `scripts/release.ts`'s
`readDefinedMigrations` makes every future release *declare* its set, but nothing compares that
set to the previous release's. If a release ever drops a migration folder (a revert of a bad
migration is the realistic way), a machine on the prior release is offered a "newer" undeclared
target that lacks something its database applied, the gate says yes, and the server does not
come back. **The exposure is bounded and shrinking**, which is why this is a suggestion (S3)
and not a defect: the undeclared branch is reachable *only* for targets published before this
check existed, because `readDefinedMigrations` **throws** rather than publishing silence. Every
declared target runs the set comparison at `convergence.ts:199-201` in **both** directions, so
an expand-only violation is caught on the forward path too once both sides declare.

**A database migrated by a build outside its own lineage.** Handled, and handled by the
declared path rather than by the direction argument. A machine that ran a feature-branch build
carrying migration `M_feat` and then converges to a declared target that lacks it is refused
`schema-advanced` regardless of direction, because `missing` is computed from the set and never
from the ordering. The only way it slips through is via the undeclared-forward branch, which
requires the *cross-lineage* build to have carried a semver-orderable label and the target to
be a pre-check release — the same shrinking window as above. The alias map is handled
symmetrically (`canonicalMigrationName` is applied to both `applied` and `targetDefines`,
`convergence.ts:199-200`) and lives in exactly one place, shared by the server's downgrade guard
and the daemon's gate, which is the right call — two copies of "which entries are the same
migration" is how those two decisions stop agreeing.

**`dev+<sha>` on either side.** Fails closed, correctly and deliberately: `parseVersion` returns
`null` for anything that is not a semver, `isProvablyNewer` is `false` for both "older" and
"unorderable", and the callers are documented to treat them alike. The docblock's mitigation —
*"that costs a dev checkout nothing, because the development publisher declares its schema from
the commit it advertises"* — is true for **dev** targets and not for a source-build machine
offered a **stable** release, which is D1 above. `migrationsAtRevision` reading
`git ls-tree <sha>:apps/server/src/migrations/drizzle` rather than the running build's compiled
list is the right choice and the commit's stated reason for it (a checkout moving backwards is
the one case where the two differ, and the difference is the bug) is correct.

**The fresh-install skip, and the twice-observed unasked downgrade.** `applied === undefined ||
applied.length === 0 → allow` (`convergence.ts:173`) is right for the database: a machine with
no database has nothing a downgrade could strand, and it is what keeps automatic rollback for
every remote worker. **But it is not, and cannot be, an answer to the observed incident, and the
branch leaves that incident exactly where it found it.** `planConvergence`
(`packages/protocol/src/update/convergence.ts:26-73`) is entirely direction-blind — its only
outcomes are `already-current`, `converge` and `cannot`, and nothing in the protocol, the
reconciler or the fleet row distinguishes a downgrade from an upgrade. So a freshly paired
machine with no database that is dragged to a channel target older than the build it shipped
with converges through the ordinary path, reports the ordinary states, and nobody is told the
direction. **My judgement: the skip does not *cause* a silent downgrade, but it does not
prevent one either, and after this branch a silent downgrade is the only kind of downgrade a
no-database machine can experience.** That is the honest reading, and the incident stays
unexplained — the explanation lives in whatever gave a fresh machine a stale target, not here.
`docs/data-and-upgrades.md` is straight about the limitation (*"Machines that hold no database
— every remote worker — are never gated at all"*), which is why this is written here rather
than as a defect. If it recurs after merge, the thing to instrument is `planConvergence`, not
the gate.

**One TOCTOU, small.** `refuse()` is evaluated once at `grant-apply.ts:144`, before a network
fetch that can take minutes, and never re-asked before `swap()` at `:170`. A database created
or migrated inside that window is invisible to the decision. Narrow — migrations run only at
boot — but the re-check costs one ledger read (S1).

## (2) The approvals sweep's seven-minute deadline and its three exemptions

The deadline itself is well built and I have no complaint about the number: it is bounded above
the daemon's own 300 s executor ceiling and below the CLI's 600 s wait, both bounds are argued
at the constant, and the sweep is genuinely wired (`relay.ts:2328-2334`, `unref`'d, cleared on
dispose) rather than left as advice in a docblock — which is the failure mode I checked for
first. `listExecuting` is a bounded, human-paced query. `keepCanaryProof`-style purity is
preserved: the sweep only ever moves `executing → failed`, and `failStalled`'s text is careful
to claim only what is known (*"The operation may or may not have run"*), which is the right
sentence.

Permanence: **`stop` yes, offline yes, first-sight no** — D2. The third exemption (a row seen
for the first time starts its clock rather than being failed on sight) is genuinely bounded: it
costs one extra deadline and only on a restart or on rows already stuck when this shipped.

Late results re-opening a failed row: **yes within a process, no across a restart, and the
across-a-restart case is silent** — D3.

## (3) Can two operations, or an operation and a reconciler sweep, disagree about the version being delivered?

**No, and the reasons are structural rather than incidental.**

*Two operations:* `exclusiveOperationVersion` is
`exclusiveUpdateVersion(operations?.engine.active(LIFECYCLE_EXCLUSION_GROUP), channel)`
(`relay.ts:515-516`) — `active()` is asked **with** the exclusion group, so single-flight
guarantees at most one operation can answer. This is worth calling out because the final
review's carried S-list includes an `engine.active()` called with *no* group elsewhere; this
new call site does not repeat it.

*An operation and a foreign kind sharing the group:* `exclusiveUpdateVersion`
(`operation.ts:281-307`) returns `undefined` for a row whose `kind` is not the update kind, or
whose `details` this binary cannot parse, or whose `details.channel` is a different channel —
and the caller then falls back to the memory test, which is the pre-existing behaviour. A
future server-move operation sharing `LIFECYCLE_EXCLUSION_GROUP` degrades rather than lies.
Putting the derivation in `operation.ts` next to the details it reads, rather than a second copy
at the composition root, is the correct call and is exactly the class of mistake this epic kept
making (a harness and production reading the same thing two ways).

*An operation and the reconciler:* they cannot act concurrently at all — `decideReconciliation`
returns `operation-active` while an exclusive lifecycle operation holds the group
(`reconciler.ts:33-42`), and the reconciler resumes on the operation's terminal transition. They
do read different sources (`isSameUpdate` consults the operation's `details.target`, the
reconciler consults `targets.get(channel)`), but never at the same time.

The one residual, which is a blank rather than a disagreement and which I did not drive: between
a restart and the first publication, the successor's `targets` map is empty while an adopted
operation is delivering version V. During that window `target(channel)` is `undefined`, so the
fleet read model shows a null target version. `tick()` returns nothing and the reconciler is
paused, so nothing acts on the blank — it is a display gap of one publication cycle.

## (4) Can `keepCanaryProof` ever be passed on a path that should re-earn the soak?

**Not today, but it is one deleted line in a different file away from being able to, and the
dependency is unstated and untested.**

`keepCanaryProof: true` is passed at exactly one site,
`UpdatesService.authorizeMachine` (`service.ts:674`). `authorizeMachine` has **two** callers:

- `apps/server/src/modules/fleet/handlers.ts:104` — the human clicking Apply on one row. This
  is the case the parameter was written for, and the argument for it is right: the canary proof
  is about the **bundle**, a human applying one row has un-proved nothing, and clearing the flag
  there charges every other machine a soak it has already paid. I also confirmed the parameter
  can only ever *omit* the clear, never set the flag (`if (!options.keepCanaryProof)
  rollout.canaryHealthy = false`, `service.ts:582`), which is what its docblock promises.
- **`apps/server/src/modules/updates/reconciler.ts:449` — a background sweep with nobody
  watching.** This is the path that should re-earn the soak, and it reaches the parameter.

It is safe today, and the reason is in a third file: `decideReconciliation` refuses a machine
in a terminal state **before** calling `authorizeMachine` (`reconciler.ts:162-165`, the "loop
guard"). So when the reconciler does call it, `clearMachineVerdicts`'s filter on
`TERMINAL_STATES` matches nothing, `cleared.length === 0`, and it returns at `service.ts:579`
having touched neither `halted` nor `canaryHealthy`. `keepCanaryProof` is a **no-op** on that
path — by accident of a guard three call frames away, not by anything in
`clearMachineVerdicts`.

That is a thin thread, and the closing review itself pulled on it: it named "a machine that
refuses and then goes offline is never reached by Try again" as the one case retry does not
cover. The obvious repair — let the reconciler consider a terminal machine once the target
changes — is exactly the edit that turns this no-op into a live automatic canary-preserving
retry. Nothing states the dependency and no test asserts it (S2).

---

# Suggestions

**S1 — the schema gate is asked once, before a fetch that can take minutes.**
`grant-apply.ts:144` evaluates `refuse(target)`; `:170` swaps. A ledger read is microseconds;
re-asking immediately before `swap` would close the window at no cost and would make the gate's
guarantee ("can the build we are about to swap in open THIS database?") true at the moment of
the swap rather than at the moment of the decision.

**S2 — pin the reconciler's no-op.** Either assert it (`reconciler.test.ts`: a reconciled
machine leaves `canaryHealthy` untouched *because nothing was cleared*, not because the flag was
kept) or move the terminal check into `authorizeMachine` so the guard travels with the method
that needs it. One sentence in `clearMachineVerdicts`'s docblock naming `decideReconciliation`
as the reason the automatic caller is harmless would be the cheapest version.

**S3 — expand-only has no gate.** `scripts/release.ts:readDefinedMigrations` now declares the
set; nothing compares it to the previous release's manifest. A five-line check in the release
job (fetch the previous manifest for this channel, assert the new set is a superset, refuse
otherwise) would turn the direction argument's second link from a policy into an instrument —
and would fail loudly at publish time, which is the only moment anyone can still do something
about it.

**S4 — the release publisher reads the working tree, the dev publisher reads the commit.**
`readDefinedMigrations(MIGRATIONS_DIR)` is a `readdirSync` on a **relative** path, so it
declares whatever tree the release job happens to be standing in.
`migrationsAtRevision` is `git ls-tree <sha>:…`, which declares the commit being advertised.
The commit message describes both as "the tree being released"; only one of them is. It throws
on an empty directory, so the failure mode is loud rather than silent, but the two publishers
should answer the same question the same way.

**S5 — `exclusiveOperationActive` is channel-agnostic while `exclusiveOperationVersion` is
channel-scoped.** A running `stable` operation therefore parks a `dev` publication in
`nextTarget` even though the two cannot collide. Pre-existing, and slightly more visible now
that `de389ccc2` made the operation's channel the host's own rather than a literal `'dev'`.

**S6 — say where `stop`'s exemption gets its safety.** The sweep exempts `stop` on the argument
that its daemon kills itself; the reason a *skew* cannot make that argument false is that
`ApprovalOp`'s `stop` arm carries no fields (`approvals.ts:42`). One comment there — "adding a
field to this arm re-opens the stall exemption in `sweepStalledExecutions`" — costs nothing and
is the kind of tripwire this codebase already writes well.

**S7 — carried, unchanged at this tip.** The closing review's S1 (a quarantined approval is
invisible *and* uncounted), S2 (`quarantined` counts drop events on a snapshot frame that
re-fires on attach), S3 (the eager-engine guard is six basenames), S5 (POD-1127's membership
test 2 reads as a false present-tense fact), S6 (per-place verdict clearing protected only by
statement order), S7 (`update-not-installed` has no `nextAction` of its own), S8 and S9. None
of the five reviewed commits touches any of them. D2 of the closing review — the sequencing
cost of shipping the quarantine alongside the value that needs it — is now written down, in
spec §19.2f and in `docs/reviews/2026-08-17-p8-shipment-decision.md`, which is what it asked
for.

---

# What a reader should NOT believe is proven

- **I built nothing, ran no server and drove no browser.** No `vite build`, so
  `web-bundle-budget.ts` was not re-run in either capacity; no `cargo`, so no Rust was
  compiled; no macOS, no signed desktop release. Everything here about UI behaviour is read off
  the view functions and their tests, and everything about the desktop path rests on other
  people's records.
- **D2 and D3 are traced and reasoned, not driven.** I did not stand up an old daemon, did not
  restart a server mid-approval, and did not park a machine offline across a sweep. What I have
  is the code path, the wiring, and the store query.
- **I did not read `machines.toMachine`'s queue.** "A parked frame is queued rather than lost so
  its clock resets" is the commit's claim and the load-bearing premise of the offline exemption;
  whether the queue survives a server restart is unmeasured here.
- **The broad test lane was not A/B'd against the fork point.** I ran focused suites only. The
  single red I hit I attributed by `git blame` + `merge-base --is-ancestor` rather than by
  running the same test at the base, which is stronger than the subject-matter inference the
  closing review had to use for its three, but it is one test and not the lane.
- **`lint:architecture` is red and stays red**: exit 1, eight violations, one of them this
  epic's (D4). A green there is not available at merge and should not be claimed.
- **The direction argument's link 2 is unenforced** and I did not attempt to violate it. I
  reasoned it through; nothing in the repo would stop a release that drops a migration folder.
- **The version-ordering move from `apps/cli` into `packages/protocol` lost no coverage, and I
  checked rather than assumed**: `packages/protocol/src/update/version-order.test.ts` exists and
  passes, `apps/cli/src/podium-update.ts:76` re-exports `compareVersions`, and
  `apps/cli/src/podium-update.test.ts:65` still exercises it through that re-export. Both suites
  are in the 139 above.

---

# Verdict — would I merge this to main today?

**Yes, merge it.** None of the five findings is a wedge, none is a data-loss path, and the two
that matter most are the kind that get worse the longer the branch sits unmerged rather than
better: the seven-minute deadline exists specifically because on merge day every daemon in the
fleet is one that drops the widened frame, and the schema gate exists because without it a
downgrade bricks an install in four seconds with nothing inside Podium able to fix it. Holding
the branch to fix copy would keep both of those unshipped. The one thing I would spend twenty
minutes on before proposing it is **D1**, because it is a hundred characters of user-facing text
on a path this branch itself newly opened, it tells the operator two things that are not known
to be true, and its one next action is impossible on the machine shape most likely to hit it —
the coordinator running from source. **D4 is a two-line correction to the epic's own record**
and should be carried before the history hardens, because a future auditor of that lint lane
will otherwise trust a sentence that is false by exactly the entry they are looking for. D2, D3
and D5 are all real and none is urgent; file them, fix them next.

**After merge, watch three things.** First, **approval rows stuck in `executing`** — query
`SELECT count(*) FROM approval_requests WHERE status = 'executing'` on the live instance for a
week; the seven-minute deadline should drive it to near zero, and any row older than a few hours
is D2's offline door, which is where I would expect the first real report. Second, **the first
`schema-unknown` refusal a human sees** — the daemon's own sentence is correct, so compare it
against what the panel said; that comparison is D1 in one screenshot and will also tell you
whether any machine is now refusing releases it should be taking. Third, **whether a machine
converges backwards without anyone asking** — the twice-observed incident is untouched by this
branch and the population that can still experience it (no database, so no gate) is every remote
worker; if it happens again, the instrument to add is direction-awareness in `planConvergence`,
not another arm on the gate.
