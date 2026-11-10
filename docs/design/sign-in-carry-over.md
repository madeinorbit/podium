# Sign-in carry-over: design

Status: written for review by the coordinator of PDM-107. Not approved yet. Nothing in it is built.
It is the contract for POD-6751 (Sign-in carry-over) and binds POD-6746, POD-6747, POD-6748, POD-6750 and POD-6752 where section 8 says so.

| Written against | Commit |
|---|---|
| Open-source repository, `integrate/pdm-107-shared-sign-in` | `bdc733bd4e` |
| The specification | `docs/design/people-and-sign-in.md` at the same commit ("the specification" below) |

Sources: the plan (`people-and-sign-in-plan.md` on PDM-107), the specification, the spike report (`sign-in-library-spike-report.md` on POD-6742) and today's code at the commit above. Nothing was run for this document (section 14).

The requirement (user, 2026-11-10): nobody has to sign in again because of this upgrade. Pairing a phone again is acceptable.

## 0. The decision in short

1. An old sign-in is **exchanged**, not imported. A browser that still holds the old cookie gets a new device sign-in the first time it asks `GET /auth/status` after the upgrade. The old row is deleted in the same transaction.
2. The exchange happens in **one place**, `GET /auth/status`. No other route, and never the socket upgrade, reads the old cookie to let somebody in.
3. One old sign-in becomes **at most one** device sign-in. For ten minutes after the exchange, the same old cookie gets the same answer again (the same new cookie, no second sign-in). This covers a second tab asking at the same moment and an answer that never reached the browser. It is the one place this design is softer than "exactly one answer"; section 13, question 1.
4. An old sign-in is honoured only before its own expiry, only within 30 days of the upgrade, and only for a member whose membership is active.
5. Only the old **cookie** is carried. A phone that holds a bearer token pairs again.
6. The old cookie never resolves to a member. It only ever turns into a device sign-in cookie, and that cookie goes through the one resolution path of the specification (section 2.5 there).

## 1. Words

| Word | Meaning |
|---|---|
| Old sign-in | A row of `client_sessions` |
| Old cookie | The cookie `podium_session` (`SESSION_COOKIE` in `@podium/protocol`). Its value is the old token |
| Old token | 32 random bytes, base64url, 43 characters. Stored only as SHA-256, hex, in `client_sessions.token_hash` |
| Device sign-in | A row of `identity_session`, as in the specification |
| Carry | Turning one old sign-in into one device sign-in |
| Carry record | A row of the new table `carried_sign_ins`: what lets the same answer be repeated for ten minutes |
| The period | The 30 days after the upgrade in which a carry is possible |

## 2. What exists today

Read at `bdc733bd4e`.

| Fact | Where |
|---|---|
| `client_sessions` holds `token_hash` (primary key), `user_id` (the member id), `created_at`, `expires_at`, `label`, `session_id` (public id), `device_id`, `device_name`, `platform`, `last_seen_at` | `apps/server/src/migrations/schema.ts` (`clientSessions`) |
| The token is never stored. The hash is `sha256(token)`, hex | `hashToken` in `apps/server/src/auth-route.ts` |
| The cookie is `podium_session`, HttpOnly, SameSite=Lax, path `/`, no `Domain`, 30 days, `Secure` only when the sign-in happened over HTTPS | `setSessionCookie` |
| `login` and `mobile` rows are renewed to 30 days at most once a day while used. `break-glass` rows keep the expiry chosen at mint | `maintainClientCredentialByHash` |
| A bearer token is accepted only for a `mobile` row, only over HTTPS | `resolveClientCredential`, `clientAuthGuard` |
| Phone pairing can deliver a `mobile` sign-in as a cookie (`delivery: 'browser'`) or as a bearer (`'native'`) | `apps/server/src/mobile-pairing-route.ts` |
| A browser row has `device_id = 'browser'`, the desktop app's has `device_id = 'desktop'` | `browserSignInMetadata` in `sign-in-device.ts` |
| The `podium` command sends its cached token as the old cookie. The cache is `cli-session.json` in the state directory; `PODIUM_SESSION_TOKEN` overrides it | `packages/issue-client/src/client.ts`, `packages/runtime/src/session-mint.ts` |
| The desktop shell copies the cookie named `podium_session` to a new origin when the window follows a moved server | `apps/desktop/src-tauri/src/main.rs` (`retarget_session_cookie`), `bootstrap.rs` (`session_cookie_for_target`) |
| The web client asks `GET /auth/status` before anything else at start, and again whenever a sync request is refused with 401 | `apps/web/src/lib/use-kernel-replica.ts`, `apps/web/src/features/setup/LoginGate.tsx` (`SYNC_AUTH_EXPIRED_EVENT`) |
| A page loaded before the upgrade reloads itself when it reconnects to a server of another version | `apps/web/src/features/setup/version-guard.ts` |
| Disable, remove, sign-out-everywhere and password recovery delete all `client_sessions` rows of the member | `apps/server/src/store/users.ts` (`deleteClientSessionsOf`) |

After the upgrade (specification, section 2.3) a device sign-in cookie is `__Secure-podium.session_token` over HTTPS and `podium.session_token` on a same-machine HTTP connection, signed, with a token of the library. The old and the new cookie differ in name, in form and in token, so one can never be taken for the other.

## 3. Approaches

### 3.1 Chosen: a one-time exchange at the status route

Section 4 describes it. Why this one:

- It needs nothing from the client. Every client already asks `/auth/status` first and again after a refusal; the browser sends the old cookie and stores the new one by itself. This holds for a page loaded before the upgrade too.
- The shared identity package stays free of old formats. The server calls two operations of the package: one read that exists for this purpose (section 9) and `deviceSignIns.create`, which pairing and the host session use as well.
- The token changes. An old token that leaked at any time before the upgrade stops being worth anything once its owner's browser has been carried.
- It is one small server module with a removal date, and it deletes its own data.

### 3.2 Rejected: importing old rows so the library accepts the old tokens

The stored forms would even allow it: `client_sessions.token_hash` is the hex of the same SHA-256 whose base64url the package stores in `identity_session.token`, so a row could be copied without knowing the token. It is rejected in both of its forms.

| Form | Why not |
|---|---|
| Import, and let `resolve` also accept the old cookie name with an unsigned token | A second credential form inside the one resolution path, in the shared package, for as long as such a sign-in is renewed, which is without limit. It ends "a bearer or cookie is accepted only in signed form" (specification 1.6). A cookie issued without `Secure` would stay a live credential on a server that now requires HTTPS. |
| Import, and on first sight re-issue the same token under the new name with a signature | The token from before the upgrade stays the live secret. Anybody who obtained an old token and later obtains the signing secret (it is in the database) can build a valid cookie. With an exchange, an old token is worth nothing after the carry. It also writes `identity_session` rows from a migration, past the library and the hashing layer, and creates device sign-ins for every stale row whether or not that browser ever comes back. |

### 3.3 Rejected: the others

| Approach | Why not |
|---|---|
| Keep the hand-written check running beside the package until the old rows have expired | A second sign-in system with fall-through. The rules forbid it. |
| Exchange on every HTTP request instead of one route | More places that can let somebody in, and it changes the pinned statement count of every guarded request. A script that holds an old token would work for ten minutes and then fail, which is harder to understand than failing at once. Nothing needs it: every client reaches the status route. |
| Exchange on the socket upgrade | A cookie set on an upgrade answer is not stored reliably by every webview. A socket admitted that way would run on a sign-in its browser may never have received. |
| A new token computed from the old one with a server key, so a repeat needs no stored record | The package would have to accept a token chosen by its caller. And an old token together with a copy of the database would yield the live token for as long as the key exists. |
| Exactly one answer, no repeat (the strictest reading of "once") | Three tabs of one browser reconnect at the same moment after the server restarts; one gets the new cookie, the other two show the sign-in form. An answer lost on the way leaves the browser with a dead old cookie. Both break the user's requirement. Section 13, question 1. |
| Carry bearer tokens too | The phone app would have to store a new token from an answer. That needs an app release tied to a server upgrade. The user accepted pairing again. |
| Do nothing | Everybody signs in again. The user decided against it. |

## 4. The carry, step by step

All of it is server code in `apps/server` (section 9). It exists only when the server built its own identity core (the seam of specification section 3 is absent). In a hosted workspace none of it is constructed and the old cookie is never read.

### 4.1 When it is attempted

In `GET /auth/status`, after the normal resolution, when **all** of these hold:

1. the resolution found no device sign-in: it is `unauthenticated`, or it is `member` by the same-machine rule (`deviceSignIn` is null);
2. the request carries the old cookie, and its value is 20 to 512 characters of the base64url alphabet;
3. the resolution is not `https_required` (so the connection is HTTPS, or plain HTTP on the same machine);
4. the request has no `Origin` header, or one that `isAllowedHttpOrigin` accepts;
5. the period has not ended (section 7).

In every other case the route answers exactly as it would without the old cookie. A request that already has a device sign-in is never touched: a valid new sign-in always wins over an old cookie.

### 4.2 The transaction

One write transaction of the server's store (`createOrJoinTransaction`). `h` is the SHA-256, hex, of the cookie value.

1. **Consume.** One statement:
   `delete from client_sessions where token_hash = h and label in ('login', 'mobile', 'break-glass') and expires_at > now returning user_id, label, expires_at, device_id, device_name, platform`.
   No row: go to section 4.3.
2. **Member.** Ask the package for the account of that member (`user_id`) if the member's membership in this workspace is `active` (section 9). No account: commit and answer as without the cookie. The old sign-in is gone and nothing was issued.
3. **Issue.** `deviceSignIns.create(accountId, device, 'cookie', facts, life)` with:

   | Old row | `device.kind` | `device.name`, `platform`, `deviceId` | `life` |
   |---|---|---|---|
   | `login`, `device_id = 'desktop'` | `desktop` | from the old row | absent: 30 days, renewing, like any new sign-in |
   | `login`, any other `device_id` | `browser` | from the old row; a row without a name is named from the request's user agent | absent |
   | `mobile` | `phone` | from the old row, including its device id | absent |
   | `break-glass` | `host` | name `Host session` | `{ expiresAt: the old row's expires_at, fixed: true }` |

   A `login` or `mobile` sign-in gets a fresh 30 days because that is what today's code does on the same request: it renews such a row to 30 days whenever it is used. A `break-glass` sign-in keeps the expiry its operator chose and is never renewed, as today.
4. **Record.** Insert a carry record for `h` (section 4.4) that expires ten minutes from now.
5. **Audit.** One audit row, command `members.signInCarried`, with the member id, the old label and the new device sign-in's id. No token, no hash, no address.
6. Commit. If any step fails the transaction rolls back, the old row is still there, and the next request can try again.

The route then resolves once more with the new cookie in place of the request's cookies, through `memberOfRequest`, and builds its normal answer from that resolution. The answer carries the `Set-Cookie` headers of the new sign-in. The old cookie is **not** cleared (section 4.5).

### 4.3 The repeat

Reached when step 1 found no row. Still inside the transaction:

1. Read the carry record for `h`. None, or expired: answer as without the cookie.
2. Open it with the presented token (section 4.4). It cannot be opened: answer as without the cookie.
3. Resolve with the cookie from the record. If that resolution is not `member` (the sign-in was ended, the membership is no longer active), delete the record and answer as without the cookie.
4. Otherwise answer as in section 4.2, with the same `Set-Cookie` headers.

A repeat creates nothing and writes nothing except the delete in step 3.

**Two requests at the same moment.** A write transaction of the store is exclusive (specification 1.4). The first runs section 4.2 completely. The second starts after the first committed, finds no old row in step 1, finds the carry record and returns the same cookie. Both browser tabs are signed in; one device sign-in exists. The build proves this with real parallel requests (section 10, test 5); if the store's transactions turn out not to exclude each other, the build stops and reports it, because the specification depends on the same property.

### 4.4 The carry record

New table in the server's migration chain, `carried_sign_ins`:

| Column | Type | Meaning |
|---|---|---|
| `old_token_hash` | text primary key | `h` |
| `device_sign_in_id` | text not null | The sign-in the carry made. For the audit trail and the tests; not used to let anybody in |
| `sealed` | text not null | The `Set-Cookie` header values of the new sign-in, encrypted. base64url of salt (16 bytes), nonce (12 bytes), ciphertext and tag |
| `expires_at` | text not null | Ten minutes after the carry |

Index on `expires_at` for the sweep.

Sealing, with the synchronous functions of `node:crypto` so the transaction is not held across an await:

- key: HKDF-SHA-256 over the old token, with the record's random salt and the info string `podium/sign-in-carry-over/v1`, 32 bytes;
- cipher: AES-256-GCM with a random nonce; additional data: `h`;
- plaintext: the JSON array of the `Set-Cookie` values.

The server cannot open a record by itself. Only a request that presents the old token can, and it gets back exactly what the first answer contained. A copy of the database holds a ciphertext whose key is a 256-bit secret the database does not contain.

### 4.5 The old cookie is left in the browser

The server never clears the old cookie during a carry.

- After the carry the cookie matches nothing: its row is deleted, and its carry record goes within ten minutes. A request that has a device sign-in never looks at it.
- Rollback (specification 8.4) restores the database backup with the older binary. That backup still holds the old row, and the browser still holds the old cookie, so a person who was carried is still signed in after a rollback. Clearing the cookie would sign them out exactly then.
- A cookie named `podium_session` may belong to another Podium server on the same host name (cookies do not know ports). Clearing what this server does not recognise would sign people out of the other one.

`POST /auth/logout` is the exception, as today: it clears the old cookie, and it deletes the old row and the carry record of the cookie it was sent (section 5).

## 5. Rules the build must enforce

Each rule has at least one test in section 10.

**Where**

- R1. Only `GET /auth/status` can carry. `/trpc`, `/files`, `/sync`, the socket upgrade, the control socket and every other route treat a request that has only an old cookie exactly like a request with no credential.
- R2. Only the cookie named `podium_session` is read. An old token sent as `Authorization: Bearer`, or placed in a cookie of the new names, is not an old sign-in.
- R3. Carrying exists only on a server that built its own identity core. With the hosted seam present the old cookie is never read.
- R4. A request that resolves to a device sign-in is never carried and its old cookie is never looked up.

**When**

- R5. An old sign-in is honoured only while `expires_at > now`. The row's `expires_at` is the one today's code last wrote; nothing after the upgrade extends it.
- R6. An old sign-in is honoured only before the period ends: 30 days after the first start of the server with the carry-over (section 7). This holds even for a `break-glass` row with a later expiry.
- R7. An old sign-in is honoured only for a member whose membership is `active` and names an account, checked inside the carry transaction. For any other member the old row is deleted and nothing is issued.
- R8. Only the labels `login`, `mobile` and `break-glass` are honoured. `upstream`, `server-transfer-claim` and every other value never are.
- R9. A carry needs HTTPS, or plain HTTP on a same-machine connection, by the connection facts of the specification (2.3). It is refused for a request with a foreign `Origin`.

**Once**

- R10. One old sign-in yields at most one device sign-in, for ever. The old row is deleted by the statement that consumes it, in the transaction that creates the device sign-in.
- R11. Any number of requests that present the same old cookie at the same moment yield one device sign-in, and each of them is answered with the same cookie.
- R12. A repeat is possible for ten minutes after the carry, only with the old token, and only while the device sign-in it made still resolves to a member. It never creates a sign-in.
- R13. After those ten minutes the old token gains nothing, whoever presents it.

**Nothing for a made-up cookie**

- R14. An old-style cookie that matches no row and no carry record gets an answer that is equal, byte for byte, to the answer for the same request without it: same status, same body, no `Set-Cookie`. It causes no write. This includes a random value, the stored hash sent as the value, a sign-in's public id, and a real token of a label that is not honoured.
- R15. Nothing but the token decides whose sign-in is carried. The member comes from the old row's `user_id`, the account from that member's membership. No header, body field, address or email of the request plays a part.

**Ending old sign-ins**

- R16. Whatever ends all device sign-ins of a member also deletes that member's old sign-ins and their carry records, in the same transaction: disabling, removing, sign-out-everywhere (by the member or by an admin), and redeeming a password-reset code. Enabling a member again brings none of them back.
- R17. `POST /v1/sign-ins/revoke` on the control socket, for kind `host`, also deletes every `break-glass` old sign-in and its carry record.
- R18. `POST /auth/logout` with an old cookie deletes that old row and its carry record and clears the cookie. It never carries.

**The new sign-in**

- R19. A carried sign-in is an ordinary device sign-in. It is listed, renewed, revoked and ended like any other; nothing marks it as carried except the audit row.
- R20. A carry never steps an authorization generation and never changes a member row or a membership.

## 6. Per transport and per label

### 6.1 Transports

| Transport | What happens |
|---|---|
| HTTP request from a browser | The page asks `/auth/status` first; the carry happens there. The following requests carry the new cookie. A request that reaches a guarded route with only the old cookie is answered 401, the client asks `/auth/status` (it does so today after a refused sync request), is carried, and goes on. |
| WebSocket connection (`/client`) | The upgrade is resolved by the one path and never carries. With only an old cookie it is refused with 401, like no cookie. After the status route has carried the browser, the upgrade carries the new cookie and the socket holds the new sign-in's id. A page from before the upgrade reloads when it reconnects (version guard) and then starts with the status route. |
| Desktop app | Its window is a webview with a cookie store; it behaves as a browser. An old row with `device_id = 'desktop'` becomes a sign-in of kind `desktop`. The all-in-one app on its own machine needs no sign-in at all (same-machine rule); if it holds an old cookie, the status route still carries it, so pairing and the device list keep working there. The shell's copy of the cookie on a server move is a separate gap (section 12, row 5). |
| Bearer token | Never carried (R2). Only `mobile` rows have one. The phone app gets 401, shows that the server was upgraded and offers pairing (POD-6749 owns the wording). |
| The `podium` command (host session) | Its cached token is an old `break-glass` token and is sent as the old cookie. The command, when its cache file is in the old form, asks `GET /auth/status` once with it, stores the cookie it gets back in the new form, and uses that from then on. An old token given through `PODIUM_SESSION_TOKEN` is not carried: the command cannot store the result, so it says that the token is from before the upgrade and names `podium auth mint-session`. |
| Hosted workspace | Nothing is carried (R3). Hosted people sign in with their cloud account, which this upgrade does not touch. |

A person who reaches the server by plain HTTP over a network cannot be carried, because after the upgrade nothing can be done over such a connection (specification 17, question 1, awaiting the user). Their old row waits. If they come back over HTTPS under the same host name within the period, the browser sends the old cookie and they are carried. Under another host name the browser has no cookie to send and they sign in.

### 6.2 Labels

| Label | Carried | As | Why |
|---|---|---|---|
| `login` | yes | `browser` or `desktop`, 30 days, renewing | the requirement |
| `break-glass` | yes | `host`, original expiry, fixed | The brief puts it in scope. On a server with several members a new host session is refused (specification 17, question 7), so an existing one is the only way the host's `podium` command keeps working until it expires. Carrying it gives nothing a process with write access to the database does not already have. Section 13, question 2 |
| `mobile`, held as a cookie | yes | `phone`, with its device id, 30 days, renewing | It is the same route and the same cookie; it costs one more row in a table and one test. The line this design draws is what the server can do without the client's help |
| `mobile`, held as a bearer | no | | section 3.3 |
| `upstream`, `server-transfer-claim` | never | | not a person's sign-in; deleted by the upgrade (POD-6750) |
| anything else | never | | R8 |

Choice for mobile, as the brief asks: **phones that hold a bearer pair again; a phone browser that holds a cookie is carried.**

The row does not record how its token was delivered, so the line is drawn by how the token is presented, not by how it was issued. Somebody who holds a phone's bearer token and sends it as the old cookie to the status route is carried. That is not a new power: the same person could use the bearer directly today. It does mean "bearer tokens are not carried" describes what the phone app can do, not a barrier (section 13, question 3).

## 7. Leftovers: how long they live and how they are deleted

**The period.** At the first start of a server that has the carry-over, after the migrations and `ensureLocalIdentity` and before it listens, the server writes the key `signInCarryOver.endsAt` into `meta` if it is absent: now plus 30 days when `client_sessions` holds a row with an honoured label, otherwise now. The value is never changed afterwards. Thirty days is the lifetime of an old `login` or `mobile` row, so by then each of them has expired by itself; the limit only cuts `break-glass` rows with a longer life. The boot log states the instant and the number of old rows, once.

| Leftover | Lives | Deleted by |
|---|---|---|
| An old row that was carried | not at all | the consuming statement (R10) |
| An old row of a member who is not active, presented | not at all | the consuming statement (R7) |
| An old row that is never presented | until its `expires_at`, at most until the period ends | the hourly sweep: `delete from client_sessions where expires_at <= now` |
| An old row of a member whose sign-ins are ended | until that act | R16, R17, R18 |
| A carry record | ten minutes; unusable after `expires_at` even while the row still exists | the hourly sweep; earlier when its sign-in no longer resolves (section 4.3, step 3) |
| Everything, when the period has ended | | at start and in the hourly sweep: every row of `client_sessions` and of `carried_sign_ins` is deleted. From then on the status route does not look at the old cookie (one flag in memory, set at start and by the sweep) |
| The old cookie in a browser | until its own 30 days pass, or sign-out | the browser; `POST /auth/logout` |
| The two tables, the module, the old cookie name | until the removal date | section 8.3 |

The sweep is the server's existing hourly timer that calls the package's `sweep` (specification 2.3); the carry-over adds its three statements to it.

## 8. What the other tasks must leave, and what may be dropped

### 8.1 POD-6750 Existing server upgrade

Must leave in place:

- the table `client_sessions` with all columns and indexes;
- every row with label `login`, `mobile` or `break-glass`, unchanged in every column. In particular `user_id`, `expires_at`, `label`, `device_id`, `device_name`, `platform`;
- member ids unchanged;
- for every enabled member with a password, and for the only enabled member of a one-person server, a membership in status `active` that names an account (specification 8.2). The carry depends on nothing else from the upgrade.

Must do, as the specification says: delete the rows with label `upstream` and `server-transfer-claim`.

Must not: rewrite `expires_at`; delete expired rows of the three labels (harmless, but the carry-over's sweep owns it); write `signInCarryOver.endsAt`.

### 8.2 POD-6746, POD-6747, POD-6748

- **POD-6748 Devices and pairing** must leave: the table definition `clientSessions` in `apps/server/src/migrations/schema.ts`; the constant `SESSION_COOKIE` in `@podium/protocol`; an old-form `cli-session.json` unread and undeleted when the `podium` command finds one. It stops every write to `client_sessions` (sign-in, pairing, the host session, the server move), as the specification says. It may delete every method of `AuthRepository`, including `getClientSession` and `deleteClientSession` and the function `hashToken`: the carry-over brings its own statements (section 9). This is less than specification 8.5 keeps (section 12, row 1).
- **POD-6746 Server sign-in path** must not read the old cookie anywhere. Its `GET /auth/status` and `POST /auth/logout` are the two places POD-6751 edits afterwards.
- **POD-6747 People and invitations** and **POD-6745** (`MemberRows.write`) need no change. POD-6751 adds the calls of R16 into their files afterwards.
- None of the three lists old sign-ins anywhere. The device list and the Access screen show device sign-ins only (section 13, question 4).

**A release rule for the coordinator.** POD-6746 to POD-6750 must not reach any build that people run, `dev/mw` included, without POD-6751. A server that runs them without the carry-over signs every browser out. If that happens anyway, nothing is lost for good: the old rows stay, and a later build with the carry-over carries those that have not expired.

### 8.3 POD-6752 Hand-written sign-in removal

May drop in its own change, with no regard to the carry-over: `user_credentials`, `member_invites`, `POST /auth/users`, the unused handshake strategies, `packages/runtime/src/session-mint.ts` except what reads an old-form cache file, and everything else specification section 9 gives it.

Must **not** drop yet, and must schedule with one `LEGACY(remove-after: …)` line each, all with the same date:

- the table `client_sessions` and its definition;
- the table `carried_sign_ins`;
- the carry-over module and its calls in `auth-route.ts`, the member routes, `MemberRows.write` and the control socket;
- `SESSION_COOKIE`;
- the old-form cache reading in the `podium` command.

On one server the data is gone 30 days after that server's upgrade (section 7). The code and the tables have to stay longer, because a server that upgrades later starts its own 30 days then. Removing them means: a server that upgrades from a version before shared sign-in straight to a version after the removal signs everybody out once. The date is a product decision (section 13, question 5). The removal after that date is one change: delete the module and its calls, and one migration that drops both tables.

## 9. What POD-6751 builds

| Piece | Where |
|---|---|
| The carry-over: the conditions of 4.1, the transaction of 4.2, the repeat of 4.3, sealing, the period, the sweep statements | new `apps/server/src/sign-in-carry-over.ts`, with its statements in new `apps/server/src/store/sign-in-carry-over.ts` (prepared once, as `docs/agents/server-data.md` requires) |
| The table `carried_sign_ins` | one migration through `bun run migration:new`, rehearsed with `scripts/rehearse-upgrade.ts` |
| One read in the package: `memberships.accountOfActiveMember(memberId): Promise<string \| undefined>`, one prepared statement by primary key | `packages/identity/src/membership/` |
| The call in `GET /auth/status`; the deletion in `POST /auth/logout` | `apps/server/src/auth-route.ts` |
| The deletions of R16 | `MemberRows.write` in `apps/server/src/store/users.ts` (disabled, removed); the sign-out-everywhere and password-reset paths of `member-routes.ts` |
| The deletion of R17 | the host sign-in routes of `control-socket.ts` |
| The old-form cache: detect, ask the status route once, rewrite | `apps/cli`, and the cache reader POD-6748 leaves |
| Fixture rows with real tokens (section 10.1) | `packages/runtime/src/fixtures/customer-upgrade/` |

The module has one public surface: `carry(request, facts, resolution)` for the status route, `endForMember(memberId)`, `endByLabel(label)`, `endForCookie(request)`, `sweep()`, and `start()` for the period. Every statement that touches `client_sessions` or `carried_sign_ins` after POD-6748 is in its store file, so the removal is a deletion of two files and their call sites.

The carry must not appear on the per-request path: a status request without an old cookie runs no statement more than before (pinned, test 27).

## 10. The tests the build must pass

Every test starts from the customer-upgrade fixtures, upgraded by the server's own start (migrations, `ensureLocalIdentity`, the carry-over's `start`), and talks to the server over real HTTP with real `Cookie` headers. Alice is the control wherever a test changes Bob. Each test is seen failing first with its mechanism turned off, and the report gives both exit codes.

### 10.1 Fixture rows

The fixtures hold only made-up hash strings today (`fixture-only-cookie-hash-alice`), which no cookie can match. The build adds rows whose `token_hash` is the real SHA-256 of a token kept beside it in a fixture file of test-only values:

| Fixture | Rows added |
|---|---|
| Two members (`multi-member-rows.json`, Alice admin, Bob member) | Alice: `login` from a browser; `login` from the desktop app; `break-glass` with a fixed expiry; one expired `login`. Bob: `login` from a browser; `mobile` held as a cookie, with a device id. Also one `upstream`, one `server-transfer-claim` and one row with an unknown label, each with a known token |
| One person (`server-rows.json`) | the sole member: one `login`, one `break-glass` |

The existing rows stay, so the existing fixture tests keep their meaning.

### 10.2 Carrying

1. Alice's browser cookie on `GET /auth/status`: the answer says signed in as Alice's member id and sets the new cookie; her old row is gone; her account has exactly one device sign-in, kind `browser`, expiring in 30 days; Bob's old rows and device sign-ins are unchanged.
2. The new cookie alone is then accepted on `/trpc`, `/files`, `/sync` and the socket upgrade.
3. Each kind: the desktop row gives kind `desktop`; Bob's `mobile` cookie gives kind `phone` with the old device id; Alice's `break-glass` gives kind `host` with exactly the old expiry and is not renewed after a day (clock moved).
4. One person with a password: carried. One person without a password on the same machine: carried too, and the status answer was "signed in" before and after.
5. Twenty status requests at the same moment with one old cookie: one device sign-in exists; all twenty answers say signed in and set the same cookie value.
6. Rehearsal: `scripts/rehearse-upgrade.ts` on both fixtures starts the server; the boot log names the end of the period and the number of old rows.

### 10.3 Once

7. A second status request with the same old cookie within ten minutes returns the same cookie and creates nothing (row counts).
8. The same after ten minutes (clock moved): the answer is the no-cookie answer. After the sweep the carry record is gone.
9. Alice ends the carried sign-in by its id; a repeat within the ten minutes gets nothing and the carry record is deleted.
10. A fault injected into `deviceSignIns.create`: the transaction rolls back, the old row is still there, the next request carries.

### 10.4 Expiry and membership

11. The expired row gets nothing. A row one second before its expiry is carried; at its expiry it is not.
12. The clock moved past the period's end: an unexpired `break-glass` row gets nothing; after start or sweep both tables are empty; the status route runs no statement for an old cookie any more.
13. Bob is disabled before his browser comes back: his old rows are deleted by the disable; his cookie gets nothing. Bob is enabled again: still nothing. Alice's cookie still carries.
14. The same for removing Bob.
15. A member whose membership is `invited` (the upgrade's third row in specification 8.2) with an old row: nothing is issued and the row is deleted.
16. Sign-out-everywhere by Bob, and by Alice for Bob, deletes Bob's old rows and not Alice's. Redeeming a password-reset code for Bob does the same.
17. `POST /v1/sign-ins/revoke` for kind `host` deletes the `break-glass` old rows and no others.
18. `POST /auth/logout` with only an old cookie deletes that row, clears the cookie and issues nothing.

### 10.5 Nothing for a made-up cookie

For each value below, the status answer equals the answer without any cookie in status, body and headers, no `Set-Cookie` is sent, and no statement that writes is run (captured at the driver):

19. 43 random base64url characters; an empty value; 600 characters; characters outside the alphabet.
20. Alice's stored `token_hash` sent as the value; Alice's public `session_id` sent as the value.
21. The real tokens of the `upstream`, `server-transfer-claim` and unknown-label rows. Their rows are untouched.
22. Alice's real old token sent as `Authorization: Bearer` over HTTPS; sent in a cookie named `__Secure-podium.session_token` without a signature; sent there with a signature made with another secret.

### 10.6 Transports and boundaries

23. Only an old cookie on `/trpc`, `/files`, `/sync` and the socket upgrade: 401 on each, and the old row is untouched.
24. The socket: refused with the old cookie alone; after the status request, accepted with the new cookie, and the socket's held sign-in id is the new one.
25. Plain HTTP from another machine: `https_required`, the old row untouched. The same cookie over HTTPS afterwards: carried.
26. A foreign `Origin` on the status request: nothing, the old row untouched.
27. A request with Bob's valid new cookie and Alice's old cookie: it stays Bob; Alice's old row is untouched; the statement count of the request equals that of a request without the old cookie.
28. A server built with the hosted seam: the old cookie is never read (no statement on `client_sessions`).
29. The `podium` command with an old-form cache file: the first command works and rewrites the file; the second uses the new form; the old token is then worth nothing after ten minutes. With an old token in `PODIUM_SESSION_TOKEN`: refused with the message that names the fix.
30. The audit row of a carry exists and holds no token and no hash.
31. Rollback: upgrade, carry Alice, then restore the backup with the fixture's older schema: Alice's old row is back, and the cookie her browser kept still matches it.

### 10.7 Driven once, because tests cannot reach a cookie store

32. A real browser on the upgraded two-member fixture, with Alice's old cookie in its store and two tabs opened at once: both tabs show the app without the sign-in form.
33. The desktop shell with an old cookie in its webview: the window shows the app without the sign-in form (`docs/agents/driving-desktop.md`).

Lanes: focused files while building; `bun run typecheck`; the store shard because a table is added; then the lean gate under the `test:heavy` lease. The server test shard manifest is regenerated after the new files are added.

## 11. What an attacker can do

### 11.1 Holding an old cookie

The old token is a bearer secret today: whoever holds it is that member until it expires or is ended. The carry-over must not make that worse, and makes it better in one way.

| Situation | Result |
|---|---|
| The thief presents it before the owner's browser does | The thief gets a device sign-in of that member, as they could have used the old cookie directly before the upgrade. The owner's browser, coming within ten minutes, gets the same sign-in; later it gets nothing and the owner signs in. The sign-in appears in the member's device list and can be ended there. Not worse than today |
| The owner's browser was carried more than ten minutes ago | The old token gains nothing, for ever (R13). Today it would have worked until it expired. Better than today |
| Within ten minutes of the owner's carry | The thief gets the same cookie the owner got. No further sign-in exists. The owner sees one device in the list. Same exposure as today, for ten minutes |
| The cookie has expired, or 30 days have passed since the upgrade | Nothing (R5, R6) |
| The member was disabled or removed, signed out everywhere, or reset their password | The row is gone (R16); nothing |
| The member is disabled when the cookie is presented, before any of those acts ran | Nothing is issued and the row is deleted (R7) |
| Presented anywhere but the status route, or as a bearer | Nothing (R1, R2) |
| A phone's bearer token, sent as the old cookie to the status route | Carried as a `phone` sign-in (section 6.2). The holder could use the bearer directly today |
| Presented over plain HTTP from another machine | `https_required`; the row is not touched |

A cookie cannot be turned against another person: the member comes from the row the token's hash selects (R15). A cross-site page cannot make a victim's browser send the old cookie on anything but a top-level navigation (SameSite=Lax); a navigation to `/auth/status` carries the victim's own sign-in into the victim's own browser, which is what the next page load would do. An attacker who can plant their own old cookie in a victim's browser (a sibling subdomain) can do that today with the same effect, and cannot replace a sign-in the browser already has (R4).

### 11.2 Holding a copy of the database from before the upgrade

It contains `client_sessions.token_hash`, the password hashes in `user_credentials`, and no signing secret (none existed).

- A token cannot be had from its hash: it is 256 random bits behind SHA-256.
- The hash sent as a cookie is hashed again and matches nothing (test 20).
- The password hashes can be attacked offline, as today. A password found that way signs in through the normal password route; it has nothing to do with the carry-over.
- The copy cannot be written back into the running server.

So the copy alone gains nothing through the carry-over. Together with an old cookie it gains what the cookie alone gains (section 11.1).

A copy taken **after** the upgrade also holds the signing secret and, for ten minutes each, carry records. A record opens only with the old token. The signing secret signs a token but cannot produce one whose hash is in `identity_session`. Old token and late copy together give the new cookie only inside the ten minutes; afterwards nothing, which an import with the same token (section 3.2) could not say.

### 11.3 Holding a second account

Bob is a member and wants to be Alice.

- Bob's own old cookie carries to Bob's account, with Bob's role. Nothing in a request chooses the member (R15).
- Bob knows Alice's member id, her email, or the public id of one of her sign-ins (an admin sees those in Access). None of them is a token; each gets the no-cookie answer (test 20).
- Bob sends his valid new cookie together with a cookie he made up for Alice: he stays Bob (R4, test 27).
- Bob, disabled, keeps his old cookie hoping to be enabled again: the disable deleted his rows (R16).
- Bob is not an admin and cannot end Alice's sign-ins or see her old rows; no route lists old rows at all.
- Two members share one browser profile: the browser holds one old cookie, of whoever signed in last. It is carried for that member, exactly the person the browser was signed in as.

A person with an account and no membership (possible in the cloud only) cannot reach any of this: carrying does not exist there (R3).

### 11.4 What a made-up old-style cookie gains

Nothing (R14): no sign-in, no cookie, no write, no difference in the answer, and no way to tell a value that never existed from one that was carried an hour ago. Guessing means finding a 256-bit value. Each attempt costs the server two reads by primary key; the status route is as cheap to call without a cookie, so no separate throttle is added.

### 11.5 What the carry-over adds to the server's attack surface

One route can now write on a `GET`. It writes only for a token that matches an unexpired row of an active member, each row once. The route already answers everybody. The new table holds ciphertexts and hashes. The module has a removal date.

## 12. Where this document differs from the specification and the briefs

For the coordinator. None changes a goal.

| # | Specification or brief | This document | Why |
|---|---|---|---|
| 1 | Specification 8.5 and section 9: POD-6748 keeps `hashToken`, `getClientSession(tokenHash)` and `deleteClientSession(tokenHash)` | Not needed. The carry consumes with one `delete … returning`; a read followed by a delete would be a race. POD-6748 may delete all of `AuthRepository` and must keep only the table definition and `SESSION_COOKIE` | section 4.2 |
| 2 | Specification 6: "`mobile` … If not [carried], the phone pairs again" | A `mobile` sign-in held as a cookie is carried; one held as a bearer is not | section 6.2 |
| 3 | The package's operations as listed in specification 2.6 | One more read, `memberships.accountOfActiveMember(memberId)` | The carry needs the account of one member; `list()` reads every membership |
| 4 | Files owned by POD-6745, POD-6746, POD-6747 and POD-6748 (specification 14) | POD-6751 adds one call each to `auth-route.ts`, `member-routes.ts`, `MemberRows.write` and `control-socket.ts`, after those tasks have landed | R16, R17, R18 |
| 5 | Specification 14 names no owner for the desktop shell | The shell copies the cookie named `podium_session` when the window follows a moved server (`main.rs`, `bootstrap.rs`). After the upgrade the sign-in is in a cookie of another name, so the copy finds nothing and the person signs in at the new address. This is not a carry-over matter and is not built by POD-6751. It needs an owner; POD-6748 ("the matching client code") is the natural one | found while reading; reported by mail |
| 6 | Specification 9: POD-6752 drops `SESSION_COOKIE` and `client_sessions` "when the carry-over's leftover period has passed, otherwise scheduled with a date" | Always scheduled with a date. The period is per server, so no release can know it has passed everywhere | section 8.3 |
| 7 | Specification 13.2: an old cookie is honoured "until its original expiry, for an active membership, once" | The same, plus two limits it did not name: 30 days after the upgrade, and the ten-minute repeat | sections 4.3, 7 |
| 8 | Brief: "the old row deleted" on exchange | Deleted, and for ten minutes a record keyed by the old token's hash remains | section 4.4 |
| 9 | No task says it | The release rule of section 8.2 | Without it a build signs everybody out |

## 13. Open questions, each with a recommendation

The document is written to the recommendation in every case. The place to change is named.

1. **The ten-minute repeat.** Strictly, "once" could mean one answer and nothing after it. Then a second tab that asks at the same moment, and a browser whose answer was lost, show the sign-in form, and the user's requirement is not met for them. **Recommendation: keep the repeat.** It creates no second sign-in, it needs the old token, and it ends by itself. The strict form is sections 4.3 and 4.4 deleted, with tests 5 and 7 turned into "one answer signs in, the others do not".
2. **A `break-glass` sign-in on a server with several members.** A new host session is refused there. **Recommendation: carry the old one.** It keeps its fixed expiry and its authority is the one it has today; refusing it would cut the host's `podium` command off at the upgrade with no way to get a new session. The other choice is one more condition in step 2 of section 4.2.
3. **`mobile` cookies.** **Recommendation: carry them**, as section 6.2 says: a phone browser that was paired stays signed in at no extra cost. The price is that any `mobile` token presented as a cookie is carried, also one that was issued as a bearer. If the security review prefers the smaller rule, "no `mobile` row is ever honoured" is one label less in the consuming statement, and phone browsers pair again like phone apps.
4. **Old sign-ins that were never presented are not shown anywhere.** For up to 30 days such a row can still become a sign-in, and neither the member's device list nor Access lists it. A member ends them with sign-out-everywhere; an admin with disable, remove or sign-out-everywhere for that member. **Recommendation: leave it so.** Showing them needs a second kind of row in two screens for a case that ends by itself. If the security review wants it visible, the cheap form is one number in `GET /auth/admin/access`.
5. **The removal date** (section 8.3). **Recommendation: `2027-06`**, about six months after the release that brings shared sign-in, in line with the other `LEGACY` dates in the tree (`2027-03`). The user or the coordinator sets it; it is one value in one header line per kept piece.
6. **An old token in `PODIUM_SESSION_TOKEN`.** **Recommendation: not carried**, with a message that names `podium auth mint-session`. Scripts that mint a session at their start are not affected.
7. **The life of a carried `login` or `mobile` sign-in.** **Recommendation: a fresh 30 days**, because today's code renews such a row to 30 days on the same request. The stricter choice, the old row's remaining time, would sign out within a day anybody whose row was close to its end, where today they would have stayed signed in.
8. **Plain HTTP over a network** (specification 17, question 1, awaiting the user). Whatever is decided there decides it here: a person who cannot use the server over that connection cannot be carried over it. If a grace period is added there, the carry follows the same connection facts and needs no change.

## 14. What was read and what was run

Read: the plan, the specification, the spike report, and at `bdc733bd4e` the files named in section 2, `apps/server/src/store/auth.ts`, `apps/server/src/store/users.ts` (the statements that delete old sign-ins), `packages/client-core/src/accounts/auth.ts`, `packages/client-core/src/replica-assembly/`, and the customer-upgrade fixtures.

Run: nothing. This task writes a document and no product code, so the lean gate was skipped; it cannot be affected.

Owed by the build, because this document asserts them from reading only:

- that the store's write transactions exclude each other for two requests at the same moment (test 5);
- that a browser and the desktop webview store the new cookie from the status answer in every setting where they sent the old one (tests 32, 33);
- that a page whose only failing connection is the socket asks `/auth/status` before it shows the sign-in form. Reading shows this for a refused sync request and shows the version reload on reconnect; the socket-only case was not traced to the end.
