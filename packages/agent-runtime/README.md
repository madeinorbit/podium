# `@podium/agent-runtime`

The **Agent Runtime contract**: the complete set of primitives every harness
session sits behind, whatever drives it.

Spec: [`docs/2026-08-07-agent-runtime-architecture.html`](../../docs/2026-08-07-agent-runtime-architecture.html)
§2 (driver families) and §3 (the primitive surface). Epic: POD-1761.

## What this is

Today a Podium agent session *is* an interactive CLI in a PTY, and every
programmatic interaction with it is a screen-scrape. This package is the
abstraction that ends that: one contract, three driver families
(`server` / `embedded` / `terminal`), and features that speak only the contract.

The inversion, in one sentence: **today the interactive process is the session
and headless is an emulation; in the target, the headless session object is the
session and the interactive terminal is one of several attachments to it.**

It is built in *front* of today's PTY stack rather than after it, so that
codex-terminal → codex-server becomes a driver swap no feature notices.

## The five rules

A primitive earns its place here only if all five hold.

1. **A primitive earns its place** only if a Podium feature consumes it, *and*
   every family can implement it or honestly decline it (`Declared<T>` —
   consumers branch and degrade; never a silent substitution).
2. **Guarantees are family-invariant; fidelity is declared.** `send()` means the
   same thing on every driver — what varies is the declared mechanism and
   confidence, never the semantics.
3. **Every write returns a receipt or a typed refusal.** Never fire-and-hope.
4. **Every read is causally enveloped** — `(at, provenance, cursor,
   observerGeneration, turnEpoch)`.
5. **Machine-transparent**: every primitive relays identically for local, remote
   and cloud machines.

## Two tiers

Rule 1 needs counter-pressure, because the surface audit's own history shows a
contract only ever grows.

- **Core** — lifecycle & identity, turns & control, interactions, observation,
  transcript, attach & lease, export/import. What a new driver MUST implement or
  explicitly decline, and everything the conformance corpus pins.
- **Extended** — draft, accounting, open-url, title, accent colour. Feature seams
  that never block a driver: **a driver shipping only the core is complete.**

New primitives default to extended and must argue their way into core. The
boundary is data, not prose — see [`src/tiers.ts`](src/tiers.ts), which is total
over the primitive names, so adding a primitive without tiering it is a compile
error.

## Entrypoints

| Import | For | Carries |
|---|---|---|
| `@podium/agent-runtime` | the machine host (`apps/daemon`) | the whole contract. **Host capability** — importing it means taking the capability to drive agent processes |
| `@podium/agent-runtime/metadata` | `apps/server`, clients | facts *about* the contract: taxonomy, tiers, permitted-failures table, wire schemas. No way to act on a host |
| `@podium/agent-runtime/testing` | driver authors (W3, W5, W6) | `runConformance` and the reference `FakeDriver` |

## Writing a driver

```ts
import { runConformance } from '@podium/agent-runtime/testing'

runConformance(() => ({ driver: makeMyDriver(deps), control: myControl }), {
  name: 'my-driver',
  family: 'terminal',
  exemptions: ['unverified-send', 'at-least-once-interactions'],
  reset: () => …,
  spec: () => …,
})
```

`exemptions` is a claim the corpus **checks**, not a set of skips it obeys: it
must equal your family's row in `PERMITTED_FAILURES` exactly. A driver claiming a
weakness its family does not permit fails, and so does one that quietly exhibits
a weakness it did not claim. That two-directional check is what lets the corpus
say something about the *hardest* driver instead of only the easiest.

## Where things live

The taxonomy (`DriverFamily`, `DriverId`, the three `*RuntimeSpec` shapes,
`SelectionContext`) is **defined in `@podium/harness`**, beside the
`AgentManifest.runtime` axis that declares it, and re-exported from
[`src/families.ts`](src/families.ts). The zod wire schemas are **defined in
`@podium/protocol`**'s `runtime` message family and re-exported from
[`src/schemas.ts`](src/schemas.ts), which asserts them structurally equal to the
TypeScript types so drift is a compile error.

Both placements are forced by dependency direction, and both exist so there is
exactly one definition site per vocabulary. Duplicating a vocabulary that already
exists is the epic's biggest long-term cost.
