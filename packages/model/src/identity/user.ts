/**
 * THE USER / ACCOUNT AGGREGATE — a person, defined once (POD-1075).
 *
 * ADR 9 D1.2: *"A `User` / account aggregate exists: identity, display name,
 * credential material (server-only, `secret-value` per ADR 1 D6), lifecycle
 * (invite, disable, remove)."* ADR 1's matrix already carries the rows this file
 * fills in — `ROW.userAccount` (personal) and `ROW.accountCredential` (secret) —
 * and their `sites` column has named `packages/model/src/identity` as the
 * destination since POD-304. This is that file.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THIS FILE EXISTS TO MAKE STRUCTURALLY TRUE
 * ---------------------------------------------------------------------------
 *
 * **Credential material is not part of any wire projection**, and that is a
 * property of the SHAPES rather than of a `delete` call on a serializer. The
 * account and its credential are two schemas composed from two disjoint field
 * groups, so there is no key to forget to strip: {@link UserWire} cannot carry a
 * password hash because {@link UserAccount} does not have one, and
 * {@link UserCredential} is a separate R3-only shape on its own matrix row
 * (`secret`, `replication: 'none'`, `offline: 'never-enqueue'`).
 *
 * The alternative — one `User` record with an `omit()` on the way out — is the
 * shape where a later field lands on the wrong side of the boundary silently,
 * because adding a key to the record is additive and the omit list is a
 * hand-maintained copy. `user.test.ts` proves the property from the other
 * direction too, with a key-name detector over every projection.
 *
 * ---------------------------------------------------------------------------
 * WHY `role` IS ON THE ACCOUNT AND IS NOT A CAPABILITY SNAPSHOT
 * ---------------------------------------------------------------------------
 *
 * ADR 9 D5 A1 forbids a serialized effective capability, and
 * `annotations/capability-snapshot.ts` enforces it over schemas by key NAME —
 * `role` is one of the names it matches. That detector is right to match it, and
 * this field is right to exist, because they are about different things:
 *
 *   - an EFFECTIVE CAPABILITY is a computed answer ("what may this principal do
 *     right now"), which must be resolved live at every apply because it depends
 *     on facts — the human's current rights, the row's current owner and grants —
 *     that move after the answer is written down;
 *   - an ACCOUNT ROLE is durable identity truth ("this person is an admin of this
 *     instance"), one of the INPUTS that answer is computed FROM. ADR 9 D1.4 is
 *     explicit that it is *"instance-level and distinct from the per-command
 *     `Capability.role` vocabulary ADR 3 D2 owns"*.
 *
 * Storing an input is not snapshotting the output. `user.test.ts` pins the
 * detector's verdict on {@link UserAccount} to EXACTLY `['role']` — so the day
 * someone adds `effectiveRights`, `capabilities` or `grants` to this aggregate,
 * the pinned list changes and the test fails. The carve-out is a pinned
 * expectation, never a widened detector.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 *
 * - **Login, sessions and enforcement.** Per-user authentication — replacing the
 *   one shared password with per-account credentials, and making the client
 *   principal name a person rather than a device — is Phase 3 (POD-315). This
 *   issue is the model and the schema; see `apps/server/src/gateway/
 *   client-principal.ts`, which still asserts `CLIENT_PRINCIPAL_GRADE = 'device'`
 *   because the transport still cannot tell two holders of one password apart.
 * - **Invite / disable / remove COMMANDS.** The lifecycle FIELDS are here
 *   ({@link UserLifecycle}); the commands that move them are Phase 3's (POD-290).
 * - **Groups.** ADR 9 D2's rejected-alternatives table defers a group grantee as
 *   an additive change to the grant edge's grantee column; there is no group
 *   here and building one before a single share exists is speculative scope.
 */

import { z } from 'zod'
import { assertUnreachable } from '../exhaustive'
import { Attribution } from '../fields/attribution'
import { Ownership } from '../fields/ownership'
import { UserIdField } from '../ids'
import { asUserId, type UserId } from '../ids/brands'
import { SOLE_USER_ID } from '../user-state/session-state'

// ---------------------------------------------------------------------------
// Roles — a closed enum with a totality obligation (ADR 9 D1.4)
// ---------------------------------------------------------------------------

/**
 * The instance-level account roles. `admin` and `member` are ADR 9 D1.4's
 * minimum and are the whole set today.
 *
 * A `const` array so the zod enum, the type and every totality check derive from
 * ONE list — the same structural discipline `VISIBILITY_CLASSES` and
 * `GRANT_VERBS` use. Adding a third role is a one-line change here and a
 * COMPILE ERROR at every exhaustive switch below until it declares its rule,
 * which is the point: a role that silently inherits `member`'s answers would be
 * a role nobody decided the meaning of.
 */
export const USER_ROLES = ['admin', 'member'] as const

export const UserRole = z.enum(USER_ROLES)
export type UserRole = (typeof USER_ROLES)[number]

/** Compile-time pin: the zod enum and the vocabulary are one set. Widening
 *  either without the other stops this assignment from typechecking. */
const _userRoleIsOneVocabulary: UserRole = null as unknown as z.infer<typeof UserRole>
void _userRoleIsOneVocabulary

/**
 * Is this role ADMIN-GRADE — i.e. may it perform the actions ADR 9 makes
 * admin-only once there is more than one human?
 *
 * The three named admin-grade powers, each with its decision:
 *   - **secrets management** (ADR 1 D6 / ADR 1 Amendment 1 D15): reading,
 *     setting and rotating server-owned secrets and managed credentials.
 *     Readiness §3.2 states it directly — *"secrets management per ADR 1 D6 is
 *     an admin-grade action once there is more than one human"*.
 *   - **deployment-substrate `manage`** (ADR 9 D3): instance settings, feature
 *     flags, advisory-lock administration.
 *   - **machine `see` / `manage`** (ADR 9 D6 M1): fleet management. Note that
 *     `use` is deliberately NOT on this list — D6's rejected alternatives refuse
 *     to let "admin" mean "may execute code on every teammate's laptop with
 *     their SSH keys". Administration of the fleet and execution on a host are
 *     different powers.
 *
 * An EXHAUSTIVE switch, not `role === 'admin'`, and the difference is the
 * totality obligation: a third role added to {@link USER_ROLES} fails to compile
 * here until someone decides whether it is admin-grade. `role === 'admin'` would
 * answer `false` for it silently — which fails CLOSED and is therefore safe, but
 * silently, and "safe but undecided" is how a role acquires a meaning nobody
 * chose.
 */
export function isAdminGrade(role: UserRole): boolean {
  switch (role) {
    case 'admin':
      return true
    case 'member':
      return false
    default:
      return assertUnreachable(role)
  }
}

// ---------------------------------------------------------------------------
// The field groups
// ---------------------------------------------------------------------------

/** WHO — the identity half. Composed by every projection of an account,
 *  including the ones that carry nothing else. */
export const UserIdentity = z.object({
  /** The person (ADR 9 D1.1). Server-minted and authoritative inside ONE
   *  instance only (ADR 1 Amendment 2 D21.3): equal `UserId` values in two
   *  instances are unrelated strings. */
  userId: UserIdField,
  /** What to render. Deliberately not an email or a login name: those are
   *  authentication inputs and belong with the credential, not on the profile
   *  every replica of this instance receives. */
  displayName: z.string(),
})
export type UserIdentity = z.infer<typeof UserIdentity>

/** WHAT KIND OF ACCOUNT — the instance-level role (ADR 9 D1.4). Its own group
 *  so a projection can carry identity WITHOUT the role, which is what a member
 *  directory needs under the O1 open question (whether the bare existence of an
 *  account is disclosable so people can be named as grantees is a policy call
 *  this issue records rather than answers). */
export const UserRoleGroup = z.object({ role: UserRole })
export type UserRoleGroup = z.infer<typeof UserRoleGroup>

/**
 * LIFECYCLE — invite, disable, remove (ADR 9 D1.2).
 *
 * `disabledAt` is `.nullable()` and NOT `.optional()`, for the reason
 * `Attribution.onBehalfOf` is: `null` is a REPRESENTABLE "this account is
 * active", while an absent key would mean "nobody threaded the value" — and a
 * reader that treats a missing disabled marker as "enabled" is a reader that
 * fails OPEN on a disabled account.
 *
 * DISABLE, THEN REMOVE, and the matrix row says why (`tombstone: 'soft-delete'`):
 * per-user rows cascade on user deletion, but OWNED entities need a transfer
 * story, which is ADR 9's lifecycle territory and not this issue's. A disabled
 * account keeps its rows and its ownership; what it loses is the ability to
 * produce a principal — and, transitively and with no reaper to write, every
 * agent delegated from it (ADR 9 D5 A1).
 */
export const UserLifecycle = z.object({
  createdAt: z.string(),
  disabledAt: z.string().nullable(),
})
export type UserLifecycle = z.infer<typeof UserLifecycle>

// ---------------------------------------------------------------------------
// R1 — the canonical durable account
// ---------------------------------------------------------------------------

/**
 * The canonical durable account — ADR 1 matrix row `user-account`.
 *
 * Built with `.extend()` over the named groups rather than by listing keys, so
 * adding a field to a group propagates here and cannot be forgotten (ADR 4
 * D3.3's propagate-or-fail-compilation rule) — the same construction
 * `SessionAggregate` and `IssueAggregate` use.
 *
 * It composes `Ownership`, whose `owner` for this row is the account ITSELF
 * (the matrix resolves it `self`: a person owns their own profile). That reads
 * circular and is deliberate — it means "who owns this row" has exactly one
 * answer shape across every owned class, including this one, so the scoped feed
 * of Phase 2 does not need a special case for the class that describes people.
 */
export const UserAccount = UserIdentity.extend(UserRoleGroup.shape)
  .extend(UserLifecycle.shape)
  .extend(Ownership.shape)
  .extend({
    /** WHICH PRINCIPAL created this account. `system` for the first admin the
     *  upgrade migration mints — there is no human behind an upgrade, and ADR 9
     *  D8 S5 forbids inventing one. An invite creates it as the inviting admin. */
    createdBy: Attribution,
  })
export type UserAccount = z.infer<typeof UserAccount>

// ---------------------------------------------------------------------------
// R4 — what a replica may see
// ---------------------------------------------------------------------------

/**
 * The wire projection of an account.
 *
 * A `pick` from R1 rather than an `omit` of the secret bits, and the direction
 * is the whole safety property: an omit-list is a hand-maintained copy of "what
 * must not escape", so a field added to R1 lands on the wire BY DEFAULT and the
 * mistake is invisible in the diff. A pick-list makes the default the other way
 * round — a new field is absent from the wire until someone adds it here, and
 * adding it is the visible edit.
 *
 * `owner` and `visibility` are absent for a different reason than the credential
 * is: for this class they are derivable from `userId` (owner = self) and
 * constant (`personal`), so shipping them would be shipping a value the reader
 * already has. That is a projection call, not a rule — `fields/README.md` rule 2:
 * requiredness is declared at R1 where the fact is unconditionally true, never
 * inherited as a constraint on every projection.
 */
export const UserWire = UserAccount.pick({
  userId: true,
  displayName: true,
  role: true,
  disabledAt: true,
})
export type UserWire = z.infer<typeof UserWire>

// ---------------------------------------------------------------------------
// R3, and server-only — credential material
// ---------------------------------------------------------------------------

/**
 * How an account authenticates. ADR 1 matrix row `account-credential`:
 * `secret-value`, `replication: 'none'`, `offline: 'never-enqueue'`, and
 * `owner: { kind: 'none', reason: 'secret' }` — *"credential material
 * AUTHENTICATES a person but is not theirs to grant or transfer"*.
 *
 * NEVER a member of {@link UserAccount}, so it can never reach a projection of
 * one. This is a separate R3 shape that the storage layer reads and no wire
 * shape composes.
 *
 * ---------------------------------------------------------------------------
 * `source` — ONE MEMBER, AND WHY THE SECOND ONE LEFT (POD-1554)
 * ---------------------------------------------------------------------------
 *
 * There was a second member, `'instance-password'`, with a NULL hash. It meant
 * *this account authenticates with the one shared password in `auth.json`* — a
 * FILE, which the POD-1075 SQL migration could not read, so it named the
 * indirection instead of inventing a hash. That was correct then and it was
 * declared temporary in the same breath: minting per-account credentials was to
 * land with the per-user login work in Phase 3 (POD-315). POD-315 closed without
 * minting them, so the bridge outlived its owner by an entire phase.
 *
 * POD-1554 does the move the migration could not: a one-shot at BOOT (where a
 * file *is* readable) copies the hash into the first admin's row and deletes
 * `auth.json` — `apps/server/src/instance-password-migration.ts`. With that,
 * every account authenticates the one way, and the enum is a single member.
 *
 * A one-member enum is kept as an enum rather than collapsed to a literal
 * because the NEXT source is a real prospect (OIDC, passkeys), and because the
 * column already stores this string. Adding a member should be additive; going
 * back through a literal would not be.
 */
export const CREDENTIAL_SOURCES = ['per-user-scrypt'] as const
export const CredentialSource = z.enum(CREDENTIAL_SOURCES)
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number]

export const UserCredential = z.object({
  userId: UserIdField,
  source: CredentialSource,
  /** Nullable because the COLUMN is (it held NULL for every `'instance-password'`
   *  row before POD-1554). A `per-user-scrypt` row with a null hash is an account
   *  that cannot log in, and every reader treats it as such rather than as a
   *  credential. Never `.optional()` — an absent key would be indistinguishable
   *  from "nobody wrote one". */
  passwordHash: z.string().nullable(),
  updatedAt: z.string(),
})
export type UserCredential = z.infer<typeof UserCredential>

// ---------------------------------------------------------------------------
// The one pre-accounts human, reconciled
// ---------------------------------------------------------------------------

/**
 * THE FIRST ADMIN — the single account an upgraded instance has, and the ONE
 * name for the identity that two constants used to spell two ways.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS RECONCILES (POD-1172)
 * ---------------------------------------------------------------------------
 *
 * Two constants named the one pre-accounts human and DISAGREED:
 *
 *   `SOLE_USER_ID`   `'user:sole'`       POD-380 — what `sessionOwner` stamps as
 *                                        every session's owner, and what the
 *                                        per-user-state migration WROTE INTO THE
 *                                        DATABASE for every pin, snooze and saved
 *                                        tab order.
 *   `INSTANCE_OWNER` `'instance-owner'`  POD-381 — what `resolvePrincipal` minted
 *                                        as every human's `UserId`.
 *
 * Each side was internally consistent, so nothing compared them until POD-351's
 * delegation ceiling needed both — where, unreconciled, the intersection denied
 * EVERY agent write. It failed closed, so a liveness defect rather than a leak,
 * but one that would have surfaced as "agents inexplicably cannot act" inside a
 * check that reads as correct. POD-351 bridged it in one named place
 * (`samePrincipal`) with a tripwire asserting the constants still differed, so
 * that whoever reconciled them would delete the bridge. Both are now gone.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SURVIVING VALUE IS `'user:sole'` AND NOT `'instance-owner'`
 * ---------------------------------------------------------------------------
 *
 * Because it is the one that is already WRITTEN DOWN. The POD-380 migration
 * (`20260730104951_per-user-state-keying`) backfilled every existing pin, snooze
 * and tab-order row with the literal `'user:sole'`, and a migration is frozen
 * history: those rows keep the id they were actually written with. Choosing
 * `'instance-owner'` would have meant a second data migration to re-key rows
 * that are already correct, to change a string no user ever sees. The other
 * constant was minted in memory and persisted nowhere, so retiring it costs
 * nothing.
 *
 * `SOLE_USER_ID` survives as the raw storage LITERAL that the migration and its
 * tests spell; this is the branded identity every principal and owner check
 * compares against. One value, two positions, no second spelling.
 */
export const FIRST_ADMIN_USER_ID: UserId = asUserId(SOLE_USER_ID)

/**
 * The first admin's role, named rather than inlined so the upgrade migration's
 * intent is greppable from the model: the account the migration mints is an
 * ADMIN, because on an upgraded instance it is the only account there is and
 * somebody must be able to manage secrets, settings and the fleet (ADR 9 D1.4,
 * D1.5 — `OPERATOR` *"survives only as a migration artefact: the first account
 * of an upgraded instance"*).
 */
export const FIRST_ADMIN_ROLE: UserRole = 'admin'
