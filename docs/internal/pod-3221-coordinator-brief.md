# Coordinator brief for the async store epic (POD-3221)

You are the coordinator of this epic. You own the specification, the decisions, the shared
edits, the freeze, the landings and the checkpoints. You convert no repository yourself.

## Read these, in this order

1. `docs/internal/pod-3221-spec.md`: the design as decided and the definition of done. §6 holds
   the working rules every worker is judged against; §7 the decisions on record.
2. `docs/internal/pod-3221-execution-method.md`: the phases, gates, checklists, the bubble-up
   protocol, the checkpoints and the issue tree with its edges.
3. `podium issue tree 3221 --max-nodes 200`: the live tree. The tracker's edges are the truth
   about what is ready; the method's table is the human summary.
4. Only when a design question is reopened: `docs/internal/pod-3221-history-spec-and-reviews.md`
   and `pod-3221-history-execution-method.md`, which preserve every revision, all five reviews
   and the Postgres, Kysely and PGlite analyses. They are not authoritative where they disagree
   with the current spec.

## What you do

- **Run the phases in the method's order.** Start ready issues with one worker each on its own
  worktree (`podium issue start <id>`), five to eight at a time as the box allows. Every worker
  brief names its files, its uncovered-method list, the checklist, the decision command, the
  freeze lock name while held, the spec's §5 and §6, and that worktrees are created with
  `bun run setup:worktree`. Check a new worker after three minutes by sampling its worktree
  (`ls -lt`, `git -C <worktree> log --oneline -3`), never by its stage.
- **Land per package on `main`** behind the merge lock, in the method's order; the lint family
  and the scoped typecheck are the gate; a conversion commit may not change an existing test
  assertion.
- **Answer decisions with rules.** A worker that meets a site no rule covers marks it
  `// DECISION POD-<n>`, files a decision issue and moves on. You amend the spec's §6, send the
  answer to each affected worker's session with `--urgency interrupt`, and have the rule applied
  to every listed site. Never edit the site instead of the rule.
- **Make the shared edits yourself** (issues 0.12 and 0.13 and the Phase 0 spec amendments), so
  no worker touches `store.ts` or `schema.ts` during Stage A.
- **Hold the freeze** for the flip: `podium lock acquire freeze:pod-3221-flip --ttl 10m`,
  renewed for the whole window, named in every concurrent session's brief; check the codemod's
  output is empty at every landing that crosses the flip until the codemod is deleted.
- **Stop at every checkpoint** (R1 to R5). Each is an issue with a standing instruction: review
  the whole subtree and the phase's handoffs and artifacts; review what landed, the measurements
  against their baselines, the gates, the markers and decision issues, and anything deferred;
  replan by adding, removing, re-sequencing or rewriting sub-issues and writing new specs where
  the design changed; check in with the human before any change to scope, the definition of
  done, the sequence, the freeze timing or a decision on record; close only when the next
  phase's ready briefs match the current documents and the human has confirmed.
- **Keep the documents current.** A design change goes into the spec, a sequencing change into
  the method's tree table, and both are committed on the epic's branch and attached as
  artifacts. Do not fork a third document.
- **Keep the epic's panel current**: the state paragraph after every landing and checkpoint,
  the measurement numbers when they change, the todo list in the human's terms.

## What only the human does

- Grants Turso platform access (issue H) and confirms the plan tier's backup guarantees.
- Confirms each checkpoint's replan.
- Agrees the flip's freeze window.
- Takes any decision that changes scope, the definition of done, or a decision on record.

## What must not happen

- No worker edits `store.ts`, `schema.ts` or a migration during Stage A.
- No conversion commit modifies an existing test assertion.
- No `as any`, `@ts-expect-error`, `biome-ignore`, `TODO`, `sql.raw` of user input, or a
  temporary second code path in converted files.
- No test lane beyond the focused one for a worker; `bun run test:full` only at the flip's
  gate, once, under the heavy lease.
- No instrument added without its deletion issue.
- No phase started before its checkpoint closes.
