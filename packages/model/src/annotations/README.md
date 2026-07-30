# `annotations/` — the ownership matrix as data (POD-304)

ADR 1's matrix, transcribed into types the compiler and a totality test can check. It
answers, per aggregate / field group: who commits truth, who may propose a write, which
person owns the row, who may see it, what happens when two writes race, what deletion
means, what happens offline, and whether any of it is secret.

| File | Holds |
|---|---|
| `ownership.ts` | The closed vocabulary — every column's value set, plus the default-closed resolvers (`visibilityClassOf`, `isTenantVisible`, `grantVerbsOf`) |
| `matrix.ts` | The DATA: one fully annotated row per class, transcribed from ADR 1 §§1–10 and Amendment 1 §3 (including its §11) |
| `arbitration.ts` | The conflict-rule reads — **Authority-side callers only** |
| `matrix.test.ts` | The totality test, and the planted unclassified fixture that proves the default fails closed |
| `arbitration-direction.test.ts` | The direction tripwire, with planted-violation probes so its zero is a measurement |

## Three things to know before editing a row

1. **Nothing here decides policy.** Every value is transcribed from the ADR pack. Where the
   pack leaves a question open, the row cites the canonical open item (ADR 9 §3's O1–O6)
   and says what is undecided — it never guesses. If you find yourself deciding, you are
   writing an ADR amendment, not a row.

2. **Widening needs an amendment; narrowing does not.** Amendment 1 D9.3's ratchet is
   one-way: per-feature policy may move a class *toward* privacy freely, but moving one
   into `deployment-substrate`, or widening a grant verb set, requires an ADR 1 amendment.
   `matrix.test.ts` pins the substrate set exhaustively for exactly this reason — a new
   member arriving there fails the test rather than passing review.

3. **The Replica never arbitrates.** Reading a row is fine anywhere: a UI that explains
   "this is admin-managed" is not arbitrating. Reading the *conflict rule* is not fine —
   that is `arbitration.ts`, and `arbitration-direction.test.ts` fails the build when
   non-Authority code imports it.

## What the totality test actually protects

The type has no optional column where one is required, so a new row cannot compile while
missing one. What a type cannot check is whether the VALUES contradict the ADR, and that is
most of the test: the field-LWW set is closed to Amendment 1 D10's members and each carries
its clock and invariant note; `op-stream` is reserved for D12's two named members and
implemented by nothing; per-user state is single-writer, non-grantable and owning-user-only
with every exception declared; the system-writer rule appears on every row a system
principal may write and on none that it may not.

And the default-closed rule is proven as **two** mechanisms, because neither substitutes for
the other: a planted class absent from the matrix fails the totality obligation, AND
`visibilityClassOf` still resolves it to `personal` with the test deleted.
