# People and sign-in: specification

Status: reviewed and accepted by the coordinator of PDM-107 on 2026-11-10, with one change that is made in this text (section 16, row 19). The integration uses the shared identity package; retirement follows the import receipt (section 9).
Amended the same day by the approved sign-in carry-over design, `docs/design/sign-in-carry-over.md` (section 16, rows 20 to 26); the changed places are sections 2.6, 6, 8.5, 9, 13.2 and 14.
Amended by the memberships task, POD-6745, with what it built differently (section 16, rows 27 to 39, accepted by the coordinator on 2026-11-10).
Amended by the cloud memberships task, PDM-495, with what it built differently (section 16, rows 41 to 50, for the coordinator).
It is the detailed reference for every task under "Shared sign-in core" (PDM-513). Where a task brief and this document disagree, the difference is listed in section 16 for the coordinator.

| Written against | Commit |
|---|---|
| Open-source repository, `integrate/pdm-107-shared-sign-in` | `f92564c0d7f97907381eafc3b21a1ed593321901` |
| podium-cloud, local `main` | `d317d8771c047e1f41c56b68a3380d7bc662df10` |
| Sign-in library | better-auth 1.7.4, @better-auth/drizzle-adapter 1.7.4, drizzle-orm 1.0.0-rc.4 (the same versions in both repositories) |

Sources: the plan (`people-and-sign-in-plan.md` on PDM-107), the spike report (`sign-in-library-spike-report.md` on POD-6742, candidate `c6eeb191ea`), the code at the two commits above, and one design proof run for this document (section 15).

The integration branch equals `origin/dev/mw` at the commit above, and that commit is the recorded base (coordinator's decision, 2026-11-10). Local `dev/mw` has one further, unpublished commit (`504c59982e`, session runtime events). It is not part of the base. It changes seven files, all under `apps/server/src/modules/sessions/` or tests of daemon frames and runtime events; none is a file the route map or any other section of this document names (`git diff --name-only e2cdd85789 504c59982e`).

## 0. Words and rules

### 0.1 Words

| Word in this document | Meaning | Library model | SQLite table (workspace database) | Postgres table (cloud) |
|---|---|---|---|---|
| Member | One person inside one workspace. Owns sessions, machine custody, keys, role. | none | `users` (server-owned, unchanged) | none; lives in the workspace database |
| Account | A person who can sign in: identifier, name, picture | `user` | `identity_user` | `user` |
| Login method | Password, Google, GitHub | `account` | `identity_account` | `account` |
| Device sign-in | One signed-in browser, desktop app, phone or host session | `session` | `identity_session` | `session` |
| One-time code | A short-lived, single-use secret that becomes a device sign-in or a new password | none (ours) | `identity_one_time_code` | `identity_one_time_code` |
| Membership | "Account A is member M of workspace W with role R", with a status | none (ours) | `identity_membership` | `identity_membership` |
| Invitation | A single-use, expiring token for a membership in the invited state | none (ours) | `identity_invitation` | `identity_invitation` |
| The package | The shared identity package, `packages/identity`, published in the workspace as `@podium/identity` | | | |
| The core | The object the package builds from an edition configuration | | | |
| The library | better-auth | | | |

The library calls an account a "user" and a login method an "account". This document never uses the library's words except in the table above and in table and column names.

### 0.2 Rules every task follows

1. The member row is the base object. What a member may do is unchanged.
2. One sign-in implementation, the package, in both editions. No second system, no fall-through, no mode check in a route or a screen.
3. A person enters only through an active membership. No member is created during a request.
4. Member rows are written by one function, apply-membership (section 2.6).
5. Differences between editions are the capability list (section 2.9) or a field of the edition configuration (section 2.1). Nothing else.
6. Device sign-in tokens, invitation tokens and one-time codes are stored only as hashes (section 1.6).
7. Signing out a device ends that device only. Agent work depends on the membership.

## 1. Tables

### 1.1 Ownership and migrations

| Table | Columns decided by | SQLite: defined in | SQLite: migrations run by | Postgres: defined in | Postgres: migrations run by |
|---|---|---|---|---|---|
| Account, login method, device sign-in, verification | the library (we add columns only through its additional-fields setting) | `packages/identity/src/schema/sqlite.ts`, re-exported by `apps/server/src/migrations/schema.ts` | the server's migration chain (`bun run migration:new`, applied by `migrateStoreConnection` at boot) | `packages/identity/src/schema/pg.ts`, re-exported by podium-cloud `packages/platform/src/schema.ts` | podium-cloud `packages/platform` (`bun run --cwd packages/platform migration:new`, its `drizzle/` folder) |
| Rate limit | the library | not created (budget in memory, section 13.4) | | as above | as above |
| Organisation, organisation member, organisation invitation | the library's organisation extension | not created | | podium-cloud `packages/platform/src/schema.ts` (cloud only, unchanged) | podium-cloud `packages/platform` |
| Membership, workspace revision, invitation, one-time code | us | `packages/identity/src/schema/sqlite.ts`, re-exported as above | the server's migration chain | `packages/identity/src/schema/pg.ts`, re-exported as above | podium-cloud `packages/platform` |
| `users` (member rows) | the server | `apps/server/src/migrations/schema.ts` | the server's migration chain | none | none |

Consequences:

- The package holds table definitions and no migration files. Each repository generates its own migrations from the definitions it re-exports. A library upgrade that changes a table reaches self-hosted databases as an ordinary server migration and the cloud as an ordinary platform migration.
- The library's own schema generator and migration runner are never used (spike row 1).
- In podium-cloud a check fails the build when the platform's migrations and the re-exported definitions differ (`drizzle-kit check` plus a generate that must produce nothing). PDM-495 adds it.
- A hosted workspace database also receives the SQLite identity tables, because it runs the same server migration chain. They stay empty there: the hosted composition root hands the server a core built on Postgres (section 3).

### 1.2 Library tables

Column names are the SQLite names; Postgres uses the same names in the existing cloud tables. Times are integer milliseconds in SQLite and `timestamp` in Postgres; the package reads and writes them as `Date`.

**`identity_user` (account).** `id` text primary key · `name` text not null · `email` text not null unique · `email_verified` boolean not null default false · `image` text · `created_at` · `updated_at`.
The `email` column holds the account identifier. It is a real address, or a generated identifier (section 7).

**`identity_account` (login method).** `id` text primary key · `account_id` text not null · `provider_id` text not null · `user_id` text not null, references account, cascade · `password` text · `access_token` · `refresh_token` · `id_token` · `access_token_expires_at` · `refresh_token_expires_at` · `scope` · `created_at` · `updated_at`. Index on `user_id`.
A self-hosted database only ever holds rows with `provider_id = 'credential'`. `password` holds the hash string of the edition's password functions (section 2.1).

**`identity_session` (device sign-in).** Library columns: `id` text primary key · `token` text not null unique · `user_id` text not null, references account, cascade · `expires_at` · `created_at` · `updated_at` · `ip_address` · `user_agent`. Index on `user_id`.
Our additional columns, declared through the library's additional-fields setting with client input off:

| Column | Type | Meaning |
|---|---|---|
| `device_kind` | text not null, one of `browser`, `desktop`, `phone`, `host` | What signed in |
| `device_name` | text | Shown in the device list. A phone names itself; a browser or the desktop app is named from its user agent at sign-in, as `browserSignInMetadata` does today |
| `device_id` | text | A phone's own stable id. Pairing the same phone again replaces its earlier sign-in |
| `platform` | text | `ios`, `android`, `web`, `macos`, `windows`, `linux`, `unknown` |
| `last_seen_at` | time | Written by resolution at most once per five minutes per sign-in |
| `fixed_expiry` | boolean not null default false | True for a sign-in whose lifetime was chosen when it was made (a host session with `--ttl`). It is never renewed |

`id` is the public id of a sign-in: the device list shows it and a revoke names it. `token` holds the SHA-256 of the token, never the token (section 1.6). In the cloud the organisation extension adds `active_organization_id`; it stays.

**`identity_verification`.** `id` · `identifier` (indexed) · `value` · `expires_at` · `created_at` · `updated_at`. Used by the library for mail verification, mailed password reset and OAuth state. Identifiers are stored hashed (library setting `verification.storeIdentifier: 'hashed'`). A self-hosted server writes nothing here; the table exists so the two editions have the same shape.

**`rate_limit` (Postgres only).** `id` · `key` unique · `count` · `last_request`.

### 1.3 Membership

**`identity_membership`**

| Column | Type | Meaning |
|---|---|---|
| `workspace_id` | text not null | The workspace. A self-hosted database holds one value, the constant `local` |
| `member_id` | text not null | The member id, equal to `users.id`. Minted when the membership is created by a new invitation or by the first setup; given when the invitation names an existing member |
| `account_id` | text, references account | Null while invited, and null for a disabled or removed membership whose account was deleted |
| `role` | text not null, `admin` or `member` | |
| `status` | text not null, `invited`, `active`, `disabled` or `removed` | |
| `version` | integer not null | The workspace revision at this membership's last change (section 1.4) |
| `authorization_version` | integer not null, default 0 | Last revision that changed existing member authority; initial identity attachment and profile changes preserve it |
| `invited_email` | text | The address an invitation was issued for, if any. Display and matching only |
| `created_by` | text | Member id of the admin, or `host`, `setup`, `organisation`, `upgrade` |
| `created_at`, `updated_at` | time | |

Primary key `(workspace_id, member_id)`. One row per member for ever: a removed member who is invited again keeps the row and the member id.
Unique index on `(workspace_id, account_id)` where `account_id` is not null and `status` is `active` or `disabled`: an account is at most one live member of a workspace.
Index on `(account_id)` for "the workspaces of this account" and for account deletion.
Index on `(workspace_id, version)` for catch-up (section 11).

Allowed changes of `status`:

| From | To | By |
|---|---|---|
| (none) | `invited` | invite |
| (none) | `active` | first setup; creating a hosted workspace |
| (none) | `invited`, `active`, `disabled` | the upgrade, for a member row that already exists (section 8.2) |
| `invited` | `active` | accept |
| `invited` | `removed` | revoke the invitation of a membership that was never active |
| `active` | `disabled` | disable |
| `disabled` | `active` | enable |
| `active`, `disabled` | `removed` | remove; in the cloud also removal from the organisation and account deletion |
| `removed`, `disabled` without an account | `invited` | invite, naming the member |

Every other change is refused.

### 1.4 Workspace revision

**`identity_workspace_revision`**: `workspace_id` text primary key · `revision` integer not null.

Every change to a membership of a workspace, in the same transaction: lock this row (Postgres `select … for update`; SQLite needs nothing, a write transaction is already exclusive), add one to `revision`, and write the new value into the changed membership's `version`. Within one workspace the versions are therefore gap-free and in commit order. Section 11 depends on that.

### 1.5 Invitation and one-time code

**`identity_invitation`**

| Column | Type | Meaning |
|---|---|---|
| `id` | text primary key | Public id; a revoke names it |
| `workspace_id`, `member_id` | text not null | The membership it admits to; that membership is in status `invited` |
| `token_hash` | text not null unique | SHA-256, hex, of the token |
| `email` | text | The address it was issued for. When set, accepting requires the same address |
| `expires_at` | time not null | |
| `created_by` | text not null | |
| `created_at` | time not null | |
| `consumed_at`, `revoked_at` | time | Set once |

An invitation is usable when it is not consumed, not revoked, not expired, and its membership is `invited`. Issuing a new invitation for the same membership revokes the earlier ones in the same transaction.

**`identity_one_time_code`**

| Column | Type | Meaning |
|---|---|---|
| `id` | text primary key | Public id of the attempt. The signed-in device polls and decides by it |
| `purpose` | text not null | `pair-device`, `hand-over`, `password-reset`, `host-sign-in`, `transfer-claim` |
| `account_id` | text, references account, cascade | Whose sign-in or password it yields. Null only for a hand-over the receiver has begun and nobody has authorised yet |
| `code_hash` | text unique | SHA-256, hex, of the code. Null before a hand-over is authorised and after a pairing code has been claimed |
| `receiver_challenge` | text | SHA-256, hex, of a verifier only the receiving device holds |
| `claim_id` | text unique | The handle a receiver uses after it claimed a pairing code |
| `approval` | text not null default `none` | `none`, `pending`, `approved`, `denied` |
| `source_sign_in_id` | text | The device sign-in that authorised a hand-over. It must still exist at redemption |
| `device` | text (JSON) | Kind, name, device id, platform and delivery of the receiving device, and for pairing its three-word phrase |
| `failed_attempts` | integer not null default 0 | Wrong verifiers presented; the fifth denies the attempt |
| `created_by` | text | Account id, or `host` |
| `created_at`, `expires_at` | time not null | |
| `consumed_at` | time | Set once, by the statement that redeems |

Index on `expires_at` for the sweep. Section 2.8 gives the life of a code for each purpose.

### 1.6 What is stored hashed, and how

| Secret | Entropy | Stored as | Who hashes |
|---|---|---|---|
| Device sign-in token | 32 characters from 62, about 190 bits (library `generateId(32)`) | SHA-256, base64url, in `identity_session.token` | the package's adapter layer (below) |
| Invitation token | 32 random bytes, base64url, 43 characters | SHA-256, hex, in `identity_invitation.token_hash` | the package |
| One-time code | 32 random bytes, base64url, 43 characters | SHA-256, hex, in `identity_one_time_code.code_hash` | the package |
| Receiver verifier | 32 random bytes | SHA-256, hex, in `receiver_challenge` | the receiving device |
| Library verification identifiers (mailed reset, mail verification) | the library's | hashed by the library (`storeIdentifier: 'hashed'`) | the library |
| Passwords | | the edition's password hash | the edition's functions |
| OAuth provider tokens (cloud) | | encrypted by the library (`account.encryptOAuthTokens: true`) | the library |

Invitation tokens and one-time codes use the same format and hash as pre-upgrade links (`randomBytes(32).toString('base64url')`, SHA-256 hex). The upgrade can therefore copy pending rows and the links people already hold keep working (section 8.3).

**The device sign-in token.** The library stores it in clear and looks it up by equality (spike, "Session tokens: cleartext"). Today's `client_sessions` stores only a hash. The package keeps the stronger property with a hashing layer around the database adapter it hands to the library:

- on create of a `session` row, `token` is replaced by its hash before the insert, and the row handed back to the library carries the original token, because the library builds the cookie from that row;
- on every find, update, delete or count of `session` whose condition names `token` (one value or a list), the values are hashed, and rows found by token are handed back carrying the token that was asked for;
- a `session` row read any other way (by account, by id) carries the hash, which opens nothing;
- an update that would set `token` is refused;
- the library's own transaction call is routed to the edition's transaction runner (section 2.2).

No other model is touched. This was run against the library on the server's real store executor; the removal controls fail (section 15). The library's bearer extension is configured with `requireSignature: true`, so a token is accepted only in its signed form. A copy of the database therefore holds nothing that signs anyone in, with or without the signing secret.

Because rows read by account carry the hash, four library routes cannot work and are disabled in every edition: `/list-sessions`, `/revoke-session`, `/revoke-sessions`, `/revoke-other-sessions`. The package's device sign-in list and revoke by id replace them (section 2.7). podium-cloud does not call them today.

**No session token in a one-time code.** The library's one-time-token extension keeps the session token in clear in `verification.value` and needs a session to exist before a code is issued. The package does not use that extension. A code names an account, and the device sign-in is created by the statement group that redeems the code. So no sign-in exists for a code that is never redeemed, nothing has to be cleaned up except the expired code row, and an account with no login method needs no sign-in first.

### 1.7 The signing secret

The library signs cookie and bearer values with one secret. With hashed tokens the secret no longer guards the sign-ins; it guards OAuth state in the cloud and is a second factor against a stolen token store.

- Self-hosted: 32 random bytes, generated at first boot, stored in the server's `server_secrets` table under the internal key `identity.signingSecret` (not part of the secret presence list shown to admins). It is in the database, not a state-directory file as in the spike, so that it moves with the database on a server move, a backup and a restore; phones hold signed tokens and keep working after a move.
- Cloud: the existing `BETTER_AUTH_SECRET` setting, unchanged.

### 1.8 The member row gains one column

`users.membership_version` integer not null default 0: the version of the membership last applied to this row (section 2.6). `users.email` and `users.account_id` stay and are written only by apply-membership. No other column of `users` changes.

## 2. The package

Location `packages/identity`, name `@podium/identity`. It imports nothing from `apps/server`, `apps/daemon` or `apps/cli`. It may import `@podium/model` (ids, roles). Entry points:

| Entry | Holds |
|---|---|
| `@podium/identity` | `createIdentityCore`, every type in this section |
| `@podium/identity/schema/sqlite`, `@podium/identity/schema/pg` | table definitions |
| `@podium/identity/testing` | the shared test suite (section 10) |
| `@podium/identity/library` | re-exports of the library that only the cloud needs (the organisation extension, provider types). podium-cloud imports the library only through this entry, so one process holds one copy of it |

### 2.1 Edition configuration

```ts
export interface IdentityConfig {
  database: IdentityDatabase
  /** Signs cookie and bearer values (section 1.7). */
  secret: string
  loginMethods: {
    password: true
    google?: { clientId: string; clientSecret: string }
    github?: { clientId: string; clientSecret: string }
  }
  /** Sends invitation, verification and reset mail. null: nothing is ever mailed. */
  mail: IdentityMailer | null
  /** May a person create an account without an invitation? */
  selfSignUp: boolean
  /**
   * 'local': accounts exist only for this database's memberships. They are made by
   * setup or by accepting an invitation, and end with the membership.
   * 'shared': accounts outlive memberships (the cloud).
   */
  accounts: 'local' | 'shared'
  hosts: HostPolicy
  /** null: the same-machine rule does not exist in this edition. */
  sameMachine: { waived: () => boolean | Promise<boolean> } | null
  /** Absent: the library's own password hashing. */
  passwordHashing?: {
    hash(password: string): Promise<string>
    verify(input: { password: string; hash: string }): Promise<boolean>
  }
  rateLimit: { storage: 'memory' | 'database' }
  /** Mounts the library's own HTTP routes at this path. Absent: they are not reachable. */
  libraryRoutes?: { basePath: string; extensions?: LibraryExtension[] }
  /** Absent: the library's ids. */
  generateId?: (model: string) => string
  now?: () => Date
}

export type HostPolicy =
  /** Any host over HTTPS, and plain HTTP only on a same-machine connection. Cookies are host-only. */
  | { kind: 'self-hosted' }
  /** One sign-in origin and a cookie shared by its subdomains. */
  | { kind: 'fixed'; authUrl: string; appOrigin: string; cookieDomain: string }
```

The two editions:

| Field | Self-hosted server | Cloud |
|---|---|---|
| `database` | SQLite, the server's store (section 2.2) | Postgres |
| `secret` | from `server_secrets` | `BETTER_AUTH_SECRET` |
| `loginMethods` | password | password, Google, GitHub as configured |
| `mail` | null | the platform mailer |
| `selfSignUp` | false | true |
| `accounts` | `local` | `shared` |
| `hosts` | `self-hosted` | `fixed` |
| `sameMachine` | `{ waived }` reading the server's `authOpenMode` setting | null |
| `passwordHashing` | `hashPassword` and `verifyPasswordHash` of `@podium/runtime/auth-store` | absent |
| `rateLimit.storage` | `memory` | `database` |
| `libraryRoutes` | absent | `/platform/auth`, with the organisation extension |
| `generateId` | absent | the platform's branded ids |

What `accounts: 'local'` changes, and nothing else does:

- password sign-in is refused, with the same answer as a wrong password, for an account that has no active membership;
- disabling a membership ends the account's device sign-ins; removing one also deletes the account, its login methods and its unused invitations and codes. This is today's behaviour of `disable` and `removeMember`.

With `accounts: 'shared'` a membership change never touches the account or its device sign-ins.

Fixed library settings in both editions: device sign-ins last 30 days and are renewed at most once a day; the cookie cache is off; the cookie prefix is `podium`; `disableSignUp` is the inverse of `selfSignUp`; account linking is on only when a provider is configured; the four session routes named in section 1.6 are disabled.

### 2.2 The database port

```ts
export type IdentityDatabase =
  | { dialect: 'sqlite'; db: SqliteDb; transaction: TransactionPort<SqliteDb> }
  | { dialect: 'pg'; db: PgDb; transaction: TransactionPort<PgDb> }

/** Runs fn in one transaction and hands it the handle its statements must use. */
export type TransactionPort<Db> = <T>(fn: (db: Db) => Promise<T>) => Promise<T>
```

- Self-hosted: `db` is the store's one drizzle instance (`StoreQueries.rootDb`) and `transaction` is `(fn) => createOrJoinTransaction(() => fn(rootDb))`. The store routes every statement to the current transaction, so library statements, the package's statements and the server's own repository writes join one transaction and roll back together. Run in section 15: an account and a device sign-in created by the library and a member row written by `UsersRepository` in one server transaction all disappear on rollback.
- Cloud: `db` is the platform's drizzle instance and `transaction` is `(fn) => db.transaction(fn)`.
- The library adapter is built with its own transaction support off (`transaction: false`) and wrapped by the hashing layer, whose `transaction` calls the port. Inside a transaction of the package, library calls run under the library's `runWithAdapter` with an adapter bound to the handle the port gave, so they use the same transaction on Postgres too.
- Drizzle's own `db.transaction()` is never called on the server's store. The executor does not know such a span.

**Statement policy** (the server's rule "prepared once", `docs/agents/server-data.md`):

1. The package's own statements are defined once per core and reused: resolution, revalidation, membership reads and writes, invitation and code redemption, device list. `prepared-guard.test.ts` and `query-plan-audit.test.ts` are extended to `packages/identity/src`.
2. The library builds its statements on every call. That cannot be changed from outside, so library statements are allowed only where a person performs a ceremony: sign-in, sign-out, renewal (at most once a day per device), account and password writes, the mail flows. They never run on the per-request path, on the socket heartbeat or in a loop.
3. Statement counts are pinned (rule 8): resolving a request is one statement, revalidating a socket is one statement, each for 5 and for 200 accounts.
4. The statements the library issues during the shared suite are captured at the driver and each is planned with `EXPLAIN QUERY PLAN`; a table scan fails the SQLite leg.
5. The package hashes a new password before opening its own write transaction. Hosted password issuance, email verification, mailed reset and provider recovery serialize on the account row; their final password and live-session checks run under that lock so an old password or revoked session cannot survive concurrent recovery.

### 2.3 Creating the core

```ts
export function createIdentityCore(config: IdentityConfig): Promise<IdentityCore>

export interface IdentityCore {
  capabilities(): Capabilities                       // section 2.9
  accounts: AccountOperations                        // section 2.4
  signIn: SignInOperations                           // section 2.4
  deviceSignIns: DeviceSignInOperations              // section 2.7
  codes: OneTimeCodeOperations                       // section 2.8
  /** The workspace-bound half. A server process holds exactly one. */
  workspace(id: string, members: MemberRowsBinding): WorkspaceIdentity
  /** Present when `libraryRoutes` is configured: the library's own HTTP handler. */
  libraryHandler?: (request: Request, facts: ConnectionFacts) => Promise<Response>
  /** Deletes expired invitations and one-time codes. Called by the server on a timer, hourly. */
  sweep(): Promise<void>
}

export interface WorkspaceIdentity {
  readonly workspaceId: string
  readonly core: IdentityCore
  resolve(request: Request, facts: ConnectionFacts): Promise<Resolution>          // section 2.5
  revalidate(held: HeldSignIn): Promise<boolean>                                   // section 2.5
  renew(request: Request, facts: ConnectionFacts): Promise<Headers>                // section 2.5
  signInRequired(): Promise<boolean>                                               // section 5.5
  memberships: MembershipOperations                                                // section 2.6
  listDeviceSignIns(page: { limit: number }): Promise<{ signIns: DeviceSignIn[]; total: number }>
  /** Hosted only: apply every membership change this workspace has not applied yet (section 11). */
  catchUp(): Promise<{ applied: number }>
}
```

**Connection facts.** The server works out three facts about a request at its existing trust boundary and passes them with every call. The package never reads `Host`, `Forwarded` or any `X-Forwarded-*` header.

```ts
export interface ConnectionFacts {
  /** 'https': the server ended TLS itself, or the trusted proxy hop reported https. */
  scheme: 'https' | 'http'
  /** The peer is this machine: loopback peer address, loopback host, no proxy hop. */
  sameMachine: boolean
  /** The client's address for throttling: the peer, or the trusted hop's value. null: unknown. */
  clientAddress: string | null
}
```

The server computes them once per request from what it already has: `isSecureRequest(url, x-forwarded-proto, trustedProxyHops)`, `isHostLocalRequest(observedRequest)` and `clientAddressForRequest(request, peerAddress, trustedProxyHops)`. The peer address is the one the native server reported for the socket. A forwarded value is read only at the position `trustedProxyHops` names, which the operator's own proxy wrote; with zero trusted hops no forwarded header is read at all. A server bound to a loopback address trusts one hop by default (`resolveTrustedProxyHops`), so Tailscale Serve or a reverse proxy on the same machine needs no setting.

**Two cookie configurations.** For `hosts.kind = 'self-hosted'` the core holds two configurations of the library on the same database and secret (spike row 4):

| Facts | Configuration | Cookie |
|---|---|---|
| `scheme = 'https'` | secure | `__Secure-podium.session_token`, Secure, HttpOnly, SameSite=Lax, host-only |
| `scheme = 'http'` and `sameMachine` | loopback | `podium.session_token`, HttpOnly, SameSite=Lax, host-only |
| `scheme = 'http'` and not `sameMachine` | none | every sign-in operation answers `https_required` (HTTP 400) |

The choice uses only the facts. For sign-in and sign-out the package calls the library's request handler, so the library's own limiter and checks run, but with a fresh request it builds itself: the path it wants on the configuration's own fixed base address, that address as `Origin`, only the `cookie`, `authorization`, `user-agent` and `content-type` headers of the caller, and one header of its own carrying `facts.clientAddress`. The library is told to read the client address from that header alone. It therefore never sees a host, an origin or a forwarding header a caller chose, and needs no list of allowed hosts. Cookies carry no `Domain`, so each binds to the host the browser used.

Because the library no longer sees the caller's origin, the server checks it first: `POST /auth/login`, `POST /auth/logout` and every other `/auth/*` route that changes something refuse a foreign `Origin` with `isAllowedHttpOrigin`, as the member and admin routes do today. For the login and logout routes this check is new (POD-6746).

Plain HTTP on a same-machine connection is the all-in-one app talking to its embedded server. A browser or the `podium` command on the same machine reaches the same listener and is treated the same: the server cannot tell them apart and none of them crosses a network. This is listed for the coordinator (section 17, question 2).

For `hosts.kind = 'fixed'` there is one configuration, as the cloud has today: base address `authUrl`, trusted origin `appOrigin`, a secure cookie shared across `cookieDomain`.

Direct library calls that pass a request set `asResponse: false` (spike, P6).

### 2.4 Accounts and sign-in

```ts
export interface AccountOperations {
  /** Server-side creation; self sign-up plays no part. Email absent: a generated identifier (section 7). */
  create(input: { name: string; email?: string; password?: string; passwordHash?: string }): Promise<Account>
  get(accountId: string): Promise<Account | undefined>
  byEmail(email: string): Promise<Account | undefined>
  hasPassword(accountId: string): Promise<boolean>
  verifyPassword(accountId: string, password: string): Promise<boolean>
  /** Replaces or creates the password login method. Does not end device sign-ins. */
  setPassword(accountId: string, password: string): Promise<void>
  /** The same, from a hash of this edition's own format; anything else is refused. Server code only (section 16, row 51). */
  setPasswordHash(accountId: string, passwordHash: string): Promise<void>
  /** Changes the identifier. Refused when another account holds it. */
  setEmail(accountId: string, email: string): Promise<void>
  updateProfile(accountId: string, profile: { name?: string; image?: string | null }): Promise<void>
}

export interface Account {
  id: string
  name: string
  /** null when the identifier is generated. */
  email: string | null
  image: string | null
}

export interface SignInOperations {
  /** How the sign-in screen must ask (section 7). */
  prompt(): Promise<'password' | 'email-password'>
  password(input: {
    email?: string
    password: string
    device: DeviceDescription
    delivery: 'cookie' | 'bearer'
  }, facts: ConnectionFacts): Promise<IssuedSignIn | SignInRefusal>
  signOut(request: Request, facts: ConnectionFacts): Promise<{ deviceSignInId: string | null; headers: Headers }>
}

export type SignInRefusal =
  | { refused: 'invalid' }                 // wrong identifier, wrong password, no active membership
  | { refused: 'throttled'; retryAfterSeconds: number }
  | { refused: 'https_required' }

export interface IssuedSignIn {
  deviceSignInId: string
  accountId: string
  expiresAt: Date
  /** delivery 'cookie': the Set-Cookie headers to add to the response. */
  headers: Headers
  /** delivery 'bearer': the signed token, shown once. */
  bearer: string | null
}

export interface DeviceDescription {
  kind: 'browser' | 'desktop' | 'phone' | 'host'
  name?: string
  deviceId?: string
  platform?: string
}
```

Rules:

- Hosted self sign-up stays open, but an unverified account has no workspace authority and cannot accept an invitation. Invitation acceptance requires a verified email matching its invited address.
- A mailed verification token proves the address, not ownership of a password registration. Before initially marking the address verified, require a live session of that same account or its current password. On a second device, the account client asks for the password; verification itself creates no sign-in. A different account's session is not proof.
- A person who did not create a password registration recovers through a mailed password reset: the single-use token proves the address, installs their new password, marks the address verified and ends all browser and device sign-ins, including pending hand-overs authorized by them. Password checks and changes cannot race past that revocation.
- Link a provider only when both sides have proved the same address. A verified provider meeting an unverified password registration first removes its password and sessions, then marks the account verified and links. An already verified password account keeps its password when linking the same verified provider email.
- A change of an account's name, picture or email adds one to the version of each of its memberships (through the workspace revision), so apply-membership copies the new facts to the member rows. The package installs this as a library database hook on the account, so a change made through the library's own profile route in the cloud is covered.
- `signIn.password` keeps today's throttle: eight failures for one identifier lock that identifier for five minutes; at most 10,000 identifiers are tracked; a request without an email is counted under one fixed key. The counters are in memory, per process (section 13.4).
- A bearer is delivered only when the request carries no `Origin` header and `facts.scheme` is `https`, as today's native login.
- `signOut` ends the one device sign-in the request carries and clears its cookie.

### 2.5 From a request to a member

```ts
export type Resolution =
  | {
      kind: 'member'
      memberId: string
      role: 'admin' | 'member'
      accountId: string
      /** null: admitted by the same-machine rule; no device signed in. */
      deviceSignIn: { id: string; kind: DeviceDescription['kind']; expiresAt: Date } | null
      /** The sign-in is due for its daily renewal; call renew() where a response can carry a cookie. */
      renewDue: boolean
    }
  | { kind: 'not-a-member'; accountId: string; membership: 'none' | 'invited' | 'disabled' | 'removed' }
  | { kind: 'unauthenticated' }
  | { kind: 'https_required' }

export type HeldSignIn =
  | { deviceSignInId: string; memberId: string; role: 'admin' | 'member' }
  | { sameMachine: true; memberId: string; role: 'admin' | 'member' }
```

`resolve` is the one path from a credential to a member, for every transport. A request with `facts.scheme = 'http'` that is not same-machine is answered `https_required` before anything is read. Otherwise its steps:

1. Find the candidate token. `Authorization: Bearer` is read only when `facts.scheme` is `https` and only in the signed form. Otherwise the cookie of the configuration the facts select (section 2.3). A request that carries both uses the bearer.
2. Check the signature with the secret (HMAC-SHA-256 over the token, the library's cookie format). A value that fails is treated as no credential.
3. Hash the token and run one statement of the package: device sign-in by hashed token, not expired, joined to its account and to that account's membership in this workspace. The statement returns the sign-in, the membership's member id, role, status and version, or no row.
4. An `active` membership answers `member`. Any other membership, or none, answers `not-a-member`.
5. No valid credential: the same-machine rule (section 5.5). It answers `member` with `deviceSignIn: null`, or `unauthenticated`.
6. At most once per five minutes per sign-in, `last_seen_at` is written (one statement).

`resolve` never calls the library. `renewDue` is true when the sign-in is not `fixed_expiry` and was last renewed more than a day ago. `renew` then calls the library's session read once, which extends the expiry and returns the cookie to set; for a bearer it only extends the expiry. A sign-in with `fixed_expiry` is never handed to the library's session read.

`revalidate` is one statement: the held device sign-in still exists and is not expired, and the membership of its account in this workspace is still `active` with the same member id and role. For a holder admitted by the same-machine rule it evaluates the rule again.

In a hosted workspace the statement of step 3 runs on Postgres, so a membership that was disabled or removed is refused on the next request without waiting for section 11. The member row is not read by `resolve`; the server reads it as it does today, per operation.

### 2.6 Membership operations and apply-membership

```ts
export interface MembershipOperations {
  list(): Promise<MembershipView[]>
  /**
   * A membership without an invitation, for system actors only:
   * 'setup' and 'organisation': the first membership of a workspace that has none (role admin);
   * 'upgrade': a member row that exists and has no membership (section 8.2).
   */
  adopt(input: {
    by: 'setup' | 'organisation' | 'upgrade'
    memberId?: string
    role: 'admin' | 'member'
    status: 'invited' | 'active' | 'disabled'
    account: AccountRef | null
  }): Promise<MembershipView>
  invite(input: { actor: Actor; role: 'admin' | 'member'; email?: string; memberId?: string; expiresInDays?: number }):
    Promise<{ membership: MembershipView; invitation: IssuedInvitation; mailed: boolean }>
  revokeInvitation(input: { actor: Actor; invitationId: string }): Promise<void>
  inspectInvitation(token: string): Promise<{ email: string | null; expiresAt: Date; needsAccount: boolean }>
  accept(input: { token: string; account: AccountRef }): Promise<{ memberId: string; accountId: string }>
  setRole(input: { actor: Actor; memberId: string; role: 'admin' | 'member' }): Promise<void>
  disable(input: { actor: Actor; memberId: string }): Promise<void>
  enable(input: { actor: Actor; memberId: string }): Promise<void>
  remove(input: { actor: Actor; memberId: string }): Promise<void>
  /** Cloud: every live membership of this account in the given workspaces becomes removed. */
  endForAccount(input: { accountId: string; workspaceIds: string[] | 'all'; by: 'organisation' | 'account-deleted' }): Promise<void>
  /** The account of a member whose membership here is active. One statement by primary key. Added for the sign-in carry-over (POD-6751). */
  accountOfActiveMember(memberId: string): Promise<string | undefined>
}

export type Actor = { memberId: string } | { system: 'host' | 'setup' | 'organisation' | 'upgrade' }
export type AccountRef =
  | { kind: 'existing'; accountId: string }
  | { kind: 'new'; name: string; email?: string; password?: string; passwordHash?: string }

export interface IssuedInvitation { id: string; token: string; expiresAt: Date }

export interface MembershipView {
  memberId: string
  role: 'admin' | 'member'
  status: 'invited' | 'active' | 'disabled' | 'removed'
  version: number
  account: Account | null
  invitedEmail: string | null
  hasPassword: boolean
  pendingInvitation: { id: string; expiresAt: Date } | null
}

export class MembershipRefused extends Error {
  readonly code:
    | 'admin-required' | 'last-admin' | 'self' | 'unavailable'
    | 'invitation-invalid' | 'already-a-member' | 'email-mismatch' | 'not-allowed'
}
```

Every operation runs in one transaction of the database port and does, in this order: check the actor, check the rule, change the membership, step the workspace revision, and, where member rows share the database, apply the membership.

Rules, each checked inside the transaction:

- **Actor.** A member actor must have an `active` membership with role `admin`. A system actor is accepted only from code, never from a request body.
- **Last admin.** `setRole` to `member`, `disable` and `remove` are refused with `last-admin` when the target is the only `active` membership with role `admin`. A member cannot disable or remove themselves (`self`).
- **Invite.** A new invitation mints a member id and a membership in status `invited`. An invitation that names a member is allowed only when that membership is `removed`, or `disabled` with no account, or absent while the member row exists (a move, PDM-512); the membership becomes `invited` and keeps the member id. Inviting with role `admin` is a role grant; the routes ask for the actor's password first, as today.
- **Accept.** The token must be usable (section 1.5). In one transaction: the invitation is consumed by `update … set consumed_at where id = ? and consumed_at is null`, and the operation stops when that changed no row; the account is created (`new`) or taken (`existing`); the membership becomes `active` with that account; the member row is applied. Two accepts at the same moment therefore yield one member. An invitation with an email is accepted only by an account with that address; `existing` is refused when the account already has a live membership in the workspace (`already-a-member`). The password of a `new` account is hashed before the transaction opens.
- **Remove.** The membership becomes `removed`. With `accounts: 'local'` the account, its login methods, its device sign-ins and its unused invitations and codes are deleted in the same transaction.
- **Disable.** With `accounts: 'local'` the account's device sign-ins are deleted in the same transaction.
- **No member before acceptance.** A membership in status `invited` has no member row, unless the invitation named an existing one.

**apply-membership.**

```ts
/** The only function that changes a member row's identity facts. */
export function applyMembership(rows: MemberRows, membership: MembershipSnapshot): Promise<void>

export interface MembershipSnapshot {
  memberId: string
  version: number
  status: 'invited' | 'active' | 'disabled' | 'removed'
  role: 'admin' | 'member'
  accountId: string | null
  profile: { name: string; image: string | null; email: string | null } | null
  actor: Actor
}

/** Implemented by the server over its users repository. Nothing else may call write(). */
export interface MemberRows {
  write(change: MemberWrite): Promise<void>
}

export interface MemberWrite {
  memberId: string
  version: number
  state: 'active' | 'disabled' | 'removed'
  role: 'admin' | 'member'
  accountId: string | null
  profile: { name: string; image: string | null; email: string | null } | null
  actor: Actor
}

export type MemberRowsBinding =
  /** Member rows are in the membership database: apply inside the membership transaction. */
  | { rows: MemberRows; sameDatabase: true }
  /** Member rows are elsewhere: apply after the commit, through catchUp (section 11). */
  | { rows: MemberRows; sameDatabase: false; cursor: AppliedCursor }

export interface AppliedCursor {
  read(): Promise<number>
  write(version: number): Promise<void>
}
```

`applyMembership` does nothing for status `invited` and otherwise calls `rows.write` once. The server's implementation, one method of `UsersRepository` in one transaction, does:

| Case | Member row | Authorization generation | Other effects |
|---|---|---|---|
| `change.version` is not above `users.membership_version` | nothing | nothing | none (applying twice is harmless) |
| no row, state `active` | inserted with role, name, picture, email, account id | not stepped | audit `members.join` |
| role differs | role written | stepped, reason `role` | audit `members.setRole` |
| `active` to `disabled` | `disabled_at` set | stepped, reason `disabled` | audit `members.disable` |
| `disabled` to `active` | `disabled_at` cleared | stepped, reason `enabled` | audit `members.enable` |
| to `removed` | `disabled_at` set if it was not | stepped, reason `removed` | machine custody released and incoming grants deleted exactly as `removeMember` does today; audit `members.remove` per machine |
| name, picture, email or account id differs | written | not stepped | none |
| always | `membership_version` set to `change.version` | | |

A removed member is a disabled member row, as today; only the membership tells the two apart, so no gate learns a new fact. Stepping the generation publishes the existing `MemberAccessChange`, which closes sockets and refuses queued work as built (POD-6293). The reason `signed-out` is no longer produced: ending device sign-ins closes the sockets of those sign-ins by their id (section 5.3) and does not touch the generation (rule 7).

Audit rows keep their command names and never hold a token or an address. They are written by the server: by `MemberRows.write` for the cases above, and by the route for events that change no member row (`members.invite`, `members.inviteRevoked`, `members.recoveryIssued`, `members.recover`, `members.signOut`, `members.revokeSignIn`).

### 2.7 Device sign-ins

```ts
export interface DeviceSignInOperations {
  listForAccount(accountId: string, current?: string): Promise<DeviceSignIn[]>
  /**
   * Ends one sign-in. byAccount: only when it belongs to that account.
   * Without the guard it is an admin's act; a route may call it so only when
   * the capability adminEndDeviceSignIn is true.
   */
  revoke(id: string, guard?: { byAccount: string }): Promise<{ revoked: boolean; accountId: string | null }>
  revokeAllForAccount(accountId: string, except?: string): Promise<string[]>   // the ids ended
  /** Used by code redemption and by tests. Never reachable from a request without a code or a password. */
  create(accountId: string, device: DeviceDescription, delivery: 'cookie' | 'bearer',
         facts: ConnectionFacts, life?: { expiresAt: Date; fixed: boolean }): Promise<IssuedSignIn>
}

export interface DeviceSignIn {
  id: string
  accountId: string
  kind: 'browser' | 'desktop' | 'phone' | 'host'
  deviceName: string
  platform: string
  createdAt: Date
  lastSeenAt: Date | null
  expiresAt: Date
  current: boolean
}
```

No token and no hash leaves these operations. `WorkspaceIdentity.listDeviceSignIns` returns the unexpired sign-ins of the accounts that hold an `active` or `disabled` membership in the workspace, latest expiry first, for the Access screen.

### 2.8 One-time codes

```ts
export interface OneTimeCodeOperations {
  /** A code for an account, made by that account's signed-in device, by an admin, or by the host. */
  issue(input: {
    purpose: 'pair-device' | 'password-reset' | 'host-sign-in' | 'transfer-claim'
    accountId: string
    createdBy: string
    ttlMs?: number
    signInLife?: { ttlMs: number; fixed: boolean }
  }): Promise<{ id: string; code: string; expiresAt: Date }>

  /** pair-device: the receiving device presents the code and binds its own verifier. */
  claim(input: { code: string; challenge: string; device: DeviceDescription; delivery: 'cookie' | 'bearer' }):
    Promise<{ claimId: string; phrase: [string, string, string]; expiresAt: Date } | undefined>
  status(id: string, accountId: string): Promise<CodeStatus>
  decide(id: string, accountId: string, decision: 'approved' | 'denied'): Promise<boolean>

  /** hand-over: the receiving device starts the attempt; a signed-in account authorises it. */
  begin(input: { purpose: 'hand-over'; challenge: string }): Promise<{ id: string; expiresAt: Date }>
  authorise(input: { challenge: string; accountId: string; sourceSignInId: string }):
    Promise<{ code: string; expiresAt: Date } | 'ended' | undefined>

  /** Turns a code into a device sign-in. Atomic; a code works once. */
  redeem(input: { code: string; verifier?: string } | { claimId: string; verifier: string },
         device: DeviceDescription, delivery: 'cookie' | 'bearer', facts: ConnectionFacts):
    Promise<IssuedSignIn | 'pending' | undefined>

  inspectPasswordReset(code: string): Promise<{ email: string | null; expiresAt: Date } | undefined>
  redeemPasswordReset(input: { code: string; password: string }): Promise<{ accountId: string; endedSignInIds: string[] } | undefined>
}
```

| Purpose | Who issues | Lifetime | Receiver bound | Approval | Redeeming yields |
|---|---|---|---|---|---|
| `pair-device` | a signed-in device of the account (`issue`) | 2 minutes | yes, at `claim` | yes: the signed-in device approves the claimed device by its three-word phrase | a `phone` sign-in, 30 days, renewing |
| `hand-over` | the receiving device (`begin`), then a signed-in account (`authorise`) | attempt 10 minutes; code 3 minutes, never beyond the attempt or the authorising sign-in | yes, at `begin` | no | a `desktop` or `phone` sign-in that expires when the authorising sign-in would |
| `password-reset` | an admin for a member's account, or the host | 24 hours (admin, host) | no | no | a new password; every device sign-in of the account ends |
| `host-sign-in` | the host control socket | 60 seconds | no | no | a `host` sign-in with the lifetime the operator asked for, `fixed_expiry` |
| `transfer-claim` | the server, for each connected client, before a server move | 10 minutes | no | no | a `browser` or `desktop` sign-in, 30 days, renewing |

Redemption is one transaction:

1. `update identity_one_time_code set consumed_at = now where <key> and consumed_at is null and expires_at > now and account_id is not null and approval in ('none', 'approved') returning *`, where the key is the code hash or the claim id. No row: nothing happened, the answer is `undefined` (or `pending` when the row exists with approval `pending`).
2. When the row has a receiver challenge, the SHA-256 of the presented verifier must equal it. A mismatch rolls the transaction back, adds one to `failed_attempts` in a transaction of its own, and denies the attempt at the fifth.
3. For a hand-over, the authorising device sign-in must still exist and be unexpired.
4. The account must still exist; with `accounts: 'local'` it must have an active membership.
5. The device sign-in is created.

Two redemptions at the same moment: the update of step 1 changes one row for one of them. Section 12 maps the cloud's hand-over onto these steps. Expired rows are deleted by `sweep`.

### 2.9 The capability list

```ts
export interface Capabilities {
  version: 1
  /** A password form is offered. */
  passwordSignIn: boolean
  /** The provider buttons to show. */
  providers: Array<'google' | 'github'>
  /** A person may create an account without an invitation. */
  selfSignUp: boolean
  /** 'link': the admin copies a link. 'mail': the server mails the invitee. */
  invitationDelivery: 'link' | 'mail'
  /** 'admin-link': an admin or the host issues a link. 'mail': the person asks for a mail. */
  passwordReset: 'admin-link' | 'mail'
  emailVerification: boolean
  organisations: boolean
  /** A one-person server may waive sign-in on its own machine. */
  sameMachineSignIn: boolean
  /** An admin may end every device sign-in of another member. */
  adminSignOutEverywhere: boolean
  /** An admin may end one device sign-in of another member. */
  adminEndDeviceSignIn: boolean
  /** Where a person signs in and manages their account when that is not this server. */
  accountUrl: string | null
}
```

| Field | Self-hosted | Cloud | Derived from |
|---|---|---|---|
| `passwordSignIn` | true | true | `loginMethods.password` |
| `providers` | `[]` | the configured ones | `loginMethods` |
| `selfSignUp` | false | true | `selfSignUp` |
| `invitationDelivery` | `link` | `mail` | `mail` |
| `passwordReset` | `admin-link` | `mail` | `mail` |
| `emailVerification` | false | true | `mail` |
| `organisations` | false | true | the organisation extension is present |
| `sameMachineSignIn` | true | false | `sameMachine` |
| `adminSignOutEverywhere` | true | false | `accounts` |
| `adminEndDeviceSignIn` | true | false | `accounts` |
| `accountUrl` | null | the account pages | `hosts` |

The list is fixed for the life of a process. The server returns it in `GET /auth/status` as `capabilities`, to every caller, signed in or not; it holds no secret. `mode` and `signInUrl` leave that response. `adminSignOutEverywhere` and `adminEndDeviceSignIn` are not in plan section 3. They are needed because a device sign-in in the cloud belongs to the person's account and serves their other workspaces too: a hosted admin's tools are disable and remove, and only the person ends their own sign-ins (plan section 5; coordinator's decision of 2026-11-10). A self-hosted admin keeps both, as today (section 16).

## 3. The seam between the hosted composition root and the server

```ts
// apps/server, startServer options
identity?: (deps: {
  memberRows: MemberRows
  appliedCursor: AppliedCursor
  /** Every member row, disabled ones included, in creation order, earliest first. */
  existingMembers(): Promise<Array<{
    memberId: string; role: 'admin' | 'member'; disabled: boolean; accountId: string | null
  }>>
}) => WorkspaceIdentity | Promise<WorkspaceIdentity>
```

The types are `IdentitySeam`, `IdentitySeamDeps` and `ExistingMember` in `apps/server/src/identity/server-identity.ts`, exported from `@podium/server`.

- **Absent** (every self-hosted server): the server opens its store, reads or creates the signing secret, builds the core with the self-hosted configuration of section 2.1 on its own database, and takes `core.workspace('local', { rows: memberRows, sameDatabase: true })`.
- **Present** (the hosted root): podium-cloud builds one core on Postgres for the process and passes `({ memberRows, appliedCursor }) => platform.identity.workspace(workspaceId, { rows: memberRows, sameDatabase: false, cursor: appliedCursor })`. It is a function because the member rows port exists only after the server has opened its store.

`memberRows` is the server's implementation of `MemberRows`. `appliedCursor` reads and writes one number in the server's `meta` table (key `identity.appliedMembershipVersion`). `existingMembers` is read-only and carries no name, address or secret; the hosted root calls it once per boot, before the server serves, to adopt the rows that carry an account id (section 8.2) and to find the earliest enabled admin row without one.

The server uses the `WorkspaceIdentity` it ends up with for everything in sections 4 and 5 and does not know which database is behind it. With the option present the server also calls `catchUp()` before it serves requests and on a timer (section 11). The cloud plugin keeps mounting its own routes through `PodiumPluginHooks.hono`.

Sign-in resolution, membership operations and session response headers come from the shared identity package. Account and profile changes reach member rows through apply-membership; resolving a request creates no member row.

One process holds one copy of the library. The package is resolved from the open-source tree, so the library it imports is the open-source tree's copy; podium-cloud must take the organisation extension from `@podium/identity/library` and drop its own dependency on `better-auth`, `@better-auth/drizzle-adapter` and `better-call`. PDM-495 adds an assertion to `apps/hosted-server/src/boundary.test.ts`, beside the one for `hono`: exactly one `better-auth` and one `@better-auth/core` directory in the bundle. `drizzle-orm` is pinned to the same exact version in both repositories; the Postgres handle comes from podium-cloud's copy and the table definitions from the open-source copy. The Postgres leg of the suite (section 10) is the proof that this works. If it does not, the fallback is that the package builds the Postgres handle itself from a `postgres.js` client podium-cloud passes in (`@podium/identity/pg`), which puts every drizzle object in one copy.

## 4. Route map

The lists were produced at `f92564c0d7` with:

```sh
git grep -nE "(app|routes)\.(get|post|put|patch|delete|all|route)\(" f92564c0d7 -- \
  apps/server/src/auth-route.ts apps/server/src/member-routes.ts \
  apps/server/src/admin-routes.ts apps/server/src/mobile-pairing-route.ts
git grep -nE "req\.url ===" f92564c0d7 -- apps/server/src/control-socket.ts
```

34 route registrations and three control socket paths matched; every one is in a table below. "Stays" means the path and method stay; what answers changes as stated.

### 4.1 `auth-route.ts`

| Route | After | Task |
|---|---|---|
| `GET /auth/status` | Stays. `needsAuth` is `workspace.signInRequired()`; `authed`, `userId`, `memberId` come from `resolve`; adds `capabilities`, `prompt` (section 7) and, for a `not-a-member` resolution, `denied: 'not_workspace_member'`. Drops `mode`, `signInUrl`, `providerSignedIn`, `deniedReason` | POD-6746 |
| `GET /auth/server-transfer-claim` | Stays (the page that posts the claim from the URL fragment) | POD-6748 |
| `POST /auth/server-transfer-claim` | Stays. Redeems a `transfer-claim` code for a device sign-in and sets its cookie | POD-6748 |
| `POST /auth/login` | Stays. Calls `signIn.password`. `delivery: 'native'` answers the signed bearer. The body's `userId` field is dropped | POD-6746 |
| `POST /auth/logout` | Stays. Calls `signIn.signOut` and closes the sockets of that device sign-in | POD-6746 |

### 4.2 `member-routes.ts` (`/auth/members/…`)

| Route | After | Task |
|---|---|---|
| `GET /list` | Stays, admin only. Members, statuses and pending invitations from `memberships.list()`; `actions` computed from it by the same rules as `memberActions`. Drops `mailAvailable` (the capability list says it) | POD-6747 |
| `GET /directory` | Stays unchanged; it reads member rows. Only the caller comes from `resolve` | POD-6747 |
| `POST /invite` | Stays. `memberships.invite`. Drops `sendEmail`: delivery follows `invitationDelivery`. Answers the link when delivery is `link` | POD-6747 |
| `POST /revoke` | Stays. `memberships.revokeInvitation` | POD-6747 |
| `POST /remove` | Stays. `memberships.remove` | POD-6747 |
| `POST /role` | Stays. `memberships.setRole` | POD-6747 |
| `POST /disable` | Stays. `memberships.disable` | POD-6747 |
| `POST /enable` | Stays. `memberships.enable` | POD-6747 |
| `POST /recovery` | Stays. Issues a `password-reset` code for the member's account and answers the link. Refused unless `passwordReset` is `admin-link` | POD-6747 |
| `POST /sign-out-everywhere` | Stays. For oneself: `deviceSignIns.revokeAllForAccount`. For another member: admin only and only when `adminSignOutEverywhere`. Closes the sockets of the ended sign-ins. The authorization generation is not stepped | POD-6747 |
| `POST /inspect` | Stays. Looks the token up as an invitation, then as a `password-reset` code, and answers `kind: 'invitation' \| 'password-reset'`, the address and the expiry. One link form stays: `#invite=<token>` | POD-6747 |
| `POST /complete` | Stays. For an invitation: `memberships.accept` with a new account; it answers the member id and the person then signs in, as today. For a reset code: `codes.redeemPasswordReset` | POD-6747 |
| `/auth/members` (mount) | Stays | POD-6747 |

The "confirm with your current password" check on role and credential changes stays and calls `accounts.verifyPassword`. An account without a password passes it, as today.

### 4.3 `admin-routes.ts` (`/auth/admin/…`)

| Route | After | Task |
|---|---|---|
| `GET /viewer` | Stays unchanged | POD-6747 |
| `GET /access` | Stays for the admission facts: counts of invited, active and disabled memberships and of open and expired invitations, from the package. The `signIns` and `signInsTotal` fields move to the new route below | POD-6747 |
| `POST /sign-ins/revoke` | Moves to `sign-in-routes.ts`, same path. Refused with 403 unless `adminEndDeviceSignIn`, so it works on a self-hosted server and never in a hosted workspace. `deviceSignIns.revoke(id)` for a sign-in of an account that is a member here; closes its sockets; audit `members.revokeSignIn` | POD-6748 |
| `GET /audit` | Stays unchanged | POD-6747 |
| `/auth/admin` (mount) | Stays | POD-6747 |
| new `GET /auth/admin/sign-ins` | In the new file `sign-in-routes.ts`: `workspace.listDeviceSignIns`, at most 200, with the total. Read-only, in both editions | POD-6748 |

The split keeps the two tasks that run side by side out of each other's files: POD-6747 owns `admin-routes.ts`, POD-6748 owns the new `sign-in-routes.ts` and removes the sign-in block from `/access` in one small agreed edit (section 16).

### 4.4 `mobile-pairing-route.ts`

| Route | After | Task |
|---|---|---|
| `POST /auth/mobile-pair/start` | Stays. `codes.issue({ purpose: 'pair-device' })` for the caller's account; needs a device sign-in, not the same-machine rule. Still answers `mode: 'open'` when sign-in is not required | POD-6748 |
| `POST /auth/mobile-pair/claim` | Stays. `codes.claim`; the phone sends the hash of its secret as the challenge, as it does today (`claimHash`) | POD-6748 |
| `POST /auth/mobile-pair/status` | Stays. `codes.status` | POD-6748 |
| `POST /auth/mobile-pair/approve` | Stays. `codes.decide(…, 'approved')` | POD-6748 |
| `POST /auth/mobile-pair/deny` | Stays. `codes.decide(…, 'denied')` | POD-6748 |
| `POST /auth/mobile-pair/complete` | Stays. `codes.redeem({ claimId, verifier })`; answers the cookie or the signed bearer | POD-6748 |
| `GET /auth/client-sessions` | Stays. The caller's device sign-ins from `deviceSignIns.listForAccount`. The answer becomes `{ signIns }` with `id`, `kind`, `deviceName`, `platform`, `createdAt`, `lastSeenAt`, `expiresAt`, `current`; `label` and `?include=all` go | POD-6748 |
| `POST /auth/client-sessions/revoke` | Stays. `deviceSignIns.revoke(id, { byAccount })`; closes that sign-in's sockets | POD-6748 |

Pairing state is the shared one-time code row, so pairing works when a hosted workspace's requests reach different processes. The pairing failure throttle per client address stays in the route.

### 4.5 Host control socket and host commands

| Today | After | Task |
|---|---|---|
| `GET /v1/login-password` | Stays. True when the earliest admin's account has a password | POD-6747 |
| `POST /v1/login-password` (`podium setup`) | Stays. `accounts.setPassword` for the earliest admin's account. This is the host command that recovers a last admin who has no email | POD-6747 |
| `POST /v1/member-recovery` (`podium auth recovery-link <email>`) | Stays. Issues a `password-reset` code for the account with that email, created by `host`; audit `members.recoveryIssued` with `by: 'host'` | POD-6747 |
| `podium auth mint-session` (host command) | New `POST /v1/host-sign-in {ttlMs?}`: issues a `host-sign-in` code; the command redeems it at once over loopback and caches the signed token as today. Refused when the workspace has more than one membership that is not `removed`, the existing single-membership rule. The server must be running | POD-6748 |
| `podium auth sessions`, `podium auth revoke-sessions [--label]` read and delete `client_sessions` directly | New `GET /v1/sign-ins` and `POST /v1/sign-ins/revoke {kind}` on the control socket; the default kind is `host` | POD-6748 |
| `/v1/public-url`, `/v1/tunnel-health`, `/v1/connect-publish`, `/v1/diagnostics` | Not sign-in; unchanged | none |

The control socket is a user-only unix socket, so these are refused over the network by construction; POD-6747 and POD-6748 each keep the test that says so.

### 4.6 Other places that write or check a password today

Password changes in each of these places use `accounts.setPassword`, `accounts.verifyPassword` and `accounts.setEmail`:

| Place | What it does |
|---|---|
| tRPC `auth.status`, `auth.profile`, `auth.setEmail`, `auth.setPassword`, `auth.setLoginRequired` (`modules/instance/service.ts`) | the caller's own credential and the sign-in policy |
| setup with a password (`modules/instance/service.ts`, `setup-enrollment.ts`, `modules/machines/service.ts`, `server.ts` near the staged-password receipt) | the first admin's password |
| `first-admin-password.ts` | the password staged in `auth.json` by `podium setup`, and `PODIUM_PASSWORD` |
| `test-support/two-member-instance.ts` | the Alice and Bob fixture; it creates its members through `memberships.adopt`, `invite` and `accept` |

`auth.setLoginRequired` keeps writing the `authOpenMode` setting; the core reads it through `sameMachine.waived`.

## 5. How each transport finds the member

### 5.1 One function in the server

The server has one function, `memberOfRequest(request)`. It computes the connection facts, calls `identity.resolve` once per `Request` object (the per-request memo of POD-6220 stays), and returns the resolution. Every transport below uses it. `clientAuthGuard`, `credentialPrincipal`, `requestPrincipal`, `sourcePrincipal`, `perRequestCredential`, `resolveClientCredential`, `requestUserId` and `isRequestAuthed` are replaced by it (POD-6746).

For a `member` resolution the server reads the member row as it does today (`users.get`, the per-operation loader) and builds the principal from the row's role. A resolution whose member row is missing or disabled is treated as `not-a-member`: in a hosted workspace this is the short time before a new membership is applied (section 11).

### 5.2 Answers

| Resolution | HTTP, tRPC, files, sync | Socket upgrade | `GET /auth/status` |
|---|---|---|---|
| `member` | continues | accepted | `authed: true` |
| `unauthenticated` | 401 `{ "error": "unauthorized" }`, the body of today | refused, 401 | `authed: false` |
| `not-a-member` | 403 `{ "error": "not_workspace_member" }` | refused, 403 | `authed: false`, `denied: "not_workspace_member"` |
| `https_required` | 400 `{ "error": "https_required" }` | refused, 400 | `authed: false` |
| member fence mismatch (POD-6292) | 401 with `MEMBER_FENCE_REFUSAL`, unchanged | unchanged | |

401 means "sign in". 403 means "you are signed in and are not a member of this workspace"; a client shows the membership message and offers another account. With `accounts: 'local'` a 403 is rare, because a disabled or removed member's sign-ins are gone; it is the normal answer in a hosted workspace.

### 5.3 Per transport

| Transport | Where | How |
|---|---|---|
| HTTP guard on `/trpc/*`, `/files/*`, `/sync/*` | `clientAuthGuard`'s replacement | `memberOfRequest`, then the table above. `OPTIONS` passes. When `renewDue`, the guard calls `identity.renew` and adds its cookies to the response; this replaces the `sessionResponseHeaders` middleware |
| tRPC context | `createContext` | the memoised resolution of the same request; the setup bootstrap exception (`isHostSetupBootstrap`) stays as it is |
| File routes | `registerAssetRoute.mayRead` | the memoised resolution |
| Sync | `registerSyncRoutes.principal` | the memoised resolution |
| Socket upgrade (`/client`) | `principalForClient` | `memberOfRequest(observedRequest)`. The socket keeps a `HeldSignIn`: the device sign-in id as its credential id, or the same-machine marker |
| Socket heartbeat (15 seconds) | `maintainClientCredential` | `identity.revalidate(held)`, one statement. False closes the socket. A check that does not answer within two heartbeats closes it, as today |
| Ending a device sign-in through this server | `onCredentialRevoked` | `ws.revokeClientCredential(deviceSignInId)` closes that sign-in's sockets at once |
| A membership change | `UsersRepository.onAccessChange` | unchanged: the generation step closes or rescopes the member's sockets and refuses queued work |
| Daemon link, agent relay, MCP, maintenance | | unchanged; they do not use device sign-ins |

A socket admitted by the same-machine rule is revalidated on the heartbeat like any other. Today such a socket is never checked again; with this it closes within 15 seconds when a second member becomes active. This is a deliberate tightening.

Routes that need a real sign-in and not the same-machine rule (pairing, the device list, ending a sign-in) require `resolution.deviceSignIn !== null`, as `credentialPrincipal` does for them today.

### 5.4 Bearer tokens

A phone holds the signed token and sends it as `Authorization: Bearer`. It is read only over HTTPS; over HTTP the answer is `https_required`, as today. Any kind of device sign-in resolves by bearer; today only the `mobile` label does. The difference is harmless, because a bearer is only ever handed to a caller without an `Origin` header.

### 5.5 The same-machine rule

It sits in one place: step 5 of `resolve` (section 2.5), with the same logic in `revalidate` and in `signInRequired`.

```
signInRequired  =  sameMachine is null
                or the workspace has two or more active memberships
                or (some account in this database has a password and not waived())
```

A request with no valid credential is the sole active member when all of these hold: `signInRequired` is false; `facts.sameMachine` is true; exactly one membership is `active`. Otherwise it is `unauthenticated`.

This is today's rule, term for term: `credentialsRequired` is "cloud, or several active members, or (not `authOpenMode` and somebody has a password)", and the open-mode principal is `soleActiveMember()` for an `isHostLocalRequest`. `facts.sameMachine` is `isHostLocalRequest`, computed by the server from the socket's peer address. The rule ends when a second membership becomes active. It is one statement of the package (the first two active memberships and whether any password login method exists).

## 6. Today's `client_sessions` labels

The list was produced at `f92564c0d7` with:

```sh
git grep -nE "createClientSession\(|deleteClientSessionsByLabel\(|BREAK_GLASS_LABEL|'server-transfer-claim'|'upstream'|'break-glass'" \
  f92564c0d7 -- apps packages scripts ':!*.test.ts' ':!*.test.tsx'
git grep -nE "INSERT (OR REPLACE )?INTO client_sessions" f92564c0d7 -- apps packages scripts ':!*.test.ts'
```

| Label | Written today by | Future form | Old rows at upgrade |
|---|---|---|---|
| `login` | `POST /auth/login` (cookie), `POST /auth/server-transfer-claim` | a device sign-in of kind `browser` or `desktop`, 30 days, renewing | left in place for the carry-over (section 8.5) |
| `mobile` | `POST /auth/login` with native delivery, `POST /auth/mobile-pair/complete` | a device sign-in of kind `phone`, 30 days, renewing, bearer or cookie | left in place. One held as a cookie is carried over; one held as a bearer is not, so that phone pairs again and the app says so (`sign-in-carry-over.md`, section 6.2) |
| `break-glass` | `podium auth mint-session`, by a direct insert from `packages/runtime/src/session-token.ts` | a device sign-in of kind `host` with a fixed expiry, made by redeeming a `host-sign-in` code from the control socket | left in place for the carry-over |
| `upstream` | nothing. The node-to-hub link is retired (`upstream-retirement.ts`); no code writes or accepts this label | none | deleted by the upgrade (POD-6750): `delete from client_sessions where label = 'upstream'`, with the count in the boot log. The rows carry a member id and a ten-year expiry and must never be honoured by the carry-over |
| `server-transfer-claim` | the server-move coordinator (`relay.ts`, `prepareClientRelocations`) | no device sign-in: a `transfer-claim` code, 10 minutes, redeemed on the moved server | deleted by the upgrade. A server move does not span an upgrade |
| any other value | nothing | none | never honoured; dropped with the table |

The enum `ClientSessionLabel` in `packages/protocol/src/pairing.ts` and the label names in `apps/web/src/features/settings/sections/access.tsx` are replaced by the device kind (POD-6748 for the protocol, POD-6749 for the screens).

Machine credentials and the daemon's enrolment tokens identify machines and are not touched. The spike could not confirm a live node-to-hub credential because none exists any more; the only remainder is the `upstream` rows above.

## 7. A person with no email

### 7.1 The identifier

The library needs an email-shaped identifier for every account. A person who never gave an address gets a generated one:

```
no-email-<32 lowercase hexadecimal characters>@no-email.invalid
```

- The 32 characters are 16 random bytes. Nothing is derived from the member id or from any other fact.
- `.invalid` is a reserved top-level domain, so the value can never be a deliverable address and can never collide with a real one.
- The package exports `isGeneratedIdentifier(value)`. `Account.email` is null for such an account. The value is never shown, never sent in any response, never mailed, never written to `users.email`, and never accepted as input: an address that ends in `@no-email.invalid` is refused in sign-in, in an invitation and in `accounts.setEmail`.
- `accounts.setEmail` replaces a generated identifier with a real address. The reverse is not possible.

The spike used `sole-<UUID>@…`; the name changes because a team can hold one such account too (below).

### 7.2 Who a sign-in without an email means

`POST /auth/login` may omit `email`. The package then picks, in this order:

1. the only account that has a password, when exactly one account in the database has one;
2. otherwise the only account with a generated identifier and a password, when there is exactly one.

In every other case the answer is the same `invalid` refusal as a wrong password. Case 2 is today's bridge for a first admin without an address in a team (`resolveLoginIdentifier`); only the first admin can be in that state, because accepting an invitation requires an address.

### 7.3 What the one-person prompt shows

`GET /auth/status` carries `prompt`:

| `prompt` | When | The sign-in screen shows |
|---|---|---|
| `password` | exactly one account has a password | one password field and the sign-in button. No email field, no identifier, no provider buttons. Below it, the reset help for `passwordReset: 'admin-link'`: "Forgot it? Run `podium setup` on the machine that runs Podium." |
| `email-password` | otherwise | an email field and a password field. The email may be left empty only by the person case 2 above describes; the screen does not say so |

On a one-person server's own machine, with no password or with sign-in waived, no prompt is shown at all: `needsAuth` is false (section 5.5). The spike ran the password-only form in a browser (row 5, `password-only.png`).

## 8. Upgrading an existing server

### 8.1 Mechanism

Two parts, both rehearsed on the customer-upgrade fixtures with `scripts/rehearse-upgrade.ts`:

1. **Schema migrations**, additive only, in the server's chain: the library tables and `identity_one_time_code` (POD-6744), then `identity_membership`, `identity_workspace_revision`, `identity_invitation` and `users.membership_version` (POD-6745). Retirement DDL is deferred until the local import records completion for that database.
2. **A data step at boot**, `ensureLocalIdentity` (POD-6750), in `apps/server`. It runs when the server built its own core (the seam of section 3 is absent), after the migrations and before the server listens, in one transaction. It is not SQL in a migration file, for three reasons: a hosted workspace database runs the same migrations and must not get local accounts; it needs the package's operations (identifiers, versions, apply-membership); and a fresh install is the same case as an upgrade, because the first admin's member row is inserted by an old migration (`20260730173834_user-accounts-first-admin`) and has no membership either.

`ensureLocalIdentity` handles every member row that has no membership row, so running it twice changes nothing the second time. If it fails, the transaction rolls back and the server does not start; the next start tries again.

### 8.2 What each member becomes

"Password" means a readable password hash in the pre-upgrade database. The hash string is copied unchanged into the login method; the edition's verify function is the one that made it, so old passwords keep working (spike row 3).

| Member row today | Membership | Account | Login method |
|---|---|---|---|
| enabled, has a password | `active`, same role | identifier: `users.email`, or generated when it is null | password, hash copied |
| enabled, no password, the only enabled member | `active`, same role | identifier: `users.email`, or generated | none. The same-machine rule serves this person as before |
| enabled, no password, other enabled members exist | `invited`, same role. The member row is left as it is | none | none. A pending invitation for this member is carried (section 8.3); without one an admin invites them again |
| disabled, has a password | `disabled`, same role | as the first row | password, hash copied. Sign-in is refused while disabled (section 2.1) |
| disabled, no password (this is what a removed member looks like) | `disabled`, same role | none | none |

Every membership is stamped with the next workspace revision and `users.membership_version` is set to it. Member ids, roles, `disabled_at` and authorization generations do not change, so sessions, tasks, machine custody and keys stay with the same people. Member rows with a cloud account id (`users.account_id`) and no password appear only in hosted workspace databases, where this step does not run; PDM-495 creates their memberships in Postgres.

The shared instance password of very old installs is not a special case here. It reaches the first admin through the existing hand-off in `first-admin-password.ts` (`auth.json`, `PODIUM_PASSWORD`), which POD-6746 points at `accounts.setPassword`.

### 8.3 Pending invitations and recovery links

The pre-upgrade link table holds both. The token hash is copied, so links already sent keep working, once each.

| Pre-upgrade link (not expired) | Becomes |
|---|---|
| no member id | a new membership in status `invited` with a newly minted member id, the row's role and address, and an invitation with the same token hash and expiry |
| a member id whose member has no password | an invitation, same token hash and expiry, for that member's `invited` membership |
| a member id whose member has a password (a recovery link) | a `password-reset` code, `code_hash` equal to the token hash, same expiry, for that member's account |

Expired rows are not carried.

### 8.4 The four cases the brief names

- **One person.** One account, one active membership, the password carried. A server in open mode, one with a per-member password and no address, and one that got the shared instance password each behave as before, including no sign-in on the all-in-one app's own machine.
- **A team.** An account and a membership per member from their address, password, role and disabled state. A disabled member still cannot sign in.
- **Pending invitations.** As in section 8.3.
- **Rollback.** The upgrade imports accounts and links, records completion, retires the source credential and invitation storage, and deletes the retired sign-in labels of section 6. Rollback is the procedure POD-6302 proved (`docs/data-and-upgrades.md`): restore the database backup the migration took, together with the matching older binary. What is lost is what happened after the upgrade: new members, changed passwords and new sign-ins. The older binary finds its own tables as it left them, including the sign-ins that were live at the upgrade.

### 8.5 What the sign-in carry-over needs left in place

The carry-over is designed in `docs/design/sign-in-carry-over.md` (POD-6755, approved by the coordinator on 2026-11-10) and built by POD-6751. Its section 8 is the full list of what each task leaves and may drop; this table agrees with it. Compatibility inputs are kept until the retirement point stated for each:

| Kept | Why |
|---|---|
| The table `client_sessions` with all its columns and indexes | the old sign-ins |
| Every row with label `login`, `mobile` or `break-glass`, unchanged, including its original `expires_at` | the carry-over honours a sign-in only until its original expiry |
| The table definition `clientSessions` in `apps/server/src/migrations/schema.ts` | the carry-over brings its own statements on it. `hashToken`, `getClientSession` and `deleteClientSession` need not be kept: an old sign-in is consumed by one `delete … returning` (`sign-in-carry-over.md`, section 4.2) |
| An old-form `cli-session.json`, unread and undeleted when the `podium` command finds one | the host's cached session is carried over once |
| The old cookie name `podium_session` (`SESSION_COOKIE` in `@podium/protocol`) as a constant | old browsers still send it. New sign-ins never use this name (section 2.3), so the two cannot be confused |
| Member ids unchanged, and for every member with an old sign-in a membership that names an account | the carry-over turns "old sign-in of member M" into "device sign-in of M's account" |
| Credential and invitation inputs | Read once by the local import, then retired; rollback restores the pre-upgrade backup (section 8.4) |

What changes under the carry-over's feet, and is allowed: the upgrade deletes the `upstream` and `server-transfer-claim` rows; nothing writes `client_sessions` after POD-6748 (new sign-ins, pairing, the host session and the server move all create device sign-ins or codes); `podium auth mint-session` stops inserting rows.

## 9. Retirement and compatibility

The shared identity package owns sign-in, invitations, recovery and device sign-ins.
The server's member rows are written only through apply-membership. Client screens
read the capability list and use the same implementation in both editions.

The boot import is the only reader of pre-upgrade password hashes and invitation
links. Its transaction records `identity.legacyLinksImported` only after all member
accounts and live links are imported. The generated retirement migration runs after
that receipt commits, before serving traffic. A direct upgrade from the oldest
customer fixture follows this sequence without an intermediate binary. Hosted
workspace composition imports no local accounts and leaves the source tables
untouched. Hosted requests use no source credential or invitation repository;
their table retirement is deferred to POD-6820 by the coordinator's decision
of 2026-11-11.

Rollback restores the database snapshot captured before the schema and data steps,
together with the matching older binary. Source credential and invitation tables
are absent from an imported database.

`client_sessions`, `carried_sign_ins`, `SESSION_COOKIE`, the carry-over module and
its calls, and old-form CLI cache reading remain marked
`LEGACY(remove-after: 2027-06)`. Their joint removal is scheduled for June 2027.
Each server honours carry-over only for its own 30-day upgrade period; a server
upgrading after removal signs in again once.

The protocol registry refuses person credentials. Person-facing HTTP and sockets
resolve through the shared identity boundary in the server.

## 10. The shared test suite

### 10.1 Shape

`@podium/identity/testing` exports one function and one list:

```ts
export const IDENTITY_SUITE_CASES: readonly string[]

export function identitySuite(runner: SuiteRunner, harness: SuiteHarness): void

/** The test functions of whichever runner executes the leg. The suite imports no runner. */
export interface SuiteRunner {
  describe(name: string, fn: () => void): void
  it(name: string, fn: () => Promise<void>): void
  beforeEach(fn: () => Promise<void>): void
  afterEach(fn: () => Promise<void>): void
  expect: (value: unknown) => any
}

export interface SuiteHarness {
  name: 'sqlite' | 'postgres'
  /** A fresh, migrated, empty database for one case, and its member rows. */
  open(): Promise<{
    database: IdentityDatabase
    memberRows: MemberRows & { read(memberId: string): Promise<MemberRowState | undefined> }
    /** Raw read of a column, to assert what is stored. */
    stored(table: string, column: string): Promise<unknown[]>
    close(): Promise<void>
  }>
}
```

The suite builds its cores itself, once with the self-hosted configuration and once with the cloud configuration of section 2.1 (mail captured in memory, no real provider), on the database the harness gives. The runner is an argument because the suite's source lives in the open-source tree and a leg may run under another repository's test runner; a suite that imported its own runner would register its cases with the wrong one.

Each leg ends with one extra test of its own: the number of cases that ran equals `IDENTITY_SUITE_CASES.length`. A leg that skips a case fails.

### 10.2 What it asserts

Every case runs on both databases. Two people, Alice and Bob; Alice is the untouched control wherever a case changes Bob.

Core (POD-6744):

1. With self sign-up off, the library's sign-up is refused and creates no row; an account is created server-side.
2. Password sign-in, a wrong password, sign-out. An existing password hash made by the edition's functions verifies.
3. The stored device sign-in token is not the token in the cookie; the stored value presented as a cookie or as a bearer resolves to nobody; an unsigned token is refused.
4. `resolve` by cookie and by signed bearer gives the same account; one statement.
5. Renewal after a day keeps the token and extends the expiry; a `fixed_expiry` sign-in is not renewed.
6. Device list for an account with the current one marked; revoking one by id ends that one only.
7. A one-time code works once, expires, and two redemptions at the same moment yield one sign-in. An account with no login method signs in by code.
8. A receiver-bound code is refused without the verifier and with a wrong one; the fifth wrong verifier denies the attempt.
9. A hand-over: begin, authorise, redeem; refused when the authorising sign-in has ended; the new sign-in expires with the authorising one.
10. A password-reset code sets the password once and ends the account's device sign-ins.
11. The capability list for the self-hosted and for the cloud configuration, value by value.
12. Plain HTTP that is not same-machine is refused; the two cookie names are as in section 2.3.
13. Library writes inside a package transaction roll back with it.

Memberships (POD-6745):

14. Bob is invited, accepts, is demoted, disabled, enabled and removed; after each step his membership, member row and authorization generation match, and Alice's are unchanged.
15. No member row exists before an invitation is accepted.
16. One invitation accepted twice at the same moment succeeds once; an expired or revoked one is refused.
17. A second account cannot accept Bob's invitation or attach to Bob's member; an invitation with an address refuses another address.
18. An invitation that names an existing member attaches the account to that member and creates no member.
19. The last active admin cannot be demoted, disabled or removed; nobody disables or removes themselves.
20. `resolve` answers `not-a-member` for an invited, disabled or removed membership and `unauthenticated` for no credential.
21. Versions: every membership change steps the workspace revision by one; applying a membership twice, or an older one after a newer one, changes nothing.
22. With `accounts: 'local'`: disabling ends the account's sign-ins, removing deletes the account, sign-in is refused without an active membership. With `accounts: 'shared'`: none of the three.
23. The same-machine rule: one active member and no password admits a same-machine request; a second active member, a password without the waiver, or a request that is not same-machine does not.

Each case is seen failing first, by turning its mechanism off, as the spike's controls did.

### 10.3 Where each leg runs

**SQLite leg, in the open-source repository.** File `apps/server/src/identity/identity-suite.sqlite.test.ts`. Its harness opens the server's real store on a temporary file (`SessionStore.open`), so the tables come from the server's migration chain and the statements go through the server's executor and driver (bun:sqlite behind `createBunStoreExecutor`); `memberRows` is the real `UsersRepository` implementation. It lives in `apps/server` because the package may not import the server.

```sh
bun run test:file -- apps/server/src/identity/identity-suite.sqlite.test.ts
```

After adding it, regenerate the server test shard manifest.

**Postgres leg, in podium-cloud.** The open-source repository has no Postgres. File `packages/platform/src/identity-suite.pg.test.ts` on the branch `integrate/pdm-494-hosted`. Its harness is the platform's guarded test database helper (`src/test/db.ts`): it refuses any database that is not `podium_test` on a loopback host, resets it and applies the platform's migrations. `memberRows` is a small table in the same test database that implements `MemberRows` with the rules of section 2.6; the real member rows are covered by the SQLite leg and by PDM-495's two-member tests.

The file imports the suite as `@podium/identity/testing`, resolved through a `paths` entry in `packages/platform/tsconfig.json` and the same alias in its vitest configuration, both pointing into `oss/podium/packages/identity/src`. It passes vitest's `describe`, `it`, `beforeEach`, `afterEach` and `expect`.

```sh
# in a podium-cloud checkout on integrate/pdm-494-hosted
git -C oss/podium fetch <path of the local open-source repository> <branch or commit under test>
git -C oss/podium checkout --detach FETCH_HEAD
bun run oss:install
bun run db:up
# then, from packages/platform:
PLATFORM_TEST_DATABASE_URL=<the local podium_test database, as compose.yaml states it> \
  bunx vitest run src/identity-suite.pg.test.ts
```

Nothing is pushed: the submodule's working tree is moved to a commit fetched from the local repository. The report of a task names the open-source commit, the podium-cloud commit, the command and its exit code.

The platform's migrations must contain the tables the suite needs. POD-6744 and POD-6745 therefore each carry one small commit on `integrate/pdm-494-hosted`: the alias and the test file (POD-6744 only), the re-export of the package's Postgres tables in `packages/platform/src/schema.ts`, and the platform migration generated from it. The platform keeps its own sign-in configuration until PDM-495; these commits add tables and a test and change no behaviour. This is more than the two briefs say (section 16).

## 11. A hosted workspace: memberships in Postgres, member rows in the workspace database

### 11.1 Numbers

- Each membership has a `version`: the workspace revision at its last change (section 1.4). It also has `authorization_version`, the last revision that changed role or membership status. Profile changes preserve it. Within a workspace the versions are gap-free and in commit order.
- The workspace database holds a cursor, `identity.appliedMembershipVersion` in `meta`: every membership change up to it has been applied to the member rows.
- Each member row holds `membership_version`: the version last applied to it.

### 11.2 One way to apply

`WorkspaceIdentity.catchUp()`:

1. read the cursor;
2. one statement on Postgres: the memberships of this workspace with `version` above the cursor, in version order, each with its account's name, picture and address;
3. for each, in order: `applyMembership(rows, snapshot)` in a transaction of the workspace database that also moves the cursor to that version;
4. stop at the first failure. The cursor stays before it, so the next run starts there.

Only one run is in flight in a process; a call during a run waits for it and then runs once more.

Because step 3 commits the member row and the cursor together, a member row is never ahead of the cursor. Because the versions are gap-free and applied in order, a change that failed is never skipped by a later one. A crash between the Postgres commit and step 3 leaves the cursor behind; the next run applies it. Applying a membership twice is harmless (section 2.6).

### 11.3 When it runs

| Trigger | Delay |
|---|---|
| A membership operation made through this workspace's server (the People screen, accepting an invitation): the operation commits on Postgres and then awaits `catchUp()` before it answers | none: applied before the response |
| At start, before the server serves requests | none |
| A timer in the server, every 10 seconds, started only when the seam of section 3 is present | at most 10 seconds plus the run |
| After a failed run | the next timer tick |

A change made elsewhere reaches the workspace by the timer: removal from the organisation, account deletion, a change of name or picture, a change made while the workspace's machine was stopped (applied at start).

**Stated maximum delay: 15 seconds** from the Postgres commit to the member row being changed and the authorization generation stepped, while this workspace can reach Postgres. It is 10 seconds of timer and 5 seconds allowed for the read and the writes. PDM-509 proves it with a fake clock: a change committed just after a tick is applied by the next tick, and Bob's next effect after that is refused.

When Postgres cannot be reached, catch-up fails and is retried every 10 seconds, and the delay lasts as long as the outage. During it no request can be resolved either (device sign-ins are in Postgres), so nobody enters; work that members already had running continues with the rights they had. After three failed runs in a row the server reports the state on `/readiness` and in its log. Whether running work should also stop is a product question (section 17, question 4).

### 11.4 What each layer guarantees

| Question | Answer | Lag |
|---|---|---|
| May this request enter? | `resolve`, on Postgres, at the request | none |
| May this open socket stay? | `revalidate` on the heartbeat, on Postgres | up to 15 seconds (the heartbeat), sooner when the member row is applied |
| May this member's running agent, daemon or queued work act? | the member row and its authorization generation, as built | up to the stated maximum delay |

There is no separate "hosted entry" fact: an ended membership makes the member row disabled through apply-membership, which is the one check that already hides disabled members.

In a self-hosted server none of this exists: the membership and the member row are in one database and change in one transaction (`sameDatabase: true`), and `catchUp` is never called.

## 12. The cloud's desktop hand-over

**Decision: it becomes the shared one-time code, purpose `hand-over`, with its receiver proof kept as a property of the code.** podium-cloud's `handoff.ts`, its `handoff` table and its `desktop-handoff` verification rows go (PDM-510). The HTTP routes and the cookie that holds the verifier stay in podium-cloud; the storage and the rules move into the package, where pairing uses the same receiver binding.

Each protection of today's hand-over, and where it is afterwards:

| Today (`packages/platform/src/handoff.ts` at `d317d87`) | Afterwards |
|---|---|
| The receiving webview starts the attempt (`begin`): a random 256-bit verifier in a host-only, Secure, HttpOnly `__Host-podium-handoff` cookie; its SHA-256 is the challenge; the attempt lives 10 minutes | Unchanged in the route. `codes.begin({ purpose: 'hand-over', challenge })` stores the attempt as a code row with no account, 10 minutes |
| `begin` accepts only a JSON POST from the app origin or the sign-in origin | Unchanged in the route |
| A signed-in browser mints a code for a challenge (`mint`); refused when no live attempt has that challenge ("this attempt has ended") | `codes.authorise({ challenge, accountId, sourceSignInId })` binds the account to the attempt row and sets its code. No live attempt: `ended` |
| The code lives at most 3 minutes and never beyond the attempt or the minting sign-in | The same three limits, in `authorise` |
| Only the SHA-256 of `code.challenge` is stored | The code hash and the challenge are stored in one row; the code is 32 random bytes |
| Redeeming needs the verifier: from the cookie for cookie delivery, from the body for bearer delivery; a verifier in a URL is not accepted | Unchanged in the route; `codes.redeem({ code, verifier })` checks it (section 2.8, step 2) |
| Redemption locks the attempt and consumes attempt and code together; a mismatch consumes neither | One row, one conditional update; a wrong verifier rolls back and consumes nothing |
| A second code minted for a consumed attempt fails | The attempt is the row: once consumed it cannot be authorised or redeemed again |
| The minting sign-in must still be live at redemption; the new sign-in is a new device, never a copy, and expires when the minting one would | Section 2.8, steps 3 and 5 |
| Foreign `Origin` headers are refused; navigation without `Origin` still needs the proof | Unchanged in the route |
| The destination after redemption comes from configuration, never from the link | Unchanged in the route |

**Login CSRF.** The attack is to make a victim's app redeem a code the attacker minted, so the victim works inside the attacker's account. It fails for the same reason as today: a code is redeemable only with the verifier of the attempt it was authorised for, the verifier is created by the server for the receiving device and never leaves its HttpOnly cookie or its native store, and an attacker can authorise only attempts whose challenge they know. Nothing is weaker. One thing is stronger: the code is a 256-bit value instead of a 27-character id.

The tests of `handoff.test.ts` move to the shared suite (cases 8 and 9) and to PDM-510's route tests; none is dropped.

Phone pairing uses the same mechanism in the other order: the signed-in device issues the code, the phone claims it with the hash of its own secret, the signed-in device approves the phone by its three-word phrase, and the phone redeems with the secret. That is today's ceremony (process-local pairing), stored in a row instead of in memory.

## 13. Security notes

### 13.1 Entropy, expiry, single use

| Secret | Entropy | Lifetime | Single use by |
|---|---|---|---|
| Invitation token | 256 bits | 7 days by default, 1 to 30 days | `update … set consumed_at … where consumed_at is null` inside the accept transaction; issuing a new one revokes the old |
| One-time code | 256 bits | 60 seconds to 24 hours by purpose (section 2.8) | the conditional update of section 2.8, step 1 |
| Receiver verifier | 256 bits | the attempt's lifetime | five wrong attempts deny the attempt |
| Device sign-in token | about 190 bits | 30 days, renewed daily while used; a host session as long as the operator chose | ended by sign-out, revoke, password reset, and with `accounts: 'local'` by disable and remove |

All are stored only as hashes (section 1.6). A link carries its token in the URL fragment, so it reaches no server log and no referrer, as today.

Hosted invitation, password-reset and email-verification secrets, including an invitation nested in a verification callback, stay in fragments handled by the account client. Redemption sends the token in a POST body. Verification never signs the person in automatically; it also requires the account proof in section 2.4.

### 13.2 An attacker with an old cookie

- A cookie of a device that signed out, was revoked, or whose account reset its password: the row is gone; the cookie resolves to nobody.
- A cookie of a disabled or removed member: self-hosted, the sign-in was deleted with the change; hosted, the cookie still names an account and `resolve` answers `not-a-member` for the workspace on the next request, with open sockets closed within 15 seconds.
- A cookie from before the upgrade (`podium_session`): it is not a credential of the package. Whatever it still opens is decided, bounded and tested by the carry-over (`sign-in-carry-over.md`, POD-6751): only at `GET /auth/status`, until its original expiry and at most 30 days after the upgrade, for an active membership, for one device sign-in. For ten minutes after that the same cookie gets the same answer again and creates nothing.
- A copy of the database, old or new: it holds hashes of tokens, invitation tokens and codes, password hashes and the signing secret. None of it signs anyone in. The password hashes can be attacked offline, as today.
- A stolen live cookie works until it expires or is ended. An admin's role and credential changes still ask for the current password, so a stolen cookie alone cannot promote, disable, remove or reset anyone (POD-6298, kept).

### 13.3 An attacker with a leaked invitation link, or with a second account

- A leaked link, self-hosted: whoever opens it first can create the account and take the membership, with the role the admin chose, unless the invitation names an address; then they must also type that address, which is a weak second fact. This is today's behaviour. The invitation is single use, expires, shows as pending on the People screen and can be revoked there; an invitation as admin needs the inviting admin's password.
- A leaked link, cloud: the invitation names an address and can be accepted only by an account that holds it; the cloud verifies addresses. The link alone is not enough.
- A second account cannot attach to someone else's member: a membership has one account, set only by accepting an invitation for that membership or by setup, and the unique index of section 1.3 refuses a second live membership for one account in a workspace. An account whose address equals a member's address gains nothing; nothing matches by address alone (audit row B5).
- A member who is not an admin can call none of the membership operations; the actor check is inside the transaction.
- A person removed from a workspace who still has a cloud account keeps the account and nothing in the workspace.

### 13.4 Throttling

| Limit | Key | Budget | Where it is kept |
|---|---|---|---|
| Password sign-in, per identifier | the address, or one fixed key when none is sent | 8 failures, then 5 minutes locked; 10,000 identifiers tracked | memory, per process, both editions |
| The library's limiter on its own routes (cloud) | client address and path | the library's defaults: 100 per 10 seconds; 3 per 10 seconds on sign-in, sign-up and password change; 3 per 60 seconds on reset and verification | Postgres (`rateLimit.storage: 'database'`), shared by every process |
| The library's limiter (self-hosted) | client address and path | the same defaults, applied to the library calls the package makes | memory; one process |
| Pairing claim and completion | client address | 12 failures, then 60 seconds; unchanged | memory, in the route |
| Verifier attempts on one code | the code row | 5, then denied | the row |

**The trusted-proxy boundary.** The client address is `ConnectionFacts.clientAddress`, computed by the server (section 2.3): the socket's peer address, or with `PODIUM_TRUSTED_PROXY_HOPS` set, the value the trusted hop appended to `X-Forwarded-For`. The package passes it to the library in a header of its own and removes every inbound forwarding header first; the library is configured to read only that header. A caller cannot choose its key. When the address is unknown the library falls back to one shared bucket per path, which limits everyone together and admits nobody extra. For the cloud's mounted library routes the same rewriting happens in `core.libraryHandler`.

In the cloud the per-identifier counter is per process, so an attacker who reaches N processes gets N times 8 tries per five minutes for one address, on top of the shared address budget. That is accepted; a shared per-identifier counter can be added later without a schema change, in the rate limit table.

### 13.5 Other notes

- Sign-in refusals do not say which part was wrong; a disabled member gets the same answer as a wrong password.
- Bearer tokens are read only over HTTPS and delivered only to callers without an `Origin` header.
- Plain HTTP is accepted only on a same-machine connection (section 2.3). An existing server that people reach by plain HTTP over a network answers `https_required` after the upgrade (section 17, question 1).
- The host commands are reachable only through the user-only control socket. A process that runs as the server's operating-system user can mint a host session, as it can today; the rule that refuses it once a second member exists stays.
- The library's own HTTP routes are not reachable on a self-hosted server.

## 14. Which task builds what

| Section | Task | Files the task owns |
|---|---|---|
| 1.2, 1.5 (one-time code), 1.6, 1.7; 2.1 to 2.5 without memberships; 2.7, 2.8, 2.9; 10 (cases 1 to 13, both legs) | POD-6744 Identity core package | `packages/identity/**` except `membership/`; the server migration for the library tables and the code table; `apps/server/src/identity/identity-suite.sqlite.test.ts`; in podium-cloud the test file, the alias and one platform migration |
| 1.3, 1.4, 1.5 (invitation), 1.8; 2.5 (the membership part of `resolve`, `revalidate`, the same-machine statement); 2.6; 10 (cases 14 to 23) | POD-6745 Memberships and invitations | `packages/identity/src/membership/**`; the server migration for the membership tables and `users.membership_version`; `MemberRows.write` in `apps/server/src/store/users.ts`; in podium-cloud one platform migration |
| 3 (open-source side); 4.1 except the transfer claim; 4.6; 5; 7; the signing secret at boot; the hourly `sweep` | POD-6746 Server sign-in path | `auth-route.ts`, `plugins.ts`, the credential resolution in `server.ts`, the gateway's client authentication, `first-admin-password.ts`, the `auth.*` and setup parts of `modules/instance/`, `test-support/two-member-instance.ts` |
| 4.2; 4.3 except the sign-in routes; 4.5 rows 1 to 3 | POD-6747 People and invitations | `member-routes.ts`, `admin-routes.ts`, `member-links.ts`, the three recovery routes of `control-socket.ts`, the `recovery-link` part of `apps/cli/src/auth-cli.ts` |
| 4.1 transfer claim; 4.3 sign-in routes; 4.4; 4.5 rows 4 and 5; 6 | POD-6748 Devices and pairing | `mobile-pairing-route.ts`, new `sign-in-routes.ts`, the device sign-in routes, the transfer-claim route and `prepareClientRelocations` in `relay.ts`, the host-session routes of `control-socket.ts`, `packages/runtime/src/session-token.ts`, the rest of `apps/cli/src/auth-cli.ts`, `packages/protocol/src/pairing.ts`, the matching client code, and the desktop shell's copy of the sign-in cookie when the window follows a moved server (`retarget_session_cookie` in `apps/desktop/src-tauri/src/main.rs`, `session_cookie_for_target` in `bootstrap.rs`), which must copy the new cookie names |
| 2.9 as read by clients; 7.3 | POD-6749 Capability-driven screens | `apps/web` LoginGate, InviteView, settings People and Access, connected devices; the matching phone and desktop views; `packages/client-core/src/accounts/auth.ts` |
| 8.1 to 8.4; the deletions of section 6 | POD-6750 Existing server upgrade | `ensureLocalIdentity` in `apps/server`, its fixtures and rehearsal |
| 8.5 as a contract; its own document | POD-6755 Sign-in carry-over design, POD-6751 Sign-in carry-over | `docs/design/sign-in-carry-over.md`, then what its section 9 names: `apps/server/src/sign-in-carry-over.ts`, `apps/server/src/store/sign-in-carry-over.ts`, the migration for `carried_sign_ins`, `memberships.accountOfActiveMember` in the package, and one call each in `auth-route.ts`, `member-routes.ts`, `MemberRows.write` and `control-socket.ts` after their owners have landed |
| 9 | POD-6752 Hand-written sign-in removal | import retirement, compatibility cleanup, and documentation |
| 3 (cloud side); the cloud configuration of 2.1; the Postgres leg from then on; memberships from existing cloud rows | PDM-495 Cloud memberships | podium-cloud `packages/platform`, `apps/hosted-server` |
| 11 | PDM-509 Membership apply and revocation | podium-cloud, and the timer and cursor in `apps/server` behind the seam |
| 12; the cloud capability list in use. A person ends their own device sign-ins on their account page; a hosted admin ends none | PDM-510 Hosted people screens | podium-cloud `packages/platform` routes, `apps/app` |

**Covered by no task brief.** Each is assigned above so that nothing is left over, and listed in section 16 so the coordinator can move it:

1. The password writers of section 4.6 (POD-6746).
2. Reporting the capability list and the prompt from the server (POD-6746; the brief of POD-6749 names the screens only).
3. The companion commits in podium-cloud for the Postgres leg before PDM-495 starts (POD-6744, POD-6745).
4. The signing secret in `server_secrets` and the hourly `sweep` (POD-6746).
5. The timer and the cursor inside `apps/server` that PDM-509 needs; PDM-509 is a podium-cloud task and this part is open-source code on the integration branch.
6. Release notes for the two visible changes: plain HTTP over a network no longer signs in, and phones may have to pair again (POD-6304 Multi-member release notes).

## 15. What was run for this document

One design proof, not product code: `hashed-tokens-proof.ts`, attached to POD-6743 with its three logs. It imports the library, the server store and the spike's table definitions from the spike worktree at `c6eeb191ea` and writes only to a temporary directory.

```sh
bun --conditions=@podium/source hashed-tokens-proof.ts                           # exit 0, 32 checks pass
PROOF_REMOVE=hashing bun --conditions=@podium/source hashed-tokens-proof.ts      # exit 1, 7 checks fail
PROOF_REMOVE=transaction bun --conditions=@podium/source hashed-tokens-proof.ts  # exit 1, 1 check fails
```

It shows, on the server's real store executor (bun:sqlite, tables from the server's migration chain):

- the library signs in, resolves by cookie and by signed bearer, renews and signs out through the hashing layer of section 1.6, while the database holds only the SHA-256 of the token;
- the stored value, sent as a cookie or as a bearer, resolves to nobody, and an unsigned token is refused;
- a device sign-in is created for an account with no login method, listed by account without a usable token, and ended by its id;
- an account and a device sign-in created by the library and a member row written by `UsersRepository` inside one server transaction roll back together, and commit together;
- the library's own transaction call goes through the server's transaction runner and rolls back;
- the library hashes verification identifiers when told to;
- a cookie's signature verifies with plain HMAC-SHA-256 and one read by the hashed token finds the device sign-in and its account, which is what `resolve` does without the library.

Nothing from the spike branch is copied into this document or into the integration branch; the proof reads it in place, and the branch is never merged. The tables of section 1.2 follow the library's own field list, not the spike's file.

Not run, and therefore owed by the building tasks: anything on Postgres (POD-6744, first); the library with the additional device columns; the one-time code table; mixing the two repositories' copies of drizzle-orm (section 3); the two cookie configurations behind the rewritten request of section 2.3 (the spike ran two configurations through the library's handler with real hosts; the rewriting is new).

## 16. Where this document and the task briefs differ

For the coordinator. None of these changes a goal; each changes who does something or adds something a brief did not name.

| # | Brief | This document | Why |
|---|---|---|---|
| 1 | POD-6743: fast-forward the integration branch to the current `dev/mw` first | Not done; the branch stays at `f92564c0d7`, which is the recorded base | The two branches diverged (4 commits one way, 1 the other). Settled by the coordinator: the base is the published `origin/dev/mw`; the unpublished commit is left out |
| 2 | POD-6744: memberships are the next task; "leave their seam" | `resolve` is split: POD-6744 builds the device sign-in and account half and the statement shape, POD-6745 adds the membership join, `revalidate` and the same-machine statement | `resolve` is one statement over both |
| 3 | POD-6744, POD-6745: open-source tasks | Each carries one small commit on podium-cloud `integrate/pdm-494-hosted` (section 10.3) | Their acceptance needs the Postgres leg before PDM-495 exists, and the platform owns the Postgres migrations |
| 4 | POD-6744: one-time codes | Our own table, not the library's one-time-token extension the spike used | The extension keeps a session token in clear and needs a session before a code (section 1.6) |
| 5 | POD-6746: owns `auth-route.ts`, the former sign-in hook, the credential resolution, the gateway | Also owns every other password writer (section 4.6), the capability list and prompt in `/auth/status`, the signing secret, the sweep | Otherwise a fresh install cannot set a password after this task, and the screens have nothing to read |
| 6 | POD-6747 owns `admin-routes.ts`; POD-6748 moves "the sign-in list and single sign-out" | The admin sign-in list and revoke move to a new file `sign-in-routes.ts` owned by POD-6748; `/auth/admin/access` keeps only the admission facts. POD-6748 makes the one small removal in `admin-routes.ts` after POD-6747 has landed, or POD-6747 makes it | The two tasks run side by side and both touched one file |
| 7 | POD-6747: "a host command that recovers the last admin"; POD-6748: "host recovery" becomes a one-time code | Two different things: the recovery link and `podium setup` password (POD-6747), and the host session of `podium auth mint-session` (POD-6748). Both edit `control-socket.ts`, in different routes | The briefs use one phrase for both |
| 8 | POD-6747: "an admin-issued reset link … signs the member out of their other devices" | It ends every device sign-in of the account, including the one that may be using the link | That is today's behaviour of a recovery link, and the person redeeming it is not signed in |
| 9 | POD-6748: "phone pairing becomes a one-time code" | The pairing ceremony (claim, three-word phrase, approval) is kept and stored in the code row | Dropping the approval would weaken pairing |
| 10 | POD-6749: capability list "(password, Google and GitHub, self sign-up, invitation by link or mail, reset by admin link or mail, organisations, same-machine sign-in)" | Four more fields: `emailVerification` (plan section 3), `adminSignOutEverywhere`, `adminEndDeviceSignIn`, `accountUrl` | Plan section 5 gives hosted and self-hosted admins different rights; the screens must not branch on a mode to show it |
| 11 | POD-6750: "the migration from today's tables" | A boot step in the server, not SQL in a migration file (section 8.1) | Hosted databases run the same migrations and must not get local accounts |
| 12 | POD-6750: "pending invitations reissued" | Carried with their token hashes; links already sent keep working | Same token format and hash on both sides |
| 13 | Plan section 4: sign-in state "the same-machine rule … ends when a second member exists" | Also: sockets admitted by the rule are revalidated on the heartbeat and close within 15 seconds when a second member becomes active | Today such a socket is never checked again |
| 14 | Today: signing a member out everywhere steps the authorization generation, which also refuses that member's queued work | Ending device sign-ins never steps the generation | Plan rule: agent work depends on the membership, not on a device |
| 15 | Spike: the signing secret in a private file | In the server's `server_secrets` table | It must move with the database on a server move; with hashed tokens it guards little |
| 16 | PDM-495: "One device sign-in read and one membership read per request" | One statement for both | `resolve` is the package's own statement |
| 17 | PDM-509: a podium-cloud task | The timer and the cursor are open-source code behind the seam | The server calls `catchUp`; podium-cloud cannot reach into it |
| 18 | PDM-510 | Also removes `handoff.ts` and its table (section 12) | The hand-over becomes the shared code |
| 19 | PDM-510: "Alice ends one of Bob's device sign-ins; that device is signed out, his other one is not", and "the device list and single sign-out reach the cloud device sign-ins" for an admin | Overridden. In a hosted workspace an admin ends no device sign-in of another person (`adminEndDeviceSignIn` is false); the Access screen lists them read-only. A person ends their own on their account page. POD-6748's line "An admin can end a single sign-in of Bob's" holds for a self-hosted server only | Coordinator's decision on review, 2026-11-10: those sign-ins belong to the person's cloud account and serve their other workspaces |
| 20 | Section 8.5 as first written: POD-6748 keeps `hashToken`, `getClientSession` and `deleteClientSession` | Not kept. POD-6748 keeps the table definition, `SESSION_COOKIE` and an old-form `cli-session.json`; the carry-over brings its own statements | The carry-over design consumes an old sign-in with one `delete … returning`; a read followed by a delete would be a race (`sign-in-carry-over.md`, section 4.2) |
| 21 | Section 6 as first written: whether `mobile` rows are carried is open | A `mobile` sign-in held as a cookie is carried; one held as a bearer is not. The security review may narrow it to no `mobile` row at all | Coordinator's decision on the carry-over design, 2026-11-10 |
| 22 | Section 2.6: the membership operations | One more read, `memberships.accountOfActiveMember(memberId)`, built by POD-6751 | The carry-over needs the account of one member |
| 23 | Section 14: files owned by POD-6745, POD-6746, POD-6747, POD-6748 | POD-6751 adds one call each to `auth-route.ts`, `member-routes.ts`, `MemberRows.write` and `control-socket.ts`, after those tasks have landed | Whatever ends a member's device sign-ins must also end that member's old sign-ins |
| 24 | Section 9 as first written: POD-6752 drops `SESSION_COOKIE` and `client_sessions` "when the carry-over's leftover period has passed, otherwise scheduled with a date" | Never in this release. They, `carried_sign_ins` and the carry-over module are marked `LEGACY(remove-after: 2027-06)` | The leftover period is per server, so no release can know it has passed everywhere |
| 25 | Section 14 names no owner for the desktop shell | POD-6748 owns the shell's copy of the sign-in cookie on a server move | Found by the carry-over design: the shell copies the cookie by its old name |
| 26 | No brief says it | POD-6746 to POD-6750 reach no build that people run, `dev/mw` included, without POD-6751. They land only on the integration branch, which reaches `dev/mw` as a whole | A server with the new sign-in path and without the carry-over signs every browser out |
| 27 | Section 2.1: the edition configuration; section 2: the package may import `@podium/model` | A required field `newMemberId: () => string`. The package mints a member id through it and imports nothing from `@podium/model`. The server passes the model's `newMemberId` (POD-6746) | Built by POD-6745. The cloud's test runner cannot resolve the model package, and a member id is the id of a member row, which belongs to the server |
| 28 | Section 2.1 | An optional field `invitationUrl: (token, workspaceId) => string`. Without it no invitation is mailed and `mailed` is false | The package cannot know the address of an invitation link |
| 29 | Section 2.6: `MemberRows` has `write` only | An optional `exists(memberId)`. An invitation that names a member with no membership is allowed only when it answers true; without the method it is refused | The package had no way to learn that a member row exists (a move, PDM-512) |
| 30 | Section 2.6: an invitation may name a membership that is removed, disabled without an account, or absent | Also one that is still `invited`: a new invitation for it, which revokes the earlier ones (section 1.5) | An expired invitation leaves its membership invited; without this it could not be invited again |
| 31 | Section 1.3: `invited` to `removed` for "a membership that was never active" | Revoking an invitation always moves an invited membership to `removed`, also one invited again after removal and one that named a moved member row. For a moved row that disables the row and releases its machine custody. A new invitation naming the same row is still possible after a revoked or an expired one, and acceptance restores the row (suite case 18) | The membership does not record whether it was ever active. Accepted on the condition that a move can be retried |
| 32 | Section 2.5: `resolve` is one statement | One statement for a member. A signed-in account with no membership costs a second one, which looks for an invitation by its address | An invited membership names no account, so the join cannot find it |
| 33 | Section 2.6: "check the actor, check the rule, change the membership, step the workspace revision" | On Postgres the workspace revision row is locked first, before the checks; the step still comes after the change | Otherwise two operations at the same moment could each pass the last-admin check |
| 34 | Section 11.2, step 3: the member row and the cursor in one transaction of the workspace database | `catchUp` commits the member row and cursor together when the workspace supplies `AppliedCursor.transaction` (PDM-509); other bindings retain idempotent row-then-cursor writes | Before PDM-509 the cursor port had no transaction. Applying a membership twice changes nothing, so replay remains safe |
| 35 | Section 2.4: a change of an account's name, picture or email reaches the member rows | Where member rows share the database, in the same transaction. Where they do not, and the change is made inside a caller's own transaction, at the next catch-up | Nothing is committed yet when the hook runs; section 11.3 already names the timer for it |
| 36 | Section 2.6, the table of `MemberRows.write` | The member row of a removed member loses its address and its account id. A member row that is no longer active gives its address or account id to the member being written; an active one keeps it | Both are unique among member rows. Without this a person who was removed and is invited again as a new member could not be written |
| 37 | Section 2.6: removal is audited as `members.remove` per machine | Also once without a machine when the member held none | A removal is always in the audit log |
| 38 | Section 2.3: `sweep` deletes expired invitations and one-time codes | As written. The membership of a deleted invitation stays `invited` until an admin invites again or revokes | Stated because row 30 depends on it |
| 39 | `scripts/span-effect-graph.ts` names the package's transaction declarations by file and line | The lines moved to `types.ts` 102, 103 and 138 and `runtime.ts` 170 (PDM-495 moved them again) | An edit above those lines moves them again; the span lint then reports an unnamed opener |
| 40 | Section 3: the seam's function receives `memberRows` and `appliedCursor` | Also a read-only `existingMembers()`: every member row of the workspace database, disabled ones included, in creation order, earliest first, as member id, role, disabled and account id | Asked for by PDM-495, approved by the coordinator. A membership's key is the member id and Postgres does not know it; with the former sign-in hook’s member lookups removed the hosted root has no other way to read the rows without importing the store |
| 41 | Section 2.1: `libraryRoutes` has `basePath` and `extensions` | Also `tables`: the tables of the extensions, by the library's model name. The cloud passes `organization`, `member` and `invitation` | Built by PDM-495. The organisation extension reads and writes its own tables through the library's adapter, which knew only the package's tables; the suite's stand-in extension has none, so the suite could not show it |
| 42 | Section 2.3: the members of `IdentityCore` | Also `transaction(fn)`: runs fn in one transaction of the database port; operations of the core called inside join it | Built by PDM-495. Creating a hosted workspace and its creator's membership must commit together, and an operation's own reads after its change must see that transaction. A membership changed inside is applied to member rows in another database by the next catch-up |
| 43 | Section 3: the hosted root passes `platform.identity.workspace(workspaceId, …)` | It passes a function that calls `platform.bindWorkspace(workspaceId, …)` and then gives memberships to the member rows that existed before memberships (row 44) | The platform must know which workspace its process serves: a membership operation made through that workspace is applied before it answers, one made for another workspace is left to that workspace's catch-up |
| 44 | Section 8.2: "PDM-495 creates their memberships in Postgres"; section 14: "memberships from existing cloud rows" | Two steps. A platform migration keeps who could enter each workspace in `workspace_membership_import` (account and role) and drops `workspace_invitation`, `organization_legacy_workspace` and the claim columns. Each workspace's server, at start and before it serves, gives every member row that has an account a membership with the same member id, role and disabled state; invites an account that could enter and never did; and, for a workspace nobody has entered, issues one invitation for the configured owner address that names the first admin's member row | A membership is keyed by the member id, which only the workspace database holds. Nothing is matched by address. Marked `LEGACY(remove-after: 2027-06)` |
| 45 | Section 12 and section 14: the hand-over becomes the shared one-time code (PDM-510) | Unchanged in plan, with one condition this document did not state: released desktop shells accept only a code of the form `hoff_` and 27 characters (`apps/desktop/src-tauri/src/handoff.rs`, `valid_code`), and so does the cloud app. PDM-495 therefore keeps `handoff.ts`, its table and its code format, and only makes the new device sign-in through `deviceSignIns.create` | Moving the code format before a shell that accepts the new one has shipped would end desktop sign-in for every installed app. PDM-510 must ship the shell change first or keep the format |
| 46 | Section 1.6: "podium-cloud does not call them today" (the four disabled session routes) | It does: the account page of `apps/app` calls `list-sessions`, `revoke-session` and `revoke-other-sessions`. PDM-495 adds `GET /platform/account/devices`, `DELETE /platform/account/devices/:id` and `DELETE /platform/account/devices` (every other device) on the package's device operations | The page itself is PDM-510's; until it is moved, the device list on the account page answers 404 |
| 47 | PDM-495 acceptance B3: "his account link [is] unchanged" for a removed Bob | Holds for a disabled Bob. For a removed Bob the membership keeps the account and the member row gives it up, as row 36 says | Row 36, accepted earlier |
| 48 | Section 2.3: the server computes the connection facts | For the platform's own routes (`/platform/*`) the platform computes them: always `https`, never same-machine, and the client address from one configured header (`PLATFORM_CLIENT_ADDRESS_HEADER`, by default `Fly-Client-IP` on a Fly machine). Without it every caller shares one budget of the library's limiter | Those routes are mounted through the plugin hook and do not see the server's trust boundary |
| 49 | No brief says it | Deploying PDM-495 signs every cloud account out once: the cookie is now `__Secure-podium.session_token` and tokens are stored hashed, so the migration deletes the earlier device sign-ins | An earlier sign-in could not be read any more, and its token was stored in clear |
| 50 | Section 1.3: creating a hosted workspace mints the creator's member id, and the membership keeps it | At the workspace's first start, before the first catch-up and in the step of row 44, the creator's membership takes the id of the first admin row the server's own migrations made. The key changes in Postgres only while nothing has been applied (the applied version is 0 and the minted id has no member row), with the workspace's revision row locked; versions do not move. Records the creator made before the first start (`created_by`) follow | Coordinator's decision, 2026-11-10: otherwise that first admin row stays enabled and unclaimed for ever, a member nobody can be, and the server's internal default principal is that row. It is the one place a membership's key changes, and it is done by podium-cloud outside the package's operations |
| 51 | Section 2.4: the account operations | One more, `accounts.setPasswordHash(accountId, hash)`: the password login method from a hash the edition's own functions made. It refuses, with `password-hash-invalid`, a string that is not in the edition's hash format; the edition says what that is through `passwordHashing.isHash`, and without its own hashing the library's format is checked. It is called only by server code (the password staged by `podium setup`, `PODIUM_PASSWORD`, setup's password inside the enrollment transaction), never with a value from a request body | A staged password exists only as a hash, and setup must hash before it opens its transaction (section 2.2, rule 5). Agreed with the coordinator |
| 52 | Section 8.1: `ensureLocalIdentity` is built by POD-6750 | POD-6746 builds its first case in `apps/server/src/identity/ensure-local-identity.ts`, run at boot only when the server built its own core: a workspace with no membership whose database holds exactly one member row, enabled, with no password in `user_credentials`, gets an active membership (`adopt` by `upgrade`, same role) and an account from its name and address with no login method. Every other database is left untouched and the boot log says so. POD-6750 extends the function in place | Without it a fresh one-person server has a member and no membership, so the same-machine rule admits nobody. Agreed with the coordinator |
| 53 | Section 5.2: an unauthenticated request is answered 401 | A request over plain HTTP that is not same-machine is answered 400 `https_required` on every transport, also when it carries no credential at all | Section 2.5 says so ("before anything is read"); the table of 5.2 is right and this row only states what a test of today's behaviour had to change (`server.open-mode.test.ts`) |
| 54 | Section 3: the seam's function receives `memberRows`, `appliedCursor` and `existingMembers` | Also `recoveryOnly: boolean`. True on a start whose workspace database cannot be written (a server move's recovery start): the function must write nothing through `memberRows` or the cursor, and the server does not call `catchUp()` | Found by PDM-495: the function adopts existing member rows at boot and must know when it may not |
| 55 | Section 2.6: the last admin and self-change refusals | The last-admin check precedes the self-disable or self-remove check. A sole admin receives `last-admin`; an admin with another active admin still receives `self` | POD-6747 route acceptance requires the clear last-admin explanation for every such action; the shared suite checks both editions |
| 56 | Section 2.6: `MembershipView.pendingInvitation`; section 4.3 admission counts | The pending invitation remains visible after expiry until sweep deletes it. Consumed and revoked invitations stay hidden; inspection and redemption still reject an expired token | POD-6747 needs the expiry to count expired invitations and let an admin reissue one; the shared suite checks visibility and refusal together |
| 57 | Section 2.8: `redeemPasswordReset` answers the account id | It also answers `endedSignInIds`, the public ids returned by the same statement that deletes the account's device sign-ins | POD-6747 closes exactly the sockets whose sign-ins ended, including a sign-in made between an earlier list and redemption. No token or hash is returned; the shared suite checks Bob's ended ids and Alice's surviving sign-in |
| 58 | Sections 1.3, 2.6 and 11: catch-up reads the latest snapshot of each membership | `identity_membership.authorization_version` persists the last authority-changing revision. Apply-membership passes it to the member writer, which steps the existing authorization generation when it is newer than `users.membership_version`, even if role and enabled state have returned to their previous values. Profile-only writes preserve the authority revision. No gate reads it | PDM-509 found that disable/enable or removal/re-admission between ticks otherwise resurrected old queued work. Approved by the coordinator; tested on SQLite and Postgres |
| 59 | Section 11.2 and row 34: the cursor has no transaction | `AppliedCursor.transaction` is an optional workspace transaction runner. The server supplies it over its existing store executor; catch-up applies one snapshot and advances its cursor in that transaction. A cursor failure rolls back member facts, generation and publications | PDM-509 tightened the crash window without changing bindings that cannot supply a transaction |
| 60 | PDM-509 account-deletion acceptance; the cloud already had an account-delete hook | The cloud extension enables the shared library’s self-deletion route. The shared library checks the signed-in account, trusted Origin, and password or fresh session. Its existing delete hook ends all memberships before deletion; workspace catch-up applies the changes | The hook was unreachable while library deletion was disabled. Approved by the coordinator, with self-only, foreign-Origin and stale-session tests |
| 61 | Section 2.4: a profile edit steps each live membership version | On Postgres, the first read finds the workspaces. After taking each workspace revision lock, the profile hook re-reads the live membership and preserves its status, role and authorization revision | PDM-509 reproduced a concurrent disable being overwritten by the earlier active snapshot. The two-connection test holds the disable’s lock while the profile edit reaches it |
| 62 | Section 8.3 gives the stored token and expiry but names no import operation | `@podium/identity/upgrade` exposes `importLegacyLink` for the server upgrade. It keeps the hash, original expiry and creator and uses the existing invitation and password-reset stores | The usual operations mint a new token. The upgrade has only the hash and the invitee may already have the original link |
| 63 | Sections 8.2 and 8.3 conflict when a legacy invitation targets the sole enabled member without a password | The member keeps their active membership and open access. The old link is refused and startup logs that the admin sets a password from Settings | The coordinator gave the sole-member rule precedence on 2026-11-10 |

| 64 | Section 9 retires source credential and invitation storage | The generated retirement migration waits for `identity.legacyLinksImported`; the local boot import records it only after member accounts and live links commit. Schema-only stores leave retirement pending. Rollback retains the initial pre-import backup | The direct-upgrade requirement from POD-6750, added to POD-6752’s brief on 2026-11-11: every supported older database must remain readable until its import completes |

## 17. Product questions this document could not settle

Each had a recommendation. Their state after the coordinator's review of 2026-11-10 is given with each. Nothing an implementing task depends on waits for the two that are still open: the document is written to the recommendation, and the place to change is named.

1. **Plain HTTP over a network. Awaiting the user.** The plan says self-hosting requires HTTPS. After the upgrade a server that people reach as `http://192.168.…` can no longer be used or signed in to; before, it could. The same happens to a server bound to a network address behind an HTTPS proxy on another machine when `PODIUM_TRUSTED_PROXY_HOPS` is not set, because the server then cannot know the connection was HTTPS. A proxy on the server's own machine is not affected (section 2.3). Recommendation: keep the decision, say it in the release notes, and have `podium setup` and the boot log say what to do (it already offers Tailscale Serve and a reverse proxy). If the user wants a grace period instead, it is one more row in the table of section 2.3.
2. **Plain HTTP on the same machine. Awaiting the user.** The user allowed HTTP only for the all-in-one app's loopback connection. The server cannot tell the app from a browser or the `podium` command on the same machine, and the command's host session depends on it. Recommendation: accept plain HTTP on any same-machine connection, on every server, as section 2.3 states. The alternative, only on an all-in-one install, breaks `podium` commands against a standalone server on its own machine.
3. **A first admin without an address in a team. Decided as recommended.** They sign in by leaving the email field empty (section 7.2), which the screen does not explain. When a second member is invited, the People screen asks such an admin to add an address first (the route exists: `auth.setEmail`). It is a screen change for POD-6749 and needs no server change.
4. **Postgres unreachable for a long time in a hosted workspace. Decided as recommended.** Nobody can enter, and work already running continues with the rights its member had (section 11.3). There is no hard stop: stopping every member's agents because the account database is down would turn one outage into two.
5. **A disabled member's sign-ins. Decided as recommended.** Self-hosted, disabling ends the member's device sign-ins, as today; enabling them again does not bring those back. Hosted, the account's sign-ins are the person's own and survive, so enabling restores access at once. The difference stays; it follows from who owns the account (`accounts`).
6. **An admin ending one device sign-in in a hosted workspace. Decided against the recommendation.** The recommendation was to allow it as the brief of PDM-510 says. The decision: a hosted admin ends no device sign-in of another person; the sign-ins belong to the person's cloud account and serve their other workspaces, and the admin's tools are disable and remove. It is the capability `adminEndDeviceSignIn` (section 2.9) and row 19 of section 16.
7. **The host session on a server with several members. Decided as recommended.** `podium auth mint-session` stays refused once a second member exists. A host session bound to one named member is a separate decision.
