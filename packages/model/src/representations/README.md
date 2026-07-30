# `representations/` — every retained representation, justified and classified (POD-368, 1.4e)

**ADR 4 D1: one vocabulary, not one universal record.** The end state of 1.4 is not "one shape".
The canonical durable aggregate (R1), live state (R2), the storage row (R3), the wire and read
projections (R4), the narrow ports (R5) and the portable export (R6) stay **distinct types** that
`Pick` from the same field groups in `../fields/`. So the guarantee 1.4 owes is different, and
harder: **every shape justified, classified, and composed.**

This directory is where the justification and the classification live. `registry.ts` carries one
entry per retained representation; `checks.ts` carries the default-closed totality checks over
them; `registry.test.ts` proves each check FIRES on planted bad input rather than merely passing on
good input.

## The documentation convention this issue sets

Every retained representation is documented **in model**, with:

| Field | What it must answer |
|---|---|
| `purpose` | What it is FOR — the job no other representation does. |
| `distinctSemantics` | **Why its semantics genuinely differ from the canonical aggregate.** Not "it is the wire shape": what fact it carries that R1 does not, or what fact it must drop. |
| `composition` | What it picks from the shared field schemas — or, if it does not, whether that is *declared legitimate* (with the coverage that enforces it) or *pending* (with a named owner and a named blocker). |
| `matrixRow` + `visibility` | Its ADR 9 D3 class, declared against an ADR 1 matrix row and checked against it. |

**Storage, live state, wire and the narrow ports each keep their own entry.** Folding them together
is exactly the "one universal record" ADR 4 D1 rejects.

> **A representation that cannot justify itself in that form is a drifted duplicate and must be
> DELETED, not documented.** That is not a slogan here: `BtwSessionInfo` and `StatusWire` could not
> answer `distinctSemantics`, so they are gone, and `DELETED_AS_DRIFTED_DUPLICATES` records them so
> that re-adding either reads as what it is.

## The four ownership-and-visibility audit items, and where each is enforced

Each is **default-closed by construction**: the check fires on planted bad code, and the planted
case is in the test file beside it. A totality check that only passes is not evidence.

| Item | Enforced by | Fires on |
|---|---|---|
| **1. Visibility-class totality** — every aggregate and every retained representation carries a declared ADR 9 D3 class; an undeclared one resolves to personal/private (D4) | `representationViolations` kinds `no-matrix-row` and `declaration-disagrees-with-matrix`, plus `visibilityClassOf`'s resolver as the semantic backstop | a fixture representation pointing at a nonexistent matrix row, and one declaring `deployment-substrate` for a `personal` row |
| **2. One definition of owner / visibility / the attribution pair** | The definitions themselves: `../fields/ownership.ts`, `../fields/attribution.ts`, and `VISIBILITY_CLASSES` in `../annotations/ownership.ts` from which the zod enum is derived. The two halves of the pair are audited **separately** — see below | `annotations/matrix.test.ts` and the compile-time pin in `fields/ownership.ts` |
| **3. No serializable effective-capability snapshot** (ADR 9 D5 A1) | `findCapabilitySnapshotKeys` (POD-643), now run over **every** schema-bearing entry rather than one | a planted `delegation.effectiveRights`, at any depth, under any wrapper |
| **4. No per-user state as a singleton field** (ADR 4 Am1 D10) | `PER_USER_STATE_KEYS` from `../aggregates/registry.ts`, run over every schema-bearing entry | a planted `readAt` |

**Item 2's two halves are audited separately, and that is deliberate.** A representation carrying
only the actor half looks correct until someone asks *whose work it was*. So `ActorRef` (four
branded principal kinds) and `onBehalfOf` (`UserId | null`, nullable and never optional) are
separate members with separate rules, and the capability audit in item 3 explicitly **exempts**
both: recording who caused a write is durable attribution, not a statement of what they were
allowed to do. An audit that conflated them would forbid the attribution the matrix requires.

## What this directory CANNOT measure, stated so nobody reads it as covered

- **It cannot grade composition.** Branding is compile-time, so a composed field swapped for a
  fresh `z.string()` is **byte-identical** and passes every golden fixture. Golden-green is not
  evidence of composition. The one assertion that does see it — the field IS the same zod
  **instance** (`toBe`, not `toEqual`) — is only available for the representations that are zod
  schemas inside this L0 package, and `registry.test.ts` makes it for those. For a TypeScript
  interface in `apps/*` no runtime instrument exists, which is why `composition` is **declared
  data** with a named owner for anything outstanding.
- **The schema-level items 3 and 4 reach only the schema-bearing entries.** Coverage of the other
  38 sites is the tree-level detector in `scripts/rearch-audit.ts`, which parses the declaration's
  key set out of the source. Both directions are closed there: an entity-shaped declaration missing
  from this registry counts as debt, and a registry entry whose site no longer exists counts too —
  so the registry cannot rot into a list of retired names.
- **The per-user item is a RATCHET, not a zero.** Five singletons ride the two wire projections
  today (`SessionMeta.readAt`/`snoozedUntil`, `IssueWire.readAt`/`tuckedAt`/`pinned`). They are
  **inherited** — 1.4 added none and blessed none — and POD-1076 owns re-keying them. The exact
  membership is pinned, so a sixth is a red rather than a slightly larger number.

## Adding a representation

1. Add the entry to `registry.ts`. If you cannot fill in `distinctSemantics` without restating
   `purpose`, you have found a drifted duplicate: delete it and add a
   `DELETED_AS_DRIFTED_DUPLICATES` row instead.
2. Bump the **literal** counts in `registry.test.ts`. They are literals on purpose — a suite whose
   parameter list is the thing under test cannot notice its own coverage shrinking.
3. Run `bun scripts/rearch-audit.ts --phase POD-302`. A new entity-shaped declaration that is not
   registered is counted debt; a registered site that does not exist is counted too.
