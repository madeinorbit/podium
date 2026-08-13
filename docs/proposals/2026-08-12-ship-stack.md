# The Ship Stack — autonomous landing as a Podium service

> Proposal, 2026-08-12. Answers: "how do I stop babysitting a dozen reviewed
> features into main?" and "how should an agent hand over proof at review?"
> Grounded in what Podium already has — nothing here needs a new agent framework.

## 1. What is actually wrong

The complaint reads as one problem ("shipping is painful") but it is four, and
they have different fixes:

| # | Failure | Why it happens today |
|---|---|---|
| 1 | Waiting on the merge lock / `test:heavy` lease | The waiter is a **live agent process** holding a full context while it polls. |
| 2 | Waiters die — OOM'd, reaped, exit 144 | Same reason: the thing waiting is a heavyweight process on a shared host. |
| 3 | Trivial blockers stop everything (dirty tree, stale local `main`, needs rebase, repo root on the wrong branch) | Each needs an agent turn to notice and repair, though every repair is deterministic. |
| 4 | Re-engaging a finished session costs a fortune | After ~5 minutes the prompt cache is cold, so "please land this" pays to re-read the whole conversation. |

## 2. The one insight

**Shipping is the only phase of the work whose inputs are completely known.**

It needs a branch, a parent branch, a gate command, a mutex, and a failure
policy. It does not need the issue's conversation, its design debate, or its
1M-token context. Paying for that context to land a branch is pure waste — which
is exactly complaint 4, generalized:

> The thing that ships an issue must not be the issue's agent, and in the common
> case must not be an agent at all.

Podium's own orchestrator design already states this doctrine
(`docs/internal/superpowers/specs/2026-07-02-orchestrator-agents-design.md`
§5.2 handler tiers, §5.4 "the steward is not an agent"). It also lists Gas
Town's **Refinery — serializes the merge queue** in the pattern table with
Podium's column marked *manual trigger*. The Ship Stack is that missing row.

## 3. Shape: four layers, cheapest first

```
  human ──"ship it"──▶ ┌──────────────────────────────────────────┐
                       │ 1. SHIP REQUEST   durable intent on the  │
                       │                   issue (not a stage)    │
                       └────────────────┬─────────────────────────┘
                                        │
                       ┌────────────────▼─────────────────────────┐
                       │ 2. THE SHIPPER    server-side service,   │  ← 95% of traffic
                       │    deterministic  no LLM, cannot OOM,    │    zero tokens
                       │                   survives restarts      │
                       └────────────────┬─────────────────────────┘
                                        │ conflict · red gate · ambiguity
                       ┌────────────────▼─────────────────────────┐
                       │ 3. THE SHIPWRIGHT headless PTY-less      │  ← bounded turns,
                       │    exception      session, tiny          │    tiny context
                       │    handler        task-shaped context    │
                       └────────────────┬─────────────────────────┘
                                        │ budget spent / needs a decision
                       ┌────────────────▼─────────────────────────┐
                       │ 4. PUSHBACK       ONE needs_human card    │  ← chip answer,
                       │                   with answer chips       │    ~0 tokens
                       └──────────────────────────────────────────┘
```

Every layer already has its substrate in the repo:

- **L2** is the steward/janitor pattern: durable cursor, boot one-shot →
  interval, time-budgeted job, fenced single writer
  (`apps/server/src/steward.ts`, `apps/janitor/src/janitor.ts`). Its actuators
  are the daemon's **already-allowlisted** repo ops — `rebase`, `mergeFfOnly`,
  `isMergedInto`, `revParseVerify`, `worktreeRemove`, `branchDelete`, `prCreate`
  (`apps/daemon/src/repo-op.ts`). It takes the mutex through the real lock
  service, which already supports FIFO queueing, grant-on-release, mail to the
  next waiter, lazy expiry, and **system lock sessions** so an in-process job can
  legitimately hold a lease (`apps/server/src/modules/lock/service.ts`).
- **L3** is `HeadlessService` (`apps/server/src/modules/superagent/headless.ts`)
  — persistent, PTY-less session rows the server drives turn by turn. No spawn
  message ever reaches the daemon.
- **L4** is `needs-human --question --options`, which already renders as answer
  chips in the Task dock and the mobile Tray.

## 4. The ship request: a new axis, not a new stage

Do **not** add a `ship` stage. Stage says *where the work is*; the ship request
says *what the human decided*. Making it a stage breaks every stage-shaped
surface and makes "in review **and** queued to ship" unsayable.

```ts
/** Derived + persisted alongside gitState; wire-projected the same way. */
export const IssueShipRequest = z.object({
  state: z.enum(['queued', 'landing', 'landed', 'held', 'abandoned']),
  requestedBy: UserIdField,        // or agent:<kind> under autonomy
  requestedAt: z.string(),
  policy: z.object({
    gate: z.string().optional(),   // default: repo's agent gate (`bun run test`)
    push: z.enum(['never', 'after-land']).default('never'),
    cleanup: z.boolean().default(true),   // worktree + branch after landing
    escalationTurns: z.number().int().default(2),  // shipwright budget
  }),
  attempts: z.array(ShipAttempt).default([]),   // audit: step, output, at
  held: z.object({ reason: z.string(), question: z.string() }).optional(),
})
```

`push: 'never'` as the default matters on this host: the operator directive here
is *land locally, never push main*. Policy is per repo, overridable per request
— the shipper must never widen what it was authorized to do.

**The UX promise this buys:** an issue with a ship request **leaves the human's
decision queue**. `issuePendingDecision()`
(`packages/client-core/src/viewmodels/slices/issues.ts`) returns `null` for it —
it is the shipper's problem now. That is literally "once you put it in the
shipper, you are good".

## 5. The train, not the line

The multiplier. A dozen ready branches must not be twelve lock acquisitions and
twelve heavy-test runs.

1. Take `merge:main` **once**.
2. Refresh the landing checkout (`fetch` + `merge --ff-only origin/main` — never
   a reset; the existing rule stands and is now enforced by code rather than by
   an agent remembering it).
3. Rebase each queued branch onto the moving tip, in dependency order (the issue
   DAG already gives this ordering).
4. Take `test:heavy` **once** and run the gate **once**, on the combined tip.
5. Green → ff-merge every branch in, close every issue, release both leases.
6. Red → **bisect the train**: split, re-gate the halves, land the good half,
   isolate the offender and hand only that one to L3. One bad branch stops
   itself, not the other eleven.

This is where "a dozen features I have to babysit" becomes one operation, and it
is also the real fix for lock contention: the queue that used to be twelve
polling agents becomes one service holding one lease.

Scheduling is pressure-aware — the per-machine load/memory indicators already
exist (`apps/web/src/features/machines/HostIndicators.tsx`); the shipper defers
a gate run on a host under memory pressure instead of racing it and getting
reaped. That is complaint 2, solved by not having a process to kill.

## 6. A dedicated landing worktree (kills a whole failure class)

Today `IssueWorkflow.action('merge')` **refuses** when the repo root is not on
the parent branch, with a comment explaining why it cannot just check it out:
the root is the live deployment-source checkout and switching its branch can
crash-loop the backend (`service/workflow.ts:491`). The ff-merge also aborts
when untracked files in the root would be overwritten — the case AGENTS.md
spends a paragraph warning agents not to `rm` their way past.

Give the shipper its **own** checkout of `main`, created once, used only for
landing, never opened by a human or an agent. Then:

- the root's branch is irrelevant — no refusal, no guard;
- there are no untracked files to collide with — no hazardous repair;
- the shipper is the only writer in it, so "dirty worktree" cannot happen there.

**This is not hypothetical.** On 2026-08-13 the shared `main` checkout carried
~150 dirty/untracked paths from another agent's parked WIP, and POD-941's
landing aborted twice in fifteen minutes on it: first `merge --ff-only` refused
because two tracked files (`schema.ts`, `drizzle-manifest.generated.ts`) would
be overwritten, then the rebase conflicted on the generated migration manifest.
The landing agent did the right thing both times — byte-compared, refused to
stash or force, released the lease, and **asked**. That is a correct agent and a
broken arrangement: the question it had to ask ("may I stash those two files?")
only exists because landings happen in a checkout other people live in. It cost
a lock acquisition, a rebase, an abort, and an hour of blocked delivery.

The same day, the sweep that cleaned that checkout **deleted this document** —
it was untracked, so it went with the rest. It was recovered from the artifact
snapshot store, which is the only reason you are reading it. Both incidents are
one fact: *the shared checkout is not a workspace, and anything that has to live
in it is at risk.* A landing worktree nobody else opens makes the first question
unaskable; committing deliverables rather than leaving them untracked prevents
the second.

The remaining dirty-tree case is the *issue's* worktree, and the shipper's
allowlist there is deliberately narrow: if the dirty files are all ignored or
build output, proceed; otherwise **hold and ask**, listing the files. It never
discards, never stashes (the stash stack is shared across worktrees in this
repo and holds other agents' parked work), never force-anything.

## 7. Escalation with a budget, and pushback that costs nothing

The shipwright (L3) gets a bounded number of headless turns — default 2 — and a
context assembled from the failure, not from the issue: the conflict hunks, the
failing gate output, the issue `brief`, the diff. Nothing else. It resolves
rebase conflicts and obvious gate breaks, then hands back to L2 to re-run the
train. Budget exhausted, or a judgment call that changes behavior → it stops.

Pushback is **one card, never a chat**:

```
POD-627 held: conflict in IssueRow.tsx (3 hunks, both sides touched the density prop)
  [ Take mine ]  [ Open a session ]  [ Drop from the train ]
```

Answering a chip is a click. No cache warm-up, no re-read, no session resume —
which is precisely the cost complaint. The card lands in the Tray, which is
already the "needs a human" surface and already refuses to show anything else.

## 8. Surfaces

`MergeQueuePanel` (`apps/web/src/features/merge-queue/`) already reads every
lease and every ready candidate. It becomes the **Ship Stack**: what is in the
train, which step it is on, what is held and the one question it is held on,
what landed. Every attempt is an event-log row plus an issue comment, matching
the audit doctrine the steward already follows.

## 9. The agent contract gets *smaller*

Today AGENTS.md carries a five-step landing procedure with seven NEVER clauses,
because agents perform landings. With the shipper, an agent's job ends at:

```
podium ship <id> --proof <…>
```

That entire hazardous procedure — the rebase, the ff-only merge, the
`--is-ancestor` verification, the reset prohibition, the untracked-file
byte-comparison — collapses into one command and moves into code that is tested
once instead of re-derived by every agent under context pressure. This is an
architecture-level simplification, not a feature.

---

# Part 2 — proof at review time

## 10. The gap

`IssuePanelArtifact` snapshots *files* into a permanent store served over
`/files/artifact` (`packages/model/src/entities/issue-vocabulary.ts:122`). Good
for shots, concept HTML, markdown. There is no way to hand the user a **running
thing**, so today they have to ask for it, or go hunting for the worktree and
start it themselves.

## 11. Proof should be typed, not freeform

"The agent decides the best way of offering proof" is right, but the choice must
come from a small vocabulary — a free choice is how you end up with "I tested it
manually, trust me". Three classes, matched to the change:

| Change class | Proof | Cost to produce |
|---|---|---|
| Logic / deterministic | the gate run + the diff | **zero** — the shipper's own gate run *is* the proof |
| Visual | artifact snapshot | already works |
| Interactive / behavioral | **live preview URL** | the gap below |

Make it a checked contract at the review transition, the same way §5.5 of the
orchestrator design promotes completion notes from convention to contract: an
issue entering `review` without proof is a lint violation the steward nudges on.

## 12. The preview URL

Add a kind to the artifact record rather than a parallel concept:

```ts
kind: z.enum(['file', 'url']).default('file'),
preview: z.object({
  url: z.string(),
  machineId: MachineIdField,     // the URL is only meaningful next to its host
  status: z.enum(['starting', 'live', 'stopped']),
  expiresAt: z.string(),
}).optional(),
```

It then rides every surface that already renders artifacts — the issue sidebar
**and** the offer card's artifact strip (`OfferArtifactStrip.tsx`,
`offer-artifacts.ts`) — so "here is the thing, click it" is the default hand-off
shape and the user never asks for a URL again.

**Producing it is unusually cheap for Podium specifically**, because the
multi-instance story is already built: identity-derived port triplets,
`--instance <id>`, from-source runs, and a documented isolation contract
(`docs/multi-instance.md`). A `podium preview <issue>` starts a from-source
instance of that issue's worktree on its derived ports, registers the URL on the
issue, and lets the janitor's existing worktree-GC cadence reap it on TTL or
when the issue lands. For non-Podium repos the same mechanism generalizes as a
declared command in repo settings (`preview: { cmd, port }`) next to
`gitWorkflow`.

**The one genuinely hard part** is reachability: the URL must work the way the
user already reaches Podium (remote machine, tunnel, phone). Register the
preview against the machine that owns the worktree and surface it through the
same routing rather than inventing a second story.

---

## 13. Build order

| Phase | Ships | Removes |
|---|---|---|
| 0 | Ship request record + `podium ship` + L2 landing **one** issue, proper lock discipline, dedicated landing worktree | babysitting, the wrong-branch refusal, the untracked-file hazard |
| 1 | The train: batching, dependency ordering, one gate per batch, bisect on red | eleven redundant gate runs and lock acquisitions |
| 2 | L3 shipwright (bounded headless turns) + L4 pushback cards | the expensive session resume |
| 3 | Typed review proof + preview URLs | "can you give me a link?" |

Ship Stack panel grows out of `MergeQueuePanel` throughout.

## 14. Risks and open decisions

- **Autonomous landing is destructive-adjacent.** §5.4 says destructive actions
  are decision gates. Resolution: *the human's `ship` is the gate* — one explicit
  authorization per issue, and the shipper may never exceed it (rebase yes;
  force-push, reset, and landing a branch it was not handed, never).
- **Two writers on main.** The lock is advisory. An agent that lands by hand
  still honors it, so nothing breaks — but the real fix is the prime text
  telling agents their job ends at `ship`.
- **Open: does landing close the issue?** Today `action('merge')` auto-closes.
  Under a train, a branch can land while the issue still owes a doc. Suggest
  landing sets `shipRequest.state = 'landed'` and closes only when the issue has
  nothing else open — otherwise the closed-with-work-left case returns.
- **Open: who owns the gate command per repo?** Reuse the agent gate
  (`bun run test`) or a distinct, heavier ship gate. A heavier gate is more
  honest for a train of twelve, and the train is what makes it affordable.
