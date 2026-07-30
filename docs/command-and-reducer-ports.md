# The command contract and optimistic reducer ports

**Established by:** POD-351 (walking skeleton) · **Consumed by:** POD-372 (optimistic
overlay), POD-311 (Phase 3 — contracts and reducers populated broadly) ·
**Reviewed against:** ADR 3 (command contracts, principal, apply-time re-authorization),
ADR 4 (representation policy), ADR 9 (identity, ownership, sharing), and
`docs/multi-user-readiness.md`.

This is the reference POD-372 and POD-311 build on. It documents the two port shapes and
— more importantly — the decisions baked into them, because anything single-operator-
shaped here gets copied N times in Phase 3.

The worked example is `sessions.rename`:
`packages/commands/src/sessions/rename.ts` (contract + reducer),
`apps/server/src/modules/sessions/rename-target-path.ts` (handler, joined at the
composition root).

---

## 1. The command contract port

`CommandContract` in `packages/commands/src/contract.ts`. Every facet is **required**,
including the ones whose answer is "none": optionality is how a column silently stops
being filled in, and a missing `exposure` must mean *served nowhere* (ADR 3 D3 rule 1)
while a missing visibility class must mean *personal and private* (ADR 9 D4). Neither
default is reachable if a field can simply be absent.

`classificationErrors()` is the totality lint. It checks more than presence — that
`outbox` exposure implies an offline-eligible delivery class, that a `secret` resource
forces `online-sensitive`, that a caller-supplied target id has answered D20. Run it in
a test for every contract you add; it is the same function a registry-wide gate runs.

### 1.1 The principal is transport-derived, and there is no identity field on any input

Per ADR 3 D7 as amended (POD-1073) and ADR 9 D1, a principal is `(user, device,
capability)` derived from the **authenticated transport only**. A `client_session` is a
**device, not a person**.

**For POD-311:** never add `actor`, `onBehalfOf`, `userId`, `owner` or `capability` to a
command's input schema. Assert the strip against **parsed output**, not against the
absence of a field in the type — a type says what the author intended; parsed output
says what a hostile caller actually gets through. See the unforgeability tests in
`rename.test.ts`.

Do **not** reintroduce a singleton operator. `OPERATOR` (role `admin`, scope `all`) is
the transitional pre-accounts principal, and building a contract around it produces
ownership checks that are dead code on the one transport humans use.

### 1.2 Attribution is a pair, never a substitution

Every write records **actor** (which agent) and **on-behalf-of** (which human), both
stamped from the transport (readiness §3.1.3 A3). They are never collapsed: "which agent
did this" and "which human was it for" are two questions, and `nameSource`
([spec:SP-eb60]) and `humanQuestionAskedBy` are shipped features that depend on the
answer.

`wirePlacement` is a real decision, not boilerplate. Put the pair on the wire only when
something downstream **reads** it — `sessions.rename` does (the overlay needs the
authored actor kind to derive its arbitration for a queued write), `sessions.handoff`
does not and records it durably instead. A wire key nobody reads is a shape POD-308 has
to freeze for nothing.

`folded-into-address` is rejected by the lint: an address field doubling as the
accountability record is not a pair.

### 1.3 Apply-time re-authorization, never a snapshot

`delivery.applyTimeReauthorization` is required for every class, because "we
re-authorize" is only half an answer — the other half is what the sender is told.

An agent's effective rights are **its own scope intersected with its delegating human's
CURRENT rights**, resolved live at every apply including every outbox replay (readiness
§3.1.3 A1, ADR 3 D8/D16). Resolve the chain; do not read a stored capability. There is
deliberately nowhere in `OutboxRecord` to put one.

**The envelope order is fixed:** exposure → parse → **authorize** → idempotency →
handler. Authorization precedes idempotency so a replay whose grant was revoked is
refused rather than served from the dedup cache. When you test this, first assert the
mutation **is** in the applied table — otherwise a refusal is indistinguishable from a
dedup lookup that simply missed.

### 1.4 Consistent errors: an invisible target fails as a nonexistent one

`errorConsistency` (Amendment 1 D20.3 — the rule is general, not mail-specific). A write
to an entity the principal cannot see must fail **identically** to a write to an id that
does not exist, or the command becomes an existence oracle for enumerating other
people's ids.

Implement it as **one code path**, not two branches that happen to agree: the target
resolver returns `undefined` for both, and the envelope treats absent-target and denied
as the same answer. The one carve-out the pack grants is machine placement (readiness
§3.1.4 M5), where unauthorized must stay distinguishable from unreachable.

Note the asymmetry a rejection is allowed: a **rejection** is a policy outcome about an
entity the principal was already authorized to write, so it may carry a reason. A
**denial** is an authorization outcome and may not.

### 1.5 Visibility classes — and the one that must not be copied

`sessions.rename` writes **shared session state** (`personal` class: private to owner,
shareable). It stays one fact under expected-revision / single-writer arbitration.

**Per-user state is a different family and must not be modelled on this template.**
`readAt`, snooze, pins, tab order and preferences are keyed `(userId, entityId)`, are
never shared and are non-grantable — POD-1076's work, `policy.scope: 'self'`, and
`AuthTarget`'s `per-user-row` member exists precisely so a grant list has no way to
widen them. Copying a shared-state contract for a per-user field would make one user's
write visible as another's.

---

## 2. The optimistic reducer port

Declared by the kernel in `packages/sync/src/replica/overlay.ts`; implemented by
contracts in `packages/commands`. **It is declared in both packages on purpose** —
`packages/sync/src/replica/` is direction-locked (`check-boundaries` rule 10), because a
Replica that could reach the contract vocabulary could interpret commands, which is
arbitration. Consumer declares the port, provider implements it, an adapter joins them.

```ts
reduce(base: unknown | undefined, command: unknown, authored?: PendingAttribution): OptimisticEffect
```

`base` is the authoritative row from **the principal's slice**, or `undefined` when the
slice holds none — the only case in which a reducer may materialise a row.

### 2.1 The four effects

| Effect | Meaning | Renders as |
|---|---|---|
| `value` | The provisional row after this command | The optimistic value |
| `absent` | The command removes the row from the view | Nothing |
| `no-reducer` | **No client-derivable effect** | Pending, value unmoved |
| `rejected` | The authority is **predicted** to refuse, with a reason | Pending + the reject-and-rebase affordance |

`no-reducer` and `rejected` are distinct and the difference is load-bearing.
`no-reducer` means *I cannot derive the effect*; `rejected` means *I have derived that
there is no effect*. Collapsing them tells the user "in flight" about a write already
decided against — and under multi-user that is not an edge case: readiness §3.3 moves
reject-and-rebase (POD-316) from rare to **routine**.

**For POD-311:** when a command's effect depends on server-side state the client does
not hold, return `no-reducer`. Never fall back to a guess. A command whose effect
depends on server-side authorization has no client-derivable effect at all, and
inventing one is how an optimistic render becomes a lie. `sessions.rename` has no
`no-reducer` branch because every input to its decision is on the row — that is a fact
about rename, **not a template**.

### 2.2 Arbitration a reducer MAY predict, versus authorization it may NOT

The line is not a fine one:

- **Permitted** — a refusal derivable from the **authoritative row the principal was
  already given**, plus the command. `sessions.rename`: SP-eb60 makes a user-set name
  sovereign, so `base.nameSource === 'user'` decides an agent-authored rename with no
  principal, grant or capability consulted. The row said so; the reducer read it.
- **Forbidden** — anything derived from who the principal *is* or what it may *see*.
  That is the authority's job, live at every apply. A reducer has no principal argument,
  so this is unrepresentable rather than merely undone.

The failure modes are opposite in kind. A mispredicted **arbitration** is a cosmetic
flicker the authority corrects on the next frame. A mispredicted **authorization** would
render an effect the principal is not entitled to — the second untrusted authorization
surface ADR 2 Amendment 1 D12.7 forbids.

### 2.3 A prediction is advisory; the authority still decides

A `rejected` reducer has not rejected anything. The command stays queued, still drains,
and is still judged live at apply. A client that dropped a write on its own prediction
would be arbitrating — and would lose a write that a concurrent `rename('')` (which
clears `nameSource`) would have made perfectly applicable by the time it landed.

`authored` carries the pair the write was recorded under, forwarded verbatim from the
Outbox. **Read the actor's KIND, never its identity.** It exists so the rejection path
has a possible caller at all; without it an agent is indistinguishable from a human and
no arbitration can be predicted.

### 2.4 What the projection guarantees, so a reducer need not

`computeOverlay` (`overlay-projection.ts`) is pure and total:

- **A pending write never makes an entity visible.** An entity that has left the view
  (`evicted` — a revoked share — or `removed`) drops its overlay *before any reducer
  runs*, structurally, by returning ahead of the fold. There is no reducer output to
  leak.
- **The overlay is derived, never persisted** (ADR 4 D7), so a re-bootstrap cannot lose
  one and a repeated call cannot drift.
- **Retirement is exact, via envelope provenance** (`causationId`/`mutationId`, ADR 2
  D8) — never by value comparison, which would be the replica arbitrating.
- `OverlayRow.rejected` is a **required** list. A caller that surfaces rejections must
  not have to distinguish "none" from "this projection does not report them".

There is no `visibility` field and no `grants` field on `OverlayRow` — absent, not empty
and not defaulted. Under private-by-default a type that could express "optimistically
tenant-visible" would be one refactor away from rendering it.

---

## 3. Extensibility to scoped feeds — what is already shaped for it

POD-1077 adds per-principal filtering, watermarks and an `evict`/`rescope` op in Phase 2,
before the POD-308 cutover. These shapes do not need a wire break or a contract change to
accommodate it:

- `ExitKind` already distinguishes `evicted` (a revoked share — a removal from *your*
  view) from `removed` (a tombstone). `remove` could not have been reused: the replica
  would render it as a deletion, and ADR 2 D5 already warns that soft-delete and
  tombstone "look identical from a distance and are not".
- The overlay drops with the row on either exit, so a filter arriving later cannot
  re-expose revoked content through an optimistic render.
- The contract's `errorConsistency` already makes invisible-fails-as-nonexistent a
  declared facet rather than handler-local behaviour.

**What is NOT built, and must not be implied:** the read side. POD-351 enforces
write-side authorization only; the feed is still unscoped. A filter without a watermark
is a protocol break — every suppressed row without one is a permanent invisible gap that
heal-loops forever — which is why the watermark and the filter must land together.

> **UPDATE — POD-1077 landed the read side (2026-07-30).** The filter and the watermark
> arrived together, and inseparably: `ScopedDelivery` (`packages/sync/src/authority/scoping.ts`)
> carries the evaluated range `throughSeq` beside `changes`, so a filtered list cannot be
> delivered without the range it was filtered over. `Authority.subscribe` and
> `Authority.changesSince` both take a principal and have no unscoped overload; `evict` and
> `rescope` are DERIVED from the visibility policy rather than nameable by a caller.
> The bound on the claim is the AUTHENTICATOR, not the mechanism: `CLIENT_PRINCIPAL_GRADE`
> is still `device`, so the shipped composition roots name `DeviceGradeUnscopedPolicy` and
> say so. See that file's header and `bun run audit:scoped-feed`.
