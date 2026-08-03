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

**Status:** open, interim shipped (POD-722 / POD-723).
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
