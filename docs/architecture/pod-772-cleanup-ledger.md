# Architecture cleanup ledger

A collector for architectural mismatches found during feature and performance work: cases where a
consumer had to hand-roll a workaround for something the platform should have been correct about out
of the box. The point of the ledger is that per-consumer fixes are accepted as interim, and the
requirement they imply must survive to the rewrite rather than being paid off silently.

Tracking issue: POD-772. Each entry names three things and nothing else:

- **Mismatch** — what the layer fails to provide, stated as a property of the layer, not of the
  consumer that tripped over it.
- **Cost** — measured or observed, with the scale it was measured at and the date. A cost without a
  scale is not evidence.
- **Correct by construction** — what the system would have to guarantee for no consumer to need the
  workaround, and where in the rewrite that guarantee belongs.

An entry stays open until the guarantee exists. An interim fix landing does **not** close an entry;
it moves the entry's status to `interim-shipped` and leaves the requirement outstanding.

---

## Entry 1 — Derived wire data rebuilt O(world)

**Status:** substantially satisfied at `96eb63cc` — see Entry 2 for the call-site
assessment and the residue. Superseded as a live requirement; kept for the record.
**Discovered by:** POD-701.
**Discovered by:** POD-701.
**Measured:** 2026-07-16, at real scale — 530 sessions, 674 issues.

### Mismatch

`publishIssues()` / `allWire()` rebuild **every** issue's wire payload on **any** session mutation,
because `IssueWire` embeds derived member data (`SessionMeta[]`). Change detection compounds it: the
whole list is compared by `JSON.stringify` byte-compare, which is O(world) per change regardless of
how small the change was.

The root mismatch is not in the issues module. The sync/offline-first layer — snapshot fan-out plus
ledger reconcile — has **no incremental derived-data story**. Every object type that wants to be fast
must therefore hand-roll its own dirty tracking. That is the defect: the cost is structural and
recurs once per object type, so fixing it per consumer never converges.

### Cost

A one-field change — `clientCount` on WebSocket attach — costs **p50 711 ms / p90 1.4 s** of
*synchronous* event-loop work. A session switch pays it twice, once on detach and once on attach.

Note the shape of this: the trigger is the cheapest possible mutation and the cost is still
proportional to the whole world. Any measurement taken at small fixture scale would have shown
nothing, which is why the scale is recorded above and why entries here require one.

### Correct by construction

Derived data is maintained incrementally, so no consumer can pay O(world) for a point mutation:
normalized entities plus a delta feed, with derived joins performed client-side, or a server-side
dirty set that bounds the rebuild to what actually changed.

**Where this belongs:** POD-308 (Authority delta feed), Phase 2 of the rewrite. That is the natural
place to make the guarantee true for every object type at once. This entry exists so the requirement
is not lost in the cutover — the interim per-type dirty tracking makes the symptom disappear from
the profiler while leaving the platform gap exactly where it was.

### Interim, and why it is not the fix

POD-722 and POD-723 hand-roll dirty tracking for sessions and issues respectively. Accepted as
interim by human decision on 2026-07-17 ("for now we do it that way"). It is the right call for the
two hot types and the wrong shape for the platform: the third and fourth object type will each pay
the same implementation cost, and each hand-rolled dirty set is an independent opportunity to get
invalidation wrong.

---

## Entry 2 — What POD-308 still owes Entry 1: the call-site assessment

**Status:** closed for the mismatch; two residues named below, one of them filed as a bug.
**Measured at:** `96eb63cc` on `issue/279-integration`, 2026-08-03. Every count in this entry is
scoped to `--include=*.ts` over `apps/` and `packages/` at that SHA.

### Why this entry exists

Entry 1's status was carried by a symbol count — `allWire` in 12 files, `publishIssues` in 7. A count
answers "where do I look"; it never answers "is this still owed", and an unconverted locator is
exactly what goes stale, because the next reader finds a number with no argument attached and cannot
tell whether it was checked or merely counted. This entry converts it by reading the sites.

### The verdict: the mismatch is gone

`apps/server/src/gateway/wire-feed-edge.ts` is the cutover, and it is landed, not planned. Its
header states the shape directly: the two-path world — an ordered `metadataDelta` pipe alongside
`funnel.publishComputed`, the full-list snapshot fan-out that each feature drove by rebuilding its
own list — is over. "That second path is gone." Everything leaves through one `publish()`, the
Authority's feed framed once. Legacy clients still receive full-list snapshots, but as a
*translation* of the feed built in `legacy-wire-v1-adapter.ts`, and the distinction is load-bearing:
a translation of one pipeline cannot disagree with the feed, because it is the feed folded up.

That is precisely Entry 1's "correct by construction" clause, and the normalized half exists to
match it: `issueProjection` as its own kind (POD-796, ADR 4 D7.1), `issueDep` as a separate kind
because an edge belongs to two issues (POD-822, D7.2), and `blocked` / `ready` / `dependents` /
`displayRef` joined replica-side (D7.3). Normalized entities, a delta feed, derived joins performed
client-side — the entry asked for exactly these three and all three are present.

The measured trigger is gone too. `apps/server/src/relay.test.ts:642` records that the attach path
no longer touches `allWire` at all (POD-1203), and the test comment is explicit that this is a
*stronger* form of the old resilience rather than a weaker test: the world a connection is served
comes from the feed, whose rows were serialized at their write, so a projection that throws today
cannot reach the bootstrap. The `clientCount`-on-attach case that cost p50 711 ms / p90 1.4 s no
longer runs the code that cost it.

### The three-way split of the locator

**`allWire` — 12 files.** Five are tests (`relay.test.ts`, `issues.ledger.test.ts`,
`wire-memo.test.ts`, `relay.bind-storm.test.ts`, `git-state-service.test.ts`). Two mention it only in
prose — `modules/machines/service.ts:153` and `gateway/wire-feed-edge.ts:12`, the latter naming it as
part of what it *replaced*. That leaves five production files that actually call it: `relay.ts:1050`,
`modules/issues/publish.ts`, and `modules/issues/service/{core,index,crud}.ts`. The twelve collapses
to five, and those five are the legacy-translation tail, not a second pipeline.

**`publishIssues` — 7 files.** Two are the real thing (`modules/issues/publish.ts:145` defines it,
`relay.ts:1050` calls it). Three are comment or perf-counter mentions (`service/core.ts:127`,
`packages/protocol/src/perf.ts:101`, `wire-memo.test.ts`). **Two are a homonym**:
`modules/sessions/publication/broadcast.ts` and `modules/sessions/session-wiring.ts` declare
`publishIssues(sessions: SessionMeta[])`, which publishes no issues at all — it emits
`session.listChanged` on the bus. Same name, opposite direction, unrelated to Entry 1. Seven
collapses to two.

**The memo.** The POD-723 `wireCache` in `service/core.ts` is still present and still labelled
"Interim until POD-308 deletes the snapshot fan-out". It now memoizes only the legacy translation,
so it is bounded by the adapter's expiry rather than by the rewrite.

### Residue 1 — naming, not debt

`publishIssues(sessions: SessionMeta[])` on the session side is a misnomer that survived the
cutover, and it is the kind that costs a reader real time: it makes a symbol census over-report
Entry 1's footprint by 2 files, and it reads as issue-publishing at every call site. Renaming it to
what it does — announce a session-list change — is a vocabulary cleanup, which is what the parent
epic POD-1546 (7.A Vocabulary and residue cleanup) is for. No behaviour change, no urgency.

### Residue 2 — a dead dirty gate, filed as POD-1573

Reading these sites turned up a defect that is real and separable, so per this ledger's rule it is
filed rather than fixed here: **POD-1573 (Bug: issue projection generation never bumped)**.

`modules/sessions/lifecycle.ts:233` declares `private issueProjectionGeneration = 0` and
`session-wiring.ts:128` reads it as the broadcast coordinator's `issueGeneration()` port. Nothing
writes it — a whole-tree grep for the identifier returns exactly those two hits. Since
`lastIssueGeneration` starts at `-1`, `issueChanged` is true on the first broadcast and false for the
rest of the process lifetime, so `session.listChanged` is emitted at most once per server. That
starves both its consumers: the issue-list republish tail at `relay.ts:1049`, and the declared
durable reaction `issues.session-derived-projection` in `composition/reactions.ts:122`. It is not a
regression from the recent lifecycle split — the same three lines (declare, compare, assign-to-last,
never increment) are present at `7755f496^`.

It belongs in this ledger for one reason beyond the bug itself: **the perf counters make it look
healthy.** A permanently-taken skip branch records `sessionsBroadcast.publishIssuesSkipped`, which is
byte-for-byte indistinguishable from a dirty check that is working perfectly. An instrument that
cannot say NO reports success. The correct-by-construction form is that a generation gate should not
be expressible without a writer — or, failing that, that a gate which has never observed a change
should be loud rather than quiet.
