# Scoped-Feed Vocabulary Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each of principal, visibility resolution, scoped change and certified frame exactly one home across `packages/protocol/src/planes` and `packages/sync`, so a later reader cannot be unsure which one decides.

**Architecture:** Protocol keeps the wire and routing vocabulary; the kernel keeps the decision. Protocol's `Principal` becomes the single principal type and `FeedPrincipal` is deleted; the kernel resolves delegated scope live behind a new narrow port; the kernel's richer `decide()` goes private behind protocol's `VisibilityResolver.canSee` as the one outward seam; and five symbols expressing a design the shipped wire declined are deleted.

**Tech Stack:** TypeScript, Zod, Vitest (`bun --bun vitest`), Turbo, Biome.

**Spec:** `docs/superpowers/specs/2026-08-03-scoped-feed-vocabulary-reconciliation-design.md`

## Global Constraints

- **Base:** integration tip `dac14c84`. Rebase before the final run; never merge `main`, never merge a sibling branch.
- **`bun install` in this worktree before any lane.** The linker is hoisted; without it `@podium/*` resolves to the main checkout and every lane measures the wrong tree. Confirm `ls node_modules/@podium` lists packages.
- **Never `git stash`** — the stash is repo-wide across live worktrees.
- **Commit with `git commit -F <file>`**, never `-m` with backticks: commit messages run through bash and a backticked word has executed here before.
- **Baseline at `dac14c84`, config named with every count:** `lint:boundaries` OK **0 allowlisted, 0 new**; `audit:rearch` "32 items, **130** sites remaining (baseline exact)"; `typecheck` rc=0 22/22; `apps/server/src` = 270 files / 3850 passed rc=0.
- **`bun run typecheck` is cached — trust a cache hit.** Never force a recompute; use `--uncached-because="<reason>"` if you genuinely distrust it.
- **Never `bunx biome` or `bun run format`** — they reformat hundreds of unrelated files. Explicit paths only.
- **Every guard must be seen to REFUSE.** "The check exists" is not acceptance. Plant the failing case, watch the *named* check go red on the *measured quantity*, then revert from a byte-verified snapshot (md5 match plus a grep for the probe string returning rc=1). Never reverse-replace. A substring rename is not a mutation; a cast is not a mutation.
- **`ScopedChange` is two different types.** Never sweep it by bare name — scope every rename by the compiler's error list, not by grep.

---

## File Structure

**Protocol (`packages/protocol/src/planes/`)**
- `principal.ts` — `Principal` and its four arms, `principalRoutingId`, `VisibilityResolver`. Gains the delegation suffix on the agent arm (Task 2).
- `scoped-feed.ts` — loses five symbols (Task 1), keeps `FeedCursor`, `RescopeFrame`, `ScopedChangeOp`, `FeedEpochField`, `ScopedFeedServerMessage`, `CHANGE_OP_SEMANTICS`, `SCOPED_CHANGE_OPS`, `RESCOPE_PRESERVES_OUTBOX`, `ChangeOpSemantics`.
- `control-port.ts` — three members retyped against the shipped `FeedDeltaMessage` (Task 1).

**Kernel (`packages/sync/src/`)**
- `feed/visibility.ts` — loses `FeedPrincipal`, `principalIdOf`, `mayDeliver`; gains `DelegationScopePort` and the `VisibilityResolver` adapter; `decide`/`VisibilityReason` become internal (Tasks 3–5).
- `feed/publisher.ts`, `authority/*.ts`, `ledger.ts` — retyped onto `Principal` (Task 4).
- `index.ts` — stops exporting `FeedPrincipal`, `principalIdOf`, `VisibilityReason`, `VisibilityDecision`, `mayDeliver` (Tasks 4–5).

**Server (`apps/server/src/`)**
- `relay.ts`, `modules/derived-family.ts` — hand-written bridges deleted, replaced by the kernel's adapter (Task 4).
- `gateway/client-principal.ts`, `gateway/feed-serving.ts`, `modules/perf/principal.ts` — retyped (Task 4).

---

### Task 1: Delete the five symbols the shipped wire declined (D4, D5)

Independent of every other task. Do it first: it shrinks the surface the later tasks move.

**Files:**
- Modify: `packages/protocol/src/planes/scoped-feed.ts` (delete `ScopedChange`, `ScopedDeltaFrame`, `isWatermarkFrame`, `acceptsAtCursor`, `coalesceCertifiedRanges`)
- Modify: `packages/protocol/src/planes/control-port.ts` (retype `publishEntity`, `sendCertified`, `assertCertified`)
- Test: `packages/protocol/src/planes/control-port.test.ts`

**Interfaces:**
- Consumes: `FeedDeltaMessage` and `CertifiedRangeFields` from `packages/protocol/src/messages/feed.ts` — the shipped frame.
- Produces: nothing new. `ControlPort.publishEntity(ref, frame: FeedDeltaMessage)`, `sendCertified(target, frame: FeedDeltaMessage)`, `assertCertified(frame: FeedDeltaMessage): void`.

- [ ] **Step 1: Record what the deleted assertions were covering**

Before deleting anything, list every assertion in `control-port.test.ts` that names one of the five symbols, and for each one name the test elsewhere that covers the same rule. The rules are D13.2 (watermark coalescing) and D13.3 (never merge across visible changes).

Run:
```bash
grep -n "isWatermarkFrame\|acceptsAtCursor\|coalesceCertifiedRanges\|ScopedDeltaFrame" \
  packages/protocol/src/planes/control-port.test.ts
grep -rn "isFeedWatermark\|watermarkThrough" --include=*.ts packages/protocol/src packages/sync/src | grep -v "/dist/"
```

Write the mapping into the commit message. **If a rule has no surviving cover, stop and report it** — this task is the subtraction of duplicates, not of coverage.

- [ ] **Step 2: Delete the five symbols**

In `packages/protocol/src/planes/scoped-feed.ts`, remove the `ScopedChange`, `ScopedDeltaFrame`, `isWatermarkFrame`, `acceptsAtCursor` and `coalesceCertifiedRanges` declarations and their doc comments. Leave everything else, including `ChangeOpSemantics` (it is the `satisfies` constraint on `CHANGE_OP_SEMANTICS`).

Also delete the now-unused `changeRowArm` import if the compiler reports it.

- [ ] **Step 3: Retype the control port against the shipped frame**

In `packages/protocol/src/planes/control-port.ts`, replace the import and the three signatures:

```ts
import type { FeedDeltaMessage } from '../messages/feed'
import type { RescopeFrame } from './scoped-feed'
```

```ts
  publishEntity(ref: EntityRef, frame: FeedDeltaMessage): RouteOutcome
  sendCertified(target: PlaneTarget, frame: FeedDeltaMessage): RouteOutcome
```

and the router's element type becomes `PlaneRouter<FeedDeltaMessage | RescopeFrame>`.

`assertCertified` keeps its behaviour; only its parameter type changes:

```ts
export function assertCertified(frame: FeedDeltaMessage): void {
```

If `assertCertified`'s body reads a field that `FeedDeltaMessage` spells differently, adjust the field reads — do not reintroduce the old shape. If the port's contract turns out to need reshaping beyond field names, **stop and file it**; that is outside this issue.

- [ ] **Step 4: Update the port's tests**

In `control-port.test.ts`, delete the assertions covering the four deleted helpers and retype the `frame(...)` factory to build a `FeedDeltaMessage`. Keep every assertion about routing, delivery policy and refusal — those are the port's own behaviour and are not being deleted.

- [ ] **Step 5: Typecheck and run the protocol lane**

```bash
bun run typecheck
bun --bun vitest run --config vitest.unit.config.ts packages/protocol
```
Expected: typecheck rc=0 22/22; protocol suite rc=0.

- [ ] **Step 6: Prove the deletion is complete on disk, not just in git**

Source alone is not enough — this repo has been bitten by "git says gone, disk-scanning gates disagree".

```bash
bun run build
for s in ScopedDeltaFrame isWatermarkFrame acceptsAtCursor coalesceCertifiedRanges; do
  echo -n "$s in dist: "
  grep -c "\b$s\b" packages/protocol/dist/index.d.ts 2>/dev/null || echo 0
done
```
Expected: `0` for all four. A non-zero count means a stale build output, not a passing deletion.

Note `ScopedChange` is deliberately excluded from that loop: the kernel's `ScopedChange` is re-exported through `@podium/sync` and will legitimately appear in other `dist` files. Check protocol's `dist` for it specifically:
```bash
grep -c "ScopedChange\b" packages/protocol/dist/index.d.ts
```
Expected: matches only `ScopedChangeOp` occurrences; no bare `ScopedChange` declaration.

- [ ] **Step 7: Report the ratchet**

```bash
bun run audit:rearch
```
Expected: "32 items, 130 sites remaining (baseline exact)" **or a lower site count**. Record which in the commit message. A count that went *up* is a finding — stop and report.

- [ ] **Step 8: Commit**

```bash
git add packages/protocol/src/planes/scoped-feed.ts packages/protocol/src/planes/control-port.ts packages/protocol/src/planes/control-port.test.ts
git commit -F /tmp/task1-msg.txt
```

---

### Task 2: Encode the delegation in the agent routing key (D3, key half)

**Files:**
- Modify: `packages/protocol/src/planes/principal.ts:153-164`
- Test: `packages/protocol/src/planes/routing.test.ts`

**Interfaces:**
- Consumes: `AgentPrincipal.delegation: DelegationRef` — already on the type.
- Produces: `principalRoutingId(p: Principal): string`, whose agent arm is now `agent:${agentIdentity}:${delegation}`. Task 5 asserts the slice consequence.

- [ ] **Step 1: Write the failing test**

Add to `packages/protocol/src/planes/routing.test.ts`:

```ts
it('routes two same-identity agents with different delegations to different keys', () => {
  // Reachable in production: agent-relay-delegation.ts sets agentIdentity from
  // resolveDelegationChain(ref).leaf, so ONE identity is reachable through more
  // than one delegation ref — with a different scope behind each.
  const base = {
    kind: 'agent' as const,
    agentIdentity: asAgentIdentityId('agent-7'),
    onBehalfOf: asUserId('alice'),
    device: asDeviceId('conn-1'),
    capability: asCapabilityRef('cap:a'),
  }
  const narrow = { ...base, delegation: asDelegationRef('del-narrow') }
  const broad = { ...base, delegation: asDelegationRef('del-broad') }

  expect(principalRoutingId(narrow)).not.toBe(principalRoutingId(broad))
})

it('keeps two connections of ONE delegated agent as one routing member', () => {
  // Two tabs are one member (D9.4). Same delegation, different device.
  const one = {
    kind: 'agent' as const,
    agentIdentity: asAgentIdentityId('agent-7'),
    onBehalfOf: asUserId('alice'),
    device: asDeviceId('conn-1'),
    capability: asCapabilityRef('cap:a'),
    delegation: asDelegationRef('del-1'),
  }
  const other = { ...one, device: asDeviceId('conn-2') }

  expect(principalRoutingId(one)).toBe(principalRoutingId(other))
})
```

Add `asDelegationRef` and `asCapabilityRef` to the file's imports from `./principal` if absent.

- [ ] **Step 2: Run it and watch the first test fail**

```bash
bun --bun vitest run --config vitest.unit.config.ts packages/protocol/src/planes/routing.test.ts
```
Expected: the *different delegations* test FAILS (both sides produce `agent:agent-7`); the *one member* test PASSES already.

Both outcomes matter. If the first test passes, the fixture is wrong — check that the two principals really differ only in `delegation`.

- [ ] **Step 3: Encode the delegation**

In `packages/protocol/src/planes/principal.ts`, change only the agent arm:

```ts
    case 'agent':
      // The delegation is part of the identity of an agent principal, not
      // metadata beside it: ONE agentIdentity is reachable through more than one
      // delegation ref (agent-relay-delegation.ts resolves the chain to a leaf),
      // and two refs mean two different scopes. A key that dropped it would give
      // a narrowly-scoped agent the audience of a broadly-scoped one — a silent
      // visibility widening that compiles and passes.
      return `agent:${p.agentIdentity}:${p.delegation}`
```

Update the function's doc comment, which currently says the identity "is the agent itself", to say it is the agent *under a given delegation*.

- [ ] **Step 4: Run the tests**

```bash
bun --bun vitest run --config vitest.unit.config.ts packages/protocol
```
Expected: both new tests PASS, whole protocol suite rc=0.

If `routing.test.ts:210`'s existing `expect(principalRoutingId(agent)).not.toBe(principalRoutingId(user('alice')))` still passes, good — it should be unaffected.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/planes/principal.ts packages/protocol/src/planes/routing.test.ts
git commit -F /tmp/task2-msg.txt
```

---

### Task 3: Introduce `DelegationScopePort` and move the policy onto `Principal` (D1, kernel half)

**Files:**
- Modify: `packages/sync/src/feed/visibility.ts`
- Test: `packages/sync/src/feed/visibility.delegation.test.ts` (create)

**Interfaces:**
- Consumes: `Principal`, `AgentPrincipal`, `DelegationRef` from `@podium/protocol`; `DelegatedScope`, `EntityRef`, `VisibilityStatePort` (existing, unchanged).
- Produces:
  - `interface DelegationScopePort { scopeOf(delegation: DelegationRef): DelegatedScope }`
  - `GrantEdgeVisibilityPolicy` constructor becomes `(state: VisibilityStatePort, delegations: DelegationScopePort)`.
  - `humanOf(principal: Principal): UserRef | null` — **now nullable**, because machine and system principals have no human.

- [ ] **Step 1: Write the failing test**

Create `packages/sync/src/feed/visibility.delegation.test.ts`:

```ts
import { asAgentIdentityId, asCapabilityRef, asDelegationRef, asDeviceId, asUserId } from '@podium/protocol'
import type { Principal } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { GrantEdgeVisibilityPolicy, entityKey } from './visibility'
import type { DelegationScopePort, EntityRef, VisibilityStatePort } from './visibility'

const REF: EntityRef = { entity: 'session', entityId: 's1' }

const state: VisibilityStatePort = {
  classOf: () => 'personal',
  mayRead: () => true,          // the HUMAN may read it
  keyedUserOf: () => null,
}

const agent = (delegation: string): Principal => ({
  kind: 'agent',
  agentIdentity: asAgentIdentityId('agent-7'),
  onBehalfOf: asUserId('alice'),
  device: asDeviceId('conn-1'),
  capability: asCapabilityRef('cap:a'),
  delegation: asDelegationRef(delegation),
})

describe('delegated scope is resolved live, through the port', () => {
  it('refuses an entity the human may read but the agent was not spawned for', () => {
    const delegations: DelegationScopePort = {
      scopeOf: () => ({ kind: 'entities', keys: new Set([entityKey('session', 'OTHER')]) }),
    }
    const policy = new GrantEdgeVisibilityPolicy(state, delegations)

    expect(policy.decide(agent('del-narrow'), REF)).toEqual({
      visible: false,
      reason: 'outside-delegated-scope',
    })
  })

  it('admits the same entity for a delegation whose scope contains it', () => {
    const delegations: DelegationScopePort = {
      scopeOf: () => ({ kind: 'entities', keys: new Set([entityKey('session', 's1')]) }),
    }
    const policy = new GrantEdgeVisibilityPolicy(state, delegations)

    expect(policy.decide(agent('del-broad'), REF)).toEqual({ visible: true, reason: 'granted' })
  })

  it('re-resolves on EVERY decide, never caching the scope (ADR 9 D5 A1)', () => {
    let calls = 0
    const delegations: DelegationScopePort = {
      scopeOf: () => {
        calls += 1
        return { kind: 'all' }
      },
    }
    const policy = new GrantEdgeVisibilityPolicy(state, delegations)

    policy.decide(agent('del-1'), REF)
    policy.decide(agent('del-1'), REF)

    expect(calls).toBe(2)
  })

  it('never consults the port for a user principal — there is no delegation', () => {
    let calls = 0
    const delegations: DelegationScopePort = {
      scopeOf: () => {
        calls += 1
        return { kind: 'all' }
      },
    }
    const policy = new GrantEdgeVisibilityPolicy(state, delegations)
    const user: Principal = {
      kind: 'user',
      user: asUserId('alice'),
      device: asDeviceId('conn-1'),
      capability: asCapabilityRef('cap:a'),
    }

    expect(policy.decide(user, REF)).toEqual({ visible: true, reason: 'granted' })
    expect(calls).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bun --bun vitest run --config vitest.unit.config.ts packages/sync/src/feed/visibility.delegation.test.ts
```
Expected: FAIL to compile — `DelegationScopePort` is not exported and the constructor takes one argument.

- [ ] **Step 3: Add the port and move the policy onto `Principal`**

In `packages/sync/src/feed/visibility.ts`:

```ts
import type { DelegationRef, Principal } from '@podium/protocol'
```

Add the port, with the constraint stated where it will be read:

```ts
/**
 * WHAT A DELEGATION WAS MINTED FOR — the A2 ceiling, supplied to the decision
 * (ADR 9 D5 A2).
 *
 * A PORT, and narrow on purpose: it reports what a scope IS, never what a scope
 * MAY SEE. The moment it decides, it has become a second visibility resolver
 * beside {@link GrantEdgeVisibilityPolicy} — which is the outcome this whole
 * reconciliation exists to prevent (`docs/multi-user-readiness.md` §3.2; POD-335
 * deleted two such surfaces).
 *
 * It exists at all because something must SUPPLY the scope to the decision, and
 * resolving it inline at each call site is how a second authorization surface
 * gets born. Consulted live on every evaluation: a scope cached at admission
 * survives the revocation of the delegation that issued it (D5 A1).
 */
export interface DelegationScopePort {
  scopeOf(delegation: DelegationRef): DelegatedScope
}
```

Replace `humanOf`, which must now express "no human":

```ts
/**
 * The human at the root of the chain, or `null` for a principal that has none.
 *
 * NULLABLE now that machine and system principals are representable (ADR 3 Am1
 * D14.2/D21 — a system job has NO user and is never assigned one). Returning a
 * placeholder user here would be the defaulting ADR 9 D8 S5 forbids.
 */
export const humanOf = (principal: Principal): UserRef | null => {
  switch (principal.kind) {
    case 'user':
      return principal.user
    case 'agent':
      return principal.onBehalfOf
    case 'machine':
    case 'system':
      return null
  }
}
```

Change the policy's constructor and `underDelegation`:

```ts
  constructor(
    private readonly state: VisibilityStatePort,
    private readonly delegations: DelegationScopePort,
  ) {}
```

In `decide`, handle the null human before the class rules that need one:

```ts
    const human = humanOf(principal)
    if (human === null) {
      // A machine or system principal has no human to hold a grant. It is not
      // refused for want of one — it is simply outside the grant model, and the
      // feed does not serve it. Default-closed (ADR 9 D4).
      return { visible: false, reason: 'personal-not-granted' }
    }
```

And `underDelegation` resolves through the port:

```ts
  private underDelegation(
    principal: Principal,
    ref: EntityRef,
    reason: VisibilityReason,
  ): VisibilityDecision {
    if (principal.kind !== 'agent') return { visible: true, reason }
    // LIVE, every time — never a field read off the principal and never cached.
    const scope = this.delegations.scopeOf(principal.delegation)
    if (scope.kind === 'all') return { visible: true, reason }
    return scope.keys.has(keyOfRef(ref))
      ? { visible: true, reason }
      : { visible: false, reason: 'outside-delegated-scope' }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun --bun vitest run --config vitest.unit.config.ts packages/sync/src/feed/visibility.delegation.test.ts
```
Expected: 4 passed.

- [ ] **Step 5: Prove the live-resolution guard can refuse**

The third test is the one that pins A1, so prove it fires. Snapshot first:

```bash
md5sum packages/sync/src/feed/visibility.ts > /tmp/vis.md5
cp packages/sync/src/feed/visibility.ts /tmp/visibility.pristine.ts
```

Mutate `underDelegation` to cache the scope on first use (a real behaviour change, not a rename):

```ts
    const scope = this.cachedScope ??= this.delegations.scopeOf(principal.delegation)
```

Run the test. Expected: the *re-resolves on EVERY decide* test goes RED with `expected 1 to be 2`. If it stays green, the assertion is not measuring resolution count — fix the test, not the code.

Revert from the byte-verified snapshot and confirm:
```bash
cp /tmp/visibility.pristine.ts packages/sync/src/feed/visibility.ts
md5sum -c /tmp/vis.md5
grep -c "cachedScope" packages/sync/src/feed/visibility.ts   # must be 0 (rc=1)
```

- [ ] **Step 6: Commit**

```bash
git add packages/sync/src/feed/visibility.ts packages/sync/src/feed/visibility.delegation.test.ts
git commit -F /tmp/task3-msg.txt
```

---

### Task 4: Delete `FeedPrincipal` and sweep every consumer (D1, sweep half)

The big one. 25 files reference `FeedPrincipal`.

**Files:**
- Modify: `packages/sync/src/feed/visibility.ts` (delete `FeedPrincipal`, `principalIdOf`, `DEVICE_GRADE_PRINCIPAL`'s type)
- Modify: `packages/sync/src/{index.ts,ledger.ts,feed/publisher.ts,feed/index.ts,authority/{authority,ports,scoping}.ts,conformance/authority.ts,outbox/records.ts}`
- Modify: `apps/server/src/{relay.ts,gateway/{client-principal,feed-serving}.ts,modules/{derived-family,funnel}.ts,modules/perf/{principal,commands}.ts}`
- Test: every `*.test.ts` the compiler names

**Interfaces:**
- Consumes: `Principal` from `@podium/protocol`; `DelegationScopePort` from Task 3.
- Produces: `Authority.changesSince(cursor, principal: Principal)`, `.bootstrap(principal: Principal)`, `.watermark(principal: Principal)`, `.subscribe(principal: Principal, subscriber)`; `FeedConnection.principal: Principal`; `feedPrincipalOf` deleted.

- [ ] **Step 1: Scope the sweep by the compiler, not by grep**

`ScopedChange` and `kind: 'user'` are homonyms across this tree — a name-based codemod here hit 67 files and was wrong in ~50 of them last time. Delete the type first and let `tsc` produce the work list:

In `packages/sync/src/feed/visibility.ts`, delete the `FeedPrincipal` type and the `principalIdOf` function. Retype `DEVICE_GRADE_PRINCIPAL`:

```ts
export const DEVICE_GRADE_PRINCIPAL: Principal = {
  kind: 'user',
  user: asUserId('device:shared-instance-password'),
  device: asDeviceId('device:shared-instance'),
  capability: asCapabilityRef('cap:device-grade'),
}
```

Then:
```bash
bun run typecheck --uncached-because="FeedPrincipal deleted; need the full error list as the work list"
```
Save the error list. **That list is the task scope.** Work it top-down; do not grep for `FeedPrincipal` to find work.

- [ ] **Step 2: Replace the type at every site the compiler named**

Mechanical: `FeedPrincipal` → `Principal`, imported from `@podium/protocol` rather than from `../feed/visibility`. In `packages/sync/src/conformance/authority.ts`, `ConformancePrincipal` is `export type ConformancePrincipal = FeedPrincipal` — retarget it to `Principal` rather than deleting it, so the conformance suite's own vocabulary is untouched.

Every construction site of the old two-arm shape needs the full arm. The user arm gains `device` and `capability`; the agent arm gains `device`, `capability`, and swaps `sessionId` for `agentIdentity` + `delegation`, and **drops `scope`** — the scope now comes from the port.

- [ ] **Step 3: Replace `principalIdOf` with `principalRoutingId`**

Every call site: import `principalRoutingId` from `@podium/protocol`. This is the swap Task 2 made safe and Task 5 pins.

In `apps/server/src/modules/perf/principal.ts`, the doc comment says *"`principalIdOf` spells an agent principal as `agent:<sessionId>`"*. That sentence is now wrong twice over — update it to `agent:<agentIdentity>:<delegation>` and keep the surrounding argument, which is unaffected (the digest is derived from whatever id it is handed).

**`PerfPrincipalRef.kind` is `'user' | 'agent'` but `Principal` has four arms.** Do not widen the wire type. Narrow at the perf site with an explicit exhaustive decision:

```ts
export const perfPrincipal = (principal: Principal): PerfPrincipalRef => {
  const id = principalRoutingId(principal)
  // machine and system principals do not appear on the perf-sampled paths, and
  // widening the WIRE type to admit them would put two kinds on a report that
  // has never carried them. Refused loudly rather than folded into 'user'.
  if (principal.kind !== 'user' && principal.kind !== 'agent') {
    throw new Error(`perfPrincipal: ${principal.kind} principals are not perf-sampled`)
  }
  ...
  return { digest, kind: principal.kind }
}
```

- [ ] **Step 4: Replace the two hand-written bridges with the kernel's adapter**

In `apps/server/src/relay.ts:572`, the whole `roomVisibility` object goes. It is the bridge this issue exists to delete, and its `if (principal.kind !== 'user') return false` is the agent-refusing defect. Replace it here with the inline form — Task 5 extracts this into the named `kernelVisibilityResolver` and deletes it from this file, so write it exactly like this to make that extraction a clean move:

```ts
const roomVisibility: VisibilityResolver = {
  canSee: (principal, ref) =>
    ref.kind === 'session' || ref.kind === 'issue'
      ? visibility.decide(principal, { entity: ref.kind, entityId: ref.id }).visible
      : false,
}
```

The `kind !== 'user'` arm is gone: an agent principal now carries a delegation the policy can resolve, which is the correctness half of this whole issue. The entity-kind narrowing stays — it is a genuine constraint of what rooms address, not a principal refusal.

In `apps/server/src/modules/derived-family.ts:388-392`, the `feedPrincipal` mapping goes the same way — `ctx.principal` is already a `Principal`.

In `apps/server/src/gateway/client-principal.ts`, `feedPrincipalOf` becomes the identity function and should be deleted, with call sites passing the `ClientPrincipal` through. Confirm `ClientPrincipal` is assignable to `Principal`; if it carries extra members that is fine, if it is missing `device` or `capability` then keep a narrow adapter and say so in the commit message.

- [ ] **Step 5: Typecheck until clean**

```bash
bun run typecheck
```
Expected: rc=0, 22/22. Iterate on the error list until empty. Do **not** silence anything with `@ts-nocheck` or a cast — a file-wide suppression over freshly-moved code has produced a false 22/22 green here before.

- [ ] **Step 6: Run the full affected lanes**

```bash
bun --bun vitest run --config vitest.unit.config.ts packages/model packages/client-core packages/protocol packages/sync
bun --bun vitest run --config vitest.unit.config.ts apps/server/src
```
Expected: both rc=0. `apps/server/src` baseline is 270 files / 3850 passed.

- [ ] **Step 7: Confirm no suppression crept in**

```bash
git diff --name-only dac14c84..HEAD | xargs grep -n "@ts-nocheck\|@ts-ignore\|@ts-expect-error" 2>/dev/null
```
Expected: no output, or only pre-existing lines you can point at in the base. A green quoted over a suppression is not a green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -F /tmp/task4-msg.txt
```

---

### Task 5: One outward seam, private reasons (D2), and the slice-separation guard (D3)

**Files:**
- Modify: `packages/sync/src/feed/visibility.ts` (delete `mayDeliver`, add the adapter)
- Modify: `packages/sync/src/index.ts` (stop exporting `VisibilityReason`, `VisibilityDecision`, `decide`)
- Modify: `apps/server/src/relay.ts`
- Test: `packages/sync/src/feed/publisher.scoped.test.ts`

**Interfaces:**
- Consumes: `VisibilityResolver` from `@podium/protocol`; `FeedVisibilityPolicy` from Task 3.
- Produces: `kernelVisibilityResolver(policy: FeedVisibilityPolicy): VisibilityResolver`.

- [ ] **Step 1: Add the adapter**

In `packages/sync/src/feed/visibility.ts`:

Add `import type { VisibilityResolver } from '@podium/protocol'` — `MetadataEntityKind` is already imported in this file.

```ts
/**
 * THE ONE OUTWARD-FACING SEAM (ADR 7 Am1 D14.3).
 *
 * `canSee` returns a bare boolean because refusal and nonexistence must be
 * indistinguishable to a caller — there is no reason code to leak. The kernel's
 * richer {@link VisibilityDecision} stays INSIDE the authority, where a test, a
 * gate and an operator's telemetry can still tell `unclassified` from
 * `personal-not-granted`. Both properties survive; neither layer gives one up.
 *
 * `=== true` is not defensive noise: ADR 9 D4 makes the port treat anything
 * other than an explicit `true` as "no", and writing it out is what keeps a
 * later refactor from returning a truthy non-boolean.
 */
export const kernelVisibilityResolver = (policy: FeedVisibilityPolicy): VisibilityResolver => ({
  canSee: (principal, entity) =>
    policy.decide(principal, {
      entity: entity.kind as MetadataEntityKind,
      entityId: entity.id,
    }).visible === true,
})
```

The `as MetadataEntityKind` cast is the one place this seam is lossy: protocol's `VisibilityResolver` types the entity kind as a bare `string` (it must, being L0), while the kernel narrows it. A kind the kernel cannot classify falls through to `classOf` returning `null` and is refused as `unclassified` — the default-closed path, which is the correct outcome for an unknown kind. Say so in a comment at the cast site.

- [ ] **Step 2: Delete `mayDeliver`**

Remove it from the `FeedVisibilityPolicy` interface and from both implementations. Let the compiler list the call sites and replace each with `decide(...).visible` inside the kernel, or with `canSee` at a package boundary.

- [ ] **Step 3: Make the reasons private**

In `packages/sync/src/index.ts`, remove `type VisibilityReason` and `type VisibilityDecision` from the export list. Keep `FeedVisibilityPolicy`, `GrantEdgeVisibilityPolicy`, `VisibilityStatePort`, `DelegationScopePort` — those are how a deployment supplies the policy.

`decide` stays on the interface (the authority calls it) but is no longer reachable with a named reason type from outside the package.

- [ ] **Step 4: Use the adapter in the relay**

`apps/server/src/relay.ts` now reads:

```ts
const presence = new PresenceRouting({
  subscriptions,
  clients: clientRegistry,
  visibility: kernelVisibilityResolver(visibility),
  now: this.now,
})
```

- [ ] **Step 5: Write the slice-separation test**

This is D3's acceptance and the reason Task 2 was not sufficient on its own. Add to `packages/sync/src/feed/publisher.scoped.test.ts`:

```ts
it('gives two same-identity agents with different delegations DIFFERENT slices', () => {
  // Not a key comparison: the leak is in the AUDIENCE FILTER, and a test that
  // compared two strings would stay green if the key changed while publishTo
  // did not.
  const narrow = agentPrincipal('agent-7', 'del-narrow')   // scoped to s1 only
  const broad = agentPrincipal('agent-7', 'del-broad')     // scoped to s1 and s2

  const a = publisher.connect(narrow, 0)
  const b = publisher.connect(broad, 0)

  publisher.publish(delivery([change(1, 's2')]))

  expect(rowsOf(a.drain())).toEqual([])              // s2 is outside narrow's scope
  expect(rowsOf(b.drain())).toEqual([{ seq: 1, entityId: 's2' }])
})
```

The two helpers this test uses do not exist yet — add them to the file's fixture block:

```ts
const agentPrincipal = (identity: string, delegation: string): Principal => ({
  kind: 'agent',
  agentIdentity: asAgentIdentityId(identity),
  onBehalfOf: asUserId('alice'),
  device: asDeviceId(`conn-${delegation}`),
  capability: asCapabilityRef('cap:a'),
  delegation: asDelegationRef(delegation),
})

/** The change rows a drained frame actually carried, for comparison by value. */
const rowsOf = (frames: readonly ServerFrame[]): { seq: number; entityId: string }[] =>
  frames
    .flatMap((f) => ('changes' in f ? f.changes : []))
    .map((c) => ({ seq: c.seq, entityId: c.entityId }))
```

Wire the fixture's `DelegationScopePort` so the two delegations resolve to different scopes:

```ts
const delegations: DelegationScopePort = {
  scopeOf: (ref) =>
    ref === 'del-broad'
      ? { kind: 'entities', keys: new Set([entityKey('session', 's1'), entityKey('session', 's2')]) }
      : { kind: 'entities', keys: new Set([entityKey('session', 's1')]) },
}
```

Both principals share `agentIdentity: 'agent-7'` — that is the whole point. If the test passes with two *different* identities it is proving nothing.

- [ ] **Step 6: Run it**

```bash
bun --bun vitest run --config vitest.unit.config.ts packages/sync
```
Expected: rc=0, the new test passes.

- [ ] **Step 7: PROVE THE GUARD CAN REFUSE — this is the acceptance, not the test's existence**

```bash
md5sum packages/protocol/src/planes/principal.ts > /tmp/prin.md5
cp packages/protocol/src/planes/principal.ts /tmp/principal.pristine.ts
```

Collapse the suffix in `principalRoutingId`'s agent arm back to `` `agent:${p.agentIdentity}` `` — a real byte change to the measured quantity, not a rename.

```bash
bun --bun vitest run --config vitest.unit.config.ts packages/sync packages/protocol
```
Expected: a **named** test goes RED — both the Task 2 key test and this slice test.

**If the slice test stays green while only the key test reddens, stop.** That means the test is asserting the key's shape rather than the slice's separation, and the guard is worthless. Fix the test so it fails, then re-run.

Revert and verify byte-for-byte:
```bash
cp /tmp/principal.pristine.ts packages/protocol/src/planes/principal.ts
md5sum -c /tmp/prin.md5
grep -c 'agent:\${p.agentIdentity}`' packages/protocol/src/planes/principal.ts   # expect rc=1
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -F /tmp/task5-msg.txt
```

---

### Task 6: Full gate run and report

**Files:** none modified — this task produces evidence.

- [ ] **Step 1: Rebase onto the current integration tip**

```bash
git fetch
git log --oneline -1 issue/279-integration
git rebase <that-sha>
bun install
ls node_modules/@podium | wc -l     # must be 25, not 0
git diff --stat <that-sha>..HEAD    # must be roughly the size of THIS work
```

Read the diffstat. A squash or rebase that produced hundreds of deletions has reverted intervening work — stop and re-derive.

- [ ] **Step 2: Run every gate, naming the config with each count**

```bash
bun run typecheck
bun run lint:boundaries
bun run audit:rearch
bun run audit:god-objects
bun run audit:router-mutations
bun --bun vitest run --config vitest.unit.config.ts packages/model packages/client-core packages/protocol packages/sync
bun --bun vitest run --config vitest.unit.config.ts apps/server/src
```

Expected against the `dac14c84` baseline: typecheck 22/22 rc=0; `lint:boundaries` OK 0 allowlisted 0 new; `audit:rearch` "32 items, 130 sites remaining" or lower; `apps/server/src` 270 files / 3850 passed.

Known-red and **not yours** — do not chase: POD-1532 (Playwright relay, ERR_CONNECTION_REFUSED), POD-1531 (`settings.set`), `lint:shadowing` in `packages/harness/src/registry.ts`, `audit:declared-consumers` in `packages/commands/src/contract.ts`.

- [ ] **Step 3: Confirm the deletion on disk one final time**

```bash
bun run build
grep -c "ScopedDeltaFrame\|isWatermarkFrame\|acceptsAtCursor\|coalesceCertifiedRanges" packages/protocol/dist/index.d.ts
```
Expected: 0.

- [ ] **Step 4: Report by mail with a quoted heredoc and literal SHAs**

Write the body to a file first, then send it — the quoted delimiter is what stops backticks executing and variables substituting, and a sibling's report arrived with an unsubstituted placeholder where its tip should have been.

```bash
cat > /tmp/pod1196-report.txt <<'EOF'
POD-1196 COMPLETE. Rebased onto <paste the literal SHA>.

GATES, config named with every count:
  typecheck rc=0, Tasks 22/22
  lint:boundaries OK, 0 allowlisted, 0 new
  audit:rearch "32 items, <N> sites remaining" (baseline 130 - state HELD or MOVED DOWN)
  vitest.unit.config.ts over model+client-core+protocol+sync = <F> files / <T> tests rc=0
  vitest.unit.config.ts over apps/server/src = <F> files / <T> tests rc=0 (baseline 270 / 3850)

DELETION PROVEN ON DISK: packages/protocol/dist/index.d.ts greps 0 for all four.

MUTATION EVIDENCE:
  Task 3 Step 5 - cached the delegated scope; NAMED test <name> went red
    (expected 1 to be 2). Reverted from snapshot: md5 match, grep rc=1.
  Task 5 Step 7 - collapsed the agent routing key to agent:${agentIdentity};
    NAMED tests <names> went red, INCLUDING the slice-separation test.
    Reverted from snapshot: md5 match, grep rc=1.

COVERAGE SUBTRACTED: <for each deleted control-port.test.ts assertion, the
surviving test that covers the same rule; or "none unaccounted for">.
EOF
podium issue mail send 1196 --body "$(cat /tmp/pod1196-report.txt)"
```

If the slice-separation test did **not** redden under Task 5's mutant, say so plainly — that is a finding about the guard, not a detail to omit.

- [ ] **Step 5: Move the issue to review and post an offer**

The Tray surfaces review-ready work only through the offer; the stage alone renders nothing.

```bash
podium issue update --id 1196 --stage review
podium offer --message "One vocabulary for principal and scoped change — ready to merge.
Protocol's Principal is now the single principal type, the kernel resolves delegated scope live behind a narrow port, and five symbols the shipped wire declined are gone. Fixes a live defect: the relay refused every agent principal.
Gates green against the dac14c84 baseline; both guards shown to refuse under mutation." \
  --action "Merge to integration::Merge POD-1196 into issue/279-integration." \
  --action-input "Send back::I want changes to POD-1196 before it merges. My feedback: " \
  --artifact docs/superpowers/specs/2026-08-03-scoped-feed-vocabulary-reconciliation-design.md
```

---

## Deferred / file separately, do not fold in

- **If the replica genuinely lacks a cursor-acceptance rule** after `acceptsAtCursor` is deleted: file it as its own issue with a `discovered-from` edge, naming where the rule should live (beside `messages/feed.ts` or in the replica). Do not keep a dead copy as insurance.
- **`packages/commands/src/mail/ceiling.ts`'s `HumanCeiling`** — a fourth near-copy of the `canSee` shape, behind a different package boundary.
- **POD-1540** (attribution census blind to TS projections) — already filed.
