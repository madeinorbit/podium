# POD-640 (3.9) — agent-mail mutations onto command defs

Branch `issue/640-3-9-agent-mail-mutations-onto-command-de`, 2 commits on
`issue/279-integration`. Human gates suspended per the fan-out protocol; forks
resolved from `docs/adr/` and recorded in the commit messages.

## The finding that shaped the issue

Four of this issue's five acceptance criteria were **already met on my base**.
POD-728 landed the mail contracts and POD-729 finished the cut — the L3 handlers,
the `registry.ts` join, the derived tRPC surface, and `cutover.test.ts` with its
characterization suites and the e2e round trip. The brief was written against a
2026-07-16 drift audit that predates both merges.

So this is a **re-pointing, not a redesign**. Each criterion was verified against
the thing that decides it rather than taken from the comments that claim it.

## Acceptance criteria

| Criterion | Verdict | Evidence |
|---|---|---|
| No hand-written `.mutation(` in the messages router | **MET (pre-existing)** | The `messages:` literal is nine `mailMutation(…)`/`mailQuery(…)` entries derived from `MAIL_COMMANDS`. Verified by brace-matched source scan in `scripts/audit-mail-commands.ts` (`derived-surface`) and by `cutover.test.ts`. Proven non-vacuous: a planted `smuggled: t.procedure.input(z.unknown()).mutation(…)` produced **3 findings and a failing test** (mutant 2 below). |
| `sessions.sendText`/`resumeAndSend` no longer wrap `withMutation` | **MET (pre-existing)** | Both are derived by `sessionFamilyProcedures()`; `SessionsService.withMutation` is deleted and dedup is `@podium/sync`'s `MutationLedger`, reached as `ctx.deps.mutations.once(`. Now also gated textually by `audit-mail-commands.ts` (`one-ledger`), whose probe includes the converse arm — the files document the deletion by quoting the call, so comments are stripped first. |
| Characterization suite green incl. #463 reply-FK class and body byte-fidelity | **MET (pre-existing)** | `characterization.{delivery,authz,spawn-await}.test.ts` + `cutover.test.ts`: 8 files / 308 tests green on my base before I changed anything. |
| Mail e2e: send → delivery → reply round trip | **MET (pre-existing)** | `cutover.test.ts` §6 drives the real `appRouter` and the real daemon relay: tRPC send → PTY frame (exactly one, byte-faithful) → relay reply → threading asserted by identity (`ackedBy === reply.id`). |
| Offline class recorded with rationale | **MET (pre-existing)** | `DURABLE_QUEUED_ONLINE` in `mail/contracts.ts`, reconciled against ADR 3 D4 rule 4 rather than defaulted: the mail queue is a SERVER-side queue of already-accepted rows, not a client Outbox of unauthorized commands. Pinned by `contract.test.ts`. |
| POD-424 audit passes for this router | **THIS ISSUE'S WORK** | `scripts/audit-mail-commands.ts` did not exist. See below. |

## What this issue actually built

### 1. `scripts/audit-mail-commands.ts` — the missing gate

The mail family was the only one of the four `@podium/commands` tenants with no
audit script. An absence claim with no instrument is indistinguishable from an
absence nobody checked.

Paired with `cutover.test.ts` per POD-732's standard ("an empty router satisfies
every absence claim perfectly"): the suite reads the **running system**, this
script resolves **no modules** and reads source text, so it runs in a fresh
checkout, in a worktree with no `@podium` install, and before anything is built.

Six checks, 17 probe arms. Several checks carry the **converse** probe — a fixture
the check must ACCEPT — because a check that fires on everything is as useless as
one that fires on nothing.

- `subject-present` — a missing subject is a FINDING, not an ENOENT crash, and it
  short-circuits the run. Added on the coordinator's note about POD-311's gate
  dying that way when its tables moved. Takes `exists` as a port so the probe can
  plant a missing table without touching the tree.
- `derived-surface` — no `.mutation(`/`.query(`/`t.procedure`/`z.unknown()` in the
  router literal, extracted by brace matching. A router that **vanished** is a
  finding, not a pass.
- `no-second-surface` — `MessageGate`'s deleted `switch (proc)` and its inline
  input tables stay deleted.
- `one-authz-door` — nothing calls `dispatchMailCommand` outside `registry.ts` and
  `gate.ts`; it takes a caller-assembled `MailHandlerContext`, which is how a
  second `MailAccess` would enter.
- `visibility-totality` — every contract declares its ADR 9 D3 class.
- `wake-needs-use` — POD-1179's table-wide assertion; see below.
- `one-ledger` — the legacy `withMutation` wrapper stays deleted.

### 2. POD-1179 — `ask` was not exempt, it was inexpressible

`mail.ask` hard-codes `lifecycle: 'wake'`, and a wake reaches
`MessageDeliveryService.trySpawn` (`service.ts:1083`) — it resumes or spawns a
session, which is code execution on that session's machine. POD-382's duplicate
contract declared `machineVerb: 'use'`; resolving the duplicate onto the mail
table dropped it.

It could not simply be added back. `classificationErrors` rejected a `machineVerb`
on any resource other than `machine`, so declaring it meant relabelling the row
gate AS the machine — losing the session gate that ADR 3 Am1 D15.2 says may not be
substituted for. **That rule contradicted the vocabulary's own design note**:
`framework.ts`'s `CommandPolicy.machineVerb` states the verb is "a SECOND axis
rather than `resource: 'machine'` because collapsing them would lose the row gate",
and the shipped session command plane already depends on it (`sessions.sendText`
is `resource: 'session'` AND `machineVerb: 'use'`).

Resolved: the converse rule is dropped; the surviving direction (a `machine`
resource MUST declare a verb) is untouched. M5 is narrowed from "any
caller-supplied target" to `resource === 'machine'`, because its hazard is a caller
probing which machines are online, which needs a nameable machine — `spawnAgent`
has one and still must distinguish, `mail.send`/`mail.ask` address an issue or
session ref and cannot name a machine at all. Keying it the old way put mail in an
impossible position: M5 demanding it distinguish, D20.2 demanding it must not.

`mail.send` gets the verb on the same evidence (its `lifecycle` input admits
`'wake'`). `mail.reply` deliberately does not: no lifecycle field, `sendReply`
defaults to `wait`. That negative control is what makes the assertion mean
something.

**Scope, stated rather than implied:** this makes the fact declared and auditable,
**not** a runtime refusal. No mail dispatch path reads `policy.machineVerb`. Filed
as **POD-1193 (Wake path machine-use gate)** with a `discovered-from` edge.

## Mutation evidence

One mutant per call; each verified applied (match-count 1, hash changed,
grep-back, only the target dirty) and each **compiled**, so both are regressions a
developer could actually ship. Reverts confirmed clean.

| Mutant | Source-text audit | Running-object test |
|---|---|---|
| Delete `machineVerb: 'use'` from `mailAskContract` (the POD-1179 regression, replayed) | **KILLED** — exit 1, `wake-needs-use` at `contracts.ts:668` | **KILLED** — `cutover.test.ts` POD-1179 case fails |
| Smuggle `smuggled: t.procedure.input(z.unknown()).mutation(…)` into the messages router | **KILLED** — exit 1, 3 × `derived-surface` at `router.ts:1193` | **KILLED** — POD-424 gate case fails |

An instrument bug was caught by its own counterfactual while writing the
running-object half: the first `admitsWake` probe keyed on `safeParse().success`,
and zod strips unknown keys and succeeds — so it called **every** contract
wake-capable, `mail.reply` included. Keyed on the parsed output now.

## Wire names

Per POD-311's constraint, no dispatched wire name is retired. The router keys stay
the bare shipped names (`send`, `inbox`, `reply`, `spawnAgent`, `awaitAgent`, …)
while the contracts carry dotted identities (`mail.send`); `sessions.ask` keeps its
wire home under the sessions router and is served through the mail derivation.
`issues.mailSend` is untouched — collapsing it into `mail.send` remains POD-311's
call, and `cutover.test.ts`'s allowlist still records it as a finding rather than
absorbing it.

## Verification

Run in this worktree after `bun install`, against base
`19cd42ef` (`issue/279-integration` has since moved 7 commits ahead; not merged,
per protocol).

| Lane | Result |
|---|---|
| `bun run typecheck` (workspace, turbo) | **exit 0** — `23 successful, 23 total`, `Cached: 0 cached, 23 total` |
| `bunx tsgo --noEmit` in `packages/commands` | **exit 0** |
| `bunx tsgo --noEmit` in `apps/server` | **exit 0** |
| Typecheck instrument probe | Both report **TS2578 / "Unused '@ts-expect-error'"** on a planted error — the zeros above are meaningful |
| Unit: `packages/commands`, `apps/server/src/modules/messages`, both sibling cutover audits, **`scripts`** | **exit 0** — 40 files / 941 tests |
| `bun scripts/check-boundaries.ts` | **exit 0** — 56 allowlisted, 0 new |
| `bun scripts/rearch-audit.ts` | **exit 0** — 25 items, 194 sites, **baseline exact** |
| `bun scripts/check-no-nul-bytes.ts` | **exit 0** |
| `bun run audit:issues` / `audit:sessions` / `audit:workflows` | probe + gate **exit 0** each |
| `bun run audit:mail` | probe (17 arms) + gate **exit 0** |

No migrations touched, so `migration:check`/`migration:manifest` do not apply.

**Deletion audit:** unchanged at baseline. This issue removes no sites — it adds a
gate — so there is no VANISHED-versus-MOVED claim to make, and the ratchet is
neither loosened nor tightened.

## Deliberately not done

- **Runtime enforcement of `machineVerb` on the wake path** — POD-1193. A
  behaviour change on the shipped wake pipeline; not absorbed into a cutover.
- **Collapsing `issues.mailSend` into `mail.send`** — POD-311's, and retiring a
  dispatched wire name is a behaviour change, not a migration.
- **The two standing findings in `cutover.test.ts`'s allowlist** —
  `modules/superagent/tools.ts` reaching delivery directly (POD-313) and the
  issues-registry `mailSend` second contract home (POD-311). Reported, not
  absorbed.
- **`POD-1179` was not closed in the tracker**: it is `proposed`, and closing a
  proposed issue is operator-only. Resolved in code; needs an operator close.
