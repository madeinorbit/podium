# Ship Stack v2 — a dependable delivery service

> Architecture and product proposal, 2026-08-12. This is the reviewed successor
> to the first Ship Stack concept. It keeps the original idea—durable shipping,
> deterministic work first, agent help only for exceptions—and corrects the
> execution, data, validation, branch-safety, preview, and UX contracts.

## The plan in simple words

Today, finishing work and shipping it are accidentally the same conversation.
That is why a completed agent has to remain alive, wait for locks, remember a
long merge procedure, and warm a huge context again just to move a branch.

The Ship Stack makes shipping a hand-off:

1. At review, Podium shows the proof and a **Ship** button.
2. Pressing it creates a durable order. The issue leaves the human's decision
   queue; Podium now owns the follow-through.
3. The server remembers the plan and coordinates it. The daemon on the machine
   that owns the repository performs git and test work.
4. Podium first tests a temporary, exact preview of the future target branch.
   It does not hold the merge lock while tests run.
5. If the tested commit is still current, Podium briefly takes the merge lock,
   lands and publishes it, verifies the destination, and closes the issue when
   the chosen policy says it should.
6. Ordinary problems are solved by code. A small, task-shaped agent is invited
   only for a conflict or test failure. A human sees one clear decision card
   only when judgment is actually needed.

The result should feel like handing a parcel to a very good courier: the user
can watch it move, but does not have to carry it.

An interactive visual prototype accompanies this proposal:
[Ship Stack UX prototype](../design/POD-775-ship-stack-prototype.html).

## Review verdict on the first proposal

The first proposal found the right product idea and the right cost hierarchy.
It should be implemented after the following corrections.

| Keep | Correct or extend |
|---|---|
| A ship request is separate from issue stage. | Shipping is a normalized aggregate, not an attempts array embedded in the issue row. |
| Deterministic work handles most traffic. | The server is the control plane; daemon workers execute filesystem, git, tests, and previews. |
| A bounded headless agent handles exceptions. | Route by live model traits, quota, risk, and task; never grant the model merge or push authority. |
| A visible stack replaces invisible polling. | Show durable orders and attempts, not advisory lock waiters dressed up as orders. |
| Batching can remove repeated validation. | Validate immutable merge-group refs first; mutate real issue refs only after a green result and compare-and-swap checks. |
| A dedicated landing checkout removes hazards. | It requires an explicit one-time adoption because a target branch cannot safely be checked out in two worktrees. |
| Review proof should be typed. | A live preview is a supervised lease, not an immutable file artifact. Offers and issues reference the proof. |
| Landing and closing are related. | They are not the same fact: destination reached, issue closed, branch cleaned, and preview stopped are explicit outcomes. |

Two claims from the first proposal should be dropped:

- A server-side service can still crash or run out of memory. Reliability comes
  from durable state, leases, idempotent steps, heartbeats, and reconciliation
  after restart—not from the process in which code happens to run.
- The stack must not acquire `merge:main` before a long gate. It snapshots the
  target and validates speculatively, then holds the mutex only for the final
  target recheck, ref update, publish, and verification.

This mirrors the mature merge-queue pattern: GitHub validates temporary merge
groups, while GitLab merge trains test each candidate with the changes before it
in the train. The Podium-specific improvement is adaptive batching for a
resource-constrained local machine and a repair path that can use its existing
agent harnesses. See [GitHub merge queues](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
and [GitLab merge trains](https://docs.gitlab.com/ci/pipelines/merge_trains/).

## Product contract

### What “Ship” promises

After a ship order is accepted:

- the issue no longer asks the human for a merge decision;
- no heavyweight agent waits or polls;
- server and daemon restarts do not lose the order;
- Podium either reaches the configured destination or presents one actionable
  hold with cause, evidence, and safe choices;
- cancel is always available before the target ref changes;
- no path uses reset, force-push, force-delete, stash, or silent dirty-tree
  cleanup;
- the UI states exactly what was tested and exactly what was published.

“Configured destination” is important. A repository policy defines whether
shipping ends at a local target ref, an ordinary remote push, or an external
provider's protected merge queue. The button must not say **Shipped** when only
a local branch moved but policy requires `origin/main`.

### Admission

An order can be queued only when:

- the issue is in review or otherwise has an unmerged deliverable;
- it is not blocked and its required sub-issues are complete;
- the branch and target are known;
- the requester is currently allowed to ship to that repository and target;
- a typed evidence manifest exists or the repository policy explicitly allows
  the relevant evidence class to be empty;
- the requested policy does not widen the repository's merge, publish, cleanup,
  or validation policy.

Admission is not branch custody. An agent can still improve a queued issue until
preflight begins. Every attempt records the expected branch tip, so a later
commit invalidates the attempt instead of racing it.

## Fit with Podium's architecture

The existing architecture already gives the feature its boundaries:

```text
 Web / mobile / CLI
          │ shipping command contracts
          ▼
 @podium/commands ──────────────── policy, exposure, attribution
          │
          ▼
 apps/server/modules/shipping     CONTROL PLANE
  order service · scheduler · batch planner · reconciler · projections
          │                         │
          │ machine RPC             ├── HeadlessService (exception only)
          ▼                         │
 apps/daemon/shipping             EXECUTION PLANE
  git refs · worktrees · jobs · validation · preview supervisor
          │
          ▼
 repository / processes / preview HTTP
```

The layer ownership follows [ARCHITECTURE.md](../../ARCHITECTURE.md):

- `@podium/model` owns portable domain vocabulary and pure transitions.
- `@podium/protocol` owns server↔daemon job and event frames.
- `@podium/commands` owns versioned user/system command contracts.
- `apps/server/src/modules/shipping/` owns authorization, durable state,
  scheduling, batching, orchestration, and projections. Writes pass through the
  existing funnel/ledger and publish through the normal replica path.
- `apps/server/src/modules/machines/rpc.ts` routes every execution request to
  the issue repository's actual machine.
- `apps/daemon/src/shipping/` owns host capabilities. It uses argv arrays and
  purpose-built operations, never a server-supplied shell string.
- `apps/web/src/features/shipping/` and the equivalent mobile surfaces consume
  a shared client-core view model.

This should be a shipping module, not another large branch inside
`steward.ts`. The steward is an event-to-nudge coordinator. Shipping is a
long-running, user-authorized workflow with its own aggregate, leases, job
protocol, and recovery rules. It may subscribe to the same typed event bus and
reuse system-principal patterns without becoming the steward.

### Server responsibilities

The server is authoritative for:

- authorization and the requester's attribution;
- repository policy and validation profile resolution;
- order, batch, attempt, and step state;
- queue ordering and dependency-aware grouping;
- machine placement from issue ownership and live daemon availability;
- lease renewal, retry/backoff, cancellation, and restart reconciliation;
- model routing and budgets for exception handling;
- issue/offer/tray projections, audit events, and notifications.

### Daemon responsibilities

The daemon is authoritative for observations and host effects:

- repository and worktree inspection;
- temporary integration refs and checkouts;
- git composition, ancestry, ref compare-and-swap, fetch, push, and verification;
- process execution with timeout, cancellation, output caps, and resource
  admission;
- machine pressure and job heartbeat reporting;
- preview process supervision and the local side of authenticated preview
  routing.

The existing single-operation `repoOp` route is useful substrate, but the
shipping path should expose higher-level purpose-built RPC operations such as
`prepareMergeGroup`, `runValidationProfile`, `commitMergeGroup`, and
`verifyDestination`. That makes invariants testable in the daemon and avoids a
server trying to compose a safe transaction out of loosely related git calls.

## Durable model

Do not append every attempt to the issue row. Attempts and output are unbounded,
hot, independently addressable data. Use a normalized aggregate family and put
only a compact derived summary on the issue projection.

```ts
type ShipOrder = {
  id: ShipOrderId
  issueId: IssueId
  repoId: RepoId
  targetBranch: string
  expectedSourceTip: string
  requestedBy: Attribution          // identity, never a permission snapshot
  requestedAt: string
  policyId: string                  // resolved from trusted repo policy
  closeMode: 'after-destination' | 'leave-open'
  state:
    | 'queued' | 'preflight' | 'composing' | 'validating'
    | 'landing' | 'publishing' | 'verifying'
    | 'shipped' | 'held' | 'cancelled'
  holdCode?: ShipHoldCode
}

type ShipBatch = {
  id: ShipBatchId
  repoId: RepoId
  targetBranch: string
  baseSha: string
  orderedOrderIds: ShipOrderId[]
  integrationRef: string
  integrationSha?: string
  generation: number
  state: 'building' | 'validating' | 'green' | 'committing' | 'done' | 'invalid'
}

type ShipAttempt = {
  id: ShipAttemptId
  orderId: ShipOrderId
  batchId?: ShipBatchId
  expectedSourceTip: string
  expectedTargetTip: string
  machineId: MachineId
  leaseGeneration: number
  startedAt: string
  finishedAt?: string
  outcome?: string
}
```

Step runs are append-only rows keyed by an idempotency key. Large stdout/stderr
is redacted, size-capped, and stored as a durable log artifact; rows carry the
summary and artifact reference. `IssueWire` gets a derived `shipSummary` with
state, queue position, current step, hold summary, and destination—not a nested
copy of all shipping entities.

Permissions are resolved live for the requester's principal whenever an outward
mutation occurs. The order stores attribution and delegation bounds, never a
serialized capability snapshot. This follows the repository's existing
principal and no-capability-snapshot rules.

## Reliable execution

### At-least-once, made safe

Exactly-once process execution is not a useful promise across crashes. The
workflow is at-least-once and every effect is safe to replay:

- each step has an idempotency key and expected input SHAs;
- the daemon journals start, heartbeat, terminal result, and result ack;
- ref moves use compare-and-swap (`oldSha → testedSha`), never an unconditional
  update;
- a remote push is ordinary non-force publication and fails if the destination
  moved;
- after a timeout or restart, the reconciler observes git and process truth
  before deciding to retry;
- an expired lease stops a worker from starting a new effect, while SHA checks
  keep a late result from being committed.

The current advisory lock remains useful for coordination with humans and older
agents. Automated correctness additionally comes from the expected-SHA compare
and swap. A stolen or expired advisory lease can therefore cause a retry, not a
wrong merge.

### Branch custody

Before composition, preflight requires:

- no live write-capable session on the issue;
- a clean issue worktree;
- the branch tip still equals the order's expected source tip;
- no active preview that depends on mutating that worktree.

Podium then uses the existing safe “free worktree, keep branch” behavior without
`--force`. The UI labels this **Podium has custody**. Reopening the issue cancels
the attempt and recreates a worktree from the unchanged branch. This gives the
shipper a stable ref without silently killing an agent or leaving a checked-out
branch that another worktree cannot update safely.

### Landing checkout adoption

A dedicated landing checkout is the right steady state but not a magic first
step. Git refuses to check out `main` in a second worktree, and forcing two
worktrees to share it creates inconsistent indexes. Podium therefore needs:

1. `podium ship doctor` to report who currently owns every target branch;
2. an explicit one-time adoption that creates a shipper-owned landing checkout
   only when the target is not checked out elsewhere;
3. a migration plan for deployments currently running from a mutable repo-root
   `main` checkout—ideally run the installed release from its versioned bundle,
   then let the landing checkout own `main`;
4. a guarded compatibility mode that uses today's root checkout only when it is
   already on the target and clean.

The service must never switch a live deployment checkout behind the operator's
back. Until adoption succeeds, wrong-branch and untracked-file conditions are
honest holds, not auto-repairs.

## The train: immutable merge groups

Orders may batch only when repo, target, merge style, publish destination,
validation policy, and authorization bounds are compatible. Dependency edges
come first; FIFO order breaks ties. Blocked or changed orders are omitted rather
than holding independent work behind them.

One batch runs as follows:

1. **Snapshot.** Read the target and source tips. No merge mutex is held.
2. **Compose.** In the daemon's detached integration checkout, build
   `refs/podium/ship/<batch>/<prefix>` commits in order. Conflicts affect the
   smallest prefix that contains them. Real issue branches are untouched.
3. **Validate.** Run the union of required validation profiles against the final
   immutable integration SHA. The receipt names that SHA. Validation jobs take
   only the resource leases their profile declares.
4. **Isolate if red.** Reuse cached prefix results and run adaptive binary/delta
   isolation. If A and B pass separately but fail together, report an
   interaction set; do not pretend one issue is “the offender.” Recompose the
   remaining independent orders.
5. **Commit briefly.** Acquire the canonical `merge:<target>` lease, refresh the
   target, and recheck every expected SHA. Any drift invalidates the batch and
   returns it to composition.
6. **Move exact refs.** Compare-and-swap each issue branch to its exact tested
   prefix tip, then fast-forward the target to the tested batch tip. Recovery can
   finish a partially completed sequence because every intended old/new pair is
   durable.
7. **Publish and prove.** Perform the configured non-force publication, then
   verify that each issue tip is an ancestor of the configured destination.
   Release the merge lease immediately.
8. **Settle.** Mark orders shipped, close eligible issues according to
   `closeMode`, stop previews, and run non-forcing cleanup.

The expensive gate runs without `merge:main`; the lock covers only step 5–7.
Under contention, speculative prefix groups can run in parallel like modern
merge trains. On a memory-constrained host, one full group followed by adaptive
isolation is cheaper. The scheduler chooses from measured queue depth, cache
reuse, and machine pressure rather than hard-coding one strategy.

## Validation and proof

### Named profiles, never arbitrary commands

The first proposal put `gate: string` on each order. That is both too vague and
too much authority. Repository policy should define named profiles from the
trusted target branch or server settings:

```ts
type ValidationProfile = {
  id: string
  argv: string[]
  cwd: 'integration-root'
  timeoutMs: number
  resourceLocks: string[]
  machineTraits?: string[]
  pathRules?: string[]
  supersedes?: string[]
}
```

An order references profile IDs. A candidate that changes its own validation or
shipping policy cannot make that change effective for itself without explicit
approval. There is no generic rule that every batch takes `test:heavy`: Podium's
ordinary gate, store shard, integration lane, and multi-instance lane exist for
different behavior. The planner deduplicates the required profile union and
honors the repository's cache rather than rerunning work for confidence.

### Review evidence is a typed manifest

An issue at review can present:

- `validation` — command/profile, source SHA, result, duration, and log;
- `artifact` — immutable screenshot, video, HTML, Markdown, or report;
- `preview` — a supervised live URL with status and expiry;
- `diff` — the exact branch comparison the reviewer is accepting.

Path/diff rules suggest the minimum class, while the agent chooses the most
useful evidence. A docs-only change can legitimately need only a rendered file;
an interaction-boundary change can require a live preview or targeted runtime
proof. Start with a review warning, collect false-positive data, and only make
well-understood evidence policies blocking.

### Preview is a lease, not an artifact

`IssuePanelArtifact` is an immutable snapshot in permanent storage. A preview is
machine-owned, mutable, expires, has a process, and can be offline. Mixing those
lifecycles into one union makes every artifact consumer understand liveness.

Use a normalized `PreviewLease` instead:

```ts
type PreviewLease = {
  id: PreviewLeaseId
  issueId: IssueId
  machineId: MachineId
  sourceSha: string
  recipeId: string
  status: 'starting' | 'live' | 'stopped' | 'failed' | 'expired'
  route: string                 // stable authenticated Podium route
  expiresAt: string
  lastHeartbeatAt?: string
}
```

The daemon supervises the declared preview recipe. For Podium itself, the
existing independent-instance contract supplies isolated state and port
namespaces; for other repos, settings declare a recipe and health probe. The
browser should not receive a raw daemon port. An authenticated server route
proxies HTTP/WebSocket traffic over the existing machine connection, so the same
link works from the desktop, another machine, or a phone. TTL, manual stop,
source-SHA mismatch, issue shipment, and daemon loss all have explicit states.

Offers and issue projections reference evidence IDs. A review offer can display
the preview beside immutable artifacts without pretending they are the same
thing.

## Model strategy: several models, very little model work

The shipper is deterministic. Models never wait for leases and never own merge,
push, branch-delete, or cleanup tools. They can only propose a patch on an
attempt-scoped repair ref; the deterministic workflow validates and commits it.

Add a personal `shipwright` role using the existing `RoleBackend` shape. Resolve
it through the requester's account, the target machine's live model catalog,
current quota, and model/harness traits. Do not persist a global favorite model
name in the shipping schema.

The escalation ladder is:

| Level | When | Route | Authority |
|---|---|---|---|
| 0 — Examiner | Parse conflicts, classify failure, collect minimal context | deterministic | read-only |
| 1 — Mechanic | Local syntactic conflict or obvious test repair | fast/balanced coding model, low–medium effort | patch repair ref only |
| 2 — Solver | Semantic conflict, cross-module failure, first repair failed | frontier coding/reasoning model, high effort | patch repair ref only |
| 3 — Inspector | High-risk generated patch or ambiguous behavior | different model family/provider, review only | verdict + concerns |
| 4 — Human | Behavior choice, policy change, repeated failure, budget exhausted | one decision card | explicit choice |

Cross-model review is useful when the patch is risky, not as a ritual on every
merge. The router should evaluate the ladder on a small golden set of real
conflicts and gate failures. Model names change quickly: current official model
guidance already separates flagship, balanced, and high-throughput tiers for
[OpenAI](https://developers.openai.com/api/docs/models),
[Anthropic](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model),
[Gemini](https://ai.google.dev/gemini-api/docs/latest-model), and
[xAI](https://docs.x.ai/developers/model-capabilities/text/reasoning). Podium's
stable abstraction should be workload traits plus measured eval results, while
its machine-keyed catalog discovers what Codex, Claude Code, Grok, OpenCode, and
Cursor can actually run on that host.

Every model invocation receives only:

- the issue brief and acceptance criteria;
- relevant diff and conflict hunks;
- bounded failure output and the validation profile;
- target-side code needed to understand those hunks;
- explicit forbidden actions and a structured patch/result contract.

If a repair changes observable behavior or acceptance criteria, the order is
held for review even when tests pass.

## UX: a shipping deck, not a log viewer

The existing Merge Queue panel shows advisory leases and candidates. Evolve it
into a Ship Stack surface backed by orders, batches, and attempts; keep a small
“resource lanes” section for raw merge/test locks.

### Entry: review handoff

The review card puts the thing to judge first:

- best evidence preview/artifact;
- exact destination and close behavior;
- validation summary tied to the source SHA;
- primary **Ship** action;
- **Send back** with required text and a secondary policy disclosure.

Pressing Ship gives immediate custody feedback: “Queued—Podium owns the next
step.” It should not open a modal unless policy is unusual or authority expands.

### Stack: calm progress

Group by repository and target. Each order shows one of a small number of human
states: Queued, Preparing, Testing, Landing, Publishing, Shipped, Held. Expand
for exact steps, SHAs, logs, model use, and retries. The batch header shows the
future target commit and the validation profiles running against it.

The most important quiet-state copy is: **No agents are waiting.** A daemon job
or durable queue may be waiting, but no paid context is burning.

Do not promise a fake ETA. Show current step, elapsed duration, queue position,
lease cause, and confidence based on historical profile durations. A human can
pause a repository, cancel an untouched order, reprioritize before composition,
or open the exact failed evidence.

### Holds: one decision, one card

A hold is deduplicated by order plus reason code. The card contains:

- the outcome headline;
- cause in one sentence;
- what deterministic repair and any model already tried;
- the smallest evidence link;
- 2–4 mutually exclusive safe actions.

Examples: **Return for changes**, **Retry unchanged**, **Drop from batch**, or
**Open repair session**. “Take mine/theirs” is not offered for semantic conflicts
without showing what those sides mean.

### Mobile

The Tray shows only holds and completed destination receipts. Routine progress
stays in the stack and notifications are milestone-based. A phone user can view
the authenticated preview and answer a hold without opening a terminal.

## Observability and controls

Operational surfaces should answer:

- queue age and depth per repo/target;
- current and historical step durations;
- batch size, validation cache hit rate, invalidation rate, and isolation runs;
- daemon job heartbeat, memory/load admission delay, and last progress;
- deterministic completion rate versus L1/L2/L3 escalation;
- model tokens, latency, provider, effort, patch acceptance, and human override;
- merge-lock hold duration (the key regression metric);
- orders held by reason and time-to-human-answer;
- destination verification and cleanup outcomes.

Global pause, per-repo pause, cancellation, concurrency, resource budgets,
model-token budgets, retry ceilings, and preview TTLs are policy—not hidden
constants. Watchdogs care about monotonic workflow progress, not whether a timer
thread is alive.

## Failure policy

| Failure | Automatic response | Human sees |
|---|---|---|
| Server/daemon restarts | reconcile durable attempt and host/git truth | nothing unless recovery stalls |
| Daemon offline | keep order queued; retry placement on owning machine | machine unavailable after threshold |
| Source tip changed | invalidate attempt; requeue latest tip after evidence check | “updated while queued” in history |
| Target tip changed | discard merge group and recompose | no hold unless retry ceiling reached |
| Dirty issue worktree | do not take custody | files and **Return to issue** |
| Composition conflict | L1 then L2 repair within budget | one hold if unresolved/semantic |
| Validation failure | classify, isolate, land independent green work | smallest failing or interacting set |
| Host pressure | admission delay; no agent waiter | “waiting for capacity,” not “stuck” |
| Advisory lease expires | stop new effects; reconcile/CAS before retry | only if progress ceiling exceeded |
| Publish rejected | refresh/recompose or use configured provider adapter | exact destination error |
| Preview dies | daemon restarts within lease budget | preview state + restart/stop |

## Build plan

Each slice is independently reviewable and keeps authority narrow.

### Slice 1 — durable single-order shipping

- Shipping model/command/protocol/module skeleton and replica projection.
- Queue/cancel/retry, explicit policy resolution, audit events.
- Daemon preflight and job journal with source/target SHA fences.
- One issue through existing guarded ff-only landing and destination proof.
- Review **Ship** action, issue custody card, and basic Stack row.

Success: an accepted single order survives server and daemon restart and either
ships or produces one actionable hold; no agent polls.

### Slice 2 — landing checkout and exact commit protocol

- `ship doctor`, landing-checkout adoption, and compatibility mode.
- Shadow merge-group refs, branch custody/freeing, compare-and-swap ref moves.
- Named validation profiles, receipts, resource admission, publish adapters.
- Recovery fault matrix across every step boundary.

Success: the tested SHA is the shipped SHA, issue tips are ancestors of the
configured destination, and the merge lock excludes validation time.

### Slice 3 — adaptive train

- Dependency/FIFO grouping and compatibility planner.
- Full-group validation, cached prefix groups, adaptive failure isolation.
- Interaction-set handling and safe recomposition of independent work.
- Queue controls, history, metrics, and pressure-aware scheduling.

Success: a dozen compatible green issues need one composition/validation group,
while one bad or interacting subset does not block independent work.

### Slice 4 — shipwright escalation

- Personal shipwright role, trait/quota router, budgets, and eval set.
- Attempt-scoped repair refs and structured model contracts.
- Mechanic/Solver/Inspector ladder via existing headless harness execution.
- Behavior-change detection and one-card human pushback.

Success: common conflicts recover without reopening the original session; models
cannot land or publish and their output is always deterministically revalidated.

### Slice 5 — review evidence and previews

- ReviewEvidence and PreviewLease aggregates/projections.
- Daemon preview supervisor, recipe policy, health/TTL lifecycle.
- Authenticated server↔daemon HTTP/WebSocket route.
- Evidence strip in issue/offer, responsive preview viewer, mobile parity.

Success: a reviewer opens the working feature from the offer on desktop or phone
without discovering a port or asking the agent for a URL.

The independently shippable implementation work is tracked as proposals:

- POD-830 (Durable ship orders) — slice 1 and the common foundation;
- POD-831 (Exact landing executor) — slice 2, blocked by POD-830;
- POD-832 (Adaptive merge trains) — slice 3, blocked by POD-831;
- POD-833 (Bounded shipwright repairs) — slice 4, blocked by POD-831;
- POD-834 (Supervised preview proofs) — slice 5, independently useful;
- POD-835 (Ship Stack delivery deck) — the production UI/UX, blocked by POD-830.

## Acceptance story

A convincing end-to-end demonstration is:

1. Queue twelve reviewed issues while another process briefly owns
   `merge:main` and the host is near its memory threshold.
2. Stop and restart the server and daemon mid-queue.
3. Observe zero waiting agent sessions and all orders still present.
4. Let the daemon compose one immutable group and validate it without holding
   the merge mutex.
5. Inject one deterministic failure and one semantic conflict.
6. Observe the safe subset ship, the deterministic failure isolate, and exactly
   one decision card for the semantic conflict.
7. Accept the repair, verify each exact issue tip is an ancestor of the required
   destination, and confirm cleanup never used a forcing operation.
8. From a phone, open the review preview for a later issue and press Ship.

That story proves the initial problem is solved: shipping continues in the
background, failures are recoverable, tokens are spent only on judgment, and the
human supervises outcomes instead of babysitting mechanics.
