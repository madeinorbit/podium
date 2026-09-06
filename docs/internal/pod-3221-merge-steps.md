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

**Blocked until POD-3467 widens the port.** `followUpAfterCommit` became `async` (POD-3468's
`b64c1b5ae`), and `PostCommitEffectPort = (step: () => void, label: string) => void`. A `=> void`
contextual type accepts a promise-returning arrow silently, so this compiles, the promise FLOATS, and
the `PostCommitError` the change exists to surface becomes an unhandled rejection. POD-3467 must first
widen the port to `void | Promise<void>` and await at `authority.ts:555` (its sole consumer), with a
test that fails when the await is deleted. Only then is this edit sound.
