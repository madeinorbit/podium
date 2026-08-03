# Instance password retires into per-user credentials (POD-1554)

**Date:** 2026-08-03 · **Base:** `issue/279-integration` @ `e05cf52b` · **Phase:** 7.1 residue,
found by POD-333.

## Why

`packages/runtime/src/auth-store.ts` holds ONE scrypt hash per instance in `~/.podium/auth.json`.
`user_credentials.source = 'instance-password'` is a NULL-hash row that MEANS "this account
authenticates through that file". POD-1075's migration named its own successor — *"minting
per-account credentials lands with the per-user login work in Phase 3 (POD-315)"* — and POD-315
closed without minting them. The bridge outlived its declared owner.

It could not simply be deleted, for two reasons. The first admin of every upgraded instance
authenticates through `auth.json`, so deleting the path without first moving that hash locks the
operator out; and the move cannot be a SQL migration, because SQL cannot read `auth.json`. The
second reason was a product decision, recorded below.

## Human decisions (2026-08-03)

> **Open mode survives as an instance-level policy, admin-only.**
>
> "No login at all" is a real supported regime — it is the loopback / all-in-one default — and the
> operator must be able to get back to it. But it is not a per-user verb: one user cannot turn off
> login for the instance. So Settings → Security splits in two. *Your password* is a per-user
> action available to everyone; *Instance login* is an admin-only instance policy.
>
> This is the per-feature call `docs/multi-user-readiness.md` leaves deferred, decided here for
> the login surface only.

> **Open mode is a `config.json` flag, not credential deletion.**
>
> The alternative — open mode means "delete every credential", mirroring today's `clearPassword` —
> keeps one source of truth but destroys other people's passwords to express an instance policy,
> and turning login back on would make everyone re-enrol. The flag is reversible. The cost is two
> pieces of state behind one question, contained by making `credentialsRequired()` the single
> reader of both.

> **`auth.clearPassword` is renamed `auth.setLoginRequired`.**
>
> The old name says "clear a password" while the behaviour is "disable login for this instance" —
> exactly the ambiguity this issue exists to remove. The churn is paid once.

## Design

### 1. One predicate

```ts
credentialsRequired() = !openMode && store.users.hasPerUserCredentials()
```

`openMode` is a boolean in `config.json`, default **false** — beside telemetry consent (D8), so it
is readable without a server and is the same switch the CLI would flip. Every caller that today
asks `hasPassword()` asks this instead: `clientAuthGuard`, `/auth/status`, `POST /auth/login`, and
the network-reachable warning in `server.ts` (which fires when the host is non-loopback and
`credentialsRequired()` is false).

Enabling open mode on a non-loopback bind requires the acknowledgement flag the command already
carries; it is not silently permitted.

### 2. The boot migration

One-shot, in `startServer` where `applyEnvPassword` is called today, **before** the server listens:

1. Read `auth.json`. Absent → done. A box with no password migrates nothing.
2. `users.setPasswordHash(FIRST_ADMIN_USER_ID, hash, now)`. The stored string is byte-identical
   between the two homes (same scrypt encoding, `hashPassword` produced both), so this is a copy,
   not a rehash — the operator's existing password keeps working.
3. **Re-read** `credentialFor(FIRST_ADMIN_USER_ID)` and assert `source === 'per-user-scrypt'` and
   the hash matches what was written.
4. Only then delete `auth.json`.

Idempotent: after step 4 there is nothing left to read. If there is no first-admin account row
(store unwired, or a shape this build does not recognise), the step logs and leaves `auth.json`
in place — a failure to migrate must never become a lockout.

A SQL migration drops any remaining `user_credentials` rows with `source = 'instance-password'`.
It runs before boot, which is safe: the boot step keys on `auth.json` existing, not on the marker
row. Such a leftover row can only belong to a non-first-admin account, which never had a working
login anyway.

### 3. `PODIUM_PASSWORD`

The headless deploy seam moves to the same place: hash the env value and write the **first
admin's** `per-user-scrypt` credential. It stays one-shot — a no-op when that credential already
exists — so leaving the variable set across restarts cannot clobber a password changed later in
the UI. That is the shipped guarantee, preserved.

### 4. Deletions

- `'instance-password'` leaves `CredentialSource` (`packages/model/src/identity/user.ts`),
  `UsersRepository.credentialFor`, and the `AccountCredentialStore` interface in `auth-route.ts`.
- `POST /auth/login` loses the `verifyPassword(...)` arm and the
  `(!users && userId === FIRST_ADMIN_USER_ID)` fallback. A login is a per-user credential match or
  it is nothing.
- `auth-store.ts` loses `hasPassword`, `setPassword`, `clearPassword`, `verifyPassword`,
  `applyEnvPassword`. `hashPassword` and `verifyPasswordHash` stay — the KDF is still the
  credential format for every per-user row. The module becomes a pure hashing seam; renaming it is
  out of scope.

### 5. The command surface

`derived-family.ts` hands a handler its service and nothing else, and `InstanceService` therefore
has no principal today. `FamilyState` widens by **one member only — the users repository**. It does
NOT gain a way to identify the caller, because it already has one: `FamilyState.caller.userId`,
filled by `callerUserId(ctx)` (`derived-family.ts`), which resolves the user arm of the principal,
the agent arm via `onBehalfOf`, and THROWS when there is no authenticated human principal.
`auth.setPassword` consumes that existing resolution. Introducing a second principal-to-user path
at this seam is exactly the duplication POD-1196 has just finished collapsing, and is forbidden here.

The throw is load-bearing rather than incidental: an unauthenticated caller cannot reach a
"set my own password" handler at all, so the command inherits fail-closed instead of building it.

`instanceService` therefore starts taking `state.users` and `state.caller.userId` — the
reviewer-visible widening that file's own comment anticipates.

| Command | Change |
|---|---|
| `auth.setPassword` | Operates on **the caller**. Verifies `current` against the caller's own credential; writes the caller's row. `roleFloor` drops `admin` → `member`: anyone may change their own password. Rationale text updated — the old one justified `admin` by "whoever holds this holds the instance", which is no longer what the command writes. |
| `auth.clearPassword` → `auth.setLoginRequired` | Input `{ required: boolean, current: string, acknowledgeNoPassword?: true }`. `roleFloor: admin`, `confirmation: 'confirm'`, redaction on `current` — all kept. Writes `openMode`. |
| `auth.status` | Returns `{ loginRequired, hasOwnCredential, canManageInstance }` instead of `{ enabled }`. Still never returns a hash. |

### 6. Web

`apps/web/src/features/settings/sections/security.tsx` splits into two sections:

- **Your password** — set/change, shown to every user, drives `auth.setPassword`, and keeps the
  existing "re-login immediately so the guard we just enabled doesn't lock this device out" step.
- **Instance login** — rendered only when `canManageInstance`; drives `auth.setLoginRequired` with
  the acknowledgement checkbox and the existing destructive copy.

The setup screen's first-run flow is unchanged in shape; it now writes the first admin's per-user
credential.

## Testing

Unit, extending the existing suites rather than adding parallel ones:

- boot migration: has-password / no-password / no-first-admin-row (asserts `auth.json` survives) /
  verify-fails-so-nothing-is-cleared, **plus a named test that runs the migration twice and
  reddens if the second run is not a no-op**. Idempotence that nothing asserts is a claim, not a
  property.
- `POST /auth/login`: succeeds on a per-user credential, refuses with no credential, and no longer
  has an instance-password path to exercise.
- `auth.setPassword` writes the caller's row and refuses a wrong `current`;
  `auth.setLoginRequired` refuses a non-admin.

**Runtime verification is required and is not optional** — this is an authentication surface and a
green unit lane is not evidence. An isolated instance is seeded with a real `auth.json` plus a
first-admin row, booted, and the admin logs in **through the browser** with the pre-migration
password; then a second account is created and logs in beside it. Both are recorded in the handoff.

## Out of scope

- Per-feature sharing/visibility policy for anything other than login.
- Renaming `auth-store.ts` now that it is only a KDF.
- Account invite/disable/remove lifecycle (ADR 9, POD-290).
