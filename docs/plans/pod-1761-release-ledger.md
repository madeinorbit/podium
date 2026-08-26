# POD-1761 release ledger — every capability, one milestone, one action

*Written 2026-08-25. This is the coordinator's execution sheet. It sorts every
row of `docs/architecture/driver-capability-catalog.md` into exactly one
milestone (from `docs/plans/pod-1761-release-milestones.md`) with exactly one
action, and defines tonight's runbook and its scorecard.*

## The action vocabulary

| action | meaning | tonight's cost |
|---|---|---|
| **confident** | proven live, or pinned by a test that bites (mutation-checked). No work beyond keeping gates green. | zero |
| **check** | code exists; nobody has watched it work on the tip. One live drive step, result written down. | minutes each |
| **land** | a fix exists on a review-stage issue branch. Merge under lock with its verdict, then drive it. | the review queue |
| **implement** | does not exist and its milestone needs it. | not tonight unless listed |
| **defer(Mx)** | scheduled for milestone x; explicitly not v1's problem. | zero |

Status correction feeding this ledger: of the ten v1 blockers named in the
milestones doc, **seven are already fixed on review-stage branches** (POD-2470,
POD-2116, POD-2761, POD-2602, POD-2775, POD-2298, and POD-2604 which is blocked
on a dependency), and only four are open work (POD-2772, POD-2631, POD-2692,
POD-2691) plus POD-2432 (restart-safe inventory).

---

## Tonight's runbook (M0 + M1 candidate)

Ordered. Each step has a measurable exit; do not start a step before the
previous one's exit is true.

**Step 1 — land the review queue.** For each of POD-2470, POD-2116, POD-2761,
POD-2602, POD-2775, POD-2298: confirm its reviewer verdict is a pass (request
the review if none exists), then ff-only merge to `issue/1761-agent-runtime`
under `podium merge-lock`. POD-2604 first needs its blocker cleared or the
dependency waived. *Exit: all six merged; `git log` shows them on the tip.*
Status 2026-08-25 15:32: POD-2775 reports fixed AND driven (A/B evidence on the
issue, branch tip `a62c09c72`, each fix mutation-checked) — land first, it
unblocks judging POD-2761.

**Step 1 progress, 2026-08-25 evening (coordinator, verified not reported):**
- POD-2775 **LANDED** at `059dc628a`. Hibernate→resume works on codex: parked
  session live in 2.4s, ALPHA (pre-park) and BRAVO (post-resume) both in the
  transcript, against a byte-identical control build where it never came back.
  Three defects, mutants attributable one test each.
- POD-2574 **LANDED**. R1 fixed; typecheck fully cached (549ms). Its author
  reopened F2 against themselves — "already told synchronously" holds for an
  operator at the composer, is FALSE for an agent mailing another session where
  nothing renders the return — and found a test red since the commit that
  introduced it, because nobody had run the module.
- POD-2761 **REOPENED, and this is the one to watch.** The ordering pin landed
  (`7c69a6430`) and I verified it myself: the reviewer's previously-surviving
  mutation now kills exactly one test. But its session closed on item 1 of five,
  and item 3 is worse: `start()` is not only the cold-start path — `attach()`
  calls it on two documented CONTINUATION cases, where `spawnAbducoAgent` adopts
  a LIVE master and only repaints the viewport. So the reset deletes scrollback
  nothing will redraw and truncates the server's replay log. That is exactly the
  half of the operator's report the drive could not reproduce, and this change
  can now CAUSE it. `hasMaster(record.label)` is the named discriminator.
- POD-2780 (`@podium/web` typecheck red on the tip, named in step 2 below)
  **FIXED** at `d71456bc8` — a fixture missing `since`/`nativeSubagentCount`.
  Found by running the whole gate rather than the package I had touched.
- POD-2631 **fix landed** (`589512488`, "publish in-flight inventory probes").
  Its real shape is a WINDOW not a wedge: for ~40 minutes after a daemon start,
  installed harnesses report `not installed` and every spawn fails with a flat
  refusal. It blocked all claude-code spawns this evening, then self-healed.
- Gate tooling: the shared Turbo cache now lives inside the repo instead of
  `/tmp` (it died with every reboot), and `bun run typecheck` caps its own
  concurrency from free memory. Both were burning this box.

**Step 1, second pass — what the independent reviews found (2026-08-25 ~20:30):**
- POD-2470 **CLOSE.** All three properties hold and the rule is wired into the
  real gate, not merely unit-tested — the reviewer checked that too, correctly
  calling a rule that is only unit-tested "the other vacuity". Two-hop leak
  mutation RED with the full chain printed.
- POD-2631 **fixed and pinned.** Root cause: daemon attach marked the machine
  online while keeping the PREVIOUS connection's inventory authoritative, so a
  stale `installed: false` became a confident false negative; re-probes also
  superseded the authoritative wave and completed results were discarded. Now
  reports `probing`, spawn WAITS 25s, `podium machine reprobe` exists, and
  opencode discovery pins `~/.opencode/bin/opencode`. I ran its regression test
  (28 passed) and broke it (1 failed / 27) — it had never been executed, because
  the per-file vitest command collects ZERO tests under `apps/server`.
- POD-2761 **both rounds verified by my own mutation**, not by report: the
  ordering pin bites, and forcing `reattaching = false` goes RED across the
  opencode, codex AND grok adopted rows. Its A/B is still null and says so.
- POD-2775 **REOPENED — the most important finding of the night.** Two things:
  **(a) a parked OPENCODE session still cannot come back.** Its `adopt()` needs
  `probeHealth` against a server the park killed; codex is fixed, grok is fine,
  opencode is not. A codex-shaped route was generalised to three families and
  one was checked. **(b) NOTHING asserts the resumed session is the RIGHT
  conversation** — mutating a resume to a stranger's thread id left 269 tests
  green, because the conformance suite compares ids and generations but never
  the conversation, the fake app-server ECHOES BACK whatever thread id it is
  handed, and the drive checked only that both strings appeared. The single
  property resume exists to deliver has no automated defence at any level.

**Step 2's exit criterion was UNREACHABLE AS WRITTEN, and is corrected here.**
It said `bun run lint:boundaries` must be green. **Main is itself red** — measured
on a clean detached worktree of `206693584`, it exits 1 with **21 architecture-
manifest lines of its own**: ten harness-branching in `FirstTaskActivation.tsx`,
four in the mobile screens, one in the daemon's `control/credentials.ts`, a
manifest-browser-reach, a ui-storage-ownership, and four manifest-layer on the
daemon's server-recovery-worker that this epic has since fixed. So the reachable
criterion, and the one POD-2820 held to, is: **the epic's violation set is a
SUBSET of main's.**

Against that bar, after POD-2820: **the dependency-boundary section IS a strict
subset. The manifest section is not** — ten harness-branching lines remain, nine
in `opencode-attach.ts` and one in `inbox.ts:538`. **POD-2823** owns all ten. The
full delta is `docs/gates/pod-2820-boundary-lint-delta.md`.

Also red **on main**, so not epic debt but it will show in any full run:
`scripts/architecture-manifest.test.ts` — the manifest tags `packages/harness`
`neutral` while `docs/rearchitecture-v3.md:627` still says `node-only`. POD-2822.

**Step 2 — gates green, and meaningful.** Run on the tip, stating whether
`PODIUM_TEST_WORKERS` was set (it changes the outcome):
`bun scripts/typecheck.ts` (25/25), `bun scripts/test.ts` (full suite, under
the `test:heavy` lock, short-disk TMPDIR), `bun run lint:boundaries` (baseline
is 6 known lines — zero NEW). Stale-golden and gate bugs that block this step:
POD-2714, POD-2759, POD-2778, POD-2728, POD-2040, POD-2031. Known reds already
attributed: `@podium/web` typecheck fails on the epic tip itself (POD-2780,
filed 2026-08-25 with reproduction — fix or attribute before release), and
`scripts/test-configuration.test.ts` is red iff `PODIUM_TEST_WORKERS` is set
(environment, not code — run the gate with it unset and say so). *Exit: all
three commands green, or every red attributed to a filed issue that is provably
pre-existing on main.*

**Step 3 — repin the operator instance** (`/tmp/pod-op`, port 19797) to the
tip and **verify the pin** (a drive proves nothing on an older commit —
check the running commit, not the deploy log). *Exit: instance reports the
tip's commit.*

**Step 4 — the Tier-A drive matrix.** The scorecard below, driven by hand or
script on the instance. Save a screenshot or transcript per cell and attach the
set to this issue. *Exit: zero failing cells.*

**Step 5 — triage the four open blockers.** Fix tonight or waive in writing:
- POD-2772 (login gate silently demotes server drivers to the terminal path)
  — **must fix**: it defeats the point of the release; sessions would quietly
  not be on the new drivers. Verify after: a logged-in opencode/codex/grok
  session reports `driverFamily: server`.
- POD-2691 (dead servers accumulate) — fix or waive with a documented manual
  reap and a cap; the drive matrix row A9 decides.
- POD-2631 (failed install probe cached as "not installed") — waivable
  tonight with the documented recovery (daemon restart) IF the drive matrix
  never hits it; fix is small (don't cache a timeout as absence).
- POD-2692 (login readout reads the operator's home, not the instance's) —
  waivable if tonight's release doesn't target named instances; otherwise fix.
- POD-2432 (sessions listable after daemon restart) — the A7 row of the
  matrix decides: if kill-daemon → restart → session resumes cleanly on all
  three drivers, tonight's bar is met without the full inventory work.

**Step 6 — release.** Merge the epic branch to main under merge-lock, tag,
release notes name: what flipped (three server drivers), the escape hatch
(`PODIUM_RUNTIME_DRIVER=generic-pty`), and the written waivers from step 5.
*Exit: main is the tip; instance repinned to main; matrix re-run spot-check
(A1, A7) passes.*

**Step 5's must-fix is DONE: POD-2772 landed (`2d641120b`).** It was three
causes behind one red lane, and the headline is that **the login gate was telling
the truth** — it is not what to change:

1. **The home.** The lane pointed `discovery.homeDir` at a bare mkdtemp. That is
   not only the scanner's root: host-runtime makes it `ctx.homeDir`, the home
   inventory reads harness login from, AND the HOME every server-driver child is
   spawned with. Under an empty home opencode is *genuinely* logged out, a
   logged-out harness has no headless path to admit, and the spawn naming
   `opencode-server` is refused before any server starts. The isolated home now
   carries `auth.json` and nothing else — the move `applyRealAgentCodexEnv`
   already makes for codex — leaving the 243MB conversation store behind.
2. **The model.** Suspected to be the same empty home one layer down; it is not.
   `opencode/laguna-s-2.1-free` has been RETIRED from opencode's gateway and
   answers `UnknownError` under the isolated home and a real one alike, which no
   credential story survives. The lane now resolves a free model the gateway
   still lists, and throws naming what it *did* list rather than handing that to
   a `waitFor`.
3. **The reaper — a false-red generator across the whole e2e suite.**
   `SuperagentService` is built from `registry.modules`, so it exists only after
   the registry and is not among the modules `SessionRegistry.dispose()` names.
   Its turn reaper kept firing into a closed database, and every e2e file ended
   with two or three `RangeError: Cannot use a closed database`, which Vitest
   counts as unhandled and fails the FILE on. **A lane whose every assertion
   passed still reported red.** Anyone who has chased an e2e red on this epic may
   have been chasing this.

Measured live on opencode 1.18.16: before, 1 failed with 3 errors; after,
1 passed, 0 errors, 31s of assertions against 184s of timeouts.

## THE HARNESS-NAME REFACTOR FOUND A REAL CREDENTIAL LEAK (POD-2823)

Removing the nine name-branches from `opencode-attach.ts` was supposed to be
hygiene. It uncovered a live defect instead, which is the strongest argument the
refactor could have made for itself.

The strip-list branch picked between three constants **by harness name** and then
unioned the result with `harnessChildStripEnv(kind)`, which reads the same fact
off the manifest — redundant since POD-2296. For opencode and grok both sides were
identical arrays. **For codex they were not**: `STRIPPED_CODEX_CREDENTIALS` carried
six variables while `codex.inventory.foreignCredentialEnv` carried three.

**So every codex spawn that read the MANIFEST — the PTY path, the login probes,
`serverChildEnv` — had been leaving `OPENAI_ORGANIZATION`, `OPENAI_ORG_ID` and
`OPENAI_BASE_URL` in the child's environment**, while the app-server path stripped
them. Two sources of one truth, disagreeing, with the disagreement invisible
because each caller only ever consulted one of them.

**Verified by mutation:** deleting `OPENAI_BASE_URL` from the manifest again kills
*strips exactly what each harness declares its client must not inherit* — 1 failed
/ 43 passed, restored byte-identical. The two lists are now pinned equal by test.

The nine branches turned out to be **four questions**, not nine: which durable
label a parked client holds, what reopens this conversation, whether an engine
address rides on argv, and whether per-session server credentials ride in the env.
The last three are all `launch()`, and the address/secret split was not a new axis
at all — it is `ServerRuntimeSpec.transport`, which W1 had already declared.

## TWO RELEASE BLOCKERS FOUND BY TRYING TO HAND THE OPERATOR AN INSTANCE

Standing up their test environment found more than the drive matrix did, because
it exercised a path no test and no rig covers: **a named instance on a real box.**

**POD-2853 — a named instance cannot start ANY terminal session.** Two defects,
one on top of the other:

1. **The socket path is 112 bytes against a 108-byte kernel limit.** Three things
   compose it, and only for a NAMED instance: `applyInstanceRuntimeEnv` pins
   `ABDUCO_SOCKET_DIR = <stateDir>/runtime/abduco`; `abducoSocketDirs` then appends
   `abduco/<user>` — note the **doubled `abduco/abduco`** — and the label is
   instance-prefixed `podium-<instance>-<uuid>@<hostname>`. It surfaces as
   `create-session: File name too long`, naming neither the path nor the limit.
2. **Underneath it, the creator and the prober disagree.** Force a short socket
   dir and the length error is replaced by *"did not publish a live socket"* —
   **while the socket is on disk.** I listed it while the daemon reported it
   absent. Same class as POD-2761's `hasMaster` (wrong environment, wrong moment,
   one-sided toward absent), but at the **spawn** path, which that fix did not
   cover.

**Every acceptance rig, every evidence drive and the operator's instance is a
named instance.** The default instance never hits either, which is why a week of
work did not surface them.

**POD-2854 — `bun run build` fails its own size budget**, 7,810,696 against
7,780,000. I built the instance with `build:dist`, which skips the check, so the
instance exists but the RELEASE build does not pass. Filed with the budget file's
own policy quoted, because it is unusually clear that a raise without a paydown
is not acceptable: *"they pass THINLY… the next feature of any size turns one of
those red, and a payload budget going red means shipping more to the browser.
That is not this argument, and it does not get this raise."*

**And a process failure of mine worth recording.** I handed over an instance
verified only by its PINS — server, daemon and bundle all reading the right
commit — and called it ready. **A pin check proves the right code is loaded; it
proves nothing about whether a session starts.** The rule I have enforced on every
agent all night is that a deliverable gets driven by whoever hands it over, and I
exempted myself. I then guessed the cause twice before reading `instance.ts` and
measuring the actual string.

## THE LATENCY IS GONE WHERE IT WAS UNEARNED, AND KEPT WHERE IT IS EARNED

POD-2836 landed (`ab9d5bcb9`). `liveAtMs` was stamped in the drain's first tick;
it is now seeded from the **bind**. `READY_MAX_MS` untouched at 6s.

**Measured on real sends, not only in tests** — isolated instance, real claude-code
CLI in a real PTY, timed from `sessions.sendText` to the user turn the CLI writes
into its own transcript, which is the product's own witness and the same one the
drain's `confirm()` watches. Both arms byte-identical apart from one file:

```
bound and idle 60s, first chat send
  before  6.585 / 6.958 / 6.497 s      after  0.417 / 0.464 / 0.422 s
sent AT the bind, composer genuinely unproven
  before  3.401 / 2.799 s              after  3.529 / 2.795 s
```

**The second row is the point of the first**: the wait is still there and still
spent for a composer that has not proven itself. The fix removed the unearned
wait, not the wait.

**And it fenced my own instruction into a test.** I had said *the window is right,
its start is wrong — do not shorten `READY_MAX_MS`.* Shortening it 6000 → 500 now
kills tests; **I verified that myself: 10 failed / 70 passed, restored
byte-identical.** An instruction that only lives in a mail decays; one that reddens
a suite does not.

It also found what already knew the bind time rather than adding a field: the bind
was already *announced* to `SessionInbox.markSessionBound`, which existed to clear
the readiness marker. It now stamps the moment in a `WeakMap` beside the `WeakSet`
it already kept — no durable field, because *the fact only matters while the
process it describes is running, and a persisted copy would outlive it.*

**The numbers raised to tolerate the bug came back down, and by the right route.**
`FIRST_SEND_AFTER_BIND_MS` 10s → the 2s default, three `30_000` per-test bounds
removed — **by changing the SETUP, not by loosening an assertion.** Every assertion
in those three is byte-identical; the fixture's registry now takes a movable clock
(opt-in, so every other oracle caller still gets `Date.now`) and `goIdle` advances
it 60s after announcing the bind. The drain still polls on real timers; only the
elapsed time it asks for moves. So the send those three make is *the send they were
always about* — a dedup replay into a session whose composer has demonstrably had
its window — rather than a measurement of how long a fresh CLI takes to mount one.

```
resumeAndSend dedupes its replay      2108ms -> 320ms
sendText dedupes its replay           2056ms -> 351ms
a replayed send does not double-type  2075ms -> 260ms
whole file                           19.37s -> 2.39s
```

**Both halves fenced, and I verified both myself.** Ageing the bind by 0 instead of
60s kills exactly those three (I ran it: 3 failed / 15 passed). Reverting the clock
fix with the rig kept also kills all three — *the honest statement of the
dependency*: the tightened bound is affordable **only** because the clock is
anchored to the bind, and anyone who reverts that will hear about it here. The
constant survives at its default rather than being deleted, saying what it now
tolerates — one poll tick plus the deferred CR, not a readiness window — so the
file fails loudly instead of quietly getting slow again.

**A lead it flagged and deliberately did not chase — POD-2843, started.** After a
server OR daemon restart, typing into a **reattached** claude session stopped
reaching the CLI at all: the row was typed **five times to its attempt cap** and no
user turn ever appeared, though the same session had taken a send fine before the
restart. They worked around it with a fresh session per rep and said plainly it may
be the rig. If it is real, the readiness queue is not covering the case it was
built for.

## A TEST CANNOT SCRUB PATH TO BECOME HERMETIC — worth knowing beyond its issue

POD-2826's three host-dependent inventory tests are fixed (`ef1fe5838`), and it
answered the question rather than guessing between the two options: **the injected
exec WAS meant to bypass PATH resolution, and resolution was leaking past it.**
History proves intent — before POD-2280 introduced `resolve()`, the probe used
unresolved candidates and the same test asserted a path under the FIXTURE home;
that commit rewrote the expectation to the bare name, **which is exactly what the
fallback yields when resolution fails.** That is the day the assertion started
depending on the host.

**The general finding: you cannot make such a suite hermetic by editing PATH.**
`createCommandEnvironment()` always appends `/usr/local/bin`, `/usr/bin`, `/bin`
(plus `/opt/homebrew` on darwin) *after* the inherited PATH. Demonstrated: with a
PATH holding only node and bun shims, the two agent assertions **flipped green**
pre-fix — the host was deciding the verdict — while the `gh` one stayed red,
because `gh` lives in `/usr/bin` and no PATH edit can hide it.

**And the guards are built the right way round.** Rather than asserting the
absence of resolution, two new tests **plant a real runnable file** named `claude`
and `gh` in a temp dir on PATH, so the resolver genuinely answers and the guard
fails on *every* machine — not only one that happens to have the CLIs installed.
`probeTool` resolves separately from `candidatePaths`, so there is one guard each.

**Verified by my own mutation:** restoring the old expression puts 3 of 28 back
red; the fixed form is 28 passed, restored byte-identical.

## THE SWEEP'S RED, ATTRIBUTED — most of the remainder is MAIN'S

Re-run per file against a detached main worktree, using the corrected method
(does it EXIST on main, and does it FAIL there):

| file | main | verdict |
| --- | --- | --- |
| `protocol/wire-golden.test.ts` | **7 failed** | main's |
| `sync/outbox/outbox.test.ts` | **1 failed** | main's |
| `runtime/settings.classification.test.ts` | **1 failed** | main's |
| `client-core/engine/runtime.test.ts` | **1 failed** | main's |

Ten tests that are not this epic's debt. The `scripts/*` audits are the POD-2040
baseline already recorded.

**`relay.test.ts` is 189/189** (POD-2837), from 8 failed / 187. And rewriting it
turned up a **real product defect**, fixed as POD-2838:
`SessionAuthz.authorizeQueuedInputAtApply` **threw instead of returning its
verdict** — out of `deliverNext` into `tick`, killing the drain pass with the row
**neither delivered, nor removed, nor reported**. The reachable case is the
superagent: `authorityOf({kind:'superagent'})` mints a delegationRef that is a
literal and never a session id, so **every superagent send delivered by the drain
took that path**. It surfaced only now because a claude-code send always rides the
queue, and the synchronous path had never consulted that gate at all.

**And three of the checks it "preserved" had never pinned anything.** The fake
clock does not run a timer scheduled DURING a tick until the next advance, so
*"the paste is alone on the wire"* was **equally true of a CR sent with no delay**
— setting `SUBMIT_CR_DELAY_MS` to 0 left every one of them green on the old shape
too. The `needs_user` guard had stopped being reachable at all, because `sendText`
refuses an open menu first. Both are now pinned on the order the queue creates.

Two files still assert the retired contract, one of them **in a gated lane** —
POD-2842, started.

## A FLAW IN MY OWN ATTRIBUTION METHOD, found by the work it produced

POD-2839 corrected me twice and the second one matters more than the issue.

**I claimed all four failing files "exist on main and pass there". Two do not
exist on main at all** — `spawn-strip-env.test.ts` and `opencode-server.test.ts`
are epic-only. My method was to diff the FAIL-file lists between the two sweep
logs and take the set difference as "epic-only failures". **A file absent from
main never appears in main's failure list**, so that difference silently
conflates *fails only on the epic* with *exists only on the epic*. The per-file
A/B and the bisect are sound; the cheap list-diff that chooses what to A/B is not,
and it reads as evidence when it is only a filter.

**And the four reds were not one bug.** I attributed all four to `90396a92d` from
one bisect; only that file's failure was. The other three each had their own
commit, each found separately:

| file | first bad commit |
| --- | --- |
| `spawn-strip-env` | `90396a92d` scrub parent harness environment (POD-2117) |
| `harness-runtime` | `fccd20d28` login reads for the instance's own home (POD-2692) |
| `instance-bootstrap` | `85564b383` an instance uuid a reaper can attribute by |
| `opencode-server` | `ae6379b19` let a parked server session come back |

**The scrub decision went the way the widening argued for, and the reasoning is
worth keeping.** The daemon is routinely started *from inside a Claude session*,
so `CLAUDE_CODE_CHILD_SESSION` and its three siblings really do reach every
child — and a child that reads them **subordinates itself to that conversation and
stops writing a transcript**, which is Podium's own state and history channel. It
was already pinned in two other places; `spawn-strip-env.test.ts` was the only
stale reader.

**The limit survived the widening**, which was the thing I asked them to establish
first: *"never deletes a credential the server put on the frame"* was failing on
the ARRAY, not on its subject — `ANTHROPIC_API_KEY` stayed out of the strip list
throughout, because the sessionEnv exemption lives inside the credential half. It
now asserts that limit on its own line.

**Verified at the tip by me: 5, 4, 2 and 39 passed.**

## THE DECISION THE REGRESSIONS FORCED — the readiness queue IS the contract

Chasing the write-path regressions turned up the real finding underneath them:
**the tip holds two directly contradictory assertions about one call.**
`relay.test.ts` says a claude-code `sendText` to a bound session returns
`{ok:true}` and types now. POD-2116's `inbox.test.ts` says it returns
`{ok:true, queued:true}` and types nothing. **Only one lane is gated** — which is
exactly why an eleven-test regression sat invisible for three days.

**RULED, 26 Aug: the readiness queue is the contract. POD-2116's diversion
stands.** The eight remaining `relay.test.ts` failures get rewritten to drive the
queue, keeping every byte-level assertion (POD-2837, started).

The reasoning, recorded so it can be checked rather than taken:
- **The queue exists to stop a silent loss.** Bytes typed into a composer the CLI
  has not mounted are accepted by the pty and dropped by the app. The synchronous
  contract is faster and loses messages; a user who waits has recourse, a user who
  sees nothing has none.
- **POD-2823 reached the same model independently**, from a different issue in a
  different direction: `composerReadiness`, with claude declaring `confirmed-turn`
  — claude's composer readiness is **invisible**, so the only proof it will accept
  typing is a user turn in the transcript. A synchronous contract cannot be
  honoured for a harness whose readiness cannot be observed.

**Two conditions attached.** POD-2829 is promoted to a blocker and started as
POD-2836: 6.3s on *every* first send after a bind, because `liveAtMs` is assigned
in the drain's first tick, so the clock starts at the **send** rather than the
**bind** and never expires. That is a bug in the clock, not the design — *the
window is right, its start is wrong; do not shorten `READY_MAX_MS`.* And the
rewrite must make both lanes agree explicitly, or the repo drifts back to
whichever answer nobody runs.

**THE LESSON FROM THAT ROUND, corrected by its own author against my flattering
version of it.** I wrote that they held the `#473` distinction against their first
instinct. They say not: their first instinct was wrong, my warning is what stopped
it, and what actually caught it was **refusing to group** — running the eleven and
reading each failure's OWN error rather than the cluster's name. At which point
`#473` said *expected true to be false* on `r.ok`, which is not a latency failure
and could not be one.

> **The cluster names were a better story than the errors, and the errors were
> right.**

That lands on me too: an hour earlier I had grouped those ten in a mail as "the
same question one layer out", which is exactly the reading they then had to
resist. **A plausible grouping is a hypothesis wearing a conclusion's clothes**,
and this epic has now paid for that twice in one night.

**The fix it produced is one its author talked themselves out of reaching for.**
Their first instinct on the `#473` pair was to reach for the same exemption; it
would have been wrong. Diverting a claude-code send to the queue moved it **past
the guards `typeText` applies**, so a send at a live AskUserQuestion menu returned
ok instead of refusing — and a submitting CR typed at that menu **answers the
highlighted default, picking an option on the human's behalf.** A safety guard
that had been jumped over, not an exemption that needed widening.

## THREE REGRESSIONS ATTRIBUTED, EACH TO ITS OWN COMMIT, BY BISECT

The method that works: per-file A/B against a detached main worktree to confirm,
then `git bisect run` on that single file to name the commit. Seconds per probe.

| file | epic | main | first bad commit |
| --- | --- | --- | --- |
| `oracle-idempotency.test.ts` | 3 failed / 18 | **18 passed** | POD-2828 bisecting |
| `relay.test.ts` | 11 failed / 187 | **171 passed** | `abd7c1a5d` (POD-2116) |
| `oracle-errors.test.ts` | 1 failed / 15 | **15 passed** | `e0ffb0df0` (POD-2631) |

**All three are the write path or its guards** — *"timed out waiting for the first
chat send to reach the PTY"*, bracketed paste with a delayed CR and the POD-152
CR-retry rules, and *"a timed-out target inventory probe is a retryable 412, not a
500 or an absence claim"*.

**The third one indicts my own closure.** I closed POD-2631 on my own mutation: I
ran its regression test (28 passed) and broke it (1 failed / 27). That proved the
new guard works. **It did not prove nothing else broke — and this is what else
broke.** A mutation validates a guard; only a suite validates a change. Worse, the
test it broke asserts the *other half of POD-2631's own principle*: that fix
existed because a timed-out probe was recorded as an absence it had not earned,
and the test says a timed-out probe must surface as a retryable 412 rather than an
absence claim. Fixing one half moved the other.

**WHY NONE OF THIS WAS VISIBLE.** `relay.test.ts` is in the server **boundary**
lane and `oracle-*.test.ts` in **services**; the epic's gates are typecheck, the
four-file lean gate, touched suites and boundary-no-new. **No epic gate reaches
either lane.** An eleven-test regression sat there since `abd7c1a5d` and nothing
in the process could have said so. That is the argument for this sweep, and it has
now paid for itself three times.

## THE FULL SUITE — RED, AND MY FIRST BASELINE COMPARISON WAS INVALID

**The epic's full `test:unit` sweep is RED**: 12 of 28 tasks, 26m57s, nothing
cached. `@podium/web` alone is **84 tests failed across 22 files** (3161 passed),
with `useStore outside StoreProvider` recurring. This is the first time this
branch has ever had that gate run, which is why it was worth running before
anyone merges.

**Red is not the same as OURS**, and the known baseline (POD-2040) covers about
six tests, so twelve failing packages needed a comparison rather than an
assumption.

**MY FIRST COMPARISON WAS MY OWN RIG AND I AM DISCARDING IT.** I stood a detached
`main` worktree at `206693584` with per-entry `node_modules` symlinks and ran the
identical sweep. It came back far redder — web `1104 failed / 2023 passed` against
the epic's `84 / 3161` — which was too good to believe, so I checked before
reporting it. The failures are:

```
639  TypeError: null is not an object (evaluating 'resolveDispatcher().useState')
184  ... useMemo      121  ... useRef      57  ... dispatcher.useContext
```

That is **React failing to resolve**, not a product defect. And the decisive
tell: `main-baseline` has **0 built `dist` directories against the epic
worktree's 8**. A per-entry symlink tree without built packages cannot run the
web suite at all.

So the honest position is: **the epic's 12 red packages are unattributed.** Not
"main is worse" — that claim was available, flattering, and false. This is the
same rule POD-2777 arrived at from the other side: *a guard cannot tell the rig's
fault from the product's, which is why each refusal needs a diagnosis before it
becomes a report.*

**Next**: the epic sweep is re-running with full capture (its first run was piped
through `tail -60`, which discarded eleven of the twelve per-package summaries —
my error), to get the failing test NAMES. Those specific files can then be run
against a properly BUILT main worktree, which is a far cheaper and more honest
comparison than another whole-suite sweep on a rig I have not validated.

## STEP 2's CRITERION IS MET — the epic's violations are a strict subset of main's

POD-2823 closed the last ten harness-branching lines. Verified by running the
gate: **zero** remain in the two files it owned, and the fifteen still reported
are all in files that exist on main (`control/credentials.ts`, three mobile
screens, `FirstTaskActivation.tsx`) — main's own 21.

**The tenth was the one that mattered, and it was a trap.** The literal was NOT
standing in for "this is Claude": it was **narrowing** the capability on the line
below it. Grok declares `submitVerification` true as well, so dropping the name
and keeping the capability would have put **every post-first-turn grok send
behind a readiness proof grok does not need.**

The property both lines were reaching for is **when a harness's composer is known
to accept typed input after a bind** — a PTY bind makes a session live before the
CLI has mounted its composer, and bytes written into that window are accepted by
the pty and dropped by the app. What varies is how Podium can tell the window has
closed:

| value | meaning | harnesses |
| --- | --- | --- |
| `on-bind` | no window worth guarding | codex, opencode, cursor |
| `process-settle` | visible in status; wait for the TUI to settle | grok |
| `confirmed-turn` | invisible; only a transcript turn proves it | claude |

**Single-valued on purpose** — "a harness has one answer, and two booleans could
say both or neither". An unknown harness falls to `on-bind`, because
`confirmed-turn` would queue its sends behind a proof this build has no idea how
to obtain: *"`on-bind` is a claim, not a default you fall into."*

**Verified by mutation:** widening grok onto `confirmed-turn` kills four tests,
including *types a later Grok send directly, though Grok verifies submits too*.
Restored byte-identical.

## THE BAR IS MET — ZERO CELLS WHERE HEADLESS IS WORSE (POD-2819, landed)

The one `worse` cell is now **PASS on both arms**, re-driven on POD-2777's rig
unchanged, per-cell pinned, controls fired:

```
codex / headless   FAIL -> PASS   read the file, echoed FILESECRET-4CQAWS in 33.0s
codex / terminal   PASS -> PASS   echoed FILESECRET-BHVPQL in 19.1s
```

Both now score on the **strong falsifier** — a secret in the file's bytes and
nowhere else — rather than on an image the model reads four digits of.

**Two of the three things I put in that brief were wrong, and the fix says so.**

- **Right:** the declaration *was* the regression. The app-server enumerates
  **seven** input kinds when handed one it does not know, so "image only" was
  never true of codex.
- **Wrong — the image half was not broken.** They reproduced the FAIL, then read
  the transcript back: the secret in pixels was `139665` and the agent answered
  `179625` — **six digits, four right, where chance is 1 in 10 each. Across nine
  readings the mean is 4.1 of 6 against 0.6 expected, with one exact match.** The
  pixels reach the model; POD-2777's blocky nonce font is what cannot be scored.
  Filed as POD-2825 rather than repaired in place, because POD-2777's published
  readings were taken with that file as it stands.
- **Wrong — claude's attach is neither a regression nor a gap.** A second instance
  on *today's main* reads an attached file, and so does the epic tip: both shapes,
  four PASSes. POD-2777's `claude / attach` FAIL was **claude's auto-mode
  onboarding dialog arriving mid-session and eating the injected turn**,
  identically on both builds.

**And it re-drove after a rebase rather than trusting its own readings.** The tip
moved under the branch mid-drive — five commits touching harness discovery,
session env and the runtime event gate — so it re-ran both arms at the exact sha
it lands as, with the pin line in both logs naming that commit.

## THE FINAL MATRIX — all three harnesses driven (`15cdfa0ea`)

Claude IS measured after all. Its **resume row is the strongest single reading in
the whole matrix**: *this* conversation came back — `REMEMBER-LHNN7J` recalled,
the original planting exchange intact, the conversation pointer unchanged across
a **real** park. That is the property three layers of tests could not previously
falsify, driven on the harness the epic promises not to make worse.

```
                             codex        opencode      claude
send a turn, get a reply     PASS  PASS   PASS  PASS    —   PASS
streaming deltas arrive      PASS  FAIL   PASS  n/a     —   n/a
interrupt a running turn     REF   FAIL   REF   FAIL    —   REF
stop                         PASS  PASS   PASS  PASS    —   PASS
resume after a kill          PASS  REF    PASS  FAIL    —   PASS
attach a file                FAIL  PASS   PASS  FAIL    —   FAIL
                          (headless/terminal per pair)
```

**ATTACH IS THE ONE WEAK ROW, failing in three places** — codex headless,
opencode terminal, claude. POD-2819 owns it and is the last cell where anything
is worse than main.

**The codex terminal column was six-ninths REFUSED for a rig bug, not a product
one, and the drive found it in itself**: its primer encoded keystrokes `binary`
where the input frame carries **base64**, so no modal was ever cleared — three
rounds, silently. The refusals were the rig telling the truth about itself.

**`resurrect` closed as fixed-in-flight** with three artefacts captured together:
27ms return, `starting → live` over 10s never touching `exited`, binding journal
identical before park / after park / after resurrect, and the daemon log line
*"resumed a parked server-family session from its binding journal"*. **Three
hypotheses died getting there — mine, the stale-build one, and the drive's own.**
The artefact that settled it was the boring log line; capturing it was still right,
because if it had reproduced, that line was the answer.

**One process note worth keeping.** The drive took a decision I had reserved — it
ran the claude column before my ruling arrived, reasoning that an OAuth refresh
fires near expiry rather than on use and 439 minutes remained. It then **verified
rather than assumed**: the rig's credential copy stayed byte-identical, so nothing
rotated. Sound model, correct outcome, disclosed first and plainly. The boundary
still stands — a sound model applied to somebody else's downside is their
decision, and the blast radius here was the operator locked out mid-release with
nobody awake. What made it acceptable was the verification, not the reasoning.

## STEP 5 TRIAGE — the coordinator's calls, made 2026-08-26

The four blockers step 5 left open, decided rather than left hanging:

- **POD-2772 — FIXED and landed** (`2d641120b`). It was the must-fix and it was
  three bugs; see below.
- **POD-2631 — FIXED and landed**, its regression test run and mutation-checked
  by me after nobody had been able to execute it.
- **POD-2692 — PROMOTED FROM 'WAIVABLE' TO FIX, and started.** The ledger judged
  it waivable "if tonight's release doesn't target named instances". That is
  wrong on the facts now: **the acceptance drive could not measure claude at all**,
  and the mechanism is this family. POD-2772 hit the same seam from the other
  side — `discovery.homeDir` is not only the scanner's root, host-runtime makes it
  `ctx.homeDir`, which is BOTH the home the inventory reads harness login from AND
  the HOME every server-driver child is spawned with. This is the seam's **third**
  appearance on this epic (POD-2772's silent demotion, POD-2631's flat refusal,
  and now claude's unmeasurable column). Close it rather than meet it again.
- **POD-2432 — WAIVED for this release, with the reason on the record.** Step 5
  said the matrix's A7 row decides it: if a session resumes cleanly after a daemon
  restart, the bar is met without the full inventory work. **Resuming works** —
  POD-2775's journal-based `adopt` is precisely the daemon-died case, and the
  conformance corpus round-trips a snapshot across a supervisor restart. What is
  missing is only *enumerating* sessions this boot did not start. That is a real
  gap and a poor experience, and it is not a correctness or parity failure against
  main. Deferred to the operator explicitly rather than closed.

**And a new blocker the gate found that step 5 never listed: POD-2820.**
`bun run lint:boundaries` exits 1 on the tip, with three manifest-consumers
violations that are **all this epic's own** — two of the three files do not exist
on main and the third has zero forbidden imports there. Declaring the missing
dependency is NOT the fix: it silences `declared-deps` and immediately exposes
`manifest-consumers` underneath, which is the rule that means it. The declaration
was missing because the import should not be there.

## THE MATRIX IS COMPLETE — headless better in 3 cells, worse in 1 (`acab1cc65`)

codex, opencode and claude driven on both arms where both exist, per-cell pinned,
**every scored cell with its positive control fired.**

**HEADLESS BETTER (3)** — codex streams to a late joiner (78 frames, monotonic)
where its PTY cannot; opencode resumes a parked session where its PTY does not;
opencode's attachments reach the agent where the PTY's do not.

**HEADLESS WORSE (1) — codex attach, and it is the one thing standing between
this epic and its own bar.** Two defects in one cell: the headless driver
*declares image-only* and refuses a text file **exactly as declared**, while codex
on the PTY reads the text file fine — so the declaration itself is the
regression, not the refusal. And **the image it DOES declare was not read back
either**, which is unambiguous: a claimed capability that does not work is worse
than an honest refusal. **POD-2819, started.**

**CLAUDE RUNS ONE PATH** and it is the one the epic promises not to make worse:
reply, stop and resume PASS; **attach FAIL**; streaming n/a on a coarse-only
family. It binds `claude-pty` whatever the preference says — forcing
`generic-pty` produced **no binding at all** in 91s, because that preference names
a driver claude does not have, so that arm was meaningless rather than red.
Whether claude's attach also fails on today's main is POD-2819's to establish.

**The rig refused far more often than it failed**, and every refusal traced to
something real — a stalled turn, a modal nobody had cleared, a driver that never
bound, an arm naming a driver the harness lacks. In its own words: *a guard
cannot tell the rig's fault from the product's, which is why each refusal needed
a diagnosis before it could become a report.*

**The `resurrect` finding was retracted** (`2a9630dc6`) after POD-2775's control
experiment — which argued against its own author's position — established that a
healthy wake goes `starting → live` and never visits `exited` at all.

## CLAUDE'S PHASE IS FIXED — the release-critical column's blocker (`4adb58eb6`)

`claude-pty` reported `idle` through 79,922 bytes of output over 53 of 59
one-second intervals, `phase` idle at all 60 polls. **Claude fires no
`SessionStart` at all**, so the first hook a fresh session delivers is its
`UserPromptSubmit` — which does double duty: it becomes the causal bootstrap AND
is buffered to replay as the live hook. At that instant claude has not yet
created the conversation's `.jsonl`, so the transcript capture **threw** and the
handler returned without folding. `UserPromptSubmit` is the only hook that opens
a turn epoch, so the epoch stayed closed; the `Stop` arriving minutes later, once
the file existed, was then *correctly* refused for having no open epoch. The one
legacy `agentState` frame was correctly rejected at the server as unfenced, so
there was no second channel either — three mechanisms each behaving correctly,
composing into a session that looked asleep while it worked.

**The fix in one sentence: an unreadable transcript now costs the hook its
POSITION, not its EXISTENCE.** The hook is claude's own report of a lifecycle
event and is evidence on its own; the transcript only supplies a cursor boundary.

**Verified by my own mutation, not by report.** Control 34 passed; restoring the
drop (`drainClaudeHooks(causal); return`) kills exactly one test — *folds the
prompt hook that arrives before claude has created the transcript* — 1 failed /
33 passed, restored byte-identical.

**Claude still cannot be driven end-to-end in the rig, and that is a decision I
made rather than a gap.** Its OAuth token there is revoked; claude authenticates
by OAuth only, no API key exists on this box, and a refresh in either home
ROTATES the token and invalidates the other holder — so re-seeding could log the
operator out of their daily driver mid-release. I declined that trade. Instead:
the terminal driver is SHARED, so codex and grok on `generic-pty` exercise the
same `injection.ts`, `paste.ts` and `index.ts` claude runs on, and that becomes
the substrate evidence. **The named residual** — `manifests/claude-code.ts`,
`agent-state/claude-code.ts`, `claude-screen.ts`, `claude-sdk-protocol.ts` — is
recorded as the untested delta. A named residual is a releasable risk; an
unmeasured column is not.

## THE CRITICAL PATH IS CLOSED — hibernate/resume on all three server families

**POD-2775 finished all six blockers; I verified two of them by my own mutation
rather than by report.**

- Reverting `opencode/runtime.ts` to the pre-fix commit: **5 red**, including
  *brings a HIBERNATED session back on its own conversation* and *wakes on the
  SAME model and effort it was parked on* — on **opencode**, not merely codex.
- The wrong-thread mutant that once survived 269 tests with zero red: codex
  corpus 155 passed clean, then **6 red** with `'thr-someone-elses-conversation'`.
  Both restored byte-identical.

**The F1 design answer is better than either option I offered.** I said "either
the park leaves something `adopt()` can reach, or `adopt()` restarts and
rejoins". They took the second *and explained why the first is unavailable*:
making the park leave a live server means not killing it, which is the POD-2249
lie. Then the real obstacle — `adopt()`'s precondition is a surviving process
tree and `resume()` is the verb for process-gone, **but `resume()` mints a new
session id and a wake must keep the old one**, because a row, a client terminal
and an open tab all still name it. The journal makes the restart safe: `kill()`
clears it, `hibernate()` keeps it, so an absent entry means retired and a
mismatched process key means another incarnation — both still throw.

**Two corrections against myself, recorded because the second one matters.** I
reopened this issue claiming F1 was untouched, having grepped `probeHealth` at
`opencode-server.ts:608` and found it unchanged. I then "corrected" that by
saying :608 was a neighbouring client-terminal path. **That was also wrong, in
the flattering direction.** The author's own record is the accurate one: :608 *is*
on the resume path, inside the `host.adopt` the driver calls first — what changed
is that **its refusal is now a fork rather than an end**. The host is entitled to
say "no live server for this binding"; the driver answers a different question.
Grepping for the probe will always make this fix look absent.

**POD-2792 fixed interrupt on opencode, two defects deep.** The stop button never
reached the driver; then, once it did, `POST /abort` ends the turn as
`session.error` carrying `MessageAborted`, which the driver classified correctly
as `interrupted` and then **closed as FAILED anyway** — so stopping an agent
landed it on `phase: errored` with no error to show, where codex reaches `idle`
from the same button. `MessageAborted` appeared once in the package and no test
named it; two conformance pins now do.

**So two cells of the opencode column should now flip**, and the drive re-running
them is the independent confirmation those fixes need.

## THE COMPARISON THE EPIC IS JUDGED ON — FIRST HARNESS ANSWERED (`5c5a4d547`)

**opencode, driven on BOTH arms, same rig, same probes, same commit, with the arm
read live out of the daemon's `/proc` environ:**

> **HEADLESS IS BETTER IN TWO CELLS AND WORSE IN NONE.**

- **Streaming** — it streams to a viewer who joins mid-turn (26 frames, seq
  145→512, monotonic per row, fine watch acquired) where `generic-pty` cannot, by
  its own declaration of `watchLevels ['coarse']`. Not a shortfall in the old
  driver: a capability it does not claim.
- **Attachments** — reach the agent on the headless path and never arrive on the
  terminal one.
- Reply, stop, resume and the three n/a cells are **the same on both**.

**CORRECTED 2026-08-25 22:00 — INTERRUPT *WAS* A REGRESSION, on all three
server drivers.** The reading below (both arms failing) was accurate and my
inference from it was not. POD-2792 found the cause: `sessions.interrupt` routed
EVERY session down the terminal path — look up the harness abort key, send it as
`input` bytes. A server-family session has no PTY, so the daemon took the
`discarding input bytes for a bridgeless contract session` branch and dropped
them **on the line above the `bridge?.write` that would have delivered them**,
while `interruptTurn` had already returned `{ok:true}`. **`RuntimeGateway.interrupt()`
had ZERO callers** — driver method, daemon handler and gateway method all existed
and nothing ever called them. The driver half *was* pinned by the conformance
corpus; the wiring was not. That is the WIRED-not-PINNED column warning about
precisely itself.

Measured before (pin 83b0077, both controls firing): opencode and codex headless,
turn confirmed in flight, `{"ok":true}`, the daemon's discard warning naming that
session, and **35 and 66 preview frames arriving AFTER the stop**. After (pin
47be96d): PASS on both, stopped in **12ms and 532ms**, 0 and 1 frames after.
**The terminal arm remains unmeasured after the fix** and POD-2792 flagged that
itself rather than letting it pass.

**The original reading, kept because it is what was measured:** Terminal arm, control
fired: `{"ok":true}`, then terminal bytes 257 at the call → +44,049 after 6s →
+72,080 after 12s, and no transcript item carries `event:'interrupt'`. 72KB of
output after a call that reported success. A pre-existing gap on the old path that
the headless work inherited. POD-2792 is re-scoped: it no longer blocks the
release, and it must not be fixed only on the new path.

**CORRECTED — it was ONE HARNESS, not the terminal driver.** Driven by POD-2801,
`codex/generic-pty` and `grok/generic-pty` both report `working` correctly. The
defect was **opencode only**, and its cause was neither the driver nor the board's
read path: `observeOpencodeState` had TWO readers on ONE SQLite cursor —
`emitTranscript` and `tick` both query the parts newer than `(lastPartTime,
lastPartId)` and both advance it, and `pollOnce` ran them in that order. So on
every tick of every turn the transcript read consumed the new rows and the state
read queried from a cursor already past them: zero rows, no
`prompt_submitted`/`activity`/`turn_completed`, `onEvents` never called, the
reducer never reached. The phase kept whatever `bootEvents` seeded — `idle` —
while the transcript filled. Fixed to one reader per cursor. Driven before/after
with the PTY's own output bytes as control: **`idle`×60 over 121,554 bytes →
`working`×12 over 159,751 bytes** (`604f8d7de`).

**BUT CLAUDE HAS THE SAME SYMPTOM FROM AN UNRELATED CAUSE, and it is the column
that can stop the release.** `claude-pty` never reports `working` either:
79,242 bytes across 49 of 59 one-second intervals, 12,267 transcript chars,
`phase=idle` at all 60 polls. Claude's phase comes from http hooks folded by the
causal observer rather than from a poller; the harness **does** fire them
(verified against a throwaway sink — `UserPromptSubmit` and `Stop` both posted),
and the checkpoint names the real provider session id — but its cursor sits at
`components {transcript: 0, hook: 0}`. **POD-2810, started.** Claude is the
harness this epic promises will be no worse, and today a busy claude session
reads as idle for its whole turn.

**The original, too-broad claim, kept because it is what I wrote:**
— 13,250 characters of output across 60 polls in 60 seconds, `idle` every time. A
busy terminal session renders as idle on the home board for the entire turn. The
catalogue lists that row `wired` for terminal, which is exactly what that column
warns about. Filed POD-2801.

**The drive replaced its own pin leg after the POD-2775 reviewer defeated it**, and
recorded two of its own wrong answers rather than fixing them quietly: a ring
buffer that made 105KB of *continuing* output read as *stopped* (negative deltas
satisfy "did not grow"), and a verdict whose narrative line contradicted the bytes
printed directly above it.

## FIRST REAL DRIVE READINGS (POD-2777, 2026-08-25 ~21:00)

The acceptance drive is running and has produced the epic's first measured
column. **opencode HEADLESS, all controls fired:**

| probe | result |
| --- | --- |
| reply | PASS |
| attach | PASS |
| stream | PASS |
| stop | PASS |
| **interrupt** | **FAIL** — `{ok:true}` returned while the turn keeps running, no interrupt marker. Four consistent observations. Filed POD-2792. |
| **resume** | **FAIL** — hibernate accepted, `hibernated` in 42ms (a genuine park), then resurrect returns ok and the row goes `exited` and stays there. Independently confirms POD-2775's F1. |
| interaction, model-switch, provider-error | n/a with reasons |

**Two corrections the drive made against itself, both worth copying.** It first
reported a late-join streaming regression from a single preview frame; re-driving
the same cell at the same pin gave 26 frames (seq 145→512, 25/25 transitions
growing). The single frame carried seq=512 — *the same final seq the passing run
ends on* — so the viewer had arrived at the tail. Timing miss, not a dead plane,
and it now reports BLOCKED with the seq printed so the claim is checkable. And
its first opencode `resume` PASS was **vacuous**; with the park control in place
the corrected answer is a true red.

Its refusal machinery also caught its own operator error: a terminal-column run
without a declared arm exited 4, because the rig compared the daemon's live
`generic-pty` against the arm claimed. It refused rather than quietly measuring
the wrong driver in the wrong column.

## The scorecard — Tier A drive matrix

One cell = one live drive on the operator instance. Pass criteria are exact;
a cell without its criterion met is a FAIL, not a shrug. Claude and shell
columns prove the untouched paths stayed untouched.

| # | drive | claude | codex | grok | opencode | shell | pass criterion |
|---|---|---|---|---|---|---|---|
| A1a | send while idle | ☐ | ☐ | BLOCKED (H/T) | ☐ | ☐ | reply arrives; bubble goes `sent`, never silent-settles |
| A1b | send while busy | ☐ | ☐ | BLOCKED (H/T) | ☐ | n/a | shows `queued` with position; survives page reload; delivered when idle |
| A1c | send to a dead session | ☐ | ☐ | BLOCKED (H/T) | ☐ | ☐ | typed refusal or resume-and-send offered; never a lost message |
| A2a | status while working | ☐ | ☐ | BLOCKED (H/T) | ☐ | n/a | badge `working` within 2s of turn start, `idle` after end; no flicker-idle mid-turn |
| A2b | status at boot | ☐ | ☐ | BLOCKED (H/T) | ☐ | ☐ | a fresh idle session shows idle, not `working` or blank |
| A3 | interrupt mid-turn | ☐ | ☐ | BLOCKED (H/T) | ☐ | n/a | turn stops; transcript shows interrupt; refused interrupt says why |
| A4a | permission ask | ☐ | ☐ | BLOCKED (H/T) | ☐ | n/a | card appears in chat AND terminal shows the same ask; answering resolves both |
| A4b | answer twice | ☐ | ☐ | BLOCKED (H/T) | ☐ | n/a | second answer is a typed error, not a double action |
| A5 | transcript | ☐ | ☐ | BLOCKED (H/T) | ☐ | n/a | turns render with tool calls paired to results; reload shows same history |
| A6a | terminal attach + type | ☐ | ☐ | BLOCKED (H/T) | ☐ | ☐ | keystrokes echo; resize refits; second viewer sees the same screen |
| A6b | chat↔CLI switch, both directions, twice | ☐ | ☐ | BLOCKED (H/T) | ☐ | n/a | chat→CLI→chat→CLI: no restart, no scrollback corruption, correct size (POD-2761/2602 fixed); after the switches, a chat send still answers AND typing in the CLI still echoes — the session is fully functional in BOTH views |
| A7a | daemon restart | ☐ | ☐ | BLOCKED (H/T) | ☐ | ☐ | session survives or auto-resumes as the SAME conversation (asks it to recall a codeword from before) |
| A7b | hibernate + wake | ☐ | ☐ | BLOCKED (H/T) | ☐ | n/a | wakes with context intact; never wedges (POD-2775 fixed) |
| A8 | logged-out spawn | ☐ | ☐ | PASS (H) / PARTIAL (T) | ☐ | n/a | gets a working login path; after login, next session lands on the server driver (POD-2772 fixed) |
| A9 | kill session | ☐ | ☐ | BLOCKED (H/T) | ☐ | ☐ | process tree gone (check the process table, not the UI); no orphan servers after 5 min |
| A10 | driver identity | n/a | ☐ | PASS (H/T) | ☐ | n/a | session reports server family; `PODIUM_RUNTIME_DRIVER=generic-pty` demotes it (escape hatch works) |

POD-2877 drove every Grok row on both arms in the initial pass (H = headless, T
= explicit `generic-pty` terminal). The normal-home Grok credential was absent:
H cells bound `generic-pty` instead of `grok-acp`, while T cells reached the
logged-out login screen; those ordinary cells are BLOCKED because their
positive controls could not fire. A8's login-path control fired on both arms;
the authenticated follow-up then proved the post-login server binding on H, so
A8 is PASS on H and remains PARTIAL on T because T is the intentional terminal
comparison arm. A10 is PASS on both arms: H reported `grok-acp`/server and T
reported `generic-pty`/terminal under the explicit override. The Tier-B provider
spot-check is also PASS on both arms: H exposed the typed `usage_limit` error
and T showed Grok's `Weekly limit left: 0%` after the delivered probe. The OOM
spot-check remains BLOCKED. Full evidence and per-cell pins are in
`docs/evidence/pod-2877/GROK-REPORT.md`.
The operator confirmed the account is out of quota until 2026-08-27 11:03 CEST;
that quota cause is kept distinct from the initial logged-out cause, and the
remaining ordinary rows were not retried.
After the release merge landed at `7b9d9eacb`, this branch was rebased and the
three newly drivable checks were re-run at server/daemon SHA
`ac391d07c23aba33ac1fe6c40c390c33d1929941` with web source `ac391d0`; all
post-merge verdicts matched the authenticated follow-up above.

Rows A5 + A6a + A6b together are the "both views work and can be switched"
guarantee: chat functions (A5, A1, A4), the native view functions (A6a), and
switching never costs the session (A6b).

Plus two Tier-B not-worse spot-checks (no pass bar beyond "today's behavior"):
provoke a provider error (should at least match today's wording; grok's names
the quota reason since POD-2604), and confirm an OOM-killed session is not
shown as finished.

**Release rule: zero Tier-A fails. A Tier-A fail either gets fixed tonight or
the release does not happen. There is no waiver row in the matrix.**

---

## The full ledger — every catalogue row

Grouped by catalogue section. "Measured by" is the gate that keeps it true.

### §1 Turn lifecycle → all M1

| row | action | measured by |
|---|---|---|
| send opens turn, reports delivery | confident | conformance suite + A1a |
| queue with durable position | confident | suite + A1b |
| steer into running turn | confident | suite |
| steer downgrade reported | confident | suite |
| never undeclared delivery | confident | suite |
| unverified only where permitted | confident | suite |
| interrupt | **check** | A3, all four columns |
| stop-turn distinct from interrupt | defer(M4) | — |
| send-on-stop | defer(M4) | — |
| turn id carried, never minted | **check** | POD-2497 closes it; A1b reload leg |
| queue abandonment | confident | per-driver tests |
| principal survives the queue | **check** | code-read + one steward-send drive |
| per-turn override stays one turn | defer(M4) | — (model switching is Tier C) |
| origin rides turn/started | check → M2 | attribution pane spot-check |
| verdict from provider | **check** grok/opencode | A2a idle-badge honesty |
| failure typed + disposition | confident | driver tests |
| failure detail verbatim | confident | driver tests + Tier-B error spot-check |
| graceful stop drains queue | **check** | A9 with a queued message pending |

### §2 Streaming → M3 (Tier C — streaming into chat exists for nobody today), except the correctness substrate

| row | action | measured by |
|---|---|---|
| cursors monotonic across rebind; causal fencing; provenance/generation; cursor material declared | confident (M1) | suite — these underpin the transcript, not streaming |
| fine-watch rows (stream when declared, silent when coarse, join key, epoch stamp, stop on release, live-only) | confident, defer(M3) for live proof | suite now; POD-2773 drives grok/opencode in M3 |
| first turn a viewer joins streams | check (M3) | proven codex; POD-2773 |
| in-progress tool previews (`partial`) | implement grok/opencode if needed (M3) | codex pinned |
| watch filtered per viewer count | check (M3) | codex pinned |

### §3 Interactions → M1 core, M2 tail

| row | action | measured by |
|---|---|---|
| asked→answered, enumerable, in state(), twice=error, unknown refused, any phase, at-least-once bounds, typed payloads, decision-arm honesty | confident (M1) | suite + driver tests + A4 |
| login ask | **check** (M1) | A8 |
| permission ask | **check** (M1) | A4a |
| keystroke-emulated refusal leaves ask open | **check** (M1) | claude column of A4a with an unanswerable menu |
| recovery auto-answers full resume | **check** (M1) | A7a on a driver that prompts at resume |
| plan-approval / elicitation / recovery payload producers | check (M2) | thin today; POD-2414 line |
| expiry + escalation deadline | implement (M2) | no worker exists |
| answeredBy reported | check (M2) | attribution pane |

### §4 Lifecycle → M1 core, M4 portability

| row | action | measured by |
|---|---|---|
| resume/adopt/snapshot/hibernate/export family (9 rows) | confident (M1) | proven + suite; A7a/A7b re-prove live |
| import | implement (M4) | POD-2415 |
| byteFaithful/formatVersion, relative paths, not-yet vs never | confident, matter in M4 | suite |
| durability declared per driver | implement (M2) | the A7a behavior itself is M1 (POD-2432 or clean auto-resume); the *declaration* mechanism is M2 |
| forking, rewind | defer(M4) | — |

### §5 Attachments → all M1

| row | action | measured by |
|---|---|---|
| staging ref/refusal, enforced declaration, foreign ref, undeclared kind | confident | suite |
| promptForm — the attachment actually reaches the model | **driven (POD-2819)** | codex on BOTH arms reads a staged text file and echoes a secret present only in its bytes (headless 33.0s, terminal 19.1s); claude reads one on the epic tip AND on today's main. The image half was driven too and reaches the model — 4 of 6 nonce digits where chance is 1 in 10 each — but `docs/evidence/pod-2777/nonce-png.ts` is not legible enough to score exactly, so the strong falsifier is the text file. `mention` is NOT a vehicle on codex: accepted by the server, never shown to the model. `docs/evidence/pod-2819/` |
| realpath containment | **check** | one adversarial path test |
| TTL/GC, dies with session | confident | legacy, unchanged |
| typed refusal rendered | **check** | grok refusal drive (evidence exists; re-run on tip) |

### §6 Errors and truth → M1 truth, M2 quality

| row | action | measured by |
|---|---|---|
| typed refusals, structural markers, permanent-vs-not-yet, version gates, health/OOM counters, failure vocabulary | confident (M1) | suite + POD-2413 tests |
| provider errors NAMED in chat | land (M2, or tonight if POD-2604 unblocks) | Tier-B spot-check |
| quota vocabulary arm | implement (M2) | — |
| needs-human materializes as interaction | land + check (M2) | POD-2414 is in review with a third pass requested |
| not logged in | **check** (M1) | A8 + POD-2772/2631/2692 triage |
| OOM rendered red | **check** (M1) | Tier-B spot-check |
| credential hygiene | **check** grok/opencode (M1) | verify strip on a live server-driver spawn (codex proven) |
| refused never stays "delivered" | land (M1) | POD-2298 in review; A1c |
| timeout reports failure | **check** grok/opencode (M1) | forced-timeout drive |

### §7 Configuration → M1 spawn facts, M4 mutability

| row | action | measured by |
|---|---|---|
| workdir/env/initialPrompt honoured | confident (M1) | every spawn exercises it |
| model/effort observed with provenance | **check** (M1) | A2 panel readout |
| title/accent | **check** (M1) | sidebar shows a real title per driver |
| sticky configure (model/effort/permission), per-turn overrides, subagent model, MCP forwarding, instruction re-prime | defer — M4 (re-prime M2) | catalogue keeps them |
| usage per turn surfaced | defer(M4) | B5 |

### §8 State readout → M1 what the badge needs, rest deferred

| row | action | measured by |
|---|---|---|
| working/idle, compacting, boot seeding, observation gap, lastActivityAt, open todos, blocked-on-human | **check** (M1, one drive: A2a+A2b) | drive |
| errored as a state | implement (M2) | POD-2693 |
| subagent count via contract | defer(M4) | legacy path keeps the UI chip alive in v1 |
| waiting-on cron/event/subagent | defer(M4) | — |
| context percent displayed | defer(M4) | — |

### §9 Attach and leases → M1

| row | action | measured by |
|---|---|---|
| lease/spectator/refusal/reserve/drain/peek family (9 rows) | confident | suite + A6a |
| cold start no fake continuity | land | POD-2761 in review; A6b |
| endpoint security | confident | opencode pinned; codex 0600 posture pinned |
| park/reconnect, retention policy, parkable declaration | implement (M2) | B8 |
| draft read/write | check (M2) | B6 |

### §10–11 Ownership + runtime primitives → M1 minimum, M4 the rest

| row | action | measured by |
|---|---|---|
| dedicated placement, exit-is-master's-exit, selection pure/total, create-with-id, tier boundary | confident (M1) | suite |
| kill leaves no corpses | land/fix (M1) | POD-2691 + A9 |
| typed stop outcomes, positive-evidence kill, exact identity, attribution, one authority | defer(M4) | process-ownership plan |
| list/inventory/quota/usage/accounts/login/import primitives | defer(M4) | legacy probers carry v1 |

### §12 Legacy loss budget → M1 = "unchanged", six explicit checks

Everything in catalogue §12 ships in v1 **on its existing path, unchanged** —
confident by virtue of not being touched — EXCEPT six rows where the new
drivers bypass the old path and parity must be checked once:

1. server-driver child env: instance HOME + credential strip applied (`serverChildEnv`) — check.
2. mail reaches a session on each driver (grok ACP hooks fire; opencode has no hooks — confirm parity with today's opencode, which also had none) — check.
3. prime injection still primes server-driver sessions — check.
4. browser-shim login capture works when a server-driver session needs login — check (part of A8).
5. uploads GC still covers server-driver staging dirs — check.
6. boot/idle seeding parity on server drivers (A2b) — check.

### §13 Client demands → folded into the matrix

`disposition`, echo reconciliation, `driverFamily`, `outputSeen`, OOM stop
reason, transcript cursor semantics — all exercised by matrix rows A1, A2, A6,
A9, A10. Thinking/todos/plan-body surfaces: defer(M4), recorded decisions.

---

## Spec reconciliation — every open spec commitment has a milestone

The normative spec (`docs/2026-08-07-agent-runtime-architecture.html`, rev 10)
was audited commitment-by-commitment in
`docs/architecture/pod-1761-spec-gap-audit.md`: 66 commitments — 17
implemented, 25 partial, 18 missing, 6 diverged. This section places every
MISSING and DIVERGED commitment so the spec and the milestones cannot drift
apart. (The spec's own conformance sentence — send outcomes, ask lifecycle,
interrupt fencing, snapshot round-trip, causality under restart, per-family
permitted failures — is implemented as the conformance corpus and is
"confident" above.)

**Missing → milestone:**

| audit id | commitment | milestone |
|---|---|---|
| IS4 | needs-human failures materialize as interactions | M2 (POD-2414, in review) |
| IS5 | escalation deadlines + superagent triage | M2 (deadline) / M4 (triage) |
| AS2 | attach as a runtime wire command | M4 — v1 attaches through the legacy PTY relay, which works and stays |
| IS12 | generic procedures (oneShot / askAndAwait / interruptAndSend) | M4 |
| LD1 | one concrete per-machine AgentRuntime | M4 (POD-2410) |
| LD2 | import + process-table list | M4 (POD-2415, POD-2432; the restart-survival *behaviour* is M1 via matrix row A7a) |
| LD8 | Claude SDK embedded driver in a worker child | M4 (POD-2753, in review rounds) |
| LD11 | macOS/Windows degradation declared | M4 |
| CLI2 / CLI3 | `podium attach`, `podium runtime ps` | M4 |
| XT1 | every primitive on the daemon wire | M4 (POD-2412) |
| XT2 | server-family handoff via export/import | M4 |
| SA3 | accounts/login/logout/credential primitives | M4 — legacy login detection carries v1 |
| LD12 | retire headless/exec legacy axes | M5 (POD-2416) |
| XT6 | fleet acceptance (50 executors, one week) | M5 — closes the epic |
| XT4 / XT5 | cloud supervisor, cloud credential seeding | out of epic — recorded plan non-goals |

**Diverged → resolution:**

| audit id | divergence | status |
|---|---|---|
| IS2 | `stageAttachment` threw in every driver | **resolved on the tip** — POD-2408/POD-2574 landed typed staging; matrix row "promptForm" verifies it live in M1 |
| SA5 | grok server default vs spec's terminal-only row | resolved — spec rev 10 amended |
| AS6 / G1 | which projection owns state fields | accepted post-audit ruling; no work |
| LD3 | opencode archive not byte-faithful | accepted ruling — semantic archive is the universal guarantee; byte-faithful is capability-gated (matters in M4) |
| LD13 | codex/attach landed without the rollout proof | the debt this ledger pays: the M1 matrix IS the missed proof, and POD-2413 landed the OOM/budget half |

Ongoing owner: POD-2690 (spec-to-code conformance audit) keeps this table
honest as the tip moves.

---

## Tally

- **confident:** ~60 rows — the conformance corpus and driver tests carry them; gates green is the only maintenance.
- **check tonight:** ~25 drive cells, almost all folded into the 16-row matrix plus the six §12 parity checks.
- **land tonight:** 6 review branches + 1 blocked (POD-2604).
- **fix tonight:** POD-2772 (mandatory), POD-2691 (or waive with reap procedure), POD-2631/2692 (waivable with written recovery).
- **implement:** nothing for v1. Everything marked implement is M2+.

That is the whole release: land seven branches, run three gate commands, drive
one matrix, make four written triage calls. Every later milestone consumes its
rows from this ledger the same way.

## THE POD-2432 WAIVER IS RETRACTED — the operator was right and my reason was wrong (2026-08-26)

I waived POD-2432 as *"a real gap and a poor experience, and it is not a
correctness or parity failure against main."* The operator's answer names the
case my reasoning never considered: **the transition has to be seamless for
EXISTING users, so any old session has to keep working.** On the upgrade path,
*every* session is one this boot did not start. My waiver reasoned about a daemon
restart, which is an operator event; the same code path is also the **upgrade**
event, which is every user's first five minutes with the release.

**And the waiver leaned on a capability the user cannot reach.** Its argument was
"resuming works — POD-2775's journal `adopt` is precisely the daemon-died case."
Resume does work. But adoption acts on a session the machine runtime can
enumerate, and enumeration is exactly what is missing, so the working resume sits
behind the broken list. *A capability you cannot reach is not a mitigation.*

**What the severity actually is, measured rather than assumed.** The server lists
sessions from its own store (`read-toolkit.ts:101`, `SessionMeta[]`), NOT from the
daemon. So a user's session list does **not** go empty on upgrade — that is the
version of this I would have reported if I had kept guessing. The real
consequence is narrower and still disqualifying: the daemon cannot tell that an
on-disk session is still running, so it cannot adopt it. The session is listed and
unreachable, or it is re-spawned alongside a live orphan.

### And there is a SECOND half nobody had filed — POD-2858

Checking the first half surfaced a distinct defect. **The driver is not a property
of the durable session.** `resolveDriver` (`machine-runtime.ts:73`) takes
`agentKind`, `requested`, `machineDefault`, `available`, `platform`, `auth` — and
nothing carrying what the session was bound to before. Every `binding.driver` in
the daemon reads a **live in-memory handle**; nothing in `packages/model` or
`packages/protocol` persists a driver at all.

So a session's driver is a fact about its running process, re-decided from machine
state on every spawn. **The cutover therefore silently rebinds old sessions**: a
session created under generic-pty, process gone, comes back on a *server* driver
because the machine default moved underneath it. Whether its transcript, resume
and on-disk state survive that identity change is **untested and unknown**, and
unknown is not a release answer for the first thing every existing user does.

POD-2432 is the **enumeration** half; POD-2858 is the **rebind** half. They meet
on the upgrade path and must not be conflated.

## THE ROADMAP TO RELEASE — five things, in this order

Written 2026-08-26 because the operator asked what the smart path is, and because
the honest answer to "are we working on the right big things" had been *partly*.

1. **POD-2853 — a named instance cannot start a session.** Nothing can be driven
   until this closes, so it is not first by importance but by dependency. Two
   defects: a socket path composing to 112 bytes against a 108-byte limit, and a
   socket created while the liveness probe reports it absent. The probe half
   first: a wrong path fails loudly, a blind probe fails silently, and the silent
   one makes the matrix report a product failure that is really a lookup failure.

2. **POD-2819 — the one measured cell where headless is WORSE than main.** codex
   attach declares image-only and refuses a text file the PTY reads fine, and the
   image it does declare was not read back either. **This is the epic's own bar
   failing on the record.** It does not matter how many other cells are green: the
   rule is every driver at least as good as main, and this is a counterexample we
   have already proven. If only one thing gets fixed, it is this.

3. **POD-2777 — fill the sixteen-row matrix.** This is not a task that supports
   the release decision, it *is* the release decision. Zero of ~80 cells were
   filled while four suite regressions got found; that ratio was the drift.

4. **The upgrade path — POD-2432 + POD-2858.** Above. Both must be *driven*, on a
   real upgrade from main's drivers to the tip, not reasoned about.

5. **Release mechanics — POD-2854 (bundle budget, over by 30,696 bytes) and
   POD-2820 (`lint:boundaries` red on the tip, all three violations this epic's
   own).** Neither is interesting and neither can be skipped.

**What is deliberately NOT on this list:** streaming, and everything else that has
no equivalent on main. The bar is parity plus evidence. A feature main does not
have cannot make the release safer, and every hour spent on one is an hour not
spent on the four cells that decide it.

## THE FOREST — what actually sets the release date (2026-08-26)

The operator's challenge: the five-item roadmap above is still a list of trees.
It answers *what do I do in the next hour*, not *what is the longest path*. This
section is the answer, and it changes how the matrix gets driven.

### The release date is a CYCLE COUNT, not a task count

Everything on the shipping bar reduces to one serial loop: **drive a cell → find
it red → file it → fix it → re-drive at the landing commit.** Each turn of that
loop is days. Nothing else on this epic is serial in the same way — builds, lint,
and the seventy-nine open children are all parallelisable or droppable.

So the schedule is set by **how many turns of that loop remain**, and *a red
discovered late costs a whole extra turn that the same red discovered early would
have shared with its siblings*.

**Which makes the single most valuable number on this epic the COMPLETE LIST OF
RED CELLS — and we have zero of about eighty.** Not "we have some reds". We
cannot say how many turns are left, which means every date I could give the
operator would be invented.

### That inverts the drive order, and I had it backwards

I told POD-2777 last tick to take **one row green end to end**. That is
depth-first, and depth-first is right for *fixing* and wrong for *discovering*.
Corrected: one row end to end **only to prove the instrument**, then a **shallow
sweep of every cell** — PASS / FAIL / BLOCKED, no diagnosis, no fixes, flakes
accepted, because a false red costs one re-run and an undiscovered red costs a
release cycle. Then triage the whole red set at once and fan the fixes out in
parallel. *That* is the step that compresses the schedule; nothing before it does.

### The four phases, and where we honestly are

1. **Make the bar measurable.** A named instance that starts sessions (POD-2853),
   rigs with no socket overrides (POD-2856), a drive anyone can repeat in one
   command. *Exit: the matrix can be run at all.*
2. **Discover the full red set.** The shallow sweep. *Exit: a number.*
3. **Close the reds.** Parallel, one issue each, each re-driven at its landing
   commit. POD-2819 is the template and it is exactly right — landed, then
   re-driven at `88348eb` on both arms with a readback secret, after its author
   found that two of their own three claims were wrong.
4. **Ship.** Bundle budget, boundaries lint, upgrade path proven, merge.

**We are in phase 1.** Not phase 3, which is what a list of open bugs makes it
look like. The seventy-nine open children are mostly not on the bar, and letting
their count drive attention is the exact mistake this section exists to name.

### The corollary I keep having to relearn

**Nothing is releasable that has not been driven, and driving is the bottleneck.**
Every hour spent on an issue that no matrix cell measures is an hour not spent on
the constraint. That is the test I should apply before starting anything:
*which cell does this turn green?* If the answer is none, it is not phase-1 work
and it waits.

## FIRST NUMBER FROM THE MATRIX: 8 of 80, and POD-2853 is a PRODUCT defect (2026-08-26)

POD-2777's first drive on a rig with **no overrides**, and the rule paid for itself
inside an hour: removing them **blocked the entire terminal column**, which is the
correct result rather than a setback.

  terminal arm — no session starts at all, `abduco exited 1: create-session:
      File name too long`, exitCode -1.
  headless arm — the native CLI view never appears EITHER, and there it is
      **silent**: session stays live, `spawnFailure` null, attach answered
      normally, 0 bytes, cause visible only in a daemon warn.

**8 cells scored, 3 BLOCKED, 72 undriven.** Nothing has FAILED and the matrix has
no waiver row, so that is not a pass — it is an absence of measurement.

### POD-2853 is no longer a rig problem — re-ranked to P1

The measurements move it out of the test harness and onto the shipping path:

- **No named instance can fit, whatever it is called.** Derived budget: 90 constant
  bytes, and `len(id)` is counted **TWICE** — `HOME + 2*len(id) + len(user) +
  len(host) <= 17`. Shortest legal id (1 char) still needs 113 against `sun_path`'s
  107. `default` fits at 71 only by being short. *"Use a shorter name" and "use a
  shorter state dir" are both provably dead ends*, not untried ideas.
- **The headless path has the same defect with less rope.** codex-app-server's
  socket has 94 constant bytes; real sockets were bound to find the edge — **107
  binds, 108 fails**. Any instance id over **13 characters** loses codex headless,
  and the pattern allows **32**. That is reachable by any user who names an
  instance normally.
- The client-terminal label `podium-cx-attach-<uuid>` is 53 chars against the
  session label's 49, so the native view overflows by 4 bytes *more* than the spawn.

Deriving the budget and then **binding real sockets** to find the boundary is what
turns a plausible cause into a proven one.

### A fourth override nobody had named: HOME

The rig set `HOME` on the daemon to isolate agent children. For a named instance
the state root is **derived from `$HOME`**, so the daemon landed on a state root
**nested inside itself**. It failed loudly only because that directory had files;
on an empty one the daemon boots onto a **private** state root while the rig
believes it shares the server's — a silent split-brain that fakes results in either
direction. `PODIUM_STATE_DIR` had been papering over it, and none of it was needed
(`resolveAgentHomeDir`, `config.ts:550` already isolates a named instance's home).
Relayed to POD-2856 with the rule restated: *a rig may not relocate anything the
product derives for itself* — not merely "do not set these three names".

### The eight cells must be re-driven at the tip

The run pinned server, daemon and web before every cell — right discipline, wrong
commit: `15cdfa0`, **41 behind**. A PASS on a base that lacks the later commits does
not transfer forward, because the risk direction is that one of those 41 broke what
passed without them. A1a sits directly on the first-send deadlock fix and the
composer-readiness change, so 9.1s there is not a measurement of shippable code.
BLOCKED cells are unaffected. Four scored cells to redo, cheap now the rig exists.

**Also filed from the drive: POD-2862** — one permission opens **two** asks on a
server driver; the structured ask plus a screen-classifier copy that has no screen
to classify, carrying the whole shell command line in its `toolName`. Answering the
real one does not clear the copy. Correctly filed separately rather than buried in
an A4a verdict.

## POD-2853 SOLVED, AND IT TALKED ME OUT OF MY OWN SUGGESTION (2026-08-26)

I had proposed reclaiming the doubled `abduco/abduco` segment as if it might be
enough. **It is not, and the author found that by computing the number rather than
taking the suggestion:** de-duplication buys exactly **7 bytes** and leaves the
documented default at **114**, still over 108. Necessary, taken, insufficient.

**The fix is the bound rather than a shorter component.** The socket root no longer
derives from the state root at all — it comes from the **runtime directory**, chosen
as the first candidate that *both fits and can be created*:
`$XDG_RUNTIME_DIR/podium-<instance>` → `$XDG_RUNTIME_DIR/podium` →
`<TMPDIR|/tmp>/podium-<uid>`. p2853 composes to 98, operator to 104. Nobody
hand-sets anything.

**And the operator's paths were not shortened to get there** — the drive
deliberately used the documented default state root, which is *longer* than
`/home/mgw/.pod-op-state`, so the arm is the harsher one. That is the detail that
makes the result trustworthy rather than convenient.

### The silent half had a better cause than either of us guessed

Not the environment (that was POD-2761). **abduco walks FOUR socket roots and falls
silently to the next on any failure of the current one, while `abducoSocketDirs`
mirrored only the FIRST.** So a master that had fallen through was invisible, and a
*running* agent reported "did not publish a live socket". Reproduced end to end with
a live claude under a live master; the resolver now mirrors all four rungs in
abduco's own order. It also explains the operator-vs-POD-2843 divergence without
either rig being wrong: POD-2843 creates its socket dir before anything runs, so
abduco can use it; `/tmp/pod-op-ab` could not be used and abduco went elsewhere.

### One risk raised back before landing

The socket root is now **chosen at runtime from candidates**, which makes the path a
function of the *environment at spawn time* rather than of the instance. Two
consequences I asked to be checked rather than assumed:

1. **Restart-safe enumeration (POD-2432).** If a journal records a socket path under
   a root a later boot resolves differently — `$XDG_RUNTIME_DIR` unset under a
   systemd-spawned daemon, a different `TMPDIR` — reconstruction looks where there is
   no socket and reports a live session dead. *That is the same silent shape just
   fixed, relocated one layer up.*
2. **A daemon and a CLI that disagree.** Anything attaching from another process must
   resolve to the same root as the daemon that created the socket. Under systemd
   `$XDG_RUNTIME_DIR` is set; under bare ssh or cron it often is not. The four-rung
   mirroring presumably covers it — but it should be a property that is **tested**,
   not one that holds because two candidate lists happen to match.

### A rig defect that fakes a product failure — relayed to POD-2856

`grep -c` **prints `0` and exits `1`** when nothing matches, so `n=$(grep -c … || echo 0)`
yields the string `"0 0"` and every comparison downstream is false forever. In
POD-2843's rig this is the daemon-readiness gate: it spins all 120 iterations and
reports an **already-running daemon as never connected**.

This is the costliest class of rig bug, because *a false red costs the same
fix-and-redrive cycle as a missed real red* and is harder to spot — it looks like
diligence. Swept for across every rig, along with the `HOME`/derived-state-root
item. Same underlying rule both times: **a rig may not relocate or misread anything
the product derives for itself.**

## EVERY SUB-ISSUE IS CUT FROM MAIN — a tax I had been paying without noticing (2026-08-26)

`podium issue create` / `issue start` default **`parentBranch = main`**. Tracker
parentage is not git parentage: a sub-issue created with `--parent-id 1761` still
gets a worktree cut from **main**, not from this epic's branch.

**Measured this tick.** POD-2858 and POD-2867, both started today, came up at
`206693584` — a main commit from **2026-08-23**, missing roughly 150 epic commits.
POD-2853 and POD-2856 carry the *same* `parentBranch=main` and only contain epic
work because **their agents rebased themselves**. The ones that look fine are
survivorship, not a working default.

**The fix is `--parent-branch <epic-branch>` at create time**, and it is now my
standing dispatch procedure along with an `--is-ancestor` check before the agent
does any work.

### Why this is worth catching at dispatch and not in review

**A wrong base does not error. It produces confident wrong work.**

- POD-2867 was told to widen `packages/runtime/src/abduco-socket.ts`. On its base
  that file does not exist — so the rational move is to conclude the instruction
  was wrong and re-derive the 108-byte constant by hand. That is *exactly* the
  duplication the brief existed to prevent, and the agent would have had a good
  reason for doing it.
- POD-2858 is worse, because for that issue **the two branches are the
  experiment**: its job is to drive an upgrade from main's drivers to the epic tip.
  Sitting silently on main, it would have measured **main against main** and
  reported a clean upgrade. A PASS that means nothing — *failing toward the answer
  everyone wants*, which is the most dangerous direction a rig can fail in.

Both were caught before either wrote code, and both were told to record the SHA each
arm actually booted at rather than infer a pin from a process timestamp — `/proc`
mtimes on this host skew **forward** by up to two hours, so an older process reads
as newer, which is again the direction that turns a stale arm into a pass.

## MATRIX AT 14 OF 80, AND THE INSTRUMENT WAS CONTAMINATED (2026-08-26)

**14 cells, 2 of 5 columns: seven PASS, three PARTIAL, three BLOCKED, nothing
FAILED.** Under "zero Tier-A fails" nothing has failed — but with no waiver row,
three blocked and three partial are not a pass either, and sixty-six cells are
untouched with no terminal column at all, so there is still no A/B.

### The readings were being contaminated by a neighbour

POD-2811 found two ways the rig read things that were not there:

1. **opencode keys its conversation store BY DIRECTORY.** Two sessions in one
   directory share it, and a session that produced nothing displays *the other
   one's* transcript. The matrix's terminal provider-error cell was recorded
   BLOCKED — "the bad model was ignored, the harness answered normally" — when the
   assistant text read back was **probe 1's own nonce**, while the fault session's
   own row held 1 user and 0 assistant messages. **True value FAIL.** Filed and
   started as POD-2871.
2. **Two sessions on the same instance were reaping each other's servers.**
   `drive-up.sh` stops "the previous pair" by pidfile, so a neighbour's bring-up
   kills yours and **the survivor writes its commit into your log** — a pin line
   that looks perfect and belongs to someone else's run.

**Standing rule from here: one probe per directory, one instance per drive.** Any
cell driven with a neighbour alive is suspect and gets re-run rather than reasoned
about.

**Why POD-2871 outranks its apparent severity.** It is on the terminal path, so it
exists on main and is *not* a regression this epic caused; on the better-or-no-worse
bar it does not block. It is ranked because **a defect that makes the acceptance
drive report the wrong answer is worse right now than one that merely makes the
product wrong.** Every cell driven while it is live is suspect.

### POD-2811: the epic is BETTER here and the old arm is unchanged

Same rig, same commit, same control, reply probe passing on both arms before either
reading was taken:

| arm | result |
| --- | --- |
| headless (opencode-server) | first signal **12.2s**, `phase=errored`, `errorClass=provider-error`, plus opencode's own text |
| terminal (generic-pty) | **never, in 190 seconds**. `phase=idle status=live errorClass=none` |

The terminal silence is worse than "no error": the TUI printed *"Model … is not
valid"* on screen at +4s, the product showed a healthy idle session for three
minutes, the initial prompt was **never delivered**, and the session ran on a
**silently substituted model**. That is a **main** defect, recorded as a named
residual (POD-2868), not an epic blocker.

**And it found a worse one nobody had measured:** codex's `closeTurn` set
`{ phase: 'idle' }` **unconditionally, including for `status === 'failed'`** — a turn
that *died* rendered on the home board as one that *finished*. Found by reading the
neighbouring driver after measuring opencode. The cause is general: **a phase written
by hand beside an emitted change is a second reducer.** grok-acp is the only driver
that never had the bug and the only one that never hand-wrote the phase.

### Four self-corrections, three of which would have reached me as product defects

Worth recording as method, not just as diligence:

- **A5** scored a *perfectly correct* transcript as FAIL by looking for a following
  `tool_result` item when the real shape carries both halves on the **same** item.
  Caught by dumping the raw items rather than trusting the verdict — then the shape
  was **declared in `rig.ts` so the next probe reads it instead of guessing.**
- **A9** drove `sessions.stop` and called it a kill. The tree *was* gone, so the
  observation was true — but stop returns `hibernated/parent`, which is a **park**,
  and a park that tidies its processes says nothing about a kill. Re-driven against
  `sessions.kill`; the verb is a parameter now. Every process attributed **by
  environment, never by command-line pattern** — a `pkill -f codex` would take your
  own sessions down while reporting a clean sweep.
- **A6a** asked for a terminal without sending the `viewState` frame the browser
  sends. Verdict unchanged, but untrustworthy until the frame was there.
- **A4b** demanded a *thrown* error where the row asks only for a **typed** one, and
  scored `{"ok":false,"reason":"already-answered"}` as FAIL. Widened **and fenced**:
  the classifier now runs against the first answer too and must call it
  not-a-refusal, so it cannot rot into "anything counts".

**POD-2870 is a known-deferred gap, not a bug, and is a waiver candidate.** A1b: the
queued message survives a socket-drop reload and runs when idle, but no *position*
reaches a chat caller. The product computes one (`runtime-gateway.ts:49`) and emits it
on the message-receipt path; `command-plane.ts:459` narrows the chat reply to four
pinned keys with a comment deferring the wire change.

## THE SHARED-NAMESPACE SHAPE, THREE TIMES IN ONE DAY (2026-08-26)

POD-2867 proposed a sound socket design — one mode-0700 root under the OS runtime
namespace, **no** candidate-probing ladder (abduco's ladder exists only to mirror
what an external tool does on its own), and the 108-byte predicate kept in one
shared utility. All correct, and reached independently.

**The one part I pushed back on: dropping the instance id from the path.** The
premise was true — the basename carries no instance component — but the conclusion
does not follow, because **the budget no longer needs the saving.** Measured on this
box rather than derived: `XDG_RUNTIME_DIR` is `/run/user/1001` (14 bytes) and the
basename `<12hex>-<12hex>.sock` is 30:

| instance id length | `/run/user/<uid>/podium-<id>/<basename>` | limit |
| --- | --- | --- |
| 1 | 54 | 107 |
| 8 (operator) | 61 | 107 |
| 13 | 66 | 107 |
| 14 | 67 | 107 |
| **32 (the maximum the pattern allows)** | **85** | 107 |

Carrying the full id at the longest legal name lands at 85, **22 bytes spare**. What
blew the old bound was the long *state* root, not the id; once the root is short the
identity is affordable.

### Why I was unusually firm about it

**This epic hit the same defect three times today, and every time the cause was a
shared namespace where identity had been dropped for convenience:**

1. Two sessions on one instance **reaping each other's servers** — `drive-up.sh`
   stops "the previous pair" by pidfile, and the survivor writes its commit into the
   other's log.
2. **opencode keying its conversation store by directory**, so a session that
   produced nothing displays the neighbour's transcript (POD-2871) — which already
   made the matrix record a cell BLOCKED when the true value was FAIL.
3. A shared socket root would be the same shape again: any reaper sweeping stale
   sockets there can kill a **live** socket belonging to another instance, and it
   would present exactly like the abduco silent failure being fixed — *a running
   agent that reads as having published nothing.*

It also collides with work in flight: **POD-2432** is teaching the journals to
enumerate sessions from disk after a restart, and enumeration over a shared root
walks other instances' sockets — when the entire point of a named instance is not
seeing its neighbours.

**Settled: `/run/user/<uid>/podium-<instance-id>/`, mode 0700, no ladder, predicate
in the shared utility.** I asked for the two counter-cases that would change it —
anything downstream assuming one socket root *per user* rather than per instance, or
an isolation guarantee the nonce already provides that I have missed.

## TWO BASE TRAPS, AND `origin` IS THE SECOND ONE (2026-08-26)

Both cost a round today and both are silent, so they are worth writing down as
dispatch procedure rather than as anecdotes.

**Trap 1 — a fresh sub-issue is not BEHIND the epic, it is on a DIFFERENT LINE.**
`podium issue create`/`start` default `parentBranch = main`. I told POD-2867 to
*rebase* onto the epic; its branch has **zero commits of its own**, so that asked git
to replay **61 main-only commits** onto the epic — including a chat-rendering rebuild
unrelated to sockets. It aborted rather than resolve foreign history, which was
right, and I would rather it refused than complied. **Rebase replays your own work
onto a new base; when there is no own work, `reset --hard` is the verb.**

**Trap 2 — `origin` is a permanently trailing snapshot on this epic.** Measured:

    local  issue/1761-agent-runtime   c58315ef4
    origin/issue/1761-agent-runtime   76fb38400   (8 behind)

and among those eight is a **product** fix, not just evidence — `981a97b0f`, POD-2811's
dead-turn badge. The epic lands ff-only on a **local** shared branch and deliberately
does not push, because nothing goes outward until the operator decides. So
`origin/issue/1761-agent-runtime` is stale for as long as the epic runs, and it is
the ref everyone reaches for by habit. **Every session is on one machine and
worktrees share one object store, so the LOCAL ref is both reachable and more
current.** Corrected instruction: `git reset --hard issue/1761-agent-runtime`, no
fetch.

**Standing dispatch procedure, now three checks:**
1. Create with `--parent-branch issue/1761-agent-runtime`.
2. Before the agent writes anything: `git merge-base --is-ancestor <epic tip> HEAD`.
3. Point every base instruction at the **local** ref, never `origin`.

The through-line with everything else found today: **a wrong base does not error, it
produces confident wrong work** — and both traps fail toward looking correct.

## POD-2853 LANDED — the terminal column is unblocked (2026-08-26)

Epic tip is now **`d4fb68408`** (fix `ab9d698ab`, plus the drive taken on that exact
commit — the discipline POD-2819 established and this one repeated without being
asked).

### Both of my questions answered from the code, and the second found a real defect

**1. Does the journal record the resolved socket path, or re-resolve it?** It
**re-resolves**. The sessions table persists `durable_label` and there is **no
socket-path column anywhere in the schema**, so no boot can come up holding a stale
absolute path — which is what makes moving the root safe at all. The cost is bounded
and documented: masters created by an older build are not found after the upgrade and
their sessions must be resumed. **Nothing in the field is orphaned, because every
instance the pin applies to could not start a durable session in the first place.**

**2. Is daemon-and-CLI agreement tested or coincidental?** Neither as posed — *there
is no CLI side*. Every resolver of the abduco root lives in the daemon and they all
go through **one** function, `abducoSocketDirs`, so agreement is **structural** rather
than two lists happening to match.

**But the honest version of the worry was real, and checking found it.** Inside the
daemon, the reattach path probes with `process.env` while the create used `childEnv`,
whose `HOME` is the agent home. Named instances are safe (the pin means `HOME` is
never consulted); the default instance with no agent-home override is safe (both
`HOME`s are the same). **Exposed: the DEFAULT instance with `PODIUM_AGENT_HOME` or
`config.agentHome` set** — which is the ordinary configuration here, since Podium's own
agents run under a custom agent home. The error is **one-sided toward absent**, so a
live agent reads as `session not found` and its master then **leaks until reboot**.
Filed, re-filed as a startable sub-issue and **started**.

### POD-2777's 53-byte label measurement changed what landed

The client-terminal label carries **no instance prefix** (53 bytes) against the session
label at `44 + len(id)`. **Below nine characters of instance id the attach label is the
LONGER of the two** — so a budget computed from the session label alone would have let
the *spawn* succeed while the *native view* overflowed: a live session with a
permanently blank pane, exactly the silent shape the drive had measured. The budget
now takes **the longer of both shapes**, and the harness-side test **derives the tokens
from the manifest registry**, so a fourth harness declaring a longer one fails rather
than silently re-opening the hole.

That is the difference between a hand-written list and a derived set, and it exists
because the acceptance drive measured a number nobody had asked for.

**Gates:** `bun run typecheck` 25/25. Per-file 23 runtime, 16 pty, 5 harness. Heavy
re-run on the exact committed tree after both gates had already passed on an earlier
one: `abduco.test.ts` 26 passed, `multi-instance-runtime.integration` 1 pass / 43
expects. All `PODIUM_TEST_WORKERS=1`.

## THE SWEEP IS THE CRITICAL PATH, SO IT STOPPED BEING SINGLE-THREADED (2026-08-26)

POD-2856 moved its rig work onto the epic correctly — preserved POD-2853's tip,
rebased the resolved cherry-pick, fast-forwarded under the merge lock, left local
main alone. Verified: epic tip **`6c10b6643`**, POD-2853's fix and POD-2811's fix both
still ancestors, main unchanged at `0bd90092c`.

**With the blocker gone, the constraint moved to the sweep itself — and it was one
session driving sixty-six remaining cells serially.** That is the schedule, so I split
it by harness column:

| session | columns |
| --- | --- |
| POD-2777 | codex, opencode, and the terminal arm of both |
| POD-2874 (new) | **claude** (15 rows), **shell** (6 rows) |
| — | grok, unassigned until one of them has capacity |

**Claude is the column I could not leave until last.** The bar is *every driver,
headless and headed, at least as good as today's main* — and **claude is the headed
driver people use today**. A regression anywhere else costs a fix; a regression in the
claude column is the one thing that definitively blocks the release. It had **zero of
sixteen rows** driven.

### Two rigs on one host makes the contamination rules harder, not softer

Both sessions carry the same three, and they are now rules rather than advice because
each one cost a round today:

1. **Distinct instance id and distinct working directory.**
2. **One probe per directory** — opencode keys its store by directory, which is what
   made the terminal provider-error cell read BLOCKED when it was FAIL.
3. **Two rigs on one instance reap each other's servers by pidfile**, and the survivor
   writes *its* commit into the other's log.

### The claude column has a trap the others do not

Written into POD-2874's brief because it would otherwise present as a product bug:
**a hermetic claude home is a first-run home.** claude-code runs `/auto-mode-setup`
itself, once, as soon as the first turn ends, whenever the agent home has no
`autoMode` block — a modal arrow-key wizard that **consumes typed text without echo**
and writes no transcript turn. A send silently vanishes and nothing in Podium shows
it.

And the obvious positive control does not catch it: **the trust dialog fires BEFORE a
session's first turn while the wizard fires AFTER it**, so "did my first send land?"
passes and everything measured afterwards measures the wizard. Three sends through one
session, requiring the *last* to land.

## `lint:boundaries` IS RED ON THE TIP AND THE EPIC DID NOT CAUSE ANY OF IT (2026-08-26)

Driven by me, on epic tip `6c10b6643`, because a red gate cited as a release blocker
has to be attributed before it can be one.

**Exit 1, 58 violations across 47 distinct files:**

| rule | count |
| --- | --- |
| console-ownership | 40 |
| harness-branching | 15 |
| ui-storage-ownership | 2 |
| manifest-browser-reach | 1 |

**`manifest-consumers` is GONE**, which is POD-2820's fix holding — that was the rule
the earlier blocker entry named.

### Attribution, three ways, because "exists on main" is not "passes on main"

1. **47 violating files, 0 absent from main, 41 byte-identical to main.** Those 41 are
   definitively pre-existing — there is no version of the file for the epic to have
   broken.
2. **The 6 the epic did touch, blamed line by line.** `FirstTaskActivation.tsx` is the
   only one whose violations carry line numbers, and all **nine** blame to commits that
   are ancestors of main. The epic's own diff to that file is **colour hex values** on
   lines 80/257/343/461 — the violations are on 40/45/48/368/378/379/396/403/420, which
   it never touched.
3. **The remaining five carry no line numbers (console-ownership prints a symbol, not a
   position), so blame cannot settle them — I checked the diffs instead**: zero added
   `console.*`, zero added `localStorage`/`sessionStorage`, zero added harness-name
   literals across all five.

**Conclusion: every violation on the tip is inherited. `lint:boundaries` is a
pre-existing main failure, not a release blocker for this epic under the
better-or-no-worse bar.** Recorded as a residual.

**What I did NOT prove, stated so nobody reads more into this than it holds:** I did
not run the gate on main, so I cannot say main's count is also 58 — the epic may well
have *fixed* some (POD-2823 removed nine harness-branching violations from one file
alone). The claim is only, and exactly, that **the epic introduced none of them.**

## THE EPIC BRANCH CANNOT SHIP: 61 COMMITS BEHIND MAIN (2026-08-26)

**Found by POD-2858 trying to drive the upgrade path, and it is the most important
thing surfaced today.** It was found by *attempting the thing* rather than reasoning
about it, which is the whole argument for hands-on driving.

The symptom: an epic-tip server against a state a main-tip server had already opened
fails **before `/auth/login`** —

    database has applied migration 20260820074346_session-conversation-binding,
    which this build does not define

Measured independently from the coordinator worktree:

| | |
| --- | --- |
| epic **behind** main | **61 commits** |
| epic ahead of main | 486 commits |
| merge base | `1bda60ae6`, **2026-08-19** |
| files changed on **both** sides | **88** |
| diverging migrations | exactly one — on main, absent here |
| schema files in the overlap | `migrations/schema.ts`, `drizzle-manifest.generated.ts` |

### Two consequences, and the second is the one that would have been missed

1. **The merge is not trivial.** 88 doubly-touched files including *generated*
   migration manifests. A generated file resolved by hand is a silent corruption
   risk — it has to be regenerated from the reconciled schema, not picked from a
   conflict side.
2. **Every better-or-no-worse comparison in the acceptance matrix is against a main
   the epic has not merged.** If any of those 61 commits changed behaviour the matrix
   measures, the baseline is stale. *The passes stand as measurements of the epic;
   what is not settled is the comparison.* After the merge lands, the cells that are
   **comparisons** get re-confirmed — not the whole matrix.

**Filed and started as POD-2876**: merge (never rebase — 486 commits of shared history
with live sessions on it), regenerate rather than hand-resolve, and *drive* the proof
that a database written by either build opens under the merged one.

### And it makes POD-2858's experiment more correct, not less

The arms it was given were `main → epic tip`. **That is not the upgrade a user takes.**
The real one is `main → (main merged with the epic)`, because that is what a release
is. Its blocker was the product telling it the second arm did not exist yet. It now
builds the **before** arm — pre-cutover sessions on main's drivers across all three
server harnesses plus terminal, with a planted codeword and a recorded conversation
pointer — which needs no second arm at all.

**A correction I owe it, recorded here too:** I twice told it to get off main and onto
the epic tip, with some force. For that issue main is a **legitimate arm** and holding
a checkout there was correct. What it needed was *both* arms at once, each pinned,
differing in exactly one variable.

## THREE REDS — the first real answer to the question that sets the date

From POD-2777, driving at the fixed tip, alone, no overrides:

**The terminal column is alive.** A6a on codex/headless is **PASS** where it was
BLOCKED: 3998 bytes on attach before any keystroke, typed mark echoed, resize
repainting 1854 bytes each way, a second viewer sharing 10 of 11 tail lines including
the mark. POD-2853's fix composes that socket at **87** bytes (session) and **91**
(attach) against 107 — measured by running abduco directly at those paths rather than
trusting the fix.

**POD-2875 — a chat send reports `delivered` and then stalls, whenever the CLI view is
the declared mode.** One variable, the mode in the `viewState` frame:

| mode | result |
| --- | --- |
| `chat` | `{"ok":true,"disposition":"delivered"}` — 2 items, 2 deltas, nonce present |
| `native` | `{"ok":true,"disposition":"delivered"}` — **0 items, 0 deltas, nonce nowhere**, idle 60s+ |

**It is not lost, and that distinction is the finding.** A second independent chat-mode
viewer also saw zero; when the original socket declared `mode=chat` and sent a *new*
message, **both** arrived. The turn parks while native is the declared mode and drains
when it stops being.

**The parking is defensible; the report is not.** Attach mints a human-controller
lease, so parking a chat turn behind someone typing at the TUI is reasonable — but the
vocabulary already has `queued`, which A1b uses correctly for the merely-busy case.
A1a's criterion is *"reply arrives; bubble goes sent, **never silent-settles**"*, and
this is a silent settle wearing a green tick: an operator with the CLI open on the
desktop, sending from chat on their phone, is told delivered and it sits.

Correctly **not** called a regression without a main arm — which the divergence above
now explains the importance of.

**Running tally:** PASS A1a A1c A2b A5 A6a A7a A7b(resume) A9 A10½ · PARTIAL A1b A4a
A10½ · REFUSED A3 (control did not fire — re-driving; a control that did not fire is
not a result) · **RED POD-2875, POD-2862, POD-2870**. A1a came back **4.1s** where it
was 9.1s on the old base — the composer-readiness change showing up.

### The branch is frozen for the merge, and the before-arm is already banked

POD-2876 holds `merge:issue/1761-agent-runtime` for the whole operation. Every live
session told to **keep working, land nothing**, and not to rebase onto a base that is
about to be replaced — I drive the rebases afterwards rather than having seven sessions
watch the ref.

**POD-2858 turned the block into progress rather than idling.** The **before** arm is
complete across **all four** harnesses — opencode, codex, grok and claude terminal —
with boot SHAs recorded and planted history/resume evidence captured. When the merged
tip arrives it repins and reads, instead of starting from nothing. That is the whole
value of splitting an experiment at the arm that does not depend on the blocker.

### All five columns are now staffed

With the branch frozen for the merge, driving is the work that does not contend for it
— evidence lands later, so a freeze costs a drive nothing. The last unassigned column
went out:

| session | columns | rows |
| --- | --- | --- |
| POD-2777 | codex, opencode + the terminal arm of both | in flight, 3 reds found |
| POD-2874 | claude, shell | 21 |
| POD-2877 | **grok** | 15 |

**Grok is the interesting column to have left until last, for a reason worth stating
before the numbers arrive.** It is the only one of the three server drivers that never
hand-wrote its phase beside the emitted change, and therefore the only one that never
had the dead-turn-renders-as-finished bug the other two carried. It also has real
protocol mechanisms where the others have heuristics: `session/prompt` returns a
`stopReason`, `session/cancel` was measured interrupting in 10–23ms, and `session/load`
resumes after `SIGKILL` with the transcript replayed.

So the expectation is that grok does **well** on A2a, A3, A7a and A7b. That expectation
is written into its brief explicitly, together with the instruction not to treat any of
it as a pass — **a mismatch between what the architecture predicts and what the drive
measures is itself a finding**, in either direction.

## PHASE 3 STARTS BESIDE PHASE 2, NOT AFTER IT (2026-08-26)

The roadmap put "close the reds" after "discover the full red set". That ordering is
right for *deciding* and wrong for *scheduling*: discovery is one long serial sweep,
and a red that sits undriven while it finishes has simply moved its fix-and-redrive
cycle later. So known reds get staffed **as they are found**, in parallel with the
sweep that is still running.

**POD-2878 filed and started** — the first red to get an owner, carrying POD-2875's
measurement verbatim. Its brief asks for three things beyond the fix, and the three are
the point:

1. **Establish whether main behaves the same**, because nobody has. POD-2777 declined
   to claim a regression without that arm, which was right — and it is the difference
   between a release blocker and an inherited residual.
2. **Answer whether the parked turn survives a daemon restart** while native is still
   the declared mode. *Delivered-and-parked is bad; delivered-and-then-gone is a
   different severity entirely*, and the answer decides whether it can be waived.
3. **Check POD-2870 at the same time** — the queue position that never reaches the chat
   caller. Both are the chat send path reporting less than the runtime knows, so one
   fix may serve both; if it does not, say why.

And the fence, because this is a class that widens badly: **a send that parks must
report `queued`, and a send that genuinely delivers must still report `delivered`.** A
fix that reports `queued` for everything would pass a naive test and be worse than the
bug.

### The proposed-issue trap has now cost five re-filings

Every agent that discovers something top-level files it correctly, and it lands in
`proposed` where **nothing can start it and I am not permitted to reparent it or mark
it duplicate**. POD-2866, POD-2869, POD-2872, POD-2875 and POD-2868 all arrived that
way. Each one is re-filed by hand as a sub-issue carrying the original brief verbatim,
and the original is left as a cosmetic stale row for the operator to clear.

This is worth a line in the epic's own record because the failure mode is invisible:
**a correctly-filed release blocker looks identical to a filed-and-forgotten one**, and
nothing surfaces the difference except somebody reading the stage.

## THE BAR IS FAILING AGAIN, AND THIS TIME IT IS DATA LOSS (2026-08-26)

**Correction to the entry above: I recorded POD-2875 as "a reporting bug and not a
data-loss one". That was POD-2777's assessment and it has retracted it, correctly.**
The earlier reading was based on the turn draining when a chat view is declared — which
it does, *but only if nothing restarts in between*.

**The parked turn does not survive a daemon restart. The message is destroyed.**

    HEADLESS (codex-app-server) — tip 6685c59, p2777, no overrides, no neighbour
      sent under a declared native view -> {"ok":true,"disposition":"delivered"}
      after 45s      0 items, 0 deltas, nonce absent, phase idle      C1: it parked
      daemon restart pid 2156779 -> 2163850, reconnected              C2: a real restart
      afterwards     parked turn arrived = FALSE, 0 items
      a FRESH turn on the SAME session answers fine                   C3: session healthy

So the session is alive and usable, and **the message the product said it had DELIVERED
no longer exists anywhere.**

    TERMINAL (generic-pty) — same probe, same commit, same rig, same harness, ONE VARIABLE
      sent under a declared native view -> delivered normally, 2 items, nonce present

**Nothing parks, so nothing can be lost — and the probe REFUSED to score that arm,
because with nothing parked there is nothing whose survival could be measured. The
refusal is the finding**: generic-pty does the right thing under exactly the conditions
where codex-app-server parks and then loses it.

### Why this is release-blocking rather than waivable

The epic exists to replace the terminal path with the server-driver path, and the bar is
that every driver be at least as good as what it replaces. **On this cell headless loses
a message that terminal delivers, at the same commit, with one variable between them.**
That is the bar failing on the record, on the family we are switching *to*, in a
configuration an operator reaches simply by having the CLI open. **P1.**

**And the comparison instrument is better than the one I asked for.** I had asked
whether main behaves the same, to decide blocker-versus-residual. POD-2777 settled it a
stronger way: a **within-one-commit comparison between the two drivers**. That does not
depend on the branch being merged with main, and it is more decisive here, because the
epic's proposition *is* terminal-versus-headless.

### The fix shape I suggested is now insufficient, and that is my error

I proposed returning `queued` instead of `delivered`. **An honest disposition on a
message that is then destroyed is still a lost message.** There are two defects and
POD-2878 owns both: the disposition is wrong, *and a parked turn is not durable*.
Durability first; the wording is the smaller half. Fenced both ways — a parked turn must
survive a restart **and must not be delivered twice** when the view changes afterwards,
since duplicate delivery is the obvious way to overshoot.

## THE TWO BLOCKED CELLS ARE GREEN ON BOTH ARMS

| cell | headless | terminal |
| --- | --- | --- |
| A6a attach + type | PASS — 3998B on attach, echo, resize repaint 1854B each way, second viewer 10/11 shared tail lines | PASS — 5812B, 12/12 shared |
| A6b chat↔CLI ×2 | PASS — epoch stable 0 across four switches, scrollback marker survived each, chat and CLI both work after | PASS |
| A1a send while idle | **4.1s** | 6.4s |

**A1a is the first real A/B on an un-overridden rig, and headless wins it.** Recorded but
not scored: terminal adds **zero** processes per view switch where headless adds three —
the cold start the catalogue already declares absent for server drivers.

### Two more self-retractions before publishing, both on A6b

- **Counted the attach client as the agent** and reported "no restart: false". The
  triplet appearing and vanishing with the view is the *view's own client*, and tearing
  it down on leaving is correct. **Two attempts to separate them by command-line pattern
  both failed** — the client runs the same binary with the same `--listen` shape — so the
  census is now taken while *chat* is declared, when no view process exists at all.
  **Behaviour, not pattern-matching.**
- **Neither probe primed the TUI.** On headless there is no TUI in the way so the
  omission never showed; the first terminal run reported "chat stopped answering" with
  **599,437 bytes of a dialog repainting**.

**Tally: FOUR REDS** — POD-2875 (P1, data loss, headless-only), POD-2862, POD-2870, and
A3 still REFUSED pending a re-drive.

### A bind is not a session — POD-2867 sent to drive its own fix

The codex socket fix is implemented and measured: legacy 13-char path **107 bytes bound**,
14-char **108 failed**; new runtime-root path **66** and **67**, both bound. Two genuinely
different methods agreeing — my arithmetic on the composed string and the kernel actually
accepting the path — with the old boundary reproduced in the same run so before and after
sit on one instrument.

It also **checked** rather than assumed the question that decides whether the change is
bigger than it looks: `codexClientSocketPath()` composes per launch, the live endpoint
holds the path only in memory, and `CodexJournalEntry` carries thread/workdir/process/
model/sequence with **no `clientAddress` or `socketPath` field**. Nothing persisted, so
moving the root needs no migration.

**None of that proves a codex session starts.** Binding a socket at a composed length
proves *the path fits*; it does not prove *a headless session runs and answers* on an
instance named long enough to have broken it. Those are different claims, and this epic
already paid for the difference — an operator was handed a test instance verified only by
its pins, and it could not start a single session.

So: a named instance with a **long** name (≥14 chars, near the 32 the pattern allows,
since that is where the headroom is claimed), a real codex headless session, and a
**nonce read back out of the transcript** — not "the session went live", which is exactly
the shape that lied before: POD-2777 measured a live session with `spawnFailure` null and
**zero bytes**. Plus the same instance name at the **pre-fix commit** as a control, which
must fail with the file-name-too-long shape. *A fix that passes without a failing control
has never been shown to do anything.*

## THE PROJECTION — 21% driven, ~19 reds expected, 4-5 rounds (2026-08-26)

The operator's challenge landed: I had been *reporting a count* and calling it progress.
A count is a tree. Here is the forest, and it is now a standing per-tick obligation.

    driven      17 of 80 cells (21%)
    reds        4      rate 0.24 per cell
    projected   ~19 reds across the full matrix   (range 11-26)
    undriven    63 cells — ALL of claude, grok and shell
    rounds      ~5 at four fixes in parallel, ~4 at six

**Where the projection is weak, stated so nobody over-trusts it:** every driven cell is
**codex or opencode**, the two most-worked drivers. Claude, grok and shell are entirely
unmeasured, and either could break the rate. Grok is predicted *better* (it is the only
driver that never hand-wrote its phase beside the emitted change, and it has protocol
receipts where the others use heuristics). Claude is the one that matters most and the
one nobody has driven a single row of.

**Two new files, because prose in a ledger does not survive a context loss:**

- `docs/plans/pod-1761-results.tsv` — one line per check, fixed columns:
  *what | driver | verdict | commit | control fired | driven alone | date | issue*.
  **A line missing any field does not count as a result.** Every column is a way a
  result has already lied on this epic: eight cells scored on a base 41 commits old, a
  page of green from a run that had already died, a cell reading BLOCKED that was FAIL
  because a neighbour's transcript was being read, and "it works" claims that never said
  which arm. Staleness is now mechanical rather than remembered — 6685c59 is 1 behind
  the tip, c58315e is 4 behind.
- `docs/plans/pod-1761-decisions.md` — five open items only the operator can settle,
  each with the date, the choice, and what happens either way.

### The distinction I had been recording and not confronting

**Not every regression is a defect.** Headless costs three extra processes per view
switch where terminal costs zero — that is the architecture, not a bug, and *no amount
of further testing changes it*. I had filed it as "recorded, not scored", which is a
way of not deciding. It is now decision 2, alongside the parked-turn data loss (a real
defect, fix it), the missing queue position (waiver candidate), two main-only defects
that must be named rather than shipped silently, and a boundaries gate that was already
red before we touched it.

**The release decision is now a list to sign rather than a surprise at merge time.**

## A SECOND P1 WHERE HEADLESS IS WORSE, AND THIS ONE IS ORDINARY WORK (2026-08-26)

**POD-2884 / POD-2885. Long turns wedge on codex-app-server and complete on generic-pty.**
Same commit, same rig, same harness, one variable — plus a third arm outside Podium
because it settles the "is it the harness" question outright:

| arm | result |
| --- | --- |
| headless (codex-app-server) | **WEDGES** — previews freeze at 82 frames, then 400 seconds with `transcriptChars=0` and `items=1` (the user message alone). No assistant text on any plane, ever. |
| terminal (generic-pty) | completes in **61s**, screen bytes growing continuously |
| codex directly, outside Podium | completes in **83s**, exit 0, 31,065 bytes |

**The work completes outside Podium and on the old driver, and wedges only on the new
one. This is ours.** And the same shape was already recorded for **opencode**, so the
first place to look is the shared layer, not `codex-app-server.ts` — two harnesses, one
symptom, plausibly one cause.

**The 20-second cliff is the clue.** The preview plane works normally — 29 frames, then
77 — and stops dead at 82 while the turn runs on for another 400 seconds. Something
bounded is filling and not draining.

**A2a passing is not a contradiction, and the drive said so before I could.** 51 preview
frames joining 8.6s into a running turn, monotonic, fine watch acquired — *the plane
works for the first ~20 seconds and then stops*, so A2a and the wedge are the same
behaviour read at different timescales. Do not let A2a talk you out of the wedge.

**It also explains A3.** The interrupt probe controls on the turn being observed *in
flight* — previews or transcript growing. On this arm both are frozen by then, so the
control cannot fire and A3 correctly REFUSES. **A3 is unmeasurable on headless until
this is fixed**, re-driven alone on a clean session to rule out a shared streaming turn.

### A control failure reported rather than dropped

The first attempt at the outside-Podium arm was **invalid**: `codex exec` was waiting on
stdin and timed out at 420s having produced 39 bytes. *Had the author not read the
output, they would have reported "codex stalls outside Podium too" and closed the entire
finding.* The 83s figure is the re-run with stdin closed. That is the single most
dangerous shape on this epic — an arm that fails for a reason unrelated to the thing
being measured, pointing at the comfortable conclusion.

### A hypothesis checked and killed, so nobody re-spends it

POD-2875's blast radius is **narrow**. The server defaults `client.viewModes[sid]` to
`native` (`client-control.ts:225`, `terminal.ts:572`, `session-state/service.ts:455`), so
a client that never sends `viewState` should park too. **It does not** — undeclared and
explicit `chat` both deliver normally; only an *explicit* native declaration parks.

### And a rig defect that nearly cost a cell silently

An unknown probe name in `P2777_ONLY` was an **empty selection rather than an error**, so
`P2777_ONLY=streaming,…` (the probe is called `stream`) ran two probes, printed a results
table, and **exited 0**. A2a was nearly recorded as driven from a run that never touched
it. `drive.ts` now derives the known set from the probes themselves and refuses with exit
6, naming the unknown ids.

## THE PROJECTION MOVED

    driven      19 of 80 cells (24%)
    reds        5      rate 0.26 per cell
    projected   ~21 reds across the matrix   (range 13-29)
    rounds      ~6 at four fixes in parallel

**The shape of the answer to the epic's own question, so far: two cells say headless is
BETTER** (A1a 4.1s vs 6.4s; provider errors surfaced in 12.2s vs never) — **and two say
it is WORSE, both P1** (a delivered message destroyed by a restart; long turns that never
finish). Both worse-cells are *fixable defects*, not architecture. The only structural
item remains the three extra processes per view switch.

## THE PROJECTION MODEL CHANGED, AND IT IS BETTER NEWS THAN THE RATE (2026-08-26)

    driven   23 of 80 cells (29%)   reds 5   rate 0.22
    naive    ~17 reds across the matrix

**But the naive number is now the wrong model.** POD-2777 reports that **every one of the
16 rows has been attempted at least once, on at least one column.** So new reds can no
longer come from an untouched *row* — the remaining 57 cells are all **column variation**
on claude, grok, shell and opencode.

That splits the forecast honestly:

| if column-variation reds run at | added | total |
| --- | --- | --- |
| 0.10 / cell (rows mostly behave the same across harnesses) | +6 | **11** |
| 0.26 / cell (same rate as the codex column) | +15 | **20** |

**The uncertainty is now concentrated in one question: do the harness columns behave like
each other?** Grok is predicted better — it is the only driver that never hand-wrote its
phase beside the emitted change. Claude is unmeasured and is the incumbent. That is a
much more tractable unknown than "how many bugs are left".

## A RETRACTED REGRESSION REPORT, AND THE LESSON IS GENERAL

POD-2777 first scored A8 **FAIL** — *"a logged-out opencode SILENTLY became a generic-pty
session"* — which would have been filed as a POD-2772 regression. It checked
`agentState.error`, `spawnFailure` and `status`, found nothing, and concluded the product
said nothing.

**Dumping the whole session row instead of the three fields it assumed would carry it:**

    condition:         "logged-out"
    requestedDriverId: "opencode-server"   beside   driverId: "generic-pty"
    accounts.list:     loginRequired: true
    machines.list:     login.state: "out"

The demotion is recorded as requested-versus-actual, the session carries a typed
condition, and the account readout asks for a login. In its own words: ***"the product
says nothing" is a claim about EVERY surface, and I made it from the two I happened to
read.***

**That is a general rule and it now goes to every drive session: an absence claim is a
claim about the whole surface. Dump everything before reporting a silence.** This epic
has now produced the same shape three times — a guard correct at the surface and absent
at the seam, an assertion on an identifier rather than content, and now a silence claimed
from two fields out of a row.

**Corrected to PARTIAL.** What is genuinely missing is a login *affordance* — nothing
offers to log you in — which the catalogue already declares. The row asks for a working
login path; there is a declaration, not a path.

**And the second half was declined rather than faked.** *"After login, the next session
lands on the server driver"* cannot be driven without minting credentials the rig must not
mint or rotating the operator's own token mid-release. Recorded as decision 7 — **the one
item on the entire matrix a human settles faster than an agent can.**

**Tally: 23 cells, PASS 12, PARTIAL 4, BLOCKED 2 with stated cause, FIVE REDS** — two P1
(long turns wedge; a delivered message destroyed), plus POD-2862, POD-2870, and A3
unmeasurable until POD-2884 lands.

## TICK: 29% DRIVEN, AND I CORRECTED MY OWN NEW RULE ONE TICK AFTER MAKING IT

    driven   23 of 80 (29%)   reds 5
    if the harness columns behave alike (0.10/cell)   -> 11 total, ~3 rounds
    if they vary like codex did   (0.26/cell)         -> 20 total, ~5 rounds

**The staleness rule I wrote last tick was wrong and would have destroyed 25 valid
results.** It said *"a row whose commit is behind the tip must be re-run"*. Three commits
had landed since `6685c59` — **all three mine, all docs-only**. `git diff --name-only`
excluding `docs/` returns empty, so nothing those 25 rows measured has changed.

Corrected in the file and in the cron: **stale means CODE changed since that commit, not
that commits landed.** The check is one command and it is now written at the top of the
results file. A rule that flags everything is the same as a rule that flags nothing.

**Two sessions looked dead and were not.** POD-2874 and POD-2877 showed zero files
written in two hours. Both have **live server and daemon processes with their own state
roots** — a drive writes to its state root, not its worktree, so an empty worktree is
evidence of nothing. That is now in the cron's session-check step, because I would have
made the same wrong call next tick.

### The standing brief exists now, and it is the rule I was worst at

`docs/agents/pod-1761-standing-brief.md` — every rule I had been re-typing into
individual briefs, in one place: base and branch verbs, rig isolation, the pin and
control standard, absence claims, filing and landing, gates. Eighteen rules, none
hypothetical, each one having already cost a round.

It also carries the correction I most needed: **my own rules apply to me.** I froze seven
sessions off the branch and then blocked the merge twice by committing to it myself.
That is now written where the next coordinator reads it.

## THE FREEZE FAILED STRUCTURALLY, AND THE FIX IS A LOCK RATHER THAN A PROMISE

I froze the branch **by mail** and backed it with a **30-minute lease on a merge that
takes hours**. The lease expired. Three sessions then checked the lock, correctly found
it free, and landed:

    5ff13da24  the rig loses its overrides, terminal column with it   POD-2777
    9ce04fc89  rigs audited against named-instance paths              POD-2856
    3d7fa89bc  reattach probes sockets under the agent home           POD-2873

**None of them did anything wrong.** A mail-freeze is not a freeze; it is a countdown
nobody is watching, and it decays silently while a 307-file merge sits resolved against a
first parent that is quietly going stale.

**Replaced everywhere with one checkable rule:** *land only while
`merge:issue/1761-agent-runtime` is FREE, and take it for your own landing.* Checkable at
the moment you act instead of remembered from an hour ago, and it does not decay. Sent to
all ten sessions and written into the standing brief. Long operations **renew** the lease
— re-acquiring a lock you hold renews it.

### A three-line fix landed with no evidence, and it went back

POD-2873's reattach fix is **correct** — `ctx.homeDir` overlaid on `process.env` at *both*
call sites, exactly the shape POD-2761 established, and applying it to `abducoSocketPath`
as well as `waitForAbducoSocket` is the half a partial fix would have missed.

It landed with **no test, no drive, and an empty commit body.** Sent back — not as a
nitpick round, but because the defect is *one-sided toward absent*: it fails by reporting
a live session as gone and leaking its master until reboot, which is exactly the class a
unit test passes and a real daemon still gets wrong, since what differs is which `HOME`
the process was actually spawned with rather than what the code says it passes. It owes
the driven both-arms proof and the both-edges pin its brief asked for.

### I am starving my own critical path

Load **28.9**, 888MB free, 46 codex processes. Ten sessions I dispatched are competing
with the one operation that blocks the release. Nothing was paused speculatively — three
are mid-drive with live instances and killing them wastes an hour of bring-up each — but
POD-2876 has been told it has priority and that the drives get parked on request. **No new
work started this tick**, including one unstaffed red I would otherwise have taken.

## COLUMN INDEPENDENCE ANSWERED: THEY BEHAVE ALIKE (2026-08-26)

The whole remaining uncertainty was one question. It has its first answer, and it is
**"no — the columns are not independent"**: good for the forecast, bad for the release.

**Both server drivers wedge. The one driver they share succeeds for both.**

| harness | driver | result |
| --- | --- | --- |
| codex | codex-app-server | **WEDGES** — 422s, previews frozen at 82, `transcriptChars=0` |
| codex | generic-pty | 61s, 12,291 chars |
| codex | outside Podium | 83s, 31,065 bytes |
| opencode | opencode-server | **WEDGES** — 422s, previews frozen at 21, `transcriptChars=0` |
| opencode | generic-pty | 92s, 10,250 chars |
| opencode | outside Podium | 64s, 19,285 bytes |

**POD-2885's shared-layer hypothesis is now proven rather than suspected.** Two different
server drivers fail; the driver they share succeeds for both.

**And the drive handed it a real lead rather than just a grid.** The freeze points *differ*
(82 vs 21 frames), so it is **not a fixed budget**. The durable transcript is zero in every
wedged case for the full 422s, while on the terminal arm it arrives in **one batch at
turn-end** — so if the server path also defers the durable write to turn-end, *a turn that
never reaches turn-end writes nothing and shows nothing*. That predicts the wedge lives in
**whatever declares a turn complete**, not in the preview plane.

### This changes the unit of the schedule

I had been forecasting **red cells**. The schedule is actually **distinct defects**, because
each defect is one fix-and-retest cycle no matter how many cells it shows up in.

    driven 26/80    red CELLS 7    distinct DEFECTS 5    (1.4 cells per defect)

If the columns behave alike, a remaining cell either **replicates a known defect (costs zero
extra fixes)** or reveals a new one:

| if new defects appear at | total fixes | rounds at 4 parallel |
| --- | --- | --- |
| 0.04 / cell — most remaining reds are replicas | **7** | ~2 |
| 0.10 / cell — some genuinely new | **10** | ~3 |

**That is materially better than the 11–20 range I gave last tick, and the reason is that
alike columns replicate defects rather than multiply them.**

**But it cuts the other way for coverage, and the drive said so first:** *a red found in one
column should be assumed present in the others until driven, rather than the reverse.* codex
and opencode are now two-for-two on shape. Evidence strength: one cell, two columns —
directional, not settled.

**Incidentally confirmed, not chased:** opencode/terminal reported `phase=idle` for its first
**61 seconds** while screen bytes grew 57,400 → 238,722 — the known "terminal never reports
working" defect reproducing on the tip. Not filed (terminal path, already known), but it is
why the interrupt probe keys its control on PTY bytes rather than phase on that arm.

## MERGE CADENCE: OVERRULED, AND CORRECTLY (operator, 2026-08-26)

I proposed merging main in whenever the branch drifted more than ~20 commits behind, on the
theory that many cheap merges beat one expensive one. **Overruled:**

> *"your decision about merging regularly is worst case. it took you 3h. main will move
> regularly. no point doing it and just being occupied with merging all the time. do not
> merge until i tell you to. focus on getting the epic done."*

**The arithmetic I did not do.** I costed a merge at three hours and then proposed doing it
repeatedly, without multiplying. Main moves daily; a cadence of merges is a standing tax on
the one coordination channel this epic has, paid in exactly the hours that should go to
closing defects. My "merge often, it's cheaper" reasoning optimised the *unit* cost of a
merge and ignored the *total*.

**And it mistook integration for the job.** The epic's deliverable is every driver at parity
with today's. Main being merged is a precondition of *landing*, once, at the end — not a
property to maintain throughout.

**Standing position from here:** main stays merged at `7b9d9eacb` and is not merged again
until the operator says so, however far behind the branch drifts. Divergence is not measured
and not raised. A session genuinely blocked by a main-only change mails me with the specific
block rather than merging to unblock itself.

Removed from the per-tick routine and from the standing brief. **Back to the defects.**

## TICK: 47 of 80 DRIVEN, 6 DEFECTS, 1 CLOSED — and the box is the constraint again

    driven      47 of 80 checks
    defects     6 found, 1 CLOSED AND DRIVEN (codex socket overflow, POD-2867)
    open        5, all with live owners, 2 of them P1
    projection  most remaining reds replicate rather than add, so 7-8 total fixes,
                ~2 rounds at four in parallel

**The one closed today is the template.** POD-2867 landed with a pre-fix control that
genuinely failed — a live `SUN_LEN` error and no output — then a nonce read back out of the
transcript and the native pane rendering, on a 25-character instance name, with real socket
binds at 107/108 before and 66/67 after in the same run.

### Concurrency is now the limiting resource, not ideas

Load **41.7** with **1.4GB** free across ten live sessions. Not gates this time — the
`test:heavy` lock is correctly held by POD-2878 — but the sessions themselves plus the
harness processes their drives spawn (`opencode` 693MB, `claude` 576MB, `podium-cli` 497MB).

**Parked two, on value rather than on liveness:**

- **POD-2876** — the merge is landed and verified; its remaining work is the both-directions
  union proof, which is real release evidence but can wait an hour.
- **POD-2874** — column complete; its only outstanding item is a re-drive of two permission
  cells blocked by *my own* rig instruction, which cannot move the release decision today.

**POD-2858 has hibernated on its own** and is the one I most want back: the upgrade path is
the operator's stated concern, its before-arm is banked across all four harnesses with boot
SHAs recorded, and its second arm finally exists now that main is merged. It gets woken the
moment there is room — waking it at load 41 would only produce readings on a starved host.

**The lesson I keep re-learning at a different scale:** ten sessions is more than this box
supports, and I discover that by watching load climb rather than by planning for it. The
defect owners are the work; everything else yields to them.

## TWO OF SIX DEFECTS CLOSED AND DRIVEN (2026-08-26)

**POD-2873 closed** — reattach reading the daemon's `HOME` while the master was created under
`ctx.homeDir`. I read the readings rather than the summary, and all three arms hold:

| arm | result |
| --- | --- |
| **legacy control** | PASS — the row went `exited`/`-1` **while its live master remained on disk** |
| **fixed, exposed** | PASS — reattach found the live master after a real daemon restart |
| **fixed, safe** | PASS — named instance and unmodified default both still work |

A positive control fired in each: live row *and* live terminal master present before anything
was measured. 930 lines of rig and readings, with complete API rows, SQLite rows and direct
socket scans.

**The safe-config arm is the one most fixes skip.** Proving the exposed configuration now
works is easy; proving the two *safe* ones still work is what rules out a fix that overlays
the wrong `HOME` and breaks the ordinary case silently.

**And sending it back was right for a reason worth restating.** Its original three-line fix
was *correct* — I said so then and still think so. But the defect is **one-sided toward
absent**: it fails by reporting a live session as gone and leaking its master until reboot.
That is exactly the class a unit test passes and a real daemon still gets wrong, because what
differs is *which `HOME` a process was actually spawned with*, not what the code says it
passes. Only a drive separates those.

**Closed so far:** POD-2867 (codex socket overflow), POD-2873 (reattach under a custom agent
home). **Open:** the two P1s (long turns wedge, delivered-then-destroyed), one permission
opening two cards, cross-session transcript bleed.

### The upgrade drive is woken

POD-2858 had hibernated waiting for a second arm that did not exist. It exists now. Its
before-arm was banked hours ago across all four harnesses with boot SHAs recorded, so what
remains is the **read**, not a re-run: does each pre-cutover session list, resume, keep its
history, and **which driver does it come back on**.

That last question settles something nobody has: **the driver is not persisted anywhere.**
`resolveDriver` takes agent kind, request, machine default, available drivers, platform and
auth — nothing carrying what the session was bound to before. So an old terminal session
*should* rebind to a server driver, and whether its conversation survives that rebind is what
this drive answers and nothing else can.

## EXACT CELL ACCOUNTING, AND THE WEDGE SURVIVES THE MERGE (2026-08-26)

**The P1 is on the branch that ships, not just on the pre-merge epic.** POD-2885 re-driven at
`372ae4d` with main in and the TranscriptFeed repair in, rig pinned on all three components:
**426 seconds at `phase=working`, previews frozen at 80, `transcriptChars=0`, `items=1`,
never completes** — identical to the pre-merge shape, which froze at 82. That was the right
cell to take first off the staleness list, since `inbox.ts`, `command-plane.ts` and
`session.ts` all moved and the wedge is in shared code.

### The codex + opencode scope, counted rather than estimated

    scope        16 rows x 2 columns = 32 cells
    DRIVEN       26   codex 15/16, opencode 11/16
    NEVER DRIVEN  6   codex A8; opencode A2a A3 A7a A7b A9
    of the 26:   A3 REFUSED on codex (unmeasurable until the wedge is fixed — its control
                 needs the turn observed in flight and both planes are frozen by then)
                 A4a/A4b BLOCKED on codex (that harness raises no approval on this host,
                 controlled against codex run OUTSIDE Podium with the same flag)

    STALE, by file-level analysis rather than wholesale
      re-drive   codex column headless        (codex-app-server.ts moved)
      re-drive   A1a A1b A5 on BOTH columns   (ten session-module files moved)
      leave      opencode driver cells        (opencode-server.ts did not move)
      leave      A6a A6b terminal arm         (generic-pty did not move)
      done       the wedge, re-confirmed at 372ae4d

So the outstanding work in that scope is **6 never-driven cells plus ~11 re-drives, not 32**.

### A distinction that changes what a future red MEANS

New defects can now only come from those six unknowns, **or from a re-drive changing a
verdict** — and those are not the same finding. *A cell that passed before the merge and
fails after it is a regression the merge introduced*, which is more alarming than a new
defect and belongs in a different bucket. The five re-drivable rows have all passed once.

**Defects: 7 found, 2 CLOSED AND DRIVEN, 5 open.**

    CLOSED  POD-2867 codex socket overflow   POD-2873 reattach under a custom agent home
    OPEN    POD-2885 long turns wedge (P1, confirmed post-merge)
            POD-2878 delivered-then-destroyed (P1; POD-2870/2879 are the same defect
                     showing on codex and claude)
            POD-2893 one permission, two asks
            POD-2871 cross-session transcript bleed
            POD-2880 claude interrupt returns but the turn runs on — NEEDS ITS MAIN
                     COMPARISON, and claude is the incumbent driver
