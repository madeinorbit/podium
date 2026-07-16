# Delegating to other agents (for agents)

You can spawn other agents onto an issue with `podium agent spawn`. Podium deliberately
has **no agent roles, no write-claim, and no activity-based auto-isolation**
([spec:SP-4ef9]). Nothing about your delegate is inferred from how it behaves: placement
is fixed by the spawn decision, and what the delegate *is* rides its session title.

The consequence is the whole point of this guide: **what you tell the delegate is the
only lever you have.** A vague prompt does not produce a vague teammate — it produces one
that shares your files, has no name on the board, and does not know you exist.

Every spawn prompt should carry four things.

## 1. Placement — where it works

```
podium agent spawn --prompt "…" --issue <ref> [--worktree]
```

By default your delegate **shares this issue's workspace** — the same branch, the same
worktree, the same working files you are editing. That is usually what you want for a
reviewer, a researcher, or a spec author.

`--worktree` does **not** isolate it, and this trips people up. The flag only asserts
that the issue *has* a worktree, turning a silent spawn into the repo root into a loud
failure. The delegate lands in the issue's worktree either way. Pass it for the loud
failure; never pass it expecting isolation.

To isolate a delegate that will **implement concurrently** with you or another
implementer, give it its own **issue**. This is one command, not two:

```
podium issue create --title "…" --parent-id <your issue> \
  --description "<the full brief — this becomes the agent's first prompt>" --start
```

`--start` does three things at once: it creates the branch and worktree, **and spawns
exactly one agent on it**, using the issue's `--description` as that agent's first prompt
(`issue start` always spawns — there is no start-without-agent option). So the brief goes
in `--description`.

> **Do not follow `--start` with `podium agent spawn --issue <sub>`.** That spawns a
> *second* agent into the same worktree, and the two will silently clobber each other.
> This is not hypothetical: it is the most common way to cause the exact damage the rest
> of this guide is about. If you want one agent on a new isolated issue, `--start` alone
> is the whole recipe.

`podium issue start` is what creates a branch and worktree; `spawn` deliberately never
forks one. The reason is the entity model, and it is worth holding on to because it
answers most placement questions on its own: **a branch is owned by an issue, and a
session never owns one.** So a delegate that needs its own branch needs its own issue —
there is no way to give a *session* a private branch, by design. The happy side effect is
that isolation shows up on the human's board as a sub-issue, which is a unit they already
read, instead of as invisible worktree plumbing. [spec:SP-4ef9]

Use `agent spawn --issue` to add a delegate to an issue that is **already started** —
i.e. deliberately, when you want a second session sharing that workspace (a reviewer
alongside an implementer). At that point section 3 applies: say who owns which files.

## 2. Naming — how the board reads

Name the delegate **at spawn**, so it is never anonymous on the board:

```
podium agent spawn --issue <ref> --title "Reviewer: auth flow" --prompt "…"
```

`--title` names the *session*. Do not confuse it with `--new "title"`, which names an
*issue*. A name you pass is agent-sourced, so it never overwrites a name the user set by
hand, and the delegate may still re-title itself as its work becomes clear.

The isolated path has **no equivalent flag** — `podium issue create --start` names the
issue, not the session it spawns. There, tell the delegate to title itself as its first
action, in the `--description` that becomes its prompt:

> First action: run `podium session title "Spec author"`.

That is also the fallback whenever you want a delegate to name itself once it understands
its own job better than you did. `podium session title` only ever renames the *calling*
session — you cannot retitle a delegate after it has started, so if you care about the
board, pass `--title` at spawn.

Session titles follow the usual rule — 3–5 words naming the thing, not the activity, and
they must distinguish this session from its siblings on the same issue. A board of
`Spec author` / `Reviewer: auth flow` / `Migration backfill` reads like a team; a board
of three untitled `claude session` rows does not.

## 3. Concurrency — who may write what

If two sessions share a workspace, **nothing serializes their writes.** There is no
write-claim and no lock on the filesystem; two agents editing one file will clobber each
other. If that is possible, prescribe the arrangement explicitly. Either assign file
ownership in the prompt:

> You own `apps/cli/src/agent-cli.ts` and its tests. Do not touch
> `apps/server/src/modules/issues/**` — POD-694 is editing it. Mail it if you need a
> change there.

…or have both sides take an advisory lease ([spec:SP-85d1]):

```
podium lock acquire migrations --ttl 10m --wait   # queued if held; 0 granted, 3 queued, 4 timed out
podium lock release migrations                    # release IMMEDIATELY; the next waiter is granted
```

`podium lock` takes **any** name — `podium merge-lock` is only sugar for the lock named
`merge:<branch>`. Also available: `renew`, `cancel`, `status`, `steal`.

Two properties to design around: leases are **advisory** (nothing enforces them — they
work only because both sides agreed to take them) and they **expire** (default 2m; pass
`--ttl` or `renew` for long work).

## 4. Team awareness — who else exists

A fresh session knows its issue. It does not know it has colleagues. Tell it:

- **Who else is on the issue**, and what each is doing — so it does not redo their work.
- **Which machine** they run on — cross-machine agents cannot see each other's files.
- **That mail is how to reach them**: `podium issue mail send <id> --body "…"`. Say this
  explicitly. A delegate that discovers a problem in someone else's file should mail the
  owner, not fix it.

## A worked brief

An isolated implementer. One command — the `--description` *is* the agent's first prompt:

```
podium issue create --title "Child session name at spawn" --parent-id 694 \
  --audience human --agent grok --model grok-4.5 --start \
  --description "
You are implementing POD-699 (Child session name at spawn). Read \`podium spec show SP-eb60\`
(title doctrine) first.

FIRST ACTION: podium session title \"Spawn child naming flag\"
(this path spawns via --start, which names the issue, not the session — so you name
yourself; a delegate spawned with 'agent spawn --title' arrives already named.)

VERIFIED FACTS (do not re-litigate; confirmed at all three layers today):
- 'podium session title' names ONLY the calling session, deliberately — session-cli.ts:208-211.
- 'agent spawn' has no title flag — allowlist agent-cli.ts:62-77, zod gate.ts:41-56.
- createSession already accepts title (service.ts:846), but 'name'+'nameSource' is the
  CURATED slot and wins in the UI (router.ts:285). Land it in 'name', not 'title'.

YOUR WORKSPACE: you have your OWN branch and worktree — you are isolated, so you can edit
freely without coordinating file ownership.

YOUR TEAM (all on machine ludovico): POD-694 is your parent; it is editing prose only, so
it will not touch your code. POD-665 runs concurrently on the spawn path and may touch code
near yours — if you need a change in its files, mail it, do not edit it:
podium issue mail send 665 --body '…'.

CONSTRAINTS: do not merge, do not deploy. Tests required. Vitest runs under bun here:
'bun --bun vitest run …', never 'bun test'.

WHEN REVIEW-READY: podium issue mail send 694 --body '<what changed, file:line, test
results verbatim, what you could not do>'. If a test fails, say so with the output.
"
```

## Rules of thumb

- **Count your agents.** After spawning, confirm you created the number you meant to:
  `podium session status "#<issue>"`. The author of this guide spawned two agents onto
  one issue 22 seconds apart — `--start` spawned one, and an `agent spawn --issue` on top
  spawned another — and they clobbered seven files before anyone noticed. The tell was a
  session id in the spawn output that did not match the one in `session status`. If those
  disagree, you have two agents.
- **Delegate a job, not a task list.** State the goal, the constraints, and what "done"
  looks like; let it find the path.
- **Carry your verified facts across.** You paid to learn them; a delegate that
  re-litigates them burns the same tokens again. Cite `file:line`.
- **Tell it what NOT to do.** Do not merge, do not deploy, stay in your worktree.
- **Ask for honest reports.** Ask for test output verbatim and for what it could not do.
