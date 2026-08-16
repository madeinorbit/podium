# Updater epic — closing review before merge

**Issue:** POD-2214 · **Epic:** POD-2087 · **Reviewed at:** `e8696a499` on
`issue/2214-closing-review-before-merge`, range `af4664671..e8696a499` (the point where
the final review, POD-2184, stopped). **Written:** 2026-08-16/17.

Spec: `docs/internal/superpowers/specs/2026-08-14-update-operations-design.md`.
Protocol: `docs/internal/superpowers/plans/2026-08-14-updater-worker-protocol.md`.
Prior reviews, read first so nothing here re-finds what is known:
`2026-08-16-updater-wave-one-review.md`, `…-wave-two-review.md`, `…-wave-three-review.md`,
`…-updater-final-review.md`.

**The integration tip moved under me.** `worktree-updater-spec` is at `a93f780b5`, two
commits ahead of my HEAD: `fe038fe6d` and `a93f780b5` (POD-2210, the foreground
all-in-one refusal) landed while this review was running. They are graded by reading
only, at the end, and none of my gates ran against them.

## What I ran

Base proven first: `git merge-base --is-ancestor worktree-updater-spec HEAD` on the range
I was given. This worktree had no `node_modules`; I hardlink-copied POD-2101's after
confirming the `bun.lock` blobs are the same object (`b7e5677cf`) — 12 ms, no measurable
disk. It is a **symlink farm**, not an install: every `@podium/*` resolves inside this
worktree (`readlink -f node_modules/@podium/protocol` → this checkout), third-party
packages resolve to the shared root, and `.vite`, `.vite-temp` and `.cache` are real local
directories. The three stale workspace links the protocol warns about (`agent-bridge`,
`core`, `domain`) are dangling *into this worktree* rather than into `main`, so they fail
loudly instead of resolving somewhere else. Every vitest header below names this worktree
as its root.

| Check | Command | Result |
| --- | --- | --- |
| **web typecheck — a real green, not a comparison** | `turbo run typecheck --filter=@podium/web --concurrency=1` | **16/16 tasks green**; `@podium/web` was a cache MISS and executed |
| mobile typecheck (the other `sendTurn` caller) | `turbo run typecheck --filter=@podium/mobile --concurrency=1` | **11/11 green**, `@podium/mobile` a cache miss |
| protocol codec + harness browser half | `vitest run --project node packages/protocol/src/messages.test.ts packages/harness/src/browser.test.ts` | **140 passed / 2 files** |
| server: updates + operations | `bun --bun vitest run --project node apps/server/src/modules/{updates,operations}/` | **489 passed / 17 files** |
| web: updates + settings + app | `(cd apps/web && bun --bun vitest run src/features/updates src/features/settings src/app)` | **638 passed, 3 failed / 66 files** — all three in `src/app`, named below |
| `lint:architecture` | `bun scripts/check-boundaries.ts --manifest-only` | **exit 1, nine violations** — one of them is this epic's (D3) |

The three web failures are `type-floor.test.ts` ×2 (CSS micro-role and stylesheet
sub-floor budgets) and `replica.test.ts` (`cold hydrate` expects a shape without
`shipOrders`, which the replica now returns). None names an updater, operations, protocol
or harness file, and POD-2190's record names the same three as pre-existing at the fork
point. **I did not A/B them**, so "pre-existing" here is inference from their subject plus
someone else's measurement, not my own comparison.

`free -g` showed 3 GB available and `df -h` 13 GB free before the typechecks; per the
protocol's revised rule a scoped typecheck above 2.5 GB needs no lane, and I took none.
No build, no `cargo`, no server, no browser. The `updater-integration` lock was never
taken and nothing was merged.

---

# Confirmed defects

Most severe first.

## D1 — Approving an agent's `podium channel dev` on a machine whose daemon predates this branch leaves the approval `executing` forever, with nothing said to anyone

**`packages/protocol/src/messages/approvals.ts:148-152`** (`ApprovalExecRequestMessage.op`
is the closed `ApprovalOp`) against **`apps/daemon/src/frame-guards.ts:41-61`**
(`payloadRejectionReply`) and **`:104-115`** (the parse-failure arm), with
**`apps/server/src/modules/approvals/service.ts:204`** (the send),
**`apps/server/src/store/approvals.ts:60-66`** (`listPending` is `status = 'pending'`
only) and **`apps/cli/src/approval-cli.ts:19,57-65`** (the CLI gives up after ten
minutes).

This is the other half of the seam `98f65d411` fixed, and it was not fixed. The commit
widened `ApprovalChannelTarget` to include `dev` and put `approvalsChanged` on the
quarantine table so the **operator's list** survives an op it cannot read. The **daemon**
receives the same closed union on a different frame, and there quarantine does not apply
at all — `approvalExecRequest` carries one op, not an array.

`payloadRejectionReply` exists precisely for this — its docblock is about a `bundleFetch`
against a `0.1.2-edge.1` daemon that produced nothing but a timeout — and it answers
**only `repoOpRequest`**:

```ts
if (!type || !requestId || type !== 'repoOpRequest') return undefined
```

So an `approvalExecRequest` whose payload the daemon cannot parse is dropped by
`warnDropped` (throttled to one line per second) and nothing is sent back.

**Failure scenario.** This is the state of the fleet on the day this branch merges, not an
exotic one. An agent on a source machine runs `podium channel dev` — the command
`98f65d411` exists to enable, and the only channel that machine's `dev+<sha>` target is
ever published on. The request is filed, the operator sees the popup, reads
"switch the update channel to dev", and approves.

- `ApprovalService.approve` transitions the row `pending → executing` and sends
  `{ type: 'approvalExecRequest', requestId, op: { kind: 'channel', target: 'dev' } }`.
- That machine's daemon still ships the two-value enum. `ControlMessage.parse` throws,
  `payloadRejectionReply` returns `undefined` because the type is not `repoOpRequest`, and
  the frame is dropped.
- No `approvalExecResult` ever arrives, so `onExecResult` never runs and the row stays
  `executing` — a state the service's own doc calls "honest" for `stop`, and which here is
  simply wrong.
- `listPending()` is `status = 'pending'`, so the request **vanishes from the operator's
  popup at the moment of approval**. From the operator's chair it looks exactly like
  success.
- The agent's CLI polls, then gives up after `APPROVAL_WAIT_MS` (10 min) printing
  *"The request is still live: it runs if the operator approves it, and you will be told
  the outcome"* — which is now false twice over: it was approved, and nobody will be told.
- `ApprovalService.notify` only fires on a transition, so the mail fallback that exists so
  "a decision is never lost" never fires either.
- `request()`'s duplicate suppression returns the same row to a retrying agent with
  *"already requested — awaiting approval in the Podium UI"*, so the retry path is a loop
  into the same dead row.

Net: the machine is not pinned, the agent is told to wait for a UI that will never show
it, the operator believes it worked, and the only trace is one throttled `warn` in that
host's journal.

**What it needs.** Either extend `payloadRejectionReply` to answer `approvalExecRequest`
with an `approvalExecResult { ok: false, output: "…not supported by this daemon (podium
<version>) — update the daemon on this machine" }` (the result shape is already defined
and the service already handles `ok: false`), or give the server a deadline on
`executing`. The first is closer to POD-1464's own reasoning — *"a timeout should mean the
machine did not answer, and nothing else"* — and its docblock explicitly names the choice
it made: *"Adding a request type is one arm; guessing at result shapes we have not seen is
not worth the risk"*. The result shape here is not a guess; `ApprovalExecResultMessage` is
already the daemon's own vocabulary. **`apps/daemon` and `apps/cli` are POD-2210's; I read
and edited nothing.**

**Test coverage.** `apps/daemon/src/control/approvals.test.ts` gained the new arm
(`approvalArgv({kind:'channel',target:'dev'})`), which proves the *new* daemon runs it.
Nothing covers the old daemon, which is the one that exists in the field.

## D2 — The quarantine that protects the approvals list ships in the same commit as the value that needs it, so every bundle older than this branch freezes its pending list the first time an agent asks for `dev`

**`packages/protocol/src/messages/codec.ts:78`** (the new entry) with **`:128-147`**
(`parseServerMessageLenient`, whose fallback at `:146` is `ServerMessage.parse(json)`),
against **`packages/client-core/src/socket-transport/socket-hub.ts:1432-1442`** (the
refused-frame arm) and **`:1665-1668`** (`approvalsList = msg.pending`).

The quarantine is the right mechanism and the reasoning on the table entry is correct. But
it protects **the receiver that has it**, and the population it is written for — a bundle
whose closed `ApprovalOp` predates the widening — is by construction the population
without it. `approvalsChanged` was not on `QUARANTINABLE` before `98f65d411`, so in an
older bundle the frame falls through to `ServerMessage.parse`, throws, is caught at
`socket-hub.ts:1432`, and `approvalsList` is left standing at whatever it last held.

**Failure scenario.** P8 is explicit that an old bundle must render a new server, *because
a bundle swap happens during the update* — so this window is the epic's own subject
matter. A browser is holding the pre-merge bundle (or a desktop all-in-one on the previous
version is talking to an updated server). An agent files `podium channel dev`. The server
broadcasts `approvalsChanged`. That bundle refuses the whole frame, and from then on its
approvals popup is frozen: it cannot see the new request, and it cannot see or decide any
of the requests it *does* understand, because the list stopped moving. Every subsequent
broadcast repeats the refusal.

**Mitigation, and why this is not the top of the list.** The failure is loud and correctly
diagnosed. `recordSkew({ refusedFrames: 1 })` makes `describeWireSkew`
(`apps/web/src/app/skew-notice.ts:43-55`) return the **severe** copy — *"This app build
cannot read what the server is sending, so parts of it may be empty or stuck. It is older
than the server. Reload to pick up a newer build"* — which is exactly the right sentence
and exactly the right remedy. Nothing is lost server-side either: approvals are durable
SQLite rows with no timeout.

**What it needs** is sequencing, not code: a value that an older peer's closed schema will
reject should land at least one release after the quarantine that survives it. Failing
that, say so in `§19` — this is a real, deliberate, cross-version cost of the widening and
it is currently written down nowhere.

## D3 — The epic leaves `lint:architecture` one violation redder than it found it, undeclared and unallowlisted, in the lane whose unreadability the protocol's own opening section blames for POD-2176

**`apps/web/src/features/updates/use-update-state.ts:283`** and **`:292`**
(`globalThis.localStorage?.setItem/getItem`), against
**`scripts/boundary-allowlist.ts`** (no entry) and the epic protocol's
*"A gate nobody can hear is a gate that cannot say no"*.

`bun scripts/check-boundaries.ts --manifest-only` exits 1 here with nine violations. Eight
are not this epic's. One is:

```
[ui-storage-ownership] apps/web/src/features/updates/use-update-state.ts: direct
localStorage/AsyncStorage method access is reserved for
packages/client-core/src/ui-state.ts and the replica persistence adapter (POD-329).
```

It arrived in `057c7960b` (*"one click, one restart, and something on the other side"*),
which is **not an ancestor of `main`** — it is an epic commit, 34 commits into this
branch. `main`'s copy of the same file contains zero references to `localStorage`. So this
is an addition, not an inheritance.

The code itself is defensible and well argued (`use-update-state.ts:262-277`): the
all-in-one restart destroys both the in-memory `watched` set and `sessionStorage`, so the
operation id is handed across two lives of the app in a five-minute window, and both
accessors are `try`-wrapped so private mode degrades to the behaviour that shipped before.
I am not asking for it to be removed.

**What is wrong is that nothing recorded the decision.** The allowlist is described in the
tool's own output as a ratchet; a deliberate exception belongs in it with this reasoning
attached, or the key belongs in `ui-state`. As it stands the epic's contribution is one
more line in the nine that make this lane unreadable — and POD-2206's post-mortem is that
this exact lane named the settings crash *by filename* and nobody heard it, because it was
red for four unrelated reasons. Adding a fifth reason is the specific harm the protocol's
first section asks workers not to cause.

Note also that POD-2206's A/B (*"one violation removed, zero added"*) was taken against the
**pre-fix commit on this branch**, so "nine pre-existing" means pre-existing on the branch.
Against `main` the epic's net is one added.

## D4 — Applying one refused machine now un-proves the canary, so an operator clicking Apply mid-wave collapses the wave back to one machine at a time — and stalls it entirely while that grant is outstanding

**`apps/server/src/modules/updates/service.ts:620`** (`authorizeMachine` now routes
through `clearMachineVerdicts`) with **`:521-540`** (which sets
`rollout.canaryHealthy = false` on every non-empty clear), against
**`apps/server/src/modules/updates/wave.ts:141-147`**.

`21cf275f6` consolidated two retry routes into one method, which is the right shape. But
the single-row route gained a side effect it did not have. Before:

```ts
if (TERMINAL_STATES.has(machine.state)) { …delete…; this.rollout(channel).halted = false }
```

After, the same path calls `clearMachineVerdicts(channel, [machineId])`, and that method
un-halts **and** un-proves:

```ts
rollout.halted = false
rollout.canaryHealthy = false
```

`planWave` treats `canaryHealthy` as the gate on widening (`wave.ts:141`): with it false it
returns `[]` outright if anything is in flight, and otherwise grants exactly one machine.

**Failure scenario.** Four machines on the channel. The canary `a` converges, so
`canaryHealthy` is true and `a`'s state row is deleted. The wave widens to `b`, `c`, `d`.
`d` rejects (`machine-dirty-checkout`); the rollout stays un-halted because the canary is
healthy. The operator sees `d`'s row in Settings → Machines, fixes the checkout, and
clicks Apply on that row. `clearMachineVerdicts` clears `d` and sets
`canaryHealthy = false`. `authorizeMachine` grants `d` directly, so `inFlight > 0`. The
next `tick()` now takes the `!canaryHealthy` branch, sees `inFlight > 0` and **returns
nothing** — no machine is granted until `d` answers. If `d` is the machine that goes
silent, the whole remainder of the wave waits out the `machines` step's ten-minute silence
budget for a reason that has nothing to do with them; if `d` answers, the wave resumes
one machine at a time rather than at `concurrency`.

The repair path exists but does not cover this: `fleet()` (`service.ts:710-716`) re-sets
`canaryHealthy = true` when a machine is *observed at target while it still has a state
row*, and the original canary's row was deleted when it converged. So nothing re-proves it
until the next machine converges.

The fleet still converges, so this is a degradation and not a wedge — which is why it is
fourth and not first. The fix is one line: `authorizeMachine`'s route should clear the
verdict without touching `canaryHealthy` (a human applying one row has not un-proved
anything), or `clearMachineVerdicts` should take that as a parameter the two callers answer
differently.

---

# Seam 1 — the codec quarantine (`98f65d411` + `e8696a499`), answered point by point

Beyond D1 and D2, the questions the brief asked:

**Is the per-element quarantine correct for a full-list snapshot?** Mechanically, yes —
and a snapshot is the *safer* of the two shapes to quarantine, not the riskier one.
`parseServerMessageLenient` rebuilds the envelope from the survivors and re-validates it
(`codec.ts:140-143`), and the receiver assigns wholesale
(`socket-hub.ts:1666: this.approvalsList = msg.pending`). For a delta collection a dropped
element is a permanent cursor gap that compounds; for a snapshot each frame re-states the
whole truth, so the surviving set is always exactly right for the readable subset, nothing
accumulates, and the drop is deterministic rather than order-dependent. I checked
specifically that the `dropped` count does not leak into a heal path it should not: the
`{ dropped }` context reaches exactly one handler, `metadataDelta → legacyFeed.frame`
(`socket-hub.ts:1513-1515`), so an unreadable approval cannot trigger a feed resync. The
codec's own docblock (`codec.ts:120-123`) still says a quarantined change "is a cursor gap…
heal on the v1 wire", which is now true of some entries on the table and meaningless for
the snapshot ones — worth a clause.

**Is a dropped element distinguishable from a deleted one?** **No, and not at any layer.**
The list is replaced wholesale, so absence is absence. The one signal is the aggregate
`WireSkew`, which is not attributed to a frame type. Concretely (S1 below) the popup at
`apps/web/src/app/ApprovalDialog.tsx:29,76` renders `approvals[0]` and says *"N more
requests waiting behind this one"* — a quarantined request is neither shown nor counted,
so the sentence is quietly wrong.

**Can it lose an approval rather than merely hide it?** **Not in the store — but the hiding
is unbounded and has no recovery path from the UI.** Approvals are durable rows with, by
deliberate design, *no timeout* (`approvals/service.ts:19-23`: *"an approval waits for a
human, indefinitely"*), so the row survives. What is lost is every route to it: the
operator cannot see it, the CLI gives up at ten minutes, `notify` only fires on a decision,
and `request()`'s dedupe hands a retrying agent the same invisible row. The only exits are
a newer bundle or the database. That is materially better than the pre-quarantine
behaviour (which froze the *whole* list) and materially worse than the table entry's
"the unreadable request is dropped and counted as skew" implies.

**The tripwire, and the reasoning it left.** POD-1127 wrote two objective membership tests
and said *"re-run them, do not trust this comment"*. Test 2 has now fired, and the author
re-derived rather than either ignoring it or letting it silently expire — which is the
behaviour the tripwire was written to produce. The substance is right: the constant really
was renamed from `COLLECTION_MESSAGE_ELEMENTS` to `QUARANTINABLE`, the question it answers
really did change, `sessionsChanged` and `hostMetricsChanged` really are snapshots on the
same table, test 1 really does still fail cleanly, and *"quarantining a row is not
replicating an entity"* is the correct distinction. Filing the relocation as POD-2211
rather than answering it in a channel fix is the right call. My one criticism is
mechanical and is S5 below: the original test-2 text at `approvals.ts:97-98` still asserts
*"no `approvalsChanged` frame"* as a present-tense fact, with the correction ten lines
further down. A reader who greps the membership test finds a false statement first.

---

# Seam 2 — the vite alias and the harness split (`4ef804a13` + `b8bab69cc` + `752bfe292`)

**Does anything else reach the host-only modules?** No. `@podium/harness` appears in
`apps/web` in exactly two places: the workspace dependency in `package.json:31`, and the
one import at `sections/shared.tsx:18`, which now names `/browser`. Every other hit across
`apps/web`, `apps/mobile`, `packages/client-core` and `packages/model` is prose in a
comment. The barrel and `/metadata` are unreachable from a browser-safe workspace by
`checkBrowserReach` (`scripts/check-boundaries.ts:728-748`): `packages/harness` is now
`neutral`, `apps/web` is `browser-safe`, and only specifiers present in
`BROWSER_ENTRYPOINTS` are exempt — `openEntrypoints` does **not** grant a pass there, which
is the property that keeps `/metadata` open-to-import and unbundlable at the same time.

**Can the alias mask a boundary violation?** No. `checkBrowserReach` reads import
specifiers out of source text and never resolves them, so a vite alias is invisible to it.
I also checked the direction that worried me more — whether an unaliased specifier could
hide from the *new* crash-language budget check, which matches on source paths
(`scripts/web-bundle-budget.ts:76-102`, `BROWSER_HOSTILE_SOURCES = ['packages/harness/src/',
…]`). It cannot: `resolve.conditions: ['@podium/source']` means even a node_modules
resolution lands on `packages/harness/src/*`, whether that is this checkout or (per
POD-746) another one, and the fragment matches either way. The alias's real job is the one
its comment claims — pinning *which checkout* — and the commit is honest that its own
baseline measurement was taken through main before the alias existed.

**Can the browser half drift from the host half?** Not in any way I can construct.
`AGENT_MANIFESTS` is a static `Record<BuiltinHarnessKind, AgentManifest>` with no dynamic
registration, `manifestFor` is `isBuiltinHarnessKind ? … : undefined`, and
`BuiltinHarnessKind` is `HarnessAgent` from `@podium/model` — the same single source that
`@podium/protocol` re-exports, so the two files' notions of the closed set cannot diverge.
`browser.test.ts` asserts the table equals the manifest-derived map for every kind, asserts
key-set equality, and pins the fail-closed behaviour for unknown ids including inherited
`Object` properties (`toString`, `constructor`), which is the prototype hole a bare
`Record` lookup would otherwise have. The old implementation read
`declaredValue(headless)?.noTools === 'enforced'`; the test compares against exactly that
expression, so the identity is the real one and not a restatement.

POD-2206's probe table (`docs/internal/pod-2206-settings-chunk.md:98-104`) made all four
guards fail on purpose and wrote down the failure each produced — including reverting the
`/metadata` import and confirming the refusal *names `@podium/harness/browser` as the
alternative*. That is the standard the protocol asks for and it is met. The one caveat is
that `manifest-browser-reach` (b)'s walk over `browser.ts` is currently trivial — the file
has exactly one import and it is type-only, so the closure is one node. The guard is
proven able to fire (they added `node:fs` and saw it), but its coverage today is a single
file; it earns its keep only when someone adds the second import, which is precisely when
it matters.

One structural gap in that guard, for whoever owns it next, is S4 below.

---

# The three shorter questions

**Does the retry fix leave any path where a stale verdict still blocks a fresh operation?**
I could not find one for a machine that is *in the plan*. `placeOf`
(`operation.ts:370-376`) now writes every planned place `pending`, `behind`
(`operation.ts:444-450`) selects on version/supervision/`onlyMachines` and never on the
verdict, so a `rejected` or `stuck` machine is still planned; and the runner clears the
verdicts of untouched places (`operation.ts:1053-1056`) *before* `settleMachines` at
`:1058`. The per-place scoping is right, and the third test in `21cf275f6` — a deferred
machine admitting itself into a running step while `vmi`'s refusal stands — drives a real
re-entry rather than a contrived one, and the commit says it was proven able to fire by
making the clearing unconditional. The two residual observations are D4 above and S6 below.
The one behaviour a reader should know is not covered: a machine that refuses and *then
goes offline* is deferred by the next plan, so its verdict is never in `step.places` to be
cleared, and the reconciler deliberately leaves a terminal machine alone
(`reconciler.ts:444`) — it converges only if it wakes while a step is running, or after a
human applies it. That is the intended design ("a background process must not keep poking a
standing fault"), not a defect, but it is the case where "Try again" still does not reach a
machine.

**Does the bundle guard actually fail if the engine goes eager again?** Yes, and this is
the best-evidenced guard on the branch: POD-2190 reverted `UpdatesProvider` to a static
import, rebuilt, and captured the printed failure naming all six modules, then reverted
(`docs/…/2026-08-16-eager-bundle-budget-repair.md:130-138`). I did not rebuild, so I am
relying on that record for the *live* proof; what I can verify from source is the matcher
shape, and it has a hole — S3 below.

**Is the typecheck narrowing safe for every caller?** Yes, and I verified it rather than
reasoning about it. `Exclude<AgentKind, 'shell'>` is `HarnessAgent` exactly
(`packages/model/src/entities/agent.ts:31,40`), which is what
`apps/mobile/src/lib/agent-models.ts:10` already declares `IssueAgentKind` to be, so the
mobile call site was already narrow. The web site narrows through `HarnessAgent.safeParse`
(`use-headless-turn.ts:160`). The third production caller,
`packages/client-core/src/engine/actions.ts:406`, passes no `agentKind` at all. Both
`@podium/web` and `@podium/mobile` typecheck green here as cache **misses**, and the
argument that the server's zod schema rejects `'shell'` at runtime — so the mirror was
promising a call that could only ever fail — is correct. Narrowing a *parameter* on an
interface others implement is also the safe direction: a fake whose `sendTurn` accepts the
wider `AgentKind` still satisfies the narrower declaration.

The measurement note in `8282cc7b4` is worth preserving: the honest count was ten errors
against this worktree's own `node_modules`, versus the 38 a worktree without one reports
when resolution walks up into `main`. That is the same POD-746 hazard as the vite alias, in
a third costume.

---

# Suggestions

**S1 — a quarantined approval is invisible *and* uncounted.**
`ApprovalDialog.tsx:29` renders `approvals[0]` and `:76` says *"N more requests waiting
behind this one"*, both computed from the post-quarantine array. With one row dropped the
sentence undercounts silently. The hub already knows the drop happened; passing the
frame-scoped count into the store, or having the dialog read `hub.wireSkew()`, would let
that line say *"1 request could not be read by this build"* — which is the difference
between an operator who reloads and one who never learns.

**S2 — `quarantined` counts drop *events*, not distinct rows, and `approvalsChanged` is a
snapshot.** `recordSkew` (`socket-hub.ts:1453-1465`) accumulates monotonically, and the
approvals snapshot is re-broadcast on every request, every decision
(`approvals/service.ts:86`) and on every client attach (`relay.ts:2349`). One unreadable
approval therefore drives the operator-visible number in
`skew-notice.ts:52` — *"N items from the server could not be read"* — upward without
bound, and churns the banner each time because the message text changes. The counter
semantics were designed for delta collections; two snapshot frames (`sessionsChanged`,
`hostMetricsChanged`) were already on the table, so this is a pre-existing shape rather
than a regression, but `approvalsChanged` is the first one that re-fires on attach. A
per-frame-type high-water mark would say the true thing.

**S3 — the eager-engine guard is six basenames, so the seventh module is invisible to it.**
`scripts/web-bundle-budget.ts:67-74` lists `operation-view.ts`, `update-view.ts`,
`use-update-state.ts`, `operations-client.ts`, `UpdatePanel.tsx`, `UpdatesEngine.tsx`, and
`matchingSources` (`:169-175`) is a substring test. A new file under
`apps/web/src/features/updates/` pulled eager by the loader is caught only by the byte
ceilings — which is exactly the currency the guard's own docblock says does not work
("the overage was 572 bytes of gzip… a number that names no cause"). The
`BROWSER_HOSTILE_SOURCES` check two blocks below already has the better shape: a directory
fragment plus an explicit exception list. `['apps/web/src/features/updates/']` with
`updates-context.tsx` (the loader) excepted would make the rule closed instead of
enumerated.

**S4 — `manifest-browser-reach` (b) special-cases one neutral workspace's subpaths instead
of all of them.** `scripts/check-boundaries.ts:819-825` refuses `node:`, `bun:`,
`@podium/runtime/`, forbidden npm packages, and any `node-only` workspace. `@podium/runtime/`
is hardcoded because its subpaths are the node half — but the same is now true of
`@podium/harness/metadata`, and of any future two-halved package. A declared browser
entrypoint that imported `@podium/harness/metadata` would pass rule (b) (harness is
`neutral`, not `node-only`) and would never be seen by rule (a) either, because (a) only
applies to files inside a `browser-safe` workspace and the entrypoint lives in a neutral
one. Nothing does this today. Generalising the hardcoded prefix to "any subpath of a
neutral workspace that is not one of its own `BROWSER_ENTRYPOINTS`" would close it, and
would let the `@podium/runtime/` line be deleted rather than duplicated per package.

**S5 — POD-1127's membership test 2 now states something false, with its correction ten
lines away.** `packages/protocol/src/messages/approvals.ts:96-98` still reads *"2.
COLLECTION_MESSAGE_ELEMENTS (messages/codec.ts) — no `approvalsChanged` frame (it is a
snapshot broadcast, not an element-wise delta collection)"*, and `:102-104` still says that
adding one expires the decision. The erratum below is correct and well argued, but the
tripwire's value was that a reader could evaluate it mechanically. Rewriting test 2 to the
renamed constant's actual question — "is `approval` a MetadataEntityKind?" is test 1; test 2
should now ask something that is still false — would restore that, and the current text
would become history rather than an assertion.

**S6 — the per-place verdict clearing is protected only by statement order.**
`operation.ts:1053-1056` clears the verdicts of untouched places; `:1058` settles and
returns if anything terminal remains; `:1108` then calls `markAuthorized(details.channel)`,
which clears **every** terminal verdict on the channel with no id list
(`service.ts:491-497`). The careful per-place reasoning at `:1024-1052` is therefore load-
bearing only because `settleMachines` returns first. Nothing states that dependency and
nothing tests it — a future edit that moves `markAuthorized` above the settle, or that adds
an early path to it, silently restores the hot loop POD-2105's guard exists to prevent. One
sentence in the docblock, or scoping `markAuthorized` to the step's places too, would pin
it.

**S7 — the new §7 code has no taxonomy entry.** `UPDATE_NOT_INSTALLED_ERROR_CODE`
(`operation.ts:1472`) falls through `errorCopy`'s `default` arm
(`operation-view.ts:526-540`), which correctly relays the server's sentence — so the
*what happened* half of P7 is honest — but the *one next action* half comes from
`describeUpdateFailure`'s generic guidance rather than the obvious one ("open Podium
Desktop on that machine and install it"). The commit's comment anticipates the fall-through
for *older* bundles; the current bundle should carry the case.

**S8 (carried, final review S8) — the reconciler's `attempts` map is still swept only on
`at-target`** (`reconciler.ts:444`). Unchanged. Now joined by `converged`, which
`expireGrant` does not clear — harmless, because `convergedBy` re-checks the machine's
actual version against the target (`reconciler.ts:283-286`), so an expired grant cannot
claim a convergence that did not happen. Both are per-process leaks of a few bytes per
machine, worth one sweep together.

**S9 (carried) — an operation ending still sweeps machines on other channels**
(`reconciler.ts:254-257`). Unchanged, and now slightly more pointed than when it was
written: since `de389ccc2` the operation's channel is the host's own, so a `stable`
operation finishing is what triggers a sweep of `dev`-pinned machines and vice versa.

**S1–S3, S6, S7 from the final review** (`invokeWithin` hand-off guard,
`core:event:allow-listen`, the panel opening itself on every load, `updates.retry`'s
100-vs-20 history window, `engine.active()` with no group) are all unchanged at this tip.

---

# The fixes the final review asked for, re-checked at the mechanism

| # | Final-review defect | Verdict |
| --- | --- | --- |
| **F1** | reconciler grant with no deadline | **Fixed at the mechanism** (`76ec6de68`). `RECONCILE_GRANT_DEADLINE_MS` (`reconciler.ts:131`) is *derived* from `UPDATE_BUDGETS` rather than chosen, so it cannot drift from the step budget bounding the identical act. `expireGrant` (`:394-404`) is armed by a timer at grant time — not a poll inside `pump`, which the docblock correctly notes would never run for the last machine in the queue — is guarded by a monotonic token against the classic stale-timer bug, routes through `abandonWait` so a machine that already answered keeps its own verdict, and pumps whoever was queued behind. `stuck` being terminal is what stops it becoming a hot loop, and the comment that asserted a mechanism POD-2101 had deleted is gone. The fake clock became a real clock because two timers minutes apart cannot share a drain — that is the honest cost and it was paid. |
| **F2** | all-in-one `done` after being ignored | **Fixed at the mechanism** (`93bacac5b`, corrected by `28e9f3ef8`). `describeWaitingExpiry` is a kind hook rather than a constant, which is right because the same kind produces both plan shapes. The predicate is *"did any step reach `done`"* rather than *"is this all-in-one"*, so an empty retry remainder lands there too. **Worth recording how the correction happened**: the first version tested `state === 'succeeded'`, which is not in `OPERATION_STEP_STATES`, and the *fixture said the same wrong word*, so the two-sided test agreed with the bug and passed. A scoped typecheck is what said no. That is the cleanest instance on this branch of a test that cannot say no because it was written in the same vocabulary as the code it checks. |
| **F3** | admitted machine granted by nothing | **Fixed at the mechanism** (`eff7c9505`). `admitDeferred` now `await this.driveLocked(operationId)` instead of `armDeadline`, exactly as `settleAsk` does; `driveLocked` re-arms the deadline itself on a `running` outcome (`engine.ts:634-636`), so the arm it replaces is not lost. Its one early return that does not re-arm — a `stalled` step (`engine.ts:608`) — is a step that already owes itself a retry. The new test asserts a **grant**, against an unmoved clock, with three machines so the canary is already proved; the two-machine version would have hidden the missing drive behind `planWave` legitimately refusing to widen. |
| **F4** | `RestartFailed` has no producer | **Unchanged.** `updater.rs:80-85`'s only caller is still inside `#[cfg(test)]`. The page still synthesises the code, so §7's contract holds on the TypeScript side and the panel carries the copy (`operation-view.ts:516-520`). Still a dead branch, still low. |
| §8 mixed channels | operation hardcoded to `'dev'` | **Substantially fixed** (`de389ccc2`) and **honestly bounded** (`fbfcf2322`). `UpdatesService.operationChannel` reuses `channelOf`, so the operation cannot disagree with the authority that will grant, and falls back to the fleet default for a host not yet in the directory — which matters because the adoption root runs before the gateway listens. The severity of what it fixed is worth stating plainly: `DEFAULT_FLEET_UPDATE_CHANNEL` is `stable`, so **on every shipped installation the planner threw "no dev update target is published" and the fleet got no operation at all** — and every drive the epic had done to that point ran on the one configuration where that is invisible. The remaining half is written down where a reader meets it (`updates/trpc.ts:133-147`): `fleetSnapshot` is still dev-scoped, so a fleet with no dev machines shows a null target version and zero counts in Settings while a good stable operation runs. Filed as POD-2191, not hidden. |

---

# The epic against its spec, one last time

## §2 — the eight first principles

| | Principle | Verdict |
| --- | --- | --- |
| **P1** | An update is a noun | **Delivered.** The final review's one exception (an operation reaching `done` having done nothing) is closed by F2's fix. Identity, plan, terminal outcome, `retryOf` and history are all real and none is inferred. |
| **P2** | One writer of truth | **Delivered.** `projectMachines` remains the one computation; the grep-level acceptance from wave three stays clean at this tip. The one place a client re-derives nothing but still lies is `fleetSnapshot`'s dev scoping — a *server* read model, so P2 is not violated; §8 is. |
| **P3** | Survives its own medicine | **Delivered, and still the strongest part.** Nothing in this range weakened it. `fe038fe6d` extends the principle honestly to the one shape that cannot survive its own medicine at all — a single foreground process — by refusing rather than pretending. |
| **P4** | Liveness is part of the contract | **Delivered.** F1 closed the last granter outside the contract; every grant in the system is now bounded by a timer somebody owns. F3 closed the case where a place was counted but clocked by nothing. |
| **P5** | Local actions are local | **Delivered.** Unchanged. |
| **P6** | Single-flight with a queue | **Delivered.** Unchanged. |
| **P7** | Errors speak user, carry engineer | **Delivered on the paths that produce errors, with two named gaps.** F2 turned the worst outcome from a false success into a typed failure with a sentence, which is the big move. What remains: `update-not-installed` has no `nextAction` of its own (S7), F4 leaves one Rust code with no producer, and — the one that matters — **D1 is a failure that produces no error at all**, on a path §7 is supposed to cover. |
| **P8** | Frozen contract | **Delivered and enforced for the operation; strained for the op catalog.** The conformance suite is real and the new `lastProgressAt` was added additively. But P8's second sentence — *"every consumer tolerates absence and unknowns"* — is exactly what `ApprovalOp` does not do, by design, because `target` becomes argv. Quarantine is the right answer for the array carrier (D2 is about when it shipped, not whether), and there is no answer at all yet for the single-op frame the daemon receives (D1). A closed catalog on a wire that must tolerate skew is a standing tension, and this branch is where it first bit. |

## §8 — the hard cases

"Untested" means the mechanism is present and I followed it, but nothing in the suites
exercises it and I did not drive it.

| Case | Verdict |
| --- | --- |
| Server restarts mid-update | **Handled, tested.** Unchanged. |
| Client reloads mid-update | **Handled, and now partly driven.** POD-2157 has completed the web-step drive with panel screenshots. |
| Web bundle replaced mid-update | **Handled, tested at the contract.** The bundle swap itself is still untested end-to-end. |
| A new version lands mid-update | **Handled, tested.** Unchanged. |
| Two tabs / two users click Update | **Handled, tested.** Unchanged. |
| A machine is offline during the wave | **Handled, tested — F3's gap closed.** The admitted machine is now granted by the admission, and the test asserts the grant rather than the place. |
| Update fails half-applied | **Handled, tested, and materially better.** `21cf275f6` is what makes Retry mean something: before it, the remainder inherited the previous operation's verdict and failed in ten milliseconds having asked nobody. |
| Server comes back on the wrong version | **Handled, tested.** Unchanged. |
| Download hangs with no error | **Handled, tested.** Unchanged. |
| Browser user vs someone's native app | **Handled, tested.** Unchanged. |
| All-in-one: who updates the server inside the app? | **Handled on both paths now.** The success path adopts from the successor's version; the ignored path fails with `update-not-installed` instead of lying; and the *foreground* shape, which had no answer at all, refuses before it fetches anything (`fe038fe6d`, reviewed by reading only). |
| Hidden dialog | **Handled, tested.** Unchanged. |
| Update offered while viewing through an old bundle | **Handled, and now testable.** POD-2206 removed the reason no built bundle could render Settings, and POD-2190 kept the panel off the first paint. I did not build, so I confirm the mechanism and the authors' measurements, not a bundle I looked at. |
| Cancel mid-update | **Handled, tested.** Unchanged. |
| Fleet on mixed channels | **Half handled, and now honestly documented.** The operation follows the host's channel rather than a literal `dev` — which is the difference between "no operation ever" and "an operation for the host's channel". A genuinely mixed fleet still gets one operation for one channel and a Settings read model scoped to `dev` (POD-2191). The spec row still promises more than is built, but the gap is now written where a reader meets it rather than inferred by a reviewer. |

---

# What a reader should NOT believe is proven

- **No macOS signed desktop release has been run, by anyone.** It needs production keys and
  a real Mac, it was explicitly out of scope for POD-2157, and nothing on this branch
  substitutes for it. Every claim about the desktop install/restart path rests on unit
  tests, `tauri-conf.test.ts` string assertions, and `#[cfg(test)]` Rust. **No Rust was
  compiled in this review or in the previous one**; CI remains the only authority for the
  desktop crate building at all.
- **POD-2157 is in flight and its remaining slice is not done.** As of this writing its own
  todo list has the web-step drive, the stable-channel drive and
  `verify-headless-update.sh` (both arms) **done** — including a real swap, restart and
  reconnect at target over feed delivery using a production-signed 0.1.3, and seven arms
  against the pinned-key trust domain with real bytes over a real socket. Still open:
  **the installed-bundle drive's pairing half** (filed as POD-2215), **`test:e2e`** (queued
  on the shared lease), and teardown accounting. Treat "the installed bundle path is
  proven" as false until POD-2215 closes.
- **I built nothing.** No `vite build`, so I did not re-run `web-bundle-budget.ts` in
  either of its new capacities. The eager-budget numbers, the "61 host-only sources → 0"
  line, and the live re-arming of the eager guard are POD-2190's and POD-2206's
  measurements, read and judged, not reproduced. Their evidence documents are unusually
  good — both name the probe that made each guard fail — but they are somebody else's runs.
- **The three failing `apps/web` `src/app` tests are called pre-existing on the strength of
  their subject matter and someone else's A/B, not mine.** I did not detach a worktree at
  the fork point to compare.
- **D1, D2 and D4 are derived by reading, not by a probe.** For D1 I traced the send
  (`approvals/service.ts:204`), the daemon's only parse-failure reply
  (`frame-guards.ts:41-61`, the sole `type !== 'repoOpRequest'` gate), `listPending`'s
  pending-only query, and the CLI's ten-minute give-up sentence; I did not stand up an old
  daemon. For D2 I confirmed the pre-change codec path falls through to
  `ServerMessage.parse` by construction; I did not run an old bundle. For D4 I traced
  `clearMachineVerdicts` → `canaryHealthy` → `planWave`'s widening gate and confirmed
  `fleet()`'s re-prove requires a state row the converged canary no longer has; a fake-clock
  service test would settle it in one run. My brief makes this document my only writable
  file, so I added none.
- **The last two commits on the integration branch were not gated by me.** `fe038fe6d` and
  `a93f780b5` (POD-2210) landed after I cut this worktree. I read them and they look right
  — the refusal is decided at the composition root, which is the only place that knows the
  PID took both roles; it disarms the exit seam itself so the protocol-mismatch self-update
  cannot reintroduce the silent stop; it declines *before* anything is fetched, because git
  delivery detaches the checkout the live server is reading from; and the systemd
  (`INVOCATION_ID`) and desktop-supervised escapes are both correct, since in those shapes
  something does restart it. But none of my typechecks or suites included them.
- **`lint:architecture` is red and stays red.** Nine violations, exit 1. The epic owns one
  of them (D3). A green there is not available at merge and should not be claimed.
- **Nothing was driven in a browser here**, and no server was run. Everything in this
  document about UI behaviour is read off the view functions and their tests.

---

# Verdict

The four defects the final review left are closed at the mechanism, not moved — and in two
cases the fix went deeper than the finding: F1's deadline is *derived* from the budget that
bounds the identical act rather than chosen, so the two numbers cannot drift, and F2's
`describeWaitingExpiry` asks the general question ("is completing honest?") rather than the
specific one ("is this all-in-one?"), so an empty retry remainder is covered by
construction. The channel fix behind them is the most consequential thing in this range:
until `de389ccc2` a shipped installation got no operation at all, and the epic had never
run in that configuration.

Against the spec, all eight principles are delivered, with P7 and P8 carrying the two
named gaps above; eleven of the fifteen §8 rows are handled with tests, three are handled
with their end-to-end proof still partial (client reload, bundle swap, old-bundle render),
one is half-handled and honestly documented, and none is broken.

**What I would not merge without is D1.** It is silent, it is permanent, its blast radius
on merge day is every machine whose daemon is older than this branch — which is all of them
— and it sits on the exact path the widening was built to enable, so the first agent to use
the new feature is the one who hits it. It is also cheap: one more `type` arm in a function
that already exists for this precise failure, with a result shape the service already
consumes.

D2 is a sequencing decision that should at minimum be written down as one. D3 is small and
procedural and would take five minutes, and I am flagging it loudly only because this epic
spent a day inside the harm that lane's redness caused, and is leaving it one line redder.
D4 is a real regression with a one-line fix. F4 remains a dead branch and can wait.
