# POD-3523 — every caller of `FeedServing.attach` / `renegotiate`, classified

The coordinator's ruling on POD-3523 required this census as the issue's first
deliverable, before any edit: rule 51 turns on **whether the caller may yield at the
moment it invokes the port**, and POD-3508 filed the issue without resolving it.

The verdict is **case 2 — the caller may not yield — on both production paths, and it
is not the "mixed" case.** The reasoning, the chains, and the measurement are below.

## 1. What routes through `admit`

`FeedServing.admit` (`apps/server/src/gateway/feed-serving.ts:276`) is declared `void`
and its body is `withReadScope(async () => …)`. `withReadScope` is
`<T>(fn: (scope: ReadScope) => T): T` (`store/executor/read-scope.ts:203`), so with an
async `fn` it returns `Promise<void>` into a `void` slot and the promise is discarded.
This is rule 56's shape exactly, and there are **two** such discard sites in the file,
not one:

| site | enclosing method | what is dropped |
| --- | --- | --- |
| `feed-serving.ts:302` | `admit` | `serveWorld` / `canResume` + `serveResume` |
| `feed-serving.ts:624` | `renegotiate` | `serveWorld(…, 'version-change')` |

Both public entry points reach a dropped promise, so both are in scope.

## 2. Production caller chains

### Path A — `attach`

| frame | file:line | sync? | can it yield? |
| --- | --- | --- | --- |
| `websocket.open(native)` | `gateway/ws-server.ts:309` | sync method on Bun's `NativeWebSocketHandler` | **no** — the runtime discards the return value; there is nothing to await it |
| `wireClientSocket(…): string \| undefined` | `gateway/client-socket.ts:58` | sync | **no** — `open()` reads the returned id synchronously to decide whether to un-register the socket |
| `ClientMux.attachClient(peer): string` | `gateway/client-mux.ts:185` | sync | **no** — returns the minted connection id, consumed by the frame above |
| `this.deps.feed.attach(…)` | `gateway/client-mux.ts:248` | — | — |

### Path B — `renegotiate` (the path every production admission actually takes)

| frame | file:line | sync? | can it yield? |
| --- | --- | --- | --- |
| `websocket.message(native, message)` | `gateway/ws-server.ts:339` | sync | **no**. The file's own comment: *"Every inbound frame's handling runs synchronously under this call, and it reaches JS without passing through any scheduler."* |
| `ws.on('message', (raw) => …)` | `gateway/client-socket.ts:81` | sync listener | **no** — an emitter discards a listener's return value |
| `measureTask('ws.client.hello', () => routeClientFrame(…))` | `gateway/client-socket.ts:145` | `<T>(label, fn: () => T): T` | **no**, and worse than "no": its `finally` records `performance.now() - startedAt` **at the sync return**. An async callback would record ≈0 ms and silently destroy POD-1931's per-frame-type cost attribution — the exact number the seam was built to produce |
| `ClientMux.routeClientFrame(id, msg): void` | `gateway/client-mux.ts:301` | sync | **no** |
| `ClientMux.renegotiate(conn, announced, cursor): void` | `gateway/client-mux.ts:354` | sync | **no** — and it *uses the return value synchronously*: `if (refusal === null) return`, otherwise `feed.detach(conn.id)` and `conn.entityServingRefused = true` |
| `this.deps.feed.renegotiate(…)` | `gateway/client-mux.ts:369` | — | — |

**There is no third production caller.** `attach`/`renegotiate` on `FeedServing` are
reached from nowhere else in `apps/`, `packages/` or `scripts/` outside tests — the many
other `.attach(` hits in the tree are unrelated methods (`WireFeedEdge.attach`,
`StatementProbeHub.attach`, `SocketHub.attach`, the agent-runtime terminal `attach`).

### Non-production callers

`feed-serving.test.ts` (18 sites), `feed-serving.resume.test.ts` (2),
`scripts/audit-serving-path.test.ts` (1), and — through `attachClient` /
`routeClientFrame` — `scripts/switch-latency-ab.ts` and `scripts/measure-hot-paths.ts`.
All sit inside async bodies and could await.

## 3. Why this is case 2 and NOT rule 51's "mixed" case 3

Rule 51 case 3 is *"the same port is invoked from BOTH"*, and it is interesting because
the two kinds of caller impose **conflicting** requirements on the port. That is not the
situation here:

- Every caller that *constrains* the port is a synchronous transport handler. Both of
  them. There is no production caller that may yield.
- The case-1 callers are tests and measurement scripts. A test does not get a vote on
  whether a port may yield: it exists to observe the subject, and it can observe an
  awaited port or an explicit settlement handle equally well.

So the constraint set is uniform, and the resolution follows the coordinator's ruling for
the "ANY caller is a synchronous transport handler" branch, not the mixed branch.

Concretely, **widening `attach()` to `Promise<UpgradeRequired | null>` is not available.**
It would force `attachClient` async, then `wireClientSocket` async, then Bun's `open()`
handler async — a floating promise in a socket-accept callback. On path B it is worse:
`message()` is the I/O-completion seam, frames arrive with no scheduler between the
kernel and JS, and an async handler would let frame N+1 begin before frame N finished.
That is the wall POD-3499 hit with `runStep` and POD-3505 hit with `apply()`.

## 4. What a consumer actually observes

The coordinator asked for this before the choice, because severity is the argument for
which resolution is acceptable.

**Measured, on the tip, in the unit lane that owns this file** — far worse than the one
`scripts/` audit failure the brief knew about:

```
bun --bun node_modules/vitest/vitest.mjs run --config vitest.boundary.config.ts \
  src/gateway/feed-serving.test.ts src/gateway/feed-serving.resume.test.ts

Test Files  2 failed (2)
     Tests  21 failed | 3 passed (24)
```

Twenty-one tests, every one of them reading what a peer received after `attach` returned,
and finding nothing there yet. Sample: *"a snapshot peer gets the five lists, in the
attach order it always had"*, *"is O(delta) at an unchanged head, where it was
O(world)"* — `expected +0 to be 50`.

**Reasoned, for production, and stated only as far as the code supports:**

1. A consumer observes a **delayed** first frame, not a missing one. The transport sends
   on a later tick either way, and nothing in the socket path reads a return value that
   depends on the bootstrap having happened.
2. A rejection anywhere in `serveWorld` / `serveResume` / `canResume` — and after the
   flip `worldFor`, `identity.resolve`, `authority.cursor` and `retention.minAvailableSeq`
   are all async DB work that can reject — becomes an **unhandled rejection** on a later
   tick. Nobody refuses; the client waits for a world that will never arrive.
3. **The admission window is now re-entrant, and it was not before.** `connections.set`
   happens at the *end* of `serveWorld` (`feed-serving.ts:459`), after several awaits,
   while both `attach` (`:259`) and `renegotiate` (`:620`) branch on
   `this.connections.has(peer.id)`. So during the window a second entry sees "not yet
   admitted" and admits again. `detach` inside the window is the same hazard from the
   other side: it clears the maps, and the in-flight admission then re-installs a
   connection and a retained principal for a peer that is gone.

Hazard 3 is `admit`'s own doc comment coming true. That comment says the read and the
registration "are one decision", indivisible today "only because nothing between them
yields", and that after the flip a commit landing in the gap is "a contiguity break the
replica can only answer by healing, forever". The read scope was widened over the whole
admission for exactly that reason — and then the promise carrying the scope was dropped,
which gives the guarantee back.

## 5. The resolution this authorises

Case 2 with no earlier async boundary available: `worldFor(principal)` depends on the
principal minted in `attachClient`, and it must be read *inside* the admission scope or
§3.5's certified-read property is what breaks. So the await cannot move earlier.

What follows is the coordinator's second branch — make the deferral **explicit and
documented as a contract** (rule 57's `void` spelling, POD-3505's `apply()` as the worked
example) — plus the half POD-3505 did not need: the deferred admission must be
**observable**, because hazard 3 and the 21 red tests both come from nobody being able to
see it settle.
