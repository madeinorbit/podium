# R1 — Phase 0 checkpoint and Stage A replan

**2026-09-04. For the operator to confirm before Stage A opens.**
Closing R1 is the only thing still blocking Stage A: every other prerequisite is done.

---

## 1. Where Phase 0 ended

Phase 0 was meant to make the conversion measurable, make it safe to parallelise, and answer the
questions a conversion must never decide quietly. It did all three, and it took four rounds of
executor review to get there rather than the one that was planned.

**Measurements hold at the R1 tip**, re-run today:

| Probe | Phase 0 baseline | At R1 | |
|---|---|---|---|
| `feedBootstrap.queriesPerRequest` | 44 | **44** | unchanged |
| `issueFrameReads.queriesPerRequest` | 371 originally, 253 after batching | **253** | the batching work removed 118 reads |
| `bootReconcile.framesPerBurst` | 1 | **1** | unchanged |
| `bindStorm.framesPerBurst` | 2 | **2** | unchanged |

**Five gates are armed, and each has been shown to fail on a deliberate break** — not merely to
pass on a clean tree:

- the store boundary lint family (raw handles, `.prepare(`, drizzle outside the store)
- the span-effect lint: 95 span bodies, 0 unclassified, **7 opaque bodies reported rather than
  assumed away**
- the coverage census gate: fails on a gained member *and* on a lost naming test
- the migration drift audit
- the hot-path budget, with five defeat cases recorded

## 2. What the independent review changed

The V2 landing review returned **REPLAN**, and it was right to. Three findings mattered:

1. **The hosted Turso proof cannot fail.** No assertion, no exit code, thirteen print statements. I
   confirmed this myself. Two landed rules cite its numbers. The *local* contract is genuinely
   asserted; it is the hosted arm — the only one that observes what the Turso decisions rest on —
   that is a transcript rather than a gate.
2. **The hosted database is shared with no lease**, and concurrent runs corrupt each other's
   results. This independently explains an unreproducible error another worker had already reported
   and could not account for.
3. **The coverage census had drifted** — seven current methods with no row at all. Stage A was going
   to be planned from it. It is now derived and gated, and validated by reproducing the original
   census exactly at the commit the original was written.

## 3. What R1 itself found

**A decision marker pointed at a closed issue.** Three sites in `relay.ts` and `native-login.ts`
carried `DECISION POD-3325`. That issue answered half its question and escalated the other half to
R3, then closed. So no open issue named those sites, and Stage A's zero-marker exit gate at R2 would
have failed with the only thing that could clear it scheduled *after* it. The rule "every marker must
have a filed issue" was satisfied in letter and void in substance.

Fixed two ways: a marker must now name an **open** issue, and closing an issue a marker still names
is forbidden. The exit gate reads *zero markers except those naming an open decision scheduled at a
named later checkpoint*, enumerated by R2 rather than counted — because a gate that cannot say
"deferred on purpose" gets met by deleting markers, which is worse than the drift.

## 4. Stage A as I propose to run it

Unchanged in shape from the plan you approved; concrete now that the census is trustworthy.

- **Wave 1 — small repositories**, in groups of three to five by adjacency. Roughly 25 files with
  fewer than 15 public members each.
- **Wave 2 — the five large ones**, by family, shared selects and mappers first, cross-family spans
  last: `shipping.ts` (54 members), `issues.ts` (44), `messages.ts` (42), `sessions.ts` (40),
  `events.ts` (29).
- Five to eight workers at a time, each in its own worktree, each producing **one commit**:
  repository files, golden tests written first against the synchronous code, and the setup edits of
  tests that construct the repository directly.
- **No `schema.ts`, no `store.ts`, no migration** in any wave. Sync forms only. Existing assertions
  untouched.
- One reviewer per wave; two for the large repositories.

**Every Stage A brief now carries the five indirectly-guarded members** the stale census was hiding —
in `repos.ts`, `messages.ts` and `grants.ts`. That is the concrete difference the census work makes:
without it those five would have been converted with nobody noticing they had no direct test.

**Exit:** lint family green, markers zero (or enumerated per §3), executor's legacy field deleted
with typecheck green, corrupt-blob test green, measurements green against the Phase 0 baseline.

## 5. What I am asking you to confirm

Nothing about scope — that is settled and I am not reopening it. Only this: **Stage A opens on the
plan above.** If you want the wave shape or the reviewer count different, this is the moment.

## 6. Open with you, separately

- **The minimum supported upgrade version.** A one-time repair that pins older issues to the right
  machine shipped only in preview builds and was deleted. If v0.1.0 is a supported direct-upgrade
  source it has to come back. This blocks POD-3359 and nothing else.
- **Seven bugs found while diagnosing the red test lanes** — spawn refused after reconnect, idle chat
  sends queuing, resurrect losing a conversation, a signing-key mismatch across rotation. Real, but
  not drizzle work. Deferred out rather than absorbed, and listed for you to schedule elsewhere.
- POD-3304 (Fly access), which blocks nothing.
