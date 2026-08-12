# Podium Shipping v3 — make it happen

> Architecture and product proposal, 2026-08-12. “Ship Stack” remains the
> internal project name; the user-facing concept is simply **Shipping**. This
> revision starts after review and treats “I like it, make it happen” as the
> complete user job.

## The plan in simple words

This proposal deliberately begins **after** the user has reviewed the work and
said it is good. Review, previews, evidence presentation, and the wording or
placement of the normal approval action belong to Podium's ordinary issue UX.

From that point, Shipping is one deterministic hand-off:

1. The normal UX or the finishing coordinator invokes `podium issue ship` for
   the top-level delivery root.
2. Podium atomically creates a durable order and moves the issue from `review`
   to the special system-owned `shipping` stage.
3. The command returns one calm receipt: **Shipping · Podium owns it now.** The
   user can leave immediately; no new view opens and no agent keeps polling.
4. The server remembers and coordinates the order. The repository-owning daemon
   performs git, validation, preview teardown, publication, and verification.
5. Deterministic code handles the normal path. A bounded repair agent is started
   only for an actual conflict or gate failure, then its patch is revalidated.
6. If Podium still cannot finish, the issue stays `shipping`, raises the existing
   durable human-attention alert, and turns the Shipping rail icon red. Otherwise
   it eventually verifies the destination and closes the issue.

The existing right-side Queues dock stays unchanged. A new adjacent
**Shipping** dock offers confidence and recovery controls, but it is not part of
the happy path and never becomes another list of work for the user to manage.

Sub-issues never become separate parcels. They integrate into the top-level
delivery root; a child agent that wants to hand off the whole approved result
names that root explicitly with `podium issue ship <root-id> --outside-scope`.

The result should feel like handing a parcel to a very good courier: the user
can watch it move, but does not have to carry it.

A production-shaped interactive prototype accompanies this proposal. It draws
only Podium's existing 316px right dock and 46px rail, copies the current
`RightDock` density and Dark Ink tokens, and storyboards the
complete post-approval flow without inventing another app shell:
[Shipping right-sidebar flow](../design/POD-775-ship-stack-prototype.html).

## Review verdict on the first proposal

The first proposal found the right product idea and the right cost hierarchy.
It should be implemented after the following corrections.

| Keep | Correct or extend |
|---|---|
| A durable ship request is separate from issue details. | Add one lifecycle stage, `shipping`, as the issue-level custody projection; keep attempts and machine state in a normalized aggregate. |
| Deterministic work handles most traffic. | The server is the control plane; daemon workers execute filesystem, git, tests, and accepted-preview teardown. |
| A bounded headless agent handles exceptions. | Route by live model traits, quota, risk, and task; never grant the model merge or push authority. |
| An optional status peek replaces invisible polling. | Add a separate Shipping dock; keep Queues and its merge/test resource lanes unchanged. |
| Batching can remove repeated validation. | Validate immutable merge-group refs first; mutate real issue refs only after a green result and compare-and-swap checks. |
| A dedicated landing checkout removes hazards. | It requires an explicit one-time adoption because a target branch cannot safely be checked out in two worktrees. |
| Accepted review input should be typed. | Shipping freezes its base/head and evidence reference; normal review and live-preview UX stay outside this service. |
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

- the issue is in the system-owned `shipping` stage and cannot be claimed,
  started, or moved by an ordinary stage edit;
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
provider's protected merge queue. No surface may say **Shipped** when only a
local branch moved but policy requires `origin/main`.

### Admission

An order can be queued only when:

- the issue is in `review` with an unmerged deliverable;
- it is a top-level delivery root (`parentId == null`); a top-level issue does
  not need to have children;
- it is not blocked, every required descendant is complete, and the approved
  root tip contains a current integration receipt for those descendants;
- the branch and target are known;
- the requester is currently allowed to ship to that repository and target;
- a typed evidence manifest exists or the repository policy explicitly allows
  the relevant evidence class to be empty;
- the requested policy does not widen the repository's merge, publish, cleanup,
  or validation policy.

The accepted source base/head pair is frozen at admission. The finishing session
may exit normally after invoking the command, but must not make another change.
Preflight waits for write-capable sessions to settle and then takes branch
custody. If the source changed after approval, Podium does not silently ship the
new content; it returns the issue to human attention with the mismatch.

### One command, one transition

The agent-facing extension belongs in the existing shared issue-command seam,
not in a standalone shell script:

```text
$ podium issue ship
shipping POD-775 → origin/main
Podium owns it now.
```

The complete CLI shape is:

```text
podium issue ship [<issue-id>] [--outside-scope]
```

With no id, an attached agent nominates its own issue. An operator or an agent
may name a different issue; an agent crossing its attached issue subtree must
say `--outside-scope`, matching the existing issue-command convention. That
flag is an explicit acknowledgement, not an authority grant: the normal role,
ownership, repository, target, review, and admission checks still run on the
named issue. The event records both the attributed requester and the scope
override. An operator does not need the flag. An unattached agent must provide
an id; omission is never resolved from the current directory or branch name.

The CLI table in `@podium/issue-client` and an `issues.ship` contract in
`@podium/commands` expose the same server operation to CLI and MCP, so agents,
web, and mobile cannot acquire subtly different semantics.

### Sub-issues compose; delivery roots ship

Only a top-level issue can own a `ShipOrder`. A nested sub-issue is a unit of
decomposition, not an independently publishable promise: its branch is first
integrated through the existing parent integration flow, and the root order
freezes the resulting approved root tip and descendant manifest.

“Top-level” means the highest issue ancestor, resolved by the server from stored
hierarchy rather than trusted from CLI input. For a nested hierarchy, each
intermediate parent integrates its children before it completes; the root then
integrates that parent. Admission walks the whole descendant closure even
though each existing integration step remains local to one parent.

This is intentionally a guard, not an automatic redirect. If an agent attached
to `POD-912` runs `podium issue ship` and that issue belongs under `POD-900`, the
server refuses with the resolved top-level root and the safe next command:

```text
POD-912 is a sub-issue of delivery root POD-900 and cannot ship separately.
To nominate the approved root: podium issue ship POD-900 --outside-scope
```

The explicit second command matters because shipping the root may include
sibling work. It gives another agent a deterministic way to flag the approved
delivery without silently broadening the first command. Admission then verifies
that all required descendants are complete and that the root's integration
receipt still describes their current tips. A top-level leaf issue is already a
delivery root and remains directly shippable.

Issue hierarchy and delivery order are separate concepts. Parent/child edges
say which work composes into one user promise; `deliveryDependsOn` says which
immutable branch or provider-PR delta must land before another. A delivery root
may participate in a Git stack, but none of its nested sub-issues gets a
standalone remote landing.

The command takes no merge method, test command, model name, destination, or
batch controls. Trusted repository policy resolves all of those. It is:

- **atomic:** order creation and `review → shipping` either both commit or
  neither does;
- **idempotent:** repeating it for the same approved base/head returns the same
  active order and receipt;
- **fenced:** a different source after acceptance is a new review, not an update
  to the old order;
- **exclusive:** direct `podium issue update --stage shipping` is rejected, as
  are ordinary stage changes while Shipping owns the issue;
- **settled by the service:** verified destination moves `shipping → done`; a
  safe cancel before any destination effect returns `shipping → review`; a hold
  remains `shipping` and sets `needsHuman`.

The detailed state—waiting for capacity, composing, validating, repairing,
publishing—is intentionally **not** a set of issue stages. It is operational
state on the order. Users need one lifecycle fact: Podium owns it.

Existing classifiers treat `shipping` as quiet system-owned work: it is absent
from `ready`, review backstops, working-session counts, and ordinary “needs you”
buckets unless `needsHuman` is also true. It remains searchable and visible in
the issue explorer, activity, and dependencies, so background does not mean
hidden or unauditable.

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
  git refs · worktrees · jobs · validation
          │
          ▼
 repository / validation processes
```

The layer ownership follows [ARCHITECTURE.md](../../ARCHITECTURE.md):

- `@podium/model` owns portable domain vocabulary, including the single
  `shipping` issue stage, and pure transitions.
- `@podium/protocol` owns server↔daemon job and event frames.
- `@podium/commands` owns versioned user/system command contracts.
- `apps/server/src/modules/shipping/` owns authorization, durable state,
  scheduling, batching, orchestration, and projections. Writes pass through the
  existing funnel/ledger and publish through the normal replica path.
- `apps/server/src/modules/machines/rpc.ts` routes every execution request to
  the issue repository's actual machine.
- `apps/daemon/src/shipping/` owns host capabilities. It uses argv arrays and
  purpose-built operations, never a server-supplied shell string.
- `apps/web/src/features/merge-queue/` evolves in place into the **Shipping**
  right dock; issue and mobile surfaces consume the same client-core view
  model. There is no new top-level Ship Stack tool.

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
- issue/Tray/Shipping-dock projections, audit events, and notifications;
- settlement calls into the separate preview service to stop accepted leases.

### Daemon responsibilities

The daemon is authoritative for observations and host effects:

- repository and worktree inspection;
- temporary integration refs and checkouts;
- git composition, ancestry, ref compare-and-swap, fetch, push, and verification;
- process execution with timeout, cancellation, output caps, and resource
  admission;
- machine pressure and job heartbeat reporting.

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
  issueId: IssueId                     // always a top-level delivery root
  descendantManifest: DescendantTip[]  // frozen integrated sub-issue inputs
  repoId: RepoId
  targetBranch: string
  sourceBaseSha: string               // reviewed layer base, not just trunk
  expectedSourceTip: string
  deliveryDependsOn: ShipOrderId[]    // branch/PR chain, not issue parentage
  providerRef?: ProviderPullRequestRef
  requestedBy: Attribution            // identity, never a permission snapshot
  requestedAt: string
  policyId: string                  // resolved from trusted repo policy
  closeMode: 'after-destination' | 'leave-open'
  state:
    | 'queued' | 'preflight' | 'composing' | 'validating' | 'repairing'
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
  expectedSourceBase: string
  expectedSourceTip: string
  expectedTargetTip: string
  machineId: MachineId
  leaseGeneration: number
  startedAt: string
  finishedAt?: string
  outcome?: string
  submittedHeadSha: string
  testedIntegrationSha?: string
  landedRefSha?: string
  destinationSha?: string
}

type ShipHold = {
  id: ShipHoldId
  orderId: ShipOrderId
  generation: number                 // compare-and-swap resolution fence
  reasonCode: ShipHoldCode
  headline: string
  detail: string
  evidenceRefs: string[]
  actions: Array<'retry' | 'return-to-issue' | 'open-repair' | ShipPolicyAction>
  raisedAt: string
  resolvedAt?: string
}
```

Step runs are append-only rows keyed by an idempotency key. Large stdout/stderr
is redacted, size-capped, and stored as a durable log artifact; rows carry the
summary and artifact reference. `IssueWire` gets a derived `shipSummary` with
order id, one of four human states, destination, a stable plain-language
activity code, server-computed queue rank, queued/state-change timestamps,
receipt availability, and an optional compact hold—not a nested copy of all
shipping entities. The four states are `waiting`, `in_progress`, `needs_you`,
and `shipped`; detailed phases never become issue lifecycle. Queue rank is a
scheduler snapshot within one repository/destination lane, never a position
inferred by the client or a global order across independent lanes.

A `DeliveryReceipt` belongs to one verified `ShipOrder`, not to the Shipping
panel. It records approved source, tested integration tip, landed/provider ref
tip, verified destination tip, validation profile/result, destination, and
completion time. Active orders can show proof-so-far but cannot call it a
delivery receipt. Completed rows link to their own receipt; older receipts stay
on issue/activity history after they leave the small recent window.

The issue row carries only `stage='shipping'` plus that compact projection. The
server enforces a one-to-one invariant between a shipping-stage issue and its
one active order. `shipping` is inserted between `review` and `done` in
`IssueStage`, but ordinary issue update/claim/start commands cannot enter or
leave it. This is the same kind of deliberate lifecycle boundary as `proposed`:
it looks simple everywhere because one purpose-built command owns its rules.

Permissions are resolved live for the requester's principal whenever an outward
mutation occurs. The order stores attribution and delegation bounds, never a
serialized capability snapshot. This follows the repository's existing
principal and no-capability-snapshot rules.

## Reliable execution

### At-least-once, made safe

Exactly-once process execution is not a useful promise across crashes. The
workflow is at-least-once and every effect is safe to replay:

- each step has an idempotency key and expected base/head input SHAs;
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
- the branch base and tip still equal the reviewed layer's expected source
  pair;
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

## Git stacks: support them, do not become them

“Stack” is overloaded here. A **Git/PR stack** is a development and review
structure: an ordered chain of small branches where each layer is based on the
one below it. A **Ship batch** is a temporary execution plan for reviewed work
that can safely share composition and validation. A **merge queue** serializes
ready changes into a protected destination. They complement one another, but
they are not the same object.

GitHub released native Stacked PRs into public preview on July 30, 2026. Its
very new `gh stack` CLI can create, rebase, submit, navigate, and merge a branch
chain; the async merge API merges or enqueues the whole contiguous prefix
through a selected PR. Availability and merge-queue support are still rolling
out, and the CLI repository's older private-preview note currently lags the
product docs, so Podium must feature-detect it and treat it as an optional
provider capability rather than a foundation. See GitHub's
[public-preview announcement](https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview/),
[stack concepts](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs),
[`github/gh-stack` CLI](https://github.com/github/gh-stack), and
[asynchronous merge API](https://github.github.com/gh-stack/reference/merge-api/).

Podium should handle stacks as follows:

- derive a delivery chain from Podium branch ancestry today; when a repository
  uses GitHub Stacked PRs, ingest its stack id, position, ultimate base, and
  pull-request webhook data through a provider adapter, then reconcile the REST
  object because there is no separately documented stack event;
- store delivery-order edges on `ShipOrder`/`ShipBatch`; do not turn branch
  ancestry into issue parentage or product `blocks` dependencies;
- identify every reviewed layer by its source base **and** head. A head alone
  describes the accumulated stack, not the discrete diff the reviewer judged;
- compose each layer's delta after its declared dependencies, never every
  stacked branch as a trunk-relative patch that repeats lower-layer changes;
- never reorder or split a declared chain across a lower unlanded layer. A ship
  batch may contain a contiguous stack prefix plus independent work, but stack
  order wins. After a partial landing, invalidate and recompose every remaining
  descendant against its automatically changed base;
- interpret one `issues.ship` invocation as authority for that issue only. If lower
  layers lack ship authorization, the order waits behind them; Podium must not
  silently use GitHub's “merge through this PR” operation to land work the user
  did not authorize;
- when all prerequisite layers already have authorized orders, the scheduler
  may compose the complete eligible prefix and the right dock can summarize it
  as one chain;
- preserve exact-SHA fencing across restacks. A changed descendant SHA
  invalidates its attempt and required evidence; patch-equivalence may reuse
  deterministic caches only under repository policy, never human approval by
  assumption;
- initially consume native GitHub stacks as read-only delivery dependencies.
  Put mutation and merge support behind capability detection, delegate landing
  to the provider's async stack/merge-queue API, and reconcile its terminal
  result. `enqueued` means accepted by GitHub's queue, not shipped;
- preserve separate submitted-head, tested-integration, landed-ref, and
  destination SHAs. Local ff-only repositories can prove exact current-ref
  ancestry; squash/rebase provider modes rewrite identity and require the
  provider receipt plus destination verification instead;
- never run a competing Podium merge train on top of GitHub's merge queue. Once
  provider policy owns landing, Podium hands off, monitors, and reconciles.

This gives Podium compatibility with GitHub, Graphite, git-spice, ghstack,
Jujutsu, and plain chained branches without making any one stack tool the
product model. The Ship service begins after review; stack tooling improves how
the work reached review. Creating, navigating, reordering, and restacking those
review branches stays in GitHub or a specialist developer tool; the quiet
Shipping dock does not grow those authoring controls.

## Validation after handoff

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

### Boundary with review: accepted input, not owned UX

Shipping neither creates nor presents review proof. The normal review system
hands it one typed, accepted input:

```ts
type ApprovedDeliveryInput = {
  issueId: IssueId
  sourceBaseSha: string
  sourceHeadSha: string
  policyId: string
  evidenceManifestRef?: string
  previewLeaseIds: PreviewLeaseId[]
}
```

The ship command freezes this input; it does not reinterpret whether the proof
was good. Existing preview work remains an independent normal-UX project.
Shipping only needs a lifecycle hook to stop accepted preview leases after
verified delivery or explicit cancellation. Review changes can therefore ship
independently and are not a prerequisite for the background service.

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

## UX: confidence without supervision

Shipping is a service, not a destination. It gets no primary navigation item,
full-width workspace, task board, or second working-task metaphor. It gets a
new **Shipping** cell in the existing right rail, immediately beside the
unchanged **Queues** cell. Queues continues to own merge locks, heavy-test
leases, and other developer resource lanes; Shipping shows only delivery
orders.

Shipping uses a Lucide-compatible perspective-road glyph: converging road edges
and a broken center line, rendered with the same 17px rail and 16px dock-header
metrics as its siblings. A small neutral-grey badge shows the number of
unfinished deliveries in the active repository scope—waiting, in progress, and
held—and is hidden at zero. It excludes retained shipped history. This count
describes the Shipping panel's own visible inventory, unlike a portfolio badge
placed on an unrelated tool.

### The handoff receipt

The review interaction is out of scope here. Whatever normal Podium surface
caused `issues.ship`, it receives the same result:

- issue stage changes to `shipping`;
- a transient confirmation says **Shipping · Podium owns it now**;
- `podium issue show` exposes the destination and compact shipping summary;
- focus, open panel, workspace, and navigation do not change.

There is no modal, policy form, progress ceremony, or second confirmation on the
normal path. If admission fails, the command refuses before changing stage and
states the one condition that must be fixed.

### Right dock: calm progress on demand

The Shipping dock remains collapsed after handoff. When opened, its sections
are, in order: conditional **Needs you**, **In progress**, ordered **Waiting**,
and bounded **Recently shipped** at the bottom. Rows are grouped or scoped by
repository and destination because independent lanes have no honest global
rank. A Waiting row shows position and elapsed wait—**Next · waiting 8 min** or
**#2 · waiting 5 min**—but never invents an ETA or a reorder control.

The four visible states have one visual grammar: neutral hollow marker for
Waiting, one blue active marker for In progress, destructive red attention for
Needs you, and a success check for Shipped. Shape, section, and visible words
carry the meaning, not color alone. Two active rows may both be blue: blue means
exactly “Podium is actively handling this,” while plain activity text says
which step.

Raw engine phases do not leak into the overview. The stable mapping is:

| Engine state | Human activity |
|---|---|
| `queued` | Waiting for its turn, with lane rank and elapsed wait |
| `preflight` | Checking the approved changes |
| `composing` | Combining related changes |
| `validating` | Running checks |
| `repairing` | Trying a safe fix |
| `landing` | Applying the checked changes |
| `publishing` | Sending to the configured destination |
| `verifying` | Confirming the configured destination |
| `held` | Needs your decision |
| `shipped` | Shipped |

Exact SHAs, logs, model attempts, and batching are one **Technical details**
disclosure inside an individual shipment. They exist for diagnosis, not
reassurance. The only everyday controls are **Cancel shipping** while still
safe and **Return to issue** after a hold; administrators configure budgets and
pause policy in settings rather than managing the live list.

The normal road glyph is neutral; its grey unfinished count is informational,
not an alert. It has no spinner, progress ring, or completion badge. Slow is not
failure. The dock says what Podium is doing and how long a queued item has
waited, but it does not promise a fake ETA.

The interactive prototype walks the intended surface through nine moments:
quiet handoff with the dock closed; optional overview; ordered waiting detail;
active-order inspection; the existing alert with a red rail glyph; focused hold
resolution; automatic resumption; verified completion; and the completed
item's delivery receipt. The workspace never changes in any of them. Opening a
delivery row replaces the dock body and provides **All shipping** as the way
back; it does not open a nested panel or second sidebar.

### Alerts: existing Podium machinery

Only a terminal-for-now hold changes the rail glyph to destructive red. This is
a binary fact about the Shipping panel—not an ambiguous portfolio count—and it
stays red until the hold is resolved. Its accessible label becomes **Shipping ·
action required**, including both unfinished and decision counts. The inventory
badge remains grey; the existing alert transport, not the changing count,
announces the hold.

The shipping service does not invent another alert center. It sets the issue's
existing `needsHuman` state, emits the normal `issue.needs_human` event, and uses
Podium's notification-fact arbitration. That already gives the hold configured
web/external notification delivery. A transient alert popup may announce it,
but the durable issue, Tray, and ship order remain the source of truth.

Do not fake a waiting asker. Today's generic `needsHuman` question sends an
answer back to `humanQuestionAskedBy`; Shipping intentionally has no live
session. The normalized `ShipHold` therefore owns its typed actions and expected
generation. `shipSummary.hold` lets the Task surface and Tray render a
`ship-hold` item instead of the generic question, and
`issues.resolveShipHold(orderId, action, expectedGeneration)` dispatches to the
shipping service. Only a successful resolution clears `needsHuman`. This reuses
Podium's attention transport while keeping the reply path deterministic and
race-safe.

The alert is deduplicated by order plus reason code and contains:

- the outcome headline;
- cause in one sentence;
- what deterministic repair and any model already tried;
- the smallest evidence link;
- 2–4 mutually exclusive safe actions.

Examples: **Let Podium retry**, **Return to issue**, or **Open repair**. The
service may include a choice specific to the failure, but it never offers raw
“take mine/theirs” for a semantic conflict. Independent shipments keep moving.

### Mobile

The mobile Tray shows holds, not routine progress. A final destination receipt
may appear in activity/history without becoming attention. The same Shipping
summary is optional on mobile, and a phone user can answer a hold without
opening a terminal.

## Observability and controls

Internal diagnostics and settings should answer:

- queue age and depth per repo/target;
- current and historical step durations;
- batch size, validation cache hit rate, invalidation rate, and isolation runs;
- daemon job heartbeat, memory/load admission delay, and last progress;
- deterministic completion rate versus L1/L2/L3 escalation;
- model tokens, latency, provider, effort, patch acceptance, and human override;
- merge-lock hold duration (the key regression metric);
- orders held by reason and time-to-human-answer;
- destination verification and cleanup outcomes.

Global pause, per-repo pause, concurrency, resource budgets, model-token budgets,
and retry ceilings are policy—not hidden constants. They live in settings and
diagnostics, not in the everyday Shipping peek. Watchdogs care about monotonic
workflow progress, not whether a timer thread is alive.

## Failure policy

| Failure | Automatic response | Human sees |
|---|---|---|
| Server/daemon restarts | reconcile durable attempt and host/git truth | nothing unless recovery stalls |
| Daemon offline | keep order waiting; retry placement on owning machine | existing alert after recovery threshold |
| Source tip changed after approval | stop; never substitute the new source | existing `needsHuman` alert + **Return to issue** |
| Target tip changed | discard merge group and recompose | no hold unless retry ceiling reached |
| Dirty issue worktree | wait for finishing session, then hold | existing alert with files + **Return to issue** |
| Composition conflict | deterministic repair, then bounded shipwright | existing alert only if unresolved/semantic |
| Validation failure | classify, repair/isolate, land independent green work | existing alert for smallest failing/interaction set |
| Host pressure | admission delay; no agent waiter | “waiting for capacity,” not “stuck” |
| Advisory lease expires | stop new effects; reconcile/CAS before retry | only if progress ceiling exceeded |
| Publish rejected | refresh/recompose or use configured provider adapter | existing alert with exact destination error after retry ceiling |

## Build plan

Each slice is independently reviewable and keeps authority narrow.

### Slice 1 — durable single-order shipping

- Add the guarded `shipping` issue stage and its lifecycle transition tests.
- Add the shared `issues.ship` contract plus `podium issue ship` CLI/MCP entry,
  optional issue id, existing `--outside-scope` confirmation, and delivery-root
  admission guard.
- Shipping model/protocol/module skeleton and compact replica projection.
- Queue/cancel/retry, explicit policy resolution, audit events.
- Daemon preflight and job journal with source/target SHA fences.
- One issue through existing guarded ff-only landing and destination proof.
- Deterministic receipt, basic Shipping-dock row, and `needsHuman` alert bridge.

Success: an accepted single order survives server and daemon restart and either
ships or produces one existing Podium alert; `review → shipping → done` is
atomic and no agent polls.

### Slice 2 — landing checkout and exact commit protocol

- `ship doctor`, landing-checkout adoption, and compatibility mode.
- Shadow merge-group refs, branch custody/freeing, compare-and-swap ref moves.
- Named validation profiles, receipts, resource admission, publish adapters.
- Recovery fault matrix across every step boundary.

Success: local ff-only landing publishes the exact tested SHA and proves current
issue tips are ancestors of the destination; provider landing records its
provider-specific rewrite receipt and destination proof. In both modes, the
merge lock excludes validation time.

### Slice 3 — adaptive train

- Dependency/FIFO grouping and compatibility planner.
- Full-group validation, cached prefix groups, adaptive failure isolation.
- Interaction-set handling and safe recomposition of independent work.
- Shipping-dock summaries, history, metrics, and pressure-aware scheduling.

Success: a dozen compatible green issues need one composition/validation group,
while one bad or interacting subset does not block independent work.

### Slice 4 — shipwright escalation

- Personal shipwright role, trait/quota router, budgets, and eval set.
- Attempt-scoped repair refs and structured model contracts.
- Mechanic/Solver/Inspector ladder via existing headless harness execution.
- Behavior-change detection and one-card human pushback.

Success: common conflicts recover without reopening the original session; models
cannot land or publish and their output is always deterministically revalidated.

The independently shippable implementation work is tracked as proposals:

- POD-830 (Durable ship orders) — slice 1 and the common foundation;
- POD-831 (Exact landing executor) — slice 2, blocked by POD-830;
- POD-832 (Adaptive merge trains) — slice 3, blocked by POD-831;
- POD-833 (Bounded shipwright repairs) — slice 4, blocked by POD-831;
- POD-834 (Supervised preview proofs) — related normal review UX, explicitly
  outside the Shipping critical path;
- POD-835 (Shipping sidebar panel) — the production UI/UX, blocked by POD-830.

## Acceptance story

A convincing end-to-end demonstration begins only after review:

1. A finishing coordinator runs `podium issue ship` on an approved top-level
   issue and receives **Shipping · Podium owns it now**. The issue atomically
   enters `shipping`; the current workspace and right dock do not change.
2. From a nested sub-issue, prove that the same no-id command refuses and names
   the delivery root. Then prove that another authorized agent can deliberately
   nominate that approved root with `podium issue ship POD-900 --outside-scope`;
   the flag is recorded and does not bypass admission.
3. The agent exits. The human continues elsewhere. The perspective-road glyph
   remains neutral while its grey count reflects unfinished deliveries; there
   is no spinner or routine notification.
4. Much later, the human optionally opens Shipping and sees **Everything is
   handled**, plain **In progress** activities, a destination-scoped ordered
   **Waiting** stack with elapsed waits, and **Recently shipped** at the bottom.
5. Stop and restart the server and daemon mid-delivery. Orders recover without
   reviving the original sessions or changing the user-facing contract.
6. Inject a mechanical conflict. A bounded shipwright repairs it, deterministic
   validation passes, and no alert is produced.
7. Inject a semantic conflict that exhausts the repair budget. The issue remains
   `shipping`, `needsHuman` creates the existing Tray/notification alert, and
   only the Shipping rail glyph turns red.
8. Resolve that one alert. Independent shipments have continued; the held order
   recomposes, publishes, verifies the configured destination, and moves to
   `done`.
9. Open the completed row and confirm its own Delivery receipt contains the
   approved, tested, landed, and verified destination references; no global
   receipt appears on the overview.
10. Confirm every transition is attributable and replay-safe, the exact local
   destination proof or provider receipt is recorded, and no forcing operation
   was used.

That story proves the initial problem is solved: shipping continues in the
background, failures are recoverable, tokens are spent only on judgment, and the
human supervises outcomes instead of babysitting mechanics.
