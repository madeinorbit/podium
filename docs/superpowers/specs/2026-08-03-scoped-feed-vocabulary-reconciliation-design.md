# One vocabulary for principal and scoped change

POD-1196 design spec. Measured at integration tip `9eea645d`.

## The problem

POD-1077 (kernel scoped feed, `packages/sync`) and POD-387 (plane-port
interfaces, `packages/protocol/src/planes`) landed overlapping vocabulary.
POD-1077 designed its seam before POD-387's mail arrived and did not find the
already-committed `planes` modules. Neither side is wrong in isolation and both
are green.

This is not a rename. Two of the overlaps encode genuine layering decisions that
have to be preserved through the merge, and one of them is already costing
correctness.

## What the divergence already costs

`apps/server/src/relay.ts:572` hand-writes a `VisibilityResolver` that converts a
protocol `Principal` into a kernel `FeedPrincipal` and delegates to
`mayDeliver`. Its first line is:

```ts
if (principal.kind !== 'user') return false
```

Every agent principal is refused, because protocol's `AgentPrincipal` has nowhere
to put a `DelegatedScope`. `apps/server/src/modules/derived-family.ts:388`
performs the same mapping a second time. The two vocabularies are already bridged
by hand, lossily, in two places.

## Census, as of `9eea645d`

Counting **reads**, not occurrences. Build output (`packages/protocol/dist`) is
not a consumer.

| Symbol | Home | Real consumers |
| --- | --- | --- |
| `Principal`, `VisibilityResolver`, `principalRoutingId` | protocol | all 3 plane ports, `routing.ts`, `relay.ts`, `presence-routing.ts` — live |
| `FeedPrincipal`, `principalIdOf`, `FeedVisibilityPolicy` | sync | publisher, scoping, ledger, `gateway/feed-serving.ts` — live |
| `ScopedChange` | sync `authority/change-lifecycle.ts` | ledger, scoping, publisher, funnel, feed-serving — live |
| `ScopedChange` | protocol `planes/scoped-feed.ts` | **zero importers**; referenced only inside `ScopedDeltaFrame` in its own file |
| `ScopedDeltaFrame` | protocol | `control-port.ts` only — and `new ControlPort(` outside tests is **zero** |
| `isWatermarkFrame`, `acceptsAtCursor`, `coalesceCertifiedRanges` | protocol | tests only |

## Decisions

### D1 — One principal type; the kernel resolves delegation behind a port

Protocol's `Principal` becomes the single principal type. `FeedPrincipal` is
deleted.

The kernel gains one port:

```ts
export interface DelegationScopePort {
  /** What this delegation was minted for (ADR 9 D5 A2). */
  scopeOf(delegation: DelegationRef): DelegatedScope
}
```

`DelegatedScope` stays in `packages/sync`, keyed by `DelegationRef`. It is
consulted inside `GrantEdgeVisibilityPolicy.underDelegation()` on **every**
`decide()`, never cached at admission — ADR 9 D5 A1 requires live resolution,
because a frozen copy survives the revocation of the person who issued it.

This preserves both invariants that were in tension:

- The plane ports still never inspect `capability` or `delegation`. Only the
  kernel policy — which *is* the policy layer — resolves the reference.
- The kernel keeps its A2 intersection, and gains a real answer for agents where
  `relay.ts` currently returns `false`.

The server adapter reads POD-1075's delegation records; the conformance fixture
supplies the test implementation.

### D2 — Reason codes go private; `canSee` is the only outward seam

`VisibilityResolver.canSee` (protocol) is the single outward-facing visibility
seam. `FeedVisibilityPolicy.mayDeliver` is deleted as a duplicate of it.

`decide()` and `VisibilityReason` stop being exported from `@podium/sync`'s
index and become internal to the authority. They remain reachable by tests,
gates and operator telemetry, and unreachable from anything a client observes.

Both layers keep the property they were built for. ADR 7 Am1 D14.3 wanted refusal
and nonexistence indistinguishable to a caller — `canSee` still returns a bare
boolean. POD-1077 wanted `unclassified` distinguishable from
`personal-not-granted` so that a default-closed backstop cannot answer the same
thing for "deliberately personal" and "never classified" — `decide()` still does,
inside the authority.

The kernel ships a small adapter implementing protocol's `VisibilityResolver`,
whose `canSee` is `decide(...).visible`. That adapter replaces the hand-written
bridges in `relay.ts` and `derived-family.ts`.

### D3 — One routing id, with the agent arm corrected

`principalIdOf` is deleted in favour of protocol's `principalRoutingId`.

**This cannot be a straight swap.** `feed-serving.ts:240` and `:358` already pipe
`principalIdOf`'s output into protocol's `principalRoutingKeyFromId`, so the two
are meant to be one function — but `publisher.ts:282-287` uses that id as the
**audience-equality test**: connections whose id matches receive the same slice.
Protocol keys an agent by `agentIdentity` alone. Unifying naively would give two
agent connections with the same identity but *different* delegations one shared
slice, and the narrower-scoped agent would receive the broader one's rows.

So protocol's agent arm becomes:

```ts
case 'agent':
  return `agent:${p.agentIdentity}:${p.delegation}`
```

This is consistent with protocol's own stated rule — membership is per principal,
and ADR 3 Am1 makes the delegation part of the agent principal. Two tabs of one
delegated agent remain one member; two differently-scoped agents were never one
principal.

### D4 — `ScopedChange` stays in the kernel

The kernel's `ScopedChange` (lifecycle phase 4) keeps the name; it has every real
consumer. Protocol's is deleted outright — it has zero importers and its only
use is inside `ScopedDeltaFrame`, which goes under D5. No rename is needed and no
symbol survives, so the name collision ends by subtraction.

### D5 — Delete protocol's frame and watermark symbols

Five symbols are deleted from `packages/protocol/src/planes/scoped-feed.ts`:
`ScopedChange`, `ScopedDeltaFrame`, `isWatermarkFrame`, `acceptsAtCursor` and
`coalesceCertifiedRanges`.

**The file itself stays, and most of it is well used.** Measured external
references at `9eea645d`, excluding the file itself and `dist`:

| Surviving symbol | External refs |
| --- | --- |
| `FeedCursor` | 24 |
| `RescopeFrame` | 15 |
| `ScopedChangeOp` | 7 |
| `FeedEpochField` | 7 |
| `ScopedFeedServerMessage` | 5 |
| `CHANGE_OP_SEMANTICS` | 3 |
| `SCOPED_CHANGE_OPS` | 2 |
| `RESCOPE_PRESERVES_OUTBOX` | 2 |

`ChangeOpSemantics` has no external reference but stays: it is the `satisfies`
constraint on `CHANGE_OP_SEMANTICS`, which has three. This is an excision of one
family from a live module, not the removal of a module.

**One consequence the plan must resolve.** `control-port.ts` has three members
typed against `ScopedDeltaFrame` — `publishEntity`, `sendCertified` and
`assertCertified`. Nothing constructs a `ControlPort` outside its own tests, so
they could be deleted, but the port is POD-387's deliverable and removing it is
outside this issue. The minimal choice, and the one this spec takes, is to retype
those three against the **shipped** frame shape from `messages/feed.ts` rather
than delete them — which is also what makes the port describe the wire that
actually exists. If retyping turns out to require reshaping the port's contract,
that is a finding to file, not to absorb here.

The count is not the argument. The argument is that **the shipped wire considered
this design and declined it.** `packages/protocol/src/messages/feed.ts` states it
in its own header:

> A watermark is that frame with `changes: []`, which is why there is no
> watermark message type here: there is nothing separate to forget to send.

and

> The certified-range fields, declared ONCE and spread into every frame.

`coalesceCertifiedRanges` is superseded by those range fields riding every frame.
The publisher's `watermarkThrough` slot is the shipped expression of D13.2, and a
stronger one: its lower bound is always `fromSeq`, so a non-contiguous certified
range is unrepresentable rather than merely rejected.

**`isWatermarkFrame` is not merely redundant — it is wrong.** The shipped
predicate is `messages/feed.ts`'s `isFeedWatermark`:

```ts
// planes/scoped-feed.ts  (deleted)
frame.changes.length === 0

// messages/feed.ts       (shipped)
frame.changes.length === 0 && frame.seq > frame.fromSeq
```

The shipped one documents why: *"An EMPTY range (`fromSeq === seq`) is not a
watermark: it certifies nothing and moves no cursor."* The `planes` version
returns `true` for exactly that case. It is a wrong answer under a plausible
name, which is the strongest reason to remove it rather than relocate it.

On `acceptsAtCursor`: it is the *replica's* acceptance rule, not the publisher's,
so it is the one symbol with an argument for survival. It still goes. If the
replica genuinely lacks that rule, it belongs beside `messages/feed.ts` or in the
replica itself, written against the shipped frame shape — not preserved in an
unwired plane port whose frame type the wire declined. That is filed as its own
issue, not folded in, and no dead copy is kept as insurance.

## Out of scope

- **POD-425's "two subscription registries is a defect".** Checked:
  `FeedPublisher.connections` is a per-connection state map holding cursors and
  send queues, not a subscription registry. Under D3 its key becomes protocol's
  routing id, which is what a registry would key on anyway. Recorded as
  checked-and-clear; not merged.
- **`packages/commands/src/mail/ceiling.ts`'s `HumanCeiling`** — a fourth
  near-copy of the `canSee` shape, but behind a different package boundary and
  narrowed to two entity kinds. Filed separately rather than widening this issue.
- **The `Attribution` projections** — filed as POD-1540 with a `discovered-from`
  edge. Not one of the five overlaps this issue names, and unlike them that split
  is documented on both sides.

## Testing

This is a vocabulary merge that must not move behaviour. The existing scoped
suites (`authority.scoped.test.ts`, `publisher.scoped.test.ts`,
`conformance/binding.test.ts`, `control-port.test.ts`) already pin it.

Genuinely new coverage, both for behaviour that is currently unreachable:

1. **The agent arm of the delegation port.** `relay.ts` returns `false` for every
   agent today, so no test can currently observe an agent's scoped slice. Needs a
   case where the human may read an entity and the agent was not spawned for it,
   asserting `outside-delegated-scope`.
2. **D3's audience separation.** Two connections, same `agentIdentity`, different
   `DelegationRef`, different scopes — assert they receive different slices. This
   is the case a naive `principalIdOf` → `principalRoutingId` swap would break,
   and nothing today would catch it.

`control-port.test.ts` loses the assertions covering the four deleted symbols.
The D13.2/D13.3 rules they expressed are *not* dropped: they are already pinned
against the publisher's slot and against `messages/feed.ts`'s
`isFeedWatermark`. The plan must name which existing test covers each rule the
deleted assertions were carrying, so removal is subtraction of duplicates rather
than of coverage.

## Verification

Per the Phase 6 exit-gate standard — a guard must be **seen to refuse**, not
merely to exist.

- Baseline at `9eea645d`, naming the config: `vitest.unit.config.ts` over
  `packages/model` + `client-core` + `protocol` + `sync` = 198 files / 3000 tests
  rc=0; `typecheck` 22/22 rc=0.
- The two new tests above must be shown red before the change and green after —
  the delegation one is currently unreachable, so it must be demonstrated to fail
  against today's `relay.ts` behaviour.
- **Deletion completeness:** confirm `packages/protocol/dist` no longer exports
  the four symbols, not only that the source is gone. This repo has been bitten
  by "git says gone, disk-scanning gates disagree".
- Run `audit:rearch`: it must still read "32 items, 152 sites remaining (baseline
  exact)", or move **down** if these sites were counted. Report which.
- `lint:boundaries` must stay at "OK, 6 allowlisted, 0 new" — D1 moves a type
  across a package boundary and this is the gate that would notice.

## Risk

The single largest risk is D3. A naive symbol swap is silent, compiles, passes
every existing test, and broadens an agent's audience — a privacy regression that
looks like a cleanup. The mitigation is that D3's test lands *before* the swap.
