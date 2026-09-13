# PDM-351 — the golden wire sample that no longer parses

    packages/protocol/src/wire-golden.test.ts > golden wire fixtures > model > parses every sample
    AssertionError: expected [ Array(1) ] to deeply equal []
      + [ "OwnerAsAssigneeField/minimal: <root>: Expected string, received null" ]

**Decided before either file was touched.** The question the brief posed was binary — the
sample is stale, or the schema is wrong. The answer is **neither**. The schema is right, no
stale sample exists, and the defect is in the fixture *harness*, which has no way to write
down "absent" at the root of a case and coerces it to `null`.

---

## 1. Can an owner legitimately be `null` on the wire after A2?

**No. Never.** And the schema is right to refuse it.

`packages/model/src/fields/ownership.ts:159`

```ts
export const OwnerAsAssigneeField = Ownership.shape.owner.optional()
```

That is a `ZodOptional`, so it accepts `undefined` and **refuses `null`** — and the
distinction is the entire point of the field, stated in its own doc comment:

> Absent therefore means "this payload predates the projection", never "unassigned" — there
> is no such state. A reader that renders absence as *Unassigned* is showing an artefact of
> its own cache.

`.optional()` is there for **peer tolerance**, not for representable-none: `Ownership.owner`
is required on R1 and `issues.owner_user_id` is `NOT NULL`, so a current server always sends
a value. Absence is reserved for payloads a client cached before A2 landed.

Widening this to `.nullish()` would re-create, at the wire, exactly the second
representation of "no owner" that A2 (`68e8d23e0`, PDM-128) deleted from storage. `null`
would then be a wire value with no R1 preimage and no defined meaning, and the first reader
to render it as *Unassigned* would resurrect the state D2 forbids.

**The schema must not be edited.**

## 2. Is the sample stale?

**There is no sample to be stale.** This was the load-bearing mistake in the framing, and it
matters because "the sample is stale" leads straight to `bun run fixtures:wire:update`, which
is the forbidden move.

`parses every sample` does **not** read a committed file. It asserts over `buildCorpus()` —
the corpus generated fresh, in-process, on every run (`wire-golden.test.ts:110`). Only its
sibling `matches the committed golden file` reads the golden.

And the committed golden agrees: `packages/protocol/src/__fixtures__/golden/model.json` holds
**708 cases, zero of them `OwnerAsAssigneeField`, and zero `parseError` anywhere**. It was
last regenerated at `569c6a283` (2026-09-11), one day *before* `68e8d23e0` (2026-09-12)
introduced the field.

So regenerating would not have refreshed a stale sample. It would have **written a
`parseError` into the golden file for the first time** and pinned the defect as the expected
output — the suite's own header calls that out, and it is the purest specimen in the
false-green catalogue.

**The golden is evidence and must not be edited.**

## 3. What is actually wrong

The harness. Three steps, each individually reasonable, and the loss happens at the third.

1. `sampler.ts:282` — `minimal` mode on a `ZodOptional` returns the `ABSENT` sentinel. Correct:
   the minimal variant characterizes defaulting by *leaving the key out*.
2. `sampler.ts:315-318` — `sample()` maps `ABSENT` to `undefined`. Its own doc comment says:

   > Returns a plain JSON-able value (or `undefined` if the whole schema is optional at its
   > root, **which no message type is**).

   That parenthetical was true when it was written. `68e8d23e0` made it false.
3. `build.ts:64` — `const wire = JSON.parse(JSON.stringify(sampled ?? null))`.

   `?? null` is the defect. At the root there is no enclosing object to omit a key from, so
   "the peer sends nothing" gets written down as "the peer sends `null`" — a value the schema
   is correct to reject. `safeParse(null)` then fails with exactly the reported message.

`OwnerAsAssigneeField` is the **only** schema optional at its root anywhere on the covered
surface — one grep over `@podium/model`, one parse failure in the suite. A2 did not forget a
representable-none encoding; it introduced the first schema whose root can legitimately be
absent, and the fixture harness had never met one.

The irony is exact: a suite built to characterize the wire could not represent *absence*, so
it invented a value — the same failure class as the `assignee` column A2 deleted.

## 4. The fix

`build.ts` stops coercing. A root-level absent sample keeps its `wire` key *absent* — JSON
has no term for "no document", and `JSON.stringify` drops an `undefined` property, so the
golden records the case with no `wire` line, which is the honest rendering of what a peer
sends. `parseDiff(undefined, undefined)` is already empty by `Object.is`, and nothing goes
on the wire, so `encoded` is the empty string.

Neither `ownership.ts` nor any file under `__fixtures__/golden/` is touched.

## 5. What this does NOT fix

`model matches the committed golden file` stays red. It is red at the fork point too, for
unrelated reasons (A2's `assignee` → `assignmentRevision` / `inputRevision` reshape), and
repairing it means regenerating the golden — a separate, deliberate act that is not this
issue's. See the receipt for the full failing-name sets and for two *newly discovered*
neighbours the brief did not know about.
