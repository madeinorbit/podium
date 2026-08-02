# POD-279 tree audit — reparenting, verification, gate wiring

**Issue:** POD-1345 (Epic tree consistency and reparenting)
**Date:** 2026-08-02
**Tree state audited:** `issue/279-integration` at `7387d5d6`; audit worktree at `aba864a9` (0 ahead, 9 behind)

Every verdict below is a measurement against that tree, not a reading of an issue's stage. Where an
issue is recorded as done, this document names the file and the symbol that was looked at. A wrong
close hides real work forever, so nothing is closed on resemblance alone.

---

## 0. What was actually wrong

The coordinator's brief described "~1300 issues in POD-279's orbit". The measured shape is
different, and the difference matters for what needed fixing:

| | count |
|---|---|
| Issues in this repo's tracker | 1236 |
| Descendants of POD-279 before this audit | 246 |
| Of those, open | 58 |
| Issues hanging **directly** off the epic with no phase owner | 36 |
| **Proposed**-lane issues discovered from inside the tree, unparented | 103 |

So the epic was not drowning in loose issues in the way it looked from the top. The 246-node tree
is largely well formed — phases 0-3 are decomposed exactly as the eager-decomposition decision
required. Three specific things were broken, and the third is the one that would have caused real
damage.

**(a) A 36-issue bulge directly under the epic.** Everything filed after the phase plan was
written — the main catch-up, the guardrail repairs, the test-lane firefighting — landed as a direct
child of POD-279 because there was no phase to put it in. `podium issue children 279` returned 48
rows of which 36 were unclassifiable, which is what made "what is left" unanswerable.

**(b) Duplicate pairs where one half shipped and the other stayed open.** Four confirmed. In each
case an agent filed a discovery into the Proposed lane, could not work it there, refiled it as a
workable sub-issue, shipped the refile — and the original stayed open forever. This is a systemic
consequence of the Proposed lane's permissions, not four coincidences. See §4.

**(c) Every phase container was falsely READY.** This is the important one. Phases 4, 5, 6 and 7
each waited only on the *previous phase*, never on their own exit gate:

```
#291 Phase 4   waits on: #290                    <- not #425, its own exit gate
#292 Phase 5   waits on: #288                    <- not #426
#293 Phase 6   waits on: #290                    <- not #427
#294 Phase 7   waits on: #291, #292, #293        <- not #337, the release gate
```

Phase 3 closed on 2026-07-31. From that moment `podium issue ready` listed Phases 4, 5 and 6 as
READY. Any coordinator trusting that signal could have closed Phase 4 with POD-425's four open
blockers untouched, which would have unblocked Phase 7 (`#294 waits on #291`), which would have
unblocked the release gate. The gate chain was one honest mistake away from certifying an unbuilt
rewrite. All four are now blocked — see §3.

---

## 1. Reparenting

### 1a. Three grouping issues created

No existing collector fitted, and inventing phase numbers would have collided with the 0-7 scheme.
Three clearly-named, unnumbered grouping issues were created under POD-279 instead. Each states in
its brief that it is a grouping issue and carries no phase number.

| New issue | Owns | Why it is a group |
|---|---|---|
| **POD-1347** Main catch-up and integration landing | 1129, 1246, 1252, 1253, 1254, 1257, 1263, 1264, 1273, 1279, 1280, 1292, 1293 | The reconciliation of the rewrite branch with main, across six sessions. POD-1246 is the work; POD-1273 is its finisher and still open. |
| **POD-1348** Guardrail and audit gate health | 861, 1105, 1122, 1168, 1211, 1212, 1224, 1239 — plus 740, 743, 1200, 1236 added by the coordinator (§5.3) | Issues about whether the epic's own instruments can be believed. The definition of done promises "manifest enforced at error level" and "deletion audit at zero" — both are promises about tools these issues cover. |
| **POD-1349** Test lanes and host environment | 1157, 1227, 1294, 1295, 1296, 1305, 1328 | The flake-under-load class and the machine it runs on. POD-1305 is load-bearing: it proved by isolation that a symlinked `node_modules` — not the code — produces the startup errors read as flakiness all through this epic. |

### 1b. Issues moved into the phase that actually owns them

| Issue | Was | Now | Reason |
|---|---|---|---|
| POD-1146 One SyncSpan for the kernel | direct child of 279 | **#289** Phase 2 | Sync-kernel work; discovered from 2.2a/2.2b. |
| POD-1241 Mobile wire cutover to v2 feed | direct child of 279 | **#289** Phase 2 | It is the wire cutover, not a slice refactor. Mobile is still a wire-v1 peer. |
| POD-1251 Compose the remaining change-row restatements | direct child of 279 | **#289** Phase 2 | Filed to answer POD-310's Phase 2 exit-gate refusal R3. |
| POD-1210 Bug: janitor archives on a dropped column | direct child of 279 | **#288** Phase 1 | Per-user state family (1.9). |
| POD-1229 Auto-archive precondition reads per-user state | direct child of 279 | **#288** Phase 1 | Discovered from 1.4d; per-user state family. |
| POD-1281 Live upgrade rehearsal on the real fleet | direct child of 279 | **#294** Phase 7 | Carved out of POD-310. It is a human gate, and human gates land with the release gate. |
| POD-788 / POD-789 Tauri replica on SQLite | direct children of 279 | **#307** Phase 2.3 | "Clients on the kernel Replica" is exactly this work. POD-803 and POD-809 ride along under 789. |
| POD-350, POD-359 ADR pack | direct children of 279 | **#349** Phase 1.5 | Phase 1.5 is "ADR pack + walking skeleton"; POD-354 was already there. Puts all three ADR-pack filings in one place. |

**Result:** direct children of POD-279 went from 48 to 15 — eight phases, Phase 1.5, this audit
issue, and the three collectors. `podium issue epic-status 279` now reads 7/15 instead of 33/48,
which is a truer denominator: it counts phases, not a mixture of phases and stray bugs.

### 1c. Not reparented, deliberately

**The 103 Proposed-lane issues** (§4). Reparenting them would nest live proposals under closed
phases and bury them in the human's curation queue, which is the opposite of surfacing them. They
are listed instead.

**Top-level product work that is not rewrite work.** 87 open top-level issues were reviewed and
left alone — Telegram bridge, mobile header navigation, desktop memory balloon, orchestrator
agents and so on. They were created during the rewrite window but are independent product work;
pulling them under POD-279 would inflate the epic with issues that have nothing to do with it.
Only four top-level issues carry a `discovered-from` edge into the tree and are genuinely rewrite
work: POD-740, POD-743, POD-1200, POD-1236. These are listed in §5 for a decision — each is
arguably owned by a closed phase, and I did not want to place open work under a done phase without
the coordinator's call.

---

## 2. Verdicts — every open issue checked against the code

Per the brief, verification was skipped for Phase 6 and Phase 7 leaves whose phase has not
started (POD-328/329/330/331/332/402/403/404/405-409/646/647/333-337/356). They are legitimately
untouched and proving it would be wasted effort.

### 2a. Closed with evidence

| Issue | Verdict | What was looked at |
|---|---|---|
| **POD-1271** Feed identity one-row constraint | **duplicate of POD-1292** (shipped) | `apps/server/src/migrations/drizzle/20260731221009_feed-identity-singleton/migration.sql` and `drizzle-manifest.generated.ts` both carry `CONSTRAINT "feed_identity_singleton" CHECK("singleton" = 1)`, with the `INSERT...SELECT` copy of all four columns. The manifest is what the tests execute, so both had to be checked. POD-1292 merged at `9417f1e1`. |
| **POD-1272** Remove the dead feed table | **duplicate of POD-1293** (shipped) | Migration `20260731225445_drop-dead-sync-feed` exists. `git grep syncFeed\|sync_feed` over `packages/sync/src/adapters/sqlite/schema.ts` and `scripts/audit-durable-classes.ts` returns **zero** hits — both the schema declaration and the `DURABLE_STORES` entry are gone, which is the whole of the issue's stated work. |
| **POD-760** Playwright webServer dies on protocol DTS | **already done** | The workaround config `tests/e2e/playwright.external.config.ts`, created precisely because `webServer` could not start, no longer exists (`git cat-file -e` fails). `scripts/browser-lane.ts` runs `bunx playwright test --config tests/e2e/playwright.config.ts` and says in its header "The Playwright config is used UNCHANGED". That committed config's `webServer` still begins `bun run --filter @podium/protocol build` and has since *gained* a third build step (`@podium/mobile build:web`). **Why that is proof and not inference:** if the protocol DTS build still exited 1, the chain would exit 1 and Playwright would never start a single spec — yet POD-1227's merge note (integration `1925f0db`) records 70 suites actually executing behind a sharded CI job. Suites cannot run behind a webServer that never starts. The issue's own acceptance criterion, "must be fixed before a real `test:browser` script can use the committed config", is met: `package.json` has `"test:browser": "bun scripts/browser-lane.ts"`. |

### 2b. Verified genuinely open — left open

| Issue | Evidence it is still real |
|---|---|
| **POD-759** Orphaned skip in router.test.ts | `apps/server/src/router.test.ts:354` still holds `it.skip('discovery.refreshRepos enriches registered roots in place (no home walk)')`. A repo-wide grep for `it.skip(`/`describe.skip(` returns exactly this one hit, so it remains the only unconditional skip in the tree — the standing quarantine POD-295's AC3 exists to keep visible. |
| **POD-763** Three-dot diffs for branch review | `docs/rearchitecture-v3.md` §3 (Standing conventions) contains no three-dot / merge-base guidance; grep for `three-dot`, `main...`, `merge base` returns nothing. |
| **POD-766** managed-account-spawn runs in two lanes | `package.json:54` `test:multi-instance` still contains `&& bun --bun node_modules/vitest/vitest.mjs run scripts/managed-account-spawn.integration.test.ts`, with no `--config`. The decision to drop it is recorded on the issue but was never landed. |
| **POD-769** Ledger: unproven detector = unproven guard | Grep of `docs/rearchitecture-v3.md` for "three costumes", "unproven detector", "non-event" returns nothing. The doctrine join is unwritten. |
| **POD-1122** scripts/ has no typecheck gate | Turbo runs typecheck in 23 packages; `scripts/` is not a workspace package and appears in none of them. Still the fail-open shape it describes. (Note: this issue's brief has a large paste of raw turbo output embedded mid-sentence — worth cleaning when someone picks it up.) |
| **POD-1343** Worktree runtime resolution | Same defect *class* as POD-1305 but a distinct instance (gate worktree with `node_modules/@podium` absent after a clean install, vs POD-1305's symlink sharing). Deliberately **not** closed as a duplicate — the two have different fixes and closing on similarity is exactly the error this audit exists to avoid. A `related` link is the right relationship; it is left for whoever works POD-1305 to decide. |
| **POD-1273, 1279, 1280, 1157, 1241, 1251, 1281, 1305, 1316, 326, 1081, 803, 809** | **Read, not independently re-measured.** Each describes work that is plainly not on the tree, and each was left open on that basis. This is a weaker standard than the rows above it and should not be read as equivalent — see the correction note below. |

### 2b-note. Correction: the last row of §2b originally overclaimed

**Added 2026-08-02 08:30 UTC, after a reader asked whether POD-1328 still reproduces.**

That row first read *"All read and confirmed to describe work not present on the tree."* For
several of its entries — POD-1328 most clearly — the honest description is **read, not
re-measured**. I read the brief and reparented the issue; I did not run `podium status` and did not
look at the probe. "Confirmed" was the wrong word and it is the exact failure this audit exists to
catch, committed by the audit itself: a verdict phrased more strongly than the evidence behind it.

The corrected wording stands above. What follows is the measurement that should have been there.

**POD-1328 — measured 2026-08-02 08:29 UTC on ludovico, live instance:**

```
$ podium status
Podium — mode: server
  ● server  up :18787  (health)          <- reports UP, correctly
$ curl -s -o /dev/null -w "%{http_code}" http://localhost:18787/health
200
$ ss -ltnp | grep 18787
LISTEN 127.0.0.1:18787  users:(("bun",pid=3097780,fd=21))
```

**The headline symptom does not reproduce.** `podium status` agrees with the health endpoint.

**That is not a fix, and POD-1328 must not be closed on it.** The original was a point-in-time
measurement at 07:05 UTC on integration `0c2ec962`; this is one contradicting reading roughly 85
minutes later. A probe that disagrees with reality intermittently is precisely the class where a
single green is a non-event — the same rule the ledger states for detectors and guards (§4 of
`docs/rearchitecture-v3.md`, and POD-769). Retiring this issue needs the probe read, not re-run.

**The issue's SECOND observation is confirmed live and ongoing, and is the more dangerous half.**
POD-1328 reported `~/.podium/config.json` rewritten at 06:43:31 UTC with a features block whose
flag names match a test fixture, and deliberately declined to name the writer. As of 08:29 UTC:

```
$ TZ=UTC stat -c '%y' ~/.podium/config.json
2026-08-02 08:14:31 UTC                  <- rewritten ~15 min ago, DURING this audit session
$ cat ~/.podium/config.json
{ "mode": "server", "features": { "sample-experiment": true, "other": false } }
```

The fixture is still in the **live** host config, and `ps` shows unit lanes running concurrently
out of the POD-402 and POD-1329 worktrees. So a test lane is still writing live host state, and
the live server is currently running with an experimental feature flag a test switched on.

**The writer remains unidentified.** This narrows the window and proves the behaviour is ongoing;
it is correlation with running lanes, not attribution, and it is not dressed up as more. The
original reporter ruled out `packages/runtime/src/config.test.ts` (properly isolated via
`mkdtempSync` + `PODIUM_STATE_DIR`) and `apps/server/src/features.test.ts` (writes nothing to
disk). That elimination still stands.

**Why this matters beyond one bug:** a test lane that mutates live host state is how a
verification run fabricates its own incident. If the status probe reads this config, the
contamination is a live candidate cause for the down-while-up reading itself — which would make
the two halves of POD-1328 one defect, not two observations.

### 2c. Corrected rather than closed — POD-1280

POD-1280 said POD-387's prose claims **seven** handoff frames where ADR 7 D7 says **eight**, and
asked for the prose to be corrected to eight. **Both numbers are wrong.**

Measured on `issue/279-integration`:

- `packages/protocol/src/messages/handoff.ts` defines **ten** `z.literal` message types — five
  request/result pairs.
- `packages/protocol/src/messages/message-class.ts` classifies all ten as `control.command`
  (lines 169-173 requests, 229-233 results).
- The fifth pair, `handoffBindingFinalizeRequest` / `handoffBindingFinalizeResult`, was added by
  **POD-644** (5.1e Binding adoption across handoff) *after* ADR 7 was written.

So ADR 7 D7 is itself now stale, in four places in `docs/adr/0007-plane-inventory.md` (the
"Re-derived count: **8**" paragraph and its enumerated list, the D7 classification-table rows, the
POD-359 drift-refresh row, and the Appendix row) plus three restatements of "eight" in
`docs/adr/0007-plane-inventory-amendment-1.md` at lines 39, 505 and 647.

The sharpest instance is the Appendix row, which reads:

> `| Handoff typed messages | z.literal in handoff.ts | **8** (not "7" from drift prose) |`

— a drift-correction row that was itself overtaken by drift. Exactly the failure POD-1280 exists
to catch, one level up.

**Action taken:** the tracker half is done — POD-387 now carries a comment with the measurement,
and POD-1280's brief is rewritten to describe the real remaining work (the ADR correction, with
the four locations named). POD-1280 stays **open**, and `#336` (7.4 Docs rewrite) now waits on it
so the correction cannot be skipped at Phase 7. It was *not* closed: the ADR half is the larger
half and is untouched.

---

## 3. Dependencies wired

14 edges added. `podium issue doctor` reports **cycles: 0** after all of them.

### 3a. Phase containers now wait on their own exit gates

The systemic bug from §0(c). Each of these four was the single edge standing between a closed
predecessor phase and a falsely-READY successor.

```
291 -> 425    Phase 4 waits on 4.8 Phase 4 exit gate
292 -> 426    Phase 5 waits on 5.6 Phase 5 exit gate
293 -> 427    Phase 6 waits on 6.6 Phase 6 exit gate
294 -> 337    Phase 7 waits on 7.5 Release gate
```

Confirmed effect — all four flipped from `ready=true` to `blocked=true`:

```
#291 Phase 4  stage=backlog  ready=false blocked=true
#292 Phase 5  stage=backlog  ready=false blocked=true
#293 Phase 6  stage=backlog  ready=false blocked=true
#294 Phase 7  stage=backlog  ready=false blocked=true
```

### 3b. Gate child-sets re-derived from the phase

Each gate's blocker set was rebuilt from its phase's membership, not from what it already waited
on.

- **#422 (Phase 0), #423 (Phase 1), #424 (Phase 3)** — closed gates; blocker sets checked and
  complete against their phases. No change.
- **#425 (Phase 4)** — waits on 318, 322, 355, 734, 1078, 1315, 1316, 1343. Re-derived Phase 4
  membership is 317-322, 355, 645, 1078, 1079, 1315, 1316, 1318 (+1343 under 425). Every **open**
  member is present. Complete; no change needed.
- **#426 (Phase 5)** — waits on 324, 325, 326, 327, 644, 737, 1081. Missing: **POD-1329**
  (Real-binary agent smokes for all five CLIs), a child of POD-325 filed after the gate was
  written. Fixed by `325 -> 1329` so 5.3 cannot close over its own open child.
- **#427 (Phase 6)** — waits on 328, 329, 330, 331, 332: all five Phase 6 leaves, complete. Added
  `328 -> 404` so 6.1 cannot close while its terminal child (6.1e, delete engine.ts) is open;
  the sub-leaves 402/403/405-409/646/647 were already covered transitively via 404 and 332.
- **#337 (Release gate / epic close)** — waits on 333-336, 356: all Phase 7 leaves. But the epic's
  definition of done makes four more things load-bearing, and none was wired:

```
337 -> 1281   "all human gates passed and evidenced"  (live upgrade rehearsal on the real fleet)
337 -> 1251   "deletion audit at ZERO"                (12 remaining change-row restatements)
337 -> 759    "full oracle green on linux"            (the one standing unconditional skip)
337 -> 1347   the catch-up must have landed
337 -> 1348   the guardrails must be trustworthy
337 -> 1349   the lanes must be trustworthy
```

### 3c. One cross-phase technical dependency

```
332 -> 1241   6.5 Mobile on the same slices waits on the mobile wire cutover to v2 feed
```

Mobile registers `feedDelta`, `feedBootstrap`, `feedRescope` and `feedResyncRequired` as
deliberately empty handlers — it is still a wire-v1 peer. Putting mobile on the shared slices
before the wire cutover would paint an empty slice on every cold start, and the failure mode is a
plausible-looking empty screen rather than a crash. Without this edge Phase 6 could certify with
mobile silently broken.

```
336 -> 1280   7.4 Docs rewrite waits on the ADR 7 handoff-count correction (§2c)
```

---

## 4. The Proposed lane — 103 issues, and why this keeps happening

**103 issues discovered from inside the POD-279 tree are sitting unparented in the Proposed lane.**
The full list with provenance is in §4c.

### 4a. This is a permissions trap, not agent carelessness

An agent that files a top-level discovery lands it in Proposed. It then **cannot work it, cannot
close it, cannot mark it a duplicate, and cannot reparent it out**. Verified directly during this
audit:

```
$ podium issue close 1266 --reason duplicate --outside-scope
podium issue: only an operator may close a proposed issue
$ podium issue duplicate 1266 1292 --outside-scope
podium issue: only an operator may mark duplicate a proposed issue
```

So the lane is **write-only for agents**. The observed consequence is a repeating four-step cycle:
an agent files into Proposed → cannot act on it → refiles the same defect as a workable sub-issue
under the epic → ships the refile → the Proposed original stays open forever.

That cycle produced every duplicate pair this audit found. It is worth fixing at the tool level,
not one issue at a time.

### 4b. Confirmed dead — recommended for bulk close by an operator

Each verified against the tree or against an explicitly-superseding issue. These are safe to close
as duplicates; nothing here is unshipped work.

| Proposed | Duplicate of | Evidence |
|---|---|---|
| POD-1266 | POD-1292 (done) | Same as POD-1271, §2a. |
| POD-1267 | POD-1293 (done) | Same as POD-1272, §2a. |
| POD-1322 | POD-1318 (done) | `apps/server/src/steward.test.ts:308` now binds `issues.commentsMail.addComment` (the concrete delegate) instead of the `issues.addComment` facade that re-entered `vi.spyOn` and blew the stack — exactly the fix POD-1318 describes. |
| POD-1327 | POD-1318 (done) | Same evidence; POD-1327 and POD-1322 are also duplicates of each other. |
| POD-1136 | POD-1229 (done) | Title-identical; POD-1229 shipped. |
| POD-1147 | POD-1151 (done) | Title-identical; POD-1151 shipped. |
| POD-1142 | POD-1153 (done) | POD-1153 "Handoff manifest attribution pair" shipped. |
| POD-1290 | POD-1295 (done) | Same defect, browser lane mobile bundle. |
| POD-1302 | POD-1303 (done) | POD-1303 "Relay suite import restored" shipped the fix. |
| POD-1166 | POD-1168 (done) | POD-1168 "Instance partition audit sees columns" carries a `discovered-from` edge to 1166 and shipped. |
| POD-1104 | — | Title is literally "Bug: NUL byte in client engine source (**already fixed**)". |
| POD-1235 | — | Title is literally "**Retracted**: secrets checks were a harness artifact". |

**One canonical-plus-four cluster:** POD-1120, POD-1198, POD-1219 and POD-1222 are four separate
Proposed filings of "scripts/ is not typechecked". The canonical, workable issue is **POD-1122**
(open, now under POD-1348). The four Proposed ones should close as duplicates of it.

That is **17 of 103** closable immediately on the evidence above.

### 4c. The remaining 86 — need triage, not closure

These are real, mostly unexamined discoveries. They are listed with the issue that discovered them
so they can be triaged in phase batches rather than one at a time. Highest-signal clusters:

- **From POD-1227 (browser suites):** 1233, 1234, 1240, 1242 — browser-lane repairs.
- **From POD-730 (workflow characterization):** 1106, 1108, 1109, 1110 — the workflow engine.
- **From POD-362/363 (branded ids):** 1144, 1145, 1164, 1171, 1183, 1192.
- **From POD-367/366/368 (representations):** 1137, 1138, 1139, 1148.
- **From POD-373 (conformance):** 1161, 1163 — both are replica-wedging bugs and look serious.
- **From POD-1220/1223 (kernel replica):** 1231, 1232, 1244, 1245 — includes "kernel replica outbox
  loses writes silently".
- **Load/flake family:** 764, 1140, 1183, 1225, 1238, 1297, 1307, 1308 — most or all are probably
  POD-1305's shared-`node_modules` root cause and could be triaged as one batch against it.

Full inventory of all 103 with provenance is attached to POD-1345 as the audit's working output and
reproducible with `podium issue deps 279` (every `blocks: #NNNN (open, discovered-from)` line whose
target is stage `proposed`).

---

## 5. Decisions — raised, and how they were resolved

Resolved by the POD-279 coordinator on 2026-08-02, after this audit merged at `cf5ee9ed`.

1. **Bulk-close the 17 dead Proposed issues** in §4b. **OPEN — operator-only.** Escalated to the
   human with the 17 called out, including the 1120/1198/1219/1222 cluster against POD-1122.
   Nothing there is unshipped.
2. **Fix the Proposed-lane trap** (§4a). **OPEN.** While agents can file into Proposed but not act
   on it, this backlog regenerates. Options: let an agent close/dedupe its own Proposed filings, or
   route agent discoveries to a lane they can work.
3. **Four rewrite-related top-level issues need a home.** **RESOLVED — all four now parent to
   POD-1348**, not to the closed phases they came from:
   - POD-740 Bug: lint:boundaries red on main (`discovered-from` POD-296, Phase 0)
   - POD-743 Bug: title test matches delegation prose (`discovered-from` POD-297, Phase 0)
   - POD-1200 Collapse the two pin mechanisms (`discovered-from` POD-1076, Phase 1)
   - POD-1236 Per-user archived flag (`discovered-from` POD-1229, Phase 1)

   The reasoning is better than my recommendation was and is worth keeping: reparenting these into
   Phase 0 and Phase 1 would reopen the question of whether those phases are finished, and they
   **are** finished. What is left over is *instrument health*, which is exactly what POD-1348
   holds. A closed phase with a live child is a lie in the other direction.
4. **Should POD-279 itself wait on Phase 7?** **RESOLVED — no, and do not add it.** The edge would
   be tautologically true (an epic is trivially blocked until its last phase closes), so it carries
   no information a reader lacks, while dropping POD-279 out of the ready lobby has a real cost: it
   is how the human and the coordinator find the epic at all. Real blocking belongs on the phase
   containers, which is where §3a put it.
5. **Two dangling dependency edges** exist repo-wide (`podium issue doctor` → `dangling: 2`, which
   makes `podium issue preflight` fail). They predate this audit. **The CLI reports the count but
   provides no way to identify which edges they are** — no `--verbose` on `doctor`, and
   `podium issue graph` prints only `1301 nodes, 1648 edges`. Unresolvable with the tools available;
   listed rather than guessed. **Folded into the tooling issue** (§6).

## 6. Tooling defects found while doing this

All four are filed on **POD-1346** (under POD-1113) alongside the coordinator's own findings.
They cost real time here and will cost the next audit the same.

1. **`podium issue tree` truncates at 100 nodes with no warning.** The epic has 246 descendants. The
   coordinator's brief records under-counting the epic by half by trusting this output, and
   separately reported ~19 open leaves to the human when the real number was 30. A truncation
   notice would have prevented both. (POD-1342 "Truncation notice in CLI output" appears to be
   exactly this and is in progress.)
2. **`podium issue find-duplicates` is unusable.** It prints internal `iss_<uuid>` identifiers
   rather than `POD-` refs, and it scores every empty "Draft" issue as a 1.00 match against every
   other, burying real duplicates. Every duplicate in this audit was found by hand. There are
   **15 empty "Draft" issues** in this repo polluting it.
3. **`podium issue doctor` reports `dangling: 2` without naming the edges** (§5.5).
4. **`--outside-scope` is undocumented on `close`.** `podium issue close --help` lists only
   `--id/--reason/--note/--author`, but the flag is required for out-of-subtree closes and does
   work. The error message tells you to use a flag the help text says does not exist.

---

## Appendix — change log

**Closed (3):** POD-1271 (duplicate/1292), POD-1272 (duplicate/1293), POD-760 (done).
**Created (3):** POD-1347, POD-1348, POD-1349 — grouping issues.
**Reparented (36):** 13 → POD-1347; 8 → POD-1348; 7 → POD-1349; 1146/1241/1251 → #289;
1210/1229 → #288; 1281 → #294; 788/789 → #307; 350/359 → #349.
**Reparented afterwards by the coordinator (4):** 740, 743, 1200, 1236 → POD-1348 (§5.3).
**Dependencies added (14):** 291→425, 292→426, 293→427, 294→337, 325→1329, 328→404, 337→1281,
337→1251, 337→759, 337→1347, 337→1348, 337→1349, 336→1280, 332→1241.
**Issue text corrected (2):** POD-387 (comment: handoff frame count is ten, not seven or eight),
POD-1280 (brief rewritten to the real remaining ADR work).
**Verified open, no change (14):** 759, 763, 766, 769, 1122, 1343, 1273, 1279, 1280, 1157, 1241,
1251, 1281, 1305, 1328.
**Product code changed: none.** This audit touched the issue tree and this document only.
