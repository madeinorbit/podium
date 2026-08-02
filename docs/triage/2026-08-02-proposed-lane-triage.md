# Proposed-lane triage — 288 agent-filed issues

**As of 2026-08-02, ~10:30 CEST.** Counted live from `~/.podium/podium.db`; three more
(POD-1360/1361/1362), then a fourth (POD-1363), landed *while this document was being written*, which is itself part
of the finding. Every open, non-archived issue in `stage=proposed` for this repo is
classified below — none is skipped.

## What is actually in there

| | count |
|---|---|
| Total proposed | **288** |
| Descend from the POD-279 subtree via a `discovered-from` edge | **103** |
| Have *no* provenance edge at all | 54 |
| Filed by an agent (`origin=agent`) | 288 — **all of them** |

So your instinct was right about the size, and half-right about the cause. The rewrite
contributed 103 by direct provenance; the other 184 came from every other stream of work
(mobile, messaging, handoff, telemetry, fleet, tracker). **The proposed lane is not a
rewrite artifact — it is the destination for every top-level discovery any agent has ever
made, and nothing has ever drained it.**

## Buckets

| Bucket | n | Meaning |
|---|---|---|
| **P1** | 99 | Rewrite work. Belongs under an existing POD-279 bucket **now** — it either blocks the epic's own gates or is a phase's unfinished business. |
| **P8** | 19 | Real rewrite-created debt, not gate-blocking. A new **Phase 8 — post-cutover cleanup** child of POD-279, done before the epic closes. |
| **HUMAN** | 6 | Blocked on a decision only you can make. One of them (POD-1067) is time-critical. |
| **DUP** | 63 | Close on triage: duplicate, already done inside the epic, withdrawn, or stale. |
| **PROD** | 101 | Genuinely independent product/infra work. **Stays in Proposed for you**, as you asked. |

### One judgement call you should check

99 P1 is more than the 103 rewrite-descended, because **I put red and flaky test lanes
into the epic regardless of who filed them.** POD-452, POD-563, POD-668, POD-914, POD-961,
POD-1054 and friends were filed by non-rewrite agents, but the unit/browser/integration
lanes *are* the rewrite's migration oracle — POD-295 locked a green baseline as Phase 0's
deliverable, and a lane that is red or flaky makes every phase-exit gate unreadable. If
you disagree, the fix is one column: move them back to PROD and accept that phase gates
are graded against a noisy oracle.

### The five things in here that actually scare me

1. **POD-1191** — *Entity revision column and assignment.* Every entity is arbitrated
   against a revision no code assigns, so the expected-revision check *can never refuse a
   stale write*. This is the last unbuilt piece of the sync protocol's conflict story and
   it is sitting in a lane nobody reads.
2. **POD-1231** — the kernel replica outbox keeps offline writes in a localStorage JSON
   blob and **silently discards** ones that fail. The storage ADR names both as things a
   client must not do. Data loss, shipped.
3. **POD-1180 / POD-1137 / POD-1249** — three instruments that cannot say no. The deletion
   ratchet counts one file, so *moving* code out of it reads as progress. The session-shapes
   audit checks nine hand-listed names, which makes a Phase-1 acceptance criterion vacuous.
   The federation-seam audit is satisfied by a **code comment**. Phase gates were graded
   with these.
4. **POD-1221** — nine command-audit scripts are wired into `package.json` and **never run
   by CI**. Only `audit:rearch` is in the pipeline.
5. **POD-1067** — multi-user ownership. The issue says it plainly: affordable now, expensive
   after the Phase-2 wire cutover. The cutover has happened on the integration branch. This
   decision is either already late or about to be.

---

## Process analysis — what went wrong, and what didn't

### What is working as designed (do not "fix" this)

Agents filing what they trip over is the behaviour you want. Roughly 60% of these issues
carry a verified root cause, a file:line, and a repro — POD-984, POD-945, POD-691, POD-1010
are better bug reports than most humans write. The `discovered-from` edge is intact on 228
of them. Guardrail 2 (`SP-6144`: only an operator moves a proposed issue) is doing exactly
its job — it stopped 288 agent-filed issues from self-promoting into your work queue.

### Failure 1 — the lane has no drain, so its cost is invisible to the filer

Proposed is write-only for agents. An agent files, and by construction can never see the
consequence: it cannot promote, close, reparent, dedupe or archive. There is no feedback
loop, so there is no pressure to file well, and no signal that the lane is 288 deep.
This is the root cause of everything below.

### Failure 2 — parallel agents re-file the same red test, over and over

**63 of 288 are duplicates**, and they cluster by mechanism, not by topic:

| Cluster | Count | Root |
|---|---|---|
| Outbox wake timing | 9 | `resurrectSession` became async; tests assert synchronously |
| Managed-account-spawn fixture | 5 | fixture missing `setLaunchCwd` / `composerEngine` |
| `scripts/` not typechecked | 4 (+1 canonical) | root tsconfig is solution-style with `files: []` |
| `router.upstream-issues` coverage | 4 | `setCoordinator`/`stop` missing from the coverage list |
| issue-authz manage/write pin | 4 | registry def vs test pin disagree |
| Review worktrees in the test lane | 4 | nested checkouts collected by the runner |
| web feature-boundary (settings→machines) | 3 | pre-existing import |
| install.sh shell-banner probe | 3 | test asserts on interactive-shell stdout |
| normalized-wire timeout under load | 3 | wall-clock budget on a loaded box |

The mechanism is identical every time: **an agent runs the full gate before merging, finds
a red that predates its change, correctly concludes it is not theirs, and files it.** Ten
agents in a fan-out do that on the same day against the same red lane. None of them can see
the proposed lane to dedupe against, and `find-duplicates` only matches titles — which
diverge, because each agent describes the failure in its own words.

This is not agent misbehaviour. It is a **missing dedupe seam** in a system that was
designed for one agent at a time and is now run at ten.

Worse: 8 of the duplicates duplicate work **already done inside the epic** (POD-1136 vs
POD-1229, POD-1266 vs POD-1292, POD-1322/1327 vs POD-1318, POD-1184 vs POD-1294, POD-1290
vs POD-1295, POD-1103 vs POD-1105). The proposed copy could not see that its twin had been
adopted and closed, because they live in different lanes.

### Failure 3 — the litmus test routes correctly and lands wrongly

The spin-off rule is: *could the current issue close with this untouched?* For "the browser
lane has been dead for two weeks" the honest answer is **yes** — POD-1227 could close
without it. So the agent correctly chose `--spinoff`, and spinoff correctly lands top-level
in Proposed.

But the *destination* is wrong for a different reason than the litmus asks about. The
question the router never asks is: **does this share a file, a gate, or a branch with an
epic that is currently in flight?** Every one of these 103 does. As you said: they cannot
be started without coordinating with the rewrite anyway. The litmus tests *shippability
independence* and silently assumes that implies *scheduling independence*. On a long-lived
integration branch with ten concurrent agents, it does not.

The evidence that the agents themselves felt this: the fan-out coordinator *invented*
POD-1347 (main catch-up), POD-1348 (guardrail and audit gate health) and POD-1349 (test
lanes and host environment) as epic-internal catch-alls, and routed what it could into them
— while its own children kept filing the same class of finding into Proposed, because
top-level `create` gives them no other exit.

### Failure 4 — tracker defects amplified all of the above

Several of the proposed issues are about the tracker failing the fan-out that produced them:

- **POD-873** — `issue start` silently drops the issue's model/effort. Six consecutive
  codex starts launched on the wrong model.
- **POD-1181** — `issue start` always branches from `main`, even for an epic with a
  long-lived integration branch. Agents began hundreds of commits from their real base.
- **POD-874** — a workflow run's coordinator is not transferable, so every respawn
  re-stranded the run at every step transition.
- **POD-1358 / POD-916 / POD-918** — a shared issue mailbox where one agent's inbox read
  consumes a peer's mail, and done children re-notify their parent forever.
- **POD-476** — the merge-lock lease (2m) expires during the 4m pre-merge gate, so the lock
  is loosest exactly when the danger window is widest.
- **POD-232 / POD-244** — the arg parser accepts unknown flags silently. Seven issues were
  created with empty descriptions and four agents started on them.

None of these caused the proposed pile-up on its own. Together they are why a ten-agent
fan-out generated this much friction-debt.

### What did *not* go wrong

These are not phantom findings. Sampling the P1 set: POD-1231, POD-1191, POD-1244,
POD-1208, POD-1125, POD-1172 and POD-1175 are all specific, mechanism-level defects in
code the rewrite itself wrote. The rewrite fan-out found real problems at a real rate. The
system just had nowhere correct to put them.

---

## How to proceed

### The constraint, precisely

I read the enforcement (`apps/server/src/modules/issues/registry.ts:57` —
`assertNotProposedForAgent`, fail-closed). On a proposed issue an agent **cannot**:
`start`, `promote`, `attach`, `archive`, `reparent` (in either direction), `claim`,
`close`, `supersede`, `duplicate`, or `update` any patch touching
`stage`/`archived`/`closedReason`/`parentId`.

An agent **can** still: edit title/description/brief/priority/type, set labels, comment,
and add/remove dependency edges. Operator scope comes from a direct (non-relay) client —
`wsServer.ts:416` grants `scope: 'all'` — so **your own `podium issue` CLI, run without
`PODIUM_ISSUE_RELAY`, is the operator.** There is no maintainer-token escape hatch in the
code; the `~/.podium/issue-maintainer.token` file is not read by anything.

### Recommendation: keep the guardrail, add a curation grant. Do the cleanup as an operator script.

**Do not relax Guardrail 2.** It is the only reason your board is not 288 items of
agent-declared work. The blast radius of a wrong relaxation is your entire work queue.

For the one-off, the cheapest correct path:

1. **I generate an operator script** — one `podium issue` invocation per decision, in
   dependency order (close duplicates → reparent P1 into buckets → create Phase 8 →
   reparent P8), each line commented with the reason from the table below. You run it
   without `PODIUM_ISSUE_RELAY`, so it executes as operator. You can read it, cut lines,
   and run it in chunks. Nothing is irreversible: `close` takes `--reason duplicate`,
   `reparent` is undoable, and no issue is deleted.
2. **Land it in three passes**, so a wrong call is cheap: (a) the 63 closes, (b) the 19
   P8 reparents behind a new Phase 8, (c) the 99 P1 reparents. Between (a) and (b) you see
   the lane drop from 288 to 225, which is the read that tells you whether the classification
   is trustworthy.
3. **Leave the 101 PROD and 6 HUMAN untouched** — that is the lane doing its job, and it is
   a reviewable size.

### Durable fixes, in the order I would do them

| | Change | Why |
|---|---|---|
| 1 | **`create --parent-id <epic>` from an agent lands in the epic's backlog, not Proposed** — when the named parent is an open epic the calling session is already working under. | This is the missing exit. It routes rewrite findings into the rewrite without letting an agent invent top-level work. Guardrail 2 is untouched. |
| 2 | **Make the proposed lane readable to agents** (`issue search --stage proposed`, and a similarity check on `create`). | Removes the 63-duplicate class by construction. Agents cannot dedupe against a lane they cannot see. |
| 3 | **Change the litmus in the prime prompt** — add: *"and does it share a file, gate, or branch with an epic currently in flight? If yes, file it into that epic, not top-level."* | Fixes the routing rule that produced the 103, at the point of decision. |
| 4 | **A standing `discovered-work` bucket per in-flight epic**, created with the epic. | POD-1347/1348/1349 were invented by hand mid-fan-out. Make that structural. |
| 5 | **Fix POD-873 and POD-1181 before the next fan-out.** | Wrong model and wrong base branch are silent, and they cost the rewrite real agent-hours. |

### If you want a different shape

The alternative to a script is a **curation session**: you grant one agent operator scope
for a bounded window and it executes the table directly. I did not assume that authority —
it is a genuine privilege escalation and the script gives you the same result with a diff
you can read first. Say the word if you'd rather have the agent do it live.

---

# The classification

## P1 — Rewrite, schedule NOW under an existing epic bucket  (99)

### → #1349 lanes  (44)

| # | Title | Note |
|---|---|---|
| POD-452 | Replace fixed sleeps and repeated process setup in PTY integration tests | Fixed sleeps + repeated process setup in PTY integration tests. |
| POD-453 | Repair skipped and brittle low-signal tests | Skipped/brittle low-signal tests. |
| POD-563 | Hermetic browser E2E | Hermetic browser E2E — the root of most browser-lane pain. |
| POD-631 | Browser harness Bun runtime | Browser harness must run under Bun. |
| POD-668 | Bug: transcript tailer timing | CANONICAL tailer timing flake. |
| POD-670 | Ephemeral daemon relay tests | Integration lane collides with the live daemon relay port. |
| POD-764 | Bug: upstream-e2e flaky under load | upstream-e2e load flake. |
| POD-914 | Bug: coordinator forwarding coverage | CANONICAL of the upstream-issues forwarded-coverage cluster. |
| POD-961 | Bug: managed spawn fixture | CANONICAL managed-account-spawn fixture drift. |
| POD-1003 | Hibernation default assertion | store.test hibernation default assertion red on main. |
| POD-1027 | Bug: Web store mocks stale | Web store mocks miss normalized replica hooks. |
| POD-1039 | Bug: mobile tools assertion | Mobile shell structure test expects a removed AppToolsRow. |
| POD-1048 | Bug: outbox wake timing | CANONICAL of the 9-issue outbox-wake-timing cluster (richest brief). |
| POD-1054 | Bug: Nested checkout collection | CANONICAL: nested review worktrees collected by test/lint lanes. |
| POD-1101 | Bug: Transcript index teardown | Transcript index teardown closes the DB mid-callback. |
| POD-1121 | Bug: bun-lane spawn fake missing durableLabelFor | Bun-lane spawn fake missing durableLabelFor. |
| POD-1126 | Keyboard-fidelity hook timeout | CANONICAL keyboard-fidelity setup-hook timeout (silently skips 13 cases). |
| POD-1132 | Bug: install-sh probe reads shell banner | CANONICAL install-sh shell-banner probe. |
| POD-1140 | Ladder loops wedge the test runner | Replica ladder loops wedge the runner — a hang instead of a failure. |
| POD-1152 | Expo launcher assertion drift | Expo launcher brittle text assertion. |
| POD-1155 | Harness teardown database noise | Harness teardown DB noise. Same family as #1101/#1298. |
| POD-1173 | Stale agent-bridge imports in e2e harness | Stale agent-bridge imports in the e2e harness; 3 more files will break the same way. |
| POD-1176 | Bug: PTY smoke race | Real-PTY composer smoke race. Same family as #1157. |
| POD-1183 | Bug: wsServer auth test flakes under load | wsServer auth test fixed-wait flake. |
| POD-1201 | Bug: connectivity state flakes | Daemon connectivity-state starvation flake. |
| POD-1204 | Bug: stale experimental settings e2e locator | Experimental-settings e2e locator matches 11 elements. |
| POD-1205 | Bug: grok catalog e2e expects absent model | Grok catalog e2e expects a model this host does not probe. |
| POD-1206 | Bug: janitor recovery test fails | Janitor recovery test fails every run, including pre-merge. |
| POD-1233 | Bug: harness segfaults mid browser run | Harness segfaults mid browser run; everything after reports a connection error. |
| POD-1234 | Bug: relay browser suite cannot load | CANONICAL: a browser spec cannot load because a helper imports a deleted module. |
| POD-1235 | Retracted: secrets checks were a harness artifact | Title says retracted, but the residual is real: the secrets guarantee is unverified. |
| POD-1238 | Bug: RepoScanFlow machine test flakes under load | RepoScanFlow machine test load flake. |
| POD-1240 | Bug: experimental settings spec drives a dead Save button | Experimental-settings spec clicks a Save button the app no longer has. |
| POD-1242 | Bug: eight browser specs click a renamed nav button | Eight browser specs still click the pre-rename Issues nav. Spotted 2 weeks ago; nothing ran them. |
| POD-1243 | Bug: load test flakes under fan-out | Wall-clock load test flakes under fan-out. |
| POD-1297 | Audit timeout under load | Architecture-audit CLI times out under contention. |
| POD-1298 | Bug: Restart mirror after close | Restart leaves the transcript mirror on a closed DB. Family of #1101/#1155. |
| POD-1299 | Bug: worktree mobile build bypass | CANONICAL: browser E2E builds the mobile bundle from main, not the worktree. Tests stale code. |
| POD-1301 | Bug: normalized-wire test timeout | CANONICAL normalized-wire timeout under load. |
| POD-1304 | VMI test host provisioning | VMI test host needs a reproducible toolchain. |
| POD-1306 | Bug: Bun unit-runner segfault | Bun 1.3.14 unit-runner segfault — no reliable repo-wide result. |
| POD-1307 | Durable-session reap timeout | Durable-session reap test deadline under starvation. |
| POD-1311 | Claude brevity smoke | CANONICAL: real-Claude brevity smoke rejects a compliant answer. |
| POD-1363 | Bug: rearch-audit baseline test times out under lane load | rearch-audit baseline test times out under lane load AND plants a marker in the SHARED baseline file, restored in a finally — a killed lane leaves it in the tree. Probe against a temp copy. |

### → #1348 gates  (17)

| # | Title | Note |
|---|---|---|
| POD-457 | Fix issue authorization action-classification regression | CANONICAL of the issue-authz manage/write classification cluster. |
| POD-700 | Bug: settings imports experimental feature | settings -> experimental feature-boundary violation (distinct from #928). |
| POD-755 | Bug: import regex swallows the next import | IMPORT_RE swallows the next import — the manifest gate inherits the miss. |
| POD-849 | Bug: apps/web/test excluded from typecheck | apps/web/test excluded from typecheck. Same family as #1122. |
| POD-928 | Settings machines boundary violation | CANONICAL settings -> machines boundary violation. |
| POD-1124 | Model L0 leans on Node globals | packages/model L0 purity claim is unenforced — its tsconfig pulls Node globals. |
| POD-1137 | Session-shapes audit detector is name-listed | The session-shapes audit is name-listed — it makes a Phase-1 acceptance criterion vacuous. |
| POD-1138 | Optional keys in conditional spreads escape excess checks | Optional keys in conditional spreads escape excess-property checks. |
| POD-1160 | Per-user detector cannot see fixed shape | Per-user detector cannot tell the fix from the defect. |
| POD-1165 | Per-user detector blind to composed PerUserKey | Per-user audit blind to a composed PerUserKey — the fix reads as 4 new violations. |
| POD-1166 | No guardrail on instance_id DDL columns | No guardrail on instance_id DDL columns; the representation equivalent IS caught. |
| POD-1180 | Deletion ratchet blind to router extractions | Deletion ratchet counts one file, so extraction reads as progress. THE RATCHET LIES. |
| POD-1207 | Perf registry ownership-matrix row | Perf registry has no ownership-matrix row to grade its hand-declared class against. |
| POD-1221 | Command audits dark in CI | Nine command-audit scripts wired into package.json and never run by CI. |
| POD-1249 | Bug: seam presence checks read comments | Federation-seam audit is satisfied by a code COMMENT — it cannot detect the removal it exists for. |
| POD-1314 | Issue exposure audit mismatch | Issue command source audit disagrees with the contract and the runtime surface. |
| POD-1321 | Bug: lifecycle boundary allowlist | Boundary allowlist entry left on a deleted source path. |

### → #289 Phase 2  (8)

| # | Title | Note |
|---|---|---|
| POD-785 | Bug: outbox localStorage quota exceeded | Client outbox localStorage quota. Same defect family as #1231; merge. |
| POD-806 | podium db restore verb | ADR 2 D1 requires restore to re-mint the epoch; mechanism shipped, CLI dispatch missing. |
| POD-1161 | Aborted bootstrap install drops buffered frames | Aborted bootstrap install drops buffered frames. |
| POD-1163 | Refused commit wedges the replica permanently | Refused commit wedges the replica permanently. Verify whether already fixed. |
| POD-1191 | Entity revision column and assignment | THE LAST UNBUILT PIECE of the sync conflict story — no code assigns the revision it arbitrates on. |
| POD-1231 | Bug: kernel replica outbox loses writes silently | CRITICAL: kernel replica outbox in a localStorage JSON blob, silently discards failed writes. ADR forbids both. |
| POD-1232 | Client write path on the kernel Outbox | Clients still queue through the OLD outbox, not the kernel Outbox. |
| POD-1244 | Bug: second tab does not converge on the kernel replica | Second tab never converges on the kernel replica. REGRESSION vs the old read path. |

### → #291 Phase 4  (5)

| # | Title | Note |
|---|---|---|
| POD-1123 | Machine-keyed model catalog | Model catalog cached instance-wide, not per machine. Multi-user prerequisite. |
| POD-1134 | Routing keys concatenate unescaped parts | Plane routing keys concatenate unescaped parts; second loose entity-ref type. |
| POD-1143 | Agent identity conflated with session id | Agent identity in a session-named field. Same family as #1164. |
| POD-1164 | Capability.actorSessionId id-space conflict | Capability.actorSessionId id-space conflict. |
| POD-1175 | RPC replies unbound from answering machine | RPC replies matched by id alone — a reply from one machine can settle another machine request. |

### → #1347 catch-up  (2)

| # | Title | Note |
|---|---|---|
| POD-1144 | Issue blockedBy holds branch names | blockedBy typed as issue ids, column holds branch names. |
| POD-1247 | Issue mutations on the arbitration engine | Issue mutations onto the shared arbitration engine (two mechanisms today). |

### → #288 Phase 1  (2)

| # | Title | Note |
|---|---|---|
| POD-1148 | Two attribution pairs, one vocabulary | Two attribution pairs, one vocabulary. Needs one naming decision. |
| POD-1156 | One shape for stamped attribution | One shape for stamped attribution — the fix for #1148. |

### → #290 Phase 3 (#315)  (2)

| # | Title | Note |
|---|---|---|
| POD-1179 | sessions.ask lost its machine-use gate | sessions.ask lost its machine-use gate when the duplicate contract was deleted. |
| POD-1193 | Wake path machine-use gate | Wake path declares machine use but nothing enforces it at delivery. |

### → #290 Phase 3  (2)

| # | Title | Note |
|---|---|---|
| POD-1230 | Perf traces without a principal | Perf traces cannot name a principal; the ring leaks across principals once a second exists. |
| POD-1250 | Conflict class required on every contract | Make the conflict class mandatory on every command contract. |

### → #294 Phase 7 (#335)  (1)

| # | Title | Note |
|---|---|---|
| POD-745 | Telemetry subpath browser-safety gap | Generalise rule 8a from @podium/runtime to every neutral-tagged workspace. |

### → #294 Phase 7 (#336 docs)  (1)

| # | Title | Note |
|---|---|---|
| POD-770 | Bug: change retention spec says 14d, ships 3d | Retention spec says 14d, ships 3d. ADR 2 decided code is right; doc correction. |

### → #294 Phase 7  (1)

| # | Title | Note |
|---|---|---|
| POD-1102 | Recorded deletion debt from main | 19 new deletion-debt instances baselined; each phase still owes its category. |

### → #291 Phase 4 (#645/#1079)  (1)

| # | Title | Note |
|---|---|---|
| POD-1114 | Pairing durability across server data loss | Server data loss permanently orphans a remote daemon. Identity-model defect. |

### → #291 Phase 4 (#1079)  (1)

| # | Title | Note |
|---|---|---|
| POD-1125 | Pair code can rebind an existing machine | SECURITY: a pair code can rebind an existing machine. |

### → #288 Phase 1 (decision)  (1)

| # | Title | Note |
|---|---|---|
| POD-1127 | Workflow wires: entity or RPC read model | Are workflows replicated? The answer decides where their wire types live. |

### → #289 Phase 2 (#373)  (1)

| # | Title | Note |
|---|---|---|
| POD-1130 | Outbox conformance fake fidelity | Outbox conformance fakes carry the residual risk; 5 of 5 defects were in the fakes. |

### → #292 Phase 5 (#397)  (1)

| # | Title | Note |
|---|---|---|
| POD-1131 | Bug: harness model dependency undeclared | packages/harness imports model without declaring it. |

### → #288 Phase 1 (#1141)  (1)

| # | Title | Note |
|---|---|---|
| POD-1147 | Issue storage row from shared fields | Issue storage row still hand-written — Phase 1 audit-zero depends on it. |

### → #291 Phase 4 (#1075)  (1)

| # | Title | Note |
|---|---|---|
| POD-1172 | Sole-human identity fork | Two constants name the single pre-accounts human and disagree. Blocks ownership checks. |

### → #289 Phase 2 (#374)  (1)

| # | Title | Note |
|---|---|---|
| POD-1195 | Web bundle reach for sync adapters | The web bundle cannot reach the IndexedDB adapter — manifest classes it server-only. |

### → #289 Phase 2 (#1077)  (1)

| # | Title | Note |
|---|---|---|
| POD-1196 | One vocabulary for principal and scoped change | Two vocabularies for principal/scoped change across planes and sync. |

### → #289 Phase 2 (#308)  (1)

| # | Title | Note |
|---|---|---|
| POD-1208 | Publication worker speaks the old wire | Publication worker still speaks the pre-cutover wire. Mixed dialects on one connection. |

### → #290 Phase 3 (#1080)  (1)

| # | Title | Note |
|---|---|---|
| POD-1209 | Superagent acts as the bound user | Superagent acts without knowing whose behalf. Multi-user prerequisite. |

### → #289 Phase 2 (#378)  (1)

| # | Title | Note |
|---|---|---|
| POD-1245 | TanStack adapter and dependency removal | TanStack removal itself; blocked by #1220. |

### → #292 Phase 5 (#324)  (1)

| # | Title | Note |
|---|---|---|
| POD-1284 | Bug: ambiguous Geometry export | Ambiguous Geometry export breaks repo typecheck. Verify — may already be fixed. |

### → #291 Phase 4 (#1315)  (1)

| # | Title | Note |
|---|---|---|
| POD-1344 | Caller identity through the git-workflow plane | git-workflow plane comments cannot name the human who ran the action. |


## P8 — Rewrite cleanup, new Phase 8 (post-cutover, before epic close)  (19)

| # | Title | Note |
|---|---|---|
| POD-772 | Architecture cleanup ledger | ALREADY an epic collector for exactly this. Reparent under #279 as the cleanup phase. |
| POD-820 | Empty string is a second spelling of unassigned | ADR 4: empty string is a second spelling of unassigned. Data normalization, post-cutover. |
| POD-825 | toWire default listSessions audit | toWire default listSessions audit. Merge with #1265. |
| POD-827 | Hub-mirrored issues stay un-normalized | Moot while the hub stays deferred (#353). Close if federation stays deferred. |
| POD-1106 | Forked workflows record no lineage | Forked workflows record no lineage. Land after #641 to avoid conflict. |
| POD-1107 | Spawn tuple has five restatements that disagree | Spawn tuple restated 5x, two disagree. Correctness facet may deserve an earlier split. |
| POD-1108 | Retry un-skips a skipped step | Retry un-skips a skipped step. |
| POD-1109 | Workflow event log has no reader | Workflow event log has no reader. |
| POD-1110 | Duplicate workflow name leaks a SQLite error | Duplicate workflow name leaks a raw SQLite error. |
| POD-1133 | Shared spawnedBy constructor and parser | spawnedBy tag: 6 producers, 7 hand-rebuilds, 5 of them gate parenthood. |
| POD-1142 | Handoff manifest format 2: attribution pair | Handoff manifest format 2 (attribution pair) — bundle format change. |
| POD-1145 | Session registry map keyed by raw string | Session registry keyed by raw string. Branded-id completion. |
| POD-1171 | Workspace fetch borrows the handoff sessionId param | Workspace fetch borrows the handoff sessionId param. |
| POD-1192 | Branded ids across the client API mirror | Branded ids across the client API mirror (both halves must move together). |
| POD-1199 | Brand drizzle columns and TS id members | Brand drizzle columns + hand-written TS id members. |
| POD-1202 | Dead hub-provenance badges in the issue panel | Dead hub-provenance badges in the issue panel. |
| POD-1265 | Session-free issue wire lookup | Session-free issue wire lookup. Merge with #825. |
| POD-1360 | Legacy repo boot heals | Legacy repo-id/origin/prefix heals still run every boot; retire into bounded upgrade behavior. |
| POD-1361 | Machine id contract branding | Machine-id fields still raw strings. Branded-id completion, no wire change. |


## HUMAN — Needs your decision before anyone can schedule it  (6)

| # | Title | Note |
|---|---|---|
| POD-434 | SECURITY GATE: daemon principals must be tenant-scoped before we host a second tenant | SECURITY GATE for multi-tenant hosting. Intersects #1067 multi-user. |
| POD-435 | Hosted agents MVP: one Fly Machine per tenant, joined with our existing daemon | Hosted-agents MVP: product/infra strategy call. |
| POD-497 | Agent messaging direction: make delivery pull-first at boundaries; treat live-PTY injection as a rare exception | Messaging direction: pull-at-boundary vs live-PTY injection. Explicitly your call. |
| POD-831 | Handoff strands shell sessions | Handoff strands shell sessions — three options, none chosen. Needs your call. |
| POD-960 | Stranded local landings need arch-v2 re-port | Four stranded pre-arch-v2 commits: superseded or re-port? Owners must decide. |
| POD-1067 | Multi-user ownership and sharing | MULTI-USER OWNERSHIP. The issue itself says: affordable now, expensive after the Phase-2 cutover. Decide BEFORE the cutover. |


## DUP — Close on triage (duplicate / already done / withdrawn / stale)  (63)

### → dup of #1048  (7)

| # | Title | Note |
|---|---|---|
| POD-994 | Bug: Outbox wake assertions |  |
| POD-1007 | Bug: relay wake tests |  |
| POD-1023 | Bug: queued wake timing |  |
| POD-1025 | Bug: outbox wake tests |  |
| POD-1026 | Bug: Outbox wake timing |  |
| POD-1037 | Bug: outbox wake timing |  |
| POD-1047 | Bug: outbox wake timing |  |

### → close: stale  (4)

| # | Title | Note |
|---|---|---|
| POD-513 | Runtime applier + store wiring | Empty drizzle-migration sub-task, superseded by the shipped drizzle-kit adoption. |
| POD-514 | Drizzle schema-as-code + baseline | Same. |
| POD-515 | Migration tests ported to drizzle | Same. |
| POD-516 | migration:new + CI drizzle-kit check | Same. |

### → dup of #457  (3)

| # | Title | Note |
|---|---|---|
| POD-465 | Broken test on main: issue-authz registry action classification |  |
| POD-525 | Bug: issueRegistry setLabels action mismatch |  |
| POD-578 | Bug: issue registry classification pin drift |  |

### → dup of #914  (3)

| # | Title | Note |
|---|---|---|
| POD-936 | Upstream write coverage drift |  |
| POD-993 | Bug: Stop forwarding coverage | Adds the issues.stop facet — fold the detail in before closing. |
| POD-1006 | Bug: router coverage drift |  |

### → dup of #961  (3)

| # | Title | Note |
|---|---|---|
| POD-962 | Managed spawn harness drift |  |
| POD-1022 | Bug: multi-instance spawn lane |  |
| POD-1024 | Bug: managed spawn harness |  |

### → dup of #1054  (3)

| # | Title | Note |
|---|---|---|
| POD-1083 | Tests Exclude Review Worktrees |  |
| POD-1094 | Review worktrees enter tests |  |
| POD-1098 | Review worktrees pollute test and lint lanes |  |

### → dup of #1122  (3)

| # | Title | Note |
|---|---|---|
| POD-1198 | Scripts directory typechecked by nothing |  |
| POD-1219 | scripts/ excluded from every typecheck lane | Self-declared duplicate. |
| POD-1222 | Audit scripts sit outside the typecheck gate |  |

### → dup of #928  (2)

| # | Title | Note |
|---|---|---|
| POD-1008 | Bug: web main tests | Also restates #1238 RepoScanFlow. |
| POD-1038 | Bug: feature boundary exception |  |

### → dup of #1132  (2)

| # | Title | Note |
|---|---|---|
| POD-1177 | Bug: installer PATH test breaks on sudo banner |  |
| POD-1237 | Bug: shell banner breaks install PATH check |  |

### → dup of #1301  (2)

| # | Title | Note |
|---|---|---|
| POD-1308 | Normalized-wire load timeouts |  |
| POD-1323 | Bug: normalized wire timeout |  |

### → dup of #1318 (done, #291)  (2)

| # | Title | Note |
|---|---|---|
| POD-1322 | Bug: steward cursor spy recursion |  |
| POD-1327 | Steward cursor spy recursion |  |

### → close: stale ops task  (1)

| # | Title | Note |
|---|---|---|
| POD-229 | Restart the 9 long-lived grok sessions to release ~1.05M inotify watches | One-off restart from 2026-07-09; long overtaken. |

### → dup of #668  (1)

| # | Title | Note |
|---|---|---|
| POD-675 | Tiny-chunk tailer test failure |  |

### → close: verify fixed  (1)

| # | Title | Note |
|---|---|---|
| POD-690 | Bug: main typecheck fails in abduco.test | abduco.test 4-arg typecheck error from 2026-07-16; almost certainly long fixed. |

### → dup of #718 (backlog)  (1)

| # | Title | Note |
|---|---|---|
| POD-717 | Shared bundle-base helper after handoff refactors | Same title already tracked properly. |

### → dup of #801  (1)

| # | Title | Note |
|---|---|---|
| POD-800 | podium auth mint-session for test agents |  |

### → dup of #803 (backlog)  (1)

| # | Title | Note |
|---|---|---|
| POD-802 | Replica byte-identity skip never matches |  |

### → dup of #871  (1)

| # | Title | Note |
|---|---|---|
| POD-870 | Blocking session send parity |  |

### → dup of #743 (review, under #1348)  (1)

| # | Title | Note |
|---|---|---|
| POD-876 | Bug: prime title assertion |  |

### → dup of #918  (1)

| # | Title | Note |
|---|---|---|
| POD-916 | Bug: finished-child notices refire |  |

### → close: probe garbage  (1)

| # | Title | Note |
|---|---|---|
| POD-1014 | probe: agent top-level lands proposed | Description literally reads "delete me". |

### → dup of #1048 + #961  (1)

| # | Title | Note |
|---|---|---|
| POD-1040 | Outbox and spawn regressions |  |

### → dup of #1328 (backlog, #1349)  (1)

| # | Title | Note |
|---|---|---|
| POD-1065 | Bug: server status stale |  |

### → close: withdrawn by its author  (1)

| # | Title | Note |
|---|---|---|
| POD-1097 | Withdrawn: stale service worker theory |  |

### → dup of #740 (backlog, #1348)  (1)

| # | Title | Note |
|---|---|---|
| POD-1100 | Bug: sessions service imports agent-bridge |  |

### → dup of #1105 (done)  (1)

| # | Title | Note |
|---|---|---|
| POD-1103 | Bug: boundaries gate red on integration |  |

### → close: already fixed by 3d31eee7  (1)

| # | Title | Note |
|---|---|---|
| POD-1104 | Bug: NUL byte in client engine source (already fixed) | Self-declared. |

### → dup of #1122 (backlog, #1348)  (1)

| # | Title | Note |
|---|---|---|
| POD-1120 | Bug: scripts/ has no typecheck gate |  |

### → dup of #1229 (done, #288)  (1)

| # | Title | Note |
|---|---|---|
| POD-1136 | Auto-archive precondition reads per-user state |  |

### → dup of #1157 (backlog, #1349)  (1)

| # | Title | Note |
|---|---|---|
| POD-1178 | Daemon composer-sync PTY smoke is red |  |

### → dup of #1294 (done, #1349)  (1)

| # | Title | Note |
|---|---|---|
| POD-1184 | Daemon reconnect tests flake under load |  |

### → dup of #1211 (done, #1348)  (1)

| # | Title | Note |
|---|---|---|
| POD-1194 | Matrix coverage sweep: 14 unclassified classes |  |

### → dup of #1126  (1)

| # | Title | Note |
|---|---|---|
| POD-1225 | Bug: keyboard-fidelity suite skips itself under load |  |

### → dup of #1292 (done, #1347)  (1)

| # | Title | Note |
|---|---|---|
| POD-1266 | Feed identity one-row constraint |  |

### → dup of #1293 (done, #1347)  (1)

| # | Title | Note |
|---|---|---|
| POD-1267 | Remove the dead feed table |  |

### → dup of #1295 (done, #1349)  (1)

| # | Title | Note |
|---|---|---|
| POD-1290 | Bug: browser lane mobile bundle |  |

### → dup of #1299  (1)

| # | Title | Note |
|---|---|---|
| POD-1300 | Bug: worktree mobile build bypass |  |

### → dup of #1234  (1)

| # | Title | Note |
|---|---|---|
| POD-1302 | Relay suite stale import |  |

### → dup of #1311  (1)

| # | Title | Note |
|---|---|---|
| POD-1312 | Claude brevity smoke |  |

### → dup of #1321  (1)

| # | Title | Note |
|---|---|---|
| POD-1362 | Daemon lifecycle boundary drift |  |


## PROD — Stays in Proposed: independent product or infra work  (101)

| # | Title | Note |
|---|---|---|
| POD-203 | Redeploy watcher down: disk 97% full kills podium-redeploy.path | Host inotify ceiling; needs root. Ops, pre-dates rewrite. |
| POD-207 | Agent test harness leaks isolated podium servers + PTY fixtures; saturates the host | Test harness leaks servers/PTYs. Consider merging into #1349 if it still bites. |
| POD-208 | Daemon has no operational logging and no app-level heartbeat | Daemon observability gap. |
| POD-211 | Central agent-environment provisioning (managed logins · fresh-machine bootstrap · GitHub auth) | Epic: central agent-environment provisioning. |
| POD-215 | gh pr create silently fails on daemons without a GitHub login | gh auth on fresh daemons; fixed properly by #214. |
| POD-217 | Environment object: named, reusable per-agent spawn bundles | Environment object feature. |
| POD-218 | Encryption at rest for server-held credentials (AES-256-GCM + log redaction) | Credential encryption at rest. Security backlog. |
| POD-230 | Report grok fs_notify depth-1 .gitignore bug upstream to xAI | Upstream report to xAI. |
| POD-232 | issue CLI: 'update --parentId' silently ignored; 'dep-add --type' unvalidated; '<cmd> --help' executes the command | Tracker arg-parser strictness. PROCESS-RELEVANT: silent flag drops mislead agents. |
| POD-235 | Mobile browser e2e: __podium test API never attaches (newSession times out) | Mobile e2e harness flag lost on replaceState. |
| POD-236 | Auto-rotating account pool (flagged) | Account pool feature. |
| POD-239 | podium update does not re-render systemd units, so unit fixes never reach existing hosts | podium update never re-renders systemd units. |
| POD-240 | System-wide podium-daemon-system.service sets no Environment=PATH | System-wide unit has no PATH. |
| POD-244 | podium update ignores unknown flags silently (--channel edge did nothing, fell back to stable) | podium update ignores unknown flags. Same family as #232. |
| POD-252 | Windows distribution: platform-aware update feed + release publish (podium update is POSIX/linux-x86_64-only) | Windows distribution. |
| POD-270 | Re-nudge sessions whose issue is still a draft (prime injects once per session) | Draft-issue re-nudge. |
| POD-346 | issue audience: immutable after create, and invisible in every text rendering an agent reads | issue audience immutable + invisible. |
| POD-353 | Deferred: hub/node federation — design + product work (post-rewrite) | Federation deferred by explicit user decision; post-rewrite. Keep visible, do not schedule. |
| POD-358 | Align discovery.refreshRepos result contract and router test | refreshRepos contract vs router test. |
| POD-428 | Issue CLI: create/update support dedicated acceptance criteria | Tracker: --acceptance flag. Rewrite wanted it as a lint gate but it is tracker tooling. |
| POD-436 | Fleet ops: cordon/drain, rolling releases, and the health checks we already learned the hard way | Fleet ops (cordon/drain, rolling releases). |
| POD-469 | Managed accounts don't serve the API roles (superagent, background) — two credential stores | Managed accounts vs settings.apiKeys — two credential stores. |
| POD-476 | merge-lock lease (2m) expires during the pre-merge test gate | merge-lock lease expires mid-gate. PROCESS-RELEVANT: silently manufactures false confidence. |
| POD-477 | Managed credentials are hardcoded to the coding role — superagent and background can't use them | Managed creds hardcoded to coding role. |
| POD-480 | Steward nudges + superagent resume_and_send bypass the messages substrate — can still type into a busy/needs_user agent | Steward/superagent bypass the messages substrate. |
| POD-487 | podium mail CLI is broken on the operator (no-relay) path: 'Unable to transform response from server' | Operator mail CLI broken (no-relay path). Blocks operator-side interrupt. |
| POD-488 | artifact-add rejects sources outside the session workspace (e.g. /tmp scratchpads) | artifact-add rejects scratchpad sources. |
| POD-493 | No agent/operator-accessible way to STOP a runaway session; issue-start spawns bypass the spawn budget | No stop primitive + spawn-budget bypass. Partly addressed by #954 — verify. |
| POD-523 | Worktree auto-clone handoff | Worktree auto-clone handoff; waits on managed credentials. |
| POD-530 | Structured Session Spawn Provenance | Structured spawn provenance. |
| POD-532 | Bug: Codex Startup Errors Hidden | Codex startup errors hidden. |
| POD-540 | Bug: Hidden Issue Starts | Hidden issue starts (agent-audience orphan can run invisibly). PROCESS-RELEVANT. |
| POD-549 | Bug: issues stage CHECK re-allows verifying | issues.stage CHECK re-allows verifying (silent constraint regression). |
| POD-561 | Stale harness hook cleanup | Stale foreign harness hook. |
| POD-562 | Bug: opencode loadConversation ignores session root | opencode loadConversation ignores session root. |
| POD-567 | Bug: unblock nudge skips ancestor sessions | Unblock nudge skips ancestor sessions. |
| POD-592 | Nice refs in mail and workflow strings | niceRef formatting in mail/workflow strings. |
| POD-596 | Worktree reaping sweep | Recurring worktree reaping chore. |
| POD-604 | Bug: relay port fallback strands sessions | Relay port fallback strands sessions. |
| POD-625 | Agent relay over a Unix socket | Agent relay over a Unix socket. |
| POD-629 | Bug: daemon restart port collision | Daemon restart port collision. Merge into #604. |
| POD-653 | Bug: shell collapse persistence | Shell collapse persistence after reload. |
| POD-672 | Bug: browser shim shadows open/xdg-open | Browser shim shadows open/xdg-open for non-URL uses. |
| POD-676 | Bug: deploy race blanks the web UI | Deploy race blanks the web UI. Real live-ops bug. |
| POD-691 | Bug: queued turn swallowed on wake | Queued turn swallowed on wake — durable message silently lost. Serious. |
| POD-697 | Update-URL self-migration | Update-URL self-migration. |
| POD-713 | Bug: shared git stash stack across worktrees | git stash is repo-wide. Workflow-rule change, not code. |
| POD-720 | Bug: reparent leaves no audit trail | reparent leaves no audit trail. PROCESS-RELEVANT: authorized op, no undo. |
| POD-739 | Telemetry spec + handoff counters | Telemetry spec/handoff counters. |
| POD-801 | podium auth mint-session for test agents | podium auth mint-session for test agents. |
| POD-818 | Bug: todo checkbox ignores its own click | Todo checkbox click is a no-op (Base UI label pattern). |
| POD-819 | Bug: issue archive doesn't stick | issue archive does not stick. |
| POD-830 | Worktree changes push, not poll | Push worktree changes instead of polling. |
| POD-839 | Bug: macOS app freeze after deploy | macOS app freeze after deploy. |
| POD-858 | Tauri target dirs balloon per worktree | Tauri target dirs balloon per worktree. Root cause of recurring disk pressure. |
| POD-866 | Cap the browse isRepo stat fan-out | Uncapped isRepo stat fan-out on browse. |
| POD-869 | Optimistic draftEdit rev rebase (web+mobile) | Optimistic draftEdit rev rebase. |
| POD-871 | Blocking session send parity | Blocking session send parity. |
| POD-872 | Bug: ask/awaitAgent time out past 30s on relay | ask/awaitAgent exceed the 30s relay timeout. |
| POD-873 | Bug: issue start drops model config | issue start drops model/effort. PROCESS-CRITICAL: silently mis-spawned the fan-out. |
| POD-874 | Bug: workflow run coordinator not transferable | Workflow coordinator not transferable. PROCESS-CRITICAL: stranded every respawn. |
| POD-918 | Bug: done child re-notifies parent forever | Done child re-notifies parent forever. PROCESS-RELEVANT: buried real signals. |
| POD-924 | Combined rollback regression pin | Rollback regression pin (POD-841 follow-up). |
| POD-926 | Reference contention regression | Reference contention regression pin. |
| POD-930 | Bug: codex identity receipt ENOENT loop | Codex identity receipt ENOENT + no-op-turn degradation. Serious harness bug. |
| POD-943 | Projection reschedule latch | Projection reschedule latch (publish worker). |
| POD-944 | Buffered delta diagnostics | Buffered delta drop diagnostics. |
| POD-945 | Bug: composer guard misses sitting draft | Composer guard misses a sitting draft. P1 — corrupts your own input. |
| POD-949 | Authority resolver runtime guard | Publication-authority resolver runtime guard. |
| POD-951 | Edge daemon protocol skew | Edge daemon protocol skew. |
| POD-952 | Update approvals name target | Update approvals do not name the target machine. |
| POD-955 | Inactivity auto-reap for sessions | Inactivity auto-reap, deferred at your request. |
| POD-956 | Bug: spec CLI wrong-machine repo path | spec CLI resolves the repo path on the wrong machine. |
| POD-984 | Bug: issue stop reaps zero sessions | issue stop reaps zero sessions. P1 tracker bug with a verified root cause. |
| POD-1002 | Assignee trigger semantics | AssigneeMenu nativeButton contract. |
| POD-1010 | Bug: config write drops serverUrl | config.test escapes its sandbox and clobbers the live config. Serious. |
| POD-1011 | Bug: server segfault in wsServer message path | Bun segfault in the wsServer message path. |
| POD-1031 | Bug: quadratic superagent seed | Quadratic superagent seed. |
| POD-1032 | Bug: queued-turn restart loop | Queued-turn restart loop. |
| POD-1034 | Bug: shutdown delivery flood | Shutdown delivery flood hides crash evidence. |
| POD-1053 | Bug: Handoff source residue | Handoff leaves source worktree + residue. |
| POD-1061 | tmux shim for agent teams | tmux shim so harness agent-teams surface as Podium sessions. |
| POD-1068 | Bug: Responsive mobile shell | Responsive mobile shell lost. |
| POD-1082 | Direct CLI Operator Authentication | Direct CLI operator auth. Merge into #487. |
| POD-1095 | Bug: Live web runbook | Live web runbook describes a retired topology. |
| POD-1099 | Work tab lost New task entry point | Work tab lost the New-task entry point. |
| POD-1111 | Bug: full disk silently truncates writes | Full disk silently truncates writes. Host-level; ten agents share the box. |
| POD-1112 | Dev machine disk exhaustion | Dev machine disk exhaustion. Likely already relieved. |
| POD-1128 | Relay allowlist blocks the session seance | Relay allowlist blocks session ask — feature unreachable from any agent CLI. |
| POD-1139 | Redeploy drops queued mail delivery triggers | Redeploy drops queued mail delivery triggers. |
| POD-1169 | Bug: transcript echoes never confirm | Transcript echoes never confirm delivery. Relates to #497. |
| POD-1170 | Bug: interrupted Claude remains working | Interrupted Claude stays working; blocks next-turn drain. |
| POD-1181 | issue start branches from main | issue start always branches from main. PROCESS-CRITICAL for epic fan-outs. |
| POD-1182 | Coordinator CLI gaps in the fan-out | Coordinator CLI gaps. PROCESS-RELEVANT: each cost the fan-out a wrong turn. |
| POD-1186 | Spawn Completion Result Contract | Spawn completion result contract (from the spawn gap analysis). |
| POD-1187 | Spawn Capability Negotiation | Spawn capability negotiation. |
| POD-1188 | Atomic Isolated Agent Spawn | Atomic isolated agent spawn. |
| POD-1189 | Spawn Context Handoff Contract | Spawn context handoff contract. |
| POD-1190 | Spawn Description Brief Separation | Spawn description/brief separation. |
| POD-1317 | Bug: new agent sessions never spawn | New agent sessions never spawn. Live P0-shaped; verify whether resolved. |
| POD-1358 | Bug: shared issue inbox consumes peer mail | Shared issue mailbox consumes peer mail. PROCESS-RELEVANT: an inbox read eats a peer message. |

