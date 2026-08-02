# POD-404 — the provider binding, and the deletion of the last client god file

**Issue:** POD-404 (6.1e), closing step of the five-step client split (POD-328, Phase 6 / POD-293).
**Governing document:** `docs/multi-user-readiness.md` — the human decisions of 2026-07-29. §3.1
and §3.2 govern this work; where this file and that one differ, that one wins.

---

## 1. What was deleted, and where each part went

Both god files named in the acceptance criteria are gone.

| File | Lines at freeze | Status |
|---|---|---|
| `packages/terminal-client/src/connection.ts` | 1,400 | **Already deleted** by POD-400 (`09fe5d3f`, transport extraction). Verified: the path does not exist, and no import of it resolves anywhere in the tree. |
| `packages/client-core/src/engine/engine.ts` | 1,491 | **Deleted here.** |

`engine.ts` did not shrink — it was distributed. What is left is a coordinator whose job is to
construct its collaborators, run one lifecycle over them, and own the single state choke point they
all write through.

| Module | code / physical | Owns |
|---|---|---|
| `engine/runtime.ts` | 593 / 888 | Construction, `start`/`dispose`/`destroy`, the `apply` choke point, the reaction dispatch table, routing, the action wiring |
| `engine/optimism.ts` | 325 / 465 | The overlay ledger: queued / awaiting-truth / spawn inserts, retirement, recompute, enqueue baselines |
| `engine/reactions.ts` | 172 / 254 | The old `useEffect` table: worktree follow + fallback, view-state report, both mark-read timers |
| `engine/state.ts` | 115 / 166 | `EngineState`, `initialEngineState`, and the pure derivations over the slice |
| `engine/boot.ts` | 37 / 61 | The tRPC enrichments (repos, pins, tab orders, personal settings, replicated layout) |
| `react/provider.tsx` | 162 / 364 | The `useSyncExternalStore` binding **and** the principal lifecycle |
| `principal.ts` | 21 / 95 | `ClientPrincipal`, and the rule about where it may come from |

Physical lines exceed code lines by a wide margin in `runtime.ts` and `provider.tsx` because the
arguments for the lifecycle rules live next to the code that implements them. Measured with block
comments and comment-only lines removed.

**Deletion completeness.** `git` reporting a file gone is not the check that matters — disk-scanning
gates see build output. Verified on this tree: no file named `engine.ts`, `connection.ts`,
`engine.js` or `connection.js` exists anywhere outside `node_modules`; there are no `dist/`
directories; and the workspace typecheck (all 22 packages) resolves every import, which is what
rules out a residual reference travelling through a barrel file. The remaining textual mentions are
historical: superpowers plans that record how those files were built, and two deliberate provenance
comments (`scripts/audit-phase2-client.ts`, `apps/web/src/lib/webReplica.ts`) that describe a past
audit finding by its then-address.

---

## 2. The principal is a lifecycle, and the provider owns it

### 2.1 One runtime per principal

`ClientRuntime` is bound to one `ClientPrincipal` at construction and can never be re-pointed at
another. Sign-in, sign-out and user switch are not state changes — they destroy the runtime and
build a new one. `react/provider.tsx` is the only caller.

This is required rather than tidy, because each of the three carriers is principal-bound in a way no
state reset reaches:

- the **socket** carries a principal (its session cookie), so a frame already in flight belongs to
  the previous person;
- the **replica** carries a per-principal cursor and slice, and a cursor left behind by someone else
  makes a cold, empty slice look permanently caught up — the client would never ask for the rows it
  has never seen;
- the **outbox** carries queued writes that belong to one person and that are re-authorized at drain
  time under that person's rights (ADR 3 D8).

`destroy()` is irreversible and poisons the state choke point: after it, `apply()` refuses, so a
resolving tRPC promise, a spawn-confirm grace timer, a retained hub handler or a component still
holding one of the previous principal's action closures cannot publish anything. `dispose()` stays
reversible — it is the React effect's cleanup, and StrictMode's dev double-mount re-starts the same
runtime. The two are deliberately separate: the irreversible boundary must not be driven by React's
effect scheduling.

Teardown runs **before** the successor is constructed, so there is no window in which one device
holds two live principals. That ordering is asserted, not assumed (§4).

### 2.2 Fail closed before a principal exists

`principal === null` builds nothing at all. That is what makes "no replica hydration, no feed
subscription, no room subscription, no outbox drain before authentication" a structural property
rather than a list of guards someone must remember to extend. The subtree does not render; cold
start paints the principal's scoped slice or nothing.

### 2.3 Identity is supplied, never derived (ADR 3 D7, the client half)

The value that selects whose slice and whose storage namespace this client opens may only come from
an authenticated server answer — today `/auth/status`'s `userId`, which the server derives from the
session cookie. Not the URL, not storage, not a wire payload, not a name the user typed. The
provider exposes it to slices and components for **display** (`useCurrentPrincipal`) and nothing may
reach around it.

The replica factory takes the principal as an argument rather than closing over one, so every
composition root answers "whose store is this?" at call time. A root handed a principal it did not
open for **throws** — refusing is the fail-closed answer, and returning the store it happens to hold
is exactly the cross-principal adoption the namespace exists to prevent. Both platform roots now do
this: the web kernel assembly and the mobile SQLite root.

---

## 3. The two decisions this issue was asked to record

### 3.1 The selector cache: KEEP the hand-rolled one

POD-328 asked whether to replace `useStoreSelector`'s cache with the slice mechanism POD-330 will
land. **Decision: keep it**, and the reason is the multi-user one rather than a preference.

Slices now derive over a **partial world** (POD-401 / POD-1077). The principal's slice can *shrink*
when the authority evicts a row — a removal from your view that is not a deletion and moves no row's
revision — and can be *rebuilt* wholesale under a rescope. Any memoization keyed on entity identity,
on a dependency set of ids, or on a revision high-water mark is wrong under that, because all three
encode the assumption *"a referenced row I cannot see is merely late."* Under scoping it may be
permanently invisible, and a cache that waits for it paints a stale row forever.

This cache encodes none of that. Its key is **snapshot identity** (`c.snap === snap`) and nothing
else. The runtime publishes a fresh snapshot object on any slice change, so an evict, a rescope and
an ordinary update are indistinguishable to it — all three miss, all three re-derive from whatever
rows are visible now. It cannot hold a row past its visibility because it never remembers rows, only
the last answer for the last snapshot.

It is correct across the principal boundary for the same reason: a new principal is a new runtime
and therefore a new snapshot object, so the first read after a switch misses. Nothing here needs to
be *told* that a switch happened — and a cache that had to be told is a cache that will one day not
be.

**The bar for POD-330's replacement:** it must invalidate on shrink-without-revision-change, not
merely on update.

### 3.2 The theme is the only pre-auth storage read

`ThemeProvider` wraps `StoreProvider` because the first paint must not flash the wrong colours while
`/auth/status` is in flight, so the theme key is read before a principal exists. That is safe
precisely because it is cosmetic: it carries no identity, no cursor, no entity and no authored work,
so reading it cannot leak one person's data to another. Everything else a client persists lives
below the principal namespace and is unreadable until the provider has one.

POD-403 landed the forward half of this claim (every theme key routes to `pre-auth-theme`). POD-404
closes it, because the forward half cannot notice a **second** key joining the exception:

- over the whole known UI vocabulary, exactly the theme keys route to `pre-auth-theme`;
- `ui-state.ts` has exactly one unnamespaced **reader** as well as one unnamespaced writer.

---

## 4. The counterfactual record

Every assertion below was observed failing under a targeted mutation before being trusted. Mutations
were applied one at a time and reverted atomically (`git checkout --` on a committed tree, with a
grep-back confirming the revert).

The principal-boundary suite is deliberately **one case per carrier**. A single case stops at its
first failing expectation, so a broken teardown would turn one assertion red and hide whether the
other three ever measured anything.

`apps/web/src/app/store.provider-identity.test.tsx`, driven with all four carriers loaded at the
instant of the switch: a queued `layoutSet` in alice's namespace, a feed cursor at 42, an open
socket, and a mounted `useStoreSelector` holding `'git'`.

| # | Mutation | Cases that went red |
|---|---|---|
| M1 | the provider stops keying its rebuild on the principal (`!samePrincipal(...)` removed) | **all 6** — destroys the runtime; reconstructs the transport; replica/cursor; queued write; cached value; late callback |
| M2 | `destroy()` stops tearing down (`this.dispose()` removed) | **1** — *reconstructs the transport, and alice's socket is already down when bob's store opens*. Exactly one, which is the point: the other five stayed green because the React effect cleanup still disposes eventually. What M2 removes is the **ordering**, and only the ordering assertion sees it. |
| M3 | `destroy()` stops poisoning the choke point (`this.destroyed = true` removed) | **2** — *destroys the previous principal's runtime rather than re-rendering it* (`isDestroyed` false) and *publishes nothing from the previous principal's late callback* |
| M4 | the selector cache stops keying on snapshot identity (`c.snap === snap` removed) | **all 6**, at the shared setup precondition, measured: `alice's cached selection must actually differ from the default: expected 'superagent' to be 'git'`. That is the instrument's can-say-yes arm — with the cache broken, the warm-cache carrier never loads, so no case downstream of it is allowed to claim a pass. |

`packages/client-core/src/ui-state.audit.test.ts`:

| # | Mutation | Cases that went red |
|---|---|---|
| M5 | a second key joins the pre-auth exception (`podium.view` routed to `pre-auth-theme`) | 2 — *the shared exact vocabulary and client additions are total* (`podium.view: expected 'pre-auth-theme' to be 'device-local'`) and *the theme is the ONLY pre-auth home* |
| M6 | a second unnamespaced reader is added to `ui-state.ts` | 1 — *ui-state has exactly one unnamespaced READER, and it is the theme* |

The two new client-audit detectors were also observed firing on the real tree before being made to
pass, which is stronger than a planted fixture: `construction-outside-provider` reported
`runtime.ts:887` (the factory's own body — the rule now names both the provider and the file that
declares the class, and the property it protects is that no *other* file reaches either symbol), and
`identity-from-non-transport-source` reported `kernelReplica.ts:142`, a `removeItem` that **retires**
the old raw identity ledger. The second was a real detector defect: a deletion derives no identity,
and flagging it would have been arguing for the ledger's return. The pattern is `getItem` only.

---

## 5. What this issue deliberately did not do

- **No authentication UI and no account management.** POD-1075 and Phase 3 own those; this binds to
  whatever principal they produce. Today that principal is the first admin's `userId`, which
  `/auth/status` already returns.
- **No presence or cursor UI.** POD-293 owns that surface.
- **No `instance_id`, anywhere in the client.** Multi-user is not multi-tenancy; ADR 1 D5 stands.
- **Single-user parity.** With one admin owning everything, boot and PTY behaviour are
  indistinguishable from before: the same runtime, the same hub, the same replica, constructed
  through one extra named argument.
