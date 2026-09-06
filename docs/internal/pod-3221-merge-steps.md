# POD-3221 — relay.ts changes queued for merge time

`relay.ts` is single-owner (B1) for the duration of the flip. Workers who need a change there stop at
the file edge and send the exact edit; the coordinator applies it when the producing branch merges.
Each entry records WHY it cannot simply be made now.

## 1. RuntimeEventGate boot hydrate — from POD-3469

Insert in `SessionRegistry.hydrate`, immediately after `await this.modules.sessions.loadFromStore()`
(`relay.ts:497`, inside `private async hydrate()` at 488):

    await this.modules.sessions.runtimeEventGate.hydrateReady(this.modules.sessions.sessions.keys())

Arguments are the hydrated in-memory `SessionId` keys. It MUST precede serving or any daemon runtime
frame. `ready(sessionId)` is synchronous for the daemon router, which is the point: the gate is a
rule 51 case 2 resolution, moving the await to boot so the router never yields.

**Blocked until POD-3469 merges.** `runtimeEventGate.hydrateReady` does not exist on B1's branch —
verified by grep across `apps/server/src` at B1 tip. Handing this to B1 now would have it call a
method that does not exist, breaking its typecheck for a reason it could not diagnose.

## 2. Ledger postCommit adapter — from POD-3467

At `relay.ts:894`:

    postCommit: (step, label) => afterCommit(step, label),
    →
    postCommit: (step, label) => followUpAfterCommit(step, label),

**Superseded in form, still queued.** POD-3467 has since gone further than the widening I asked for,
and its design is better: it RENAMED the port and typed the STEP async rather than the port's return —

    - export type PostCommitEffectPort   = (step: () => void, label: string) => void
    + export type PostCommitFollowUpPort = (step: () => Promise<void>, label: string) => void

with `authority.ts:556` now passing `async () => …`. That is correct: the adapter registers and the
executor's drain awaits under the writer lease, so the port itself rightly still returns `void`. My
proposed `void | Promise<void>` return widening would have made the port's own return the async thing,
which is not what needed to be async.

### THREE-WAY HAZARD TO RESOLVE DELIBERATELY AT MERGE

`followUpAfterCommit` differs across the branches and the difference is invisible to each author:

| branch | `followUpAfterCommit` | `PostCommit*Port` |
|---|---|---|
| B1 `3263` | sync, `: void` | `PostCommitEffectPort` |
| integration | sync, `: void` | `PostCommitEffectPort` |
| POD-3467 | sync, `: void` | `PostCommitFollowUpPort`, step async |
| POD-3468 | **`async`, `: Promise<void>`** | `PostCommitEffectPort` |

POD-3468 made it async for its own caller in `crud.ts` (awaiting the no-span path); POD-3467 needs an
async STEP registered through a still-void adapter. Both are individually correct. Composed carelessly
they reproduce the floating-promise defect: an `async` `followUpAfterCommit` returning `Promise<void>`
into a `=> void` adapter slot compiles clean and drops the rejection.

Resolve at merge by taking POD-3467's port rename and async-step typing, then deciding explicitly
whether `followUpAfterCommit` must await inline (POD-3468's no-span path) or only register (the
in-span path) — and pin whichever with a test that fails when the await is removed. Do not let a
textual merge pick.
