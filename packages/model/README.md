# @podium/model

**L0 — the zero-dependency root. Every entity defined once.**

This package imports **nothing but `zod`**: no workspace package, no node builtin, no IO.
That constraint is the whole point — it is what makes this the *one authoritative definition
site* rather than one more layer that happens to hold some types. If something you want to put
here needs a workspace import, it does not belong here.

Absorbed `@podium/domain` wholesale at POD-299 (Phase 1, POD-288); `@podium/domain` and the
`@podium/runtime/git.ts` re-export shim were **deleted**, not deprecated.

## Layout

The directory layout is a decision, recorded here because the rest of Phase 1 lands on top of
it. Reserved directories are intentionally empty and carry a README naming their owner.

| Directory | Holds | Status |
|---|---|---|
| `clock.ts` | `Instant` (epoch ms) — **the** clock representation — plus `toInstant`/`toIso`/`requireInstant`, the adapters at the edges | live |
| `exhaustive.ts` | `assertUnreachable` — the totality guard every closed union in this package ends with | live |
| `ids/` | Branded ID types (`IssueId`, `SessionId`, `MachineId`, … and POD-1075's `UserId`) | **reserved** — POD-360…363 |
| `entities/` | Entity aggregates and their field vocabularies (`issue-color` today) | live, grows |
| `identity/` | Identity of things and of principals: git remote / repo identity, worktree identity, session identity — and POD-1075's `User` / account aggregate | live, grows |
| `authz/` | The authorization policy: roles, the closed scope set, and `authorize` — the single enforcement function | live |
| `predicates/` | Pure derivations over entity shapes: issue stage/defer, snooze, sort keys, machine + handoff selection, session priority, mobile entry | live |
| `annotations/` | The ownership matrix as data: one annotated row per replicated class, the closed column vocabulary, the Authority-only arbitration reads, and the totality test (see its README) | live — POD-304 |
| `provenance/` | `ReplicatedEnvelope<T>` — how a row reached THIS replica. Deliberately not the home for owner / visibility / attribution | live — POD-304 |
| `user-state/` | The per-user state family keyed `(userId, entityId)`: `readAt`, snooze, pins, tab order, preferences | **reserved** — POD-1076 |

Nothing outside this package imports a subpath — the `exports` map publishes only `.` — so this
layout can be rearranged without touching a consumer.

## Four invariants that later work depends on

Recorded because POD-1075 (user accounts / identity) and POD-1076 (per-user state) extend this
package rather than replacing it, per `docs/multi-user-readiness.md` (human decisions,
2026-07-29).

1. **The authz scope set is closed, and totality is compiler-enforced.** `IssueScope` is a
   discriminated union; every match on `kind` ends in `default: assertUnreachable(scope)`, and
   `authz/issue-authz.test.ts` adds a `Record<IssueScope['kind'], …>` as a second checked site.
   Adding the owner-scoped and grant-scoped members of §3.2 is therefore a **compile error until
   each site declares its rule** — never a silent default, which would fail *open* and invert
   the default-closed rule of §3.1.1. `authorize()` stays the single enforcement function, and
   `Capability.actorSessionId` is preserved as the ACTOR seam of §3.1.3 A3's attribution pair.

2. **One clock representation.** Every time-dependent predicate takes an `Instant` (epoch ms).
   The twin ISO-string / epoch-ms predicate families over `deferUntil` collapsed into one
   (`isIssueDeferred`; the `isIssueSnoozed` spelling is gone). Stored and wire values stay the
   strings they already are, so the wire is byte-identical — which is what makes POD-1076's move
   of `snoozedUntil` into `user-state/` a **re-key**, not a re-representation. See `clock.ts` for
   why epoch won: lexicographic ISO comparison is wrong for the bare `YYYY-MM-DD` dates the
   defer presets store and for any offset-bearing spelling.

3. **Multi-user is not multi-tenancy.** Nothing here carries an `instance_id` or an
   instance-partition concept; ADR 1 D5 is unaffected. `annotations/matrix.test.ts` now
   asserts this over the serialized matrix, so a future row cannot smuggle a tenant
   discriminator in as a column value.

4. **An unclassified entity class is PRIVATE, and that holds without the test** (POD-304).
   `visibilityClassOf` resolves an unknown class to `personal` — a total function with no
   "unclassified" outcome a caller could mishandle and no thrown error a caller could catch
   and treat as permissive. The totality test is the other half, not a substitute: it fails
   the build for the missing declaration. Forgetting to classify must fail toward privacy
   (ADR 9 D4), and a default that fails open is the failure mode that rule exists to
   prevent. The arbitration reads deliberately do the OPPOSITE and throw: visibility has a
   safe default, a merge policy does not.

## Build orchestration

The reference case for the convention (POD-715, [spec:SP-3b58]): a `typecheck` script using
`tsgo --noEmit`, a `@podium/source` export condition so consumers resolve source in dev and
tests, and a `typecheck` task in `turbo.json`. As the L0 root with no `dependsOn` edges of its
own, it is also the reference case for whichever ADR-8 resolution style wins (source-conditions
vs. project references).
