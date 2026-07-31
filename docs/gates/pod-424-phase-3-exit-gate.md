# POD-424 Phase-3 exit gate

**Gate run:** 2026-07-31
**Candidate:** `8672477077d87e9e6797e12a792d9c24d1bf6055` (`issue/279-integration`)
**Verdict:** **REFUSED — Phase 4 and Phase 6 remain blocked.**

The command-contract migration is substantially present, the source guardrails can
detect their planted violations, Telegram fails closed, and the secrets split is
complete. The multi-user policy layer assigned to Phase 3 is not live end to end:
production human transports still resolve to the ambient first admin, sharing has no
command surface or rescope emitter, several policy suites inject principals and ports
that production cannot mint, superagent and automation state remain instance-wide,
and system jobs do not use the system-principal attribution path.

POD-1283 (Phase 3 policy completion) is the blocking internal remediation issue.

## 1. Evidence convention and baseline

No landing lane, typecheck, or audit was re-derived when current-sha evidence existed.
The fresh catch-up landing evidence attributed to POD-1246 and POD-1273 at this exact
candidate is:

- clean integration tree;
- forced typecheck: 23/23 workspaces, 0 cached, exit 0;
- unit lanes: node 9,138, web 1,456, mobile 34, Bun SQLite 14, exit 0;
- shadowing scan: 2,033 files clean, exit 0;
- architecture deletion baseline: 31 items / 197 sites, exact, exit 0.

The gate ran only source audits not covered by that landing record, deliberate-fixture
probes, environment checks, and process close-outs. The worktree initially had no local
dependency installation. A locked local install was not authorised, so the gate did not
fall through to another checkout's packages; new Vitest and Playwright runs were not
claimed.

## 2. Closed-child evidence

Every pre-existing Phase-3 child is `done`; the phase tree was read directly rather than
inferred from the root tree. The important landing records are:

| Issue | Attributable evidence used by this gate |
|---|---|
| POD-311 (Command contracts) | Forced typecheck 23/23, 0 cached; 5,494 focused tests; boundary, deletion, surface and NUL audits green. |
| POD-312 (Session commands) | All four children closed; the session-surface audit's four planted fixtures fired; no hand-written session mutation remained. |
| POD-313 (Superagent/fleet/spec commands) | Thirteen gates green at landing; Phase-3 family deletion ratchet 194 → 179. This did not add superagent owners. |
| POD-314 (Derived router) | Nineteen gates green at landing, but it explicitly closed with six old-scope `router-triple-access` sites rather than zero. Current-tree re-measurement is red at 18 sites (§4). |
| POD-315 (Command security) | Authz matrix landed at `02b865b9`; forced typecheck 23/23; 399/400 focused cases (one recorded load flake); product mutations found a surviving invariant and added its assertion. Its own header says two humans are not production-representable and tRPC/MCP still mint `OPERATOR`. |
| POD-316 (Outbox recovery) | Landed at `9560957e`; the unauthorized classifier mutant turned 6/29 red. Its close record says four ACs cannot be met in this tree and the web still drains the legacy outbox. |
| POD-352 (Secrets/preferences) | Landed at `77ce11be`; seven-item exit audit at zero after POD-1213; classification mutations changed real outcomes. |
| POD-640 / POD-641 / POD-735 | Mail, workflows and automations derived-surface audits landed with planted fixtures and the family migrations closed. Their policy defaults are assessed below rather than inferred from the migration result. |
| POD-1080 (Telegram binding) | Landed at `dfd39e81`; owner fixture mutant failed 2/20; durable evidence is `docs/agents/pod-1080-gate-evidence.md`. |

All child sessions shown by `podium issue tree 290` are hibernated and the child issues
are closed. Child closure is therefore satisfied as a process fact; it is not evidence
that every child AC was met, because POD-315 and POD-316 explicitly recorded partials.

## 3. Deliberate-violation probe register

The source-only probes were executed on the candidate and exited 0, meaning each
instrument found its planted bad fixture (and, where implemented, spared its clean
control):

| Probe command | Result |
|---|---|
| `bun scripts/audit-session-commands.ts --probe` | 5 checks fired; 2 non-firing controls stayed silent. |
| `bun scripts/audit-router-mutations.ts --probe` | Parser and all 4 checks fired. |
| `bun scripts/audit-mail-commands.ts --probe` | All 17 probes agreed with their fixtures. |
| `bun scripts/audit-workflow-commands.ts --probe` | All 6 probes fired. |
| `bun scripts/audit-machine-grants.ts --probe` | Every check fired and spared clean fixtures. |
| `bun scripts/audit-telegram-binding.ts --probe` | All 3 source checks fired. |
| `bun scripts/audit-scoped-feed.ts --probe` | All source checks fired and spared clean fixtures. |
| `bun scripts/audit-settings-commands.ts --probe` | Parser and all 5 checks fired. |
| `bun scripts/audit-automation-commands.ts --probe` | All 6 checks fired and spared clean fixtures. |
| `bun scripts/audit-client-secrets.ts --probe` | Every secret-path check fired. |
| `bun scripts/audit-durable-classes.ts --probe` | Every check fired; current census was 89 declared/explained stores. |

These results prove the instruments can say no. They do not turn an absent production
path into a pass. Items whose required production subject does not exist are refused
below rather than represented by a synthetic mutant.

## 4. Original Phase-3 scope

### Hand-written mutation procedures — FAIL

The current-tree source audits all ran. Family audits pass, but the repository-wide
census reports **2 hand-written `.mutation(` procedures** in `router.ts`, both named by
the allowlist:

- `settings.set` at `apps/server/src/router.ts:328`;
- `discovery.scan` at `apps/server/src/router.ts:398`.

The phase deletion audit is also not zero:

- `bun scripts/rearch-audit.ts --phase POD-313` → exit 0, one item at zero;
- `bun scripts/rearch-audit.ts --phase POD-314` → exit 1,
  `router-triple-access` = **18** surviving sites;
- `--phase POD-290` and `--phase POD-1076` → exit 2 because no items are mapped to
  those phase ids. The CLI failed closed correctly, but those ids cannot be cited as
  passing deletion audits.

### Four-transport authz matrix — FAIL as an end-to-end claim

`apps/server/src/authz-matrix.test.ts` is a valuable policy contract, and it is in the
9,138-test landing lane. Its own header states that tRPC/MCP still mint `OPERATOR` and
that two humans cannot be distinguished. For several axes it substitutes the
person-scoped capability the transports *will* supply. This proves the policy functions,
not the four production transports required by the gate.

### Offline classes and dead-letter UX — FAIL runtime bar

POD-316 proves that definitive refusals park in the kernel Outbox and that recovery
affordances are reason-code driven. Its own close record also states that the web engine
still drains the legacy outbox and that its runtime verification was happy-dom rather
than Playwright over the real application. With no local dependency installation, this
gate could not drive an isolated branch harness; it did not use another checkout or the
user's live `main` instance as substitute evidence.

### Secrets split — PASS

The current source audits pass: settings surface exit 0; client secrets exit 0 with five
classified secret paths, both scrub adapters wired, and zero POD-421-owned residual
sites. `notifications.telegramBotToken` remains in the keyed server-only secret store;
personal routing is outside that store.

## 5. Multi-user acceptance items 1–13

| Item | Verdict | Evidence / refusal |
|---|---|---|
| 1. Visibility totality and private fallback | **PASS** | Current landing unit lane covers the filesystem-derived population gate. `CommandDef` runtime fallback is `personal`; family probes fired on missing/mismatched classifications. |
| 2. Exposure totality and served-nowhere fallback | **PASS** | `commandExposure(def) => def.exposure ?? []`; `isExposedOn` therefore denies every transport for an undeclared definition. The session family has the sibling planted-contract test, and surface probes fired. |
| 3. Transport-stamped attribution pair | **FAIL** | Resolver and selected mail/workflow writes carry the pair, but tRPC/MCP still resolve ambient `OPERATOR`; the matrix does not drive actual four-transport writes. There is no proof that every persisted command write carries both halves, and no production second human can demonstrate inert forged ownership. |
| 4. Share/unshare plus rescope | **FAIL** | No share/unshare/grant command exists. The only matching command name is `machines.revoke`, which unpairs a machine. No production server call emits `rescope`; only the protocol control port defines it. The feed mechanism's rescope/evict tests cannot prove a missing grant writer. |
| 5. Live delegation | **FAIL** | The pure resolver walks a live injected index, but an absent root falls back to `FIRST_ADMIN_USER_ID`. The product has no durable revocable human delegation path; the matrix's revocation uses an injected map and a different synthetic owner. No real mid-flight second-human revocation can run. |
| 6. Machine verbs fail closed | **FAIL (mechanism partial)** | Machine rows, grants, pairing owner, see/use/manage and unauthorized-vs-unreachable exist, and the machine source probes fired. Production mail still calls `mailPolicy()` with `SINGLE_USER_MACHINE_ACCESS` (`mayUse: () => true`), and the required spawn/PTY/harness/file/worktree cross-surface denial plus freshly authenticated non-owner cannot be exercised. |
| 7. Existence oracle | **FAIL (port partial)** | Injected mail tests prove byte-identical invisible/nonexistent failures and preserve cross-issue semantics. Production `relay.ts` calls bare `mailPolicy()`, which installs `SINGLE_USER_CEILING` (`canSee` everything); an invisible issue cannot be represented on the shipped path. |
| 8. Telegram resolves or refuses | **PASS for D22.1/D22.2** | Source audit and POD-1080 evidence establish one resolver, a gate on the shared inbound entry, no fallback identity, claim-code commands, per-user binding rows, and server-only bot token. D22.3 (acting as the bound user's owned superagent) remains POD-1209 and contributes to item 10's failure. |
| 9. System vs creator-attributed writes | **FAIL** | `systemPrincipal()` exists but has no production call site. Steward/expiry/boot-reconcile writes were not forced through it. `automations` and `automation_runs` have no owner/creator or attribution pair, so scheduled jobs cannot run under their creator's current rights. |
| 10. Superagent and per-user state | **FAIL** | `superagent_threads`, `superagent_messages`, `superagent_queued_inputs`, and `superagent_pending_turns` have no owner/user column; store reads are unscoped. POD-1076/POD-1213 moved read/snooze/pins/tabs/preferences to per-user stores, but the required superagent half is absent. |
| 11. Single-user parity | **PASS** | Inherited POD-314/POD-315/POD-316 evidence plus the current 9,138-test landing lane. The matrix explicitly pins today's shipped capabilities as the parity arm. |
| 12. Not multi-tenancy | **PASS** | No entity/grant/outbox tenant discriminator was added. Existing `instanceId` references are the pre-existing deployment-partition/runtime identity of ADR 1 D5, not a row-level tenant dimension. |
| 13. Open questions recorded | **PARTIAL / gate remains refused** | ADR 3 Amendment 1 and the readiness record retain the existence, graph-edge, reparent, inheritance, sharing-authority, and dead-letter disclosure questions. The Phase-3 ledger had not recorded the gate boundary or the child partials until this run; this report and the appended ledger entry now do. No permissive answer is inferred from a default. |

## 6. Process and scheduler close-out

- All pre-existing Phase-3 children are closed and their sessions are hibernated.
- The gate worktree was aligned to the current integration candidate and was clean before
  this evidence/doc delta.
- Dependency resolution was kept environment-neutral: no tests were run through another
  checkout's package installation.
- POD-1283 is an internal child of this gate and remains open; this gate remains
  `in_progress`.
- Phase 4 and Phase 6 must remain blocked. POD-290 may not close.

## 7. Required rerun after POD-1283

At a new candidate SHA, retain current landing evidence only when attributed to that same
SHA. Then rerun the source counterfactuals and exercise items 3–10 on production paths:
two authenticated users, all four transports, share/revoke with replica eviction, live
delegation revocation, all machine execution surfaces, invisible mail target, unbound
Telegram, actual system jobs, creator-rights automation, owned superagent state, and the
real browser dead-letter recovery flow. Both router mutation count and
`router-triple-access` must be zero.
