# POD-382 — 3.2 cutover: the derived session surface, framework idempotency, and the audit

Branch `issue/382-3-2d-cutover-delete-hand-written-session`, base `issue/279-integration`
at branch-point `04613369`.

---

## Acceptance criteria, each answered

| Criterion | Status | Evidence |
|---|---|---|
| No `.mutation(` for sessions outside the derived surface; every hand-written session mutation deleted from `router.ts`, including `sessions.handoff` | **MET** | `router.ts` spreads `sessionFamilyProcedures()` into `sessions`/`pins`/`snoozes`/`tabs`; zero `.mutation(` remains in any of the four literals (`bun run audit:sessions`). Deleted: `handoff`, `stop`, `uploadImage`, `ask`, plus POD-380's `presenceProc` and POD-381's `sessionCommand` helpers, whose own comments named this issue. Checked BOTH directions at runtime over the real `appRouter`: every session-family mutation is in the manifest, and every manifest entry exists and is a mutation. |
| `withMutation` removed; framework idempotency proven by a duplicate-delivery test | **MET** | `SessionsService.withMutation` deleted; `@podium/sync`'s `MutationLedger` is the one implementation, built once at the composition root and exposed as `modules.mutations`. Duplicate delivery asserted across both envelopes (presence + command plane), plus a receipt written directly through the ledger being honoured by the router — the strongest available statement that the two dedups are one mechanism. 9 unit cases on the ledger itself. |
| Audit fails the build when a session-family command omits its visibility class or its owner-or-grant policy; unclassified defaults to private, and the default is tested | **MET** | `visibility` declared on all 11 presence + 12 command-plane contracts and on `sessions.handoff`. Two mechanisms, neither substituting: `commandVisibility()` resolves an absent declaration to `personal`, and both audit halves fail the build on the omission. Mutant M2 (delete one contract's visibility) killed the script check AND the runtime totality test. |
| Audit asserts no per-user field remains an instance-wide singleton | **PARTLY MET — the honest split is stated below** | Pins, snoozes and tab order are keyed `(userId, …)` and asserted with two DIFFERENT actors (Alice writes, Bob's rows stay empty). `readAt` is still a column on the session row: POD-1076 owns the storage move and POD-380 recorded why it waits (POD-1077's scoped feed). What this gate proves is that its COMMAND is already `scope: 'self'` / `per-user-state`, so the remaining move is storage-only — no contract, wire or replica change. Reported as a named residue rather than as a green claim. |
| Attribution assertion on one representative command per class | **MET** | Presence: the pair decides `nameSource`, and a payload-supplied `humanDirect`/`actor`/`onBehalfOf` is ignored. Command plane: `spawnedBy` stamped from the principal (agent → `session:<id>`, human → `user`), payload identity parsed away. Handoff: the durable record carries `actor` + `onBehalfOf` together, with the contract's own declaration asserted so an empty event list cannot pass. |
| No route to spawn / resume / send / kill / handoff bypasses the machine `use` check, including the all-in-one `local` case | **MET** | Table-driven over create · resume · sendText · kill · stop · uploadImage · ask: a principal holding `see` and not `use` is refused with `you do not have access to run agents on machine 'The Box'`. All-in-one: a colleague authenticated to the instance gets `unknown machine 'local'` on the sentinel — outside the see set, so identical to a never-paired id. Non-vacuity case: the owner succeeds at the same commands. Mutant M5 (delete the gate) killed 4 cases. |
| Cross-command sweep: invisible session and invisible machine fail identically to nonexistent ones | **MET — and it caught a real defect** | Eight targeted commands answer an invisible session exactly as a nonexistent one, with a can-say-yes case proving a VISIBLE target differs. An invisible machine answers `unknown machine 'box'`, byte-identical to a never-paired id. The sweep found the send path leaking existence — see the finding below. |
| No session reducer renders a rescope / evict as a deletion | **MET, as a check plus a tripwire** | Asserted where the rule is decided: POD-369's `REPLICA_TRANSITIONS` row `D14-EVICT` states *"MUST NOT surface as a deletion, emit a domain delete, or write a tombstone"*, filtered on `op=evict` (not on the word, which also appears in `D14-READMIT` stating a different rule). Plus a tripwire on the premise: no session contract carries a rescope/evict op yet — POD-1077 adds it before the POD-308 cutover, and when it does this fails. |
| Session e2e from the web UI and `podium session` CLI green | **MET, after repairing a base-red harness** | CLI: `apps/cli` 300 passed / 20 skipped. Integration e2e: `bun run test:e2e` 7 files / 27 passed. Web UI: Playwright `chromium-desktop` — see "the browser lane was red on the base" below. |

---

## The finding: the send path was an existence oracle

The cross-command sweep is the check the brief asked for, and it earned its place on
the first run.

`sendText` / `resumeAndSend` fell through to the message substrate whenever the
caller was not an agent. The substrate resolves its target from its OWN session list,
which knows nothing about a principal. So:

- a NONEXISTENT id → `{ok: false, reason: 'dead-lettered: session no longer exists', disposition: 'dead_letter'}`
- an INVISIBLE-BUT-EXISTING session → `{ok: true, queued: true, disposition: 'queued'}`

Two observable answers, which is the existence oracle §3.1.5 forbids — and worse than
a leak: the message was **delivered** to a session the principal may not see.

An absent target now never reaches the substrate. The synthesized dead-letter value is
pinned equal to the substrate's own answer by a test that asks the substrate directly,
so the duplicated string is checked rather than trusted. POD-379 pins `ok:false` +
`disposition:'dead_letter'` for that path and asserts nothing about a ledger row,
which is what makes not writing one behaviour-preserving.

---

## Two corrections I made to my own work, both caught by a sibling's contract

Recorded because both are the same shape — a rule generalised one scope too wide.

1. **`sessions.ask` first declared no `machineVerb`**, reasoning that a question is a
   durable message the substrate delivers whether or not the target is live. It is
   delivered at `lifecycle: 'wake'`, so asking one can START A PROCESS on someone's
   machine — the same reason `resumeAndSend` carries the verb. POD-381's table-wide
   assertion failed, correctly. The contract now declares `use` with the gate to match.

2. **The visibility lint asserted `resource: 'machine'` ⇔ `visibility: 'owned-compute'`.**
   It fired on `mail.spawnAgent` and on a `sessions.rename` fixture, both correctly
   classified. The two fields answer different questions — what a command WRITES versus
   what it authorizes AGAINST — and a spawn authorizes against compute while writing a
   personal session. Only the defensible direction was kept (owned-compute state must
   name the machine resource), and `sessions.handoff` was reclassified to `personal`,
   which is what it writes.

---

## The instruments, and why there are two

Two instruments of the same class corroborate; they do not complement. These are
different classes:

- **`apps/server/src/session-cutover.audit.test.ts`** (46 cases) reads the RUNNING
  system — the real `appRouter`, the real contract objects, the real services. Only a
  runtime check can prove a gate actually refuses or that two error shapes are equal.
- **`scripts/audit-session-commands.ts`** (`bun run audit:sessions`) reads SOURCE TEXT
  and resolves no modules, so it runs in a worktree with no local `@podium` install —
  where importing a workspace package fails outright — and catches what no runtime
  check can see: a contract added without a `visibility:` line. That field is OPTIONAL
  on `CommandDef` (the ~70 issue and lock defs predate it), so the typechecker never
  asks, and ADR 9 D4's default-closed resolution makes the omission SILENT.

The script's `--probe` mode is part of the gate, not a convenience: it plants each
defect where a naive scan would MISS it — the mutation at the END of a nested router
literal, because a line-based scan stops at the first `})`, about 15 lines in — and
fails if a check does not fire. `audit:sessions` runs `--probe` first.

### Mutation testing: 6 mutants, 0 survivors

Each mutant asserted its pattern matched **exactly once**, that the file hash changed,
that the mutant text greps back out, and reverted against a **backup** rather than
against `git diff --quiet`. The test expected to die was named before running.

| # | Mutant | Killed by |
|---|---|---|
| M1 | a hand-written `.mutation(` smuggled to the END of the `sessions` router | script `derived-surface` (exit 1) |
| M1b | the same mutant | `every session-family mutation the router serves is declared in the manifest` (+1 more) |
| M2 | one contract's `visibility` deleted | script `visibility-totality` (exit 1) |
| M2b | the same mutant | `every session-family command declares its visibility class and its policy` |
| M3 | `withMutation` restored as a service method | script `framework-idempotency` (exit 1) |
| M4 | `setPin` loses its `userId` parameter | script `per-user-keying` (exit 1) |
| M5 | the machine `use` gate deleted from the shared target resolver | 4 AC6 cases (sendText · kill · stop · all-in-one) |
| M6 | the send fall-through restored | both AC7 send cases |

---

## Verification lanes

Run in this worktree. In-package typechecks, not repo-root — a root run can pass
because no program covers the package.

| Lane | Result |
|---|---|
| `bunx tsgo --noEmit -p apps/server/tsconfig.json` | clean |
| `bunx tsgo --noEmit -p apps/web/tsconfig.json` | clean |
| `packages/{model,protocol,commands,sync}` in-package typecheck | clean |
| `apps/server/src/modules/sessions` + `packages/protocol` + `packages/commands` | 75 files, 1326 passed |
| `apps/server/src/session-cutover.audit.test.ts` | 46 passed |
| `packages/sync/src/mutation-ledger.test.ts` | 9 passed |
| `apps/cli/src` (the `podium session` CLI) | 300 passed, 20 skipped |
| `bun run test:e2e` | 7 files, 27 passed |
| `bun scripts/check-boundaries.ts` | OK — 56 allowlisted, 0 new |
| `bun scripts/rearch-audit.ts` | OK — 25 items, 212 sites (baseline exact) |
| `bun scripts/check-no-nul-bytes.ts` | ok |
| `bun run audit:sessions` | probe + gate, exit 0 |

**Deletion-audit baseline.** `router-triple-access` went 101 → 94 (the derived surface
removed seven `mods(ctx)` sites from `router.ts`). The ratchet FAILS an unrecorded
win, so the baseline was updated with `--update-baseline`; every other item is
unchanged. This is the ratchet moving DOWN, never a rebaseline over a regression.

---

## The browser lane was red on the base, and is repaired

`tests/e2e/serve-harness.ts` imported `agentLaunchCommand`, `ConversationDiscoveryCache`
and two types from `@podium/agent-bridge`. That package is now **empty** — POD-396 took
the PTY half to `@podium/pty` and POD-397 the harness half to `@podium/harness`, and
its barrel deliberately re-exports nothing so the deletion audit does not count a
forwarding shim. Every browser spec therefore failed at `webServer` start with
`Export named 'agentLaunchCommand' not found`.

Proved to pre-date this branch: neither `serve-harness.ts` nor
`packages/agent-bridge/src/index.ts` appears in `git diff --name-only <branch-point> HEAD`,
and at the branch point the symbol was already absent from the barrel.

Repaired in three lines (one import statement re-pointed, plus `@podium/harness` added
to `tests/e2e/package.json`) because the acceptance criterion requires the lane and no
browser spec could run without it. Flagged to the coordinator as out-of-scope work that
belongs to the Phase-3 extraction.

---

## What this issue deliberately did NOT do

- **The relay arm of `sessions.stop` is untouched.** It resolves its target from the
  CAPABILITY on self-stop, applies an issue-access gate and an issueless parent rule,
  and THROWS on refusal — three separately pinned behaviours that differ from the
  operator path this issue migrated. The contract declares `exposure: ['trpc', 'mcp']`
  so the surviving arm is visible as a residue rather than covered by a claim the
  contract does not keep. Folding it in is the remainder of POD-381's cutover.
- **The session READS are still hand-written** (`list`, `transcriptRead`, `status`,
  `read`, `recap`). They have no contracts; that is POD-311's remaining work. The audit
  reads procedure TYPE off the built router rather than names, so a write cannot hide
  among them by being declared a query.
- **No `owner` column was added anywhere.** POD-1075 owns identity and POD-1079 machine
  ownership; every seam this issue touches reads through the injectable ports they will
  fill, which is why a second human is testable today without accounts existing.
- **`sessions.ask` keeps `z.unknown()` as its contract input.** Its real schema lives
  with the MessageGate that parses it, and its contract is POD-729's; restating it in
  `@podium/protocol` would be a second declaration of the messaging vocabulary.
