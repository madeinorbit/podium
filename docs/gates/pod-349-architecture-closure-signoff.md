# POD-349 — Phase 1.5 architecture closure: SIGN-OFF

**VERDICT: PASSED. Measured on `00479906`, 2026-07-31.**

Sign-off was delegated to the coordinator by the human ("no human decisions — complete the
rewrite autonomously"). Recorded here rather than as a stage flip, because a gate that closes
without a record is a gate nobody can audit later.

## AC1 — both children closed; the ADR pack merged and referenced

**HOLDS.** POD-359 and POD-351 are both `done`. The pack is present in `docs/adr/`: the
original ADRs plus ADR 9 and the four amendments carrying the 2026-07-29 multi-user
decisions — `0001-…-amendment-1`, `0001-…-amendment-2`, `0002-sync-protocol-amendment-1`,
`0003-command-security-amendment-1`, `0004-representation-policy-amendment-1`,
`0007-plane-inventory-amendment-1`. Each base ADR carries its "Amended by" pointer.

## AC2 — walking skeleton shipped and verified; abstractions signed off

**HOLDS.** POD-351 is `done`. The abstractions the wider sign-off subject names — the
principal shape with the actor / on-behalf-of attribution pair, the five visibility classes
with default-closed classification, owner/visibility/grants as normative matrix columns, and
the scoped-feed primitive — are all present and, more to the point, **conformance-covered**
rather than merely declared. See AC3's ordering check.

## AC3 — tracker reconciliation (the load-bearing criterion)

**HOLDS, with one defect found and filed.**

The seven new multi-user issues are wired into the phases the brief names, verified by
their own numbering: 1.8 POD-1075 and 1.9 POD-1076 under Phase 1; **2.8 POD-1077** under
Phase 2; 3.12 POD-1080 under Phase 3; 4.10 POD-1078 and 4.11 POD-1079 under Phase 4; 5.7
POD-1081 under Phase 5.

**Defect found: #1280.** POD-387's "DRIFT REFRESH" prose says the handoff surface has SEVEN
frames while its own binding section and ADR 7 D7 say EIGHT. Found by POD-1074's session
during its reconciliation pass and filed with attribution. It is a contradiction *inside a
single issue* and it survived every prior sweep — which is precisely why this criterion is
the load-bearing one. It does not hold the gate: the ADR and the binding section agree, so
the stale sentence is the outlier, and it is now owned.

## The hard ordering constraint (brief §3)

*The watermarked scoped feed and scoped bootstrap must land in the kernel BEFORE the POD-308
wire cutover — adding a per-client filter without watermarks is a protocol break, not an
optimisation.*

**SATISFIED IN SUBSTANCE. Stated precisely, because one instrument here was vacuous.**

- The constraint IS written into ADR 2's amendment (12 references to the cutover ordering).
- Both POD-1077 and POD-308 are `done`, and the tree is green.
- The three conformance cases the brief demands be gate conditions rather than follow-ups
  are present and substantive in `packages/sync/src/conformance/` and
  `authority.scoped.test.ts`: *a revoke anchors an EVICT at the seq of the change that
  caused it*; *a grant anchors a RE-ADMITTING UPSERT carrying the current value*; *a
  principal NOT in the audience sees the grant seq as a watermark, not an evict*; *a
  re-grant re-admits the same entity — eviction is REVERSIBLE*.

> **WHAT I COULD NOT PROVE, recorded rather than glossed.** I tried to establish the LANDING
> ORDER of POD-1077 and POD-308 from commit messages and could not: the oldest commit
> mentioning each is the SAME commit (`9c5b15bd`, the ADR-pack landing, which names both
> issues). My first ordering check therefore compared a commit with itself and reported
> "constraint HELD" — trivially true and worth nothing. The merge-commit search collapsed the
> same way. So the ordering is asserted from the PROPERTY, not the history: the watermark
> machinery exists in the kernel with the named conformance cases green, which is the state
> the ordering constraint existed to produce. If someone later needs the order itself, it
> must come from the issue activity log, not from `git log --grep`.

## AC4 — the visibility machinery is not inert (brief §4)

**HOLDS.** The default is private, so the machinery carries the normal path from day one.
The conformance cases above exercise grant, revoke, re-grant, watermark-not-evict and
per-user-state narrowing — not a mechanism shipped inert with coverage promised later.

## Not claimed

Phase 2's **live upgrade rehearsal** is not executed; it needs a VPS, deploy credentials and
a physical phone, and is carved out as **#1281**. POD-310's verification half passed
separately (see its own gate doc §7).
