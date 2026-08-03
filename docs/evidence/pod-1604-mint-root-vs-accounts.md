# POD-1604 — the mint root did not move when accounts landed

**Status: BLOCKS THE MERGE TO MAIN.** Not because a test is red, but because the
rewrite introduces a privilege gap that main does not have. Recorded here so the
decision is made deliberately rather than by flipping a flag.

## What the tripwire says

`packages/runtime/src/session-mint.test.ts` — "POD-1402 tripwire: host cannot
express a second human while mint is FS-only (ADR 3 D14)" — is RED:

    client_sessions gained 'userId' while assumesSingleOperator=true.
    FS-only mint ACCEPT has ended — bind mint to an identity before multi-user.

`HOST_LOCAL_MINT_TRUST` still declares `assumesSingleOperator: true`,
`mintBoundToIdentity: false`, and `reopenWhen: 'A second human principal exists
on one instance'`.

## The three answers, measured

**Q1 — is minting with FIRST_ADMIN_USER_ID "bound to an identity"?** No. It binds
to a *fixed* identity, which is the same claim `assumesSingleOperator` already
makes, not a replacement for it.

**Q2 — does a second human principal now exist?** YES, live.
`CLIENT_PRINCIPAL_GRADE` is `'user'` (`gateway/client-principal.ts:24`, flipped
from `'device'`). `CREDENTIAL_SOURCES` is `['per-user-scrypt']` only; the shared
password is retired by migration `20260803120000`. Login takes a `userId` and
verifies that account's own hash — "a per-account credential match or it is
nothing" (`auth-route.ts:246`). `POST /auth/users` creates a second account.
**`reopenWhen` is met.** (A dozen comments across the tree still say `'device'`;
they are stale — the code decides.)

**Q3 — what is the mint root today?** Filesystem access, unchanged.
`mintBreakGlassSession` guards only `existsSync(podium.db)`, then inserts
`FIRST_ADMIN_USER_ID`. So **write access to the database mints an admin session.**

## Why no flag was flipped

The declaration requires `mintBoundToIdentity: true` in the same change that sets
`assumesSingleOperator: false`. Gating `podium auth mint-session` on a password
would gate the *helper*, not the *root* — the module header already states the
disqualifying fact: a password "would not stop a DB INSERT". Anything that can
call the mint can equally run one line of SQL. That flip would declare the hole
closed while changing nothing.

## The larger finding

**Accounts are not an OS-level boundary here.** Every account's agents run as one
OS user with full write access to `podium.db`. The per-account boundary exists
only inside the server process, so a member-level account that gets a process onto
the host reaches the same authority as the first admin.

Main does not have this gap: it has no accounts, so "single operator" is TRUE
there. The rewrite introduces the mismatch.

## The decision required

Binding the mint means making filesystem write access insufficient — separate OS
users, or session issuance behind a privileged boundary. That is architecture plus
a product decision: **what does break-glass mean when you cannot log in?**

Related: POD-1605 (`device-grade-owner.ts` was to be deleted when per-user login
landed; its live call site still records the first admin as owner of any machine
paired by any account).
