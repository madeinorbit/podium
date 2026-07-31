# POD-736 — the switch-latency harness across the wire cutover

Evidence for *2.7 Switch-latency harness survives cutover*. Three parts: the
recorded A/B, the proof that the harness can say NO, and one decision taken
against the issue brief on measured grounds.

Raw arm reports: `docs/agents/evidence/pod-736/`.
Host: 8 cores, load average 9–28 during the runs (a busy fan-out host — see
*Threats to validity*).

---

## 1. The recorded A/B — snapshot pipeline vs Authority feed

**Which baseline this is measured against, stated first because it is the part
that is easiest to get wrong.** There are three recorded baselines on this issue
and they are not interchangeable:

| baseline | what it measured | number |
|---|---|---|
| POD-701 pre-rewrite | client gesture → chat first paint, real browser, 530 sessions | p50 2292ms / p90 4896ms |
| POD-701 post-fix (main `85fa1a2c`, after POD-722/723/724/725) | the same, same instrument | p50 548ms / p90 1012ms |
| **this A/B** | the **server's share** of a switch, in-process, 588 sessions / 800 issues | see below |

**This A/B is not measured against either POD-701 figure, and could not be.**
Those are client-side end-to-end numbers from a real Chromium against a copied
state dir; the pre-cutover arm of a client-side comparison cannot be re-run,
because the pipeline it measured no longer exists. One side of that comparison
could only ever be a quotation carrying its browser, its machine and its day
inside it.

So arm A was **measured, not quoted**: a detached worktree at `e3a9a9ab` — the
commit immediately before `f63e0581` merged POD-1203's serving-path cutover, with
`publishComputed` still present — running *the same bench script*, on the same
host, three minutes apart from arm B. That is a MEASURED not-mine claim in the
sense the fan-out protocol requires: named SHA, own `bun install`, identical
command.

### Result

Driver: 588 sessions, 800 issues, 250 attach/detach cycles (500 switches).

| | A — snapshot pipeline (`e3a9a9ab`) | B — Authority feed (this branch) |
|---|---|---|
| interaction p50 | **0.90ms** | **1.12ms** |
| interaction p90 | 2.26ms | 3.38ms |
| interaction p99 | 6.16ms | 9.33ms |
| `ws.attach` p50 | 0.28ms | 0.29ms |
| `sessionsBroadcast.total` p50 | 0.60ms | 0.65ms |
| `feedPublish.total` p50 | — (no feed) | 0.14ms |
| `feedPublish.frame` / `.fanout` p50 | — | 0.07ms / 0.05ms |

**Reading it honestly: the cutover did not move the server's share of a switch,
and it did not need to.** The server was already spending under a millisecond per
switch at this scale before the cutover; the +0.22ms in arm B is the feed's
framing and fanout being *added* while `sessionsBroadcast` has not yet fully shed
its remaining work (the issue-projection change check). This is a
**no-regression** result, which is what the cutover owed, and it is emphatically
**not** a restatement of POD-701's 2292ms → 548ms — that improvement was won by
POD-722/723/724/725 and lives mostly outside the server's broadcast path.

Anyone quoting a large switch-latency win from this table has read it wrong. The
number that moved 4× is on the POD-701 browser bench, and the reason it is not
reproduced here is that this bench deliberately does not include the browser.

### Does this comparison control for slice size?

Yes, and here is the argument rather than an assertion.

Arm B's single principal has a measured slice of **1388 rows**, and
588 sessions + 800 issues = 1388. The post-cutover principal's slice **is** the
whole world, so arm B enjoys no smaller working set than arm A's unscoped feed.
The comparison is like-for-like on the axis that matters.

Arm A carries **no principal partition at all** — the dimension did not exist on
that tree — and the bench says so rather than inventing one. Consequently
`--compare arm-a.json arm-b.json` **refuses**:

```
INVALID: the arms share no principal. A cross-principal comparison is not a
comparison — see docs/multi-user-readiness.md and the POD-736 acceptance criteria.
```

That refusal is correct and is left in place. A same-principal comparison across
the cutover is **structurally unavailable** and will remain so: the dimension is
newer than the pre-cutover tree. The valid same-principal comparison is between
two post-cutover arms (§3), and every future A/B — POD-310's rehearsal, POD-337's
gate — is same-principal by construction because both arms will have the
dimension.

---

## 2. Can the harness say NO?

The failure this issue exists to prevent is not a harness that breaks. It is a
harness that **keeps working while measuring the wrong thing**: after the
cutover, `perf.snapshot` still returned populated `sessionsBroadcast.*` phases —
because that pipeline still fires for the issue-projection rebuild — while
observing none of the path that now serves clients. Every symptom of health, over
a shrinking remainder.

`apps/server/src/modules/perf/harness-live.test.ts` drives the real
`SessionRegistry`, a real connection and a real write, and asserts against the
process-level singleton every production site writes to. Five mutants were
applied to prove it refuses. One mutant per call; each verified as **1 match**,
hash changed, compiled, only the target file dirty, reverted to the original
hash.

| # | mutant | result |
|---|---|---|
| 1 | drop `perf.record('feedPublish.total')` from `WriteFunnel.flushDeltas` | **KILLED** — 4 of 6 tests red |
| 2 | drop `feedBootstrap.total` from `FeedServing.serveWorld` | **KILLED** — 1 red |
| 3 | attribute the serving edge's phases to `DEPLOYMENT` instead of the principal | **SURVIVED**, then killed — see below |
| 4 | make the principal digest ignore its input (all principals collapse to one partition) | **KILLED** — 1 red |
| 5 | never call `observeSliceSize` at bootstrap | **KILLED** — 1 red |

### Mutant 3 is the finding, so it is written up rather than buried

Swapping only `gateway/feed-serving.ts`'s attribution to `DEPLOYMENT` **passed
all six tests**. It typechecked, it ran, and half the switch cost silently left
the principal's partition.

The reason is exactly the trap this run keeps paying for: the assertion named one
phase, `feedPublish.total`, and that phase is recorded in a *different file*
(`modules/funnel.ts`), which kept its principal. The partition still contained a
plausible p50. A reader would have seen a healthy per-principal number computed
from half the work.

The fix is to assert over **every** `feedPublish.*` phase the deployment-wide map
contains, with a floor (`toBe(4)`) so the loop cannot iterate over an empty list.
Re-run against the same mutant: **1 test red**, with the message naming the phase
that went missing. Fixed in `c999567d`'s successor commit, and the mutant is the
reason that commit exists.

---

## 3. The decision taken against the brief: the POD-722/723 shims stay

The issue brief instructs: *"remove the interim POD-722/723 delta-scoping shims
as part of the cutover — they are scar tissue on the deleted pipeline."*

**That premise no longer holds after POD-1203, and the shims are not being
deleted.** The reasoning and then the measurement:

- When the shims were written they sat on top of `publishComputed`/`allWire` —
  two serving paths over one truth, and the skip existed to avoid re-fanning a
  snapshot nothing had changed. That is genuinely scar tissue on a deleted
  pipeline.
- Post-POD-1203, `publishIssues()` no longer fans out a snapshot. It reconciles
  rows into the ledger, and the Authority dedups the **fan-out** natively. So the
  half of the shims' job the brief describes **is** gone.
- What the shims now suppress is the other half: the O(issues × sessions)
  `allWire()` **build** that a session-driven publish triggers. That work is
  unchanged by the cutover and sits directly on the switch hot path.

Measured, same principal, same 1388-row slice, arms three minutes apart
(`--compare` accepts this pair and prints `slice size 1388 rows — like for like`):

| | shims present | POD-722 skip removed |
|---|---|---|
| interaction p50 | **1.12ms** | **20.43ms** |
| interaction p90 | 3.38ms | 34.92ms |
| interaction p99 | 9.33ms | 50.39ms |
| `sessionsBroadcast.total` p50 | 0.65ms | 18.85ms |
| `sessionsBroadcast.publishIssues` p50 | *never ran* | 14.29ms |
| `feedBootstrap.read` p50 | 7.03ms | 32.52ms |

`sessionsBroadcast.publishIssuesSkipped` fired on **500 of 500** switch
broadcasts: the skip is engaged on every switch, and removing it puts a ~14ms
rebuild on each one. **An 18× regression on the exact number this issue exists to
protect.**

So the shims are registered as a counted deletion-audit item
(`issue-wire-dirty-scoping-shims`, 4 sites, phase POD-337) rather than deleted or
left as a comment. The brief's real requirement — *audit items reach zero* — is
now enforceable, where before it was an instruction with no instrument: the item
had never actually been registered, so nothing was counting it.

**The named expiry condition**, so it can arrive rather than drift: both shims
exist because `IssueWire` embeds `SessionMeta[]`, which is what makes a *session*
change force an *issue* rebuild. They become deletable when a session change
reaches issue clients as its own change row instead. That is a representation
change (ADR 4), not a timing one, and it is what POD-337 must see at zero.

---

## 4. Cross-principal exposure — what is closed, and what is flagged

Closed:

- Partitions are keyed by a **digest** of `principalIdOf`, never the raw id. An
  agent principal is keyed by its session id, and a session id in a
  deployment-wide diagnostic is content from somebody's slice.
- The partition is a **mechanism**, not a report format: a scoped read is
  `snapshotFor(principal)` — selection, not a filter someone must remember to
  apply. Asserted in both arms (`registry.test.ts`: A's traces present, B's
  absent, and the deployment-wide read still carries both).

**FLAGGED, NOT DECIDED** — these force the open existence-leak question
(`docs/multi-user-readiness.md` §3.1.2) and this issue instruments rather than
enforces:

1. **`perf.report` cannot name its principal.** Client switch traces arrive over
   /trpc, which mints OPERATOR for every caller and carries no per-connection
   principal. The only other candidate is the trace's own `sessionId`, and
   attributing by payload is what would let one client write into another
   principal's partition (ADR 3 Am1 D17). So traces land in the deployment-wide
   ring, exactly as before, and **that ring is the harness's one remaining
   cross-principal exposure** the day a second principal exists.
2. **Nothing enforces `perf.snapshot`'s grade.** The contract already declares
   the family `deployment-substrate` and says in as many words that the tRPC
   transport does not gate on `roleFloor`. `snapshot` is a query and has no
   `roleFloor` slot at all. Making it admin-grade in fact is enforcement, and
   belongs to POD-315's per-user principal, not here.
3. **Slice sizes are existence facts.** `byPrincipal` publishes each principal's
   row count. Whether a count of another person's world may be read is
   deliberately open in §3.1.2. It is kept out of the per-principal partitions of
   *other* principals, but the deployment-wide read has it.

---

## Threats to validity

- **Host load.** The runs happened on a fan-out host at load average 9–28 on 8
  cores. Absolute milliseconds are therefore pessimistic and noisy. The
  *comparisons* are the claim, and each pair ran within minutes on the same host.
  The 18× shim result is far outside any plausible load artefact; the A→B +0.22ms
  is within noise and is reported as "no regression", not as a regression.
- **In-process, not end-to-end.** This bench measures the server's share. It does
  not include the browser, the transcript read, or a real state dir, and it is
  not a substitute for `tests/e2e/switch-bench.ts` for the number a user feels.
- **One principal.** Every connection maps to one device-grade principal today
  (`gateway/client-principal.ts`), so the per-principal dimension currently has
  one entry. It is derived from the real feed principal at every site, never
  hard-coded, so the day per-user login lands the samples partition correctly
  with no edit — and the historical samples recorded from now on stay comparable.
