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
| POD-328 sync/async twins | POD-400…404 |
| POD-331 client engine split | POD-405…409 |

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
| POD-359 ADR pack sign-off | Reads and signs off the 8 ADRs before Phase 1 entry | `docs/adr/` (the pack itself; sign-off procedure in POD-359) | POD-359 issue artifacts + signed ADR frontmatter |
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
  multi-instance) in CI, per the lane doctrine (§2). *In progress; waits on POD-619
  stable baseline — precondition now MET (landed 1b10357f).*
- POD-296 — architecture manifest lint: layer/platform/role/feature constraints, WARN
  mode, phase-mapped allowlist. *On its issue branch: the tag-derived matrix lives in
  `scripts/architecture-manifest.ts`, today's 50 known violations are frozen with
  per-(rule, file) counts in `scripts/boundary-allowlist.ts` and mapped to the phase that
  removes each, and the ratchet runs as its OWN blocking CI step. It adds its layer/tag
  table + the rule → legacy-rule retirement map POD-335 needs as a subsection here, drift-
  tested against the manifest (§5) — that subsection arrives with POD-296's branch.*
- POD-297 — deletion audit script (`scripts/rearch-audit.ts`): the Section-6 "what
  disappears" inventory encoded as grep/AST checks with per-item and total counts,
  counted in CI, must reach zero by POD-337. *Landed on its issue branch (bddfff78);
  all 21 inventory items encoded and mapped to their owning phase issue, wired as its
  OWN blocking CI step. Rule + rationale: `docs/rearch-deletion-audit.md`.*
- POD-298 — this ledger. *This document.*

**Cut lines:** Phase 0 ships guardrails only — no production code moves, no schema
moves, no deletions. The audit script REPORTS counts; it does not fail CI on nonzero
(that ratchet is per-phase). Manifest lint stays in warn mode until Phase 7 (POD-335).

**Oracle status:** baseline MEASURED at c577009d and **RED** — see §2.4 for the lane table.
typecheck + e2e green; unit red (POD-743 — since FIXED by POD-295, no product change);
integration + multi-instance red (POD-746, one file failing in both). Zero quarantines. The
oracle command (`bun run oracle`) and the CI job are in place. **The baseline is not yet
lockable GREEN: gate POD-422 stays shut on POD-746 (module duplication) and POD-757 (a ~40%
flaky unit test — a retry-0 lane that flakes cannot certify anything).** Typecheck runs
under tsgo via turbo (POD-715 landed).

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
| `packages/domain` | L0 model | browser-safe | entity-predicates, issue-stage, issue-authz, session-dedup, git-identity | → **`packages/model`** (Phase 1 POD-299) |
| `packages/protocol` | L1 wire | browser-safe | wire-schema, titles | Phase 1 POD-300 moves schemas out; Phase 2 POD-308 wire cutover |
| `packages/issue-client` | L1 wire | node-only | issue-command-table | → folded into the command registry (Phase 3 POD-311) |
| `packages/transcript` | L2 kernel | node-only | transcript-parsing | package placement settled by ADR 8; POD-398 implements |
| `packages/runtime` | L2 kernel | **neutral** | config, sqlite, git-port, connectivity, auth-store, settings | browser-safe barrel + node-only subpaths (legacy rule 8) |
| `packages/sync` | L2 kernel | node-only | oplog, upstream-sync | → one sync kernel (Phase 2 POD-305/306) |
| `packages/telemetry` | L2 kernel | **neutral** | telemetry-schema, telemetry-consent, telemetry-queue | added mid-Phase-0 [spec:SP-f933]; subpath gap POD-745 |
| `packages/agent-bridge` | L2 kernel | node-only | harness-adapters, pty-port | → **split** into `packages/harness` + `packages/pty` (Phase 5 POD-325) |
| `packages/terminal-client` | L2 kernel | browser-safe | terminal-port | — |
| `packages/client-core` | L3 feature | browser-safe | viewmodels | → client engine split (Phase 6 POD-331) |
| `packages/terminal-client-react` | L3 feature | browser-safe | terminal-react | — |
| `apps/cli` | L4 app | node-only | cli-surface | — |
| `apps/daemon` | L4 app | node-only | daemon-surface | Phase 5 machine-host tightening (POD-292) |
| `apps/desktop` | L4 app | browser-safe | desktop-shell | — |
| `apps/mobile` | L4 app | browser-safe | mobile-surface | — |
| `apps/server` | L4 app | node-only | server-surface | role-tiered (core<hub<cloud, `apps/server/src/roles.ts`); Phase 4 decomposition |
| `apps/web` | L4 app | browser-safe | web-surface | Phase 6 engine split |
| `scripts` | L5 compose | node-only | build, lint, compose | composes apps; nothing may import it |

**Declared same-layer edges** (the only legal sideways imports): `issue-client → protocol`;
`sync → runtime`; `telemetry → runtime`; `agent-bridge → runtime`; `agent-bridge → transcript`.

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

### Phase 1 — packages/model (POD-288) · exit gate POD-423

**Scope:** one semantic vocabulary at L0: `packages/model` scaffold (POD-299), entity
schemas out of protocol (POD-300), branded IDs everywhere (POD-301 → 360–363),
canonical aggregates + composed projections (POD-302 → 364–368, incl. handoff
vocabulary POD-643), agent identity dual form (POD-303), provenance envelope +
ownership annotations (POD-304).

**Cut lines:** no behavior change — representations re-derived, wire fixtures byte-stable
(golden fixtures from POD-360). Narrow ports remain as named derivations.

**Oracle status / audit counts:** filled at phase close. Audit items: hand-restated
field definitions, raw-string ids (now incl. `messages/handoff.ts`), agent-kind/
capability tables (five adapters since grok landed dc6537d6), stateDir.

**Verification steps (gate POD-423):** regenerate the gate evidence checklist against
current main, not the 07-13 snapshot; audit items zero; oracle green; wire fixtures
unchanged (incl. the handoff family); ledger + as-built updated. `podium issue tree 288`.

### Phase 2 — One sync kernel (POD-289) · exit gate POD-310 (HUMAN)

**Scope:** Authority (POD-305), Replica + Outbox + conformance (POD-306 → 369–373),
clients on the kernel with transactional storage (POD-307 → 374–378, human device gate
POD-377), wire cutover + version negotiation (POD-308), upstream retirement + federation
seam (POD-309), switch-latency harness survival (POD-736).

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

### Phase 3 — Command registry as the universal write surface (POD-290) · exit gate POD-424

**Scope:** L1/L3 split + framework (POD-311), session mutations (POD-312 → 379–382 +
handoff POD-642), superagent/fleet/specs (POD-313 → 383–386), derived router (POD-314),
command security (POD-315), offline classes + outbox UX (POD-316), secrets/preferences
split (POD-352 → 418–421), agent-mail (POD-640) and workflows (POD-641) routers
(post-freeze additions, gate via the POD-314→POD-315 chain).

**Cut lines:** contracts at L1, handlers at L3, joined at composition roots.
messaging (Telegram bridge) has no tRPC mutations — no migration child; its reactions
are POD-321's business.

**Verification steps (gate POD-424):** no hand-written mutation procedures (audit);
authz matrix green across four transports; offline classes + dead-letter UX
runtime-verified; secrets split complete; ledger + as-built updated.
`podium issue tree 290`.

### Phase 4 — Node decomposition (POD-291) · exit gate POD-425

**Scope:** gateway + plane inventory implementation (POD-317 → 387–391), fleet service
+ one machine identity (POD-318), SessionService split (POD-319 → 392–395), IssueService
recomposition (POD-320), declarative acyclic composition + reactions registry (POD-321),
memory service (POD-322), orchestrator/attention/telemetry boundary review (POD-355),
instance-vs-machine identity (POD-645, [spec:SP-15aa], post-freeze addition).

**Verification steps (gate POD-425):** composition root acyclic (topological test);
god-object audit items zero; module graph doc committed; session/issue/memory e2e green;
live redeploy keeps sessions; multi-instance isolation suite green through the
decomposition. `podium issue tree 291`.

### Phase 5 — Machine host tightening (POD-292) · exit gate POD-426

**Scope:** SessionBinding designed lifecycle (POD-323, design doc gates code), async-only
durable hosts (POD-324), harness/pty split with one manifest per CLI (POD-325 → 396–399),
best-available state channel (POD-326), daemon connection state machine + host control
decomposition + codex version guard (POD-327, HUMAN soak gate), sync/async twins
(POD-328 → 400–404), binding adoption across handoff (POD-644), receipts crash
durability (POD-737).

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
