# A stable installation is never offered an update — POD-2212, fixed

The acceptance drive (`pod-2157-acceptance-evidence.md`) proved the two halves
either side of this gap and named the gap between them. A stable-pinned host
**does** plan against the stable authority, and an installed instance **did**
fetch Podium's real production-signed `0.1.3`, verify it against the baked key
and swap in four seconds. What no stable installation ever got was the **offer**
— so nobody ever pressed the button this epic built.

This is what was wrong, what changed, and the live A/B that shows it.

## Two reads, both asking the development authority

**The offer has exactly one input.** `use-update-state.ts` derives the whole
offer from `server.target`, which is the target on `/version`; `describeUpdate`
with no target and no places answers `{state:'none'}`, which renders no panel at
all.

**`/version` asked `dev` twice.** The composition root wired it as

```ts
return (await devPublisher.publishTarget()) ?? registry.modules.updates.target()
```

and `UpdatesService.target(channel: UpdateChannel = 'dev')` defaults to `dev`.
On an installed host the publisher is disabled and the dev authority has nothing
to say, so `/version` carried no target at all. The drive measured the
disagreement inside one second: the operation resolved stable `0.1.3` while
`/version` advertised `dev+03a2892`.

**The fleet read model asked `dev` too.** POD-2100 scoped `fleetSnapshot` to the
dev authority with a stated reason — edge and stable machines carry their own
per-row targets, so comparing them against the *dev* target would invent behind
places the global action could not grant. The reason was right and **its premise
expired**: POD-2189 made that action's authority the HOST's own channel, and the
read model was not moved with it. On a stable fleet `targetVersion` was null and
`total`/`behind` were zero.

## The fix: both reads ask the question the action already asks

`UpdatesService.advertisedTarget(hostMachineId, publishedDevTarget?)` and
`fleetSnapshot` now resolve through `operationChannel(hostMachineId)` — the same
method `updates.start` and the boot adoption path use.

That is what keeps the invariant POD-2100 was protecting. **The set counted is
the set the mutation would grant**, because both ask one question. A machine
pinned elsewhere is still left out of these counts, still keeps its own per-row
target and action and the standing reconciliation, and still appears in
`allMachines`, which is where Settings renders it. The widening is exactly one
channel wide, and it invents no grantable place.

On a dev-following host nothing changes: the published development bundle keeps
its precedence, because it is HEAD read this request against a `dev` target set
when HEAD last moved.

## Was the read model widening actually required for the OFFER?

Asked by the coordinator, and worth answering with the case rather than an
opinion: **yes, for one fleet shape, and it is not an unusual one.**

Fixing `/version` alone is sufficient whenever the **coordinator itself** is
behind — `serverBehind` then produces a place and the panel has something to
show. It is **not** sufficient when the coordinator is current and only another
machine is behind. There the sole remaining place is the machines row, which
`describeUpdate` draws from `fleet.behind` alone; dev-scoped, that count is zero
on a stable fleet, `placesFor` returns nothing and the panel answers
`{state:'none'}` — no offer, for a wave `updates.start` would plan and grant in
full. That case is pinned by
`counts a behind stable machine when the coordinator itself is current`.

So POD-2191's question is answered here rather than deferred, and answered
narrowly: one channel, the operation's own, and nothing else widened.

## The live A/B, on this branch's code

One binary, one env, one channel pin; the only variable is the composition
root's target resolution. Both servers were stable-pinned
(`PODIUM_UPDATE_CHANNEL=stable`), on their own state roots, with the development
publisher **disabled by a dirty checkout** — which is the installed-host shape,
where the publisher half is absent and the fallback authority decides everything.

| | wiring | `/version` target |
|---|---|---|
| **A** — pre-fix (`c42a0d1ae`) | `publishTarget() ?? updates.target()` | **ABSENT** — the panel has nothing to offer |
| **B** — this branch | `advertisedTarget(hostMachineId, published)` | **`0.1.3`**, feed delivery, production signatures |

B's payload, abridged, and it is Podium's real published release — no manifest
was faked and no fetch was intercepted:

```
appVersion  dev+d12fe2e
target      version 0.1.3, artifacts.headless.delivery "feed"
            linux-x86_64 digest sha256-/c0MiQRAnatMNKIshru3mDqReOuXKFrzk1z5fRJwbVg=
```

That digest is byte-identical to the one the acceptance drive recorded, which is
the cross-check that this is the same authority the operation resolved.

`appVersion dev+d12fe2e` against `target 0.1.3` is `serverBehind`, which is the
place the panel needs. The offer exists.

## Gates

- **Ten tests**, six on `advertisedTarget` and four on the fleet read model, all
  **proven able to fire**: reverting each half to its dev-scoped form reds seven
  and then the fleet case, and restoring returns 118/118 green.
- **Scoped typecheck** `@podium/server`: 11/11, the server task a cache miss.
- **`test:related`** over the three changed source files, A/B'd against the fork
  point `c42a0d1ae` in a detached in-place checkout: **failure sets
  byte-identical**, 6 files / 7 tests failing on both sides, none of them naming
  a file this change touches (issues, superagent, oracle-tags, shipping). The
  branch run carries the 9 extra passing tests this change adds.
- No build outputs were produced; the disposable state roots were removed.
