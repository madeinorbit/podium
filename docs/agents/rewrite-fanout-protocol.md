# POD-279 rewrite fan-out — protocol for implementers and reviewers

You were spawned into an **autonomous fan-out** for the architecture rewrite (POD-279). A
coordinator session drives it; **there is no human in this loop**. Read this file in full before
you touch anything, and follow it for the whole task.

Coordinator session id: `aa1f8b5d-bb56-4c68-8eb6-809c6f55ec47`
(reach it with `podium mail send --to aa1f8b5d-bb56-4c68-8eb6-809c6f55ec47 --body "…"`)

## 1. Never block on a human

- **Never** call `AskUserQuestion`, `podium issue needs-human`, or any interactive prompt. A session
  that parks waiting for a person is a stalled session and the whole fan-out waits on it.
- Your issue's brief may name a HUMAN GATE. Those gates are **suspended** for this run by explicit
  user instruction: do the work, record the evidence the gate asked for as an issue artifact, and
  keep going. Do not set `needs-human`.
- When you hit a genuine decision fork, resolve it yourself in this order: `docs/adr/` (the ADR pack,
  **as amended**) → `docs/multi-user-readiness.md` → `docs/rearchitecture-v3.md` → the existing code's
  established pattern. Write the decision **and its rationale** into the commit message so the
  reviewer and the coordinator can audit it. Then continue.

## 2. Your branch, and who owns integration

Your worktree branches off **`issue/279-integration`**, not `main`. That branch carries what you
need and `main` does not:

- Phase 0 guardrails: `scripts/oracle.ts`, `scripts/rearch-audit.ts`,
  `scripts/architecture-manifest.ts`, `scripts/check-boundaries.ts`, `scripts/check-no-nul-bytes.ts`
- The ADR pack: `docs/adr/0001…0009` plus the `-amendment-1` files
- The migration ledger: `docs/rearchitecture-v3.md`, `docs/rearch-deletion-audit.md`

**Do not rebase onto `main`. Do not merge `main`. Do not merge or push to `main`.** The coordinator
owns integration and will merge your branch into `issue/279-integration` once the reviewer is happy.
If you believe you need something from `main`, mail the coordinator instead of pulling it.

## 3. First three commands, every time

```sh
podium session title "…"          # 3-5 words naming the thing, not the activity
bun install                       # worktrees do NOT inherit node_modules — skipping this
                                  # silently resolves @podium/* from ANOTHER checkout
podium issue update --id <your-id> --stage in_progress
```

## 4. Verification — evidence, not assertions

Before you report done, run these **in your worktree** and keep the real output:

```sh
bun run typecheck
bun run test
bun scripts/check-boundaries.ts
bun scripts/rearch-audit.ts
```

`bun run lint` dies early at biome, which means later gates never run — so run
`bun scripts/check-boundaries.ts` **directly** as shown. If your change touches migrations, also run
`bun run migration:check` and `bun run migration:manifest`.

Never claim a lane is green without pasting its output. If a lane was **already red on your base**,
prove that (`git stash` is repo-wide and forbidden — instead check the same lane on a clean checkout
of `issue/279-integration`) and say so explicitly rather than letting it read as your regression.

UI or interaction behavior you changed needs **runtime** verification against a running stack, not
just a unit assertion. Attach screenshots as issue artifacts:
`podium issue artifact <id> --add <path-inside-the-repo> --title "…"`.

## 5. Stay inside your scope

Your diff must be the issue you were given. If you discover adjacent work:

```sh
podium issue create --description "…" --brief "…"       # 1-3 plain sentences in --description
podium issue dep-add <new> <your-id> --type discovered-from
podium mail send --to aa1f8b5d-bb56-4c68-8eb6-809c6f55ec47 --body "discovered POD-… : …"
```

Do **not** grow your diff to cover it. A large surprise diff is the single most common reason a
review round-trips, and round-trips are what this run cannot afford.

Commit in logical chunks. Every commit message ends with a trailer:

```
Podium-Issue: POD-<your-id>
```

## 6. Reporting done

```sh
podium issue update --id <your-id> --stage review
podium mail send --to aa1f8b5d-bb56-4c68-8eb6-809c6f55ec47 --body "…"
```

The mail is the coordinator's only signal. It must carry:

1. **What landed** — the acceptance criteria, each one answered.
2. **Files touched** — `git diff --stat issue/279-integration...HEAD`.
3. **Verification output** — the real tail of each lane from section 4.
4. **Decisions you made** at forks, and anything the reviewer must know to judge the work.
5. **What you deliberately did NOT do**, and why.

Then go idle. Do **not** stop your own session, do **not** merge anywhere: the coordinator merges
your branch, then stops your session and removes your worktree.

## 7. If you are a REVIEWER

You are reviewing a branch against `issue/279-integration`. Same no-human rule applies.

- Review against the issue's **literal acceptance criteria** and the ADR pack — not against a general
  sense of quality. Quote the criterion, then say met / not met, with the evidence.
- **Mechanism presence is not coverage.** A new API with zero callers, a flag nothing sets, a
  conformance suite that skips the failure path — all count as *stopped short*, not done.
- Grep audits are necessary and never sufficient. Verify against the thing that actually decides
  (the code path, the test that fails when you break the product) not against a plausible proxy.
- **Re-run the verification lanes yourself.** A report claiming green is a claim, not evidence.
- Return a verdict of exactly `APPROVE` or `CHANGES REQUESTED` plus a numbered, actionable list.
  Mail it to the coordinator **and** to the implementer's session.
