# Rearchitecture v3 — Migration Ledger

**The single living record of the architecture rewrite (POD-279).** This document carries
the execution machinery: the adopted decisions, per-phase status, the conventions every
executing agent is bound by, and the registries (hot files, human gates, scar tissue).
It is updated continuously — each phase updates its section as work lands, and closes it
at phase exit. Prose here never closes a gate; the tracker does (see EXIT GATES).

Epic: POD-279 (Architecture rewrite v3: land the first-principles redesign COMPLETELY).
Plan source: the 2026-07-10 first-principles proposal, revised by the two 2026-07-13
adversarial review rounds (disposition reports live as comments on POD-279).

---

## 1. The five moves and adopted decisions

The rewrite lands five moves, end to end, with no intermediate state left behind:

1. **ONE SEMANTIC VOCABULARY** — every field/concept authoritatively defined once in
   `packages/model` (L0); canonical durable aggregate + live state + storage
   representation + wire/read projections COMPOSED from shared field schemas.
   NOT one universal record; legitimate narrow ports remain as named derived projections.
2. **ONE SYNC KERNEL** — Authority (arbitrates truth per the ownership-matrix ADR) /
   Replica (applies ordered revisions + optimistic overlay; **never** arbitrates) /
   Outbox (durable command delivery with the full lifecycle incl. dead-letter recovery).
   One implementation, pluggable ports, one cross-hop conformance suite.
3. **COMMAND CONTRACTS EVERYWHERE** — L1 contracts (versioned schemas, policy,
   default-closed transport exposure, offline class, redaction, optimistic reducers)
   joined to L3 feature handlers at composition roots; principal from authenticated
   transport only; apply-time re-auth for offline commands; secrets never replicated
   or queued.
4. **PLANES AS PROTOCOL CONTRACTS** — control/stream/bulk classify messages and set
   port semantics (inventory decided in ADR 7); application code stays VERTICAL by feature.
5. **VARIANCE AT THE EDGE** — behavioral branching on harness identity confined to
   harness adapters; one SessionBinding lifecycle owning session-identity aliases
   with history.

### Adopted decisions (binding)

- **Route A** — the full first-principles redesign, not incremental patching; phases
  ordered so guardrails and contracts land before extraction.
- **ADR gate POD-359 runs BEFORE Phase 1.** The 8-ADR pack (ownership matrix, sync
  protocol, command security/lifecycle, representation policy, peer topology, replica
  storage, plane/message inventory, package topology) is committed to `docs/adr/` and
  human-signed-off before the model phase consumes its decisions.
- **Version negotiation is a PERMANENT mechanism; the concrete legacy adapter EXPIRES.**
  The wire ships a permanent negotiation mechanism; the N/N-1 legacy adapter (POD-308)
  is a deletion-audit item with a deadline — expired and deleted by Phase 7 at the
  latest (POD-294/POD-337 track the expiry). The internal snapshot pipeline dies in
  Phase 2 regardless.
- **Two processes, one peer protocol** — server and daemon speak the same peer framing;
  role-specific auth strategy modules, not a conditional god machine (ADR 5, POD-317,
  POD-327 mirrors the gateway contract from the daemon side).
- **Transactional replica storage** — IndexedDB on web (OPFS only if the pre-ADR spike
  proves a threshold need), SQLite on mobile; localStorage/AsyncStorage only for small
  preferences/degraded fallback; crash/power-loss/quota semantics tested at every
  entity/cursor/outbox boundary (ADR 6, POD-307).
- **Best-available state channel per provider** — hooks where supported,
  provider-specific polling otherwise, classifier as lowest-confidence fallback inside
  the claude manifest; every signal carries source + confidence, reducer prefers higher
  confidence (POD-326).
- **HarnessId / BuiltinHarnessKind dual form** — closed enum in-repo (compile-time
  totality), open branded string + serialized capability descriptor on the wire, with
  incremental-completeness manifests, so unknown kinds degrade gracefully without
  lockstep redeploys (POD-303, POD-325).
- **MULTI-USER WITHIN ONE TENANT** (user decisions 2026-07-28/29; full record and rationale in
  `docs/multi-user-readiness.md`; encoded as ADR 9 + amendments to ADRs 1/2/3/4/7 under POD-359).
  Podium gains users, ownership and sharing, with realtime collaboration kept open as a path.
  The binding parts, because each overturns a decision the pack justified by single-operator use:
  1. **Private by default, and the visibility machinery is built in Phase 2** — ADR 2 D2's unscoped
     feed is overturned. Per-principal filtering REQUIRES watermarks (a suppressed row is otherwise
     an invisible permanent gap that heal-loops forever) plus a rescope/evict event, because a
     grant or revoke changes visibility WITHOUT the entity's revision moving. Load-bearing from day
     one, so its conformance cases are a Phase-2 gate condition, not a follow-up. **All of it lands
     before POD-308's wire cutover** — POD-1077 blocks POD-308, and that edge is not advisory.
  2. **Agents are principals delegated from a human** — rights are the agent's scope intersected
     with its human's CURRENT rights, resolved live at every apply, never a snapshot; the human is a
     ceiling while the default grant stays narrower (its issue subtree); attribution is the pair
     actor + on-behalf-of; agent output is owned by the delegating human; the delegation lifecycle
     IS SessionBinding (POD-323). Sub-agents chain, never widening.
  3. **Machines are owned compute** — `see` / `use` / `manage` are separate grants, `use` is a
     code-execution boundary rather than a privacy one, a newly paired machine is private to its
     pairer, and the all-in-one host is not ambient team compute.
  4. **The superagent is per-user; system jobs are not delegated** — system principals may read
     across owners but write only as `system`, never as a person.
  5. **Not multi-tenancy.** ADR 1 D5 (InstanceId is a deployment partition) is UNAFFECTED —
     multi-user lives INSIDE one instance. Do not add `instance_id` columns.
  Deliberately open, per feature: which existence facts leak; whether a cross-boundary graph edge is
  hidden or shown opaquely; that `reparent` is now permission-affecting; per-class owner/grant
  inheritance on create.
- **HUB DEFERRED** per spec [spec:SP-0371] (user decision, confirmed 2026-07-13).
  In scope: local topology (clients + one server + N paired machine daemons) plus the
  preserved federation SEAM (feed identity, origin/causation, reserved peer-capability
  fields, kernel ports free of same-machine assumptions, parameterized conformance
  suite). Out of scope: any federated product behavior — parked in POD-353.
  UpstreamSync/UpstreamForwarder are retired during the rewrite (POD-309).

---

## Runtime work placement [spec:SP-c29e]

The loop split is classified by the facts a job needs and the authority it exercises. A timer
is only a trigger; it does not decide placement. This matrix is the durable rule for current
code and for the v3 migration:

| Placement | Owns | Must not own |
|---|---|---|
| Interactive server loop | Sockets and WebSocket fan-out, tRPC, ordered command application, authorization, live runtime state, protocol/liveness timers, bounded actor state machines | Durable calendar polling or CPU-heavy pure transforms |
| Bun workers | CPU-heavy pure transforms such as projection preparation, encoding, and parsing; inputs and outputs are versioned values | SQLite, the ledger, the write funnel, authorization decisions, or live runtime ownership |
| Janitor systemd sibling | Durable calendar/event polling and housekeeping decisions: message expiry, steward work, automation cron, retention, auto-archive, and automatic connect-scan orchestration | Live presence/in-flight truth, direct durable mutation, or deep interactive connect scans |
| Server command/write seam | Apply-time revalidation, authorization, transaction/write-funnel execution, ledger ordering, and fan-out | Trusting a janitor observation as current truth |

The janitor may read WAL SQLite only for durable candidate facts. Every mutation returns over
the narrow authenticated maintenance transport with a deterministic run key, observed durable
preconditions, and a lease fencing token. The server re-reads the facts at apply time and
returns `applied`, `already-applied`, or `stale`. Compatibility negotiation prevents an old
janitor from acquiring or renewing a lease after an incompatible protocol/schema change.

POD-845's first review cut moves message expiry and establishes the shared fenced surface and
real sibling lifecycle. POD-925 Batch 1 moves event-log retention, ledger change-log cadence
prune, issue auto-archive, and maintenance_commands retention onto that surface (server timers
and ledger append-cadence prune retired after parity tests). POD-925 Batch 2 moves steward
poll (cursor advances only after durable deliveries), automations cron (occurrence id reserved
before side effects and reused as mutation id), and automatic connect-scan orchestration
(deep scans stay interactive; server rechecks connectivity at apply). Until each cut lands,
its existing owner remains authoritative rather than running two writers.

---

## 2. The migration oracle

The oracle is the behavioral contract every phase must preserve. It is defined over the
**test-lane doctrine** — `docs/agents/testing.md` (authoritative lane map) and specs
[spec:SP-0be7] + [spec:SP-3f93] — NOT a single full-suite command. `bun run test` is
deliberately the fast retry-0 unit lane only; "oracle green" means the relevant lanes
green: **unit / integration / e2e / multi-instance** (agent-smoke is explicit-only).
Per-phase "oracle status" lines below reference lane results. Locking the baseline is
POD-295; the CI wiring is verified at gate POD-422.

Build orchestration is part of the oracle environment: typecheck runs under tsgo
(POD-706, [spec:SP-3b58]), with turbo task orchestration once POD-715 lands — gate
evidence must cite the orchestrator actually in CI at the time.

### 2.1 Running it: one command (POD-295)

`bun run oracle` (`scripts/oracle.ts`) runs the whole lane set in one step and prints a
per-lane verdict. It runs lanes **sequentially** (the heavy lanes bind fixed ports —
relay.e2e 9921, multi-machine 9922 — so two at once on one machine collide) and it
**does not stop at the first red**, because one red lane must never mask another's
status. Lane membership lives in `ORACLE_LANES` there; `scripts/test-configuration.test.ts`
pins it against the CI matrix and the package.json scripts, so a lane cannot silently
fall out of CI. Typecheck and unit have their own CI jobs; the `oracle` matrix job runs
the three heavy lanes.

### 2.2 Where the oracle blocks (POD-295)

AC-as-written said "a red oracle blocks merge on every PR to main". **That does not map
onto this repo**, and taking it literally would break landing: work lands by local
`git merge --ff-only` under the merge lock, and main is pushed to origin in batches
(39 commits behind at the time of writing; the only open PRs are dependabot's). GitHub
required-status-checks would reject that batched push. So the oracle blocks in two
places, neither of them server-side:

1. **Local land gate (the real gate).** Acquiring the merge lock for main requires a
   green `bun run oracle` on the candidate sha, with the evidence pasted into the issue.
   Advisory — exactly like the merge lock itself, which nothing enforces either.
2. **CI backstop (detection, not prevention).** The `oracle` matrix job runs on
   `pull_request` and on `push` to main, never `continue-on-error`, one lane per leg.
   It catches what slipped past the convention; on the batched-push model it reports
   after the fact.

Deliberately NOT used: branch protection and git hooks (POD-279 coordinator decision,
2026-07-16). The CI job must never be made `continue-on-error` — see POD-744, where
biome + boundaries bundled under one `continue-on-error` made an architectural guardrail
decorative for weeks: it exited 1 on every branch and CI reported green. **A gate whose
red is swallowed is worse than no gate — it launders the failure.**

### 2.3 Quarantine register (POD-295)

AC3: every skip/quarantine carries a linked issue and a reason recorded here — this table
is the single record. Reds are tracked as fixes, not skips; a quarantine is a last resort,
never a silent skip. **POD-295 added no quarantines**; the one entry below is pre-existing
and was found by the sweep, already skipped and already invisible.

| Test | Lane | Issue | Reason |
| --- | --- | --- | --- |
| `router.test.ts:369` `discovery.refreshRepos enriches registered roots in place` | unit | POD-759 | The expectation predates registered-root enrichment: discovery now returns the registered root itself as a repository entry even when the daemon scan is empty. Skipped rather than fixed so CI would not silently bless the new shape without review — **that review never happened**. Its original link (`podium #32`) is closed AND was never about this test, so the skip deferred to nothing. POD-759 replaces it. |

Everything else that does not run is **conditional-by-environment, not a quarantine**, and
needs no entry: the `PODIUM_REAL_CLI` gate on the agent-smoke suites ([spec:SP-0be7] — never
implicit, bills real quota), abduco/tmux availability guards, and platform guards. Verified
by sweep: `router.test.ts:369` is the only unconditional `.skip` in the repo.

### 2.4 Baseline — commit c577009d, 2026-07-16 (POD-295)

Measured with `bun run oracle` on the branch at local main tip. **The baseline is RED —
it is recorded as measured, not as hoped.** Both failures are deterministic (they
reproduce every run, identically); there are **zero flakes** and zero quarantines.

| Lane | Result | Detail |
| --- | --- | --- |
| typecheck | **GREEN** | 21 turbo tasks incl. `@podium/telemetry-relay` |
| unit | **RED** | 1 file / 2 tests — `relay-agent-relay.test.ts` → POD-743 |
| integration | **RED** | 1 file / 3 tests — `managed-account-spawn.integration.test.ts` → POD-746 |
| e2e | **GREEN** | 7 files / 21 tests |
| multi-instance | **RED** | same file and cause as integration → POD-746 |

Re-measured on `issue/295` with the POD-743 fix applied: **unit GREEN** — 342 files /
4078 tests passed, 3 files / 15 tests skipped (all accounted for in §2.3), plus apps/web
127 files. So the unit lane's red is closed; POD-757's flake did not surface in that run,
which is precisely the problem with a ~40% flake — one green run proves nothing.

The oracle is therefore **not yet locked green**. Gate POD-422 reads this section, so
state it plainly: **the green-baseline AC stays open on POD-746 and POD-757** (POD-743 is
fixed, below). Every red was root-caused rather than quarantined. §2's flake doctrine
governs the dispositions here — a flaky lane is not an oracle, and a flake's FIX belongs
to the owner of the code under test while POD-295 inherits only the CONSEQUENCE:

- **POD-743** (unit) — **FIXED by POD-295**, no product change, no quarantine. §2 already
  records why the assertion was wrong (a proxy satisfiable by the delegation prose alone,
  in both directions). The fix keys on the thing itself: the marker derives from
  `sessionTitleRule()`, the doctrine's single copy, already reused at relay.ts:1190 —
  [spec:SP-0be7]'s "behavioral assertions over UI copy-string pins". Mutation-tested:
  deleting the product's already-named guard (relay.ts:1176) turns the file red on exactly
  `says nothing about titles once the session HAS a name`; the old assertion could not have
  caught that at the positive site. The unit lane's red is closed outright.
- **POD-746** (integration + multi-instance) — **not POD-295's to fix**; dedicated
  implementor assigned. Recorded because the error message misdirects, which is §2's proxy
  rule showing up in an error string: it says "the drizzle migrator requires the bun:sqlite
  runtime", but the runtime is fine (`isBunRuntime()=true`, bun:sqlite present, the db IS
  bun-backed). `bunSqliteClient()` is a module-scoped **WeakMap lookup**, and
  `@podium/runtime/sqlite` is loaded twice across resolution roots, so the migrator holds a
  different WeakMap than the one the db was registered in. Proven by differential: for one
  db object, the test-side lookup FINDS it while the server-side returns undefined.

- **POD-757** (unit) — the one true flake, and the reason this baseline is not lockable
  even with POD-743 fixed. Owned by `@podium/transcript` per §2's ownership split, with its
  own implementor and branch; POD-295 carries only the consequence. NOT quarantined: that
  trades a visible flake for invisible lost coverage on a bug being actively fixed.
  **Data point for its owner: tailer did NOT flake in POD-295's full-lane run.** That is
  the ~40% being ~40%, not evidence of a fix — one green run must not close it.

Two lanes report one bug: `managed-account-spawn.integration.test.ts` runs in both
integration (via the `*.integration.test.ts` glob) and multi-instance (named explicitly in
the script). Worth deciding whether that overlap is intended — the lane map treats the
lanes as distinct sets.

Known gap at baseline (POD-756): the oracle covers **no browser tests**. 54 Playwright
suites under `tests/e2e/browser/` run in no lane, no script and no CI; `test:e2e` is
browser-free despite what the docs said. Whether the oracle gains a browser lane is open —
POD-295 locked the existing lane set rather than growing it.

Count it the way the runner resolves it, not by reading the directory —
`find tests/e2e/browser -name '*.browser.e2e.ts' -type f | wc -l` → 54 (its
`playwright.config.ts` is `testDir: './browser'` + `testMatch: '**/*.browser.e2e.ts'`).
An earlier "56" here was a directory listing that counted two helpers as suites, and it had
already propagated into a second issue before POD-756 caught it. Plus a 55th orphan that is
outside even the orphaned suite: `tests/e2e/mobile-web-smoke.spec.ts` misses Playwright
twice (outside `testDir`, and `.spec.ts` ≠ the `testMatch` glob) and misses vitest's globs
too, so nothing runs it and nothing references it.

---

## 3. Standing conventions

### 3.1 Phase-entry drift refresh (standing convention)

At every phase-entry gate, **the phase agent re-audits its phase issues against current
main before starting** — a "drift refresh". This plan froze 2026-07-13 and was
materially stale in ~30 issues within 3 days (drizzle-kit adoption, instance identity
[spec:SP-15aa], session handoff, new messages/workflows verticals, web redesign);
later phases execute months from now and WILL drift further. The 2026-07-16 refresh
comments on affected issues are the template: a dated `DRIFT REFRESH` comment per
affected issue stating what changed on main and how the issue's scope/ACs move.

Post-freeze facts to re-check at minimum: test-lane structure (docs/agents/testing.md),
build orchestration (tsgo/turbo — the SP-3b58 cold-timing baseline was measured on tsc
and is already stale), instance identity (SP-15aa), the deletion-audit inventory, the
hot-file table below, and any new verticals (routers, packages, wire messages) landed
since the phase was decomposed.

### 3.2 Phase-close rule

A phase closes ONLY when: (a) all its children including its exit-gate leaf are closed,
(b) its deletion-audit items are at zero, (c) the oracle lanes are green, (d) its ledger
section below is filled in (scope as executed, cut lines, oracle status, audit counts
before/after), and (e) its as-built docs are updated (§9). No phase closes while a
dual/legacy path it was meant to remove still exists.

**Clause (b) is executable, not a judgement call** (lands with POD-297; rule written up in
`docs/rearch-deletion-audit.md`):

```
bun run audit:rearch --phase POD-309     # the phase-close gate
```

- **exit 0** — every inventory item mapped to that phase is at zero: clear to close.
- **exit 1** — lists what still stands, with `file:line` per surviving site.
- **exit 2** — unknown flag, malformed phase, or a phase with no items mapped. The gate
  **fails closed**: an unrecognised argument never degrades into a passing run.

That exit-2 behavior is load-bearing and is verified by EXECUTION, not by reading the
source — re-executed against POD-297's HEAD 44051213 (POD-298, 2026-07-16): a well-formed
phase id with no items mapped to it, a bare `--phase`, a malformed `--phase notaphase`, a
typo'd `--phasee`, the dangerous `--updatebaseline` typo (which would otherwise silently
run the ratchet and look like it worked), and an unknown flag among known ones each exit
2; `--phase POD-309` exits 1 and names its surviving site. A gate that answers "clear to
close" for input it did not understand would be worse than no gate, and this repo has
shipped exactly that bug twice: `git rev-parse` ECHOES an unknown flag and exits 0 rather
than rejecting it, silently defeating a worktree check in both POD-657 and POD-665.
**Before any phase leans on a new gate, test that it refuses input it does not
understand** — the failure mode is not an error, it is a plausible pass.

**Re-test when the CLI's argument handling changes, and hold this paragraph to its own
rule.** This evidence has now been re-executed twice for exactly that reason: first at
`bddfff78`, invalidated when the script grew ~193 lines of argument handling
(`50edbe13`), then invalidated again when actions were reordered before reports
(`44051213` — which fixed `--json --update-baseline` exiting 0 having written NOTHING,
the same fail-open family this paragraph exists to catch). It holds at each. Evidence
naming a commit is evidence about THAT commit; a gate's argument handling is exactly the
code that changes without anyone thinking of it as behavior.

### 3.3 Exit gates are scheduler-enforced leaves

Parents are closable with open children, so **downstream work blocks on the gate LEAF,
not on the milestone**. The gates: POD-422 (Phase 0) · POD-423 (Phase 1) · POD-310
(Phase 2, human) · POD-424 (Phase 3) · POD-425 (Phase 4) · POD-426 (Phase 5) ·
POD-427 (Phase 6) · POD-337 (release gate, human). A gate closes only after its
verification checklist is executed and evidenced — never because its phase "looks done".

### 3.4 Tracker navigation rule

`podium issue tree 279` **TRUNCATES beyond the CLI cap (~100 nodes)** — the rewrite
tree is far larger. Never verify readiness or completeness from the root tree alone;
inspect per-phase trees (`podium issue tree <phase-id>`) or query children recursively.
This rule is repeated in every phase section's verification steps below.

### 3.5 Lint caveat

Issue acceptance criteria currently live in **description prose** because the CLI does
not expose the dedicated acceptance field. Therefore `podium issue lint` AC checks are
**NOT a quality gate** for the rewrite issues until the CLI gap is fixed (tracked with
POD-413's agent). Gate agents verify ACs by reading descriptions, not by lint output.

### 3.6 "Recorded in the ledger" means a LEDGER-ENTRY comment

An AC that says something is "recorded in the ledger" is satisfied by a comment on the
issue prefixed `LEDGER-ENTRY`, carrying the text to record. **Only the phase's designated
ledger owner edits this file**, folding LEDGER-ENTRY comments into the owning section.
This keeps the hot-file rule (§5) workable: contributors never queue on the file, and the
owner batches edits at natural seams (gate close-outs, phase exit). A LEDGER-ENTRY comment
that never got folded in is the owner's defect, not the contributor's.

### 3.7 Per-guardrail CI workflow files

New CI guardrail steps MAY live in their own workflow file (`.github/workflows/`
`ci-<guardrail>.yml`) instead of being added to `ci.yml`, to keep `ci.yml` out of
hot-file contention. The non-negotiables travel with the step wherever it lives: blocking
(never `continue-on-error` — §2.2's POD-744 lesson), and covered by the drift guard
(`scripts/test-configuration.test.ts`) when it participates in the oracle lane set.

---

## 4. Decomposition discipline

**User decision: EAGER — executed in-plan 2026-07-13.** Every flagged mini-epic was
pre-split into bounded children following the protocol
*characterization → scaffold → one aggregate/hop → shadow/conformance → cutover → named deletion*:

| Mini-epic | Pre-split children |
|---|---|
| POD-301 branded IDs | POD-360…363 |
| POD-302 semantic vocabulary | POD-364…368 |
| POD-306 Replica + Outbox | POD-369…373 |
| POD-307 client storage | POD-374…378 |
| POD-312 session mutations | POD-379…382 |
| POD-313 superagent/fleet/spec mutations | POD-383…386 |
| POD-317 gateway | POD-387…391 |
| POD-319 SessionService split | POD-392…395 |
| POD-325 harness/pty split | POD-396…399 |
| POD-328 client engine split | POD-400…404 |
| POD-331 god components onto slices | POD-405…409 |

**Any FUTURE oversized issue follows the same protocol**: it is split before
implementation, and the split is **reviewed against the governing ADR** (an oversized
issue implemented whole is a gate-blocking defect). "Oversized" = touches more than one
hot file, more than one hop, or cannot state a single named deletion.

**Grep audits are necessary, never sufficient.** Semantic gates (conformance suites,
manifest lint, runtime verification, human gates) decide; a grep count of zero is
evidence, not proof. The deletion audit states this in its own terms
(`docs/rearch-deletion-audit.md`): a zero means **the named shapes are gone, not that the
phase's design intent was met** — the exit gates (§3.3) still own that judgement. Treat
`audit:rearch --phase X` exiting 0 as a NECESSARY condition for closing X, never a
sufficient one.

**And symmetrically: a detector's HIT is a question, not a verdict — only reading the site
answers it.** A zero is not proof the debt is gone; a hit is not proof the debt is there.
This cuts wider than greps: it is the rule for any mismatch a cheap check surfaces. (Worked
example, POD-298 2026-07-16: a cited issue's TITLE disagreeing with what the citation
claimed was treated as the finding — "the ref is wrong" — when the title of a bug names the
ROOT CAUSE while the body carries the SYMPTOM, and the body supported the citation exactly.
The check was right to flag; it was wrong to conclude. Flag, then READ.)

---

## 5. Hot-file integration ownership

Contested files each have ONE owning phase/issue at any time. Anyone else touching a
hot file coordinates with the owner (issue mail + `podium lock acquire hotfile:<name>`)
and merges BEHIND the owner. Merge-order rule per file:

**Parts of this ledger become machine-checked with POD-296's branch — documentation that
can fail CI.** That branch adds `scripts/architecture-manifest.test.ts`, which reads the
§8 tag table it also adds and asserts every tagged workspace has a matching ledger row,
every declared same-layer edge is listed, and no row names an untagged workspace; it
matches on `| \`packages/foo\` |` row prefixes and the `L0 model` / `L2 kernel` layer
labels. (Neither the test nor that table exists on main yet — arriving with POD-296;
`packages/telemetry/src/docs-drift.test.ts` is the same shape and is live today.) Once it
lands: a phase that adds, renames or splits a package updates the manifest AND its ledger
row in the same commit, and anyone reformatting §8 runs the unit lane before assuming a
prose change is safe. Prefer adding a drift test to trusting a convention — a table that
CANNOT silently drift is worth more than a rule saying it must not.

| Hot file | Owner (phase/issue) | Merge-order rule |
|---|---|---|
| Protocol message unions + codec (`packages/protocol`) | Phase 1 POD-300 (schemas move out), then Phase 2 POD-308 (wire cutover), then Phase 4 POD-317/POD-387 (plane inventory) | Owner lands first each phase; additive message variants by others rebase onto the owner's union; no one but the owner changes codec/negotiation. |
| `router.ts` (tRPC surface) | Phase 3 POD-314 (derivation shrinks it to genuine queries); mutation-migration children (POD-312/313/640/641) delete their procs | Deletions land per-child; POD-314's derived-router refactor merges LAST in Phase 3, after all migrations. |
| Server composition root | Phase 4 POD-321 (declarative acyclic composition) | Until POD-321, edits are append-only wiring; extraction children (POD-317/319/320/322) each rebase onto the previous extraction — serialize via merge lock. |
| Workspace manifests (`package.json` graph, new packages) | The phase scaffolding issue creating the package (POD-299 model, POD-305/306 kernel, POD-311 commands, POD-325 harness/pty, POD-331 engine) | New package = one scaffolding commit owned by that issue; others take it as a base. Every new package registers its typecheck task + correct workspace deps (see turbo.json row). |
| `scripts/check-boundaries.ts` (architecture manifest lint) | Phase 0 POD-296 (warn mode), then Phase 7 POD-335 (error level) | Between those, phases may ONLY shrink their own allowlist entries; rule changes go through the owner. |
| Store migrations (global migration order) | Phase 2 POD-305 (app migration orchestrator owns global ordering) | One migration number at a time — `podium lock acquire migration-number` before allocating; feature-owned tables stay in their feature but register with the orchestrator. |
| `turbo.json` (build orchestration; contested once POD-715 lands) | POD-715's agent, then each package-scaffolding issue for its own task entry | Every new package registers a typecheck task + correct workspace deps as part of scaffolding — otherwise turbo invalidation silently misses it. Cross-cutting pipeline changes only via the owner. |
| **`docs/rearchitecture-v3.md` — THIS LEDGER** (contested by construction: §8 says every phase writes its own section) | POD-298 owns §1–§7 and §9 (the conventions); each phase owns ITS OWN §8 section and nothing else | **Append within your own section; never restructure another phase's.** Two phases appending at different seams auto-merge cleanly — that is the whole reason the rule is "append, don't reflow". Rebase onto the ledger's current head before editing (POD-296 and POD-298 both edited it on 2026-07-16 from different bases; it merged only because both were appends). Parts of §8 are DRIFT-TESTED (below) — a reflow that reads fine can still fail CI. |

---

## 6. Human gates registry

**THE RULE: when a gate is reached, the executing agent MUST run
`podium issue needs-human` on the gate issue. Prose labels cannot close a gate.**
Evidence is attached via issue artifacts (`podium issue artifact <id> --add …`);
runbooks live in this document (section per gate below or in the phase section).

| Gate | What the human does | Runbook location | Evidence location |
|---|---|---|---|
| POD-359 ADR pack sign-off | Reads and signs off the pack before Phase 1 entry: the 8 original ADRs **plus ADR 9 (identity, ownership, sharing) and the amendments to ADRs 1/2/3/4/7** carrying the 2026-07-29 multi-user decisions | `docs/adr/` (the pack itself; decision record in `docs/multi-user-readiness.md`; sign-off procedure in POD-359) | POD-359 issue artifacts + signed ADR frontmatter |
| POD-377 / POD-332 device smokes | *(multi-user)* both now include a **second-user pass** — see their descriptions | POD-377 / POD-332 descriptions | those issues' artifacts |
| POD-351 walking-skeleton sign-off | Verifies session.rename on the target path (online/offline, two clients, crash/reconnect); USER sign-off | POD-351 description + §Phase 1 ledger section | POD-351 issue artifacts (shadow-comparison record, runtime evidence) |
| POD-310 live upgrade rehearsal | Runs the local-topology upgrade on the real fleet (VPS + remote daemon + phone PWA); rollback drill | This document, Phase 2 section (runbook committed by POD-310) | POD-310 issue artifacts + quantitative checks recorded here |
| POD-377 mobile cutover device smoke | Real-device smoke of the SQLite replica migration | POD-377 description | POD-377 issue artifacts |
| POD-332 mobile slices device smoke | Real-device smoke: cold-start offline paint, reconnect drain, terminal parity | POD-332 description | POD-332 issue artifacts |
| POD-327 remote-daemon soak | 48h live remote-daemon soak (paired VPS) without manual intervention; may run on an isolated named instance per [spec:SP-15aa] | POD-327 description + Phase 5 section | POD-327 issue artifacts |
| POD-337 fleet soak + release | 72h+ local-topology fleet soak, two redeploys + one daemon self-update; quantitative criteria within thresholds; "clean" as defined in POD-337 | This document, Phase 7 section (runbook committed by POD-337) | POD-337 issue artifacts |

---

## 7. Scar-tissue registry

Incident-hardened code is **relocated verbatim, never rewritten**. When a phase moves a
file containing scar tissue, the scar moves with its comment and its test; "cleaning it
up" is a regression until the incident class is provably impossible. Each relocation is
recorded here (phase agents append rows).

| Scar | Where it lives today | Incident it encodes |
|---|---|---|
| Malformed-frame-per-reattach tolerated as benign | daemon connection handling (POD-327 relocates; must document in code) | One ZodError per (re)attach is NORMAL; treating it as fatal broke reattach |
| `decideOnProtocolMismatch` / `decidePostUpdate` self-update policy | `daemon/self-update` module | Self-update decisions were once inline and cross-wired; keep/extend the module (POD-327) |
| Delete-tracking on replica sync (assign `undefined`, never `delete`) | replica delta application | Replica dropped nulled fields — stuck fields incident (POD-170-era); POD-378 carries the regression test |
| `reclaimStaleScope` | session scope allocation | Scope-name collision killed a live agent |
| Master-probe + exited-row heal on restart | server boot | Restart orphaned live sessions |
| `seedBootState` on reattach | agent state pipeline | Reattach previously showed stale agent state |
| Feature-detect `spawn({terminal})` | PTY spawn path | PTY black screens on stale-Bun daemon |
| Masters in their own `systemd-run --scope` | session spawn | Redeploy's cgroup kill took live sessions down |
| Codex trust-hash/TOML version guard (to be added) | codex adapter (POD-327) | Silent mis-hashing on unknown codex versions; must degrade loudly |

(Phase 5, which touches the host layer, updates this registry for everything it
relocates — an explicit AC on POD-327.)

---

## 8. Phase ledger

Every phase issue links back to its section here. Each section is maintained by that
phase's agents and finalized at the exit gate. **Verification steps in every phase
include: use `podium issue tree <phase-id>` (never the root tree — §3.4), run the
drift refresh (§3.1) at phase entry, and verify ACs by reading descriptions (§3.5).**

### Phase 0 — Guardrails (POD-287) · exit gate POD-422

**Scope:** build the mechanism that makes "half-landed" visible and painful, BEFORE any
code moves. Four children:

- POD-295 — lock the migration oracle: green lane baseline (unit + integration + e2e +
  multi-instance) in CI, per the lane doctrine (§2). *Done — integrated at ca361327;
  see the oracle-status paragraph below for the measured green.*
- POD-296 — architecture manifest lint: layer/platform/role/feature constraints, WARN
  mode, phase-mapped allowlist. *Done — integrated at ca361327: the tag-derived matrix lives in
  `scripts/architecture-manifest.ts`, today's 50 known violations (48 under the manifest
  rules + 2 legacy `agent-bridge-consumers` → POD-740; re-derive with
  `bun run lint:boundaries` → "50 allowlisted, 0 new", `bun run lint:architecture` →
  "48 allowlisted, 0 new") are frozen with
  per-(rule, file) counts in `scripts/boundary-allowlist.ts` and mapped to the phase that
  removes each, and the ratchet runs as its OWN blocking CI step. Its layer/tag
  table + the rule → legacy-rule retirement map POD-335 needs live as a subsection here,
  drift-tested against the manifest (§5).*
- POD-297 — deletion audit script (`scripts/rearch-audit.ts`): the Section-6 "what
  disappears" inventory encoded as grep/AST checks with per-item and total counts,
  counted in CI, must reach zero by POD-337. *Done — integrated at ca361327;
  all 21 inventory items encoded and mapped to their owning phase issue, wired as its
  OWN blocking CI step. Rule + rationale: `docs/rearch-deletion-audit.md`.*
- POD-298 — this ledger. *This document.*

**Cut lines:** Phase 0 ships guardrails only — no production code moves, no schema
moves, no deletions. The audit script REPORTS counts; it does not fail CI on nonzero
(that ratchet is per-phase). Manifest lint stays in warn mode until Phase 7 (POD-335).

**Oracle status:** baseline MEASURED at c577009d and **RED** — see §2.4 for the lane table.
typecheck + e2e green; unit red (POD-743 — since FIXED by POD-295, no product change);
integration + multi-instance red (POD-746, one file failing in both). Zero quarantines. The
oracle command (`bun run oracle`) and the CI job are in place. Typecheck runs under tsgo
via turbo (POD-715 landed).

**Status at the integrated head `ca361327` (issue/279-integration, measured 2026-07-17,
POD-422 evidence pack):** `bun run oracle` → **ORACLE GREEN, all five lanes** (typecheck /
unit / integration / e2e / multi-instance), plus a second full unit run and five standalone
`tailer.test.ts` runs, all green. POD-746 is **fixed and landed** in the integration train
(968dee89 anchors `@podium/runtime` to the checkout under test; 106db154, 8bf0feed,
ca361327 guard it). POD-757's fix is **committed on its branch (a1c5f0ef) but not yet
integrated or proven** (standalone + under-load); the flake did not reproduce at ca361327
in 5 standalone runs — recorded as measured fact, not as a fix. **Gate POD-422 stays open
on POD-757's disposition alone.**

**Audit counts:** baseline committed by POD-297 in `scripts/rearch-audit-baseline.json`
— **21 items / 246 sites at fd4ea76b**. That is the before-count every later phase reads.
After Phase 0: unchanged by definition (nothing deleted yet).

**`scripts/rearch-audit-baseline.json` on POD-297's branch is the AUTHORITATIVE source;
the table below is a derived convenience copy.** If they disagree, the JSON wins and this
table is stale — re-derive it, never hand-edit it to match.

**Where every later phase's before/after evidence comes from (§8 obligation, satisfied
mechanically):** the ratchet forces the baseline to be EXACT — a regression fails, and an
improvement *also* fails until it is recorded with `--update-baseline`. So a win cannot
land unrecorded, and **every deletion PR's baseline diff IS that phase's before/after
evidence** — no phase agent hand-counts anything. `bun run audit:rearch --json` emits
machine-readable per-item counts + sites. Baseline at Phase 0 entry, by owning phase:

| Phase issue | Items | Sites | Phase issue | Items | Sites |
|---|---|---|---|---|---|
| POD-302 | 3 | 24 | POD-321 | 1 | 1 |
| POD-303 | 1 | 2 | POD-324 | 1 | 4 |
| POD-308 | 1 | 12 | POD-325 | 1 | 4 |
| POD-309 | 1 | 4 | POD-329 | 2 | 16 |
| POD-313 | 1 | 1 | POD-332 | 2 | 3 |
| POD-314 | 1 | 123 | POD-333 | 3 | 20 |
| POD-318 | 2 | 21 | POD-334 | 1 | 11 |

(Re-derived by POD-298 from POD-297's committed baseline at their HEAD 44051213, by
joining the JSON counts to each check's declared owning phase — not copied from a
report; unchanged across 50edbe13→44051213. POD-314's 123 sites are the hand-written
tRPC mutation procedures; that single number is the best available proxy for Phase 3's
size.)

**Why this baseline went UP (236 → 246) without any debt being added — the sharpest
illustration of §4's "grep audits are necessary, never sufficient".** An adversarial
review of POD-297's detectors found six defects, three of which could let a phase close
while its debt still stood. `reexport-shims` was line-based, so a re-export wrapped across
lines carried no single `export … from` line and went uncounted (13 → 19) — and because
biome wraps a re-export as soon as a name is added, **ADDING code made the count DROP**,
which the ratchet's improvement path would have written into the baseline as a win.
`router-triple-access` keyed on a helper name that is itself an alias, missing 4 longhand
sites (119 → 123). `send-turn-duplicate` did `sites.slice(1)`, so a detector whose anchor
had moved reported `[]` → 0 and POD-313 read **"clear to close"**. The lesson for every
phase: **a detector that stops matching is not a deletion.** A count that falls because
the code moved out from under the pattern looks exactly like a win. Treat a drop you did
not deliberately cause as a suspected broken detector until proven otherwise.

**Verification steps (gate POD-422):** oracle CI job live (lane-based, incl. the
typecheck lane under the current orchestrator); deletion audit baseline committed AND
running as its own blocking CI step; manifest lint in warn mode with phase-mapped
allowlist; ledger conventions complete (this document); all four children closed with
evidence. Use `podium issue tree 287`, not the root tree. Only then does POD-422 close
and unblock the ADR pack + Phase 1.

**A guardrail wired into a `continue-on-error` step is not a guardrail.** `.github/workflows/ci.yml`
bundles biome + `lint:boundaries` into one step marked `continue-on-error: true` (while the
biome backlog burns down, POD-30). That flag makes the BOUNDARY guardrail non-blocking too,
so an architectural violation reports green — diagnosed in POD-744. This is not
hypothetical: `bun run lint:boundaries` **exits 1 on current main** (two
`agent-bridge-consumers` violations, `apps/server/src/accounts.ts` and `relay.ts`;
verified 2026-07-16 at c577009d), tracked open as POD-740.

The lesson for Phase 0: **shipping a lint is not the same as the lint being able to fail a
PR.** Gate POD-422 must confirm each Phase 0 guardrail is its OWN blocking step and that a
deliberate violation actually fails CI — not merely that the script exists and is green
when run by hand. Both Phase 0 ratchets are deliberately wired that way, each as its own
step outside the `continue-on-error` one: the deletion audit (POD-297) and the
architecture-manifest ratchet (`bun run lint:architecture`, POD-296). Known debt warns;
only NEW violations fail. The two concerns must never share one `continue-on-error`.

#### Architecture manifest — layer/tag assignment (POD-296)

The manifest lives in `scripts/architecture-manifest.ts`; this table is the ledger
record of it. Every app and package is tagged, and the allowed-dependency matrix is
DERIVED from the tags plus an explicit same-layer list — a same-layer edge is never
implicit. A workspace with source and no tags is itself a violation
(`manifest-untagged`), so a new package cannot silently escape the matrix. **When a
phase adds, renames or splits a package, it updates this table and the manifest in the
same commit.**

| Workspace | Layer | Platform | Owns (features) | Transition |
|---|---|---|---|---|
| `packages/model` | L0 model | browser-safe | entity-schemas, entity-predicates, issue-stage, issue-authz, session-dedup, git-identity, clock | **DONE** (Phase 1 POD-299 + POD-300): absorbed and deleted `packages/domain`, plus the `@podium/runtime/git.ts` shim; then POD-300 moved every replicated-entity schema in from `packages/protocol` (`entities/`: agent, session, issue, conversation, machine, transcript, handoff — the machine file is one named group because per-machine facts inherit machine scoping). Zod-only, zero workspace deps. POD-304 then filled `annotations/` (the ownership matrix as DATA: 53 rows × ADR 1 D4's eight columns + Amendment 1 D8's owner/visibility/grants + the attribution pair, the system-writer rule, inheritance-on-create and visibility-mutability; a totality test; `arbitration.ts` as the Authority-only read surface) and added `provenance/` (`ReplicatedEnvelope<T>` — the entity schemas are provenance-free). Reserved homes remaining: `ids/` (POD-360…363), `user-state/` (POD-1076) |
| `packages/protocol` | L1 wire | browser-safe | wire-schema, titles | **DONE** (Phase 1 POD-300): entity schemas moved to `packages/model`; protocol keeps only frames (message unions, codec, handshake, sync-class taxonomy, versioning) and imports the entities. No re-export shim. Wire proven byte-identical by the golden fixtures in `packages/protocol/src/messages/wire-golden.json`. Next: Phase 2 POD-308 wire cutover |
| `packages/issue-client` | L1 wire | node-only | issue-command-table | → folded into the command registry (Phase 3 POD-311) |
| `packages/commands` | L1 wire | browser-safe | command-contracts | **landed POD-728** (3.9b) — created ahead of POD-311, which still OWNS it. POD-311 was backlog+blocked with no branch when the Phase-3 children needed a contract type to declare against, so POD-728 built ADR 3 D1's field table (policy, exposure, offline class, redaction, conflict, decision — all REQUIRED, with `classificationErrors()` as the lint) and made **agent-mail its first tenant instead of issues**. What POD-311 still owns: migrating the issue registry onto the L1/L3 split, folding in the stranded `protocol/commands.ts` CommandDef and `messages/mutations.ts` MutationEnvelope/MutationResult, and deriving the four transports from `exposure`. Note the transitional duplication this leaves: POD-380/381's facets live on `protocol/commands.ts` while POD-728's live here, and POD-311 is the issue that collapses them — see the ledger note under POD-728 |
| `packages/transcript` | L2 kernel | node-only | transcript-parsing | package placement settled by ADR 8; POD-398 implements |
| `packages/runtime` | L2 kernel | **neutral** | config, sqlite, git-port, connectivity, auth-store, settings | browser-safe barrel + node-only subpaths (legacy rule 8) |
| `packages/sync` | L2 kernel | node-only | oplog, upstream-sync | → one sync kernel (Phase 2 POD-305/306) |
| `packages/telemetry` | L2 kernel | **neutral** | telemetry-schema, telemetry-consent, telemetry-queue | added mid-Phase-0 [spec:SP-f933]; subpath gap POD-745 |
| `packages/agent-bridge` | L2 kernel | node-only | (none) | **EMPTY SHELL.** POD-396 extracted the PTY half to `packages/pty`, POD-397 the harness half to `packages/harness`; feature ownership is exclusive so both tags MOVED. Awaiting deletion by POD-399 |
| `packages/pty` | L2 kernel | node-only | pty-port, durable-host | **landed POD-396** (5.3a) from agent-bridge (ADR 8 D4). Harness-AGNOSTIC: `HARNESS_ADAPTER_HOME` is now `packages/harness`, so the axiom APPLIES here and a harness comparison inside pty is a violation |
| `packages/harness` | L2 kernel | node-only | harness-adapters | **landed POD-397** (5.3b): one `AgentManifest` per CLI (launch/exec/headless/state/discovery/transcript) over `Record<BuiltinHarnessKind, AgentManifest>`; the home for harness variance and `HARNESS_ADAPTER_HOME` for the axiom. Principal-free (`harness-principal-free` lint) |
| `packages/terminal-client` | L2 kernel | browser-safe | terminal-port | — |
| `packages/composer` | L2 kernel | browser-safe | composer-driver, prompt-draft | appeared on main after POD-296; the harness composer port (pure, protocol-only) — folds into `packages/harness` with agent-bridge (Phase 5 POD-325) |
| `packages/client-core` | L3 feature | browser-safe | viewmodels | → client engine split (Phase 6 POD-331) |
| `packages/terminal-client-react` | L3 feature | browser-safe | terminal-react | — |
| `apps/cli` | L4 app | node-only | cli-surface | — |
| `apps/daemon` | L4 app | node-only | daemon-surface | Phase 5 machine-host tightening (POD-292) |
| `apps/desktop` | L4 app | browser-safe | desktop-shell | — |
| `apps/janitor` | L4 app | node-only | maintenance-jobs | appeared on main after POD-296; maintenance/steward jobs lifted out of `apps/server` — feeds Phase 4 server decomposition (POD-292) |
| `apps/mobile` | L4 app | browser-safe | mobile-surface | — |
| `apps/server` | L4 app | node-only | server-surface | role-tiered (core<hub<cloud, `apps/server/src/roles.ts`); Phase 4 decomposition |
| `apps/web` | L4 app | browser-safe | web-surface | Phase 6 engine split |
| `scripts` | L5 compose | node-only | build, lint, compose | composes apps; nothing may import it |

**Declared same-layer edges** (the only legal sideways imports): `issue-client → protocol`;
`sync → runtime`; `telemetry → runtime`; `agent-bridge → runtime`; `agent-bridge → transcript`;
`pty → runtime` (POD-396: `stateDir()` behind the abduco binary cache); `harness → runtime`; `harness → transcript`; `terminal-client → composer`; `commands → protocol` (POD-728: contracts name the frames they are exposed on).

**Neutral is a real tag, not a dodge.** `runtime` and `telemetry` both have a browser-safe
barrel with node-only concerns behind explicit subpaths, so neither is honestly
browser-safe nor node-only. The workspace-granular tag cannot see subpaths: legacy rule
8a covers `@podium/runtime` only, which is why the identical hole in `@podium/telemetry`
is filed as POD-745 rather than papered over.

**Warn mode + ratchet.** `scripts/boundary-allowlist.ts` freezes today's 50 known
violations with per-(rule, file) COUNTS, each mapped to the issue that removes it: 46
harness-branching → Phase 5 (POD-292/POD-325), 2 `apps/desktop → scripts` → Phase 7
(POD-294), 2 legacy `agent-bridge-consumers` → POD-740. Allowlisted-and-within-count
warns; anything new — or one more in an already-listed file — fails. Slack fails too: a
count left above reality leaves slots that can be refilled silently, so "the list can
only shrink" is only true if not shrinking it stops the build. Phases shrink their own
entries (§5); POD-335 flips to error level with the list empty.

**One allowlist, both rule families.** The legacy eight run through the same ratchet, so
POD-740's two `apps/server → @podium/agent-bridge` imports are grandfathered rather than
failing `lint:boundaries` on every branch — while a NEW legacy violation still fails.
The two families are applied to their own violations separately (`partitionAllowlist`):
one shared pass would have each declaring the other's entries stale.

**Two lint entrypoints, on purpose.** `bun run lint:boundaries` runs everything and is
wired into `bun run lint`, which is `continue-on-error: true` in CI while biome's ~249
pre-existing errors are burned down (podium #30) — anything living only inside it is
decorative. `bun run lint:architecture` (`--manifest-only`) is therefore a SEPARATE
BLOCKING CI step. POD-297's deletion audit is wired the same way for the same reason.

**The harness axiom tracks HarnessAgent identity, not the literal.** `ApiProvider`
(`['openrouter','anthropic','openai','codex']`) is a separate enum sharing the literal
`codex`, so a comparison reading a provider is not harness branching and is not flagged
— codex-the-provider's variance belongs to POD-292's broader "confine agent-CLI variance
to the harness layer". Identifiers flowing, and Records keyed by harness, are never
flagged: only comparisons branch.

**Rule → legacy-rule retirement map** (POD-335 retires each legacy rule only once its
equivalent exists; none is dropped without one): `manifest-layer` + `manifest-platform`
subsume rules 1/3/4/5 (app→app, leaf/near-leaf allowlists, packages-never-apps,
cli-no-apps) and rule 2 (agent-bridge consumers); `manifest-role` reuses
`apps/server/src/roles.ts` and subsumes rule 6; the `features` tag is the intended home
for rule 7 (domain single-home); rule 8 (runtime browser-safety) needs the subpath
awareness POD-745 describes before the platform tag can retire it.

### ADR gate (POD-359) + Walking skeleton (POD-351) — between Phase 0 and Phases 2–3

Not a numbered phase but a scheduling stage: POD-359 (8 ADRs, HUMAN GATE) runs after
POD-422 and before Phase 1 consumption; POD-351 (session.rename end-to-end on the
target path, shadow-compared, HUMAN sign-off) gates Phases 2–3 entry and ships the
first real command contract + optimistic reducer port that POD-372/POD-311 consume.

**Ledger obligations:** shadow-comparison record for POD-351 lands in this section;
zero divergence required.

#### POD-351 as-built — the walking skeleton

**What moved.** Exactly one command. `sessions.rename` runs on the target path in
production config; the other ten presence commands are untouched on the presence
envelope.

*Re-pointed after POD-382 landed the 3.2 cutover.* This issue originally joined the
contract to its handler as a hand-written `renameProc` in `router.ts`. POD-382 then
deleted the hand-written session surface entirely — every session mutation is now
DERIVED from the contract tables by `modules/sessions/trpc.ts`, and
`scripts/audit-session-commands.ts` fails the build if a `.mutation(` for a session
appears in `router.ts` at all. So rename now arrives through that derived surface as
its own manifest source, `walking-skeleton`, built by `renameProcedure()`. It stays
in `TRPC_PRESENCE_NAMES` and keeps its presence contract — that contract is still
what declares its exposure and policy, and the both-directions exposure cross-check
must keep covering it — while the manifest records that a DIFFERENT envelope runs it.
Declaring a fourth source rather than special-casing inside `presenceProcedure` is
what keeps "which commands are on which envelope" readable in the manifest, so a
second command migrating later is a row that changes rather than a condition somebody
has to find. The contract and the reducer were unchanged by the move, which is the
evidence that the port shapes were right.

The adapter
(`modules/sessions/rename-adapter.ts`) defaults to the target path — a legacy default
would leave the target path with zero production callers — with
`PODIUM_SESSION_RENAME_PATH=legacy` as the rollback, matched exactly so a typo cannot
silently disable a shipped command. `MIGRATED_COMMANDS` is asserted to be exactly
`['sessions.rename']`, so a list that grew would fail a test rather than pass a review.

**The pairing, since the obvious one no longer exists.** POD-380 deleted the
hand-written rename procedure. LEGACY is therefore `PresenceRegistry` (POD-380's
envelope, the protocol `CommandDef`, a `PresencePrincipal`, `undefined` on success);
TARGET is `modules/sessions/rename-target-path.ts` (the `@podium/commands` ADR 3
contract, the real `CommandPrincipal` with its delegation chain resolved live, the
contract's accept/reject outcome union). Both share the composition root's one
`MutationLedger`, so a replay is seen once no matter which path served the original —
idempotency is framework-owned on both sides, and the target path's ordering
(authorize BEFORE the ledger is consulted) is what `rename-offline.test.ts` pins.

**SHADOW COMPARISON — ZERO DIVERGENCE.** `modules/sessions/rename-shadow.test.ts`
runs nine input cases plus the SP-eb60 arbitration branch and the not-found case
through BOTH paths, on two independently-seeded REAL stacks (real `SessionStore`,
`SessionRegistry`, `SessionsService`), comparing the written row *and* a normalised
verdict in ONE assertion that fails on divergence. Refusal reason strings are compared
verbatim. 20 tests, all passing, zero divergence.

**The comparison is proven able to fail.** Three tests inject a real divergence and
assert the shadow assertion reds — including the case a name-only comparison would
miss: same string, different `nameSource`. Without it, an agent write laundered as a
human write would pass the shadow and take SP-eb60's sovereignty with it.

**Crash / reconnect.** Not re-proved here. POD-373's conformance suite certifies
`base/crash-between-writes` (entity/cursor/outbox all-or-nothing, including inside an
atomic bootstrap install and while draining the buffer) and
`scoped/crash-with-watermark-in-flight` against both kernels, and POD-1146's single
`SyncSpan` plus POD-373's externally-opened-span rule are what make the one-transaction
guarantee structural. POD-351 adds the VERTICAL that suite cannot express — see below —
rather than a second copy of the kernel property.

**Offline path.** `modules/sessions/rename-offline.test.ts` (12 tests): a rename queued
offline is re-authorized at DRAIN by the same code that authorizes it online; it is
REJECTED when the principal loses access, and also when the delegating HUMAN is revoked
though the agent is not (§3.1.3 A1's transitive property). A revoked REPLAY is refused
rather than served from the dedup cache — the test first asserts the mutation IS in the
applied table, so the cache genuinely had something to serve. No capability snapshot
exists anywhere in the path: `OutboxRecord` has no field for one, and two otherwise
identical drains resolve differently when ownership flips between them.

##### The two gaps this skeleton does NOT close, stated so a green run cannot imply them

1. **READ-SIDE SCOPING IS NOT BUILT, AND IS NOT CLAIMED.** POD-351 enforces the
   WRITE side: authorization is owner/grant-aware, resolved live over the delegation
   chain at every apply. It does **not** enforce read-side visibility — the delta feed
   here is still unscoped, which is POD-1077's work in Phase 2 and must land before the
   POD-308 wire cutover. Nothing in this issue's evidence should be read as privacy.
   The contract, the delta envelope and the replica apply path are shaped so
   per-principal filtering plus watermarks and an `evict`/`rescope` op can be added
   without a wire break: the reducer port already carries `ExitKind` (`evicted` vs
   `removed`) and the overlay DROPS with the row before any reducer runs, so a revoked
   share cannot be re-exposed optimistically. Recorded rather than implied because a
   filter without a watermark is a protocol break, and every suppressed row without one
   is a permanent invisible gap that heal-loops forever.
   **CLOSED by POD-1077 (2026-07-30)** — see its ledger entry at the end of this phase.
   The filter and the watermark landed together and inseparably (the delivery type carries
   the evaluated range beside the rows), and the qualifier that remains is the
   authenticator rather than the mechanism: `CLIENT_PRINCIPAL_GRADE` is still `device`.
2. **TODAY'S OPERATOR SHORT-CIRCUITS THE OWNER GATE.** The tRPC human is `OPERATOR`
   (`role: admin`, `scope: all`), and `authorize()` allows on scope `all` before reading
   the target's owner. So owner/grant gating is real and proven for an agent (whose
   human ceiling has no scope short-circuit) and for any scoped human, and is
   short-circuited for today's unconstrained operator — correct as designed under §3.2's
   one-password instance, and replaced by POD-1075. Pinned by two tests in
   `rename-offline.test.ts` so the qualifier travels with the claim.

**Defect found: POD-1172 (sole-human identity fork).** `SOLE_USER_ID` (`'user:sole'`,
POD-380 — what `sessionOwner` stamps) and `INSTANCE_OWNER` (`'instance-owner'`, POD-381
— what `resolvePrincipal` mints) both name the one pre-accounts human and disagree.
Each side was internally self-consistent, so nothing had compared them; POD-351's
delegation ceiling is the first code that needs both, and unreconciled it denies every
agent write. It fails CLOSED (liveness, not a leak) but would have surfaced as "agents
inexplicably cannot act" the day accounts land. Bridged in one named place
(`samePrincipal`) with a tripwire test asserting the constants still differ, so whoever
reconciles them deletes the bridge instead of leaving a permanent alias table.

### Phase 1 — packages/model (POD-288) · exit gate POD-423

**Scope:** one semantic vocabulary at L0: `packages/model` scaffold (POD-299), entity
schemas out of protocol (POD-300), branded IDs everywhere (POD-301 → 360–363),
canonical aggregates + composed projections (POD-302 → 364–368, incl. handoff
vocabulary POD-643), agent identity dual form (POD-303), provenance envelope +
ownership annotations (POD-304), **user accounts + identity model (POD-1075) and the
per-user state family (POD-1076)** — both multi-user, 2026-07-29.

**Cut lines:** no behavior change — representations re-derived, wire fixtures byte-stable
(golden fixtures from POD-360). Narrow ports remain as named derivations.

**Oracle status / audit counts:** measured at gate POD-423 (see its LEDGER ENTRY below) —
**phase HELD OPEN**. Audit items: hand-restated field definitions (`session-shapes` 0,
`issue-shapes` 0), **raw-string ids — NO AUDIT ITEM EXISTS; measured by grep at 66 sites,
NOT zero**, agent-kind enums 0 (`capability-tables` 5 is POD-325 / Phase 5.3, not Phase 1),
stateDir (`state-dir-defs`) 0. Deletion audit 25 items / 186 sites, baseline exact. Oracle
RED on two inherited failures, neither Phase 1's.

**POD-304 as-built (provenance envelope + ownership annotations).** Two decisions this
section records because later phases depend on them:

1. **The provenance split landed at the DEFINITION sites, not on the wire.** ADR 4 D3.8
   moves `viaHub` / `upstreamStale` / `pendingSync` to a `ReplicatedEnvelope<T>`; nesting
   them under an `envelope` key is a WIRE change, and Phase 1's contract is that the wire
   does not move (POD-360's goldens). So `SessionMetaEntity` / `IssueWireEntity` are
   provenance-free while `SessionMeta` / `IssueWire` compose entity + the flat group at the
   historical key position — byte-identical, 87/87 goldens. **POD-308 owns nesting the
   carrier.** Replica read sites already go through `provenanceOf` / `isViaHub` /
   `isUpstreamStale` / `isPendingSync`, so the cutover does not have to find them again.
2. **`owner` / `visibility` / `actor` / `on-behalf-of` are forbidden on the envelope**
   (ADR 4 Am1 D9.4), enforced by test. An envelope fact is droppable at a replica
   boundary; an authorization input that can be dropped fails OPEN. The same reasoning
   settled the needs-human placement question: `humanQuestionAskedBy` /
   `humanQuestionAskedAt` are server-authoritative attribution and stay ENTITY data.

**Handed forward in writing:** `docs/rearch-visibility-mutability-inventory.md` (generated
from the matrix, `--check`-gated) is POD-1077's input — 32 of 53 classes have visibility
that changes after create, which is the quantitative form of "the machinery is
load-bearing from day one". The owner column is a RULE (`OwnerResolution` + declared
no-owner reason), not a `UserId` field, so POD-1075's brand plugs in additively.

**POD-368 as-built (1.4e — the vocabulary audit, closing POD-302).** Four things this section
records because later phases inherit them:

1. **The audit item was REDEFINED, and the redefinition is the deliverable.** `session-shapes` and
   `issue-shapes` were hardcoded lists of nine and seven NAMES; POD-367 measured them at **4 of 17**
   issue representations, counting `packages/model`'s own canonical declarations as debt. The lists
   were deliberately **not** extended — that leaves the criterion zeroable by renaming an identifier
   — so the detectors now key on the entity **vocabulary**, read at runtime out of the field groups.
   9 → 0 and 8 → 0. Their limit travels with them: a **composed** representation is invisible to a
   key-counting detector by construction, so they enumerate RESTATEMENTS and can never enumerate
   REPRESENTATIONS. `packages/model/src/representations/registry.ts` is the enumeration and is
   deliberately not derived from them.
2. **Every retained representation is documented in model**, with purpose, why its semantics differ
   from the canonical aggregate, what it composes, and a declared ADR 9 D3 class checked against an
   ADR 1 matrix row. Storage, live state, wire and the narrow ports each keep their own entry (ADR 4
   D1). **43 entries: 26 session + 17 issue** — POD-364's 41, minus two drifted duplicates deleted
   rather than documented, plus four its hand pass missed and the detector found.
3. **Two audit items are ratchets, not zeros, and are mapped away from POD-302 on purpose.**
   `per-user-singletons` (8, all inherited) → **POD-1076**; `change-row-typings` (7) re-phased →
   **POD-308** as ADR 2 D9 sync-envelope shape. The second is what makes POD-302's gate pass, so it
   is the deviation a reviewer should check first. Neither is folded into a zero.
4. **`findCapabilitySnapshotKeys` had exactly one caller.** ADR 9 D5 A1's rule is about every
   representation, so it now runs over all of them — with `owner` / `actor` / `onBehalfOf` exempt **by
   test**, because attribution must survive export and an audit that conflated the two would forbid
   what this matrix requires.

Full record: `docs/rearch-vocabulary-audit.md` (§9 carries the LEDGER-ENTRY text).

**Handed forward in writing, and OPEN:** the 13-surface existence-leak list (L-1…L-13, ADR 9 §3 O1)
and the cross-boundary graph-edge question (O2) go to Phase 3 (POD-290). POD-367 landed the property
that keeps BOTH edge answers expressible without a second projection function — `IssueRefHead` is
identity-only and content is added by mask — and the decision itself is made nowhere. One real
vocabulary drift is filed as **POD-1148**: two attribution pairs exist, and reconciling them needs a
decision nobody has made about whether the actor's agent arm names the agent identity or the session.

**Verification steps (gate POD-423):** regenerate the gate evidence checklist against
current main, not the 07-13 snapshot; audit items zero; oracle green; wire fixtures
unchanged (incl. the handoff family); ledger + as-built updated. `podium issue tree 288`.

#### LEDGER ENTRY — POD-423 (1.7 Phase 1 exit gate): HELD OPEN, and what the refusal is worth

**The gate does not close.** Full evidence, every figure re-measured rather than quoted:
`docs/gates/pod-423-phase-1-exit-gate.md`. Measured at `b812e549` from a branch **0 ahead /
0 behind `issue/279-integration` with a clean tree** — an empty diff, which is what makes
every not-mine claim below mechanistic rather than hopeful.

**What is green, and it is most of it.** Workspace typecheck `--force` exit 0 with
`Cached: 0 cached, 23 total`. Deletion audit **25 items / 186 sites, baseline exact** —
*down* from the 194 the brief quoted and the 193 POD-383 recorded, i.e. the ratchet
tightened. All six surface audits exit 0; boundaries 0 new; NUL clean; representation and
change-row audits exit 0; wire goldens 176 tests green. Phase-1's baseline items are at
zero: `session-shapes`, `issue-shapes`, `agent-kind-enums`, `state-dir-defs`,
`representation-registry-rot`. `capability-tables: 5` is POD-325 / Phase 5.3 and is not
Phase 1's to close.

**Three blockers, and the first two are the same defect wearing different clothes.**

1. **Raw-string ids are not at zero, and nothing measures them.** The gate's AC names four
   audit items; three exist as baseline keys and are 0, and the fourth — raw-string ids —
   **has no key in `rearch-audit-baseline.json` and no detector in `scripts/`.** POD-363's
   AC promised that item would reach zero repo-wide; the item was never implemented, so the
   zero was never measurable and no ratchet defends it. Direct grep finds **66 non-test
   sites** naming an entity id as bare `z.string()` while the brand exists. The finding that
   rules out "these are boundary parses" is that the inconsistency is **intra-file**:
   `packages/commands/src/issues/contracts.ts` imports and uses `IssueIdField`/`UserIdField`
   at 143–145, then writes `machineId`/`mutationId` as `z.string()` six times below;
   `router.ts` carries `.pipe(SessionIdField)` and bare `machineId: z.string()` in the same
   file. Inside `packages/model` itself, `fields/change.ts:132` leaves `mutationId` bare
   while `MutationIdField` is exported. **POD-301, the parent whose scope is exactly this
   flip, is `backlog`.** Four *other* bare ids in model are correct and documented
   "UNBRANDED BY DECISION" (native/harness-minted ids) and must not be flipped —
   checked individually, not waved through.

2. **Fourteen live durable classes have no ADR 1 matrix row** (POD-385's sweep,
   `docs/agents/pod-385-matrix-coverage-sweep.md`; POD-1194 filed but `proposed`,
   `ready=false`). Phase 1's thesis is "every entity defined once in `packages/model`", and
   fourteen unadjudicated classes qualify that thesis directly. Three are per-user-shaped
   (`recap_watermarks`, `notification_facts`, `message_wake_cooldowns`) where the D4
   backstop's `personal` is *wrong*, not merely absent. **This gate STATES it rather than
   discovering it later**, which is the whole reason the item is in this entry.

3. **"All Phase-1 children closed" fails literally** — POD-301, POD-1076 and POD-288 are all
   `backlog`.

**The generalisable lesson, which is (1) and (2) as one shape.** Both are gates whose
REFUSING ARM CAN NEVER FIRE. `visibilityClassOf` is total and default-closed, so a class
nobody classified and a class deliberately classified `personal` return the same value and
both read green — `matrix.test.ts` can prove the backstop fires for a *synthetic* id and can
never prove no *real* class is undeclared. The raw-string-id item is the same failure one
level up: an AC that names an audit item which does not exist reads as satisfied forever,
because there is nothing to run. **An audit item named in an AC but absent from the baseline
is not a passing check; it is an unmeasured claim**, and the fix in both cases is a
MEMBERSHIP gate — enumerate the population (schema tables; id-shaped fields) and require
each member to be either classified or a declared omission. Neither is built here: POD-423
verifies, it does not build.

**Oracle RED, and neither red is Phase 1's.** unit is **1 failed / 7666 passed**, the single
failure `apps/daemon/src/connectivity-state.test.ts` reconnect case — **isolated 3/3 green**,
confirming POD-1184's load-flake (MEASURED). multi-instance fails inside `install`, where
`bash -i` resolved `podium` to the host's interactive sudo lecture text — an environment
artifact. Both are MECHANISTIC not-mine claims: the branch's diff is empty. Not re-measured
on a detached checkout, and the entry says so.

**Stated limits, because a gate that hides them is the thing it exists to prevent.** The
66-site figure is my own grep over eight field NAMES, not an instrument — it cannot see a
raw id under a ninth name. POD-385's sweep enumerated only the 54 `sqliteTable`
declarations, so filesystem-backed and daemon-local stores were never swept and **the true
count of unclassified classes is unknown and ≥ 14** (pspec, the class that started this, is
exactly such a store). Wire-delta attribution (632/635 identical, 3 handoff) is POD-1162's
measurement consumed as given per the split, not re-derived.

#### LEDGER ENTRY — POD-1076 (1.9 Per-user state family): the mirror was the defect

**What moved, and what the ratchet was actually counting.** Five singleton columns on
three shared entity rows became three tables keyed `(user_id, entity_id)`:
`sessions.read_at`, `issues.read_at`, `issues.tucked_at`, `issues.pinned` and
`issue_messages.read_at` → `session_user_state`, `issue_user_state`,
`issue_message_user_state`. ADR 1's matrix has classified these `per-user-state`
since POD-304; this is the storage catching up.

But re-keying the tables was only half of it, and the half that was already done for
snooze was the instructive one. POD-380 re-keyed `snoozes` to `(user_id, session_id)`
and left a `snoozedUntil` MIRROR field on the live `Session` for the unscoped broadcast
to read. **That mirror is an instance-wide singleton however per-user the table behind
it is** — which is exactly why `per-user-singletons` still counted
`SessionDurableState.snoozedUntil` after POD-380 shipped. Deleting the mirror fields is
what cleared the ratchet; deleting the columns alone would not have.

**THE PROJECTION NEEDS A VIEWER — the fork POD-380 recorded, resolved.** POD-380 left
`readAt` behind on a stated blocker: its only read path is the BROADCAST session
projection (ADR 2 D2's unscoped feed), so a per-user row *"has nowhere correct to be
delivered until POD-1077's scoped feed makes fan-out per-principal"*. That argument
establishes that the PROJECTION needs a viewer, not that the STORAGE must stay a
singleton. So `Session.toMeta(overlay)` and `IssueService.toWire` take a per-viewer
overlay ARGUMENT, and the unscoped broadcast supplies one named user's overlay through
a single method per service (`broadcastViewer()` → `FIRST_ADMIN_USER_ID`, spelled out
rather than defaulted per readiness §3.1.6 S4). The wire is byte-identical. POD-1077's
remaining work is two method bodies plus the `_forPrincipal` seam that already exists —
not a hunt for mirror fields, which is the state POD-380 left and this issue removed.

The overlay argument is REQUIRED, not optional-with-an-empty-default. An optional
overlay is a mirror with extra steps, and "whoever forgot to pass it sees everything as
unread" is precisely the failure the argument exists to make unreachable.

**MIGRATION: drizzle-kit emitted a silent total data loss.** `generate` produced the
three `CREATE TABLE`s and the five `DROP COLUMN`s **with nothing between them**. Applied
as generated it destroys every read marker, tuck-away and pin in the database with no
error, no constraint violation, and three correctly-shaped empty tables left behind. The
`INSERT ... SELECT` backfill is the whole point of the migration and drizzle cannot infer
it, because a re-key is a DATA move that happens to have DDL either side. (It did NOT hit
POD-380's and POD-1075's `ALTER TABLE ADD <col> NOT NULL with no DEFAULT` fault — that
fault is a property of ADD COLUMN, not of re-keying, and the absence is recorded because
it is informative.)

Continuity test copies POD-1075's instrument: rewinds a REAL pre-migration database
(asserting `__drizzle_migrations` exists, so it cannot silently exercise FIRST BOOT —
POD-305), asserts the pre-state, and identifies every row BY KEY AND VALUE. The fixture
seeds markers with DISTINCT values, because an all-NULL fixture passes vacuously: "no
markers before, no rows after" is what a correct migration and a data-destroying one both
produce. Mutation-verified with two PRODUCT mutants, both killed, both reverted to a
byte-identical file (hash checked): deleting the session backfill, and swapping
`read_at`/`tucked_at` in the issue backfill SELECT — two TEXT columns of nullable ISO
strings, invisible to every schema and count assertion.

**THREE PINNED TRIPWIRES FIRED AND WERE REPLACED BY THEIR POSITIVE FORM**, not deleted:

- **POD-382** measured `read_at` as a column on the session ROW and said so honestly.
  It now measures the per-user row, and adds the assertion a column could not express:
  a different principal has no marker for the same session.
- **POD-311**'s `per-user-state-storage.tripwire.test.ts` is deleted, as its own header
  instructed, and `PER_USER_DELIVERY` flips `online-only` → `offline-eligible`. The
  recorded reason for `online-only` was that a queued write replayed against a SINGLETON
  column applies one principal's marker to every reader — a property of a table with no
  user in its key, not of the command. With the key in place these four match their
  session twins, two of which are POD-379's `markRead`/`markUnread`.
- **POD-1076 leaves the `willChange` corpus.** `oracle-presence.test.ts`'s
  characterization becomes a pinned must-not-change about the FEED (the unscoped
  broadcast serves one viewer to every DEVICE of one person), and POD-1076 is removed
  from `SUPERSEDING_ISSUES` — a landed issue left in that list keeps asserting that a
  pending change is still pending.

**POD-731's `workflows.assign` PIN-shaped warning: ADJUDICATED, CLASSIFICATION STANDS.**
A binding is `(target_kind, target_id) → revision`, one SHARED fact about a target, so it
is `personal` and inherits the target's owner. What changed is that its warning now has a
concrete destination: `@podium/model`'s `user-state/` family exists, so "my default
workflow for this repo" composes the one `perUserKey` fragment instead of being invented
beside it.

**POD-385's THREE UNCLASSIFIED PER-USER-SHAPED TABLES — one adopted, two declined, none
silently.**

- `recap_watermarks` — **ADOPTED**, as a matrix row and no migration. "How far did I get
  reading this transcript" is a fact about a reader, never shared, never grantable; D4's
  backstop answered `personal`, which is the WRONG class rather than merely an absent one,
  because `personal` IS shareable. It needed no re-key: the table is ALREADY keyed
  `(reader, session_id)`. Its key half may be an AGENT session rather than a human, which
  is deliberate and declared as a `PER_USER_WRITER_EXCEPTIONS` entry — two agents of one
  person hold independent cursors, so collapsing the key onto `userId` would silently MERGE
  them. The family's shape is (principal, entity); `userId` is the common case, not the
  definition.
- `notification_facts` — **DECLINED.** The steward's arbiter's once-until-ack claim
  ledger, keyed `(fact_key, target)` where `target` is a notification target, written by
  `system`. The family requires `writers: ['operator']` and `systemWriter: 'never-writes'`;
  forcing it in would be a false declaration. It is coordination state and belongs to
  POD-1194's adjudication.
- `message_wake_cooldowns` — **DECLINED.** One opaque `key` and an `attempted_at`; no
  principal in the key at all, and it is system-written rate-limit suppression rather than
  per-user view state. POD-1194's.

**Two behaviour changes, both strictly more correct, both recorded rather than absorbed.**
(1) A LAPSED timed snooze is no longer projected. The mirror never expired, so an expired
snooze surfaced until the next restart; the projection now reads `snoozes`, which prunes
lapsed timed snoozes on read exactly as it always documented. Three test fixtures used
fixed PAST deadlines that only round-tripped because of the mirror, and are now future
dates with the counterfactual pinned beside them. (2) A per-user write rides the write-seam
ledger, so the change reaches the replica rather than only the broadcast — which forced the
ordering rule below.

**THE ORDERING RULE, paid for twice.** `persist` builds its change payload from
`sessionWire`, which reads the overlay CACHE. The cache must be invalidated BEFORE
`changes` is built (inside `write`, after the row lands) or the change carries the
PRE-change value, the ledger's byte-dedup drops it as unchanged, and a durable write
silently stops being transactional with its own change record. It must ALSO be invalidated
in a `finally`, because that first re-read happens INSIDE the span and caches a value the
append can still roll back — without it, a failed append leaves the projection serving a
snooze that is not in the database, reintroducing one layer up the divergence the rollback
exists to prevent. Both were found by existing tests, not by inspection.

**Ratchet: `per-user-singletons` 8 → 2, baseline ratcheted DOWN; total sites 186 → 180.**
The two survivors are `IssueAutoArchiveObservation.readAt` and
`SessionAutoArchiveObservation.readAt` in `packages/protocol/src/maintenance.ts`, which are
NOT this issue's: they are a declared-legitimate validation gate over untrusted steward
input, and the open question they carry — "archived because WHO read it?" — is POD-1136's.
That question is now ASKABLE rather than unanswerable, because the value finally has an
owner.

`NOT_A_REPRESENTATION` 36 → 38, and the bump is reported as what it is rather than
buried: `IssueUserOverlay` and `NO_ISSUE_USER_STATE` are per-VIEWER projection arguments,
structurally the OPPOSITE of the defect the item counts, and the detector reads key NAMES
in a declaration so it cannot tell a shared row from a viewer-scoped argument (the same
blind spot recorded on `HANDOFF_BUNDLE_CORE`; reported to POD-368, which owns the
detector). The exclusion is keyed on the exact `(file, symbol)` pair, so re-adding any of
the three markers to `IssueRow`, `SessionRow`, `IssueWire` or the live `Session` is still
counted. **The audit is VANISHED, not MOVED, for the six cleared sites**: no declaration
anywhere in the repo carries `readAt`/`tuckedAt`/`pinned` on a session or issue row type —
grepped at the destinations, not inferred from the delta.

**Wire golden fixtures: PURELY ADDITIVE, zero deletions** — 82 added lines, six new family
schemas, nothing removed. That is what POD-1075 and POD-1076 are required to be.

**Left for others.** The COLLAPSE of the two pin mechanisms (inventory §7.1's "POD-1076
should collapse the two") is **POD-1200**, filed with a `discovered-from` edge. Both
mechanisms are now correctly keyed per user and both carry a `pinned_at` timestamp, so
their values are compatible; merging them is a wire and UI change across `PinState`'s kind
enum and every `issues.pinned` consumer, and POD-1076 closes without it. Personal
PREFERENCE keys stay POD-352's (Phase 3): splitting personal from instance keys is that
issue's surface, and re-keying half a settings blob here would leave the other half to a
second migration — the exact cost this family exists to avoid.

### Phase 2 — One sync kernel (POD-289) · exit gate POD-310 (HUMAN)

**Scope:** Authority (POD-305), Replica + Outbox + conformance (POD-306 → 369–373),
clients on the kernel with transactional storage (POD-307 → 374–378, human device gate
POD-377), wire cutover + version negotiation (POD-308), upstream retirement + federation
seam (POD-309), switch-latency harness survival (POD-736), **the watermarked scoped feed
(POD-1077 — multi-user, 2026-07-29)**.

**Ordering constraint (binding):** POD-1077 lands BEFORE POD-308. Per-principal filtering
added after the wire is frozen is a protocol break, not an optimization (ADR 2 D2 and its
2026-07-29 amendment) — the tracker edge POD-1077 → POD-308 is load-bearing.

**Cut lines:** kernel = infrastructure-neutral state machines + ports (L2); persistence
adapters own generic sync tables; app orchestrator owns global migration order (hot
file §5); feature-owned tables stay put. Internal snapshot fan-out dies here; the N/N-1
wire adapter is born here WITH its expiry registered in the deletion audit.

**Ledger obligations:** quantitative release-criteria THRESHOLDS are fixed in this
section during Phase 2 (measured at POD-337): cold startup, DB growth rate, sync lag,
outbox age + dead-letter count, gap-heal time, bootstrap snapshot time, reconnect-storm
behavior, render counts, memory per pane, zero-data-loss crash tests. The POD-310
upgrade-rehearsal runbook is committed into this section.

**Verification steps (gate POD-310, HUMAN):** rehearsal on the real local topology
(VPS + remote daemon + phone PWA), in-place DB upgrade, zero lost sessions, rollback
drill tested once; `podium issue needs-human` set at the gate. `podium issue tree 289`.

#### LEDGER ENTRY — POD-305 (2.1 Authority): in-place upgrade and its rollback

**What the schema change is.** One drizzle migration,
`20260730162954_change-provenance-envelope`: three NULLABLE columns added to
`changes` (`origin_id`, `causation_id`, `mutation_id`) per ADR 2 D8. Nothing is
dropped, nothing is rewritten, no table is rebuilt.

**Ownership moved in the same issue, and moving it is NOT a migration.**
`changes` and `applied_mutations` are now declared in
`packages/sync/src/adapters/sqlite/schema.ts` instead of
`apps/server/src/migrations/schema.ts`. `drizzle.config.ts` names an ARRAY of
schema files with ONE `out` directory, so drizzle-kit unions them and **global
migration ordering remains the drizzle journal** — folder-timestamp order plus
the snapshot `prevId` DAG. Verified rather than assumed: `generate` emitted only
the three `ALTER TABLE ADD COLUMN`s, i.e. the ownership move produced no DDL at
all. This supersedes §5's "app migration orchestrator owns global ordering" row
for these tables: there is no orchestrator, there is the journal.

A second `out` directory for the kernel's tables was considered and REJECTED —
two journals have no defined order between them, so a migration in one that
depends on a table created in the other is correct on the machine that authored
it and a boot failure everywhere else.

**Forward path.** Applied by the normal boot path: `store.ts` →
`runDrizzleMigrations`, inside drizzle's single boot transaction. A partial
apply is therefore not a reachable state.

**ROLLBACK: restore the automatic pre-migration backup.** drizzle has no down
migrations, and this issue adds none. The procedure is `backup.ts`'s
pre-migration copy (with the free-space preflight, f07d2683):

1. Stop the server.
2. Restore the pre-migration backup over `podium.db`.
3. Start the OLDER build.

The downgrade guard already refuses a newer DB against an older build, so
starting an old build against an un-restored database fails loudly instead of
silently mis-reading it.

**Why a hand-rolled reverse migration is NOT offered.** `ALTER TABLE DROP
COLUMN` on `changes` is available in modern SQLite, but the three columns are
additive and NULLABLE: an older build never selects them, so leaving them in
place is harmless and the only reason to drop them would be cosmetic. Offering a
reverse step that touches the change log to achieve nothing is strictly more
risk than not offering one.

**Seq continuity is the property under test, and it is pinned.**
`apps/server/src/migrations/change-provenance-upgrade.test.ts` upgrades a REAL
database in place and asserts what the NEXT append is given, not merely that the
migration succeeded. A restarted `seq` is silent on both sides — every replica
cursor would sit above the new head, `changesSince` would return nothing, the
client would look up to date forever, and nothing would heal, because a future
cursor is not a gap. One case covers a head-PRUNED log, which a naive `MAX(seq)`
check would pass while the product broke: pruning deletes the oldest rows, so
`MAX(seq)` is unmoved while a rebuild would reset `sqlite_sequence` BELOW the
highest seq ever assigned, and two changes would then share one position.

Mutation-verified: appending `UPDATE sqlite_sequence SET seq = 0` to the
migration fails the three seq assertions and PASSES the row-preservation and
NULL-column ones, so the test fails when seq restarts rather than only when the
migration errors.

#### LEDGER ENTRY — POD-1077 (2.8 watermarked scoped feed): which half shipped

**What landed.** ADR 2 Amendment 1 D12–D14's producing half, in the kernel. The feed is
per principal: `Authority.subscribe(principal, subscriber)` and
`Authority.changesSince(cursor, principal)`, with no unscoped overload of either, and
`FeedPublisher.connect(id, fromSeq, principal)` / `publish(principal, delivery)`. The four
tripwires POD-305/POD-306/POD-351/POD-390 pinned all went red and were replaced by their
positive form, assertion for assertion.

**The design decision worth carrying forward: the range travels with the filter.** D13
requires the filter and the watermark together, and POD-351 stated the failure exactly — a
suppressed row nobody certifies is a hole, the replica heals, the heal returns the same
filtered rows, forever. That is prevented by a TYPE rather than by a rule: `ScopedDelivery`
carries `throughSeq` beside `changes`, so there is no way to hand the framing side a
filtered list without the range the filtering covered. The dangerous outcome was never
"scoping does not work" — it was "scoping works and the client silently never converges",
so every suppression case in the suite also asserts where the receiver's position ends up.

**Two other shapes chosen to make a mistake unrepresentable rather than forbidden.**
`evict` vs a re-admitting `upsert` is derived from the policy at the anchor seq, never
named by a caller; a caller who could name it would be an oracle for what another
principal may see. And `rescope` (D14.4) is an ARM of the delivery, chosen from the size of
the derived set — `FeedPublisher` has no `rescope` method at all, as a module function
rather than a `private` one, because TS `private` is compile-time only and a guard
asserting its absence would have had to be written against a type a cast defeats.

**Watermarks are free, structurally.** D13.4 says watermark-only frames must not demote a
replica. A watermark never enters the bounded send queue: it sits in a per-connection
coalescing slot where a run collapses to one certified range and the next visible frame
absorbs it by extending downward. A 500-frame suppressed firehose against a one-frame
bound leaves the connection undemoted and at the head.

**WHICH HALF SHIPPED — the qualifier that bounds every claim above.** The MECHANISM, not
the mechanism plus a trustworthy principal. POD-1075 made a principal *expressible*
(`UserAccount`, per-user `client_sessions`, grant edges as model types); it did not make
one *distinguishable on a connection*. `packages/runtime/src/auth-store.ts` is still one
shared password and `apps/server/src/gateway/client-principal.ts` still asserts
`CLIENT_PRINCIPAL_GRADE === 'device'`, so two connections presenting that password are the
same person as far as any server-side check can tell. POD-390's phrasing is the one to
keep: *a column that CAN name a person is not an authenticator that DOES.*

So the two shipped composition roots (`Ledger`, `WriteFunnel`) name
`DeviceGradeUnscopedPolicy` — exported under a name that says what it is, held to a
two-entry allowlist by `bun run audit:scoped-feed`, and deleted outright when per-user
login lands, which is what forces every site to name a real policy. Wiring the grant-edge
policy onto a device-grade transport would have produced a system that LOOKS scoped and
whose slices are decided by a credential everyone shares — the worst of the two states,
because it reads as privacy.

**Conformance moved one property across the fixture line.** POD-306's `binding.test.ts`
recorded that "the log, the clock and the visibility policy are the fixture's". The policy
was the last thing the seven scoped gates were certifying on the kernel's behalf; the
DECISION is now `GrantEdgeVisibilityPolicy` and the fixture keeps only the tables. The
binding case that proves it is the one a stub cannot pass: the kernel refuses an entity
kind the FIXTURE granted, because that kind carries no declared visibility class.

**Unclassified is distinguishable from personal.** ADR 9 D4's default-closed backstop
answers `personal` for both a deliberate classification and a missing one, which is a gate
that cannot notice an entity class arriving unclassified. `VisibilityStatePort.classOf`
returns `null` for an undeclared kind and the policy refuses it with its own reason. Both
outcomes are invisible — that keeps the failure safe; they are separately observable —
that lets a test, a gate and an operator tell a decision from an omission.

**Verification.** Workspace typecheck `--force` (23/23, `Cached: 0 cached`), instrument
probed with a `@ts-expect-error` that reported TS2578. `packages/sync` 574 passed;
`apps/server` 3024 passed (the one worker-SIGILL file passes isolated); scripts lane 371
passed with `loop-split-load` red, which is the host-load flake named in the fan-out
brief. `check-boundaries` 0 new, `rearch-audit` 25 items / 186 sites baseline exact,
`check-no-nul-bytes` ok, `audit:scoped-feed` probe + gate green. Three mutants applied one
at a time, each verified to compile and to revert cleanly: dropping the watermark emission
(killed by 5, including the running-object audit), removing the filter (killed by 11), and
`evict` → `remove` (killed by 3).

**Handed forward.** POD-308 owns the wire cutover — `evict` reaching the pre-cutover wire
throws rather than degrading to `remove` (D14.5), in both composition roots, so the day
someone wires a real policy without the cutover is a loud failure. D13.5's watermark
CADENCE is a measured threshold and stays POD-337's; `Authority.watermark(principal)` is
the operation it will call. Real share/unshare commands stay Phase 3's (POD-290).

#### LEDGER ENTRY — POD-309 (2.5 retire the upstream sync/forwarder): the two-directional claim

**THE JOB WAS TWO OBLIGATIONS THAT FAIL IN OPPOSITE DIRECTIONS,** and naming that was the
first useful thing. [spec:SP-0371] says the rewrite must NOT deliver hub/node federation
AND must NOT make choices that prevent a future hub. The retirement rots by RE-GROWTH — a
`new UpstreamForwarder(` reappearing, a `forwardIssueMutation` dep coming back with a
well-meaning refactor. The seam rots by ATTRITION — nobody deletes it, they bake an
assumption into it: a `@trpc/client` import lands in `authority/`, `suite.ts` starts
naming the one instantiation that exists, `ChangeProvenanceFields` loses `causationId`
because nothing reads it today. Every attrition case compiles and passes every test, and
each one makes a future hub a flag day. The deletion ratchet covers the first direction
and is STRUCTURALLY incapable of covering the second: a ratchet counts what is PRESENT and
must go down, so it cannot notice something that vanished. Hence a second gate whose
checks are mostly PRESENCE claims.

**WHAT THE FORWARDER STILL DID THAT THE KERNEL DOES NOT — nothing H1 needs, measured
before planning as the brief required.** Its durable FIFO queue with backoff, poison-drop
and watchdog pacing is a strict SUBSET of the kernel Outbox (POD-306: ordering partitions,
dead-letter *with* a recovery leg, age limits, principal binding). Its `mutationId`
idempotency is `MutationLedger` (POD-382, the ONE implementation). Its
`optimisticIssuePatch`/`PATCH_ID_FIELDS` overlay is superseded by `replica/overlay.ts`,
whose retirement is EXACT via `causationId` rather than value-shaped. `UpstreamSync`'s
cursor/gap/heal ladder is ADR 2 D7's ladder, now built on feed identity, `minAvailableSeq`
and resync-required rather than on a persisted integer. What was genuinely unique to it
was the federation part alone — a WS+tRPC dialer carrying a hub-minted cookie, `viaHub`
ingest, and `upstream_outbox` — i.e. exactly the H2 behaviour this issue removes. POD-305
asked which of `mirror.ts` / `upstream.ts` this issue deletes: **upstream**. The transcript
lake survives; its `node:fs` use is unrelated to federation.

**THE RATCHET: `upstream-sync-forwarder` 4 → 0, deletion audit 179 → 175 sites, and it is
4 VANISHED / 0 MOVED.** Reported by grepping DESTINATIONS, not as a delta (POD-1180). The
two class declarations and the two construction sites are gone, and a repo-wide grep for
`UpstreamSync|UpstreamForwarder|UpstreamIssuesService|upstreamMirrorFor|setUpstream*|
forwardIssueMutation|issueWrite` outside comments returns nothing: no file declares,
constructs, or calls any of them. Every surviving mention is prose explaining what was
removed, and those stay legal — a retirement nobody can describe is a retirement nobody
can audit — which is why the new gate scans COMMENT-STRIPPED text and proves the stripper
non-vacuous in both directions.

**`issueWrite` WAS UNWRAPPED AT 28 CALL SITES rather than left as a pass-through.** With no
second authority its body reduced to `return local()`. Keeping a contentless wrapper is the
cheap option and the wrong one: it still reads as a policy seam, and the next author to add
a branch to it would be re-growing the forwarding path by accident.

**FORK RESOLVED — `resolveServerRole` no longer reads `config.upstream`.** The heuristic
("a server dialing a hub is a NODE, so inbound pairing is off") named an H2 deployment
shape whose input can no longer exist; a branch whose input is unreachable is dead code
that reads as policy. ADR 5 D2 says the H1 server IS the rendezvous for its clients and
daemons, and D5 says "daemon pairing and fleet admin STAY", so the default is `hub: true` —
byte-identical to every non-node deployment. The explicit override survives in BOTH
directions and is now the only way to reach `hub: false`, which `server.role.test.ts`
asserts per direction (a default of `true` makes a single-direction test indistinguishable
from `return { hub: true }`).

**FORK RESOLVED — the pending rows are PARKED IN PLACE, and the rejected option is the
interesting half.** ADR 5 D8 permits archiving the schema and forbids silent discard of
poison/pending work. The literal reading of "one-shot migration parks the rows" is a
drizzle migration renaming `upstream_outbox`, and that is the ONE option that destroys
them: `drizzle-kit` resolves renames INTERACTIVELY and this repo generates
non-interactively ([spec:SP-4428]), where the same schema edit emits DROP + CREATE — in one
transaction, at boot, silently. So the table keeps its name and contents, every WRITER is
deleted (only `SyncRepository.listParkedUpstreamMutations` survives, and
`parked-upstream.test.ts` asserts the writers' ABSENCE on the running object rather than
grepping for a name a rename would satisfy), and `reportParkedUpstreamMutations` reports
anything parked at EVERY boot on two channels — a warning naming each mutation, because a
durable event is invisible in a terminal, and a durable `upstream.retired_pending` event
carrying the same list, because a journal rotates. It reports every boot deliberately: a
once-only flag would miss precisely the operator who inherits the box later.

**THE SEAM PROOF IS TEST-ONLY, AND IT IS NOT A REHEARSAL.** ADR 5 D8's seam proof is "a
second in-memory Authority against kernel ports". `second-authority.seam.test.ts`
instantiates two real `Authority` objects over two independent in-memory port sets and
asserts they share NO state — B's first row is seq 1 while A has already assigned 1 and 2,
which is what a module-level counter or a shared baseline would break — and that each
carries its OWN `FeedIdentity`, so seq 1 exists in both feeds and means two different
things. Nothing replicates A into B, transfers authority, prevents a loop or survives a
hub disappearing: those are POD-353's, and building them under the banner of "proving the
seam" is how a deferred feature returns as test code nobody admits to owning. The standing
control is a case asserting BOTH authorities accept writes — an authority that refuses
everything satisfies every isolation claim in the file perfectly.

**S5 GOT AN HONEST NULL RESULT rather than a manufactured one.** `instantiation.ts` lists
POD-309 as a hop that supplies a `SyncInstantiation`. It supplies none, deliberately: this
issue DELETES a hop rather than adding one, and inventing a second storage adapter to
satisfy the letter of S5 would be a suite certifying its own fixture. What is checked
instead is the property a future hop actually needs — that `suite.ts` never NAMES
`inMemoryInstantiation`. A suite that reaches for the one instantiation that exists is
parameterized on paper and unrunnable by anyone else, which is the failure
`instantiation.ts` warns about in its own header.

**THE SWEEP, recorded as required — and it is a null result.** No federation acceptance
criterion remains in the plan. `docs/rearchitecture-v3.md` mentions the hub in exactly two
places and both are correct: §1's HUB DEFERRED declaration, and the Phase-2 scope line
naming this issue. POD-289's own AC is the meta-criterion ("no fake federation acceptance
criteria anywhere in the phase") and it holds. The four deferred behaviours — authority
transfer, upstream projection, loop prevention, hub disappearance — were already
enumerated in POD-353 before this issue started; they were verified present, not added.

**EVIDENCE.** Workspace typecheck FORCED 23/23 with `Cached: 0 cached`, exit 0, and the
instrument PROBED (a planted `TS2322` was reported at the expected line, then reverted).
`check-boundaries` 56 allowlisted / 0 new; `check-no-nul-bytes` clean; deletion audit exact
at the ratcheted-down baseline; `audit:seam` probe + gate green. FOUR mutants, one per run,
each verified match-count 1, hash changed, grep-back, only the target dirty, and COMPILING
before being believed: (1) `reportParkedUpstreamMutations` short-circuited to `return 0` →
killed by 2 cases; (2) an `enqueueUpstreamMutation` WRITER re-added to `SyncRepository` →
killed twice, by the runtime absence assertion AND by the source gate's
`R-retirement-holds`; (3) `suite.ts` defaulting its parameter to `inMemoryInstantiation` →
killed by `S5-parameterized-suite`; (4) `FeedIdentityRegistry` minting one shared identity
→ killed by the S1 case. Mutant (2) is the one worth keeping: it compiles, it is a
plausible refactor, and only the paired gates catch it.

**Handed forward.** POD-308 owns the wire cutover and its brief names the same
`upstream-sync-forwarder` ratchet item; it is now 0, so POD-308 inherits a win rather than
a target — on a `scripts/rearch-audit-baseline.json` conflict, take the LOWER number.
POD-353 starts from a green dual-Authority proof and a gate that will tell it if the seam
drifted while it waited.

### Phase 3 — Command registry as the universal write surface (POD-290) · exit gate POD-424

**Scope:** L1/L3 split + framework (POD-311), session mutations (POD-312 → 379–382 +
handoff POD-642), superagent/fleet/specs (POD-313 → 383–386), derived router (POD-314),
command security (POD-315), offline classes + outbox UX (POD-316), secrets/preferences
split (POD-352 → 418–421), agent-mail (POD-640) and workflows (POD-641) routers
(post-freeze additions, gate via the POD-314→POD-315 chain), **Telegram identity binding
(POD-1080 — multi-user, 2026-07-29)**.

**Cut lines:** contracts at L1, handlers at L3, joined at composition roots.
The Telegram bridge still has no tRPC mutations — no migration child, and its reactions
remain POD-321's business. What multi-user adds there is narrower and different: per-user
superagent makes the *inbound* Telegram edge an AUTHENTICATION surface (an arriving message
must resolve to a user via a claim-code binding; unknown chats fail closed), which is
POD-1080, not a mutation migration.

**Verification steps (gate POD-424):** no hand-written mutation procedures (audit);
authz matrix green across four transports; offline classes + dead-letter UX
runtime-verified; secrets split complete; ledger + as-built updated.
`podium issue tree 290`.

#### LEDGER ENTRY — POD-383 (3.3a superagent thread contracts): the dedupe, and what decided it

**Seven contracts, one visibility class, and the class was READ rather than copied.**
`sendTurn · interruptTurn · openInTerminal · clear · restart · startBtw · concierge` are
now L1 contracts in `packages/commands/src/superagent/`, joined to `SuperagentService` in
`modules/superagent/registry.ts`, with the `superagent:` router derived from the table.
All seven write ONE row on ADR 1's matrix — `superagent-state` — which ADR 9 D8 S2
classifies `personal` ("MY threads never surface in YOUR sidebar"). Deliberately NOT
`per-user-state`: that class is for a facet whose value DIFFERS PER READER, and a thread's
history, binding and turn machine are one fact owned by one person.

**The assertion that pins it needed a probe to mean anything.** `visibilityClassOf()` is
TOTAL and default-closed — it returns `'personal'` for a row id it has never heard of,
which is every superagent contract's answer. Asserting the constant against it without
first proving the row RESOLVES is a check that passes against a typo. The suite therefore
asserts the row is declared, then asserts the class, then shows the backstop firing on a
row id that does not exist. The same shape POD-731 used, and the reason it is used again is
that the failure it prevents is invisible in a green run.

**WHICH NAME SURVIVED WAS A MEASUREMENT, NOT A PREFERENCE.** `superagent.send` and
`superagent.sendTurn` were two procedures with byte-identical input schemas and one body,
both forwarding to `SuperagentService.sendTurn`. POD-1075's precedent is that PERSISTENCE
decides between two names for one thing. The census: ELEVEN call sites name `sendTurn` —
apps/web `SuperagentView` and `ChatView`, apps/mobile `SuperagentScreen`,
`packages/client-core`'s engine, and the browser e2e that asserts on the outgoing request
URL — and ZERO name `send`. The alias's own comment ("the generic entry the panel uses")
was already false. It is DELETED, not re-homed or deprecated: tRPC serves by name over
HTTP, so a client bundle older than this change would 404 on `send`, and that caveat is
recorded rather than glossed — but a deprecation window would preserve a name nothing has
ever sent, which is precisely how a fork survives a dedupe.

**Delivery classes were decided per command, and the matrix row is NOT the answer.** The
`superagent-state` row says `offline: offline-eligible`; that is a statement about
REPLICATING THE ROWS, not about QUEUEING THESE COMMANDS, and conflating the two is how an
outbox learns to replay a harness turn. Six of the seven govern a LIVE harness and refuse
on liveness (a turn in flight, the terminal lock) — a refusal conditioned on liveness
cannot be honoured at drain time, when the world has moved. `startBtw` runs no turn, upserts
one row and is idempotent, so it is the one `offline-eligible` contract. Nothing names
`outbox`: ADR 3 D3 serves a transport because a contract NAMES it, never because a class
would have permitted it.

**Machine `use` on three, and the line is where code can run.** `sendTurn`, `concierge` and
`openInTerminal` place work on owned compute (readiness §3.1.4 M2's code-execution
boundary), which forces `online-only` via D18.3 and
`distinguishesUnauthorizedFromUnreachable: true` via M5 — a pairing
`classificationErrors` enforces. `interruptTurn`, `restart`, `clear` and `startBtw` place
nothing; classifying every touch of a running process as `use` would make the verb mean
"near compute" instead of "may cause code to run".

**THE ANCHOR FOLLOWED THE CODE, and the report says which of MOVED and VANISHED happened**
(POD-1180's lesson, applied rather than cited). The duplicate PROCEDURE VANISHED: no file
in the repo declares `superagent.send`. The surviving CALL MOVED: `ctx.superagent.sendTurn(`
in `router.ts` became `s.sendTurn(` in the joined table, because the router is now derived.
A detector still scanning only `router.ts` would have read the move as a win — its own
throw guard fired instead, which is the guard working. Both homes are scanned now, so
re-adding the alias in either is still counted. `send-turn-duplicate` 1 → 0; deletion audit
194 → **193 sites**, 25 items, baseline ratcheted DOWN.

**Two instruments, because neither is sufficient.** `scripts/audit-superagent-commands.ts`
resolves no modules and reads source text; `modules/superagent/derived-surface.test.ts`
inspects the ASSEMBLED `appRouter` object. POD-732's standard is that "an empty router
satisfies every absence claim perfectly", so the runtime arm asserts the POSITIVE first and
on the same procedure map — the seven are served as mutations, the two reads as queries,
the nine paths are exactly those nine — before it asserts that `send` is absent. Mutation
evidence: re-adding `send:` to the joined TABLE does not compile (`satisfies
Record<SuperagentContractName, …>` rejects the key, TS2353) and is reported as INVALID
non-evidence; the VALID kill is a hand-written `send:` procedure in the router, which
compiles and is caught three ways — source gate, runtime test, and the deletion ratchet.

**One defect this run's rules caught that vitest could not.** The derived procedure's output
type was `ReturnType<handler>`, and four handlers are `async`, so tRPC wrapped an already-
Promise output and shipped `Promise<Promise<{…}>>` to the client. Every server test stayed
green; `apps/web` failed to typecheck against `PodiumClientApi`. `Awaited<>` is the fix, and
the workspace typecheck is what found it — the in-package one said nothing, because the
damage lands at the consumer.

**Left for POD-386 (3.3d):** the machines/repos/specs half of the cutover. The superagent
router is done here because a contract table with no dispatcher is mechanism without
coverage; POD-386 inherits a router whose superagent arm is already derived and audited.

#### LEDGER ENTRY — POD-386 (3.3d cutover + router audit): what was actually left, and the gate that composes

**Four fifths of the deliverable was already done, and finding that out was the first
job.** The brief pointed at POD-311/POD-640, which each turned a redesign into a
re-pointing after measuring. Same here: POD-383 derived the superagent arm, POD-384 derived
machines/repos/discovery and moved the hub gate into the contract, and each shipped a paired
audit. The census below is the measurement — 34 hand-written `.mutation(` in `router.ts`,
of which the 3.3 families held exactly **three**, all in `specs`. POD-385's scope stopped at
L1: it declared the three spec contracts with `exposure: ['trpc', 'relay', 'cli']` and
repointed `specsInputs` at their schema instances, but `router.ts` still built the
procedures by hand — a contract declaring a transport that nothing derived. That is the
whole cutover that remained, and it is now `modules/specs/registry.ts` + `trpc.ts`.

**FORK RESOLVED — no `serverRole` gate on the spec family.** The fleet derivation picks its
base procedure from each contract's `serverRole` because three of its ten are hub-only. No
spec contract declares one, and ADR 3 D3's content is that a transport is served because a
contract NAMES it; deriving a gate from a field nobody declared would invent the field.
What actually decides a spec write is the repo-root allowlist inside `SpecsService`, which
every transport already runs and which this issue deliberately did not move.

**SEVEN LOCAL ABSENCE CLAIMS DO NOT COMPOSE INTO A GLOBAL ONE, and that is why the second
gate exists.** `audit:sessions`, `audit:workflows`, `audit:issues`, `audit:mail`,
`audit:superagent`, `audit:fleet` and the new `audit:spec` each say "no hand-written
`.mutation(` in MY routers". Every one of them is true of a `router.ts` that grew a
brand-new router full of hand-written writes, because no audit owns a router nobody has
claimed. `audit:router-mutations` reads the whole file: every top-level `t.router(` literal
is accounted for exactly once — derived family, or `pending` with its remaining keys and
owning issue — and a router in neither list is a finding. The total is ratcheted (31, down
from 34) AND the membership is named, so a decrease must say WHICH key vanished. A bare
delta is what POD-1180 exists for.

**THE SETTINGS GUARD IS A TWO-DIRECTION CLAIM, which is the unusual part.** POD-313's own
title carves settings out of this phase ("settings via #352"), so the obligation is that
settings is UNTOUCHED — and a settings write DISAPPEARING is as much a failure as one
appearing, because a cutover that quietly absorbed somebody else's surface would read as
progress on every ratchet in the repo. The census enforces it with no ratchet relief.
`router.settings-guard.test.ts` asserts the same against the RUNNING `appRouter` — the exact
procedure set and the exact verbs, by whole-map equality rather than four `toBeDefined()`
calls, which cannot see an extra — plus the check the source scan structurally cannot make:
that no `*_CONTRACTS` table in `@podium/commands` names a `settings.*` command. A
`...settingsFamily` spread would have left `router.ts` textually clean while migrating the
whole surface.

**A PARSER BUG THAT WAS LIVE IN THE CENSUS'S FIRST DRAFT, recorded because the shape
generalises.** The per-family audits anchor the procedure key on a fixed indentation
(`\n\s{4}(\w+):`), which is correct only because their routers happen to be flat. Applied
file-wide it names the last field of an inline `z.object({…})` as the procedure:
`conversations.setMeta` was recorded as `conversations.summary`, and the both-directions
check then fired on four routers nobody had touched. The key is now chosen by nesting
DEPTH — of the keys before the mutation, the last whose value begins no deeper than the
mutation itself — and that exact shape is in both the `--probe` fixture and the lane test.
The general form: an anchor that rides on formatting is an instrument that reports the
formatting.

**MUTATION EVIDENCE, four mutants, one per run, each compiled before it was believed.**
(1) Deleting `settings.telegramSetupStart` → killed by the census as `settings-guard` AND
by two cases of the running-router guard. (2) A hand-written `specs.smuggled` mutation
planted after the derived spread → killed by `audit:spec` and by the census's
`derived-family-clean` and `ratchet`; `tsgo` exit 0, so this was a valid mutant and not a
compile failure misread as a kill. (3) Dropping `...specFamily` → killed by the
presence check, which is what stops the absence checks being satisfiable by deletion.
(4) Restating `specsCreateInput` as an identical inline `z.object` → **compiles, and
PASSES `mutations-wire-golden.test.ts`**, killed only by the `toBe` identity assertion and
the new textual check. That is POD-305's finding reproduced end to end: a restatement is
byte-identical on the wire and invisible to every golden fixture.

**Deletion audit: 61 → 58 on `router-triple-access`, and it is 2 vanished + 1 MOVED.**
Three `mods(ctx).specs.<verb>` reach-throughs left `router.ts`; one came back as a single
`mods(ctx).specs` in `modules/specs/trpc.ts`, because the derivation reaches the service
once for all three. The detector scans `router.ts` only, so it reads the relocation as part
of the win. Not extending it was deliberate and is argued in
`docs/rearch-deletion-audit.md`: the same extension would have to cover
`modules/fleet/handlers.ts` (POD-384's seven) in the same breath, which raises the number
mid-phase and buries three real deletions under a definitional change. Widening that
detector belongs to POD-314's cutover; POD-1180 already records the blind spot.

**Deliberately NOT done.** The twelve `pending` routers are recorded, not migrated —
`cloud`, `setup`, `auth`, `automations`, `approvals` and the rest are POD-314's, and
`settings` is POD-352's. Growing this diff to cover them is the round-trip this run cannot
afford; the census is what makes leaving them explicit rather than invisible.

**POD-420 (3.7c) — the settings WRITE family, and the settings guard converted from ABSENT
to DERIVED-SURFACE-EXACT.** The paragraph above about the guard's third claim ("no
`*_CONTRACTS` table names a `settings.*` command") described the state until #352's
children arrived. `SETTINGS_CONTRACTS` now names four, and the guard's contract half is an
exact correspondence instead of an emptiness check: every `settings.*` contract declaring
`trpc` must be served as a mutation, and every served `settings.*` procedure must be either
a contract or one of three NAMED hand-written exceptions. **Both directions and no ratchet
relief survive the conversion** — whole-map equality on names AND verbs — because the
reasoning that made the guard worth having generalises past settings: an absorbed surface
reads as progress on every ratchet. The conversion was mutation-verified against POD-386's
own mutant (deleting `settings.telegramSetupStart`) plus its contract-side twin, and
`describe('this guard can say NO')` plants both new defects — a settings write no contract
names, and a contract the router does not serve.

**ONE CONTRACT PER MATRIX ROW, which is the content of the split.** The blob's members sit
on three rows with three visibility classes and two offline classes; `visibility` is
required and single-valued, so a contract over the whole blob cannot be classified without
lying about two thirds of what it writes. `settings.updatePersonal` (per-user-state,
offline-eligible, member) · `settings.updateInstance` (deployment-substrate,
offline-eligible, admin) · `settings.setSecret` / `settings.clearSecret` (secret,
online-sensitive, admin, confirm, never outbox).

**THE PREFERENCE PATCH IS ADDRESSED BY CLASSIFIED PATH, and the schema is the gate.** A
blob-shaped partial can express a secret, so a preference command over one needs a
handler-side detector — and a detector that misses one key fails open. Addressed by path,
`{ 'apiKeys.openai': … }` is refused by `settings.updatePersonal`'s own input schema before
a handler exists, by TWO independent mechanisms (the tier check and POD-418's may-enqueue
backstop), which is ADR 9 D4 point 2's shape.

**OFFLINE-ELIGIBILITY ARGUED PER TIER rather than copied from the row's column**, following
POD-735's precedent for departing from a written column. The test is what the write does
while queued and when replayed late: a preference is INERT (it arms nothing and executes
nowhere), and `autoContinue.enabled` — the member that gave pause — is still inert as a
write, because it is a boolean the loop reads when it next runs, not a command that starts
one. That is the D18.3 line. The two tiers differ in their conflict story (single-writer
`(userId)` vs the only surviving field-LWW group), so they carry two reconciliations rather
than one shared cell, and a test asserts the texts are not the same object.

**Exposure is `trpc` only, MEASURED.** `relay.ts` has no `settings` arm, there is no
`podium settings` CLI verb and no settings MCP tool — POD-385's defect is declaring a
transport nothing dispatches. The preference contracts are `offline-eligible` and still do
not name `outbox`: the class says "may be queued", the exposure says "nothing queues it
yet", and `audit:settings` pins that no client outbox executor names a settings command so
the day one appears the decision is retaken deliberately.

**The structural half: `settings.set` now REFUSES a secret change.** Derived from
`SERVER_SECRET_KEYS`, so a secret added to the model becomes unwritable-by-blob on the same
commit — not a detector over key names, which fails open on the one it misses. It compares
VALUES, not mentions, because the shipped clients round-trip the whole blob including the
secrets they were served. Two existing suites configured a Telegram token through the blob
and now fail correctly; both were repointed at `setSecret`.

**The fingerprint producer POD-418 specified and did not build.** `HMAC-SHA256(serverKey,
domain ‖ key ‖ value)` truncated to 8 bytes, under a persistent 0600 key in the state dir
(`readOrCreateDaemonSecret`'s race shape). Never a bare digest: a provider key is short and
highly structured, so an unsalted digest of one is brute-forceable by anyone holding the
projection. The two load-bearing assertions are claims about the OUTPUT — it must not equal
the bare digest in any obvious spelling, and it must CHANGE when the server key changes —
because "we used an HMAC" is a claim about source text a reviewer is already reading.

**`audit:settings` is the ninth family gate**, paired with the running-object guard, with
`--probe` fixtures for all five checks and a parser anchored on BRACE DEPTH rather than
columns (POD-386's indentation defect and POD-301's line-split defect, both planted in the
clean fixture as decoys).

### Phase 4 — Node decomposition (POD-291) · exit gate POD-425

**Scope:** gateway + plane inventory implementation (POD-317 → 387–391), fleet service
+ one machine identity (POD-318), SessionService split (POD-319 → 392–395), IssueService
recomposition (POD-320), declarative acyclic composition + reactions registry (POD-321),
memory service (POD-322), orchestrator/attention/telemetry boundary review (POD-355),
instance-vs-machine identity (POD-645, [spec:SP-15aa], post-freeze addition),
**presence rooms + subscriptions (POD-1078) and machine ownership + grants (POD-1079)** —
both multi-user, 2026-07-29.

**One primitive, two consumers:** POD-1078's room/subscription registry is the SAME
mechanism POD-1077's scoped feed needs for per-principal routing. It is built once, at
POD-387/POD-317, and consumed by both — building it twice is a gate-blocking defect.

**Verification steps (gate POD-425):** composition root acyclic (topological test);
god-object audit items zero; module graph doc committed; session/issue/memory e2e green;
live redeploy keeps sessions; multi-instance isolation suite green through the
decomposition. `podium issue tree 291`.

#### LEDGER ENTRY — POD-1079 (4.11 machine ownership and grants): which half shipped

**WHICH HALF: the see/use/manage grant MECHANISM, not a principal the transport can
authenticate.** The brief demanded this be said explicitly, so: `machines.owner_user_id`
is a real column, the `grants` edge table has its first writer and reader, the fleet
family enforces `roleFloor` and `machineVerb` per command, and the handoff gate
classifies its refusals. What did NOT change is `packages/runtime/src/auth-store.ts` —
still ONE SHARED PASSWORD, `CLIENT_PRINCIPAL_GRADE` still `device`. Every authenticated
connection still resolves to one `UserId`, so the gate below CAN refuse a second person
and today's login cannot produce one. POD-1077's pattern is copied rather than
re-invented: the placeholder is NAMED (`deviceGradeSoleOwner()`, `apps/server/src/
device-grade-owner.ts`), held to three declared sites by `bun run audit:machine-grants`,
and DELETED OUTRIGHT when per-user login lands so every site becomes a compile error
that has to name a real principal.

**THE SEAM POD-1075 LEFT IS THE SEAM THAT WAS FILLED, and no call site changed.**
`ownershipFromMachines` carried two comments reading "POD-1079: read `row.ownerUserId`
here" and "read the grant edges here". Both are now reads. Machine ROWS come through
`MachinesService`'s cache (invalidated by every write); GRANTS deliberately bypass it,
because ADR 9 D2 rule 4 evaluates an edge LIVE and a cached grant is the
revoked-share-that-keeps-working failure the rule exists to prevent.

**NULL OWNER IS A VALUE, NOT AN ABSENCE.** `machineUseAllowed` already gave `owner: null`
a meaning — an owner-less machine grants `use` to NOBODY — so the column is nullable and
a row whose writer never named an owner is unusable, loudly, rather than usable by
everyone. The upgrade backfills existing rows to `'user:sole'`: D6 M3 ("private to its
pairer") evaluated in a world with exactly one pairer, not a widening. No grant rows are
written by the migration, because sharing is a deliberate act (D2 rule 3).

**OWNERSHIP FLOWS FROM THE PAIRER, STAMPED AT MINT.** `PairingGrant` gained
`ownerUserId`, set when the code is minted and carried opaquely to redeem, so the daemon —
which supplies everything else in the pair frame — has no say in who owns the machine it
becomes (ADR 3 D7: identity is never read from a payload). `ON CONFLICT` COALESCEs, so a
re-pair is not a takeover while a legacy NULL row can still be adopted, and `revokeMachine`
deletes the machine's edges because a daemon keeps its id across revoke/re-pair.

**THE FLEET GATE IS DERIVED, AND THE ORDER OF ITS TWO QUESTIONS IS THE DECISION.**
`modules/fleet/authz.ts` reads each contract's own `roleFloor` then its `machineVerb`;
`trpc.ts` runs every derived procedure through it, so a fleet command added tomorrow is
gated by what it declares. POD-384's reasoning is preserved rather than re-derived: a
`member` CLEARS the floor on the nine, which is what keeps D6 M1's owner column
reachable, and the real refusal is the per-machine row gate. A principal whose account
row is missing, unreadable or disabled satisfies NO floor; a SYSTEM principal clears
every floor, because it is in-process only (D21.2) and inventing an `admin` role for it
would be the service account D8 S5 rejects.

**FORK RESOLVED — how to gate a command that names no machine.** `discovery.refreshRepos`
takes `z.void()` and fans out over every online machine. Refusing it whenever one machine
belonged to somebody else makes a shared instance unusable; scanning them all walks a
colleague's filesystem through their daemon, which is what `use` is a boundary against.
So the fan-out is NARROWED — `scanReposAll` takes the principal's predicate — and refused
only when it would reach nothing, which the caller must be able to tell from "no daemons
online". An omitted machine selector is gated against `defaultMachine()`, never waved
through: otherwise the whole repo family is ungated by leaving a field out.

**FORK RESOLVED — ownership does not travel on the wire.** `ownershipRows()` is a
separate method from `listMachines()` on purpose. The listing is the wire projection, and
putting an owner id on `MachineWire` would disclose the fleet's ownership graph to every
principal that can `see` a machine — a decision nobody made, and one the gate does not
need, because refusals are computed server-side. `audit:machine-grants` checks the schema
block, not the file.

**POD-643's REQUIREMENT, DISCHARGED.** Handoff refusals now carry the three-arm reason at
the point the refusal is DECIDED, not at the daemon frame where it is eventually reported
— the server refuses before it dispatches, so a frame-only classification could never
carry the server's own denials. `absent` maps to `unknown-target`, never `unauthorized`:
`machine-access.ts` answers one thing for "no such machine" and "outside your see set",
and re-deriving that distinction here would rebuild the existence oracle the lower layer
refuses to build. An Error SUBCLASS rather than a result union, because every existing
caller handles a throw and a parallel result path would be ignored by all of them.

**DELIBERATELY NOT DONE — `machines.share` / `machines.unshare`.** ADR 1's matrix assigns
those commands to Phase 3 / POD-290 in the `grant-edge` row's own `sites` field, and
building them here would fork that. The stronger reason is POD-1077's: a share command
takes a `grantee: UserId` that no login can ever produce, so it would be a sharing UI
whose slices are decided by a shared credential — "worse than an honestly unscoped one
because it reads as privacy". The edge table has a writer (`GrantsRepository`), a reader
(the gate), and a deleter (`revokeMachine`); what it does not have is a command surface,
and that is a stated deferral rather than an omission.

**TWO INSTRUMENTS, and the reason the decision suite exists at all.** A second human
cannot be produced through the router — so a router-only suite would exercise only the
principal that is allowed everything, which is POD-351's failure exactly. The DECISION
suite therefore drives `fleetAuthzFailure` directly with colleague principals; the WIRING
suite drives the real `appRouter` and gets its refusals from facts the environment CAN
produce (an unowned row; a row owned by someone the transport cannot authenticate as),
including an admit → revoke → refuse sequence across three consecutive calls. Both assert
the positive first. `audit:machine-grants` is the source-text half and says in its own
header what it structurally cannot see.

### Phase 5 — Machine host tightening (POD-292) · exit gate POD-426

**Scope:** SessionBinding designed lifecycle (POD-323, design doc gates code), async-only
durable hosts (POD-324), harness/pty split with one manifest per CLI (POD-325 → 396–399),
best-available state channel (POD-326), daemon connection state machine + host control
decomposition + codex version guard (POD-327, HUMAN soak gate), binding adoption across
handoff (POD-644), receipts crash durability (POD-737), shared session control identity
(POD-1081 — multi-user, 2026-07-29).

*Correction (2026-07-29):* this paragraph previously also listed "sync/async twins
(POD-328 → 400–404)". That was a stale duplicate: the sync/async-twins work is POD-324,
already named above as "async-only durable hosts", and it has no pre-split children.
POD-328 is a **Phase 6** issue (6.1 client engine split) and POD-400–404 are its children.
The §4 decomposition table carried the same error and is corrected there.

**Cut lines:** behavioral branching on harness identity confined to harness adapters;
identifiers + capability descriptors flow freely (declared data-driven exceptions:
icon maps/pickers). Scar-tissue registry (§7) updated for everything relocated.

**Verification steps (gate POD-426):** binding lifecycle tests green; zero sync/async
twins; harness axiom at error; all-five-agents needs-attention e2e; Codex identity
evidence (`tests/e2e/browser/codex-identity-real.browser.e2e.ts`); receipts SIGKILL→
rebind check; instance-isolation assertion (SP-15aa); 48h remote-daemon soak evidenced
with needs-human set at the gate. `podium issue tree 292`.

### Phase 6 — Client engine split (POD-293) · exit gate POD-427

**Scope:** engine split into transport / replica-binding / actions / router+ui-state /
viewmodel slices (POD-331 → 405–409 and siblings), one ui-state owner, mobile on the
same slices — delete MobileClientValue (POD-332, HUMAN device gate; note: mobile still
wires AsyncStorage replica today, so the SQLite verify is build-and-switch with POD-375),
plus post-freeze leaves POD-646/POD-647.

**Verification steps (gate POD-427):** engine/connection/derive god files gone (audit);
one ui-state owner (lint); render-count probe recorded; offline-first behavior preserved;
mobile device smoke evidenced; bundle within PWA precache limits. `podium issue tree 293`.

### Phase 7 — Final deletions, docs, release (POD-294) · exit/release gate POD-337 (HUMAN)

**Scope:** delete named compatibility shims (POD-333), single-source systemd units +
packaged-install e2e (POD-334), manifest at ERROR level with every legacy lint rule
retired against an equivalent (POD-335), docs rewrite from the per-phase as-built
sections (POD-336), topology closure — shipped layout vs proposal, every deviation
explicit (POD-356), release gate (POD-337): deletion audit at ZERO across the entire
inventory (incl. the expired N/N-1 adapter; the negotiation MECHANISM is permanent and
exempt), quantitative criteria measured against the Phase-2 thresholds, chaos matrix,
all-target packaging with real-binary smoke, file-size report as a review signal with
a named god-object reviewer pass, and the 72h+ fleet soak (HUMAN GATE).

**Verification steps (gate POD-337, HUMAN):** everything above evidenced via issue
artifacts; `podium issue needs-human` set; the deletion audit stays in CI permanently
as a regression tripwire. `podium issue tree 294`.

---

## 9. As-built rule

**Each phase updates the as-built architecture docs at phase close** — current-state
documentation is continuous, not a Phase-7 event. Concretely: the phase's gate
checklist includes "as-built docs updated" (ARCHITECTURE.md and the relevant
`docs/` pages describe the system as it now IS, including any deviation from the ADRs,
which must be documented against ADR 8 topology). POD-336 then rewrites the full doc
set FROM these per-phase sections rather than reconstructing history.
