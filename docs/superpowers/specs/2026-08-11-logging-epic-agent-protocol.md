# Logging Epic — Agent Protocol

**Epic:** POD-1897 (Logging strategy and pipeline)
**Applies to:** every implementation sub-issue (POD-1900 … POD-1906)

The coordinator session on POD-1897 runs this epic. Read this file before
starting work; it defines how your chunk is scoped, verified, and landed.

## Read first

- `docs/superpowers/specs/2026-08-11-logging-strategy-design.md` — approved
  design. It is authoritative; if your chunk seems to need a deviation, mail
  the coordinator rather than improvising.
- `docs/superpowers/specs/2026-08-11-logging-strategy-plan.md` — find *your*
  chunk and stay inside it. Other chunks belong to other agents; touching
  their files causes merge pain and duplicated work.

Downstream chunks depend on the APIs earlier chunks publish, so match the
spec's record shape, level names, and sink interface exactly.

## Integration branch — not main

This epic integrates on **`worktree-pod-1897-logging`**, not `main`. Your
branch is based on it.

- Do **not** rebase onto, merge into, or push to `main`.
- Do **not** force-push. Do **not** cherry-pick.

## Landing your chunk

You land your own work when it is complete and tested:

1. `podium lock acquire merge:worktree-pod-1897-logging --wait --ttl 10m`
2. `git fetch origin`
3. Rebase your branch onto `origin/worktree-pod-1897-logging`.
4. Re-run the verification gates (step order matters — the rebase may have
   pulled in another chunk that breaks yours).
5. Fast-forward-only merge your branch into `worktree-pod-1897-logging` and
   push it.
6. `podium lock release merge:worktree-pod-1897-logging` immediately.

If the rebase conflicts or foreign commits appear, **stop and mail the
coordinator** — do not invent an alternative landing route.

**What that rule is actually for**, since chunk 1 hit the edge of it: it
exists to stop you inventing a route *around* a refusal — cherry-picking,
force-pushing, pushing a temp branch to the target, or leaving diverged
history behind. It does not mean a refused fast-forward is always a stop.

If the branch simply moved ahead of you while you were running gates, and
you are **holding the merge lock**, the correct response is: inspect the
incoming commits, and if they are ones you can account for, rebase onto
them, **re-run your gates on the rebased tree**, and then push. The
re-verification is the non-negotiable part — the tree you tested is not the
tree you are landing. Stop and mail when the incoming commits are ones you
cannot account for, when there is a real conflict, or when re-verification
fails.

## Definition of done

Before you land:

- `bun run typecheck` green. Trust a cache hit; never force a recompute.
- `bun run test` green. **Know what this now runs**: since `e254f8e76`
  (`test: make lean gate the default`) root `test` is a LEAN gate —
  typecheck plus four guard files. It is not the old full lane, and it does
  not run `packages/protocol`, `apps/server` or `apps/web` tests. The old
  lane is `test:full`.
- **The tests of every package your change can reach**, named explicitly in
  your landing mail. The lean gate does not cover your chunk; you do. A leaf
  package with no consumers reaches little, and saying so with the scope
  named is honest. A chunk that edits `apps/server`, `apps/cli` or
  `apps/web` reaches a great deal and should run `test:full`.
- Any gate named in your chunk's acceptance criteria (e.g.
  `scripts/audit-browser-reach.ts`, `lint:boundaries` run directly).
- `@podium/scripts` tests when you touch the architecture manifest or any
  derived registry — they own the manifest, rearch-ledger and durable-class
  audits, and they are what catch a half-registered package.
- Testing follows `CLAUDE.md`: the smallest focused set that protects the
  changed behavior. UI/interaction changes still need runtime verification.
- If you added, moved, or deleted an `apps/server` test file, re-run
  `bun scripts/server-test-shards.ts --write`.

## Waiting on the test lane

`test:heavy` is a shared lease and has been contended throughout this epic.
Two rules learned in chunk 1:

- **Once the repo lane is queued, stop editing.** Every edit while queued
  means the lane you are waiting on is measuring a tree you no longer intend
  to land, and you have to kill and relaunch it. Finish the tree first, then
  queue.
- A queued lane is **not** a stuck lane. Never force it, never
  `--uncached-because` your way past it without a concrete reason.
- **Stay in-session while the lane runs.** Going idle silently drops your
  queue position — an idle agent is not waiting for a lease, it has left the
  queue.
- **Release the lease when your lane finishes.** It is not released when the
  command that acquired it exits. An agent that finishes its run and sits on
  a live TTL blocks the queue exactly as effectively as one still running,
  and `lock status` cannot tell the difference from outside.
- **Never pipe a gate through `tail`, `head`, or any filter.** You get the
  exit status of the pipe, not of the gate. This manufactured a green during
  chunk 1 and nearly caused a false landing. Read the output, not the exit
  code.

## A hold expires; re-check before acting on memory

A compaction boundary is exactly where a stale instruction survives as if it
were live. Chunk 1 lost an hour sitting on a "hold and wait for my mail"
that had already been superseded, because it came back from a compaction
holding the instruction but never re-checked the world.

**A hold is a statement about a moment, not a standing state.** Before
acting on any remembered instruction — especially one that tells you to
wait — re-read the live base (`git fetch`, compare against
`origin/worktree-pod-1897-logging`) and your newest mail. If either has
moved, the remembered instruction is suspect.

From outside, a stale hold is indistinguishable from a wedge: `live/working`
with no commit, no lease and no base change. If you are genuinely blocked,
say so in mail rather than sitting.

## Testing a diagnostic that moved off the console

Wherever this epic moves a diagnostic from `console.*` to the logger, every
test watching a console spy for it fails — chunk 2 hit 25 such failures
across 14 server files, none of them a regression. The answer is
`captureLogs()` in `apps/server/src/test-support`: it registers a **real
sink**, so the test observes the production mechanism rather than a mock,
and it pins **no** `minLevel`, so it follows the namespace level exactly as
the file and stdout sinks do. A capture pinned at `trace` would see records
a real deployment never emits, and the test would pass on behaviour that
does not ship.

Chunks 4 and 5 will hit the same wall in web and mobile. Use that pattern
rather than inventing a capture.

## One sink owns the stream

`packages/runtime/src/logging.ts` is the composition root, and its rule is
stricter than "file or stdout": systemd takes stdout, detached takes the
rotating file, foreground takes the console, and **exactly one** sink is
registered. Under detached the spawner still points stdio at the legacy
`<role>.log`, so an extra console sink would write every record into the
unbounded file this epic exists to replace. That legacy file is now only the
net for **stray** output — a bun panic, a library's own printf.

Do not register a second process-wide sink. A destination for records
arriving from *other* processes (chunk 3's per-origin client files) is not a
sink on this process's stream. `configureProcessLogging` is idempotent by
replacement, which is what lets the CLI configure as `cli` and re-configure
as `server`/`daemon`/`janitor` once it knows its role.

## Cross-platform file operations

Chunk 2's rotation leaned on `renameSync` **replacing** its destination,
which is POSIX-only — on Windows it throws when the destination exists.
Found by mutation-testing the rotation test rather than trusting it: two
mutants survived, each masking the other. The consequence would have been a
Windows install logging to the console forever from its second rotation
onward, with a full `.1` on disk, silently.

Podium targets win32 (see the ConPTY branch in `durable-backend`). Unlink a
rename destination first, and treat any filesystem call whose semantics
differ across platforms as a place to check rather than assume. Chunk 5
touches the Tauri side and should read this twice.

## Known-red baseline

`packages/protocol` wire-golden fails on three families (host, model,
feature-state): the committed golden lacks the `machines`
`updateChannelOverride` field the model schema emits. It is broken on `main`
itself — the golden and model blobs are byte-identical on `origin/main` and
on this integration branch — so it is not epic damage and not yours. Tracked
as POD-1911.

When you run `test:full`, **exactly those three** are expected. Anything
beyond them is yours. Do not regenerate the golden: it belongs to POD-1911.

Note the lean default gate does not run `packages/protocol` at all, so these
three will simply not appear unless you run `test:full`. Their absence is
not evidence they are fixed.

## Read the output, not the liveness

A run that completed and failed looks identical from outside to a run that
was killed: no process, no lease, an idle session. They are only
distinguishable in the **output**. Before diagnosing a lane as killed, look
for the actual assertion and exit status, and check `dmesg` for an oom-kill
rather than inferring one from a missing process. This cost the coordinator
a wrong theory during chunk 1.

Corollary for reporting: "the lane is running" is only credible if the
lease is HELD. Check `podium lock status`, do not report intent.

## After landing

1. Set your issue to review: `podium issue update --id <id> --stage review`.
2. Mail the coordinator: `podium issue mail send 1897 --body "..."` — say
   what landed, what you verified, and anything the next chunk should know.
3. Stop your session (`podium session stop`).

A reviewer runs over this epic after POD-1900 and again after POD-1904. The
coordinator hands findings back to the agent that wrote the code, so expect
a possible follow-up before the epic closes.

## Working rules

- No `AskUserQuestion` — there is no human on your session. It blocks
  silently. Mail the coordinator if you are genuinely blocked.
- Never bare `git stash` — the stash stack is shared across worktrees.
- Keep your issue stage current (`planning` → `in_progress` → `review`) and
  keep `podium issue state <id> --set "..."` readable for the human.
- Discovered work that is not your chunk: file it, do not do it. Use
  `podium issue create --parent-id 1897` plus a `discovered-from` edge, or
  mail the coordinator if it affects another chunk in flight.
