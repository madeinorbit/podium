# POD-1634 — The mint root after multi-user landed

**Status:** Decided 2026-08-04
**Decision:** Neither ending offered is honestly available at this layer. The tripwire stays RED and is not touched. The binding is real work with a named mechanism, filed separately.
**Supersedes nothing; completes** POD-1604 (which reached the same verdict and stopped).
**ADR:** [ADR 3 D14](../adr/0003-command-security.md) · **Prior:** [POD-1402](1402-host-local-mint-trust.md)

Measured on `issue/1634-bind-the-mint-or-narrow-its-tripwire` at `79ac3f586`.

## The question

`packages/runtime/src/session-mint.test.ts` — *"POD-1402 tripwire: host cannot
express a second human while mint is FS-only (ADR 3 D14)"* — is red. The brief
offered two endings: **(a)** bind the mint and flip `mintBoundToIdentity`, or
**(b)** narrow the tripwire's condition because the column landed for an
unrelated reason.

## (b) is dead — four independent detectors fire, not one

The test aborts at its first failing assertion, which made this look like a
single-column drift. It is not. Evaluating every detector in the tripwire
against `apps/server/src/migrations/schema.ts` at this SHA:

| Detector | Result |
|---|---|
| `client_sessions` per-user column | **FIRES** — `userId` |
| `machines` per-user column | **FIRES** — `ownerUserId` |
| `users` table present | **FIRES** — `schema.ts:597` |
| `grants` table present | **FIRES** — `schema.ts:633` |
| `memberships` / `user_grants` | absent |

Narrowing the `client_sessions` check moves the failure to the next detector.
Each is direct evidence of the same fact, so there is no narrowing that is both
honest and green. **(b) is not available.**

## The premise did not merely drift — multi-user is live in production code

Not schema-only. Verified call sites:

- `POST /auth/users` (`apps/server/src/auth-route.ts:284-325`) — an admin creates
  further accounts, including further admins. Wired into the real server at
  `server.ts:428-435`; exercised by a browser e2e.
- `UsersRepository.create()` (`apps/server/src/store/users.ts:118-131`) writes a
  real `per-user-scrypt` credential row.
- `/auth/login` (`auth-route.ts:239,252-256`) takes `userId` **from the request
  body** and verifies *that account's own* hash. The shared-password arm is gone.
- `grants` has live writers: `IssueCrud.share()/unshare()`
  (`modules/issues/service/crud.ts:690,711`), registered commands
  (`modules/issues/registry.ts:736-747`).
- `CLIENT_PRINCIPAL_GRADE` flipped `'device'` → `'user'`
  (`gateway/client-principal.ts:24`).

`HOST_LOCAL_MINT_TRUST.reopenWhen` — *"a second human principal exists on one
instance"* — is **met**. Note POD-1067, the issue that was supposed to design
this, is still `proposed`: the machinery arrived ahead of it via the POD-1439
reconciliation, and ahead of D14's prerequisite.

## (a) is not available either — and ADR 3 D14 pre-rejected the mechanism

The mint root is unchanged. `mintBreakGlassSession`
(`packages/runtime/src/session-mint.ts:127-152`) checks only that `podium.db`
exists and is writable, then inserts `FIRST_ADMIN_USER_ID`. No credential is
consulted; `MintOptions` has no principal field. **On a host that now models
several humans, any local process that can write the state dir obtains the first
admin's authority.** This is reachable by a member-grade account holder, whose
agent sessions run on the host as the same OS user.

Gating `podium auth mint-session` on a per-user password would gate **the helper,
not the root** — anything that can call the mint can equally run
`INSERT INTO client_sessions … 'user:sole'`. This is not a new observation: ADR 3
D14's own rejected-alternatives table already rejects *"require the instance
password"* for exactly this reason — *"the same process can still INSERT a
`client_sessions` row if it can write the DB — which is the mint's actual trust
root."*

So the instrument is internally under-specified: consequence 3 names *"password
step-up"* as a qualifying binding, while the rejected-alternatives table in the
same decision rejects password step-up as not a boundary. The rejected-alternatives
reasoning is the operative one.

**Generalising it:** on a single-OS-user host, no application-layer change can
make `mintBoundToIdentity` honestly true. Any secret the server can read to
validate a session, a co-resident process running as the same user can also read —
or bypass, by writing the session row directly. Accounts are enforced *inside the
server process*; nothing on the host is bound by them. The mint helper is a
symptom, not the disease.

## Decision

1. **The tripwire is not touched.** No deletion, no allowlist, no narrowing, no
   flag flip. It is reporting a true and live escalation and it should keep
   reporting it.
2. **No flag is flipped.** `assumesSingleOperator: false` with
   `mintBoundToIdentity: false` is the state reality is in, but the instrument's
   coherence rule forbids that pair *by design* — it exists to make shipping
   multi-user with an unbound mint impossible to record quietly. Recording it
   quietly is precisely what a flip would do.
3. **This is an ADR violation, not a stale declaration.** D14 consequence 3:
   rebinding is *"a hard prerequisite of multi-user, not an optional hardening of
   mint-session."* Multi-user shipped without it. The correct entry is a tracked
   violation with owned remediation, not a re-labelled instrument.

## Recommended remediation, in two parts

**Part 1 — cheap, honest, reverses the delta D14 actually named (recommended).**
Make `mintBreakGlassSession` **fail closed when the instance holds more than one
user account**. D14's argument for ACCEPT was that mint *"does not enlarge the set
of processes that could already act as the operator"* — it only converted *"a
multi-step attack into one documented verb."* Refusing the verb once a second
account exists reverses exactly that delta and restores the pre-POD-1376 state on
the instances where it became dangerous.

This does **not** make `mintBoundToIdentity` true and must not be recorded as
doing so — the raw-INSERT root survives. It removes the discoverable path, which
is the only thing mint ever added.

*Live-instance impact:* single-account instances are unaffected — mint behaves
exactly as today. Existing `client_sessions` rows are untouched and validation is
unchanged, so the 44 live rows and the current operator session keep working
either way. **Open input:** whether ludovico currently holds more than one
account. If it does, this change stops `podium auth mint-session` there and needs
an operator escape hatch decided first. That count was not read — `~/.podium` is
out of bounds for this session.

**Part 2 — the actual binding (architecture, operator call).**
Make FS write access to `podium.db` insufficient. The candidates, all of which
are deployment/architecture rather than code in this module:

- separate OS users per principal, so `podium.db` is not writable by every
  principal's agent process;
- session issuance behind a privileged boundary (socket/service) a co-resident
  process cannot write directly;
- per-user datastore.

Each carries a product question about what *break-glass* means when you cannot log
in. Until one lands, the tripwire stays red and is correct to be.

## What still makes the tripwire fire

Unchanged, deliberately: any of the four detectors above, plus the coherence
branch that requires `mintBoundToIdentity === true` whenever
`assumesSingleOperator === false`. Nothing was added to or removed from its
condition by this decision.
