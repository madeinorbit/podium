# `fields/` — the shared field schemas (POD-365, 1.4b)

**One vocabulary, not one universal record.** ADR 4 D1 is explicit that the canonical durable
aggregate, live state, the storage row and the wire/read projections stay **distinct types**.
What they share is their *field groups*, and this directory is where those groups are defined —
exactly once — so that the 24 session-shaped and 17 issue-shaped representations POD-364 counted
(`docs/rearch-field-schema-inventory.md` §2, §3) can `Pick` from them instead of restating them.

| File | Holds | Composed by |
|---|---|---|
| `ownership.ts` | `Ownership` — `owner` + `visibility` (ADR 9 D2/D3, ADR 4 Am1 D9.2) | Every owned aggregate |
| `attribution.ts` | `ActorRef` and `Attribution` — the actor / on-behalf-of **pair** (ADR 9 D5 A3, ADR 4 Am1 D9.3) | Every attributing site |
| `per-user-key.ts` | `PerUserKey` — the `(userId, entityId)` fragment (ADR 4 Am1 D10.2) | POD-1076's per-user family |
| `op-stream.ts` | `OpStreamDocument` — materialized value + bounded op tail (ADR 1 Am1 D12 part 3) | The three reserved `op-stream` members |
| `session.ts` | The 15 session field schemas of inventory §6.2 | `aggregates/session.ts`, POD-366's projections |
| `issue.ts` | The 13 issue field schemas of inventory §6.3 | `aggregates/issue.ts`, POD-367's projections |

## Four rules that this directory only stays useful by keeping

### 1. Nothing here is a projection

A projection function — `toWire`, `toStorage`, `SessionMeta`, `IssueWire` — belongs to the
representation that owns it (POD-366 for sessions, POD-367 for issues, POD-643 for the handoff
manifest). This directory defines *what a field means*; it never decides *which representation
carries it*. If a change here would need to know about a specific wire shape, it is in the wrong
file.

### 2. Leave room for principal-dependent projection — do not build it

Under the scoped feed (POD-1077 / ADR 2 Am1) a wire projection may legitimately **differ per
principal**: a field suppressed because the reader may not see it, or a graph edge that crosses a
visibility boundary rendered as an opaque reference (ADR 9 §3 O2). None of that is built here, and
none of it is Phase 1's to decide.

What this directory owes that future is only that it does not make it **inexpressible**. Concretely:

- A field group is a plain `z.object`, so a scoped projection composes it with `.pick()`,
  `.omit()` or `.partial()`. No group is sealed, positional, or defined as an intersection that
  cannot be narrowed.
- **Requiredness is declared at R1, where the fact is always true — never inherited as a
  constraint on every projection.** `Ownership.owner` is required *on the canonical aggregate*
  because an owned row always has an owner; that says nothing about whether a scoped R4 shape must
  carry it. A projection that must omit a field omits it, and the golden fixtures for that
  projection are the gate — not this file.
- `ActorRef` is a discriminated union rather than a nullable string, so "an actor you may not
  resolve" can later be added as a member (a redacted arm) instead of overloading `null`, which
  already means "no on-behalf-of" on the other half of the pair.

### 3. Per-user state is not a field here

`readAt`, snooze, pins, tab order, sidebar/tab layout and personal preference keys are **absent
from the canonical aggregates by construction** (ADR 4 Am1 D10, inventory §7). They are their own
R1 family keyed `(userId, entityId)`, owned by POD-1076, and they compose `PerUserKey` — the one
key fragment — over POD-301's `userEntityKey` / `parseUserEntityKey` helpers in `../ids/keys.ts`.

A singleton left behind "for now" is the expensive mistake: it is later a table migration **plus**
a wire change **plus** a replica migration, on the one part of the system this rewrite promises
never to redo.

### 4. No serializable effective capability, anywhere

There is deliberately no schema in this directory for "what this principal may do". Effective
rights are an agent's own scope intersected with its human's **current** rights, resolved live at
every apply (ADR 9 D5 A1, on ADR 3 D8's existing re-authorization path). A snapshotted capability
would survive the revocation of the person it was derived from, with no reaper to trigger — the
privilege leak ADR 9 D5 A1 rejects by name. `Attribution` records *who caused a write*; it never
records *what they were allowed to do*.
